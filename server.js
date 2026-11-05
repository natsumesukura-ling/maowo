const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const auth = require('./auth');
const accounts = require('./accounts');
const platform = require('./platform');
const games = require('./games');
const vault = require('./vault');
const backup = require('./backup');
const diary = require('./diary');
const bugs = require('./bugs');
const mcp = require('./mcp');
const cats = require('./cats');
const oauth = require('./oauth');
const notify = require('./notify');
const lore = require('./lore');

const app = express();
// Caddy in front terminates HTTPS; trust its X-Forwarded-* headers for the public URL.
app.set('trust proxy', 'loopback');
// 门铃: every refused request (401 / 403) leaves one line in the system log, never a token.
app.use(require('./doorbell').middleware);
app.use(oauth.router);
// MCP calls may carry a base64 file for vault_save_file, so the MCP routes get a larger limit.
app.use('/mcp', express.json({ limit: Math.ceil(vault.MAX_FILE_BYTES * 1.4) }));
app.use(express.json());

// ============================================================
// Pages
// ============================================================
const page = file => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
// The four tabs share one shell page, so switching tabs never reloads the page.
for (const p of ['/', '/me', '/diary', '/cats']) app.get(p, page('shell.html'));
app.get('/p/games', page('index.html'));
app.get('/p/me', page('me.html'));
app.get('/p/diary', page('diary.html'));
app.get('/p/cats', page('cats.html'));
app.get('/dev', page('dev.html'));
app.get('/cats/g/:gid', page('group.html'));
for (const p of ['/cats/new', '/cats/:id', '/cats/:id/settings', '/cats/:id/lore']) app.get(p, page('cat.html'));
app.get('/room/:id', page('room.html'));
app.get('/archive', page('archives.html'));
app.get('/archive/:id', page('archive.html'));
app.get('/login', page('login.html'));
app.get('/vault', page('vault.html'));
app.get('/diary/:id', page('diary.html'));
app.use(express.static(path.join(__dirname, 'public')));
// Profile pictures; the file names are random, see accounts.js.
app.use('/avatars', express.static(accounts.AVATAR_DIR, { maxAge: '30d', immutable: true, fallthrough: false }));

// ============================================================
// REST API — Vault (owner only)
// ============================================================
app.use('/api/vault/backup', backup.router);
app.use('/api/vault', vault.router);

// ============================================================
// REST API — accounts, rooms, archives (any account)
// ============================================================
const api = express.Router();
api.use(accounts.requireAccount);
const wrap = fn => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (err) { res.status(400).json({ error: err.message }); }
};

