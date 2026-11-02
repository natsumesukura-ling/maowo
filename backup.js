const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yazl = require('yazl');
const yauzl = require('yauzl');
const { db, DATA_DIR } = require('./db');
const { requireToken } = require('./auth');
const { FILES_DIR, safeFilename } = require('./vault');

// ============================================================
// Backup format: one zip that is readable without maowo
//   manifest.json      every item's metadata and note revisions
//   笔记/ 文件/         current notes (.md) and files, as-is
//   回收站/笔记/ 回收站/文件/   the same for items in the trash
// ============================================================
const FORMAT = 'maowo-vault';
const FORMAT_VERSION = 1;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;
const TMP_DIR = path.join(DATA_DIR, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const README = `这是猫窝存档的完整备份。

笔记/        每篇笔记一个 .md 文件，用任何文本编辑器都能打开
文件/        上传的文件，原样保存
回收站/      回收站里的笔记和文件
manifest.json  标题、标签、说明、时间和笔记的旧版本

文件名格式是「名字__ID」。把整个压缩包在猫窝存档页「从备份导入」，就能原样恢复。
`;

const stmts = {
  all: db.prepare('SELECT * FROM vault_items ORDER BY created_at ASC'),
  revisions: db.prepare('SELECT title, content, source, created_at FROM vault_revisions WHERE item_id = ? ORDER BY id ASC'),
  exists: db.prepare('SELECT 1 FROM vault_items WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO vault_items (id, kind, title, note, tags, content, filename, stored_name, mime, size, sha256, source, created_at, updated_at, deleted_at)
    VALUES (@id, @kind, @title, @note, @tags, @content, @filename, @stored_name, @mime, @size, @sha256, @source, @created_at, @updated_at, @deleted_at)
  `),
  insertRevision: db.prepare(`
    INSERT INTO vault_revisions (item_id, title, content, source, created_at) VALUES (@item_id, @title, @content, @source, @created_at)
  `),
};

function entryPath(row) {
  const folder = (row.deleted_at ? '回收站/' : '') + (row.kind === 'note' ? '笔记' : '文件');
  return row.kind === 'note' ? `${folder}/${safeFilename(row.title)}__${row.id}.md` : `${folder}/${row.stored_name}`;
}

function stamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

// ============================================================
// Export
// ============================================================
function exportZip(res) {
  const zip = new yazl.ZipFile();
  const items = [];
  for (const row of stmts.all.all()) {
    const zipPath = entryPath(row);
    const mtime = new Date(row.updated_at);
    if (row.kind === 'note') {
      zip.addBuffer(Buffer.from(row.content, 'utf8'), zipPath, { mtime });
    } else {
      const full = path.join(FILES_DIR, row.stored_name);
      if (!fs.existsSync(full)) continue;
      zip.addFile(full, zipPath, { mtime });
    }
    items.push({
      id: row.id, kind: row.kind, title: row.title, note: row.note, tags: JSON.parse(row.tags),
      filename: row.filename, mime: row.mime, size: row.size, sha256: row.sha256, source: row.source,
      created_at: row.created_at, updated_at: row.updated_at, deleted_at: row.deleted_at,
      path: zipPath, revisions: stmts.revisions.all(row.id),
    });
  }
  const manifest = { format: FORMAT, version: FORMAT_VERSION, exported_at: new Date().toISOString(), items };
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
  zip.addBuffer(Buffer.from(README), '说明.txt');
  zip.end();

  const name = `maowo-存档-${stamp()}.zip`;
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="maowo-backup-${stamp()}.zip"; filename*=UTF-8''${encodeURIComponent(name)}`);
  zip.outputStream.pipe(res);
}

// ============================================================
// Import: merge only. Items whose ID already exists are skipped, never overwritten.
// ============================================================
const openZip = file => new Promise((resolve, reject) =>
  yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => err ? reject(err) : resolve(zip)));

function readEntries(zip) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    zip.on('entry', e => { entries.set(e.fileName, e); zip.readEntry(); });
    zip.on('end', () => resolve(entries));
    zip.on('error', reject);
    zip.readEntry();
  });
}

const openEntry = (zip, entry) => new Promise((resolve, reject) =>
  zip.openReadStream(entry, (err, stream) => err ? reject(err) : resolve(stream)));

