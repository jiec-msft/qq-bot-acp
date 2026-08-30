import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { QQBotAcpClient } from "../src/acp/client.js";

test("ACP file callbacks stay inside the configured workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qq-client-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "inside.txt"), "inside\n");
  await fs.writeFile(outside, "outside\n");

  try {
    const client = new QQBotAcpClient(workspace);
    assert.deepEqual(
      await client.readTextFile({ path: "inside.txt" }),
      { content: "inside\n" },
    );
    await client.writeTextFile({ path: "created.txt", content: "created\n" });
    assert.equal(
      await fs.readFile(path.join(workspace, "created.txt"), "utf8"),
      "created\n",
    );
    await assert.rejects(
      client.readTextFile({ path: outside }),
      /must stay inside agent\.cwd/,
    );
    await assert.rejects(
      client.writeTextFile({ path: outside, content: "changed" }),
      /must stay inside agent\.cwd/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ACP writes reject dangling symlinks and turn policy escapes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qq-client-policy-"));
  const workspace = path.join(root, "workspace");
  const proposal = path.join(workspace, ".tmp", "proposal.md");
  const link = path.join(workspace, "dangling.txt");
  await fs.mkdir(path.dirname(proposal), { recursive: true });
  try {
    try {
      await fs.symlink(path.join(root, "outside.txt"), link, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Symbolic links are unavailable in this Windows environment");
        return;
      }
      throw error;
    }
    const client = new QQBotAcpClient(workspace);
    await client.beginTurn(
      { onText: async () => {} },
      false,
      { restrictPermissions: true, allowedWriteFiles: [proposal] },
    );
    await client.writeTextFile({ path: proposal, content: "proposal\n" });
    await assert.rejects(
      client.writeTextFile({
        path: path.join(workspace, "other.md"),
        content: "other\n",
      }),
      /cannot write that file/,
    );
    await assert.rejects(
      client.writeTextFile({ path: link, content: "outside\n" }),
      /cannot target symbolic links/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
