const crypto = require('crypto');
const { db } = require('./db');
const accounts = require('./accounts');
const games = require('./games');

// ============================================================
// Platform layer: rooms, seats, visibility, skipping, archives, comments.
// Game modules only see seats and names; everything about accounts stays here.
// ============================================================
const SILENCE_MS = 3 * 60 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    game TEXT NOT NULL,
    name TEXT NOT NULL,
    host_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    seats TEXT NOT NULL,
    options TEXT NOT NULL,
    state TEXT,
    result TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS room_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    day INTEGER NOT NULL DEFAULT 0,
    part TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    seat INTEGER,
    label TEXT,
    text TEXT NOT NULL,
    visible TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_room_events_room ON room_events(room_id, id);

  CREATE TABLE IF NOT EXISTS room_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    ts TEXT NOT NULL
  );
`);

const stmts = {
  all: db.prepare('SELECT * FROM rooms'),
  upsert: db.prepare(`
    INSERT INTO rooms (id, game, name, host_id, status, seats, options, state, result, created_at, started_at, finished_at)
    VALUES (@id, @game, @name, @host_id, @status, @seats, @options, @state, @result, @created_at, @started_at, @finished_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, host_id=@host_id, status=@status, seats=@seats, options=@options,
      state=@state, result=@result, started_at=@started_at, finished_at=@finished_at
  `),
  remove: db.prepare('DELETE FROM rooms WHERE id = ?'),
  insertEvent: db.prepare(`INSERT INTO room_events (room_id, ts, day, part, kind, seat, label, text, visible)
    VALUES (@room_id, @ts, @day, @part, @kind, @seat, @label, @text, @visible)`),
  events: db.prepare('SELECT * FROM room_events WHERE room_id = ? AND id > ? ORDER BY id'),
  insertComment: db.prepare('INSERT INTO room_comments (room_id, account_id, text, ts) VALUES (?, ?, ?, ?)'),
  comments: db.prepare('SELECT * FROM room_comments WHERE room_id = ? ORDER BY id'),
};

const rooms = new Map();
for (const row of stmts.all.all()) {
  rooms.set(row.id, {
    id: row.id, game: row.game, name: row.name, hostId: row.host_id, status: row.status,
    seats: JSON.parse(row.seats), options: JSON.parse(row.options), state: row.state ? JSON.parse(row.state) : null,
    result: row.result ? JSON.parse(row.result) : null,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
  });
}

function save(room) {
  stmts.upsert.run({
    id: room.id, game: room.game, name: room.name, host_id: room.hostId, status: room.status,
    seats: JSON.stringify(room.seats), options: JSON.stringify(room.options),
    state: room.state ? JSON.stringify(room.state) : null, result: room.result ? JSON.stringify(room.result) : null,
    created_at: room.createdAt, started_at: room.startedAt || null, finished_at: room.finishedAt || null,
  });
}

// ---------- change notification (long polling) ----------
const waiters = new Map();
function notify(roomId) {
  const set = waiters.get(roomId);
  if (!set) return;
  waiters.delete(roomId);
  set.forEach(fn => fn());
}
function waitForChange(roomId, ms) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { waiters.get(roomId)?.delete(finish); finish(); }, ms);
    if (!waiters.has(roomId)) waiters.set(roomId, new Set());
    waiters.get(roomId).add(finish);
  });
}

// ---------- helpers ----------
function getRoom(id) {
  const room = rooms.get(String(id || '').trim());
  if (!room) throw new Error('找不到这个房间');
  return room;
}
const moduleOf = room => games.get(room.game);
const seatOf = (room, accountId) => room.seats.find(s => s.accountId === accountId)?.seat || null;
const seatName = (room, seat) => accounts.byId(room.seats.find(s => s.seat === seat)?.accountId)?.name || '空位';

function context(room) {
  const mod = moduleOf(room);
  return {
    now: () => Date.now(),
    random: n => crypto.randomInt(n),
    log(e) {
      const phase = room.state ? mod.phase(room.state) : { day: 0, part: '' };
      stmts.insertEvent.run({
        room_id: room.id, ts: new Date().toISOString(),
        day: e.day ?? phase.day ?? 0, part: e.part ?? phase.part ?? '',
        kind: e.kind || 'system', seat: e.seat ?? null, label: e.label ?? null, text: String(e.text),
        visible: Array.isArray(e.visible) ? JSON.stringify(e.visible) : (e.visible || 'public'),
      });
    },
  };
}

// Hard boundary: a seat only ever receives events meant for it. After the game everything is public.
function canSee(event, seat, finished) {
  if (finished || event.visible === 'public') return true;
  if (event.visible === 'archive' || !seat) return false;
  return JSON.parse(event.visible).includes(seat);
}

function eventsFor(room, seat, sinceId = 0) {
  const finished = room.status === 'finished';
  return stmts.events.all(room.id, sinceId).filter(e => canSee(e, seat, finished)).map(e => ({
    id: e.id, ts: e.ts, day: e.day, part: e.part, kind: e.kind, seat: e.seat, label: e.label, text: e.text,
    private: e.visible !== 'public',
  }));
}

// ---------- room lifecycle ----------
function createRoom(account, { game, name, options = {} }) {
  const mod = games.get(game);
  if (!mod) throw new Error(`没有这个游戏：${game}。可选：${games.list().map(g => g.id).join('、')}`);
  const opts = mod.normalizeOptions(options);
  const id = crypto.randomBytes(4).toString('hex');
  const seatCount = mod.seatCount(opts);
  const room = {
    id, game: mod.id, name: String(name || '').trim().slice(0, 24) || `${account.name}的${mod.name}局`,
    hostId: account.id, status: 'waiting', options: opts,
    seats: Array.from({ length: seatCount }, (_, i) => ({ seat: i + 1, accountId: i === 0 ? account.id : null })),
    state: null, result: null, createdAt: new Date().toISOString(),
  };
  rooms.set(id, room);
  save(room);
  return room;
}

function joinRoom(account, roomId, seat) {
  const room = getRoom(roomId);
  if (room.status !== 'waiting') throw new Error('游戏已经开始了，不能再入座');
  if (seatOf(room, account.id)) throw new Error(`你已经在 ${seatOf(room, account.id)}号 了`);
  const free = room.seats.filter(s => !s.accountId);
  if (!free.length) throw new Error('座位已经坐满了');
  const target = seat ? room.seats.find(s => s.seat === Number(seat)) : free[0];
  if (!target) throw new Error('没有这个座位');
  if (target.accountId) throw new Error(`${target.seat}号 已经有人了`);
  target.accountId = account.id;
  save(room); notify(room.id);
  return room;
}

function leaveRoom(account, roomId) {
  const room = getRoom(roomId);
  if (room.status !== 'waiting') throw new Error('游戏已经开始了，不能离座');
  const s = room.seats.find(x => x.accountId === account.id);
  if (!s) throw new Error('你不在这个房间的座位上');
  s.accountId = null;
  save(room); notify(room.id);
  return room;
}

function deleteRoom(account, roomId) {
  const room = getRoom(roomId);
  if (room.hostId !== account.id) throw new Error('只有房主能解散房间');
  if (room.status !== 'waiting') throw new Error('游戏开始后不能解散');
  rooms.delete(room.id);
  stmts.remove.run(room.id);
  notify(room.id);
}

function startGame(account, roomId) {
  const room = getRoom(roomId);
  if (room.hostId !== account.id) throw new Error('只有房主能开始游戏');
  if (room.status !== 'waiting') throw new Error('游戏已经开始了');
  if (room.seats.some(s => !s.accountId)) throw new Error(`还有空位：${room.seats.filter(s => !s.accountId).map(s => s.seat + '号').join('、')}`);
  const mod = moduleOf(room);
  room.status = 'playing';
  room.startedAt = new Date().toISOString();
  const ctx = context(room);
  room.state = mod.setup(room.seats.map(s => ({ seat: s.seat, name: seatName(room, s.seat) })), room.options, ctx);
  afterChange(room);
  return room;
}

function afterChange(room) {
  const mod = moduleOf(room);
  if (room.status === 'playing') {
    const result = mod.result(room.state);
    if (result) {
      room.status = 'finished';
      room.finishedAt = new Date().toISOString();
      room.result = result;
    }
  }
  save(room); notify(room.id);
}

function act(account, roomId, action) {
  const room = getRoom(roomId);
  if (room.status !== 'playing') throw new Error(room.status === 'waiting' ? '游戏还没开始' : '这局已经结束了');
  const seat = seatOf(room, account.id);
  if (!seat) throw new Error('你不在这一局的座位上');
  const out = moduleOf(room).act(room.state, seat, action || {}, context(room));
  if (out && out.error) throw new Error(out.error);
  afterChange(room);
  return out && out.message;
}

function chat(account, roomId, text) {
  const room = getRoom(roomId);
  const mod = moduleOf(room);
  if (!mod.allowChat) throw new Error(`${mod.name}没有聊天频道，请在轮到你时发言`);
  const seat = seatOf(room, account.id);
  if (!seat) throw new Error('入座之后才能聊天');
  text = String(text || '').trim();
  if (!text) throw new Error('说点什么吧');
  if (text.length > 500) throw new Error('一次最多 500 字');
  context(room).log({ kind: 'chat', seat, label: '聊天', text });
  notify(room.id);
}

// ---------- skipping ----------
function skipInfo(room, viewer) {
  if (room.status !== 'playing' || !viewer) return { canSkip: false };
  const p = moduleOf(room).pending(room.state);
  if (!p || !p.seats.length) return { canSkip: false };
  const elapsed = Date.now() - p.since;
  const isHost = room.hostId === viewer.id;
  const ownsAiHere = room.seats.some(s => accounts.byId(s.accountId)?.owner_id === viewer.id);
  // At night the button must not reveal which seats are acting, so it appears for anyone who could skip someone.
  const relevant = p.hidden
    ? isHost || ownsAiHere
    : p.seats.some(seat => isHost || accounts.byId(room.seats.find(s => s.seat === seat).accountId)?.owner_id === viewer.id);
  return { canSkip: relevant && elapsed >= SILENCE_MS, relevant, waitMs: Math.max(0, SILENCE_MS - elapsed) };
}

function skip(account, roomId) {
  const room = getRoom(roomId);
  if (room.status !== 'playing') throw new Error('现在没有可以跳过的人');
  const mod = moduleOf(room);
  const p = mod.pending(room.state);
  if (!p || !p.seats.length) throw new Error('现在没有可以跳过的人');
  if (Date.now() - p.since < SILENCE_MS) throw new Error('静默满 3 分钟后才能跳过');
  const isHost = room.hostId === account.id;
  const allowed = p.seats.filter(seat => isHost || accounts.byId(room.seats.find(s => s.seat === seat).accountId)?.owner_id === account.id);
  if (!allowed.length) {
    if (p.hidden) return '已处理';
    throw new Error('只能跳过自己名下的 AI；房主可以跳过所有人');
  }
  const ctx = context(room);
  const night = mod.phase(room.state).night;
  for (const seat of p.mode === 'turn' ? allowed.slice(0, 1) : allowed) {
    const name = seatName(room, seat);
    const by = isHost ? `，由房主 ${accounts.byId(account.id).name} 操作` : '';
    ctx.log({ kind: 'skip', seat, text: `${seat}号 ${name} 已被跳过${p.label}${by}`, visible: night ? 'archive' : 'public' });
    const out = mod.act(room.state, seat, mod.defaultAction(room.state, seat), ctx);
    if (out && out.error) throw new Error(`跳过失败：${out.error}`);
  }
  afterChange(room);
  return '已跳过';
}

// ---------- views ----------
function seatList(room, viewerSeat) {
  return room.seats.map(s => {
    const a = accounts.byId(s.accountId);
    return { seat: s.seat, account: a ? { id: a.id, name: a.name, kind: a.kind, avatar: a.avatar ? `/avatars/${a.avatar}` : null } : null, me: s.seat === viewerSeat };
  });
}

function phaseLabel(room) {
  if (room.status === 'waiting') return '等人中';
  if (room.status === 'finished') return '已结束';
  return moduleOf(room).phase(room.state).label;
}

function summary(room, viewer) {
  const mod = moduleOf(room);
  const mySeat = viewer ? seatOf(room, viewer.id) : null;
  return {
    id: room.id, game: room.game, gameName: mod.name, name: room.name, status: room.status,
    filled: room.seats.filter(s => s.accountId).length, total: room.seats.length,
    host: accounts.byId(room.hostId)?.name, mySeat, phase: phaseLabel(room),
    configLabel: mod.configLabel(room.options),
    result: room.result, createdAt: room.createdAt, startedAt: room.startedAt, finishedAt: room.finishedAt,
  };
}

function listRooms(viewer) {
  return [...rooms.values()].filter(r => r.status !== 'finished')
    .sort((a, b) => (b.startedAt || b.createdAt).localeCompare(a.startedAt || a.createdAt))
    .map(r => summary(r, viewer));
}

function listArchives(viewer, limit = 50) {
  return [...rooms.values()].filter(r => r.status === 'finished')
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, limit)
    .map(r => summary(r, viewer));
}

function view(room, viewer, sinceId = 0) {
  const mod = moduleOf(room);
  const seat = viewer ? seatOf(room, viewer.id) : null;
  const playing = room.status === 'playing';
  return {
    ...summary(room, viewer),
    isHost: !!viewer && room.hostId === viewer.id,
    seats: seatList(room, seat),
    phaseInfo: room.state ? mod.phase(room.state) : null,
    board: room.state ? mod.publicView(room.state, room.status === 'finished') : null,
    me: room.state && seat ? mod.seatView(room.state, seat) : null,
    actions: playing && seat ? mod.actions(room.state, seat) : [],
    pending: playing ? mod.publicPending(room.state) : null,
    skip: skipInfo(room, viewer),
    allowChat: !!mod.allowChat,
    events: eventsFor(room, seat, sinceId),
  };
}

// Plain-text state for MCP. Only events since this account last looked are repeated.
const lastSeen = new Map();
function textView(room, account) {
  const mod = moduleOf(room);
  const seat = seatOf(room, account.id);
  const key = `${room.id}:${account.id}`;
  const all = eventsFor(room, seat);
  const since = lastSeen.get(key);
  const fresh = since === undefined ? all.slice(-30) : all.filter(e => e.id > since);
  if (all.length) lastSeen.set(key, all[all.length - 1].id);

  const lines = [`【${room.name}】${mod.name} · ${mod.configLabel(room.options)} · 房间号 ${room.id}`];
  lines.push(`状态：${phaseLabel(room)}${seat ? ` · 你是 ${seat}号` : ' · 你没有入座'}`);
  lines.push('', '座位：');
  const board = room.state ? mod.publicView(room.state, room.status === 'finished') : null;
  for (const s of room.seats) {
    const a = accounts.byId(s.accountId);
    const extra = board && mod.seatNote ? mod.seatNote(board, s.seat) : '';
    lines.push(`  ${s.seat}号 ${a ? a.name + (a.kind === 'ai' ? '（AI）' : '（人类）') : '空位'}${s.seat === seat ? ' ← 你' : ''}${extra ? ' · ' + extra : ''}`);
  }
  if (room.state) {
    const extra = mod.textBoard ? mod.textBoard(room.state) : '';
    if (extra) lines.push('', extra);
    if (seat) lines.push('', mod.textPrivate(room.state, seat));
  }
  if (fresh.length) {
    lines.push('', since === undefined ? '最近发生：' : '上次查看之后：');
    for (const e of fresh) {
      const who = e.seat ? `${e.seat}号 ${seatName(room, e.seat)}` : '';
      const tag = e.private ? '（仅你可见）' : '';
      lines.push(e.kind === 'speech' || e.kind === 'chat' || e.kind === 'wolf'
        ? `  ${who}（${e.label || '发言'}）${tag}：${e.text}`
        : `  · ${e.text}${tag}`);
    }
  }
  if (room.status === 'waiting') {
    lines.push('', `等人中：${room.seats.filter(s => s.accountId).length}/${room.seats.length}。坐满后由房主 ${accounts.byId(room.hostId)?.name} 开始。`);
  } else if (room.status === 'playing' && seat) {
    const acts = mod.actions(room.state, seat);
    lines.push('', acts.length ? '你现在可以做（用 act 工具）：' : '现在不需要你操作。可以调用 wait_turn 等待轮到你。');
    for (const a of acts) lines.push(`  - action="${a.type}"：${a.label}${a.hint ? '（' + a.hint + '）' : ''}`);
  } else if (room.status === 'finished') {
    lines.push('', `已结束：${room.result.title}。完整复盘用 get_archive 查看，也可以留言。`);
  }
  lines.push('', `需要完整规则可调用 get_rules（game="${room.game}"）。`);
  return lines.join('\n');
}

function isMyTurn(room, account) {
  if (room.status !== 'playing') return true;
  const seat = seatOf(room, account.id);
  return !!seat && moduleOf(room).actions(room.state, seat).some(a => !a.passive);
}

// ---------- archives & comments ----------
function archive(room, viewer) {
  if (room.status !== 'finished') throw new Error('这局还没结束，结束后才有归档');
  const mod = moduleOf(room);
  const duration = Date.parse(room.finishedAt) - Date.parse(room.startedAt);
  return {
    ...summary(room, viewer), duration,
    seats: seatList(room, null),
    detail: mod.archive(room.state),
    events: eventsFor(room, null),
    comments: stmts.comments.all(room.id).map(c => {
      const a = accounts.byId(c.account_id);
      return { id: c.id, ts: c.ts, text: c.text, name: a?.name || '已删除', kind: a?.kind, avatar: a?.avatar ? `/avatars/${a.avatar}` : null, seat: seatOf(room, c.account_id) };
    }),
  };
}

function comment(account, roomId, text) {
  const room = getRoom(roomId);
  if (room.status !== 'finished') throw new Error('结束后才能留言');
  text = String(text || '').trim();
  if (!text) throw new Error('说点什么吧');
  if (text.length > 1000) throw new Error('一条留言最多 1000 字');
  stmts.insertComment.run(room.id, account.id, text, new Date().toISOString());
}

// What an account is doing right now, for the lobby and 「我的」.
function whereIs(accountId) {
  for (const r of rooms.values()) {
    if (r.status === 'finished') continue;
    const seat = seatOf(r, accountId);
    if (seat) return { roomId: r.id, roomName: r.name, seat, game: r.game, status: r.status, phase: phaseLabel(r) };
  }
  return null;
}

module.exports = {
  SILENCE_MS, getRoom, createRoom, joinRoom, leaveRoom, deleteRoom, startGame, act, chat, skip,
  listRooms, listArchives, view, textView, isMyTurn, waitForChange, archive, comment, whereIs, summary, seatOf,
};
