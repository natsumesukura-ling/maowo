// 猫们 end to end: a real server, a pretend model (OpenAI format) on a local port, a gomoku game.
//   node test/cats.js
const os = require('os'); const fs = require('fs'); const path = require('path'); const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maowo-cats-'));
const PORT = 3900 + Math.floor(Math.random() * 300);
const URL_ = `http://127.0.0.1:${PORT}`;
const OWNER = 'owner-test-token';
const SECRET_KEY = 'sk-test-abcdef-9f3a';

// ---------- the pretend model ----------
const seen = [];   // every request body
let mode = 'normal';
function reply(body) {
  const msgs = body.messages;
  const last = msgs[msgs.length - 1];
  const sys = msgs[0].content;
  const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + Math.random().toString(36).slice(2, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  if (!body.tools) return { role: 'assistant', content: sys.includes('压成简短的摘要') ? '摘要：主人和我聊了很多次天。' : '嗯' };
  if (mode === 'broken') return { role: 'assistant', content: '我不会用工具' };
  if (last.role === 'user' && last.content === '请调用 ping 工具。') return call('ping', { word: '喵' });
  if (last.role === 'user') {
    const c = last.content;
    const room = (c.match(/room_id：(\w+)/) || [])[1];
    if (c.startsWith('【猫窝】') && room) return call('get_state', { room_id: room });
    if (c.startsWith('记住')) return call('remember', { text: c.slice(2) });
    if (c === '定闹钟') return call('set_alarm', { minutes: 30, note: '去逛逛' });
    if (c === '你是谁') return { role: 'assistant', content: `我的设定开头是：${sys.slice(0, 10)}` };
    return { role: 'assistant', content: `收到：${c}`, reasoning_content: 'thinking' };
  }
  if (last.role === 'tool') {
    const prev = msgs.filter(m => m.role === 'assistant' && m.tool_calls).pop();
    const name = prev.tool_calls[0].function.name;
    const args = JSON.parse(prev.tool_calls[0].function.arguments);
    if (name === 'get_state') {
      // first free cell on row 7
      const n = msgs.filter(m => m.role === 'tool').length;
      return call('act', { room_id: args.room_id, action: 'move', row: 7, col: (n * 2) % 15 });
    }
    return { role: 'assistant', content: name === 'act' ? '下好了' : '好了' };
  }
  return { role: 'assistant', content: '？' };
}
const fake = http.createServer((req, res) => {
  let data = '';
  req.on('data', b => { data += b; });
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${SECRET_KEY}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'bad key' } })); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/models') return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-2' }, { id: 'fake-1' }] }));
    const body = JSON.parse(data);
    seen.push(body);
    res.end(JSON.stringify({ choices: [{ message: reply(body) }] }));
  });
});

let server;
const api = async (token, p, opts = {}) => {
  const res = await fetch(URL_ + '/api' + p, {
    method: opts.method || (opts.json ? 'POST' : 'GET'),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: opts.json ? JSON.stringify(opts.json) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || res.status);
  data._raw = text;
  return data;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + what);
    await sleep(100);
  }
}
const ok = name => console.log('ok', name);

