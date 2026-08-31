import assert from "node:assert/strict";
import test from "node:test";
import { createInitialConfig, type BotConfig } from "../src/config/schema.js";
import {
  buildMediaUploadBody,
  buildMediaMessageBody,
  buildStreamMessageBody,
  buildTextMessageBody,
  parseStreamMessageResponse,
  QQApiError,
  QQApi,
  type QQSendMediaInput,
  type QQSendStreamInput,
  type QQSendTextInput,
  type QQUploadMediaInput,
} from "../src/qq/api.js";
import { QQSender } from "../src/qq/sender.js";
import {
  renderLatexForQQ,
  renderMarkdownForQQ,
  renderNativeMarkdownForQQ,
  splitMarkdown,
  splitText,
} from "../src/qq/format.js";
import type { PreparedArtifact } from "../src/artifacts/file.js";
import type { QQInboundMessage } from "../src/qq/types.js";

test("QQ replies split at natural boundaries", () => {
  assert.deepEqual(splitText("one two three", 7), ["one two", "three"]);
  assert.deepEqual(splitText("short", 10), ["short"]);
  assert.deepEqual(splitText("123456😀", 7), ["123456", "😀"]);
  assert.deepEqual(splitText("😀x", 1), ["😀", "x"]);
});

test("delayed streaming diagnostic can compare wakeup behavior", async () => {
  const { sender, streams } = senderFixture();
  const pauses: number[] = [];

  await sender.runStreamingDiagnostic(inboundMessage(), {
    delayMinutes: 10,
    isWakeup: true,
    pause: async (milliseconds) => {
      pauses.push(milliseconds);
    },
  });

  assert.deepEqual(pauses, [600_000]);
  assert.deepEqual(streams.map(({ index }) => index), [0, 1]);
  assert.deepEqual(streams.map(({ state }) => state), [1, 10]);
  assert.ok(streams.every(({ isWakeup }) => isWakeup === true));
});

