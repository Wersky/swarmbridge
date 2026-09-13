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
// ntfy stub：记录门铃发布 + 支持 JSON 订阅流（含建立连接时的重放）
// ---------------------------------------------------------------------------
export function startNtfyStub() {
  const topics = new Map();   // topic → [{id, time, message}]
  const streams = new Map();  // topic → Set<res>
  let nextId = 1;

  function broadcast(topic, msg) {
    for (const res of streams.get(topic) ?? []) {
      try { res.write(JSON.stringify(msg) + '\n'); } catch { /* 断开的连接 */ }
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://ntfy-stub');
    const topic = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      // POST /{topic} —— 发布门铃
      if (req.method === 'POST') {
        const list = topics.get(topic) ?? [];
        const msg = {
          id: String(nextId++),
          // 毫秒精度：server 端用发布时间与订阅时刻比较来丢弃重放的历史铃（见 subscribedAt），
          // 秒级精度会让同秒内发布的铃被误判为历史（实测踩过）。
          time: Date.now() / 1000,
          event: 'message',
          message: Buffer.concat(chunks).toString('utf8'),
        };
        list.push(msg);
        topics.set(topic, list);
        broadcast(topic, msg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: msg.id }));
        return;
      }
      // GET /{topic}/json —— 订阅流：先重放历史，再保持连接推送新消息
      if (req.method === 'GET' && url.pathname.endsWith('/json')) {
        // ⚠️ 流的 topic 必须去掉 /json 后缀，与 POST 的 key 一致，
        // 否则 broadcast 永远找不到订阅流（实测踩过）。
        const streamTopic = topic.replace(/\/json$/, '');
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        // ⚠️ writeHead 只缓存头部，首次 body write 才上线。空主题若无任何写入，
        // 客户端会永远收不到响应（实测踩过：curl/fetch 双双超时）。
        // 真实 ntfy 也会先推一条 open 事件，这里保持一致。
        res.write(JSON.stringify({ event: 'open', time: Math.floor(Date.now() / 1000) }) + '\n');
        const list = topics.get(streamTopic) ?? [];
        for (const msg of list) res.write(JSON.stringify(msg) + '\n');
        if (!streams.has(streamTopic)) streams.set(streamTopic, new Set());
        streams.get(streamTopic).add(res);
        // ⚠️ 必须监听 res 的 close（连接断开），而不是 req 的——
        // GET 请求体结束后 req 的 close 会立刻触发，把刚注册的流删掉，
        // 之后所有广播都找不到订阅者（实测踩过：铃发出去但没人收到）。
        res.on('close', () => streams.get(streamTopic)?.delete(res));
        return; // 保持连接
      }
      res.writeHead(404); res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        /** 等待某主题出现 ≥n 条发布（门铃是 fire-and-forget，断言前要等它落地） */
        async waitForPublishes(topic, n = 1, maxMs = 4000) {
          const t0 = Date.now();
          for (;;) {
            if ((topics.get(topic)?.length ?? 0) >= n) return topics.get(topic);
            if (Date.now() - t0 > maxMs) return topics.get(topic) ?? [];
            await new Promise(r => setTimeout(r, 50));
          }
        },
        publishes: (topic) => topics.get(topic) ?? [],
        close: () => {
          for (const set of streams.values()) for (const res of set) { try { res.destroy(); } catch { /* 已断开 */ } }
          server.close();
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// swarmbridge server 子进程客户端
// ---------------------------------------------------------------------------
export function connect({ identity, workspace, apiBase, token = GOOD_TOKEN, repo = 'acct/shared', ntfyUrl, ntfyTopic }) {
  const child = registerChild(spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BRIDGE_API_BASE: apiBase,
      BRIDGE_TOKEN: token,
      BRIDGE_ID: identity,
      BRIDGE_REPO: repo,
      // 门铃默认指向不可达地址：不经过 withBridge（注入 stub ntfy）的连接绝不触达真实 ntfy
      BRIDGE_NTFY_URL: ntfyUrl ?? 'http://127.0.0.1:1',
      BRIDGE_NTFY_TOPIC: ntfyTopic ?? '',
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
    child, rpc, call, callRaw, stderr: () => stderrBuf,
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
  const ntfy = await startNtfyStub();
  const conns = [];
  const wsDir = makeWorkspace();
  const mk = (identity, extra = {}) => {
    const c = connect({ identity, workspace: wsDir, apiBase: stub.url, ntfyUrl: ntfy.url, ...extra });
    conns.push(c);
    return c;
  };
  try {
    return await fn({ stub, ntfy, mk, workspace: wsDir });
  } finally {
    for (const c of conns) { try { c.kill(); } catch { /* 已退出 */ } }
    // 给优雅退出留一点时间，再兜底强杀
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    reapAll();
    stub.close();
    ntfy.close();
    rmWorkspace(wsDir);
  }
}
export const TOKEN = GOOD_TOKEN;
