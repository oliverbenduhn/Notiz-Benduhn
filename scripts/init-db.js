#!/usr/bin/env node
// Datenbankinitialisierung mit better-sqlite3 (konsistent mit server.js)
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'database.db');

try {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS note (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS note_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO note (id, content) VALUES (1, '{}');
  `);

  db.close();
  console.log('Datenbankinitialisierung abgeschlossen:', dbPath);
} catch (err) {
  console.error('Migration fehlgeschlagen:', err.message);
  process.exit(1);
}
