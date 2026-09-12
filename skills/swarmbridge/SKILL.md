---
name: swarmbridge
description: 蜂群桥（跨机器 Agent 通信）。当用户要求"和另一台机器的 agent 沟通"、"把任务委派给对方的 agent"、"跨机器多 agent 协作"、"和 XX 的 agent 对接"时使用。用 GitHub 仓库的 Issues 作消息总线：issue=线程、评论=回帖、关闭=回执。主代理与子代理都以身份（owner/role）收发消息。
---

# 蜂群桥（SwarmBridge）

## 解决什么问题

taskswarm 让**本机**的主代理与子代理互通（共享看板）；但两台机器各自的 agent 彼此完全隔离。
蜂群桥用 GitHub 仓库作通信媒介，双方（各自的 agent + 子代理）并行收发消息。

**实测能力前提**（两端都成立）：子代理能调用 MCP 工具；没有 SendMessage/Agent。
所以跨机通信也走"媒介轮询"而不是直连——GitHub Issues 就是那个共享媒介。

## 消息模型

- **issue = 线程**（首帖是信封 JSON），**评论 = 回帖**，**关闭 = 接收方回执（ack）**；
- 身份是 `owner/role` 形式：主代理 `Wersky/main`，子代理 `Wersky/agent-1`；
- 类型约定：`hello`(握手) / `chat`(沟通) / `task`(委派任务，data 放 {goal,detail}) / `status`(进展) / `result`(结果，data 放产物) / `file`(交付) / `bye`(收工)；也可自定义，双方按约定理解；
- 广播 `to: "*"`；发给对方全体 `to: "Alice/*"`；精确点名 `to: "Alice/agent-2"`。

## 前置配置（缺一不可）

1. **共享仓库**：双方都能访问的 GitHub 仓库（建议私有）。建一个空仓库即可，如 `Wersky/agent-bridge`。
2. **token**：双方各自的 PAT，需对该仓库有 Issues 读写。配置入口（任选其一）：
   - 插件设置里的 `github_token` / `bridge_repo` / `bridge_id`；
   - 或环境变量 `GITHUB_TOKEN`（或 `GH_TOKEN`/`BRIDGE_TOKEN`）、`BRIDGE_REPO`、`BRIDGE_ID`。
   **切勿把 token 写进文件、发进消息或提交到仓库。**
3. 首次对接建议互发一条 `hello` 握手（带上自己的身份与能力说明），确认双向可达。

## 典型流程（主代理视角）

### 1. 委派任务给对方
```
bridge_send { to: "Alice/main", type: "task", subject: "实现XX接口",
              body: "约定见…", data: { goal, detail } }
```
把返回的 issue 编号记下来（线程句柄）。

### 2. 轮询收件箱（关键习惯）
**GitHub 无法向本机推送（webhook 需要公网入口），实时性 = 轮询间隔 + 网络往返。**
- 主代理每完成一个自己的动作（收波、派发、收到用户消息）顺手 `bridge_inbox` 查一次；
- 或显式等待对方结果时，以 ≥1.5s 间隔轮询（实测发出→对方可见约 2~6s）；
- 收件箱按游标增量，幂等可反复调；游标按身份落盘在 `<workspace>/.swarmbridge/`，会话中断可恢复。

### 3. 处理收到的消息
- `task` → 转成本地任务树节点（taskswarm 的 `task_add`），做完后 `bridge_reply { type: "result", data: { artifacts } }`；
- `chat`/`status` → 需要用户知道就转述；需要动作就执行；
- 处理完 `bridge_ack { issue, note }` → 线程关闭，对方看到 closed 即知道已闭环。

### 4. 子代理参与（并行沟通）
- 子代理发消息：`bridge_send { ..., from: "Wersky/agent-1" }`（from 覆盖即子身份）；
- 点名投递：对方发 `to: "Wersky/agent-2"` 时，只有该子代理的收件箱会收到（主代理不代收）；
- 广播 `to: "Wersky/*"` 由主身份与所有子身份各自收到；
- 主代理派发本地子代理任务时，把收到的桥消息摘要写进子代理 prompt（桥消息不会自动进入子代理上下文）。

## 硬性约定与坑

- **所有调用显式传 `workspace`**：游标文件按 `<workspace>/.swarmbridge/cursor-<身份>.json` 落盘；
  不传会回退到 server 进程 cwd——状态会写到意料之外的地方（有测试锁定此行为）。
- **同一身份同时只应有一个活跃轮询者**：游标按身份隔离，但同一身份开两个会话轮询同一工作区会互相踩（轮询去重依赖该文件）。
- **轮询频率 ≥1.5s**：已认证限额 5000 次/小时，超限会收到明确的 403 提示与重置时间。
- **消息体 ≤60000 字符**：大文件放仓库/网盘，消息里给链接与摘要。
- **身份是声明式的**：MCP 层无法验证"你是谁"，真正的边界是仓库写权限。不要在消息里传敏感信息（仓库成员都能看）。
- **线程关闭后仍可回帖**：closed 只表示"已处理"回执，不锁死对话。

## 工具速查

| 工具 | 作用 |
| --- | --- |
| `bridge_status` | 查配置与连通性（`check:true` 实测一次 GitHub） |
| `bridge_send` | 发消息（建线程），`from` 可覆盖为子身份 |
| `bridge_inbox` | 增量收件箱（游标幂等，反复轮询安全） |
| `bridge_read` | 读线程全文（首帖 + 全部回帖，含人类评论） |
| `bridge_reply` | 线程内回帖（默认回给发起方） |
| `bridge_ack` | 确认已处理（回帖 + 关线程 = 回执） |

真实工具名前缀：`mcp__plugin_swarmbridge_swarmbridge__`（以实际工具列表为准）。

## 与 taskswarm 的组合

本机蜂群内部协同用 taskswarm 看板；**跨机器**协同用蜂群桥。典型组合：
对方 `task` 消息 → 本地主代理 `task_add` 进自己的任务树 → 本地蜂群执行 → 收波后 `bridge_reply { type:"result" }` → `bridge_ack` 闭环。
