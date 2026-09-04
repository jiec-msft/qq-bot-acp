import fs from "node:fs/promises";
import WebSocket from "ws";
import { atomicWriteJson } from "../config/store.js";
import { QQApi } from "./api.js";
import type {
  QQAttachment,
  QQGatewayEvent,
  QQInboundMessage,
} from "./types.js";

const BASE_INTENTS = (1 << 25) | (1 << 30) | (1 << 12);
const FORUM_EVENT_INTENT = 1 << 28;
const MAX_RECONNECT_DELAY_MS = 30_000;

interface GatewayState {
  version: 1;
  appId?: string;
  intents?: number;
  sessionId?: string;
  sequence?: number;
  botUserId?: string;
  botUsername?: string;
}

export interface QQBotIdentity {
  id: string;
  username: string;
}

export interface QQForumThreadCreateEvent {
  guildId: string;
  channelId: string;
  authorId?: string;
  threadInfo: {
    threadId: string;
    title: unknown;
    content: unknown;
    dateTime: string;
  };
}

export interface QQForumPublishAuditEvent {
  guildId: string;
  channelId: string;
  authorId?: string;
  type: number;
  result: number;
  errorMessage?: string;
  threadId?: string;
  postId?: string;
  replyId?: string;
}

export interface QQGatewayOptions {
  forumEnabled?: boolean;
  onForumThreadCreate?: (
    event: QQForumThreadCreateEvent,
  ) => Promise<void>;
  onForumPublishAuditResult?: (
    event: QQForumPublishAuditEvent,
  ) => Promise<void>;
  onBotIdentity?: (identity: QQBotIdentity) => void;
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
  private stateOperations = Promise.resolve();
  private connectionGeneration = 0;

  constructor(
    private readonly api: QQApi,
    private readonly stateFile: string,
    private readonly onMessage: (message: QQInboundMessage) => Promise<void>,
    private readonly log: (message: string) => void,
    private readonly options: QQGatewayOptions = {},
  ) {
    this.state = {
      version: 1,
      appId: api.appId,
      intents: gatewayIntents(options.forumEnabled === true),
    };
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
      const generation = await this.withStateLock(async () => {
        if (this.stopped) return undefined;
        return ++this.connectionGeneration;
      });
      if (generation === undefined) return;
      const socket = new WebSocket(url);
      this.clearHeartbeat();
      this.socket = socket;
      this.payloadChain = Promise.resolve();

      socket.on("open", () => this.log("QQ gateway socket connected"));
      socket.on("message", (data) => {
        this.queuePayload(socket, String(data), generation);
      });
      socket.on("error", (error) => {
        if (!this.isCurrentConnection(generation, socket)) return;
        this.log(`QQ gateway error: ${error.message}`);
        if (!this.readySettled) {
          this.readySettled = true;
          this.rejectReady(error);
        }
      });
      socket.on("close", (code) => {
        if (!this.isCurrentConnection(generation, socket)) return;
        this.socket = undefined;
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

  private queuePayload(
    socket: WebSocket,
    raw: string,
    generation = this.connectionGeneration,
  ): void {
    if (!this.isCurrentConnection(generation, socket)) return;
    this.payloadChain = this.payloadChain
      .then(() => this.handlePayload(raw, generation, socket))
      .catch((error) => {
        this.log(`QQ gateway payload failed: ${String(error)}`);
        socket.close(4002, "payload handling failed");
        return new Promise<void>(() => {});
      });
  }

  private async handlePayload(
    raw: string,
    generation = this.connectionGeneration,
    socket = this.socket,
  ): Promise<void> {
    if (!this.isCurrentConnection(generation, socket)) return;
    let payload: QQGatewayEvent;
    try {
      payload = JSON.parse(raw) as QQGatewayEvent;
    } catch {
      this.log("Ignoring malformed QQ gateway payload");
      return;
    }

    const durableForumDispatch =
      payload.op === 0 &&
      (
        payload.t === "FORUM_THREAD_CREATE" ||
        payload.t === "FORUM_PUBLISH_AUDIT_RESULT"
      ) &&
      this.options.forumEnabled === true;
    if (durableForumDispatch) {
      await this.handleDispatch(payload.t, payload.d, generation, socket);
      if (payload.s !== undefined) {
        await this.saveSequence(payload.s, generation, socket);
      }
      return;
    }

    if (payload.op === 0 && payload.t === "READY") {
      await this.handleDispatch(payload.t, payload.d, generation, socket);
      if (payload.s !== undefined) {
        await this.saveSequence(payload.s, generation, socket);
      }
      return;
    }

    if (payload.s !== undefined) {
      await this.saveSequence(payload.s, generation, socket);
    }

    switch (payload.op) {
      case 10:
        this.handleHello(payload.d, generation, socket);
        return;
      case 0:
        await this.handleDispatch(payload.t, payload.d, generation, socket);
        return;
      case 7:
        socket?.close(4000, "server requested reconnect");
        return;
      case 9:
        await this.replaceState(generation, {
          version: 1,
          appId: this.api.appId,
          intents: gatewayIntents(this.options.forumEnabled === true),
        }, socket);
        socket?.close(4001, "invalid session");
        return;
    }
  }

  private handleHello(
    data: unknown,
    generation: number,
    socket?: WebSocket,
  ): void {
    if (!this.isCurrentConnection(generation, socket)) return;
    const interval =
      typeof data === "object" &&
      data !== null &&
      "heartbeat_interval" in data &&
      typeof data.heartbeat_interval === "number"
        ? data.heartbeat_interval
        : 41_250;
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      this.send(
        { op: 1, d: this.state.sequence ?? null },
        false,
        generation,
        socket,
      );
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
      }, true, generation, socket);
    } else {
      this.send({
        op: 2,
        d: {
          token: `QQBot ${this.currentTokenPlaceholder()}`,
          intents: gatewayIntents(this.options.forumEnabled === true),
          shard: [0, 1],
          properties: {
            os: process.platform,
            browser: "qq-bot-acp",
            device: "qq-bot-acp",
          },
        },
      }, true, generation, socket);
    }
  }

