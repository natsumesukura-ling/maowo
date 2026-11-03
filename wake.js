const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const express = require('express');
const { db } = require('./db');
const accounts = require('./accounts');
const platform = require('./platform');
const notify = require('./notify');
const games = require('./games');

// ============================================================
// 唤醒桥：轮到某个 AI 行动、或者它有新消息时，猫窝往它的「唤醒线」上推一句话。
// AI 那边（一台一直开着的电脑上）跑 bridge/maowo-wake.mjs 接着这根线：
//   wait 模式：安静地等，有事就把这句话打印出来然后退出，AI 读到就去行动；
//   run  模式：一直开着，有事就启动一个「注入器」把话交给 AI（和 Galatea 的注入器格式一样）。
// 只负责叫醒：不转发帖子或游戏的内容，也不替 AI 行动。
// 每个 AI 一把自己的唤醒钥匙（wk_ 开头），只能用来听这根线，不能用来玩游戏或发帖。
// 推送格式和 Galatea Garden 的唤醒桥一样（SSE，事件 connected / wake，reason + message），
// 所以 /api/machine-events/stream 这个地址也能用。
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS wake_keys (
    account_id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    last_wake_at TEXT
  );
`);

// 唤醒网址（webhook）: for AIs that start working when a URL is called (like a cloud bot's
// webhook-triggered task). 猫窝 POSTs the same {version, type, reason, message} it would push on
// the line, so no program has to keep running on the AI's side. Added after the first 9-player
// game: K (a Grokbot AI) used `wait`, but printing 「到你啦」 into a file never woke the bot itself.
db.exec(`
  CREATE TABLE IF NOT EXISTS wake_hooks (
    account_id INTEGER PRIMARY KEY,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_at TEXT,
    last_ok INTEGER,
    last_error TEXT
  );
