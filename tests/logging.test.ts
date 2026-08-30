import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { conversationLogId } from "../src/acp/session-manager.js";
import { createServiceLogger } from "../src/logging/service-logger.js";

test("service logger writes dated files and mirrors console output", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qq-bot-acp-log-"));
  const consoleLines: string[] = [];
  const logger = await createServiceLogger(directory, {
    now: () => new Date("2026-08-30T08:27:35.623Z"),
    consoleLog: (line) => consoleLines.push(line),
  });

  logger.log("QQ stream frame failed trace=1 error=http-400");
  await logger.close();

  const expected =
    "[2026-08-30T08:27:35.623Z] QQ stream frame failed trace=1 error=http-400";
  assert.deepEqual(consoleLines, [expected]);
  assert.equal(
    await fs.readFile(
      path.join(directory, "qq-bot-acp-2026-08-30.log"),
      "utf8",
    ),
    `${expected}\n`,
  );
});

test("conversation log IDs are stable without exposing QQ identifiers", () => {
  const key = "qqbot:app-id:direct:sensitive-user-openid";
  const first = conversationLogId(key);

  assert.equal(first, conversationLogId(key));
  assert.match(first, /^[a-f0-9]{12}$/);
  assert.doesNotMatch(first, /app-id|sensitive-user-openid/);
  assert.notEqual(
    first,
    conversationLogId("qqbot:app-id:direct:another-user-openid"),
  );
});
