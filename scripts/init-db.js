#!/usr/bin/env node
// Datenbankinitialisierung mit better-sqlite3 (konsistent mit server.js)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../lib/db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'database.db')

try {
  const db = openDatabase(dbPath)
  db.close()
  console.log('Datenbankinitialisierung abgeschlossen:', dbPath)
} catch (err) {
  console.error('Migration fehlgeschlagen:', err.message)
  process.exit(1)
}