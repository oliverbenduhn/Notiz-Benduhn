// Geteilte DB-Schicht für server.js und scripts/init-db.js.
// Schema-Statements sind idempotent; applySchema() läuft bei jedem Start.

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// SQL-Statements in der Reihenfolge, in der sie ausgeführt werden müssen.
// note + INSERT-Seed zuerst (wird von note_images nicht referenziert, aber
// semantisch die Haupttabelle), dann note_images.
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS note (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    revision INTEGER NOT NULL DEFAULT 0
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
  const columns = db.prepare('PRAGMA table_info(note)').all()
  if (!columns.some(column => column.name === 'revision')) {
    db.prepare('ALTER TABLE note ADD COLUMN revision INTEGER NOT NULL DEFAULT 0').run()
  }
}

// Reine Connection ohne Schema. Erlaubt Tests, isoliert zu arbeiten.
export function connect(dbPath) {
  return new Database(dbPath)
}

// WAL separat, damit Migrationen / Tests gezielt darauf verzichten können.
export function enableWal(db) {
  db.pragma('journal_mode = WAL')
}

// Öffnet die DB, schaltet WAL ein, legt Schema an. Einziger Konstruktor-Pfad.
export function openDatabase(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = connect(dbPath)
  enableWal(db)
  applySchema(db)
  return db
}

// Repository-Funktionen -- die einzigen Stellen, die SQL auf note/note_images
// absetzen. Caller (server.js) hantiert nur mit domain-Begriffen (getNote,
// updateNote, recordImage, ...), nicht mit SQL.

// Liefert den geparsten Inhalt + updatedAt der Singleton-Notiz.
// Defektes JSON wird als leeres Doc zurückgegeben statt 500 zu werfen --
// sonst killt ein einziger defekter Row den Healthcheck (siehe Audit H5).
export function getNote(db) {
  const row = db.prepare('SELECT content, updated_at, revision FROM note WHERE id = 1').get()
  let content
  try {
    content = JSON.parse(row.content)
  } catch (err) {
    console.error('note.content unparsbar, liefere leeres Doc:', err.message)
    content = { type: 'doc', content: [] }
  }
  return { content, updatedAt: row.updated_at, revision: row.revision }
}

// Ersetzt den Notiz-Inhalt. Caller muss content validiert haben (Object).
// Gibt die neue updated_at zurück, damit der Client Konflikte erkennen kann.
export function updateNote(db, content) {
  db.prepare(
    'UPDATE note SET content = ?, updated_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE id = 1'
  ).run(JSON.stringify(content))
  return db.prepare('SELECT updated_at, revision FROM note WHERE id = 1').get()
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

export function listImages(db) {
  return db.prepare('SELECT filename FROM note_images').all()
}

export function removeAllImages(db) {
  db.prepare('DELETE FROM note_images').run()
}