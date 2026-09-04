import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { BotConfig } from "../config/schema.js";
import { atomicWriteJson } from "../config/store.js";
import {
  QQApiError,
  type QQForumThreadSummary,
  type QQPublishForumThreadInput,
  type QQPublishForumThreadResponse,
} from "./api.js";
import type {
  QQBotIdentity,
  QQForumPublishAuditEvent,
  QQForumThreadCreateEvent,
} from "./gateway.js";
import type {
  QQForumInboundMessage,
  QQInboundMessage,
} from "./types.js";

export interface QQForumApi {
  readonly appId: string;
  publishForumThread(
    input: QQPublishForumThreadInput,
  ): Promise<QQPublishForumThreadResponse>;
  listForumThreads(channelId: string): Promise<QQForumThreadSummary[]>;
}

const MAX_PROCESSED_THREAD_IDS = 1_000;
const DEFAULT_AUDIT_TIMEOUT_MS = 120_000;
const DEFAULT_RECONCILIATION_POLL_MS = 1_000;

export type QQForumThread = QQForumThreadCreateEvent;

type QQForumPublicationPhase =
  | "submitting"
  | "waitingAudit"
  | "auditSucceeded"
  | "auditFailed";

interface QQForumPublicationError {
  kind?: "audit" | "submissionRejected";
  result?: number;
  status?: number;
  code?: string | number;
  detailHash?: string;
}

interface QQForumPublication {
  sourceThreadId: string;
  guildId: string;
  channelId: string;
  marker: string;
  phase: QQForumPublicationPhase;
  taskId?: string;
  submittedAtMs?: number;
  attempt: number;
  ambiguousAttempt?: boolean;
  title: string;
  content: string;
  error?: QQForumPublicationError;
}

interface QQForumAuditQuarantine {
  sourceThreadId: string;
  guildId: string;
  channelId: string;
  untilMs: number;
}

interface QQForumQueueState {
  version: 1;
  pending: QQForumThreadCreateEvent[];
  completed?: string[];
  publications?: QQForumPublication[];
  auditQuarantines?: QQForumAuditQuarantine[];
}

export interface PreparedForumThread {
  threadId: string;
  sourceTitle: string;
  prompt: string;
}

interface RichSegment {
  text: string;
  mentionIds: string[];
}

type PersistForumQueueState = (
  file: string,
  state: QQForumQueueState,
) => Promise<void>;

export interface QQForumPublisher {
  publishForumResult(
    message: QQForumInboundMessage,
    content: string,
  ): Promise<QQPublishForumThreadResponse>;
}

export interface QQForumCoordinatorTiming {
  now?: () => number;
  pause?: (milliseconds: number) => Promise<void>;
  auditTimeoutMs?: number;
  reconciliationPollMs?: number;
}

interface PublicationWaiter {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class QQForumCoordinator {
  private identity?: QQBotIdentity;
  private readonly completedThreadIds = new Set<string>();
  private readonly activeThreadIds = new Set<string>();
  private readonly retryRequestedThreadIds = new Set<string>();
  private readonly pendingThreads = new Map<string, QQForumThreadCreateEvent>();
  private readonly publications = new Map<string, QQForumPublication>();
  private readonly publicationWaiters = new Map<string, PublicationWaiter>();
  private readonly activePublicationByChannel = new Map<string, string>();
  private readonly auditQuarantinesByChannel =
    new Map<string, QQForumAuditQuarantine>();
  private readonly channelOperations = new Map<string, Promise<void>>();
  private stateOperations = Promise.resolve();
  private started = false;
  private stopped = false;
  private accessPolicyApplied = false;

  constructor(
    private readonly api: QQForumApi,
    private readonly getConfig: () => BotConfig,
    private readonly onMessage: (message: QQInboundMessage) => Promise<void>,
    private readonly log: (message: string) => void,
    private readonly queueFile: string,
    private readonly persistState: PersistForumQueueState = atomicWriteJson,
    private readonly timing: QQForumCoordinatorTiming = {},
  ) {}

  async start(): Promise<void> {
    await this.withStateLock(async () => {
      const state = await loadForumQueueState(this.queueFile);
      this.pendingThreads.clear();
      this.completedThreadIds.clear();
      this.publications.clear();
      this.auditQuarantinesByChannel.clear();
      for (const threadId of state.completed ?? []) {
        this.rememberCompleted(threadId);
      }
      let stateChanged = false;
      for (const event of state.pending) {
        const threadId = event.threadInfo.threadId;
        if (!this.completedThreadIds.has(threadId)) {
          this.pendingThreads.set(threadId, event);
        } else {
          stateChanged = true;
        }
      }
      for (const publication of state.publications ?? []) {
        const source = this.pendingThreads.get(publication.sourceThreadId);
        if (
          source &&
          source.guildId === publication.guildId &&
          source.channelId === publication.channelId
        ) {
          this.publications.set(publication.sourceThreadId, publication);
        } else {
          stateChanged = true;
        }
      }
      for (const quarantine of state.auditQuarantines ?? []) {
        if (quarantine.untilMs > this.currentTime()) {
          this.auditQuarantinesByChannel.set(
            quarantine.channelId,
            quarantine,
          );
        } else {
          stateChanged = true;
        }
      }
      if (stateChanged) await this.persistQueue();
    });
    this.stopped = false;
    this.started = true;
    this.accessPolicyApplied = false;
  }

  async applyCurrentAccessPolicy(): Promise<void> {
    await this.withStateLock(async () => {
      const allowedGuilds = new Set(
        this.getConfig().qq.forum.guildAllowFrom,
      );
      const pendingSnapshot = new Map(this.pendingThreads);
      const publicationsSnapshot = new Map(this.publications);
      const quarantinesSnapshot = new Map(
        this.auditQuarantinesByChannel,
      );
      let stateChanged = false;
      for (const [threadId, event] of this.pendingThreads) {
        if (allowedGuilds.has(event.guildId)) continue;
        this.pendingThreads.delete(threadId);
        this.publications.delete(threadId);
        stateChanged = true;
      }
      for (const [channelId, quarantine] of this.auditQuarantinesByChannel) {
        if (allowedGuilds.has(quarantine.guildId)) continue;
        this.auditQuarantinesByChannel.delete(channelId);
        stateChanged = true;
      }
      if (!stateChanged) return;
      try {
        await this.persistQueue();
      } catch (error) {
        this.pendingThreads.clear();
        for (const entry of pendingSnapshot) this.pendingThreads.set(...entry);
        this.publications.clear();
        for (const entry of publicationsSnapshot) {
          this.publications.set(...entry);
        }
        this.auditQuarantinesByChannel.clear();
        for (const entry of quarantinesSnapshot) {
          this.auditQuarantinesByChannel.set(...entry);
        }
        throw error;
      }
    });
    this.accessPolicyApplied = true;
    this.drainPending();
  }

