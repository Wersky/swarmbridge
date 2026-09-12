#!/usr/bin/env node
/**
 * 门铃时延实测：B 先 bridge_wait 挂起（ntfy 推送），A 再 send，量真实推送延迟。
 * 与 live-roundtrip（轮询模式）对比用。门槛同 live-roundtrip：BRIDGE_LIVE=1 + token。
 */
import { connect, makeWorkspace, rmWorkspace } from '../mcp/test/helpers.mjs';

if (process.env.BRIDGE_LIVE !== '1' || !(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.BRIDGE_TOKEN)) {
  console.log('[live] 跳过：未设置 BRIDGE_LIVE=1 或缺少 token。');
  process.exit(0);
}
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.BRIDGE_TOKEN;
const ws = makeWorkspace();

// live 模式显式传 ntfy 地址：测试 helpers 默认把门铃指向不可达地址（防测试触网），
// 这里必须覆盖为真实 ntfy，否则门铃发不到（实测踩过：铃全部落在 127.0.0.1:1）。
const A = connect({ identity: 'wersky/main', workspace: ws, apiBase: 'https://api.github.com', token: TOKEN, repo: process.env.BRIDGE_REPO, ntfyUrl: 'https://ntfy.sh' });
const B = connect({ identity: 'alice/main', workspace: ws, apiBase: 'https://api.github.com', token: TOKEN, repo: process.env.BRIDGE_REPO, ntfyUrl: 'https://ntfy.sh' });

try {
  const ROUNDS = 3;
  const latencies = [];
  for (let i = 1; i <= ROUNDS; i++) {
    // B 先挂起等铃（ntfy 推送），最长 20s
    const waitPromise = B.call('bridge_wait', { timeout: 20 });
    await new Promise(r => setTimeout(r, 800)); // 给 B 的 ntfy 订阅流建立时间（仅首轮需要，后续复用）

    const t0 = Date.now();
    const sent = await A.call('bridge_send', { to: 'alice/main', type: 'task', subject: `门铃压测#${i}`, body: 'doorbell latency probe' });
    const sendMs = Date.now() - t0;

    const w = await waitPromise;
    const ringMs = Date.now() - t0; // 从开始发送到铃响（含发送本身）
    latencies.push(ringMs - sendMs);
    console.log(`第 ${i} 轮: 发送 ${sendMs}ms｜send→铃响 ${ringMs}ms（纯推送传播 ≈ ${ringMs - sendMs}ms）｜issue #${w.rings[0]?.issue}`);
  }
  const med = (arr) => arr.slice().sort((x, y) => x - y)[Math.floor(arr.length / 2)];
  console.log(`\n门铃传播中位: ${med(latencies)}ms（最快 ${Math.min(...latencies)}ms）——对比纯轮询模式的 2.5~7s`);
} finally {
  console.log('A 的 stderr:', JSON.stringify(A.stderr().slice(0, 400)));
  console.log('B 的 stderr:', JSON.stringify(B.stderr().slice(0, 400)));
  A.kill(); B.kill();
  setTimeout(() => { rmWorkspace(ws); process.exit(0); }, 300);
}
