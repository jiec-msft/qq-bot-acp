export type ControlCommand =
  | { kind: "id" }
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
  if (trimmed === "/id") return { kind: "id" };
  if (trimmed === "/acp-cancel") return { kind: "cancel" };
  if (trimmed === "/acp-new") return { kind: "new" };

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
