#!/usr/bin/env node
/**
 * bench.mjs — 通信时延实测（需真实 token 与共享仓库，BRIDGE_LIVE 同款门槛）：两身份走真实 GitHub API，多次往返取分布。
 * 轮询间隔 300ms（主动等回复时的激进节奏，短时突发不影响限额）。
 * 每一轮：A 发 task → B 收到 → B 回 result → A 收到，分别记录两段时延。
 */
import { connect, makeWorkspace, rmWorkspace } from '../mcp/test/helpers.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ws = makeWorkspace();
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.BRIDGE_TOKEN;
const REPO = process.env.BRIDGE_REPO;

const A = connect({ identity: 'wersky/main', workspace: ws, apiBase: 'https://api.github.com', token: TOKEN, repo: REPO });
const B = connect({ identity: 'alice/main', workspace: ws, apiBase: 'https://api.github.com', token: TOKEN, repo: REPO });

async function pollUntil(conn, expectFn, { maxMs = 20000, step = 300, label } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await conn.call('bridge_inbox', {});
    const hit = expectFn(r);
    if (hit) return { hit, ms: Date.now() - t0 };
    if (Date.now() - t0 > maxMs) throw new Error(`[${label}] 超时`);
    await sleep(step);
  }
}

const leg1 = [], leg2 = [], sendTimes = [];
try {
  const ROUNDS = 3;
  for (let i = 1; i <= ROUNDS; i++) {
    const t0 = Date.now();
    const sent = await A.call('bridge_send', { to: 'alice/main', type: 'task', subject: `压测#${i}`, body: 'latency probe' });
    const sendMs = Date.now() - t0;
    sendTimes.push(sendMs);

    const b = await pollUntil(B, r => r.messages.find(m => m.messageId === sent.messageId), { label: `B收#${i}` });
    leg1.push(b.ms);

    await B.call('bridge_reply', { issue: sent.issue, type: 'result', body: `round${i} done`, data: { round: i } });

    const a = await pollUntil(A, r => r.messages.find(m => m.issue === sent.issue && m.replies > 0), { label: `A收回帖#${i}` });
    leg2.push(a.ms);

    await B.call('bridge_ack', { issue: sent.issue, note: `round${i}` });
    console.log(`第 ${i} 轮: 发送 ${sendMs}ms｜A→B 可见 ${b.ms}ms｜B回帖→A可见 ${a.ms}ms`);
  }
  const med = (arr) => arr.slice().sort((x, y) => x - y)[Math.floor(arr.length / 2)];
  console.log(`\n汇总（${ROUNDS} 轮，300ms 轮询间隔）：
  发送 API 耗时中位: ${med(sendTimes)}ms（最快 ${Math.min(...sendTimes)}ms）
  A→B 单向可见中位: ${med(leg1)}ms（最快 ${Math.min(...leg1)}ms，最慢 ${Math.max(...leg1)}ms）
  B→A 单向可见中位: ${med(leg2)}ms（最快 ${Math.min(...leg2)}ms，最慢 ${Math.max(...leg2)}ms）
  一问一答完整往返: 约 ${(med(leg1) + med(leg2))}ms（不含双方处理时间）`);
} finally {
  A.kill(); B.kill();
  setTimeout(() => { rmWorkspace(ws); process.exit(0); }, 300);
}