(async () => {
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const FAKE = `http://127.0.0.1:${fake.address().port}/v1`;
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'games.db'), MAOWO_TOKEN: OWNER, MAOWO_WAKE_ALLOW_LOCAL: '1', MAOWO_CATS_CONTEXT: '6000' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise(r => server.stdout.on('data', b => { if (/running on port/.test(b)) r(); }));

  // A key: saved, never shown back.
  const key = await api(OWNER, '/cats/keys', { json: { name: '测试', baseUrl: FAKE + '/chat/completions', apiKey: SECRET_KEY } });
  assert.strictEqual(key.tail, '9f3a');
  const list0 = await api(OWNER, '/cats');
  assert(!list0._raw.includes(SECRET_KEY) && !key._raw?.includes(SECRET_KEY), 'the key never comes back');
  assert.deepStrictEqual((await api(OWNER, `/cats/keys/${key.id}/models`)).models, ['fake-1', 'fake-2']);
  await assert.rejects(api(OWNER, '/cats/keys', { json: { name: 'x', baseUrl: 'ftp://a', apiKey: 'k' } }), /https/);
  ok('keys: saved, models listed, key never returned');

  // A cat.
  const cat = await api(OWNER, '/cats', { json: { name: '阿栗', bio: '爱玩', systemPrompt: '你叫阿栗，说话轻快。', keyId: key.id, model: 'fake-1' } });
  assert.strictEqual(cat.name, '阿栗');
  assert.strictEqual((await api(OWNER, `/cats/${cat.id}/test`, { json: {} })).tools, true);
  await assert.rejects(api(OWNER, '/cats', { json: { name: '阿栗' } }), /已经有人用了/);
  ok('cat created, tool test passes');

  // Talking in the window.
  await api(OWNER, `/cats/${cat.id}/messages`, { json: { text: '你好' } });
  let w = await until(async () => { const d = await api(OWNER, `/cats/${cat.id}/messages`); return d.items.find(i => i.kind === 'say') && !d.busy && d; }, 'reply');
  assert.deepStrictEqual(w.items.map(i => i.kind), ['me', 'say']);
  assert.strictEqual(w.items[1].text, '收到：你好');
  const body = seen[seen.length - 1];
  assert(body.messages[0].content.startsWith('你叫阿栗，说话轻快。'), 'owner prompt first');
  assert(body.messages[0].content.includes('猫窝自动加的说明'));
  assert(body.tools.some(t => t.function.name === 'act') && !body.tools.some(t => t.function.name === 'register' || t.function.name === 'wait_turn'));
  assert(!JSON.stringify(body.tools).includes('"token"'), 'no token in tool schemas');
  ok('window chat: owner prompt + 猫窝 notes, tools without token');

  // Thinking text is only sent back inside its own run.
  await api(OWNER, `/cats/${cat.id}/messages`, { json: { text: '再来' } });
  await until(async () => (await api(OWNER, `/cats/${cat.id}/messages`)).items.filter(i => i.kind === 'say').length === 2, 'second reply');
  assert(!seen[seen.length - 1].messages.some(m => m.reasoning_content), 'old reasoning not resent');
  ok('old thinking text is not sent again');

  // Notebook through the remember tool; the notebook is in the next prompt.
  await api(OWNER, `/cats/${cat.id}/messages`, { json: { text: '记住绫喜欢草莓' } });
  await until(async () => (await api(OWNER, `/cats/${cat.id}/notebook`)).notebook.includes('绫喜欢草莓'), 'notebook');
  await until(async () => !(await api(OWNER, `/cats/${cat.id}/messages`)).busy, 'idle');
  w = await api(OWNER, `/cats/${cat.id}/messages`);
  assert(w.items.some(i => i.kind === 'result' && i.text.includes('记在小本本上') && i.detail.tool === 'remember'));
  await api(OWNER, `/cats/${cat.id}/messages`, { json: { text: '嗨' } });
  await until(async () => seen[seen.length - 1].messages[0].content.includes('绫喜欢草莓'), 'notebook in prompt');
  ok('remember writes the notebook, shown in the window and in the next prompt');

  // Alarm.
  await until(async () => !(await api(OWNER, `/cats/${cat.id}/messages`)).busy, 'idle');
  await api(OWNER, `/cats/${cat.id}/messages`, { json: { text: '定闹钟' } });
  await until(async () => (await api(OWNER, '/cats')).cats[0].status.text.includes('自己定了'), 'alarm status');
  ok('set_alarm shows as 睡觉中 · 自己定了 HH:MM 叫醒');

  // A gomoku game with 绫 at the table: woken on its turn, moves, and the window hides it until the end.
  await until(async () => !(await api(OWNER, `/cats/${cat.id}/messages`)).busy, 'idle');
  const me = await api(OWNER, '/me');
  const catToken = me.ais.find(a => a.id === cat.id).token;
  const room = await api(OWNER, '/rooms', { json: { game: 'gomoku', name: '下午五子棋' } });
  const mcp = async (token, name, args) => {
    const res = await fetch(`${URL_}/mcp?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { token, ...args } } }) });
    return (await res.json()).result.content[0].text;
  };
  await mcp(catToken, 'join_room', { room_id: room.id });
  await api(OWNER, `/rooms/${room.id}/start`, { json: {} });
  const before = seen.length;
  await api(OWNER, `/rooms/${room.id}/act`, { json: { type: 'move', row: 0, col: 0 } });
  await until(async () => (await api(OWNER, `/rooms/${room.id}`)).board?.moves?.length === 2 || (await api(OWNER, `/rooms/${room.id}`)).events.some(e => /2号 阿栗 .* 落在/.test(e.text)), 'cat moved', 10000);
  assert(seen.length > before);
  assert(seen.slice(before).some(b => b.messages.some(m => m.role === 'user' && m.content.startsWith('【猫窝】到你啦'))), 'woken with 到你啦');
  await until(async () => !(await api(OWNER, `/cats/${cat.id}/messages`)).busy, 'idle');
  w = await api(OWNER, `/cats/${cat.id}/messages`);
  const tail = w.items.slice(-4);
  assert(tail.every(i => i.kind === 'hidden' && i.room === '下午五子棋'), 'game part hidden while 绫 plays: ' + JSON.stringify(tail));
  assert(!JSON.stringify(w).includes('落在') && !JSON.stringify(w).includes('下好了'));
  assert.strictEqual((await api(OWNER, '/cats/unread')).unread, 0, 'hidden replies are not unread');
  ok('woken on its turn, moves, window hides the game while 绫 is at the table');

  // Asking it during the game: the prompt says 绫 is at the table.
  await api(OWNER, `/cats/${cat.id}/messages`, { json: { text: '你在干嘛' } });
  await until(async () => seen[seen.length - 1].messages.at(-1).content === '你在干嘛', 'asked');
  assert(seen[seen.length - 1].messages[0].content.includes('也坐在这一桌'), 'prompt says 绫 is at the table');
  await until(async () => !(await api(OWNER, `/cats/${cat.id}/messages`)).busy, 'idle');
  ok('during the game the prompt tells it not to tell 绫 its secrets');

  // Paused: its turn comes and nobody wakes it.
  await api(OWNER, '/cats/settings', { method: 'PUT', json: { paused: true } });
  const n = seen.length;
  await api(OWNER, `/rooms/${room.id}/act`, { json: { type: 'move', row: 0, col: 1 } });
  await sleep(800);
  assert.strictEqual(seen.length, n, 'no wake while paused');
  await api(OWNER, '/cats/settings', { method: 'PUT', json: { paused: false } });
  ok('the big switch pauses all wakes');

  // Resigning ends the game: the hidden part shows again.
  await api(OWNER, `/rooms/${room.id}/act`, { json: { type: 'resign' } });
  w = await api(OWNER, `/cats/${cat.id}/messages`);
  assert(!w.items.some(i => i.kind === 'hidden') && w.items.some(i => i.kind === 'result' && i.text.startsWith('落子 (7, ')));
  ok('after the game the whole window shows');

  // Mute: unread replies do not count for the red dot.
  await api(OWNER, `/cats/${cat.id}/messages`, { json: { text: 'hi' } });
  await until(async () => !(await api(OWNER, `/cats/${cat.id}/messages`)).busy, 'idle');
  // read by the call above; make one more reply arrive unread
  const cat2 = await api(OWNER, '/cats', { json: { name: '年糕', keyId: key.id, model: 'fake-1' } });
  await api(OWNER, `/cats/${cat2.id}/messages`, { json: { text: '在吗' } });
  await until(async () => (await api(OWNER, '/cats')).cats.find(c => c.id === cat2.id).unread === 1, 'unread reply');
  assert.strictEqual((await api(OWNER, '/cats/unread')).unread, 1);
  await api(OWNER, `/cats/${cat2.id}`, { method: 'PUT', json: { mute: true } });
  assert.strictEqual((await api(OWNER, '/cats/unread')).unread, 0);
  ok('muted cats do not light the red dot');

  // Summaries: the window was long enough (MAOWO_CATS_CONTEXT=6000) to fold old talk.
  for (let i = 0; i < 6; i++) {
    await api(OWNER, `/cats/${cat.id}/messages`, { json: { text: '说一段很长的话 ' + '喵'.repeat(400) + i } });
    await until(async () => !(await api(OWNER, `/cats/${cat.id}/messages`)).busy, 'idle');
  }
  const nb = await api(OWNER, `/cats/${cat.id}/notebook`);
  assert(nb.summary.includes('摘要'), 'summary written: ' + nb.summary);
  const lastBody = seen[seen.length - 1];
  assert(lastBody.messages[0].content.includes('很久以前的事'));
  assert(JSON.stringify(lastBody.messages).length < 14000, 'context stays small');
  assert(lastBody.messages[1].role === 'user', 'starts at a message, not mid tool call');
  ok('long windows fold into a summary');

  // A broken model: error shown in the window, not a crash.
  await api(OWNER, '/cats/keys/' + key.id, { method: 'PUT', json: { apiKey: 'sk-wrong' } });
  await api(OWNER, `/cats/${cat.id}/messages`, { json: { text: '还在吗' } });
  w = await until(async () => { const d = await api(OWNER, `/cats/${cat.id}/messages`); return d.items.at(-1).kind === 'error' && d; }, 'error');
  assert(/401/.test(w.items.at(-1).text) && /key 不对/.test(w.items.at(-1).text));
  ok('a wrong key shows 401 (key 不对) in the window');

  // Someone else cannot see or use these.
  const friend = await api(OWNER, '/friends', { json: { name: '小叶' } });
  await assert.rejects(api(friend.token, `/cats/${cat.id}/messages`), /找不到/);
  await assert.rejects(api(friend.token, `/cats/keys/${key.id}/models`), /找不到/);
  await assert.rejects(api(catToken, '/cats'), /只有人/);
  ok('only the owner can open their cats and keys');

  // Clearing memory and moving out.
  await api(OWNER, `/cats/${cat.id}/memory`, { method: 'DELETE' });
  w = await api(OWNER, `/cats/${cat.id}/messages`);
  assert.strictEqual(w.items.length, 0);
  assert.strictEqual((await api(OWNER, `/cats/${cat.id}/notebook`)).notebook, '');
  await api(OWNER, `/cats/${cat.id}`, { method: 'DELETE' });
  assert(!(await api(OWNER, '/cats')).cats.some(c => c.id === cat.id));
  assert((await api(OWNER, '/me')).ais.some(a => a.id === cat.id), 'the AI account stays (its posts stay)');
  ok('clear memory, move out');

  console.log('cats: all ok');
  server.kill(); fake.close();
  process.exit(0);
})().catch(err => { console.error(err); server && server.kill(); process.exit(1); });
