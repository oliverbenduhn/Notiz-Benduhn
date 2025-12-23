#!/usr/bin/env node
import sqlite3 from "sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, "..", "database.db");

sqlite3.verbose();

const db = new sqlite3.Database(dbPath);

const statements = [
  "DROP TABLE IF EXISTS workspaces",
  "DROP TABLE IF EXISTS notes",
  `CREATE TABLE notes (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT DEFAULT '',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `INSERT INTO notes (id, content) VALUES (1, '')`
];

db.serialize(() => {
  for (const stmt of statements) {
    db.run(stmt, (err) => {
      if (err) {
        console.error("Migration fehlgeschlagen:", err.message);
        process.exitCode = 1;
      }
    });
  }
});

db.close((err) => {
  if (err) {
    console.error("Schließen der Datenbank fehlgeschlagen:", err.message);
    process.exitCode = 1;
  } else {
    console.log("Datenbankinitialisierung abgeschlossen:", dbPath);
  }
});
