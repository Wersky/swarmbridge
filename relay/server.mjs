#!/usr/bin/env node
/**
 * relay/server.mjs — 自建中继（⚠️ 实验性，未经跨机实测，不保证稳定性）
 *
 * 是什么：一个**独立于 GitHub 的**消息仓库服务，实现 swarmbridge 所需的
 * GitHub API 子集（issues + comments + 状态变更）。两台机器的 swarmbridge
 * 把 BRIDGE_API_BASE 指向它，即可在**不经过 GitHub** 的情况下互通——
 * 延迟 ≈ 网络 RTT（同内网/组网下 10~200ms），无限额、无平台传播延迟。
 *
 * ⚠️ 稳定性声明：本中继随 swarmbridge 1.1.0 一起发布，但**没有在真实的
 * 跨机部署中测试过**（作者只有单机环境）。它只做过本机回环测试。生产使用
 * 前请自行评估；追求稳定请用默认的 GitHub 模式（`bridge_ack`/游标等协议
 * 完全一致，随时可切回，把 BRIDGE_API_BASE 改回 https://api.github.com 即可）。
 *
 * 用法：
 *   node relay/server.mjs --port 8787 --token <共享密钥> --data <数据目录>
 *   （数据目录默认 ./swarmbridge-relay-data；请放在两台机器都能访问的位置，
 *     或让中继本身跑在其中一台机器/一台 VPS 上，另一台通过组网访问）
 *
 * 两端配置（swarmbridge 环境变量）：
 *   BRIDGE_API_BASE=http://<中继地址>:8787
 *   BRIDGE_TOKEN=<共享密钥>
 *   BRIDGE_REPO=bridge/main   （中继不区分仓库，填任意 owner/name 形式即可）
 *
 * 已知限制：
 *   - 单进程内存 + JSON 文件持久化，重启瞬间写入窗口可能丢最后一条（重启前
 *     会尽力落盘）；不适合多人生产。
 *   - 无 TLS：公网部署请自己套反代（nginx/caddy）或只在内网/组网内使用。
 *   - 不实现分页（一次性全量返回）；任务量大时自行加 per_page。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { port: 8787, token: '', data: path.join(process.cwd(), 'swarmbridge-relay-data'), host: '0.0.0.0' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--data') opts.data = argv[++i];
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--help' || a === '-h') { console.log('见文件头注释'); process.exit(0); }
  }
  if (!opts.token) {
    console.error('[relay] 必须提供 --token <共享密钥>：两端 swarmbridge 的 BRIDGE_TOKEN 必须与之相同。');
    process.exit(2);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const dataFile = path.join(opts.data, 'relay-state.json');

// ---------------------------------------------------------------------------
// 持久化：内存为准，落地用 tmp→rename 原子替换。单进程 + 同步写，量小够用。
// ---------------------------------------------------------------------------
let state = { issues: {}, counters: { issue: 0, comment: 0 } };
try {
  const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  if (raw && raw.issues) state = raw;
} catch { /* 首次启动 */ }

let saveTimer = null;
function save() {
  // 防抖落盘：高频收发时不至于每条消息都写盘；进程退出前再兜底一次
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      const tmp = `${dataFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, dataFile);
    } catch (e) {
      console.error('[relay] 落盘失败：', e.message);
    }
  }, 300);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      fs.writeFileSync(`${dataFile}.tmp-exit`, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(`${dataFile}.tmp-exit`, dataFile);
    } catch { /* ignore */ }
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// HTTP 服务：实现 swarmbridge 需要的 GitHub API 子集
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj ?? {}));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // 鉴权：两端 BRIDGE_TOKEN 必须与 --token 一致
    if (req.headers.authorization !== `Bearer ${opts.token}`) {
      return json(res, 401, { message: 'Bad credentials（--token 不匹配）' });
    }
    let body = null;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
    const url = new URL(req.url, 'http://relay');
    const parts = url.pathname.split('/').filter(Boolean); // ['repos', o, n, ...]

    try {
      // GET /health —— 不需要仓库语义
      if (parts[0] === 'health') return json(res, 200, { ok: true, issues: Object.keys(state.issues).length });

      if (parts[0] !== 'repos') return json(res, 404, { message: 'Not Found' });
      const repoKey = `${parts[1]}/${parts[2]}`;
      state.issues[repoKey] ??= {};

      // GET /repos/:o/:n
      if (parts.length === 3 && req.method === 'GET') {
        return json(res, 200, { full_name: repoKey, private: true, permissions: { push: true } });
      }

      if (parts[3] !== 'issues') return json(res, 404, { message: 'Not Found' });
      const repo = state.issues[repoKey];

      // POST /repos/:o/:n/issues —— 建线程
      if (parts.length === 4 && req.method === 'POST') {
        const num = ++state.counters.issue;
        repo[num] = {
          number: num, title: body?.title ?? '', body: body?.body ?? '', state: 'open',
          updated_at: nowIso(), comments: [], html_url: `relay://${repoKey}/${num}`,
        };
        save();
        return json(res, 201, repo[num]);
      }

      // GET /repos/:o/:n/issues —— 列表（since 增量，按 updated_at 降序）
      if (parts.length === 4 && req.method === 'GET') {
        const since = url.searchParams.get('since');
        let all = Object.values(repo);
        if (since) all = all.filter(i => i.updated_at > since);
        all.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        return json(res, 200, all.map(publicIssue));
      }

      const n = Number(parts[4]);
      const it = repo[n];
      if (!it) return json(res, 404, { message: 'Not Found' });

      if (parts.length === 5 && req.method === 'GET') return json(res, 200, publicIssue(it));

      if (parts.length === 5 && req.method === 'PATCH') {
        if (body?.state) { it.state = body.state; it.updated_at = nowIso(); save(); }
        return json(res, 200, publicIssue(it));
      }

      if (parts.length === 6 && parts[5] === 'comments') {
        if (req.method === 'GET') {
          return json(res, 200, it.comments.map(c => ({ id: c.id, body: c.body, created_at: c.created_at, user: { login: 'relay' } })));
        }
        if (req.method === 'POST') {
          const c = { id: ++state.counters.comment, body: body?.body ?? '', created_at: nowIso() };
          it.comments.push(c);
          it.updated_at = c.created_at;
          save();
          return json(res, 201, c);
        }
      }

      return json(res, 404, { message: 'Not Found' });
    } catch (err) {
      return json(res, 500, { message: err?.message ?? 'internal' });
    }
  });
});

/** 对外形态：comments 字段是计数（与真实 GitHub 一致），内部存数组 */
function publicIssue(it) {
  return { ...it, comments: it.comments.length };
}

server.listen(opts.port, opts.host, () => {
  const addr = server.address();
  console.log(`[relay] 监听 http://${addr.address}:${addr.port}`);
  console.log(`[relay] 数据文件: ${dataFile}`);
  console.log(`[relay] 两端配置: BRIDGE_API_BASE=http://<本机可达地址>:${opts.port}  BRIDGE_TOKEN=<与 --token 相同>  BRIDGE_REPO=bridge/main`);
  console.log('[relay] ⚠️ 实验性组件：未经跨机实测，不保证稳定性。追求稳定请用 GitHub 模式。');
});
