import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_PUBLISH_FILE_BYTES = 10 * 1024 * 1024;
const PUBLISH_CONFIRMATION_MS = 10 * 60 * 1000;

export interface WorkspaceStatus {
  branch: string;
  head: string;
  upstream?: string;
  ahead: number;
  clean: boolean;
  changes: string[];
  commits: string[];
}

interface PublishConfirmation {
  head: string;
  branch: string;
  upstream: string;
  remoteOid: string;
  remote: string;
  remoteBranch: string;
  pushUrl: string;
  expiresAt: number;
}

export class WorkspaceRepository {
  private readonly confirmations = new Map<string, PublishConfirmation>();
  private publishChain = Promise.resolve();

  constructor(private readonly cwd: string) {}

  async status(): Promise<WorkspaceStatus> {
    await this.assertRepositoryRoot();
    const [branch, head, status] = await Promise.all([
      this.git(["branch", "--show-current"]),
      this.git(["rev-parse", "HEAD"]),
      this.git(["status", "--porcelain=v1"]),
    ]);
    const upstream = await this.gitOptional([
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    const ahead = upstream
      ? Number(await this.git(["rev-list", "--count", `${upstream}..HEAD`]))
      : 0;
    const commits = upstream && ahead > 0
      ? lines(await this.git(["log", "--oneline", `${upstream}..HEAD`]))
      : [];
    return {
      branch,
      head,
      upstream: upstream || undefined,
      ahead,
      clean: !status,
      changes: lines(status),
      commits,
    };
  }

  async requestPublish(conversationId: string): Promise<WorkspaceStatus> {
    const status = await this.status();
    if (!status.clean) {
      throw new Error("工作树仍有未提交改动，不能发布");
    }
    if (!status.upstream) {
      throw new Error("当前分支没有上游分支，不能自动发布");
    }
    if (!status.branch) {
      throw new Error("当前处于 detached HEAD，不能自动发布");
    }
    const { remote, remoteBranch } = parseUpstream(status.upstream);
    const [pushUrl, remoteOid] = await Promise.all([
      this.git(["remote", "get-url", "--push", remote]),
      this.remoteBranchOid(remote, remoteBranch),
    ]);
    await this.assertRemoteAncestor(remoteOid);
    const ahead = Number(
      await this.git(["rev-list", "--count", `${remoteOid}..${status.head}`]),
    );
    if (ahead === 0) {
      throw new Error("没有待发布的本地提交");
    }
    const commits = lines(
      await this.git(["log", "--oneline", `${remoteOid}..${status.head}`]),
    );
    await this.assertPublishFiles(remoteOid, status.head);
    this.confirmations.set(conversationId, {
      head: status.head,
      branch: status.branch,
      upstream: status.upstream,
      remoteOid,
      remote,
      remoteBranch,
      pushUrl,
      expiresAt: Date.now() + PUBLISH_CONFIRMATION_MS,
    });
    return { ...status, ahead, commits };
  }

  confirmPublish(conversationId: string): Promise<WorkspaceStatus> {
    const run = this.publishChain.then(async () => {
      const confirmation = this.confirmations.get(conversationId);
      if (!confirmation || confirmation.expiresAt < Date.now()) {
        this.confirmations.delete(conversationId);
        throw new Error("发布确认已过期，请先重新发送 Publish");
      }
      const status = await this.status();
      if (
        !status.clean ||
        status.head !== confirmation.head ||
        status.branch !== confirmation.branch ||
        status.upstream !== confirmation.upstream
      ) {
        this.confirmations.delete(conversationId);
        throw new Error("仓库在确认后发生变化，请重新发送 Publish");
      }
      let pushUrl: string;
      let remoteOid: string;
      try {
        [pushUrl, remoteOid] = await Promise.all([
          this.git(["remote", "get-url", "--push", confirmation.remote]),
          this.remoteBranchOid(
            confirmation.remote,
            confirmation.remoteBranch,
          ),
        ]);
      } catch {
        this.confirmations.delete(conversationId);
        throw new Error("远程仓库或上游分支在确认后发生变化，请重新发送 Publish");
      }
      if (
        pushUrl !== confirmation.pushUrl ||
        remoteOid !== confirmation.remoteOid
      ) {
        this.confirmations.delete(conversationId);
        throw new Error("远程仓库或上游分支在确认后发生变化，请重新发送 Publish");
      }
      const hooksDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), "qq-bot-acp-hooks-"),
      );
      try {
        await this.git([
          "-c",
          `core.hooksPath=${hooksDirectory}`,
          "push",
          `--force-with-lease=refs/heads/${confirmation.remoteBranch}:${confirmation.remoteOid}`,
          confirmation.remote,
          `${confirmation.head}:refs/heads/${confirmation.remoteBranch}`,
        ]);
      } finally {
        await fs.rm(hooksDirectory, { recursive: true, force: true });
      }
      this.confirmations.delete(conversationId);
      return this.status();
    });
    this.publishChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  clearConfirmation(conversationId: string): void {
    this.confirmations.delete(conversationId);
  }

