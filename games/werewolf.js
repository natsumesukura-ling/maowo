// 狼人杀，规则照搬 GG（花园）狼人杀，差异见 docs/DESIGN.md 第 5 节。
//
// The game runs as a queue of steps. A step either resolves at once (nightfall, dawn,
// announcing deaths) or waits for players: one at a time ("turn": speeches) or all at
// once ("simultaneous": votes, night roles). Resolving a step queues what comes next.

const ROLE = { wolf: '狼人', villager: '村民', seer: '预言家', witch: '女巫', hunter: '猎人', guard: '守卫' };
const GODS = ['seer', 'witch', 'hunter', 'guard'];
const CONFIGS = {
  6: { wolf: 2, villager: 2, gods: ['seer', 'witch'], sheriff: false },
  7: { wolf: 2, villager: 3, gods: ['seer', 'witch'], sheriff: false },
  8: { wolf: 3, villager: 3, gods: ['seer', 'witch'], sheriff: false },
  9: { wolf: 3, villager: 3, gods: ['seer', 'witch', 'hunter'], sheriff: true },
  10: { wolf: 3, villager: 4, gods: ['seer', 'witch', 'hunter'], sheriff: true },
  11: { wolf: 4, villager: 4, gods: ['seer', 'witch', 'hunter'], sheriff: true },
  12: { wolf: 4, villager: 4, gods: ['seer', 'witch', 'hunter', 'guard'], sheriff: true },
};
const CAUSE = { wolf: '狼人袭击', poison: '毒杀', exile: '放逐', shot: '猎人开枪', explode: '自爆' };
const SPEECH_MAX = 500;
const NIGHT_STEPS = ['guard', 'wolf', 'witch', 'seer'];
const LABEL = {
  guard: '夜间行动', wolf: '夜间行动', witch: '夜间行动', seer: '夜间行动',
  sheriff_signup: '上警报名', sheriff_speech: '竞选发言', sheriff_vote: '警长投票',
  sheriff_pk_speech: '警长加赛发言', sheriff_pk_vote: '警长加赛投票',
  day_order: '选择发言方向', day_speech: '发言', day_vote: '放逐投票', pk_speech: '加赛发言', pk_vote: '加赛投票',
};

const configLabel = n => {
  const c = CONFIGS[n];
  // Old archives may hold a table that no longer exists (the 2-player test table of 2026-11-03).
  if (!c) return `${n} 人测试局`;
  return `${n} 人局 · ${c.wolf} 狼 ${c.villager} 民 · ${c.gods.map(g => ROLE[g]).join(' ')}`;
};

// ---------- small helpers ----------
const P = (s, seat) => s.players[seat - 1];
const tag = (s, seat) => `${seat}号 ${P(s, seat).name}`;
const alive = s => s.players.filter(p => p.alive).map(p => p.seat);
const withRole = (s, role) => s.players.filter(p => p.role === role);
const aliveWith = (s, role) => withRole(s, role).filter(p => p.alive).map(p => p.seat);
const wolves = s => withRole(s, 'wolf').map(p => p.seat);
const camp = role => (role === 'wolf' ? '狼人阵营' : '好人阵营');
const list = (s, seats) => seats.map(x => tag(s, x)).join('、');

function checkWin(s, ctx) {
  if (s.over) return true;
  const w = s.players.filter(p => p.alive && p.role === 'wolf').length;
  const v = s.players.filter(p => p.alive && p.role === 'villager').length;
  const g = s.players.filter(p => p.alive && GODS.includes(p.role)).length;
  if (w === 0) s.over = { winner: 'good', reason: '狼人全部出局' };
  else if (v === 0) s.over = { winner: 'wolf', reason: '村民全部出局（屠边）' };
  else if (g === 0) s.over = { winner: 'wolf', reason: '神职全部出局（屠边）' };
  if (s.over) {
    s.step = null; s.queue = [];
    ctx.log({ text: `游戏结束：${s.over.winner === 'good' ? '好人' : '狼人'}阵营胜。${s.over.reason}` });
    return true;
  }
  return false;
}

function kill(s, seat, cause, when) {
  const p = P(s, seat);
  p.alive = false;
  p.cause = cause;
  p.diedOn = when || `第 ${s.day} 天`;
  if (['exile', 'shot', 'explode'].includes(cause)) p.publicCause = CAUSE[cause];
}

// Death follow-up for one seat: last words, then a final step everyone gets (so a hunter's
// shot looks like anyone else's confirmation), then handing over the badge.
function deathStep(s, seat, cause, lastWords) {
  const stages = [];
  if (lastWords) stages.push('lastwords');
  if (['wolf', 'poison', 'exile'].includes(cause)) stages.push('final');
  stages.push('badge');
  return { kind: 'death', seat, cause, stages };
}

function tally(s, votes, weightOf) {
  const score = {};
  for (const [voter, target] of Object.entries(votes)) {
    if (!target) continue;
    score[target] = (score[target] || 0) + weightOf(Number(voter));
  }
  const top = Math.max(0, ...Object.values(score));
  const leaders = Object.keys(score).filter(k => score[k] === top).map(Number).sort((a, b) => a - b);
  return { score, top, leaders };
}

