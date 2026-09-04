import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PreparedArtifact } from "../src/artifacts/file.js";
import { createInitialConfig } from "../src/config/schema.js";
import { QQApi, QQApiError } from "../src/qq/api.js";
import {
  prepareForumThread,
  QQForumCoordinator,
  type QQForumApi,
} from "../src/qq/forum.js";
import type { QQForumThreadCreateEvent } from "../src/qq/gateway.js";
import {
  forumResultTitle,
  QQSender,
  type QQMessageApi,
} from "../src/qq/sender.js";
import type { QQForumInboundMessage } from "../src/qq/types.js";

test("forum parsing accepts leading real and literal bot mentions only", () => {
  const identity = { id: "bot-user", username: "C" };
  const real = forumThread({
    content: [{
      at_info: { user_id: "bot-user" },
    }, {
      text_info: { text: " explain the reaction" },
    }],
  });
  const literal = forumThread({ content: "@c，compare these compounds" });
  const middle = forumThread({ content: "Please ask @C about this reaction" });

  assert.equal(
    prepareForumThread(real, identity)?.prompt,
    "Forum thread title: Chemistry\n\nexplain the reaction",
  );
  assert.equal(
    prepareForumThread(literal, identity)?.prompt,
    "Forum thread title: Chemistry\n\ncompare these compounds",
  );
  assert.equal(prepareForumThread(middle, identity), null);
});

test("forum parsing preserves multiple and blank official paragraphs", () => {
  const prepared = prepareForumThread(
    forumThread({
      title: JSON.stringify({
        paragraphs: [{
          elems: [{ text_info: { text: "Multi-paragraph request" } }],
        }],
      }),
      content: JSON.stringify({
        paragraphs: [
          {
            elems: [
              { at_info: { user_id: "bot-user" } },
              { text_info: { text: " first paragraph" } },
            ],
          },
          { elems: [] },
          {
            elems: [{ text_info: { text: "third paragraph" } }],
          },
        ],
      }),
    }),
    { id: "bot-user", username: "C" },
  );

  assert.equal(prepared?.sourceTitle, "Multi-paragraph request");
  assert.equal(
    prepared?.prompt,
    "Forum thread title: Multi-paragraph request\n\nfirst paragraph\n\nthird paragraph",
  );
});

test("forum parsing keeps legacy JSON title and content formats", () => {
  const prepared = prepareForumThread(
    forumThread({
      title: JSON.stringify([{ text: "Legacy " }, { text: "title" }]),
      content: JSON.stringify([
        { type: "at", data: { user_id: "bot-user", text: "@C" } },
        { type: "text", data: { text: " legacy request" } },
      ]),
    }),
    { id: "bot-user", username: "C" },
  );

  assert.equal(prepared?.sourceTitle, "Legacy title");
  assert.equal(
    prepared?.prompt,
    "Forum thread title: Legacy title\n\nlegacy request",
  );
});