  private async handleDispatch(
    type: string | undefined,
    data: unknown,
    generation: number,
    socket?: WebSocket,
  ): Promise<void> {
    if (!this.isCurrentConnection(generation, socket)) return;
    if (type === "READY") {
      const ready = asRecord(data);
      const user = asRecord(ready.user);
      const sessionId =
        typeof ready.session_id === "string" ? ready.session_id : undefined;
      const identity =
        typeof user.id === "string" && typeof user.username === "string"
          ? { id: user.id, username: user.username }
          : undefined;
      const updated = await this.updateState(generation, (state) => {
        if (state.sessionId !== sessionId) state.sequence = undefined;
        state.sessionId = sessionId;
        state.intents = gatewayIntents(this.options.forumEnabled === true);
        state.botUserId = identity?.id;
        state.botUsername = identity?.username;
      }, socket);
      if (!updated) return;
      if (!this.isCurrentConnection(generation, socket)) return;
      if (identity) {
        this.options.onBotIdentity?.({
          id: identity.id,
          username: identity.username,
        });
      }
      this.markReady("new");
      return;
    }
    if (type === "RESUMED") {
      this.markReady("resumed");
      return;
    }
    if (!type || typeof data !== "object" || data === null) return;
    if (
      type === "FORUM_THREAD_CREATE" &&
      this.options.forumEnabled === true
    ) {
      const event = normalizeForumThreadCreate(data);
      this.log(`QQ gateway forum dispatch type=${type} accepted=${event !== null}`);
      if (event && this.options.onForumThreadCreate) {
        await this.options.onForumThreadCreate(event);
      }
      return;
    }
    if (
      type === "FORUM_PUBLISH_AUDIT_RESULT" &&
      this.options.forumEnabled === true
    ) {
      const event = normalizeForumPublishAuditResult(data);
      this.log(`QQ gateway forum dispatch type=${type} accepted=${event !== null}`);
      if (event && this.options.onForumPublishAuditResult) {
        await this.options.onForumPublishAuditResult(event);
      }
      return;
    }
    const message = normalizeInbound(type, data as Record<string, unknown>, this.api.appId);
    if (isMessageDispatch(type)) {
      this.log(
        `QQ gateway message dispatch type=${type} accepted=${message !== null} addressed=${message?.addressed ?? "n/a"}`,
      );
    }
    if (!message) return;
    void this.onMessage(message).catch((error) => {
      this.log(`Inbound message failed: ${String(error)}`);
    });
  }

