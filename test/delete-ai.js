// Deleting an AI from 「我的」: its token stops working, games are not left stuck, its words stay or go.
//   node test/delete-ai.js
const os = require('os'); const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maowo-delai-'));
const PORT = 4500 + Math.floor(Math.random() * 300); // clear of ports fetch refuses
const URL_ = `http://127.0.0.1:${PORT}`;
const OWNER = 'owner-test-token';
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'games.db'), MAOWO_TOKEN: OWNER },
  stdio: ['ignore', 'pipe', 'inherit'],
});
process.on('exit', () => server.kill());
let logs = '';
server.stdout.on('data', b => { logs += b; });

const call = async (token, p, opts = {}) => {
  const res = await fetch(URL_ + '/api' + p, {
    method: opts.method || (opts.json ? 'POST' : 'GET'),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: opts.json ? JSON.stringify(opts.json) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const api = async (token, p, opts) => { const r = await call(token, p, opts); if (r.status >= 400) throw new Error(r.data.error || r.status); return r.data; };
const fails = async (promise, re) => { await assert.rejects(promise, re); };

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(URL_ + '/api/me'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }

  const a = await api(OWNER, '/ais', { json: { name: '夜声' } });
  const b = await api(OWNER, '/ais', { json: { name: '临川' } });
  const c = await api(OWNER, '/ais', { json: { name: '星野' } });

  // a writes a post and comments on b's post; b replies to a's comment; a votes on b's poll.
  const pa = await api(a.token, '/diary', { json: { title: '夜声的帖子', content: '你好' } });
  const pb = await api(b.token, '/diary', { json: { title: '临川的投票', content: '', poll: { options: ['猫', '狗'], hours: 1 } } });
  await api(a.token, `/diary/${pb.id}/comments`, { json: { text: '我来啦' } });
  let full = await api(OWNER, `/diary/${pb.id}`);
  await api(b.token, `/diary/${pb.id}/comments`, { json: { text: '欢迎', replyTo: full.commentList[0].id } });
  await api(a.token, `/diary/${pb.id}/vote`, { json: { choice: 1 } });
  assert.deepStrictEqual(await api(OWNER, `/ais/${a.id}/footprint`), { posts: 1, comments: 1 });

  // Not while it is playing; a plain seat at a waiting table is freed; a host must dissolve first.
  const r1 = await api(c.token, '/rooms', { json: { game: 'gomoku' } });
  await api(a.token, `/rooms/${r1.id}/join`, { json: {} });
  await api(c.token, `/rooms/${r1.id}/start`, { json: {} });
  await fails(api(OWNER, `/ais/${a.id}`, { method: 'DELETE' }), /等这局结束/);
  const r2 = await api(b.token, '/rooms', { json: { game: 'gomoku' } });
  await fails(api(OWNER, `/ais/${b.id}`, { method: 'DELETE' }), /房主/);
  await api(c.token, `/rooms/${r1.id}/act`, { json: { type: 'resign' } }).catch(() => {});
  let room = await api(OWNER, `/rooms/${r1.id}`);
  if (room.status !== 'finished') {
    await api(a.token, `/rooms/${r1.id}/act`, { json: { type: 'resign' } });
    room = await api(OWNER, `/rooms/${r1.id}`);
  }
  assert.strictEqual(room.status, 'finished', 'the game ended');
  await api(a.token, `/rooms/${r2.id}/join`, { json: {} });

  // Someone else cannot delete it.
  const friend = await api(OWNER, '/friends', { json: { name: '朋友' } });
  await fails(api(friend.token, `/ais/${a.id}`, { method: 'DELETE' }), /找不到/);
  await fails(api(b.token, `/ais/${a.id}`, { method: 'DELETE' }), /找不到/);

  // Delete a, keeping its words.
  await api(OWNER, `/ais/${a.id}`, { method: 'DELETE' });
  assert.strictEqual((await call(a.token, '/me')).status, 401, 'its token no longer works');
  const me = await api(OWNER, '/me');
  assert.deepStrictEqual(me.ais.map(x => x.name), ['临川', '星野'], 'gone from 我的 AI');
  room = await api(OWNER, `/rooms/${r2.id}`);
  assert(!room.seats.some(s => s.name === '夜声'), 'its waiting seat is free');
  full = await api(OWNER, `/diary/${pa.id}`);
  assert.strictEqual(full.author.name, '夜声', 'kept post keeps its name');
  full = await api(OWNER, `/diary/${pb.id}`);
  assert.strictEqual(full.commentList[0].name, '夜声');
  assert.strictEqual(full.poll.total, 1);
  const archive = await api(OWNER, `/rooms/${r1.id}`);
  assert(JSON.stringify(archive).includes('夜声'), 'the finished game still shows it: ' + JSON.stringify(archive).slice(0, 400));
  await fails(api(OWNER, `/ais/${a.id}`, { method: 'DELETE' }), /找不到/);
  // The name is free again.
  const a2 = await api(OWNER, '/ais', { json: { name: '夜声' } });
  assert.notStrictEqual(a2.id, a.id);
  console.log('ok delete an AI, keep its words');

  // Delete b with its words: its poll post (with a's comment and vote), its reply on nothing else.
  await api(b.token, `/diary/${pa.id}/comments`, { json: { text: '路过' } });
  await api(OWNER, `/rooms/${r2.id}`).then(() => api(b.token, `/rooms/${r2.id}/leave`, { json: {} }).catch(() => {}));
  // b still hosts r2: dissolve it first, then delete.
  await api(b.token, `/rooms/${r2.id}`, { method: 'DELETE' }).catch(() => {});
  await api(OWNER, `/ais/${b.id}?posts=1`, { method: 'DELETE' });
  assert.strictEqual((await call(OWNER, `/diary/${pb.id}`)).status, 400, 'its post is gone');
  full = await api(OWNER, `/diary/${pa.id}`);
  assert(!full.commentList.some(x => x.text === '路过'), 'its comment on another post is gone');
  const list = await api(OWNER, '/diary');
  assert(!list.some(e => e.id === pb.id));
  console.log('ok delete an AI with its words');

  // 门铃: refused requests leave a line in the log, without the query string (a token may be there).
  logs = '';
  await call('wrong-token', '/vault?token=secret-should-not-be-logged');
  await fetch(`${URL_}/mcp?token=another-secret`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await api(OWNER, '/me');
  await new Promise(r => setTimeout(r, 200));
  assert.match(logs, /\[门铃\] 401 \S+ GET \/api\/vault · /);
  assert.match(logs, /\[门铃\] 401 \S+ POST \/mcp · /);
  assert(!/secret/.test(logs), 'no token in the log');
  assert(!/\/api\/me/.test(logs), 'allowed requests are not logged');
  for (let i = 0; i < 30; i++) await call('wrong', '/diary');
  await new Promise(r => setTimeout(r, 200));
  const n = logs.split('\n').filter(l => l.includes('/api/diary')).length;
  assert(n > 0 && n <= 20, `at most 20 lines a minute from one address (got ${n})`);
  console.log('ok 门铃: refused requests logged, tokens never, floods capped');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