  stop(): void {
    this.stopped = true;
    for (const waiter of this.publicationWaiters.values()) {
      waiter.reject(new Error("QQ forum coordinator stopped"));
    }
    this.publicationWaiters.clear();
  }

  setBotIdentity(identity: QQBotIdentity): void {
    this.identity = identity;
    this.drainPending();
  }

  async handlePublishAudit(event: QQForumPublishAuditEvent): Promise<void> {
    if (event.type !== 1) {
      this.log(
        `QQ forum audit ignored scope=${forumScopeLogId(event.guildId, event.channelId)} type=${event.type}`,
      );
      return;
    }
    if (!this.identity || event.authorId !== this.identity.id) {
      this.log(
        `QQ forum audit ignored scope=${forumScopeLogId(event.guildId, event.channelId)} author=${forumValueLogId(event.authorId ?? "missing")}: author is not the bot`,
      );
      return;
    }
    if (await this.ignoreQuarantinedAudit(event)) return;
    const sourceThreadId = this.activePublicationByChannel.get(event.channelId);
    if (!sourceThreadId) {
      this.log(
        `QQ forum audit ignored scope=${forumScopeLogId(event.guildId, event.channelId)} author=${forumValueLogId(event.authorId ?? "missing")}: no active publication`,
      );
      return;
    }

    const active = this.publications.get(sourceThreadId);
    if (
      !active ||
      active.guildId !== event.guildId ||
      active.channelId !== event.channelId
    ) {
      this.log(
        `QQ forum audit ignored scope=${forumScopeLogId(event.guildId, event.channelId)}: active publication did not match`,
      );
      return;
    }
    if (event.result === 0) {
      if (!event.threadId) {
        this.log(
          `QQ forum audit ignored scope=${forumScopeLogId(event.guildId, event.channelId)} source=${forumValueLogId(sourceThreadId)}: successful audit has no thread`,
        );
        return;
      }
      const waiter = this.publicationWaiters.get(sourceThreadId);
      let threads: QQForumThreadSummary[] | undefined;
      try {
        threads = await this.listForumThreadsUntilSignal(active, waiter);
      } catch (error) {
        this.log(
          `QQ forum audit verification failed scope=${forumScopeLogId(event.guildId, event.channelId)} source=${forumValueLogId(sourceThreadId)} error=${forumErrorName(error)}`,
        );
        throw error;
      }
      if (!threads) return;
      if (
        !threads.some((thread) =>
          thread.threadId === event.threadId &&
          forumThreadHasMarker(thread, active.marker)
        )
      ) {
        this.log(
          `QQ forum audit ignored scope=${forumScopeLogId(event.guildId, event.channelId)} source=${forumValueLogId(sourceThreadId)} thread=${forumValueLogId(event.threadId)}: thread marker did not match`,
        );
        return;
      }
    }

    let matched = false;
    await this.withStateLock(async () => {
      const publication = this.publications.get(sourceThreadId);
      if (
        !publication ||
        publication.guildId !== event.guildId ||
        publication.channelId !== event.channelId ||
        this.activePublicationByChannel.get(event.channelId) !== sourceThreadId
      ) {
        this.log(
          `QQ forum audit ignored scope=${forumScopeLogId(event.guildId, event.channelId)}: active publication did not match`,
        );
        return;
      }
      if (
        publication.phase === "auditSucceeded" ||
        publication.phase === "auditFailed"
      ) {
        this.log(
          `QQ forum audit ignored scope=${forumScopeLogId(event.guildId, event.channelId)} source=${forumValueLogId(sourceThreadId)}: publication is already terminal`,
        );
        return;
      }
      const previous = structuredClone(publication);
      const previousQuarantine = this.auditQuarantinesByChannel.get(
        publication.channelId,
      );
      this.markPublicationTerminal(
        publication,
        event.result === 0 ? "auditSucceeded" : "auditFailed",
        event.result === 0
          ? undefined
          : {
              kind: "audit",
              result: event.result,
              detailHash: event.errorMessage
                ? forumValueLogId(event.errorMessage)
                : undefined,
            },
      );
      try {
        await this.persistQueue();
      } catch (error) {
        this.publications.set(sourceThreadId, previous);
        if (previousQuarantine) {
          this.auditQuarantinesByChannel.set(
            publication.channelId,
            previousQuarantine,
          );
        } else {
          this.auditQuarantinesByChannel.delete(publication.channelId);
        }
        throw error;
      }
      matched = true;
    });
    if (!matched) return;

    const waiter = this.publicationWaiters.get(sourceThreadId);
    if (event.result === 0) {
      waiter?.resolve();
      this.log(
        `QQ forum publication audit succeeded scope=${forumScopeLogId(event.guildId, event.channelId)} source=${forumValueLogId(sourceThreadId)}`,
      );
    } else {
      waiter?.reject(new QQForumAuditError(event.result));
      this.log(
        `QQ forum publication audit failed scope=${forumScopeLogId(event.guildId, event.channelId)} source=${forumValueLogId(sourceThreadId)} result=${event.result}${event.errorMessage ? ` detail=${forumValueLogId(event.errorMessage)}` : ""}`,
      );
    }
  }

  private async ignoreQuarantinedAudit(
    event: QQForumPublishAuditEvent,
  ): Promise<boolean> {
    let ignoredSourceThreadId: string | undefined;
    await this.withStateLock(async () => {
      const quarantine = this.auditQuarantinesByChannel.get(event.channelId);
      if (!quarantine || quarantine.guildId !== event.guildId) return;
      if (quarantine.untilMs > this.currentTime()) {
        ignoredSourceThreadId = quarantine.sourceThreadId;
        return;
      }
      this.auditQuarantinesByChannel.delete(event.channelId);
      try {
        await this.persistQueue();
      } catch (error) {
        this.auditQuarantinesByChannel.set(event.channelId, quarantine);
        throw error;
      }
    });
    if (!ignoredSourceThreadId) return false;
    this.log(
      `QQ forum audit ignored scope=${forumScopeLogId(event.guildId, event.channelId)} source=${forumValueLogId(ignoredSourceThreadId)}: publication is quarantined and terminal`,
    );
    return true;
  }

