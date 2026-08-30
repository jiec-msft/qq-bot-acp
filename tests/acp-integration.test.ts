import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "../src/acp/session-manager.js";
import { SessionStateStore } from "../src/acp/state.js";
import { ArtifactBroker } from "../src/artifacts/broker.js";
import { createInitialConfig } from "../src/config/schema.js";

test("per-conversation manager exchanges prompts with an ACP child process", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "qq-bot-acp-agent-"));
  const fixture = path.resolve("tests", "fixtures", "fake-agent.mjs");
  const config = createInitialConfig({
    appId: "unused",
    clientSecretFile: path.join(temp, "secret"),
    agentCommand: process.execPath,
    agentArgs: [fixture],
    agentCwd: process.cwd(),
  });

  const artifacts = new ArtifactBroker(() => {});
  await artifacts.start();
  const manager = new SessionManager(
    config,
    new SessionStateStore(path.join(temp, "sessions.json")),
    artifacts,
    () => {},
  );
  manager.start();
  const replies: string[] = [];
  let completed = false;
  try {
    await manager.prompt(
      "qqbot:test:direct:user",
      [{ type: "text", text: "hello" }],
      {
        onText: async (text) => { replies.push(text); },
        onComplete: async () => { completed = true; },
      },
    );
    assert.deepEqual(replies, ["echo:", "hello"]);
    assert.equal(completed, true);
    assert.deepEqual(
      (await manager.getRuntimeStatus("qqbot:test:direct:user")).options,
      {
        model: "gpt-5.6-sol",
        reasoning_effort: "medium",
      },
    );

    const firstTurn: string[] = [];
    const secondTurn: string[] = [];
    await Promise.all([
      manager.prompt(
        "qqbot:test:direct:user",
        [{ type: "text", text: "first" }],
        { onText: async (text) => { firstTurn.push(text); } },
      ),
      manager.prompt(
        "qqbot:test:direct:user",
        [{ type: "text", text: "second" }],
        { onText: async (text) => { secondTurn.push(text); } },
      ),
    ]);
    assert.deepEqual(firstTurn, ["echo:", "first"]);
    assert.deepEqual(secondTurn, ["echo:", "second"]);

    const options = await manager.setSessionConfig(
      "qqbot:test:direct:user",
      "model",
      "large",
    );
    assert.equal(options[0]?.currentValue, "large");

    await manager.setSessionPreset("qqbot:test:direct:user", {
      model: "gpt-5.6-sol",
      reasoning_effort: "max",
    });
    const status = await manager.getRuntimeStatus("qqbot:test:direct:user");
    assert.equal(status.conversationLoaded, false);
    assert.equal(status.options.reasoning_effort, "max");
    await assert.rejects(
      manager.setSessionPreset("qqbot:test:direct:user", {
        model: "gpt-5.6-sol",
        reasoning_effort: "ultra",
      }),
      /does not support value "ultra"/,
    );
    assert.equal(
      (await manager.getRuntimeStatus("qqbot:test:direct:user")).options
        .reasoning_effort,
      "max",
    );
  } finally {
    await manager.stop();
    await artifacts.stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("queued work is protected from eviction and cannot restart after stop", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "qq-bot-acp-slow-"));
  const fixture = path.resolve("tests", "fixtures", "slow-agent.mjs");
  const config = createInitialConfig({
    appId: "unused",
    clientSecretFile: path.join(temp, "secret"),
    agentCommand: process.execPath,
    agentArgs: [fixture],
    agentCwd: process.cwd(),
  });
  config.sessions.maxConcurrent = 1;
  const artifacts = new ArtifactBroker(() => {});
  await artifacts.start();
  const manager = new SessionManager(
    config,
    new SessionStateStore(path.join(temp, "sessions.json")),
    artifacts,
    () => {},
  );
  manager.start();
  try {
    await manager.prompt("a", [{ type: "text", text: "warm" }], {
      onText: async () => {},
    });
    const active = manager.prompt("a", [{ type: "text", text: "slow" }], {
      onText: async () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(
      manager.prompt("b", [{ type: "text", text: "other" }], {
        onText: async () => {},
      }),
      /Maximum concurrent ACP sessions reached/,
    );
    await active;

    const running = manager.prompt("a", [{ type: "text", text: "slow" }], {
      onText: async () => {},
    });
    const queued = manager.prompt("a", [{ type: "text", text: "queued" }], {
      onText: async () => {},
    });
    void running.catch(() => {});
    void queued.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    await manager.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await manager.getRuntimeStatus("a");
    assert.equal(status.residentSessions, 0);
    assert.equal(status.pendingSessions, 0);
  } finally {
    await manager.stop();
    await artifacts.stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
