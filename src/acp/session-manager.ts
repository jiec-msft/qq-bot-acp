import crypto from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import {
  ArtifactBroker,
  type ArtifactSession,
} from "../artifacts/broker.js";
import type { PreparedArtifact } from "../artifacts/file.js";
import type { BotConfig } from "../config/schema.js";
import { findSessionOption, SessionStateStore } from "./state.js";
import {
  startAgent,
  stopAgentProcess,
  type AgentConnection,
} from "./process.js";

interface ManagedSession {
  key: string;
  agent: AgentConnection;
  artifacts: ArtifactSession;
  chain: Promise<void>;
  active: boolean;
  lastActivity: number;
}

export interface PromptCallbacks {
  onText: (text: string) => Promise<void>;
  onThought?: (text: string) => Promise<void>;
  onArtifact?: (
    artifact: PreparedArtifact,
    caption?: string,
  ) => Promise<{ alreadySent: boolean }>;
  onComplete?: () => Promise<void>;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private pendingSessions = new Map<string, Promise<ManagedSession>>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private config: BotConfig,
    private readonly state: SessionStateStore,
    private readonly artifactBroker: ArtifactBroker,
    private readonly log: (message: string) => void,
  ) {}

  start(): void {
    this.cleanupTimer = setInterval(() => void this.cleanupIdle(), 60_000);
    this.cleanupTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await Promise.allSettled(this.pendingSessions.values());
    this.pendingSessions.clear();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => this.stopSession(session)));
  }

  async updateConfig(config: BotConfig): Promise<void> {
    const agentChanged =
      JSON.stringify(this.config.agent) !== JSON.stringify(config.agent) ||
      this.config.sessions.resume !== config.sessions.resume;
    this.config = config;
    if (agentChanged) await this.resetAll();
  }

  prompt(
    key: string,
    prompt: acp.ContentBlock[],
    callbacks: PromptCallbacks,
  ): Promise<void> {
    return this.enqueue(key, async (session) => {
      await session.agent.client.beginTurn(callbacks, this.config.output.showThoughts);
      session.artifacts.beginTurn(
        callbacks.onArtifact ??
          (async () => {
            throw new Error("Artifact delivery is unavailable for this turn");
          }),
      );
      session.active = true;
      try {
        await session.agent.connection.prompt({
          sessionId: session.agent.sessionId,
          prompt,
        });
        await session.agent.client.flush();
        await this.state.setSessionId(key, this.config.agent, session.agent.sessionId);
      } finally {
        session.artifacts.endTurn();
        session.active = false;
        session.lastActivity = Date.now();
      }
    });
  }

  async cancel(key: string): Promise<boolean> {
    const session = this.sessions.get(key);
    if (!session?.active) return false;
    await session.agent.connection.cancel({ sessionId: session.agent.sessionId });
    return true;
  }

  async reset(key: string): Promise<boolean> {
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    await this.state.clearSession(key, this.config.agent);
    if (!session) return false;
    await this.stopSession(session);
    return true;
  }

  async getSessionConfig(key: string): Promise<{
    active: boolean;
    available: acp.SessionConfigOption[];
    persisted: Record<string, string | boolean>;
  }> {
    const session = this.sessions.get(key);
    return {
      active: Boolean(session),
      available: session?.agent.configOptions ?? [],
      persisted: await this.state.getOptions(key, this.config.agent),
    };
  }

  async setSessionConfig(
    key: string,
    configId: string,
    value: string | boolean,
  ): Promise<acp.SessionConfigOption[]> {
    const session = this.sessions.get(key);
    if (!session) {
      throw new Error("No active ACP session. Send a normal message first.");
    }
    const option = findSessionOption(session.agent.configOptions, configId);
    if (!option) {
      const ids = session.agent.configOptions.map((entry) => entry.id);
      throw new Error(
        ids.length
          ? `Unknown session option "${configId}". Available: ${ids.join(", ")}`
          : "The active agent does not advertise configurable session options.",
      );
    }
    const response = await session.agent.connection.setSessionConfigOption(
      typeof value === "boolean"
        ? { sessionId: session.agent.sessionId, configId, type: "boolean", value }
        : { sessionId: session.agent.sessionId, configId, value },
    );
    session.agent.configOptions = response.configOptions;
    await this.state.setOption(key, this.config.agent, configId, value);
    return response.configOptions;
  }

  async resetSessionConfig(key: string): Promise<void> {
    await this.state.clearOptions(key, this.config.agent);
    await this.reset(key);
  }

  private async enqueue(
    key: string,
    operation: (session: ManagedSession) => Promise<void>,
  ): Promise<void> {
    const session = await this.getOrCreate(key);
    const run = session.chain.then(() => operation(session));
    session.chain = run.catch(() => {});
    return run;
  }

  private async getOrCreate(key: string): Promise<ManagedSession> {
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const pending = this.pendingSessions.get(key);
    if (pending) return pending;
    const creation = this.createSession(key);
    this.pendingSessions.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingSessions.get(key) === creation) {
        this.pendingSessions.delete(key);
      }
    }
  }

  private async createSession(key: string): Promise<ManagedSession> {
    if (this.sessions.size >= this.config.sessions.maxConcurrent) {
      await this.evictOldest();
    }
    const persistedSessionId = await this.state.getSessionId(key, this.config.agent);
    const artifacts = this.artifactBroker.createSession(this.config.agent.cwd);
    let agent: AgentConnection;
    try {
      agent = await startAgent(this.config.agent, {
        persistedSessionId,
        resume: this.config.sessions.resume,
        mcpServers: [artifacts.mcpServer],
        log: (message) =>
          this.log(`[conversation=${conversationLogId(key)}] ${message}`),
      });
    } catch (error) {
      artifacts.dispose();
      throw error;
    }
    const session: ManagedSession = {
      key,
      agent,
      artifacts,
      chain: Promise.resolve(),
      active: false,
      lastActivity: Date.now(),
    };
    this.sessions.set(key, session);
    agent.process.once("exit", () => {
      artifacts.dispose();
      if (this.sessions.get(key) === session) this.sessions.delete(key);
    });
    try {
      await this.applyPersistedOptions(session);
      return session;
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      await this.stopSession(session);
      throw error;
    }
  }

  private async applyPersistedOptions(session: ManagedSession): Promise<void> {
    const persisted = await this.state.getOptions(session.key, this.config.agent);
    for (const [configId, value] of Object.entries(persisted)) {
      if (!findSessionOption(session.agent.configOptions, configId)) continue;
      const response = await session.agent.connection.setSessionConfigOption(
        typeof value === "boolean"
          ? { sessionId: session.agent.sessionId, configId, type: "boolean", value }
          : { sessionId: session.agent.sessionId, configId, value },
      );
      session.agent.configOptions = response.configOptions;
    }
  }

  private async cleanupIdle(): Promise<void> {
    if (this.config.sessions.idleTimeoutMs === 0) return;
    const cutoff = Date.now() - this.config.sessions.idleTimeoutMs;
    const expired = [...this.sessions.values()].filter(
      (session) => !session.active && session.lastActivity < cutoff,
    );
    for (const session of expired) {
      this.sessions.delete(session.key);
      await this.stopSession(session);
    }
  }

  private async evictOldest(): Promise<void> {
    const oldest = [...this.sessions.values()]
      .filter((session) => !session.active)
      .sort((left, right) => left.lastActivity - right.lastActivity)[0];
    if (!oldest) throw new Error("Maximum concurrent ACP sessions reached");
    this.sessions.delete(oldest.key);
    await this.stopSession(oldest);
  }

  private async resetAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => this.stopSession(session)));
  }

  private async stopSession(session: ManagedSession): Promise<void> {
    session.artifacts.dispose();
    await stopAgentProcess(session.agent.process);
  }
}

export function conversationLogId(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}
