# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.1.0] - 2026-09-13

### Added

- **ntfy 门铃推送（默认开启）**：`bridge_send`/`bridge_reply`/`bridge_ack` 成功后向 ntfy 主题推一条响铃（仅元数据，正文始终只在 GitHub）；server 进程常驻订阅，铃到即记入内存缓冲。真机实测铃传播 **309ms**（中位，3 轮），单向总延迟 ≈ **0.9s**（纯轮询为 3~8s，瓶颈是 GitHub 对新线程的索引传播）。
- **`bridge_wait`**：阻塞等铃（默认 10s、上限 25s）——「发完任务等回复」时用，响铃即返回；绕过全局串行队列，不阻塞同进程其他代理的收发。
- **`bridge_ring`**：非阻塞查看未消费的门铃（取走即清空）。
- **自建中继 `relay/server.mjs`**（⚠️ 实验性，未实测）：实现 GitHub API 子集，两端 `BRIDGE_API_BASE` 指向它即可脱离 GitHub 互通（内网级延迟），协议与工具完全不变，可无损切回。
- 门铃配置：`BRIDGE_NTFY_URL`（默认 https://ntfy.sh，可自托管）、`BRIDGE_NTFY_TOPIC`（默认由仓库名派生，设 `off` 关闭）。
- 真机基准脚本 `scripts/bench.mjs`（轮询模式）与 `scripts/bench-doorbell.mjs`（门铃模式）。

### Changed

- 工具数 6 → 8；`bridge_send`/`bridge_reply`/`bridge_ack` 返回体新增 `doorbell` 字段（门铃状态）。
- `bridge_status` 新增 `doorbell` 段（enabled/topic/connected/pendingRings）。

## [1.0.0] - 2026-09-12

### Added

- 首个版本：跨机器 Agent 通信桥，以 GitHub 仓库 Issues 为消息总线。
- 工具：`bridge_status` / `bridge_send` / `bridge_inbox` / `bridge_read` / `bridge_reply` / `bridge_ack`。
- 协议：信封 JSON（`bridge:1`）寻址（`owner/role` 身份、`*` 广播、`prefix/*` 通配）、
  游标增量收件箱（按身份落盘、会话恢复）、ack 回执闭环（回帖 + 关闭线程）。
- 17 个离线测试（本地 stub 模拟 GitHub API，覆盖收发闭环、寻址、过滤、游标、错误路径），
  外加真机验证脚本 `scripts/live-roundtrip.mjs`（`BRIDGE_LIVE=1` 时运行）。
