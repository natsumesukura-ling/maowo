// 故事: any number of separate story threads per cat, next to its one main line (cats.js).
// A story starts from a setting 绫 writes and the cat writes first. Each has its own messages and its own
// rolling summary; stories do not know each other, use no tools and are never woken by games.
// The main line hears of a story only when she sends it a summary (「告诉主线的它」).
const express = require('express');
const { db } = require('./db');
const accounts = require('./accounts');
const { kit } = require('./cats');

db.exec(`
  CREATE TABLE IF NOT EXISTS cat_stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    setting TEXT NOT NULL DEFAULT '',
    with_memory INTEGER NOT NULL DEFAULT 1,
    theme_id INTEGER,
    summary TEXT NOT NULL DEFAULT '',
    told_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cat_story_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    cut TEXT,
    summarized INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cat_story_messages_story ON cat_story_messages (story_id, id);
`);

const q = {
  of: db.prepare('SELECT * FROM cat_stories WHERE account_id = ? ORDER BY updated_at DESC, id DESC'),
  get: db.prepare('SELECT * FROM cat_stories WHERE id = ?'),
  add: db.prepare('INSERT INTO cat_stories (account_id, title, setting, with_memory, theme_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  touch: db.prepare('UPDATE cat_stories SET updated_at = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM cat_stories WHERE id = ?'),
  clear: db.prepare('DELETE FROM cat_story_messages WHERE story_id = ?'),
  msgs: db.prepare('SELECT * FROM cat_story_messages WHERE story_id = ? ORDER BY id'),
  live: db.prepare('SELECT * FROM cat_story_messages WHERE story_id = ? AND summarized = 0 ORDER BY id'),
  after: db.prepare('SELECT * FROM cat_story_messages WHERE story_id = ? AND id > ? ORDER BY id'),
  msg: db.prepare('SELECT * FROM cat_story_messages WHERE id = ? AND story_id = ?'),
  say: db.prepare('INSERT INTO cat_story_messages (story_id, role, kind, text, cut, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  last: db.prepare('SELECT * FROM cat_story_messages WHERE story_id = ? ORDER BY id DESC LIMIT 1'),
  lastId: db.prepare('SELECT MAX(id) AS id FROM cat_story_messages WHERE story_id = ?'),
  dropFrom: db.prepare('DELETE FROM cat_story_messages WHERE story_id = ? AND id >= ?'),
};

const TITLE_MAX = 24, SETTING_MAX = 8000, TEXT_MAX = 8000;
const OPENER = '（开始吧。照上面的背景设定，由你来写开场。）';
const busy = new Set();          // story ids being written right now
const liveText = new Map();      // story id -> { text, thinking }
const listeners = new Map();     // story id -> Set of fns
const changed = sid => { const set = listeners.get(sid); if (set) for (const fn of [...set]) fn(); };

function own(req) {
  const { ai, cat } = kit.mine(req);
  const st = req.params.sid ? q.get.get(Number(req.params.sid)) : null;
  if (req.params.sid && (!st || st.account_id !== ai.id)) throw new Error('找不到这段故事');
  return { ai, cat, st };
}
function info(st) {
  const last = q.last.get(st.id);
  const t = last ? last.text.replace(/\s+/g, ' ') : '';
  return {
    id: st.id, title: st.title, setting: st.setting, withMemory: !!st.with_memory, themeId: st.theme_id || null,
    told: !!st.told_at, createdAt: st.created_at, updatedAt: st.updated_at, busy: busy.has(st.id),
    last: last ? (t.length > 50 ? t.slice(0, 50) + '…' : t) : '',
  };
}
const item = r => ({ id: r.id, kind: r.kind, text: r.text, cut: r.cut || undefined, createdAt: r.created_at });
function windowData(st, after = 0) {
  const rows = after ? q.after.all(st.id, after) : q.msgs.all(st.id);
  return { story: info(st), busy: busy.has(st.id), items: rows.map(item), lastId: q.lastId.get(st.id).id || 0 };
}

// ---------- what the model is sent ----------
function systemFor(ai, cat, st) {
  const { text, user } = kit.persona(ai, cat, !!st.with_memory);
  const parts = [text, '——以下是猫窝加的说明——',
    `现在是一段独立的故事，和你平时的日常是分开的。${user}给的背景设定或要求：`, st.setting.trim() || '（没有写，自由发挥）', '',
    st.with_memory ? `你认识${user}：上面的前情提要和小本本是你们平时的事，可以带进这段故事里，但这段故事里发生的事只属于这段故事。`
      : `这段故事里你不带着平时的记忆，${user}是谁、你们是什么关系，都照背景设定来。`,
    `以【${user}的戏外指令】开头的消息，是她在戏外告诉你怎么写（换个写法、写长一点、剧情往哪走）。最优先照做，但不要在戏里回应或提到它，它只管这一条。`,
    '这里没有工具，也不用管游戏和帖子，专心写故事。'];
  if (st.summary.trim()) parts.push('', '这段故事前面发生的事（摘要）：', st.summary.trim());
  return kit.fillNames(parts.join('\n'), ai, cat);
}
const forModel = (r, user) => ({ role: r.role, content: r.kind === 'order' ? `【${user}的戏外指令】${r.text}` : r.text });
function requestFor(ai, cat, st) {
  const { user } = kit.persona(ai, cat, false);
  const rows = q.live.all(st.id).filter(r => r.kind !== 'error');
  // The first message is always the same opener, so the start of every request stays the same (cache).
  const messages = [{ role: 'user', content: OPENER }, ...rows.map(r => forModel(r, user))];
  return [{ role: 'system', content: systemFor(ai, cat, st) }, ...kit.withTailPreset(ai, cat, messages)];
}

// Older half of a long story is folded into its own summary.
async function maybeSummarize(ai, cat, st, key) {
  const rows = q.live.all(st.id).filter(r => r.kind !== 'error');
  const total = rows.reduce((n, r) => n + r.text.length, 0);
  if (total <= kit.CONTEXT_CHARS) return st;
  let keep = 0, cutAt = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) { keep += rows[i].text.length; if (keep > kit.CONTEXT_CHARS / 2) { cutAt = i + 1; break; } }
  const old = rows.slice(0, cutAt);
  if (old.length < 2) return st;
  const { user } = kit.persona(ai, cat, false);
  const body = old.map(r => `${r.role === 'user' ? user : ai.name}：${r.text}`).join('\n\n');
  const msg = await kit.callModel(key, cat.model, [
    { role: 'system', content: '你在整理一段正在进行的故事。把「之前的摘要」和「接下来的原文」合成一份新的摘要，给接着写这段故事的人看。保留：人物和他们的关系、发生过的事（按先后）、重要的原话和约定、埋下的伏笔、现在的场景和气氛。只写发生过的，不要评论，不要续写。800 到 2000 字。' },
    { role: 'user', content: `背景设定：\n${st.setting || '（无）'}\n\n之前的摘要：\n${st.summary || '（还没有）'}\n\n接下来的原文：\n${body}\n\n请写出新的摘要。` },
  ], []);
  const text = String(msg.content || '').trim().slice(0, 4000);
  if (!text) return st;
  db.transaction(() => {
    db.prepare('UPDATE cat_stories SET summary = ? WHERE id = ?').run(text, st.id);
    db.prepare('UPDATE cat_story_messages SET summarized = 1 WHERE story_id = ? AND id <= ?').run(st.id, old[old.length - 1].id);
  })();
  return q.get.get(st.id);
}

async function write(ai, cat, st) {
  if (busy.has(st.id)) return;
  busy.add(st.id);
  changed(st.id);
  const fail = text => q.say.run(st.id, 'assistant', 'error', text, null, kit.nowIso());
  try {
    const key = kit.keyOf(cat);
    if (!key) throw new Error('还没有给它选钥匙');
    if (!cat.model) throw new Error('还没有给它选模型');
    st = await maybeSummarize(ai, cat, st, key).catch(() => st);
    const msg = await kit.callModel(key, cat.model, requestFor(ai, cat, st), [], 'auto', { onText: (text, thinking) => liveText.set(st.id, { text, thinking }) });
    const content = typeof msg.content === 'string' ? msg.content.trim() : '';
    if (content) q.say.run(st.id, 'assistant', 'say', content, msg._cut || null, kit.nowIso());
    else fail(`它这次一个字都没回：${msg._cut === 'length' ? '字数用到上限了，还没开始写正文就停了（多半是思考把额度用光了）' : msg._cut === 'filter' ? '被模型那边的内容审查拦下了' : '模型回了一段空的'}。可以点「重新回答」再试一次。`);
  } catch (err) {
    fail(`出错了：${err.message}`);
  } finally {
    busy.delete(st.id);
    liveText.delete(st.id);
    q.touch.run(kit.nowIso(), st.id);
    changed(st.id);
  }
}
const idle = st => { if (busy.has(st.id)) throw new Error('它还在写，等它写完再来'); };
// Error lines are for her eyes only: they never go to the model and are swept away by the next try.
const sweepErrors = st => db.prepare("DELETE FROM cat_story_messages WHERE story_id = ? AND kind = 'error'").run(st.id);

// ---------- REST: /api/cats/:id/stories ----------
const router = express.Router({ mergeParams: true });
const wrap = kit.wrap;
router.use(accounts.requireAccount);
router.use((req, res, next) => (req.account.kind === 'human' ? next() : res.status(403).json({ error: '只有人能看故事' })));
router.get('/', wrap(req => { const { ai } = own(req); return q.of.all(ai.id).map(info); }));
router.post('/', wrap(req => {
  const { ai, cat } = own(req);
  const b = req.body || {};
  const setting = String(b.setting || '').replace(/\r\n/g, '\n').trim();
  if (!setting) throw new Error('写一点背景设定，或者告诉它你想看什么');
  if (setting.length > SETTING_MAX) throw new Error(`背景设定太长了（最多 ${SETTING_MAX} 字）`);
  const title = String(b.title || '').trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX) || setting.replace(/\s+/g, ' ').slice(0, 12);
  const now = kit.nowIso();
  const id = q.add.run(ai.id, title, setting, b.withMemory === false ? 0 : 1, b.themeId ? Number(b.themeId) : null, now, now).lastInsertRowid;
  const st = q.get.get(id);
  write(ai, cat, st);   // it writes first
  return info(st);
}));
router.get('/:sid', wrap(req => { const { st } = own(req); return windowData(st, Number(req.query.after) || 0); }));
router.put('/:sid', wrap(req => {
  const { st } = own(req);
  const b = req.body || {};
  if (b.title !== undefined) {
    const t = String(b.title || '').trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX);
    if (!t) throw new Error('给这段故事起个名字');
    db.prepare('UPDATE cat_stories SET title = ? WHERE id = ?').run(t, st.id);
  }
  if (b.themeId !== undefined) db.prepare('UPDATE cat_stories SET theme_id = ? WHERE id = ?').run(b.themeId ? Number(b.themeId) : null, st.id);
  return info(q.get.get(st.id));
}));
router.delete('/:sid', wrap(req => {
  const { st } = own(req);
  idle(st);
  db.transaction(() => { q.clear.run(st.id); q.remove.run(st.id); })();
  changed(st.id);
  return { ok: true };
}));
router.post('/:sid/messages', wrap(req => {
  const { ai, cat, st } = own(req);
  idle(st);
  let text = String(req.body.text || '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('写点什么吧');
  if (text.length > TEXT_MAX) throw new Error(`太长了（最多 ${TEXT_MAX} 字）`);
  const order = /^[$＄]/.test(text);
  if (order) text = text.replace(/^[$＄]\s*/, '');
  if (!text) throw new Error('戏外指令后面写点内容');
  sweepErrors(st);
  q.say.run(st.id, 'user', order ? 'order' : 'me', text, null, kit.nowIso());
  write(ai, cat, st);
  return { ok: true };
}));
router.get('/:sid/live', wrap(req => {
  const { st } = own(req);
  const l = liveText.get(st.id);
  return { busy: busy.has(st.id), text: l ? l.text : '', thinking: l ? !!l.thinking : false };
}));
// Long polling, like the main window: answers when something is new or after 25 s.
router.get('/:sid/wait', wrap(async (req, res) => {
  const { st } = own(req);
  const after = Number(req.query.after) || 0;
  const wasBusy = req.query.busy === '1';
  const ready = () => (q.lastId.get(st.id).id || 0) > after || busy.has(st.id) !== wasBusy || !q.get.get(st.id);
  if (!ready()) {
    await new Promise(resolve => {
      const set = listeners.get(st.id) || new Set();
      listeners.set(st.id, set);
      const done = () => { clearTimeout(timer); set.delete(done); if (!set.size) listeners.delete(st.id); resolve(); };
      const timer = setTimeout(done, 25000);
      set.add(done);
      res.on('close', done);
    });
  }
  const now = q.get.get(st.id);
  if (!now) throw new Error('找不到这段故事');
  return windowData(now, after);
}));
// 重新回答: what it wrote after her newest line (or the opening, if she has not said anything) goes, and it writes again.
router.post('/:sid/regenerate', wrap(req => {
  const { ai, cat, st } = own(req);
  idle(st);
  const rows = q.live.all(st.id);
  let i = rows.length;
  while (i > 0 && rows[i - 1].role === 'assistant') i--;
  if (i < rows.length) q.dropFrom.run(st.id, rows[i].id);
  changed(st.id);
  write(ai, cat, st);
  return { ok: true };
}));
// 从这句重来: her line and everything after it go; the words come back for the input box.
router.post('/:sid/rewind', wrap(req => {
  const { st } = own(req);
  idle(st);
  const r = q.msg.get(Number(req.body.messageId), st.id);
  if (!r || r.role !== 'user' || r.summarized) throw new Error('这句回不去了（太早，已经写进摘要了）');
  q.dropFrom.run(st.id, r.id);
  changed(st.id);
  return { text: (r.kind === 'order' ? '$ ' : '') + r.text };
}));
// 改它的话.
router.put('/:sid/messages/:mid', wrap(req => {
  const { st } = own(req);
  idle(st);
  const r = q.msg.get(Number(req.params.mid), st.id);
  if (!r || r.kind !== 'say' || r.summarized) throw new Error('这句改不了');
  const text = String(req.body.text || '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('不能改成空的');
  db.prepare('UPDATE cat_story_messages SET text = ?, cut = NULL WHERE id = ?').run(text.slice(0, 60000), r.id);
  changed(st.id);
  return item(q.msg.get(r.id, st.id));
}));
// 告诉主线的它: a summary of this story (hers, or written by the cat's model) goes into the main line's memory.
router.post('/:sid/tell', wrap(async req => {
  const { ai, cat, st } = own(req);
  idle(st);
  let text = String(req.body.text || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (!text) {
    const key = kit.keyOf(cat);
    if (!key || !cat.model) throw new Error('它还没有钥匙或模型，先自己写一段摘要吧');
    const { user } = kit.persona(ai, cat, false);
    const rows = q.live.all(st.id).filter(r => r.kind !== 'error');
    let body = rows.map(r => `${r.role === 'user' ? user : ai.name}：${r.text}`).join('\n\n');
    if (body.length > kit.CONTEXT_CHARS) body = '……' + body.slice(-kit.CONTEXT_CHARS);
    const msg = await kit.callModel(key, cat.model, [
      { role: 'system', content: `下面是${user}和「${ai.name}」演的一段故事。请写一段摘要，给平时的${ai.name}自己看：这是一段和日常分开的戏，讲了什么背景、发生了什么、最后停在哪、气氛怎么样。用第三人称，150 到 400 字，只写发生过的，不要评论，不要加标题。` },
      { role: 'user', content: `背景设定：\n${st.setting || '（无）'}\n\n${st.summary ? `更早的部分（摘要）：\n${st.summary}\n\n` : ''}原文：\n${body || '（还没有内容）'}` },
    ], []);
    text = String(msg.content || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    if (!text) throw new Error('它没写出摘要，你自己写一段吧');
  }
  kit.tellMain(ai.id, st.title, text);
  db.prepare('UPDATE cat_stories SET told_at = ? WHERE id = ?').run(kit.nowIso(), st.id);
  return { text };
}));

function removeAll(aiId) {
  for (const st of q.of.all(aiId)) { q.clear.run(st.id); q.remove.run(st.id); }
}
module.exports = { router, removeAll };