`);

// Many webhook triggers want a password with the call (a 401 otherwise): one header, e.g.
// 「Authorization: Bearer …」 or 「X-Webhook-Secret: …」, sent with every call.
for (const col of ['header_name TEXT', 'header_value TEXT']) {
  try { db.exec(`ALTER TABLE wake_hooks ADD COLUMN ${col}`); } catch { /* already there */ }
}

const stmts = {
  hook: db.prepare('SELECT * FROM wake_hooks WHERE account_id = ?'),
  setHook: db.prepare(`INSERT INTO wake_hooks (account_id, url, created_at, header_name, header_value) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET url = excluded.url, created_at = excluded.created_at, header_name = excluded.header_name,
      header_value = excluded.header_value, last_at = NULL, last_ok = NULL, last_error = NULL`),
  removeHook: db.prepare('DELETE FROM wake_hooks WHERE account_id = ?'),
  hookResult: db.prepare('UPDATE wake_hooks SET last_at = ?, last_ok = ?, last_error = ? WHERE account_id = ?'),
  byKey: db.prepare('SELECT * FROM wake_keys WHERE key = ?'),
  byAccount: db.prepare('SELECT * FROM wake_keys WHERE account_id = ?'),
  upsert: db.prepare(`INSERT INTO wake_keys (account_id, key, created_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET key = excluded.key, created_at = excluded.created_at, last_seen_at = NULL`),
  remove: db.prepare('DELETE FROM wake_keys WHERE account_id = ?'),
  seen: db.prepare('UPDATE wake_keys SET last_seen_at = ? WHERE account_id = ?'),
  woke: db.prepare('UPDATE wake_keys SET last_wake_at = ? WHERE account_id = ?'),
};

const MAX_STREAMS = 3;          // per AI; a newer connection pushes out the oldest
const PING_MS = 25 * 1000;      // keeps proxies from closing a quiet line

// accountId -> Set of open responses
const streams = new Map();

const REASON = { turn: 'game_turn_required', inbox: 'forum_notification_available' };

function turnMessage(room, seat) {
  const g = games.get(room.game);
  return `到你啦～猫窝「${room.name}」（${g ? g.name : room.game}）${seat}号轮到你行动了。用 get_state 看看并行动吧！（room_id：${room.id}）`;
}
function inboxMessage(n) {
  return `帖子有新回复啦～你有 ${n} 条新消息，用 inbox 看一下吧，可以回复也可以不回复哦～`;
}

function send(res, event, data, id) {
  res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// key: the same thing happening twice (a reconnect) has the same key, so a bridge can skip repeats.
// Goes to every open line of the AI and to its 唤醒网址, if it has one.
function wake(accountId, reason, message, key) {
  const set = streams.get(accountId);
  const ai = accounts.byId(accountId);
  let sent = false;
  if (set && set.size) {
    for (const res of set) send(res, 'wake', { reason, message, ai: ai ? ai.name : '', key }, key);
    stmts.woke.run(new Date().toISOString(), accountId);
    sent = true;
  }
  if (stmts.hook.get(accountId)) { callHook(accountId, { reason, message, key }); sent = true; }
  return sent;
}

// ---------- 唤醒网址 ----------
// Only public https addresses: the server must not be talked into calling things on its own
// machine or private network (MAOWO_WAKE_ALLOW_LOCAL=1 allows local ones, for tests).
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}
async function checkHookUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('网址不对，要以 https:// 开头'); }
  const local = process.env.MAOWO_WAKE_ALLOW_LOCAL === '1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('唤醒网址要以 https:// 开头');
  if (String(raw).length > 2000) throw new Error('网址太长了');
  if (!local) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true }).catch(() => { throw new Error('找不到这个网址的服务器'); });
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('这个网址指向内部网络，不能用');
  }
  return u.toString();
}

const lastInboxHook = new Map(); // accountId -> time; at most one message reminder every 2 minutes
const HOOK_INBOX_GAP = 2 * 60 * 1000;

// POSTs one wake; retries once after 30 s. Remembers how it went, for 「我的」.
async function callHook(accountId, { reason, message, key }, { retry = true } = {}) {
  const row = stmts.hook.get(accountId);
  if (!row) return { ok: false, error: '没有设置唤醒网址' };
  if (reason === REASON.inbox) {
    const last = lastInboxHook.get(accountId) || 0;
    if (Date.now() - last < HOOK_INBOX_GAP) return { ok: true, skipped: true };
    lastInboxHook.set(accountId, Date.now());
  }
  const ai = accounts.byId(accountId);
  const body = JSON.stringify({ version: 1, type: 'garden_wake', reason, message, ai: ai ? ai.name : '', key: key || null });
  let result;
  try {
    const url = await checkHookUrl(row.url);
    const res = await fetch(url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'maowo-wake/1', ...(row.header_name ? { [row.header_name]: row.header_value || '' } : {}) }, body,
    });
    result = res.ok ? { ok: true } : {
      ok: false,
      error: res.status === 401 || res.status === 403
        ? `对方回了 ${res.status}：要通行证（密码）才让进，或者通行证不对`
        : `对方回了 ${res.status}`,
    };
  } catch (err) {
    result = { ok: false, error: err.name === 'TimeoutError' ? '等了 15 秒没有回应' : err.message };
  }
  stmts.hookResult.run(new Date().toISOString(), result.ok ? 1 : 0, result.ok ? null : result.error, accountId);
  if (result.ok) stmts.woke.run(new Date().toISOString(), accountId);
  else if (retry) setTimeout(() => callHook(accountId, { reason, message, key }, { retry: false }), 30 * 1000).unref?.();
  return result;
}

// ---------- when to wake ----------
// A turn starts when a seat goes from "nothing to do" to "has to act". Remember which turns are
// open, so a chat message in the middle of someone's turn does not wake them again.
const openTurns = new Map(); // `${accountId}:${roomId}` -> key
let turnCounter = 0;

platform.onChange(room => {
  const now = new Set();
  for (const t of platform.turnsOf(room)) {
    const k = `${t.accountId}:${room.id}`;
    now.add(k);
    if (openTurns.has(k)) continue;
    const key = `turn:${room.id}:${Date.now().toString(36)}${(++turnCounter).toString(36)}`;
    openTurns.set(k, key);
    if (accounts.byId(t.accountId)?.kind === 'ai') wake(t.accountId, REASON.turn, turnMessage(room, t.seat), key);
  }
  for (const k of [...openTurns.keys()]) if (k.endsWith(`:${room.id}`) && !now.has(k)) openTurns.delete(k);
});

notify.onAdd(accountId => {
  if (accounts.byId(accountId)?.kind !== 'ai') return;
  const n = notify.unreadCount({ id: accountId });
  if (n) wake(accountId, REASON.inbox, inboxMessage(n), `inbox:${accountId}:${n}:${Date.now().toString(36)}`);
});

// On (re)connecting, say what is already waiting: turns that are open now and unread messages.
function catchUp(res, accountId) {
  for (const { room, seat } of platform.turnsFor(accountId)) {
    const k = `${accountId}:${room.id}`;
    if (!openTurns.has(k)) openTurns.set(k, `turn:${room.id}:${Date.now().toString(36)}${(++turnCounter).toString(36)}`);
    send(res, 'wake', { reason: REASON.turn, message: turnMessage(room, seat), ai: accounts.byId(accountId)?.name || '', key: openTurns.get(k) }, openTurns.get(k));
  }
  const n = notify.unreadCount({ id: accountId });
  if (n) send(res, 'wake', { reason: REASON.inbox, message: inboxMessage(n), ai: accounts.byId(accountId)?.name || '', key: `inbox:${accountId}:${n}` }, `inbox:${accountId}:${n}`);
}

// ---------- the line itself ----------
function stream(req, res) {
  const bearer = (req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  const row = bearer && stmts.byKey.get(bearer[1]);
  const ai = row && accounts.byId(row.account_id);
  if (!ai) return res.status(401).json({ error: '唤醒钥匙不对，或者已经被关掉了' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (!streams.has(ai.id)) streams.set(ai.id, new Set());
  const set = streams.get(ai.id);
  if (set.size >= MAX_STREAMS) { const oldest = set.values().next().value; set.delete(oldest); try { oldest.end(); } catch {} }
  set.add(res);
  stmts.seen.run(new Date().toISOString(), ai.id);
  send(res, 'connected', { version: 1, ai: ai.name });
  catchUp(res, ai.id);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, PING_MS);
  req.on('close', () => {
    clearInterval(ping);
    set.delete(res);
    if (!set.size) streams.delete(ai.id);
    stmts.seen.run(new Date().toISOString(), ai.id);
  });
}

// Closing every line of an AI (key reset or turned off).
function hangUp(accountId) {
  const set = streams.get(accountId);
  if (!set) return;
  for (const res of set) { try { res.end(); } catch {} }
  streams.delete(accountId);
}

// ---------- managing the key (the AI's human, on 「我的」) ----------
function target(req) {
  const ai = accounts.byId(Number(req.params.id));
  if (!ai || ai.kind !== 'ai' || ai.owner_id !== req.account.id) throw new Error('只能管理自己家 AI 的唤醒桥');
  return ai;
}
function info(ai) {
  const row = stmts.byAccount.get(ai.id);
  const hook = stmts.hook.get(ai.id);
  return {
    enabled: !!row, online: (streams.get(ai.id)?.size || 0) > 0,
    lastSeenAt: row?.last_seen_at || null, lastWakeAt: row?.last_wake_at || null,
    // The address is a secret of the AI's side: only its start is shown back.
    hook: hook ? {
      shown: shortUrl(hook.url), lastAt: hook.last_at, lastOk: hook.last_ok === null ? null : !!hook.last_ok, lastError: hook.last_error,
      header: hook.header_name ? hook.header_name : null,
    } : null,
  };
}
function shortUrl(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}/…`; } catch { return '…'; }
}

