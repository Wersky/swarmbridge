/**
 * plan 消息类型（PPR 计划的跨机器载体）测试。
 *
 * 背景：对方收到 plan 后要照它建本地任务树（含 role/reviewer 字段，驱动审核门）。
 * 字段漂移会静默降级成普通聊天，审核门白设——因此发送端必须卡住格式。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withBridge } from './helpers.mjs';

const GOOD_PLAN = {
  plan: [
    { id: 'p1', title: '出计划', role: 'planner' },
    { id: 'p2', title: '实现接口', role: 'producer', dependsOn: ['p1'], reviewer: 'alice/main' },
    { id: 'p3', title: '验收', role: 'reviewer', dependsOn: ['p2'], reviewer: 'alice/main' },
  ],
  reviewer: 'alice/main',
  producer: 'alice/agent-1',
};

describe('plan 消息（PPR 计划载体）', () => {
  test('合法计划可发送并原样收到（含 role/reviewer 分工）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const b = mk('alice/main');

      const sent = await a.call('bridge_send', {
        to: 'alice/main', type: 'plan', subject: '登录模块 PPR 计划',
        body: '按计划分工执行，reviewer 由你方担任', data: GOOD_PLAN,
      });
      assert.ok(sent.issue);

      const inbox = await b.call('bridge_inbox', {});
      const got = inbox.messages.find(m => m.issue === sent.issue);
      assert.ok(got, '对方应收到 plan 消息');
      assert.equal(got.type, 'plan');
      assert.equal(got.data.plan.length, 3, '计划子项应完整传递');
      assert.equal(got.data.plan[1].role, 'producer');
      assert.equal(got.data.plan[1].reviewer, 'alice/main', '审核者分工必须传到');
      assert.deepEqual(got.data.plan[1].dependsOn, ['p1']);
      assert.equal(got.data.reviewer, 'alice/main', '计划级默认 reviewer 应传递');
    });
  });

  test('缺 data.plan 被拒绝（给出可行动的写法）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const r = await a.callRaw('bridge_send', { to: 'alice/main', type: 'plan', subject: 'x', data: {} });
      assert.equal(r.ok, false);
      assert.match(r.error, /data\.plan/);
      assert.match(r.error, /非空数组|title/, '错误应说明怎么写');
    });
  });

  test('plan 为空数组被拒绝', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const r = await a.callRaw('bridge_send', { to: 'alice/main', type: 'plan', data: { plan: [] } });
      assert.equal(r.ok, false);
      assert.match(r.error, /非空数组/);
    });
  });

  test('子项缺 title 被拒绝（指出是第几项）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const r = await a.callRaw('bridge_send', {
        to: 'alice/main', type: 'plan', data: { plan: [{ title: 'ok' }, { role: 'producer' }] },
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /plan\[1\]/, '错误应指出具体是哪一项');
      assert.match(r.error, /title/);
    });
  });

  test('非法 role 被拒绝并列出可用值', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const r = await a.callRaw('bridge_send', {
        to: 'alice/main', type: 'plan', data: { plan: [{ title: 'x', role: '经理' }] },
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /planner|producer|reviewer/);
    });
  });

  test('dependsOn 类型错误被拒绝', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const r = await a.callRaw('bridge_send', {
        to: 'alice/main', type: 'plan', data: { plan: [{ title: 'x', dependsOn: 'p1' }] },
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /dependsOn/);
      assert.match(r.error, /数组/);
    });
  });

  test('非 plan 类型的 data 不受此校验（自由格式仍是自由格式）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const ok = await a.callRaw('bridge_send', { to: 'alice/main', type: 'chat', data: { 随意: '字段' } });
      assert.equal(ok.ok, true, 'chat 类型的 data 不应被 plan 规则约束');
    });
  });

  test('plan 消息可被回帖与 ack（走完整线程语义）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const b = mk('alice/main');
      const sent = await a.call('bridge_send', { to: 'alice/main', type: 'plan', subject: '计划', data: GOOD_PLAN });

      // 对方接收计划 → 回执已收到并开始执行
      await b.call('bridge_reply', {
        issue: sent.issue, type: 'status', body: '计划已接收，开始按分工执行',
        data: { accepted: true, myRole: 'producer', items: ['p2'] },
      });
      const thread = await a.call('bridge_read', { issue: sent.issue });
      assert.equal(thread.head.type, 'plan');
      assert.equal(thread.replies.length, 1);
      assert.equal(thread.replies[0].data.accepted, true);

      // 全部完成后 ack 闭环
      const ack = await b.call('bridge_ack', { issue: sent.issue, note: '按计划完成' });
      assert.equal(ack.state, 'closed');
    });
  });
});