test("stopping the sender cancels a delayed streaming diagnostic", async () => {
  const { sender, streams } = senderFixture();
  const diagnostic = sender.runStreamingDiagnostic(inboundMessage(), {
    delayMinutes: 10,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  sender.stop();
  await diagnostic;

  assert.equal(streams.length, 1);
  assert.equal(streams[0]!.state, 1);
});

test("delayed diagnostics report expiry without automatic recovery", async () => {
  const { sender, streams } = senderFixture({}, async (input) => {
    if (input.index === 1) {
      throw new QQApiError("stream send", 400, 40034020, "trace-test");
    }
    return { id: "diagnostic-stream" };
  });

  await assert.rejects(
    sender.runStreamingDiagnostic(inboundMessage(), {
      delayMinutes: 1,
      pause: async () => {},
    }),
    /code 40034020/,
  );

  assert.deepEqual(streams.map(({ sequence, index }) => ({ sequence, index })), [
    { sequence: 1, index: 0 },
    { sequence: 1, index: 1 },
  ]);
});

test("channel-compatible plain text avoids decorative Markdown simulation", () => {
  const markdown = [
    "# Result",
    "",
    "**Bold** and `code`; [docs](https://example.com).",
    "> quoted",
    "",
    "```ts",
    "const answer = 42;",
    "```",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| answer | **42** |",
  ].join("\n");

  assert.equal(
    renderMarkdownForQQ(markdown),
    [
      "Result",
      "",
      "Bold and code; docs (https://example.com).",
      "> quoted",
      "",
      "Code (ts):",
      "const answer = 42;",
      "",
      "Name | Value",
      "answer | 42",
    ].join("\n"),
  );
});

test("plain text keeps code copy-safe without brackets or Unicode frames", () => {
  assert.equal(
    renderMarkdownForQQ(
      "Run `bin/tool --flag=[x]`, then keep ``a ` b`` unchanged.",
    ),
    "Run bin/tool --flag=[x], then keep a ` b unchanged.",
  );

  assert.equal(
    renderMarkdownForQQ(
      [
        "```bash",
        "printf '%s\\n' \"a[b]\"",
        "  indented();",
        "",
        "```not-a-closing-fence",
        "```",
        "",
        "~~~",
        "plain <tag> & punctuation!",
        "~~~",
        "",
        "```text",
        "```",
      ].join("\n"),
    ),
    [
      "Code (bash):",
      "printf '%s\\n' \"a[b]\"",
      "  indented();",
      "",
      "```not-a-closing-fence",
      "",
      "Code:",
      "plain <tag> & punctuation!",
      "",
      "Code (text):",
    ].join("\n"),
  );
});

test("LaTeX remains readable in native and plain QQ output", () => {
  const formula = String.raw`\[
match(x,g)=\text{x与猜测g在相同位置上数字相同的个数}
\]`;

  assert.equal(
    renderMarkdownForQQ(formula),
    [
      "Formula:",
      "match(x, g) = x与猜测g在相同位置上数字相同的个数",
    ].join("\n"),
  );
  assert.equal(
    renderMarkdownForQQ(
      String.raw`Score \(x_i \geq \frac{1}{2}\); area is $r^2 \times \pi$.`,
    ),
    "Score xᵢ ≥ 1 / 2; area is r² × π.",
  );
  assert.equal(
    renderLatexForQQ(String.raw`\sqrt{x^2 + y^2} \approx 1`),
    "√(x² + y²) ≈ 1",
  );
  assert.equal(
    renderMarkdownForQQ("Tickets cost $5 and $10."),
    "Tickets cost $5 and $10.",
  );
  assert.equal(
    renderMarkdownForQQ("Use `\\[x^2\\]` literally."),
    "Use \\[x^2\\] literally.",
  );
  assert.equal(
    renderMarkdownForQQ(["```tex", "$$x^2$$", "```"].join("\n")),
    ["Code (tex):", "$$x^2$$"].join("\n"),
  );
  assert.equal(
    renderNativeMarkdownForQQ(
      [
        "# Score",
        "",
        String.raw`Value \(x_i \geq \frac{1}{2}\).`,
        "",
        formula,
        "",
        "```tex",
        "$$x^2$$",
        "```",
      ].join("\n"),
    ),
    [
      "# Score",
      "",
      "Value xᵢ ≥ 1 / 2.",
      "",
      "match(x, g) = x与猜测g在相同位置上数字相同的个数",
      "",
      "```tex",
      "$$x^2$$",
      "```",
    ].join("\n"),
  );
});

test("direct replies use one official QQ stream from first update through completion", async () => {
  const { sender, sent, streams } = senderFixture();
  const reply = sender.createReply(inboundMessage());

  await reply.write("# Overview\n\nFirst");
  await waitForStreamUpdate();
  await reply.write(" answer.");
  await waitForStreamUpdate();
  await reply.finish();

  assert.equal(sent.length, 0);
  assert.deepEqual(
    streams.map((stream) => ({
      text: stream.text,
      replyToId: stream.replyToId,
      sequence: stream.sequence,
      index: stream.index,
      state: stream.state,
      contentType: stream.contentType,
      streamMessageId: stream.streamMessageId,
    })),
    [
      {
        text: "# Overview\n\nFirst",
        replyToId: "inbound",
        sequence: 1,
        index: 0,
        state: 1,
        contentType: "markdown",
        streamMessageId: undefined,
      },
      {
        text: "# Overview\n\nFirst answer.",
        replyToId: "inbound",
        sequence: 1,
        index: 1,
        state: 1,
        contentType: "markdown",
        streamMessageId: "stream-inbound",
      },
      {
        text: "# Overview\n\nFirst answer.\n\n🔚",
        replyToId: "inbound",
        sequence: 1,
        index: 2,
        state: 10,
        contentType: "markdown",
        streamMessageId: "stream-inbound",
      },
    ],
  );
});

test("official direct streams ignore the legacy text chunk limit", async () => {
  const { sender, sent, streams } = senderFixture({
    textChunkLimit: 100,
  });
  const reply = sender.createReply(inboundMessage());
  const response = `# Long answer\n\n${"x".repeat(500)}`;

  await reply.write(response);
  await reply.finish();

  assert.equal(sent.length, 0);
  assert.equal(streams.length, 2);
  assert.deepEqual(streams.map((frame) => frame.state), [1, 10]);
  assert.deepEqual(streams.map((frame) => frame.index), [0, 1]);
  assert.equal(streams[0]!.streamMessageId, undefined);
  assert.equal(streams[1]!.streamMessageId, "stream-inbound");
  assert.match(streams[1]!.text, /^# Long answer\n\nx{500}/);
  assert.doesNotMatch(streams[1]!.text, /truncated/i);
});

test("streaming diagnostic bypasses ACP and emits visible timed frames", async () => {
  const { sender, streams, logs } = senderFixture({
    markdownMode: "plain",
    streamResponses: false,
  });
  const pauses: number[] = [];

  await sender.runStreamingDiagnostic(
    inboundMessage(),
    {
      pause: async (milliseconds) => {
        pauses.push(milliseconds);
      },
    },
  );

  assert.deepEqual(pauses, [1_000, 1_000, 1_000]);
  assert.deepEqual(streams.map(({ index }) => index), [0, 1, 2, 3]);
  assert.deepEqual(streams.map(({ state }) => state), [1, 1, 1, 10]);
  assert.ok(streams.every(({ contentType }) => contentType === "markdown"));
  assert.ok(streams.slice(1).every(
    ({ streamMessageId }) => streamMessageId === "stream-inbound",
  ));
  assert.ok(streams.every(
    ({ replyToId, sequence }) => replyToId === "inbound" && sequence === 1,
  ));
  assert.match(streams[0]!.text, /1\. First generating frame accepted\.$/);
  assert.match(streams[1]!.text, /2\. Second generating frame accepted/);
  assert.match(streams[2]!.text, /3\. Third generating frame accepted/);
  assert.match(streams[3]!.text, /3\. Third generating frame accepted[\s\S]*🔚$/);
  assert.equal(
    logs.filter((entry) => entry.includes("frame accepted")).length,
    4,
  );
  assert.ok(logs.every((entry) => !entry.includes(streams[0]!.text)));

  await assert.rejects(
    sender.runStreamingDiagnostic(inboundMessage("group"), {
      pause: async () => {},
    }),
    /require a direct chat/,
  );
});

test("remain_msg_len is pending telemetry and never stops a QQ stream", async () => {
  const { sender, streams, logs } = senderFixture({}, async (input) => ({
    id: `stream-${input.replyToId}`,
    pendingCharacters: [0, 17, 4, 0][input.index],
  }));

  await sender.runStreamingDiagnostic(inboundMessage(), {
    pause: async () => {},
  });

  assert.deepEqual(streams.map(({ index }) => index), [0, 1, 2, 3]);
  assert.deepEqual(streams.map(({ state }) => state), [1, 1, 1, 10]);
  assert.deepEqual(
    logs
      .filter((entry) => entry.includes("frame accepted"))
      .map((entry) => entry.match(/pending=(\d+)$/)?.[1]),
    ["0", "17", "4", "0"],
  );
  assert.match(streams.at(-1)!.text, /🔚$/);
});

test("direct streaming preserves Markdown and LaTeX across ACP delta boundaries", async () => {
  const { sender, streams } = senderFixture();
  const reply = sender.createReply(inboundMessage());

  await reply.write("# Result\n\n\\[\nmatch(x,g)=\\text{x");
  await waitForStreamUpdate();
  assert.equal(streams.length, 1);
  assert.equal(streams[0]!.text, "# Result");

  await reply.write("与猜测g相同的个数}\n\\]\n\n```ts\nconst x =");
  await waitForStreamUpdate();
  assert.equal(streams.length, 2);
  assert.equal(
    streams[1]!.text,
    "# Result\n\nmatch(x, g) = x与猜测g相同的个数",
  );

  await reply.write(" 1;\n```\n");
  await reply.finish();
  assert.match(
    streams.at(-1)!.text,
    /match\(x, g\) = x与猜测g相同的个数\n\n```ts\nconst x = 1;\n```/,
  );
  assert.equal(streams.at(-1)!.state, 10);
});

test("direct streaming handles a LaTeX opener split after its backslash", async () => {
  const { sender, streams } = senderFixture();
  const reply = sender.createReply(inboundMessage());

  await reply.write("Value: \\");
  await waitForStreamUpdate();
  assert.equal(streams[0]!.text, "Value:");

  await reply.write("(x^2");
  await waitForStreamUpdate();
  assert.equal(streams.length, 1);

  await reply.write("\\) done");
  await reply.finish();
  assert.match(streams.at(-1)!.text, /^Value: x² done/);
  assert.equal(streams.at(-1)!.state, 10);
});

test("direct streaming waits for lookahead after an inline-dollar close", async () => {
  const { sender, streams } = senderFixture();
  const reply = sender.createReply(inboundMessage());

  await reply.write("Value $x$");
  await waitForStreamUpdate();
  assert.equal(streams[0]!.text, "Value");

  await reply.write("2");
  await waitForStreamUpdate();
  assert.equal(streams.length, 1);

  await reply.finish();
  assert.match(streams.at(-1)!.text, /^Value \$x\$2/);
  assert.equal(streams.at(-1)!.state, 10);
});

test("long native Markdown splits into valid fenced code and list chunks", () => {
  const codeLines = Array.from(
    { length: 8 },
    (_, index) => `const value${index} = "${"x".repeat(25)}";`,
  );
  const codeChunks = splitMarkdown(
    ["```ts", ...codeLines, "```"].join("\n"),
    100,
  );
  assert.ok(codeChunks.length > 1);
  assert.ok(codeChunks.every((chunk) => chunk.length <= 100));
  assert.ok(codeChunks.every((chunk) => /^```ts\n[\s\S]*\n```$/.test(chunk)));
  assert.deepEqual(
    codeChunks.flatMap((chunk) => chunk.split("\n").slice(1, -1)),
    codeLines,
  );

  const list = [
    "# Tasks",
    "",
    ...Array.from(
      { length: 8 },
      (_, index) => `${index + 1}. Item ${index + 1}: ${"x".repeat(25)}`,
    ),
    "    - nested child",
  ].join("\n");
  const listChunks = splitMarkdown(list, 100);
  assert.ok(listChunks.every((chunk) => chunk.length <= 100));
  assert.equal(listChunks.join("\n"), list);
  assert.ok(
    listChunks.slice(1).every((chunk) => /^\d+\. /.test(chunk)),
  );
  assert.match(listChunks.at(-1)!, /\n    - nested child$/);
});

test("group fallback batching splits lists only between top-level items", async () => {
  const { sender, sent } = senderFixture({
    textChunkLimit: 180,
    streamMinChars: 100,
  });
  const reply = sender.createReply(inboundMessage("group"));
  const firstItem = `1. First item ${"x".repeat(90)}\n    - nested detail\n`;
  const secondItem = `2. Second item ${"y".repeat(80)}\n\n`;

  await reply.write(`# Steps\n\n${firstItem}${secondItem}`);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.text, `# Steps\n\n${firstItem.trimEnd()}`);
  assert.equal(sent[0]!.markdown, true);

  await reply.finish();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.text, secondItem.trim());
  assert.deepEqual(sent.map(({ sequence }) => sequence), [1, 2]);
});

test("long-running group results resume on the next inbound message", async () => {
  let now = 0;
  const { sender, sent } = senderFixture({}, undefined, () => now);
  const reply = sender.createReply(inboundMessage("group"));

  await reply.sendProgress("Task accepted");
  now = 5 * 60 * 1000;
  await reply.write("Task complete");
  await reply.finish();

  assert.equal(sent[0]?.replyToId, "inbound");
  assert.equal(sent[0]?.sequence, 1);
  assert.equal(sent.length, 1);

  assert.equal(
    await sender.deliverPending(inboundMessage("group", "fresh")),
    1,
  );
  assert.equal(sent[1]?.replyToId, "fresh");
  assert.equal(sent[1]?.sequence, 1);
  assert.equal(
    sent[1]?.text,
    "检测到上次任务已有待发送结果，正在补发。\n\nTask complete",
  );
});

test("expired group heartbeats are skipped instead of sent actively", async () => {
  let now = 0;
  const { sender, sent } = senderFixture({}, undefined, () => now);
  const reply = sender.createReply(inboundMessage("group"));

  await reply.sendProgress("Task accepted");
  now = 5 * 60 * 1000;
  await reply.sendProgress("Still running");

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.replyToId, "inbound");
  assert.equal(sent[0]?.sequence, 1);
  assert.equal(reply.getLastDeliveryAt(), 0);
});

