// Players who go silent or leave mid-game: skip waits, 托管, coming back, ending the game together,
// and two-player games ending instead of the system playing for someone.
//   node test/away.js
const os = require('os');
const fs = require('fs');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maowo-away-'));
process.env.DB_PATH = path.join(dir, 'games.db');

const assert = require('assert');
const accounts = require('../accounts');
const platform = require('../platform');
const { db } = require('../db');

const owner = accounts.ownerAccount();
const friend = accounts.create('human', '朋友');
const ais = Array.from({ length: 12 }, (_, i) => accounts.create('ai', `bot${i + 1}`, owner.id));
const MIN = 60 * 1000;
const pick = a => a[Math.floor(Math.random() * a.length)];
const ok = name => console.log('ok', name);

const V = 'villager', W = 'wolf';
const ROLES9 = [V, 'seer', 'witch', 'hunter', V, V, W, W, W];

function newGame(seats, roles) {
  const room = platform.createRoom(seats[0], { game: roles ? 'werewolf' : 'gomoku', options: roles ? { players: seats.length } : {} });
  for (let i = 1; i < seats.length; i++) platform.joinRoom(seats[i], room.id);
  platform.startGame(seats[0], room.id);
  if (roles) platform.getRoom(room.id).state.players.forEach((p, i) => { p.role = roles[i]; });
  return room.id;
}
const room = id => platform.getRoom(id);
const kind = id => room(id).state.step?.kind;
const pending = id => (room(id).state && require('../games').get(room(id).game).pending(room(id).state)) || null;
const seatOfPending = id => pending(id)?.seats || [];
const lastLines = (id, k) => db.prepare('SELECT text FROM room_events WHERE room_id = ? ORDER BY id DESC LIMIT ?').all(id, k).map(r => r.text);
// Pretend `ms` of silence has passed in the current step.
function silence(id, ms) { const p = pending(id); const st = room(id).state; if (st.step) st.step.since = Date.now() - ms; if (st.since) st.since = Date.now() - ms; return p; }
const trySkip = (id, who) => { try { return platform.skip(who, id); } catch (e) { return 'ERR ' + e.message; } };

// Everyone except `silent` takes one action; `policy` can choose it.
function stepOnce(id, silent, policy) {
  const r = room(id);
  for (const s of r.seats) {
    if (silent.includes(s.seat)) continue;
    const acct = accounts.byId(s.accountId);
    const v = platform.view(r, acct);
    const req = v.actions.filter(a => !a.passive && !a.room);
    if (!req.length) continue;
    let action = policy && policy(v, s.seat, req);
    if (!action) {
      const a = req.find(x => ['pass', 'abstain', 'not_run', 'confirm', 'no_shoot', 'witch_pass', 'check_none', 'guard_none', 'kill_none', 'clockwise', 'destroy_badge'].includes(x.type)) || req[0];
      action = { type: a.type, target: a.targets ? a.targets[0] : undefined, text: a.text ? '…' : undefined };
    }
    platform.act(acct, id, action);
    return true;
  }
  return false;
}
function runUntil(id, silent, pred, policy) {
  for (let i = 0; i < 600; i++) {
    if (room(id).status === 'finished' || pred()) return true;
    if (!stepOnce(id, silent, policy)) return false;
  }
  throw new Error('runUntil: too many steps');
}
const randomPolicy = (v, seat, req) => { const a = pick(req); return { type: a.type, target: a.targets ? pick(a.targets) : undefined, text: a.text ? '…' : undefined }; };
const noSheriffNoKill = (v, seat, req) => req.find(a => a.type === 'not_run') ? { type: 'not_run' } : req.find(a => a.type === 'kill_none') ? { type: 'kill_none' } : null;
const voteFor = target => (v, seat, req) => (req.some(a => a.type === 'vote') && seat !== target ? { type: 'vote', target } : null);

// ---------- A: everyone votes 1号, who goes silent before the result ----------
{
  const id = newGame(ais.slice(0, 9), ROLES9);
  runUntil(id, [], () => kind(id) === 'day_vote', noSheriffNoKill);
  runUntil(id, [1], () => false, voteFor(1));
  assert.deepStrictEqual(seatOfPending(id), [1]);
  // The host here is bot1 itself, so the owner of the AIs (strong) skips.
  silence(id, 2.9 * MIN);
  assert.match(trySkip(id, owner), /再等/, 'no skip before 3 minutes');
  silence(id, 3 * MIN);
  assert.strictEqual(trySkip(id, owner), '已跳过');
  assert(lastLines(id, 3).some(t => /1号 bot1 以 8 票被放逐/.test(t)), 'exiled with 8 votes');
  assert.strictEqual(kind(id), 'death');
  silence(id, 1.9 * MIN);
  assert.match(trySkip(id, owner), /再等/, 'second skip waits 2 minutes');
  silence(id, 2 * MIN);
  assert.strictEqual(trySkip(id, owner), '已跳过');
  assert.strictEqual(room(id).seats[0].away, 'auto', 'two skips in a row: 托管');
  // Last words were skipped; nobody but a hunter has anything left to do once out.
  assert.notStrictEqual(kind(id), 'death');
  ok('A 全场归票 1号，1号投票前掉线：3 分钟、2 分钟后跳过，之后系统托管');
}

