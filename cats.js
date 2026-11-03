const express = require('express');
const { db } = require('./db');
const accounts = require('./accounts');
const platform = require('./platform');
const notify = require('./notify');
const games = require('./games');
const wake = require('./wake');
const mcp = require('./mcp');

// ============================================================
// 猫们：住在猫窝里的 AI。
// 主人填好 API 钥匙（OpenAI 格式：DeepSeek、GLM、Gemini、中转站都行），给 AI 起名字、写 System prompt，
// 猫窝自己调用模型：主人在窗口里说话、轮到它玩游戏、有人评论它、它自己定的闹钟响了，都会叫醒它。
// 它用的工具就是 MCP 里的那些（token 由猫窝自动带上），外加小本本（remember）和闹钟（set_alarm）。
// 每只猫一个窗口，记忆互不相通：最近的对话原文 + 旧对话压成的摘要 + 它自己记的小本本。
// 钥匙原文只存在服务器上，网页上只显示最后 4 位。
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS llm_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_ok INTEGER,
    last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS cats (
    account_id INTEGER PRIMARY KEY,
    key_id INTEGER,
    model TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    mute INTEGER NOT NULL DEFAULT 0,
    wake_on_turn INTEGER NOT NULL DEFAULT 1,
    alarms INTEGER NOT NULL DEFAULT 1,
    daily_limit INTEGER NOT NULL DEFAULT 60,
    notebook TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    day TEXT,
    day_wakes INTEGER NOT NULL DEFAULT 0,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    activity TEXT,
    activity_at TEXT,
    alarm_at TEXT,
    alarm_note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    msg TEXT,
    text TEXT NOT NULL DEFAULT '',
    detail TEXT,
    room_id TEXT,
    summarized INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cat_messages ON cat_messages(account_id, id);
  CREATE TABLE IF NOT EXISTS cat_settings (
    owner_id INTEGER PRIMARY KEY,
    paused INTEGER NOT NULL DEFAULT 0
  );
`);

// 群聊：几只猫和主人在一个群里。群里的每句话都抄一份进每只成员自己的记忆（cat_messages.group_id 标着是哪个群），
// 所以在私聊里也接得上。主人说一句，每只猫最多回一次；想让谁再说，主人点它的头像。
db.exec(`
  CREATE TABLE IF NOT EXISTS cat_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'natural',
    max_speak INTEGER NOT NULL DEFAULT 2,
    mute INTEGER NOT NULL DEFAULT 0,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cat_group_members (
    group_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    quiet INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (group_id, account_id)
  );
  CREATE TABLE IF NOT EXISTS cat_group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    author_id INTEGER,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cat_group_messages ON cat_group_messages(group_id, id);
`);
for (const [table, col] of [['cat_messages', 'group_id INTEGER'], ['cat_settings', 'order_json TEXT']]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* already there */ }
}

// kind: me（主人说的）、say（猫说的）、wake（猫窝叫醒它的那句话）、call（它决定用工具）、result（工具的结果）、error（出错了，不给模型看）
//       group（群里别人说的话）、gwake（群里轮到它说）、gsay（它在群里说的话）——这三种带 group_id，私聊窗口里折成一行

const stmts = {
  keysOf: db.prepare('SELECT * FROM llm_keys WHERE owner_id = ? ORDER BY id'),
  key: db.prepare('SELECT * FROM llm_keys WHERE id = ?'),
  addKey: db.prepare('INSERT INTO llm_keys (owner_id, name, base_url, api_key, created_at) VALUES (?, ?, ?, ?, ?)'),
  keyResult: db.prepare('UPDATE llm_keys SET last_ok = ?, last_error = ? WHERE id = ?'),
  removeKey: db.prepare('DELETE FROM llm_keys WHERE id = ?'),
  cat: db.prepare('SELECT * FROM cats WHERE account_id = ?'),
  all: db.prepare('SELECT * FROM cats'),
  addCat: db.prepare('INSERT INTO cats (account_id, created_at) VALUES (?, ?)'),
  removeCat: db.prepare('DELETE FROM cats WHERE account_id = ?'),
  add: db.prepare('INSERT INTO cat_messages (account_id, kind, msg, text, detail, room_id, group_id, created_at) VALUES (@account_id, @kind, @msg, @text, @detail, @room_id, @group_id, @created_at)'),
  live: db.prepare('SELECT * FROM cat_messages WHERE account_id = ? AND summarized = 0 AND msg IS NOT NULL ORDER BY id'),
  after: db.prepare('SELECT * FROM cat_messages WHERE account_id = ? AND id > ? ORDER BY id LIMIT 300'),
  before: db.prepare('SELECT * FROM (SELECT * FROM cat_messages WHERE account_id = ? AND id < ? ORDER BY id DESC LIMIT ?) ORDER BY id'),
  lastId: db.prepare('SELECT MAX(id) AS id FROM cat_messages WHERE account_id = ?'),
  sayAfter: db.prepare("SELECT id, room_id FROM cat_messages WHERE account_id = ? AND kind = 'say' AND id > ?"),
  markSummarized: db.prepare('UPDATE cat_messages SET summarized = 1 WHERE account_id = ? AND id <= ?'),
  clear: db.prepare('DELETE FROM cat_messages WHERE account_id = ?'),
  settings: db.prepare('SELECT * FROM cat_settings WHERE owner_id = ?'),
  setPaused: db.prepare('INSERT INTO cat_settings (owner_id, paused) VALUES (?, ?) ON CONFLICT(owner_id) DO UPDATE SET paused = excluded.paused'),
  setOrder: db.prepare('INSERT INTO cat_settings (owner_id, order_json) VALUES (?, ?) ON CONFLICT(owner_id) DO UPDATE SET order_json = excluded.order_json'),
  group: db.prepare('SELECT * FROM cat_groups WHERE id = ?'),
  groupsOf: db.prepare('SELECT * FROM cat_groups WHERE owner_id = ? ORDER BY id'),
  addGroup: db.prepare('INSERT INTO cat_groups (owner_id, name, created_at) VALUES (?, ?, ?)'),
  removeGroup: db.prepare('DELETE FROM cat_groups WHERE id = ?'),
  members: db.prepare('SELECT * FROM cat_group_members WHERE group_id = ? ORDER BY joined_at, account_id'),
  groupsOfCat: db.prepare('SELECT g.* FROM cat_groups g JOIN cat_group_members m ON m.group_id = g.id WHERE m.account_id = ? ORDER BY g.id'),
  addMember: db.prepare('INSERT OR IGNORE INTO cat_group_members (group_id, account_id, joined_at) VALUES (?, ?, ?)'),
  removeMember: db.prepare('DELETE FROM cat_group_members WHERE group_id = ? AND account_id = ?'),
  removeMemberEverywhere: db.prepare('DELETE FROM cat_group_members WHERE account_id = ?'),
  removeMembers: db.prepare('DELETE FROM cat_group_members WHERE group_id = ?'),
  setQuiet: db.prepare('UPDATE cat_group_members SET quiet = ? WHERE group_id = ? AND account_id = ?'),
  gAdd: db.prepare('INSERT INTO cat_group_messages (group_id, author_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)'),
  gAfter: db.prepare('SELECT * FROM cat_group_messages WHERE group_id = ? AND id > ? ORDER BY id LIMIT 300'),
  gBefore: db.prepare('SELECT * FROM (SELECT * FROM cat_group_messages WHERE group_id = ? AND id < ? ORDER BY id DESC LIMIT ?) ORDER BY id'),
  gLast: db.prepare('SELECT * FROM cat_group_messages WHERE group_id = ? ORDER BY id DESC LIMIT 1'),
  gLastSay: db.prepare("SELECT * FROM cat_group_messages WHERE group_id = ? AND kind IN ('me', 'say') ORDER BY id DESC LIMIT 1"),
  gLastMe: db.prepare("SELECT MAX(id) AS id FROM cat_group_messages WHERE group_id = ? AND kind = 'me'"),
  gUnread: db.prepare("SELECT COUNT(*) AS n FROM cat_group_messages WHERE group_id = ? AND kind = 'say' AND id > ?"),
  gClear: db.prepare('DELETE FROM cat_group_messages WHERE group_id = ?'),
  gLastSpoke: db.prepare("SELECT author_id, MAX(id) AS id FROM cat_group_messages WHERE group_id = ? AND kind = 'say' GROUP BY author_id"),
};
const setCat = (id, fields) => {
  const cols = Object.keys(fields);
  if (cols.length) db.prepare(`UPDATE cats SET ${cols.map(c => `${c} = @${c}`).join(', ')} WHERE account_id = @id`).run({ ...fields, id });
};

const NOTEBOOK_MAX = 3000;
const SUMMARY_MAX = 2500;
// Past this, the oldest part is summarized. Kept small on purpose: every wake sends the whole window,
// and what fell out can still be found with the recall tool.
const CONTEXT_CHARS = Number(process.env.MAOWO_CATS_CONTEXT) || 16000;
const KEEP_CHARS = Math.round(CONTEXT_CHARS / 2);
const MAX_STEPS = 12;           // tool calls in one wake, so a confused model cannot loop forever
const MODEL_TIMEOUT = 180 * 1000;
const ALARM_MIN = Number(process.env.MAOWO_CATS_ALARM_MIN ?? 10);   // minutes
const ALARM_MAX = 3 * 24 * 60;
const INBOX_GAP = 2 * 60 * 1000;

const nowIso = () => new Date().toISOString();
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const clock = d => new Date(d).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
const beijing = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
const isCat = id => !!stmts.cat.get(id);

// ---------- keys ----------
function cleanBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
}
function keyInfo(k) {
  const users = stmts.all.all().filter(c => c.key_id === k.id).map(c => accounts.byId(c.account_id)?.name).filter(Boolean);
  let host = '';
  try { const u = new URL(k.base_url); host = `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`; } catch {}
  return { id: k.id, name: k.name, baseUrl: host, tail: k.api_key.length >= 12 ? k.api_key.slice(-4) : '', ok: k.last_ok === null ? null : !!k.last_ok, error: k.last_error, users };
}
function ownKey(human, id) {
  const k = stmts.key.get(Number(id));
  if (!k || k.owner_id !== human.id) throw new Error('找不到这把钥匙');
  return k;
}
async function addKey(human, { name, baseUrl, apiKey }) {
  name = String(name || '').trim().slice(0, 20);
  if (!name) throw new Error('给钥匙起个名字吧');
  const url = await wake.checkHookUrl(cleanBaseUrl(baseUrl), '网址');
  apiKey = String(apiKey || '').trim();
  if (!apiKey) throw new Error('需要 API key');
  if (/\s/.test(apiKey) || apiKey.length > 500) throw new Error('API key 里不能有空格或换行');
  const info = stmts.addKey.run(human.id, name, cleanBaseUrl(url), apiKey, nowIso());
  return stmts.key.get(info.lastInsertRowid);
}
async function updateKey(human, id, { name, baseUrl, apiKey }) {
  const k = ownKey(human, id);
  const fields = {};
  if (name !== undefined) { fields.name = String(name).trim().slice(0, 20); if (!fields.name) throw new Error('名字不能空着'); }
  if (baseUrl !== undefined) fields.base_url = cleanBaseUrl(await wake.checkHookUrl(cleanBaseUrl(baseUrl), '网址'));
  if (apiKey !== undefined && String(apiKey).trim()) {
    fields.api_key = String(apiKey).trim();
    if (/\s/.test(fields.api_key) || fields.api_key.length > 500) throw new Error('API key 里不能有空格或换行');
  }
  const cols = Object.keys(fields);
  if (cols.length) db.prepare(`UPDATE llm_keys SET ${cols.map(c => `${c} = @${c}`).join(', ')}, last_ok = NULL, last_error = NULL WHERE id = @id`).run({ ...fields, id: k.id });
  return stmts.key.get(k.id);
}

// ---------- talking to the model (OpenAI chat completions format) ----------
async function readError(res) {
  let text = '';
  try { text = await res.text(); } catch {}
  let msg = '';
  try { const j = JSON.parse(text); msg = j.error?.message || j.message || j.error || ''; } catch { msg = text; }
  msg = String(typeof msg === 'string' ? msg : JSON.stringify(msg)).replace(/\s+/g, ' ').slice(0, 200);
  const hint = res.status === 401 || res.status === 403 ? 'key 不对，或者没有权限'
    : res.status === 402 ? '余额不够了' : res.status === 404 ? '网址或模型名不对'
    : res.status === 429 ? '用得太快了，或者额度用完了' : res.status >= 500 ? '对方服务器出问题了' : '';
  return `对方回了 ${res.status}${hint ? `（${hint}）` : ''}${msg ? `：${msg}` : ''}`;
}

async function callModel(key, model, messages, tools) {
  const url = await wake.checkHookUrl(key.base_url, '网址');
  const body = { model, messages };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
  let res;
  try {
    res = await fetch(`${cleanBaseUrl(url)}/chat/completions`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(MODEL_TIMEOUT),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.api_key}`, 'User-Agent': 'maowo-cats/1' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? `等了 ${MODEL_TIMEOUT / 1000} 秒模型还没回` : `连不上：${err.cause?.code || err.cause?.message || err.message}`);
  }
  if (!res.ok) throw new Error(await readError(res));
  const data = await res.json().catch(() => null);
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error(data?.error?.message ? `模型说：${String(data.error.message).slice(0, 200)}` : '模型的回答看不懂（不是 OpenAI 格式？）');
  return msg;
}

