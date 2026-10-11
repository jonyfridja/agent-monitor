import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { allowedHost, hashPassword, LoginLimiter, parseCookies, Sessions, verifyPassword } from './auth.ts';

test('passwords: only a salted scrypt hash is stored, and it verifies the right password only', async () => {
  const hash = await hashPassword('correct horse');
  assert.match(hash, /^scrypt\$/);
  assert.doesNotMatch(hash, /correct horse/);
  assert.notEqual(hash, await hashPassword('correct horse'), 'salted');
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('correct hors', hash), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('passwords shorter than 6 characters are refused (the default 123456 is the shortest allowed)', async () => {
  await assert.rejects(hashPassword('12345'), /at least 6/);
  assert.match(await hashPassword('123456'), /^scrypt\$/);
});

test('session cookies: valid until expiry, tamper-proof, and void after a password change', () => {
  const s = new Sessions('secret', 'hash-1', 1000);
  const cookie = s.issue(0);
  assert.equal(s.valid(cookie, 500), true);
  assert.equal(s.valid(cookie, 1001), false, 'expired');
  const [, sig] = cookie.split('.');
  assert.equal(s.valid(`99999999999999.${sig}`, 500), false, 'expiry cannot be extended');
  assert.equal(s.valid(undefined), false);
  assert.equal(s.valid('nonsense'), false);
  assert.equal(new Sessions('secret', 'hash-2', 1000).valid(cookie, 500), false, 'new password → old cookies rejected');
});

test('login limiter: locks an IP out after 5 failures for the window, others unaffected', () => {
  const l = new LoginLimiter(5, 60_000);
  for (let i = 0; i < 4; i++) l.fail('a', 0);
  assert.equal(l.retryAfter('a', 1), 0);
  l.fail('a', 0);
  assert.equal(l.retryAfter('a', 1000), 59_000);
  assert.equal(l.retryAfter('b', 1000), 0);
  assert.equal(l.retryAfter('a', 60_000), 0, 'window over');
  l.fail('c', 0);
  l.succeed('c');
  assert.equal(l.retryAfter('c', 0), 0);
});

test('cookie parsing tolerates junk', () => {
  assert.deepEqual(parseCookies('a=1; am_session=x.y; bad; c=%E0'), { a: '1', am_session: 'x.y' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('host check: IPs, localhost and this Mac pass; a rebinding domain does not', () => {
  for (const h of ['192.168.1.5:47821', '127.0.0.1', '[::1]:47821', 'localhost:47821', `${hostname().replace(/\.local$/, '')}.local:1`]) {
    assert.equal(allowedHost(h), true, h);
  }
  assert.equal(allowedHost('evil.example.com'), false);
  assert.equal(allowedHost('mac.lan', ['mac.lan']), true, 'configured extra name');
});
