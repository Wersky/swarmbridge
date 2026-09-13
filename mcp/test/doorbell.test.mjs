/**
 * 门铃（ntfy 推送）测试。
 *
 * 门铃架构：bridge_send/reply/ack 成功后向 ntfy 主题发一条「响铃」（仅元数据，
 * 无正文）；接收方的 server 进程后台订阅该主题，把铃记进内存缓冲；
 * bridge_wait（阻塞等铃）/ bridge_ring（非阻塞查看）从这里消费。
 * GitHub 始终是事实源：门铃挂了只影响速度，不影响正确性。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withBridge } from './helpers.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 与 server 端一致的派生规则：swarmbridge-<sha256(repo).slice(0,12)>
const derivedTopic = (repo) => `swarmbridge-${crypto.createHash('sha256').update(repo).digest('hex').slice(0, 12)}`;

describe('门铃发布', () => {
  test('send / reply / ack 都会向 ntfy 发铃（仅元数据，无正文）', async () => {
    await withBridge(async ({ mk, ntfy }) => {
      const a = mk('wersky/main');
      const b = mk('alice/main');

      const sent = await a.call('bridge_send', { to: 'alice/main', type: 'task', subject: '机密任务', body: '不应出现在 ntfy 上的正文' });
      const pubA = await ntfy.waitForPublishes(derivedTopic('acct/shared'), 1);
      assert.ok(pubA.length >= 1);
      const ring = JSON.parse(pubA.at(-1).message);
      assert.equal(ring.kind, 'ring');
      assert.equal(ring.issue, sent.issue);
      assert.equal(ring.from, 'wersky/main');
      assert.equal(ring.to, 'alice/main');
      assert.ok(!pubA.at(-1).message.includes('不应出现在'), '门铃只带元数据，不带正文');

      await b.call('bridge_reply', { issue: sent.issue, type: 'result', body: 'done' });
      const pubB = await ntfy.waitForPublishes(derivedTopic('acct/shared'), 2);
      assert.ok(pubB.length >= 2);

      await b.call('bridge_ack', { issue: sent.issue, note: 'ok' });
      const pubC = await ntfy.waitForPublishes(derivedTopic('acct/shared'), 3);
      assert.ok(pubC.length >= 3, 'ack 也应响铃（让发起方知道线程已闭环）');
    });
  });

  test('门铃关闭模式（BRIDGE_NTFY_TOPIC=off）：不发铃、wait 提示未开启', async () => {
    await withBridge(async ({ mk, ntfy }) => {
      const a = mk('wersky/main', { ntfyTopic: 'off' });
      const b = mk('alice/main', { ntfyTopic: 'off' });

      await a.call('bridge_send', { to: 'alice/main', type: 'chat', subject: '无铃消息' });
      await sleep(400);
      assert.equal(ntfy.publishes(derivedTopic('acct/shared')).length, 0, 'off 模式不应有任何发布');

      const w = await b.call('bridge_wait', { timeout: 1 });
      assert.equal(w.rung, false);
      assert.match(w.hint, /门铃未开启/);
    });
  });
});

describe('门铃接收', () => {
  test('bridge_wait 阻塞等铃：对方 send 后立即被唤醒（实测秒级）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const b = mk('alice/main');

      // B 先挂起等待（不 await），A 随后发送
      const waitPromise = b.call('bridge_wait', { timeout: 10 });
      await sleep(600); // 给 B 的 ntfy 订阅流一点建立时间
      const t0 = Date.now();
      const sent = await a.call('bridge_send', { to: 'alice/main', type: 'chat', subject: '门铃测试' });

      const w = await waitPromise;
      assert.equal(w.rung, true, '对方 send 后门铃应立即响');
      assert.ok(w.rings.some(r => r.issue === sent.issue), `铃应指向新线程 #${sent.issue}`);
      assert.ok(w.waitedMs < 5000, `从 send 到唤醒应秒级（实际 ${w.waitedMs}ms）`);
      assert.ok(Date.now() - t0 < 5000);
    });
  });

  test('ring 非阻塞查看 + 消费语义（取走即清空）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const b = mk('alice/main');
      // 先让 B 的订阅流建立
      await b.call('bridge_ring', {});
      await a.call('bridge_send', { to: 'alice/main', type: 'chat', subject: 'x' });
      await sleep(800);

      const r1 = await b.call('bridge_ring', {});
      assert.equal(r1.enabled, true);
      assert.ok(r1.rings.length >= 1, '应有未消费的铃');
      const r2 = await b.call('bridge_ring', {});
      assert.equal(r2.rings.length, 0, 'ring 取走即清空，不重复投递');
    });
  });

  test('身份过滤：发给别人的铃不投递；自己的铃不回声', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const carol = mk('carol/main');
      const b = mk('alice/main');

      // 各自先建立订阅流（bridge_ring 立即返回，订阅在后台异步建立）
      await a.call('bridge_ring', {});
      await carol.call('bridge_ring', {});
      await b.call('bridge_ring', {});
      await sleep(600);

      await carol.call('bridge_send', { to: 'alice/main', type: 'chat', subject: '给 alice' });
      await sleep(800);

      const inA = await a.call('bridge_ring', {});
      assert.equal(inA.rings.length, 0, 'wersky 不应收到发给 alice 的铃');
      const inC = await carol.call('bridge_ring', {});
      assert.equal(inC.rings.length, 0, '发件人自己不应收到自己的铃（回声抑制）');
      const inB = await b.call('bridge_ring', {});
      assert.ok(inB.rings.length >= 1, 'alice 应收到');
    });
  });

  test('bridge_wait 丢弃进入时的陈旧铃（只等"等待期间新到"的铃）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const b = mk('alice/main');
      // 先让 B 订阅流建立，再让 A 发一条（这条会成为 B 缓冲区里的"陈旧铃"）
      await b.call('bridge_ring', {});
      await sleep(600);
      await a.call('bridge_send', { to: 'alice/main', type: 'chat', subject: '陈旧铃' });
      await sleep(900); // 铃已进 B 的缓冲

      // bridge_wait 不应把这条旧铃当成刚响的铃
      const w = await b.call('bridge_wait', { timeout: 2 });
      assert.equal(w.rung, false, '旧铃不应让 wait 立即返回 true（会把旧消息误判为新到达）');
      assert.match(String(w.discarded ?? ''), /陈旧铃|旧铃|1 条/);

      // 而 bridge_ring 应仍能主动取到它（丢弃只发生在 wait 的语义里）
      const r = await b.call('bridge_ring', {});
      assert.equal(r.rings.length, 0, 'wait 已丢弃，ring 不再重复给');
    });
  });

  test('ack 响铃让发起方知道线程已闭环', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const b = mk('alice/main');
      const sent = await a.call('bridge_send', { to: 'alice/main', type: 'task', subject: '任务' });
      await b.call('bridge_ack', { issue: sent.issue, note: '完成' });

      // a 的监听流此刻才建立，stub 会重放历史铃（含 task 铃与 ack 铃）
      await a.call('bridge_ring', {});
      await sleep(800);
      const r = await a.call('bridge_ring', {});
      assert.ok(r.rings.some(x => x.issue === sent.issue && x.type === 'ack'), '发起方应收 ack 铃');
    });
  });
});
