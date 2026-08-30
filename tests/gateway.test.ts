import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { QQApi } from "../src/qq/api.js";
import { QQGateway } from "../src/qq/gateway.js";

test("a resumed QQ gateway session becomes ready", async () => {
  const gateway = new QQGateway(
    new QQApi("app", "secret"),
    path.join(os.tmpdir(), "unused-qq-gateway-state.json"),
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
});
