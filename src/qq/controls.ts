import {
  QQApiError,
  type QQPanelItem,
  type QQPanelRecord,
  type QQPanelScope,
} from "./api.js";

const PANEL_REMARK_PREFIX = "qq-bot-acp:simple-controls:";

const PANEL_ITEMS: QQPanelItem[] = [
  command("Help", "Show usage"),
  command("New Chat", "Start a new session"),
  command("Stop", "Cancel current task"),
  command("Status", "Show sessions and Git"),
  command("Normal", "Use medium reasoning"),
  command("Deep", "Use max reasoning"),
  command("Learn", "Propose new knowledge"),
  command("Approve", "Apply approved proposal"),
  command("Review", "Review local changes"),
  command("Publish", "Preview Git push"),
  command("Discard", "Discard temporary draft"),
];

export class QQControls {
  private syncChain = Promise.resolve();

  constructor(private readonly api: QQControlApi) {}

  sync(): Promise<void> {
    const run = this.syncChain.then(() => this.syncNow());
    this.syncChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async syncNow(): Promise<void> {
    await this.api.updateMenu([
      {
        type: "send_message",
        name: "Help",
        send_message: "Help",
      },
      {
        type: "send_message",
        name: "New Chat",
        send_message: "New Chat",
      },
    ]);
    await this.ensurePanel("c2c");
    await this.ensurePanel("group");
  }

  private async ensurePanel(scope: QQPanelScope): Promise<void> {
    const remark = `${PANEL_REMARK_PREFIX}${scope}`;
    const existing = (await this.allPanels(scope)).find(
      (record) => record.panel.remark === remark,
    );
    const panel = { items: PANEL_ITEMS, remark };
    if (existing) {
      await retryConcurrentPanelOperation(() =>
        this.api.updatePanel(existing.panel_id, panel),
      );
    } else {
      await retryConcurrentPanelOperation(() =>
        this.api.createPanel(scope, panel),
      );
    }
  }

  private async allPanels(scope: QQPanelScope): Promise<QQPanelRecord[]> {
    const records: QQPanelRecord[] = [];
    let cursor = "";
    while (true) {
      const page = await this.api.listPanels(scope, cursor);
      records.push(...page.records);
      if (page.isEnd) return records;
      cursor = page.nextCursor;
    }
  }
}

export interface QQControlApi {
  updateMenu(items: Record<string, unknown>[]): Promise<void>;
  listPanels(
    scope: QQPanelScope,
    cursor?: string,
  ): Promise<{
    records: QQPanelRecord[];
    nextCursor: string;
    isEnd: boolean;
  }>;
  createPanel(
    scope: QQPanelScope,
    panel: { items: QQPanelItem[]; remark: string },
  ): Promise<string>;
  updatePanel(
    panelId: string,
    panel: { items: QQPanelItem[]; remark: string },
  ): Promise<void>;
}

function command(name: string, desc: string): QQPanelItem {
  return {
    type: "command",
    name,
    desc,
    only_admin: false,
  };
}

async function retryConcurrentPanelOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (const delay of [0, 500, 1_500]) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof QQApiError) || String(error.code) !== "40030009") {
        throw error;
      }
    }
  }
  throw new Error("QQ panel operation remained busy after retries");
}