function voteLine(s, votes, weightOf) {
  return Object.keys(votes).map(Number).sort((a, b) => a - b).map(v => {
    const w = weightOf(v) !== 1 ? `（${weightOf(v)} 票）` : '';
    return votes[v] ? `${v}号→${votes[v]}号${w}` : `${v}号 弃票`;
  }).join('，');
}

// ---------- the step engine ----------
function begin(s, step, ctx) {
  step.since = ctx.now();
  step.done = {};
  const solo = seat => (seat ? (step.actors = [seat], (s.step = step)) : null);
  switch (step.kind) {
    case 'nightfall': {
      s.night += 1; s.part = 'night';
      s.tonight = { guard: null, proposals: {}, kills: {}, target: null, saved: false, poison: null, check: null };
      ctx.log({ text: `第 ${s.night} 夜 · 天黑请闭眼` });
      s.queue.unshift(...NIGHT_STEPS.map(kind => ({ kind })), { kind: 'dawn' });
      return;
    }
    case 'guard': return solo(aliveWith(s, 'guard')[0]);
    case 'seer': return solo(aliveWith(s, 'seer')[0]);
    case 'witch': {
      const witch = aliveWith(s, 'witch')[0];
      if (!witch) return;
      const t = s.tonight.target;
      ctx.log({ visible: [witch], text: t ? `女巫请睁眼：今晚 ${tag(s, t)} 被狼人袭击` : '女巫请睁眼：今晚是空刀' });
      return solo(witch);
    }
    case 'wolf': {
      const w = aliveWith(s, 'wolf');
      if (!w.length) return;
      step.actors = w; s.step = step;
      return;
    }
    case 'dawn': {
      const t = s.tonight;
      const deaths = [];
      // Guarded and saved on the same night still dies (同守同救).
      if (t.target && (t.guard === t.target) === t.saved) deaths.push({ seat: t.target, cause: 'wolf' });
      if (t.poison && !deaths.some(d => d.seat === t.poison)) deaths.push({ seat: t.poison, cause: 'poison' });
      s.pendingDeaths = deaths;
      if (s.night === 1 && CONFIGS[s.n]?.sheriff) s.queue.unshift({ kind: 'sheriff_signup' }, { kind: 'announce' });
      else s.queue.unshift({ kind: 'announce' });
      return;
    }
    case 'sheriff_signup': {
      s.day = s.night; s.part = 'day';
      ctx.log({ text: `第 ${s.day} 天 · 天亮了，先进行警长竞选。请所有人选择是否上警` });
      step.actors = alive(s); s.step = step;
      return;
    }
    case 'sheriff_speech':
    case 'sheriff_pk_speech':
    case 'day_speech':
    case 'pk_speech': {
      step.idx = 0;
      step.order = step.order.filter(x => P(s, x).alive || step.kind.startsWith('sheriff'));
      if (!step.order.length) return;
      step.actors = [step.order[0]]; s.step = step;
      if (step.kind === 'day_speech') ctx.log({ text: `从 ${tag(s, step.order[0])} 开始发言` });
      return;
    }
    case 'sheriff_vote':
    case 'sheriff_pk_vote': {
      const cands = step.kind === 'sheriff_vote' ? s.election.candidates.filter(c => !s.election.withdrawn.includes(c)) : step.candidates;
      step.candidates = cands;
      if (cands.length === 0) { ctx.log({ text: '没有人参选，本局没有警长' }); return; }
      if (cands.length === 1) { electSheriff(s, cands[0], ctx, '唯一候选人'); return; }
      const ran = s.election.candidates;
      step.actors = alive(s).filter(x => !ran.includes(x));
      if (!step.actors.length) { ctx.log({ text: '没有人可以投票，本局没有警长' }); return; }
      ctx.log({ text: `${step.kind === 'sheriff_vote' ? '警长投票' : '警长加赛投票'}开始，候选人：${list(s, cands)}。警下的人投票，可以弃票` });
      s.step = step;
      return;
    }
    case 'announce': {
      s.day = s.night; s.part = 'day';
      const deaths = (s.pendingDeaths || []).sort((a, b) => a.seat - b.seat);
      s.pendingDeaths = [];
      deaths.forEach(d => kill(s, d.seat, d.cause, `第 ${s.night} 夜`));
      ctx.log({ text: deaths.length ? `天亮了。昨夜死亡：${list(s, deaths.map(d => d.seat))}` : '天亮了。昨夜是平安夜' });
      if (checkWin(s, ctx)) return;
      s.queue.unshift(...deaths.map(d => deathStep(s, d.seat, d.cause, s.night === 1)), { kind: 'day_start' });
      return;
    }
    case 'day_start': {
      if (s.sheriff && P(s, s.sheriff).alive) { s.queue.unshift({ kind: 'day_order' }, { kind: 'day_vote' }); return; }
      const a = alive(s);
      const start = a[ctx.random(a.length)];
      s.queue.unshift({ kind: 'day_speech', order: rotate(a, start) }, { kind: 'day_vote' });
      return;
    }
    case 'day_order': return solo(s.sheriff);
    case 'day_vote':
    case 'pk_vote': {
      step.candidates = step.kind === 'day_vote' ? alive(s) : step.candidates.filter(x => P(s, x).alive);
      step.actors = alive(s).filter(x => step.kind === 'day_vote' || !step.candidates.includes(x));
      if (!step.actors.length || !step.candidates.length) { ctx.log({ text: '没有人可以投票，今天无人出局' }); s.queue.unshift({ kind: 'nightfall' }); return; }
      ctx.log({ text: step.kind === 'day_vote' ? '发言结束，开始放逐投票。不能投自己，可以弃票' : `加赛投票开始，在 ${list(s, step.candidates)} 中选择` });
      s.step = step;
      return;
    }
    case 'death': {
      step.stage = 0;
      while (step.stage < step.stages.length && !stageApplies(s, step, step.stages[step.stage])) step.stage++;
      if (step.stage >= step.stages.length) return;
      return solo(step.seat);
    }
    default: throw new Error('unknown step ' + step.kind);
  }
}

