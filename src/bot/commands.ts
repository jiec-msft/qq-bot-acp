export type ControlCommand =
  | { kind: "id" }
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "mode"; mode: "normal" | "deep" }
  | { kind: "learn"; guidance?: string }
  | { kind: "approve" }
  | { kind: "review" }
  | { kind: "publish"; confirm: boolean; error?: string }
  | { kind: "discard" }
  | { kind: "setup-controls" }
  | { kind: "config"; key?: string; value?: string; operation: "show" | "get" | "set" | "status" }
  | { kind: "session-config"; key?: string; value?: string; operation: "show" | "set" | "reset" }
  | {
      kind: "test-streaming";
      delayMinutes?: 1 | 3 | 5 | 10;
      wakeup: boolean;
      error?: string;
    }
  | { kind: "cancel" }
  | { kind: "new" };

export function parseControlCommand(text: string): ControlCommand | null {
  const trimmed = text.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === "/id") return { kind: "id" };
  if (["help", "/help"].includes(normalized)) return { kind: "help" };
  if (["status", "/status"].includes(normalized)) return { kind: "status" };
  if (["normal", "/normal"].includes(normalized)) {
    return { kind: "mode", mode: "normal" };
  }
  if (["deep", "/deep"].includes(normalized)) {
    return { kind: "mode", mode: "deep" };
  }
  if (["approve", "/approve"].includes(normalized)) return { kind: "approve" };
  if (["review", "/review"].includes(normalized)) return { kind: "review" };
  if (["discard", "/discard"].includes(normalized)) return { kind: "discard" };
  if (["setup controls", "/setup-controls"].includes(normalized)) {
    return { kind: "setup-controls" };
  }
  if (["stop", "/stop", "/acp-cancel"].includes(normalized)) {
    return { kind: "cancel" };
  }
  if (["new chat", "/new", "/acp-new"].includes(normalized)) {
    return { kind: "new" };
  }

  const learning = matchCommandInsensitive(trimmed, ["Learn", "/learn"]);
  if (learning !== null) {
    return {
      kind: "learn",
      guidance: learning || undefined,
    };
  }

  const publishing = matchCommandInsensitive(trimmed, ["Publish", "/publish"]);
  if (publishing !== null) {
    if (!publishing) return { kind: "publish", confirm: false };
    if (publishing.toLowerCase() === "confirm") {
      return { kind: "publish", confirm: true };
    }
    return {
      kind: "publish",
      confirm: false,
      error: "Usage: Publish or Publish Confirm",
    };
  }

  const streaming = matchCommand(trimmed, ["/test-streaming"]);
  if (streaming !== null) {
    if (!streaming) return { kind: "test-streaming", wakeup: false };
    const args = splitArguments(streaming).map(unquote);
    const delay = Number(args[0]);
    const wakeup = args[1] === "wakeup";
    if (
      ![1, 3, 5, 10].includes(delay) ||
      args.length > 2 ||
      (args.length === 2 && !wakeup)
    ) {
      return {
        kind: "test-streaming",
        wakeup: false,
        error: "Usage: /test-streaming [1|3|5|10] [wakeup]",
      };
    }
    return {
      kind: "test-streaming",
      delayMinutes: delay as 1 | 3 | 5 | 10,
      wakeup,
    };
  }

  const config = matchCommand(trimmed, ["/config", "/c"]);
  if (config !== null) {
    if (!config) return { kind: "config", operation: "show" };
    if (config === "status") return { kind: "config", operation: "status" };
    const [first, ...rest] = splitArguments(config);
    if (first === "get") {
      return { kind: "config", operation: "get", key: rest.join(" ") };
    }
    return {
      kind: "config",
      operation: "set",
      key: first,
      value: rest.join(" "),
    };
  }

  const session = matchCommand(trimmed, ["/session-config", "/sc"]);
  if (session !== null) {
    if (!session) return { kind: "session-config", operation: "show" };
    if (session === "reset") return { kind: "session-config", operation: "reset" };
    const [key, ...rest] = splitArguments(session);
    return {
      kind: "session-config",
      operation: "set",
      key,
      value: rest.join(" "),
    };
  }
  return null;
}

function matchCommand(text: string, names: string[]): string | null {
  for (const name of names) {
    if (text === name) return "";
    if (text.startsWith(`${name} `)) return text.slice(name.length).trim();
  }
  return null;
}

function matchCommandInsensitive(text: string, names: string[]): string | null {
  const lower = text.toLowerCase();
  for (const name of names) {
    const normalized = name.toLowerCase();
    if (lower === normalized) return "";
    if (lower.startsWith(`${normalized} `)) {
      return text.slice(name.length).trim();
    }
  }
  return null;
}

function splitArguments(value: string): string[] {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
