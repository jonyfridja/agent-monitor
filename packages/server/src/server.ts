import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { readFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { extname, join, normalize as normalizePath, sep } from 'node:path';
import { normalize } from '@agent-monitor/adapters';
import { AGENT_IDS, type AgentId, type NoticeLevel, type StreamMessage, type Viewer } from '@agent-monitor/protocol';
import { SessionStore } from './store.ts';
import { defaultNameSources, NameResolver, type NameSources } from './names.ts';
import { claudeCwd, findClaudeTranscript, listRecentClaudeTranscripts } from './claudeTranscripts.ts';
import { cursorCwds, findCursorTranscript, listRecentCursorTranscripts, RECENT_CURSOR_TRANSCRIPT_MS } from './cursorTranscripts.ts';
import { readTranscript, resolveTranscript } from './transcript.ts';
import { allowedHost, LoginLimiter, parseCookies, safeEqual, Sessions, verifyPassword } from './auth.ts';

export interface ServerOptions {
  port: number;
  /** Pairing token (QR link) for non-loopback callers, used only while no password is set. Empty/undefined + no password = open. */
  token?: string;
  /** scrypt hash (see `hashPassword`). Set → LAN viewers must log in with the password; the token stops working. */
  passwordHash?: string;
  /** No real password chosen yet: LAN logins are refused (and say why) until `setPasswordHash` is called. */
  setupRequired?: boolean;
  /** Signs login cookies. Default: random per process (phones re-login after a restart). */
  sessionSecret?: string;
  /** PEM key + cert. Set → HTTPS on the same port; plain-http LAN requests are redirected. Loopback http keeps working for hooks. */
  tls?: { key: string; cert: string };
  /** Extra hostnames browsers may use to reach us (besides IPs, localhost and this Mac's name). */
  allowedHosts?: string[];
  /** Directory of the phone web client to serve at `/`. */
  webDir?: string;
  staleMs?: number;
  host?: string;
  /** Serve conversation logs to phones. Default true; can be flipped at runtime. */
  shareTranscripts?: boolean;
  /** Directories a transcript file must live under. Default: ~/.claude, ~/.codex, and ~/.cursor. */
  transcriptRoots?: string[];
  /** Where to look up the harness's own session names. Default: the real ~/.claude, ~/.codex, and ~/.cursor. */
  nameSources?: NameSources;
  /**
   * `~/.cursor/projects`, where Cursor (IDE and CLI) writes `agent-transcripts/<id>/<id>.jsonl`.
   * Default: that directory under the home folder. Hooks often omit the path, so the server looks here.
   */
  cursorProjectsDir?: string;
  /**
   * `~/.claude/projects`, where Claude Code (CLI and the desktop app) writes `<slug>/<sessionId>.jsonl`.
   * Default: that directory under the home folder. Same lookup as Cursor when a hook omits the path.
   */
  claudeProjectsDir?: string;
}

export interface MonitorServer {
  readonly store: SessionStore;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Only events from these agents are accepted. */
  setEnabledAgents(agents: Iterable<AgentId>): void;
  setShareTranscripts(value: boolean): void;
  /** Change (or clear) the phone password at runtime; every logged-in phone is signed out. Ends `setupRequired`. */
  setPasswordHash(hash: string | undefined): void;
  readonly secure: boolean;
  viewers(): Viewer[];
  onViewersChange(fn: (viewers: Viewer[]) => void): () => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
};

const MAX_BODY = 1_000_000;
const PING_MS = 15_000;
const TICK_MS = 5_000;
const NAME_CHECK_MS = 15_000; // per session, unless the event is a milestone (start / turn end)
const NAME_RECHECK_MS = 3_000; // Codex writes a thread name shortly after the turn ends

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

const COOKIE = 'am_session';
const LOGIN_FAIL_DELAY_MS = 400;

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob: mediastream:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  // No HSTS on purpose: with a self-signed cert it would make the browser's "proceed anyway" impossible.
};

const cleanIp = (addr: string | undefined): string => (addr ?? '?').replace(/^::ffff:/, '');

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const isAgent = (v: string | null): v is AgentId => v !== null && (AGENT_IDS as readonly string[]).includes(v);

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