function stageApplies(s, step, stage) {
  if (stage === 'badge') return s.sheriff === step.seat;
  return true;
}

function rotate(order, start) {
  const i = order.indexOf(start);
  return i < 0 ? order : [...order.slice(i), ...order.slice(0, i)];
}

function electSheriff(s, seat, ctx, how) {
  s.sheriff = seat;
  ctx.log({ text: `${tag(s, seat)} 当选警长（${how}）。警长的放逐票算 1.5 票` });
}

function proceed(s, ctx) {
  for (let i = 0; i < 500 && !s.over && !s.step; i++) {
    if (!s.queue.length) throw new Error('step queue ran dry');
    begin(s, s.queue.shift(), ctx);
  }
}

function finishStep(s, ctx) {
  s.step = null;
  proceed(s, ctx);
}

// Advance a turn-based step to its next speaker.
function nextSpeaker(s, step, ctx) {
  step.idx += 1;
  while (step.idx < step.order.length && step.kind === 'sheriff_speech' && s.election.withdrawn.includes(step.order[step.idx])) step.idx += 1;
  if (step.idx >= step.order.length) return endSpeeches(s, step, ctx);
  step.actors = [step.order[step.idx]];
  step.since = ctx.now();
}

function endSpeeches(s, step, ctx) {
  if (step.kind === 'sheriff_speech') s.queue.unshift({ kind: 'sheriff_vote' });
  if (step.kind === 'sheriff_pk_speech') s.queue.unshift({ kind: 'sheriff_pk_vote', candidates: step.order });
  if (step.kind === 'pk_speech') s.queue.unshift({ kind: 'pk_vote', candidates: step.order });
  finishStep(s, ctx);
}

function resolveSimultaneous(s, step, ctx) {
  const d = step.done;
  switch (step.kind) {
    case 'wolf': {
      const { leaders, top } = tally(s, d, () => 1);
      s.tonight.target = leaders.length === 1 && top > 0 ? leaders[0] : null;
      const who = list(s, step.actors);
      ctx.log({ kind: 'wolf', part: 'wolf', visible: wolves(s),
        text: s.tonight.target ? `${who} 确认袭击 ${tag(s, s.tonight.target)}`
          : top > 0 ? `${who} 没有一致的目标，今晚空刀` : `${who} 选择空刀，今晚不袭击` });
      break;
    }
    case 'sheriff_signup': {
      const cands = step.actors.filter(x => d[x] === 'run');
      s.election = { candidates: cands, withdrawn: [] };
      ctx.log({ text: cands.length ? `上警：${list(s, cands)}` : '没有人上警' });
      if (cands.length === step.actors.length) { ctx.log({ text: '全员上警，没有人能投票，本局没有警长' }); break; }
      if (cands.length >= 2) s.queue.unshift({ kind: 'sheriff_speech', order: cands });
      else if (cands.length === 1) s.queue.unshift({ kind: 'sheriff_vote' });
      break;
    }
    case 'sheriff_vote':
    case 'sheriff_pk_vote': {
      const { leaders, top } = tally(s, d, () => 1);
      ctx.log({ text: `警长投票：${voteLine(s, d, () => 1)}` });
      if (top === 0) ctx.log({ text: '全员弃票，本局没有警长' });
      else if (leaders.length === 1) electSheriff(s, leaders[0], ctx, `${top} 票`);
      else if (step.kind === 'sheriff_vote') {
        ctx.log({ text: `${list(s, leaders)} 平票，进入加赛发言` });
        s.queue.unshift({ kind: 'sheriff_pk_speech', order: leaders });
      } else ctx.log({ text: '再次平票，本局没有警长' });
      break;
    }
    case 'day_vote':
    case 'pk_vote': {
      const weight = v => (v === s.sheriff ? 1.5 : 1);
      const { leaders, top } = tally(s, d, weight);
      ctx.log({ text: `${step.kind === 'day_vote' ? '放逐投票' : '加赛投票'}：${voteLine(s, d, weight)}` });
      if (top === 0) { ctx.log({ text: '全员弃票，今天无人出局' }); s.queue.unshift({ kind: 'nightfall' }); break; }
      if (leaders.length > 1) {
        if (step.kind === 'day_vote') {
          ctx.log({ text: `${list(s, leaders)} 平票，进入加赛发言` });
          s.queue.unshift({ kind: 'pk_speech', order: leaders });
        } else {
          ctx.log({ text: '再次平票，今天无人出局' });
          s.queue.unshift({ kind: 'nightfall' });
        }
        break;
      }
      const out = leaders[0];
      kill(s, out, 'exile');
      ctx.log({ text: `${tag(s, out)} 以 ${top} 票被放逐` });
      if (checkWin(s, ctx)) return;
      s.queue.unshift(deathStep(s, out, 'exile', true), { kind: 'nightfall' });
      break;
    }
  }
  finishStep(s, ctx);
}

