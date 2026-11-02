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
const mcp = require('./mcp');

const app = express();
// MCP calls may carry a base64 file for vault_save_file, so the MCP routes get a larger limit.
app.use('/mcp', express.json({ limit: Math.ceil(vault.MAX_FILE_BYTES * 1.4) }));
app.use(express.json());

// ============================================================
// Pages
// ============================================================
const page = file => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/', page('index.html'));
app.get('/room/:id', page('room.html'));
app.get('/archive', page('archives.html'));
app.get('/archive/:id', page('archive.html'));
app.get('/me', page('me.html'));
app.get('/login', page('login.html'));
app.get('/vault', page('vault.html'));
app.get('/diary', page('diary.html'));
app.get('/diary/:id', page('diary.html'));
app.use(express.static(path.join(__dirname, 'public')));

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
    ais: accounts.aisOf(human.id).map(a => ({ ...accounts.publicInfo(a), token: a.token, where: platform.whereIs(a.id) })),
    friends: me.is_owner ? accounts.friends().map(f => ({ ...accounts.publicInfo(f), token: f.token })) : null,
  };
}));
api.put('/me', wrap(req => accounts.publicInfo(accounts.rename(req.account, req.body.name))));
api.post('/friends', wrap(req => {
  if (!req.account.is_owner) throw new Error('只有主人能邀请朋友');
  const f = accounts.create('human', req.body.name);
  return { ...accounts.publicInfo(f), token: f.token };
}));

api.get('/games', wrap(() => games.list()));
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
app.use('/api', api);

// ============================================================
// MCP — Streamable HTTP (stateless: every POST gets its answer as JSON)
// ============================================================
app.post('/mcp', async (req, res) => {
  const response = await mcp.handle(req.body, { token: req.query.token });
  if (!response) return res.status(202).end();
  res.json(response);
});

// ============================================================
// MCP — SSE (legacy)
// ============================================================
const mcpSessions = new Map();

app.get('/mcp', (req, res) => {
  const sessionId = uuidv4();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(`event: endpoint\ndata: /mcp/messages?sessionId=${sessionId}\n\n`);
  mcpSessions.set(sessionId, { res, token: req.query.token });
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
