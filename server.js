const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { GomokuGame } = require('./games/gomoku');
const db = require('./db');
const auth = require('./auth');
const vault = require('./vault');
const backup = require('./backup');

const app = express();
// MCP calls may carry a base64 file for vault_save_file, so the MCP routes get a larger limit.
app.use('/mcp', express.json({ limit: Math.ceil(vault.MAX_FILE_BYTES * 1.4) }));
app.use(express.json());

// ============================================================
// In-memory game cache (backed by SQLite)
// ============================================================
const games = new Map();

// Load active games from DB on startup
for (const row of db.listActiveGames()) {
  const game = new GomokuGame(null, null, row);
  games.set(game.gameId, game);
}
console.log(`Loaded ${games.size} active game(s) from database`);

// ============================================================
// Web Frontend
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/vault', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vault.html')));

// ============================================================
// REST API — Vault (存档)
// ============================================================
app.use('/api/vault/backup', backup.router);
app.use('/api/vault', vault.router);

// ============================================================
// REST API — Games (owner token required until there are player accounts)
// ============================================================
app.use('/api/games', auth.requireToken);

app.post('/api/games', (req, res) => {
  const { gameType = 'gomoku', players } = req.body;
  if (!players || !Array.isArray(players) || players.length < 2) {
    return res.status(400).json({ error: '需要至少两名玩家' });
  }

  const gameId = uuidv4().slice(0, 8);
  let game;
  if (gameType === 'gomoku') {
    game = new GomokuGame(gameId, players);
  } else {
    return res.status(400).json({ error: `不支持的游戏类型: ${gameType}` });
  }

  games.set(gameId, game);
  db.saveGame(game);
  res.json({ gameId, message: '游戏已创建', game: game.getPublicState() });
});

app.get('/api/games/:gameId', (req, res) => {
  const game = games.get(req.params.gameId);
  if (!game) return res.status(404).json({ error: '游戏不存在' });
  res.json(game.getPublicState());
});

app.post('/api/games/:gameId/move', (req, res) => {
  const game = games.get(req.params.gameId);
  if (!game) return res.status(404).json({ error: '游戏不存在' });

  const { player, ...moveData } = req.body;
  if (!player) return res.status(400).json({ error: '需要指定玩家' });

  const result = game.makeMove(player, moveData);
  if (result.error) return res.status(400).json(result);

  db.saveGame(game);
  res.json(result);
});

app.get('/api/games', (req, res) => {
  const active = [];
  games.forEach((game, id) => active.push({ gameId: id, ...game.getPublicState() }));
  const finished = db.listFinishedGames().map(row => ({
    gameId: row.game_id,
    gameType: row.game_type,
    players: row.players,
    winner: row.winner,
    moves: row.moves,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }));
  res.json({ active, finished });
});

app.get('/api/games/:gameId/history', (req, res) => {
  const game = games.get(req.params.gameId);
  if (game) {
    const messages = db.getMessages(req.params.gameId);
    return res.json({ ...game.getFullHistory(), messages });
  }
  const row = db.loadGame(req.params.gameId);
  if (!row) return res.status(404).json({ error: '游戏不存在' });
  const messages = db.getMessages(req.params.gameId);
  res.json({
    gameId: row.game_id, gameType: row.game_type, players: row.players,
    winner: row.winner, status: row.status, moves: row.moves,
    createdAt: row.created_at, finishedAt: row.finished_at, messages,
  });
});

// ============================================================
// REST API — Chat
// ============================================================
app.post('/api/games/:gameId/chat', (req, res) => {
  const { sender, content } = req.body;
  if (!sender || !content) return res.status(400).json({ error: '需要 sender 和 content' });
  const game = games.get(req.params.gameId);
  if (!game) return res.status(404).json({ error: '游戏不存在' });

  const msg = db.saveMessage(req.params.gameId, sender, content);
  res.json(msg);
});

app.get('/api/games/:gameId/chat', (req, res) => {
  const sinceId = parseInt(req.query.since) || 0;
  const messages = db.getMessages(req.params.gameId, sinceId);
  res.json(messages);
});

// ============================================================
// MCP Streamable HTTP Transport (stateless: every POST gets its answer as JSON)
// ============================================================
app.post('/mcp', (req, res) => {
  const response = handleMcpMessage(req.body, { token: req.query.token });
  if (!response) return res.status(202).end();
  res.json(response);
});

// ============================================================
// MCP SSE Transport (legacy)
// ============================================================
const mcpSessions = new Map();

