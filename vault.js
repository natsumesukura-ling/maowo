const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db, DATA_DIR } = require('./db');
const { requireToken } = require('./auth');

// ============================================================
// Storage: metadata + notes in SQLite, files on disk under data/vault/
// ============================================================
const FILES_DIR = path.join(DATA_DIR, 'vault');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_READ = 200 * 1024;
const INLINE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
const TEXT_MIMES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml))/;

const stmts = {
  insert: db.prepare(`
    INSERT INTO vault_items (id, kind, title, note, tags, content, filename, stored_name, mime, size, sha256, source, created_at, updated_at)
    VALUES (@id, @kind, @title, @note, @tags, @content, @filename, @stored_name, @mime, @size, @sha256, @source, @created_at, @updated_at)
  `),
  get: db.prepare('SELECT * FROM vault_items WHERE id = ?'),
  list: db.prepare(`
    SELECT id, kind, title, note, tags, filename, mime, size, source, created_at, updated_at, deleted_at
    FROM vault_items WHERE (deleted_at IS NULL) = @alive ORDER BY updated_at DESC
  `),
  update: db.prepare(`
    UPDATE vault_items SET title=@title, note=@note, tags=@tags, content=@content, size=@size, source=@source, updated_at=@updated_at WHERE id=@id
  `),
  setDeleted: db.prepare('UPDATE vault_items SET deleted_at = ? WHERE id = ?'),
  purge: db.prepare('DELETE FROM vault_items WHERE id = ?'),
  insertRevision: db.prepare(`
    INSERT INTO vault_revisions (item_id, title, content, source, created_at) VALUES (@item_id, @title, @content, @source, @created_at)
  `),
  listRevisions: db.prepare('SELECT id, title, length(CAST(content AS BLOB)) AS size, source, created_at FROM vault_revisions WHERE item_id = ? ORDER BY id DESC'),
  getRevision: db.prepare('SELECT * FROM vault_revisions WHERE id = ? AND item_id = ?'),
  purgeRevisions: db.prepare('DELETE FROM vault_revisions WHERE item_id = ?'),
};

function normalizeTags(tags) {
  if (typeof tags === 'string') tags = tags.split(/[,，\s]+/);
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(t => String(t).trim()).filter(Boolean))].slice(0, 20);
}

