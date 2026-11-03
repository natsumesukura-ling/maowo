const crypto = require('crypto');
const express = require('express');
const { db } = require('./db');
const accounts = require('./accounts');

// ============================================================
// Bug book: anyone in maowo can report a problem from the 开发中 page.
// The owner (or the owner's AIs over MCP) marks it fixed, so the next AI
// working on maowo can read what is still open.
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS bugs (
    id TEXT PRIMARY KEY,
    author_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const stmts = {
  all: db.prepare("SELECT * FROM bugs ORDER BY status = 'done', created_at DESC"),
  get: db.prepare('SELECT * FROM bugs WHERE id = ?'),
  insert: db.prepare(`INSERT INTO bugs (id, author_id, text, status, note, created_at, updated_at)
    VALUES (@id, @author_id, @text, 'open', NULL, @now, @now)`),
  update: db.prepare('UPDATE bugs SET status = @status, note = @note, updated_at = @now WHERE id = @id'),
  remove: db.prepare('DELETE FROM bugs WHERE id = ?'),
};

const MAX_TEXT = 2000;

function shape(b) {
  const a = accounts.byId(b.author_id);
  return {
    id: b.id, text: b.text, status: b.status, note: b.note || '',
    author: { id: b.author_id, name: a ? a.name : '已删除', kind: a ? a.kind : null, avatar: a?.avatar ? `/avatars/${a.avatar}` : null },
    createdAt: b.created_at, updatedAt: b.updated_at,
  };
}

function list() { return stmts.all.all().map(shape); }

function report(author, text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('写一下哪里不对劲吧');
  if (t.length > MAX_TEXT) throw new Error(`最多 ${MAX_TEXT} 个字`);
  const id = crypto.randomBytes(4).toString('hex');
  stmts.insert.run({ id, author_id: author.id, text: t, now: new Date().toISOString() });
  return shape(stmts.get.get(id));
}

// Only the owner side may close, reopen or delete a report.
function update(editor, id, { status, note }) {
  if (!accounts.isOwnerSide(editor)) throw new Error('只有主人和主人的 AI 能改状态');
  const b = stmts.get.get(id);
  if (!b) throw new Error('找不到这条');
  const s = status === undefined ? b.status : status;
  if (!['open', 'done'].includes(s)) throw new Error('状态只能是 open 或 done');
  const n = note === undefined ? b.note : String(note || '').trim().slice(0, 500) || null;
  stmts.update.run({ id, status: s, note: n, now: new Date().toISOString() });
  return shape(stmts.get.get(id));
}

function remove(editor, id) {
  if (!editor?.is_owner) throw new Error('只有主人能删除');
  if (!stmts.remove.run(id).changes) throw new Error('找不到这条');
}

// ============================================================
// REST API — /api/bugs
// ============================================================
const router = express.Router();
router.use(accounts.requireAccount);
const wrap = fn => (req, res) => { try { res.json(fn(req)); } catch (err) { res.status(400).json({ error: err.message }); } };
router.get('/', wrap(() => list()));
router.post('/', wrap(req => report(req.account, req.body.text)));
router.put('/:id', wrap(req => update(req.account, req.params.id, req.body)));
router.delete('/:id', wrap(req => (remove(req.account, req.params.id), { ok: true })));

// ============================================================
// MCP tools
// ============================================================
const tokenProp = { token: { type: 'string', description: '你的 token（register 时拿到的）' } };
const mcpTools = [
  {
    name: 'bug_list',
    description: '看大家在「开发中」页面提交的 Bug 和意见。默认只看还没修的。',
    inputSchema: { type: 'object', properties: { ...tokenProp, all: { type: 'boolean', description: '连修好的也一起看' } }, required: ['token'] },
  },
  {
    name: 'bug_report',
    description: '提交一条 Bug 或意见。',
    inputSchema: { type: 'object', properties: { ...tokenProp, text: { type: 'string' } }, required: ['token', 'text'] },
  },
  {
    name: 'bug_update',
    description: '把一条 Bug 标成修好了（done）或重新打开（open），可以附一句说明。只有主人的 AI 能用。',
    inputSchema: {
      type: 'object',
      properties: { ...tokenProp, id: { type: 'string' }, status: { type: 'string', enum: ['open', 'done'] }, note: { type: 'string' } },
      required: ['token', 'id'],
    },
  },
];

const line = b => `[${b.id}] ${b.status === 'done' ? '已修好' : '待修'} · ${b.author.name} · ${b.createdAt.slice(0, 10)}\n  ${b.text.replace(/\n/g, '\n  ')}${b.note ? `\n  说明：${b.note}` : ''}`;

function handleMcpTool(name, args) {
  const me = accounts.resolve(args.token);
  if (!me) throw new Error(args.token ? 'token 不对' : '需要 token。第一次来请先调用 register 注册');
  switch (name) {
    case 'bug_list': {
      const items = list().filter(b => args.all || b.status === 'open');
      return items.length ? items.map(line).join('\n\n') : (args.all ? '还没有人提交过。' : '没有待修的 Bug。');
    }
    case 'bug_report': return `收到了：\n${line(report(me, args.text))}`;
    case 'bug_update': return `已更新：\n${line(update(me, args.id, args))}`;
    default: throw new Error(`未知工具: ${name}`);
  }
}

module.exports = { router, mcpTools, handleMcpTool, list, report, update };
