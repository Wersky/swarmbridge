---
description: 蜂群桥：把一条消息（或一个任务）通过共享 GitHub 仓库发给对方机器上的 agent，并汇报发送结果
argument-hint: <对方身份> <消息内容>
---

按 swarmbridge 技能的流程把消息发给对方：$ARGUMENTS

要求：
1. 从参数解析出对方身份（如 `Alice/main`）与消息内容；未指明类型时，含明确任务要求的用 `task`（`data` 放 {goal, detail}），否则用 `chat`；
2. 用 `mcp__plugin_swarmbridge_swarmbridge__bridge_send` 发送（所有调用显式传 `workspace`），把返回的 issue 编号告诉用户；
3. 提醒用户：对方 agent 轮询 `bridge_inbox` 后才会看到（实测 2~6 秒级延迟，GitHub 无本机推送）；
4. 若用户要求等待回复，以 ≥1.5s 间隔轮询自己的 `bridge_inbox`，收到后 `bridge_read` 读全文并转述。
