import path from "node:path";
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const botConfigSchema = z.object({
  version: z.literal(1),
  qq: z.object({
    appId: nonEmptyString,
    clientSecretFile: nonEmptyString,
  }),
  agent: z.object({
    command: nonEmptyString,
    args: z.array(z.string()).default([]),
    cwd: nonEmptyString,
    env: z.record(z.string(), z.string()).default({}),
  }),
  access: z.object({
    admins: z.array(nonEmptyString).default([]),
    allowFrom: z.array(nonEmptyString).default([]),
    groupAllowFrom: z.array(nonEmptyString).default([]),
  }),
  sessions: z.object({
    idleTimeoutMs: z.number().int().nonnegative().default(86_400_000),
    maxConcurrent: z.number().int().positive().max(100).default(10),
    resume: z.enum(["off", "auto", "required"]).default("off"),
    defaultOptions: z.record(
      z.string(),
      z.union([z.string(), z.boolean()]),
    ).default({
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
    }),
  }),
  output: z.object({
    textChunkLimit: z.number().int().min(100).max(4000).default(2000),
    markdownMode: z.enum(["plain", "native", "raw"]).default("native"),
    streamResponses: z.boolean().default(true),
    streamMinChars: z.number().int().min(100).max(4000).default(400),
    showThoughts: z.boolean().default(false),
  }),
});

export type BotConfig = z.infer<typeof botConfigSchema>;

export function createInitialConfig(input: {
  appId: string;
  clientSecretFile: string;
  agentCommand: string;
  agentArgs?: string[];
  agentCwd?: string;
}): BotConfig {
  return botConfigSchema.parse({
    version: 1,
    qq: {
      appId: input.appId,
      clientSecretFile: path.resolve(input.clientSecretFile),
    },
    agent: {
      command: input.agentCommand,
      args: input.agentArgs ?? [],
      cwd: path.resolve(input.agentCwd ?? process.cwd()),
      env: {},
    },
    access: {
      admins: [],
      allowFrom: [],
      groupAllowFrom: [],
    },
    sessions: {
      idleTimeoutMs: 86_400_000,
      maxConcurrent: 10,
      resume: "off",
      defaultOptions: {
        model: "gpt-5.6-sol",
        reasoning_effort: "medium",
      },
    },
    output: {
      textChunkLimit: 2000,
      markdownMode: "native",
      streamResponses: true,
      streamMinChars: 400,
      showThoughts: false,
    },
  });
}

export function parseConfig(value: unknown): BotConfig {
  return botConfigSchema.parse(value);
}

export function parseConfigValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("A configuration value is required");
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export function getConfigValue(config: BotConfig, key: string): unknown {
  let current: unknown = config;
  for (const segment of configKeySegments(key)) {
    if (typeof current !== "object" || current === null || !(segment in current)) {
      throw new Error(`Unknown configuration key: ${key}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function setConfigValue(config: BotConfig, key: string, value: unknown): BotConfig {
  const segments = configKeySegments(key);
  if (segments[0] === "version") {
    throw new Error("The configuration version cannot be changed");
  }

  const candidate = structuredClone(config) as unknown as Record<string, unknown>;
  let current = candidate;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new Error(`Unknown configuration key: ${key}`);
    }
    current = next as Record<string, unknown>;
  }

  const leaf = segments.at(-1)!;
  if (!(leaf in current)) throw new Error(`Unknown configuration key: ${key}`);
  current[leaf] = value;
  return parseConfig(candidate);
}

function configKeySegments(key: string): string[] {
  const segments = key.trim().split(".").filter(Boolean);
  if (segments.length === 0) throw new Error("A configuration key is required");
  if (segments.some((segment) => !/^[A-Za-z][A-Za-z0-9]*$/.test(segment))) {
    throw new Error(`Invalid configuration key: ${key}`);
  }
  return segments;
}

export function redactConfig(config: BotConfig): unknown {
  return {
    ...config,
    qq: {
      ...config.qq,
      clientSecretFile: config.qq.clientSecretFile ? "[configured file]" : "[not configured]",
    },
    agent: {
      ...config.agent,
      env: Object.fromEntries(
        Object.keys(config.agent.env).map((key) => [key, "[redacted]"]),
      ),
    },
  };
}
