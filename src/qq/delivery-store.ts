import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PreparedArtifact } from "../artifacts/file.js";

const STORE_VERSION = 1;
const RECENT_DELIVERY_MS = 30 * 60 * 1000;

export type Delivery =
  | { kind: "text"; text: string; markdown: boolean }
  | { kind: "artifact"; artifact: PreparedArtifact; caption?: string };

export type StoredDelivery =
  | { kind: "text"; text: string; markdown: boolean }
  | {
      kind: "artifact";
      artifact: Omit<PreparedArtifact, "data"> & {
        data?: Buffer;
        dataFile?: string;
      };
      caption?: string;
    };

interface PendingEnvelope {
  batchId: string;
  delivery: StoredDelivery;
}

interface RecentBatch {
  batchId: string;
  deliveredAt: number;
  deliveries: StoredDelivery[];
}

interface DeliveryState {
  version: 1;
  pending: Record<string, PendingEnvelope[]>;
  recent: Record<string, RecentBatch>;
}

export class DeliveryStore {
  private readonly pending = new Map<string, PendingEnvelope[]>();
  private readonly recent = new Map<string, RecentBatch>();
  private mutationChain = Promise.resolve();

  constructor(
    private readonly root?: string,
    private readonly now: () => number = Date.now,
  ) {}