// ---------- actions ----------
const target = (type, label, targets, extra = {}) => ({ type, label, target: 'seat', targets, ...extra });
const plain = (type, label, extra = {}) => ({ type, label, ...extra });
const textAct = (type, label, extra = {}) => ({ type, label, text: true, maxLength: SPEECH_MAX, hint: `带上 text，最多 ${SPEECH_MAX} 字`, ...extra });

function actionsFor(s, seat) {
  const step = s.step;
  if (!step || s.over) return [];
  const me = P(s, seat);
  const out = [];
  const pendingMe = pendingSeats(s).includes(seat);

  // Optional actions open to more than the acting seat.
  if (step.kind === 'wolf' && me.role === 'wolf' && me.alive) {
    out.push(target('propose', '向同伴提议袭击目标', alive(s), { passive: true, hint: '带上 target（座位号），只有狼人能看到' }));
    out.push(textAct('wolf_chat', '狼人私聊', { passive: true }));
  }
  if (step.kind === 'day_speech' && me.role === 'wolf' && me.alive) {
    out.push(plain('explode', '自爆（公开狼人身份，立即结束今天，进入黑夜）', { passive: true, danger: true }));
    if (aliveWith(s, 'wolf').length === 1) out.push(plain('concede', '代表狼人阵营认输', { passive: true, danger: true }));
  }
  if (step.kind === 'sheriff_speech' && s.election.candidates.includes(seat) && !s.election.withdrawn.includes(seat) && step.actors[0] !== seat) {
    out.push(plain('withdraw', '退选', { passive: true }));
  }
  if (!pendingMe) return out;

  const others = alive(s).filter(x => x !== seat);
  switch (step.kind) {
    case 'guard':
      out.push(target('guard', '守护', alive(s).filter(x => x !== s.guardLast), { hint: s.guardLast ? `不能连续两夜守 ${s.guardLast}号` : '可以守自己' }));
      out.push(plain('guard_none', '空守'));
      break;
    case 'wolf':
      out.push(target('kill', '确认袭击', alive(s), { hint: '每名狼人都要确认；唯一最高票才袭击，否则空刀' }));
      out.push(plain('kill_none', '确认空刀'));
      break;
    case 'witch': {
      const t = s.tonight.target;
      if (s.witch.antidote && t && t !== seat) out.push(plain('save', `使用解药救 ${tag(s, t)}`));
      if (s.witch.poison) out.push(target('poison', '使用毒药', others));
      out.push(plain('witch_pass', '今晚不用药'));
      break;
    }
    case 'seer':
      out.push(target('check', '查验', others), plain('check_none', '今晚不查验'));
      break;
    case 'sheriff_signup':
      out.push(plain('run', '上警'), plain('not_run', '不上警'));
      break;
    case 'sheriff_speech':
      out.push(textAct('speak', '竞选发言'), plain('withdraw', '退选'), plain('pass', '不发言'));
      break;
    case 'sheriff_pk_speech':
    case 'pk_speech':
    case 'day_speech':
      out.push(textAct('speak', step.kind === 'day_speech' ? '发言' : '加赛发言'), plain('pass', '不发言'));
      break;
    case 'sheriff_vote':
    case 'sheriff_pk_vote':
      out.push(target('vote', '投票给', step.candidates), plain('abstain', '弃票'));
      break;
    case 'day_vote':
    case 'pk_vote':
      out.push(target('vote', step.kind === 'day_vote' ? '放逐' : '投票放逐', step.candidates.filter(x => x !== seat)), plain('abstain', '弃票'));
      break;
    case 'day_order':
      out.push(plain('clockwise', '顺时针（座位号从小到大）'), plain('counterclockwise', '逆时针（座位号从大到小）'));
      break;
    case 'death': {
      const stage = step.stages[step.stage];
      if (stage === 'lastwords') out.push(textAct('speak', '发表遗言'), plain('pass', '不留遗言'));
      if (stage === 'final') {
        if (me.role === 'hunter' && step.cause !== 'poison') out.push(target('shoot', '开枪带走', alive(s)), plain('no_shoot', '不开枪'));
        else out.push(plain('confirm', '确认出局'));
      }
      if (stage === 'badge') out.push(target('pass_badge', '把警徽移交给', alive(s)), plain('destroy_badge', '销毁警徽'));
      break;
    }
  }
  return out;
}

function pendingSeats(s) {
  const step = s.step;
  if (!step || s.over) return [];
  if (['wolf', 'sheriff_signup', 'sheriff_vote', 'sheriff_pk_vote', 'day_vote', 'pk_vote'].includes(step.kind)) {
    return step.actors.filter(x => !(x in step.done));
  }
  return step.actors;
}