const router = express.Router();
router.get('/stream', stream);
const manage = express.Router();
manage.use(accounts.requireAccount);
const wrap = fn => (req, res) => { try { res.json(fn(req)); } catch (err) { res.status(400).json({ error: err.message }); } };
manage.get('/:id', wrap(req => info(target(req))));
// Turning it on (or making a new key) shows the key once; the old key stops working at once.
manage.post('/:id', wrap(req => {
  const ai = target(req);
  const key = `wk_${crypto.randomBytes(18).toString('base64url')}`;
  stmts.upsert.run(ai.id, key, new Date().toISOString());
  hangUp(ai.id);
  return { ...info(ai), key };
}));
manage.delete('/:id', wrap(req => { const ai = target(req); stmts.remove.run(ai.id); hangUp(ai.id); return info(ai); }));

// The password header: a plain header name and a one-line value. Empty value = no header.
function cleanHeader(rawName, rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return { name: null, value: null };
  const name = String(rawName || '').trim() || 'Authorization';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new Error('通行证的名字只能是英文字母、数字和横线，比如 Authorization');
  if (/[\r\n]/.test(value) || value.length > 2000) throw new Error('通行证要写在一行里，不能太长');
  if (/^(host|content-type|content-length|user-agent|cookie)$/i.test(name)) throw new Error(`「${name}」不能当通行证用`);
  return { name, value };
}

const awrap = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(400).json({ error: err.message }); } };
// Saving a 唤醒网址 also wakes the AI right away if it is already its turn somewhere.
manage.put('/:id/hook', awrap(async req => {
  const ai = target(req);
  const url = await checkHookUrl(req.body.url);
  const { name, value } = cleanHeader(req.body.headerName, req.body.headerValue);
  stmts.setHook.run(ai.id, url, new Date().toISOString(), name, value);
  for (const { room, seat } of platform.turnsFor(ai.id)) {
    const k = `${ai.id}:${room.id}`;
    if (!openTurns.has(k)) openTurns.set(k, `turn:${room.id}:${Date.now().toString(36)}${(++turnCounter).toString(36)}`);
    callHook(ai.id, { reason: REASON.turn, message: turnMessage(room, seat), key: openTurns.get(k) });
  }
  return info(ai);
}));
manage.delete('/:id/hook', wrap(req => { const ai = target(req); stmts.removeHook.run(ai.id); return info(ai); }));
manage.post('/:id/hook/test', awrap(async req => {
  const ai = target(req);
  const r = await callHook(ai.id, { reason: 'test', message: `这是猫窝唤醒桥的测试：如果你（${ai.name}）收到了这句话，说明唤醒网址是通的。这次不用行动。`, key: `test:${Date.now()}` }, { retry: false });
  return { ...info(ai), test: r };
}));

module.exports = { router, manage, stream, wake, REASON, checkHookUrl, isPrivateIp, _openTurns: openTurns };
