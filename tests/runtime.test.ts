import assert from "node:assert/strict";
import test from "node:test";
import { BotRuntime } from "../src/runtime.js";

test("runtime applies recovered forum policy only after Gateway readiness", async () => {
  const calls: string[] = [];
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = () => {
      calls.push("gateway.ready");
      resolve();
    };
  });
  const runtime = runtimeWithLifecycleStubs(calls, ready);

  const started = runtime.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.includes("forum.applyCurrentAccessPolicy"), false);

  markReady();
  await started;
  assert.ok(
    calls.indexOf("forum.applyCurrentAccessPolicy") >
      calls.indexOf("gateway.ready"),
  );
});

test("runtime leaves recovered forum policy untouched when Gateway startup fails", async () => {
  const calls: string[] = [];
  const runtime = runtimeWithLifecycleStubs(
    calls,
    Promise.reject(new Error("candidate Gateway failed")),
  );

  await assert.rejects(runtime.start(), /candidate Gateway failed/);
  assert.equal(calls.includes("forum.applyCurrentAccessPolicy"), false);
});

function runtimeWithLifecycleStubs(
  calls: string[],
  ready: Promise<void>,
): BotRuntime {
  const runtime = Object.create(BotRuntime.prototype) as BotRuntime;
  Reflect.set(runtime, "sender", {
    start: async () => calls.push("sender.start"),
    stop: () => calls.push("sender.stop"),
  });
  Reflect.set(runtime, "stager", {
    start: async () => calls.push("stager.start"),
  });
  Reflect.set(runtime, "sessions", {
    start: () => calls.push("sessions.start"),
    stop: async () => calls.push("sessions.stop"),
  });
  Reflect.set(runtime, "forum", {
    start: async () => calls.push("forum.start"),
    applyCurrentAccessPolicy: async () =>
      calls.push("forum.applyCurrentAccessPolicy"),
    stop: () => calls.push("forum.stop"),
  });
  Reflect.set(runtime, "gateway", {
    start: async () => calls.push("gateway.start"),
    ready,
    stop: async () => calls.push("gateway.stop"),
  });
  Reflect.set(runtime, "artifacts", {
    stop: async () => calls.push("artifacts.stop"),
  });
  return runtime;
}