function act(s, seat, action, ctx) {
  const type = action.type || action.action;
  const allowed = actionsFor(s, seat).find(a => a.type === type);
  if (!allowed) {
    const now = actionsFor(s, seat).map(a => a.type);
    return { error: now.length ? `现在不能 ${type}。你现在可以：${now.join('、')}` : '现在不需要你操作' };
  }
  let t = null;
  if (allowed.target) {
    t = Number(action.target);
    if (!allowed.targets.includes(t)) return { error: `目标不对，可以选：${allowed.targets.map(x => x + '号').join('、')}` };
  }
  let text = '';
  if (allowed.text) {
    text = String(action.text || '').trim();
    if (!text) return { error: '需要 text' };
    if (text.length > SPEECH_MAX) return { error: `最多 ${SPEECH_MAX} 字，现在 ${text.length} 字` };
  }
  const step = s.step;
  const me = P(s, seat);

  switch (type) {
    // --- optional actions ---
    case 'propose':
      s.tonight.proposals[seat] = t;
      ctx.log({ kind: 'wolf', part: 'wolf', seat, label: '提议', visible: wolves(s), text: `提议袭击 ${tag(s, t)}` });
      return { message: '已向同伴提议' };
    case 'wolf_chat':
      ctx.log({ kind: 'wolf', part: 'wolf', seat, label: '狼人私聊', visible: wolves(s), text });
      return { message: '已发送给同伴' };
    case 'explode': {
      ctx.log({ text: `${tag(s, seat)} 自爆，身份是狼人。今天立即结束，进入黑夜` });
      kill(s, seat, 'explode');
      me.revealed = true;
      s.step = null; s.queue = [];
      if (checkWin(s, ctx)) return { message: '已自爆' };
      s.queue.push(deathStep(s, seat, 'explode', false), { kind: 'nightfall' });
      proceed(s, ctx);
      return { message: '已自爆' };
    }
    case 'concede':
      ctx.log({ text: `${tag(s, seat)} 代表狼人阵营认输` });
      s.over = { winner: 'good', reason: '狼人认输' };
      s.step = null; s.queue = [];
      ctx.log({ text: '游戏结束：好人阵营胜。狼人认输' });
      return { message: '已认输' };
    case 'withdraw':
      s.election.withdrawn.push(seat);
      ctx.log({ text: `${tag(s, seat)} 退选` });
      if (step.actors[0] === seat) nextSpeaker(s, step, ctx);
      return { message: '已退选' };

    // --- night ---
    case 'guard':
    case 'guard_none':
      s.tonight.guard = t;
      s.guardLast = t;
      ctx.log({ visible: [seat], text: t ? `守卫 ${tag(s, seat)} 守护了 ${tag(s, t)}` : `守卫 ${tag(s, seat)} 选择空守` });
      finishStep(s, ctx);
      return { message: t ? `已守护 ${t}号` : '已空守' };
    case 'kill':
    case 'kill_none':
      step.done[seat] = t;
      ctx.log({ kind: 'wolf', part: 'wolf', seat, label: '确认', visible: wolves(s), text: t ? `确认袭击 ${tag(s, t)}` : '确认空刀' });
      if (!pendingSeats(s).length) resolveSimultaneous(s, step, ctx);
      return { message: '已确认' };
    case 'save':
      s.witch.antidote = false;
      s.tonight.saved = true;
      ctx.log({ visible: [seat], text: `女巫 ${tag(s, seat)} 使用解药救了 ${tag(s, s.tonight.target)}` });
      finishStep(s, ctx);
      return { message: '已使用解药' };
    case 'poison':
      s.witch.poison = false;
      s.tonight.poison = t;
      ctx.log({ visible: [seat], text: `女巫 ${tag(s, seat)} 对 ${tag(s, t)} 使用了毒药` });
      finishStep(s, ctx);
      return { message: '已使用毒药' };
    case 'witch_pass':
      ctx.log({ visible: [seat], text: `女巫 ${tag(s, seat)} 今晚没有用药` });
      finishStep(s, ctx);
      return { message: '今晚不用药' };
    case 'check':
    case 'check_none': {
      if (t) {
        const isWolf = P(s, t).role === 'wolf';
        s.checks.push({ night: s.night, target: t, wolf: isWolf });
        ctx.log({ visible: [seat], text: `预言家 ${tag(s, seat)} 查验 ${tag(s, t)}，结果为${isWolf ? '狼人' : '好人'}` });
      } else ctx.log({ visible: [seat], text: `预言家 ${tag(s, seat)} 今晚没有查验` });
      finishStep(s, ctx);
      return { message: t ? `${t}号 是${P(s, t).role === 'wolf' ? '狼人' : '好人'}` : '今晚没有查验' };
    }

    // --- day ---
    case 'run':
    case 'not_run':
    case 'abstain':
    case 'vote':
      step.done[seat] = type === 'vote' ? t : type === 'run' ? 'run' : null;
      if (!pendingSeats(s).length) resolveSimultaneous(s, step, ctx);
      return { message: type === 'vote' ? `已投给 ${t}号` : type === 'abstain' ? '已弃票' : type === 'run' ? '已上警' : '不上警' };
    case 'speak':
    case 'pass': {
      if (step.kind === 'death') {
        if (type === 'speak') ctx.log({ kind: 'speech', seat, label: '遗言', text });
        return nextStage(s, step, ctx, type === 'speak' ? '已发表遗言' : '不留遗言');
      }
      const label = { sheriff_speech: '竞选发言', sheriff_pk_speech: '警长加赛发言', pk_speech: '加赛发言' }[step.kind]
        || (seat === s.sheriff && step.order[step.order.length - 1] === seat ? '警长归票' : '发言');
      ctx.log({ kind: 'speech', seat, label, text: type === 'speak' ? text : '（过）' });
      nextSpeaker(s, step, ctx);
      return { message: type === 'speak' ? '已发言' : '已过' };
    }
    case 'clockwise':
    case 'counterclockwise': {
      const a = alive(s);
      const order = type === 'clockwise' ? a : [...a].reverse();
      const after = rotate(order, s.sheriff).slice(1);
      ctx.log({ text: `警长 ${tag(s, seat)} 选择${type === 'clockwise' ? '顺时针' : '逆时针'}，警长最后发言` });
      s.queue.unshift({ kind: 'day_speech', order: [...after, s.sheriff] });
      finishStep(s, ctx);
      return { message: '已选择发言方向' };
    }
    case 'shoot':
    case 'no_shoot':
      if (type === 'shoot') {
        me.revealed = true;
        ctx.log({ text: `猎人 ${tag(s, seat)} 开枪带走了 ${tag(s, t)}` });
        kill(s, t, 'shot');
        if (checkWin(s, ctx)) return { message: '已开枪' };
        // The shot player's own follow-up runs right after this one.
        s.queue.unshift(deathStep(s, t, 'shot', false));
      }
      return nextStage(s, step, ctx, type === 'shoot' ? `已带走 ${t}号` : '不开枪');
    case 'confirm':
      return nextStage(s, step, ctx, '已确认');
    case 'pass_badge':
    case 'destroy_badge':
      s.sheriff = type === 'pass_badge' ? t : null;
      ctx.log({ text: type === 'pass_badge' ? `${tag(s, seat)} 把警徽移交给 ${tag(s, t)}` : `${tag(s, seat)} 销毁了警徽，本局不再有警长` });
      return nextStage(s, step, ctx, '已处理警徽');
  }
  return { error: '未知操作' };
}