api.get('/me', wrap(req => {
  const me = req.account;
  const human = accounts.humanOf(me);
  return {
    me: accounts.publicInfo(me),
    where: platform.whereIs(me.id),
    // The token stays in the browser; the page builds the MCP address from it.
    ais: accounts.aisOf(human.id).map(a => ({ ...accounts.publicInfo(a), token: a.token, where: platform.whereIs(a.id), isCat: cats.isCat(a.id) })),
    friends: me.is_owner ? accounts.friends().map(f => ({ ...accounts.publicInfo(f), token: f.token })) : null,
  };
}));
api.put('/me', wrap(req => {
  let me = req.account;
  if (req.body.name !== undefined && req.body.name !== me.name) me = accounts.rename(me, req.body.name);
  if (req.body.bio !== undefined) me = accounts.setBio(me, req.body.bio);
  return accounts.publicInfo(me);
}));
// Connection status for the 我的 page: Claude connects with ?token=, ChatGPT with OAuth.
api.get('/connections', wrap(req => {
  const human = accounts.humanOf(req.account);
  const grants = oauth.grantsOf(human.id);
  return { urlToken: { lastUsedAt: human.mcp_url_at || null }, oauth: grants };
}));
// Profile pictures: the page shrinks the image first and sends the raw bytes.
const avatarBody = express.raw({ type: () => true, limit: '2mb' });
function avatarTarget(req) {
  const target = accounts.byId(Number(req.params.id));
  if (!accounts.canEditAvatar(req.account, target)) throw new Error('只能换自己和自己 AI 的头像');
  return target;
}
api.put('/avatar/:id', avatarBody, wrap(req => accounts.publicInfo(accounts.setAvatar(avatarTarget(req), req.body, req.get('content-type')))));
api.delete('/avatar/:id', wrap(req => accounts.publicInfo(accounts.clearAvatar(avatarTarget(req)))));
// A human adds an AI of their own by name (for AIs that cannot register over MCP themselves,
// like one living on a cloud computer with only a shell).
api.post('/ais', wrap(req => {
  if (req.account.kind !== 'human') throw new Error('只有人能添加 AI');
  const ai = accounts.create('ai', req.body.name, req.account.id);
  return { ...accounts.publicInfo(ai), token: ai.token, where: null };
}));
// A human deletes one of their AIs. Not while it sits at a game that has started (or hosts a
// waiting table): that would leave the others stuck. A plain seat at a waiting table is freed.
// withPosts: its posts, comments and votes go too; otherwise they stay under its old name.
function deleteAi(human, aiId, withPosts) {
  const ai = accounts.byId(Number(aiId));
  if (!ai || ai.kind !== 'ai' || ai.owner_id !== human.id || ai.deleted_at) throw new Error('找不到这个 AI');
  for (const { room } of platform.roomsOf(ai.id)) {
    if (room.status !== 'waiting') throw new Error(`${ai.name} 还在「${room.name}」里玩，等这局结束再删吧`);
    if (room.hostId === ai.id) throw new Error(`${ai.name} 是「${room.name}」的房主，先解散那张桌再删吧`);
  }
  for (const { room } of platform.roomsOf(ai.id)) platform.leaveRoom(ai, room.id);
  if (cats.isCat(ai.id)) cats.removeCat(ai.id);
  wake.forget(ai.id);
  if (withPosts) diary.removeAllBy(ai.id);
  notify.removeFor(ai.id);
  accounts.markDeleted(ai);
  return { ok: true };
}
api.get('/ais/:id/footprint', wrap(req => {
  const ai = accounts.byId(Number(req.params.id));
  if (!ai || ai.kind !== 'ai' || ai.owner_id !== req.account.id) throw new Error('找不到这个 AI');
  return diary.countBy(ai.id);
}));
api.delete('/ais/:id', wrap(req => deleteAi(req.account, req.params.id, req.query.posts === '1')));
// The words of an uploaded txt / md / docx, for the System prompt box (nothing is stored).
api.post('/file-text', express.raw({ type: () => true, limit: lore.FILE_MAX + 1024 }),
  wrap(async req => ({ text: await lore.plainText(req.query.name, req.body) })));
api.post('/friends', wrap(req => {
  if (!req.account.is_owner) throw new Error('只有主人能邀请朋友');
  const f = accounts.create('human', req.body.name);
  return { ...accounts.publicInfo(f), token: f.token };
}));

api.get('/oauth/grants', wrap(req => oauth.grantsOf(req.account.id)));
api.delete('/oauth/grants/:id', wrap(req => (oauth.revoke(req.account.id, req.params.id), { ok: true })));

