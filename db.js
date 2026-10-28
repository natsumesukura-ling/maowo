const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'games.db');

// Ensure data directory exists
const fs = require('fs');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================================
// Schema
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    game_id TEXT PRIMARY KEY,
    game_type TEXT NOT NULL,
    players TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'playing',
    winner TEXT,
    board TEXT,
    current_player TEXT,
    current_player_index INTEGER DEFAULT 0,
    moves TEXT DEFAULT '[]',
    created_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (game_id) REFERENCES games(game_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_game ON messages(game_id);
`);

// ============================================================
// Game Operations
// ============================================================
const stmts = {
  insertGame: db.prepare(`
    INSERT INTO games (game_id, game_type, players, status, winner, board, current_player, current_player_index, moves, created_at)
    VALUES (@game_id, @game_type, @players, @status, @winner, @board, @current_player, @current_player_index, @moves, @created_at)
  `),

  updateGame: db.prepare(`
    UPDATE games SET status=@status, winner=@winner, board=@board, current_player=@current_player,
    current_player_index=@current_player_index, moves=@moves, finished_at=@finished_at WHERE game_id=@game_id
  `),

  getGame: db.prepare('SELECT * FROM games WHERE game_id = ?'),
  listActive: db.prepare("SELECT * FROM games WHERE status = 'playing' ORDER BY created_at DESC"),
  listFinished: db.prepare("SELECT * FROM games WHERE status = 'finished' ORDER BY finished_at DESC LIMIT 50"),

  insertMessage: db.prepare(`
    INSERT INTO messages (game_id, sender, content, created_at) VALUES (@game_id, @sender, @content, @created_at)
  `),

  getMessages: db.prepare('SELECT * FROM messages WHERE game_id = ? ORDER BY id ASC'),
  getMessagesSince: db.prepare('SELECT * FROM messages WHERE game_id = ? AND id > ? ORDER BY id ASC'),
};

function saveGame(game) {
  const data = {
    game_id: game.gameId,
    game_type: game.gameType,
    players: JSON.stringify(game.players),
    status: game.status,
    winner: game.winner,
    board: JSON.stringify(game.board),
    current_player: game.currentPlayer,
    current_player_index: game.currentPlayerIndex,
    moves: JSON.stringify(game.moves),
    created_at: game.createdAt,
    finished_at: game.finishedAt || null,
  };

  const existing = stmts.getGame.get(game.gameId);
  if (existing) {
    stmts.updateGame.run(data);
  } else {
    stmts.insertGame.run(data);
  }
}

function loadGame(gameId) {
  const row = stmts.getGame.get(gameId);
  if (!row) return null;
  return {
    ...row,
    players: JSON.parse(row.players),
    board: JSON.parse(row.board),
    moves: JSON.parse(row.moves),
  };
}

function listActiveGames() {
  return stmts.listActive.all().map(row => ({
    ...row,
    players: JSON.parse(row.players),
    moves: JSON.parse(row.moves),
  }));
}

function listFinishedGames() {
  return stmts.listFinished.all().map(row => ({
    ...row,
    players: JSON.parse(row.players),
    moves: JSON.parse(row.moves),
  }));
}

function saveMessage(gameId, sender, content) {
  const now = new Date();
  const created_at = now.toISOString();
  const result = stmts.insertMessage.run({ game_id: gameId, sender, content, created_at });
  return { id: result.lastInsertRowid, game_id: gameId, sender, content, created_at };
}

function getMessages(gameId, sinceId = 0) {
  if (sinceId > 0) {
    return stmts.getMessagesSince.all(gameId, sinceId);
  }
  return stmts.getMessages.all(gameId);
}

module.exports = { saveGame, loadGame, listActiveGames, listFinishedGames, saveMessage, getMessages };
