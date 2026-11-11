// 主题 (how a chat window looks: background, bubbles, input box, narration / quote colors) and
// 全局外观 (the other pages: background, glass on the tab bar). 绫 keeps several named themes; each cat
// and each story picks one, none = the built-in warm paper look. A theme is a small JSON of numbers
// and colors: the pages turn it into CSS variables (public/chat-theme.js), nothing here knows CSS.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, DATA_DIR } = require('./db');
const accounts = require('./accounts');

db.exec(`
  CREATE TABLE IF NOT EXISTS cat_themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS looks (owner_id INTEGER PRIMARY KEY, json TEXT NOT NULL);
`);
for (const col of ['theme_id INTEGER']) { try { db.exec(`ALTER TABLE cats ADD COLUMN ${col}`); } catch { /* already there */ } }

// Background pictures: <data>/theme-images/<random>.<ext>, served at /theme-img/<name> without a login
// (CSS cannot send a token), protected by the random name like avatars.
const IMG_DIR = path.join(DATA_DIR, 'theme-images');
fs.mkdirSync(IMG_DIR, { recursive: true });
const IMG_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMG_MAX = 6 * 1024 * 1024;

const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : d);
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
const img = v => (/^\/theme-img\/[a-f0-9]{24}\.(jpg|png|webp|gif)$/.test(String(v || '')) ? String(v) : '');
const bubble = (b = {}, d) => ({ color: hex(b.color, d.color), alpha: num(b.alpha, 0, 100, d.alpha), blur: num(b.blur, 0, 40, d.blur), radius: num(b.radius, 0, 28, d.radius), ink: hex(b.ink, d.ink) });
// Only known fields, each inside its range: whatever comes in, what is stored is safe to turn into CSS.
function cleanTheme(t = {}) {
  return {
    bg: { image: img(t.bg?.image), imageAlpha: num(t.bg?.imageAlpha, 0, 100, 100), color: hex(t.bg?.color, '#f7eee1') },
    ink: hex(t.ink, '#2a1f17'),
    bar: { color: hex(t.bar?.color, '#f7eee1'), alpha: num(t.bar?.alpha, 0, 100, 100), blur: num(t.bar?.blur, 0, 40, 0) },
    input: { color: hex(t.input?.color, '#fffaf3'), alpha: num(t.input?.alpha, 0, 100, 100), blur: num(t.input?.blur, 0, 40, 0), radius: num(t.input?.radius, 0, 28, 12), ink: hex(t.input?.ink, '#2a1f17') },
    char: bubble(t.char, { color: '#fbf5ec', alpha: 100, blur: 0, radius: 18, ink: '#2a1f17' }),
    me: bubble(t.me, { color: '#f6e2cc', alpha: 100, blur: 0, radius: 18, ink: '#2a1f17' }),
    narr: { on: !!t.narr?.on, color: hex(t.narr?.color, '#85715f'), italic: t.narr?.italic !== false, hide: !!t.narr?.hide },
    quote: { on: !!t.quote?.on, color: hex(t.quote?.color, '#96491d'), bold: !!t.quote?.bold },
  };
}
function cleanLook(l = {}) {
  return {
    bg: { image: img(l.bg?.image), imageAlpha: num(l.bg?.imageAlpha, 0, 100, 100), color: hex(l.bg?.color, '#f7eee1') },
    nav: { glass: !!l.nav?.glass, alpha: num(l.nav?.alpha, 0, 100, 60), blur: num(l.nav?.blur, 0, 40, 16) },
    card: { alpha: num(l.card?.alpha, 30, 100, 100) },
  };
}

const q = {
  of: db.prepare('SELECT * FROM cat_themes WHERE owner_id = ? ORDER BY id'),
  get: db.prepare('SELECT * FROM cat_themes WHERE id = ?'),
  add: db.prepare('INSERT INTO cat_themes (owner_id, name, json, created_at) VALUES (?, ?, ?, ?)'),
  set: db.prepare('UPDATE cat_themes SET name = ?, json = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM cat_themes WHERE id = ?'),
  look: db.prepare('SELECT json FROM looks WHERE owner_id = ?'),
  setLook: db.prepare('INSERT INTO looks (owner_id, json) VALUES (?, ?) ON CONFLICT(owner_id) DO UPDATE SET json = excluded.json'),
};
const parse = (s, f) => { try { return f(JSON.parse(s)); } catch { return f({}); } };
function info(t) {
  const cats = db.prepare('SELECT account_id FROM cats WHERE theme_id = ?').all(t.id).map(r => accounts.byId(r.account_id)?.name).filter(Boolean);
  const stories = db.prepare('SELECT COUNT(*) AS n FROM cat_stories WHERE theme_id = ?').get(t.id).n;
  return { id: t.id, name: t.name, theme: parse(t.json, cleanTheme), usedBy: cats, stories };
}
const cleanName = n => { const s = String(n || '').trim().replace(/\s+/g, ' ').slice(0, 20); if (!s) throw new Error('给主题起个名字'); return s; };
// Is this theme hers? (cats.js asks before a cat picks one.)
const ownedBy = (id, ownerId) => { const t = q.get.get(Number(id)); return !!t && t.owner_id === ownerId; };
const count = ownerId => q.of.all(ownerId).length;

const router = express.Router();
const wrap = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (err) { res.status(400).json({ error: err.message }); } };
router.use(accounts.requireAccount);
// The look is read by every page of a person; themes are managed by people only.
router.get('/look', wrap(req => parse(q.look.get(req.account.id)?.json || '{}', cleanLook)));
router.use((req, res, next) => (req.account.kind === 'human' ? next() : res.status(403).json({ error: '只有人能改主题' })));
router.put('/look', wrap(req => { const l = cleanLook(req.body || {}); q.setLook.run(req.account.id, JSON.stringify(l)); return l; }));
router.get('/', wrap(req => q.of.all(req.account.id).map(info)));
router.post('/', wrap(req => {
  const id = q.add.run(req.account.id, cleanName(req.body.name), JSON.stringify(cleanTheme(req.body.theme)), new Date().toISOString()).lastInsertRowid;
  return info(q.get.get(id));
}));
const mine = req => { const t = q.get.get(Number(req.params.tid)); if (!t || t.owner_id !== req.account.id) throw new Error('找不到这个主题'); return t; };
router.put('/:tid', wrap(req => {
  const t = mine(req);
  q.set.run(req.body.name !== undefined ? cleanName(req.body.name) : t.name, JSON.stringify(req.body.theme ? cleanTheme(req.body.theme) : parse(t.json, cleanTheme)), t.id);
  return info(q.get.get(t.id));
}));
router.delete('/:tid', wrap(req => {
  const t = mine(req);
  db.transaction(() => {
    db.prepare('UPDATE cats SET theme_id = NULL WHERE theme_id = ?').run(t.id);
    db.prepare('UPDATE cat_stories SET theme_id = NULL WHERE theme_id = ?').run(t.id);
    q.remove.run(t.id);
  })();
  return { ok: true };
}));
router.post('/image', express.raw({ type: () => true, limit: IMG_MAX + 1024 }), wrap(req => {
  const ext = IMG_TYPES[String(req.get('content-type') || '').split(';')[0].trim()];
  if (!ext) throw new Error('只能用 jpg / png / webp / gif 图片');
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('图片是空的');
  if (req.body.length > IMG_MAX) throw new Error('图片太大了（最多 6MB）');
  const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(IMG_DIR, name), req.body);
  return { url: `/theme-img/${name}` };
}));

module.exports = { router, IMG_DIR, ownedBy, count, cleanTheme, cleanLook };