  async publishForumResult(
    message: QQForumInboundMessage,
    content: string,
  ): Promise<QQPublishForumThreadResponse> {
    if (
      !this.getConfig().qq.forum.guildAllowFrom.includes(
        message.forum.guildId,
      )
    ) {
      await this.removeDisallowedThread(
        message.forum.threadId,
        message.forum.guildId,
        message.forum.channelId,
      );
      throw new Error("QQ forum guild is not allowed");
    }
    const sourceThreadId = message.forum.threadId;
    const marker = forumSourceMarker(
      this.api.appId,
      message.forum.guildId,
      message.forum.channelId,
      sourceThreadId,
    );
    const output = {
      title: forumResultTitle(
        message.forum.botUsername,
        message.forum.sourceTitle,
        marker,
      ),
      content: content.trim() || "No response was produced.",
    };
    await this.preparePublication(message, marker, output);
    return this.withChannelLock(
      message.forum.channelId,
      () => this.submitPublication(sourceThreadId),
    );
  }

  private async preparePublication(
    message: QQForumInboundMessage,
    marker: string,
    output: { title: string; content: string },
  ): Promise<void> {
    await this.withStateLock(async () => {
      const existing = this.publications.get(message.forum.threadId);
      if (existing?.phase === "auditSucceeded") return;
      if (existing) {
        const previous = structuredClone(existing);
        existing.title = output.title;
        existing.content = output.content;
        try {
          await this.persistQueue();
        } catch (error) {
          this.publications.set(message.forum.threadId, previous);
          throw error;
        }
        return;
      }
      const publication: QQForumPublication = {
        sourceThreadId: message.forum.threadId,
        guildId: message.forum.guildId,
        channelId: message.forum.channelId,
        marker,
        phase: "submitting",
        attempt: 0,
        title: output.title,
        content: output.content,
      };
      this.publications.set(publication.sourceThreadId, publication);
      try {
        await this.persistQueue();
      } catch (error) {
        this.publications.delete(publication.sourceThreadId);
        throw error;
      }
    });
  }

  private async submitPublication(
    sourceThreadId: string,
  ): Promise<QQPublishForumThreadResponse> {
    const waiter = publicationWaiter();
    this.publicationWaiters.set(sourceThreadId, waiter);
    const publication = this.publications.get(sourceThreadId);
    if (!publication) throw new Error("QQ forum publication state is missing");
    this.activePublicationByChannel.set(
      publication.channelId,
      sourceThreadId,
    );
    try {
      let retryFailedPublication = publication.phase === "auditFailed";
      while (true) {
        if (this.stopped) throw new Error("QQ forum coordinator stopped");
        const latest = this.publications.get(sourceThreadId);
        if (!latest) throw new Error("QQ forum publication state is missing");
        const config = this.getConfig().qq.forum;
        if (!config.guildAllowFrom.includes(latest.guildId)) {
          await this.removeDisallowedThread(
            sourceThreadId,
            latest.guildId,
            latest.channelId,
          );
          throw new Error("QQ forum guild is not allowed");
        }
        if (!config.enabled) {
          throw new Error("QQ forum publication is disabled");
        }
        if (latest.phase === "auditSucceeded") {
          return confirmedPublicationResponse(latest);
        }
        if (latest.phase === "auditFailed") {
          if (!retryFailedPublication) {
            throw new QQForumAuditError(latest.error?.result);
          }
          retryFailedPublication = false;
          await this.submitPublicationAttempt(sourceThreadId);
          continue;
        }
        if (latest.attempt === 0) {
          await this.submitPublicationAttempt(sourceThreadId);
          continue;
        }

        await this.waitForRemainingAuditWindow(latest, waiter);
        const afterWait = this.publications.get(sourceThreadId);
        if (!afterWait) {
          throw new Error("QQ forum publication state is missing");
        }
        if (afterWait.phase === "auditSucceeded") {
          return confirmedPublicationResponse(afterWait);
        }
        if (afterWait.phase === "auditFailed") {
          throw new QQForumAuditError(afterWait.error?.result);
        }
        if (this.stopped) throw new Error("QQ forum coordinator stopped");

        const reconciliation = await this.reconcilePublicationAttempt(
          afterWait,
          waiter,
        );
        if (reconciliation === "found") {
          return confirmedPublicationResponse(
            this.publications.get(sourceThreadId)!,
          );
        }
        if (reconciliation === "signaled") continue;

        await this.waitForRetryBackoff(waiter);
        const afterBackoff = this.publications.get(sourceThreadId);
        if (!afterBackoff) {
          throw new Error("QQ forum publication state is missing");
        }
        if (
          afterBackoff.phase === "auditSucceeded" ||
          afterBackoff.phase === "auditFailed"
        ) {
          continue;
        }
        if (reconciliation === "absent") {
          await this.submitPublicationAttempt(sourceThreadId);
        }
      }
    } finally {
      if (
        this.activePublicationByChannel.get(publication.channelId) ===
        sourceThreadId
      ) {
        this.activePublicationByChannel.delete(publication.channelId);
      }
      if (this.publicationWaiters.get(sourceThreadId) === waiter) {
        this.publicationWaiters.delete(sourceThreadId);
      }
    }
  }