  private async assertPublishFiles(base: string, head: string): Promise<void> {
    const commits = lines(
      await this.git(["rev-list", "--reverse", `${base}..${head}`]),
    );
    for (const commit of commits) {
      const changed = nulValues(
        await this.gitRaw([
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "--no-renames",
          "--diff-filter=AMCR",
          "-r",
          "-m",
          "-z",
          commit,
        ]),
      );
      for (const file of changed) {
        this.assertPublishPath(file);
        const rawSize = await this.gitOptionalValue([
          "cat-file",
          "-s",
          `${commit}:${file}`,
        ]);
        if (rawSize === undefined) {
          throw new Error(`无法验证待发布文件：${file}`);
        }
        const size = Number(rawSize);
        if (!Number.isFinite(size)) {
          throw new Error(`无法验证待发布文件大小：${file}`);
        }
        if (size > MAX_PUBLISH_FILE_BYTES) {
          throw new Error(`文件超过 10 MB 发布限制：${file}`);
        }
      }
    }
  }

  private assertPublishPath(file: string): void {
    const normalized = file.replace(/\\/g, "/");
    if (
      normalized.startsWith(".tmp/") ||
      (normalized.startsWith("outputs/") &&
        normalized !== "outputs/README.md")
    ) {
      throw new Error(`临时或生成文件不能发布：${file}`);
    }
  }

  private async assertRepositoryRoot(): Promise<void> {
    const root = await this.git(["rev-parse", "--show-toplevel"]);
    const normalizedRoot = root.replace(/\\/g, "/").toLowerCase();
    const normalizedCwd = this.cwd.replace(/\\/g, "/").toLowerCase();
    if (normalizedRoot !== normalizedCwd) {
      throw new Error("Agent cwd 必须是 Git 仓库根目录");
    }
  }

  private async remoteBranchOid(
    remote: string,
    remoteBranch: string,
  ): Promise<string> {
    const result = await this.git([
      "ls-remote",
      "--heads",
      remote,
      `refs/heads/${remoteBranch}`,
    ]);
    const oid = result.split(/\s+/, 1)[0];
    if (!oid || !/^[0-9a-f]{40,64}$/i.test(oid)) {
      throw new Error("无法读取远程分支当前提交");
    }
    return oid;
  }

  private async assertRemoteAncestor(remoteOid: string): Promise<void> {
    try {
      await this.git(["merge-base", "--is-ancestor", remoteOid, "HEAD"]);
    } catch {
      throw new Error(
        "远程分支不是当前 HEAD 的已知祖先，请先 fetch/rebase 后再发布",
      );
    }
  }

  private async git(args: string[]): Promise<string> {
    return (await this.gitRaw(args)).trim();
  }

  private async gitRaw(args: string[]): Promise<string> {
    const result = await execFileAsync("git", args, {
      cwd: this.cwd,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  }

  private async gitOptional(args: string[]): Promise<string> {
    try {
      return await this.git(args);
    } catch {
      return "";
    }
  }

  private async gitOptionalValue(args: string[]): Promise<string | undefined> {
    try {
      return await this.git(args);
    } catch {
      return undefined;
    }
  }
}

function lines(value: string): string[] {
  return value ? value.split(/\r?\n/).filter(Boolean) : [];
}

function nulValues(value: string): string[] {
  return value ? value.split("\0").filter((entry) => entry.length > 0) : [];
}

function parseUpstream(upstream: string): {
  remote: string;
  remoteBranch: string;
} {
  const separator = upstream.indexOf("/");
  if (separator <= 0 || separator === upstream.length - 1) {
    throw new Error("无法解析上游分支");
  }
  return {
    remote: upstream.slice(0, separator),
    remoteBranch: upstream.slice(separator + 1),
  };
}
