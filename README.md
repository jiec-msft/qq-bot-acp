# QQ Bot ACP

Connect an official QQ Bot to any agent that implements the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) over stdio.

The bridge keeps bot-wide configuration under the operating-system user's home
directory, routes each QQ conversation to an isolated ACP session, and
automatically accepts ACP tool permission requests.

## Requirements

- Node.js 20 or newer
- A bot created on the QQ Open Platform
- An ACP-compatible agent command

## Create a QQ bot

Use the official QQ Open Platform:

- Management console: <https://q.qq.com/>
- Official bot documentation: <https://bot.q.qq.com/wiki/>
- Introduction and access guide:
  <https://bot.q.qq.com/wiki/bot_new_product-intro/>
- API authentication:
  <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html>

1. Open <https://q.qq.com/> and sign in by scanning the QR code with QQ.
2. Complete developer identity verification if requested.
3. Select **创建机器人** (**Create Bot**).
4. Enter the bot's name, avatar, description, and other required details.
5. Open the newly created bot's development/settings page.
6. Copy its **AppID**.
7. Generate or reveal its **AppSecret**, then save it immediately. QQ may not
   display the secret again.

## Install

```bash
npm install
npm run build
npm link
```

## Initialize

Store the AppSecret in a local file rather than putting it in a command or the
repository:

```bash
mkdir -p "$HOME/.qq-bot-acp/secrets"
printf '%s' 'YOUR_APP_SECRET' \
  > "$HOME/.qq-bot-acp/secrets/qq-app-secret.txt"
chmod 700 "$HOME/.qq-bot-acp" "$HOME/.qq-bot-acp/secrets"
chmod 600 "$HOME/.qq-bot-acp/secrets/qq-app-secret.txt"
```

Then initialize the bridge:

```bash
qq-bot-acp init \
  --app-id "YOUR_APP_ID" \
  --client-secret-file "$HOME/.qq-bot-acp/secrets/qq-app-secret.txt" \
  --agent "npx" \
  --agent-arg "@github/copilot@1.0.82" \
  --agent-arg "--acp" \
  --cwd "/path/to/agent-workspace"
```

Initialization is the only CLI configuration surface besides administrator
bootstrap. It refuses to overwrite an existing configuration.

The default persistent directory is:

```text
~\.qq-bot-acp\
├── config.json
├── config.proven.json
├── config.failed.json
├── state.json
├── sessions.json
├── logs\
└── media\
```