test("expired direct heartbeats are skipped instead of sent actively", async () => {
  let now = 0;
  const { sender, sent } = senderFixture({}, undefined, () => now);
  const reply = sender.createReply(inboundMessage());

  await reply.sendProgress("Task accepted");
  now = 5 * 60 * 1000;
  await reply.sendProgress("Still running");

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.replyToId, "inbound");
  assert.equal(sent[0]?.sequence, 1);
});

test("long-running direct streams start with wakeup enabled", async () => {
  let now = 0;
  const { sender, streams } = senderFixture({}, undefined, () => now);
  const reply = sender.createReply(inboundMessage());

  await reply.sendProgress("Task accepted");
  now = 5 * 60 * 1000;
  await reply.write("Task complete");
  await reply.finish();

  assert.ok(streams.length >= 2);
  assert.ok(streams.every(({ isWakeup }) => isWakeup === true));
  assert.ok(streams.every(({ sequence }) => sequence === 2));
});

test("QQ passive replies are capped and visibly truncated", async () => {
  const { sender, sent } = senderFixture({
    textChunkLimit: 100,
    streamResponses: false,
  });

  await sender.reply(inboundMessage("group"), "x".repeat(650));

  assert.equal(sent.length, 5);
  assert.deepEqual(sent.map((message) => message.sequence), [1, 2, 3, 4, 5]);
  assert.match(sent[4]!.text, /Response truncated/);
  assert.ok(sent.every((message) => message.text.length <= 100));
});

