# QQ Bot 集成、部署与避坑指南

[返回中文 README](../README.zh.md) | [English README](../README.md)

本文总结将 QQ 官方机器人接入 ACP Agent 的完整步骤，以及真实部署中容易踩到的坑。

## 整体结构

```text
手机或桌面 QQ
      |
      v
QQ Open Platform Gateway + Message API
      |
      v
qq-bot-acp
      |
      v
ACP Agent，例如 GitHub Copilot CLI
      |
      v
受控的本地工作区
```

运行 `qq-bot-acp` 的电脑不需要安装 QQ。它通过 HTTPS 和 WebSocket 直接连接 QQ
开放平台。

## 第一步：创建机器人

1. 登录 [QQ 开放平台](https://q.qq.com/)。
2. 完成开发者认证。
3. 创建机器人并填写名称、头像和介绍。
4. 进入开发设置，复制 `AppID`。
5. 生成并立即保存 `AppSecret`。
6. 将机器人添加到测试群或正式群。

### AppID 与 AppSecret

两者必须分开保存：

| 配置 | 内容 |
| --- | --- |
| `--app-id` | 只填写 AppID |
| Secret 文件 | 只保存 AppSecret，不包含 AppID、引号或 JSON |

不要将 AppSecret 放进 Git、命令脚本、Issue、聊天消息或截图。

## 第二步：安装并初始化 Bridge

```powershell
git clone https://github.com/jiec-msft/qq-bot-acp.git
Set-Location qq-bot-acp
npm install
npm run build
npm link
```

创建 Secret 文件：

```powershell
New-Item -ItemType Directory -Force "$HOME\.qq-bot-acp\secrets"
notepad "$HOME\.qq-bot-acp\secrets\qq-app-secret.txt"
```

初始化 GitHub Copilot CLI：

```powershell
qq-bot-acp init `
  --app-id "YOUR_APP_ID" `
  --client-secret-file "$HOME\.qq-bot-acp\secrets\qq-app-secret.txt" `
  --agent "npx" `
  --agent-arg "@github/copilot@1.0.82" `
  --agent-arg "--acp" `
  --cwd "D:\path\to\agent-workspace"
```

`agent.cwd` 是 Agent 可以工作的根目录。不要指向包含大量私人文件的用户主目录。

## 第三步：启动并设置管理员

先启动：

```powershell
qq-bot-acp
```

然后私聊机器人发送 `/id`。停止 Bot 后执行：

```powershell
qq-bot-acp --admin-openid "YOUR_OPENID"
```

注意：

- 必须使用机器人返回的 Bot 专属 OpenID。
- 数字 QQ 号无效。
- 另一个机器人的 OpenID 也无效。
- 管理员列表一旦非空，`--admin-openid` 不会覆盖现有管理员。

## 第四步：在手机 QQ 中逐群开启两个开关

每个群都要单独操作：

1. 打开目标群。
2. 点击机器人头像。
3. 进入机器人设置。
4. 开启“接受机器人推送”。
5. 开启“接收群内全部消息”。

这些入口可能不会出现在桌面 QQ 或 QQ 开放平台管理后台。

### 两个开关分别解决什么问题

| 开关 | 作用 | 未开启时的表现 |
| --- | --- | --- |
| 接受机器人推送 | 允许 Bot 主动发送长任务结果 | 主动发送可能返回 `40034105` |
| 接收群内全部消息 | 接收 `GROUP_MESSAGE_CREATE` | 只能收到旧的 `GROUP_AT_MESSAGE_CREATE` |

## 第五步：重新建立 Gateway Session

修改“接收群内全部消息”后，Gateway 恢复旧 Session 时可能继续使用旧订阅。

1. 确认没有任务正在运行。
2. 停止 Bot。
3. 备份当前实例目录中的 `state.json`。
4. 删除原 `state.json`。
5. 重新启动 Bot。
6. 确认日志显示：

```text
QQ gateway ready (new)
Bot ready using current configuration
```

不要在 Bot 执行任务时删除状态或重启，否则会中断当前 ACP 进程。

## 第六步：配置访问控制

默认配置拒绝所有普通用户：

```text
access.allowFrom = []
access.groupAllowFrom = []
```

通过私聊 `/id` 获取每位可信用户的 OpenID，再由管理员配置允许列表。

生产群不建议使用 `"*"`。如果 Agent 能修改文件或运行命令，开放给所有群成员会扩大
误操作和提示注入风险。

## 第七步：验证消息行为

### 1. 普通群消息

发送一条不带 `@Bot` 的普通消息。

预期：

```text
GROUP_MESSAGE_CREATE accepted=true addressed=false
```

Bot 不回复、不执行命令、不启动 Agent，也不补发历史结果。

### 2. 手动输入假 @

直接键入或复制：

```text
@Copilot 帮我做一个任务
```

如果没有从 QQ 的弹出列表中选择机器人，这只是普通文本。

预期：

- 可信用户收到一条安全说明。
- Agent 不启动。
- 不可信用户保持静默，避免被利用来制造群消息噪音。

### 3. 真实 @

输入 `@`，从 QQ 弹出的列表中选择机器人，然后发送 `ping`。

预期：

```text
GROUP_MESSAGE_CREATE accepted=true addressed=true
QQ task started
```

Bot 应立即确认任务。

### 4. 超过 5 分钟的附件任务

安排一个会生成 PPTX、PDF 或图片，并且运行超过 5 分钟的任务。期间不要发送
`Status`。

预期：

```text
QQ active group artifact confirmed
QQ active group text confirmed
QQ task completed
```

这证明群主动推送、附件上传和最终文本交付都已工作。

## 常见问题与真实原因

| 现象 | 常见原因 | 处理方式 |
| --- | --- | --- |
| 消息看起来有 `@Copilot`，但没有 ACK | 手动输入了普通文本，没有真实 mention 元数据 | 输入 `@` 并从 QQ 列表选择机器人 |
| 开启全量消息后，普通聊天也触发任务 | 消息入口没有检查结构化 mention | 使用 `addressed` 安全门；普通消息必须立即返回 |
| 已开启全量消息，但日志仍只有旧事件 | Gateway 恢复了旧 Session | 备份并删除 `state.json`，确认 `ready (new)` |
| 长任务完成后没有结果 | 群消息 5 分钟被动回复窗口已过期 | 开启“接受机器人推送”，或下一次真实 `@Bot` 补发 |
| 主动发送返回 `40034105` | 当前群没有开启机器人推送权限 | 在手机 QQ 的该群机器人设置中开启推送 |
| 发送 `Status` 后附件突然出现 | `Status` 提供了新的有效 `msg_id`，触发待发送队列 | 这是恢复机制，不是任务刚刚完成 |
| Bot 重启后结果丢失 | 只在内存保存待发送结果 | 使用 `deliveries` 持久化文本和附件 |
| 补发附件失败 | 复用了已经过期的 `file_info` | 补发时重新上传原始附件 |
| Gateway 一直连接但没有 ready | 代码只处理 `READY`，忽略 `RESUMED` | 两种事件都必须进入 ready 状态 |
| Stream 返回 `40034020` | 原消息或 Stream 已经过期 | 只进行一次不带 `msg_id` 的 wakeup 恢复 |
| 认为消息 ID 代表用户已读 | QQ 成功响应只确认平台接收 | 用 `Retry` 处理用户侧未看到的情况 |

## QQ 消息窗口和配额

| 场景 | 被动回复有效期 | 单条用户消息最多回复 |
| --- | ---: | ---: |
| QQ 私聊 | 60 分钟 | 4 次 |
| QQ 群聊 | 5 分钟 | 5 次 |
| QQ 频道 | 5 分钟 | 按频道 API 限制 |

群主动消息还受到 Bot 和单群的频率与每日额度限制。不要把周期心跳设计成无限主动消息。

## `is_wakeup` 的坑

`is_wakeup=true` 是互动召回消息，不是延长旧被动回复窗口。

它与以下字段互斥：

```text
msg_id
event_id
```

发送 wakeup 时不要同时携带旧的 `msg_id` 或 `msg_seq`。

## 交付确认的边界

QQ 返回消息 ID，能够确认：

- QQ 平台接受了请求。
- 请求不是明确失败。

它不能确认：

- 消息已经在客户端展示。
- 用户已经阅读。
- 用户已经打开附件。

QQ Bot API 没有可靠的群历史拉取接口，也不能依赖 Bot 自身消息一定会作为事件回推。
因此当前策略是：平台确认 + 持久化结果 + `Retry` 补偿，而不是伪造“已读”状态。

## 长任务可靠性建议

- 收到真实 `@Bot` 后立即 ACK。
- 状态提示必须来自真实 Agent 活动，而不是固定的“仍在工作”文案。
- 群聊在 5 分钟内使用被动回复，之后尝试主动交付。
- 主动交付失败时保留待发送结果。
- 文本和附件必须跨进程重启恢复。
- 文件补发时重新上传。
- 为最终结果预留回复配额，不要让进度消息耗尽全部次数。
- 网络结果不确定时使用相同 `msg_id + msg_seq` 重试，避免重复消息。

## 并发与共享工作区

每个 QQ 会话有独立队列和 ACP Session，不同群或私聊可以并发执行。

如果它们共享同一个 Git 工作区，Agent 指令必须要求：

- 修改前检查 Git 状态。
- 不覆盖其他任务的未提交改动。
- 修改重叠文件前进行协调。
- Git commit、push 等短临界区串行执行。

不需要为了每个 QQ 群创建一个完整工作区，但必须保护共享文件。

## 隐私和日志

生产日志建议只记录：

- 事件类型
- 是否接受和是否真实提及
- 任务阶段与耗时
- 文本字符数和字节数
- HTTP 状态、QQ 错误码和 Trace ID
- 消息确认 ID 的哈希

不要记录：

- AppSecret 或 Access Token
- 消息正文
- 完整 QQ OpenID、群 OpenID 或消息 ID
- 附件下载 URL
- 用户文件内容

## 上线检查清单

- [ ] AppSecret 只存在于本地受限文件。
- [ ] `agent.cwd` 指向专用工作区。
- [ ] 已设置管理员。
- [ ] 只允许可信用户。
- [ ] 每个目标群已开启两个手机端开关。
- [ ] 修改订阅后日志显示 `QQ gateway ready (new)`。
- [ ] 普通消息显示 `addressed=false`，并保持静默。
- [ ] 假 `@Copilot` 只收到安全提示。
- [ ] 真实 `@Bot` 立即收到 ACK。
- [ ] 超过 5 分钟的附件任务能够主动交付。
- [ ] `Retry` 和 `Seen` 工作正常。
- [ ] Bot 重启后待发送结果仍存在。
- [ ] 日志没有消息正文、Secret 或完整 QQ 标识。
