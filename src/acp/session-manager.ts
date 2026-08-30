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
  applySessionOptions,
  startAgent,
  stopAgentProcess,
  type AgentConnection,
  validateSessionOptionValues,
} from "./process.js";
import type { TurnPolicy } from "./client.js";

interface ManagedSession {
  key: string;
  agent: AgentConnection;
  artifacts: ArtifactSession;
  chain: Promise<void>;
  active: boolean;
  pendingOperations: number;
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
  policy?: TurnPolicy;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private pendingSessions = new Map<string, Promise<ManagedSession>>();
  private pendingOperationReservations = new Map<string, number>();
  private reservedSessions = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private configGeneration = 0;

  constructor(
    private config: BotConfig,
    private readonly state: SessionStateStore,
    private readonly artifactBroker: ArtifactBroker,
    private readonly log: (message: string) => void,
  ) {}

  start(): void {
    this.stopping = false;
    this.cleanupTimer = setInterval(() => void this.cleanupIdle(), 60_000);
    this.cleanupTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const operations = [...this.operationChains.values()];
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await Promise.allSettled(this.pendingSessions.values());
    this.pendingSessions.clear();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => this.stopSession(session)));
    await Promise.race([
      Promise.allSettled(operations),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    this.operationChains.clear();
    const lateSessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(
      lateSessions.map((session) => this.stopSession(session)),
    );
  }

  async updateConfig(config: BotConfig): Promise<void> {
    const agentChanged =
      JSON.stringify(this.config.agent) !== JSON.stringify(config.agent) ||
      this.config.sessions.resume !== config.sessions.resume ||
      JSON.stringify(this.config.sessions.defaultOptions) !==
        JSON.stringify(config.sessions.defaultOptions);
    this.config = config;
    if (agentChanged) {
      this.configGeneration++;
      await this.resetAll();
    }
  }

  prompt(
    key: string,
    prompt: acp.ContentBlock[],
    callbacks: PromptCallbacks,
  ): Promise<void> {
    return this.serialize(key, () => this.enqueue(key, async (session) => {
      await session.agent.client.beginTurn(
        callbacks,
        this.config.output.showThoughts,
        callbacks.policy,
      );
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
    }));
  }

  async cancel(key: string): Promise<boolean> {
    const session = this.sessions.get(key);
    if (!session?.active) return false;
    await session.agent.connection.cancel({ sessionId: session.agent.sessionId });
    return true;
  }

  async reset(key: string): Promise<boolean> {
    return this.serialize(key, () => this.resetNow(key));
  }

  private async resetNow(key: string): Promise<boolean> {
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
    return this.serialize(key, async () => {
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
      session.pendingOperations++;
      try {
        const response = await session.agent.connection.setSessionConfigOption(
          typeof value === "boolean"
            ? { sessionId: session.agent.sessionId, configId, type: "boolean", value }
            : { sessionId: session.agent.sessionId, configId, value },
        );
        session.agent.configOptions = response.configOptions;
        await this.state.setOption(key, this.config.agent, configId, value);
        return response.configOptions;
      } finally {
        session.pendingOperations--;
      }
    });
  }

  async resetSessionConfig(key: string): Promise<void> {
    await this.serialize(key, async () => {
      await this.state.clearOptions(key, this.config.agent);
      await this.resetNow(key);
    });
  }

  async setSessionPreset(
    key: string,
    values: Record<string, string | boolean>,
  ): Promise<void> {
    await this.serialize(key, async () => {
      const existing = this.sessions.get(key);
      if (existing) {
        validateSessionOptionValues(existing.agent.configOptions, values, true);
      } else {
        await this.validatePreset(values);
      }
      await this.state.replaceOptions(key, this.config.agent, values);
      await this.resetNow(key);
    });
  }

  async getRuntimeStatus(key: string): Promise<{
    conversationLoaded: boolean;
    conversationActive: boolean;
    residentSessions: number;
    pendingSessions: number;
    activeTurns: number;
    maxConcurrent: number;
    options: Record<string, string | boolean>;
  }> {
    const session = this.sessions.get(key);
    return {
      conversationLoaded: Boolean(session),
      conversationActive: session?.active ?? false,
      residentSessions: this.sessions.size,
      pendingSessions: this.pendingSessions.size,
      activeTurns: [...this.sessions.values()].filter(
        (candidate) => candidate.active,
      ).length,
      maxConcurrent: this.config.sessions.maxConcurrent,
      options: {
        ...this.config.sessions.defaultOptions,
        ...await this.state.getOptions(key, this.config.agent),
      },
    };
  }

  private async enqueue(
    key: string,
    operation: (session: ManagedSession) => Promise<void>,
  ): Promise<void> {
    const session = await this.acquireSessionForOperation(key);
    const run = session.chain
      .then(() => operation(session))
      .finally(() => {
        session.pendingOperations--;
      });
    session.chain = run.catch(() => {});
    return run;
  }

  private async getOrCreate(key: string): Promise<ManagedSession> {
    if (this.stopping) throw new Error("ACP session manager is stopping");
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const pending = this.pendingSessions.get(key);
    if (pending) return pending;
    this.reservedSessions++;
    const creation = this.createSession(
      key,
      this.configGeneration,
      this.config,
    );
    this.pendingSessions.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingSessions.get(key) === creation) {
        this.pendingSessions.delete(key);
      }
    }
  }

  private async createSession(
    key: string,
    generation: number,
    config: BotConfig,
  ): Promise<ManagedSession> {
    let reservationActive = true;
    let session: ManagedSession | undefined;
    let artifacts: ArtifactSession | undefined;
    try {
      if (this.stopping) throw new Error("ACP session manager is stopping");
      if (
        this.sessions.size + this.reservedSessions >
        config.sessions.maxConcurrent
      ) {
        await this.evictOldest();
      }
      const persistedSessionId = await this.state.getSessionId(
        key,
        config.agent,
      );
      artifacts = this.artifactBroker.createSession(config.agent.cwd);
      const agent = await startAgent(config.agent, {
        persistedSessionId,
        resume: config.sessions.resume,
        mcpServers: [artifacts.mcpServer],
        log: (message) =>
          this.log(`[conversation=${conversationLogId(key)}] ${message}`),
      });
      session = {
        key,
        agent,
        artifacts,
        chain: Promise.resolve(),
        active: false,
        pendingOperations: this.pendingOperationReservations.get(key) ?? 0,
        lastActivity: Date.now(),
      };
      await applySessionOptions(
        session.agent,
        config.sessions.defaultOptions,
        true,
      );
      await this.applyPersistedOptions(session, config.agent);
      if (this.stopping) {
        throw new Error("ACP session manager is stopping");
      }
      if (generation !== this.configGeneration) {
        throw new Error("ACP configuration changed while creating the session");
      }
      this.reservedSessions--;
      reservationActive = false;
      this.sessions.set(key, session);
      agent.process.once("exit", () => {
        artifacts?.dispose();
        if (this.sessions.get(key) === session) this.sessions.delete(key);
      });
      return session;
    } catch (error) {
      if (session) await this.stopSession(session);
      else artifacts?.dispose();
      throw error;
    } finally {
      if (reservationActive) this.reservedSessions--;
    }
  }

  private async applyPersistedOptions(
    session: ManagedSession,
    agentConfig: BotConfig["agent"],
  ): Promise<void> {
    const persisted = await this.state.getOptions(session.key, agentConfig);
    await applySessionOptions(session.agent, persisted, false);
  }

  private async validatePreset(
    values: Record<string, string | boolean>,
  ): Promise<void> {
    const artifacts = this.artifactBroker.createSession(this.config.agent.cwd);
    let agent: AgentConnection | undefined;
    try {
      agent = await startAgent(this.config.agent, {
        mcpServers: [artifacts.mcpServer],
      });
      validateSessionOptionValues(agent.configOptions, values, true);
    } finally {
      artifacts.dispose();
      if (agent) await stopAgentProcess(agent.process);
    }
  }

  private async cleanupIdle(): Promise<void> {
    if (this.config.sessions.idleTimeoutMs === 0) return;
    const cutoff = Date.now() - this.config.sessions.idleTimeoutMs;
    const expired = [...this.sessions.values()].filter(
      (session) =>
        !session.active &&
        session.pendingOperations === 0 &&
        session.lastActivity < cutoff,
    );
    for (const session of expired) {
      this.sessions.delete(session.key);
      await this.stopSession(session);
    }
  }

  private async evictOldest(): Promise<void> {
    const oldest = [...this.sessions.values()]
      .filter(
        (session) => !session.active && session.pendingOperations === 0,
      )
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

  private readonly operationChains = new Map<string, Promise<void>>();

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopping) {
      return Promise.reject(new Error("ACP session manager is stopping"));
    }
    const previous = this.operationChains.get(key) ?? Promise.resolve();
    const run = previous.then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.operationChains.set(key, settled);
    void settled.finally(() => {
      if (this.operationChains.get(key) === settled) {
        this.operationChains.delete(key);
      }
    });
    return run;
  }

  private async acquireSessionForOperation(
    key: string,
  ): Promise<ManagedSession> {
    const existing = this.sessions.get(key);
    if (existing) {
      existing.pendingOperations++;
      return existing;
    }
    this.pendingOperationReservations.set(
      key,
      (this.pendingOperationReservations.get(key) ?? 0) + 1,
    );
    try {
      return await this.getOrCreate(key);
    } finally {
      const remaining =
        (this.pendingOperationReservations.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.pendingOperationReservations.set(key, remaining);
      } else {
        this.pendingOperationReservations.delete(key);
      }
    }
  }
}

export function conversationLogId(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}
