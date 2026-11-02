// Scripted checks of specific werewolf rules against the module directly.
const assert = require('assert');
const ww = require('../games/werewolf');

function game(roles) {
  const logs = [];
  // random(n) = n - 1 makes the role shuffle a no-op, so roles follow the config order:
  // wolves, villagers, then gods. Each test lists roles in exactly that order.
  const ctx = { now: () => 0, random: n => n - 1, log: e => logs.push(e) };
  const s = ww.setup(roles.map((_, i) => ({ seat: i + 1, name: 'p' + (i + 1) })), { players: roles.length }, ctx);
  roles.forEach((r, i) => assert.strictEqual(s.players[i].role, r, 'role order'));
  const act = (seat, type, extra = {}) => {
    const out = ww.act(s, seat, { type, ...extra }, ctx);
    assert(!out.error, `${seat} ${type}: ${out.error}`);
    return out;
  };
  return { s, act, logs, ctx };
}
const nine = ['wolf', 'wolf', 'wolf', 'villager', 'villager', 'villager', 'seer', 'witch', 'hunter'];
const twelve = ['wolf', 'wolf', 'wolf', 'wolf', 'villager', 'villager', 'villager', 'villager', 'seer', 'witch', 'hunter', 'guard'];

// 同守同救: guarded and saved on the same night still dies.
{
  const { s, act } = game(twelve);
  assert.strictEqual(s.step.kind, 'guard');
  act(12, 'guard', { target: 5 });
  for (const w of [1, 2, 3, 4]) act(w, 'kill', { target: 5 });
  assert.strictEqual(s.step.kind, 'witch');
  act(10, 'save');
  act(9, 'check', { target: 1 });
  assert.strictEqual(s.step.kind, 'sheriff_signup');
  for (const x of [1,2,3,4,5,6,7,8,9,10,11,12]) act(x, 'not_run');
  assert.strictEqual(s.players[4].alive, false, 'guarded+saved should die');
  console.log('ok 同守同救');
}
// Guard alone saves; guard cannot repeat; witch cannot save herself.
{
  const { s, act } = game(twelve);
  act(12, 'guard', { target: 5 });
  for (const w of [1, 2, 3, 4]) act(w, 'kill', { target: 5 });
  act(10, 'witch_pass');
  act(9, 'check_none');
  for (const x of [1,2,3,4,5,6,7,8,9,10,11,12]) act(x, 'not_run');
  assert.strictEqual(s.players[4].alive, true, 'guarded should live');
  const witchSelf = game(twelve);
  witchSelf.act(12, 'guard_none');
  for (const w of [1, 2, 3, 4]) witchSelf.act(w, 'kill', { target: 10 });
  assert(!ww.actions(witchSelf.s, 10).some(a => a.type === 'save'), 'witch must not self-save');
  console.log('ok 守卫、女巫不能自救');
}
// Split wolf vote → no kill; peaceful night announced.
{
  const { s, act, logs } = game(nine);
  act(1, 'kill', { target: 4 }); act(2, 'kill', { target: 5 }); act(3, 'kill_none');
  act(8, 'witch_pass'); act(7, 'check', { target: 1 });
  for (let x = 1; x <= 9; x++) act(x, 'not_run');
  assert(logs.some(l => /平安夜/.test(l.text)), 'split vote should be a peaceful night');
  console.log('ok 狼人分票空刀');
}
// Sheriff 1.5 votes decide a 1 vs 1 split; poisoned hunter cannot shoot.
{
  const { s, act } = game(nine);
  for (const w of [1, 2, 3]) act(w, 'kill_none');
  act(8, 'poison', { target: 9 });
  act(7, 'check', { target: 2 });
  act(4, 'run'); for (const x of [1,2,3,5,6,7,8,9]) act(x, 'not_run');
  assert.strictEqual(s.sheriff, 4, 'only candidate becomes sheriff');
  assert.strictEqual(s.players[8].alive, false, 'poisoned hunter dies');
  assert.strictEqual(s.step.kind, 'death');
  assert(!ww.actions(s, 9).some(a => a.type === 'shoot'), 'poisoned hunter must not shoot');
  act(9, 'speak', { text: '遗言' });
  act(9, 'confirm');
  assert.strictEqual(s.step.kind, 'day_order');
  act(4, 'clockwise');
  assert.deepStrictEqual(s.step.order, [5, 6, 7, 8, 1, 2, 3, 4], 'clockwise from sheriff, sheriff last');
  for (const x of s.step.order.slice()) act(x, 'pass');
  assert.strictEqual(s.step.kind, 'day_vote');
  act(4, 'vote', { target: 1 }); act(5, 'vote', { target: 2 });
  for (const x of [1, 2, 3, 6, 7, 8]) act(x, 'abstain');
  assert.strictEqual(s.players[0].alive, false, 'sheriff 1.5 should break the tie');
  console.log('ok 警长 1.5 票、毒死的猎人不能开枪');
}
// Exiled hunter shoots; tie goes to PK, second tie means nobody leaves.
{
  const { s, act } = game(['wolf', 'wolf', 'villager', 'villager', 'seer', 'witch']);
  act(1, 'kill_none'); act(2, 'kill_none'); act(6, 'witch_pass'); act(5, 'check', { target: 1 });
  assert.strictEqual(s.step.kind, 'day_speech');
  for (const x of s.step.order.slice()) act(x, 'pass');
  act(1, 'vote', { target: 3 }); act(3, 'vote', { target: 1 });
  for (const x of [2, 4, 5, 6]) act(x, 'abstain');
  assert.strictEqual(s.step.kind, 'pk_speech');
  act(1, 'pass'); act(3, 'pass');
  assert.strictEqual(s.step.kind, 'pk_vote');
  assert.deepStrictEqual(s.step.actors, [2, 4, 5, 6], 'tied players do not vote in PK');
  act(2, 'vote', { target: 3 }); act(4, 'vote', { target: 1 }); act(5, 'abstain'); act(6, 'abstain');
  assert(s.players.every(p => p.alive), 'second tie: nobody leaves');
  assert.strictEqual(s.part, 'night');
  console.log('ok 平票加赛、再平票无人出局');
}
// Wolf explodes during the day: straight to night.
{
  const { s, act } = game(['wolf', 'wolf', 'villager', 'villager', 'seer', 'witch']);
  act(1, 'kill_none'); act(2, 'kill_none'); act(6, 'witch_pass'); act(5, 'check_none');
  act(2, 'explode');
  assert.strictEqual(s.players[1].alive, false);
  assert.strictEqual(s.part, 'night');
  assert.strictEqual(s.night, 2);
  console.log('ok 自爆');
}
// Wolves win by killing all gods (屠边).
{
  const { s, act } = game(['wolf', 'wolf', 'villager', 'villager', 'seer', 'witch']);
  act(1, 'kill', { target: 5 }); act(2, 'kill', { target: 5 });
  act(6, 'witch_pass'); act(5, 'check', { target: 1 });
  act(5, 'speak', { text: '1号是狼' }); act(5, 'confirm');
  for (const x of s.step.order.slice()) act(x, 'pass');
  act(1, 'vote', { target: 6 }); act(2, 'vote', { target: 6 }); act(3, 'abstain'); act(4, 'abstain'); act(6, 'abstain');
  assert(s.over && s.over.winner === 'wolf', 'all gods out → wolves win');
  console.log('ok 屠边');
}
console.log('all rule checks passed');
