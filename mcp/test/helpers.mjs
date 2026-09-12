/**
 * 测试辅助：本地 GitHub API stub + swarmbridge server 子进程客户端。
 *
 * 为什么不直接连真 GitHub：
 *  - 测试必须离线可跑、可重复、不受限流影响；
 *  - 协议逻辑（信封/寻址/游标/ack）与"GitHub 那头"解耦后，替换传输层即可验证；
 *  - 真实 GitHub 的连通性由单独的 live 测试覆盖（需要 token，默认跳过）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

// ---------------------------------------------------------------------------
// 活跃子进程登记（测试异常退出时统一收割，不留孤儿 node 进程）
// ---------------------------------------------------------------------------
const liveChildren = new Set();
function registerChild(child) {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  child.once('close', () => liveChildren.delete(child));
  return child;
}
function reapAll() {
  for (const c of liveChildren) {
    try { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  liveChildren.clear();
}
process.on('exit', reapAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { reapAll(); process.exit(130); });
export { reapAll };

// ---------------------------------------------------------------------------
// GitHub API stub
// ---------------------------------------------------------------------------
const GOOD_TOKEN = 'good-token';

export function startGithubStub() {
  const issues = new Map();   // number → {number,title,body,state,updated_at,comments:[],html_url}
  const counters = { issue: 0, comment: 0 };
  let now = Date.now();

  const iso = () => new Date(now++).toISOString(); // 每次调用时间前移，保证 updated_at 严格递增

  function findIssue(n) {
    const it = issues.get(Number(n));
    if (!it) throw httpError(404, 'Not Found');
    return it;
  }
  /** 对外（MCP server 眼中）的 issue 形态：comments 是**计数**，与真实 GitHub 一致 */
  function publicIssue(it) {
    return { ...it, comments: it.comments.length };
  }
  function httpError(status, message) {
    const e = new Error(message);
    e.statusCode = status;
    return e;
  }
  function requireAuth(req) {
    if (req.headers.authorization !== `Bearer ${GOOD_TOKEN}`) throw httpError(401, 'Bad credentials');
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const url = new URL(req.url, 'http://stub');
      const parts = url.pathname.split('/').filter(Boolean); // ['repos', o, r, ...]
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'x-ratelimit-remaining': '4999' });
        res.end(JSON.stringify(obj ?? {}));
      };
      try {
        requireAuth(req);
        // GET /repos/:o/:n
        if (parts[0] === 'repos' && parts.length === 3 && req.method === 'GET') {
          return send(200, { full_name: `${parts[1]}/${parts[2]}`, private: true, permissions: { push: true } });
        }
        if (parts[0] !== 'repos' || parts[3] !== 'issues') return send(404, { message: 'Not Found' });
        const key = `${parts[1]}/${parts[2]}`;

        // POST /repos/:o/:r/issues —— 建线程
        if (parts.length === 4 && req.method === 'POST') {
          const num = ++counters.issue;
          const it = {
            number: num, title: body.title, body: body.body, state: 'open',
            updated_at: iso(), comments: [], html_url: `https://github.com/${key}/issues/${num}`,
          };
          issues.set(num, it);
          return send(201, publicIssue(it));
        }
        // GET /repos/:o/:r/issues —— 列表（since 增量、按 updated_at 降序）
        if (parts.length === 4 && req.method === 'GET') {
          const since = url.searchParams.get('since');
          let all = [...issues.values()];
          if (since) all = all.filter(i => i.updated_at > since);
          all.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
          return send(200, all.map(publicIssue));
        }
        const n = Number(parts[4]);
        // GET/PATCH /repos/:o/:r/issues/:n
        if (parts.length === 5 && req.method === 'GET') return send(200, publicIssue(findIssue(n)));
        if (parts.length === 5 && req.method === 'PATCH') {
          const it = findIssue(n);
          if (body.state) { it.state = body.state; it.updated_at = iso(); }
          return send(200, it);
        }
        // GET/POST /repos/:o/:r/issues/:n/comments
        if (parts.length === 6 && parts[5] === 'comments' && req.method === 'GET') {
          return send(200, findIssue(n).comments.map(c => ({ id: c.id, body: c.body, created_at: c.created_at, user: { login: 'stub-user' } })));
        }
        if (parts.length === 6 && parts[5] === 'comments' && req.method === 'POST') {
          const it = findIssue(n);
          const c = { id: ++counters.comment, body: body.body, created_at: iso() };
          it.comments.push(c);
          it.comments_count = it.comments.length;
          it.updated_at = c.created_at;
          return send(201, c);
        }
        return send(404, { message: 'Not Found' });
      } catch (err) {
        return send(err.statusCode ?? 500, { message: err.message });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => server.close(),
        issues,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// swarmbridge server 子进程客户端
// ---------------------------------------------------------------------------
export function connect({ identity, workspace, apiBase, token = GOOD_TOKEN, repo = 'acct/shared' }) {
  const child = registerChild(spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BRIDGE_API_BASE: apiBase,
      BRIDGE_TOKEN: token,
      BRIDGE_ID: identity,
      BRIDGE_REPO: repo,
      // 明确清空其他 token 变体，保证测试不受宿主环境影响
      GITHUB_TOKEN: '', GH_TOKEN: '',
    },
  }));
  let nextId = 1;
  const pending = new Map();
  let stderrBuf = '';
  child.stdout.on('data', (buf) => {
    for (const line of buf.toString().split('\n')) {
      const t = line.trim(); if (!t) continue;
      let m; try { m = JSON.parse(t); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  child.stderr.on('data', (b) => { stderrBuf += b.toString(); });

  // 快速失败：server 进程崩了（如语法错误）立刻拒绝挂起的调用，
  // 否则每条 RPC 都要白等 30s 超时，整个测试套件像挂死一样。
  child.on('exit', (code) => {
    for (const [id, res] of pending) {
      pending.delete(id);
      res({ jsonrpc: '2.0', id, error: { code: -32000, message: `server 进程已退出（code=${code}）：${stderrBuf.slice(0, 300)}` } });
    }
  });

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC 超时：${method}；stderr: ${stderrBuf.slice(0, 200)}`)); }, 30000);
    pending.set(id, (v) => { clearTimeout(timer); resolve(v); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  async function callRaw(name, args) {
    // 注入 workspace：server 的游标落在 <workspace>/.swarmbridge/，
    // 不传会回退到 server 进程 cwd（跨测试/跨身份互相污染——实测踩过）。
    const withWs = { workspace, ...(args ?? {}) };
    const res = await rpc('tools/call', { name, arguments: withWs });
    if (res.error) return { ok: false, error: `rpc: ${res.error.message}` };
    let data; try { data = JSON.parse(res.result?.content?.[0]?.text ?? '{}'); } catch { return { ok: false, error: '返回不是 JSON' }; }
    return res.result.isError ? { ok: false, error: String(data.error ?? '') } : { ok: true, data };
  }
  async function call(name, args) {
    const r = await callRaw(name, args);
    if (!r.ok) throw new Error(`[${name}] ${r.error}`);
    return r.data;
  }

  return {
    child, rpc, call, callRaw,
    kill() {
      try { child.stdin.end(); } catch { /* 已关闭 */ }
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 1500);
      if (typeof t.unref === 'function') t.unref();
      child.once('exit', () => clearTimeout(t));
    },
  };
}

export function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swarmbridge-test-'));
}
export function rmWorkspace(dir) {
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* Windows 偶发占用，稍后重试 */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
  }
}

/**
 * 每个测试一个独立 stub + 强制清理的运行容器。
 *
 * 为什么必须这样：
 *  1. stub 若跨测试共享，而收件箱默认看最近 24h，后面的测试会看到前面测试的消息，
 *     计数断言互相污染；
 *  2. 任何一条没被 kill 的连接都会让父进程事件循环不排空（子进程管道是活跃句柄），
 *     node --test 进程不退出，管道下游的 tail 永远等不到 EOF —— 看起来像"卡死"。
 * finally 里统一 kill + close + 删目录，断言失败也不会泄漏。
 */
export async function withBridge(fn, opts = {}) {
  const stub = await startGithubStub();
  const conns = [];
  const wsDir = makeWorkspace();
  const mk = (identity, extra = {}) => {
    const c = connect({ identity, workspace: wsDir, apiBase: stub.url, ...extra });
    conns.push(c);
    return c;
  };
  try {
    return await fn({ stub, mk, workspace: wsDir });
  } finally {
    for (const c of conns) { try { c.kill(); } catch { /* 已退出 */ } }
    // 给优雅退出留一点时间，再兜底强杀
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    reapAll();
    stub.close();
    rmWorkspace(wsDir);
  }
}
export const TOKEN = GOOD_TOKEN;