  private async submitPublicationAttempt(
    sourceThreadId: string,
  ): Promise<void> {
    if (this.stopped) throw new Error("QQ forum coordinator stopped");
    await this.updatePublication(sourceThreadId, (publication) => {
      publication.phase = "submitting";
      publication.taskId = undefined;
      publication.submittedAtMs = this.currentTime();
      publication.attempt++;
      publication.error = undefined;
    });
    const publication = this.publications.get(sourceThreadId)!;
    try {
      const response = await this.api.publishForumThread({
        channelId: publication.channelId,
        title: publication.title,
        content: publication.content,
        format: 3,
      });
      await this.updatePublication(sourceThreadId, (latest) => {
        latest.taskId = response.taskId;
        if (
          latest.phase !== "auditSucceeded" &&
          latest.phase !== "auditFailed"
        ) {
          latest.phase = "waitingAudit";
        }
      });
    } catch (error) {
      if (isDefinitiveForumSubmissionRejection(error)) {
        const code = privacySafeQQErrorCode(error.code);
        await this.updatePublication(sourceThreadId, (latest) => {
          if (
            latest.phase === "auditSucceeded" ||
            latest.phase === "auditFailed"
          ) {
            return;
          }
          this.markPublicationTerminal(latest, "auditFailed", {
            kind: "submissionRejected",
            status: error.status,
            ...(code === undefined ? {} : { code }),
          });
        });
        this.log(
          `QQ forum publication rejected scope=${forumScopeLogId(publication.guildId, publication.channelId)} source=${forumValueLogId(sourceThreadId)} attempt=${publication.attempt} status=${error.status}${code === undefined ? "" : ` code=${code}`}`,
        );
        return;
      }
      await this.updatePublication(sourceThreadId, (latest) => {
        if (
          latest.phase !== "auditSucceeded" &&
          latest.phase !== "auditFailed"
        ) {
          latest.ambiguousAttempt = true;
        }
      });
      this.log(
        `QQ forum publication submission uncertain scope=${forumScopeLogId(publication.guildId, publication.channelId)} source=${forumValueLogId(sourceThreadId)} attempt=${publication.attempt} error=${forumErrorName(error)}`,
      );
    }
  }

  private async waitForRemainingAuditWindow(
    publication: QQForumPublication,
    waiter: PublicationWaiter,
  ): Promise<void> {
    const auditTimeoutMs = Math.max(
      1,
      this.timing.auditTimeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS,
    );
    const submittedAtMs = publication.submittedAtMs;
    const remaining = submittedAtMs === undefined
      ? 0
      : Math.min(
          auditTimeoutMs,
          submittedAtMs + auditTimeoutMs - this.currentTime(),
        );
    if (remaining <= 0) return;
    await waitForPublicationSignal(
      waiter.promise,
      remaining,
      this.timing.pause,
    );
  }

  private async reconcilePublicationAttempt(
    publication: QQForumPublication,
    waiter: PublicationWaiter,
  ): Promise<"found" | "absent" | "unavailable" | "signaled"> {
    let threads: QQForumThreadSummary[];
    try {
      const result = await this.listForumThreadsUntilSignal(
        publication,
        waiter,
      );
      if (result === undefined) return "signaled";
      threads = result;
    } catch (error) {
      this.log(
        `QQ forum reconciliation list failed scope=${forumScopeLogId(publication.guildId, publication.channelId)} source=${forumValueLogId(publication.sourceThreadId)} error=${forumErrorName(error)}`,
      );
      return "unavailable";
    }
    if (!threads.some((thread) =>
      forumThreadHasMarker(thread, publication.marker)
    )) {
      return "absent";
    }
    let reconciled = false;
    await this.updatePublication(
      publication.sourceThreadId,
      (latest) => {
        if (
          latest.phase !== "auditSucceeded" &&
          latest.phase !== "auditFailed"
        ) {
          this.markPublicationTerminal(
            latest,
            "auditSucceeded",
            undefined,
          );
          reconciled = true;
        }
      },
    );
    const latest = this.publications.get(publication.sourceThreadId);
    if (latest?.phase === "auditFailed") {
      throw new QQForumAuditError(latest.error?.result);
    }
    if (!reconciled && latest?.phase !== "auditSucceeded") {
      return "signaled";
    }
    this.log(
      `QQ forum publication reconciled scope=${forumScopeLogId(publication.guildId, publication.channelId)} source=${forumValueLogId(publication.sourceThreadId)}`,
    );
    return "found";
  }

  private async listForumThreadsUntilSignal(
    publication: QQForumPublication,
    waiter?: PublicationWaiter,
  ): Promise<QQForumThreadSummary[] | undefined> {
    const listing = this.api.listForumThreads(publication.channelId);
    if (!waiter) return listing;
    return Promise.race([
      listing,
      waiter.promise.then(() => undefined),
    ]);
  }

  private async waitForRetryBackoff(
    waiter: PublicationWaiter,
  ): Promise<void> {
    await waitForPublicationSignal(
      waiter.promise,
      Math.max(
        1,
        this.timing.reconciliationPollMs ??
          DEFAULT_RECONCILIATION_POLL_MS,
      ),
      this.timing.pause,
    );
  }

  private async updatePublication(
    sourceThreadId: string,
    update: (publication: QQForumPublication) => void,
  ): Promise<void> {
    await this.withStateLock(async () => {
      const publication = this.publications.get(sourceThreadId);
      if (!publication) throw new Error("QQ forum publication state is missing");
      const previous = structuredClone(publication);
      const previousQuarantine = this.auditQuarantinesByChannel.get(
        publication.channelId,
      );
      update(publication);
      try {
        await this.persistQueue();
      } catch (error) {
        this.publications.set(sourceThreadId, previous);
        if (previousQuarantine) {
          this.auditQuarantinesByChannel.set(
            publication.channelId,
            previousQuarantine,
          );
        } else {
          this.auditQuarantinesByChannel.delete(publication.channelId);
        }
        throw error;
      }
    });
  }

  private markPublicationTerminal(
    publication: QQForumPublication,
    phase: "auditSucceeded" | "auditFailed",
    error: QQForumPublicationError | undefined,
  ): void {
    publication.phase = phase;
    publication.error = error;
    if (
      publication.attempt <= 1 &&
      publication.ambiguousAttempt !== true
    ) {
      return;
    }
    const submittedAtMs = publication.submittedAtMs;
    if (submittedAtMs === undefined) return;
    const untilMs = submittedAtMs + this.auditTimeoutMs();
    if (untilMs <= this.currentTime()) return;
    this.auditQuarantinesByChannel.set(publication.channelId, {
      sourceThreadId: publication.sourceThreadId,
      guildId: publication.guildId,
      channelId: publication.channelId,
      untilMs,
    });
  }

  private async resumePublication(
    sourceThreadId: string,
  ): Promise<QQPublishForumThreadResponse> {
    const publication = this.publications.get(sourceThreadId);
    if (!publication) throw new Error("QQ forum publication state is missing");
    return this.withChannelLock(publication.channelId, async () => {
      const latest = this.publications.get(sourceThreadId);
      if (!latest) throw new Error("QQ forum publication state is missing");
      if (latest.phase === "auditSucceeded") {
        return confirmedPublicationResponse(latest);
      }
      if (latest.phase === "auditFailed") {
        return await this.submitPublication(sourceThreadId);
      }
      return this.submitPublication(sourceThreadId);
    });
  }

