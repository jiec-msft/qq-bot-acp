import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { QQApi } from "../src/qq/api.js";
import {
  gatewayIntents,
  normalizeForumPublishAuditResult,
  normalizeForumThreadCreate,
  normalizeInbound,
  QQGateway,
} from "../src/qq/gateway.js";

test("forum Gateway intent adds only the private forum event", () => {
  const base = gatewayIntents(false);
  const forum = gatewayIntents(true);

  assert.equal(base & (1 << 18), 0);
  assert.equal(forum & (1 << 18), 0);
  assert.notEqual(forum & (1 << 28), 0);
  assert.equal(forum, base | (1 << 28));
});

test("a resumed QQ gateway session becomes ready", async () => {
  const fixture = await gatewayStateFixture();
  const gateway = new QQGateway(
    new QQApi("app", "secret"),
    fixture.stateFile,
    async () => {},
    () => {},
  );
  const handlePayload = Reflect.get(gateway, "handlePayload") as (
    raw: string,
  ) => Promise<void>;
  await Reflect.apply(handlePayload, gateway, [
    JSON.stringify({ op: 0, t: "RESUMED", d: {}, s: 42 }),
  ]);
  const ready = await Promise.race([
    gateway.ready.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
  assert.equal(ready, true);
  await fixture.cleanup();
});

test("Gateway compares sequences only within the same READY session", async () => {
  const fixture = await gatewayStateFixture();
  const gateway = new QQGateway(
    new QQApi("app", "secret"),
    fixture.stateFile,
    async () => {},
    () => {},
  );
  Reflect.set(gateway, "state", {
    version: 1,
    appId: "app",
    intents: gatewayIntents(false),
    sessionId: "old-session",
    sequence: 10,
  });
  const handlePayload = Reflect.get(gateway, "handlePayload") as (
    raw: string,
  ) => Promise<void>;

  try {
    await Reflect.apply(handlePayload, gateway, [
      JSON.stringify({
        op: 0,
        t: "READY",
        s: 2,
        d: {
          session_id: "new-session",
          user: { id: "bot-user", username: "C" },
        },
      }),
    ]);
    assert.equal(await readSequence(fixture.stateFile), 2);

    await Reflect.apply(handlePayload, gateway, [
      JSON.stringify({ op: 0, t: "RESUMED", d: {}, s: 1 }),
    ]);
    assert.equal(await readSequence(fixture.stateFile), 2);
  } finally {
    await fixture.cleanup();
  }
});

test("full-mode group events mark only bot mentions as addressed", () => {
  const event = {
    id: "message",
    author: {
      member_openid: "member",
      bot: false,
    },
    group_openid: "group",
    content: "make a presentation",
    timestamp: "2026-08-31T12:24:00+08:00",
    mentions: [{ id: "bot", bot: true }],
  };

  assert.equal(
    normalizeInbound("GROUP_MESSAGE_CREATE", event, "app")?.text,
    "make a presentation",
  );
  assert.equal(
    normalizeInbound(
      "GROUP_MESSAGE_CREATE",
      { ...event, mentions: [] },
      "app",
    )?.addressed,
    false,
  );
  assert.equal(
    normalizeInbound(
      "GROUP_MESSAGE_CREATE",
      { ...event, author: { member_openid: "bot", bot: true } },
      "app",
    ),
    null,
  );
});

test("Gateway normalizes and dispatches full private forum events", async () => {
  const fixture = await gatewayStateFixture();
  const forumEvents: unknown[] = [];
  const identities: unknown[] = [];
  const gateway = new QQGateway(
    new QQApi("app", "secret"),
    fixture.stateFile,
    async () => {},
    () => {},
    {
      forumEnabled: true,
      onForumThreadCreate: async (event) => {
        forumEvents.push(event);
      },
      onBotIdentity: (identity) => {
        identities.push(identity);
      },
    },
  );
  const handlePayload = Reflect.get(gateway, "handlePayload") as (
    raw: string,
  ) => Promise<void>;

  await Reflect.apply(handlePayload, gateway, [
    JSON.stringify({
      op: 0,
      t: "READY",
      d: {
        session_id: "session",
        user: { id: "bot-user", username: "C" },
      },
    }),
  ]);
  await Reflect.apply(handlePayload, gateway, [
    JSON.stringify({
      op: 0,
      t: "FORUM_THREAD_CREATE",
      d: {
        guild_id: "guild",
        channel_id: "channel",
        author_id: "author",
        thread_info: {
          thread_id: "thread",
          title: "{\"paragraphs\":[{\"elems\":[{\"text_info\":{\"text\":\"Title\"}}]}]}",
          content: [{
            at_info: { user_id: "bot-user" },
          }, {
            text_info: { text: " help" },
          }],
          date_time: "2026-09-04T00:00:00Z",
        },
      },
    }),
  ]);

  assert.deepEqual(identities, [{ id: "bot-user", username: "C" }]);
  assert.deepEqual(forumEvents, [{
    guildId: "guild",
    channelId: "channel",
    authorId: "author",
    threadInfo: {
      threadId: "thread",
      title: "{\"paragraphs\":[{\"elems\":[{\"text_info\":{\"text\":\"Title\"}}]}]}",
      content: [{
        at_info: { user_id: "bot-user" },
      }, {
        text_info: { text: " help" },
      }],
      dateTime: "2026-09-04T00:00:00Z",
    },
  }]);
  await fixture.cleanup();
});

test("Gateway saves forum sequence only after durable acceptance", async () => {
  const fixture = await gatewayStateFixture();
  let accepting = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gateway = new QQGateway(
    new QQApi("app", "secret"),
    fixture.stateFile,
    async () => {},
    () => {},
    {
      forumEnabled: true,
      onForumThreadCreate: async () => {
        accepting = true;
        await blocked;
      },
    },
  );
  const handlePayload = Reflect.get(gateway, "handlePayload") as (
    raw: string,
  ) => Promise<void>;

  const handling = Reflect.apply(handlePayload, gateway, [
    JSON.stringify({
      op: 0,
      t: "FORUM_THREAD_CREATE",
      s: 77,
      d: {
        guild_id: "guild",
        channel_id: "channel",
        author_id: "author",
        thread_info: {
          thread_id: "thread",
          title: "Title",
          content: "@C help",
          date_time: "2026-09-04T00:00:00Z",
        },
      },
    }),
  ]);

  try {
    await waitFor(() => accepting);
    assert.equal(await fileExists(fixture.stateFile), false);
    release();
    await handling;
    const state = JSON.parse(await fs.readFile(fixture.stateFile, "utf8")) as {
      sequence?: number;
    };
    assert.equal(state.sequence, 77);
  } finally {
    release();
    await fixture.cleanup();
  }
});

test("Gateway normalizes forum publication audit results", () => {
  assert.deepEqual(normalizeForumPublishAuditResult({
    guild_id: "guild",
    channel_id: "channel",
    author_id: "bot-user",
    type: 1,
    result: 0,
    err_msg: "",
    thread_id: "thread",
    post_id: "post",
    reply_id: "reply",
  }), {
    guildId: "guild",
    channelId: "channel",
    authorId: "bot-user",
    type: 1,
    result: 0,
    errorMessage: "",
    threadId: "thread",
    postId: "post",
    replyId: "reply",
  });
});

test("Gateway saves audit sequence only after durable publication update", async () => {
  const fixture = await gatewayStateFixture();
  let accepting = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gateway = new QQGateway(
    new QQApi("app", "secret"),
    fixture.stateFile,
    async () => {},
    () => {},
    {
      forumEnabled: true,
      onForumPublishAuditResult: async () => {
        accepting = true;
        await blocked;
      },
    },
  );
  const handlePayload = Reflect.get(gateway, "handlePayload") as (
    raw: string,
  ) => Promise<void>;
  const handling = Reflect.apply(handlePayload, gateway, [
    forumAuditDispatch(77),
  ]);

  try {
    await waitFor(() => accepting);
    assert.equal(await fileExists(fixture.stateFile), false);
    release();
    await handling;
    const state = JSON.parse(await fs.readFile(fixture.stateFile, "utf8")) as {
      sequence?: number;
    };
    assert.equal(state.sequence, 77);
  } finally {
    release();
    await fixture.cleanup();
  }
});

test("Gateway does not advance audit sequence when durable update fails", async () => {
  const fixture = await gatewayStateFixture();
  const initialState = {
    version: 1,
    appId: "app",
    intents: gatewayIntents(true),
    sequence: 41,
  };
  await fs.writeFile(fixture.stateFile, `${JSON.stringify(initialState)}\n`);
  const gateway = new QQGateway(
    new QQApi("app", "secret"),
    fixture.stateFile,
    async () => {},
    () => {},
    {
      forumEnabled: true,
      onForumPublishAuditResult: async () => {
        throw new Error("publication state failed");
      },
    },
  );
  Reflect.set(gateway, "state", initialState);
  const handlePayload = Reflect.get(gateway, "handlePayload") as (
    raw: string,
  ) => Promise<void>;

  try {
    await assert.rejects(
      Reflect.apply(handlePayload, gateway, [forumAuditDispatch(42)]),
      /publication state failed/,
    );
    assert.equal(
      (Reflect.get(gateway, "state") as { sequence?: number }).sequence,
      41,
    );
    const persisted = JSON.parse(
      await fs.readFile(fixture.stateFile, "utf8"),
    ) as { sequence?: number };
    assert.equal(persisted.sequence, 41);
  } finally {
    await fixture.cleanup();
  }
});

test("Gateway stops a failed socket payload chain before advancing sequence", async () => {
  const fixture = await gatewayStateFixture();
  const initialState = {
    version: 1,
    appId: "app",
    intents: gatewayIntents(true),
    sequence: 41,
  };
  await fs.writeFile(fixture.stateFile, `${JSON.stringify(initialState)}\n`);
  let callbacks = 0;
  const gateway = new QQGateway(
    new QQApi("app", "secret"),
    fixture.stateFile,
    async () => {},
    () => {},
    {
      forumEnabled: true,
      onForumThreadCreate: async () => {
        callbacks++;
        throw new Error("durable queue failed");
      },
    },
  );
  Reflect.set(gateway, "state", initialState);
  const closes: Array<[number, string]> = [];
  const socket = {
    close: (code: number, reason: string) => {
      closes.push([code, reason]);
    },
  };
  Reflect.set(gateway, "socket", socket);
  const queuePayload = Reflect.get(gateway, "queuePayload") as (
    socket: unknown,
    raw: string,
  ) => void;

  try {
    Reflect.apply(queuePayload, gateway, [
      socket,
      forumDispatch("failed-thread", 42),
    ]);
    Reflect.apply(queuePayload, gateway, [
      socket,
      forumDispatch("must-not-run", 43),
    ]);
    await waitFor(() => closes.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(callbacks, 1);
    assert.deepEqual(closes, [[4002, "payload handling failed"]]);
    assert.equal(
      (Reflect.get(gateway, "state") as { sequence?: number }).sequence,
      41,
    );
    const persisted = JSON.parse(
      await fs.readFile(fixture.stateFile, "utf8"),
    ) as { sequence?: number };
    assert.equal(persisted.sequence, 41);
  } finally {
    await fixture.cleanup();
  }
});

test("stale socket completion cannot regress a replacement connection sequence", async () => {
  const fixture = await gatewayStateFixture();
  const initialState = {
    version: 1,
    appId: "app",
    intents: gatewayIntents(true),
    sessionId: "session",
    sequence: 9,
  };
  await fs.writeFile(fixture.stateFile, `${JSON.stringify(initialState)}\n`);
  let markOldStarted!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    markOldStarted = resolve;
  });
  let releaseOld!: () => void;
  const oldBlocked = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const gateway = new QQGateway(
    new QQApi("app", "secret"),
    fixture.stateFile,
    async () => {},
    () => {},
    {
      forumEnabled: true,
      onForumThreadCreate: async (event) => {
        if (event.threadInfo.threadId === "old") {
          markOldStarted();
          await oldBlocked;
        }
      },
    },
  );
  Reflect.set(gateway, "state", initialState);
  const oldSocket = { close: () => {} };
  const newSocket = { close: () => {} };
  const queuePayload = Reflect.get(gateway, "queuePayload") as (
    socket: unknown,
    raw: string,
    generation?: number,
  ) => void;

  try {
    Reflect.set(gateway, "socket", oldSocket);
    Reflect.set(gateway, "connectionGeneration", 1);
    Reflect.apply(queuePayload, gateway, [
      oldSocket,
      forumDispatch("old", 10),
      1,
    ]);
    const oldChain = Reflect.get(gateway, "payloadChain") as Promise<void>;
    await oldStarted;

    Reflect.set(gateway, "socket", newSocket);
    Reflect.set(gateway, "connectionGeneration", 2);
    Reflect.set(gateway, "payloadChain", Promise.resolve());
    Reflect.apply(queuePayload, gateway, [
      newSocket,
      forumDispatch("new", 11),
      2,
    ]);
    const newChain = Reflect.get(gateway, "payloadChain") as Promise<void>;
    await newChain;

    releaseOld();
    await oldChain;
    assert.equal(
      (Reflect.get(gateway, "state") as { sequence?: number }).sequence,
      11,
    );
    assert.equal(await readSequence(fixture.stateFile), 11);
  } finally {
    releaseOld();
    await fixture.cleanup();
  }
});

test("stale durable failure closes only its own socket", async () => {
  const fixture = await gatewayStateFixture();
  const initialState = {
    version: 1,
    appId: "app",
    intents: gatewayIntents(true),
    sessionId: "session",
    sequence: 9,
  };
  await fs.writeFile(fixture.stateFile, `${JSON.stringify(initialState)}\n`);
  let markOldStarted!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    markOldStarted = resolve;
  });
  let rejectOld!: (error: Error) => void;
  const oldBlocked = new Promise<void>((_resolve, reject) => {
    rejectOld = reject;
  });
  const gateway = new QQGateway(
    new QQApi("app", "secret"),
    fixture.stateFile,
    async () => {},
    () => {},
    {
      forumEnabled: true,
      onForumThreadCreate: async (event) => {
        if (event.threadInfo.threadId === "old") {
          markOldStarted();
          await oldBlocked;
        }
      },
    },
  );
  Reflect.set(gateway, "state", initialState);
  const oldCloses: Array<[number, string]> = [];
  const newCloses: Array<[number, string]> = [];
  let markOldClosed!: () => void;
  const oldClosed = new Promise<void>((resolve) => {
    markOldClosed = resolve;
  });
  const oldSocket = {
    close: (code: number, reason: string) => {
      oldCloses.push([code, reason]);
      markOldClosed();
    },
  };
  const newSocket = {
    close: (code: number, reason: string) => newCloses.push([code, reason]),
  };
  const queuePayload = Reflect.get(gateway, "queuePayload") as (
    socket: unknown,
    raw: string,
    generation?: number,
  ) => void;

  try {
    Reflect.set(gateway, "socket", oldSocket);
    Reflect.set(gateway, "connectionGeneration", 1);
    Reflect.apply(queuePayload, gateway, [
      oldSocket,
      forumDispatch("old", 10),
      1,
    ]);
    await oldStarted;

    Reflect.set(gateway, "socket", newSocket);
    Reflect.set(gateway, "connectionGeneration", 2);
    Reflect.set(gateway, "payloadChain", Promise.resolve());
    Reflect.apply(queuePayload, gateway, [
      newSocket,
      forumDispatch("new", 11),
      2,
    ]);
    const newChain = Reflect.get(gateway, "payloadChain") as Promise<void>;
    await newChain;

    rejectOld(new Error("old durable callback failed"));
    await oldClosed;
    assert.deepEqual(oldCloses, [[4002, "payload handling failed"]]);
    assert.deepEqual(newCloses, []);
    assert.equal(await readSequence(fixture.stateFile), 11);
  } finally {
    rejectOld(new Error("cleanup"));
    await fixture.cleanup();
  }
});

