# QQ Bot ACP

[English](README.md) | [简体中文](README.zh.md)

将 QQ 官方机器人连接到任何通过标准输入输出实现
[Agent Client Protocol（ACP）](https://agentclientprotocol.com/) 的 Agent。

本项目负责 QQ 鉴权、Gateway 连接、消息路由、会话隔离、长任务状态、
附件交付和失败恢复。每个 QQ 群或私聊都有独立的 ACP 会话和任务队列，
不同会话可以并发工作。

如果你是第一次接入 QQ 机器人，建议先阅读
[QQ Bot 集成、部署与避坑指南](docs/qq-bot-setup.zh.md)。

## 主要能力

- 支持 QQ 私聊、QQ群和 QQ 频道消息。
- 每个 QQ 会话使用独立的 ACP Session。
- 支持 GitHub Copilot CLI、Claude Code ACP、Gemini CLI 等 ACP Agent。
- 立即确认任务，并持续报告长任务状态。
- 支持发送图片、视频、音频、PPTX、Word、PDF 和普通文件。
- 长任务超过 QQ 被动回复窗口后，可使用群主动消息发送结果。
- 待发送文本和附件会持久化，Bot 重启后仍可补发。
- 支持 `Status`、`Retry`、`Seen`、`Stop` 等恢复和控制命令。
- 默认拒绝未授权用户，并限制 Agent 的文件访问范围。
- 开启“接收群内全部消息”后，普通群消息仍不会启动 Agent。

## 环境要求

- Node.js 20 或更高版本
- 已在 [QQ 开放平台](https://q.qq.com/) 创建机器人
- 一个支持 ACP 的 Agent 命令

运行 Bot 的电脑**不需要安装或登录 QQ 客户端**。QQ 客户端只用于创建机器人、
配置群权限和日常聊天。

## 创建 QQ 机器人

1. 打开 [QQ 开放平台](https://q.qq.com/)，使用 QQ 扫码登录。
2. 根据提示完成开发者身份验证。
3. 选择“创建机器人”。
4. 填写机器人名称、头像和介绍。
5. 进入机器人的开发或设置页面。
6. 复制 `AppID`。
7. 生成并立即保存 `AppSecret`。QQ 可能不会再次显示完整 Secret。

`AppID` 和 `AppSecret` 是两个不同的值：

- `YOUR_APP_ID` 只替换为 AppID。
- `YOUR_APP_SECRET` 只替换为 Secret，**不包含 AppID**。

不要把 AppSecret 提交到 Git、写入 README、截图或聊天记录。建议将它单独保存到
用户目录下的 Secret 文件中。

## 安装

```powershell
git clone https://github.com/jiec-msft/qq-bot-acp.git
Set-Location qq-bot-acp
npm install
npm run build
npm link
```

## 初始化

先创建 Secret 目录，并使用本地编辑器将 AppSecret 保存到
`qq-app-secret.txt`：

```powershell
New-Item -ItemType Directory -Force "$HOME\.qq-bot-acp\secrets"
notepad "$HOME\.qq-bot-acp\secrets\qq-app-secret.txt"
```

然后初始化：

```powershell
qq-bot-acp init `
  --app-id "YOUR_APP_ID" `
  --client-secret-file "$HOME\.qq-bot-acp\secrets\qq-app-secret.txt" `
  --agent "npx" `
  --agent-arg "@github/copilot@1.0.82" `
  --agent-arg "--acp" `
  --cwd "D:\path\to\agent-workspace"
```

初始化不会覆盖已经存在的配置。默认运行数据位于：

```text
~\.qq-bot-acp\
├── config.json
├── config.proven.json
├── config.failed.json
├── state.json
├── sessions.json
├── logs\
├── media\
└── deliveries\
```

如需运行多个实例，请在初始化和启动时都使用 `--instance NAME`。

## 设置管理员

第一次启动：

```powershell
qq-bot-acp
```

此时只有 `/id` 可用：

1. 在 QQ 中私聊机器人并发送 `/id`。
2. 复制机器人返回的 Bot 专属 OpenID。
3. 停止 Bot。
4. 使用该 OpenID 启动一次：

```powershell
qq-bot-acp --admin-openid "YOUR_OPENID"
```

数字 QQ 号不能代替 OpenID。不同机器人生成的 OpenID 也不能混用。

## 为每个 QQ 群开启权限

以下两个开关目前通常只能在**手机 QQ**中设置，而且每个群都要单独开启：

1. 打开目标群。
2. 点击机器人头像并进入设置。
3. 开启“接受机器人推送”。
4. 开启“接收群内全部消息”。

“接受机器人推送”允许 Bot 在群消息 5 分钟被动回复窗口结束后主动发送长任务结果。
“接收群内全部消息”使 Gateway 收到 `GROUP_MESSAGE_CREATE` 事件。

即使开启全量消息，安全规则仍然是：

- 普通群消息保持静默，不执行命令，不启动 Agent，也不补发结果。
- 必须输入 `@` 并从 QQ 弹出的列表中选择机器人，才算真实提及。
- 手动输入或复制纯文本 `@Copilot` 不会启动 Agent；可信用户会收到安全提示。

修改“接收群内全部消息”后，旧 Gateway Session 可能继续使用旧订阅。停止 Bot，
备份并删除当前实例的 `state.json`，然后重新启动；日志应显示：

```text
QQ gateway ready (new)
```

## 配置可信用户

默认的 `access.allowFrom` 和 `access.groupAllowFrom` 都是空数组，也就是默认拒绝。
先使用 `/id` 获取 Bot 专属 OpenID，再由管理员私聊 Bot 配置允许列表。

只有确实需要允许所有人使用时才配置 `"*"`。公开群中的 Agent 可能读取或修改共享
工作区，因此不建议默认开放。

## QQ 频道论坛帖子

论坛自动化只支持 **QQ 私域机器人**。它默认关闭，并且必须明确配置频道
（Guild）ID 允许列表：

```text
/config qq.forum.enabled true
/config qq.forum.guildAllowFrom ["YOUR_GUILD_ID"]
```

修改 `qq.forum.*` 后请重启 Bot。程序会自动丢弃使用不同 intent 集合记录的旧
Gateway 状态。启用后，程序只请求私域 `FORUM_EVENT` intent（`1 << 28`），并直接
处理携带完整帖子内容的 `FORUM_THREAD_CREATE` 事件。

不要在公域机器人上启用此配置。公域机器人会拒绝这个 intent，导致 Gateway
鉴权失败。QQ 平台开启私域能力后，还必须先把机器人移出频道，再重新添加，
API 能力才会生效。

私域机器人会自动获得论坛 API。权限卡不能让公域机器人获得论坛帖子读取或发布
能力。只有以真实 @Bot 开头，或以“`@机器人名称` + 空格/标点”开头的帖子才会启动
Agent。

每个来源帖子都有独立 ACP 会话。论坛任务不会发送进度或心跳帖子，最终答案只会
以一个新的 Markdown 论坛帖子发布。同一论坛子频道的结果发布会串行执行，但不同
来源帖子的 ACP 任务仍可并发运行。

QQ 的帖子 `PUT` 是异步受理。程序只有收到成功的
`FORUM_PUBLISH_AUDIT_RESULT` 后，才会把来源事件标记为完成。审核失败时，来源事件
和已生成结果会继续保留，等待一次受控重试。每个结果标题末尾会带一个短的确定性
标记，例如 `[C:1a2b3c4d]`。这个可见后缀是必要的，因为审核事件不包含 `PUT`
返回的 `task_id`。

待处理事件和发布状态都保存在 `forum-queue.json`。重启后，程序会在有限宽限期内
通过私域机器人的帖子列表 API 查找标题标记。找到标记时不会重复 `PUT`；找不到时
会直接重发已保存的结果，不会重新运行 ACP。允许列表之外的新事件不会写入队列；
如果已有队列事件的 Guild 后来被移出允许列表，该事件也会被删除。全局关闭论坛
功能时，允许范围内的待处理事件仍会保留，但不会启动。论坛任务暂不支持显式附件
发布。

## 长任务与附件交付

QQ群被动回复窗口为 5 分钟，私聊为 60 分钟。Bot 会：

1. 立即回复任务已接收。
2. 在允许的窗口内发送进度。
3. 群任务超过 5 分钟后尝试主动发送结果。
4. 如果主动消息权限不可用，将文本和附件保存到 `deliveries`。
5. 用户下一次真实 `@Bot` 时优先补发结果。

附件不会复用可能过期的上传信息。补发时会重新读取持久化文件并上传。
QQ 返回消息 ID 代表平台已接受请求，但不代表用户已经阅读。

常用恢复命令：

```text
Status
Retry
Seen
Stop
```

- `Status`：查看当前任务和交付状态。
- `Retry`：重新发送最近一次已确认结果。
- `Seen`：清除最近一次结果缓存。
- `Stop`：取消当前任务。

## 常用命令

```text
Help
New Chat
Stop
Status
Retry
Seen
Normal
Deep
Learn
Approve
Review
Publish
Publish Confirm
Discard
/setup-controls
/id
/config
/session-config
/test-streaming
```

管理员可在私聊中执行 `/setup-controls`，安装或更新 QQ 的菜单和命令面板。

## Agent 示例

GitHub Copilot CLI：

```powershell
--agent "npx" --agent-arg "@github/copilot@1.0.82" --agent-arg "--acp"
```

Claude Code ACP：

```powershell
--agent "npx" --agent-arg "@agentclientprotocol/claude-agent-acp"
```

Gemini CLI：

```powershell
--agent "npx" --agent-arg "@google/gemini-cli" --agent-arg "--experimental-acp"
```

## 安全与隐私

- AppSecret 只从本地文件读取，不应进入仓库。
- 日志不记录消息正文、附件 URL 或完整 QQ 消息 ID。
- QQ 标识在交付存储中使用哈希，不直接保存真实会话 ID。
- 默认拒绝未授权用户。
- ACP 文件读取和写入被限制在配置的 `agent.cwd` 内。
- 脚本和可执行附件会被拒绝。
- 普通群消息不会释放待发送结果。
- `Learn`、`Approve` 和 `Publish Confirm` 将学习、审核和发布分成独立步骤。

## 更多技术细节

英文 README 包含流式消息、Markdown、LaTeX、ACP Session 配置、附件 MCP、
发布保护和错误恢复等完整技术说明：

[阅读英文技术文档](README.md)

## 致谢

本项目参考了以下项目的设计和实现：

- [formulahendry/wechat-acp](https://github.com/formulahendry/wechat-acp)
- [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)

`qq-bot-acp` 是独立的 QQ-to-ACP Bridge，不依赖 OpenClaw Runtime。