test("forum coordinator persists before durable acceptance resolves", async () => {
  const fixture = await forumQueueFixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const coordinator = await forumCoordinator(fixture.queueFile, async () => {
    await blocked;
  });
  const event = forumThread({
    threadId: "source-thread",
    guildId: allowedGuild,
    content: "@C solve this",
  });

  try {
    await coordinator.handleThread(event);

    assert.deepEqual(await readForumQueue(fixture.queueFile), {
      version: 1,
      pending: [event],
      completed: [],
    });
  } finally {
    release();
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator recovers pending events after identity is available", async () => {
  const fixture = await forumQueueFixture();
  const event = forumThread({ threadId: "recovered-thread" });
  const first = await forumCoordinator(
    fixture.queueFile,
    async () => assert.fail("pending task launched without identity"),
    { identity: false },
  );
  await first.handleThread(event);
  first.stop();

  const inbound: QQForumInboundMessage[] = [];
  const recovered = await forumCoordinator(
    fixture.queueFile,
    async (message) => {
      inbound.push(message as QQForumInboundMessage);
    },
    { identity: false },
  );

  try {
    assert.equal(inbound.length, 0);
    recovered.setBotIdentity({ id: "bot-user", username: "C" });
    await waitFor(() => inbound.length === 1);
    await waitForQueueLength(recovered, fixture.queueFile, 0);
    assert.equal(inbound[0]?.messageId, "recovered-thread");
  } finally {
    recovered.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator retains failures and retries them after restart", async () => {
  const fixture = await forumQueueFixture();
  const event = forumThread({ threadId: "retry-thread" });
  let failedAttempts = 0;
  const first = await forumCoordinator(fixture.queueFile, async () => {
    failedAttempts++;
    throw new Error("dispatch failed");
  });
  await first.handleThread(event);
  await waitFor(() => failedAttempts === 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  first.stop();
  assert.deepEqual(await readForumQueue(fixture.queueFile), {
    version: 1,
    pending: [event],
    completed: [],
  });

  let recoveredAttempts = 0;
  const recovered = await forumCoordinator(fixture.queueFile, async () => {
    recoveredAttempts++;
  });
  try {
    await waitFor(() => recoveredAttempts === 1);
    await waitForQueueLength(recovered, fixture.queueFile, 0);
  } finally {
    recovered.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator deduplicates a duplicate event while active", async () => {
  const fixture = await forumQueueFixture();
  let dispatches = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const coordinator = await forumCoordinator(fixture.queueFile, async () => {
    dispatches++;
    await blocked;
  });
  const event = forumThread({ threadId: "same-thread" });

  try {
    await coordinator.handleThread(event);
    await waitFor(() => dispatches === 1);
    await coordinator.handleThread(event);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(dispatches, 1);
    assert.equal((await readForumQueue(fixture.queueFile)).pending.length, 1);
  } finally {
    release();
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator deduplicates a completed thread in memory", async () => {
  const fixture = await forumQueueFixture();
  let dispatches = 0;
  const coordinator = await forumCoordinator(fixture.queueFile, async () => {
    dispatches++;
  });
  const event = forumThread({ threadId: "completed-thread" });

  try {
    await coordinator.handleThread(event);
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
    await coordinator.handleThread(event);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(dispatches, 1);
    assert.equal((await readForumQueue(fixture.queueFile)).pending.length, 0);
  } finally {
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator deduplicates a completed thread after restart", async () => {
  const fixture = await forumQueueFixture();
  const event = forumThread({ threadId: "restarted-completed-thread" });
  let dispatches = 0;
  const first = await forumCoordinator(fixture.queueFile, async () => {
    dispatches++;
  });

  await first.handleThread(event);
  await waitForQueueLength(first, fixture.queueFile, 0);
  first.stop();

  const recovered = await forumCoordinator(fixture.queueFile, async () => {
    dispatches++;
  });
  try {
    await recovered.handleThread(event);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(dispatches, 1);
    assert.deepEqual((await readForumQueue(fixture.queueFile)).completed, [
      "restarted-completed-thread",
    ]);
  } finally {
    recovered.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator evicts the oldest completed thread ID", async () => {
  const fixture = await forumQueueFixture();
  const event = forumThread({ threadId: "newly-completed-thread" });
  const completed = Array.from(
    { length: 1_000 },
    (_, index) => `completed-${index}`,
  );
  await fs.writeFile(fixture.queueFile, `${JSON.stringify({
    version: 1,
    pending: [event],
    completed,
  })}\n`);
  const coordinator = await forumCoordinator(fixture.queueFile, async () => {});

  try {
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
    const persisted = await readForumQueue(fixture.queueFile);
    assert.equal(persisted.completed?.length, 1_000);
    assert.equal(persisted.completed?.includes("completed-0"), false);
    assert.equal(persisted.completed?.includes("completed-1"), true);
    assert.equal(persisted.completed?.at(-1), "newly-completed-thread");
  } finally {
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator rejects an oversized completed thread set", async () => {
  const fixture = await forumQueueFixture();
  await fs.writeFile(fixture.queueFile, `${JSON.stringify({
    version: 1,
    pending: [],
    completed: Array.from(
      { length: 1_001 },
      (_, index) => `completed-${index}`,
    ),
  })}\n`);

  try {
    await assert.rejects(
      forumCoordinator(fixture.queueFile, async () => {}),
      /Invalid QQ forum queue state/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("forum coordinator rejects new disallowed guild events before persistence", async () => {
  const fixture = await forumQueueFixture();
  const config = forumConfig();
  config.qq.forum.guildAllowFrom = [];
  let dispatches = 0;
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {
      dispatches++;
    },
    { config },
  );

  try {
    await coordinator.handleThread(forumThread({
      threadId: "disallowed-thread",
      guildId: "9999999999999999999",
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(dispatches, 0);
    assert.equal(await fileExists(fixture.queueFile), false);
  } finally {
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator keeps recovered work when candidate startup fails", async () => {
  const fixture = await forumQueueFixture();
  const event = forumThread({ threadId: "candidate-retained-thread" });
  await fs.writeFile(fixture.queueFile, `${JSON.stringify({
    version: 1,
    pending: [event],
  })}\n`);
  const candidateConfig = forumConfig();
  candidateConfig.qq.forum.guildAllowFrom = [];
  const candidate = await forumCoordinator(
    fixture.queueFile,
    async () => assert.fail("candidate config dispatched recovered work"),
    {
      config: candidateConfig,
      identity: false,
      applyAccessPolicy: false,
    },
  );

  candidate.setBotIdentity({ id: "bot-user", username: "C" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  candidate.stop();
  assert.deepEqual((await readForumQueue(fixture.queueFile)).pending, [event]);

  const provenConfig = forumConfig();
  let dispatches = 0;
  const recovered = await forumCoordinator(
    fixture.queueFile,
    async () => {
      dispatches++;
    },
    { config: provenConfig },
  );

  try {
    await waitForQueueLength(recovered, fixture.queueFile, 0);
    assert.equal(dispatches, 1);
  } finally {
    recovered.stop();
    await fixture.cleanup();
  }
});

test("current access policy deletes recovered work removed from the allowlist", async () => {
  const fixture = await forumQueueFixture();
  const event = forumThread({ threadId: "removed-guild-thread" });
  await fs.writeFile(fixture.queueFile, `${JSON.stringify({
    version: 1,
    pending: [event],
    publications: [queuedPublication(event, {
      marker: "11223344",
      phase: "waitingAudit",
    })],
  })}\n`);
  const config = forumConfig();
  config.qq.forum.guildAllowFrom = [];
  let dispatches = 0;
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {
      dispatches++;
    },
    {
      config,
      applyAccessPolicy: false,
    },
  );

  try {
    assert.deepEqual((await readForumQueue(fixture.queueFile)).pending, [event]);
    await coordinator.applyCurrentAccessPolicy();
    assert.equal(dispatches, 0);
    assert.deepEqual(await readForumQueue(fixture.queueFile), {
      version: 1,
      pending: [],
      completed: [],
    });
  } finally {
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator retains allowed pending events while globally disabled", async () => {
  const fixture = await forumQueueFixture();
  const event = forumThread({ threadId: "configuration-retained-thread" });
  await fs.writeFile(fixture.queueFile, `${JSON.stringify({
    version: 1,
    pending: [event],
  })}\n`);
  const config = forumConfig();
  config.qq.forum.enabled = false;
  let dispatches = 0;
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {
      dispatches++;
    },
    { config },
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(dispatches, 0);
    assert.deepEqual((await readForumQueue(fixture.queueFile)).pending, [event]);

    config.qq.forum.enabled = true;
    await coordinator.handleThread(event);
    await waitFor(() => dispatches === 1);
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
  } finally {
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator uses an active duplicate as one retry request", async () => {
  const fixture = await forumQueueFixture();
  let attempts = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const coordinator = await forumCoordinator(fixture.queueFile, async () => {
    attempts++;
    if (attempts === 1) {
      await blocked;
      throw new Error("first attempt failed");
    }
  });
  const event = forumThread({ threadId: "duplicate-retry-thread" });

  try {
    await coordinator.handleThread(event);
    await waitFor(() => attempts === 1);
    await coordinator.handleThread(event);
    release();
    await waitFor(() => attempts === 2);
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(attempts, 2);
  } finally {
    release();
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator rolls back pending and completed on persistence failure", async () => {
  const fixture = await forumQueueFixture();
  let writes = 0;
  const persistState = async (file: string, value: unknown): Promise<void> => {
    writes++;
    if (writes === 2) throw new Error("completion persistence failed");
    await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  let dispatches = 0;
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {
      dispatches++;
    },
    { persistState },
  );
  const event = forumThread({ threadId: "persistence-retry-thread" });

  try {
    await coordinator.handleThread(event);
    await waitFor(() => writes === 2);
    assert.deepEqual((await readForumQueue(fixture.queueFile)).pending, [event]);

    await coordinator.handleThread(event);
    await waitFor(() => dispatches === 2);
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
    assert.deepEqual((await readForumQueue(fixture.queueFile)).completed, [
      "persistence-retry-thread",
    ]);
  } finally {
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator processes distinct same-channel threads concurrently", async () => {
  const fixture = await forumQueueFixture();
  let active = 0;
  let maximumActive = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handled: string[] = [];
  const coordinator = await forumCoordinator(fixture.queueFile, async (message) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    handled.push(message.messageId);
    await blocked;
    active--;
  });

  try {
    await Promise.all([
      coordinator.handleThread(forumThread({ threadId: "first" })),
      coordinator.handleThread(forumThread({ threadId: "second" })),
    ]);
    await waitFor(() => active === 2);

    assert.deepEqual(new Set(handled), new Set(["first", "second"]));
    assert.equal(maximumActive, 2);
  } finally {
    release();
    await waitFor(() => active === 0);
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("accepted forum PUT does not complete the source before audit success", async () => {
  const fixture = await forumQueueFixture();
  const config = forumConfig();
  const published: unknown[] = [];
  let releasePut!: () => void;
  const putBlocked = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  const api = forumApi({
    publishForumThread: async (input) => {
      published.push(input);
      await putBlocked;
      return { taskId: "task", createTime: "now" };
    },
  });
  let sender!: QQSender;
  const coordinator = new QQForumCoordinator(
    api,
    () => config,
    async (message) => {
      const reply = sender.createReply(message);
      await reply.write("Answer");
      await reply.finish();
    },
    () => {},
    fixture.queueFile,
  );
  sender = new QQSender(
    api,
    () => config,
    () => {},
    Date.now,
    undefined,
    undefined,
    coordinator,
  );

  try {
    await coordinator.start();
    await coordinator.applyCurrentAccessPolicy();
    coordinator.setBotIdentity({ id: "bot-user", username: "C" });
    await coordinator.handleThread(forumThread({
      threadId: "audit-source",
    }));
    await waitFor(() => published.length === 1);
    const submitting = await readForumQueue(fixture.queueFile);
    assert.equal(submitting.pending.length, 1);
    assert.equal(submitting.publications?.[0]?.phase, "submitting");
    assert.equal(submitting.publications?.[0]?.taskId, undefined);

    releasePut();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Reflect.get(coordinator, "stateOperations");

    const accepted = await readForumQueue(fixture.queueFile);
    assert.equal(accepted.pending.length, 1);
    assert.equal(accepted.publications?.[0]?.phase, "waitingAudit");
    assert.equal(accepted.publications?.[0]?.taskId, "task");
    assert.match(
      (published[0] as { title: string }).title,
      /\[C:[a-f0-9]{8}\]$/,
    );

    await coordinator.handlePublishAudit({
      guildId: allowedGuild,
      channelId: "channel",
      authorId: "bot-user",
      type: 1,
      result: 0,
      threadId: "result-thread",
    });
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
  } finally {
    releasePut();
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("failed forum audit retains the source and retries saved output once", async () => {
  const fixture = await forumQueueFixture();
  const config = forumConfig();
  let acpTurns = 0;
  let puts = 0;
  const api = forumApi({
    publishForumThread: async () => {
      puts++;
      return { taskId: `task-${puts}`, createTime: "now" };
    },
  });
  let sender!: QQSender;
  const coordinator = new QQForumCoordinator(
    api,
    () => config,
    async (message) => {
      acpTurns++;
      const reply = sender.createReply(message);
      await reply.write("Saved answer");
      await reply.finish();
    },
    () => {},
    fixture.queueFile,
  );
  sender = new QQSender(
    api,
    () => config,
    () => {},
    Date.now,
    undefined,
    undefined,
    coordinator,
  );
  const source = forumThread({ threadId: "failed-audit-source" });

  try {
    await coordinator.start();
    await coordinator.applyCurrentAccessPolicy();
    coordinator.setBotIdentity({ id: "bot-user", username: "C" });
    await coordinator.handleThread(source);
    await waitFor(() => puts === 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Reflect.get(coordinator, "stateOperations");
    await coordinator.handlePublishAudit({
      guildId: allowedGuild,
      channelId: "channel",
      authorId: "bot-user",
      type: 1,
      result: 9,
      errorMessage: "private platform detail",
    });
    await waitFor(() =>
      (Reflect.get(coordinator, "activeThreadIds") as Set<string>).size === 0
    );

    const failed = await readForumQueue(fixture.queueFile);
    assert.equal(failed.pending.length, 1);
    assert.equal(failed.publications?.[0]?.phase, "auditFailed");
    assert.equal(
      JSON.stringify(failed).includes("private platform detail"),
      false,
    );

    await coordinator.handleThread(source);
    await waitFor(() => puts === 2);
    assert.equal(acpTurns, 1);
    await coordinator.handlePublishAudit({
      guildId: allowedGuild,
      channelId: "channel",
      authorId: "bot-user",
      type: 1,
      result: 0,
      threadId: "result-thread",
    });
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
    assert.equal(acpTurns, 1);
  } finally {
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("missing forum audit keeps the source active and retries the same marker", async () => {
  const fixture = await forumQueueFixture();
  const config = forumConfig();
  const titles: string[] = [];
  const api = forumApi({
    publishForumThread: async (input) => {
      titles.push(input.title);
      return { taskId: `task-${titles.length}`, createTime: "now" };
    },
    listForumThreads: async () => [],
  });
  let sender!: QQSender;
  const coordinator = new QQForumCoordinator(
    api,
    () => config,
    async (message) => {
      const reply = sender.createReply(message);
      await reply.write("Saved answer");
      await reply.finish();
    },
    () => {},
    fixture.queueFile,
    undefined,
    {
      auditTimeoutMs: 5,
      reconciliationPollMs: 5,
    },
  );
  sender = new QQSender(
    api,
    () => config,
    () => {},
    Date.now,
    undefined,
    undefined,
    coordinator,
  );

  try {
    await coordinator.start();
    await coordinator.applyCurrentAccessPolicy();
    coordinator.setBotIdentity({ id: "bot-user", username: "C" });
    await coordinator.handleThread(forumThread({
      threadId: "audit-timeout-source",
    }));
    await waitFor(() => titles.length >= 2, 500);

    const retained = await readForumQueue(fixture.queueFile);
    assert.equal(retained.pending.length, 1);
    assert.ok(
      ["submitting", "waitingAudit"].includes(
        retained.publications?.[0]?.phase ?? "",
      ),
    );
    assert.ok((retained.publications?.[0]?.attempt ?? 0) >= 2);
    assert.ok(retained.publications?.[0]?.submittedAtMs);
    assert.equal(new Set(titles).size, 1);
    assert.equal(
      (Reflect.get(coordinator, "activeThreadIds") as Set<string>).size,
      1,
    );
  } finally {
    coordinator.stop();
    await waitFor(() =>
      (Reflect.get(coordinator, "activeThreadIds") as Set<string>).size === 0
    );
    await Reflect.get(coordinator, "stateOperations");
    await fixture.cleanup();
  }
});

test("late audit completes only the fenced source before the next publication", async () => {
  const fixture = await forumQueueFixture();
  const published: Array<{ channelId: string; title: string }> = [];
  const listed: Array<{ threadId: string; title: string; content: string }> = [];
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {},
    {
      api: forumApi({
        publishForumThread: async (input) => {
          published.push({
            channelId: input.channelId,
            title: input.title,
          });
          return {
            taskId: `task-${published.length}`,
            createTime: "now",
          };
        },
        listForumThreads: async () => listed,
      }),
      timing: {
        auditTimeoutMs: 15,
        reconciliationPollMs: 1_000,
      },
    },
  );
  const first = coordinator.publishForumResult(
    forumInboundMessage({ threadId: "source-a" }),
    "Answer A",
  );
  const second = coordinator.publishForumResult(
    forumInboundMessage({ threadId: "source-b" }),
    "Answer B",
  );

  try {
    await waitFor(() => published.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(published.length, 1);

    listed.push({
      threadId: "result-a",
      title: published[0]!.title,
      content: "Answer A",
    });
    await coordinator.handlePublishAudit(forumAudit({
      threadId: "result-a",
    }));
    await first;
    await waitFor(() => published.length === 2);

    await coordinator.handlePublishAudit(forumAudit({
      threadId: "result-a",
    }));
    const secondSettled = await Promise.race([
      second.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 25)
      ),
    ]);
    assert.equal(secondSettled, false);

    listed.push({
      threadId: "result-b",
      title: published[1]!.title,
      content: "Answer B",
    });
    await coordinator.handlePublishAudit(forumAudit({
      threadId: "result-b",
    }));
    await second;
  } finally {
    coordinator.stop();
    await Promise.allSettled([first, second]);
    await fixture.cleanup();
  }
});

test("multi-attempt publication quarantines delayed audits before the next source", async () => {
  const fixture = await forumQueueFixture();
  const published: Array<{ channelId: string; title: string; content: string }> = [];
  let now = 0;
  let pauseCalls = 0;
  let quarantineStarted!: () => void;
  const quarantineStartedPromise = new Promise<void>((resolve) => {
    quarantineStarted = resolve;
  });
  let releaseQuarantine!: () => void;
  const quarantineBlocked = new Promise<void>((resolve) => {
    releaseQuarantine = resolve;
  });
  let revealPublishedThreads = false;
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {},
    {
      api: forumApi({
        publishForumThread: async (input) => {
          published.push(input);
          return {
            taskId: `task-${published.length}`,
            createTime: "now",
          };
        },
        listForumThreads: async () =>
          revealPublishedThreads
            ? published.map((thread, index) => ({
                threadId: index < 2 ? "result-a" : "result-b",
                title: thread.title,
                content: thread.content,
              }))
            : [],
      }),
      timing: {
        now: () => now,
        auditTimeoutMs: 100,
        reconciliationPollMs: 10,
        pause: async (milliseconds) => {
          pauseCalls++;
          if (pauseCalls <= 2) {
            now += milliseconds;
            return;
          }
          if (pauseCalls === 4) {
            quarantineStarted();
            await quarantineBlocked;
          } else {
            await new Promise<void>(() => {});
          }
        },
      },
    },
  );
  const first = coordinator.publishForumResult(
    forumInboundMessage({ threadId: "source-a" }),
    "Answer A",
  );
  const second = coordinator.publishForumResult(
    forumInboundMessage({ threadId: "source-b" }),
    "Answer B",
  );

  try {
    await waitFor(() => published.length === 2);
    assert.equal(published[0]!.title, published[1]!.title);

    revealPublishedThreads = true;
    await coordinator.handlePublishAudit(forumAudit({
      threadId: "result-a",
    }));
    await first;
    await quarantineStartedPromise;

    await coordinator.handlePublishAudit(forumAudit({
      result: 9,
      threadId: "delayed-result-a",
    }));
    const quarantined = await readForumQueue(fixture.queueFile);
    const queuedSecond = quarantined.publications?.find((publication) =>
      publication.sourceThreadId === "source-b"
    );
    assert.equal(queuedSecond?.phase, "submitting");
    assert.equal(queuedSecond?.attempt, 0);
    assert.equal(published.length, 2);
    assert.equal(quarantined.auditQuarantines?.[0]?.sourceThreadId, "source-a");

    now = 210;
    releaseQuarantine();
    await waitFor(() => published.length === 3);
    assert.notEqual(published[2]!.title, published[1]!.title);

    await coordinator.handlePublishAudit(forumAudit({
      threadId: "result-b",
    }));
    await second;
  } finally {
    releaseQuarantine();
    coordinator.stop();
    await Promise.allSettled([first, second]);
    await fixture.cleanup();
  }
});

test("definitive QQ PUT rejection does not retry and releases the channel", async () => {
  const fixture = await forumQueueFixture();
  const accepted: Array<{ channelId: string; title: string; content: string }> = [];
  const putSources: string[] = [];
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {},
    {
      api: forumApi({
        publishForumThread: async (input) => {
          putSources.push(input.content);
          if (input.content === "Answer A") {
            throw new QQApiError(
              "publish forum thread",
              400,
              400123,
              "private-trace",
            );
          }
          accepted.push(input);
          return { taskId: "task-b", createTime: "now" };
        },
        listForumThreads: async () =>
          accepted.map((thread) => ({
            threadId: "result-b",
            title: thread.title,
            content: thread.content,
          })),
      }),
    },
  );
  const first = coordinator.publishForumResult(
    forumInboundMessage({ threadId: "rejected-a" }),
    "Answer A",
  );
  void first.catch(() => {});
  const second = coordinator.publishForumResult(
    forumInboundMessage({ threadId: "accepted-b" }),
    "Answer B",
  );

  try {
    await assert.rejects(first, /rejected|failed/i);
    await waitFor(() => putSources.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(putSources, ["Answer A", "Answer B"]);

    const retained = await readForumQueue(fixture.queueFile);
    const rejected = retained.publications?.find((publication) =>
      publication.sourceThreadId === "rejected-a"
    );
    assert.equal(rejected?.phase, "auditFailed");
    assert.deepEqual(rejected?.error, {
      kind: "submissionRejected",
      status: 400,
      code: 400123,
    });
    assert.equal(JSON.stringify(retained).includes("private-trace"), false);

    await coordinator.handlePublishAudit(forumAudit({
      threadId: "result-b",
    }));
    await second;
  } finally {
    coordinator.stop();
    await Promise.allSettled([first, second]);
    await fixture.cleanup();
  }
});

test("restart restores audit quarantine before resuming the next source", async () => {
  const fixture = await forumQueueFixture();
  const source = forumThread({ threadId: "restart-source-b" });
  await fs.writeFile(fixture.queueFile, `${JSON.stringify({
    version: 1,
    pending: [source],
    publications: [queuedPublication(source, {
      marker: "12345678",
      phase: "submitting",
      attempt: 0,
      submittedAtMs: undefined,
    })],
    auditQuarantines: [{
      sourceThreadId: "restart-source-a",
      guildId: allowedGuild,
      channelId: "channel",
      untilMs: 110,
    }],
  })}\n`);
  let now = 10;
  let puts = 0;
  let markQuarantineWait!: () => void;
  const quarantineWait = new Promise<void>((resolve) => {
    markQuarantineWait = resolve;
  });
  let releaseQuarantine!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseQuarantine = resolve;
  });
  let publishedTitle = "";
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {},
    {
      identity: false,
      api: forumApi({
        publishForumThread: async (input) => {
          puts++;
          publishedTitle = input.title;
          return { taskId: "task-b", createTime: "now" };
        },
        listForumThreads: async () =>
          publishedTitle
            ? [{
                threadId: "result-b",
                title: publishedTitle,
                content: "Saved answer",
              }]
            : [],
      }),
      timing: {
        now: () => now,
        auditTimeoutMs: 100,
        pause: async () => {
          markQuarantineWait();
          await blocked;
        },
      },
    },
  );

  try {
    coordinator.setBotIdentity({ id: "bot-user", username: "C" });
    await quarantineWait;
    assert.equal(puts, 0);

    await coordinator.handlePublishAudit(forumAudit({ result: 9 }));
    assert.equal(puts, 0);
    assert.equal(
      (await readForumQueue(fixture.queueFile)).publications?.[0]?.phase,
      "submitting",
    );

    now = 110;
    releaseQuarantine();
    await waitFor(() => puts === 1);
    await coordinator.handlePublishAudit(forumAudit({
      threadId: "result-b",
    }));
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
  } finally {
    releaseQuarantine();
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("forum publication serializes per channel while allowing other channels", async () => {
  const fixture = await forumQueueFixture();
  const calls: string[] = [];
  const api = forumApi({
    publishForumThread: async (input) => {
      calls.push(input.channelId);
      return {
        taskId: `task-${calls.length}`,
        createTime: "now",
      };
    },
  });
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {},
    { api },
  );
  const first = coordinator.publishForumResult(
    forumInboundMessage({ threadId: "first", channelId: "same" }),
    "First",
  );
  const second = coordinator.publishForumResult(
    forumInboundMessage({ threadId: "second", channelId: "same" }),
    "Second",
  );
  const other = coordinator.publishForumResult(
    forumInboundMessage({ threadId: "other", channelId: "other" }),
    "Other",
  );

  try {
    await waitFor(() => calls.length === 2);
    assert.deepEqual(new Set(calls), new Set(["same", "other"]));

    await coordinator.handlePublishAudit(forumAudit({
      channelId: "same",
      result: 0,
    }));
    await first;
    await waitFor(() => calls.length === 3);
    assert.deepEqual(calls, ["same", "other", "same"]);

    await coordinator.handlePublishAudit(forumAudit({
      channelId: "other",
      result: 0,
    }));
    await other;
    await coordinator.handlePublishAudit(forumAudit({
      channelId: "same",
      result: 0,
    }));
    await second;
  } finally {
    coordinator.stop();
    await Promise.allSettled([first, second, other]);
    await fixture.cleanup();
  }
});

test("orphan forum publication audits are ignored", async () => {
  const fixture = await forumQueueFixture();
  const logs: string[] = [];
  const config = forumConfig();
  const coordinator = new QQForumCoordinator(
    forumApi(),
    () => config,
    async () => {},
    (message) => logs.push(message),
    fixture.queueFile,
  );

  try {
    await coordinator.start();
    await coordinator.applyCurrentAccessPolicy();
    coordinator.setBotIdentity({ id: "bot-user", username: "C" });
    await coordinator.handlePublishAudit(forumAudit({ result: 0 }));

    assert.equal(await fileExists(fixture.queueFile), false);
    assert.equal(logs.some((message) =>
      message.includes("no active publication")
    ), true);
  } finally {
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("successful audit list failure retains publication for Gateway replay", async () => {
  const fixture = await forumQueueFixture();
  let puts = 0;
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {},
    {
      api: forumApi({
        publishForumThread: async () => {
          puts++;
          return { taskId: "task", createTime: "now" };
        },
        listForumThreads: async () => {
          throw new Error("list unavailable");
        },
      }),
    },
  );
  const publication = coordinator.publishForumResult(
    forumInboundMessage({ threadId: "audit-list-failure" }),
    "Answer",
  );

  try {
    await waitFor(() => puts === 1);
    await assert.rejects(
      coordinator.handlePublishAudit(forumAudit()),
      /list unavailable/,
    );
    const retained = await readForumQueue(fixture.queueFile);
    assert.ok(
      ["submitting", "waitingAudit"].includes(
        retained.publications?.[0]?.phase ?? "",
      ),
    );
    const settled = await Promise.race([
      publication.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 25)
      ),
    ]);
    assert.equal(settled, false);
  } finally {
    coordinator.stop();
    await Promise.allSettled([publication]);
    await fixture.cleanup();
  }
});

test("restart reconciliation completes a source when its marker is found", async () => {
  const fixture = await forumQueueFixture();
  const source = forumThread({ threadId: "marker-found-source" });
  const publication = queuedPublication(source, {
    marker: "1234abcd",
    phase: "waitingAudit",
  });
  await fs.writeFile(fixture.queueFile, `${JSON.stringify({
    version: 1,
    pending: [source],
    publications: [publication],
  })}\n`);
  let puts = 0;
  let lists = 0;
  let acpTurns = 0;
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {
      acpTurns++;
    },
    {
      identity: false,
      api: forumApi({
        publishForumThread: async () => {
          puts++;
          return { taskId: "duplicate", createTime: "now" };
        },
        listForumThreads: async () => {
          lists++;
          return [{
            threadId: "published-result",
            title: publication.title,
            content: publication.content,
          }];
        },
      }),
      timing: {
        reconciliationPollMs: 5,
      },
    },
  );

  try {
    coordinator.setBotIdentity({ id: "bot-user", username: "C" });
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
    assert.equal(lists, 1);
    assert.equal(puts, 0);
    assert.equal(acpTurns, 0);
  } finally {
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("restart completes audit-confirmed sources without rerunning ACP", async () => {
  const fixture = await forumQueueFixture();
  const source = forumThread({ threadId: "audit-confirmed-source" });
  await fs.writeFile(fixture.queueFile, `${JSON.stringify({
    version: 1,
    pending: [source],
    publications: [queuedPublication(source, {
      marker: "fedcba98",
      phase: "auditSucceeded",
    })],
  })}\n`);
  let acpTurns = 0;
  let puts = 0;
  let lists = 0;
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {
      acpTurns++;
    },
    {
      identity: false,
      api: forumApi({
        publishForumThread: async () => {
          puts++;
          return { taskId: "duplicate", createTime: "now" };
        },
        listForumThreads: async () => {
          lists++;
          return [];
        },
      }),
    },
  );

  try {
    coordinator.setBotIdentity({ id: "bot-user", username: "C" });
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
    assert.equal(acpTurns, 0);
    assert.equal(puts, 0);
    assert.equal(lists, 0);
  } finally {
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("restart reconciliation republishes saved output when marker stays absent", async () => {
  const fixture = await forumQueueFixture();
  const source = forumThread({ threadId: "marker-absent-source" });
  const publication = queuedPublication(source, {
    marker: "89abcdef",
    phase: "waitingAudit",
  });
  await fs.writeFile(fixture.queueFile, `${JSON.stringify({
    version: 1,
    pending: [source],
    publications: [publication],
  })}\n`);
  let now = 0;
  let puts = 0;
  let acpTurns = 0;
  let publishedTitle = "";
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {
      acpTurns++;
    },
    {
      identity: false,
      api: forumApi({
        publishForumThread: async (input) => {
          puts++;
          publishedTitle = input.title;
          assert.equal(input.title, publication.title);
          assert.equal(input.content, publication.content);
          return { taskId: "retry-task", createTime: "now" };
        },
        listForumThreads: async () =>
          publishedTitle
            ? [{
                threadId: "result-thread",
                title: publishedTitle,
                content: publication.content,
              }]
            : [],
      }),
      timing: {
        now: () => now,
        pause: async (milliseconds) => {
          now += milliseconds;
        },
        reconciliationPollMs: 5,
        auditTimeoutMs: 10,
      },
    },
  );

  try {
    coordinator.setBotIdentity({ id: "bot-user", username: "C" });
    await waitFor(() => puts === 1);
    assert.equal(acpTurns, 0);
    await coordinator.handlePublishAudit(forumAudit({
      guildId: allowedGuild,
      result: 0,
    }));
    await waitForQueueLength(coordinator, fixture.queueFile, 0);
    assert.equal(acpTurns, 0);
  } finally {
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("restart waits the remaining audit window before reconciling and retrying", async () => {
  const fixture = await forumQueueFixture();
  const source = forumThread({ threadId: "recent-submission-source" });
  const publication = queuedPublication(source, {
    marker: "7654abcd",
    phase: "waitingAudit",
    attempt: 1,
    submittedAtMs: 940,
  });
  await fs.writeFile(fixture.queueFile, `${JSON.stringify({
    version: 1,
    pending: [source],
    publications: [publication],
  })}\n`);
  let now = 1_000;
  let lists = 0;
  let puts = 0;
  const pauses: number[] = [];
  let releaseRemainingWindow!: () => void;
  const remainingWindow = new Promise<void>((resolve) => {
    releaseRemainingWindow = resolve;
  });
  const coordinator = await forumCoordinator(
    fixture.queueFile,
    async () => {},
    {
      identity: false,
      api: forumApi({
        publishForumThread: async () => {
          puts++;
          return { taskId: "retry-task", createTime: "now" };
        },
        listForumThreads: async () => {
          lists++;
          return [];
        },
      }),
      timing: {
        now: () => now,
        pause: async (milliseconds) => {
          pauses.push(milliseconds);
          if (pauses.length === 1) {
            await remainingWindow;
            now += milliseconds;
            return;
          }
          if (pauses.length === 2) {
            now += milliseconds;
            return;
          }
          await new Promise<void>(() => {});
        },
        auditTimeoutMs: 100,
        reconciliationPollMs: 5,
      },
    },
  );

  try {
    coordinator.setBotIdentity({ id: "bot-user", username: "C" });
    await waitFor(() => pauses.length === 1);
    assert.deepEqual(pauses, [40]);
    assert.equal(lists, 0);
    assert.equal(puts, 0);

    releaseRemainingWindow();
    await waitFor(() => puts === 1);
    assert.equal(lists, 1);
  } finally {
    releaseRemainingWindow();
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator retains an active task that rejects after stop", async () => {
  const fixture = await forumQueueFixture();
  let reject!: (error: Error) => void;
  let started = false;
  const blocked = new Promise<void>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  const coordinator = await forumCoordinator(fixture.queueFile, async () => {
    started = true;
    await blocked;
  });
  const event = forumThread({ threadId: "stopped-active-thread" });

  await coordinator.handleThread(event);
  await waitFor(() => started);
  coordinator.stop();
  reject(new Error("stopped active task"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  try {
    assert.deepEqual(await readForumQueue(fixture.queueFile), {
      version: 1,
      pending: [event],
      completed: [],
    });
  } finally {
    await fixture.cleanup();
  }
});

test("forum coordinator removes terminal ignored events from the queue", async () => {
  const fixture = await forumQueueFixture();
  let dispatches = 0;
  const coordinator = await forumCoordinator(fixture.queueFile, async () => {
    dispatches++;
  });

  try {
    await coordinator.handleThread(forumThread({
      threadId: "not-addressed",
      content: "Please help",
    }));
    await coordinator.handleThread(forumThread({
      threadId: "bot-authored",
      authorId: "bot-user",
    }));
    await waitForQueueLength(coordinator, fixture.queueFile, 0);

    assert.equal(dispatches, 0);
  } finally {
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator rejects malformed events before persistence", async () => {
  const fixture = await forumQueueFixture();
  const coordinator = await forumCoordinator(fixture.queueFile, async () => {
    assert.fail("invalid forum event was dispatched");
  });

  try {
    await coordinator.handleThread(forumThread({ authorId: undefined }));
    await coordinator.handleThread(forumThread({ threadId: "" }));
    assert.equal(await fileExists(fixture.queueFile), false);
  } finally {
    coordinator.stop();
    await fixture.cleanup();
  }
});

test("forum coordinator stop prevents launching recovered tasks", async () => {
  const fixture = await forumQueueFixture();
  const event = forumThread({ threadId: "stopped-thread" });
  const first = await forumCoordinator(
    fixture.queueFile,
    async () => assert.fail("pending task launched without identity"),
    { identity: false },
  );
  await first.handleThread(event);
  first.stop();

  let dispatches = 0;
  const recovered = await forumCoordinator(
    fixture.queueFile,
    async () => {
      dispatches++;
    },
    { identity: false },
  );
  recovered.stop();
  recovered.setBotIdentity({ id: "bot-user", username: "C" });
  await new Promise((resolve) => setTimeout(resolve, 25));

  try {
    assert.equal(dispatches, 0);
    assert.deepEqual(await readForumQueue(fixture.queueFile), {
      version: 1,
      pending: [event],
      completed: [],
    });
  } finally {
    await fixture.cleanup();
  }
});

test("QQ API publishes a forum thread with the official PUT contract", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    url: string;
    method: string;
    body?: Record<string, unknown>;
  }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/getAppAccessToken")) {
      return new Response(JSON.stringify({
        access_token: "token",
        expires_in: 7200,
      }), { status: 200 });
    }
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body
        ? JSON.parse(String(init.body)) as Record<string, unknown>
        : undefined,
    });
    return new Response(JSON.stringify({
      task_id: "task",
      create_time: "now",
    }), { status: 200 });
  };

  try {
    const api = new QQApi("app", "secret");
    assert.deepEqual(
      await api.publishForumThread({
        channelId: "channel",
        title: "C: Title",
        content: "Answer",
        format: 3,
      }),
      { taskId: "task", createTime: "now" },
    );
    assert.deepEqual(requests, [{
      url: "https://api.sgroup.qq.com/channels/channel/threads",
      method: "PUT",
      body: {
        title: "C: Title",
        content: "Answer",
        format: 3,
      },
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("QQ API lists private forum threads for marker reconciliation", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/getAppAccessToken")) {
      return new Response(JSON.stringify({
        access_token: "token",
        expires_in: 7200,
      }), { status: 200 });
    }
    requests.push({
      url,
      method: init?.method ?? "GET",
    });
    return new Response(JSON.stringify({
      threads: [{
        guild_id: "guild",
        channel_id: "channel",
        author_id: "bot-user",
        thread_info: {
          thread_id: "result-thread",
          title: "C: Chemistry [C:1234abcd]",
          content: "Answer",
          date_time: "2026-09-04T00:01:00Z",
        },
      }],
      is_finish: 1,
    }), { status: 200 });
  };

  try {
    const api = new QQApi("app", "secret");
    assert.deepEqual(await api.listForumThreads("channel"), [{
      threadId: "result-thread",
      title: "C: Chemistry [C:1234abcd]",
      content: "Answer",
    }]);
    assert.deepEqual(requests, [{
      url: "https://api.sgroup.qq.com/channels/channel/threads",
      method: "GET",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forum replies publish exactly one Markdown result thread", async () => {
  const published: unknown[] = [];
  const sender = new QQSender(
    forumMessageApi(async (input) => {
      published.push(input);
      return { taskId: "task", createTime: "now" };
    }),
    () => forumConfig(),
  );
  const reply = sender.createReply(forumInboundMessage());

  assert.equal(await reply.sendProgress("Task accepted"), false);
  await reply.write("First ");
  await reply.flush();
  await reply.write("answer.");
  await reply.finish();
  await reply.finish();

  assert.deepEqual(published, [{
    channelId: "channel",
    title: "C: Chemistry",
    content: "First answer.",
    format: 3,
  }]);
  assert.equal(
    Array.from(forumResultTitle("Very long bot name", "x".repeat(100))).length,
    80,
  );
  const markedTitle = forumResultTitle(
    "Very long bot name",
    "x".repeat(100),
    "1234abcd",
  );
  assert.equal(Array.from(markedTitle).length, 80);
  assert.match(markedTitle, /\[C:1234abcd\]$/);
});

test("forum replies reject explicit artifact publication", async () => {
  const sender = new QQSender(
    forumMessageApi(async () => ({ taskId: "task", createTime: "now" })),
    () => forumConfig(),
  );
  const reply = sender.createReply(forumInboundMessage());
  const artifact: PreparedArtifact = {
    kind: "file",
    fileName: "result.txt",
    mimeType: "application/octet-stream",
    data: Buffer.from("result"),
    digest: "digest",
  };

  await assert.rejects(
    reply.sendArtifact(artifact),
    /forum artifact publication is not supported/i,
  );
});

const allowedGuild = "2193686490806678807";

async function forumCoordinator(
  queueFile: string,
  onMessage: ConstructorParameters<typeof QQForumCoordinator>[2],
  options: {
    identity?: boolean;
    config?: ReturnType<typeof forumConfig>;
    persistState?: (file: string, value: unknown) => Promise<void>;
    api?: QQForumApi;
    timing?: ConstructorParameters<typeof QQForumCoordinator>[6];
    applyAccessPolicy?: boolean;
  } = {},
): Promise<QQForumCoordinator> {
  const api = options.api ?? forumApi();
  const config = options.config ?? forumConfig();
  const coordinator = new QQForumCoordinator(
    api,
    () => config,
    onMessage,
    () => {},
    queueFile,
    options.persistState,
    options.timing,
  );
  await coordinator.start();
  if (options.applyAccessPolicy !== false) {
    await coordinator.applyCurrentAccessPolicy();
  }
  if (options.identity !== false) {
    coordinator.setBotIdentity({ id: "bot-user", username: "C" });
  }
  return coordinator;
}

async function forumQueueFixture(): Promise<{
  queueFile: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qq-bot-acp-forum-"));
  return {
    queueFile: path.join(root, "forum-queue.json"),
    cleanup: () => fs.rm(root, {
      recursive: true,
      force: true,
    }),
  };
}

async function readForumQueue(queueFile: string): Promise<{
  version: 1;
  pending: QQForumThreadCreateEvent[];
  completed?: string[];
  publications?: Array<{
    sourceThreadId: string;
    phase: string;
    taskId?: string;
    submittedAtMs?: number;
    attempt?: number;
    error?: {
      kind?: string;
      result?: number;
      status?: number;
      code?: string | number;
      detailHash?: string;
    };
  }>;
  auditQuarantines?: Array<{
    sourceThreadId: string;
    channelId: string;
    untilMs: number;
  }>;
}> {
  return JSON.parse(await fs.readFile(queueFile, "utf8")) as {
    version: 1;
    pending: QQForumThreadCreateEvent[];
    completed?: string[];
    publications?: Array<{
      sourceThreadId: string;
      phase: string;
      taskId?: string;
      submittedAtMs?: number;
      attempt?: number;
      error?: {
        kind?: string;
        result?: number;
        status?: number;
        code?: string | number;
        detailHash?: string;
      };
    }>;
    auditQuarantines?: Array<{
      sourceThreadId: string;
      channelId: string;
      untilMs: number;
    }>;
  };
}

async function waitForQueueLength(
  coordinator: QQForumCoordinator,
  queueFile: string,
  length: number,
): Promise<void> {
  await waitFor(() =>
    (Reflect.get(coordinator, "activeThreadIds") as Set<string>).size === 0
  );
  await Reflect.get(coordinator, "stateOperations");
  assert.equal((await readForumQueue(queueFile)).pending.length, length);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      assert.fail(`Condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function forumThread(
  overrides: {
    threadId?: string;
    guildId?: string;
    channelId?: string;
    authorId?: string;
    title?: unknown;
    content?: unknown;
    dateTime?: string;
  } = {},
): QQForumThreadCreateEvent {
  return {
    guildId: overrides.guildId ?? allowedGuild,
    channelId: overrides.channelId ?? "channel",
    authorId: "authorId" in overrides ? overrides.authorId : "author",
    threadInfo: {
      threadId: overrides.threadId ?? "thread",
      title: overrides.title ?? "Chemistry",
      content: overrides.content ?? "@C help",
      dateTime: overrides.dateTime ?? "2026-09-04T00:00:00Z",
    },
  };
}

function forumConfig() {
  const config = createInitialConfig({
    appId: "app",
    clientSecretFile: path.resolve("secret"),
    agentCommand: "agent",
  });
  config.qq.forum.enabled = true;
  config.qq.forum.guildAllowFrom = [allowedGuild];
  return config;
}

function forumInboundMessage(
  overrides: {
    threadId?: string;
    guildId?: string;
    channelId?: string;
  } = {},
): QQForumInboundMessage {
  const guildId = overrides.guildId ?? allowedGuild;
  const channelId = overrides.channelId ?? "channel";
  const threadId = overrides.threadId ?? "thread";
  return {
    accountId: "app",
    conversationId: `qqbot:app:forum:${guildId}:${channelId}:${threadId}`,
    chatType: "forum",
    senderId: "author",
    targetId: channelId,
    messageId: threadId,
    timestamp: "2026-09-04T00:00:00Z",
    text: "prompt",
    attachments: [],
    addressed: true,
    forum: {
      guildId,
      channelId,
      threadId,
      sourceTitle: "Chemistry",
      botUsername: "C",
    },
  };
}

function forumMessageApi(
  publishForumThread: QQMessageApi["publishForumThread"],
): QQMessageApi {
  return {
    sendText: async () => "message",
    sendStream: async () => ({ id: "stream" }),
    uploadMedia: async () => "file",
    sendMedia: async () => "message",
    publishForumThread,
  };
}

function forumApi(
  overrides: Partial<QQForumApi & QQMessageApi> = {},
): QQForumApi & QQMessageApi {
  const published: Array<{
    channelId: string;
    title: string;
    content: string;
  }> = [];
  const publishForumThread = async (
    input: Parameters<QQForumApi["publishForumThread"]>[0],
  ) => {
    published.push(input);
    return overrides.publishForumThread
      ? overrides.publishForumThread(input)
      : { taskId: "task", createTime: "now" };
  };
  return {
    appId: "app",
    sendText: async () => "message",
    sendStream: async () => ({ id: "stream" }),
    uploadMedia: async () => "file",
    sendMedia: async () => "message",
    publishForumThread,
    listForumThreads: overrides.listForumThreads ?? (async (channelId) =>
      published
        .filter((thread) => thread.channelId === channelId)
        .map((thread) => ({
          threadId: "result-thread",
          title: thread.title,
          content: thread.content,
        }))),
    ...overrides,
    publishForumThread,
  };
}

function forumAudit(
  overrides: {
    guildId?: string;
    channelId?: string;
    result?: number;
    threadId?: string;
  } = {},
) {
  return {
    guildId: overrides.guildId ?? allowedGuild,
    channelId: overrides.channelId ?? "channel",
    authorId: "bot-user",
    type: 1,
    result: overrides.result ?? 0,
    threadId: overrides.threadId ?? "result-thread",
  };
}

function queuedPublication(
  source: QQForumThreadCreateEvent,
  overrides: {
    marker: string;
    phase: "submitting" | "waitingAudit" | "auditSucceeded" | "auditFailed";
    attempt?: number;
    submittedAtMs?: number;
  },
) {
  return {
    sourceThreadId: source.threadInfo.threadId,
    guildId: source.guildId,
    channelId: source.channelId,
    marker: overrides.marker,
    phase: overrides.phase,
    attempt: overrides.attempt,
    submittedAtMs: overrides.submittedAtMs,
    taskId: "original-task",
    title: `C: Chemistry [C:${overrides.marker}]`,
    content: "Saved answer",
  };
}
