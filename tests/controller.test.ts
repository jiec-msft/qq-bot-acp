import assert from "node:assert/strict";
import test from "node:test";
import { shouldHandleMessage } from "../src/bot/controller.js";
import type { QQInboundMessage } from "../src/qq/types.js";

test("ordinary full-mode group messages never enter Bot behavior", () => {
  const message: QQInboundMessage = {
    accountId: "app",
    conversationId: "conversation",
    chatType: "group",
    senderId: "member",
    targetId: "group",
    messageId: "message",
    timestamp: "2026-08-31T13:56:00+08:00",
    text: "ordinary group chat",
    attachments: [],
    addressed: false,
  };

  assert.equal(shouldHandleMessage(message), false);
  assert.equal(shouldHandleMessage({ ...message, addressed: true }), true);
  assert.equal(shouldHandleMessage({ ...message, addressed: undefined }), true);
});
