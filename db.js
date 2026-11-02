const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'games.db');

// Ensure data directory exists
const fs = require('fs');
const DATA_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================================
// Schema
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS vault_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    content TEXT,
    filename TEXT,
    stored_name TEXT,
    mime TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS vault_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (item_id) REFERENCES vault_items(id)
  );

  CREATE INDEX IF NOT EXISTS idx_vault_revisions_item ON vault_revisions(item_id);
`);

// Platform tables (accounts, rooms, events) are created by the modules that own them.
module.exports = { db, DATA_DIR };
