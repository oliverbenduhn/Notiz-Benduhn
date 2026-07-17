import express from 'express'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import multer from 'multer'
import { mkdirSync, unlinkSync } from 'node:fs'
import {
  openDatabase,
  getNote,
  updateNote,
  recordImage,
  findImage,
  removeImage,
} from './lib/db.js'

// Notiz-Benduhn HTTP-API.
// Eine geteilte Notiz (note.id = 1), Bild-Uploads unter UPLOADS_DIR.
// Schema-Init läuft idempotent beim Start; Spiegelung in scripts/init-db.js.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, 'data', 'notiz.db')
const DATA_DIR = path.dirname(DB_PATH)
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(DATA_DIR, 'uploads')

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(UPLOADS_DIR, { recursive: true })

const db = openDatabase(DB_PATH)

// Multer-Disk-Storage: Präfix mit ms-Zeitstempel verhindert Kollisionen
// und liefert stabile Sortierung; Safe-Rewrite schützt vor Path-Traversal.
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
  res.json({ content: getNote(db) })
})

app.put('/api/note', (req, res) => {
  const { content } = req.body
  if (!content || typeof content !== 'object') {
    return res.status(400).json({ error: 'Ungültiger Inhalt.' })
  }
  updateNote(db, content)
  res.json({ ok: true })
})

app.post('/api/images', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Datei zu gross (max. 10 MB).' })
      }
      return res.status(400).json({ error: err.message || 'Upload fehlgeschlagen.' })
    }
    if (!req.file) return res.status(400).json({ error: 'Keine Datei.' })
    recordImage(db, req.file.filename)
    res.json({ url: `/uploads/${req.file.filename}` })
  })
})

app.delete('/api/images/:filename', (req, res) => {
  const { filename } = req.params
  const target = path.resolve(UPLOADS_DIR, filename)
  // Path-Traversal-Schutz: aufgelöster Pfad muss innerhalb UPLOADS_DIR liegen
  if (!target.startsWith(UPLOADS_DIR + path.sep)) {
    return res.status(400).json({ error: 'Ungültiger Dateiname.' })
  }
  if (!findImage(db, filename)) return res.status(404).json({ error: 'Nicht gefunden.' })
  removeImage(db, filename)
  try { unlinkSync(target) } catch { /* ignoriere wenn Datei fehlt */ }
  res.json({ ok: true })
})

const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => console.log(`notiz running on :${PORT}`))