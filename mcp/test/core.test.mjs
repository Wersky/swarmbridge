/**
 * swarmbridge 核心行为测试（离线：每个测试一个独立的本地 GitHub stub）。
 *
 * 覆盖：协议层、收发闭环（send → inbox → reply → read → ack）、
 * 寻址与过滤（精确/通配/广播/排除自己/排除人类帖子）、子身份、
 * 游标持久化、错误路径（无 token / 401 / 网络失败 / 消息过大 / 参数缺失）。
 *
 * 结构要求：所有测试经 withBridge 运行 —— 每个测试独立的 stub 与工作区，
 * finally 统一收割子进程，保证隔离且不泄漏（详见 helpers.withBridge 注释）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withBridge, connect, makeWorkspace, rmWorkspace } from './helpers.mjs';

describe('协议层', () => {
  test('initialize 与 tools/list（6 个工具）', async () => {
    await withBridge(async ({ mk }) => {
      const c = mk('wersky/main');
      const init = await c.rpc('initialize', {});
      assert.equal(init.result.serverInfo.name, 'swarmbridge');
      const list = await c.rpc('tools/list', {});
      assert.deepEqual(list.result.tools.map(t => t.name).sort(), [
        'bridge_ack', 'bridge_inbox', 'bridge_read', 'bridge_reply', 'bridge_ring',
        'bridge_send', 'bridge_status', 'bridge_wait',
      ]);
    });
  });

  test('非法 JSON 行后仍能继续服务', async () => {
    await withBridge(async ({ mk }) => {
      const c = mk('wersky/main');
      c.child.stdin.write('这不是 JSON\n');
      const res = await c.rpc('ping', {});
      assert.ok(res.result !== undefined);
    });
  });

  test('未知工具给出可用工具清单', async () => {
    await withBridge(async ({ mk }) => {
      const c = mk('wersky/main');
      const r = await c.callRaw('bridge_不存在', {});
      assert.equal(r.ok, false);
      assert.match(r.error, /bridge_send/);
    });
  });
});

describe('配置与连通性', () => {
  test('无 token 时给出可读错误', async () => {
    await withBridge(async ({ mk }) => {
      const c = mk('x/main', { token: '' });
      const r = await c.callRaw('bridge_status', { check: true });
      assert.equal(r.ok, false);
      assert.match(r.error, /GITHUB_TOKEN/);
    });
  });

  test('status + check:true 返回连通信息与延迟', async () => {
    await withBridge(async ({ mk }) => {
      const c = mk('wersky/main');
      const s = await c.call('bridge_status', { check: true });
      assert.equal(s.identity, 'wersky/main');
      assert.equal(s.repo, 'acct/shared');
      assert.equal(s.connectivity.ok, true);
      assert.equal(s.connectivity.repoFullName, 'acct/shared');
      assert.ok(s.connectivity.latencyMs >= 0);
    });
  });
});

describe('收发闭环', () => {
  test('send → 对方 inbox → reply → 我方 inbox → read → ack 闭环', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const b = mk('alice/main');

      const sent = await a.call('bridge_send', {
        to: 'alice/main', type: 'task', subject: '实现登录接口',
        body: '按 docs/api.md 的约定实现 /login', data: { goal: '登录接口', detail: '含 429 退避' },
      });
      assert.ok(sent.issue >= 1);

      const inboxB = await b.call('bridge_inbox', {});
      assert.equal(inboxB.count, 1);
      assert.equal(inboxB.messages[0].from, 'wersky/main');
      assert.equal(inboxB.messages[0].type, 'task');
      assert.deepEqual(inboxB.messages[0].data, { goal: '登录接口', detail: '含 429 退避' });

      const inboxA0 = await a.call('bridge_inbox', {});
      assert.equal(inboxA0.count, 0, '自己发的消息不应出现在自己的收件箱');

      await b.call('bridge_reply', { issue: sent.issue, type: 'result', body: '已完成，代码在 feat/login 分支', data: { branch: 'feat/login' } });

      const inboxA1 = await a.call('bridge_inbox', {});
      assert.equal(inboxA1.count, 1, '对方回帖应让线程重新出现在我的收件箱');
      assert.equal(inboxA1.messages[0].issue, sent.issue);
      assert.equal(inboxA1.messages[0].replies, 1);

      const thread = await a.call('bridge_read', { issue: sent.issue });
      assert.equal(thread.head.type, 'task');
      assert.equal(thread.replies.length, 1);
      assert.equal(thread.replies[0].from, 'alice/main');
      assert.equal(thread.replies[0].type, 'result');
      assert.deepEqual(thread.replies[0].data, { branch: 'feat/login' });

      const ack = await b.call('bridge_ack', { issue: sent.issue, note: '已合并' });
      assert.equal(ack.state, 'closed');

      const threadAfter = await a.call('bridge_read', { issue: sent.issue });
      assert.equal(threadAfter.state, 'closed');
      assert.equal(threadAfter.replies.at(-1).type, 'ack');
    });
  });

  test('游标持久化：不重复吐旧消息；进程重启后游标从磁盘恢复', async () => {
    await withBridge(async ({ mk, workspace }) => {
      const a = mk('wersky/main');
      let b = mk('alice/main');

      assert.equal((await b.call('bridge_inbox', {})).count, 0);

      await a.call('bridge_send', { to: 'alice/main', type: 'chat', subject: 'm1' });
      assert.equal((await b.call('bridge_inbox', {})).count, 1);
      assert.equal((await b.call('bridge_inbox', {})).count, 0, '游标已推进，不应重复');

      // 模拟会话中断重启：换一个新进程连同一个工作区（游标在磁盘上）
      b.kill();
      b = mk('alice/main');
      await a.call('bridge_send', { to: 'alice/main', type: 'chat', subject: 'm2' });
      const got = await b.call('bridge_inbox', {});
      assert.deepEqual(got.messages.map(m => m.subject), ['m2'], '重启后只应看到新消息 m2');
    });
  });
});

describe('寻址与过滤', () => {
  test('to=第三方不进我的收件箱；广播两边都收到', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const b = mk('alice/main');
      const carol = mk('carol/main');
      await carol.call('bridge_send', { to: 'alice/main', type: 'chat', subject: '只给 alice' });
      await carol.call('bridge_send', { to: '*', type: 'chat', subject: '广播' });

      const inA = await a.call('bridge_inbox', {});
      assert.deepEqual(inA.messages.map(m => m.subject), ['广播']);
      const inB = await b.call('bridge_inbox', {});
      assert.equal(inB.messages.length, 2);
      assert.ok(inB.messages.some(m => m.subject === '广播'));
      assert.ok(inB.messages.some(m => m.subject === '只给 alice'));
    });
  });

  test('子身份寻址：wersky/* 由主身份代收；wersky/agent-2 精确投递', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const a2 = mk('wersky/agent-2');
      const b = mk('alice/main');
      await b.call('bridge_send', { to: 'wersky/*', type: 'chat', subject: '给 wersky 全体' });
      await b.call('bridge_send', { to: 'wersky/agent-2', type: 'chat', subject: '点名 agent-2' });

      const inMain = await a.call('bridge_inbox', {});
      assert.deepEqual(inMain.messages.map(m => m.subject), ['给 wersky 全体'],
        '点名 agent-2 的消息不应由 main 代收');
      const inA2 = await a2.call('bridge_inbox', {});
      assert.equal(inA2.messages.length, 2);
      assert.ok(inA2.messages.some(m => m.subject === '给 wersky 全体'));
      assert.ok(inA2.messages.some(m => m.subject === '点名 agent-2'));
    });
  });

  test('人类手写的 issue（无信封）不进收件箱', async () => {
    await withBridge(async ({ mk, stub }) => {
      const a = mk('wersky/main');
      const sent = await a.call('bridge_send', { to: 'alice/main', type: 'chat', subject: '占位' });
      const it = stub.issues.get(sent.issue);
      it.body = '这是人类手写的内容，不是 JSON';
      it.updated_at = new Date(Date.now() + 86400000).toISOString();

      const b = mk('alice/main');
      assert.equal((await b.call('bridge_inbox', {})).count, 0);
    });
  });

  test('子代理用 from 覆盖身份发消息（跨方并行沟通的基础）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      await a.call('bridge_send', { to: 'alice/main', type: 'chat', subject: '来自子代理', from: 'wersky/agent-1' });
      const inB = await mk('alice/main').call('bridge_inbox', {});
      assert.equal(inB.messages[0].from, 'wersky/agent-1', '对方看到的发件人应是子身份');
    });
  });
});

describe('错误路径', () => {
  test('401 → 指向 token 问题', async () => {
    await withBridge(async ({ mk }) => {
      const c = mk('x/main', { token: 'wrong' });
      const r = await c.callRaw('bridge_inbox', {});
      assert.equal(r.ok, false);
      assert.match(r.error, /token|认证/);
    });
  });

  test('连不上 API → 指向网络/代理', async () => {
    await withBridge(async ({ mk }) => {
      const c = mk('x/main', { apiBase: 'http://127.0.0.1:1' });
      const r = await c.callRaw('bridge_inbox', {});
      assert.equal(r.ok, false);
      assert.match(r.error, /连接 GitHub API|网络|代理/);
    });
  });

  test('消息超过正文上限 → 明确报错并给出出路', async () => {
    await withBridge(async ({ mk }) => {
      const c = mk('wersky/main');
      const r = await c.callRaw('bridge_send', {
        to: 'alice/main', type: 'chat', subject: '太大',
        body: 'x'.repeat(40000), data: { blob: 'y'.repeat(40000) },
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /过大|60000/);
      assert.match(r.error, /文件|gist|链接/);
    });
  });

  test('缺 to / 缺 type → 指出缺什么、给例子', async () => {
    await withBridge(async ({ mk }) => {
      const c = mk('wersky/main');
      assert.match((await c.callRaw('bridge_send', { type: 'chat' })).error, /to/);
      assert.match((await c.callRaw('bridge_send', { to: 'alice/main' })).error, /type/);
    });
  });

  test('issue 编号非法 → 可读错误', async () => {
    await withBridge(async ({ mk }) => {
      const c = mk('wersky/main');
      assert.match((await c.callRaw('bridge_read', { issue: 'abc' })).error, /编号/);
    });
  });

  test('游标文件按身份隔离且为合法 JSON', async () => {
    await withBridge(async ({ mk, workspace }) => {
      const a = mk('wersky/main');
      const b = mk('alice/main');
      await a.call('bridge_inbox', {});
      await b.call('bridge_inbox', {});
      const dir = path.join(workspace, '.swarmbridge');
      const files = fs.readdirSync(dir);
      assert.equal(files.length, 2);
      for (const f of files) {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        assert.match(raw.identity, /^(wersky|alice)\/main$/);
        assert.ok(typeof raw.since === 'string');
      }
    });
  });
});
