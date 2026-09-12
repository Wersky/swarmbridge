# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.0.0] - 2026-09-12

### Added

- 首个版本：跨机器 Agent 通信桥，以 GitHub 仓库 Issues 为消息总线。
- 工具：`bridge_status` / `bridge_send` / `bridge_inbox` / `bridge_read` / `bridge_reply` / `bridge_ack`。
- 协议：信封 JSON（`bridge:1`）寻址（`owner/role` 身份、`*` 广播、`prefix/*` 通配）、
  游标增量收件箱（按身份落盘、会话恢复）、ack 回执闭环（回帖 + 关闭线程）。
- 17 个离线测试（本地 stub 模拟 GitHub API，覆盖收发闭环、寻址、过滤、游标、错误路径），
  外加真机验证脚本 `scripts/live-roundtrip.mjs`（`BRIDGE_LIVE=1` 时运行）。