// ---------- B: 1号 is exiled, then goes silent: only the last words are lost ----------
{
  const id = newGame(ais.slice(0, 9), ROLES9);
  runUntil(id, [], () => kind(id) === 'day_vote', noSheriffNoKill);
  runUntil(id, [], () => kind(id) === 'death', voteFor(1));
  silence(id, 3 * MIN); assert.strictEqual(trySkip(id, owner), '已跳过'); // last words
  assert.notStrictEqual(kind(id), 'death', 'no 确认出局 after last words');
  for (let i = 0; i < 3000 && room(id).status !== 'finished'; i++) if (!stepOnce(id, [1], randomPolicy)) throw new Error('stuck');
  assert.strictEqual(room(id).status, 'finished');
  ok('B 放逐后才掉线：跳过遗言，游戏照常打完');
}

// ---------- C: who may skip, and how long they wait ----------
{
  const seats = [friend, owner, ...ais.slice(0, 7)];
  const id = newGame(seats, ROLES9);
  runUntil(id, [], () => kind(id) === 'day_vote', noSheriffNoKill);
  runUntil(id, [1], () => false, voteFor(1)); // the host (a friend, 1号) is the silent one
  const stranger = accounts.create('human', '路人');
  silence(id, 10 * MIN);
  assert.match(trySkip(id, stranger), /只有坐在这一局里的人/, 'spectators cannot skip');
  silence(id, 4.9 * MIN);
  assert.match(trySkip(id, owner), /再等/, 'others wait 5 minutes the first time');
  silence(id, 5 * MIN);
  assert.strictEqual(trySkip(id, owner), '已跳过', 'another player can skip the silent host');
  silence(id, 2.9 * MIN);
  assert.match(trySkip(id, owner), /再等/, 'others wait 3 minutes the second time');
  silence(id, 3 * MIN);
  assert.strictEqual(trySkip(id, owner), '已跳过');
  assert.strictEqual(room(id).seats[0].away, 'auto');
  ok('C 房主掉线：其他人 5 分钟、3 分钟后能跳过他；旁观的人不能跳过');
}

// ---------- H: 「小绫特权」: nobody skips the owner ----------
{
  assert.strictEqual(platform.OWNER_NEVER_SKIPPED, true);
  const seats = [friend, owner, ...ais.slice(0, 7)];
  const id = newGame(seats, ROLES9);
  runUntil(id, [], () => kind(id) === 'day_vote', noSheriffNoKill);
  runUntil(id, [2], () => false, voteFor(2)); // the owner (2号) takes her time
  assert.deepStrictEqual(seatOfPending(id), [2]);
  silence(id, 60 * MIN);
  for (const who of [friend, ais[0]]) assert.match(trySkip(id, who), /小绫特权/);
  assert.strictEqual(room(id).seats[1].skips || 0, 0);
  assert(!room(id).seats[1].away);
  // Gomoku: the AI cannot end the game on her either.
  const g = newGame([ais[0], owner]);
  platform.act(ais[0], g, { type: 'move', row: 7, col: 7 });
  silence(g, 60 * MIN);
  assert.match(trySkip(g, ais[0]), /小绫特权/);
  assert.strictEqual(room(g).status, 'playing');
  ok('H 小绫特权：谁都不能跳过主人（狼人杀、五子棋都一样）');
}

// ---------- D: coming back, and leaving on purpose ----------
{
  const id = newGame(ais.slice(0, 9), ROLES9);
  const r = room(id);
  platform.act(ais[4], id, { type: 'room_leave' });
  assert.strictEqual(r.seats[4].away, 'left');
  runUntil(id, [5], () => kind(id) === 'day_speech' || kind(id) === 'day_vote', noSheriffNoKill);
  assert(!seatOfPending(id).includes(5), 'a seat that left is never waited for');
  const v = platform.view(room(id), ais[4]);
  assert(v.actions.some(a => a.type === 'room_back') && !v.actions.some(a => !a.room), 'away seat only sees 「我回来了」');
  platform.act(ais[4], id, { type: 'room_back' });
  assert.strictEqual(room(id).seats[4].away, null);
  assert.strictEqual(room(id).seats[4].skips, 0);
  ok('D 「我先走了」立刻托管，「我回来了」取消托管');
}

