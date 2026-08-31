import assert from "node:assert/strict";
import test from "node:test";
import { parseControlCommand } from "../src/bot/commands.js";

test("global configuration aliases parse key and JSON value", () => {
  assert.deepEqual(parseControlCommand('/c agent.args ["acp","--debug"]'), {
    kind: "config",
    operation: "set",
    key: "agent.args",
    value: '["acp","--debug"]',
  });
  assert.deepEqual(parseControlCommand("/config get agent.command"), {
    kind: "config",
    operation: "get",
    key: "agent.command",
  });
});

test("session configuration aliases remain conversation scoped", () => {
  assert.deepEqual(parseControlCommand("/sc reasoning_effort high"), {
    kind: "session-config",
    operation: "set",
    key: "reasoning_effort",
    value: "high",
  });
  assert.deepEqual(parseControlCommand("/session-config reset"), {
    kind: "session-config",
    operation: "reset",
  });
});

test("streaming diagnostic command is recognized exactly", () => {
  assert.deepEqual(parseControlCommand("/test-streaming"), {
    kind: "test-streaming",
    wakeup: false,
  });
  assert.deepEqual(parseControlCommand("/test-streaming 10 wakeup"), {
    kind: "test-streaming",
    delayMinutes: 10,
    wakeup: true,
  });
  assert.deepEqual(parseControlCommand("/test-streaming now"), {
    kind: "test-streaming",
    wakeup: false,
    error: "Usage: /test-streaming [1|3|5|10] [wakeup]",
  });
});

test("simple panel commands map to safe control actions", () => {
  assert.deepEqual(parseControlCommand("Help"), { kind: "help" });
  assert.deepEqual(parseControlCommand("New Chat"), { kind: "new" });
  assert.deepEqual(parseControlCommand("Stop"), { kind: "cancel" });
  assert.deepEqual(parseControlCommand("Status"), { kind: "status" });
  assert.deepEqual(parseControlCommand("Retry"), { kind: "retry" });
  assert.deepEqual(parseControlCommand("Seen"), { kind: "seen" });
  assert.deepEqual(parseControlCommand("Normal"), {
    kind: "mode",
    mode: "normal",
  });
  assert.deepEqual(parseControlCommand("Deep"), {
    kind: "mode",
    mode: "deep",
  });
  assert.deepEqual(parseControlCommand("Learn improve equation rendering"), {
    kind: "learn",
    guidance: "improve equation rendering",
  });
  assert.deepEqual(parseControlCommand("Approve"), { kind: "approve" });
  assert.deepEqual(parseControlCommand("Review"), { kind: "review" });
  assert.deepEqual(parseControlCommand("Publish"), {
    kind: "publish",
    confirm: false,
  });
  assert.deepEqual(parseControlCommand("Publish Confirm"), {
    kind: "publish",
    confirm: true,
  });
  assert.deepEqual(parseControlCommand("Discard"), { kind: "discard" });
  assert.deepEqual(parseControlCommand("/setup-controls"), {
    kind: "setup-controls",
  });
});
