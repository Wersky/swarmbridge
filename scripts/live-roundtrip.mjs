#!/usr/bin/env node
/**
 * live-roundtrip.mjs — 真机连通性验证：用真实 GitHub 仓库跑一次完整收发闭环。
 *
 * 默认跳过（保证 CI/离线测试不打真实 API）；显式设置 BRIDGE_LIVE=1 且具备以下
 * 环境变量时才运行：
 *   GITHUB_TOKEN / GH_TOKEN / BRIDGE_TOKEN —— 对仓库有 Issues 读写的 PAT
 *   BRIDGE_REPO  —— 共享仓库 "owner/name"（例：Wersky/agent-bridge）
 *
 * 脚本以两个身份（wersky/main 与 alice/main，模拟两台机器上的主代理）
 * 走完 send → inbox → reply → inbox → ack 全流程，并打印每一步的时延。
 */
import { connect, makeWorkspace, rmWorkspace } from '../mcp/test/helpers.mjs';

const enabled = process.env.BRIDGE_LIVE === '1' && (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.BRIDGE_TOKEN);
if (!enabled) {
  console.log('[live] 跳过：未设置 BRIDGE_LIVE=1 或缺少 token。');
  process.exit(0);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ws = makeWorkspace();

async function pollUntil(conn, expectFn, { maxMs = 30000, step = 1500, label } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await conn.call('bridge_inbox', {});
    const hit = expectFn(r);
    if (hit) return { message: hit, waitedMs: Date.now() - t0, polls: Math.round((Date.now() - t0) / step) };
    if (Date.now() - t0 > maxMs) throw new Error(`[${label}] 等待超时（${maxMs}ms）`);
    await sleep(step);
  }
}

const A = connect({ identity: 'wersky/main', workspace: ws, apiBase: 'https://api.github.com', token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.BRIDGE_TOKEN, repo: process.env.BRIDGE_REPO });
const B = connect({ identity: 'alice/main', workspace: ws, apiBase: 'https://api.github.com', token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.BRIDGE_TOKEN, repo: process.env.BRIDGE_REPO });

try {
  const t0 = Date.now();
  const sent = await A.call('bridge_send', {
    to: 'alice/main', type: 'task', subject: '真机验证：请确认收到',
    body: '这是 swarmbridge 的真机往返验证消息。', data: { goal: '验证跨机通信', detail: '轮询时延测量' },
  });
  console.log(`[1] send   → issue #${sent.issue}（本地耗时 ${Date.now() - t0}ms）`);

  const got = await pollUntil(B, r => r.messages.find(m => m.subject.includes('真机验证')), { label: 'B 收消息' });
  console.log(`[2] B 收到 → from=${got.message.from} type=${got.message.type}｜从发出到被轮询到：${got.waitedMs}ms（轮询间隔 1.5s，共 ${got.polls} 次）`);

  const t1 = Date.now();
  await B.call('bridge_reply', { issue: got.message.issue, type: 'result', body: '已收到并处理。', data: { ok: true } });
  console.log(`[3] reply  → 回帖完成（${Date.now() - t1}ms）`);

  const back = await pollUntil(A, r => r.messages.find(m => m.issue === got.message.issue), { label: 'A 收回帖' });
  console.log(`[4] A 看到 → 线程更新，replies=${back.message.replies}｜从回帖到被轮询到：${back.waitedMs}ms`);

  const t2 = Date.now();
  await B.call('bridge_ack', { issue: got.message.issue, note: '真机验证完成' });
  const thread = await A.call('bridge_read', { issue: got.message.issue });
  console.log(`[5] ack    → state=${thread.state}（${Date.now() - t2}ms），回帖数=${thread.replies.length}`);
  console.log(`\n✅ 真机往返闭环 OK：https://github.com/${process.env.BRIDGE_REPO}/issues/${sent.issue}`);
} finally {
  A.kill(); B.kill();
  setTimeout(() => { rmWorkspace(ws); process.exit(0); }, 300);
}
