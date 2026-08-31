import { createHash } from "node:crypto";
import type {
  ArtifactKind,
  PreparedArtifact,
} from "../artifacts/file.js";
import type { BotConfig } from "../config/schema.js";
import type {
  QQMediaFileType,
  QQSendMediaInput,
  QQSendStreamInput,
  QQStreamMessageResponse,
  QQSendTextInput,
  QQUploadMediaInput,
} from "./api.js";
import { QQApiError } from "./api.js";
import {
  findStreamingSplit,
  renderNativeMarkdownForQQ,
  renderMarkdownForQQ,
  splitMarkdown,
  splitText,
  trimBlockStart,
} from "./format.js";
import type { QQInboundMessage } from "./types.js";

const DIRECT_MAX_PASSIVE_REPLIES = 4;
const GROUP_MAX_PASSIVE_REPLIES = 5;
const CHANNEL_MAX_PASSIVE_REPLIES = 5;
const PROGRESSIVE_REPLY_LIMIT = 2;
const FINAL_REPLY_RESERVE = 1;
const MAX_ARTIFACTS_PER_TURN = 2;
const STREAM_LENGTH_MARGIN = 64;
const STREAM_UPDATE_INTERVAL_MS = 300;
const STREAM_DIAGNOSTIC_INTERVAL_MS = 1_000;
const PASSIVE_REPLY_SAFE_MS = 4 * 60 * 1000;
const STREAM_EMPTY_PLACEHOLDER = "…";
const STREAM_COMPLETION_MARKER = "\n\n🔚";
const STREAM_RECOVERY_MARKER =
  "QQ stream resumed after an idle timeout. The complete answer follows.\n\n";
const TRUNCATION_NOTICE =
  "Response truncated: QQ's passive reply limit was reached.";
let nextStreamTrace = 1;

type EffectiveMarkdownMode = BotConfig["output"]["markdownMode"];

export interface QQMessageApi {
  sendText(input: QQSendTextInput): Promise<string | undefined>;
  sendStream(input: QQSendStreamInput): Promise<QQStreamMessageResponse>;
  uploadMedia(input: QQUploadMediaInput): Promise<string>;
  sendMedia(input: QQSendMediaInput): Promise<string | undefined>;
}

export interface QQReplyStream {
  sendProgress(text: string): Promise<void>;
  getLastDeliveryAt(): number | undefined;
  write(text: string): Promise<void>;
  flush(): Promise<void>;
  sendArtifact(
    artifact: PreparedArtifact,
    caption?: string,
  ): Promise<{ alreadySent: boolean }>;
  finish(): Promise<void>;
}

export interface QQStreamingDiagnosticOptions {
  delayMinutes?: 1 | 3 | 5 | 10;
  isWakeup?: boolean;
  pause?: (milliseconds: number) => Promise<void>;
}

export class QQSender {
  private readonly shutdown = new AbortController();
  private readonly pendingDeliveries = new Map<string, PendingDelivery[]>();