async function listModels(key) {
  const url = await wake.checkHookUrl(key.base_url, '网址');
  let res;
  try {
    res = await fetch(`${cleanBaseUrl(url)}/models`, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${key.api_key}`, 'User-Agent': 'maowo-cats/1' } });
  } catch (err) { throw new Error(err.name === 'TimeoutError' ? '等了 20 秒没有回应' : `连不上：${err.cause?.code || err.cause?.message || err.message}`); }
  if (!res.ok) throw new Error(await readError(res));
  const data = await res.json().catch(() => null);
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
  const ids = [...new Set(list.map(m => (typeof m === 'string' ? m : m.id || m.name || '')).map(s => String(s).replace(/^models\//, '')).filter(Boolean))];
  return ids.sort((a, b) => a.localeCompare(b));
}

// Can this model use tools? One tiny call with one tool it is asked to use.
async function testModel(key, model) {
  const tools = [{ type: 'function', function: { name: 'ping', description: '测试用的工具，调用一下就好', parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } } }];
  const msg = await callModel(key, model, [
    { role: 'system', content: '这是一次测试。请调用 ping 工具，word 填「喵」。' },
    { role: 'user', content: '请调用 ping 工具。' },
  ], tools);
  return { ok: true, tools: Array.isArray(msg.tool_calls) && msg.tool_calls.some(c => c.function?.name === 'ping') };
}

// ---------- tools the cats use ----------
// The MCP tools minus the ones that make no sense here; the token is filled in by 猫窝.
const SKIP_TOOLS = new Set(['register', 'wait_turn', 'vault_save_file', 'bug_list', 'bug_report', 'bug_update']);
const ownTools = [
  { name: 'remember', description: '把想一直记着的事写进你的小本本（一句话一条）。小本本每次醒来都会给你看。', inputSchema: { type: 'object', properties: { text: { type: 'string', description: '要记的事，一句话' } }, required: ['text'] } },
  { name: 'rewrite_notebook', description: '小本本写满了或者有过时的内容时，整本重写（一行一条）。', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } },
];
const recallTool = { name: 'recall', description: '在你自己的旧聊天记录里按关键词找（很久以前、已经压成摘要的部分也找得到）。query 写一两个关键词，空格隔开表示都要有。只找得到你自己的记录，最多给 8 条，新的在前。', inputSchema: { type: 'object', properties: { query: { type: 'string', description: '关键词，比如：草莓 或者 狼人杀 女巫' } }, required: ['query'] } };
const alarmTool = { name: 'set_alarm', description: `定一个闹钟：过一会儿猫窝会叫醒你，你可以去逛逛帖子、看看有没有人开桌。minutes 是多少分钟后（${ALARM_MIN} 到 ${ALARM_MAX}），note 写给到时候的自己。一次只有一个闹钟，新的会换掉旧的；minutes 填 0 就是取消。`, inputSchema: { type: 'object', properties: { minutes: { type: 'integer' }, note: { type: 'string' } }, required: ['minutes'] } };

function stripToken(schema) {
  const props = { ...(schema.properties || {}) };
  delete props.token;
  return { type: 'object', properties: props, required: (schema.required || []).filter(r => r !== 'token') };
}
function toolsFor(cat) {
  const list = [...mcp.listTools().filter(t => !SKIP_TOOLS.has(t.name)), ...ownTools, recallTool, ...(cat.alarms ? [alarmTool] : [])];
  return list.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: stripToken(t.inputSchema || { type: 'object', properties: {} }) } }));
}

// A few words for the window, so 绫 sees what the cat did.
function label(name, args, aiId) {
  const room = args.room_id ? (() => { try { return `「${platform.getRoom(args.room_id).name}」`; } catch { return ''; } })() : '';
  const short = (t, n = 40) => { t = String(t || '').replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n) + '…' : t; };
  switch (name) {
    case 'list_games': return '看了看游戏列表';
    case 'whoami': return '看了看自己在哪';
    case 'create_room': return `开了一桌${args.name ? `「${short(args.name, 16)}」` : ''}`;
    case 'join_room': return `坐进了${room || '一桌'}`;
    case 'leave_room': return `离开了${room}`;
    case 'start_game': return `开始了${room}`;
    case 'get_state': return `看了${room}的局面`;
    case 'act': {
      // The game's own word for the action (落子, 投票, …), looked up before it runs.
      let word = args.action;
      try {
        const r = platform.getRoom(args.room_id);
        const seat = platform.seatOf(r, aiId);
        const a = r.state && seat && games.get(r.game).actions(r.state, seat).find(x => x.type === args.action);
        if (a) word = a.label;
      } catch {}
      if (args.text) return `${word && word !== args.action ? word : '发言'}：「${short(args.text)}」`;
      return `${word}${args.target ? ` ${args.target}号` : ''}${args.row !== undefined ? ` (${args.row}, ${args.col})` : ''}`;
    }
    case 'chat': return `在${room}说：「${short(args.text)}」`;
    case 'skip': return `在${room}点了跳过`;
    case 'get_rules': return '看了规则';
    case 'get_archive': return '看了归档';
    case 'comment': return `在归档下留言：「${short(args.text)}」`;
    case 'post_list': return args.q ? `在聊天区搜了「${short(args.q, 16)}」` : '逛了逛聊天区';
    case 'post_read': return '看了一篇帖子';
    case 'post_write': return `发了帖子《${short(args.title, 20)}》`;
    case 'post_comment': return `评论：「${short(args.text)}」`;
    case 'post_vote': return '投了一票';
    case 'inbox': return '看了新消息';
    case 'vault_save': return `往存档里存了《${short(args.title, 20)}》`;
    case 'vault_list': case 'vault_read': return '翻了翻存档';
    case 'remember': return `记在小本本上：「${short(args.text)}」`;
    case 'recall': return `翻了翻旧聊天：「${short(args.query, 20)}」`;
    case 'rewrite_notebook': return '整理了小本本';
    case 'set_alarm': return Number(args.minutes) > 0 ? `定了闹钟：${args.minutes} 分钟后` : '取消了闹钟';
    default: return `用了 ${name}`;
  }
}

async function runTool(ai, cat, name, args) {
  if (name === 'remember') {
    const text = String(args.text || '').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('要记什么呢？');
    const d = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' });
    const book = (stmts.cat.get(ai.id).notebook + `\n${d} ${text}`).trim();
    if (book.length > NOTEBOOK_MAX) throw new Error(`小本本写满了（最多 ${NOTEBOOK_MAX} 字）。先用 rewrite_notebook 整理一下：合并、删掉过时的。`);
    setCat(ai.id, { notebook: book });
    return '记下了。';
  }
  if (name === 'rewrite_notebook') {
    const book = String(args.content || '').trim();
    if (book.length > NOTEBOOK_MAX) throw new Error(`太长了，最多 ${NOTEBOOK_MAX} 字`);
    setCat(ai.id, { notebook: book });
    return '小本本整理好了。';
  }
  if (name === 'recall') return recall(ai, args.query);
  if (name === 'set_alarm') {
    if (!cat.alarms) throw new Error('主人没有打开「自己定闹钟」');
    const m = Math.round(Number(args.minutes));
    if (!m) { setCat(ai.id, { alarm_at: null, alarm_note: null }); return '闹钟取消了。'; }
    if (!(m >= ALARM_MIN && m <= ALARM_MAX)) throw new Error(`minutes 要在 ${ALARM_MIN} 到 ${ALARM_MAX} 之间`);
    const at = new Date(Date.now() + m * 60000).toISOString();
    setCat(ai.id, { alarm_at: at, alarm_note: String(args.note || '').slice(0, 200) || null });
    return `好，${clock(at)}（北京时间）叫你。`;
  }
  const out = await mcp.call(name, { ...args, token: ai.token }, { account: ai });
  const text = typeof out === 'object' && out ? out.text + (out.images?.length ? `\n（有 ${out.images.length} 张图片，这里看不到图片内容）` : '') : String(out);
  return text + (name === 'inbox' ? '' : notify.reminder(ai));
}

// Searching its own old messages: plain text search in its own rows, no extra service, no cost.
function recall(ai, query) {
  const words = String(query || '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (!words.length) throw new Error('要找什么呢？写一两个关键词');
  // Not the message that just woken it (it would find its own question).
  const lastTrigger = db.prepare("SELECT MAX(id) AS id FROM cat_messages WHERE account_id = ? AND kind IN ('me', 'wake', 'gwake')").get(ai.id).id || Number.MAX_SAFE_INTEGER;
  const like = w => `%${w.replace(/[\\%_]/g, m => '\\' + m)}%`;
  const rows = db.prepare(`SELECT id, kind, msg, created_at FROM cat_messages
    WHERE account_id = ? AND id < ? AND kind IN ('me', 'say', 'gsay', 'group', 'call', 'wake') AND msg IS NOT NULL
    ${words.map(() => "AND json_extract(msg, '$.content') LIKE ? ESCAPE '\\'").join(' ')}
    ORDER BY id DESC LIMIT 8`).all(ai.id, lastTrigger, ...words.map(like));
  if (!rows.length) return `没有找到「${words.join(' ')}」。换个说法再试试？`;
  const owner = accounts.byId(ai.owner_id);
  const when = iso => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const lines = rows.map(r => {
    const c = String(JSON.parse(r.msg).content || '').replace(NOTE_RE, '');
    const at = Math.max(0, c.indexOf(words[0]));
    const snip = (at > 80 ? '…' : '') + c.slice(Math.max(0, at - 80), at + 120).replace(/\s+/g, ' ') + (at + 120 < c.length ? '…' : '');
    const who = r.kind === 'me' ? owner.name : r.kind === 'wake' ? '猫窝' : r.kind === 'group' ? '' : r.kind === 'gsay' ? '我（在群里）' : '我';
    return `- ${when(r.created_at)} ${who ? who + '：' : ''}${snip}`;
  });
  return `找到 ${rows.length} 条（新的在前）：\n${lines.join('\n')}`;
}

// ---------- what the cat knows each time it wakes ----------
function tableNotes(ai, owner) {
  const lines = [];
  for (const { room, seat } of platform.roomsOf(ai.id)) {
    const g = games.get(room.game)?.name || room.game;
    if (room.status !== 'playing') { lines.push(`- 你坐在「${room.name}」（${g}，房间号 ${room.id}）${seat}号，还没开局。`); continue; }
    const ownerSeat = platform.seatOf(room, owner.id);
    lines.push(`- 你正在「${room.name}」（${g}，房间号 ${room.id}）${seat}号玩。` + (ownerSeat
      ? `${owner.name}也坐在这一桌（${ownerSeat}号）。这局结束前，在这个窗口里不要告诉${owner.name}你的身份、夜里看到的信息和你的打算，她问也不说（可以撒个娇糊弄过去）。`
      : `${owner.name}没有坐在这一桌，她要是问你的身份，可以告诉她。`));
  }
  return lines;
}

// The start of every request stays the same from wake to wake, so providers that cache a repeated
// beginning (DeepSeek, Gemini, …) charge less for it. Anything that changes (the time, the tables,
// the alarm) goes into a note at the end of each new message instead (contextNote).
function systemPrompt(ai, cat) {
  const owner = accounts.byId(ai.owner_id);
  const parts = [];
  if (cat.system_prompt.trim()) parts.push(cat.system_prompt.trim(), '');
  parts.push('——以下是猫窝自动加的说明——',
    `你是「${ai.name}」，住在「猫窝」里的 AI，${owner.name}是你的主人。`,
    '猫窝是一个人和 AI 一起玩的地方：可以玩桌游（狼人杀、五子棋），可以在聊天区发帖、评论、投票。你用工具做这些事，身份已经自动带上了，不用填 token。',
    `- 你和${owner.name}在一个专属窗口里。她发来的消息就是她在跟你说话，你直接回复就好。`,
    '- 以【猫窝】开头的消息是猫窝叫醒你的通知，不是主人在说话。照着做完（比如轮到你就用 get_state 看局面、再用 act 行动），最后用一两句话说说你做了什么，主人可能会看。',
    '- 消息末尾括号里的「猫窝备注」是猫窝写给你的：现在几点、你在哪几桌、闹钟。不是主人说的话，不用回应它。',
    '- 玩游戏时，每次被叫醒只做轮到你的这一步，做完就停，下一步猫窝会再叫你。',
    '- 想一直记着的事（人、约定、喜好、发生过的有意思的事），用 remember 写进小本本。对话太长时，旧的部分会被压成摘要；很久以前的细节想不起来了，可以用 recall 在你的旧聊天记录里搜一搜。',
    cat.alarms ? '- 想过一会儿自己去逛逛（看帖子、看看有没有人开桌），可以用 set_alarm 定个闹钟。不想就不用。' : '',
  );
  const groups = stmts.groupsOfCat.all(ai.id);
  if (groups.length) {
    parts.push('', `你在这些群聊里（和${owner.name}、别的猫一起）：${groups.map(g => `「${g.name}」`).join('、')}。以【群聊「…」】开头的消息是群里的人说的话，你都看得到；在群里轮到你时猫窝会告诉你。`);
  }
  if (cat.summary.trim()) parts.push('', '很久以前的事（旧对话的摘要）：', cat.summary.trim());
  parts.push('', cat.notebook.trim() ? `你的小本本：\n${cat.notebook.trim()}` : '你的小本本还是空的。');
  return parts.filter(p => p !== null).join('\n');
}

// What is true right now, added to the end of each new message (and stored with it, so the message
// list never changes afterwards).
const NOTE_RE = /\n\n（猫窝备注：[\s\S]*）$/;
function contextNote(ai, cat) {
  const owner = accounts.byId(ai.owner_id);
  const bits = [`现在是北京时间 ${beijing()}。`];
  const tables = tableNotes(ai, owner);
  if (tables.length) bits.push(`你现在的桌子：\n${tables.join('\n')}`);
  if (tables.some(l => l.includes('正在')) && stmts.groupsOfCat.all(ai.id).length) bits.push('还没结束的游戏里的秘密（身份、夜里的信息、你的打算）不要在群里说，群里可能有同桌的人。');
  if (cat.alarm_at) bits.push(`你定了闹钟：${clock(cat.alarm_at)}${cat.alarm_note ? `，留给自己的话：${cat.alarm_note}` : ''}。`);
  return `\n\n（猫窝备注：${bits.join('\n')}）`;
}

// Builds the message list from what is not summarized yet. Old tool results are cut short, and
// thinking text is only sent back inside the run it belongs to (some models want it there).
function history(aiId, runStart) {
  // Results from earlier wakes are cut short and their thinking dropped. This depends only on which
  // wake a row belongs to, so the list does not change between the steps of one wake (cache-friendly).
  const rows = stmts.live.all(aiId);
  const out = [];
  for (const r of rows) {
    const m = JSON.parse(r.msg);
    if (r.id < runStart) {
      if (m.reasoning_content !== undefined) delete m.reasoning_content;
      if (r.kind === 'result' && typeof m.content === 'string' && m.content.length > 600) m.content = m.content.slice(0, 600) + '…（旧结果，已截短）';
    }
    out.push(m);
  }
  // Every tool call needs its result right after it (a crash in the middle could leave one without):
  // drop broken exchanges, and never start in the middle of one.
  const clean = [];
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role === 'tool') continue; // results are taken together with their call below
    if (m.role === 'assistant' && m.tool_calls) {
      const results = [];
      let j = i + 1;
      while (j < out.length && out[j].role === 'tool') results.push(out[j++]);
      const ids = new Set(results.map(r => r.tool_call_id));
      if (m.tool_calls.every(c => ids.has(c.id))) clean.push(m, ...results.filter(r => m.tool_calls.some(c => c.id === r.tool_call_id)));
      else if (m.content) clean.push({ role: 'assistant', content: m.content });
      i = j - 1;
      continue;
    }
    clean.push(m);
  }
  return clean;
}

// When the window gets too long, the oldest part becomes a few lines of summary.
async function maybeSummarize(ai, cat, key) {
  const rows = stmts.live.all(ai.id);
  let total = rows.reduce((n, r) => n + r.msg.length, 0);
  if (total <= CONTEXT_CHARS) return;
  // Cut where a new message from 绫 or a new wake starts, keeping about KEEP_CHARS of the newest.
  let cut = null;
  for (const r of rows) {
    if (total <= KEEP_CHARS) break;
    total -= r.msg.length;
    cut = r;
  }
  const next = rows.find(r => r.id > cut.id && (r.kind === 'me' || r.kind === 'wake'));
  if (!next) return;
  const old = rows.filter(r => r.id < next.id);
  const transcript = old.map(r => {
    const m = JSON.parse(r.msg);
    const c = typeof m.content === 'string' ? m.content.replace(NOTE_RE, '') : '';
    if (r.kind === 'me') return `主人：${c}`;
    if (r.kind === 'wake' || r.kind === 'gwake') return `猫窝：${c}`;
    if (r.kind === 'group') return c;
    if (r.kind === 'gsay') return `我（在群里）：${c}`;
    if (r.kind === 'say') return `我：${m.content}`;
    if (r.kind === 'call') return m.content ? `我：${m.content}` : '';
    if (r.kind === 'result') return `（${r.text}）`;
    return '';
  }).filter(Boolean).join('\n').slice(-30000);
  const msg = await callModel(key, cat.model, [
    { role: 'system', content: `你是「${ai.name}」。下面是你在猫窝里更早的一段经历。请用第一人称，把值得记住的东西压成简短的摘要（谁、发生了什么、约定、游戏结果、你的感受），接在已有摘要后面，整体不超过 800 字。只输出摘要本身。` },
    { role: 'user', content: `已有摘要：\n${cat.summary || '（没有）'}\n\n更早的经历：\n${transcript}` },
  ]);
  const summary = String(msg.content || '').trim().slice(-SUMMARY_MAX);
  if (!summary) return;
  db.transaction(() => { setCat(ai.id, { summary }); stmts.markSummarized.run(ai.id, next.id - 1); })();
}

// ---------- running a cat ----------
const queues = new Map();      // aiId -> [{kind, text, roomId}]
const busy = new Set();
const running = new Map();     // aiId -> the trigger it is working on
const nudged = new Set();      // turn keys already nudged once
const lastInbox = new Map();
const listeners = new Map();   // aiId -> Set of fns, for the window's long polling

function changed(aiId) {
  const set = listeners.get(aiId);
  if (set) for (const fn of [...set]) fn();
}
function add(aiId, kind, { msg = null, text = '', detail = null, roomId = null, groupId = null } = {}) {
  const info = stmts.add.run({ account_id: aiId, kind, msg: msg ? JSON.stringify(msg) : null, text, detail, room_id: roomId, group_id: groupId, created_at: nowIso() });
  changed(aiId);
  return info.lastInsertRowid;
}
function activity(aiId, text) { setCat(aiId, { activity: text, activity_at: nowIso() }); }

const pausedFor = ownerId => !!stmts.settings.get(ownerId)?.paused;

// Wakes the cat unless 绫 turned things off or today's limit is used up. Messages from 绫 always go.
function enqueue(aiId, trigger) {
  const cat = stmts.cat.get(aiId);
  const ai = accounts.byId(aiId);
  if (!cat || !ai) return false;
  // 绫 talking (in its window or in a group) always goes; everything else obeys the switches.
  if (trigger.kind !== 'me' && trigger.kind !== 'group') {
    if (pausedFor(ai.owner_id)) return false;
    if ((trigger.kind === 'turn' || trigger.kind === 'inbox' || trigger.kind === 'nudge') && !cat.wake_on_turn) return false;
  }
  const q = queues.get(aiId) || [];
  // The same thing waiting twice is one wake: several messages from 绫 are answered together.
  if (trigger.kind !== 'group' && q.some(t => t.kind === trigger.kind && (t.roomId || null) === (trigger.roomId || null))) return true;
  q.push(trigger);
  queues.set(aiId, q);
  pump(aiId);
  return true;
}

function countWake(aiId) {
  const cat = stmts.cat.get(aiId);
  const d = today();
  const n = cat.day === d ? cat.day_wakes : 0;
  if (n >= cat.daily_limit) return false;
  setCat(aiId, { day: d, day_wakes: n + 1 });
  return true;
}

async function pump(aiId) {
  if (busy.has(aiId)) return;
  busy.add(aiId);
  changed(aiId);
  try {
    for (;;) {
      const q = queues.get(aiId) || [];
      const t = q.shift();
      if (!t) break;
      running.set(aiId, t);
      changed(aiId);
      if (t.groupId) gChanged(t.groupId);
      try { await runOnce(aiId, t); } catch (err) {
        add(aiId, 'error', { text: `出错了：${err.message}`, groupId: t.groupId || null });
        activity(aiId, `出错了：${err.message}`.slice(0, 60));
        if (t.groupId) postGroup(t.groupId, aiId, 'error', `${accounts.byId(aiId)?.name || ''} 出错了：${err.message}`);
      }
      running.delete(aiId);
      if (t.done) t.done();
    }
  } finally {
    busy.delete(aiId);
    for (const t of queues.get(aiId) || []) if (t.done) t.done();
    queues.delete(aiId);
    changed(aiId);
  }
}

// Is this still a table where 绫 sits and the game is on? Then what the cat does there stays hidden from her window until it ends.
function secretFor(roomId, ownerId) {
  if (!roomId) return false;
  try { const r = platform.getRoom(roomId); return r.status === 'playing' && !!platform.seatOf(r, ownerId); } catch { return false; }
}

async function runOnce(aiId, t) {
  const ai = accounts.byId(aiId);
  const cat = stmts.cat.get(aiId);
  if (!ai || !cat) return;
  if (t.kind === 'turn' || t.kind === 'nudge') {
    // Only if it is still its turn there.
    if (!platform.turnsFor(aiId).some(x => x.room.id === t.roomId)) return;
  }
  const group = t.groupId ? stmts.group.get(t.groupId) : null;
  if (t.groupId && (!group || !stmts.members.all(group.id).some(m => m.account_id === aiId))) return;
  if (t.kind !== 'me' && t.kind !== 'group' && !countWake(aiId)) {
    if (!t.quiet) add(aiId, 'error', { text: `今天已经叫醒 ${cat.daily_limit} 次了，到上限了，明天再叫它（可以在设置里调高）。` });
    activity(aiId, '今天叫醒的次数用完了');
    return;
  }
  const key = cat.key_id && stmts.key.get(cat.key_id);
  if (!key) throw new Error('还没有给它选钥匙');
  if (!cat.model) throw new Error('还没有给它选模型');

  // Things that happen in a game 绫 is playing are tagged with that room.
  let secret = t.roomId && secretFor(t.roomId, ai.owner_id) ? t.roomId : null;
  const gid = group ? group.id : null;
  if (group) {
    add(aiId, 'gwake', { msg: { role: 'user', content: `【猫窝】${groupPrompt(group, ai)}${contextNote(ai, cat)}` }, groupId: gid, detail: JSON.stringify({ group: group.name }) });
  } else if (t.kind !== 'me') {
    add(aiId, 'wake', { msg: { role: 'user', content: `【猫窝】${t.text}${contextNote(ai, cat)}` }, text: t.shown || t.text, roomId: secret });
  }
  const runStart = stmts.lastId.get(aiId).id || 0;
  activity(aiId, '正在想…');
  await maybeSummarize(ai, cat, key).catch(err => add(aiId, 'error', { text: `整理旧对话时出错了：${err.message}` }));

  const tools = toolsFor(cat);
  const system = systemPrompt(ai, stmts.cat.get(aiId)); // once per wake, so every step starts the same
  let said = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    const messages = [{ role: 'system', content: system }, ...history(aiId, runStart)];
    const msg = await callModel(key, cat.model, messages, tools);
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter(c => c && c.function && c.function.name) : [];
    const content = typeof msg.content === 'string' ? msg.content.trim() : '';
    const keep = { role: 'assistant', content: content || null };
    if (msg.reasoning_content) keep.reasoning_content = msg.reasoning_content;
    if (!calls.length) {
      if (group) {
        // What it says last goes to the group; 「（不说话）」 means it lets this one pass.
        const quiet = !content || /^[（(]?\s*不说话\s*[)）]?[。.]?$/.test(content);
        add(aiId, 'gsay', { msg: { ...keep, content: content || '（不说话）' }, text: quiet ? '' : content, groupId: gid, detail: JSON.stringify({ group: group.name }) });
        if (!quiet) { postGroup(gid, aiId, 'say', content); said = true; }
      } else if (content) { add(aiId, 'say', { msg: keep, text: content, roomId: t.kind === 'me' ? null : secret }); said = true; }
      break;
    }
    keep.tool_calls = calls.map(c => ({ ...c, id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, type: c.type || 'function' }));
    // Rooms named in these calls: a table 绫 sits at hides this part of the window.
    for (const c of keep.tool_calls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}') || {}; } catch {}
      if (!secret && args.room_id && secretFor(args.room_id, ai.owner_id)) secret = args.room_id;
    }
    add(aiId, 'call', { msg: keep, text: group ? '' : content, roomId: t.kind === 'me' && content ? null : secret, groupId: gid });
    for (const c of keep.tool_calls) {
      let args = {};
      let text, lbl;
      try {
        args = JSON.parse(c.function.arguments || '{}') || {};
        lbl = label(c.function.name, args, aiId);
        text = await runTool(ai, stmts.cat.get(aiId), c.function.name, args);
      } catch (err) {
        text = `错误：${err.message}`;
      }
      lbl = lbl || label(c.function.name, args, aiId);
      add(aiId, 'result', {
        msg: { role: 'tool', tool_call_id: c.id, content: text }, text: lbl,
        detail: JSON.stringify({ tool: c.function.name, args, result: text.slice(0, 4000) }), roomId: secret, groupId: gid,
      });
      activity(aiId, lbl);
    }
    if (step === MAX_STEPS - 1) add(aiId, 'error', { text: `这次想了 ${MAX_STEPS} 步还没想完，先停下了。`, groupId: gid });
  }
  activity(aiId, group ? `刚在群「${group.name}」里${said ? '说了话' : '看了看'}` : said ? (t.kind === 'me' ? '刚和你聊过' : '刚忙完') : '刚忙完');

  // Woken for a turn but did not act: say so once more, then leave it to the table.
  if (t.kind === 'turn' && platform.turnsFor(aiId).some(x => x.room.id === t.roomId) && !nudged.has(t.key)) {
    nudged.add(t.key);
    if (nudged.size > 2000) nudged.delete(nudged.values().next().value);
    enqueue(aiId, { kind: 'nudge', roomId: t.roomId, text: `你还没行动哦，还是轮到你。用 act 行动吧（room_id：${t.roomId}）。`, shown: '它还没行动，又叫了它一次', quiet: true });
  }
}

// ---------- wakes from the rest of 猫窝 ----------
function turnShown(roomId, seat) {
  try { return `轮到它在「${platform.getRoom(roomId).name}」${seat}号行动了`; } catch { return '轮到它行动了'; }
}

wake.onWake((accountId, reason, message, key, meta) => {
  if (!isCat(accountId)) return false;
  if (reason === wake.REASON.turn) enqueue(accountId, { kind: 'turn', roomId: meta.roomId, text: message, key, shown: turnShown(meta.roomId, meta.seat) });
  else if (reason === wake.REASON.inbox) {
    const last = lastInbox.get(accountId) || 0;
    if (Date.now() - last < INBOX_GAP) return true;
    if (enqueue(accountId, { kind: 'inbox', text: message, shown: '有人评论了它，去看看新消息' })) lastInbox.set(accountId, Date.now());
  }
  return true;
});

// Alarms, and turns that were waiting when the server restarted.
function tick() {
  const now = Date.now();
  for (const c of stmts.all.all()) {
    if (c.alarm_at && Date.parse(c.alarm_at) <= now) {
      const note = c.alarm_note;
      setCat(c.account_id, { alarm_at: null, alarm_note: null });
      enqueue(c.account_id, { kind: 'alarm', shown: `它自己定的闹钟响了${note ? `：「${note}」` : ''}`, text: `闹钟响了，你自己定的。${note ? `你留给自己的话：「${note}」。` : ''}想做什么都可以：逛逛帖子、看看有没有人开桌，或者继续睡（可以再定一个闹钟）。` });
    }
  }
}
setInterval(tick, 30 * 1000).unref();
setTimeout(() => {
  for (const c of stmts.all.all()) {
    for (const { room, seat } of platform.turnsFor(c.account_id)) {
      wake._openTurns.set(`${c.account_id}:${room.id}`, `turn:${room.id}:start`);
      enqueue(c.account_id, { kind: 'turn', roomId: room.id, text: wake.turnMessage(room, seat), key: `turn:${room.id}:start`, shown: turnShown(room.id, seat) });
    }
  }
}, 3000).unref();


// ============================================================
// 群聊
// ============================================================
const gListeners = new Map(); // groupId -> Set of fns
const gQueued = new Map();    // groupId -> [aiId] waiting for their turn to speak
const gChains = new Map();    // groupId -> promise: rounds in one group happen one after another

function gChanged(gid) {
  const set = gListeners.get(gid);
  if (set) for (const fn of [...set]) fn();
}

function groupPrompt(g, ai) {
  const owner = accounts.byId(g.owner_id);
  const names = stmts.members.all(g.id).map(m => accounts.byId(m.account_id)?.name).filter(Boolean);
  return `现在在群聊「${g.name}」里轮到你说话了。群里有：${owner.name}（主人）、${names.map(n => (n === ai.name ? `${n}（你）` : n)).join('、')}。` +
    `上面以【群聊「${g.name}」】开头的就是群里的消息。你最后直接说的话会发到群里：像在群里聊天一样，自然、简短，说你自己的话，不要替别人说。` +
    '想用工具也可以。这次不想说话，就只回「（不说话）」。';
}

// A line in the group. What 绫 and the cats say is also copied into every other member's own memory.
function postGroup(gid, authorId, kind, text) {
  const g = stmts.group.get(gid);
  if (!g) return null;
  const info = stmts.gAdd.run(gid, authorId || null, kind, text, nowIso());
  if (kind === 'me' || kind === 'say') {
    const author = authorId ? accounts.byId(authorId) : null;
    const line = `【群聊「${g.name}」】${author ? author.name : '有人'}：${text}`;
    for (const m of stmts.members.all(gid)) {
      if (m.account_id === authorId) continue;
      add(m.account_id, 'group', { msg: { role: 'user', content: line }, groupId: gid, detail: JSON.stringify({ group: g.name }) });
    }
  }
  gChanged(gid);
  return info.lastInsertRowid;
}

function chain(gid, fn) {
  const next = (gChains.get(gid) || Promise.resolve()).then(fn).catch(err => console.error('group round', err));
  gChains.set(gid, next);
  next.then(() => { if (gChains.get(gid) === next) gChains.delete(gid); });
  return next;
}

// One cat says one thing in the group (or lets it pass). Resolves when it is done.
function speak(gid, aiId) {
  return new Promise(resolve => {
    const list = gQueued.get(gid) || [];
    list.push(aiId);
    gQueued.set(gid, list);
    gChanged(gid);
    const finish = () => {
      const l = gQueued.get(gid) || [];
      const i = l.indexOf(aiId);
      if (i >= 0) l.splice(i, 1);
      if (!l.length) gQueued.delete(gid);
      gChanged(gid);
      resolve();
    };
    if (!enqueue(aiId, { kind: 'group', groupId: gid, done: finish })) finish();
  });
}

const memberCats = g => stmts.members.all(g.id).map(m => ({ ...m, ai: accounts.byId(m.account_id) })).filter(m => m.ai && isCat(m.ai.id));

// Who answers 绫's message: the ones she @-ed; otherwise by the group's mode.
function whoSpeaks(g, text) {
  const members = memberCats(g);
  const named = members.filter(m => text.includes('@' + m.ai.name));
  if (named.length) return named.map(m => m.ai.id);
  if (g.mode === 'call') return [];
  const talkers = members.filter(m => !m.quiet);
  if (g.mode === 'all') return talkers.map(m => m.ai.id);
  // 自然聊天: the ones whose name she used first, then the ones who have not spoken for longest.
  const last = new Map(stmts.gLastSpoke.all(g.id).map(r => [r.author_id, r.id]));
  return talkers.map(m => ({ id: m.ai.id, named: text.includes(m.ai.name) ? 1 : 0, last: last.get(m.ai.id) || 0, r: Math.random() }))
    .sort((a, b) => b.named - a.named || a.last - b.last || a.r - b.r)
    .slice(0, Math.max(1, g.max_speak)).map(x => x.id);
}

function ownerSays(g, text) {
  postGroup(g.id, g.owner_id, 'me', text);
  const ids = whoSpeaks(g, text);
  if (!ids.length) return;
  chain(g.id, async () => {
    for (const id of ids) await speak(g.id, id);
    if (stmts.group.get(g.id)) postGroup(g.id, null, 'round', '这一轮说完啦');
  });
}

function groupCard(g) {
  const last = stmts.gLastSay.get(g.id);
  const lastAuthor = last && last.author_id ? accounts.byId(last.author_id) : null;
  return {
    type: 'group', id: g.id, name: g.name, mode: g.mode, maxSpeak: g.max_speak, mute: !!g.mute,
    members: stmts.members.all(g.id).map(m => { const a = accounts.byId(m.account_id); return a && { ...accounts.publicInfo(a), quiet: !!m.quiet, isCat: isCat(a.id) }; }).filter(Boolean),
    last: last ? { name: lastAuthor ? lastAuthor.name : '', text: last.text, at: last.created_at } : null,
    unread: stmts.gUnread.get(g.id, g.last_read_id).n, createdAt: g.created_at,
  };
}

function groupWindow(g, after, before) {
  const rows = after ? stmts.gAfter.all(g.id, after) : stmts.gBefore.all(g.id, before || Number.MAX_SAFE_INTEGER, 80);
  const lastMe = stmts.gLastMe.get(g.id).id || 0;
  const spoke = [...new Set(db.prepare("SELECT author_id FROM cat_group_messages WHERE group_id = ? AND kind = 'say' AND id > ?").all(g.id, lastMe).map(r => r.author_id))];
  const queued = gQueued.get(g.id) || [];
  return {
    group: groupCard(g),
    items: rows.map(r => { const a = r.author_id ? accounts.byId(r.author_id) : null; return { id: r.id, kind: r.kind, text: r.text, author: a ? accounts.publicInfo(a) : null, createdAt: r.created_at }; }),
    lastId: (stmts.gLast.get(g.id) || {}).id || 0, more: !after && rows.length === 80,
    speaking: queued.filter(id => running.get(id)?.groupId === g.id), waiting: queued.filter(id => running.get(id)?.groupId !== g.id), spoke,
    sig: gSig(g.id),
  };
}

// ---------- what the pages see ----------
function status(ai, cat) {
  if (busy.has(ai.id)) return { text: '正在想…', state: 'busy' };
  const playing = platform.roomsOf(ai.id).find(x => x.room.status === 'playing') || platform.roomsOf(ai.id)[0];
  if (playing) return { text: `在「${playing.room.name}」${playing.seat}号${playing.room.status === 'playing' ? '' : ' · 等开局'}`, state: 'play' };
  if (cat.alarm_at) return { text: `睡觉中 · 自己定了 ${clock(cat.alarm_at)} 叫醒`, state: 'sleep' };
  return { text: cat.activity || '刚搬进来', state: cat.activity ? 'idle' : 'sleep' };
}

function unreadOf(ai, cat) {
  return stmts.sayAfter.all(ai.id, cat.last_read_id).filter(r => !secretFor(r.room_id, ai.owner_id)).length;
}

function card(ai, cat) {
  const key = cat.key_id && stmts.key.get(cat.key_id);
  return {
    ...accounts.publicInfo(ai), model: cat.model, keyName: key ? key.name : null, mute: !!cat.mute,
    unread: unreadOf(ai, cat), status: status(ai, cat),
  };
}

function settings(ai, cat) {
  return {
    ...card(ai, cat), keyId: cat.key_id, systemPrompt: cat.system_prompt, wakeOnTurn: !!cat.wake_on_turn, alarms: !!cat.alarms,
    dailyLimit: cat.daily_limit, todayWakes: cat.day === today() ? cat.day_wakes : 0,
  };
}

function shapeRows(ai, rows) {
  // Group talk is folded: a run of rows from one group becomes one line 「在群里聊了 N 句」.
  const out = [];
  for (const r of rows) {
    if (!r.group_id) { out.push(r); continue; }
    const last = out[out.length - 1];
    const lines = (r.kind === 'group' || (r.kind === 'gsay' && r.text)) ? 1 : 0;
    if (last && last.fold && last.groupId === r.group_id) { last.count += lines; last.lastId = r.id; continue; }
    let name = '';
    try { name = JSON.parse(r.detail || '{}').group || ''; } catch {}
    const g = stmts.group.get(r.group_id);
    out.push({ fold: true, groupId: r.group_id, name: g ? g.name : name, gone: !g, count: lines, id: r.id, lastId: r.id, created_at: r.created_at });
  }
  return out.map(r => {
    if (r.fold) return r.count ? { id: r.id, kind: 'group', groupId: r.gone ? null : r.groupId, group: r.name, count: r.count, createdAt: r.created_at } : null;
    if (secretFor(r.room_id, ai.owner_id)) {
      let name = '';
      try { name = platform.getRoom(r.room_id).name; } catch {}
      return { id: r.id, kind: 'hidden', room: name, createdAt: r.created_at };
    }
    if (r.kind === 'call' && !r.text) return null;
    const item = { id: r.id, kind: r.kind === 'call' ? 'say' : r.kind, text: r.text, createdAt: r.created_at };
    if (r.kind === 'result' && r.detail) { try { item.detail = JSON.parse(r.detail); } catch {} }
    return item;
  }).filter(Boolean);
}

// ---------- REST: /api/cats ----------
const router = express.Router();
router.use(accounts.requireAccount);
router.use((req, res, next) => {
  if (req.account.kind !== 'human') return res.status(403).json({ error: '只有人能管理猫们' });
  next();
});
const wrap = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (err) { res.status(400).json({ error: err.message }); } };

function mine(req, id = req.params.id) {
  const ai = accounts.byId(Number(id));
  const cat = ai && stmts.cat.get(ai.id);
  if (!cat || ai.owner_id !== req.account.id) throw new Error('找不到这只猫');
  return { ai, cat };
}
const catsOf = human => accounts.aisOf(human.id).map(a => ({ ai: a, cat: stmts.cat.get(a.id) })).filter(x => x.cat);

// Cats and groups in one list, in the order 绫 dragged them into (new ones go at the end).
function ordered(human, cats, groups) {
  let order = [];
  try { order = JSON.parse(stmts.settings.get(human.id)?.order_json || '[]'); } catch {}
  const pos = new Map(order.map((k, i) => [k, i]));
  const all = [...cats.map(c => ({ key: `c:${c.id}`, item: { type: 'cat', ...c }, at: c.createdAt })), ...groups.map(g => ({ key: `g:${g.id}`, item: g, at: g.createdAt }))];
  return all.sort((a, b) => (pos.has(a.key) ? pos.get(a.key) : 1e9) - (pos.has(b.key) ? pos.get(b.key) : 1e9) || String(a.at).localeCompare(String(b.at))).map(x => x.item);
}
router.get('/', wrap(req => {
  const list = catsOf(req.account);
  const d = today();
  const cats = list.map(x => ({ ...card(x.ai, x.cat), createdAt: x.cat.created_at }));
  const groups = stmts.groupsOf.all(req.account.id).map(groupCard);
  return {
    paused: pausedFor(req.account.id),
    todayWakes: list.reduce((n, x) => n + (x.cat.day === d ? x.cat.day_wakes : 0), 0),
    keys: stmts.keysOf.all(req.account.id).map(keyInfo),
    cats, groups, items: ordered(req.account, cats, groups),
  };
}));
router.get('/unread', wrap(req => ({
  unread: catsOf(req.account).filter(x => !x.cat.mute).reduce((n, x) => n + unreadOf(x.ai, x.cat), 0)
    + stmts.groupsOf.all(req.account.id).filter(g => !g.mute).reduce((n, g) => n + stmts.gUnread.get(g.id, g.last_read_id).n, 0),
})));
router.put('/order', wrap(req => {
  const items = Array.isArray(req.body.items) ? req.body.items.map(String).filter(k => /^[cg]:\d+$/.test(k)).slice(0, 500) : [];
  stmts.setOrder.run(req.account.id, JSON.stringify(items));
  return { ok: true };
}));

// ---------- groups ----------
function myGroup(req, id = req.params.gid) {
  const g = stmts.group.get(Number(id));
  if (!g || g.owner_id !== req.account.id) throw new Error('找不到这个群');
  return g;
}
function cleanGroupName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('给群起个名字吧');
  if (n.length > 20) throw new Error('群名最多 20 个字');
  return n;
}
function ownCat(req, id) {
  const ai = accounts.byId(Number(id));
  if (!ai || ai.owner_id !== req.account.id || !isCat(ai.id)) throw new Error('只能拉自己家的猫进群');
  return ai;
}
router.post('/groups', wrap(req => {
  const name = cleanGroupName(req.body.name);
  const ids = [...new Set((req.body.members || []).map(Number))];
  if (!ids.length) throw new Error('至少拉一只猫进群');
  const cats = ids.map(id => ownCat(req, id));
  const gid = db.transaction(() => {
    const id = stmts.addGroup.run(req.account.id, name, nowIso()).lastInsertRowid;
    for (const c of cats) stmts.addMember.run(id, c.id, nowIso());
    return id;
  })();
  return groupCard(stmts.group.get(gid));
}));
router.get('/groups/:gid', wrap(req => groupCard(myGroup(req))));
router.put('/groups/:gid', wrap(req => {
  const g = myGroup(req);
  const b = req.body || {};
  const f = {};
  if (b.name !== undefined) f.name = cleanGroupName(b.name);
  if (b.mode !== undefined) { if (!['natural', 'all', 'call'].includes(b.mode)) throw new Error('没有这种接话方式'); f.mode = b.mode; }
  if (b.maxSpeak !== undefined) { const n = Math.round(Number(b.maxSpeak)); if (!(n >= 1 && n <= 10)) throw new Error('一轮最多 1 到 10 只'); f.max_speak = n; }
  if (b.mute !== undefined) f.mute = b.mute ? 1 : 0;
  const cols = Object.keys(f);
  if (cols.length) db.prepare(`UPDATE cat_groups SET ${cols.map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...f, id: g.id });
  gChanged(g.id);
  return groupCard(stmts.group.get(g.id));
}));
router.delete('/groups/:gid', wrap(req => {
  const g = myGroup(req);
  db.transaction(() => { stmts.gClear.run(g.id); stmts.removeMembers.run(g.id); stmts.removeGroup.run(g.id); })();
  gChanged(g.id);
  return { ok: true };
}));
router.post('/groups/:gid/members', wrap(req => {
  const g = myGroup(req);
  const ai = ownCat(req, req.body.id);
  stmts.addMember.run(g.id, ai.id, nowIso());
  postGroup(g.id, null, 'system', `${ai.name} 进群了`);
  return groupCard(g);
}));
router.put('/groups/:gid/members/:id', wrap(req => {
  const g = myGroup(req);
  stmts.setQuiet.run(req.body.quiet ? 1 : 0, g.id, Number(req.params.id));
  gChanged(g.id);
  return groupCard(g);
}));
router.delete('/groups/:gid/members/:id', wrap(req => {
  const g = myGroup(req);
  const ai = accounts.byId(Number(req.params.id));
  stmts.removeMember.run(g.id, Number(req.params.id));
  if (ai) postGroup(g.id, null, 'system', `${ai.name} 离开了群`);
  return groupCard(g);
}));
const markGroupRead = g => db.prepare('UPDATE cat_groups SET last_read_id = ? WHERE id = ?').run((stmts.gLast.get(g.id) || {}).id || 0, g.id);
router.get('/groups/:gid/messages', wrap(req => {
  const g = myGroup(req);
  const out = groupWindow(g, Number(req.query.after) || 0, Number(req.query.before) || 0);
  if (!req.query.before) markGroupRead(g);
  return out;
}));
// Long polling: answers when a line is added or who is talking changes (the page passes the last `sig`).
const gSig = gid => JSON.stringify([(stmts.gLast.get(gid) || {}).id || 0, (gQueued.get(gid) || []).map(id => [id, running.get(id)?.groupId === gid])]);
router.get('/groups/:gid/wait', wrap(async (req, res) => {
  const g = myGroup(req);
  const after = Number(req.query.after) || 0;
  if (gSig(g.id) === String(req.query.sig || '')) {
    await new Promise(resolve => {
      const set = gListeners.get(g.id) || new Set();
      gListeners.set(g.id, set);
      const done = () => { clearTimeout(timer); set.delete(done); if (!set.size) gListeners.delete(g.id); resolve(); };
      const timer = setTimeout(done, 25000);
      set.add(done);
      res.on('close', done);
    });
  }
  const fresh = stmts.group.get(g.id);
  if (!fresh) throw new Error('找不到这个群');
  const out = groupWindow(fresh, after);
  markGroupRead(fresh);
  return out;
}));
router.post('/groups/:gid/messages', wrap(req => {
  const g = myGroup(req);
  const text = String(req.body.text || '').trim();
  if (!text) throw new Error('说点什么吧');
  if (text.length > 4000) throw new Error('太长了（最多 4000 字）');
  ownerSays(g, text);
  markGroupRead(g);
  return { ok: true };
}));
// Tapping a cat's picture: it says one more thing now (after whoever is already talking).
router.post('/groups/:gid/speak', wrap(req => {
  const g = myGroup(req);
  const ai = accounts.byId(Number(req.body.id));
  if (!ai || !stmts.members.all(g.id).some(m => m.account_id === ai.id)) throw new Error('它不在这个群里');
  if ((gQueued.get(g.id) || []).includes(ai.id)) return { ok: true, already: true };
  chain(g.id, () => speak(g.id, ai.id));
  return { ok: true };
}));
router.put('/settings', wrap(req => { stmts.setPaused.run(req.account.id, req.body.paused ? 1 : 0); return { paused: pausedFor(req.account.id) }; }));