function safeFilename(name) {
  const cleaned = String(name || 'file').replace(/[\/\\\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'file').slice(0, 120);
}

function rowToItem(row) {
  return { ...row, tags: JSON.parse(row.tags), stored_name: undefined };
}

function listItems({ q, tag, trash } = {}) {
  let rows = stmts.list.all({ alive: trash ? 0 : 1 }).map(rowToItem);
  if (tag) rows = rows.filter(r => r.tags.includes(tag));
  if (q) {
    const needle = q.toLowerCase();
    const contentHits = new Set(
      db.prepare("SELECT id FROM vault_items WHERE kind = 'note' AND instr(lower(content), ?) > 0").all(needle).map(r => r.id)
    );
    rows = rows.filter(r => contentHits.has(r.id) ||
      [r.title, r.note, r.filename || '', r.tags.join(' ')].some(s => s.toLowerCase().includes(needle)));
  }
  return rows;
}

function getItem(id) {
  const row = stmts.get.get(id);
  return row ? rowToItem(row) : null;
}

function createNote({ title, content, note = '', tags }, source) {
  if (!title || !String(title).trim()) throw new Error('需要标题');
  if (typeof content !== 'string') throw new Error('需要内容');
  const now = new Date().toISOString();
  const item = {
    id: uuidv4().replace(/-/g, '').slice(0, 12), kind: 'note', title: String(title).trim(), note: String(note || ''),
    tags: JSON.stringify(normalizeTags(tags)), content, filename: null, stored_name: null,
    mime: 'text/plain', size: Buffer.byteLength(content), sha256: null, source, created_at: now, updated_at: now,
  };
  stmts.insert.run(item);
  return getItem(item.id);
}

// Notes keep every previous version in vault_revisions, so nothing is lost on overwrite.
function updateItem(id, changes, source) {
  const row = stmts.get.get(id);
  if (!row) throw new Error('找不到这份存档');
  if (row.deleted_at) throw new Error('这份存档在回收站里，先恢复再修改');
  const now = new Date().toISOString();
  const next = {
    id, title: changes.title !== undefined ? String(changes.title).trim() : row.title,
    note: changes.note !== undefined ? String(changes.note) : row.note,
    tags: changes.tags !== undefined ? JSON.stringify(normalizeTags(changes.tags)) : row.tags,
    content: row.content, size: row.size, source, updated_at: now,
  };
  if (!next.title) throw new Error('标题不能为空');
  if (changes.content !== undefined) {
    if (row.kind !== 'note') throw new Error('文件的内容不能直接修改，请重新上传');
    if (changes.content !== row.content) {
      stmts.insertRevision.run({ item_id: id, title: row.title, content: row.content, source: row.source, created_at: row.updated_at });
      next.content = String(changes.content);
      next.size = Buffer.byteLength(next.content);
    }
  }
  stmts.update.run(next);
  return getItem(id);
}

function createFile({ buffer, filename, mime, title, note = '', tags }, source) {
  if (!buffer || !buffer.length) throw new Error('文件是空的');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('文件太大，上限 50MB');
  const id = uuidv4().replace(/-/g, '').slice(0, 12);
  const name = safeFilename(filename);
  const storedName = `${id}__${name}`;
  fs.writeFileSync(path.join(FILES_DIR, storedName), buffer);
  const now = new Date().toISOString();
  stmts.insert.run({
    id, kind: 'file', title: String(title || name).trim(), note: String(note || ''),
    tags: JSON.stringify(normalizeTags(tags)), content: null, filename: name, stored_name: storedName,
    mime: mime || 'application/octet-stream', size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'), source, created_at: now, updated_at: now,
  });
  return getItem(id);
}

function filePath(id) {
  const row = stmts.get.get(id);
  if (!row || row.kind !== 'file') return null;
  return { row, full: path.join(FILES_DIR, row.stored_name) };
}

function readText(id) {
  const item = getItem(id);
  if (!item) throw new Error('找不到这份存档');
  if (item.kind === 'note') return { item, text: item.content };
  if (!TEXT_MIMES.test(item.mime)) return { item, text: null };
  const buf = fs.readFileSync(filePath(id).full);
  return { item, text: buf.subarray(0, MAX_TEXT_READ).toString('utf8'), truncated: buf.length > MAX_TEXT_READ };
}

function purgeItem(id) {
  const found = filePath(id);
  db.transaction(() => { stmts.purgeRevisions.run(id); stmts.purge.run(id); })();
  if (found && fs.existsSync(found.full)) fs.unlinkSync(found.full);
}

// ============================================================
// REST API — /api/vault (owner token required)
// ============================================================
const router = express.Router();
router.use(requireToken);

const wrap = fn => (req, res) => {
  try { fn(req, res); } catch (err) { res.status(400).json({ error: err.message }); }
};

router.get('/', wrap((req, res) => {
  res.json(listItems({ q: req.query.q, tag: req.query.tag, trash: req.query.trash === '1' }));
}));

router.post('/notes', wrap((req, res) => res.json(createNote(req.body, 'web'))));

// The page sends the bytes as application/octet-stream and the real type in ?mime=,
// so the global JSON parser never touches an uploaded .json file.
router.post('/files', express.raw({ type: () => true, limit: MAX_FILE_BYTES }), wrap((req, res) => {
  res.json(createFile({
    buffer: req.body, filename: req.query.filename, mime: req.query.mime,
    title: req.query.title, note: req.query.note, tags: req.query.tags,
  }, 'web'));
}));

router.get('/:id', wrap((req, res) => {
  const item = getItem(req.params.id);
  if (!item) return res.status(404).json({ error: '找不到这份存档' });
  res.json(item);
}));

router.put('/:id', wrap((req, res) => res.json(updateItem(req.params.id, req.body, 'web'))));

router.get('/:id/download', (req, res) => {
  const found = filePath(req.params.id);
  if (!found) {
    const item = getItem(req.params.id);
    if (!item) return res.status(404).json({ error: '找不到这份存档' });
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename(item.title) + '.txt')}`);
    return res.send(item.content);
  }
  const inline = req.query.inline === '1' && INLINE_MIMES.has(found.row.mime);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', 'sandbox');
  res.set('Content-Type', inline ? found.row.mime : 'application/octet-stream');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(found.row.filename)}`);
  res.sendFile(found.full);
});

router.get('/:id/revisions', wrap((req, res) => res.json(stmts.listRevisions.all(req.params.id))));

router.get('/:id/revisions/:rev', wrap((req, res) => {
  const rev = stmts.getRevision.get(req.params.rev, req.params.id);
  if (!rev) return res.status(404).json({ error: '找不到这个版本' });
  res.json(rev);
}));

