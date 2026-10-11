import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { createAdapters, type InstallState } from '@agent-monitor/adapters';
import { AGENT_IDS, type AgentId, type Session, type Viewer } from '@agent-monitor/protocol';
import {
  CONFIG_PATH,
  createMonitorServer,
  defaultNameSources,
  DEFAULT_PASSWORD,
  ensureCert,
  hashPassword,
  MIN_PASSWORD,
  verifyPassword,
  lanAddresses,
  loadConfig,
  saveConfig,
  type Config,
  type MonitorServer,
} from '@agent-monitor/server';

export interface AgentState {
  enabled: boolean;
  hook: InstallState | 'error';
  error?: string;
}

/** Everything the tray and window need, as plain data (safe to send over IPC). */
export interface HostState {
  running: boolean;
  port: number;
  phoneUrl: string | null;
  error?: string;
  agents: Record<AgentId, AgentState>;
  sessions: Session[];
  viewers: Viewer[];
  launchAtLogin: boolean;
  shareTranscripts: boolean;
  /** No password chosen yet: phones can't log in, and the window shows only the setup form. */
  needsPassword: boolean;
  /** HTTPS for phones; set when a certificate loaded. */
  https: boolean;
  /** SHA-256 of the self-signed cert, to compare with what the phone shows. */
  certFingerprint?: string;
}

export interface ControllerOptions {
  webDir: string;
  configPath?: string;
  /** Home dir holding `.claude` / `.codex`; overridable for tests. */
  home?: string;
  /** Overrides the saved port (tests). */
  port?: number;
}

