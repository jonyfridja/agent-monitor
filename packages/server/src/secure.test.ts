// Password login, cookies, HTTPS-on-the-same-port and the hardening headers, exercised over real sockets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer, lanAddresses, type MonitorServer } from './index.ts';
import { hashPassword } from './auth.ts';
import { ensureCert } from './tls.ts';

const PORT = 46800 + Math.floor(Math.random() * 90);
const [lan] = lanAddresses();
const skipLan = lan ? false : 'no LAN interface on this machine';
let dir: string;
let ca: string;
let server: MonitorServer;

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Tiny client: trusts our self-signed cert (pinned as the CA) and reads the whole body. */
function call(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  const u = new URL(url);
  const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(u, { method: opts.method ?? 'GET', headers: opts.headers, ca }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}
const login = (password: string, base: string, type = 'application/json') =>
  call(`${base}/api/login`, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify({ password }) });
const cookieOf = (r: Res) => (r.headers['set-cookie']?.[0] ?? '').split(';')[0];

const https = () => `https://${lan}:${PORT}`;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'am-sec-'));
  const tls = await ensureCert(join(dir, 'tls'), lanAddresses());
  ca = tls.cert;
  server = createMonitorServer({
    port: PORT,
    token: 'pair-token',
    passwordHash: await hashPassword('hunter2hunter2'),
    sessionSecret: 'test-secret',
    tls,
  });
  await server.start();
});
after(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

test('loopback keeps plain http: hooks and the probe work unchanged', async () => {
  const hook = await call(`http://127.0.0.1:${PORT}/api/events?agent=claude`, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/w/p' }),
  });
  assert.equal(hook.status, 204);
  assert.equal((await call(`http://127.0.0.1:${PORT}/api/state`)).status, 200);
  assert.equal((await call(`https://127.0.0.1:${PORT}/api/state`)).status, 200, 'and https on the same port');
});

test('the self-signed cert is reused while it still covers this Mac’s addresses', async () => {
  const again = await ensureCert(join(dir, 'tls'), lanAddresses());
  assert.equal(again.cert, ca);
  assert.match(again.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  const pub = new X509Certificate(ca).publicKey;
  assert.deepEqual(pub.asymmetricKeyDetails, { namedCurve: 'prime256v1' });
  // Browsers reject explicit curve parameters; a named curve encodes as the short P-256 OID form (91-byte SPKI).
  assert.equal(pub.export({ type: 'spki', format: 'der' }).length, 91);
  const moved = await ensureCert(join(dir, 'tls'), ['10.99.99.99']);
  assert.notEqual(moved.cert, ca, 'a new LAN address → a new cert');
});

test('LAN plain http is redirected to https', { skip: skipLan }, async () => {
  const r = await call(`http://${lan}:${PORT}/api/state?x=1`);
  assert.equal(r.status, 308);
  assert.equal(r.headers.location, `https://${lan}:${PORT}/api/state?x=1`);
});

test('LAN: data needs a login; the pairing token no longer works once a password is set', { skip: skipLan }, async () => {
  assert.equal((await call(`${https()}/api/state`)).status, 401);
  assert.equal((await call(`${https()}/api/state?t=pair-token`)).status, 401);
  assert.deepEqual(JSON.parse((await call(`${https()}/api/auth`)).body), { authed: false, password: true, setup: false });
  assert.equal((await call(`${https()}/`)).status, 404, 'static route reachable (no webDir here), not 401');
});

test('LAN: wrong password is refused; the right one sets a hardened cookie that unlocks the API', { skip: skipLan }, async () => {
  assert.equal((await login('nope-nope', https())).status, 401);
  assert.equal((await login('hunter2hunter2', https(), 'text/plain')).status, 415, 'no cross-site form posts');
  const ok = await login('hunter2hunter2', https());
  assert.equal(ok.status, 204);
  const set = ok.headers['set-cookie']![0];
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.match(set, new RegExp(flag));
  const cookie = cookieOf(ok);
  assert.equal((await call(`${https()}/api/state`, { headers: { cookie } })).status, 200);
  assert.deepEqual(JSON.parse((await call(`${https()}/api/auth`, { headers: { cookie } })).body), { authed: true, password: true, setup: false });

  const out = await call(`${https()}/api/logout`, { method: 'POST' });
  assert.match(out.headers['set-cookie']![0], /Max-Age=0/);

  server.setPasswordHash(await hashPassword('a-new-password'));
  assert.equal((await call(`${https()}/api/state`, { headers: { cookie } })).status, 401, 'changing the password signs phones out');
});

test('responses carry hardening headers and no HSTS (it would lock users out of a self-signed cert)', async () => {
  const r = await call(`https://127.0.0.1:${PORT}/api/auth`);
  assert.match(String(r.headers['content-security-policy']), /default-src 'self'.*frame-ancestors 'none'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['strict-transport-security'], undefined);
});

test('DNS rebinding: an unknown Host is refused even from loopback', async () => {
  assert.equal((await call(`http://127.0.0.1:${PORT}/api/state`, { headers: { host: 'evil.example.com' } })).status, 421);
});

test('browsers cannot post hook events: a request with an Origin is refused even on loopback', async () => {
  const r = await call(`http://127.0.0.1:${PORT}/api/events?agent=claude`, {
    method: 'POST',
    headers: { origin: 'https://evil.example.com' },
    body: '{}',
  });
  assert.equal(r.status, 403);
});

test('without a password, the QR pairing link is swapped for a cookie and the token leaves the URL', { skip: skipLan }, async () => {
  const p = PORT + 100;
  const s = createMonitorServer({ port: p, token: 'pair-token', sessionSecret: 'x' });
  await s.start();
  try {
    const base = `http://${lan}:${p}`;
    const r = await call(`${base}/?t=pair-token`);
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, '/');
    assert.doesNotMatch(r.headers['set-cookie']![0], /Secure/, 'plain http: no Secure flag, or the cookie would be dropped');
    assert.equal((await call(`${base}/api/state`, { headers: { cookie: cookieOf(r) } })).status, 200);
    const bad = await call(`${base}/?t=wrong`);
    assert.equal(bad.status, 303);
    assert.equal(bad.headers['set-cookie'], undefined);
    assert.equal((await login('anything', base)).status, 404, 'no password configured');
  } finally {
    await s.stop();
  }
});

test('until a real password is chosen, LAN logins are refused with a reason; setting one opens them', { skip: skipLan }, async () => {
  const p = PORT + 200;
  const s = createMonitorServer({ port: p, passwordHash: await hashPassword('123456'), setupRequired: true, sessionSecret: 'x' });
  await s.start();
  try {
    const base = `http://${lan}:${p}`;
    assert.deepEqual(JSON.parse((await call(`${base}/api/auth`)).body), { authed: false, password: true, setup: true });
    const refused = await login('123456', base);
    assert.equal(refused.status, 403, 'not even the placeholder password works');
    assert.match(refused.body, /set a password on the Mac/);
    assert.equal((await call(`http://127.0.0.1:${p}/api/state`)).status, 200, 'the Mac itself is unaffected');
    s.setPasswordHash(await hashPassword('Chosen-Pass-1'));
    assert.equal((await login('Chosen-Pass-1', base)).status, 204);
  } finally {
    await s.stop();
  }
});

// Last: it locks this IP out of the main server.
test('LAN: after 5 wrong passwords the IP is locked out, even for the right one', { skip: skipLan }, async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login(`wrong-${i}-xx`, https())).status, 401);
  const locked = await login('a-new-password', https());
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers['retry-after']) > 0);
});