app.get('/mcp', (req, res) => {
  const sessionId = uuidv4();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: endpoint\ndata: /mcp/messages?sessionId=${sessionId}\n\n`);
  // A token in the connection URL (/mcp?token=...) unlocks the vault tools for this session.
  mcpSessions.set(sessionId, { res, createdAt: Date.now(), token: req.query.token });
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 30000);
  req.on('close', () => { clearInterval(heartbeat); mcpSessions.delete(sessionId); });
});

app.post('/mcp/messages', (req, res) => {
  const { sessionId } = req.query;
  const session = mcpSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const response = handleMcpMessage(req.body, session);
  if (response) session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
  res.status(202).json({ status: 'accepted' });
});

// ============================================================
// MCP Protocol Handler
// ============================================================
function handleMcpMessage(message, session) {
  const { method, id, params } = message || {};
  // Notifications carry no id and never get a reply.
  if (id === undefined) return null;
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: {
        // Only basic tools are used, so any protocol version the client asks for works.
        protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'maowo', version: '0.2.0' }
      }};
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: getMcpTools() } };
    case 'tools/call': return handleToolCall(id, params, session);
    default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
  }
}

function getMcpTools() {
  return [
    {
      name: 'create_game',
      description: '创建新游戏对局。目前支持五子棋(gomoku)。',
      inputSchema: {
        type: 'object',
        properties: {
          ...vault.tokenProp,
          game_type: { type: 'string', description: '游戏类型: gomoku', default: 'gomoku' },
          players: { type: 'array', items: { type: 'string' }, description: '玩家名称列表，如 ["菲菲", "夜声"]' }
        },
        required: ['players']
      }
    },
    {
      name: 'get_game_state',
      description: '查看当前游戏局面。返回棋盘和状态信息。',
      inputSchema: {
        type: 'object',
        properties: {
          ...vault.tokenProp,
          game_id: { type: 'string', description: '游戏ID' },
          player: { type: 'string', description: '你的玩家名称' }
        },
        required: ['game_id']
      }
    },
    {
      name: 'make_move',
      description: '执行操作。五子棋: 在指定位置落子。坐标从0开始，如 row=7, col=7 表示棋盘中心。',
      inputSchema: {
        type: 'object',
        properties: {
          ...vault.tokenProp,
          game_id: { type: 'string', description: '游戏ID' },
          player: { type: 'string', description: '你的玩家名称' },
          row: { type: 'integer', description: '行坐标 (0-14)' },
          col: { type: 'integer', description: '列坐标 (0-14)' }
        },
        required: ['game_id', 'player', 'row', 'col']
      }
    },
    {
      name: 'send_chat',
      description: '在游戏中发送聊天消息。',
      inputSchema: {
        type: 'object',
        properties: {
          ...vault.tokenProp,
          game_id: { type: 'string', description: '游戏ID' },
          sender: { type: 'string', description: '你的名称' },
          content: { type: 'string', description: '消息内容' }
        },
        required: ['game_id', 'sender', 'content']
      }
    },
    {
      name: 'list_games',
      description: '查看所有进行中和已结束的游戏。',
      inputSchema: { type: 'object', properties: { ...vault.tokenProp } }
    },
    {
      name: 'get_game_history',
      description: '查看某局游戏的完整记录（包含对话）。',
      inputSchema: {
        type: 'object',
        properties: { ...vault.tokenProp, game_id: { type: 'string', description: '游戏ID' } },
        required: ['game_id']
      }
    },
    ...vault.mcpTools
  ];
}

function handleToolCall(id, params, session) {
  const { name, arguments: args = {} } = params;
  try {
    let result;
    // Every tool needs the owner token, from the connection URL or the token argument.
    if (!auth.checkToken(args.token || session.token)) throw new Error('需要正确的 token');
    if (name.startsWith('vault_')) {
      result = vault.handleMcpTool(name, args);
    } else switch (name) {
      case 'create_game': {
        const { game_type = 'gomoku', players } = args;
        if (!players || players.length < 2) throw new Error('需要至少两名玩家');
        const gameId = uuidv4().slice(0, 8);
        let game;
        if (game_type === 'gomoku') game = new GomokuGame(gameId, players);
        else throw new Error(`不支持的游戏类型: ${game_type}`);
        games.set(gameId, game);
        db.saveGame(game);
        result = `游戏已创建！\n游戏ID: ${gameId}\n类型: ${game_type}\n玩家: ${players.join(' vs ')}\n\n${game.getBoardString()}\n\n轮到 ${game.currentPlayer} 落子`;
        break;
      }
      case 'get_game_state': {
        const game = games.get(args.game_id);
        if (!game) throw new Error('游戏不存在');
        result = game.getStateForPlayer(args.player);
        break;
      }
      case 'make_move': {
        const game = games.get(args.game_id);
        if (!game) throw new Error('游戏不存在');
        const moveResult = game.makeMove(args.player, { row: args.row, col: args.col });
        if (moveResult.error) throw new Error(moveResult.error);
        db.saveGame(game);
        result = moveResult.message + '\n\n' + game.getBoardString();
        if (game.status === 'playing') result += `\n\n轮到 ${game.currentPlayer} 落子`;
        break;
      }
      case 'send_chat': {
        const game = games.get(args.game_id);
        if (!game) throw new Error('游戏不存在');
        const msg = db.saveMessage(args.game_id, args.sender, args.content);
        result = `消息已发送: [${args.sender}] ${args.content}`;
        break;
      }
      case 'list_games': {
        const activeList = [];
        games.forEach((game, gid) => activeList.push(`[${gid}] ${game.gameType} - ${game.players.join(' vs ')} - ${game.status}`));
        const finishedList = db.listFinishedGames().map(r => `[${r.game_id}] ${r.game_type} - ${r.players.join(' vs ')} - 胜者: ${r.winner || '平局'}`);
        result = '--- 进行中 ---\n' + (activeList.length ? activeList.join('\n') : '无') +
          '\n\n--- 已结束 ---\n' + (finishedList.length ? finishedList.join('\n') : '无');
        break;
      }
      case 'get_game_history': {
        const game = games.get(args.game_id);
        const row = game ? null : db.loadGame(args.game_id);
        if (!game && !row) throw new Error('游戏不存在');
        const hist = game ? game.getFullHistory() : {
          gameId: row.game_id, gameType: row.game_type, players: row.players,
          winner: row.winner, status: row.status, moves: row.moves,
          createdAt: row.created_at, finishedAt: row.finished_at,
        };
        const messages = db.getMessages(args.game_id);
        result = JSON.stringify({ ...hist, messages }, null, 2);
        break;
      }
      default: throw new Error(`未知工具: ${name}`);
    }
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] } };
  } catch (err) {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `错误: ${err.message}` }], isError: true } };
  }
}

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