// Delete moves to the trash; ?purge=1 on an item already in the trash removes it for good.
router.delete('/:id', wrap((req, res) => {
  const item = getItem(req.params.id);
  if (!item) return res.status(404).json({ error: '找不到这份存档' });
  if (req.query.purge === '1') {
    if (!item.deleted_at) throw new Error('先移到回收站，才能彻底删除');
    purgeItem(item.id);
    return res.json({ purged: true });
  }
  stmts.setDeleted.run(new Date().toISOString(), item.id);
  res.json(getItem(item.id));
}));

router.post('/:id/restore', wrap((req, res) => {
  if (!getItem(req.params.id)) return res.status(404).json({ error: '找不到这份存档' });
  stmts.setDeleted.run(null, req.params.id);
  res.json(getItem(req.params.id));
}));

// ============================================================
// MCP tools — no delete here: removing things stays a human job on the web page
// ============================================================
const tokenProp = { token: { type: 'string', description: '猫窝 token（连接地址里已带 token 时可省略）' } };

const mcpTools = [
  {
    name: 'vault_save',
    description: '把一段文字存进猫窝存档（笔记、对话摘录、重要资料）。带 id 时更新已有笔记，旧版本会保留。',
    inputSchema: {
      type: 'object',
      properties: {
        ...tokenProp,
        id: { type: 'string', description: '要更新的存档 ID；新建时不填' },
        title: { type: 'string', description: '标题' },
        content: { type: 'string', description: '正文' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签' },
        note: { type: 'string', description: '一句话说明' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'vault_save_file',
    description: '把一个文件存进猫窝存档，内容用 base64 传。',
    inputSchema: {
      type: 'object',
      properties: {
        ...tokenProp,
        filename: { type: 'string', description: '文件名，如 notes.md' },
        content_base64: { type: 'string', description: '文件内容（base64）' },
        mime: { type: 'string', description: '文件类型，如 text/markdown' },
        title: { type: 'string', description: '标题，默认用文件名' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签' },
        note: { type: 'string', description: '一句话说明' },
      },
      required: ['filename', 'content_base64'],
    },
  },
  {
    name: 'vault_list',
    description: '列出或搜索猫窝存档。',
    inputSchema: {
      type: 'object',
      properties: {
        ...tokenProp,
        query: { type: 'string', description: '搜索词（标题、说明、标签、笔记正文）' },
        tag: { type: 'string', description: '只看这个标签' },
      },
    },
  },
  {
    name: 'vault_read',
    description: '读取一份存档的内容。',
    inputSchema: {
      type: 'object',
      properties: { ...tokenProp, id: { type: 'string', description: '存档 ID' } },
      required: ['id'],
    },
  },
];

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function describe(item) {
  const tags = item.tags.length ? ` #${item.tags.join(' #')}` : '';
  const kind = item.kind === 'note' ? '笔记' : `文件 ${item.filename}`;
  return `[${item.id}] ${item.title} · ${kind} · ${formatSize(item.size)} · ${item.updated_at.slice(0, 10)}${tags}`;
}

function handleMcpTool(name, args) {
  switch (name) {
    case 'vault_save': {
      const item = args.id
        ? updateItem(args.id, { title: args.title, content: args.content, tags: args.tags, note: args.note }, 'mcp')
        : createNote(args, 'mcp');
      return `已存档${args.id ? '（已更新，旧版本保留）' : ''}\n${describe(item)}`;
    }
    case 'vault_save_file': {
      if (typeof args.content_base64 !== 'string') throw new Error('需要 content_base64');
      const item = createFile({ ...args, buffer: Buffer.from(args.content_base64, 'base64') }, 'mcp');
      return `已存档\n${describe(item)}`;
    }
    case 'vault_list': {
      const items = listItems({ q: args.query, tag: args.tag });
      return items.length ? items.map(describe).join('\n') : '没有找到存档';
    }
    case 'vault_read': {
      const { item, text, truncated } = readText(args.id);
      const head = describe(item) + (item.note ? `\n说明: ${item.note}` : '');
      if (text === null) return `${head}\n\n这是二进制文件（${item.mime}），只能在网页上下载。`;
      return `${head}\n\n${text}${truncated ? '\n\n……（内容过长，只显示前 200KB）' : ''}`;
    }
    default: throw new Error(`未知工具: ${name}`);
  }
}

module.exports = { router, mcpTools, handleMcpTool, MAX_FILE_BYTES };
