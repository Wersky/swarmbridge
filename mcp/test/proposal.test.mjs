/**
 * proposal 消息类型（问题 + 建议新增计划项的跨机器提交通道）测试。
 *
 * 背景：生产者/子代理在跑任务时撞见的问题与补救动作，必须**结构化**发到桥线程，
 * 对方 reviewer 才能逐项采纳/驳回并直接并入本地任务树。若退化成自由文本，
 * 建议会被淹没在聊天里；items 字段刻意与 plan 子项同构，采纳后无需二次翻译。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withBridge } from './helpers.mjs';

const GOOD_ITEMS = [
  { id: 'n1', title: '补一个回归测试脚本', role: 'producer', assignee: 'alice/agent-1' },
  { id: 'n2', title: '验收回归脚本', role: 'reviewer', dependsOn: ['n1'], reviewer: 'wersky/main' },
];

describe('proposal 消息（问题 + 建议计划项）', () => {
  test('problem-only 合法并可往返（对方收到 data.problem）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const b = mk('alice/main');

      const sent = await a.call('bridge_send', {
        to: 'alice/main', type: 'proposal', subject: 'T2 阻塞：接口未实现',
        body: '发现阻塞，先报问题，建议项待定',
        data: { forTask: 'T2', problem: 'T2 依赖的鉴权接口尚未实现，无法联调' },
      });
      assert.ok(sent.issue);

      const inbox = await b.call('bridge_inbox', {});
      const got = inbox.messages.find(m => m.issue === sent.issue);
      assert.ok(got, '对方应收到 proposal 消息');
      assert.equal(got.type, 'proposal');
      assert.equal(got.data.problem, 'T2 依赖的鉴权接口尚未实现，无法联调');
      assert.equal(got.data.forTask, 'T2');
    });
  });

  test('items-only 合法并可往返（items 内容完整）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const b = mk('alice/main');

      const sent = await a.call('bridge_send', {
        to: 'alice/main', type: 'proposal', subject: '建议补两项',
        data: { forTask: 'T2', items: GOOD_ITEMS, rationale: '回归缺失导致同类 bug 反复出现' },
      });

      const inbox = await b.call('bridge_inbox', {});
      const got = inbox.messages.find(m => m.issue === sent.issue);
      assert.ok(got, '对方应收到 proposal 消息');
      assert.equal(got.data.items.length, 2, '建议项应完整传递');
      assert.equal(got.data.items[0].title, '补一个回归测试脚本');
      assert.equal(got.data.items[0].role, 'producer');
      assert.equal(got.data.items[0].assignee, 'alice/agent-1', 'assignee 应传递（供直接并入任务树）');
      assert.deepEqual(got.data.items[1].dependsOn, ['n1']);
      assert.equal(got.data.items[1].reviewer, 'wersky/main', 'reviewer 应传递（驱动审核门）');
      assert.equal(got.data.rationale, '回归缺失导致同类 bug 反复出现');
    });
  });

  test('缺 problem 与 items 被拒绝（说明至少写一个）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const r = await a.callRaw('bridge_send', {
        to: 'alice/main', type: 'proposal', subject: '空提案',
        data: { forTask: 'T2', rationale: '只有理由，没有内容' },
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /problem/);
      assert.match(r.error, /items/);
      assert.match(r.error, /至少/, '错误应说明至少写一个');
    });
  });

  test('items 第 2 项缺 title 被拒绝（错误含 data.items[1]）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const r = await a.callRaw('bridge_send', {
        to: 'alice/main', type: 'proposal',
        data: { items: [{ title: 'ok' }, { role: 'producer' }] },
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /data\.items\[1\]/, '错误应指出具体是哪一项');
      assert.match(r.error, /title/);
    });
  });

  test('非法 role 被拒绝并列出可用值', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const r = await a.callRaw('bridge_send', {
        to: 'alice/main', type: 'proposal',
        data: { items: [{ title: 'x', role: '经理' }] },
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /data\.items\[0\]\.role/);
      assert.match(r.error, /planner|producer|reviewer/, '错误应列出可用值');
    });
  });

  test('dependsOn 非数组被拒绝', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const r = await a.callRaw('bridge_send', {
        to: 'alice/main', type: 'proposal',
        data: { problem: 'x', items: [{ title: 'y', dependsOn: 'n1' }] },
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /dependsOn/);
      assert.match(r.error, /数组/);
    });
  });

  test('forTask 过长被拒绝', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const r = await a.callRaw('bridge_send', {
        to: 'alice/main', type: 'proposal',
        data: { problem: 'x', forTask: 'T'.repeat(81) },
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /forTask/);
      assert.match(r.error, /80/);
    });
  });

  test('bridge_reply 传 type=proposal 时同样被校验（非法数据被拒）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const b = mk('alice/main');
      const sent = await a.call('bridge_send', { to: 'alice/main', type: 'task', subject: '干活', data: { goal: 'x' } });

      // 回帖形式的提案走同一条校验：空提案被拒
      const bad = await b.callRaw('bridge_reply', { issue: sent.issue, type: 'proposal', body: '提个建议', data: { rationale: '只有理由' } });
      assert.equal(bad.ok, false);
      assert.match(bad.error, /problem|items/, '回帖的 proposal 也应被结构校验');

      // 合法提案回帖成功，并在发起方侧可见
      const good = await b.call('bridge_reply', {
        issue: sent.issue, type: 'proposal', body: '建议补回归',
        data: { forTask: 'T2', problem: '无回归导致反复', items: GOOD_ITEMS },
      });
      assert.equal(good.type, 'proposal');

      const thread = await a.call('bridge_read', { issue: sent.issue });
      assert.equal(thread.replies.length, 1);
      assert.equal(thread.replies[0].type, 'proposal');
      assert.equal(thread.replies[0].data.items.length, 2);
    });
  });

  test('非 proposal/plan 类型的 data 不受约束（chat 随意字段仍可发）', async () => {
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');
      const ok = await a.callRaw('bridge_send', { to: 'alice/main', type: 'chat', data: { 随意: '字段' } });
      assert.equal(ok.ok, true, 'chat 类型的 data 不应被 proposal 规则约束');
      const ok2 = await a.callRaw('bridge_send', { to: 'alice/main', type: 'chat', data: { items: '不是数组也行', problem: 123 } });
      assert.equal(ok2.ok, true, '非 proposal 类型不做结构校验');
    });
  });

  test('★ 身份/标识字段类型守卫：非字符串在发送端就被拦住（真机验证暴露的缺口）', async () => {
    // 背景：接收端会把 reviewer/assignee 落进任务，若桥放行 {x:1}，
    // 接收端会强转成 "[object Object]"——任务照进树但审核门永远没有合法裁决者。
    await withBridge(async ({ mk }) => {
      const a = mk('wersky/main');

      for (const field of ['reviewer', 'assignee', 'id', 'parentId']) {
        for (const [label, bad] of [['对象', { x: 1 }], ['数组', ['x']], ['数字', 42]]) {
          const r = await a.callRaw('bridge_send', {
            to: 'alice/main', type: 'proposal', subject: 'x',
            data: { items: [{ title: 't', [field]: bad }] },
          });
          assert.equal(r.ok, false, `proposal 的 ${field} 传${label}必须被拒`);
          assert.match(r.error, new RegExp(`${field} 必须是字符串`), `错误应点名 ${field}`);
          assert.match(r.error, /data\.items\[0\]/, '错误应定位到具体项');
        }
      }

      // plan 类型同样受保护（同一类校验不该只覆盖一条路径）
      const rp = await a.callRaw('bridge_send', {
        to: 'alice/main', type: 'plan',
        data: { plan: [{ title: 't', reviewer: { x: 1 } }] },
      });
      assert.equal(rp.ok, false, 'plan 的 reviewer 传对象也必须被拒');
      assert.match(rp.error, /reviewer 必须是字符串/);

      // 空字符串同样拒绝（避免落成空身份）
      const re = await a.callRaw('bridge_send', {
        to: 'alice/main', type: 'proposal', data: { items: [{ title: 't', reviewer: '   ' }] },
      });
      assert.equal(re.ok, false);
      assert.match(re.error, /不能是空字符串/);

      // 对照：合法字符串照常通过
      const good = await a.callRaw('bridge_send', {
        to: 'alice/main', type: 'proposal', subject: 'ok',
        data: { items: [{ title: 't', reviewer: 'alice/agent-9', assignee: 'alice/agent-1' }] },
      });
      assert.equal(good.ok, true, '合法身份字符串应正常发送');
    });
  });
});