  private currentTime(): number {
    return (this.timing.now ?? Date.now)();
  }

  private auditTimeoutMs(): number {
    return Math.max(
      1,
      this.timing.auditTimeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS,
    );
  }

  async handleThread(event: QQForumThreadCreateEvent): Promise<void> {
    const threadId = event.threadInfo.threadId;
    if (!event.authorId || !threadId) {
      this.log(
        `QQ forum event ignored scope=${forumScopeLogId(event.guildId, event.channelId)}: author or thread is missing`,
      );
      return;
    }

    let pending = false;
    await this.withStateLock(async () => {
      if (
        !this.getConfig().qq.forum.guildAllowFrom.includes(event.guildId)
      ) {
        if (
          !this.accessPolicyApplied &&
          (
            this.pendingThreads.has(threadId) ||
            this.publications.has(threadId)
          )
        ) {
          this.log(
            `QQ forum event ignored scope=${forumScopeLogId(event.guildId, event.channelId)} thread=${forumValueLogId(threadId)}: access policy is not proven`,
          );
          return;
        }
        await this.removeDisallowedThreadState(
          threadId,
          event.guildId,
          event.channelId,
        );
        return;
      }
      if (this.completedThreadIds.has(threadId)) return;
      if (this.activeThreadIds.has(threadId)) {
        this.retryRequestedThreadIds.add(threadId);
      }
      if (!this.pendingThreads.has(threadId)) {
        this.pendingThreads.set(threadId, event);
        try {
          await this.persistQueue();
        } catch (error) {
          this.pendingThreads.delete(threadId);
          throw error;
        }
      }
      pending = true;
    });
    if (pending) this.launch(threadId);
  }

  private drainPending(): void {
    for (const threadId of this.pendingThreads.keys()) {
      this.launch(threadId);
    }
  }

  private launch(threadId: string): void {
    if (
      !this.started ||
      this.stopped ||
      !this.accessPolicyApplied ||
      !this.identity ||
      this.activeThreadIds.has(threadId)
    ) {
      return;
    }
    const event = this.pendingThreads.get(threadId);
    if (!event) return;
    const config = this.getConfig().qq.forum;
    if (!config.enabled) {
      return;
    }
    if (!config.guildAllowFrom.includes(event.guildId)) {
      void this.removeDisallowedThread(
        threadId,
        event.guildId,
        event.channelId,
      ).catch((error) => {
        this.log(
          `QQ forum disallowed task cleanup failed scope=${forumScopeLogId(event.guildId, event.channelId)} thread=${forumValueLogId(threadId)} error=${forumErrorName(error)}`,
        );
      });
      return;
    }

    this.activeThreadIds.add(threadId);
    let failed = false;
    void this.process(event, this.identity)
      .catch((error) => {
        failed = true;
        this.log(
          `QQ forum task retained scope=${forumScopeLogId(event.guildId, event.channelId)} thread=${forumValueLogId(threadId)} error=${forumErrorName(error)}`,
        );
      })
      .finally(() => {
        this.activeThreadIds.delete(threadId);
        if (!failed) {
          this.retryRequestedThreadIds.delete(threadId);
          return;
        }
        if (this.retryRequestedThreadIds.delete(threadId)) {
          this.launch(threadId);
        }
      });
  }

  private async process(
    event: QQForumThreadCreateEvent,
    identity: QQBotIdentity,
  ): Promise<void> {
    const authorId = event.authorId!;
    const threadId = event.threadInfo.threadId;
    const publication = this.publications.get(threadId);
    if (publication) {
      if (publication.phase !== "auditSucceeded") {
        await this.resumePublication(threadId);
      }
      await this.complete(threadId);
      return;
    }
    if (authorId === identity.id) {
      this.log(
        `QQ forum event ignored scope=${forumScopeLogId(event.guildId, event.channelId)} thread=${forumValueLogId(threadId)}: author is the bot`,
      );
      await this.complete(threadId);
      return;
    }

    const prepared = prepareForumThread(event, identity);
    if (!prepared) {
      this.log(
        `QQ forum event ignored scope=${forumScopeLogId(event.guildId, event.channelId)} thread=${forumValueLogId(threadId)}: no leading bot mention`,
      );
      await this.complete(threadId);
      return;
    }

    await this.onMessage({
      accountId: this.api.appId,
      conversationId:
        `qqbot:${this.api.appId}:forum:${event.guildId}:${event.channelId}:${prepared.threadId}`,
      chatType: "forum",
      senderId: authorId,
      targetId: event.channelId,
      messageId: prepared.threadId,
      timestamp: event.threadInfo.dateTime,
      text: prepared.prompt,
      attachments: [],
      addressed: true,
      forum: {
        guildId: event.guildId,
        channelId: event.channelId,
        threadId: prepared.threadId,
        sourceTitle: prepared.sourceTitle,
        botUsername: identity.username,
      },
    });
    await this.complete(threadId);
  }

  private async complete(threadId: string): Promise<void> {
    await this.withStateLock(async () => {
      const event = this.pendingThreads.get(threadId);
      if (!event) return;
      const pendingSnapshot = new Map(this.pendingThreads);
      const completedSnapshot = new Set(this.completedThreadIds);
      const publicationSnapshot = this.publications.get(threadId);
      this.pendingThreads.delete(threadId);
      this.publications.delete(threadId);
      this.rememberCompleted(threadId);
      try {
        await this.persistQueue();
      } catch (error) {
        this.pendingThreads.clear();
        for (const [pendingThreadId, pendingEvent] of pendingSnapshot) {
          this.pendingThreads.set(pendingThreadId, pendingEvent);
        }
        this.completedThreadIds.clear();
        for (const completedThreadId of completedSnapshot) {
          this.completedThreadIds.add(completedThreadId);
        }
        if (publicationSnapshot) {
          this.publications.set(threadId, publicationSnapshot);
        }
        throw error;
      }
    });
  }

  private removeDisallowedThread(
    threadId: string,
    guildId: string,
    channelId: string,
  ): Promise<void> {
    return this.withStateLock(() =>
      this.removeDisallowedThreadState(threadId, guildId, channelId)
    );
  }

