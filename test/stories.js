// 故事, 主题, 置顶: a real server and a pretend model that streams.
//   node test/stories.js
const os = require('os'); const fs = require('fs'); const path = require('path'); const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maowo-stories-'));
const PORT = 4600 + Math.floor(Math.random() * 300);
const URL_ = `http://127.0.0.1:${PORT}`;
const OWNER = 'owner-test-token';
const KEY = 'sk-test-stories';
const seen = [];
const fake = http.createServer((req, res) => {
  let data = '';
  req.on('data', b => { data += b; });
  req.on('end', async () => {
    const body = JSON.parse(data || '{}');
    seen.push(body);
    const msgs = body.messages || [];
    const last = msgs[msgs.length - 1];
    const text = typeof last.content === 'string' ? last.content : '';
    const sys = msgs[0].content;
    let out = `写：${text.slice(0, 30)}`;
    if (sys.includes('你在整理一段正在进行的故事')) out = '故事摘要：他们在便利店躲雨。';
    else if (sys.includes('请写一段摘要')) out = '这是一段雨夜便利店的戏，停在两人共撑一把伞。';
    else if (text.includes('由你来写开场')) out = '*雨下得很大。*“欢迎光临。”';
    else if (text.includes('空的')) out = '';
    if (!body.stream) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: out }, finish_reason: 'stop' }] })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const put = (delta, f = null) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: f }] })}\n\n`);
    const half = Math.ceil(out.length / 2);
    if (out) { put({ content: out.slice(0, half) }); await new Promise(r => setTimeout(r, text.includes('慢') ? 900 : 30)); put({ content: out.slice(half) }, 'stop'); }
    else put({}, 'stop');
    res.write('data: [DONE]\n\n'); res.end();
  });
});

let server;
process.on('exit', () => { try { server && server.kill(); } catch {} });
const api = async (token, p, opts = {}) => {
  const res = await fetch(URL_ + '/api' + p, { method: opts.method || (opts.json ? 'POST' : 'GET'), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: opts.json ? JSON.stringify(opts.json) : undefined });
  const text = await res.text();
  const d = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(d.error || res.status);
  return d;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(60); }
}
const ok = name => console.log('ok', name);

(async () => {
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'games.db'), MAOWO_TOKEN: OWNER, MAOWO_WAKE_ALLOW_LOCAL: '1', MAOWO_CATS_CONTEXT: '600' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise(r => server.stdout.on('data', b => { if (/running on port/.test(b)) r(); }));
  const key = await api(OWNER, '/cats/keys', { json: { name: '测试', baseUrl: `http://127.0.0.1:${fake.address().port}/v1/chat/completions`, apiKey: KEY } });
  const cat = await api(OWNER, '/cats', { json: { name: '洛祁言', systemPrompt: '你是洛祁言，嘴硬心软。', keyId: key.id, model: 'm' } });
  const cat2 = await api(OWNER, '/cats', { json: { name: '阿栗', systemPrompt: '你是阿栗。', keyId: key.id, model: 'm' } });
  await api(OWNER, `/cats/${cat.id}/notebook`, { method: 'PUT', json: { notebook: '11/9 绫喜欢草莓', summary: '我们认识很久了。' } });
  const S = `/cats/${cat.id}/stories`;
  const win = id => api(OWNER, `${S}/${id}`);
  const idle = id => until(async () => { const d = await win(id); return !d.busy && d; }, 'story idle');

  // A story: she gives the setting, the cat writes first.
  await assert.rejects(api(OWNER, S, { json: { setting: ' ' } }), /背景设定/);
  const st = await api(OWNER, S, { json: { setting: '雨夜，便利店。你是店员，{{user}}是客人。', title: '雨夜便利店' } });
  assert.strictEqual(st.title, '雨夜便利店'); assert.strictEqual(st.withMemory, true);
  let d = await until(async () => { const x = await win(st.id); return !x.busy && x.items.length && x; }, 'opening');
  assert.deepStrictEqual(d.items.map(i => i.kind), ['say']);
  assert(d.items[0].text.includes('欢迎光临'));
  const first = seen.find(b => b.stream);
  assert(first.stream && !first.tools, 'streamed, no tools');
  const sys = first.messages[0].content;
  assert(sys.startsWith('你是洛祁言，嘴硬心软。'), 'her prompt first');
  assert(sys.includes('雨夜，便利店') && sys.includes('主人是客人') && !sys.includes('{{user}}'), '{{user}} filled in the setting');
  assert(sys.includes('独立的故事') && !sys.includes('get_state') && !sys.includes('remember'), 'no 猫窝 tool talk');
  assert.strictEqual(first.messages[1].role, 'user');
  ok('a story starts from her setting, the cat writes first, streamed, without tools');

  // Talking, an order from outside the story, the main line knows nothing.
  await api(OWNER, `${S}/${st.id}/messages`, { json: { text: '我没带伞' } });
  d = await until(async () => { const x = await win(st.id); return !x.busy && x.items.length === 3 && x; }, 'reply');
  assert.deepStrictEqual(d.items.map(i => i.kind), ['say', 'me', 'say']);
  await api(OWNER, `${S}/${st.id}/messages`, { json: { text: '$ 写短一点' } });
  d = await until(async () => { const x = await win(st.id); return !x.busy && x.items.length === 5 && x; }, 'order');
  assert.strictEqual(d.items[3].kind, 'order'); assert.strictEqual(d.items[3].text, '写短一点');
  assert(seen.at(-1).messages.at(-1).content.startsWith('【主人的戏外指令】写短一点'));
  assert.strictEqual((await api(OWNER, `/cats/${cat.id}/messages`)).items.length, 0, 'nothing of it in the main line');
  ok('lines, $ orders; the main line does not see the story');

  // Live text while it writes.
  await api(OWNER, `${S}/${st.id}/messages`, { json: { text: '慢慢说' } });
  const l = await until(async () => { const x = await api(OWNER, `${S}/${st.id}/live`); return x.text && x; }, 'live text');
  assert(l.busy);
  await assert.rejects(api(OWNER, `${S}/${st.id}/messages`, { json: { text: '别急' } }), /还在写/);
  await idle(st.id);
  ok('live text while it writes; one thing at a time');

  // 重新回答, 从这句重来, 改它的话.
  d = await win(st.id);
  const n0 = d.items.length;
  await api(OWNER, `${S}/${st.id}/regenerate`, { json: {} });
  d = await until(async () => { const x = await win(st.id); return !x.busy && x.items.length === n0 && x; }, 'regenerated');
  const mine = d.items.filter(i => i.kind === 'me').at(-1);
  const back = await api(OWNER, `${S}/${st.id}/rewind`, { json: { messageId: mine.id } });
  assert.strictEqual(back.text, '慢慢说');
  d = await win(st.id);
  assert(!d.items.some(i => i.id >= mine.id));
  const say = d.items.filter(i => i.kind === 'say').at(-1);
  await api(OWNER, `${S}/${st.id}/messages/${say.id}`, { method: 'PUT', json: { text: '我改过的这句' } });
  assert.strictEqual((await win(st.id)).items.find(i => i.id === say.id).text, '我改过的这句');
  ok('重新回答, 从这句重来, 改它的话');

  // An empty answer is said; the error line is not sent to the model and goes with the next try.
  await api(OWNER, `${S}/${st.id}/messages`, { json: { text: '空的' } });
  d = await until(async () => { const x = await win(st.id); return !x.busy && x.items.at(-1).kind === 'error' && x; }, 'empty');
  assert(/一个字都没回/.test(d.items.at(-1).text));
  await api(OWNER, `${S}/${st.id}/messages`, { json: { text: '再来' } });
  d = await idle(st.id);
  assert(!d.items.some(i => i.kind === 'error'));
  assert(!JSON.stringify(seen.at(-1).messages).includes('一个字都没回'));
  ok('an empty answer says so, and the error never reaches the model');

  // A long story folds its older half into its own summary.
  for (let i = 0; i < 6; i++) { await api(OWNER, `${S}/${st.id}/messages`, { json: { text: `第${i}句。` + '很长的一句话'.repeat(20) } }); await idle(st.id); }
  assert(seen.some(b => b.messages[0].content.includes('你在整理一段正在进行的故事')), 'summarized');
  assert(seen.at(-1).messages[0].content.includes('故事摘要：他们在便利店躲雨。'), 'its own summary is in the prompt');
  assert((await win(st.id)).items.length > 10, 'she still sees every line');
  ok('a long story keeps its own rolling summary');

  // With and without the main line's memory.
  assert(seen.at(-1).messages[0].content.includes('绫喜欢草莓'), 'memory comes along by default');
  const st2 = await api(OWNER, S, { json: { setting: '古风，客栈。', withMemory: false } });
  await idle(st2.id);
  const sys2 = seen.at(-1).messages[0].content;
  assert(!sys2.includes('草莓') && !sys2.includes('认识很久') && sys2.includes('不带着平时的记忆'));
  assert.strictEqual(st2.title, '古风，客栈。');
  assert(!JSON.stringify(seen.at(-1).messages).includes('便利店'), 'stories do not know each other');
  ok('带上主线的记忆 on by default; off = only the persona; stories are separate');

  // 告诉主线的它: a summary lands in the main line's memory.
  const told = await api(OWNER, `${S}/${st.id}/tell`, { json: {} });
  assert(told.text.includes('雨夜便利店的戏'));
  let main = await api(OWNER, `/cats/${cat.id}/messages`);
  assert.strictEqual(main.items.at(-1).kind, 'aside'); assert(main.items.at(-1).text.includes('共撑一把伞'));
  await api(OWNER, `${S}/${st2.id}/tell`, { json: { text: '我自己写的摘要' } });
  await api(OWNER, `/cats/${cat.id}/messages`, { json: { text: '你记得吗' } });
  await until(async () => !(await api(OWNER, `/cats/${cat.id}/messages`)).busy, 'main idle');
  const mainReq = JSON.stringify(seen.at(-1).messages);
  assert(mainReq.includes('共撑一把伞') && mainReq.includes('我自己写的摘要'), 'the main line now knows');
  const all = await api(OWNER, S);
  assert(all.length === 2 && all.every(s => s.told));
  ok('告诉主线的它: her summary or the cat\'s own, kept in the main line');

  // Only hers; deleting.
  const friend = await api(OWNER, '/friends', { json: { name: '小叶' } });
  await assert.rejects(api(friend.token, `${S}/${st.id}`), /找不到/);
  await assert.rejects(api(OWNER, `/cats/${cat2.id}/stories/${st.id}`), /找不到这段故事/);
  await api(OWNER, `${S}/${st2.id}`, { method: 'DELETE' });
  assert.strictEqual((await api(OWNER, S)).length, 1);
  await assert.rejects(win(st2.id), /找不到/);
  ok('stories belong to one cat of one owner; a story can be deleted');

  // 主题: several, one per cat or story; only safe values are kept.
  const th = await api(OWNER, '/themes', { json: { name: '水蓝', theme: { bg: { color: '#A9C8E4', image: 'https://evil.example/x.png', imageAlpha: 500 }, char: { color: 'red; } body { display: none', alpha: 62, blur: 10, radius: 14 }, narr: { on: true }, quote: { on: 1 } } } });
  assert.strictEqual(th.theme.bg.color, '#a9c8e4'); assert.strictEqual(th.theme.bg.image, ''); assert.strictEqual(th.theme.bg.imageAlpha, 100);
  assert.strictEqual(th.theme.char.color, '#fbf5ec'); assert.strictEqual(th.theme.char.alpha, 62);
  assert(th.theme.narr.on && th.theme.quote.on);
  await assert.rejects(api(OWNER, '/themes', { json: { name: ' ', theme: {} } }), /起个名字/);
  await api(OWNER, `/cats/${cat.id}`, { method: 'PUT', json: { themeId: th.id } });
  await api(OWNER, `${S}/${st.id}`, { method: 'PUT', json: { themeId: th.id } });
  assert.strictEqual((await api(OWNER, `/cats/${cat.id}`)).themeId, th.id);
  assert.strictEqual((await win(st.id)).story.themeId, th.id);
  let list = await api(OWNER, '/themes');
  assert.deepStrictEqual(list[0].usedBy, ['洛祁言']); assert.strictEqual(list[0].stories, 1);
  await assert.rejects(api(OWNER, `/cats/${cat.id}`, { method: 'PUT', json: { themeId: 9999 } }), /找不到这个主题/);
  await assert.rejects(api(friend.token, `/themes/${th.id}`, { method: 'PUT', json: { name: 'x' } }), /找不到/);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await (await fetch(URL_ + '/api/themes/image', { method: 'POST', headers: { Authorization: 'Bearer ' + OWNER, 'Content-Type': 'image/png' }, body: png })).json();
  assert(/^\/theme-img\/[a-f0-9]{24}\.png$/.test(up.url));
  assert.strictEqual((await fetch(URL_ + up.url)).status, 200);
  const th2 = await api(OWNER, `/themes/${th.id}`, { method: 'PUT', json: { theme: { ...th.theme, bg: { ...th.theme.bg, image: up.url } } } });
  assert.strictEqual(th2.theme.bg.image, up.url); assert.strictEqual(th2.name, '水蓝');
  await api(OWNER, `/themes/${th.id}`, { method: 'DELETE' });
  assert.strictEqual((await api(OWNER, `/cats/${cat.id}`)).themeId, null);
  assert.strictEqual((await win(st.id)).story.themeId, null);
  ok('主题: saved clean, picked per cat and per story, a deleted one is taken off');

  // 全局外观.
  let look = await api(OWNER, '/themes/look');
  assert.strictEqual(look.nav.glass, false); assert.strictEqual(look.card.alpha, 100);
  look = await api(OWNER, '/themes/look', { method: 'PUT', json: { bg: { image: up.url, color: '#112233' }, nav: { glass: true, alpha: 55, blur: 99 }, card: { alpha: 5 } } });
  assert.deepStrictEqual(look, { bg: { image: up.url, imageAlpha: 100, color: '#112233' }, nav: { glass: true, alpha: 55, blur: 40 }, card: { alpha: 30 } });
  assert.strictEqual((await api(friend.token, '/themes/look')).nav.glass, false, 'each person has their own');
  ok('全局外观: saved clean, one per person');

  // 置顶 and the newest line on the card.
  let home = await api(OWNER, '/cats');
  assert.deepStrictEqual(home.items.map(x => x.name), ['洛祁言', '阿栗']);
  assert(home.items[0].last && home.items[0].last.text.startsWith('写：你记得吗') && !home.items[0].last.mine, 'the newest line of the main window');
  assert.strictEqual(home.items[1].last, null);
  await api(OWNER, `/cats/${cat2.id}`, { method: 'PUT', json: { pinned: true } });
  home = await api(OWNER, '/cats');
  assert.deepStrictEqual(home.items.map(x => x.name), ['阿栗', '洛祁言']); assert(home.items[0].pinned);
  await api(OWNER, '/cats/order', { method: 'PUT', json: { items: [`c:${cat.id}`, `c:${cat2.id}`] } });
  assert.deepStrictEqual((await api(OWNER, '/cats')).items.map(x => x.name), ['阿栗', '洛祁言'], 'pinned stays in front whatever the order');
  const g = await api(OWNER, '/cats/groups', { json: { name: '小群', members: [cat.id] } });
  await api(OWNER, `/cats/groups/${g.id}`, { method: 'PUT', json: { pinned: true } });
  await api(OWNER, `/cats/${cat2.id}`, { method: 'PUT', json: { pinned: false } });
  assert.strictEqual((await api(OWNER, '/cats')).items[0].name, '小群');
  ok('置顶: pinned cats and groups come first; the card shows the newest line');

  // Moving out takes the stories along.
  await api(OWNER, `/cats/${cat.id}`, { method: 'DELETE' }).catch(async () => { await api(OWNER, `/ais/${cat.id}`, { method: 'DELETE' }); });
  await assert.rejects(win(st.id), /找不到/);
  ok('a cat that moves out takes its stories with it');

  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('all story checks passed');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
