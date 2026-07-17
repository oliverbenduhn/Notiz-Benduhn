import express from 'express'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import crypto from 'node:crypto'
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
// UPLOADS_DIR absolut auflösen, sonst matcht der Path-Traversal-Check
// unten nicht (Audit: gefixt während Implementierung).
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(DATA_DIR, 'uploads')

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(UPLOADS_DIR, { recursive: true })

const db = openDatabase(DB_PATH)

// Multer-Disk-Storage: ms-Zeitstempel + Zufallssuffix verhindert ms-Kollisionen
// unter Last; Safe-Rewrite schützt vor Path-Traversal.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`)
  }
})
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Nur Bilder'))
})

// Minimaler Doc-Shape-Check; tiefer kann/sollte der Server nicht prüfen,
// sonst wird er zum zweiten Editor. Root-Typ ist immer 'doc' (Tiptap-Konvention).
function isTiptapDoc(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.type === 'doc' &&
    Array.isArray(value.content)
  )
}

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.join(__dirname, 'public')))
app.use('/uploads', express.static(UPLOADS_DIR))

app.get('/api/note', (_req, res) => {
  const { content, updatedAt } = getNote(db)
  res.json({ content, updatedAt })
})

app.put('/api/note', (req, res) => {
  const { content } = req.body
  if (!isTiptapDoc(content)) {
    return res.status(422).json({ error: 'Ungültiger Inhalt.' })
  }
  const updatedAt = updateNote(db, content)
  res.json({ ok: true, updatedAt })
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
    // Atomarität: erst INSERT, dann antworten. Bei DB-Fehler die bereits
    // geschriebene Datei wieder entfernen, sonst wächst der Uploads-Ordner
    // mit jedem Fehler um ein Orphan (Audit H3).
    try {
      recordImage(db, req.file.filename)
    } catch (insertErr) {
      try { unlinkSync(path.join(UPLOADS_DIR, req.file.filename)) } catch {}
      return res.status(500).json({ error: 'Speichern fehlgeschlagen.' })
    }
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