test("non-streaming direct fallback uses the official four-reply limit", async () => {
  const { sender, sent } = senderFixture({
    textChunkLimit: 100,
    streamResponses: false,
  });

  await sender.reply(inboundMessage(), "x".repeat(650));

  assert.equal(sent.length, 4);
  assert.deepEqual(sent.map((message) => message.sequence), [1, 2, 3, 4]);
  assert.match(sent[3]!.text, /Response truncated/);
});

test("truncation keeps the final native fenced-code chunk valid", async () => {
  const { sender, sent } = senderFixture({
    textChunkLimit: 100,
    streamResponses: false,
  });
  const response = [
    "```js",
    ...Array.from(
      { length: 20 },
      (_, index) => `const value${index} = "${"x".repeat(25)}";`,
    ),
    "```",
  ].join("\n");

  await sender.reply(inboundMessage("group"), response);

  assert.equal(sent.length, 5);
  assert.ok(sent.every(({ text, markdown }) => text.length <= 100 && markdown));
  assert.match(
    sent[4]!.text,
    /^```js\n[\s\S]*\n```\n\nResponse truncated:/,
  );
});

test("direct and group Markdown use QQ msg_type 2 payloads", () => {
  for (const chatType of ["direct", "group"] as const) {
    assert.deepEqual(
      buildTextMessageBody({
        chatType,
        targetId: "target",
        text: "# Title",
        replyToId: "message",
        sequence: 2,
        markdown: true,
      }),
      {
        msg_type: 2,
        markdown: { content: "# Title" },
        msg_id: "message",
        msg_seq: 2,
      },
    );
  }

  assert.deepEqual(
    buildTextMessageBody({
      chatType: "group",
      targetId: "target",
      text: "# Completed",
      markdown: true,
    }),
    {
      msg_type: 2,
      markdown: { content: "# Completed" },
    },
  );
});

test("active group media messages omit passive reply identifiers", () => {
  assert.deepEqual(
    buildMediaMessageBody({
      chatType: "group",
      targetId: "target",
      fileInfo: "file",
    }),
    {
      content: " ",
      msg_type: 7,
      media: { file_info: "file" },
    },
  );
});

test("QQ stream request bodies and responses follow the official contract", () => {
  const base: QQSendStreamInput = {
    targetId: "user",
    text: "# Answer",
    replyToId: "inbound",
    sequence: 2,
    index: 0,
    state: 1,
    contentType: "markdown",
  };
  assert.deepEqual(buildStreamMessageBody(base), {
    input_mode: "replace",
    input_state: 1,
    index: 0,
    content_type: "markdown",
    content_raw: "# Answer",
    msg_id: "inbound",
    msg_seq: 2,
  });

  assert.deepEqual(
    buildStreamMessageBody({
      ...base,
      text: "# Answer\n\nDone",
      index: 1,
      state: 10,
      streamMessageId: "stream-1",
      isWakeup: true,
    }),
    {
      input_mode: "replace",
      input_state: 10,
      index: 1,
      content_type: "markdown",
      content_raw: "# Answer\n\nDone",
      msg_id: "inbound",
      stream_msg_id: "stream-1",
      msg_seq: 2,
      is_wakeup: true,
    },
  );
  assert.deepEqual(
    parseStreamMessageResponse({ id: "stream-1", remain_msg_len: 1234 }),
    { id: "stream-1", pendingCharacters: 1234 },
  );
  assert.throws(
    () => parseStreamMessageResponse({ remain_msg_len: 1234 }),
    /did not include a message ID/,
  );
  assert.throws(
    () => parseStreamMessageResponse({ id: "stream-1", remain_msg_len: -1 }),
    /invalid remaining length/,
  );
});