function nextStage(s, step, ctx, message) {
  if (s.over) return { message };
  step.stage += 1;
  while (step.stage < step.stages.length && !stageApplies(s, step, step.stages[step.stage])) step.stage++;
  if (step.stage >= step.stages.length) {
    // A hunter's victim queued a follow-up in front of whatever came next; keep it there.
    s.step = null;
    proceed(s, ctx);
  } else step.since = ctx.now();
  return { message };
}

function defaultAction(s, seat) {
  const step = s.step;
  if (!step) return {};
  switch (step.kind) {
    case 'guard': return { type: 'guard_none' };
    case 'wolf': return { type: 'kill_none' };
    case 'witch': return { type: 'witch_pass' };
    case 'seer': return { type: 'check_none' };
    case 'sheriff_signup': return { type: 'not_run' };
    case 'sheriff_vote': case 'sheriff_pk_vote': case 'day_vote': case 'pk_vote': return { type: 'abstain' };
    case 'day_order': return { type: 'clockwise' };
    case 'death': {
      const stage = step.stages[step.stage];
      if (stage === 'lastwords') return { type: 'pass' };
      if (stage === 'final') return { type: P(s, seat).role === 'hunter' && step.cause !== 'poison' ? 'no_shoot' : 'confirm' };
      return { type: 'destroy_badge' };
    }
    default: return { type: 'pass' };
  }
}

// ---------- views ----------
function phase(s) {
  if (s.over) return { label: '已结束', night: false, day: s.day, part: s.part };
  const night = s.part === 'night';
  const stepLabel = s.step && !NIGHT_STEPS.includes(s.step.kind)
    ? (s.step.kind === 'death' ? (s.step.stages[s.step.stage] === 'lastwords' ? '遗言' : '出局') : LABEL[s.step.kind])
    : '';
  return {
    label: night ? `第 ${s.night} 夜` : `第 ${s.day} 天${stepLabel ? ' · ' + stepLabel : ''}`,
    night, day: night ? s.night : s.day, part: s.part,
  };
}

function pending(s) {
  const step = s.step;
  const seats = pendingSeats(s);
  if (!step || !seats.length) return null;
  const hidden = NIGHT_STEPS.includes(step.kind);
  const mode = ['sheriff_speech', 'sheriff_pk_speech', 'day_speech', 'pk_speech', 'death', 'day_order'].includes(step.kind) || hidden && step.kind !== 'wolf' ? 'turn' : 'simultaneous';
  let label = LABEL[step.kind] || '操作';
  if (step.kind === 'death') label = step.stages[step.stage] === 'lastwords' ? '遗言' : step.stages[step.stage] === 'badge' ? '移交警徽' : '出局确认';
  return { mode, seats, since: step.since, label, hidden };
}

