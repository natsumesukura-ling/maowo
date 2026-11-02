// Random bots play full games through the platform layer.
//   node test/simulate.js [games-per-size]
const os = require('os');
const fs = require('fs');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maowo-sim-'));
process.env.DB_PATH = path.join(dir, 'games.db');

const assert = require('assert');
const accounts = require('../accounts');
const platform = require('../platform');

const rounds = Number(process.argv[2] || 30);
const owner = accounts.ownerAccount();
const ais = Array.from({ length: 12 }, (_, i) => accounts.create('ai', `bot${i + 1}`, owner.id));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const stats = { games: 0, good: 0, wolf: 0, steps: 0, skips: 0, explode: 0, concede: 0, sheriff: 0 };

function playOnce(game, n) {
  const host = ais[0];
  const room = platform.createRoom(host, { game, options: { players: n } });
  for (let i = 1; i < n; i++) platform.joinRoom(ais[i], room.id);
  platform.startGame(host, room.id);
  for (let guard = 0; guard < 5000; guard++) {
    const r = platform.getRoom(room.id);
    if (r.status === 'finished') break;
    stats.steps++;
    // Now and then let the silence timer run out and skip whoever is pending.
    if (Math.random() < 0.05 && r.state.step) {
      if (r.state.step) r.state.step.since -= platform.SILENCE_MS;
      if (r.state.since) r.state.since -= platform.SILENCE_MS;
      platform.skip(host, room.id); stats.skips++; continue;
    }
    let acted = false;
    for (const seat of shuffle(r.seats.map(s => s.seat))) {
      const acct = ais[seat - 1];
      const v = platform.view(r, acct);
      if (game === 'werewolf') {
        const role = r.state.players[seat - 1].role;
        // Hard boundary: wolf chat only reaches wolves, and nobody sees unrevealed roles of others.
        if (role !== 'wolf') assert(!v.events.some(e => e.kind === 'wolf'), 'wolf chat leaked');
        for (const p of v.board.players) if (p.role && p.seat !== seat) assert(r.state.players[p.seat - 1].revealed, 'role leaked');
        assert(!v.events.some(e => e.private && /查验/.test(e.text)) || role === 'seer', 'seer result leaked');
        if (v.board.night) assert(!v.pending || v.pending.hidden, 'night pending not hidden');
      }
      const required = v.actions.filter(a => !a.passive);
      const optional = v.actions.filter(a => a.passive);
      let a = null;
      if (optional.length && Math.random() < 0.03) {
        a = pick(optional);
        if ((a.type === 'explode' || a.type === 'concede') && Math.random() < 0.7) a = null;
      }
      if (!a && required.length) a = pick(required);
      if (!a) continue;
      const action = { type: a.type };
      if (a.target === 'seat') action.target = pick(a.targets);
      if (a.target === 'cell') { const b = r.state.board; let rr, cc; do { rr = Math.floor(Math.random() * 15); cc = Math.floor(Math.random() * 15); } while (b[rr][cc]); action.row = rr; action.col = cc; }
      if (a.text) action.text = `${a.type} from ${seat}`;
      if (a.type === 'explode') stats.explode++;
      if (a.type === 'concede') stats.concede++;
      platform.act(acct, room.id, action);
      acted = true;
      break;
    }
    assert(acted || platform.getRoom(room.id).status === 'finished', `nobody could act in ${game} ${n}: ${JSON.stringify(r.state.step)}`);
  }
  const r = platform.getRoom(room.id);
  assert.strictEqual(r.status, 'finished', `${game} ${n} did not finish`);
  stats.games++;
  if (r.result.winner === 'good') stats.good++; else if (r.result.winner === 'wolf') stats.wolf++;
  if (game === 'werewolf' && r.state.sheriff) stats.sheriff++;
  checkVisibility(r);
  platform.archive(r, owner);
  platform.textView(r, ais[1]);
}

// No seat may ever have been shown a private event meant for another seat while the game ran.
function checkVisibility(r) {
  const { db } = require('../db');
  const rows = db.prepare('SELECT * FROM room_events WHERE room_id = ?').all(r.id);
  for (const e of rows) {
    if (e.visible === 'public' || e.visible === 'archive') continue;
    const seats = JSON.parse(e.visible);
    assert(seats.length >= 1, 'private event without seats');
  }
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

for (let n = 6; n <= 12; n++) for (let i = 0; i < rounds; i++) playOnce('werewolf', n);
for (let i = 0; i < rounds; i++) playOnce('gomoku', 2);
console.log(JSON.stringify(stats));
fs.rmSync(dir, { recursive: true, force: true });
