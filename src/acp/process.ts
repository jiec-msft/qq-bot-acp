import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { BotConfig } from "../config/schema.js";
import { QQBotAcpClient } from "./client.js";

export interface AgentConnection {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  client: QQBotAcpClient;
  sessionId: string;
  configOptions: acp.SessionConfigOption[];
  loaded: boolean;
}

export type SessionOptionValues = Record<string, string | boolean>;

export async function startAgent(
  config: BotConfig["agent"],
  options?: {
    persistedSessionId?: string;
    resume?: BotConfig["sessions"]["resume"];
    mcpServers?: acp.McpServer[];
    log?: (message: string) => void;
  },
): Promise<AgentConnection> {
  const client = new QQBotAcpClient(config.cwd);
  const useShell =
    globalThis.process.platform === "win32" &&
    (path.extname(config.command) === "" || /\.(?:cmd|bat)$/i.test(config.command));
  const command =
    useShell && /\s/.test(config.command) ? `"${config.command}"` : config.command;
  const process = spawn(command, config.args, {
    cwd: config.cwd,
    env: { ...globalThis.process.env, ...config.env },
    stdio: ["pipe", "pipe", "inherit"],
    shell: useShell,
    windowsHide: true,
  });

  try {
    if (!process.stdin || !process.stdout) {
      throw new Error("ACP agent did not expose stdin/stdout");
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(process.stdin),
      Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = new acp.ClientSideConnection(() => client, stream);
    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: {
        name: "qq-bot-acp",
        title: "QQ Bot ACP",
        version: "0.1.0",
      },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
    assertMcpSupport(
      options?.mcpServers ?? [],
      initialized.agentCapabilities?.mcpCapabilities,
    );

    const resume = options?.resume ?? "off";
    if (options?.persistedSessionId && resume !== "off") {
      if (initialized.agentCapabilities?.loadSession !== true) {
        if (resume === "required") {
          throw new Error("The configured agent does not support ACP session/load");
        }
      } else {
        try {
          const loaded = await connection.loadSession({
            cwd: config.cwd,
            mcpServers: options?.mcpServers ?? [],
            sessionId: options.persistedSessionId,
          });
          return {
            process,
            connection,
            client,
            sessionId: options.persistedSessionId,
            configOptions: loaded.configOptions ?? [],
            loaded: true,
          };
        } catch (error) {
          if (resume === "required" || !isResourceNotFound(error)) throw error;
          options.log?.("Persisted ACP session was not found; creating a new session");
        }
      }
    }

    const created = await connection.newSession({
      cwd: config.cwd,
      mcpServers: options?.mcpServers ?? [],
    });
    return {
      process,
      connection,
      client,
      sessionId: created.sessionId,
      configOptions: created.configOptions ?? [],
      loaded: false,
    };
  } catch (error) {
    await stopAgentProcess(process);
    throw error;
  }
}

export async function smokeTestAgent(
  config: BotConfig["agent"],
  mcpServers: acp.McpServer[] = [],
  sessionOptions: SessionOptionValues = {},
): Promise<void> {
  const agent = await startAgent(config, { mcpServers });
  try {
    await applySessionOptions(agent, sessionOptions, true);
  } finally {
    await stopAgentProcess(agent.process);
  }
}

export async function applySessionOptions(
  agent: AgentConnection,
  values: SessionOptionValues,
  strict: boolean,
): Promise<void> {
  for (const [configId, value] of Object.entries(values)) {
    const option = agent.configOptions.find((entry) => entry.id === configId);
    if (!option) {
      if (!strict) continue;
      const available = agent.configOptions.map((option) => option.id);
      throw new Error(
        available.length
          ? `ACP agent does not advertise required session option "${configId}". Available: ${available.join(", ")}`
          : `ACP agent does not advertise required session option "${configId}"`,
      );
    }
    assertSessionOptionValue(option, value);
    const response = await agent.connection.setSessionConfigOption(
      typeof value === "boolean"
        ? { sessionId: agent.sessionId, configId, type: "boolean", value }
        : { sessionId: agent.sessionId, configId, value },
    );
    agent.configOptions = response.configOptions;
  }
}

export function validateSessionOptionValues(
  options: acp.SessionConfigOption[],
  values: SessionOptionValues,
  strict: boolean,
): void {
  for (const [configId, value] of Object.entries(values)) {
    const option = options.find((entry) => entry.id === configId);
    if (!option) {
      if (!strict) continue;
      const available = options.map((entry) => entry.id);
      throw new Error(
        available.length
          ? `ACP agent does not advertise required session option "${configId}". Available: ${available.join(", ")}`
          : `ACP agent does not advertise required session option "${configId}"`,
      );
    }
    assertSessionOptionValue(option, value);
  }
}

function assertSessionOptionValue(
  option: acp.SessionConfigOption,
  value: string | boolean,
): void {
  if (option.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`ACP session option "${option.id}" requires a boolean`);
    }
    return;
  }
  if (typeof value !== "string") {
    throw new Error(`ACP session option "${option.id}" requires a string`);
  }
  const choices = option.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
  );
  if (!choices.includes(value)) {
    throw new Error(
      `ACP session option "${option.id}" does not support value "${value}". Available: ${choices.join(", ")}`,
    );
  }
}

export async function stopAgentProcess(process: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    process.once("exit", () => resolve());
    process.once("close", () => resolve());
  });
  process.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}

function isResourceNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === -32002
  );
}

function assertMcpSupport(
  servers: acp.McpServer[],
  capabilities: acp.McpCapabilities | null | undefined,
): void {
  if (
    servers.some((server) => "type" in server && server.type === "http") &&
    capabilities?.http !== true
  ) {
    throw new Error(
      "The configured agent does not support ACP HTTP MCP servers required for QQ artifact delivery",
    );
  }
  if (
    servers.some((server) => "type" in server && server.type === "sse") &&
    capabilities?.sse !== true
  ) {
    throw new Error("The configured agent does not support ACP SSE MCP servers");
  }
}
