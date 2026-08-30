import type * as acp from "@agentclientprotocol/sdk";
import { SessionManager } from "../acp/session-manager.js";
import {
  getConfigValue,
  parseConfigValue,
  redactConfig,
  setConfigValue,
  type BotConfig,
} from "../config/schema.js";
import { ConfigStore } from "../config/store.js";
import { QQSender } from "../qq/sender.js";
import type { QQInboundMessage } from "../qq/types.js";
import { parseControlCommand, type ControlCommand } from "./commands.js";

export class BotController {
  constructor(
    private config: BotConfig,
    private readonly configStore: ConfigStore,
    private readonly sessions: SessionManager,
    private readonly sender: QQSender,
    private readonly log: (message: string) => void,
  ) {}

  getConfig(): BotConfig {
    return this.config;
  }

  async handleMessage(message: QQInboundMessage): Promise<void> {
    const command = parseControlCommand(message.text);

    if (command?.kind === "id") {
      if (message.chatType !== "direct") {
        await this.sender.reply(message, "The /id command is available in private chat only.");
      } else {
        await this.sender.reply(message, `Your QQ Bot OpenID is:\n${message.senderId}`);
      }
      return;
    }

    if (this.config.access.admins.length === 0) {
      await this.sender.reply(
        message,
        "Bot administration is not initialized. Send /id privately, then restart with --admin-openid.",
      );
      return;
    }

    if (command?.kind === "config") {
      await this.handleGlobalConfig(message, command);
      return;
    }
    if (command?.kind === "test-streaming") {
      if (message.chatType !== "direct" || !this.isAdmin(message.senderId)) {
        await this.sender.reply(
          message,
          "The /test-streaming command is restricted to administrators in private chat.",
        );
      } else if (command.error) {
        await this.sender.reply(message, command.error);
      } else {
        await this.sender.runStreamingDiagnostic(message, {
          delayMinutes: command.delayMinutes,
          isWakeup: command.wakeup,
        });
      }
      return;
    }
    if (!this.isAllowed(message)) {
      await this.sender.reply(message, "You are not allowed to use this bot.");
      return;
    }
    if (command?.kind === "session-config") {
      await this.handleSessionConfig(message, command);
      return;
    }
    if (command?.kind === "cancel") {
      const cancelled = await this.sessions.cancel(message.conversationId);
      await this.sender.reply(message, cancelled ? "Current ACP turn cancelled." : "No active ACP turn.");
      return;
    }
    if (command?.kind === "new") {
      await this.sessions.reset(message.conversationId);
      await this.sender.reply(message, "ACP session cleared. Your next message starts a new session.");
      return;
    }

    const prompt = await messageToPrompt(message);
    const reply = this.sender.createReply(message);
    let thoughtStarted = false;
    let answerStarted = false;
    await this.sessions.prompt(message.conversationId, prompt, {
      onText: async (text) => {
        if (thoughtStarted && !answerStarted) {
          answerStarted = true;
          await reply.write("\n\n## Answer\n\n");
        }
        await reply.write(text);
      },
      onThought: async (text) => {
        if (!thoughtStarted) {
          thoughtStarted = true;
          await reply.write("## Thought\n\n");
        }
        await reply.write(text);
      },
      onArtifact: (artifact, caption) =>
        reply.sendArtifact(artifact, caption),
      onComplete: () => reply.finish(),
    });
  }

  private async handleGlobalConfig(
    message: QQInboundMessage,
    command: Extract<ControlCommand, { kind: "config" }>,
  ): Promise<void> {
    if (message.chatType !== "direct" || !this.isAdmin(message.senderId)) {
      await this.sender.reply(message, "Global configuration is restricted to administrators in private chat.");
      return;
    }

    try {
      if (command.operation === "show") {
        await this.sender.reply(message, json(redactConfig(this.config)));
        return;
      }
      if (command.operation === "status") {
        await this.sender.reply(
          message,
          `Config: ${this.configStore.paths.config}\nProven backup: ${this.configStore.paths.provenConfig}`,
        );
        return;
      }
      if (command.operation === "get") {
        if (!command.key) throw new Error("Usage: /config get <key>");
        await this.sender.reply(message, json(getConfigValue(redactConfig(this.config) as BotConfig, command.key)));
        return;
      }
      if (!command.key || !command.value) {
        throw new Error("Usage: /config <key> <value>");
      }
      const previous = this.config;
      const candidate = setConfigValue(
        previous,
        command.key,
        parseConfigValue(command.value),
      );
      await this.configStore.write(candidate);
      try {
        await this.sessions.updateConfig(candidate);
        this.config = candidate;
      } catch (error) {
        await this.configStore.write(previous);
        await this.sessions.updateConfig(previous);
        throw error;
      }
      const restartRequired = command.key.startsWith("qq.");
      await this.sender.reply(
        message,
        `Updated ${command.key}.${restartRequired ? " Restart required for the QQ connection change." : ""}`,
      );
    } catch (error) {
      await this.sender.reply(message, `Configuration error: ${errorMessage(error)}`);
    }
  }

  private async handleSessionConfig(
    message: QQInboundMessage,
    command: Extract<ControlCommand, { kind: "session-config" }>,
  ): Promise<void> {
    try {
      if (command.operation === "show") {
        const state = await this.sessions.getSessionConfig(message.conversationId);
        await this.sender.reply(message, json(state));
        return;
      }
      if (command.operation === "reset") {
        await this.sessions.resetSessionConfig(message.conversationId);
        await this.sender.reply(
          message,
          "Session configuration cleared. Your next message starts a new ACP session.",
        );
        return;
      }
      if (!command.key || !command.value) {
        throw new Error("Usage: /session-config <key> <value>");
      }
      await this.sessions.setSessionConfig(
        message.conversationId,
        command.key,
        parseSessionValue(command.value),
      );
      await this.sender.reply(message, `Updated session option ${command.key}.`);
    } catch (error) {
      await this.sender.reply(message, `Session configuration error: ${errorMessage(error)}`);
    }
  }

  private isAdmin(senderId: string): boolean {
    return this.config.access.admins.includes(senderId);
  }

  private isAllowed(message: QQInboundMessage): boolean {
    if (this.isAdmin(message.senderId)) return true;
    const allowed =
      message.chatType === "group"
        ? this.config.access.groupAllowFrom
        : this.config.access.allowFrom;
    return allowed.includes("*") || allowed.includes(message.senderId);
  }
}

async function messageToPrompt(message: QQInboundMessage): Promise<acp.ContentBlock[]> {
  const blocks: acp.ContentBlock[] = [];
  if (message.text) blocks.push({ type: "text", text: message.text });
  for (const attachment of message.attachments) {
    if (attachment.contentType.startsWith("image/")) {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        blocks.push({ type: "text", text: `[Image download failed: ${attachment.url}]` });
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 10 * 1024 * 1024) {
        blocks.push({ type: "text", text: `[Image too large: ${attachment.url}]` });
        continue;
      }
      blocks.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: attachment.contentType,
      });
    } else {
      blocks.push({
        type: "text",
        text: `[Attachment: ${attachment.filename ?? attachment.contentType} — ${attachment.url}]`,
      });
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "[empty message]" });
  return blocks;
}

function parseSessionValue(raw: string): string | boolean {
  const parsed = parseConfigValue(raw);
  if (typeof parsed !== "string" && typeof parsed !== "boolean") {
    throw new Error("Session option values must be strings or booleans");
  }
  return parsed;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
