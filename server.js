import express from 'express'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import { mkdirSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs'
import {
  openDatabase,
  getNote,
  updateNote,
  recordImage,
  findImage,
  removeImage,
  listImages,
  removeAllImages,
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
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
    cb(allowed.includes(file.mimetype) ? null : new Error('Nur PNG, JPEG, GIF oder WebP.'), allowed.includes(file.mimetype))
  }
})

// Multer's MIME value is client supplied. Check the stored header before making
// the file reachable under /uploads; SVG is deliberately not an upload format.
function hasImageSignature(filename) {
  const fd = openSync(filename, 'r')
  const header = Buffer.alloc(12)
  const bytes = readSync(fd, header, 0, header.length, 0)
  closeSync(fd)
  return (
    (bytes >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (bytes >= 3 && header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ||
    (bytes >= 6 && ['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString())) ||
    (bytes >= 12 && header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP')
  )
}

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

function hasOnlyUploadImageSources(node) {
  if (!node || typeof node !== 'object') return true
  if (node.type === 'image' && !String(node.attrs?.src ?? '').startsWith('/uploads/')) return false
  return !Array.isArray(node.content) || node.content.every(hasOnlyUploadImageSources)
}

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.join(__dirname, 'public')))
app.use('/uploads', express.static(UPLOADS_DIR))

app.get('/api/note', (_req, res) => {
  const { content, updatedAt, revision } = getNote(db)
  res.json({ content, updatedAt, revision })
})

app.put('/api/note', (req, res) => {
  const { content } = req.body
  if (!isTiptapDoc(content) || !hasOnlyUploadImageSources(content)) {
    return res.status(422).json({ error: 'Ungültiger Inhalt.' })
  }
  const { updated_at: updatedAt, revision } = updateNote(db, content)
  res.json({ ok: true, updatedAt, revision })
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
    if (!hasImageSignature(req.file.path)) {
      unlinkSync(req.file.path)
      return res.status(400).json({ error: 'Dateiinhalt ist kein unterstütztes Bild.' })
    }
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

app.delete('/api/note', (_req, res) => {
  const images = listImages(db)
  const emptyDoc = { type: 'doc', content: [] }
  const clearNote = db.transaction(() => {
    removeAllImages(db)
    return updateNote(db, emptyDoc)
  })
  const { updated_at: updatedAt, revision } = clearNote()
  for (const { filename } of images) {
    try { unlinkSync(path.join(UPLOADS_DIR, filename)) } catch {}
  }
  res.json({ ok: true, updatedAt, revision })
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

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültiges JSON.' })
  console.error('unhandled request error:', err)
  res.status(500).json({ error: 'Interner Serverfehler.' })
})

const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => console.log(`notiz running on :${PORT}`))