import fs from "node:fs/promises";
import WebSocket from "ws";
import { atomicWriteJson } from "../config/store.js";
import { QQApi } from "./api.js";
import type {
  QQAttachment,
  QQGatewayEvent,
  QQInboundMessage,
} from "./types.js";

const INTENTS = (1 << 25) | (1 << 30) | (1 << 12);
const MAX_RECONNECT_DELAY_MS = 30_000;

interface GatewayState {
  version: 1;
  appId?: string;
  sessionId?: string;
  sequence?: number;
}

export class QQGateway {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private readySettled = false;
  private stopped = false;
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnectAttempt = 0;
  private state: GatewayState;
  private payloadChain = Promise.resolve();

  constructor(
    private readonly api: QQApi,
    private readonly stateFile: string,
    private readonly onMessage: (message: QQInboundMessage) => Promise<void>,
    private readonly log: (message: string) => void,
  ) {
    this.state = { version: 1, appId: api.appId };
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  async start(): Promise<void> {
    await this.loadState();
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeat();
    this.socket?.close(1000, "shutdown");
  }

  private async connect(): Promise<void> {
    try {
      const url = await this.api.getGatewayUrl();
      if (this.stopped) return;
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.on("open", () => this.log("QQ gateway socket connected"));
      socket.on("message", (data) => {
        const raw = String(data);
        this.payloadChain = this.payloadChain
          .then(() => this.handlePayload(raw))
          .catch((error) => this.log(`QQ gateway payload failed: ${String(error)}`));
      });
      socket.on("error", (error) => {
        this.log(`QQ gateway error: ${error.message}`);
        if (!this.readySettled) {
          this.readySettled = true;
          this.rejectReady(error);
        }
      });
      socket.on("close", (code) => {
        this.clearHeartbeat();
        if (!this.stopped && code !== 1000) void this.scheduleReconnect();
      });
    } catch (error) {
      if (!this.readySettled) {
        this.readySettled = true;
        this.rejectReady(error);
      }
      throw error;
    }
  }

  private async handlePayload(raw: string): Promise<void> {
    let payload: QQGatewayEvent;
    try {
      payload = JSON.parse(raw) as QQGatewayEvent;
    } catch {
      this.log("Ignoring malformed QQ gateway payload");
      return;
    }

    if (payload.s !== undefined) {
      this.state.sequence = payload.s;
      await this.saveState();
    }

    switch (payload.op) {
      case 10:
        this.handleHello(payload.d);
        return;
      case 0:
        await this.handleDispatch(payload.t, payload.d);
        return;
      case 7:
        this.socket?.close(4000, "server requested reconnect");
        return;
      case 9:
        this.state = { version: 1, appId: this.api.appId };
        await this.saveState();
        this.socket?.close(4001, "invalid session");
        return;
    }
  }

  private handleHello(data: unknown): void {
    const interval =
      typeof data === "object" &&
      data !== null &&
      "heartbeat_interval" in data &&
      typeof data.heartbeat_interval === "number"
        ? data.heartbeat_interval
        : 41_250;
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      this.send({ op: 1, d: this.state.sequence ?? null });
    }, interval);
    this.heartbeat.unref();