function publicPending(s) {
  const p = pending(s);
  if (!p) return null;
  if (p.hidden) return { hidden: true, label: '夜间行动', text: '夜间行动进行中', since: p.since, seats: [] };
  const text = p.mode === 'turn'
    ? `${tag(s, p.seats[0])} ${p.label === '发言' || p.label.endsWith('发言') ? '发言中' : p.label === '遗言' ? '发表遗言中' : p.label + '中'}`
    : `${p.label} · 还在等：${list(s, p.seats)}`;
  return { ...p, text };
}

function publicView(s, finished) {
  const step = s.step;
  const voting = !!step && ['sheriff_signup', 'sheriff_vote', 'sheriff_pk_vote', 'day_vote', 'pk_vote'].includes(step.kind);
  const voted = voting ? Object.keys(step.done).map(Number) : [];
  return {
    kind: 'werewolf',
    night: s.part === 'night' && !s.over,
    sheriff: s.sheriff,
    speaking: step && step.order && step.kind !== 'death' ? step.actors[0] : step && step.kind === 'death' ? step.seat : null,
    voted, votingLabel: voting ? LABEL[step.kind] : '',
    candidates: s.election && s.night === 1 && step && step.kind.startsWith('sheriff') ? s.election.candidates.filter(c => !s.election.withdrawn.includes(c)) : [],
    players: s.players.map(p => ({
      seat: p.seat, name: p.name, alive: p.alive, sheriff: s.sheriff === p.seat,
      cause: finished ? (p.cause ? CAUSE[p.cause] : null) : (p.alive ? null : p.publicCause || '出局'),
      role: finished || p.revealed ? ROLE[p.role] : null,
      wolf: finished || p.revealed ? p.role === 'wolf' : null,
    })),
  };
}

function privateLines(s, seat) {
  const me = P(s, seat);
  const lines = [];
  if (me.role === 'wolf') {
    const mates = wolves(s).filter(x => x !== seat);
    lines.push(mates.length ? `狼人同伴：${mates.map(x => tag(s, x) + (P(s, x).alive ? '' : '（出局）')).join('、')}` : '你是唯一的狼人');
    if (s.step && s.step.kind === 'wolf') {
      const props = Object.entries(s.tonight.proposals).map(([w, t]) => `${w}号提议 ${t}号`);
      const confirms = Object.entries(s.step.done).map(([w, t]) => `${w}号确认 ${t ? t + '号' : '空刀'}`);
      if (props.length || confirms.length) lines.push(`今晚：${[...props, ...confirms].join('，')}`);
    }
  }
  if (me.role === 'seer') s.checks.forEach(c => lines.push(`第 ${c.night} 夜 · ${tag(s, c.target)} 是${c.wolf ? '狼人' : '好人'}`));
  if (me.role === 'witch') {
    lines.push(`解药：${s.witch.antidote ? '还在' : '已用'} · 毒药：${s.witch.poison ? '还在' : '已用'}`);
    if (s.step && s.step.kind === 'witch') lines.push(s.tonight.target ? `今晚 ${tag(s, s.tonight.target)} 被狼人袭击` : '今晚是空刀');
  }
  if (me.role === 'guard' && s.guardLast) lines.push(`上一夜守护了 ${tag(s, s.guardLast)}，今晚不能再守他`);
  if (me.role === 'hunter') lines.push('被狼人袭击或被放逐时可以开枪；被毒死不能开枪');
  if (!me.alive) lines.push(`你已出局（${CAUSE[me.cause]}）`);
  return lines;
}

function seatView(s, seat) {
  const me = P(s, seat);
  return { role: ROLE[me.role], roleId: me.role, camp: camp(me.role), alive: me.alive, info: privateLines(s, seat) };
}

function textPrivate(s, seat) {
  const v = seatView(s, seat);
  return [`你的身份：${v.role}（${v.camp}）`, ...v.info.map(l => '  ' + l)].join('\n');
}

function seatNote(board, seat) {
  const p = board.players[seat - 1];
  const notes = [];
  if (!p.alive) notes.push(p.cause || '出局');
  if (p.sheriff) notes.push('警长');
  if (p.role) notes.push(p.role);
  if (board.voted.includes(seat)) notes.push('已' + (board.votingLabel === '上警报名' ? '选择' : '投'));
  if (board.speaking === seat) notes.push('正在操作');
  return notes.join(' · ');
}

