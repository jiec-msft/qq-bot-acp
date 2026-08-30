import fs from "node:fs/promises";
import { smokeTestAgent } from "./acp/process.js";
import { SessionManager } from "./acp/session-manager.js";
import { SessionStateStore } from "./acp/state.js";
import { ArtifactBroker } from "./artifacts/broker.js";
import { BotController } from "./bot/controller.js";
import type { BotConfig } from "./config/schema.js";
import { ConfigStore } from "./config/store.js";
import { QQApi } from "./qq/api.js";
import { QQControls } from "./qq/controls.js";
import { QQGateway } from "./qq/gateway.js";
import { QQSender } from "./qq/sender.js";
import { AttachmentStager } from "./uploads/stager.js";
import { WorkspaceRepository } from "./workspace/repository.js";

export class BotRuntime {
  private readonly sessions: SessionManager;
  private readonly gateway: QQGateway;
  private readonly controller: BotController;
  private readonly sender: QQSender;
  private readonly stager: AttachmentStager;

  private constructor(
    config: BotConfig,
    store: ConfigStore,
    api: QQApi,
    private readonly artifacts: ArtifactBroker,
    private readonly log: (message: string) => void,
  ) {
    this.sessions = new SessionManager(
      config,
      new SessionStateStore(store.paths.sessions),
      artifacts,
      log,
    );
    let controller!: BotController;
    const sender = new QQSender(api, () => controller.getConfig(), log);
    this.sender = sender;
    const controls = new QQControls(api);
    this.stager = new AttachmentStager(config.agent.cwd, log);
    controller = new BotController(
      config,
      store,
      this.sessions,
      sender,
      controls,
      this.stager,
      new WorkspaceRepository(config.agent.cwd),
      log,
    );
    this.controller = controller;
    this.gateway = new QQGateway(
      api,
      store.paths.state,
      (message) => controller.handleMessage(message),
      log,
    );
  }

  static async create(
    config: BotConfig,
    store: ConfigStore,
    log: (message: string) => void,
  ): Promise<BotRuntime> {
    const secret = (await fs.readFile(config.qq.clientSecretFile, "utf8")).trim();
    if (!secret) throw new Error(`QQ client secret file is empty: ${config.qq.clientSecretFile}`);
    const api = new QQApi(config.qq.appId, secret);
    await api.getAccessToken();
    const artifacts = new ArtifactBroker(log);
    await artifacts.start();
    const testArtifacts = artifacts.createSession(config.agent.cwd);
    try {
      await smokeTestAgent(
        config.agent,
        [testArtifacts.mcpServer],
        config.sessions.defaultOptions,
      );
      return new BotRuntime(config, store, api, artifacts, log);
    } catch (error) {
      await artifacts.stop();
      throw error;
    } finally {
      testArtifacts.dispose();
    }
  }

  async start(): Promise<void> {
    await this.stager.start();
    this.sessions.start();
    try {
      await this.gateway.start();
      await this.gateway.ready;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.sender.stop();
    await Promise.allSettled([this.gateway.stop(), this.sessions.stop()]);
    await this.artifacts.stop();
  }
}
