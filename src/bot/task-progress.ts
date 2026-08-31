import type { SessionManager } from "../acp/session-manager.js";
import type { QQReplyStream } from "../qq/sender.js";

const MINUTE_MS = 60_000;
const HEARTBEAT_DELAY_MS = 2 * MINUTE_MS;
const HEARTBEAT_INTERVAL_MS = 2 * MINUTE_MS;
const RECENT_DELIVERY_MS = 90_000;
const STALE_ACTIVITY_MS = 8 * MINUTE_MS;

type RuntimeStatus = Awaited<ReturnType<SessionManager["getRuntimeStatus"]>>;
type Schedule = (delayMs: number, callback: () => void) => () => void;
export type TaskProgressPhase = "queued" | "starting" | "running";

export class TaskProgressReporter {
  private readonly startedAt: number;
  private cancelTimer?: () => void;
  private stopped = false;
  private phase: TaskProgressPhase = "queued";

  constructor(
    private readonly reply: Pick<
      QQReplyStream,
      "sendProgress" | "getLastDeliveryAt"
    >,
    private readonly getStatus: () => Promise<RuntimeStatus>,
    private readonly log: (message: string) => void,
    private readonly now: () => number = Date.now,
    private readonly schedule: Schedule = defaultSchedule,
  ) {
    this.startedAt = now();
  }

  start(): void {
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  setPhase(phase: Exclude<TaskProgressPhase, "queued">): void {
    this.phase = phase;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const elapsed = this.now() - this.startedAt;
    const delay =
      elapsed < HEARTBEAT_DELAY_MS
        ? HEARTBEAT_DELAY_MS - elapsed
        : HEARTBEAT_INTERVAL_MS;
    this.cancelTimer = this.schedule(
      Math.max(0, delay),
      () => void this.report(),
    );
  }

  private async report(): Promise<void> {
    if (this.stopped) return;
    try {
      const now = this.now();
      const lastDelivery = this.reply.getLastDeliveryAt();
      if (
        lastDelivery === undefined ||
        now - lastDelivery >= RECENT_DELIVERY_MS
      ) {
        const status = await this.getStatus();
        if (this.stopped) return;
        const delivered = await this.reply.sendProgress(
          formatTaskProgress(
            status,
            now - this.startedAt,
            now,
            this.phase,
          ),
        );
        this.log(
          `QQ task heartbeat ${delivered ? "sent" : "skipped"} elapsedMs=${now - this.startedAt} phase=${this.phase} activityAgeMs=${
            status.lastAgentActivityAt === undefined
              ? "unknown"
              : Math.max(0, now - status.lastAgentActivityAt)
          }`,
        );
      }
    } catch (error) {
      this.log(`QQ task heartbeat failed: ${errorMessage(error)}`);
    } finally {
      this.scheduleNext();
    }
  }
}

export function formatTaskProgress(
  status: RuntimeStatus,
  elapsedMs: number,
  now: number,
  phase: TaskProgressPhase = "running",
): string {
  const elapsed = formatDuration(elapsedMs);
  if (phase === "queued") {
    return `任务仍在排队，已等待 ${elapsed}。当前有 ${status.activeTurns} 个并发任务。当前群或机器人可能无法使用主动消息；若超过 5 分钟，请发送 Status 查询状态或取回已完成结果。`;
  }
  if (phase === "starting") {
    return `任务已等待 ${elapsed}，正在启动或恢复 Agent 会话。当前群或机器人可能无法使用主动消息；若超过 5 分钟，请发送 Status 查询状态或取回已完成结果。`;
  }
  if (!status.agentProcessAlive) {
    return `任务已运行 ${elapsed}，但 Agent 进程已停止，结果可能无法完成。请发送 Status 检查待发送结果，或发送 Stop 后重新提交任务。`;
  }
  const activityAge = status.lastAgentActivityAt === undefined
    ? undefined
    : Math.max(0, now - status.lastAgentActivityAt);
  if (activityAge !== undefined && activityAge >= STALE_ACTIVITY_MS) {
    return `任务已运行 ${elapsed}，但 Agent 已有 ${formatDuration(activityAge)} 没有报告新活动，可能正在执行耗时命令，也可能卡住。请发送 Status 查询；Stop 可取消。`;
  }
  const activity = status.lastAgentActivity ?? "正在工作";
  const recent = activityAge === undefined
    ? ""
    : `，最近活动在 ${formatDuration(activityAge)} 前`;
  return `任务仍在正常运行，已用时 ${elapsed}${recent}。当前状态：${activity}。群聊被动回复超过 5 分钟后失效；请发送 Status 查询状态或取回结果。`;
}

function defaultSchedule(delayMs: number, callback: () => void): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.max(1, Math.floor(milliseconds / MINUTE_MS));
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