  private send(
    payload: unknown,
    needsToken = false,
    generation = this.connectionGeneration,
    socket = this.socket,
  ): void {
    if (!this.isCurrentConnection(generation, socket)) return;
    if (!needsToken) {
      socket?.send(JSON.stringify(payload));
      return;
    }
    void this.api.getAccessToken().then((token) => {
      if (!this.isCurrentConnection(generation, socket)) return;
      const serialized = JSON.stringify(payload).replace(this.currentTokenPlaceholder(), token);
      socket?.send(serialized);
    }).catch((error) => {
      this.log(`Unable to authenticate QQ gateway: ${String(error)}`);
      socket?.close(4004, "authentication failed");
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
      const intents = gatewayIntents(this.options.forumEnabled === true);
      if (
        parsed.version === 1 &&
        parsed.appId === this.api.appId &&
        parsed.intents === intents
      ) {
        this.state = parsed;
        if (parsed.botUserId && parsed.botUsername) {
          this.options.onBotIdentity?.({
            id: parsed.botUserId,
            username: parsed.botUsername,
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private isCurrentConnection(
    generation: number,
    socket?: WebSocket,
  ): boolean {
    return (
      generation === this.connectionGeneration &&
      (socket === undefined || this.socket === socket)
    );
  }

  private saveSequence(
    sequence: number,
    generation = this.connectionGeneration,
    socket = this.socket,
  ): Promise<boolean> {
    return this.updateState(generation, (state) => {
      if (state.sequence === undefined || sequence > state.sequence) {
        state.sequence = sequence;
      }
    }, socket);
  }

  private replaceState(
    generation: number,
    state: GatewayState,
    socket?: WebSocket,
  ): Promise<boolean> {
    return this.withStateLock(async () => {
      if (!this.isCurrentConnection(generation, socket)) return false;
      await atomicWriteJson(this.stateFile, state);
      if (!this.isCurrentConnection(generation, socket)) return false;
      this.state = state;
      return true;
    });
  }

  private updateState(
    generation: number,
    update: (state: GatewayState) => void,
    socket?: WebSocket,
  ): Promise<boolean> {
    return this.withStateLock(async () => {
      if (!this.isCurrentConnection(generation, socket)) return false;
      const next = structuredClone(this.state);
      update(next);
      if (
        next.sequence === this.state.sequence &&
        next.sessionId === this.state.sessionId &&
        next.intents === this.state.intents &&
        next.botUserId === this.state.botUserId &&
        next.botUsername === this.state.botUsername
      ) {
        return true;
      }
      await atomicWriteJson(this.stateFile, next);
      if (!this.isCurrentConnection(generation, socket)) return false;
      this.state = next;
      return true;
    });
  }

  private withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.stateOperations.then(operation);
    this.stateOperations = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}

export function gatewayIntents(forumEnabled: boolean): number {
  return forumEnabled
    ? BASE_INTENTS | FORUM_EVENT_INTENT
    : BASE_INTENTS;
}

export function normalizeForumThreadCreate(
  value: unknown,
): QQForumThreadCreateEvent | null {
  const event = asRecord(value);
  const threadInfo = asRecord(event.thread_info);
  const guildId = String(event.guild_id ?? "");
  const channelId = String(event.channel_id ?? "");
  const threadId = String(threadInfo.thread_id ?? "");
  if (!guildId || !channelId || !threadId) return null;
  const authorId =
    typeof event.author_id === "string" && event.author_id
      ? event.author_id
      : undefined;
  return {
    guildId,
    channelId,
    authorId,
    threadInfo: {
      threadId,
      title: threadInfo.title ?? "",
      content: threadInfo.content ?? "",
      dateTime: String(threadInfo.date_time ?? ""),
    },
  };
}

export function normalizeForumPublishAuditResult(
  value: unknown,
): QQForumPublishAuditEvent | null {
  const event = asRecord(value);
  const guildId = String(event.guild_id ?? "");
  const channelId = String(event.channel_id ?? "");
  const type = numericEventValue(event.type);
  const result = numericEventValue(event.result);
  if (!guildId || !channelId || type === undefined || result === undefined) {
    return null;
  }
  return {
    guildId,
    channelId,
    authorId: optionalString(event.author_id),
    type,
    result,
    errorMessage: optionalString(event.err_msg),
    threadId: optionalString(event.thread_id),
    postId: optionalString(event.post_id),
    replyId: optionalString(event.reply_id),
  };
}

export function normalizeInbound(
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
  if (
    type === "GROUP_AT_MESSAGE_CREATE" ||
    type === "GROUP_MESSAGE_CREATE"
  ) {
    if (author.bot === true) return null;
    const addressed =
      type === "GROUP_AT_MESSAGE_CREATE" ||
      normalizeMentions(event.mentions).some((mention) => mention.bot === true);
    const senderId = String(author.member_openid ?? "");
    const targetId = String(event.group_openid ?? "");
    if (!senderId || !targetId) return null;
    return {
      ...base,
      conversationId: `qqbot:${accountId}:group:${targetId}`,
      chatType: "group",
      senderId,
      targetId,
      addressed,
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

function normalizeMentions(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function isMessageDispatch(type: string): boolean {
  return [
    "C2C_MESSAGE_CREATE",
    "GROUP_AT_MESSAGE_CREATE",
    "GROUP_MESSAGE_CREATE",
    "AT_MESSAGE_CREATE",
    "DIRECT_MESSAGE_CREATE",
  ].includes(type);
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numericEventValue(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numeric) ? numeric : undefined;
}
