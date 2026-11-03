const crypto = require('crypto');
const { db, DATA_DIR } = require('./db');
const { checkToken } = require('./auth');

// ============================================================
// Accounts: humans (the owner, invited friends) and the AIs they own.
// The owner's token is the owner token from auth.js; everyone else has a stored token.
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    token TEXT UNIQUE,
    owner_id INTEGER,
    is_owner INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);
// Added later: profile picture file, a one-line bio, and when a URL-token MCP client (Claude) last connected.
for (const col of ['avatar TEXT', 'bio TEXT', 'mcp_url_at TEXT']) {
  try { db.exec(`ALTER TABLE accounts ADD COLUMN ${col}`); } catch { /* already there */ }
}

const stmts = {
  owner: db.prepare('SELECT * FROM accounts WHERE is_owner = 1'),
  insert: db.prepare(`INSERT INTO accounts (kind, name, token, owner_id, is_owner, created_at)
    VALUES (@kind, @name, @token, @owner_id, @is_owner, @created_at)`),
  byId: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  byToken: db.prepare('SELECT * FROM accounts WHERE token = ?'),
  byName: db.prepare('SELECT * FROM accounts WHERE name = ?'),
  aisOf: db.prepare("SELECT * FROM accounts WHERE kind = 'ai' AND owner_id = ? ORDER BY id"),
  friends: db.prepare("SELECT * FROM accounts WHERE kind = 'human' AND is_owner = 0 ORDER BY id"),
  rename: db.prepare('UPDATE accounts SET name = ? WHERE id = ?'),
  setBio: db.prepare('UPDATE accounts SET bio = ? WHERE id = ?'),
  setAvatar: db.prepare('UPDATE accounts SET avatar = ? WHERE id = ?'),
  touchMcpUrl: db.prepare('UPDATE accounts SET mcp_url_at = ? WHERE id = ?'),
};

if (!stmts.owner.get()) {
  stmts.insert.run({ kind: 'human', name: '主人', token: null, owner_id: null, is_owner: 1, created_at: new Date().toISOString() });
}

const ownerAccount = () => stmts.owner.get();
const byId = id => stmts.byId.get(id) || null;

function resolve(token) {
  if (typeof token !== 'string' || !token) return null;
  if (checkToken(token)) return ownerAccount();
  return stmts.byToken.get(token) || null;
}

function cleanName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('需要名字');
  if (n.length > 16) throw new Error('名字最多 16 个字');
  return n;
}

function create(kind, name, ownerId) {
  name = cleanName(name);
  if (stmts.byName.get(name)) throw new Error(`「${name}」这个名字已经有人用了，换一个吧`);
  const token = (kind === 'ai' ? 'tk_' : 'hu_') + crypto.randomBytes(18).toString('base64url');
  const info = stmts.insert.run({ kind, name, token, owner_id: ownerId || null, is_owner: 0, created_at: new Date().toISOString() });
  return byId(info.lastInsertRowid);
}

function rename(account, name) {
  name = cleanName(name);
  const other = stmts.byName.get(name);
  if (other && other.id !== account.id) throw new Error(`「${name}」这个名字已经有人用了`);
  stmts.rename.run(name, account.id);
  return byId(account.id);
}

function setBio(account, bio) {
  const b = String(bio ?? '').trim().replace(/\s+/g, ' ');
  if (b.length > 40) throw new Error('一句话介绍最多 40 个字');
  stmts.setBio.run(b || null, account.id);
  return byId(account.id);
}

// ============================================================
// Avatars: small images in <data>/avatars, served at /avatars/<random name>.
// The random file name is the only protection, the same as an unlisted link.
// ============================================================
const fs = require('fs');
const path = require('path');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const AVATAR_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// A human may change their own picture and their AIs' pictures.
const canEditAvatar = (editor, target) => !!editor && !!target && editor.kind === 'human' &&
  (editor.id === target.id || (target.kind === 'ai' && target.owner_id === editor.id));

function removeAvatarFile(file) {
  if (file && /^[0-9a-f]+\.\w+$/.test(file)) fs.rm(path.join(AVATAR_DIR, file), { force: true }, () => {});
}

function setAvatar(target, buffer, mime) {
  const ext = AVATAR_TYPES[mime];
  if (!ext) throw new Error('头像只支持 JPG、PNG、WebP、GIF 图片');
  if (!buffer || !buffer.length) throw new Error('没有收到图片');
  if (buffer.length > AVATAR_MAX_BYTES) throw new Error('图片太大了（最多 2MB）');
  const file = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(AVATAR_DIR, file), buffer);
  removeAvatarFile(target.avatar);
  stmts.setAvatar.run(file, target.id);
  return byId(target.id);
}

function clearAvatar(target) {
  removeAvatarFile(target.avatar);
  stmts.setAvatar.run(null, target.id);
  return byId(target.id);
}

// Remembers that a URL-token client (Claude) connected; written at most once a minute.
function touchMcpUrl(account) {
  const human = humanOf(account);
  if (!human) return;
  const last = Date.parse(human.mcp_url_at || 0) || 0;
  if (Date.now() - last > 60000) stmts.touchMcpUrl.run(new Date().toISOString(), human.id);
}

// Who the account answers to: a human answers to themself, an AI to its owner.
const humanOf = account => account.kind === 'human' ? account : byId(account.owner_id);
const isOwnerSide = account => !!account && (account.is_owner === 1 || humanOf(account)?.is_owner === 1);

function publicInfo(account) {
  return {
    id: account.id, kind: account.kind, name: account.name, isOwner: account.is_owner === 1, ownerId: account.owner_id,
    avatar: account.avatar ? `/avatars/${account.avatar}` : null, bio: account.bio || '',
  };
}

// Express middleware: Bearer token (or ?token=) must belong to an account.
function requireAccount(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : req.query.token;
  const account = resolve(token);
  if (!account) return res.status(401).json({ error: '需要正确的 token' });
  req.account = account;
  next();
}

module.exports = {
  resolve, byId, ownerAccount, create, rename, setBio, setAvatar, clearAvatar, canEditAvatar, touchMcpUrl, AVATAR_DIR,
  humanOf, isOwnerSide, publicInfo, requireAccount,
  aisOf: humanId => stmts.aisOf.all(humanId),
  friends: () => stmts.friends.all(),
};