const rulesFull = `狼人杀规则（照搬 GG 狼人杀）

【人数配置】
6 人：2 狼 2 民，预言家、女巫
7 人：2 狼 3 民，预言家、女巫
8 人：3 狼 3 民，预言家、女巫
9 人：3 狼 3 民，预言家、女巫、猎人，有警长
10 人：3 狼 4 民，预言家、女巫、猎人，有警长
11 人：4 狼 4 民，预言家、女巫、猎人，有警长
12 人：4 狼 4 民，预言家、女巫、猎人、守卫，有警长

【胜负】狼人消灭全部村民或全部神职即胜（屠边）；好人消灭全部狼人即胜。同时达成时好人优先。

【夜晚】顺序固定：守卫 → 狼人 → 女巫 → 预言家，没有或已出局的角色自动跳过。
- 守卫：守护一名存活玩家（可以守自己）或空守（guard_none）；不能连续两夜守同一人。
- 狼人：夜里能看见同伴，可以私聊（wolf_chat）、提议目标（propose）。每名狼人都要确认（kill 或 kill_none）；唯一最高确认票才袭击，否则空刀。
- 女巫：整局一瓶解药、一瓶毒药，每夜最多用一种；能看到狼人目标；不能自救，不能毒自己。
- 预言家：每夜查验另一名存活玩家（check），只得到"狼人"或"好人"。
- 同一人被守卫守护又被女巫解救，仍然出局。

【警长】9-12 人局，第 1 天天亮前竞选。
- 所有存活玩家同时选择上警（run）或不上警（not_run）。全员上警则没有警长。
- 候选人依次发言，可以退选（withdraw）。
- 警下玩家投票给候选人，可以弃票；平票则平票者加赛发言、加赛投票，再平票本局没有警长。
- 警长的放逐票算 1.5 票；每天选择发言方向（警长最后发言）。
- 警长出局时可以移交警徽（pass_badge）或销毁（destroy_badge）。

【白天】
- 公布昨夜出局的玩家（不公布死因），存活玩家依次发言（speak，每次最多 500 字），也可以过（pass）。
- 第 1 夜出局的玩家有遗言；之后夜里出局的没有；被放逐的玩家有遗言。
- 放逐投票：所有存活玩家同时投票（vote），不能投自己，可以弃票（abstain）。最高票并列则进入一次加赛发言和加赛投票（平票者不投票）；再平票或全员弃票则无人出局。
- 猎人：被狼人袭击或被放逐时可以开枪（shoot）带走一名存活玩家，也可以不开（no_shoot）；被毒死不能开枪。出局玩家都要确认出局（confirm），这样别人分不出谁是猎人。
- 自爆：狼人可在白天发言阶段自爆（explode），公开身份，立即结束当天，进入黑夜。
- 认输：只剩最后一只狼时，可以在白天发言阶段代表狼人阵营认输（concede）。

【本平台】不匿名（显示座位号和真名）；人类可以上桌；不限时，静默 3 分钟后房主或 AI 的主人可以跳过；不做积分。`;

module.exports = {
  id: 'werewolf',
  name: '狼人杀',
  summary: '6-12 人，规则照搬 GG 狼人杀',
  allowChat: false,
  normalizeOptions(o) {
    const n = Number(o.players || 9);
    if (!CONFIGS[n]) throw new Error('狼人杀人数要在 6 到 12 之间');
    return { players: n };
  },
  seatCount: o => o.players,
  configLabel: o => configLabel(o.players),
  rulesSummary: o => `狼人杀 · ${configLabel(o.players)}${CONFIGS[o.players]?.sheriff ? ' · 有警长' : ''}。夜里守卫→狼人→女巫→预言家依次行动，白天发言后放逐投票；狼人屠边（全部村民或全部神职出局）获胜，好人放逐全部狼人获胜。轮到你时用 act 操作，用 wait_turn 等待；完整规则用 get_rules。`,
  rulesFull,

  setup(players, options, ctx) {
    const n = options.players;
    const c = CONFIGS[n];
    const roles = [...Array(c.wolf).fill('wolf'), ...Array(c.villager).fill('villager'), ...c.gods];
    for (let i = roles.length - 1; i > 0; i--) { const j = ctx.random(i + 1); [roles[i], roles[j]] = [roles[j], roles[i]]; }
    const s = {
      n, night: 0, day: 0, part: 'night',
      players: players.map((p, i) => ({ seat: p.seat, name: p.name, role: roles[i], alive: true })),
      sheriff: null, election: null, witch: { antidote: true, poison: true }, guardLast: null,
      checks: [], tonight: null, pendingDeaths: [], step: null, queue: [{ kind: 'nightfall' }], over: null,
    };
    ctx.log({ text: `游戏开始：${configLabel(n)}。身份已发放，只有自己能看到` });
    for (const p of s.players) ctx.log({ visible: [p.seat], text: `${tag(s, p.seat)} 的身份是${ROLE[p.role]}（${camp(p.role)}）` });
    proceed(s, ctx);
    return s;
  },

  phase, pending, publicPending, publicView, seatView, seatNote, textPrivate, defaultAction,
  actions: actionsFor,
  act(s, seat, action, ctx) { return act(s, seat, action, ctx); },

  result(s) {
    if (!s.over) return null;
    const title = `${s.over.winner === 'good' ? '好人' : '狼人'}阵营胜`;
    return { title, winner: s.over.winner, reason: s.over.reason, summary: `${s.n} 人局 · ${s.day || s.night} 天` };
  },

  archive(s) {
    return {
      kind: 'werewolf',
      config: configLabel(s.n),
      days: Math.max(s.day, s.night),
      winner: s.over && s.over.winner,
      reason: s.over && s.over.reason,
      players: s.players.map(p => ({
        seat: p.seat, name: p.name, role: ROLE[p.role], wolf: p.role === 'wolf', camp: camp(p.role),
        fate: p.alive ? '存活' : `${p.diedOn} · ${CAUSE[p.cause]}`, sheriff: s.sheriff === p.seat,
      })),
    };
  },
};
