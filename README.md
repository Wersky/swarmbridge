# SwarmBridge · 蜂群桥

> 让两台机器上各自的 agent 与子代理，通过一个 GitHub 仓库**并行对话**：issue = 线程，评论 = 回帖，关闭 = 回执。

[![tests](https://img.shields.io/badge/tests-23%20passed-brightgreen)](#测试)
[![deps](https://img.shields.io/badge/dependencies-0-brightgreen)](#设计取舍)
[![node](https://img.shields.io/badge/node-%3E%3D18-blue)](https://nodejs.org)

## 这是什么

AI 编码代理（ZCode / Claude Code 等）的子代理天生**互相隔离**：没有 SendMessage、没有跨机网络、看不到对方的任何状态。同一台机器内可以用共享文件/看板解决（见姊妹插件 [taskswarm](https://github.com/Wersky/taskswarm)），**跨机器**则完全没有现成通道——开发者只能当人肉报文员。

SwarmBridge 把一个**双方都能访问的 GitHub 仓库**变成消息总线：

```
我的 agent ──bridge_send──▶ GitHub Issues ◀──bridge_inbox── 对方的 agent
    │                          （线程+回帖+回执）                  │
    └────────── 双方的子代理各自以子身份（owner/agent-N）参与 ──────────┘
```

- **实时性（实测）**：纯 GitHub 轮询模式，发出 → 对方轮询到 ≈ **3~8s**（瓶颈是 GitHub 对新线程的索引传播，2.5~7s）；**1.1.0 起默认叠加 ntfy 门铃推送，传播降到 ≈ 0.3s，单向总延迟 ≈ 0.9s**（见下文「门铃」）。已认证限额 5000 次/小时，多 agent 以 ≥1.5s 间隔轮询绰绰有余。
- **为什么是 Issues 而不是仓库里的 JSON 文件**：追加式、服务端落库，**双方并发写零冲突**（git 提交方案要拉取-变基-重试，并发下必翻车）；自带 `updated_at` 时间戳（增量轮询）、评论线程（对话）、开关状态（回执），人类还能直接在网页上看懂并参与。

## 门铃（ntfy 推送，1.1.0 默认开启）

GitHub 无法向本机推送，轮询的等待时间受「轮询间隔 × 平台索引传播」双重拖累。1.1.0 引入门铃：**发完消息顺手向 ntfy 主题推一条「响铃」（仅元数据：issue 号/身份/类型，不含正文），对方的 server 进程常驻订阅该主题，铃一响立即拉取 GitHub。**

```
send ──▶ GitHub（事实源，含正文）──┐
   └──▶ ntfy 响铃（≈0.3s）────────┴──▶ 对方 server 唤醒 → bridge_inbox 消费
```

- **实测**：铃的传播 **309ms**（中位，3 轮），单向总延迟 ≈ **0.9s**（对比纯轮询 3~8s）；
- **零配置**：主题由仓库名自动派生（`swarmbridge-<hash>`），双端一致；也可用 `BRIDGE_NTFY_TOPIC` 指定（自建 ntfy 用 `BRIDGE_NTFY_URL`）；
- **优雅降级**：门铃挂了/关了（`BRIDGE_NTFY_TOPIC=off`）只是退回慢速轮询，正确性不受影响——GitHub 是唯一事实源；
- **两个使用工具**：
  - `bridge_wait {timeout≤25}` —— 阻塞等铃（「发完任务等回复」场景），响铃即返回；不阻塞同进程其他代理的收发；
  - `bridge_ring` —— 非阻塞查看有无未消费的铃；
- 隐私边界：铃只含元数据且 ntfy 主题名公开可猜，**正文永远只在 GitHub**（私有仓库内容不上 ntfy）。

## 自建中继（⚠️ 实验性，未实测）

不想依赖 GitHub / 追求内网级延迟（10~200ms）时，可以用自带的独立中继：它实现 swarmbridge 所需的 GitHub API 子集，两端把 `BRIDGE_API_BASE` 指向它即可，**协议与工具完全不变**（门铃、游标、ack 全兼容）。

```bash
node relay/server.mjs --port 8787 --token <共享密钥> --data <数据目录>
# 两端环境变量：
BRIDGE_API_BASE=http://<中继地址>:8787   BRIDGE_TOKEN=<共享密钥>   BRIDGE_REPO=bridge/main
```

> ⚠️ **稳定性声明：中继组件没有经过真实的跨机部署测试**（作者只有单机环境，只做过本机回环验证）。单进程内存 + JSON 文件持久化，无 TLS，不适合多人生产。追求稳定请用默认的 GitHub 模式——把 `BRIDGE_API_BASE` 改回 `https://api.github.com` 即可无损切回，协议完全一致。

## PPR 计划分发（1.2.0）

`type: "plan"` 用于**跨机器分发 PPR 计划**：`data = {plan:[{id,title,detail?,dependsOn?,role?,reviewer?}], reviewer?, producer?}`。

发送端强校验结构（非空数组、每项必带 title、`role` 限于 planner/producer/reviewer），错误会指出是第几项。对方收到后照它建本地任务树（taskswarm 的 `role`/`reviewer` 原样带入），本地审核门自动生效，完成后 `bridge_reply {type:"result"}` 回报、`bridge_ack` 闭环。

**寻址是「子可见父、父不可见子」**：发给 `alice/main` 的消息，子身份（`alice/agent-9`）也能收到——这是 PPR 的前提（计划发给主身份，审核由子代理担任）；而点名 `alice/agent-2` 的私聊不会外泄给主身份或兄弟身份。

## 安装

需要 Node ≥ 18，零第三方依赖。

1. 在 GitHub 建一个双方都能访问的仓库（建议私有），如 `Wersky/agent-bridge`；
2. 双方各自准备 PAT（对该仓库有 Issues 读写）；
3. ZCode 里「设置 → 插件管理 → 发现」添加本仓库所在市场并安装，或在插件设置里填 `github_token` / `bridge_repo` / `bridge_id`（也可以用环境变量 `GITHUB_TOKEN` / `BRIDGE_REPO` / `BRIDGE_ID`）。

```bash
git clone https://github.com/Wersky/swarmbridge.git
```

## 工具

| 工具 | 作用 |
| --- | --- |
| `bridge_status` | 配置与连通性自检（`check:true` 实测一次 GitHub） |
| `bridge_send` | 发消息建线程。`to` 支持 `Alice/main`（精确）、`Alice/*`（对方全体）、`*`（广播）；`from` 可覆盖为子身份 |
| `bridge_inbox` | 增量收件箱：游标幂等、按身份落盘（`<workspace>/.swarmbridge/`）、会话恢复不丢进度 |
| `bridge_read` | 读线程全文（首帖 + 全部回帖，人类普通评论也能读出） |
| `bridge_reply` | 线程内回帖（自动回给发起方） |
| `bridge_ack` | 确认已处理：回帖 + 关闭线程，对方看到 closed 即闭环 |
| `bridge_wait` | **阻塞等铃**（ntfy 推送）：对方发消息即唤醒，≤25s，不阻塞同进程其他代理 |
| `bridge_ring` | 非阻塞查看未消费的门铃 |

消息信封（自动组装，人类可直接阅读）：

```json
{
  "bridge": 1,
  "id": "uuid",
  "from": "Wersky/main",
  "to": "Alice/main",
  "type": "task",
  "subject": "实现登录接口",
  "body": "约定见 docs/api.md",
  "data": { "goal": "登录接口", "detail": "含 429 退避" },
  "ts": "2026-09-12T13:00:00.000Z"
}
```

类型约定：`hello` 握手 / `chat` 沟通 / `task` 委派 / `status` 进展 / `result` 结果 / `file` 交付 / `bye` 收工（可自定义）。

## 典型流程

**委派任务给对方**：`bridge_send {type:"task", data:{goal,detail}}` → 对方轮询收到 → 对方本地执行（可再开自己的蜂群）→ `bridge_reply {type:"result", data:{artifacts}}` → 我方轮询看到 → 任何一方 `bridge_ack` 闭环。

**子代理并行参与**：我方子代理以 `from:"Wersky/agent-1"` 发消息；对方可以点名 `to:"Wersky/agent-1"` 精确投递（主代理不代收），或 `to:"Wersky/*"` 群发。这样两边的"主代理 + N 个子代理"可以同时多条线程并行沟通。

## 与 taskswarm 的关系

[taskswarm](https://github.com/Wersky/taskswarm) 解决**本机**编排（主代理 ↔ 子代理，共享看板）；SwarmBridge 解决**跨机器**通信（本方 ↔ 对方，GitHub 总线）。组合用法：对方的 `task` 消息 → 本地主代理把它 `task_add` 进自己的任务树 → 本地蜂群执行 → 收波后 `bridge_reply {type:"result"}` → `bridge_ack` 闭环。

## 设计取舍

- **零依赖**：只用 Node 内置模块（含内置 `fetch`），没有 SDK、没有供应链面。
- **声明式身份**：MCP 协议层无法验证"你是谁"，真正的安全边界是**仓库写权限**（token 能写仓库才能发消息）。消息对仓库成员可见，勿传敏感信息。
- **游标按身份隔离落盘**：同一工作区多身份（主代理 + 子代理）各自轮询互不干扰；同一身份同时只应有一个活跃轮询者。
- **刻意不给 `bridge_inbox` 加类型过滤**：轮询游标会推进，被过滤掉的消息将不会再出现——类型筛选由调用方在返回结果里自行做（消息带 `type` 字段），避免"查看一下就弄丢消息"的坑。
- **错误信息全部"发生了什么 + 下一步怎么做"**：401 指向 token、404 指向仓库名与权限、403 指向限额与重置时间、网络失败指向代理配置。

## 测试

23 个离线测试全绿（`npm test`）：本地 stub 模拟 GitHub API，覆盖收发闭环、寻址与通配、广播、排除自己、排除人类帖子、子身份、游标持久化与会话恢复、401/404/网络失败/消息过大等错误路径。测试基础设施自带进程收割，异常退出不留孤儿 node 进程。

另有真机验证脚本（默认跳过，避免无 token 环境跑挂）：

```bash
BRIDGE_LIVE=1 BRIDGE_REPO=Wersky/agent-bridge GITHUB_TOKEN=*** npm run live
```

## License

MIT © 2026 Wersky

---

<details>
<summary>English</summary>

**SwarmBridge** lets agents and their subagents on two different machines talk in parallel through a shared GitHub repository: an issue is a thread, a comment is a reply, closing is an ack.

Subagents in coding agents (ZCode / Claude Code) are inherently isolated — no SendMessage, no cross-machine network. Within one machine a shared board works (see [taskswarm](https://github.com/Wersky/taskswarm)); across machines nothing exists. SwarmBridge fills that gap with zero dependencies (Node built-in `fetch` only).

**Measured latency**: GitHub cannot push to a local machine (webhooks need a public endpoint), so SwarmBridge polls incrementally with a per-identity cursor. Live roundtrip: send → visible to peer ≈ 5.3s at a 1.5s polling interval; reply → visible ≈ 0.9s. Authenticated rate limit (5000/h) comfortably supports several agents.

**Why Issues instead of a JSON file in the repo**: appends are server-side with zero merge conflicts (a git-commit bus requires pull–rebase–retry and breaks under concurrency), `updated_at` enables cheap incremental polling, and comments/state give you threads and acks for free — plus humans can read and join on the web.

23 offline tests (a local stub fakes the GitHub API) plus gated live scripts.

MIT © 2026 Wersky

</details>
