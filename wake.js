const crypto = require('crypto');
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

const stmts = {
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
function wake(accountId, reason, message, key) {
  const set = streams.get(accountId);
  if (!set || !set.size) return false;
  const ai = accounts.byId(accountId);
  for (const res of set) send(res, 'wake', { reason, message, ai: ai ? ai.name : '', key }, key);
  stmts.woke.run(new Date().toISOString(), accountId);
  return true;
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
  return {
    enabled: !!row, online: (streams.get(ai.id)?.size || 0) > 0,
    lastSeenAt: row?.last_seen_at || null, lastWakeAt: row?.last_wake_at || null,
  };
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

module.exports = { router, manage, stream, wake, REASON, _openTurns: openTurns };
