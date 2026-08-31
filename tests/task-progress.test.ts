import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTaskProgress,
  TaskProgressReporter,
} from "../src/bot/task-progress.js";

test("task progress continues when Agent output has not reached QQ", async () => {
  let now = 0;
  let scheduled: (() => void) | undefined;
  const sent: string[] = [];
  const reporter = new TaskProgressReporter(
    {
      getLastDeliveryAt: () => 0,
      sendProgress: async (text: string) => {
        sent.push(text);
        return true;
      },
    },
    async () => runtimeStatus({
      conversationActive: true,
      lastAgentActivityAt: 90_000,
      lastAgentActivity: "正在编辑文件",
    }),
    () => {},
    () => now,
    (_delay, callback) => {
      scheduled = callback;
      return () => {};
    },
  );

  reporter.start();
  reporter.setPhase("running");
  now = 2 * 60_000;
  scheduled?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /正常运行/);
  assert.match(sent[0]!, /正在编辑文件/);

  now = 4 * 60_000;
  scheduled?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  reporter.stop();
});

test("task progress distinguishes queued, stopped, and stale tasks", () => {
  assert.match(
    formatTaskProgress(
      runtimeStatus(),
      5 * 60_000,
      5 * 60_000,
      "queued",
    ),
    /仍在排队/,
  );
  assert.match(
    formatTaskProgress(
      runtimeStatus({ agentProcessAlive: false }),
      5 * 60_000,
      5 * 60_000,
      "running",
    ),
    /Agent 进程已停止/,
  );
  assert.match(
    formatTaskProgress(
      runtimeStatus({
        conversationActive: true,
        lastAgentActivityAt: 0,
      }),
      10 * 60_000,
      10 * 60_000,
      "running",
    ),
    /可能.*卡住/,
  );
});

function runtimeStatus(
  overrides: Partial<{
    conversationLoaded: boolean;
    conversationActive: boolean;
    conversationPending: boolean;
    residentSessions: number;
    pendingSessions: number;
    activeTurns: number;
    maxConcurrent: number;
    turnStartedAt: number;
    lastAgentActivityAt: number;
    lastAgentActivity: string;
    agentProcessAlive: boolean;
    options: Record<string, string | boolean>;
  }> = {},
) {
  return {
    conversationLoaded: true,
    conversationActive: false,
    conversationPending: false,
    residentSessions: 1,
    pendingSessions: 0,
    activeTurns: 1,
    maxConcurrent: 10,
    agentProcessAlive: true,
    options: {},
    ...overrides,
  };
}