Use `--instance NAME` during both initialization and startup to select
`~\.qq-bot-acp\instances\NAME\`.

## Bootstrap the administrator

Start the bot:

```powershell
qq-bot-acp
```

Before an administrator exists, only `/id` is accepted. Privately send `/id`
to the bot, copy the returned bot-scoped C2C OpenID, stop the process, and run:

```powershell
qq-bot-acp --admin-openid "YOUR_OPENID"
```

`--admin-openid` persists the initial administrator and is rejected after the
administrator list becomes non-empty. QQ OpenIDs are scoped to a specific bot;
a numeric QQ account number cannot replace one.

## Chat configuration

Bot-wide changes are accepted only from configured administrators in private
chat:

```text
/config
/config get agent.command
/config agent.command "my-agent"
/c agent.args ["acp","--profile","work"]
/c sessions.idleTimeoutMs 3600000
/config status
```

Values use JSON when appropriate; an unquoted scalar is treated as text.
Configuration writes are atomic. After the QQ gateway authenticates, reaches
ready state, and the ACP agent passes `initialize` plus `session/new`, the
configuration is copied to `config.proven.json`. If the next launch fails, the
candidate is archived as `config.failed.json` and the proven configuration is
restored automatically.

Changes under `qq.*` require a restart. Agent changes terminate active ACP
processes so each conversation starts against the new agent.

## Output formatting and streaming

Direct-chat responses use QQ's official
[`/v2/users/{openid}/stream_messages`](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)
API. Each inbound QQ message owns one independent response stream: every
update retains that message's original `msg_id` and `msg_seq`, then reuses the
`stream_msg_id` returned by QQ's first frame. ACP deltas are accumulated and
sent as throttled full-document `replace` updates, and the final update sets
`input_state: 10` with a single `🔚` marker in the same message. Fenced
code and explicit LaTeX that span ACP deltas are held until structurally
complete so an update never rewrites a prefix QQ may already have displayed.

QQ currently exposes `stream_messages` for direct/C2C chats only. Group chats
explicitly do not support streaming parameters, and channel replies use the
normal channel message API. Those scenarios retain Markdown-aware progressive
batching: fenced code blocks, top-level list items, and nested list content
remain on valid boundaries. QQ permits four passive replies per inbound direct
message and five per inbound group message. Text streams/messages and explicit
artifacts share that per-message sequence budget without rebinding a response
to a newer inbound message.

The bridge does not split a direct stream at the legacy 2,000-character chunk
size. QQ's `remain_msg_len` reports characters still pending for server-side
delivery, not writable capacity: a live response commonly returns zero after
the submitted text has been consumed. The bridge records it as queue telemetry
but never truncates or stops a stream because of it. Any actual platform
length rejection is surfaced explicitly.

Native QQ Markdown is the default for direct and group conversations. QQ opened
custom Markdown in those two scenarios to all bots on April 23, 2026; no
Markdown template or separate application is required. Replies use
`msg_type: 2` with `markdown.content`, supporting headings, emphasis,
strikethrough, links, public-URL images, ordered and unordered nested lists,
quotes, and horizontal rules.

Channel Markdown remains invite-only. The bridge therefore uses an explicit
plain-text compatibility renderer for channel replies instead of attempting a
Markdown send and retrying, which could duplicate a message. The compatibility
renderer removes style markers while preserving readable headings, links,
lists, quotes, tables, and copyable code without decorative brackets or
Unicode frames.

LaTeX expressions delimited by `\[ ... \]`, `$$ ... $$`, `\(...\)`, or
`$...$` are converted to readable Unicode in both native and plain modes.
Common symbols, fractions, roots, superscripts, subscripts, and
`\text{...}` content are supported; fenced code remains unchanged.

Output behavior can be adjusted from an administrator private chat:

```text
/c output.markdownMode "native"
/c output.streamResponses true
/c output.streamMinChars 400
/c output.textChunkLimit 2000
```

Set `output.markdownMode` to `"plain"` to force compatibility rendering in all
conversations, or to `"raw"` to send unformatted text payloads. Set
`output.streamResponses` to `false` to wait for turn completion before
replying through the normal message API. For backward compatibility,
`output.textChunkLimit` and `output.streamMinChars` remain valid configuration
keys, but they apply only to non-streaming group/channel replies and to the
direct fallback selected by `output.streamResponses: false`; official direct
streams ignore both settings. Plain compatibility mode renders only the final
direct stream frame because stripping Markdown incrementally could rewrite a
prefix after a delimiter closes; native and raw modes update progressively.

## Sending artifacts

The bridge automatically gives each ACP session a loopback-only HTTP MCP server
named `qq-artifacts`; no change to `agent.args` is needed. An agent can
proactively publish a file to the current QQ conversation by calling:

```text
send_artifact({ "path": "output/chart.png", "caption": "Optional caption" })
```

The path may be absolute or relative to `agent.cwd`, but the resolved file must
remain inside that directory. Merely reading a file does not send it:
upload occurs only when the agent explicitly calls `send_artifact`.

Artifact delivery supports PNG/JPEG images, MP4 video, and SILK/MP3/WAV/OGG
voice audio as native media. Other regular files are sent through QQ's ordinary
file upload with their sanitized base name preserved. Every artifact is limited
to 20 MiB and can be sent only in direct or group chats. Calls are accepted only
while handling an active QQ message, duplicate content is sent once per turn,
and at most two artifacts can be sent per turn. Artifacts remain separate
rich-media replies and use their own sequence numbers, while all frames in a
direct text stream retain one sequence number; the combined identities remain
within QQ's four-reply direct or five-reply group budget. The configured ACP
agent must advertise HTTP MCP support.

## ACP session configuration

Session options belong to the current QQ conversation and configured agent:

```text
/session-config
/session-config model "MODEL_ID"
/sc reasoning_effort "high"
/sc reset
```

The keys come from the active agent's advertised ACP
`SessionConfigOption[]`. Options are validated through
`session/set_config_option`, persisted, and reapplied when that conversation's
ACP session is recreated. Send a normal message before setting an option.

Other bridge commands:

```text
/acp-cancel
/acp-new
/id
/test-streaming
```

An administrator can send `/test-streaming` in a direct chat to test QQ's
official streaming transport without starting an ACP turn. The diagnostic
forces three generating frames one second apart, then sends the final
`input_state: 10` frame. Service logs record only the per-turn trace, frame
index/state, cumulative and delta character counts, UTF-8 byte count, update
interval, content type, stream state, QQ error metadata, and QQ-reported
pending character count. Message content and full message IDs are not logged.
Logs are also appended to daily files under `~\.qq-bot-acp\logs\` or the
selected instance directory. When QQ returns an `X-Tps-Trace-ID`, keep that
value for platform support.

## Agent examples

GitHub Copilot:

```powershell
--agent "npx" --agent-arg "@github/copilot@1.0.82" --agent-arg "--acp"
```

Claude Code ACP:

```powershell
--agent "npx" --agent-arg "@agentclientprotocol/claude-agent-acp"
```

Gemini CLI:

```powershell
--agent "npx" --agent-arg "@google/gemini-cli" --agent-arg "--experimental-acp"
```

Any other executable is supported if it reads and writes ACP NDJSON over
stdin/stdout.

## Access and session behavior

- Direct, group `@`, and guild channel messages are supported.
- `access.allowFrom` and `access.groupAllowFrom` default to `["*"]`.
- Global `/config` commands always require a direct-message administrator,
  regardless of those allowlists.
- Each conversation has its own serialized queue, agent subprocess, and ACP
  session.
- Text and image prompts are forwarded to ACP. Other attachments are exposed
  to the agent as source URLs.
- Agent text is split to the configured QQ message limit before delivery.
- ACP permission requests automatically select an allow option.

## Acknowledgements

This project builds on ideas and implementation patterns from:

- [formulahendry/wechat-acp](https://github.com/formulahendry/wechat-acp),
  especially its ACP stdio client, per-conversation agent session lifecycle,
  prompt adaptation, and session configuration handling.
- [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot),
  the official QQ Bot channel plugin for
  [OpenClaw](https://github.com/openclaw/openclaw), especially its QQ Open
  Platform authentication, WebSocket gateway, event normalization, reconnect,
  and outbound messaging patterns.

`qq-bot-acp` combines these approaches into a standalone QQ-to-ACP bridge; it
does not require the OpenClaw runtime.
