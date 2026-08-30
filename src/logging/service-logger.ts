import fs from "node:fs/promises";
import path from "node:path";

export interface ServiceLogger {
  log(message: string): void;
  close(): Promise<void>;
}

export async function createServiceLogger(
  directory: string,
  options: {
    now?: () => Date;
    consoleLog?: (line: string) => void;
    consoleError?: (line: string) => void;
  } = {},
): Promise<ServiceLogger> {
  const now = options.now ?? (() => new Date());
  const consoleLog = options.consoleLog ?? console.log;
  const consoleError = options.consoleError ?? console.error;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  let writes = Promise.resolve();
  let writeErrorReported = false;

  return {
    log(message: string): void {
      const timestamp = now();
      const line = `[${timestamp.toISOString()}] ${message}`;
      const file = path.join(
        directory,
        `qq-bot-acp-${timestamp.toISOString().slice(0, 10)}.log`,
      );
      consoleLog(line);
      writes = writes
        .then(() =>
          fs.appendFile(file, `${line}\n`, {
            encoding: "utf8",
            mode: 0o600,
          }),
        )
        .catch((error) => {
          if (writeErrorReported) return;
          writeErrorReported = true;
          consoleError(
            `Unable to write QQ Bot ACP service log: ${errorMessage(error)}`,
          );
        });
    },
    async close(): Promise<void> {
      await writes;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
