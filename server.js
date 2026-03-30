import express from 'express'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Database from 'better-sqlite3'
import multer from 'multer'
import { mkdirSync, unlinkSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, 'data', 'notiz.db')
const DATA_DIR = path.dirname(DB_PATH)
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(DATA_DIR, 'uploads')

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(UPLOADS_DIR, { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

db.prepare(`CREATE TABLE IF NOT EXISTS note (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
)`).run()

db.prepare(`CREATE TABLE IF NOT EXISTS note_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`).run()

db.prepare(`INSERT OR IGNORE INTO note (id, content) VALUES (1, '{}')`).run()

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
    cb(null, `${Date.now()}-${safe}`)
  }
})
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Nur Bilder'))
})

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.join(__dirname, 'public')))
app.use('/uploads', express.static(UPLOADS_DIR))

app.get('/api/note', (_req, res) => {
  const row = db.prepare('SELECT content FROM note WHERE id = 1').get()
  res.json({ content: JSON.parse(row.content) })
})

app.put('/api/note', (req, res) => {
  const { content } = req.body
  if (!content || typeof content !== 'object') {
    return res.status(400).json({ error: 'Ungültiger Inhalt.' })
  }
  db.prepare(
    'UPDATE note SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
  ).run(JSON.stringify(content))
  res.json({ ok: true })
})

app.post('/api/images', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei.' })
  db.prepare('INSERT INTO note_images (filename) VALUES (?)').run(req.file.filename)
  res.json({ url: `/uploads/${req.file.filename}` })
})

app.delete('/api/images/:filename', (req, res) => {
  const { filename } = req.params
  const target = path.resolve(UPLOADS_DIR, filename)
  // Path-Traversal-Schutz: aufgelöster Pfad muss innerhalb UPLOADS_DIR liegen
  if (!target.startsWith(UPLOADS_DIR + path.sep)) {
    return res.status(400).json({ error: 'Ungültiger Dateiname.' })
  }
  // Erst prüfen ob Datei in DB existiert
  const row = db.prepare('SELECT id FROM note_images WHERE filename = ?').get(filename)
  if (!row) return res.status(404).json({ error: 'Nicht gefunden.' })
  db.prepare('DELETE FROM note_images WHERE filename = ?').run(filename)
  try { unlinkSync(target) } catch { /* ignoriere wenn Datei fehlt */ }
  res.json({ ok: true })
})

const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => console.log(`notiz running on :${PORT}`))