// ---------- E: ending the game together ----------
{
  const id = newGame(ais.slice(0, 9), ROLES9);
  const actionsOf = seat => platform.view(room(id), ais[seat - 1]).actions.map(a => a.type);
  assert(!actionsOf(2).includes('room_end'), 'no 终止 while everyone is here');
  platform.act(ais[0], id, { type: 'room_leave' });
  platform.act(ais[1], id, { type: 'room_leave' });
  assert(actionsOf(3).includes('room_end'), '终止 appears once someone is away');
  assert(!actionsOf(1).includes('room_end'), 'someone away cannot propose');
  platform.act(ais[2], id, { type: 'room_end' }); // 7 still here, need 4
  platform.act(ais[3], id, { type: 'room_end_yes' });
  platform.act(ais[4], id, { type: 'room_end_no' });
  platform.act(ais[5], id, { type: 'room_end_no' });
  platform.act(ais[6], id, { type: 'room_end_no' });
  platform.act(ais[7], id, { type: 'room_end_no' }); // 4 against: can no longer pass
  assert.strictEqual(room(id).status, 'playing');
  assert(!actionsOf(3).includes('room_end'), 'failed today: no new proposal the same day');
  // A new day allows another try; time running out counts as a no.
  room(id).extra.endFailedDay = -1;
  platform.act(ais[2], id, { type: 'room_end' });
  room(id).extra.endVote.since -= 3 * MIN;
  platform.act(ais[3], id, { type: 'room_end_yes' }); // too late: settles as failed
  assert.strictEqual(room(id).status, 'playing');
  room(id).extra.endFailedDay = -1;
  platform.act(ais[2], id, { type: 'room_end' });
  for (const s of [4, 5, 6]) platform.act(ais[s - 1], id, { type: 'room_end_yes' });
  assert.strictEqual(room(id).status, 'finished');
  assert.strictEqual(room(id).result.aborted, true);
  assert.strictEqual(room(id).result.title, '对局中止');
  platform.archive(room(id), owner);
  ok('E 终止对局：有人离开才出现、过半同意才解散、超时算不同意、没通过当天不能再提');
}

// ---------- F: someone silent for the whole game ----------
{
  const counts = [];
  for (let g = 0; g < 20; g++) {
    const id = newGame(ais.slice(0, 9), ROLES9);
    let skips = 0;
    for (let i = 0; i < 5000 && room(id).status !== 'finished'; i++) {
      if (!stepOnce(id, [1], randomPolicy)) { silence(id, 3 * MIN); assert.strictEqual(trySkip(id, owner), '已跳过'); skips++; }
    }
    assert.strictEqual(room(id).status, 'finished');
    counts.push(skips);
  }
  assert(Math.max(...counts) <= 2, `a silent player needs at most 2 manual skips, got ${counts}`);
  ok(`F 一直掉线的人：每局最多手动跳过 2 次（${counts.join(',')}）`);
}

// ---------- G: gomoku: resign, and a silent opponent ends the game ----------
{
  let id = newGame([ais[0], ais[1]]);
  platform.act(ais[0], id, { type: 'move', row: 7, col: 7 });
  platform.act(ais[0], id, { type: 'resign' });
  assert.strictEqual(room(id).status, 'finished');
  assert.strictEqual(room(id).result.winner, 2);

  id = newGame([owner, ais[1]]);
  platform.act(owner, id, { type: 'move', row: 7, col: 7 });
  silence(id, 2.9 * MIN);
  assert.match(trySkip(id, owner), /再等/);
  silence(id, 3 * MIN);
  assert.strictEqual(trySkip(id, owner), '对局已结束');
  assert.strictEqual(room(id).result.winner, 1);
  assert.match(room(id).result.reason, /掉线/);
  assert(!platform.view(room(id), owner).actions.length);
  ok('G 五子棋：认输对方赢；对方 3 分钟不动可以结束，掉线判负，系统不代下');
}

// ---------- H. playing only with your own AIs: end it yourself, even after leaving ----------
{
  const has = (id, who) => platform.view(room(id), who).actions.some(a => a.type === 'room_end_now');
  const r1 = platform.createRoom(owner, { game: 'uno', options: { players: 2 } });
  platform.joinRoom(ais[0], r1.id);
  platform.startGame(owner, r1.id);
  assert(has(r1.id, owner), 'owner with only her AIs can end it');
  assert(!has(r1.id, ais[0]), 'the AI cannot');
  platform.act(owner, r1.id, { type: 'room_leave' });
  assert(has(r1.id, owner), 'still there after 我先走了');
  platform.act(owner, r1.id, { type: 'room_end_now' });
  assert.strictEqual(room(r1.id).status, 'finished');
  assert(room(r1.id).result.aborted);
  // a friend at the table: no shortcut, the usual vote
  const r2 = platform.createRoom(owner, { game: 'uno', options: { players: 3 } });
  platform.joinRoom(ais[1], r2.id); platform.joinRoom(friend, r2.id);
  platform.startGame(owner, r2.id);
  assert(!has(r2.id, owner) && !has(r2.id, friend));
  // gomoku with her own AI: there too (besides 认输)
  const g = newGame([owner, ais[2]]);
  assert(has(g, owner));
  ok('H 桌上只有自家的 AI：主人可以直接结束对局（离开后也行），有别人在就不行');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('all away checks passed');