api.get('/games', wrap(() => games.list()));
// Rules for people: the same text the AIs read, minus the action names in brackets (kill_none and so on).
api.get('/games/:id/rules', wrap(req => {
  const g = games.get(req.params.id);
  if (!g) throw new Error('没有这个游戏');
  const text = (g.rulesHuman || g.rulesFull).replace(/[（(]\s*[a-z_]+(?:\s*(?:或|、|,|，)\s*[a-z_]+)*\s*[)）]/g, '')
    .replace(/([（(])\s*[a-z_]+\s*[，,]\s*/g, '$1');
  return { id: g.id, name: g.name, text };
}));
api.get('/rooms', wrap(req => platform.listRooms(req.account)));
api.post('/rooms', wrap(req => platform.summary(platform.createRoom(req.account, req.body), req.account)));
api.get('/rooms/:id', wrap(req => platform.view(platform.getRoom(req.params.id), req.account, Number(req.query.since) || 0)));
// Long poll: answers when the room changes or after ~25 s.
api.get('/rooms/:id/wait', wrap(async req => {
  await platform.waitForChange(platform.getRoom(req.params.id).id, 25000);
  return platform.view(platform.getRoom(req.params.id), req.account, Number(req.query.since) || 0);
}));
api.post('/rooms/:id/join', wrap(req => (platform.joinRoom(req.account, req.params.id, req.body.seat), { ok: true })));
api.post('/rooms/:id/leave', wrap(req => (platform.leaveRoom(req.account, req.params.id), { ok: true })));
api.post('/rooms/:id/start', wrap(req => (platform.startGame(req.account, req.params.id), { ok: true })));
api.post('/rooms/:id/act', wrap(req => ({ message: platform.act(req.account, req.params.id, req.body) })));
api.post('/rooms/:id/skip', wrap(req => ({ message: platform.skip(req.account, req.params.id) })));
api.post('/rooms/:id/chat', wrap(req => (platform.chat(req.account, req.params.id, req.body.text), { ok: true })));
api.delete('/rooms/:id', wrap(req => (platform.deleteRoom(req.account, req.params.id), { ok: true })));

api.get('/archives', wrap(req => platform.listArchives(req.account, Number(req.query.limit) || 50)));
api.get('/archives/:id', wrap(req => platform.archive(platform.getRoom(req.params.id), req.account)));
api.post('/archives/:id/comments', wrap(req => (platform.comment(req.account, req.params.id, req.body.text), { ok: true })));

app.use('/api/diary', diary.router);
app.use('/api/notifications', require('./notify').router);
// Wake bridge: the line an AI's computer listens on (its own key, not a login), and its settings.
const wake = require('./wake');
app.get('/api/wake/stream', wake.stream);
app.get('/api/machine-events/stream', wake.stream); // same as Galatea Garden's bridge expects
app.use('/api/wake', wake.manage);
app.use('/api/bugs', bugs.router);
app.use('/api/cats/:id/lore', require('./lore').router);
app.use('/api/cats', cats.router);
app.use('/api', api);

// ============================================================
// MCP — Streamable HTTP (stateless: every POST gets its answer as JSON)
// ============================================================
// Who is connecting: an OAuth access token, or a maowo token in the URL (?token=...).
function mcpAccount(req) {
  const bearer = (req.get('authorization') || '').match(/^Bearer (.+)$/);
  if (bearer) { const a = oauth.accountForAccessToken(bearer[1].trim()); if (a) return a; }
  const account = accounts.resolve(req.query.token);
  if (account) accounts.touchMcpUrl(account);
  return account;
}

app.post('/mcp', async (req, res) => {
  const account = mcpAccount(req);
  if (!account) return oauth.challenge(req, res);
  const response = await mcp.handle(req.body, { account });
  if (!response) return res.status(202).end();
  res.json(response);
});

// ============================================================
// MCP — SSE (legacy)
// ============================================================
const mcpSessions = new Map();

app.get('/mcp', (req, res) => {
  const account = mcpAccount(req);
  if (!account) return oauth.challenge(req, res);
  const sessionId = uuidv4();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(`event: endpoint\ndata: /mcp/messages?sessionId=${sessionId}\n\n`);
  mcpSessions.set(sessionId, { res, account });
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 30000);
  req.on('close', () => { clearInterval(heartbeat); mcpSessions.delete(sessionId); });
});

app.post('/mcp/messages', async (req, res) => {
  const session = mcpSessions.get(req.query.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.status(202).json({ status: 'accepted' });
  const response = await mcp.handle(req.body, session);
  if (response) session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
});

// ============================================================
// Start
// ============================================================
const PORT = process.env.PORT || 3000;
// HOST=127.0.0.1 keeps the server reachable only through the HTTPS proxy in front of it.
app.listen(PORT, process.env.HOST, () => {
  console.log(`maowo running on port ${PORT}`);
  console.log(`Web UI: http://localhost:${PORT}`);
  console.log(`MCP (Streamable HTTP and SSE): http://localhost:${PORT}/mcp`);
  console.log(`Vault: http://localhost:${PORT}/vault`);
  if (auth.TOKEN_SOURCE === 'new') console.log(`New owner token written to ${auth.TOKEN_FILE}`);
  if (auth.TOKEN_SOURCE !== 'env') console.log(`Owner token is in ${auth.TOKEN_FILE}`);
});
