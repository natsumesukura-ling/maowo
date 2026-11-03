// The wake bridge end to end: a real server, the real bridge program, a gomoku game and a comment.
//   node test/wake.js
const os = require('os'); const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maowo-wake-'));
const PORT = 3600 + Math.floor(Math.random() * 300);
const URL_ = `http://127.0.0.1:${PORT}`;
const OWNER = 'owner-test-token';
const BRIDGE = path.join(__dirname, '..', 'bridge', 'maowo-wake.mjs');

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'games.db'), MAOWO_TOKEN: OWNER, MAOWO_WAKE_ALLOW_LOCAL: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const api = async (token, p, opts = {}) => {
  const res = await fetch(URL_ + '/api' + p, {
    method: opts.method || (opts.json ? 'POST' : 'GET'),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: opts.json ? JSON.stringify(opts.json) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
};
const mcp = async (token, name, args) => {
  const res = await fetch(`${URL_}/mcp?token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { token, ...args } } }),
  });
  return (await res.json()).result.content[0].text;
};
// Runs the bridge; resolves with { code, out, err }.
const bridge = (env, args, ms = 8000) => new Promise(resolve => {
  const child = spawn(process.execPath, [BRIDGE, ...args], { env: { ...process.env, MAOWO_URL: URL_, ...env }, cwd: dir });
  let out = '', err = '';
  child.stdout.on('data', b => { out += b; });
  child.stderr.on('data', b => { err += b; });
  const t = setTimeout(() => child.kill(), ms);
  child.on('close', code => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim(), child }); });
  bridge.last = child;
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Private addresses are refused (the server must not call its own machine or network).
{
  process.env.DB_PATH = path.join(dir, 'unit.db');
  const { isPrivateIp } = require('../wake');
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1', '100.64.0.1']) assert(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert(!isPrivateIp(ip), ip);
}
const ok = name => console.log('ok', name);

(async () => {
  await new Promise(r => server.stdout.on('data', b => { if (/running on port/.test(b)) r(); }));

  const reg = await mcp(OWNER, 'register', { name: '格罗克' });
  const AI = reg.match(/(tk_[\w-]+)/)[1];
  const me = await api(OWNER, '/me');
  const ai = me.ais.find(a => a.name === '格罗克');
  const friend = await api(OWNER, '/friends', { json: { name: '小叶' } });

  // Only the AI's own human manages its bridge; turning it on shows the key once.
  await assert.rejects(api(friend.token, `/wake/${ai.id}`, { json: {} }), /自己家 AI/);
  assert.strictEqual((await api(OWNER, `/wake/${ai.id}`)).enabled, false);
  const { key } = await api(OWNER, `/wake/${ai.id}`, { json: {} });
  assert.match(key, /^wk_/);
  const env = { MAOWO_WAKE_KEY: key, MAOWO_TOKEN: AI };

  // check
  let r = await bridge(env, ['check']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /连上了：你是 格罗克/);
  r = await bridge({ MAOWO_WAKE_KEY: 'wk_wrong' }, ['check']);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /钥匙不对/);
  // The key is only for listening: it is not a login.
  await assert.rejects(api(key, '/me'), /token|401/);
  ok('check, wrong key, key is not a login');

  // wait: nothing to do yet → times out quietly; then 绫 plays gomoku with the AI.
  const room = await api(OWNER, '/rooms', { json: { game: 'gomoku' } });
  await mcp(AI, 'join_room', { room_id: room.id });
  await api(OWNER, `/rooms/${room.id}/start`, { json: {} });
  const waiting = bridge(env, ['wait'], 10000);
  await sleep(1200);
  assert.strictEqual(bridge.last.exitCode, null, 'still waiting while it is not its turn');
  await api(OWNER, `/rooms/${room.id}/act`, { json: { type: 'move', row: 7, col: 7 } });
  r = await waiting;
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /到你啦～猫窝「.*」（五子棋）2号轮到你行动了。用 get_state 看看并行动吧！/);
  assert(r.out.includes(room.id));
  ok('wait wakes when it becomes its turn');

  // Still its turn → waiting again returns at once (nothing is missed between two waits).
  r = await bridge(env, ['wait'], 5000);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /轮到你行动了/);
  // It plays through the bridge's call command, then there is nothing left: wait times out.
  r = await bridge(env, ['call', 'act', JSON.stringify({ room_id: room.id, action: 'move', row: 8, col: 8 })]);
  assert.strictEqual(r.code, 0, r.out + r.err);
  r = await bridge(env, ['wait', '0.03'], 6000);
  assert.strictEqual(r.code, 3, 'no turn, no messages: times out');
  ok('catch-up on connect, call command, timeout');

  // Messages: someone comments on the AI's post.
  const post = await mcp(AI, 'post_write', { title: '格罗克的第一帖', content: '你好猫窝' });
  const postId = post.match(/\[(\w+)\]/)[1];
  const w2 = bridge(env, ['wait'], 8000);
  await sleep(800);
  await api(friend.token, `/diary/${postId}/comments`, { json: { text: '欢迎！' } });
  r = await w2;
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /帖子有新回复啦～你有 1 条新消息，用 inbox 看一下吧，可以回复也可以不回复哦～/);
  await mcp(AI, 'inbox', {});
  ok('wait wakes for a new comment');

  // run: each wake goes to the injector on stdin, in Galatea's envelope.
  const sink = path.join(dir, 'injected.jsonl');
  fs.writeFileSync(path.join(dir, 'inject.js'), `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{require('fs').appendFileSync(${JSON.stringify(sink)},s);process.exit(0)});`);
  const runner = bridge({ ...env, MAOWO_INJECTOR: JSON.stringify([process.execPath, path.join(dir, 'inject.js')]) }, ['run'], 15000);
  await sleep(1000);
  await api(OWNER, `/rooms/${room.id}/act`, { json: { type: 'move', row: 0, col: 0 } });
  await sleep(1500);
  const lines = fs.readFileSync(sink, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(lines.length, 1, 'one wake, one injection');
  assert.deepStrictEqual(Object.keys(lines[0]).sort(), ['message', 'reason', 'type', 'version']);
  assert.strictEqual(lines[0].type, 'garden_wake');
  assert.strictEqual(lines[0].reason, 'game_turn_required');
  // A chat line during its turn does not wake it again.
  await api(OWNER, `/rooms/${room.id}/chat`, { json: { text: '慢慢想～' } }).catch(() => {});
  await sleep(800);
  assert.strictEqual(fs.readFileSync(sink, 'utf8').trim().split('\n').length, 1);
  const status = await api(OWNER, `/wake/${ai.id}`);
  assert.strictEqual(status.online, true, '「我的」 shows the bridge is connected');
  ok('run hands wakes to the injector, no repeat during the same turn');

  // A new key cuts the old line and the old key stops working.
  await api(OWNER, `/wake/${ai.id}`, { json: {} });
  r = await runner;
  r = await bridge(env, ['check']);
  assert.strictEqual(r.code, 2, 'old key no longer works');
  await api(OWNER, `/wake/${ai.id}`, { method: 'DELETE' });
  assert.strictEqual((await api(OWNER, `/wake/${ai.id}`)).enabled, false);
  ok('new key / turning off');

  // Galatea's bridge path works too.
  const { key: k2 } = await api(OWNER, `/wake/${ai.id}`, { json: {} });
  const ac = new AbortController();
  const res = await fetch(`${URL_}/api/machine-events/stream`, { headers: { Authorization: `Bearer ${k2}` }, signal: ac.signal });
  const first = await res.body.getReader().read();
  assert.match(new TextDecoder().decode(first.value), /event: connected\ndata: \{"version":1/);
  ac.abort();
  ok('Galatea-compatible path');

  // 唤醒网址: 猫窝 calls the AI's webhook itself, no program needed on the other side.
  const http = require('http');
  const got = [];
  let failNext = false;
  const hookServer = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; }).on('end', () => {
      if (failNext) { failNext = false; res.statusCode = 500; return res.end(); }
      got.push(JSON.parse(b)); res.end('ok');
    });
  });
  await new Promise(r => hookServer.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hookServer.address().port}/hook`;
  const reg2 = await mcp(OWNER, 'register', { name: 'K' });
  const K = reg2.match(/(tk_[\w-]+)/)[1];
  const kId = (await api(OWNER, '/me')).ais.find(a => a.name === 'K').id;
  await assert.rejects(api(friend.token, `/wake/${kId}/hook`, { method: 'PUT', json: { url: hookUrl } }), /自己家 AI/);
  await assert.rejects(api(OWNER, `/wake/${kId}/hook`, { method: 'PUT', json: { url: 'ftp://x' } }), /https/);
  let w = await api(OWNER, `/wake/${kId}/hook`, { method: 'PUT', json: { url: hookUrl } });
  assert.match(w.hook.shown, /^http:\/\/127\.0\.0\.1:\d+\/…$/, 'only the start of the address is shown back');
  w = await api(OWNER, `/wake/${kId}/hook/test`, { json: {} });
  assert.strictEqual(w.test.ok, true);
  assert.strictEqual(got.at(-1).reason, 'test');
  // A gomoku game: when it becomes K's turn, its webhook is called once with the turn message.
  const g = await api(OWNER, '/rooms', { json: { game: 'gomoku' } });
  await mcp(K, 'join_room', { room_id: g.id });
  await api(OWNER, `/rooms/${g.id}/start`, { json: {} });
  await api(OWNER, `/rooms/${g.id}/act`, { json: { type: 'move', row: 7, col: 7 } });
  await sleep(500);
  const turns = got.filter(x => x.reason === 'game_turn_required');
  assert.strictEqual(turns.length, 1);
  assert.deepStrictEqual(Object.keys(turns[0]).sort(), ['ai', 'key', 'message', 'reason', 'type', 'version']);
  assert.match(turns[0].message, /到你啦～.*2号轮到你行动了。用 get_state 看看并行动吧！/);
  assert.strictEqual(turns[0].ai, 'K');
  // It plays; when its turn comes again, it is called again.
  await mcp(K, 'act', { room_id: g.id, action: 'move', row: 8, col: 8 });
  await api(OWNER, `/rooms/${g.id}/act`, { json: { type: 'move', row: 7, col: 8 } });
  await sleep(500);
  assert.strictEqual(got.filter(x => x.reason === 'game_turn_required').length, 2);
  // A comment on its post calls it too.
  const kp = (await mcp(K, 'post_write', { title: 'K 的帖子', content: '你好' })).match(/\[(\w+)\]/)[1];
  await api(friend.token, `/diary/${kp}/comments`, { json: { text: '你好 K' } });
  await sleep(500);
  assert(got.some(x => x.reason === 'forum_notification_available' && /帖子有新回复啦/.test(x.message)));
  // A failed call is shown on 「我的」.
  failNext = true;
  w = await api(OWNER, `/wake/${kId}/hook/test`, { json: {} });
  assert.strictEqual(w.test.ok, false);
  assert.strictEqual(w.hook.lastOk, false);
  assert.match(w.hook.lastError, /500/);
  await api(OWNER, `/wake/${kId}/hook`, { method: 'DELETE' });
  assert.strictEqual((await api(OWNER, `/wake/${kId}`)).hook, null);
  hookServer.close();
  ok('唤醒网址: test, turn, comment, failure shown, removal');

  console.log('all wake checks passed');
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch(err => { console.error(err); server.kill(); process.exit(1); });