  private async removeDisallowedThreadState(
    threadId: string,
    guildId: string,
    channelId: string,
  ): Promise<void> {
    if (this.getConfig().qq.forum.guildAllowFrom.includes(guildId)) return;
    const pending = this.pendingThreads.get(threadId);
    const publication = this.publications.get(threadId);
    const quarantine = this.auditQuarantinesByChannel.get(channelId);
    const matchingQuarantine =
      quarantine?.sourceThreadId === threadId ? quarantine : undefined;
    if (!pending && !publication && !matchingQuarantine) {
      this.log(
        `QQ forum event ignored scope=${forumScopeLogId(guildId, channelId)} thread=${forumValueLogId(threadId)}: guild is not allowed`,
      );
      return;
    }
    this.pendingThreads.delete(threadId);
    this.publications.delete(threadId);
    if (matchingQuarantine) {
      this.auditQuarantinesByChannel.delete(channelId);
    }
    try {
      await this.persistQueue();
    } catch (error) {
      if (pending) this.pendingThreads.set(threadId, pending);
      if (publication) this.publications.set(threadId, publication);
      if (matchingQuarantine) {
        this.auditQuarantinesByChannel.set(channelId, matchingQuarantine);
      }
      throw error;
    }
    this.log(
      `QQ forum task deleted scope=${forumScopeLogId(guildId, channelId)} thread=${forumValueLogId(threadId)}: guild is not allowed`,
    );
  }

  private persistQueue(): Promise<void> {
    const state: QQForumQueueState = {
      version: 1,
      pending: [...this.pendingThreads.values()],
      completed: [...this.completedThreadIds],
      ...(this.publications.size > 0
        ? { publications: [...this.publications.values()] }
        : {}),
      ...(this.auditQuarantinesByChannel.size > 0
        ? {
            auditQuarantines: [
              ...this.auditQuarantinesByChannel.values(),
            ],
          }
        : {}),
    };
    return this.persistState(this.queueFile, state);
  }

  private withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.stateOperations.then(operation);
    this.stateOperations = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private async withChannelLock<T>(
    channelId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.channelOperations.get(channelId) ?? Promise.resolve();
    const run = previous.then(async () => {
      await this.waitForAuditQuarantine(channelId);
      return operation();
    });
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.channelOperations.set(channelId, settled);
    try {
      return await run;
    } finally {
      if (this.channelOperations.get(channelId) === settled) {
        this.channelOperations.delete(channelId);
      }
    }
  }

  private async waitForAuditQuarantine(channelId: string): Promise<void> {
    while (true) {
      if (this.stopped) throw new Error("QQ forum coordinator stopped");
      const quarantine = this.auditQuarantinesByChannel.get(channelId);
      if (!quarantine) return;
      const remaining = quarantine.untilMs - this.currentTime();
      if (remaining > 0) await this.pause(remaining);
      await this.withStateLock(async () => {
        const latest = this.auditQuarantinesByChannel.get(channelId);
        if (!latest || latest.untilMs > this.currentTime()) return;
        this.auditQuarantinesByChannel.delete(channelId);
        try {
          await this.persistQueue();
        } catch (error) {
          this.auditQuarantinesByChannel.set(channelId, latest);
          throw error;
        }
      });
    }
  }

  private pause(milliseconds: number): Promise<void> {
    if (this.timing.pause) return this.timing.pause(milliseconds);
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private rememberCompleted(threadId: string): void {
    if (this.completedThreadIds.has(threadId)) {
      this.completedThreadIds.delete(threadId);
    }
    this.completedThreadIds.add(threadId);
    if (this.completedThreadIds.size > MAX_PROCESSED_THREAD_IDS) {
      const oldest = this.completedThreadIds.values().next().value;
      if (oldest !== undefined) this.completedThreadIds.delete(oldest);
    }
  }
}

async function loadForumQueueState(file: string): Promise<QQForumQueueState> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, pending: [] };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Invalid QQ forum queue state");
  }

  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.pending)) {
    throw new Error("Invalid QQ forum queue state");
  }
  return {
    version: 1,
    pending: parsed.pending.map(parseQueuedForumEvent),
    completed: parseCompletedThreadIds(parsed.completed),
    publications: parseForumPublications(parsed.publications),
    auditQuarantines: parseForumAuditQuarantines(
      parsed.auditQuarantines,
    ),
  };
}

function parseCompletedThreadIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PROCESSED_THREAD_IDS) {
    throw new Error("Invalid QQ forum queue state");
  }
  const completed = value.map((threadId) => {
    if (typeof threadId !== "string" || !threadId) {
      throw new Error("Invalid QQ forum queue state");
    }
    return threadId;
  });
  if (new Set(completed).size !== completed.length) {
    throw new Error("Invalid QQ forum queue state");
  }
  return completed;
}

function parseForumPublications(value: unknown): QQForumPublication[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Invalid QQ forum queue state");
  }
  const publications = value.map((item) => {
    if (!isRecord(item)) {
      throw new Error("Invalid QQ forum publication state");
    }
    const phase = item.phase;
    if (
      typeof item.sourceThreadId !== "string" ||
      !item.sourceThreadId ||
      typeof item.guildId !== "string" ||
      !item.guildId ||
      typeof item.channelId !== "string" ||
      !item.channelId ||
      typeof item.marker !== "string" ||
      !/^[a-f0-9]{8}$/.test(item.marker) ||
      ![
        "submitting",
        "waitingAudit",
        "auditSucceeded",
        "auditFailed",
      ].includes(String(phase)) ||
      typeof item.title !== "string" ||
      !item.title ||
      typeof item.content !== "string" ||
      !item.content
    ) {
      throw new Error("Invalid QQ forum publication state");
    }
    const error = parseForumPublicationError(item.error);
    if (
      item.taskId !== undefined &&
      (typeof item.taskId !== "string" || !item.taskId)
    ) {
      throw new Error("Invalid QQ forum publication state");
    }
    if (
      item.attempt !== undefined &&
      (
        typeof item.attempt !== "number" ||
        !Number.isInteger(item.attempt) ||
        item.attempt < 0
      )
    ) {
      throw new Error("Invalid QQ forum publication state");
    }
    if (
      item.submittedAtMs !== undefined &&
      (
        typeof item.submittedAtMs !== "number" ||
        !Number.isInteger(item.submittedAtMs) ||
        item.submittedAtMs < 0
      )
    ) {
      throw new Error("Invalid QQ forum publication state");
    }
    if (
      item.ambiguousAttempt !== undefined &&
      typeof item.ambiguousAttempt !== "boolean"
    ) {
      throw new Error("Invalid QQ forum publication state");
    }
    const attempt = item.attempt as number | undefined ??
      (
        phase === "submitting" || phase === "waitingAudit"
          ? 1
          : 0
      );
    return {
      sourceThreadId: item.sourceThreadId,
      guildId: item.guildId,
      channelId: item.channelId,
      marker: item.marker,
      phase: phase as QQForumPublicationPhase,
      taskId: item.taskId as string | undefined,
      submittedAtMs: item.submittedAtMs as number | undefined,
      attempt,
      ambiguousAttempt: item.ambiguousAttempt as boolean | undefined ??
        (phase === "submitting" && attempt > 0),
      title: item.title,
      content: item.content,
      error,
    };
  });
  if (
    new Set(publications.map((item) => item.sourceThreadId)).size !==
    publications.length
  ) {
    throw new Error("Invalid QQ forum queue state");
  }
  return publications;
}

