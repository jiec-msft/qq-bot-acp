#!/usr/bin/env node

import fs from "node:fs/promises";
import { BotRuntime } from "../src/runtime.js";
import { resolveBotPaths } from "../src/config/paths.js";
import { ConfigStore } from "../src/config/store.js";
import { createInitialConfig } from "../src/config/schema.js";
import { createServiceLogger } from "../src/logging/service-logger.js";

interface CliOptions {
  command: "start" | "init" | "help";
  instance?: string;
  appId?: string;
  clientSecretFile?: string;
  agent?: string;
  agentArgs: string[];
  cwd?: string;
  admins: string[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    printHelp();
    return;
  }
  const paths = resolveBotPaths(options.instance);
  const store = new ConfigStore(paths);

  if (options.command === "init") {
    if (!options.appId || !options.clientSecretFile || !options.agent) {
      throw new Error(
        "init requires --app-id, --client-secret-file, and --agent",
      );
    }
    await fs.access(options.clientSecretFile);
    const config = createInitialConfig({
      appId: options.appId,
      clientSecretFile: options.clientSecretFile,
      agentCommand: options.agent,
      agentArgs: options.agentArgs,
      agentCwd: options.cwd,
    });
    await store.initialize(config);
    console.log(`Created ${paths.config}`);
    return;
  }

  if (options.admins.length > 0) {
    await store.bootstrapAdmins(options.admins);
  }

  const logger = await createServiceLogger(paths.logs);
  const log = (message: string) => logger.log(message);
  let runtime: BotRuntime | undefined;
  try {
    const startup = await store.loadForStartup(async (config) => {
      const candidate = await BotRuntime.create(config, store, log);
      try {
        await candidate.start();
        runtime = candidate;
      } catch (error) {
        await candidate.stop();
        throw error;
      }
    });
    await store.markProven(startup.config);
    if (startup.source === "proven") {
      log(`Current config failed; restored proven config: ${startup.currentError?.message}`);
    }
    log(`Bot ready using ${startup.source} configuration`);
  } catch (error) {
    await logger.close();
    throw error;
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("Stopping...");
    await runtime?.stop();
    await logger.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    command: "start",
    agentArgs: [],
    admins: [],
  };
  let index = 0;
  if (args[0] === "init") {
    options.command = "init";
    index++;
  } else if (args[0] === "start") {
    index++;
  } else if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    options.command = "help";
    return options;
  }

  while (index < args.length) {
    const flag = args[index++];
    const value = args[index++];
    if (!value) throw new Error(`Missing value for ${flag}`);
    switch (flag) {
      case "--instance":
        options.instance = value;
        break;
      case "--app-id":
        options.appId = value;
        break;
      case "--client-secret-file":
        options.clientSecretFile = value;
        break;
      case "--agent":
        options.agent = value;
        break;
      case "--agent-arg":
        options.agentArgs.push(value);
        break;
      case "--cwd":
        options.cwd = value;
        break;
      case "--admin-openid":
        options.admins.push(value);
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`qq-bot-acp

Initialize:
  qq-bot-acp init --app-id ID --client-secret-file PATH --agent COMMAND
                  [--agent-arg ARG] [--cwd PATH] [--instance NAME]

Start:
  qq-bot-acp [start] [--instance NAME] [--admin-openid OPENID]

--admin-openid is accepted only while the persisted administrator list is empty.
After startup, use /id privately to discover your bot-scoped OpenID.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