  constructor(
    private readonly api: QQMessageApi,
    private readonly getConfig: () => BotConfig,
    private readonly log: (message: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  createReply(message: QQInboundMessage): QQReplyStream {
    return new BufferedQQReply(
      this.api,
      message,
      this.getConfig().output,
      this.log,
      false,
      true,
      this.now,
      (delivery) => this.deferDelivery(message.conversationId, delivery),
    );
  }

  stop(): void {
    this.shutdown.abort();
  }

  async reply(message: QQInboundMessage, text: string): Promise<void> {
    const reply = this.createReply(message);
    await reply.write(text);
    await reply.finish();
  }

  async deliverPending(message: QQInboundMessage): Promise<number> {
    const pending = this.pendingDeliveries.get(message.conversationId);
    if (!pending?.length || message.chatType === "channel") return 0;
    let delivered = 0;
    let sequence = 1;
    while (pending.length > 0 && sequence <= pendingReplyLimit(message.chatType)) {
      const item = pending[0]!;
      if (item.kind === "text") {
        await this.api.sendText({
          chatType: message.chatType,
          targetId: message.targetId,
          text: item.text,
          replyToId: message.messageId,
          sequence,
          markdown: item.markdown,
        });
      } else {
        const fileInfo = await this.api.uploadMedia({
          chatType: message.chatType,
          targetId: message.targetId,
          data: item.artifact.data,
          fileType: qqMediaFileType(item.artifact.kind),
          fileName: item.artifact.fileName,
        });
        await this.api.sendMedia({
          chatType: message.chatType,
          targetId: message.targetId,
          fileInfo,
          replyToId: message.messageId,
          sequence,
          caption: item.caption,
        });
      }
      pending.shift();
      delivered++;
      sequence++;
    }
    if (pending.length === 0) {
      this.pendingDeliveries.delete(message.conversationId);
    }
    this.log(
      `QQ deferred delivery resumed conversation=${conversationLogId(message.conversationId)} delivered=${delivered} remaining=${pending.length}`,
    );
    return delivered;
  }

  async runStreamingDiagnostic(
    message: QQInboundMessage,
    options: QQStreamingDiagnosticOptions = {},
  ): Promise<void> {
    if (message.chatType !== "direct") {
      throw new Error("QQ streaming diagnostics require a direct chat");
    }
    const reply = new BufferedQQReply(
      this.api,
      message,
      {
        ...this.getConfig().output,
        markdownMode: "native",
        streamResponses: true,
      },
      this.log,
      options.isWakeup === true,
      false,
      this.now,
      () => {},
    );
    const pause = options.pause;
    if (options.delayMinutes !== undefined) {
      await reply.write(
        `# QQ Streaming Diagnostic\n\nInitial frame accepted. Waiting ${options.delayMinutes} minute(s).`,
      );
      await reply.flush();
      if (!(await this.pauseDiagnostic(options.delayMinutes * 60_000, pause))) {
        return;
      }
      await reply.write(
        `\n\nContinuation sent after ${options.delayMinutes} minute(s). is_wakeup=${options.isWakeup === true}.`,
      );
      await reply.finish();
      return;
    }
    const deltas = [
      "# QQ Streaming Diagnostic\n\n1. First generating frame accepted.",
      "\n\n2. Second generating frame accepted after one second.",
      "\n\n3. Third generating frame accepted after another second.",
    ];
    for (const delta of deltas) {
      await reply.write(delta);
      await reply.flush();
      if (!(await this.pauseDiagnostic(STREAM_DIAGNOSTIC_INTERVAL_MS, pause))) {
        return;
      }
    }
    await reply.finish();
  }

  private async pauseDiagnostic(
    milliseconds: number,
    pause?: (milliseconds: number) => Promise<void>,
  ): Promise<boolean> {
    if (this.shutdown.signal.aborted) return false;
    if (pause) {
      await pause(milliseconds);
      return !this.shutdown.signal.aborted;
    }
    try {
      await sleep(milliseconds, this.shutdown.signal);
      return true;
    } catch (error) {
      if (this.shutdown.signal.aborted) return false;
      throw error;
    }
  }

  private deferDelivery(
    conversationId: string,
    delivery: PendingDelivery,
  ): void {
    const pending = this.pendingDeliveries.get(conversationId) ?? [];
    pending.push(delivery);
    this.pendingDeliveries.set(conversationId, pending);
    this.log(
      `QQ delivery deferred conversation=${conversationLogId(conversationId)} kind=${delivery.kind} pending=${pending.length}`,
    );
  }
}

type PendingDelivery =
  | { kind: "text"; text: string; markdown: boolean }
  | { kind: "artifact"; artifact: PreparedArtifact; caption?: string };

class BufferedQQReply implements QQReplyStream {
  private buffer = "";
  private sent = 0;
  private artifactsSent = 0;
  private deferredDeliveries = 0;
  private readonly artifactDigests = new Set<string>();
  private finished = false;
  private operationChain = Promise.resolve();
  private streamMessageId?: string;
  private streamSequence?: number;
  private streamIndex = 0;
  private streamLastText = "";
  private streamTimer?: ReturnType<typeof setTimeout>;
  private streamError?: unknown;
  private streamLastAttemptAt?: number;
  private streamStartedAt?: number;
  private streamRecovered = false;
  private readonly streamTrace = nextStreamTrace++;
  private readonly createdAt: number;
  private lastDeliveryAt?: number;

  constructor(
    private readonly api: QQMessageApi,
    private readonly message: QQInboundMessage,
    private readonly output: BotConfig["output"],
    private readonly log: (message: string) => void,
    private readonly forceWakeup = false,
    private readonly allowRecovery = true,
    private readonly now: () => number = Date.now,
    private readonly deferDelivery: (delivery: PendingDelivery) => void,
  ) {
    this.createdAt = now();
  }

  write(text: string): Promise<void> {
    return this.enqueue(() => this.writeNow(text));
  }

  sendProgress(text: string): Promise<void> {
    return this.enqueue(() => this.sendProgressNow(text));
  }

  getLastDeliveryAt(): number | undefined {
    return this.lastDeliveryAt;
  }

  flush(): Promise<void> {
    return this.enqueue(() => this.flushNow());
  }

  sendArtifact(
    artifact: PreparedArtifact,
    caption?: string,
  ): Promise<{ alreadySent: boolean }> {
    return this.enqueue(() => this.sendArtifactNow(artifact, caption));
  }

  finish(): Promise<void> {
    return this.enqueue(() => this.finishNow());
  }

  private async writeNow(text: string): Promise<void> {
    if (this.finished) throw new Error("Cannot write to a finished QQ reply");
    if (this.streamError !== undefined) throw this.streamError;
    if (!text) return;
    this.buffer += text;
    if (!this.output.streamResponses) return;
    if (this.usesOfficialStream()) {
      this.scheduleStreamUpdate();
      return;
    }
    await this.flushProgressive();
  }

  private async sendProgressNow(text: string): Promise<void> {
    if (this.finished) throw new Error("Cannot write to a finished QQ reply");
    const rendered = this.render(text);
    if (!rendered) return;
    const passive = this.passiveReplyAvailable();
    if (!passive) {
      this.log("QQ progress update skipped because the passive reply window expired");
      return;
    }
    await this.api.sendText({
      chatType: this.message.chatType,
      targetId: this.message.targetId,
      text: rendered,
      replyToId: this.message.messageId,
      sequence: this.allocateSequence(),
      markdown: this.effectiveMarkdownMode() === "native",
    });
    this.markDelivered();
  }

  private async flushNow(): Promise<void> {
    if (this.finished) throw new Error("Cannot flush a finished QQ reply");
    if (this.streamError !== undefined) throw this.streamError;
    if (this.usesOfficialStream()) {
      this.clearStreamTimer();
      await this.flushStreamUpdate();
      return;
    }
    if (this.output.streamResponses) await this.flushProgressive();
  }

  private async sendArtifactNow(
    artifact: PreparedArtifact,
    caption?: string,
  ): Promise<{ alreadySent: boolean }> {
    if (this.finished) throw new Error("Cannot send from a finished QQ reply");
    if (this.artifactDigests.has(artifact.digest)) {
      return { alreadySent: true };
    }
    if (this.message.chatType === "channel") {
      throw new Error("QQ artifact delivery is not supported in channel chats");
    }
    if (this.artifactsSent >= MAX_ARTIFACTS_PER_TURN) {
      throw new Error(
        `At most ${MAX_ARTIFACTS_PER_TURN} artifacts can be sent in one QQ turn`,
      );
    }
    if (this.usesOfficialStream()) {
      await this.flushStreamUpdate();
    }
    if (this.availableReplySlots() <= FINAL_REPLY_RESERVE) {
      throw new Error("No QQ reply slot remains for another artifact");
    }
    if (!this.passiveReplyAvailable()) {
      this.defer({
        kind: "artifact",
        artifact,
        caption: caption ? renderMarkdownForQQ(caption) : undefined,
      });
      this.artifactsSent++;
      this.artifactDigests.add(artifact.digest);
      return { alreadySent: false };
    }

    const fileInfo = await this.api.uploadMedia({
      chatType: this.message.chatType,
      targetId: this.message.targetId,
      data: artifact.data,
      fileType: qqMediaFileType(artifact.kind),
      fileName: artifact.fileName,
    });
    await this.api.sendMedia({
      chatType: this.message.chatType,
      targetId: this.message.targetId,
      fileInfo,
      replyToId: this.message.messageId,
      sequence: this.allocateSequence(),
      caption: caption ? renderMarkdownForQQ(caption) : undefined,
    });
    this.markDelivered();
    this.artifactsSent++;
    this.artifactDigests.add(artifact.digest);
    return { alreadySent: false };
  }

  private async finishNow(): Promise<void> {
    if (this.finished) return;
    this.clearStreamTimer();
    if (this.streamError !== undefined) throw this.streamError;

    if (this.usesOfficialStream()) {
      await this.finishOfficialStream();
      this.finished = true;
      return;
    }

    const rendered = this.render(this.buffer);
    this.buffer = "";
    const chunks = capReplyChunks(
      this.split(rendered),
      this.availableReplySlots(),
      this.output.textChunkLimit,
      (text, limit) => this.split(text, limit),
    );
    await this.sendChunks(chunks);
    this.finished = true;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(operation);
    this.operationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async flushProgressive(): Promise<void> {
    if (!this.passiveReplyAvailable()) return;
    const maxLength = Math.max(
      this.output.streamMinChars,
      this.output.textChunkLimit - STREAM_LENGTH_MARGIN,
    );

    while (this.sent < PROGRESSIVE_REPLY_LIMIT) {
      const splitAt = findStreamingSplit(
        this.buffer,
        this.output.streamMinChars,
        maxLength,
        this.output.textChunkLimit,
      );
      if (splitAt === undefined) return;

      const raw = this.buffer.slice(0, splitAt).trim();
      const chunks = this.split(this.render(raw));
      if (chunks.length > PROGRESSIVE_REPLY_LIMIT - this.sent) return;

      this.buffer = trimBlockStart(this.buffer.slice(splitAt));
      await this.sendChunks(chunks);
    }
  }

  private usesOfficialStream(): boolean {
    return this.message.chatType === "direct" && this.output.streamResponses;
  }

  private scheduleStreamUpdate(): void {
    if (this.streamTimer) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = undefined;
      void this.enqueue(() => this.flushStreamUpdate()).catch((error) => {
        this.streamError = error;
      });
    }, STREAM_UPDATE_INTERVAL_MS);
    this.streamTimer.unref();
  }

  private clearStreamTimer(): void {
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
  }

  private async flushStreamUpdate(): Promise<void> {
    if (this.streamError !== undefined) throw this.streamError;
    const desired = this.renderStreamText();
    if (!desired || desired === this.streamLastText) return;

    this.assertStreamPrefix(desired);
    await this.sendStreamFrame(desired, 1);
  }

  private async finishOfficialStream(): Promise<void> {
    let desired = this.renderStreamText(true);
    if (this.streamMessageId === undefined) {
      desired ||= STREAM_EMPTY_PLACEHOLDER;
      await this.sendStreamFrame(desired, 1);
    }
    this.assertStreamPrefix(desired);
    await this.sendStreamFrame(`${desired}${STREAM_COMPLETION_MARKER}`, 10);
  }

  private renderStreamText(final = false): string {
    if (!final && this.effectiveMarkdownMode() === "plain") return "";
    const source = final ? this.buffer : streamSafeSource(this.buffer);
    const rendered = this.render(source);
    return this.streamRecovered
      ? `${STREAM_RECOVERY_MARKER}${rendered}`
      : rendered;
  }

  private assertStreamPrefix(desired: string): void {
    if (!desired.startsWith(this.streamLastText)) {
      throw new Error(
        "QQ stream update would modify content already sent by the platform",
      );
    }
  }

  private async sendStreamFrame(text: string, state: 1 | 10): Promise<void> {
    if (this.streamSequence === undefined) {
      this.streamSequence = this.allocateSequence();
    }
    const frameIndex = this.streamIndex;
    const attemptAt = Date.now();
    this.streamStartedAt ??= attemptAt;
    const idleMs =
      this.streamLastAttemptAt === undefined
        ? "first"
        : String(attemptAt - this.streamLastAttemptAt);
    const streamAgeMs = attemptAt - this.streamStartedAt;
    this.streamLastAttemptAt = attemptAt;
    const characters = countCharacters(text);
    const deltaCharacters = text.startsWith(this.streamLastText)
      ? countCharacters(text.slice(this.streamLastText.length))
      : characters;
    const bytes = Buffer.byteLength(text, "utf8");
    const contentType =
      this.effectiveMarkdownMode() === "native" ? "markdown" : "text";
    this.log(
      `QQ stream frame sending trace=${this.streamTrace} index=${frameIndex} state=${state} chars=${characters} deltaChars=${deltaCharacters} bytes=${bytes} idleMs=${idleMs} streamAgeMs=${streamAgeMs} contentType=${contentType} streamStarted=${this.streamMessageId !== undefined} recovered=${this.streamRecovered} wakeup=${this.shouldWakeup()}`,
    );
    let response: QQStreamMessageResponse;
    try {
      response = await this.api.sendStream({
        targetId: this.message.targetId,
        text,
        replyToId: this.message.messageId,
        sequence: this.streamSequence,
        index: frameIndex,
        state,
        contentType,
        streamMessageId: this.streamMessageId,
        isWakeup: this.shouldWakeup(),
      });
    } catch (error) {
      this.log(
        `QQ stream frame failed trace=${this.streamTrace} index=${frameIndex} state=${state} chars=${characters} deltaChars=${deltaCharacters} bytes=${bytes} idleMs=${idleMs} streamAgeMs=${streamAgeMs} contentType=${contentType} streamStarted=${this.streamMessageId !== undefined} recovered=${this.streamRecovered} wakeup=${this.shouldWakeup()} error=${streamErrorCategory(error)}${streamErrorDetails(error)}`,
      );
      if (this.canRecoverExpiredStream(error)) {
        await this.recoverExpiredStream(text, state);
        return;
      }
      throw error;
    }
    if (
      this.streamMessageId !== undefined &&
      response.id !== this.streamMessageId
    ) {
      throw new Error("QQ stream response changed the stream message ID");
    }
    this.streamMessageId ??= response.id;
    this.streamIndex++;
    this.streamLastText = text;
    this.log(
      `QQ stream frame accepted trace=${this.streamTrace} index=${frameIndex} state=${state} chars=${countCharacters(text)} pending=${response.pendingCharacters ?? "unknown"}`,
    );
    this.markDelivered();
  }

  private canRecoverExpiredStream(error: unknown): boolean {
    return (
      this.allowRecovery &&
      !this.streamRecovered &&
      this.streamMessageId !== undefined &&
      error instanceof QQApiError &&
      String(error.code) === "40034020"
    );
  }

  private async recoverExpiredStream(
    text: string,
    state: 1 | 10,
  ): Promise<void> {
    this.log(
      `QQ stream recovery starting trace=${this.streamTrace} previousIndex=${this.streamIndex} strategy=new-wakeup-stream`,
    );
    this.streamRecovered = true;
    this.streamMessageId = undefined;
    this.streamIndex = 0;
    this.streamSequence = this.allocateSequence();
    this.streamLastText = "";
    const recoveredText = `${STREAM_RECOVERY_MARKER}${text}`;
    await this.sendStreamFrame(recoveredText, 1);
    if (state === 10) {
      await this.sendStreamFrame(recoveredText, 10);
    }
  }

  private render(text: string): string {
    switch (this.effectiveMarkdownMode()) {
      case "plain":
        return renderMarkdownForQQ(text);
      case "native":
        return renderNativeMarkdownForQQ(text);
      case "raw":
        return text.trim();
    }
  }

  private split(
    text: string,
    limit = this.output.textChunkLimit,
  ): string[] {
    return this.effectiveMarkdownMode() === "plain"
      ? splitText(text, limit)
      : splitMarkdown(text, limit);
  }

  private effectiveMarkdownMode(): EffectiveMarkdownMode {
    return (
      this.output.markdownMode === "native" &&
      this.message.chatType === "channel"
    )
      ? "plain"
      : this.output.markdownMode;
  }

  private async sendChunks(chunks: string[]): Promise<void> {
    for (const text of chunks) {
      if (!this.passiveReplyAvailable()) {
        this.defer({
          kind: "text",
          text,
          markdown: this.effectiveMarkdownMode() === "native",
        });
        continue;
      }
      await this.api.sendText({
        chatType: this.message.chatType,
        targetId: this.message.targetId,
        text,
        replyToId: this.message.messageId,
        sequence: this.allocateSequence(),
        markdown: this.effectiveMarkdownMode() === "native",
      });
      this.markDelivered();
    }
  }

  private allocateSequence(): number {
    if (this.sent >= this.maxPassiveReplies()) {
      throw new Error("QQ passive reply limit was reached");
    }
    this.sent++;
    return this.sent;
  }

  private maxPassiveReplies(): number {
    switch (this.message.chatType) {
      case "direct":
        return DIRECT_MAX_PASSIVE_REPLIES;
      case "group":
        return GROUP_MAX_PASSIVE_REPLIES;
      case "channel":
        return CHANNEL_MAX_PASSIVE_REPLIES;
    }
  }

  private passiveReplyAvailable(): boolean {
    return this.now() - this.createdAt < PASSIVE_REPLY_SAFE_MS;
  }

  private availableReplySlots(): number {
    return this.passiveReplyAvailable()
      ? this.maxPassiveReplies() - this.sent
      : this.maxPassiveReplies() - this.deferredDeliveries;
  }

  private shouldWakeup(): boolean {
    return (
      this.forceWakeup ||
      this.streamRecovered ||
      this.now() - this.createdAt >= PASSIVE_REPLY_SAFE_MS
    );
  }

  private markDelivered(): void {
    this.lastDeliveryAt = this.now();
  }

  private defer(delivery: PendingDelivery): void {
    this.deferDelivery(delivery);
    this.deferredDeliveries++;
  }
}

function qqMediaFileType(kind: ArtifactKind): QQMediaFileType {
  switch (kind) {
    case "image":
      return 1;
    case "video":
      return 2;
    case "voice":
      return 3;
    case "file":
      return 4;
  }
}

function pendingReplyLimit(chatType: QQInboundMessage["chatType"]): number {
  switch (chatType) {
    case "direct":
      return DIRECT_MAX_PASSIVE_REPLIES;
    case "group":
      return GROUP_MAX_PASSIVE_REPLIES;
    case "channel":
      return CHANNEL_MAX_PASSIVE_REPLIES;
  }
}

function conversationLogId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function capReplyChunks(
  chunks: string[],
  maximum: number,
  limit: number,
  split: (text: string, limit: number) => string[],
): string[] {
  if (chunks.length <= maximum) return chunks;
  if (maximum <= 0) return [];

  const capped = chunks.slice(0, maximum);
  const last = capped[maximum - 1]!;
  const contentLimit = Math.max(0, limit - TRUNCATION_NOTICE.length - 2);
  const safePrefix = split(last, contentLimit)[0] ?? "";
  capped[maximum - 1] =
    safePrefix
      ? `${safePrefix.trimEnd()}\n\n${TRUNCATION_NOTICE}`
      : TRUNCATION_NOTICE;
  return capped;
}

function streamSafeSource(source: string): string {
  let fence: { marker: string; length: number } | undefined;
  let fenceStart = -1;
  let inlineCode: { length: number; start: number } | undefined;
  let explicitMath: "\\]" | "\\)" | "$$" | undefined;
  let explicitMathStart = -1;
  let inlineDollarStart = -1;
  let trailingEscapeStart = -1;

  let trailingBackslashes = 0;
  for (
    let index = source.length - 1;
    index >= 0 && source[index] === "\\";
    index--
  ) {
    trailingBackslashes++;
  }
  if (trailingBackslashes % 2 === 1) {
    trailingEscapeStart = source.length - 1;
  }

  for (let index = 0; index < source.length; index++) {
    if (!inlineCode && (source[index] === "\n" || index === 0)) {
      const lineStart = index === 0 ? 0 : index + 1;
      const lineEnd = source.indexOf("\n", lineStart);
      const line = source.slice(
        lineStart,
        lineEnd === -1 ? source.length : lineEnd,
      );
      const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      const marker = fenceMatch?.[1];
      if (marker) {
        if (!fence) {
          fence = { marker: marker[0]!, length: marker.length };
          fenceStart = lineStart;
        } else if (
          marker[0] === fence.marker &&
          marker.length >= fence.length &&
          !fenceMatch?.[2]?.trim()
        ) {
          fence = undefined;
          fenceStart = -1;
        }
      }
    }
    if (fence) continue;

    if (!explicitMath && source[index] === "`" && source[index - 1] !== "\\") {
      let length = 1;
      while (source[index + length] === "`") length++;
      if (!inlineCode) {
        inlineCode = { length, start: index };
      } else if (length === inlineCode.length) {
        inlineCode = undefined;
      }
      index += length - 1;
      continue;
    }
    if (inlineCode) continue;

    if (explicitMath) {
      if (
        (explicitMath === "$$" && source.startsWith("$$", index)) ||
        (explicitMath !== "$$" && source.startsWith(explicitMath, index))
      ) {
        index += explicitMath.length - 1;
        explicitMath = undefined;
        explicitMathStart = -1;
      }
      continue;
    }
    if (source.startsWith("\\[", index)) {
      explicitMath = "\\]";
      explicitMathStart = index;
      index++;
    } else if (source.startsWith("\\(", index)) {
      explicitMath = "\\)";
      explicitMathStart = index;
      index++;
    } else if (source.startsWith("$$", index)) {
      explicitMath = "$$";
      explicitMathStart = index;
      index++;
    } else if (
      source[index] === "$" &&
      source[index - 1] !== "\\" &&
      source[index - 1] !== "$" &&
      source[index + 1] !== "$"
    ) {
      if (inlineDollarStart === -1 && !/\s/.test(source[index + 1] ?? "")) {
        inlineDollarStart = index;
      } else if (
        inlineDollarStart !== -1 &&
        source[index + 1] !== undefined &&
        !/[$\d]/.test(source[index + 1]!)
      ) {
        inlineDollarStart = -1;
      }
    }
  }

  const protectedStart = [
    fenceStart,
    explicitMathStart,
    inlineDollarStart,
    inlineCode?.start ?? -1,
    trailingEscapeStart,
  ]
    .filter((position) => position >= 0)
    .sort((left, right) => left - right)[0];
  return protectedStart === undefined
    ? source
    : source.slice(0, protectedStart);
}

function countCharacters(text: string): number {
  return Array.from(text).length;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function streamErrorCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const status = message.match(/^QQ stream send failed \((\d+)/)?.[1];
  if (status) return `http-${status}`;
  if (message.startsWith("QQ stream response did not include")) {
    return "invalid-response-id";
  }
  if (message.startsWith("QQ stream response included an invalid")) {
    return "invalid-response-length";
  }
  return "request-error";
}

function streamErrorDetails(error: unknown): string {
  if (!(error instanceof QQApiError)) return "";
  return [
    error.code === undefined ? undefined : `qqCode=${error.code}`,
    error.traceId ? `qqTrace=${error.traceId}` : undefined,
  ]
    .filter(Boolean)
    .map((entry) => ` ${entry}`)
    .join("");
}