  async start(): Promise<void> {
    await this.mutate(async () => {
      if (!this.root) return;
      await fs.mkdir(this.artifactsRoot(), { recursive: true });
      try {
        const parsed = JSON.parse(
          await fs.readFile(this.stateFile(), "utf8"),
        ) as unknown;
        const state = parseState(parsed);
        for (const [conversationId, deliveries] of Object.entries(state.pending)) {
          this.pending.set(conversationId, deliveries);
        }
        for (const [conversationId, batch] of Object.entries(state.recent)) {
          this.recent.set(conversationId, batch);
        }
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      this.pruneRecent();
      await this.persist();
      await this.gcArtifacts();
    });
  }

  async append(
    conversationId: string,
    batchId: string,
    delivery: Delivery,
  ): Promise<void> {
    const key = storageId(conversationId);
    await this.mutate(async () => {
      const stored = await this.storeDelivery(delivery);
      const pending = this.pending.get(key) ?? [];
      pending.push({ batchId, delivery: stored });
      this.pending.set(key, pending);
      await this.persist();
    });
  }

  async peekPending(
    conversationId: string,
  ): Promise<PendingEnvelope | undefined> {
    await this.mutationChain;
    return this.pending.get(storageId(conversationId))?.[0];
  }

  async confirmPending(conversationId: string): Promise<void> {
    const key = storageId(conversationId);
    await this.mutate(async () => {
      const pending = this.pending.get(key);
      const confirmed = pending?.shift();
      if (!confirmed) return;
      if (pending?.length === 0) this.pending.delete(key);
      const replaced = this.remember(
        key,
        confirmed.batchId,
        confirmed.delivery,
      );
      await this.persist();
      if (replaced) await this.gcArtifacts();
    });
  }

  async rememberDelivered(
    conversationId: string,
    batchId: string,
    delivery: Delivery,
  ): Promise<void> {
    const key = storageId(conversationId);
    await this.mutate(async () => {
      const stored = await this.storeDelivery(delivery);
      const replaced = this.remember(key, batchId, stored);
      await this.persist();
      if (replaced) await this.gcArtifacts();
    });
  }

  async getRecent(conversationId: string): Promise<StoredDelivery[]> {
    const key = storageId(conversationId);
    return this.mutate(async () => {
      const changed = this.pruneRecent();
      if (changed) {
        await this.persist();
        await this.gcArtifacts();
      }
      return [...(this.recent.get(key)?.deliveries ?? [])];
    });
  }

  async clearRecent(conversationId: string): Promise<boolean> {
    const key = storageId(conversationId);
    return this.mutate(async () => {
      const removed = this.recent.delete(key);
      if (!removed) return false;
      await this.persist();
      await this.gcArtifacts();
      return true;
    });
  }

  async status(
    conversationId: string,
  ): Promise<{ pending: number; recent: number }> {
    const key = storageId(conversationId);
    return this.mutate(async () => {
      const changed = this.pruneRecent();
      if (changed) {
        await this.persist();
        await this.gcArtifacts();
      }
      return {
        pending: this.pending.get(key)?.length ?? 0,
        recent: this.recent.get(key)?.deliveries.length ?? 0,
      };
    });
  }

  async artifactData(delivery: StoredDelivery): Promise<Buffer> {
    if (delivery.kind !== "artifact") {
      throw new Error("Text deliveries do not contain artifact data");
    }
    if (delivery.artifact.data) return delivery.artifact.data;
    if (!this.root || !delivery.artifact.dataFile) {
      throw new Error("Persisted artifact data is unavailable");
    }
    return fs.readFile(this.resolveDataFile(delivery.artifact.dataFile));
  }

  private remember(
    conversationId: string,
    batchId: string,
    delivery: StoredDelivery,
  ): boolean {
    const current = this.recent.get(conversationId);
    const replaced = current !== undefined && current.batchId !== batchId;
    const deliveries =
      current?.batchId === batchId ? current.deliveries : [];
    deliveries.push(delivery);
    this.recent.set(conversationId, {
      batchId,
      deliveredAt: this.now(),
      deliveries,
    });
    return replaced;
  }

  private async storeDelivery(delivery: Delivery): Promise<StoredDelivery> {
    if (delivery.kind === "text") return delivery;
    if (!this.root) {
      return {
        ...delivery,
        artifact: { ...delivery.artifact, data: delivery.artifact.data },
      };
    }
    const dataFile = path.join("artifacts", `${delivery.artifact.digest}.bin`);
    const target = this.resolveDataFile(dataFile);
    try {
      await fs.writeFile(target, delivery.artifact.data, { flag: "wx" });
    } catch (error) {
      if (!isExistingFile(error)) throw error;
    }
    const { data: _data, ...metadata } = delivery.artifact;
    return {
      ...delivery,
      artifact: { ...metadata, dataFile },
    };
  }

  private pruneRecent(): boolean {
    let changed = false;
    for (const [conversationId, batch] of this.recent) {
      if (this.now() - batch.deliveredAt >= RECENT_DELIVERY_MS) {
        this.recent.delete(conversationId);
        changed = true;
      }
    }
    return changed;
  }

  private async persist(): Promise<void> {
    if (!this.root) return;
    const state: DeliveryState = {
      version: STORE_VERSION,
      pending: Object.fromEntries(this.pending),
      recent: Object.fromEntries(this.recent),
    };
    const file = this.stateFile();
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(temp, file);
  }

  private async gcArtifacts(): Promise<void> {
    if (!this.root) return;
    const referenced = new Set<string>();
    const collect = (delivery: StoredDelivery): void => {
      if (delivery.kind === "artifact" && delivery.artifact.dataFile) {
        referenced.add(path.resolve(this.root!, delivery.artifact.dataFile));
      }
    };
    for (const deliveries of this.pending.values()) {
      deliveries.forEach(({ delivery }) => collect(delivery));
    }
    for (const batch of this.recent.values()) {
      batch.deliveries.forEach(collect);
    }
    for (const entry of await fs.readdir(this.artifactsRoot(), {
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const candidate = path.resolve(this.artifactsRoot(), entry.name);
      if (!referenced.has(candidate)) await fs.rm(candidate);
    }
  }

  private resolveDataFile(dataFile: string): string {
    if (!/^artifacts[\\/][a-f0-9]{64}\.bin$/.test(dataFile)) {
      throw new Error("Delivery state contains an invalid artifact path");
    }
    return path.resolve(this.root!, dataFile);
  }

  private stateFile(): string {
    return path.join(this.root!, "state.json");
  }

  private artifactsRoot(): string {
    return path.join(this.root!, "artifacts");
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(operation);
    this.mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function parseState(value: unknown): DeliveryState {
  if (!isRecord(value) || value.version !== STORE_VERSION) {
    throw new Error("Unsupported QQ delivery state");
  }
  if (!isRecord(value.pending) || !isRecord(value.recent)) {
    throw new Error("Invalid QQ delivery state");
  }
  for (const deliveries of Object.values(value.pending)) {
    if (!Array.isArray(deliveries)) throw new Error("Invalid pending delivery state");
    deliveries.forEach(parsePendingEnvelope);
  }
  for (const batch of Object.values(value.recent)) parseRecentBatch(batch);
  return value as unknown as DeliveryState;
}

function parsePendingEnvelope(value: unknown): void {
  if (!isRecord(value) || typeof value.batchId !== "string") {
    throw new Error("Invalid pending delivery");
  }
  parseStoredDelivery(value.delivery);
}

function parseRecentBatch(value: unknown): void {
  if (
    !isRecord(value) ||
    typeof value.batchId !== "string" ||
    typeof value.deliveredAt !== "number" ||
    !Array.isArray(value.deliveries)
  ) {
    throw new Error("Invalid recent delivery");
  }
  value.deliveries.forEach(parseStoredDelivery);
}

function parseStoredDelivery(value: unknown): void {
  if (!isRecord(value) || (value.kind !== "text" && value.kind !== "artifact")) {
    throw new Error("Invalid stored delivery");
  }
  if (value.kind === "text") {
    if (typeof value.text !== "string" || typeof value.markdown !== "boolean") {
      throw new Error("Invalid stored text delivery");
    }
    return;
  }
  if (!isRecord(value.artifact)) throw new Error("Invalid stored artifact");
  const artifact = value.artifact;
  if (
    typeof artifact.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.digest) ||
    typeof artifact.fileName !== "string" ||
    typeof artifact.kind !== "string" ||
    typeof artifact.mimeType !== "string" ||
    typeof artifact.dataFile !== "string" ||
    !/^artifacts[\\/][a-f0-9]{64}\.bin$/.test(artifact.dataFile)
  ) {
    throw new Error("Invalid stored artifact");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function storageId(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("hex");
}
