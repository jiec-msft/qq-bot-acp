import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

export interface TurnPolicy {
  allowedWriteFiles?: string[];
  restrictPermissions?: boolean;
}

export interface TurnCallbacks {
  onText: (text: string) => Promise<void>;
  onThought?: (text: string) => Promise<void>;
  onComplete?: () => Promise<void>;
}

export class QQBotAcpClient implements acp.Client {
  private callbacks: TurnCallbacks = { onText: async () => {} };
  private taskChain = Promise.resolve();
  private showThoughts = false;
  private callbackError: unknown;
  private turnPolicy: TurnPolicy = {};

  constructor(private readonly workspace: string) {}

  beginTurn(
    callbacks: TurnCallbacks,
    showThoughts: boolean,
    policy: TurnPolicy = {},
  ): Promise<void> {
    return this.enqueue(async () => {
      this.callbacks = callbacks;
      this.showThoughts = showThoughts;
      this.callbackError = undefined;
      this.turnPolicy = policy;
    });
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    if (
      this.turnPolicy.restrictPermissions &&
      !this.isRestrictedToolAllowed(params.toolCall)
    ) {
      return { outcome: { outcome: "cancelled" } };
    }
    const selected =
      params.options.find((option) => option.kind === "allow_once") ??
      params.options.find((option) => option.kind === "allow_always") ??
      params.options[0];
    return selected
      ? { outcome: { outcome: "selected", optionId: selected.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  sessionUpdate(params: acp.SessionNotification): Promise<void> {
    return this.enqueue(async () => {
      const update = params.update;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        await this.invoke(this.callbacks.onText, update.content.text);
        return;
      }
      if (
        update.sessionUpdate === "agent_thought_chunk" &&
        update.content.type === "text" &&
        this.showThoughts
      ) {
        await this.invoke(this.callbacks.onThought, update.content.text);
      }
    });
  }

  async flush(): Promise<void> {
    await this.enqueue(async () => {
      if (this.callbackError !== undefined) throw this.callbackError;
      await this.callbacks.onComplete?.();
    });
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const file = await this.resolveReadPath(params.path);
    const content = await fs.readFile(file, "utf8");
    const lines = content.split(/\r?\n/);
    const start = params.line ? Math.max(0, params.line - 1) : 0;
    const selected =
      params.limit == null ? lines.slice(start) : lines.slice(start, start + params.limit);
    return { content: selected.join("\n") };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const file = await this.resolveWritePath(params.path);
    this.assertPolicyAllowsWrite(file);
    const handle = await fs.open(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(params.content, "utf8");
    } finally {
      await handle.close();
    }
    return {};
  }

  private async resolveReadPath(file: string): Promise<string> {
    const resolved = this.assertLexicallyContained(file);
    const real = await fs.realpath(resolved);
    await this.assertReallyContained(real);
    return real;
  }

  private async resolveWritePath(file: string): Promise<string> {
    const resolved = this.assertLexicallyContained(file);
    try {
      const stat = await fs.lstat(resolved);
      if (stat.isSymbolicLink()) {
        throw new Error("ACP file writes cannot target symbolic links");
      }
      const real = await fs.realpath(resolved);
      await this.assertReallyContained(real);
      return real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = await fs.realpath(path.dirname(resolved));
    await this.assertReallyContained(parent);
    return resolved;
  }

  private assertPolicyAllowsWrite(file: string): void {
    const allowed = this.turnPolicy.allowedWriteFiles;
    if (allowed === undefined) return;
    const normalized = path.resolve(file);
    if (!allowed.some((candidate) => path.resolve(candidate) === normalized)) {
      throw new Error("This ACP turn cannot write that file");
    }
  }

  private isRestrictedToolAllowed(toolCall: acp.ToolCallUpdate): boolean {
    if (
      toolCall.kind === "read" ||
      toolCall.kind === "search" ||
      toolCall.kind === "fetch" ||
      toolCall.kind === "think"
    ) {
      return true;
    }
    if (toolCall.kind !== "edit") return false;
    const allowed = this.turnPolicy.allowedWriteFiles ?? [];
    const locations = toolCall.locations ?? [];
    return (
      locations.length > 0 &&
      locations.every((location) => {
        const target = this.assertLexicallyContained(location.path);
        return allowed.some(
          (candidate) => path.resolve(candidate) === path.resolve(target),
        );
      })
    );
  }

  private assertLexicallyContained(file: string): string {
    const resolved = path.resolve(this.workspace, file);
    const relative = path.relative(path.resolve(this.workspace), resolved);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("ACP file access must stay inside agent.cwd");
    }
    return resolved;
  }

  private async assertReallyContained(target: string): Promise<void> {
    const root = await fs.realpath(this.workspace);
    const relative = path.relative(root, target);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("ACP file access must stay inside agent.cwd");
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.taskChain.then(task);
    this.taskChain = run.catch(() => {});
    return run;
  }

  private async invoke(
    callback: ((text: string) => Promise<void>) | undefined,
    text: string,
  ): Promise<void> {
    if (!callback || !text || this.callbackError !== undefined) return;
    try {
      await callback(text);
    } catch (error) {
      this.callbackError = error;
      throw error;
    }
  }
}
