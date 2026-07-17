// Geteilte DB-Schicht für server.js und scripts/init-db.js.
// Schema-Statements sind idempotent; applySchema() läuft bei jedem Start.

import Database from 'better-sqlite3'

// SQL-Statements in der Reihenfolge, in der sie ausgeführt werden müssen.
// note + INSERT-Seed zuerst (wird von note_images nicht referenziert, aber
// semantisch die Haupttabelle), dann note_images.
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS note (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS note_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `INSERT OR IGNORE INTO note (id, content) VALUES (1, '{}')`,
]

export function applySchema(db) {
  for (const stmt of SCHEMA_STATEMENTS) db.prepare(stmt).run()
}

// Öffnet die DB, schaltet WAL ein, legt Schema an. Einziger Konstruktor-Pfad.
export function openDatabase(dbPath) {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  applySchema(db)
  return db
}

// Repository-Funktionen -- die einzigen Stellen, die SQL auf note/note_images
// absetzen. Caller (server.js) hantiert nur mit domain-Begriffen (getNote,
// updateNote, recordImage, ...), nicht mit SQL.

// Liefert den geparsten Inhalt der Singleton-Notiz.
export function getNote(db) {
  const row = db.prepare('SELECT content FROM note WHERE id = 1').get()
  return JSON.parse(row.content)
}

// Ersetzt den Notiz-Inhalt. Caller muss content validiert haben (Object).
export function updateNote(db, content) {
  db.prepare(
    'UPDATE note SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
  ).run(JSON.stringify(content))
}

export function recordImage(db, filename) {
  db.prepare('INSERT INTO note_images (filename) VALUES (?)').run(filename)
}

export function findImage(db, filename) {
  return db.prepare('SELECT id FROM note_images WHERE filename = ?').get(filename)
}

export function removeImage(db, filename) {
  db.prepare('DELETE FROM note_images WHERE filename = ?').run(filename)
}