/** Owns config, the server and the agents' hook files. No Electron imports: testable in plain Node. */
export class Controller extends EventEmitter {
  #opts: ControllerOptions;
  #adapters: ReturnType<typeof createAdapters>;
  #config!: Config;
  #server?: MonitorServer;
  #unsubscribe: (() => void)[] = [];
  #hooks: Record<AgentId, Pick<AgentState, 'hook' | 'error'>> = {
    claude: { hook: 'not-installed' },
    codex: { hook: 'not-installed' },
  };
  #error?: string;
  #pending?: NodeJS.Timeout;
  #tls?: { fingerprint: string };
  #tlsError?: string;
  #needsPassword = false;

  constructor(opts: ControllerOptions) {
    super();
    this.#opts = opts;
    this.#adapters = createAdapters(opts.home);
  }

  get config(): Config {
    return this.#config;
  }

  async init(): Promise<void> {
    this.#config = await loadConfig(this.#opts.configPath ?? CONFIG_PATH);
    if (this.#opts.port) this.#config.port = this.#opts.port;
    this.#needsPassword = await verifyPassword(DEFAULT_PASSWORD, this.#config.passwordHash);
    await this.refreshHooks();
    await this.startServer();
  }

  async startServer(): Promise<void> {
    if (this.#server) return;
    const tls = await this.#loadTls();
    const server = createMonitorServer({
      port: this.#config.port,
      token: this.#config.token,
      passwordHash: this.#config.passwordHash,
      sessionSecret: this.#config.sessionSecret,
      setupRequired: this.#needsPassword,
      tls,
      webDir: this.#opts.webDir,
      shareTranscripts: this.#config.shareTranscripts,
      nameSources: this.#opts.home ? defaultNameSources(this.#opts.home) : undefined,
      transcriptRoots: this.#opts.home ? [join(this.#opts.home, '.claude'), join(this.#opts.home, '.codex')] : undefined,
    });
    server.setEnabledAgents(AGENT_IDS.filter((a) => this.#config.agents[a].enabled));
    try {
      await server.start();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.#error = code === 'EADDRINUSE' ? `Port ${this.#config.port} is already in use` : String(err);
      this.#changed();
      return;
    }
    this.#error = this.#tlsError;
    this.#tls = tls;
    this.#server = server;
    this.#unsubscribe = [server.store.subscribe(() => this.#changed()), server.onViewersChange(() => this.#changed())];
    this.#changed();
  }

  async stopServer(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    await server.stop();
    this.#changed();
  }

  async setAgentEnabled(id: AgentId, enabled: boolean): Promise<void> {
    this.#config.agents[id].enabled = enabled;
    await saveConfig(this.#config, this.#opts.configPath ?? CONFIG_PATH);
    this.#server?.setEnabledAgents(AGENT_IDS.filter((a) => this.#config.agents[a].enabled));
    this.#changed();
  }

  /** Only on the user's request: add our hook entries to the agent's config file. */
  async installHooks(id: AgentId): Promise<void> {
    await this.#hookAction(id, () => this.#adapters[id].install(this.#config.port));
  }

  /** Only on the user's request: remove our hook entries (and only ours). */
  async uninstallHooks(id: AgentId): Promise<void> {
    await this.#hookAction(id, () => this.#adapters[id].uninstall());
  }

  async #hookAction(id: AgentId, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.#hooks[id] = { hook: 'error', error: err instanceof Error ? err.message : String(err) };
      this.#changed();
      return;
    }
    await this.refreshHooks();
  }

  async setShareTranscripts(value: boolean): Promise<void> {
    this.#config.shareTranscripts = value;
    await saveConfig(this.#config, this.#opts.configPath ?? CONFIG_PATH);
    this.#server?.setShareTranscripts(value);
    this.#changed();
  }

  /** Change the phone password. Applies at once and signs every phone out. */
  async setPassword(password: string): Promise<void> {
    // Strength rules live in the window; here only what keeps the state consistent.
    if (password.length < MIN_PASSWORD) throw new Error(`The password needs at least ${MIN_PASSWORD} characters.`);
    if (password === DEFAULT_PASSWORD) throw new Error('Choose something other than the placeholder password.');
    this.#config.passwordHash = await hashPassword(password);
    this.#needsPassword = false;
    await saveConfig(this.#config, this.#opts.configPath ?? CONFIG_PATH);
    this.#server?.setPasswordHash(this.#config.passwordHash);
    this.#changed();
  }

  async #loadTls() {
    this.#tlsError = undefined;
    if (!this.#config.tls.enabled) return undefined;
    try {
      return await ensureCert(join(dirname(this.#opts.configPath ?? CONFIG_PATH), 'tls'), lanAddresses(), this.#config.tls);
    } catch (err) {
      this.#tlsError = `HTTPS is off — no certificate: ${err instanceof Error ? err.message : String(err)}`;
      return undefined;
    }
  }

  async setLaunchAtLogin(value: boolean): Promise<void> {
    this.#config.launchAtLogin = value;
    await saveConfig(this.#config, this.#opts.configPath ?? CONFIG_PATH);
    this.#changed();
  }

  /** Read (never write) each agent's hook file to show whether our hooks are in it. */
  async refreshHooks(): Promise<void> {
    await Promise.all(
      AGENT_IDS.map(async (id) => {
        try {
          this.#hooks[id] = { hook: await this.#adapters[id].state(this.#config.port) };
        } catch (err) {
          this.#hooks[id] = { hook: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    this.#changed();
  }

  state(): HostState {
    const [ip] = lanAddresses();
    const agents = Object.fromEntries(
      AGENT_IDS.map((id) => [id, { enabled: this.#config.agents[id].enabled, ...this.#hooks[id] }]),
    ) as Record<AgentId, AgentState>;
    return {
      running: !!this.#server,
      port: this.#config.port,
      phoneUrl:
        this.#server && ip
          ? `${this.#tls ? 'https' : 'http'}://${ip}:${this.#config.port}/`
          : null,
      error: this.#error,
      agents,
      sessions: this.#server?.store.snapshot() ?? [],
      viewers: this.#server?.viewers() ?? [],
      launchAtLogin: this.#config.launchAtLogin,
      shareTranscripts: this.#config.shareTranscripts,
      needsPassword: this.#needsPassword,
      https: !!this.#tls,
      certFingerprint: this.#tls?.fingerprint,
    };
  }

  /** Coalesce bursts (a busy agent emits an event per tool call) into ~10 updates/s. */
  #changed(): void {
    if (this.#pending) return;
    this.#pending = setTimeout(() => {
      this.#pending = undefined;
      this.emit('change', this.state());
    }, 100);
  }

  async shutdown(): Promise<void> {
    await this.stopServer();
    clearTimeout(this.#pending);
  }
}
