const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "data.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ig_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    ig_user_id TEXT,
    username TEXT,
    full_name TEXT,
    avatar TEXT,
    page_id TEXT,
    page_name TEXT,
    access_token TEXT,
    token_expiry TEXT,
    active INTEGER DEFAULT 1,
    link TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS scenarios (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    keywords TEXT DEFAULT '[]',
    dm_text TEXT DEFAULT '',
    follow_up INTEGER DEFAULT 0,
    account_ids TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS replies (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS event_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    account TEXT,
    type TEXT,
    message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_states (
    key TEXT PRIMARY KEY,
    data TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

module.exports = db;
