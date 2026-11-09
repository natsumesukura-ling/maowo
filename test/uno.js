// UNO rules: legal plays, action cards, +4 challenge, UNO calls, and many random games that must end.
//   node test/uno.js
const assert = require('assert');
const uno = require('../games/uno');

let seed = 1;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
const mkctx = () => { const log = []; return { log: e => log.push(e), lines: log, now: () => 0, random: n => rand() % n }; };
const players = n => Array.from({ length: n }, (_, i) => ({ seat: i + 1, name: `P${i + 1}` }));
const card = (color, value, id) => ({ id: id || `${color}-${value}-${Math.random()}`, color, value });
function fixed(n, hands, topCard, opts = {}) {
  const ctx = mkctx();
  const s = uno.setup(players(n), { players: n }, ctx);
  s.hands = hands; s.discard = [topCard]; s.color = topCard.color || opts.color; s.turn = 1; s.dir = 1; s.stage = 'play'; s.uno = null;
  s.deck = Array.from({ length: 40 }, (_, i) => card('yellow', String(i % 9 + 1), `d${i}`));
  return { s, ctx };
}
const ok = m => console.log('ok ' + m);
const act = (s, seat, a, ctx) => uno.act(s, seat, a, ctx);

// matching by colour or number, wrong card refused, names work
{
  const { s, ctx } = fixed(3, { 1: [card('red', '5', 'a'), card('blue', '7', 'b'), card('green', '5', 'c')], 2: [card('red', '1')], 3: [card('red', '2')] }, card('red', '9'));
  assert.match(act(s, 1, { type: 'play', card: '蓝7' }, ctx).error, /接不上/);
  assert(!act(s, 1, { type: 'play', card: '红5' }, ctx).error);
  assert.strictEqual(s.turn, 2);
  assert.strictEqual(s.uno, null);
  assert(!act(s, 2, { type: 'draw' }, ctx).error);
  ok('colour or number; names like 红5');
}
// skip, reverse, draw2
{
  const { s, ctx } = fixed(4, { 1: [card('red', 'skip', 'a'), card('red', '1')], 2: [card('red', '2')], 3: [card('red', 'reverse', 'r'), card('red', '3')], 4: [card('red', '4')] }, card('red', '9'));
  act(s, 1, { type: 'play', card: 'a' }, ctx);
  assert.strictEqual(s.turn, 3, 'skip jumps 2');
  act(s, 3, { type: 'play', card: 'r', uno: true }, ctx);
  assert.strictEqual(s.dir, -1); assert.strictEqual(s.turn, 2, 'reverse goes back');
  const { s: t, ctx: c2 } = fixed(3, { 1: [card('red', 'draw2', 'd'), card('red', '1')], 2: [card('red', '2')], 3: [card('red', '3')] }, card('red', '9'));
  act(t, 1, { type: 'play', card: '红+2', uno: true }, c2);
  assert.strictEqual(t.hands[2].length, 3); assert.strictEqual(t.turn, 3);
  const { s: u, ctx: c3 } = fixed(2, { 1: [card('red', 'reverse', 'r'), card('red', '1'), card('red', '2')], 2: [card('red', '2')] }, card('red', '9'));
  act(u, 1, { type: 'play', card: 'r' }, c3);
  assert.strictEqual(u.turn, 1, 'two players: reverse is a skip');
  ok('skip, reverse (2p = skip), +2');
}
// wild needs a colour; +4 challenge both ways
{
  const { s, ctx } = fixed(3, { 1: [card(null, 'wild', 'w'), card('red', '1')], 2: [card('blue', '2')], 3: [card('red', '3')] }, card('red', '9'));
  assert.match(act(s, 1, { type: 'play', card: '变色' }, ctx).error, /color/);
  act(s, 1, { type: 'play', card: '变色', color: '蓝', uno: true }, ctx);
  assert.strictEqual(s.color, 'blue');
  const guilty = fixed(3, { 1: [card(null, 'wild4', 'f'), card('red', '1'), card('blue', '1')], 2: [card('blue', '2')], 3: [card('red', '3')] }, card('red', '9'));
  act(guilty.s, 1, { type: 'play', card: '+4', color: '绿' }, guilty.ctx);
  assert.strictEqual(guilty.s.stage, 'challenge'); assert.strictEqual(guilty.s.turn, 2);
  assert.deepStrictEqual(uno.actions(guilty.s, 2).map(a => a.type), ['accept_draw_four', 'challenge_draw_four']);
  act(guilty.s, 2, { type: 'challenge_draw_four' }, guilty.ctx);
  assert.strictEqual(guilty.s.hands[1].length, 6, 'guilty: the player of +4 draws 4');
  assert.strictEqual(guilty.s.turn, 2, 'challenger plays on');
  const fair = fixed(3, { 1: [card(null, 'wild4', 'f'), card('blue', '1'), card('blue', '2')], 2: [card('blue', '2')], 3: [card('red', '3')] }, card('red', '9'));
  act(fair.s, 1, { type: 'play', card: 'f', color: 'green' }, fair.ctx);
  act(fair.s, 2, { type: 'challenge_draw_four' }, fair.ctx);
  assert.strictEqual(fair.s.hands[2].length, 7, 'wrong challenge: 6 cards'); assert.strictEqual(fair.s.turn, 3);
  const acc = fixed(3, { 1: [card(null, 'wild4', 'f'), card('blue', '1'), card('blue', '2')], 2: [card('blue', '2')], 3: [card('red', '3')] }, card('red', '9'));
  act(acc.s, 1, { type: 'play', card: 'f', color: 'green' }, acc.ctx);
  act(acc.s, 2, { type: 'accept_draw_four' }, acc.ctx);
  assert.strictEqual(acc.s.hands[2].length, 5); assert.strictEqual(acc.s.turn, 3);
  ok('wild colour; +4 accept, challenge right and wrong');
}
// drawing: playable drawn card may be played or kept; only that one
{
  const { s, ctx } = fixed(3, { 1: [card('blue', '1', 'x')], 2: [card('red', '2')], 3: [card('red', '3')] }, card('yellow', '9'));
  s.deck.push(card('yellow', '4', 'y4'));
  act(s, 1, { type: 'draw' }, ctx);
  assert.strictEqual(s.stage, 'drawn');
  assert.match(act(s, 1, { type: 'play', card: 'x' }, ctx).error, /刚摸到/);
  assert.match(act(s, 1, { type: 'draw' }, ctx).error, /已经摸过/);
  act(s, 1, { type: 'keep_drawn' }, ctx);
  assert.strictEqual(s.turn, 2);
  assert(ctx.lines.some(l => Array.isArray(l.visible) && l.visible[0] === 1 && /摸到了 黄4/.test(l.text)), 'only the drawer sees the card');
  ok('draw: play it or keep it');
}
// UNO: forgetting can be caught until the next player moves; calling late is fine
{
  const { s, ctx } = fixed(3, { 1: [card('red', '1', 'a'), card('red', '2')], 2: [card('red', '3'), card('blue', '3')], 3: [card('red', '4'), card('green', '1')] }, card('red', '9'));
  act(s, 1, { type: 'play', card: 'a' }, ctx);
  assert.strictEqual(s.uno, 1);
  assert(uno.actions(s, 3).some(a => a.type === 'catch_uno'));
  act(s, 3, { type: 'catch_uno', target: 1 }, ctx);
  assert.strictEqual(s.hands[1].length, 3);
  const b = fixed(3, { 1: [card('red', '1', 'a'), card('red', '2')], 2: [card('red', '3'), card('blue', '3')], 3: [card('red', '4')] }, card('red', '9'));
  act(b.s, 1, { type: 'play', card: 'a' }, b.ctx);
  act(b.s, 2, { type: 'play', card: '红3', uno: true }, b.ctx);
  assert.strictEqual(b.s.uno, null, 'the next move closes the window');
  assert.match(act(b.s, 3, { type: 'catch_uno', target: 1 }, b.ctx).error, /没有/);
  const c = fixed(3, { 1: [card('red', '1', 'a'), card('red', '2')], 2: [card('red', '3')], 3: [card('red', '4')] }, card('red', '9'));
  act(c.s, 1, { type: 'play', card: 'a' }, c.ctx);
  act(c.s, 1, { type: 'call_uno' }, c.ctx);
  assert.strictEqual(c.s.uno, null);
  ok('UNO: caught before the next move, or called late');
}
// winning, and random full games always end
{
  const { s, ctx } = fixed(2, { 1: [card('red', '1', 'a')], 2: [card('red', '3')] }, card('red', '9'));
  act(s, 1, { type: 'play', card: 'a' }, ctx);
  assert.strictEqual(uno.result(s).winner, 1);
  let games = 0, total = 0;
  for (let g = 0; g < 300; g++) {
    const n = 2 + (g % 5);
    const c = mkctx();
    const st = uno.setup(players(n), { players: n }, c);
    for (let step = 0; step < 5000 && !uno.result(st); step++) {
      const seat = st.turn;
      const acts = uno.actions(st, seat).filter(a => !a.passive);
      const a = acts[rand() % acts.length];
      const body = { type: a.type };
      if (a.type === 'play') { body.card = a.cards[rand() % a.cards.length]; body.color = ['red', 'yellow', 'green', 'blue'][rand() % 4]; body.uno = rand() % 2 === 0; }
      const out = uno.act(st, seat, body, c);
      assert(!out.error, `${out.error} ${JSON.stringify(body)}`);
      const count = Object.values(st.hands).reduce((k, h) => k + h.length, 0) + st.deck.length + st.discard.length;
      assert.strictEqual(count, 108, 'no card lost');
      total++;
    }
    if (uno.result(st)) games++;
  }
  assert(games >= 290, `${games}/300 random games ended`);
  ok(`random games end (${games}/300, ${total} moves), no card lost`);
}
console.log('all uno checks passed');
