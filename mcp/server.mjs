#!/usr/bin/env node
/**
 * swarmbridge MCP server — 跨机器 Agent 通信桥（GitHub 仓库作为消息媒介）。
 *
 * 解决的问题：本机 taskswarm 让"我的主代理与我的子代理"互通（共享看板）；
 * 但两台机器各自的 agent/子代理彼此完全隔离。本桥用 GitHub 仓库的 Issues
 * 作为消息总线，让双方（各自的 agent + 子代理）能够并行收发消息：
 *
 *   issue   = 一条会话线程（首帖 = 信封 JSON）
 *   comment = 线程内的回帖（也是信封 JSON）
 *   close   = 接收方确认已处理（ack），发送方由此得到回执
 *
 * 为什么选 Issues 而不是仓库里的 JSON 状态文件：
 *   - 追加式、服务端落库，双方并发写不会产生 merge 冲突（git 提交方案需要
 *     拉取-变基-重试，并发下极易翻车）；
 *   - 自带 updated_at 时间戳，可用 ?since= 做增量拉取（廉价轮询）；
 *   - 自带评论线程与开关状态，天然就是"线程 + 回执"模型；
 *   - 人类也能直接在网页上看懂、参与。
 *
 * 实时性：GitHub 无法向本机推送（webhook 需要公网入口），因此采用**短轮询**——
 * 收件箱用 ?since= 游标增量拉取，延迟 = 轮询间隔 + 网络往返（秒级）。
 * 已认证 token 限额 5000 次/小时，多个 agent 以 ≥5s 间隔轮询完全够用。
 *
 * 零依赖：只用 Node 内置模块（Node ≥ 18 的内置 fetch）。
 *
 * 工具一览：
 *   bridge_status  配置与连通性自检
 *   bridge_send    发消息（新建 issue 线程）
 *   bridge_inbox   收件箱：按游标增量拉取发给"我"的新消息
 *   bridge_read    读完整线程（首帖 + 全部回帖）
 *   bridge_reply   在线程内回帖
 *   bridge_ack     确认已处理（回帖 + 关闭线程），给对方回执
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

const SERVER_VERSION = '1.1.0'; // 必须与 package.json / .zcode-plugin/plugin.json 一致
const BRIDGE_MARKER = 1;            // 信封协议版本号（body.bridge === 1 才算本桥消息）
const MAX_BODY_CHARS = 60000;       // GitHub issue/comment 正文上限 65536，留余量
const INBOX_PAGE = 100;             // 单次拉取上限（GitHub per_page 最大 100）
const SEEN_LIMIT = 500;             // 游标去重表容量（防止无限增长）

// ---------------------------------------------------------------------------
// 配置（每次调用时读取，环境变量可在运行中出现/变更）
// ---------------------------------------------------------------------------
function cfg() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.BRIDGE_TOKEN || '';
  const repo = (process.env.BRIDGE_REPO || '').trim();   // 形如 "owner/name"
  const id = (process.env.BRIDGE_ID || '').trim();       // 本方身份，如 "wersky/main"
  const apiBase = (process.env.BRIDGE_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
  // 门铃（可选，默认开启）：GitHub 无本机推送，用 ntfy 把「有新消息」推给对方，
  // 省掉轮询等待与列表索引传播（实测门铃送达 ~750ms，GitHub 新线程传播 2.5-7s）。
  //   BRIDGE_NTFY_URL    ntfy 服务器（默认 https://ntfy.sh，可自托管）
  //   BRIDGE_NTFY_TOPIC  主题；设为 "off" 关闭门铃；缺省由仓库名自动派生（双端零配置一致）
  // 话题名公开可猜（只泄露元数据：issue 号/身份/类型），正文始终只在 GitHub —— 私有仓库内容不上 ntfy。
  const ntfyUrl = (process.env.BRIDGE_NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, '');
  const ntfyTopicRaw = process.env.BRIDGE_NTFY_TOPIC !== undefined ? process.env.BRIDGE_NTFY_TOPIC.trim() : '';
  return { token, repo, id, apiBase, ntfyUrl, ntfyTopicRaw };
}

function workspaceOf(args) {
  const ws = args?.workspace;
  if (ws === undefined || ws === null || ws === '') return '';
  if (typeof ws !== 'string') {
    throw new Error('workspace 必须是字符串。下一步：传入工作区绝对路径，例如 "/path/to/my-project"。');
  }
  return ws.trim();
}
function stateDir(args) {
  return path.join(workspaceOf(args) || process.cwd(), '.swarmbridge');
}
/**
 * 游标文件按身份隔离：cursor-<identity 消毒>.json。
 * 同一工作区里可能有多个身份（主代理 + 各子代理）各自轮询，
 * 共用一个文件会互相覆盖游标（实测踩过），必须一人一份。
 */
function cursorFile(args, identity) {
  const safe = String(identity).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(stateDir(args), `cursor-${safe}.json`);
}

