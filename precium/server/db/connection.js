// Precium — conexión a la base de datos (SQLite, módulo node:sqlite incluido en Node 22).
// Crea el archivo y el esquema si todavía no existen. Si la base ya existía de antes de que
// se agregara la tabla de sesiones, la crea (migración mínima).

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = path.join(__dirname, 'schema.sql');

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const has = (name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!has('users')) {
    db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  } else if (!has('sessions')) {
    db.exec(`CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL);
      CREATE INDEX idx_sessions_user ON sessions (user_id);`);
  }
  db.exec("DELETE FROM sessions WHERE expires_at < datetime('now')");
  return db;
}

module.exports = { openDb };
