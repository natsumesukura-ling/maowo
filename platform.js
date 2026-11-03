const crypto = require('crypto');
const { db } = require('./db');
const accounts = require('./accounts');
const games = require('./games');

// ============================================================
// Platform layer: rooms, seats, visibility, skipping, archives, comments.
// Game modules only see seats and names; everything about accounts stays here.
// ============================================================
const SILENCE_MS = 3 * 60 * 1000;
const MIN = 60 * 1000;
// How long a silent player is waited for before they can be skipped, by how many times in a row
// they have been skipped already. The host (or the owner of that AI) waits less than everyone else.
// After two skips in a row the seat is 托管: the system acts for it right away.
const WAIT_HOST = [3 * MIN, 2 * MIN];
const WAIT_OTHERS = [5 * MIN, 3 * MIN];
const AWAY_AFTER = 2;
const END_VOTE_MS = 3 * MIN;

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

// Platform data that is not part of a game's state (the termination vote).
try { db.exec('ALTER TABLE rooms ADD COLUMN extra TEXT'); } catch { /* already there */ }

const stmts = {
  all: db.prepare('SELECT * FROM rooms'),
  upsert: db.prepare(`
    INSERT INTO rooms (id, game, name, host_id, status, seats, options, state, result, created_at, started_at, finished_at, extra)
    VALUES (@id, @game, @name, @host_id, @status, @seats, @options, @state, @result, @created_at, @started_at, @finished_at, @extra)
    ON CONFLICT(id) DO UPDATE SET name=@name, host_id=@host_id, status=@status, seats=@seats, options=@options,
      state=@state, result=@result, started_at=@started_at, finished_at=@finished_at, extra=@extra
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
    extra: row.extra ? JSON.parse(row.extra) : {},
  });
}

function save(room) {
  stmts.upsert.run({
    id: room.id, game: room.game, name: room.name, host_id: room.hostId, status: room.status,
    seats: JSON.stringify(room.seats), options: JSON.stringify(room.options),
    state: room.state ? JSON.stringify(room.state) : null, result: room.result ? JSON.stringify(room.result) : null,
    created_at: room.createdAt, started_at: room.startedAt || null, finished_at: room.finishedAt || null,
    extra: JSON.stringify(room.extra || {}),
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
  if (room.status === 'playing') actForAway(room);
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
  action = action || {};
  if (String(action.type || '').startsWith('room_')) return roomAction(room, seat, action.type);
  const s = seatEntry(room, seat);
  if (s.away) comeBack(room, seat);   // acting yourself means you are back
  s.skips = 0;                          // the skip count only counts skips in a row
  const out = moduleOf(room).act(room.state, seat, action, context(room));
  if (out && out.error) throw new Error(out.error);
  afterChange(room);
  return out && out.message;
}

function chat(account, roomId, text) {
  const room = getRoom(roomId);
  const mod = moduleOf(room);
  // Anyone seated can chat while the table waits; once a game starts, only games with a chat channel allow it.
  if (room.status === 'finished') throw new Error('这局已经结束了，可以去归档留言');
  if (room.status === 'playing' && !mod.allowChat) throw new Error(`${mod.name}没有聊天频道，请在轮到你时发言`);
  const seat = seatOf(room, account.id);
  if (!seat) throw new Error('入座之后才能聊天');
  text = String(text || '').trim();
  if (!text) throw new Error('说点什么吧');
  if (text.length > 500) throw new Error('一次最多 500 字');
  context(room).log({ kind: 'chat', seat, label: '聊天', text });
  notify(room.id);
}

// ---------- skipping ----------
const seatEntry = (room, seat) => room.seats.find(s => s.seat === seat);
const isAway = (room, seat) => !!seatEntry(room, seat)?.away;
// A two-player game ends when one side goes silent, instead of the system playing for them.
const twoPlayer = room => !!moduleOf(room).forfeit;

// Who may skip `seat`, and after how long. null = not allowed.
function skipWait(room, viewer, seat) {
  if (!viewer) return null;
  const target = accounts.byId(seatEntry(room, seat)?.accountId);
  const mySeat = seatOf(room, viewer.id);
  if (mySeat === seat) return null;
  const strong = room.hostId === viewer.id || (target && target.kind === 'ai' && target.owner_id === viewer.id);
  const ownsSeatedAi = room.seats.some(s => accounts.byId(s.accountId)?.owner_id === viewer.id);
  if (!strong && !mySeat && !ownsSeatedAi) return null; // spectators cannot skip
  if (twoPlayer(room)) return SILENCE_MS;
  const n = Math.min(seatEntry(room, seat).skips || 0, 1);
  return (strong ? WAIT_HOST : WAIT_OTHERS)[n];
}

function skipInfo(room, viewer) {
  if (room.status !== 'playing' || !viewer) return { canSkip: false };
  const p = moduleOf(room).pending(room.state);
  if (!p || !p.seats.length) return { canSkip: false };
  const elapsed = Date.now() - p.since;
  const waits = p.seats.map(seat => skipWait(room, viewer, seat)).filter(w => w !== null);
  if (!waits.length) return { canSkip: false, relevant: false };
  const need = Math.min(...waits);
  return { canSkip: elapsed >= need, relevant: true, waitMs: Math.max(0, need - elapsed), endsGame: twoPlayer(room) };
}

function skip(account, roomId) {
  const room = getRoom(roomId);
  if (room.status !== 'playing') throw new Error('现在没有可以跳过的人');
  const mod = moduleOf(room);
  const p = mod.pending(room.state);
  if (!p || !p.seats.length) throw new Error('现在没有可以跳过的人');
  const elapsed = Date.now() - p.since;
  const waits = p.seats.map(seat => ({ seat, wait: skipWait(room, account, seat) })).filter(x => x.wait !== null);
  if (!waits.length) {
    if (p.hidden) return '已处理';
    throw new Error('只有坐在这一局里的人才能跳过');
  }
  const ready = waits.filter(x => elapsed >= x.wait).map(x => x.seat);
  if (!ready.length) {
    const left = Math.min(...waits.map(x => x.wait)) - elapsed;
    throw new Error(`再等 ${Math.ceil(left / 60000)} 分钟才能跳过`);
  }
  const ctx = context(room);
  const night = mod.phase(room.state).night;
  const by = room.hostId === account.id ? `，由房主 ${accounts.byId(account.id).name} 操作` : `，由 ${accounts.byId(account.id).name} 操作`;
  if (twoPlayer(room)) {
    const seat = ready[0];
    ctx.log({ kind: 'skip', seat, text: `${seat}号 ${seatName(room, seat)} 掉线了，对局结束${by}` });
    mod.forfeit(room.state, seat, ctx);
    afterChange(room);
    return '对局已结束';
  }
  for (const seat of p.mode === 'turn' ? ready.slice(0, 1) : ready) {
    const s = seatEntry(room, seat);
    ctx.log({ kind: 'skip', seat, text: `${seat}号 ${seatName(room, seat)} 已被跳过${p.label}${by}`, visible: night ? 'archive' : 'public' });
    const out = mod.act(room.state, seat, mod.defaultAction(room.state, seat), ctx);
    if (out && out.error) throw new Error(`跳过失败：${out.error}`);
    s.skips = (s.skips || 0) + 1;
    if (s.skips >= AWAY_AFTER && !s.away) {
      s.away = 'auto';
      ctx.log({ kind: 'away', seat, text: `${seat}号 ${seatName(room, seat)} 连续没有回应，之后由系统托管（回来后点「我回来了」）` });
    }
  }
  afterChange(room);
  return '已跳过';
}

// Seats that are away get the default action as soon as it is their turn: nobody waits for them.
function actForAway(room) {
  const mod = moduleOf(room);
  if (twoPlayer(room)) return;
  const ctx = context(room);
  for (let guard = 0; guard < 500 && room.status === 'playing'; guard++) {
    if (mod.result(room.state)) return;
    const p = mod.pending(room.state);
    if (!p || !p.seats.length) return;
    const seats = (p.mode === 'turn' ? p.seats.slice(0, 1) : p.seats).filter(seat => isAway(room, seat));
    if (!seats.length) return;
    const night = mod.phase(room.state).night;
    for (const seat of seats) {
      ctx.log({ kind: 'skip', seat, text: `${seat}号 ${seatName(room, seat)} 托管中，自动跳过${p.label}`, visible: night ? 'archive' : 'public' });
      const out = mod.act(room.state, seat, mod.defaultAction(room.state, seat), ctx);
      if (out && out.error) return; // never loop on a broken default
    }
  }
}

function comeBack(room, seat) {
  const s = seatEntry(room, seat);
  s.away = null; s.skips = 0;
  context(room).log({ kind: 'away', seat, text: `${seat}号 ${seatName(room, seat)} 回来了` });
}

// ---------- room actions: leaving, coming back, ending the game together ----------
const endVote = room => room.extra && room.extra.endVote;
const dayKey = room => moduleOf(room).phase(room.state).day;
const voters = room => room.seats.filter(s => s.accountId && !s.away).map(s => s.seat);

// Actions every seat has besides the game's own. Passive ones do not wake AIs in wait_turn.
function roomActions(room, seat) {
  if (room.status !== 'playing' || !seat) return [];
  const mod = moduleOf(room);
  if (twoPlayer(room)) return [];
  const out = [];
  const me = seatEntry(room, seat);
  const v = endVote(room);
  if (v && !me.away && v.votes[seat] === undefined) {
    out.push({ type: 'room_end_yes', label: '同意终止对局（解散游戏）', danger: true, room: true });
    out.push({ type: 'room_end_no', label: '不同意，继续玩', room: true });
  }
  if (me.away) out.push({ type: 'room_back', label: '我回来了', passive: true, room: true });
  else {
    out.push({ type: 'room_leave', label: '我先走了（之后系统替你跳过，大家不用等你）', passive: true, danger: true, room: true });
    const someoneAway = room.seats.some(s => s.away);
    if (someoneAway && !v && (room.extra?.endFailedDay ?? null) !== dayKey(room)) {
      out.push({ type: 'room_end', label: '提议终止对局（终止即解散游戏，要还在的人过半同意）', passive: true, danger: true, room: true });
    }
  }
  return out;
}

function roomAction(room, seat, type) {
  if (!roomActions(room, seat).some(a => a.type === type)) throw new Error('现在不能这样做');
  const ctx = context(room);
  const name = `${seat}号 ${seatName(room, seat)}`;
  room.extra = room.extra || {};
  let message;
  if (type === 'room_leave') {
    const s = seatEntry(room, seat); s.away = 'left';
    ctx.log({ kind: 'away', seat, text: `${name} 先走了，之后由系统托管` });
    message = '已离开，系统会替你跳过。回来后点「我回来了」';
  } else if (type === 'room_back') {
    comeBack(room, seat); message = '欢迎回来';
  } else if (type === 'room_end') {
    room.extra.endVote = { by: seat, since: Date.now(), day: dayKey(room), votes: { [seat]: true } };
    const n = voters(room).length;
    ctx.log({ kind: 'endvote', seat, text: `${name} 提议终止对局（终止即解散游戏）。还在的 ${n} 人里要有 ${Math.floor(n / 2) + 1} 人同意，3 分钟内没表态算不同意` });
    message = '已发起，等大家表态';
  } else {
    endVote(room).votes[seat] = type === 'room_end_yes';
    ctx.log({ kind: 'endvote', seat, text: `${name} ${type === 'room_end_yes' ? '同意' : '不同意'}终止对局` });
    message = '已表态';
  }
  settleEndVote(room);
  afterChange(room);
  return message;
}

// Decides the termination vote once the outcome is certain, or when time is up.
function settleEndVote(room) {
  const v = endVote(room);
  if (!v || room.status !== 'playing') return false;
  const eligible = voters(room);
  const yes = eligible.filter(s => v.votes[s] === true).length;
  const no = eligible.filter(s => v.votes[s] === false).length;
  const need = Math.floor(eligible.length / 2) + 1;
  const timeUp = Date.now() - v.since >= END_VOTE_MS;
  const ctx = context(room);
  if (yes >= need) {
    room.extra.endVote = null;
    ctx.log({ kind: 'endvote', text: `${yes} 人同意，对局终止，游戏解散。不算输赢` });
    room.status = 'finished';
    room.finishedAt = new Date().toISOString();
    room.result = { title: '对局中止', winner: null, reason: '有人掉线，大家同意终止', aborted: true };
    return true;
  }
  if (eligible.length - no < need || timeUp) {
    room.extra.endVote = null;
    room.extra.endFailedDay = v.day;
    ctx.log({ kind: 'endvote', text: `终止对局没有通过（同意 ${yes} 人，需要 ${need} 人），继续游戏。今天不能再提议` });
    return true;
  }
  return false;
}
// Votes left open run out on their own.
setInterval(() => {
  for (const room of rooms.values()) if (endVote(room) && settleEndVote(room)) { save(room); notify(room.id); }
}, 10000).unref();

function endVoteInfo(room, seat) {
  const v = endVote(room);
  if (!v || room.status !== 'playing') return null;
  const eligible = voters(room);
  return {
    by: v.by, need: Math.floor(eligible.length / 2) + 1, total: eligible.length,
    yes: eligible.filter(s => v.votes[s] === true).length, no: eligible.filter(s => v.votes[s] === false).length,
    mine: seat ? v.votes[seat] ?? null : null, leftMs: Math.max(0, END_VOTE_MS - (Date.now() - v.since)),
  };
}

const allActions = (room, seat) => {
  if (room.status !== 'playing' || !seat) return [];
  const game = isAway(room, seat) ? [] : moduleOf(room).actions(room.state, seat);
  return [...game, ...roomActions(room, seat)];
};

function seatList(room, viewerSeat) {
  return room.seats.map(s => {
    const a = accounts.byId(s.accountId);
    return { seat: s.seat, account: a ? { id: a.id, name: a.name, kind: a.kind, avatar: a.avatar ? `/avatars/${a.avatar}` : null } : null, me: s.seat === viewerSeat, away: s.away || null };
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
    actions: allActions(room, seat),
    endVote: endVoteInfo(room, seat),
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
    const extra = [board && mod.seatNote ? mod.seatNote(board, s.seat) : '', s.away === 'left' ? '已离开' : s.away ? '托管中' : ''].filter(Boolean).join(' · ');
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
      lines.push((e.kind === 'speech' || e.kind === 'chat' || e.kind === 'wolf') && e.seat
        ? `  ${who}（${e.label || '发言'}）${tag}：${e.text}`
        : `  · ${e.text}${tag}`);
    }
  }
  if (room.status === 'waiting') {
    lines.push('', `等人中：${room.seats.filter(s => s.accountId).length}/${room.seats.length}。坐满后由房主 ${accounts.byId(room.hostId)?.name} 开始。`);
  } else if (room.status === 'playing' && seat) {
    const ev = endVoteInfo(room, seat);
    if (ev) lines.push('', `有人提议终止对局：同意 ${ev.yes} / 需要 ${ev.need}（还在的 ${ev.total} 人），不同意 ${ev.no}，还剩 ${Math.ceil(ev.leftMs / 1000)} 秒。`);
    if (isAway(room, seat)) lines.push('', '你现在是托管状态，系统会替你跳过。想继续玩就用 act，action="room_back"。');
    const acts = allActions(room, seat);
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
  return !!seat && allActions(room, seat).some(a => !a.passive);
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
  SILENCE_MS, WAIT_HOST, WAIT_OTHERS, getRoom, createRoom, joinRoom, leaveRoom, deleteRoom, startGame, act, chat, skip,
  listRooms, listArchives, view, textView, isMyTurn, waitForChange, archive, comment, whereIs, summary, seatOf,
};