function parseForumPublicationError(
  value: unknown,
): QQForumPublicationError | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Invalid QQ forum publication state");
  }
  if (
    value.kind !== undefined &&
    value.kind !== "audit" &&
    value.kind !== "submissionRejected"
  ) {
    throw new Error("Invalid QQ forum publication state");
  }
  if (value.result !== undefined && !Number.isInteger(value.result)) {
    throw new Error("Invalid QQ forum publication state");
  }
  if (
    value.status !== undefined &&
    (
      !Number.isInteger(value.status) ||
      (value.status as number) < 100 ||
      (value.status as number) > 599
    )
  ) {
    throw new Error("Invalid QQ forum publication state");
  }
  if (
    value.code !== undefined &&
    privacySafeQQErrorCode(value.code) === undefined
  ) {
    throw new Error("Invalid QQ forum publication state");
  }
  if (
    value.detailHash !== undefined &&
    (
      typeof value.detailHash !== "string" ||
      !/^[a-f0-9]{12}$/.test(value.detailHash)
    )
  ) {
    throw new Error("Invalid QQ forum publication state");
  }
  if (value.result === undefined && value.status === undefined) {
    throw new Error("Invalid QQ forum publication state");
  }
  return {
    kind: value.kind as QQForumPublicationError["kind"],
    result: value.result as number | undefined,
    status: value.status as number | undefined,
    code: value.code as string | number | undefined,
    detailHash: value.detailHash as string | undefined,
  };
}

function parseForumAuditQuarantines(
  value: unknown,
): QQForumAuditQuarantine[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Invalid QQ forum queue state");
  }
  const quarantines = value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.sourceThreadId !== "string" ||
      !item.sourceThreadId ||
      typeof item.guildId !== "string" ||
      !item.guildId ||
      typeof item.channelId !== "string" ||
      !item.channelId ||
      typeof item.untilMs !== "number" ||
      !Number.isInteger(item.untilMs) ||
      item.untilMs < 0
    ) {
      throw new Error("Invalid QQ forum audit quarantine state");
    }
    return {
      sourceThreadId: item.sourceThreadId,
      guildId: item.guildId,
      channelId: item.channelId,
      untilMs: item.untilMs,
    };
  });
  if (
    new Set(quarantines.map((item) => item.channelId)).size !==
    quarantines.length
  ) {
    throw new Error("Invalid QQ forum audit quarantine state");
  }
  return quarantines;
}

function parseQueuedForumEvent(value: unknown): QQForumThreadCreateEvent {
  if (!isRecord(value) || !isRecord(value.threadInfo)) {
    throw new Error("Invalid QQ forum queue event");
  }
  const { threadInfo } = value;
  if (
    typeof value.guildId !== "string" ||
    !value.guildId ||
    typeof value.channelId !== "string" ||
    !value.channelId ||
    typeof value.authorId !== "string" ||
    !value.authorId ||
    typeof threadInfo.threadId !== "string" ||
    !threadInfo.threadId ||
    typeof threadInfo.dateTime !== "string" ||
    !("title" in threadInfo) ||
    !("content" in threadInfo)
  ) {
    throw new Error("Invalid QQ forum queue event");
  }
  return {
    guildId: value.guildId,
    channelId: value.channelId,
    authorId: value.authorId,
    threadInfo: {
      threadId: threadInfo.threadId,
      title: threadInfo.title,
      content: threadInfo.content,
      dateTime: threadInfo.dateTime,
    },
  };
}

export function prepareForumThread(
  thread: QQForumThread,
  identity: QQBotIdentity,
): PreparedForumThread | null {
  const title = richText(thread.threadInfo.title).trim() || "Untitled forum thread";
  const contentSegments = richSegments(thread.threadInfo.content);
  const strippedContent = stripLeadingBotMention(contentSegments, identity);
  if (strippedContent !== null) {
    return {
      threadId: thread.threadInfo.threadId,
      sourceTitle: title,
      prompt: forumPrompt(title, strippedContent),
    };
  }

  const titleSegments = richSegments(thread.threadInfo.title);
  const strippedTitle = stripLeadingBotMention(titleSegments, identity);
  if (strippedTitle === null) return null;
  const content = segmentsText(contentSegments).trim();
  return {
    threadId: thread.threadInfo.threadId,
    sourceTitle: strippedTitle || title,
    prompt: forumPrompt(strippedTitle || title, content),
  };
}

function forumPrompt(title: string, content: string): string {
  const heading = `Forum thread title: ${title.trim()}`;
  const body = content.trim();
  return body ? `${heading}\n\n${body}` : heading;
}

function richText(value: unknown): string {
  return segmentsText(richSegments(value));
}

function richSegments(value: unknown): RichSegment[] {
  const decoded = decodeJsonValue(value);
  if (typeof decoded === "string") {
    return [{ text: decoded, mentionIds: [] }];
  }
  if (Array.isArray(decoded)) {
    return decoded.flatMap((item) => richSegments(item));
  }
  if (!isRecord(decoded)) return [];

  const mentionIds = directMentionIds(decoded);
  if (decoded.paragraphs !== undefined) {
    const paragraphs = Array.isArray(decoded.paragraphs)
      ? decoded.paragraphs
      : [decoded.paragraphs];
    const nested = paragraphs.flatMap((paragraph, index) => [
      ...(index > 0 ? [{ text: "\n", mentionIds: [] }] : []),
      ...richSegments(paragraph),
    ]);
    return mergeMentionIds(nested, mentionIds);
  }
  if (typeof decoded.text === "string") {
    return [{ text: decoded.text, mentionIds }];
  }
  if (decoded.text !== undefined && typeof decoded.text === "object") {
    return mergeMentionIds(richSegments(decoded.text), mentionIds);
  }
  if (decoded.text_info !== undefined) {
    return mergeMentionIds(richSegments(decoded.text_info), mentionIds);
  }

  for (const key of [
    "elems",
    "elements",
    "children",
    "ops",
    "blocks",
    "content",
    "data",
  ]) {
    if (decoded[key] !== undefined) {
      return mergeMentionIds(richSegments(decoded[key]), mentionIds);
    }
  }

  const nested = Object.entries(decoded)
    .filter(([key]) => !isMetadataKey(key))
    .flatMap(([, item]) => richSegments(item));
  return mergeMentionIds(nested, mentionIds);
}