test("forum normalization requires the supplied full thread", () => {
  assert.equal(
    normalizeForumThreadCreate({
      guild_id: "guild",
      channel_id: "channel",
      author_id: "author",
    }),
    null,
  );
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
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

async function readSequence(file: string): Promise<number | undefined> {
  try {
    return (JSON.parse(await fs.readFile(file, "utf8")) as {
      sequence?: number;
    }).sequence;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function gatewayStateFixture(): Promise<{
  stateFile: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qq-bot-acp-gateway-"));
  return {
    stateFile: path.join(root, "state.json"),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function forumDispatch(threadId: string, sequence: number): string {
  return JSON.stringify({
    op: 0,
    t: "FORUM_THREAD_CREATE",
    s: sequence,
    d: {
      guild_id: "guild",
      channel_id: "channel",
      author_id: "author",
      thread_info: {
        thread_id: threadId,
        title: "Title",
        content: "@C help",
        date_time: "2026-09-04T00:00:00Z",
      },
    },
  });
}

function forumAuditDispatch(sequence: number): string {
  return JSON.stringify({
    op: 0,
    t: "FORUM_PUBLISH_AUDIT_RESULT",
    s: sequence,
    d: {
      guild_id: "guild",
      channel_id: "channel",
      author_id: "bot-user",
      type: 1,
      result: 0,
      err_msg: "",
      thread_id: "result-thread",
      post_id: "",
      reply_id: "",
    },
  });
}
