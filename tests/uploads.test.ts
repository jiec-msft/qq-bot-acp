import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AttachmentStager } from "../src/uploads/stager.js";
import type { QQInboundMessage } from "../src/qq/types.js";

const execFileAsync = promisify(execFile);

test("attachments are staged under ignored workspace temp storage", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "qq-upload-"));
  await execFileAsync("git", ["init"], { cwd: workspace, windowsHide: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(Buffer.from("pptx-data"), {
      status: 200,
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "content-length": "9",
      },
    });
  try {
    const stager = new AttachmentStager(workspace, () => {});
    await stager.start();
    const blocks = await stager.toPrompt(message("lesson.pptx"), "请分析课件");
    const prompt = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.match(prompt, /请分析课件/);
    assert.match(prompt, /\.tmp[\\/]qq-bot-acp/);
    assert.doesNotMatch(prompt, /example\.com/);

    const files = await fs.readdir(
      stager.conversationDirectory("conversation"),
    );
    assert.equal(files.length, 1);
    assert.match(files[0]!, /lesson\.pptx$/);
    assert.equal(await stager.discard("conversation"), true);
    assert.equal(await stager.discard("conversation"), false);
    await execFileAsync(
      "git",
      ["check-ignore", "-q", ".tmp/qq-bot-acp/example"],
      { cwd: workspace, windowsHide: true },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("image attachments remain available as ACP image blocks", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "qq-image-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(Buffer.from("image-data"), { status: 200 });
  try {
    const stager = new AttachmentStager(workspace, () => {});
    await stager.start();
    const input = message("structure.png");
    input.attachments[0]!.contentType = "image/png";
    const blocks = await stager.toPrompt(input);
    assert.ok(blocks.some((block) => block.type === "image"));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("attachment staging rejects a symlinked temp directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qq-upload-link-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  try {
    try {
      await fs.symlink(outside, path.join(workspace, ".tmp"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Symbolic links are unavailable in this Windows environment");
        return;
      }
      throw error;
    }
    await assert.rejects(
      new AttachmentStager(workspace, () => {}).start(),
      /Unsafe attachment directory/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function message(filename: string): QQInboundMessage {
  return {
    accountId: "app",
    conversationId: "conversation",
    chatType: "direct",
    senderId: "user",
    targetId: "user",
    messageId: "message",
    timestamp: "2026-08-30T00:00:00Z",
    text: "",
    attachments: [
      {
        filename,
        contentType: "application/octet-stream",
        url: "https://example.com/attachment",
      },
    ],
  };
}