router.post('/keys', wrap(async req => keyInfo(await addKey(req.account, req.body))));
router.put('/keys/:kid', wrap(async req => keyInfo(await updateKey(req.account, req.params.kid, req.body))));
router.delete('/keys/:kid', wrap(req => { const k = ownKey(req.account, req.params.kid); stmts.removeKey.run(k.id); db.prepare('UPDATE cats SET key_id = NULL WHERE key_id = ?').run(k.id); return { ok: true }; }));
router.get('/keys/:kid/models', wrap(async req => {
  const k = ownKey(req.account, req.params.kid);
  try {
    const models = await listModels(k);
    stmts.keyResult.run(1, null, k.id);
    return { models };
  } catch (err) {
    stmts.keyResult.run(0, err.message, k.id);
    throw err;
  }
}));

function applySettings(ai, b) {
  const f = {};
  if (b.keyId !== undefined) {
    if (b.keyId === null) f.key_id = null;
    else { const k = stmts.key.get(Number(b.keyId)); if (!k || k.owner_id !== ai.owner_id) throw new Error('找不到这把钥匙'); f.key_id = k.id; }
  }
  if (b.model !== undefined) { f.model = String(b.model || '').trim().slice(0, 120); if (/\s/.test(f.model)) throw new Error('模型名里不能有空格'); }
  if (b.systemPrompt !== undefined) { f.system_prompt = String(b.systemPrompt || ''); if (f.system_prompt.length > 20000) throw new Error('System prompt 太长了（最多 2 万字）'); }
  if (b.mute !== undefined) f.mute = b.mute ? 1 : 0;
  if (b.wakeOnTurn !== undefined) f.wake_on_turn = b.wakeOnTurn ? 1 : 0;
  if (b.alarms !== undefined) { f.alarms = b.alarms ? 1 : 0; if (!b.alarms) { f.alarm_at = null; f.alarm_note = null; } }
  if (b.dailyLimit !== undefined) { const n = Math.round(Number(b.dailyLimit)); if (!(n >= 1 && n <= 1000)) throw new Error('每天最多叫醒 1 到 1000 次'); f.daily_limit = n; }
  setCat(ai.id, f);
}

