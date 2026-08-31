import os from "node:os";
import path from "node:path";

const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface BotPaths {
  root: string;
  config: string;
  provenConfig: string;
  failedConfig: string;
  state: string;
  sessions: string;
  logs: string;
  media: string;
  deliveries: string;
}

export function resolveBotPaths(instance?: string, home = os.homedir()): BotPaths {
  if (instance && !INSTANCE_PATTERN.test(instance)) {
    throw new Error(
      "Instance must be 1-64 characters and contain only letters, digits, '.', '_' or '-'",
    );
  }
  const root = instance
    ? path.join(home, ".qq-bot-acp", "instances", instance)
    : path.join(home, ".qq-bot-acp");
  return {
    root,
    config: path.join(root, "config.json"),
    provenConfig: path.join(root, "config.proven.json"),
    failedConfig: path.join(root, "config.failed.json"),
    state: path.join(root, "state.json"),
    sessions: path.join(root, "sessions.json"),
    logs: path.join(root, "logs"),
    media: path.join(root, "media"),
    deliveries: path.join(root, "deliveries"),
  };
}
