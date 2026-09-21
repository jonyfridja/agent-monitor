import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { extname, join, normalize as normalizePath, sep } from 'node:path';
import { normalize } from '@agent-monitor/adapters';
import type { AgentId, NoticeLevel, StreamMessage, Viewer } from '@agent-monitor/protocol';
import { SessionStore } from './store.ts';
import { defaultNameSources, NameResolver, type NameSources } from './names.ts';
import { readTranscript, resolveTranscript } from './transcript.ts';

export interface ServerOptions {
  port: number;
  /** Required from non-loopback callers on viewer endpoints. Empty/undefined disables the check. */
  token?: string;
  /** Directory of the phone web client to serve at `/`. */
  webDir?: string;
  staleMs?: number;
  host?: string;
  /** Serve conversation logs to phones. Default true; can be flipped at runtime. */
  shareTranscripts?: boolean;
  /** Directories a transcript file must live under. Default: ~/.claude and ~/.codex. */
  transcriptRoots?: string[];
  /** Where to look up the harness's own session names. Default: the real ~/.claude and ~/.codex. */
  nameSources?: NameSources;
}

export interface MonitorServer {
  readonly store: SessionStore;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Only events from these agents are accepted. */
  setEnabledAgents(agents: Iterable<AgentId>): void;
  setShareTranscripts(value: boolean): void;
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

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

export function createMonitorServer(opts: ServerOptions): MonitorServer {
  const store = new SessionStore({ staleMs: opts.staleMs });
  const enabled = new Set<AgentId>(['claude', 'codex']);
  let shareTranscripts = opts.shareTranscripts ?? true;
  const transcriptRoots = opts.transcriptRoots ?? [join(homedir(), '.claude'), join(homedir(), '.codex')];
  const names = new NameResolver(opts.nameSources ?? defaultNameSources());
  const nameChecked = new Map<string, number>();
  const viewers = new Map<string, Viewer>();
  const viewerListeners = new Set<(v: Viewer[]) => void>();
  let tickTimer: NodeJS.Timeout | undefined;

  const emitViewers = () => {
    const list = [...viewers.values()];
    for (const fn of viewerListeners) fn(list);
  };

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (isLoopback(req.socket.remoteAddress) || !opts.token) return true;
    return (url.searchParams.get('t') ?? req.headers['x-agent-monitor-token']) === opts.token;
  };

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

  async function handleEvent(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const agent = url.searchParams.get('agent') as AgentId | null;
    if (agent !== 'claude' && agent !== 'codex') return send(res, 400, { error: 'unknown agent' });
    let raw: unknown;
    try {
      raw = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'invalid json' });
    }
    if (enabled.has(agent)) {
      const ev = normalize(agent, raw);
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
    if ((agent !== 'claude' && agent !== 'codex') || !id) return send(res, 400, { error: 'agent and id required' });
    // The phone names a session; the file path only ever comes from the hook the agent itself sent.
    const known = store.transcriptPath(agent, id);
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

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const loopback = isLoopback(req.socket.remoteAddress);
    const route = `${req.method} ${url.pathname}`;
    const fail = (err: unknown) => {
      if (!res.headersSent) send(res, 500, { error: String(err) });
      else res.end();
    };

    // Ingest endpoints are for the agents' hooks on this machine only.
    if (route === 'POST /api/events' || route === 'POST /api/notify') {
      if (!loopback) return send(res, 403, { error: 'loopback only' });
      (route === 'POST /api/events' ? handleEvent(req, res, url) : handleNotify(req, res)).catch(fail);
      return;
    }
    if (route === 'GET /api/stream' || route === 'GET /api/state' || route === 'GET /api/transcript') {
      if (!authorized(req, url)) return send(res, 401, { error: 'bad token' });
      if (route === 'GET /api/transcript') {
        handleTranscript(res, url).catch(fail);
        return;
      }
      if (route === 'GET /api/state') return send(res, 200, { now: Date.now(), sessions: store.snapshot() });
      return handleStream(req, res);
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      handleStatic(res, url.pathname).catch(fail);
      return;
    }
    send(res, 404);
  });

  return {
    store,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
          server.off('error', reject);
          tickTimer = setInterval(() => store.tick(), TICK_MS);
          resolve();
        });
      });
    },
    stop() {
      clearInterval(tickTimer);
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // SSE streams would otherwise keep the port bound
        viewers.clear();
        emitViewers();
      });
    },
    setEnabledAgents(agents) {
      enabled.clear();
      for (const a of agents) enabled.add(a);
      for (const a of ['claude', 'codex'] as const) if (!enabled.has(a)) store.clearAgent(a);
    },
    setShareTranscripts(value) {
      shareTranscripts = value;
    },
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
