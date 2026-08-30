import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { atomicWriteJson } from "../config/store.js";
import type { BotConfig } from "../config/schema.js";

interface PersistedState {
  version: 1;
  sessionIds: Record<string, string>;
  options: Record<string, Record<string, string | boolean>>;
}

export class SessionStateStore {
  private state: PersistedState = { version: 1, sessionIds: {}, options: {} };
  private loaded = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as PersistedState;
      if (parsed.version === 1) this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async getSessionId(key: string, agent: BotConfig["agent"]): Promise<string | undefined> {
    await this.load();
    return this.state.sessionIds[scopeKey(key, agent)];
  }

  async setSessionId(key: string, agent: BotConfig["agent"], id: string): Promise<void> {
    await this.load();
    this.state.sessionIds[scopeKey(key, agent)] = id;
    await this.save();
  }

  async clearSession(key: string, agent: BotConfig["agent"]): Promise<void> {
    await this.load();
    delete this.state.sessionIds[scopeKey(key, agent)];
    await this.save();
  }

  async getOptions(
    key: string,
    agent: BotConfig["agent"],
  ): Promise<Record<string, string | boolean>> {
    await this.load();
    return { ...(this.state.options[scopeKey(key, agent)] ?? {}) };
  }

  async setOption(
    key: string,
    agent: BotConfig["agent"],
    configId: string,
    value: string | boolean,
  ): Promise<void> {
    await this.load();
    const scope = scopeKey(key, agent);
    this.state.options[scope] = { ...(this.state.options[scope] ?? {}), [configId]: value };
    await this.save();
  }

  async setOptions(
    key: string,
    agent: BotConfig["agent"],
    values: Record<string, string | boolean>,
  ): Promise<void> {
    await this.load();
    const scope = scopeKey(key, agent);
    this.state.options[scope] = {
      ...(this.state.options[scope] ?? {}),
      ...values,
    };
    await this.save();
  }

  async replaceOptions(
    key: string,
    agent: BotConfig["agent"],
    values: Record<string, string | boolean>,
  ): Promise<void> {
    await this.load();
    this.state.options[scopeKey(key, agent)] = { ...values };
    await this.save();
  }

  async clearOptions(key: string, agent: BotConfig["agent"]): Promise<void> {
    await this.load();
    delete this.state.options[scopeKey(key, agent)];
    await this.save();
  }

  private save(): Promise<void> {
    return atomicWriteJson(this.file, this.state);
  }
}

export function findSessionOption(
  options: SessionConfigOption[],
  id: string,
): SessionConfigOption | undefined {
  return options.find((option) => option.id === id);
}

function scopeKey(key: string, agent: BotConfig["agent"]): string {
  const identity = JSON.stringify({
    command: agent.command,
    args: agent.args,
    cwd: agent.cwd,
  });
  const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `${digest}:${key}`;
}