async function readEntryBuffer(zip, entry) {
  const chunks = [];
  for await (const chunk of await openEntry(zip, entry)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Streams an entry to disk while hashing it, so large files never sit in memory.
async function extractEntry(zip, entry, dest) {
  const hash = crypto.createHash('sha256');
  const stream = await openEntry(zip, entry);
  const out = fs.createWriteStream(dest);
  let size = 0;
  await new Promise((resolve, reject) => {
    stream.on('data', chunk => { hash.update(chunk); size += chunk.length; });
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    stream.pipe(out);
  });
  return { sha256: hash.digest('hex'), size };
}

const ID_RE = /^[0-9a-f-]{1,40}$/;
const str = (v, fallback = '') => typeof v === 'string' ? v : fallback;
const time = v => typeof v === 'string' && !isNaN(Date.parse(v)) ? v : null;

async function importZip(file) {
  const zip = await openZip(file);
  const result = { imported: 0, skipped: 0, failed: [] };
  try {
    const entries = await readEntries(zip);
    const manifestEntry = entries.get('manifest.json');
    if (!manifestEntry) throw new Error('这不是猫窝的备份：找不到 manifest.json');
    let manifest;
    try { manifest = JSON.parse((await readEntryBuffer(zip, manifestEntry)).toString('utf8')); }
    catch { throw new Error('manifest.json 坏掉了'); }
    if (manifest.format !== FORMAT || !Array.isArray(manifest.items)) throw new Error('这不是猫窝的备份');
    if (manifest.version > FORMAT_VERSION) throw new Error('备份来自更新版本的猫窝，请先更新程序');

    for (const it of manifest.items) {
      const label = str(it && it.title, '(无标题)');
      try {
        if (!it || !ID_RE.test(it.id) || !['note', 'file'].includes(it.kind)) throw new Error('条目格式不对');
        if (stmts.exists.get(it.id)) { result.skipped++; continue; }
        const entry = entries.get(it.path);
        if (!entry) throw new Error('压缩包里缺少这个文件');
        const now = new Date().toISOString();
        const row = {
          id: it.id, kind: it.kind, title: str(it.title).trim() || '(无标题)', note: str(it.note),
          tags: JSON.stringify(Array.isArray(it.tags) ? it.tags.filter(t => typeof t === 'string') : []),
          content: null, filename: null, stored_name: null, mime: str(it.mime, 'application/octet-stream'),
          size: 0, sha256: null, source: str(it.source, 'web'),
          created_at: time(it.created_at) || now, updated_at: time(it.updated_at) || now, deleted_at: time(it.deleted_at),
        };
        let written = null;
        if (it.kind === 'note') {
          row.content = (await readEntryBuffer(zip, entry)).toString('utf8');
          row.mime = 'text/plain';
          row.size = Buffer.byteLength(row.content);
        } else {
          row.filename = safeFilename(it.filename);
          row.stored_name = `${it.id}__${row.filename}`;
          written = path.join(FILES_DIR, row.stored_name);
          const { sha256, size } = await extractEntry(zip, entry, written);
          if (it.sha256 && it.sha256 !== sha256) { fs.unlinkSync(written); throw new Error('文件校验不通过，可能损坏了'); }
          row.sha256 = sha256;
          row.size = size;
        }
        try {
          db.transaction(() => {
            stmts.insert.run(row);
            for (const rev of Array.isArray(it.revisions) ? it.revisions : []) {
              if (typeof rev.content !== 'string') continue;
              stmts.insertRevision.run({
                item_id: it.id, title: str(rev.title, row.title), content: rev.content,
                source: str(rev.source, 'web'), created_at: time(rev.created_at) || now,
              });
            }
          })();
        } catch (err) {
          if (written) fs.unlinkSync(written);
          throw err;
        }
        result.imported++;
      } catch (err) {
        result.failed.push({ title: label, error: err.message });
      }
    }
  } finally {
    zip.close();
  }
  return result;
}

// Writes the request body to a temp file (zips can be far bigger than memory should hold).
function receiveToTemp(req) {
  const tmp = path.join(TMP_DIR, `import-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.zip`);
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(tmp);
    const fail = err => { out.destroy(); fs.rm(tmp, { force: true }, () => reject(err)); };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_IMPORT_BYTES) { req.destroy(); fail(new Error('备份太大，上限 4GB')); }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => resolve(tmp));
    req.pipe(out);
  });
}

// ============================================================
// REST API — /api/vault/backup (owner token required)
// ============================================================
const router = express.Router();
router.use(requireToken);

router.get('/export', (req, res) => {
  try { exportZip(res); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/import', async (req, res) => {
  let tmp;
  try {
    tmp = await receiveToTemp(req);
    res.json(await importZip(tmp));
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    if (tmp) fs.rm(tmp, { force: true }, () => {});
  }
});

module.exports = { router, exportZip, importZip };
