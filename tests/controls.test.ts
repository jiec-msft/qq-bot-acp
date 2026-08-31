import assert from "node:assert/strict";
import test from "node:test";
import {
  QQControls,
  type QQControlApi,
} from "../src/qq/controls.js";
import type {
  QQPanelItem,
  QQPanelRecord,
  QQPanelScope,
} from "../src/qq/api.js";

test("QQ controls create simple English menu and panels", async () => {
  const menus: Record<string, unknown>[][] = [];
  const created: Array<{
    scope: QQPanelScope;
    panel: { items: QQPanelItem[]; remark: string };
  }> = [];
  const api: QQControlApi = {
    updateMenu: async (items) => {
      menus.push(items);
    },
    listPanels: async () => ({
      records: [],
      nextCursor: "",
      isEnd: true,
    }),
    createPanel: async (scope, panel) => {
      created.push({ scope, panel });
      return `panel-${scope}`;
    },
    updatePanel: async () => {},
  };

  await new QQControls(api).sync();

  assert.deepEqual(
    menus[0]?.map((item) => item.name),
    ["Help", "New Chat"],
  );
  assert.deepEqual(created.map(({ scope }) => scope), ["c2c", "group"]);
  assert.deepEqual(
    created[0]?.panel.items.map(({ name }) => name),
    [
      "Help",
      "New Chat",
      "Stop",
      "Status",
      "Retry",
      "Seen",
      "Normal",
      "Deep",
      "Learn",
      "Approve",
      "Review",
      "Publish",
      "Discard",
    ],
  );
});

test("QQ controls update an existing managed panel", async () => {
  const updated: string[] = [];
  const existing: QQPanelRecord = {
    panel_id: "existing-c2c",
    scope: "c2c",
    target_type: "all",
    panel: { remark: "qq-bot-acp:simple-controls:c2c" },
  };
  const api: QQControlApi = {
    updateMenu: async () => {},
    listPanels: async (scope) => ({
      records: scope === "c2c" ? [existing] : [],
      nextCursor: "",
      isEnd: true,
    }),
    createPanel: async (scope) => `created-${scope}`,
    updatePanel: async (panelId) => {
      updated.push(panelId);
    },
  };

  await new QQControls(api).sync();
  assert.deepEqual(updated, ["existing-c2c"]);
});

test("QQ control synchronization is serialized within one process", async () => {
  let active = 0;
  let maximum = 0;
  const api: QQControlApi = {
    updateMenu: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    },
    listPanels: async () => ({
      records: [],
      nextCursor: "",
      isEnd: true,
    }),
    createPanel: async (scope) => `created-${scope}`,
    updatePanel: async () => {},
  };
  const controls = new QQControls(api);
  await Promise.all([controls.sync(), controls.sync()]);
  assert.equal(maximum, 1);
});
