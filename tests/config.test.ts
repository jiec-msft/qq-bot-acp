import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../src/config/store.js";
import { resolveBotPaths } from "../src/config/paths.js";
import {
  createInitialConfig,
  getConfigValue,
  parseConfig,
  parseConfigValue,
  setConfigValue,
} from "../src/config/schema.js";

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "qq-bot-acp-"));
  const paths = resolveBotPaths(undefined, home);
  const config = createInitialConfig({
    appId: "app",
    clientSecretFile: path.join(home, "secret"),
    agentCommand: "agent",
  });
  return { home, paths, config, store: new ConfigStore(paths) };
}

test("configuration paths are independent of cwd and conversations", async () => {
  const home = path.join("C:", "Users", "example");
  const paths = resolveBotPaths("work", home);
  assert.equal(paths.root, path.join(home, ".qq-bot-acp", "instances", "work"));
});

test("configuration values support JSON and validated dotted updates", async () => {
  const { config } = await fixture();
  assert.deepEqual(config.access.allowFrom, []);
  assert.deepEqual(config.access.groupAllowFrom, []);
  assert.deepEqual(config.sessions.defaultOptions, {
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
  });
  const updated = setConfigValue(config, "agent.args", parseConfigValue('["acp"]'));
  assert.deepEqual(getConfigValue(updated, "agent.args"), ["acp"]);
  assert.throws(() => setConfigValue(config, "sessions.maxConcurrent", 0));
  assert.throws(() => setConfigValue(config, "unknown.value", true));
});

test("legacy configurations receive output formatting defaults", async () => {
  const { config } = await fixture();
  assert.equal(config.output.markdownMode, "native");
  const legacy = {
    ...config,
    sessions: {
      idleTimeoutMs: config.sessions.idleTimeoutMs,
      maxConcurrent: config.sessions.maxConcurrent,
      resume: config.sessions.resume,
    },
    output: {
      textChunkLimit: config.output.textChunkLimit,
      showThoughts: config.output.showThoughts,
    },
  };

  const parsed = parseConfig(legacy);
  assert.deepEqual(parsed.output, config.output);
  assert.deepEqual(parsed.sessions.defaultOptions, config.sessions.defaultOptions);
  assert.equal(parsed.output.markdownMode, "native");
});

test("admin CLI bootstrap cannot replace an existing administrator", async () => {
  const { store, config } = await fixture();
  await store.initialize(config);
  const bootstrapped = await store.bootstrapAdmins(["OPENID"]);
  assert.deepEqual(bootstrapped.access.admins, ["OPENID"]);
  await assert.rejects(() => store.bootstrapAdmins(["OTHER"]), /bootstrap-only/);
});

test("failed current configuration falls back to proven and archives failure", async () => {
  const { store, config, paths } = await fixture();
  await store.initialize(config);
  await store.markProven(config);
  const candidate = setConfigValue(config, "agent.command", "broken");
  await store.write(candidate);

  const loaded = await store.loadForStartup(async (value) => {
    if (value.agent.command === "broken") throw new Error("agent failed");
  });

  assert.equal(loaded.source, "proven");
  assert.equal(loaded.config.agent.command, "agent");
  assert.equal((await store.read()).agent.command, "agent");
  assert.match(await fs.readFile(paths.failedConfig, "utf8"), /broken/);
});