    if (this.state.sessionId && this.state.sequence !== undefined) {
      this.send({
        op: 6,
        d: {
          token: `QQBot ${this.currentTokenPlaceholder()}`,
          session_id: this.state.sessionId,
          seq: this.state.sequence,
        },
      }, true);
    } else {
      this.send({
        op: 2,
        d: {
          token: `QQBot ${this.currentTokenPlaceholder()}`,
          intents: INTENTS,
          shard: [0, 1],
          properties: {
            os: process.platform,
            browser: "qq-bot-acp",
            device: "qq-bot-acp",
          },
        },
      }, true);
    }
  }

  private async handleDispatch(type: string | undefined, data: unknown): Promise<void> {
    if (type === "READY") {
      const ready = data as { session_id?: string };
      this.state.sessionId = ready.session_id;
      await this.saveState();
      this.markReady("new");
      return;
    }
    if (type === "RESUMED") {
      this.markReady("resumed");
      return;
    }
    if (!type || typeof data !== "object" || data === null) return;
    const message = normalizeInbound(type, data as Record<string, unknown>, this.api.appId);
    if (!message) return;
    void this.onMessage(message).catch((error) => {
      this.log(`Inbound message failed: ${String(error)}`);
    });
  }

  private send(payload: unknown, needsToken = false): void {
    if (!needsToken) {
      this.socket?.send(JSON.stringify(payload));
      return;
    }
    void this.api.getAccessToken().then((token) => {
      const serialized = JSON.stringify(payload).replace(this.currentTokenPlaceholder(), token);
      this.socket?.send(serialized);
    }).catch((error) => {
      this.log(`Unable to authenticate QQ gateway: ${String(error)}`);
      this.socket?.close(4004, "authentication failed");
    });
  }

  private currentTokenPlaceholder(): string {
    return "__QQ_ACCESS_TOKEN__";
  }

  private markReady(source: "new" | "resumed"): void {
    this.reconnectAttempt = 0;
    if (!this.readySettled) {
      this.readySettled = true;
      this.resolveReady();
    }
    this.log(`QQ gateway ready (${source})`);
  }

  private async scheduleReconnect(): Promise<void> {
    this.reconnectAttempt++;
    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      1_000 * 2 ** Math.min(5, this.reconnectAttempt - 1),
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (!this.stopped) await this.connect();
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private async loadState(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.stateFile, "utf8")) as GatewayState;
      if (parsed.version === 1 && parsed.appId === this.api.appId) this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private saveState(): Promise<void> {
    return atomicWriteJson(this.stateFile, this.state);
  }
}

function normalizeInbound(
  type: string,
  event: Record<string, unknown>,
  accountId: string,
): QQInboundMessage | null {
  const author = asRecord(event.author);
  const attachments = normalizeAttachments(event.attachments);
  const base = {
    accountId,
    messageId: String(event.id ?? ""),
    timestamp: String(event.timestamp ?? new Date().toISOString()),
    text: cleanText(String(event.content ?? "")),
    attachments,
  };

  if (type === "C2C_MESSAGE_CREATE") {
    const senderId = String(author.user_openid ?? "");
    if (!senderId) return null;
    return {
      ...base,
      conversationId: `qqbot:${accountId}:direct:${senderId}`,
      chatType: "direct",
      senderId,
      targetId: senderId,
    };
  }
  if (type === "GROUP_AT_MESSAGE_CREATE") {
    const senderId = String(author.member_openid ?? "");
    const targetId = String(event.group_openid ?? "");
    if (!senderId || !targetId) return null;
    return {
      ...base,
      conversationId: `qqbot:${accountId}:group:${targetId}`,
      chatType: "group",
      senderId,
      targetId,
    };
  }
  if (type === "AT_MESSAGE_CREATE" || type === "DIRECT_MESSAGE_CREATE") {
    const senderId = String(author.id ?? "");
    const targetId = String(event.channel_id ?? "");
    if (!senderId || !targetId) return null;
    return {
      ...base,
      conversationId: `qqbot:${accountId}:channel:${targetId}`,
      chatType: "channel",
      senderId,
      senderName: typeof author.username === "string" ? author.username : undefined,
      targetId,
    };
  }
  return null;
}

function normalizeAttachments(value: unknown): QQAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (typeof record.url !== "string") return [];
    return [{
      contentType: String(record.content_type ?? "application/octet-stream"),
      url: record.url.startsWith("//") ? `https:${record.url}` : record.url,
      filename: typeof record.filename === "string" ? record.filename : undefined,
    }];
  });
}

function cleanText(text: string): string {
  return text.replace(/<@!?\d+>/g, "").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}