test("QQ API posts stream frames to the direct stream endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/getAppAccessToken")) {
      return new Response(JSON.stringify({
        access_token: "token",
        expires_in: 7200,
      }), { status: 200 });
    }
    requests.push({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({
      id: "stream-1",
      remain_msg_len: 999,
    }), { status: 200 });
  };

  try {
    const response = await new QQApi("app", "secret").sendStream({
      targetId: "user/with/slash",
      text: "Answer",
      replyToId: "inbound",
      sequence: 1,
      index: 0,
      state: 1,
      contentType: "markdown",
    });
    assert.deepEqual(response, {
      id: "stream-1",
      pendingCharacters: 999,
    });
    assert.equal(
      requests[0]?.url,
      "https://api.sgroup.qq.com/v2/users/user%2Fwith%2Fslash/stream_messages",
    );
    assert.deepEqual(requests[0]?.body, {
      input_mode: "replace",
      input_state: 1,
      index: 0,
      content_type: "markdown",
      content_raw: "Answer",
      msg_id: "inbound",
      msg_seq: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("QQ API requires a message ID to confirm delivery acceptance", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/getAppAccessToken")) {
      return new Response(JSON.stringify({
        access_token: "token",
        expires_in: 7200,
      }), { status: 200 });
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const api = new QQApi("app", "secret");
    await assert.rejects(
      api.sendText({
        chatType: "group",
        targetId: "group",
        text: "result",
        replyToId: "inbound",
        sequence: 1,
      }),
      /missing-message-id/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("QQ API preserves privacy-safe stream error diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/getAppAccessToken")) {
      return new Response(JSON.stringify({
        access_token: "token",
        expires_in: 7200,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      code: 40034020,
      message: "stream content rejected\nby platform",
      trace_id: "trace-from-body",
    }), {
      status: 400,
      headers: { "x-tps-trace-id": "trace-from-header" },
    });
  };

  try {
    await assert.rejects(
      () => new QQApi("app", "secret").sendStream({
        targetId: "user",
        text: "private response",
        replyToId: "inbound",
        sequence: 1,
        index: 5,
        state: 1,
        contentType: "markdown",
        streamMessageId: "stream-1",
      }),
      (error: unknown) => {
        assert.ok(error instanceof QQApiError);
        assert.equal(error.status, 400);
        assert.equal(error.code, 40034020);
        assert.equal(error.traceId, "trace-from-header");
        assert.doesNotMatch(
          error.message,
          /private response|stream content rejected/,
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interleaved turns retain their own inbound and stream message IDs", async () => {
  const { sender, streams } = senderFixture();
  const first = sender.createReply(inboundMessage("direct", "inbound-a", "user-a"));
  const second = sender.createReply(inboundMessage("direct", "inbound-b", "user-b"));

  await Promise.all([first.write("First"), second.write("Second")]);
  await waitForStreamUpdate();
  await Promise.all([first.write(" A"), second.write(" B")]);
  await waitForStreamUpdate();
  await Promise.all([first.finish(), second.finish()]);

  const firstFrames = streams.filter((frame) => frame.replyToId === "inbound-a");
  const secondFrames = streams.filter((frame) => frame.replyToId === "inbound-b");
  assert.deepEqual(firstFrames.map((frame) => frame.targetId), [
    "user-a", "user-a", "user-a",
  ]);
  assert.deepEqual(secondFrames.map((frame) => frame.targetId), [
    "user-b", "user-b", "user-b",
  ]);
  assert.ok(firstFrames.slice(1).every(
    (frame) => frame.streamMessageId === "stream-inbound-a",
  ));
  assert.ok(secondFrames.slice(1).every(
    (frame) => frame.streamMessageId === "stream-inbound-b",
  ));
});

test("raw and native modes preserve supported Markdown syntax", async () => {
  const response = "# Title\n\nUse `bin/tool`.\n\n```sh\necho ok\n```";

  for (const markdownMode of ["raw", "native"] as const) {
    const { sender, sent } = senderFixture({
      markdownMode,
      streamResponses: false,
    });
    await sender.reply(inboundMessage(), response);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.text, response);
    assert.equal(sent[0]!.markdown, markdownMode === "native");
  }
});

test("channels use the explicit plain-text compatibility path", async () => {
  const { sender, sent } = senderFixture({ streamResponses: false });
  await sender.reply(
    inboundMessage("channel"),
    "# Title\n\n**Bold** and `code`.\n\n```sh\necho ok\n```",
  );

  assert.deepEqual(
    sent.map(({ text, markdown }) => ({ text, markdown })),
    [{
      text: "Title\n\nBold and code.\n\nCode (sh):\necho ok",
      markdown: false,
    }],
  );
});

test("send failures propagate without a duplicate fallback reply", async () => {
  const config = createInitialConfig({
    appId: "app",
    clientSecretFile: "/unused",
    agentCommand: "agent",
  });
  let attempts = 0;
  const sender = new QQSender(
    {
      sendText: async () => {
        attempts++;
        throw new Error("QQ rejected Markdown");
      },
      sendStream: async () => {
        attempts++;
        throw new Error("QQ rejected stream");
      },
      uploadMedia: async () => "unused",
      sendMedia: async () => "unused",
    },
    () => config,
  );

  await assert.rejects(
    sender.reply(inboundMessage(), "# One reply"),
    /QQ rejected stream/,
  );
  assert.equal(attempts, 1);
});

test("stream update failures surface without sending a fallback reply", async () => {
  let attempts = 0;
  const { sender, sent, logs } = senderFixture({}, async () => {
    attempts++;
    throw new Error("QQ stream unavailable with sensitive response");
  });
  const reply = sender.createReply(inboundMessage());

  await reply.write("Partial");
  await waitForStreamUpdate();
  await assert.rejects(reply.finish(), /QQ stream unavailable/);
  assert.equal(attempts, 1);
  assert.equal(sent.length, 0);
  assert.match(logs.at(-1)!, /error=request-error$/);
  assert.doesNotMatch(logs.at(-1)!, /sensitive response/);
});

test("an explicit QQ length rejection surfaces without local truncation", async () => {
  const { sender, sent, streams, logs } = senderFixture({}, async (input) => {
    if (input.index === 1) {
      throw new Error("QQ stream send failed (400; code 40054007)");
    }
    return {
      id: `stream-${input.replyToId}`,
      pendingCharacters: 0,
    };
  });
  const reply = sender.createReply(inboundMessage());

  await reply.write("start");
  await waitForStreamUpdate();
  await reply.write("x".repeat(200));
  await waitForStreamUpdate();

  await assert.rejects(reply.finish(), /code 40054007/);
  assert.equal(sent.length, 0);
  assert.deepEqual(streams.map(({ index }) => index), [0, 1]);
  assert.match(streams[1]!.text, /^startx{200}$/);
  assert.match(logs.at(-1)!, /error=http-400$/);
});

test("expired stream failures restart once with a wakeup stream", async () => {
  let expired = false;
  const { sender, streams, logs } = senderFixture({}, async (input) => {
    if (input.sequence === 1 && input.index === 1 && !expired) {
      expired = true;
      throw new QQApiError(
        "stream send",
        400,
        40034020,
        "trace-123",
      );
    }
    return {
      id: `stream-${input.sequence}`,
      pendingCharacters: 0,
    };
  });
  const reply = sender.createReply(inboundMessage());

  await reply.write("start");
  await waitForStreamUpdate();
  await reply.write("追加");
  await waitForStreamUpdate();
  await reply.finish();

  assert.deepEqual(
    streams.map(({ sequence, index, state, isWakeup }) => ({
      sequence,
      index,
      state,
      isWakeup,
    })),
    [
      { sequence: 1, index: 0, state: 1, isWakeup: false },
      { sequence: 1, index: 1, state: 1, isWakeup: false },
      { sequence: 2, index: 0, state: 1, isWakeup: true },
      { sequence: 2, index: 1, state: 10, isWakeup: true },
    ],
  );
  assert.match(
    streams[2]!.text,
    /^QQ stream resumed after an idle timeout[\s\S]*start追加$/,
  );
  assert.ok(
    logs.some((entry) =>
      entry.includes("strategy=new-wakeup-stream"),
    ),
  );
});

test("stream failure logs distinguish size, timing, and QQ metadata", async () => {
  const { sender, logs } = senderFixture({}, async (input) => {
    if (input.index === 1 || input.sequence === 2) {
      throw new QQApiError(
        "stream send",
        400,
        40034020,
        "trace-123",
      );
    }
    return {
      id: `stream-${input.replyToId}`,
      pendingCharacters: 0,
    };
  });
  const reply = sender.createReply(inboundMessage());

  await reply.write("start");
  await waitForStreamUpdate();
  await reply.write("追加");
  await waitForStreamUpdate();

  await assert.rejects(reply.finish(), /code 40034020/);
  const failure = logs.find((entry) =>
    entry.includes("frame failed") &&
    entry.includes("index=1 state=1 chars=7"),
  )!;
  assert.match(failure, /index=1 state=1 chars=7 deltaChars=2 bytes=11/);
  assert.match(
    failure,
    /idleMs=\d+ streamAgeMs=\d+ contentType=markdown streamStarted=true/,
  );
  assert.match(failure, /error=http-400 qqCode=40034020/);
  assert.match(failure, /qqTrace=trace-123/);
  assert.doesNotMatch(failure, /start追加|content rejected/);
});

test("stream ID mismatch errors do not expose either QQ message ID", async () => {
  const { sender } = senderFixture({}, async (input) => ({
    id: input.index === 0 ? "sensitive-stream-a" : "sensitive-stream-b",
    pendingCharacters: 0,
  }));
  const reply = sender.createReply(inboundMessage());

  await reply.write("start");
  await waitForStreamUpdate();
  await reply.write(" more");
  await waitForStreamUpdate();

  await assert.rejects(
    reply.finish(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /changed the stream message ID/);
      assert.doesNotMatch(
        error.message,
        /sensitive-stream-a|sensitive-stream-b/,
      );
      return true;
    },
  );
});

test("plain compatibility rendering waits for a prefix-safe final frame", async () => {
  const { sender, streams } = senderFixture({ markdownMode: "plain" });
  const reply = sender.createReply(inboundMessage());

  await reply.write("**bold");
  await waitForStreamUpdate();
  assert.equal(streams.length, 0);
  await reply.write("** and `code`");
  await waitForStreamUpdate();
  assert.equal(streams.length, 0);
  await reply.finish();

  assert.equal(streams.length, 2);
  assert.equal(streams[0]!.contentType, "text");
  assert.deepEqual(streams.map((frame) => frame.state), [1, 10]);
  assert.equal(streams[0]!.text, "bold and code");
  assert.equal(streams[1]!.text, "bold and code\n\n🔚");
});

test("QQ artifact uploads and media payloads use rich-media messages", () => {
  for (const fileType of [1, 2, 3] as const) {
    assert.deepEqual(buildMediaUploadBody(Buffer.from([0, 1, 2]), fileType), {
      file_type: fileType,
      file_data: "AAEC",
      srv_send_msg: false,
    });
  }
  assert.deepEqual(
    buildMediaUploadBody(
      Buffer.from([0, 1, 2]),
      4,
      "report: 2026.pdf",
    ),
    {
      file_type: 4,
      file_data: "AAEC",
      file_name: "report_ 2026.pdf",
      srv_send_msg: false,
    },
  );
  assert.throws(
    () => buildMediaUploadBody(Buffer.from([0, 1, 2]), 4),
    /require a file name/,
  );
  assert.deepEqual(
    buildMediaMessageBody({
      chatType: "group",
      targetId: "group",
      fileInfo: "uploaded-file",
      replyToId: "inbound",
      sequence: 3,
      caption: " Chart ",
    }),
    {
      content: "Chart",
      msg_type: 7,
      media: { file_info: "uploaded-file" },
      msg_id: "inbound",
      msg_seq: 3,
    },
  );
});

test("ordinary artifacts preserve their file name and use QQ file uploads", async () => {
  const { sender, uploads, media } = senderFixture({ streamResponses: false });
  const reply = sender.createReply(inboundMessage());

  await reply.sendArtifact(artifact("document", "report.pdf"), "Final report");
  await reply.finish();

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.fileType, 4);
  assert.equal(uploads[0]?.fileName, "report.pdf");
  assert.equal(media[0]?.caption, "Final report");
});

test("deferred delivery retries transient failures with a stable sequence", async () => {
  const config = createInitialConfig({
    appId: "app",
    clientSecretFile: "/unused",
    agentCommand: "agent",
  });
  let now = 0;
  let attempts = 0;
  const retried: QQSendTextInput[] = [];
  const pauses: number[] = [];
  const logs: string[] = [];
  const sender = new QQSender(
    {
      sendText: async (input) => {
        if (input.replyToId === "inbound") return "ack";
        retried.push(input);
        attempts++;
        if (attempts === 1) {
          throw new QQApiError("send", 503, "temporary");
        }
        return "confirmed-message";
      },
      sendStream: async () => ({ id: "stream" }),
      uploadMedia: async () => "file",
      sendMedia: async () => "media",
    },
    () => config,
    (message) => logs.push(message),
    () => now,
    async (milliseconds) => {
      pauses.push(milliseconds);
    },
  );
  const reply = sender.createReply(inboundMessage("group"));

  await reply.sendProgress("Task accepted");
  now = 5 * 60 * 1000;
  await reply.write("Task complete");
  await reply.finish();
  assert.equal(
    await sender.deliverPending(inboundMessage("group", "fresh")),
    1,
  );

  assert.equal(attempts, 2);
  assert.deepEqual(pauses, [500]);
  assert.deepEqual(
    retried.map(({ replyToId, sequence, text }) => ({
      replyToId,
      sequence,
      text,
    })),
    [
      {
        replyToId: "fresh",
        sequence: 1,
        text: "检测到上次任务已有待发送结果，正在补发。\n\nTask complete",
      },
      {
        replyToId: "fresh",
        sequence: 1,
        text: "检测到上次任务已有待发送结果，正在补发。\n\nTask complete",
      },
    ],
  );
  assert.ok(logs.some((entry) => entry.includes("retrying attempt=2")));
  assert.ok(logs.some((entry) => entry.includes("item confirmed")));
  assert.ok(logs.every((entry) => !entry.includes("confirmed-message")));
});

test("long-running group artifacts resume on the next inbound message", async () => {
  let now = 0;
  const { sender, media } = senderFixture(
    { streamResponses: false },
    undefined,
    () => now,
  );
  const reply = sender.createReply(inboundMessage("group"));

  await reply.sendProgress("Task accepted");
  now = 5 * 60 * 1000;
  await reply.sendArtifact(artifact("document", "report.pdf"), "Final report");
  await reply.finish();

  assert.equal(media.length, 0);
  assert.equal(
    await sender.deliverPending(inboundMessage("group", "fresh")),
    1,
  );
  assert.equal(media[0]?.replyToId, "fresh");
  assert.equal(media[0]?.sequence, 1);
  assert.equal(media[0]?.caption, "补发结果：Final report");
});

test("deferred artifacts and final text fit one fresh reply window", async () => {
  let now = 0;
  const { sender, sent, media, operations } = senderFixture(
    { streamResponses: false, textChunkLimit: 100 },
    undefined,
    () => now,
  );
  const reply = sender.createReply(inboundMessage("group"));

  await reply.sendProgress("Task accepted");
  now = 5 * 60 * 1000;
  await reply.sendArtifact(artifact("one", "one.pdf"), "One");
  await reply.sendArtifact(artifact("two", "two.pdf"), "Two");
  await reply.write("x".repeat(500));
  await reply.finish();

  assert.equal(sent.length, 1);
  assert.equal(media.length, 0);
  assert.equal(
    await sender.deliverPending(inboundMessage("group", "fresh")),
    5,
  );
  assert.deepEqual(
    operations.slice(1),
    [
      "upload:one",
      "media:1",
      "upload:two",
      "media:2",
      "text:3",
      "text:4",
      "text:5",
    ],
  );
});

test("artifacts share reply sequencing and are deduplicated per turn", async () => {
  const { sender, sent, streams, uploads, media, operations } = senderFixture();
  const reply = sender.createReply(inboundMessage());
  const video = artifact("video", "clip.mp4");
  const voice = artifact("voice", "voice.silk");

  await reply.write(`${"a".repeat(110)}\n\n`);
  await waitForStreamUpdate();
  assert.deepEqual(streams.map(({ sequence }) => sequence), [1]);

  assert.deepEqual(await reply.sendArtifact(video, "**Clip**"), {
    alreadySent: false,
  });
  assert.deepEqual(await reply.sendArtifact(video, "Duplicate"), {
    alreadySent: true,
  });
  assert.deepEqual(await reply.sendArtifact(voice), {
    alreadySent: false,
  });
  await assert.rejects(
    reply.sendArtifact(artifact("third", "third.png")),
    /At most 2 artifacts/,
  );

  await reply.write("Final **answer**.");
  await reply.finish();

  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads.map(({ fileType }) => fileType), [2, 3]);
  assert.deepEqual(media.map(({ sequence }) => sequence), [2, 3]);
  assert.equal(media[0]?.caption, "Clip");
  assert.equal(sent.length, 0);
  assert.ok(streams.every(({ sequence }) => sequence === 1));
  assert.deepEqual(
    operations,
    [
      "stream:1:0",
      "upload:video",
      "media:2",
      "upload:voice",
      "media:3",
      "stream:1:1",
    ],
  );
});

function senderFixture(
  output: Partial<BotConfig["output"]> = {},
  streamResponse?: (
    input: QQSendStreamInput,
  ) => Promise<{ id: string; pendingCharacters?: number }>,
  now?: () => number,
) {
  const config = createInitialConfig({
    appId: "app",
    clientSecretFile: "/unused",
    agentCommand: "agent",
  });
  config.output = { ...config.output, ...output };
  const sent: QQSendTextInput[] = [];
  const streams: QQSendStreamInput[] = [];
  const uploads: QQUploadMediaInput[] = [];
  const media: QQSendMediaInput[] = [];
  const operations: string[] = [];
  const logs: string[] = [];
  const sender = new QQSender(
    {
      sendText: async (input) => {
        sent.push(input);
        operations.push(`text:${input.sequence}`);
        return `message-${sent.length}`;
      },
      sendStream: async (input) => {
        streams.push(input);
        operations.push(`stream:${input.sequence}:${input.index}`);
        return streamResponse
          ? streamResponse(input)
          : {
              id: `stream-${input.replyToId}`,
              pendingCharacters: 0,
            };
      },
      uploadMedia: async (input) => {
        uploads.push(input);
        operations.push(`upload:${input.data.toString()}`);
        return `file-${uploads.length}`;
      },
      sendMedia: async (input) => {
        media.push(input);
        operations.push(`media:${input.sequence}`);
        return `media-${media.length}`;
      },
    },
    () => config,
    (message) => logs.push(message),
    now,
  );
  return { sender, sent, streams, uploads, media, operations, logs };
}

function artifact(digest: string, fileName: string): PreparedArtifact {
  if (fileName.endsWith(".mp4")) {
    return {
      data: Buffer.from(digest),
      digest,
      fileName,
      kind: "video",
      mimeType: "video/mp4",
    };
  }
  if (fileName.endsWith(".silk")) {
    return {
      data: Buffer.from(digest),
      digest,
      fileName,
      kind: "voice",
      mimeType: "audio/silk",
    };
  }
  if (fileName.endsWith(".pdf")) {
    return {
      data: Buffer.from(digest),
      digest,
      fileName,
      kind: "file",
      mimeType: "application/octet-stream",
    };
  }
  return {
    data: Buffer.from(digest),
    digest,
    fileName,
    kind: "image",
    mimeType: fileName.endsWith(".jpg") ? "image/jpeg" : "image/png",
  };
}

function inboundMessage(
  chatType: QQInboundMessage["chatType"] = "direct",
  messageId = "inbound",
  targetId = "user",
): QQInboundMessage {
  return {
    accountId: "app",
    conversationId: "conversation",
    chatType,
    senderId: "user",
    targetId,
    messageId,
    timestamp: "2026-08-27T00:00:00Z",
    text: "hello",
    attachments: [],
  };
}

function waitForStreamUpdate(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 350));
}
