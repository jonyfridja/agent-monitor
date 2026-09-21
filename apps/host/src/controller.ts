import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { createAdapters, type InstallState } from '@agent-monitor/adapters';
import { AGENT_IDS, type AgentId, type Session, type Viewer } from '@agent-monitor/protocol';
import {
  CONFIG_PATH,
  createMonitorServer,
  defaultNameSources,
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
    await this.#syncHooks();
    await this.startServer();
  }

  async startServer(): Promise<void> {
    if (this.#server) return;
    const server = createMonitorServer({
      port: this.#config.port,
      token: this.#config.token,
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
    this.#error = undefined;
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
    await this.#syncHooks();
    this.#changed();
  }

  /** Re-write hooks for an enabled agent (e.g. after fixing a broken config file). */
  async reinstall(id: AgentId): Promise<void> {
    await this.#syncOne(id, true);
    this.#changed();
  }

  async setShareTranscripts(value: boolean): Promise<void> {
    this.#config.shareTranscripts = value;
    await saveConfig(this.#config, this.#opts.configPath ?? CONFIG_PATH);
    this.#server?.setShareTranscripts(value);
    this.#changed();
  }

  async setLaunchAtLogin(value: boolean): Promise<void> {
    this.#config.launchAtLogin = value;
    await saveConfig(this.#config, this.#opts.configPath ?? CONFIG_PATH);
    this.#changed();
  }

  async #syncHooks(): Promise<void> {
    await Promise.all(AGENT_IDS.map((id) => this.#syncOne(id)));
  }

  /** Enabled → hooks point at our port; disabled → our hooks removed. Foreign hooks are never touched. */
  async #syncOne(id: AgentId, force = false): Promise<void> {
    const adapter = this.#adapters[id];
    try {
      const state = await adapter.state(this.#config.port);
      if (this.#config.agents[id].enabled) {
        if (force || state !== 'installed') await adapter.install(this.#config.port);
        this.#hooks[id] = { hook: 'installed' };
      } else {
        if (state !== 'not-installed') await adapter.uninstall();
        this.#hooks[id] = { hook: 'not-installed' };
      }
    } catch (err) {
      this.#hooks[id] = { hook: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  state(): HostState {
    const [ip] = lanAddresses();
    const agents = Object.fromEntries(
      AGENT_IDS.map((id) => [id, { enabled: this.#config.agents[id].enabled, ...this.#hooks[id] }]),
    ) as Record<AgentId, AgentState>;
    return {
      running: !!this.#server,
      port: this.#config.port,
      phoneUrl: this.#server && ip ? `http://${ip}:${this.#config.port}/?t=${this.#config.token}` : null,
      error: this.#error,
      agents,
      sessions: this.#server?.store.snapshot() ?? [],
      viewers: this.#server?.viewers() ?? [],
      launchAtLogin: this.#config.launchAtLogin,
      shareTranscripts: this.#config.shareTranscripts,
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
