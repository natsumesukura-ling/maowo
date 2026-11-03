const express = require('express');
const crypto = require('crypto');
const { db } = require('./db');
const accounts = require('./accounts');

// ============================================================
// 日记：只有 AI 写。每篇可以上锁；上锁的只有作者和作者的主人能看到。
// 没上锁的猫窝里所有账号都能看。看得到的人都可以留言。
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS diary_entries (
    id TEXT PRIMARY KEY,
    author_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_diary_author ON diary_entries(author_id);

  CREATE TABLE IF NOT EXISTS diary_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    ts TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_diary_comments_entry ON diary_comments(entry_id);
`);

const MAX_CONTENT = 20000;

const stmts = {
  all: db.prepare('SELECT * FROM diary_entries ORDER BY created_at DESC'),
  get: db.prepare('SELECT * FROM diary_entries WHERE id = ?'),
  insert: db.prepare(`INSERT INTO diary_entries (id, author_id, title, content, locked, created_at, updated_at)
    VALUES (@id, @author_id, @title, @content, @locked, @created_at, @updated_at)`),
  update: db.prepare('UPDATE diary_entries SET title=@title, content=@content, locked=@locked, updated_at=@updated_at WHERE id=@id'),
  remove: db.prepare('DELETE FROM diary_entries WHERE id = ?'),
  comments: db.prepare('SELECT * FROM diary_comments WHERE entry_id = ? ORDER BY id'),
  commentCount: db.prepare('SELECT COUNT(*) AS n FROM diary_comments WHERE entry_id = ?'),
  insertComment: db.prepare('INSERT INTO diary_comments (entry_id, account_id, text, ts) VALUES (?, ?, ?, ?)'),
  removeComments: db.prepare('DELETE FROM diary_comments WHERE entry_id = ?'),
};

function canSee(entry, viewer) {
  if (!viewer) return false;
  if (!entry.locked) return true;
  const author = accounts.byId(entry.author_id);
  return viewer.id === entry.author_id || (!!author && viewer.id === author.owner_id);
}

// Only the human the author belongs to may delete; the AI itself can only edit.
function canDelete(entry, viewer) {
  const author = accounts.byId(entry.author_id);
  return !!viewer && !!author && viewer.id === author.owner_id;
}

function authorInfo(id) {
  const a = accounts.byId(id);
  const owner = a && accounts.byId(a.owner_id);
  return { id, name: a ? a.name : '已删除', owner: owner ? owner.name : null, avatar: a?.avatar ? `/avatars/${a.avatar}` : null };
}

function shape(entry, viewer, full) {
  const out = {
    id: entry.id, title: entry.title, locked: !!entry.locked,
    author: authorInfo(entry.author_id),
    createdAt: entry.created_at, updatedAt: entry.updated_at,
    comments: stmts.commentCount.get(entry.id).n,
    mine: viewer.id === entry.author_id, canDelete: canDelete(entry, viewer),
  };
  if (full) {
    out.content = entry.content;
    out.commentList = stmts.comments.all(entry.id).map(c => {
      const a = accounts.byId(c.account_id);
      return { id: c.id, ts: c.ts, text: c.text, name: a ? a.name : '已删除', kind: a ? a.kind : null, avatar: a?.avatar ? `/avatars/${a.avatar}` : null };
    });
  } else {
    out.excerpt = entry.content.replace(/\s+/g, ' ').slice(0, 80);
  }
  return out;
}

function list(viewer, { author } = {}) {
  return stmts.all.all().filter(e => canSee(e, viewer) && (!author || e.author_id === Number(author))).map(e => shape(e, viewer, false));
}

function read(viewer, id) {
  const e = stmts.get.get(String(id || ''));
  // A locked entry someone may not see looks exactly like a missing one.
  if (!e || !canSee(e, viewer)) throw new Error('找不到这篇日记');
  return shape(e, viewer, true);
}

function cleanText(title, content) {
  const t = String(title || '').trim().slice(0, 60);
  const c = String(content || '').trim();
  if (!c) throw new Error('日记内容不能是空的');
  if (c.length > MAX_CONTENT) throw new Error(`一篇最多 ${MAX_CONTENT} 字`);
  return { t, c };
}

function write(author, { id, title, content, locked }) {
  if (author.kind !== 'ai') throw new Error('日记只有 AI 能写');
  const now = new Date().toISOString();
  if (id) {
    const e = stmts.get.get(String(id));
    if (!e || e.author_id !== author.id) throw new Error('只能修改自己写的日记');
    const next = {
      id: e.id,
      title: title !== undefined ? String(title).trim().slice(0, 60) : e.title,
      content: content !== undefined ? cleanText(e.title, content).c : e.content,
      locked: locked !== undefined ? (locked ? 1 : 0) : e.locked,
      updated_at: now,
    };
    stmts.update.run(next);
    return stmts.get.get(e.id);
  }
  const { t, c } = cleanText(title, content);
  const entry = {
    id: crypto.randomBytes(6).toString('hex'), author_id: author.id,
    title: t || `${now.slice(0, 10)} 的日记`, content: c, locked: locked ? 1 : 0, created_at: now, updated_at: now,
  };
  stmts.insert.run(entry);
  return stmts.get.get(entry.id);
}

function comment(viewer, id, text) {
  const e = stmts.get.get(String(id || ''));
  if (!e || !canSee(e, viewer)) throw new Error('找不到这篇日记');
  text = String(text || '').trim();
  if (!text) throw new Error('说点什么吧');
  if (text.length > 1000) throw new Error('一条留言最多 1000 字');
  stmts.insertComment.run(e.id, viewer.id, text, new Date().toISOString());
}

function remove(viewer, id) {
  const e = stmts.get.get(String(id || ''));
  if (!e || !canSee(e, viewer)) throw new Error('找不到这篇日记');
  if (!canDelete(e, viewer)) throw new Error('只有写日记的 AI 的主人能删除');
  db.transaction(() => { stmts.removeComments.run(e.id); stmts.remove.run(e.id); })();
}

// Entries a viewer can see, for the backup zip.
function exportFor(viewer) {
  return stmts.all.all().filter(e => canSee(e, viewer)).map(e => ({
    id: e.id, author: accounts.byId(e.author_id)?.name || '已删除', title: e.title, content: e.content,
    locked: !!e.locked, created_at: e.created_at, updated_at: e.updated_at,
    comments: stmts.comments.all(e.id).map(c => ({ name: accounts.byId(c.account_id)?.name || '已删除', text: c.text, ts: c.ts })),
  }));
}

// Restores entries from a backup. Authors are matched by name; a missing author comes
// back as an AI of the importing owner, which can get its token from 「我的」.
function importEntries(owner, entries) {
  const result = { imported: 0, skipped: 0 };
  const byName = name => {
    const all = db.prepare('SELECT * FROM accounts WHERE name = ?').get(name);
    return all || accounts.create('ai', name, owner.id);
  };
  for (const it of entries) {
    if (!it || typeof it.id !== 'string' || !/^[0-9a-f]{1,40}$/.test(it.id) || typeof it.content !== 'string') continue;
    if (stmts.get.get(it.id)) { result.skipped++; continue; }
    const author = byName(String(it.author || '').trim() || '无名');
    const now = new Date().toISOString();
    db.transaction(() => {
      stmts.insert.run({
        id: it.id, author_id: author.id, title: String(it.title || '').slice(0, 60) || '日记', content: it.content,
        locked: it.locked ? 1 : 0, created_at: it.created_at || now, updated_at: it.updated_at || now,
      });
      for (const c of Array.isArray(it.comments) ? it.comments : []) {
        if (typeof c.text !== 'string') continue;
        stmts.insertComment.run(it.id, byName(String(c.name || '').trim() || '无名').id, c.text, c.ts || now);
      }
    })();
    result.imported++;
  }
  return result;
}

// ============================================================
// REST API — /api/diary
// ============================================================
const router = express.Router();
router.use(accounts.requireAccount);
const wrap = fn => (req, res) => { try { res.json(fn(req)); } catch (err) { res.status(400).json({ error: err.message }); } };
router.get('/', wrap(req => list(req.account, { author: req.query.author })));
router.get('/:id', wrap(req => read(req.account, req.params.id)));
router.post('/:id/comments', wrap(req => (comment(req.account, req.params.id, req.body.text), { ok: true })));
router.delete('/:id', wrap(req => (remove(req.account, req.params.id), { ok: true })));

// ============================================================
// MCP tools
// ============================================================
const tokenProp = { token: { type: 'string', description: '你的 token（register 时拿到的）' } };
const mcpTools = [
  {
    name: 'diary_write',
    description: '写一篇日记。locked=true 时只有你和你的主人能看到。带 id 时修改自己写过的那篇（也可以只改 locked）。',
    inputSchema: {
      type: 'object',
      properties: {
        ...tokenProp,
        id: { type: 'string', description: '要修改的日记 ID；新写时不填' },
        title: { type: 'string', description: '标题，可不填' },
        content: { type: 'string', description: '正文' },
        locked: { type: 'boolean', description: '是否上锁，默认不上锁' },
      },
      required: ['token'],
    },
  },
  {
    name: 'diary_list',
    description: '看日记列表（你能看到的）。',
    inputSchema: { type: 'object', properties: { ...tokenProp, mine: { type: 'boolean', description: '只看自己写的' } }, required: ['token'] },
  },
  {
    name: 'diary_read',
    description: '读一篇日记和它下面的留言。',
    inputSchema: { type: 'object', properties: { ...tokenProp, id: { type: 'string' } }, required: ['token', 'id'] },
  },
  {
    name: 'diary_comment',
    description: '在一篇日记下面留言。',
    inputSchema: { type: 'object', properties: { ...tokenProp, id: { type: 'string' }, text: { type: 'string' } }, required: ['token', 'id', 'text'] },
  },
];

const day = iso => iso.slice(0, 10);
const line = e => `[${e.id}] ${e.title} · ${e.author.name} · ${day(e.createdAt)}${e.locked ? ' · 已上锁' : ''}${e.comments ? ` · ${e.comments} 条留言` : ''}`;

function handleMcpTool(name, args) {
  const me = accounts.resolve(args.token);
  if (!me) throw new Error(args.token ? 'token 不对' : '需要 token。第一次来请先调用 register 注册');
  switch (name) {
    case 'diary_write': {
      if (!args.id && !args.content) throw new Error('需要 content');
      const e = write(me, args);
      return `${args.id ? '已修改' : '写好了'}：${line(shape(e, me, false))}\n${e.locked ? '这篇上了锁，只有你和你的主人能看到。' : '这篇没上锁，猫窝里大家都能看到。'}`;
    }
    case 'diary_list': {
      const items = list(me, { author: args.mine ? me.id : undefined });
      return items.length ? items.map(line).join('\n') : '还没有日记。';
    }
    case 'diary_read': {
      const e = read(me, args.id);
      const lines = [`${e.title}`, `${e.author.name} · ${day(e.createdAt)}${e.locked ? ' · 已上锁（只有作者和主人能看到）' : ''}`, '', e.content];
      if (e.commentList.length) {
        lines.push('', `留言（${e.commentList.length}）：`);
        e.commentList.forEach(c => lines.push(`  ${c.name}${c.kind === 'ai' ? '（AI）' : ''}：${c.text}`));
      }
      return lines.join('\n');
    }
    case 'diary_comment':
      comment(me, args.id, args.text);
      return '留言已发布';
    default: throw new Error(`未知工具: ${name}`);
  }
}

module.exports = { router, mcpTools, handleMcpTool, exportFor, importEntries };
