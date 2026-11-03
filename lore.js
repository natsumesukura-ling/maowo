const express = require('express');
const yauzl = require('yauzl');
const { db } = require('./db');
const accounts = require('./accounts');

// ============================================================
// 世界书：每只猫自己的设定资料（人物、地点、规矩…），绫自己写，或者上传文件（txt / md / docx，
// 也能导入酒馆导出的世界书 json）。
//   常驻：每次叫醒都带上，放在 System prompt 里（不常变，不影响缓存）。
//   关键词触发：最近的聊天里出现了关键词才带上，写进那条新消息末尾的「猫窝备注」里，
//              还在窗口里的就不再重复带（省钱）。
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS cat_lore (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'always',
    keywords TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    source TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cat_lore ON cat_lore(account_id, id);
`);

const ENTRY_MAX = 100000;     // characters in one entry
const ALWAYS_MAX = 30000;     // all 常驻 entries together, in the system prompt
const TRIGGER_MAX = 8000;     // keyword entries added to one message
const FILE_MAX = 10 * 1024 * 1024;

const stmts = {
  list: db.prepare('SELECT * FROM cat_lore WHERE account_id = ? ORDER BY id'),
  get: db.prepare('SELECT * FROM cat_lore WHERE id = ?'),
  add: db.prepare(`INSERT INTO cat_lore (account_id, title, content, mode, keywords, enabled, source, created_at, updated_at)
    VALUES (@account_id, @title, @content, @mode, @keywords, @enabled, @source, @at, @at)`),
  remove: db.prepare('DELETE FROM cat_lore WHERE id = ?'),
  removeAll: db.prepare('DELETE FROM cat_lore WHERE account_id = ?'),
};

const kw = row => { try { return JSON.parse(row.keywords) || []; } catch { return []; } };
const shape = r => ({ id: r.id, title: r.title, content: r.content, mode: r.mode, keywords: kw(r), enabled: !!r.enabled, source: r.source, length: r.content.length, updatedAt: r.updated_at });
const marker = r => `【世界书：${r.title}】`;

function clean({ title, content, mode, keywords, enabled }, old = {}) {
  const out = {};
  if (title !== undefined || !old.title) {
    out.title = String(title ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!out.title) throw new Error('给这一条起个标题吧');
  }
  if (content !== undefined || old.content === undefined) {
    out.content = String(content ?? '').replace(/\r\n/g, '\n').trim();
    if (!out.content) throw new Error('内容不能是空的');
    if (out.content.length > ENTRY_MAX) throw new Error(`一条最多 ${ENTRY_MAX / 10000} 万字，太长了可以拆成几条`);
  }
  if (mode !== undefined) { if (!['always', 'keyword'].includes(mode)) throw new Error('只有「常驻」和「关键词触发」两种'); out.mode = mode; }
  if (keywords !== undefined) {
    const list = (Array.isArray(keywords) ? keywords : String(keywords).split(/[,，、;；\n]+/)).map(k => String(k).trim()).filter(Boolean);
    out.keywords = JSON.stringify([...new Set(list)].slice(0, 30).map(k => k.slice(0, 40)));
  }
  if (enabled !== undefined) out.enabled = enabled ? 1 : 0;
  return out;
}

function add(accountId, fields, source = null) {
  const f = clean(fields);
  const info = stmts.add.run({ account_id: accountId, title: f.title, content: f.content, mode: f.mode || 'always', keywords: f.keywords || '[]', enabled: f.enabled ?? 1, source, at: new Date().toISOString() });
  return stmts.get.get(info.lastInsertRowid);
}

// ---------- what the cat gets ----------
// 常驻 entries, for the system prompt.
function alwaysText(accountId) {
  const rows = stmts.list.all(accountId).filter(r => r.enabled && r.mode === 'always');
  if (!rows.length) return '';
  let out = '', left = ALWAYS_MAX;
  for (const r of rows) {
    if (left <= 0) break;
    const piece = `${marker(r)}\n${r.content}`.slice(0, left);
    out += (out ? '\n\n' : '') + piece;
    left -= piece.length;
  }
  return out;
}

// Keyword entries whose words appear in `scan` and that are not already in the window (`windowText`).
function triggeredText(accountId, scan, windowText) {
  const low = String(scan || '').toLowerCase();
  const rows = stmts.list.all(accountId).filter(r => r.enabled && r.mode === 'keyword');
  let out = '', left = TRIGGER_MAX;
  for (const r of rows) {
    if (left <= 0) break;
    if (!kw(r).some(k => low.includes(k.toLowerCase()))) continue;
    if (windowText.includes(marker(r))) continue;
    const piece = `${marker(r)}\n${r.content}`.slice(0, left);
    out += (out ? '\n\n' : '') + piece;
    left -= piece.length;
  }
  return out;
}

// ---------- reading files ----------
const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');

// The words of a .docx: word/document.xml, paragraph by paragraph.
function docxText(buf) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(new Error('这个 docx 打不开，可能坏了，或者不是 Word 文件'));
      let found = false;
      zip.on('entry', e => {
        if (e.fileName !== 'word/document.xml') return zip.readEntry();
        found = true;
        if (e.uncompressedSize > 50 * 1024 * 1024) return reject(new Error('这个文件里的文字太多了'));
        zip.openReadStream(e, (err2, stream) => {
          if (err2) return reject(err2);
          const parts = [];
          let size = 0;
          stream.on('data', b => { size += b.length; if (size > 50 * 1024 * 1024) { stream.destroy(); reject(new Error('这个文件里的文字太多了')); } else parts.push(b); });
          stream.on('end', () => {
            const xml = Buffer.concat(parts).toString('utf8')
              .replace(/<w:(instrText|delText)[^>]*>[\s\S]*?<\/w:\1>/g, '')
              .replace(/<w:tab\/>/g, '\t').replace(/<w:(br|cr)[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n');
            resolve(decode(xml.replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', () => { if (!found) reject(new Error('这个 docx 里没有找到正文')); });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

// 酒馆（SillyTavern）的世界书 json: { entries: { "0": { key: [...], content, comment, constant, disable } } }
function tavernEntries(json) {
  const raw = json && (json.entries || (Array.isArray(json) ? json : null));
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  return list.filter(e => e && typeof e.content === 'string' && e.content.trim()).map((e, i) => {
    const keys = [...(e.key || e.keys || []), ...(e.keysecondary || [])].map(String).filter(Boolean);
    return {
      title: String(e.comment || e.name || keys[0] || `条目 ${i + 1}`).slice(0, 40),
      content: e.content,
      mode: e.constant || !keys.length ? 'always' : 'keyword',
      keywords: keys,
      enabled: !(e.disable === true || e.enabled === false),
    };
  });
}

async function fromFile(accountId, name, buf) {
  if (!buf || !buf.length) throw new Error('没有收到文件');
  if (buf.length > FILE_MAX) throw new Error('文件太大了（最多 10MB）');
  const base = String(name || '文件').replace(/^.*[\\/]/, '');
  const ext = (base.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  const title = base.replace(/\.[a-z0-9]+$/i, '').slice(0, 40) || '文件';
  let text;
  if (ext === 'docx') text = await docxText(buf);
  else if (ext === 'doc') throw new Error('老的 .doc 格式读不了，请在 Word 或 WPS 里「另存为」.docx 再上传');
  else if (['txt', 'md', 'markdown', 'json', ''].includes(ext)) text = buf.toString('utf8').replace(/^\uFEFF/, '');
  else throw new Error('只支持 txt、md、docx，还有酒馆导出的世界书 json');
  if (ext === 'json') {
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('这个 json 读不懂'); }
    const entries = tavernEntries(json);
    if (!entries) throw new Error('这个 json 不像酒馆的世界书（里面没有 entries）');
    if (!entries.length) throw new Error('这本世界书里没有内容');
    return db.transaction(() => entries.map(e => add(accountId, e, base)))();
  }
  if (!text.trim()) throw new Error('文件里没有文字');
  let content = text;
  let cut = false;
  if (content.length > ENTRY_MAX) { content = content.slice(0, ENTRY_MAX); cut = true; }
  const row = add(accountId, { title, content, mode: 'always' }, base);
  return cut ? [{ ...row, cut: true }] : [row];
}

// ---------- REST: /api/cats/:id/lore ----------
const router = express.Router({ mergeParams: true });
router.use(accounts.requireAccount);
const wrap = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(400).json({ error: err.message }); } };
function owned(req) {
  const ai = accounts.byId(Number(req.params.id));
  const isCat = ai && db.prepare('SELECT 1 FROM cats WHERE account_id = ?').get(ai.id);
  if (!isCat || ai.owner_id !== req.account.id || req.account.kind !== 'human') throw new Error('找不到这只猫');
  return ai;
}
function entry(req, ai) {
  const r = stmts.get.get(Number(req.params.lid));
  if (!r || r.account_id !== ai.id) throw new Error('找不到这一条');
  return r;
}
const listOf = ai => {
  const rows = stmts.list.all(ai.id);
  return { entries: rows.map(shape), alwaysLength: rows.filter(r => r.enabled && r.mode === 'always').reduce((n, r) => n + r.content.length, 0), alwaysMax: ALWAYS_MAX };
};

router.get('/', wrap(req => listOf(owned(req))));
router.post('/', wrap(req => { const ai = owned(req); add(ai.id, req.body || {}); return listOf(ai); }));
router.post('/upload', express.raw({ type: () => true, limit: FILE_MAX + 1024 }), wrap(async req => {
  const ai = owned(req);
  const rows = await fromFile(ai.id, req.query.name, req.body);
  return { ...listOf(ai), added: rows.length, cut: rows.some(r => r.cut) };
}));
router.put('/:lid', wrap(req => {
  const ai = owned(req);
  const r = entry(req, ai);
  const f = clean(req.body || {}, r);
  const cols = Object.keys(f);
  if (cols.length) db.prepare(`UPDATE cat_lore SET ${cols.map(c => `${c} = @${c}`).join(', ')}, updated_at = @at WHERE id = @id`).run({ ...f, at: new Date().toISOString(), id: r.id });
  return listOf(ai);
}));
router.delete('/:lid', wrap(req => { const ai = owned(req); stmts.remove.run(entry(req, ai).id); return listOf(ai); }));

module.exports = { router, alwaysText, triggeredText, removeAll: id => stmts.removeAll.run(id), docxText, tavernEntries, count: id => stmts.list.all(id).length };
