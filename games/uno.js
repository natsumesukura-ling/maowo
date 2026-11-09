// UNO：2-6 人，一局定胜负，先出完手牌的人赢。规则照 Galatea Garden（花园）的 UNO：
// 摸到能出的牌可以马上出或留着；+4 可以被下家质疑；剩一张要喊 UNO，没喊被抓到罚摸 2 张。
const COLORS = ['red', 'yellow', 'green', 'blue'];
const CN = { red: '红', yellow: '黄', green: '绿', blue: '蓝' };
const BY_CN = { 红: 'red', 黄: 'yellow', 绿: 'green', 蓝: 'blue', red: 'red', yellow: 'yellow', green: 'green', blue: 'blue', r: 'red', y: 'yellow', g: 'green', b: 'blue' };
const VNAME = { skip: '禁止', reverse: '反转', draw2: '+2', wild: '变色', wild4: '+4' };
const HAND = 7;

const nameOf = c => c.color ? `${CN[c.color]}${VNAME[c.value] || c.value}` : VNAME[c.value];
const colorOf = v => BY_CN[String(v || '').trim().toLowerCase()] || BY_CN[String(v || '').trim()] || null;

function newDeck() {
  const cards = [];
  let n = 0;
  const add = (color, value) => cards.push({ id: `c${++n}`, color, value });
  for (const color of COLORS) {
    add(color, '0');
    for (let k = 0; k < 2; k++) {
      for (let v = 1; v <= 9; v++) add(color, String(v));
      add(color, 'skip'); add(color, 'reverse'); add(color, 'draw2');
    }
  }
  for (let k = 0; k < 4; k++) { add(null, 'wild'); add(null, 'wild4'); }
  return cards;
}
function shuffle(a, ctx) {
  for (let i = a.length - 1; i > 0; i--) { const j = ctx.random(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const rulesFull = `UNO 规则（2-6 人，一局定胜负）
- 一副 108 张：红黄绿蓝四色，每色 0 一张，1-9、禁止、反转、+2 各两张；变色（万能）4 张，+4（万能）4 张。
- 每人先发 7 张，翻开一张当起始牌。轮到你时，打出一张和桌面「颜色相同」或「数字 / 符号相同」的牌；万能牌什么时候都能出，出的时候选一个颜色。
- 没有能出的（或不想出），就摸一张。摸到的牌能出，可以马上出它，也可以留着（keep_drawn），轮到下一位；摸到不能出的，直接轮到下一位。
- 禁止：下一位跳过。反转：出牌方向反过来（两个人玩时等于禁止）。+2：下一位摸 2 张并跳过。
- +4：下一位要选「接受」（摸 4 张并跳过）或「质疑」。质疑时看出 +4 的人当时手里有没有和桌面颜色相同的牌：有，就是犯规，他自己摸 4 张，质疑的人照常出牌；没有，质疑失败，质疑的人摸 6 张并跳过。
- 打完后手里只剩 1 张时要喊 UNO（出牌时带 uno=true，或者之后用 call_uno）。忘了喊、在下一位行动前被别人抓到（catch_uno），罚摸 2 张。
- 最先出完手牌的人获胜。
- 牌的写法：红5、黄禁止、绿反转、蓝+2、变色、+4。出牌用 act，action="play"，card 填牌名；万能牌再带 color（红 / 黄 / 绿 / 蓝）。
- 有聊天频道，可以随时聊天。`;
const rulesHuman = rulesFull.split('\n').filter(l => !/act，|uno=true|call_uno|catch_uno|keep_drawn/.test(l)).join('\n');

const next = (s, seat, steps = 1) => {
  const n = s.players.length;
  return ((seat - 1 + s.dir * steps) % n + n) % n + 1;
};
const top = s => s.discard[s.discard.length - 1];
const canPlay = (s, c) => !c.color || c.color === s.color || (!!top(s).color && c.value === top(s).value);
const pname = (s, seat) => `${seat}号 ${s.players[seat - 1].name}`;

function draw(s, seat, n, ctx) {
  const got = [];
  for (let i = 0; i < n; i++) {
    if (!s.deck.length) {
      const keepTop = s.discard.pop();
      s.deck = shuffle(s.discard.map(c => c), ctx);
      s.discard = [keepTop];
      if (!s.deck.length) break; // everything is in hands
      ctx.log({ text: '牌堆摸完了，把弃牌洗回去当新牌堆' });
    }
    const c = s.deck.pop();
    s.hands[seat].push(c);
    got.push(c);
  }
  if (s.hands[seat].length !== 1 && s.uno === seat) s.uno = null;
  return got;
}
// The turn goes to `seat`; anything that was waiting on the old turn is closed.
function turnTo(s, seat, ctx) {
  s.turn = seat; s.stage = 'play'; s.drawn = null; s.since = ctx.now();
}
// After any move by someone else, a forgotten UNO can no longer be caught.
function closeUno(s, actor) { if (s.uno && s.uno !== actor) s.uno = null; }

function finish(s, seat, ctx) {
  s.winner = seat;
  ctx.log({ text: `${pname(s, seat)} 出完了所有手牌，获胜！` });
}

function play(s, seat, card, color, sayUno, ctx) {
  const hand = s.hands[seat];
  hand.splice(hand.indexOf(card), 1);
  const before = s.color;
  s.discard.push(card);
  const wild = !card.color;
  if (wild) s.color = color; else s.color = card.color;
  ctx.log({ kind: 'play', seat, text: `${pname(s, seat)} 出了 ${nameOf(card)}${wild ? `，选了${CN[color]}色` : ''}` });
  if (!hand.length) return finish(s, seat, ctx);
  if (hand.length === 1) {
    if (sayUno) { s.uno = null; ctx.log({ seat, text: `${pname(s, seat)}：UNO！` }); }
    else s.uno = seat;
  }
  const n = s.players.length;
  if (card.value === 'reverse') {
    s.dir = -s.dir;
    ctx.log({ text: n === 2 ? '反转（两个人玩，等于禁止）' : '出牌方向反过来了' });
    return turnTo(s, n === 2 ? seat : next(s, seat), ctx);
  }
  if (card.value === 'skip') {
    const skipped = next(s, seat);
    ctx.log({ text: `${pname(s, skipped)} 被跳过` });
    return turnTo(s, next(s, seat, 2), ctx);
  }
  if (card.value === 'draw2') {
    const victim = next(s, seat);
    draw(s, victim, 2, ctx);
    ctx.log({ text: `${pname(s, victim)} 摸 2 张，跳过` });
    return turnTo(s, next(s, seat, 2), ctx);
  }
  if (card.value === 'wild4') {
    const victim = next(s, seat);
    // Was it played against the rules? (a card of the colour on the table was in hand)
    s.challenge = { by: seat, guilty: hand.some(c => c.color === before), color: before };
    turnTo(s, victim, ctx);
    s.stage = 'challenge';
    return;
  }
  return turnTo(s, next(s, seat), ctx);
}

module.exports = {
  id: 'uno',
  name: 'UNO',
  summary: '按颜色、数字或符号接牌，用功能牌改变局势，先出完手牌的人赢',
  allowChat: true,
  normalizeOptions: o => ({ players: Math.min(6, Math.max(2, Math.round(Number(o && o.players) || 4))) }),
  seatCount: o => o.players,
  configLabel: o => `${o.players} 人`,
  rulesSummary: o => `UNO · ${o.players} 人：按颜色或数字 / 符号接牌，先出完的人赢。出牌用 act，action="play"，card 填牌名（如 红5、蓝+2、变色），万能牌带 color；摸牌 action="draw"。剩 1 张时出牌带 uno=true 喊 UNO。完整规则用 get_rules。`,
  rulesFull,
  rulesHuman,

  setup(players, options, ctx) {
    const deck = shuffle(newDeck(), ctx);
    const hands = {};
    players.forEach(p => { hands[p.seat] = deck.splice(-HAND); });
    // The first card from the pile may not be a wild: those go back and another is turned.
    let first = deck.pop();
    while (!first.color) { deck.unshift(first); first = deck.pop(); }
    const s = { players, deck, hands, discard: [first], color: first.color, dir: 1, turn: 1, stage: 'play', drawn: null, uno: null, challenge: null, winner: null, since: ctx.now(), turns: 0 };
    ctx.log({ text: `发牌了：每人 ${HAND} 张。起始牌是 ${nameOf(first)}，1号 ${players[0].name} 先出` });
    // An action card to start with works on the first player.
    if (first.value === 'skip') { ctx.log({ text: `起始牌是禁止：1号 被跳过` }); turnTo(s, next(s, 1), ctx); }
    else if (first.value === 'reverse') { s.dir = -1; ctx.log({ text: '起始牌是反转：反方向出牌' }); turnTo(s, players.length === 2 ? 2 : players.length, ctx); }
    else if (first.value === 'draw2') { draw(s, 1, 2, ctx); ctx.log({ text: '起始牌是 +2：1号 摸 2 张，跳过' }); turnTo(s, next(s, 1), ctx); }
    return s;
  },

  phase: s => ({ label: s.winner ? '已结束' : `轮到 ${s.turn}号 · ${CN[s.color]}色 · ${s.dir === 1 ? '顺时针' : '逆时针'}`, night: false, day: 0, part: '' }),

  pending: s => (s.winner ? null : { mode: 'turn', seats: [s.turn], since: s.since, label: s.stage === 'challenge' ? '接受或质疑 +4' : '出牌' }),
  publicPending(s) {
    const p = this.pending(s);
    return p && { ...p, text: `${p.seats[0]}号 ${s.players[p.seats[0] - 1].name} ${s.stage === 'challenge' ? '要决定接不接 +4' : '思考中'}` };
  },

  actions(s, seat) {
    if (s.winner) return [];
    const out = [];
    const hand = s.hands[seat] || [];
    if (s.turn === seat) {
      if (s.stage === 'challenge') {
        out.push({ type: 'accept_draw_four', label: '接受 +4（摸 4 张）' });
        out.push({ type: 'challenge_draw_four', label: '质疑 +4（对方犯规他摸 4 张；猜错你摸 6 张）' });
      } else if (s.stage === 'drawn') {
        const c = hand.find(x => x.id === s.drawn);
        out.push({ type: 'play', label: `出刚摸到的 ${nameOf(c)}`, hint: `card="${nameOf(c)}"${c.color ? '' : '，带上 color'}`, cards: [c.id] });
        out.push({ type: 'keep_drawn', label: '留着，不出' });
      } else {
        const ok = hand.filter(c => canPlay(s, c));
        if (ok.length) out.push({ type: 'play', label: '出牌', hint: `能出：${[...new Set(ok.map(nameOf))].join('、')}；万能牌带 color；剩 1 张时带 uno=true`, cards: ok.map(c => c.id) });
        out.push({ type: 'draw', label: '摸一张' });
      }
    }
    if (s.uno === seat) out.push({ type: 'call_uno', label: '喊 UNO', passive: true });
    if (s.uno && s.uno !== seat) out.push({ type: 'catch_uno', label: `抓 ${s.uno}号 没喊 UNO（他罚摸 2 张）`, passive: true, target: 'seat', targets: [s.uno] });
    return out;
  },

  act(s, seat, action, ctx) {
    if (s.winner) return { error: '这局已经结束了' };
    const type = action.type;
    const hand = s.hands[seat];
    if (type === 'call_uno') {
      if (s.uno !== seat) return { error: hand.length === 1 ? '已经喊过了' : '只剩 1 张的时候才能喊 UNO' };
      s.uno = null;
      ctx.log({ seat, text: `${pname(s, seat)}：UNO！` });
      return { message: '喊了 UNO' };
    }
    if (type === 'catch_uno') {
      const target = Number(action.target) || s.uno;
      if (!s.uno || target !== s.uno || target === seat) return { error: '现在没有可以抓的人' };
      draw(s, target, 2, ctx);
      s.uno = null;
      ctx.log({ text: `${pname(s, seat)} 抓到 ${pname(s, target)} 没喊 UNO，${target}号 罚摸 2 张` });
      return { message: '抓到了' };
    }
    if (s.turn !== seat) return { error: `现在轮到 ${s.turn}号` };
    if (s.stage === 'challenge') {
      const ch = s.challenge;
      if (type === 'accept_draw_four') {
        closeUno(s, seat);
        draw(s, seat, 4, ctx);
        ctx.log({ text: `${pname(s, seat)} 接受 +4，摸 4 张，跳过` });
        s.challenge = null;
        turnTo(s, next(s, seat), ctx);
        return { message: '摸了 4 张' };
      }
      if (type === 'challenge_draw_four') {
        closeUno(s, seat);
        s.challenge = null;
        if (ch.guilty) {
          draw(s, ch.by, 4, ctx);
          ctx.log({ text: `${pname(s, seat)} 质疑 +4：成功！${pname(s, ch.by)} 手里其实有${CN[ch.color]}色的牌，他自己摸 4 张。${seat}号 照常出牌` });
          turnTo(s, seat, ctx);
          return { message: '质疑成功，轮到你出牌' };
        }
        draw(s, seat, 6, ctx);
        ctx.log({ text: `${pname(s, seat)} 质疑 +4：失败，${pname(s, ch.by)} 没有犯规。${seat}号 摸 6 张，跳过` });
        turnTo(s, next(s, seat), ctx);
        return { message: '质疑失败，摸了 6 张' };
      }
      return { error: '先决定：接受 +4（accept_draw_four）还是质疑（challenge_draw_four）' };
    }
    if (type === 'keep_drawn') {
      if (s.stage !== 'drawn') return { error: '你还没摸牌' };
      ctx.log({ seat, text: `${pname(s, seat)} 留着摸到的牌` });
      closeUno(s, seat);
      turnTo(s, next(s, seat), ctx);
      return { message: '留着了' };
    }
    if (type === 'draw') {
      if (s.stage === 'drawn') return { error: '这回合已经摸过了：出刚摸到的牌，或者留着（keep_drawn）' };
      closeUno(s, seat);
      const [c] = draw(s, seat, 1, ctx);
      if (!c) { ctx.log({ text: `${pname(s, seat)} 想摸牌，但牌堆空了，轮到下一位` }); turnTo(s, next(s, seat), ctx); return { message: '没牌可摸了' }; }
      ctx.log({ seat, text: `${pname(s, seat)} 摸了一张` });
      ctx.log({ seat, text: `你摸到了 ${nameOf(c)}`, visible: [seat] });
      if (canPlay(s, c)) { s.stage = 'drawn'; s.drawn = c.id; return { message: `摸到 ${nameOf(c)}，可以出它（play），也可以留着（keep_drawn）` }; }
      turnTo(s, next(s, seat), ctx);
      return { message: `摸到 ${nameOf(c)}，出不了，轮到下一位` };
    }
    if (type === 'play') {
      // The card: its id (from the page) or its name (from an AI: 红5, 蓝+2, 变色…).
      const want = String(action.card || action.card_id || '').trim();
      let card = hand.find(c => c.id === want);
      if (!card && want) {
        const norm = w => w.replace(/\s/g, '').replace(/^万能/, '').replace(/^(变色牌|变色)$/, '变色').replace(/^\+4(变色)?$/, '+4').replace(/跳过$/, '禁止');
        card = hand.find(c => nameOf(c) === norm(want));
      }
      if (!card) return { error: `你手里没有「${want || '？'}」。你的手牌：${hand.map(nameOf).join('、')}` };
      if (s.stage === 'drawn' && card.id !== s.drawn) return { error: '摸牌之后只能出刚摸到的那张，或者留着（keep_drawn）' };
      if (!canPlay(s, card)) return { error: `${nameOf(card)} 接不上：桌面是 ${CN[s.color]}色 的 ${nameOf(top(s))}` };
      let color = null;
      if (!card.color) {
        color = colorOf(action.color || action.chosen_color);
        if (!color) return { error: '万能牌要带 color：红 / 黄 / 绿 / 蓝' };
      }
      closeUno(s, seat);
      s.turns++;
      play(s, seat, card, color, !!(action.uno || action.call_uno), ctx);
      return { message: `出了 ${nameOf(card)}` };
    }
    return { error: 'UNO 的操作：play（出牌）、draw（摸牌）、keep_drawn、accept_draw_four、challenge_draw_four、call_uno、catch_uno' };
  },

  // For a seat under 托管: take the +4, keep a drawn card, otherwise draw.
  defaultAction(s, seat) {
    if (s.stage === 'challenge') return { type: 'accept_draw_four' };
    if (s.stage === 'drawn') return { type: 'keep_drawn' };
    return { type: 'draw' };
  },

  publicView: (s, finished) => ({
    top: { ...top(s), name: nameOf(top(s)) }, color: s.color, dir: s.dir, turn: s.turn, stage: s.stage, uno: s.uno, winner: s.winner,
    deck: s.deck.length, counts: Object.fromEntries(s.players.map(p => [p.seat, s.hands[p.seat].length])),
    hands: finished ? Object.fromEntries(s.players.map(p => [p.seat, s.hands[p.seat].map(c => ({ ...c, name: nameOf(c) }))])) : undefined,
  }),
  seatView: (s, seat) => ({
    hand: s.hands[seat].map(c => ({ ...c, name: nameOf(c), ok: !s.winner && s.turn === seat && (s.stage === 'drawn' ? c.id === s.drawn : s.stage === 'play' && canPlay(s, c)) })),
  }),
  seatNote: (board, seat) => `${board.counts[seat]} 张${board.uno === seat ? ' · 没喊 UNO' : ''}`,

  textBoard: s => `桌面：${nameOf(top(s))}，现在的颜色是 ${CN[s.color]}色 · 方向 ${s.dir === 1 ? '顺时针（1→2→3…）' : '逆时针'} · 牌堆还剩 ${s.deck.length} 张\n手牌数：${s.players.map(p => `${p.seat}号 ${s.hands[p.seat].length} 张`).join('，')}`,
  textPrivate: (s, seat) => `你的手牌（${s.hands[seat].length} 张）：${s.hands[seat].map(nameOf).join('、')}`,

  result(s) {
    if (!s.winner) return null;
    return { title: `${s.players[s.winner - 1].name} 胜`, winner: s.winner, summary: `${s.turns} 次出牌`, ...(s.endReason ? { reason: s.endReason } : {}) };
  },

  archive: s => ({ kind: 'uno', players: s.players, winner: s.winner, hands: Object.fromEntries(s.players.map(p => [p.seat, s.hands[p.seat].map(nameOf)])) }),
};