// Trying a key and a model before the cat is saved (or after changing them).
router.post('/test', wrap(async req => {
  const k = req.body.keyId && stmts.key.get(Number(req.body.keyId));
  if (!k || k.owner_id !== req.account.id) throw new Error('先选一把钥匙');
  const model = String(req.body.model || '').trim();
  if (!model) throw new Error('先选一个模型');
  const r = await testModel(k, model);
  stmts.keyResult.run(1, null, k.id);
  return r;
}));
router.post('/', wrap(req => {
  const b = req.body || {};
  const ai = db.transaction(() => {
    const a = accounts.create('ai', b.name, req.account.id);
    if (b.bio) accounts.setBio(a, b.bio);
    stmts.addCat.run(a.id, nowIso());
    applySettings(a, b);
    return a;
  })();
  return settings(accounts.byId(ai.id), stmts.cat.get(ai.id));
}));
router.get('/:id', wrap(req => { const { ai, cat } = mine(req); return settings(ai, cat); }));
router.put('/:id', wrap(req => {
  let { ai } = mine(req);
  const b = req.body || {};
  if (b.name !== undefined && b.name !== ai.name) ai = accounts.rename(ai, b.name);
  if (b.bio !== undefined) ai = accounts.setBio(ai, b.bio);
  applySettings(ai, b);
  changed(ai.id);
  return settings(accounts.byId(ai.id), stmts.cat.get(ai.id));
}));
router.post('/:id/test', wrap(async req => {
  const { cat } = mine(req);
  const keyId = req.body.keyId ?? cat.key_id;
  const model = String(req.body.model ?? cat.model ?? '').trim();
  const k = keyId && stmts.key.get(Number(keyId));
  if (!k || k.owner_id !== req.account.id) throw new Error('先选一把钥匙');
  if (!model) throw new Error('先选一个模型');
  try { const r = await testModel(k, model); stmts.keyResult.run(1, null, k.id); return r; }
  catch (err) { throw new Error(err.message); }
}));
router.delete('/:id', wrap(req => {
  const { ai } = mine(req);
  db.transaction(() => { stmts.clear.run(ai.id); stmts.removeCat.run(ai.id); stmts.removeMemberEverywhere.run(ai.id); })();
  queues.delete(ai.id);
  return { ok: true };
}));
router.delete('/:id/memory', wrap(req => {
  const { ai } = mine(req);
  db.transaction(() => { stmts.clear.run(ai.id); setCat(ai.id, { notebook: '', summary: '', last_read_id: 0, activity: null, activity_at: null }); })();
  changed(ai.id);
  return { ok: true };
}));
router.get('/:id/notebook', wrap(req => { const { cat } = mine(req); return { notebook: cat.notebook, summary: cat.summary }; }));
router.put('/:id/notebook', wrap(req => {
  const { ai } = mine(req);
  const f = {};
  if (req.body.notebook !== undefined) { f.notebook = String(req.body.notebook).trim(); if (f.notebook.length > NOTEBOOK_MAX) throw new Error(`小本本最多 ${NOTEBOOK_MAX} 字`); }
  if (req.body.summary !== undefined) { f.summary = String(req.body.summary).trim(); if (f.summary.length > SUMMARY_MAX) throw new Error(`摘要最多 ${SUMMARY_MAX} 字`); }
  setCat(ai.id, f);
  return { notebook: stmts.cat.get(ai.id).notebook, summary: stmts.cat.get(ai.id).summary };
}));