// ---------------------------------------------------------------------------
// 身份与寻址
//
// 约定：身份是"声明式"的（如 "wersky/main"、"wersky/agent-1"）。MCP 协议层
// 无法验证身份真伪（和 taskswarm 的 force 同理）——安全边界是仓库访问权
// （token 能写这个仓库的人才能发消息），不是身份字段本身。
//
// 收件匹配规则（to → 是否投递给 myId）：
//   "*"          → 所有人
//   "wersky"     → wersky 本人与其全部子身份（wersky/agent-1 等）
//   "wersky/*"   → 同上（显式通配写法）
//   "wersky/agent-1" → 精确匹配
// ---------------------------------------------------------------------------
function toMatches(to, myId) {
  if (!to || to === '*') return true;
  if (to === myId) return true;
  if (myId.startsWith(to + '/')) return true;          // "wersky" 匹配 "wersky/agent-1"
  if (to.endsWith('/*') && myId.startsWith(to.slice(0, -1))) return true; // "wersky/*"
  return false;
}

function requireId(value, label) {
  const s = String(value ?? '').trim();
  if (s === '') {
    throw new Error(`${label} 不能为空。下一步：传入身份字符串，如 "wersky/main"（推荐格式 owner/role，子代理用 owner/agent-N）。`);
  }
  if (s.length > 80) throw new Error(`${label} 过长（${s.length} > 80）。下一步：用简短身份，如 "wersky/main"。`);
  return s;
}

// ---------------------------------------------------------------------------
// 落盘（游标）。小文件，但同样用 tmp→rename 原子替换，避免半截 JSON。
// ---------------------------------------------------------------------------
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw new Error(`写入 ${path.basename(file)} 失败：${err?.message ?? err}`);
  }
}

function loadCursor(args, identity) {
  try {
    const raw = JSON.parse(fs.readFileSync(cursorFile(args, identity), 'utf8'));
    if (raw && raw.identity === identity && typeof raw.since === 'string') return raw;
    return null;
  } catch {
    return null; // 不存在或损坏都从默认起点开始
  }
}
function saveCursor(args, identity, since, seen) {
  atomicWrite(cursorFile(args, identity), JSON.stringify({ identity, since, seen, savedAt: new Date().toISOString() }, null, 2));
}

/**
 * 记录"本方刚在该线程上活动过"（reply / ack 之后调用）。
 * 意义：自己发出的回帖也会刷新线程的 updated_at，若不记账，
 * 下次轮询会把自己的动作当成"新消息"回声给自己。
 */
function noteOwnActivity(args, identity, issue, at) {
  const saved = loadCursor(args, identity) ?? { seen: {}, since: at };
  const seen = { ...(saved.seen ?? {}) };
  const stamp = String(at ?? new Date().toISOString());
  seen[issue] = seen[issue] && seen[issue] > stamp ? seen[issue] : stamp;
  const since = saved.since && saved.since > stamp ? saved.since : stamp;
  const keys = Object.keys(seen);
  if (keys.length > SEEN_LIMIT) {
    for (const k of keys.slice(0, keys.length - SEEN_LIMIT)) delete seen[k];
  }
  saveCursor(args, identity, since, seen);
}

// ---------------------------------------------------------------------------
// GitHub REST 传输层
// ---------------------------------------------------------------------------
class BridgeError extends Error {} // 可预期的错误（配置/网络/API），信息已面向使用者