function mergeMentionIds(
  segments: RichSegment[],
  mentionIds: string[],
): RichSegment[] {
  if (mentionIds.length === 0) return segments;
  if (segments.length === 0) return [{ text: "", mentionIds }];
  return segments.map((segment, index) => index === 0
    ? { ...segment, mentionIds: [...mentionIds, ...segment.mentionIds] }
    : segment);
}

function decodeJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!/^[\[{"].*[\]}"]$/s.test(trimmed)) return value;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "string" && parsed === value ? value : parsed;
  } catch {
    return value;
  }
}

function directMentionIds(value: Record<string, unknown>): string[] {
  const sources: unknown[] = [];
  if (value.at_info !== undefined) sources.push(value.at_info);
  if (value.atInfo !== undefined) sources.push(value.atInfo);
  if (
    value.type === "at" ||
    value.type === "mention" ||
    value.kind === "at" ||
    value.kind === "mention"
  ) {
    sources.push(value);
  }
  return [...new Set(sources.flatMap(collectUserIds))];
}

function collectUserIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectUserIds);
  if (!isRecord(value)) return [];
  const ids: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (
      ["user_id", "userId", "id", "openid", "user_openid"].includes(key) &&
      (typeof item === "string" || typeof item === "number")
    ) {
      ids.push(String(item));
    } else if (typeof item === "object" && item !== null) {
      ids.push(...collectUserIds(item));
    }
  }
  return ids;
}

function stripLeadingBotMention(
  segments: RichSegment[],
  identity: QQBotIdentity,
): string | null {
  const firstIndex = segments.findIndex((segment) =>
    segment.text.trim().length > 0 || segment.mentionIds.length > 0,
  );
  if (firstIndex < 0) return null;
  const first = segments[firstIndex]!;
  const realMention = first.mentionIds.includes(identity.id);
  const stripped = stripLiteralMention(first.text, identity.username);
  if (!realMention && stripped === null) return null;

  const replacement = stripped ?? first.text;
  return segmentsText([
    ...segments.slice(0, firstIndex),
    { text: replacement, mentionIds: [] },
    ...segments.slice(firstIndex + 1),
  ]).trim();
}

function stripLiteralMention(text: string, username: string): string | null {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(
      `^\\s*@${escaped}(?=$|[\\s\\p{P}])`,
      "iu",
    ),
  );
  if (!match) return null;
  return text.slice(match[0].length)
    .replace(/^[\s\p{P}]+/u, "");
}

function segmentsText(segments: RichSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

function isMetadataKey(key: string): boolean {
  return [
    "at_info",
    "atInfo",
    "text_info",
    "type",
    "kind",
    "style",
    "attrs",
    "user_id",
    "userId",
    "id",
    "openid",
    "user_openid",
  ].includes(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function forumResultTitle(
  botUsername: string,
  sourceTitle: string,
  marker?: string,
  maximumCharacters = 80,
): string {
  const prefix = `${botUsername.trim() || "Bot"}: `;
  const normalized =
    sourceTitle.replace(/\s+/g, " ").trim() || "Forum response";
  const suffix = marker ? ` [C:${marker}]` : "";
  const available = Math.max(0, maximumCharacters - Array.from(suffix).length);
  const base = Array.from(`${prefix}${normalized}`);
  const title = base.length <= available
    ? base.join("")
    : `${base.slice(0, Math.max(0, available - 1)).join("")}…`;
  return `${title}${suffix}`;
}

function forumSourceMarker(
  appId: string,
  guildId: string,
  channelId: string,
  sourceThreadId: string,
): string {
  return createHash("sha256")
    .update(`${appId}\0${guildId}\0${channelId}\0${sourceThreadId}`)
    .digest("hex")
    .slice(0, 8);
}

function confirmedPublicationResponse(
  publication: QQForumPublication,
): QQPublishForumThreadResponse {
  return {
    taskId: publication.taskId ?? "marker-reconciled",
    createTime: "",
  };
}

function forumThreadHasMarker(
  thread: QQForumThreadSummary,
  marker: string,
): boolean {
  const token = `[C:${marker}]`;
  return serializedForumValue(thread.title).includes(token);
}

function serializedForumValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function publicationWaiter(): PublicationWaiter {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function waitForPublicationSignal(
  audit: Promise<void>,
  timeoutMs: number,
  pause?: (milliseconds: number) => Promise<void>,
): Promise<"audit" | "elapsed"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = pause
    ? pause(timeoutMs).then(() => "elapsed" as const)
    : new Promise<"elapsed">((resolve) => {
        timer = setTimeout(() => resolve("elapsed"), timeoutMs);
        timer.unref();
      });
  return Promise.race([
    audit.then(() => "audit" as const),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class QQForumAuditError extends Error {
  constructor(result?: number) {
    super(
      result === undefined
        ? "QQ forum publication audit failed"
        : `QQ forum publication audit failed (result ${result})`,
    );
    this.name = "QQForumAuditError";
  }
}

function forumScopeLogId(guildId: string, channelId: string): string {
  return forumValueLogId(`${guildId}:${channelId}`);
}

function forumValueLogId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function forumErrorName(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as NodeJS.ErrnoException).code;
  return code ? `${error.name}:${code}` : error.name;
}

function isDefinitiveForumSubmissionRejection(
  error: unknown,
): error is QQApiError {
  return (
    error instanceof QQApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 425, 429].includes(error.status)
  );
}

function privacySafeQQErrorCode(
  code: unknown,
): string | number | undefined {
  if (typeof code === "number" && Number.isSafeInteger(code)) return code;
  if (
    typeof code === "string" &&
    /^[A-Za-z0-9_.:-]{1,64}$/.test(code)
  ) {
    return code;
  }
  return undefined;
}