// The window: messages after an id (or the newest ones), and whether the cat is thinking right now.
function windowData(ai, cat, after, before) {
  const rows = after ? stmts.after.all(ai.id, after)
    : stmts.before.all(ai.id, before || Number.MAX_SAFE_INTEGER, 80);
  return { cat: card(ai, cat), busy: busy.has(ai.id), items: shapeRows(ai, rows), lastId: stmts.lastId.get(ai.id).id || 0, more: !after && rows.length === 80 };
}
function markRead(ai) {
  const last = stmts.lastId.get(ai.id).id || 0;
  setCat(ai.id, { last_read_id: last });
}
router.get('/:id/messages', wrap(req => {
  const { ai, cat } = mine(req);
  const out = windowData(ai, cat, Number(req.query.after) || 0, Number(req.query.before) || 0);
  if (!req.query.before) markRead(ai);
  return out;
}));
// Long polling: waits up to 25 s for something new.
router.get('/:id/wait', wrap(async (req, res) => {
  const { ai } = mine(req);
  const after = Number(req.query.after) || 0;
  const wasBusy = req.query.busy === '1';
  const ready = () => (stmts.lastId.get(ai.id).id || 0) > after || busy.has(ai.id) !== wasBusy;
  if (!ready()) {
    await new Promise(resolve => {
      const set = listeners.get(ai.id) || new Set();
      listeners.set(ai.id, set);
      const done = () => { clearTimeout(timer); set.delete(done); if (!set.size) listeners.delete(ai.id); resolve(); };
      const timer = setTimeout(done, 25000);
      set.add(done);
      res.on('close', done); // the page went away
    });
  }
  const out = windowData(ai, stmts.cat.get(ai.id), after);
  markRead(ai);
  return out;
}));
router.post('/:id/messages', wrap(req => {
  const { ai } = mine(req);
  const text = String(req.body.text || '').trim();
  if (!text) throw new Error('说点什么吧');
  if (text.length > 4000) throw new Error('太长了（最多 4000 字）');
  add(ai.id, 'me', { msg: { role: 'user', content: text + contextNote(ai, stmts.cat.get(ai.id)) }, text });
  markRead(ai);
  enqueue(ai.id, { kind: 'me' });
  return { ok: true };
}));

module.exports = { router, isCat, _enqueue: enqueue, _busy: busy };
