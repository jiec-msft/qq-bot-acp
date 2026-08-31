import assert from "node:assert/strict";
import test from "node:test";
import { inboundMessageDisposition } from "../src/bot/controller.js";
import type { QQInboundMessage } from "../src/qq/types.js";

test("full-mode group messages distinguish real and literal mentions", () => {
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

  assert.equal(inboundMessageDisposition(message), "ignore");
  assert.equal(
    inboundMessageDisposition({ ...message, text: "  @Copilot help me" }),
    "warn-literal-mention",
  );
  assert.equal(
    inboundMessageDisposition({ ...message, text: "@Copilot帮我做题" }),
    "warn-literal-mention",
  );
  assert.equal(
    inboundMessageDisposition({ ...message, text: "Discuss @Copilot later" }),
    "ignore",
  );
  assert.equal(
    inboundMessageDisposition({ ...message, addressed: true }),
    "handle",
  );
  assert.equal(
    inboundMessageDisposition({ ...message, addressed: undefined }),
    "handle",
  );
});