export function createMonitorServer(opts: ServerOptions): MonitorServer {
  const store = new SessionStore({ staleMs: opts.staleMs });
  const enabled = new Set<AgentId>(AGENT_IDS);
  let shareTranscripts = opts.shareTranscripts ?? true;
  const transcriptRoots = opts.transcriptRoots ?? [join(homedir(), '.claude'), join(homedir(), '.codex'), join(homedir(), '.cursor')];
  const nameSources = opts.nameSources ?? defaultNameSources();
  const names = new NameResolver(nameSources);
  const cursorProjectsDir = opts.cursorProjectsDir ?? join(homedir(), '.cursor', 'projects');
  const claudeProjectsDir = opts.claudeProjectsDir ?? join(homedir(), '.claude', 'projects');
  let cwdCache: { at: number; map: Map<string, string> } | undefined;
  const nameChecked = new Map<string, number>();
  const viewers = new Map<string, Viewer>();
  const viewerListeners = new Set<(v: Viewer[]) => void>();
  let tickTimer: NodeJS.Timeout | undefined;
  const secret = opts.sessionSecret ?? randomBytes(32).toString('base64url');
  let passwordHash = opts.passwordHash;
  let setupRequired = !!opts.setupRequired;
  let sessions = new Sessions(secret, passwordHash ?? opts.token ?? '');
  const limiter = new LoginLimiter();

  const emitViewers = () => {
    const list = [...viewers.values()];
    for (const fn of viewerListeners) fn(list);
  };

  const tokenOk = (given: unknown): boolean =>
    !passwordHash && !!opts.token && typeof given === 'string' && safeEqual(given, opts.token);

  /** Loopback (hooks, the host app) is trusted. LAN: a login cookie, or — only while no password is set — the token. */
  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (isLoopback(req.socket.remoteAddress)) return true;
    if (setupRequired) return false;
    if (!passwordHash && !opts.token) return true;
    if (sessions.valid(parseCookies(req.headers.cookie)[COOKIE])) return true;
    return tokenOk(url.searchParams.get('t') ?? req.headers['x-agent-monitor-token']);
  };

  const encrypted = (req: IncomingMessage): boolean => !!(req.socket as TLSSocket).encrypted;

  const sessionCookie = (req: IncomingMessage, value: string, maxAgeS: number): string =>
    `${COOKIE}=${value}; Path=/; Max-Age=${maxAgeS}; HttpOnly; SameSite=Strict${encrypted(req) ? '; Secure' : ''}`;

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = cleanIp(req.socket.remoteAddress);
    if (setupRequired) return send(res, 403, { error: 'set a password on the Mac first' });
    if (!passwordHash) return send(res, 404, { error: 'no password set' });
    // JSON only: a cross-site form can't send it without a CORS preflight we never answer.
    if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'json only' });
    const wait = limiter.retryAfter(ip);
    if (wait > 0) {
      res.setHeader('retry-after', Math.ceil(wait / 1000));
      return send(res, 429, { error: 'too many attempts', retryAfter: Math.ceil(wait / 1000) });
    }
    let password: unknown;
    try {
      password = (JSON.parse(await readBody(req)) as { password?: unknown }).password;
    } catch {
      return send(res, 400, { error: 'invalid json' });
    }
    if (typeof password === 'string' && password.length <= 1024 && (await verifyPassword(password, passwordHash))) {
      limiter.succeed(ip);
      res.setHeader('set-cookie', sessionCookie(req, sessions.issue(), Math.floor(sessions.ttlMs / 1000)));
      return send(res, 204);
    }
    limiter.fail(ip);
    await new Promise((r) => setTimeout(r, LOGIN_FAIL_DELAY_MS));
    send(res, 401, { error: 'wrong password' });
  }

  function handleStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const write = (msg: StreamMessage) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
    res.write('retry: 2000\n\n');
    write({ type: 'snapshot', now: Date.now(), sessions: store.snapshot() });

    const viewer: Viewer = {
      id: randomUUID(),
      ip: cleanIp(req.socket.remoteAddress),
      userAgent: String(req.headers['user-agent'] ?? ''),
      since: Date.now(),
    };
    const unsubscribe = store.subscribe(write);
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    // Loopback viewers (curl, the host window) are not "connected phones".
    const counted = !isLoopback(req.socket.remoteAddress);
    if (counted) {
      viewers.set(viewer.id, viewer);
      emitViewers();
    }
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      if (counted && viewers.delete(viewer.id)) emitViewers();
    });
  }

  /** Look up the harness's name for a session and attach it. Best effort: failures just leave the folder name. */
  async function refreshName(agent: AgentId, id: string, force: boolean): Promise<void> {
    const key = `${agent}:${id}`;
    const now = Date.now();
    if (!force && now - (nameChecked.get(key) ?? 0) < NAME_CHECK_MS) return;
    nameChecked.set(key, now);
    const known = store.transcriptPath(agent, id);
    const transcript = known ? await resolveTranscript(known, transcriptRoots) : null;
    store.setName(agent, id, await names.resolve(agent, id, transcript ?? undefined));
  }

  /** Cursor runs Claude's hook command too, with a Cursor payload. That is the same chat, not a Claude session. */
  function isCursorPayload(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const p = raw as Record<string, unknown>;
    return typeof p.cursor_version === 'string' && typeof p.conversation_id === 'string';
  }

  async function cursorTranscript(id: string): Promise<string | null> {
    const path = await findCursorTranscript(cursorProjectsDir, id);
    return path && (await resolveTranscript(path, transcriptRoots));
  }

  async function claudeTranscript(id: string): Promise<string | null> {
    const path = await findClaudeTranscript(claudeProjectsDir, id);
    return path && (await resolveTranscript(path, transcriptRoots));
  }

  async function cwdFor(id: string): Promise<string | undefined> {
    const now = Date.now();
    if (!cwdCache || now - cwdCache.at > NAME_CHECK_MS) cwdCache = { at: now, map: await cursorCwds(nameSources.cursorChatsDir) };
    return cwdCache.map.get(id);
  }

  /** Cursor often leaves transcript_path null. Pick up the jsonl by id, and chats the hooks never reported. */
  async function syncCursorTranscripts(): Promise<void> {
    if (!enabled.has('cursor')) return;
    const found = await listRecentCursorTranscripts(cursorProjectsDir, Date.now() - RECENT_CURSOR_TRANSCRIPT_MS);
    for (const item of found) {
      const path = await resolveTranscript(item.path, transcriptRoots);
      if (!path) continue;
      const existing = store.snapshot().find((s) => s.agent === 'cursor' && s.id === item.id);
      if (!existing) {
        store.apply({
          agent: 'cursor',
          sessionId: item.id,
          cwd: await cwdFor(item.id),
          kind: 'session-start',
          at: item.mtime,
          transcriptPath: path,
        });
        void refreshName('cursor', item.id, true).catch(() => {});
      } else if (!store.transcriptPath('cursor', item.id)) {
        store.setTranscript('cursor', item.id, path);
      }
    }
  }

  /** Claude Code CLI and the desktop app share this tree. Hooks sometimes never hand over the file. */
  async function syncClaudeTranscripts(): Promise<void> {
    if (!enabled.has('claude')) return;
    const found = await listRecentClaudeTranscripts(claudeProjectsDir, Date.now() - RECENT_CURSOR_TRANSCRIPT_MS);
    for (const item of found) {
      const path = await resolveTranscript(item.path, transcriptRoots);
      if (!path) continue;
      const existing = store.snapshot().find((s) => s.agent === 'claude' && s.id === item.id);
      if (!existing) {
        store.apply({
          agent: 'claude',
          sessionId: item.id,
          cwd: await claudeCwd(path),
          kind: 'session-start',
          at: item.mtime,
          transcriptPath: path,
        });
        void refreshName('claude', item.id, true).catch(() => {});
      } else if (!store.transcriptPath('claude', item.id)) {
        store.setTranscript('claude', item.id, path);
      }
    }
  }

  async function handleEvent(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const agent = url.searchParams.get('agent');
    if (!isAgent(agent)) return send(res, 400, { error: 'unknown agent' });
    let raw: unknown;
    try {
      raw = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'invalid json' });
    }
    if (agent === 'claude' && isCursorPayload(raw)) return send(res, 204);
    if (enabled.has(agent)) {
      let ev = normalize(agent, raw);
      if (ev && !ev.transcriptPath && (ev.agent === 'cursor' || ev.agent === 'claude')) {
        const path = ev.agent === 'cursor' ? await cursorTranscript(ev.sessionId) : await claudeTranscript(ev.sessionId);
        if (path) ev = { ...ev, transcriptPath: path };
      }
      if (ev) {
        store.apply(ev);
        const milestone = ev.kind === 'session-start' || ev.kind === 'turn-end';
        void refreshName(ev.agent, ev.sessionId, milestone).catch(() => {});
        if (ev.kind === 'turn-end') setTimeout(() => void refreshName(ev.agent, ev.sessionId, true).catch(() => {}), NAME_RECHECK_MS).unref();
      }
    }
    send(res, 204);
  }

  async function handleNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { title?: unknown; body?: unknown; level?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'invalid json' });
    }
    if (typeof body.title !== 'string' || !body.title) return send(res, 400, { error: 'title required' });
    const level: NoticeLevel = body.level === 'urgent' || body.level === 'attention' ? body.level : 'info';
    const notice = store.notify({ title: body.title, body: typeof body.body === 'string' ? body.body : '', level });
    send(res, 200, notice);
  }

  async function handleTranscript(res: ServerResponse, url: URL): Promise<void> {
    if (!shareTranscripts) return send(res, 403, { error: 'disabled' });
    const agent = url.searchParams.get('agent');
    const id = url.searchParams.get('id');
    if (!isAgent(agent) || !id) return send(res, 400, { error: 'agent and id required' });
    // The phone names a session. The path comes from the hook, or from the agent's transcript directory when the hook left it out.
    let known = store.transcriptPath(agent, id);
    if (!known && (agent === 'cursor' || agent === 'claude')) {
      const found = agent === 'cursor' ? await cursorTranscript(id) : await claudeTranscript(id);
      if (found) {
        store.setTranscript(agent, id, found);
        known = found;
      }
    }
    const path = known && (await resolveTranscript(known, transcriptRoots));
    if (!path) return send(res, 404, { error: 'no transcript' });
    send(res, 200, await readTranscript(agent, path));
  }

  async function handleStatic(res: ServerResponse, pathname: string): Promise<void> {
    if (!opts.webDir) return send(res, 404);
    const rel = normalizePath(pathname === '/' ? '/index.html' : pathname);
    const file = join(opts.webDir, rel);
    if (!file.startsWith(opts.webDir + sep)) return send(res, 403);
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    } catch {
      send(res, 404);
    }
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const loopback = isLoopback(req.socket.remoteAddress);
    const route = `${req.method} ${url.pathname}`;
    const fail = (err: unknown) => {
      if (!res.headersSent) send(res, 500, { error: String(err) });
      else res.end();
    };
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (url.pathname.startsWith('/api/')) res.setHeader('cache-control', 'no-store');

    // DNS rebinding: a web page whose domain now resolves to us would otherwise get loopback trust.
    if (!allowedHost(req.headers.host, opts.allowedHosts)) return send(res, 421, { error: 'unknown host' });

    // Ingest endpoints are for the agents' hooks on this machine only. Browsers always send Origin on POST; curl doesn't.
    if (route === 'POST /api/events' || route === 'POST /api/notify') {
      if (!loopback || req.headers.origin) return send(res, 403, { error: 'loopback only' });
      (route === 'POST /api/events' ? handleEvent(req, res, url) : handleNotify(req, res)).catch(fail);
      return;
    }

    // Phones get HTTPS when it's on; plain http stays available on loopback (hooks, probe, curl).
    if (opts.tls && !loopback && !encrypted(req)) {
      res.writeHead(308, { location: `https://${req.headers.host ?? 'localhost'}${req.url ?? '/'}` }).end();
      return;
    }

    if (route === 'GET /api/auth') {
      return send(res, 200, { authed: authorized(req, url), password: !!passwordHash, setup: setupRequired });
    }
    if (route === 'POST /api/login') {
      handleLogin(req, res).catch(fail);
      return;
    }
    if (route === 'POST /api/logout') {
      res.setHeader('set-cookie', sessionCookie(req, '', 0));
      return send(res, 204);
    }
    if (route === 'GET /api/stream' || route === 'GET /api/state' || route === 'GET /api/transcript') {
      if (!authorized(req, url)) return send(res, 401, { error: passwordHash ? 'login required' : 'bad token' });
      if (route === 'GET /api/transcript') {
        handleTranscript(res, url).catch(fail);
        return;
      }
      if (route === 'GET /api/state') return send(res, 200, { now: Date.now(), sessions: store.snapshot() });
      return handleStream(req, res);
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      // A pairing link (?t=…) is swapped for a cookie, and the token leaves the address bar and history.
      const t = url.searchParams.get('t');
      if (t !== null && !loopback) {
        if (tokenOk(t)) res.setHeader('set-cookie', sessionCookie(req, sessions.issue(), Math.floor(sessions.ttlMs / 1000)));
        url.searchParams.delete('t');
        res.writeHead(303, { location: url.pathname + url.search }).end();
        return;
      }
      handleStatic(res, url.pathname).catch(fail);
      return;
    }
    send(res, 404);
  }

  const httpServer = createServer(handle);
  const httpsServer = opts.tls ? createHttpsServer({ key: opts.tls.key, cert: opts.tls.cert }, handle) : undefined;
  const raw = new Set<Socket>();
  // One port, both protocols: peek at the first byte — 0x16 opens a TLS handshake — and hand the socket to the
  // matching server. Hooks keep posting plain http to 127.0.0.1 while phones use https.
  const front = createNetServer((socket) => {
    raw.add(socket);
    socket.on('close', () => raw.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy()); // connected but silent
    socket.once('data', (first: Buffer) => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(first);
      (httpsServer && first[0] === 0x16 ? httpsServer : httpServer).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  httpsServer?.on('tlsClientError', (_err, socket) => socket.destroy()); // e.g. the phone rejecting our self-signed cert

  return {
    store,
    start() {
      return new Promise((resolve, reject) => {
        front.once('error', reject);
        front.listen(opts.port, opts.host ?? '0.0.0.0', () => {
          front.off('error', reject);
          void Promise.all([syncCursorTranscripts(), syncClaudeTranscripts()])
            .catch(() => {})
            .finally(() => {
              tickTimer = setInterval(() => {
                store.tick();
                void syncCursorTranscripts().catch(() => {});
                void syncClaudeTranscripts().catch(() => {});
              }, TICK_MS);
              resolve();
            });
        });
      });
    },
    stop() {
      clearInterval(tickTimer);
      return new Promise((resolve) => {
        front.close(() => resolve());
        // SSE streams would otherwise keep the port bound
        httpServer.closeAllConnections();
        httpsServer?.closeAllConnections();
        for (const socket of raw) socket.destroy();
        viewers.clear();
        emitViewers();
      });
    },
    setEnabledAgents(agents) {
      enabled.clear();
      for (const a of agents) enabled.add(a);
      for (const a of AGENT_IDS) if (!enabled.has(a)) store.clearAgent(a);
    },
    setShareTranscripts(value) {
      shareTranscripts = value;
    },
    setPasswordHash(hash) {
      passwordHash = hash || undefined;
      setupRequired = false;
      sessions = new Sessions(secret, passwordHash ?? opts.token ?? '');
    },
    secure: !!opts.tls,
    viewers: () => [...viewers.values()],
    onViewersChange(fn) {
      viewerListeners.add(fn);
      return () => viewerListeners.delete(fn);
    },
  };
}

/** Non-internal IPv4 addresses, most likely LAN first (192.168/10/172.16 before others). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const i of infos ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  const rank = (ip: string) => (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(ip) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}