async function gh(method, apiPath, { token, apiBase, body } = {}) {
  if (!token) {
    throw new BridgeError(
      '缺少 GitHub token。下一步：设置环境变量 GITHUB_TOKEN（或 GH_TOKEN / BRIDGE_TOKEN），' +
      '需要一个对该仓库有 Issues 读写的 Personal Access Token；切勿把 token 写进任何文件或提交到仓库。'
    );
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(apiBase + apiPath, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'swarmbridge-mcp',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    const reason = err?.name === 'AbortError' ? '请求超时（20s）' : (err?.cause?.code ?? err?.message ?? '网络错误');
    throw new BridgeError(
      `无法连接 GitHub API（${reason}）。下一步：检查网络与代理（如 Clash 是否在 127.0.0.1:7890），` +
      `或用 BRIDGE_API_BASE 指向可用的 API 地址后重试。`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j?.message ?? ''; } catch { /* 忽略 */ }
    if (res.status === 401) {
      throw new BridgeError(`GitHub 认证失败（401）：token 无效或已过期。下一步：检查 GITHUB_TOKEN 是否正确、是否已失效。`);
    }
    if (res.status === 403 && (detail.includes('rate limit') || res.headers.get('x-ratelimit-remaining') === '0')) {
      const reset = res.headers.get('x-ratelimit-reset');
      const at = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : '稍后';
      throw new BridgeError(`GitHub API 限额用尽（403）。重置于 ${at}。下一步：降低轮询频率（建议 ≥5s 一次），或稍后再试。`);
    }
    if (res.status === 404) {
      throw new BridgeError(`GitHub 返回 404：仓库不存在、写错了名字，或 token 无权访问它。下一步：检查 BRIDGE_REPO（格式 "owner/name"）与 token 权限。${detail ? `（${detail}）` : ''}`);
    }
    if (res.status === 422) {
      throw new BridgeError(`GitHub 拒绝了请求（422）：${detail || '参数不合法'}。下一步：检查消息内容（正文是否为空、标题是否过长）。`);
    }
    throw new BridgeError(`GitHub API 错误（HTTP ${res.status}）：${detail || '未知'}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// 信封（消息格式）
//
// issue/comment 的正文就是一份 JSON 信封（人类可读的 pretty JSON）。
// 只认 body.bridge === 1 的内容为桥消息——人类手写的 issue 不会进 agent 收件箱。
// ---------------------------------------------------------------------------
function makeEnvelope({ from, to, type, subject, body, data, inReplyTo }) {
  if (!to) {
    throw new Error('缺少 to。下一步：填收件方身份（如 "alice/main"），发给对方全部代理用 "alice/*"，广播用 "*"。');
  }
  if (!type) {
    throw new Error('缺少 type。下一步：从约定类型里选一个：hello(握手) / chat(自由沟通) / task(委派任务) / status(进展) / result(结果) / file(产物交付) / bye(收工)；也可以自定义，接收方按约定理解。');
  }
  const env = {
    bridge: BRIDGE_MARKER,
    id: crypto.randomUUID(),
    from,
    to,
    type: String(type).trim(),
    subject: String(subject ?? '').slice(0, 200),
    body: String(body ?? ''),
    ...(data !== undefined ? { data } : {}),
    ...(inReplyTo !== undefined ? { inReplyTo } : {}),
    ts: new Date().toISOString(),
  };
  const size = JSON.stringify(env).length;
  if (size > MAX_BODY_CHARS) {
    throw new Error(`消息过大（${size} > ${MAX_BODY_CHARS} 字符，含 data）。下一步：把大块内容放到仓库文件或 gist 里，消息里只给链接与摘要。`);
  }
  return env;
}

function parseEnvelope(rawText) {
  try {
    const obj = JSON.parse(rawText);
    if (obj && typeof obj === 'object' && obj.bridge === BRIDGE_MARKER && obj.from && obj.to) return obj;
  } catch { /* 人类手写内容，不是信封 */ }
  return null;
}

function issueTitle(env) {
  return `[bridge] ${env.from} → ${env.to}: ${env.subject || env.type}`;
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------
function requireCfg(args) {
  const c = cfg();
  const repo = String(args?.repo ?? '').trim() || c.repo;
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new BridgeError(
      `BRIDGE_REPO 未配置或格式不对（当前值："${repo || '(空)'}"）。下一步：设为共享仓库 "owner/name"` +
      `（环境变量 BRIDGE_REPO，或调用参数 repo），双方必须指向同一个仓库。`
    );
  }
  const from = String(args?.from ?? '').trim() || c.id;
  if (!from) {
    throw new BridgeError('BRIDGE_ID 未配置。下一步：设置环境变量 BRIDGE_ID（本方身份，如 "wersky/main"），或调用时传 from。');
  }
  // 门铃主题解析：显式 "off" 关闭；显式值直接用；缺省由仓库名派生（双端零配置一致）
  let ntfyTopic = null;
  if (c.ntfyTopicRaw === 'off') {
    ntfyTopic = null;
  } else if (c.ntfyTopicRaw) {
    ntfyTopic = c.ntfyTopicRaw;
  } else {
    ntfyTopic = `swarmbridge-${crypto.createHash('sha256').update(repo).digest('hex').slice(0, 12)}`;
  }
  return { ...c, repo, from, ntfyTopic };
}

// ---------------------------------------------------------------------------
// 门铃（ntfy）：fire-and-forget 的「有新消息」通知。
// 只发元数据（issue 号/身份/类型），不发正文 —— 正文永远只在 GitHub。
// 失败静默：GitHub 是唯一事实源，门铃只是加速器，挂了就退回轮询模式。
// ---------------------------------------------------------------------------
function publishDoorbell(c, env, issue) {
  if (!c.ntfyTopic) return;
  const payload = JSON.stringify({
    bridge: BRIDGE_MARKER, kind: 'ring', repo: c.repo, issue,
    messageId: env.id, from: env.from, to: env.to, type: env.type,
    ts: new Date().toISOString(),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  fetch(`${c.ntfyUrl}/${encodeURIComponent(c.ntfyTopic)}`, {
    method: 'POST',
    body: payload,
    headers: { 'User-Agent': 'swarmbridge-doorbell' },
    signal: ctrl.signal,
  }).catch((e) => { process.stderr.write('[doorbell-err] ' + (e?.name ?? '') + ' ' + (e?.message ?? '') + ' ' + (e?.cause?.code ?? '') + '\n'); }).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// 门铃接收端：后台订阅 ntfy 的 JSON 流，把响铃记进内存环形缓冲。
// bridge_wait（阻塞等铃）与 bridge_ring（非阻塞查看）从这里取。
// 消费过滤：只投递「发给本方身份的、且不是本方自己发的」铃。
// ---------------------------------------------------------------------------
const doorbellState = {
  rings: [],            // {issue, from, to, type, messageId, at, atMs}
  started: false,
  topic: null,
  url: null,
  connected: false,
  watermark: 0,         // 已入缓冲的最大消息时间（ms）
  seenIds: new Set(),   // 已入缓冲的 messageId：挡住 ntfy 重放导致的重复铃
};

function takeMyRings(identity) {
  const mine = [];
  const rest = [];
  for (const r of doorbellState.rings) {
    (toMatches(r.to, identity) && r.from !== identity ? mine : rest).push(r);
  }
  doorbellState.rings = rest;
  return mine;
}

/** 只读计数（不清空缓冲）——status 展示用；清空走 takeMyRings */
function peekMyRings(identity) {
  return doorbellState.rings.filter(r => toMatches(r.to, identity) && r.from !== identity).length;
}

function ensureDoorbellListener(c) {
  if (!c.ntfyTopic) return null;
  // 同一进程身份固定（BRIDGE_ID），主题/URL 变化只可能在重启后出现
  if (!doorbellState.started) {
    doorbellState.started = true;
    doorbellState.topic = c.ntfyTopic;
    doorbellState.url = c.ntfyUrl;
    doorbellStreamLoop(c).catch(() => { /* 后台尽力而为 */ });
  }
  return doorbellState;
}

async function doorbellStreamLoop(c) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 65000); // 长连接 65s 自愈重连
    try {
      const res = await fetch(`${c.ntfyUrl}/${encodeURIComponent(c.ntfyTopic)}/json?since=10m`, {
        headers: { 'User-Agent': 'swarmbridge-doorbell' },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      doorbellState.connected = true;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt; try { evt = JSON.parse(line); } catch { continue; }
          if (evt.event !== 'message' || !evt.message) continue;
          let env; try { env = JSON.parse(evt.message); } catch { continue; }
          if (env.bridge !== BRIDGE_MARKER || env.kind !== 'ring') continue;
          const atMs = evt.time ? evt.time * 1000 : Date.now();
          // 按 messageId 去重：ntfy 的 ?since= 重放会把历史铃再推一遍
          // （断线重连场景），这里用已见过的 id 集合挡住，避免同一条铃重复入缓冲。
          // 不用时间戳判断新旧——ntfy 时间戳只有秒级精度，且"对方先发、我稍后订阅"
          // 是正常时序，按时间过滤会误杀真实的新铃（实测踩过两次）。
          if (doorbellState.seenIds.has(env.messageId)) continue;
          doorbellState.seenIds.add(env.messageId);
          if (doorbellState.seenIds.size > 200) {
            // 简易限容：保留最近 200 个 id
            doorbellState.seenIds = new Set([...doorbellState.seenIds].slice(-100));
          }
          doorbellState.rings.push({
            issue: env.issue, from: env.from, to: env.to, type: env.type,
            messageId: env.messageId, at: new Date(atMs).toISOString(), atMs,
          });
          if (atMs > doorbellState.watermark) doorbellState.watermark = atMs;
          if (doorbellState.rings.length > 50) doorbellState.rings.splice(0, doorbellState.rings.length - 50);
        }
      }
    } catch {
      doorbellState.connected = false; // 断流：轮询兜底仍然可用
    } finally {
      clearTimeout(timer);
    }
    await sleep(2000); // 断线重连间隔
  }
}

/** base = apiBase + /repos/{repo} */
function repoBase(repo) { return `/repos/${repo}`; }

async function bridgeStatus(args) {
  const c = requireCfg(args);
  const cursor = loadCursor(args, c.from);
  const out = {
    identity: c.from,
    repo: c.repo,
    apiBase: c.apiBase,
    token: c.token ? `已配置（***${c.token.slice(-4)}）` : '未配置',
    cursor: cursor ? { since: cursor.since, seenThreads: Object.keys(cursor.seen ?? {}).length } : '（尚无收件记录）',
    doorbell: c.ntfyTopic
      ? { enabled: true, url: c.ntfyUrl, topic: c.ntfyTopic, connected: doorbellState.connected, pendingRings: peekMyRings(c.from) }
      : { enabled: false, note: 'BRIDGE_NTFY_TOPIC=off，纯 GitHub 轮询模式' },
    stateDir: stateDir(args),
  };
  if (args?.check === true) {
    const t0 = Date.now();
    const repoInfo = await gh('GET', repoBase(c.repo), { token: c.token, apiBase: c.apiBase });
    out.connectivity = {
      ok: true,
      repoFullName: repoInfo.full_name,
      private: !!repoInfo.private,
      permissions: repoInfo.permissions ?? null,
      latencyMs: Date.now() - t0,
    };
  }
  return out;
}

async function bridgeSend(args) {
  const c = requireCfg(args);
  // from 可被调用方覆盖：这是子代理以子身份（如 "wersky/agent-1"）沟通的基础。
  // 身份是声明式的——真正的边界是仓库写权限（能写这个仓库的人才能发消息）。
  const from = String(args?.from ?? '').trim() || c.from;
  const env = makeEnvelope({
    from,
    to: requireId(args?.to, 'to'),
    type: args?.type,
    subject: args?.subject,
    body: args?.body,
    data: args?.data,
  });
  const created = await gh('POST', `${repoBase(c.repo)}/issues`, {
    token: c.token, apiBase: c.apiBase,
    body: { title: issueTitle(env), body: JSON.stringify(env, null, 2) },
  });
  publishDoorbell(c, env, created.number);
  return {
    ok: true,
    issue: created.number,
    url: created.html_url,
    messageId: env.id,
    to: env.to,
    type: env.type,
    ...(c.ntfyTopic ? { doorbell: `已响铃（${c.ntfyUrl}/${c.ntfyTopic}）——对方若在 bridge_wait，约 1~2 秒即可看到` } : {}),
    hint: '对方需轮询 bridge_inbox 才能看到（GitHub 无法向本机推送）。紧急事项请通知对方查看。',
  };
}

async function bridgeInbox(args) {
  const c = requireCfg(args);
  const saved = loadCursor(args, c.from);
  const seen = { ...(saved?.seen ?? {}) };
  // 首次使用默认只看最近 24h，避免把共享仓库的全部历史灌进上下文
  const since = String(args?.since ?? saved?.since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  // 注意：刻意不提供 type 过滤参数——轮询游标会推进，被过滤掉的消息将不会再出现。
  // 类型筛选由调用方在返回结果里自行做（messages 里带 type 字段）。
  const limit = Math.max(1, Math.min(Number(args?.limit ?? 20), 100));

  // ⚠️ GitHub 的 sort=updated 在多页/大量数据时不可靠（实测：direction=asc 会退化成按
  // issue 号排序，导致刚发的消息排不进返回页），因此改为**按创建时间降序拉取**
  // （created 顺序稳定），再在本地按 updated_at 排序与截断。
  // 拉取量设大一些，保证近期的活跃线程都在窗口内。
  const list = await gh('GET', `${repoBase(c.repo)}/issues?state=all&sort=created&direction=desc&per_page=${INBOX_PAGE}`, {
    token: c.token, apiBase: c.apiBase,
  });

  const messages = [];
  let maxUpdated = since;
  for (const item of Array.isArray(list) ? list : []) {
    if (item.pull_request) continue;                     // PR 不是桥消息
    if (item.updated_at && item.updated_at > maxUpdated) maxUpdated = item.updated_at;
    // 拉取下界：仅在**首次使用**（尚无 seen 记录）时用 24h 默认值挡掉陈年历史；
    // 一旦有了处理记录，去重完全交给 seen 表——不再用时间过滤，
    // 否则未返回（被 limit 截断）的更早消息会被 since 永久挡在候选之外（实测踩过）。
    const hasHistory = Object.keys(seen).length > 0;
    if (!hasHistory && item.updated_at && item.updated_at < since) continue;
    const known = seen[item.number];
    if (known && known >= item.updated_at) continue;     // 已处理过
    const env = parseEnvelope(item.body ?? '');
    if (!env) continue;                                  // 人类手写的 issue，不进收件箱

    // 参与者语义：线程与我相关 = 我是发起人，或收件人是我（含通配）。
    // 只看首帖信封判断"是不是发给我的"不够——我发起的线程对方回帖时，
    // 首帖 from 仍是我，若按 from 过滤会把我方线程的回复永远挡在门外。
    const participant = env.from === c.from || toMatches(env.to, c.from);
    if (!participant) continue;

    // 自己发起的线程：仅当出现回帖（comments > 0）才进收件箱；
    // 自己的回帖/ack 造成的更新已在 noteOwnActivity 记账，不会回声。
    if (env.from === c.from && !(item.comments > 0)) continue;

    // ⚠️ 此处**不**写 seen：先收集候选，只有真正返回给调用方的才标记为已处理。
    // 若在这里就标记，被 limit 截断（未返回）的消息下轮会被 seen 跳过 → 静默丢失（实测踩过）。
    messages.push({
      issue: item.number,
      messageId: env.id,
      from: env.from,
      to: env.to,
      type: env.type,
      subject: env.subject ?? '',
      body: env.body ?? '',
      ...(env.data !== undefined ? { data: env.data } : {}),
      ts: env.ts,
      threadState: item.state,                           // open = 待处理，closed = 已被 ack
      replies: item.comments ?? 0,                       // 线程内回帖数（读全文用 bridge_read）
      updatedAt: item.updated_at,
      url: item.html_url,
    });
    // 注意：这里**不**按 limit 提前 break —— 先收集全部候选，排序后再截断。
    // 原因：拉取顺序（created desc）≠ 对外顺序（updated desc），提前 break 会把
    // 更新的线程挡在截断线外（实测踩过：inbox 只返回最旧的 20 条，新消息被丢弃）。
  }

  // 排序 + 截断：对外按 updated_at 降序（最新在前），超出 limit 的留在下一轮。
  // 遍历顺序取决于 GitHub 返回顺序（created desc），不能假定它与 updated_at 一致；
  // 曾用 reverse() 想当然倒序、且在正确排序前就 break，导致返回最旧的 20 条、
  // 新消息被截断线排除（实测：bridge_inbox 看不到刚发的消息）。
  messages.sort((a, b) => (a.updatedAt === b.updatedAt ? 0 : (a.updatedAt < b.updatedAt ? 1 : -1)));
  const returned = messages.slice(0, limit);
  const remaining = messages.length - returned.length;
  let cursorTo = since; // 下一轮的拉取下界（下面按实际返回的消息推进）

  // 游标语义（实测踩过后重写）：
  //   - `seen` 表是**真正的去重依据**（按 issue 记已处理到的 updated_at）；
  //   - `since` 只是「拉取范围下界」，用于让 GitHub 端少返回历史数据。
  // 关键约束：**只为实际返回的消息推进 seen/since**。若把未返回的也标记为已处理，
  // 它们会被永久跳过、静默丢失（这正是下面 remaining 分支存在的理由）。
  if (returned.length > 0) {
    // 下界取「本批最旧一条的时间」：比它更早的（未返回的）下轮仍会被拉取，
    // 已返回的由 seen 表挡住不会重复投递。
    const oldest = returned[returned.length - 1].updatedAt;
    cursorTo = oldest;
    // 只有实际交付的消息才计入 seen（见上方"不写 seen"的注释）
    for (const m of returned) seen[m.issue] = m.updatedAt;
  }

  // 游标去重表限容：丢最旧的
  const keys = Object.keys(seen);
  if (keys.length > SEEN_LIMIT) {
    for (const k of keys.slice(0, keys.length - SEEN_LIMIT)) delete seen[k];
  }
  saveCursor(args, c.from, cursorTo, seen);

  return {
    identity: c.from,
    count: returned.length,
    ...(remaining > 0 ? { remaining, hintMore: `还有 ${remaining} 条更早的消息未返回，下次轮询 bridge_inbox 会继续给出` } : {}),
    ...(list.length >= INBOX_PAGE ? { truncated: `本页已达 ${INBOX_PAGE} 条上限，更早的消息会在下次轮询继续返回` } : {}),
    messages: returned,                                // 按更新时间降序（最新在前）
    since: cursorTo,
    hint: returned.length > 0
      ? '用 bridge_read(issue) 读线程全文；处理完用 bridge_ack(issue) 关闭线程给对方回执。'
      : '暂无新消息。对方发出的消息要等它轮询 bridge_inbox 才会被看到；保持轮询节奏（建议 ≥5s）。',
  };
}

async function fetchThread(c, issue) {
  const n = Number(issue);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`issue 编号不合法（收到 "${issue}"）。下一步：用 bridge_inbox 返回的 issue 编号（正整数）。`);
  }
  const info = await gh('GET', `${repoBase(c.repo)}/issues/${n}`, { token: c.token, apiBase: c.apiBase });
  const comments = await gh('GET', `${repoBase(c.repo)}/issues/${n}/comments?per_page=100`, { token: c.token, apiBase: c.apiBase });
  return { info, comments: Array.isArray(comments) ? comments : [] };
}

async function bridgeRead(args) {
  const c = requireCfg(args);
  const { info, comments } = await fetchThread(c, args?.issue);
  const head = parseEnvelope(info.body ?? '');
  return {
    issue: info.number,
    url: info.html_url,
    state: info.state,
    title: info.title,
    head: head ?? { kind: 'plain', note: '首帖不是本桥信封（可能被人工编辑过）', raw: String(info.body ?? '').slice(0, 2000) },
    replies: comments.map(cm => {
      const env = parseEnvelope(cm.body ?? '');
      return env
        ? { at: cm.created_at, from: env.from, to: env.to, type: env.type, body: env.body, ...(env.data !== undefined ? { data: env.data } : {}) }
        : { at: cm.created_at, kind: 'plain', user: cm.user?.login, body: String(cm.body ?? '').slice(0, 2000) };
    }),
  };
}

async function bridgeReply(args) {
  const c = requireCfg(args);
  const { info } = await fetchThread(c, args?.issue);
  const head = parseEnvelope(info.body ?? '');
  const to = String(args?.to ?? '').trim() || head?.from || '';
  const env = makeEnvelope({
    from: c.from,
    to,
    type: args?.type ?? 'reply',
    subject: `Re: ${head?.subject ?? info.title}`,
    body: args?.body,
    data: args?.data,
    inReplyTo: head?.id ?? info.number,
  });
  const created = await gh('POST', `${repoBase(c.repo)}/issues/${info.number}/comments`, {
    token: c.token, apiBase: c.apiBase,
    body: { body: JSON.stringify(env, null, 2) },
  });
  // 自己的回帖会刷新线程 updated_at，记入游标避免下次轮询回声给自己
  noteOwnActivity(args, c.from, info.number, created?.created_at);
  publishDoorbell(c, env, info.number);
  return { ok: true, issue: info.number, commentId: created.id, messageId: env.id, to: env.to, type: env.type };
}

async function bridgeAck(args) {
  const c = requireCfg(args);
  const { info } = await fetchThread(c, args?.issue);
  const env = makeEnvelope({
    from: c.from,
    to: parseEnvelope(info.body ?? '')?.from || '*',
    type: 'ack',
    subject: `Ack: ${info.title}`,
    body: String(args?.note ?? '已处理。'),
  });
  await gh('POST', `${repoBase(c.repo)}/issues/${info.number}/comments`, {
    token: c.token, apiBase: c.apiBase,
    body: { body: JSON.stringify(env, null, 2) },
  });
  let closedAt = new Date().toISOString();
  if (info.state !== 'closed') {
    const patched = await gh('PATCH', `${repoBase(c.repo)}/issues/${info.number}`, {
      token: c.token, apiBase: c.apiBase, body: { state: 'closed' },
    });
    closedAt = patched?.updated_at ?? closedAt;
  }
  noteOwnActivity(args, c.from, info.number, closedAt);
  publishDoorbell(c, env, info.number);
  return { ok: true, issue: info.number, state: 'closed', hint: '线程已关闭 = 回执已送达。对方在其收件箱里会看到 closed 状态（确认闭环）。' };
}

// ---------------------------------------------------------------------------
// bridge_wait / bridge_ring —— 门铃的接收端
//
// 这两个工具**绕过全局串行队列**：它们只读内存中的响铃缓冲、不碰游标文件，
// 阻塞等待不会卡住同进程里其他子代理的收发。
// ---------------------------------------------------------------------------
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

async function bridgeWait(args) {
  const c = requireCfg(args);
  const L = ensureDoorbellListener(c);
  if (!L) {
    return { rung: false, waitedMs: 0, rings: [],
      hint: '门铃未开启（BRIDGE_NTFY_TOPIC=off）。直接轮询 bridge_inbox 即可，速度退回纯 GitHub 模式。' };
  }
  const timeout = Math.min(Math.max(Number(args?.timeout ?? 10), 0), 25);
  const t0 = Date.now();
  // 语义：等到「缓冲区里有铃」即返回。
  //
  // ⚠️ 刻意**不**在进入时丢弃已缓冲的铃：真实时序常常是
  //   「对方先发布 → 我稍后才调用 bridge_wait」，
  // 若把进入时已有的铃当"陈旧"丢掉，这条真实的新消息就永远等不到（实测踩过：
  // 已安装插件验证里等满 20s 超时，而铃其实早在 ntfy 上了）。
  // 重复消费由两道保险挡住：门铃按 messageId 去重（同一条铃不会重复入缓冲）、
  // bridge_inbox 按游标去重（已处理的消息不会重复出现）。
  let rings = takeMyRings(c.from);
  while (rings.length === 0 && Date.now() - t0 < timeout * 1000) {
    await sleepMs(150);
    rings = takeMyRings(c.from);
  }
  return {
    rung: rings.length > 0,
    rings,
    waitedMs: Date.now() - t0,
    hint: rings.length > 0
      ? '门铃已响 → 立即 bridge_inbox 消费新消息。'
      : '超时未响：对方尚未发送，或对方门铃关闭。bridge_inbox 轮询兜底仍可用。',
  };
}

async function bridgeRing(args) {
  const c = requireCfg(args);
  const L = ensureDoorbellListener(c);
  if (!L) return { enabled: false, connected: false, rings: [], hint: '门铃未开启（BRIDGE_NTFY_TOPIC=off）。' };
  const rings = takeMyRings(c.from);
  return {
    enabled: true,
    connected: L.connected,
    rings,
    hint: rings.length > 0 ? '有未消费的门铃 → bridge_inbox 消费。' : '暂无铃；门铃流保持监听中。',
  };
}

// ---------------------------------------------------------------------------
// 工具清单
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'bridge_status', description: '查看桥的配置（身份/仓库/token）与连通性。check:true 时会实际请求一次 GitHub 验证。',
    inputSchema: {
      type: 'object',
      properties: {
        check: { type: 'boolean', description: '是否实际连接 GitHub 验证（默认 false，离线也能看配置）' },
      },
    },
  },
  {
    name: 'bridge_send', description: '给对方 agent 发消息（新建线程）。type 约定：hello/chat/task/status/result/file/bye。',
    inputSchema: {
      type: 'object', required: ['to', 'type'],
      properties: {
        to: { type: 'string', description: '收件方身份，如 "alice/main"；发给对方全部子代理用 "alice/*"；广播用 "*"' },
        type: { type: 'string', description: '消息类型：hello/chat/task/status/result/file/bye 或自定义' },
        subject: { type: 'string', description: '一句话主题' },
        body: { type: 'string', description: '正文（自由文本）' },
        data: { type: 'object', description: '结构化负载（如 task 的 {goal,detail}，result 的 {artifacts:[...]}）' },
        from: { type: 'string', description: '发件身份覆盖（默认 BRIDGE_ID）。子代理用 "wersky/agent-1" 这类子身份' },
        repo: { type: 'string', description: '覆盖 BRIDGE_REPO（"owner/name"）' },
      },
    },
  },
  {
    name: 'bridge_inbox', description: '收件箱：增量拉取发给"我"的新消息（按游标，幂等可反复轮询）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回条数（默认 20，上限 100）' },
        since: { type: 'string', description: '覆盖游标起点（ISO 时间），一般不用' },
        from: { type: 'string', description: '身份覆盖' },
        repo: { type: 'string', description: '覆盖 BRIDGE_REPO' },
      },
    },
  },
  {
    name: 'bridge_read', description: '读完整线程：首帖 + 全部回帖（含人类普通评论）。',
    inputSchema: {
      type: 'object', required: ['issue'],
      properties: { issue: { type: 'number', description: '线程编号（bridge_inbox 返回的 issue）' } },
    },
  },
  {
    name: 'bridge_reply', description: '在线程内回帖（自动回给线程发起方，除非显式 to）。',
    inputSchema: {
      type: 'object', required: ['issue', 'body'],
      properties: {
        issue: { type: 'number' },
        body: { type: 'string' },
        type: { type: 'string', description: '默认 reply，可传 status/result 等' },
        data: { type: 'object' },
        from: { type: 'string', description: '发件身份覆盖' },
        repo: { type: 'string' },
      },
    },
  },
  {
    name: 'bridge_ack', description: '确认线程已处理：回帖 + 关闭线程。对方会看到 closed = 回执闭环。',
    inputSchema: {
      type: 'object', required: ['issue'],
      properties: { issue: { type: 'number' }, note: { type: 'string', description: '处理结论，一句话' } },
    },
  },
  {
    name: 'bridge_wait', description: '阻塞等待门铃（对方发消息会实时推铃）：响铃即返回，最多等 timeout 秒（≤25）。适合「发完任务等回复」的场景。不会影响同进程其他代理的收发。',
    inputSchema: {
      type: 'object',
      properties: {
        timeout: { type: 'number', description: '最长等待秒数（默认 10，上限 25）' },
        repo: { type: 'string' },
      },
    },
  },
  {
    name: 'bridge_ring', description: '非阻塞查看门铃：立即返回是否有未消费的响铃（不等待）。',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } } },
  },
];

const HANDLERS = {
  bridge_status: bridgeStatus,
  bridge_send: bridgeSend,
  bridge_inbox: bridgeInbox,
  bridge_read: bridgeRead,
  bridge_reply: bridgeReply,
  bridge_ack: bridgeAck,
  bridge_wait: bridgeWait,
  bridge_ring: bridgeRing,
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio（newline-delimited）
//
// 与 taskswarm 不同：本 server 的工具是**异步**的（网络请求）。为保证
// 同一 server 进程内的调用串行（多个子代理共享本进程，避免游标文件竞争），
// 所有 tools/call 过一条 promise 链顺序执行。
// ---------------------------------------------------------------------------
function reply(id, result, error) {
  const msg = { jsonrpc: '2.0', id };
  if (error) msg.error = { code: -32603, message: String(error.message ?? error) };
  else msg.result = result;
  process.stdout.write(JSON.stringify(msg) + '\n');
}

let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn, fn);
  chain = p.then(() => undefined, () => undefined);
  return p;
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let req;
  try { req = JSON.parse(trimmed); } catch { return; } // 非法行忽略（与 taskswarm 一致）
  const { id, method, params } = req;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'swarmbridge', version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const handler = HANDLERS[name];
    if (!handler) {
      return reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: `未知工具: ${name}。可用工具：${Object.keys(HANDLERS).join(', ')}` }) }], isError: true });
    }
    const run = () => Promise.resolve()
      .then(() => handler(args))
      .then((result) => reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }))
      .catch((err) => reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: String(err?.message ?? err) }) }], isError: true }));
    // bridge_wait/bridge_ring 绕过串行队列：只读内存响铃缓冲、不碰游标文件，
    // 阻塞等待期间同进程其他子代理的收发照常进行。
    if (name === 'bridge_wait' || name === 'bridge_ring') {
      run();
      return;
    }
    enqueue(run);
    return;
  }
  return reply(id, null, new Error(`未知方法: ${method}`));
});
rl.on('close', () => process.exit(0));
