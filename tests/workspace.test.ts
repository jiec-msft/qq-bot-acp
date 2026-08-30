import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WorkspaceRepository } from "../src/workspace/repository.js";

const execFileAsync = promisify(execFile);

test("workspace publication requires preview and an unchanged clean head", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qq-workspace-"));
  const remote = path.join(root, "remote.git");
  const workspace = path.join(root, "workspace");
  await git(root, ["init", "--bare", remote]);
  await fs.mkdir(workspace);
  await git(workspace, ["init", "-b", "main"]);
  await git(workspace, ["config", "user.name", "Test"]);
  await git(workspace, ["config", "user.email", "test@example.com"]);
  await git(workspace, ["remote", "add", "origin", remote]);
  await fs.writeFile(path.join(workspace, "README.md"), "initial\n");
  await git(workspace, ["add", "README.md"]);
  await git(workspace, ["commit", "-m", "initial"]);
  await git(workspace, ["push", "-u", "origin", "main"]);
  await fs.writeFile(path.join(workspace, "knowledge.md"), "approved\n");
  await git(workspace, ["add", "knowledge.md"]);
  await git(workspace, ["commit", "-m", "add knowledge"]);

  try {
    const repository = new WorkspaceRepository(workspace);
    const preview = await repository.requestPublish("conversation");
    assert.equal(preview.clean, true);
    assert.equal(preview.ahead, 1);
    assert.match(preview.commits[0]!, /add knowledge/);

    const published = await repository.confirmPublish("conversation");
    assert.equal(published.ahead, 0);
    await assert.rejects(
      repository.confirmPublish("conversation"),
      /重新发送 Publish/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workspace publication rejects prohibited files from intermediate commits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qq-workspace-history-"));
  const remote = path.join(root, "remote.git");
  const workspace = path.join(root, "workspace");
  await git(root, ["init", "--bare", remote]);
  await fs.mkdir(workspace);
  await git(workspace, ["init", "-b", "main"]);
  await git(workspace, ["config", "user.name", "Test"]);
  await git(workspace, ["config", "user.email", "test@example.com"]);
  await git(workspace, ["remote", "add", "origin", remote]);
  await fs.writeFile(path.join(workspace, "README.md"), "initial\n");
  await git(workspace, ["add", "README.md"]);
  await git(workspace, ["commit", "-m", "initial"]);
  await git(workspace, ["push", "-u", "origin", "main"]);
  await fs.mkdir(path.join(workspace, ".tmp"));
  await fs.writeFile(path.join(workspace, ".tmp", "private.txt"), "private\n");
  await git(workspace, ["add", "-f", ".tmp/private.txt"]);
  await git(workspace, ["commit", "-m", "add temporary file"]);
  await git(workspace, ["rm", ".tmp/private.txt"]);
  await git(workspace, ["commit", "-m", "remove temporary file"]);

  try {
    await assert.rejects(
      new WorkspaceRepository(workspace).requestPublish("conversation"),
      /临时或生成文件不能发布/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workspace publication previews all commits and binds the push remote", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qq-workspace-remote-"));
  const remote = path.join(root, "remote.git");
  const replacement = path.join(root, "replacement.git");
  const workspace = path.join(root, "workspace");
  await git(root, ["init", "--bare", remote]);
  await git(root, ["init", "--bare", replacement]);
  await fs.mkdir(workspace);
  await git(workspace, ["init", "-b", "main"]);
  await git(workspace, ["config", "user.name", "Test"]);
  await git(workspace, ["config", "user.email", "test@example.com"]);
  await git(workspace, ["remote", "add", "origin", remote]);
  await fs.writeFile(path.join(workspace, "README.md"), "initial\n");
  await git(workspace, ["add", "README.md"]);
  await git(workspace, ["commit", "-m", "initial"]);
  await git(workspace, ["push", "-u", "origin", "main"]);
  for (let index = 1; index <= 6; index++) {
    await fs.writeFile(
      path.join(workspace, `knowledge-${index}.md`),
      `${index}\n`,
    );
    await git(workspace, ["add", `knowledge-${index}.md`]);
    await git(workspace, ["commit", "-m", `knowledge ${index}`]);
  }

  try {
    const repository = new WorkspaceRepository(workspace);
    const preview = await repository.requestPublish("conversation");
    assert.equal(preview.commits.length, 6);
    await git(workspace, ["remote", "set-url", "origin", replacement]);
    await assert.rejects(
      repository.confirmPublish("conversation"),
      /远程仓库或上游分支在确认后发生变化/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
  });
}
