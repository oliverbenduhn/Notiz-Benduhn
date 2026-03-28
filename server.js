import express from "express";
import bodyParser from "body-parser";
import morgan from "morgan";
import sqlite3 from "sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import multer from "multer";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, "database.db");
sqlite3.verbose();

const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(path.dirname(DB_PATH), "uploads");

mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Nur Bilddateien erlaubt."));
  }
});

const db = new sqlite3.Database(DB_PATH);
const NOTE_ID = 1;
const LOCK_DURATION_MS = 10000;

const createNotesTable = () =>
  new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE notes (
        id INTEGER PRIMARY KEY CHECK (id = ${NOTE_ID}),
        content TEXT DEFAULT '',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      (err) => {
        if (err) return reject(err);
        db.run(
          `INSERT INTO notes (id, content) VALUES (${NOTE_ID}, '')`,
          (insertErr) => {
            if (insertErr) reject(insertErr);
            else resolve();
          }
        );
      }
    );
  });

const ensureDefaultNote = () =>
  new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO notes (id, content)
       SELECT ${NOTE_ID}, '' WHERE NOT EXISTS (SELECT 1 FROM notes WHERE id = ${NOTE_ID})`,
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });

const runMigrations = () =>
  new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("DROP TABLE IF EXISTS workspaces", (dropErr) => {
        if (dropErr) return reject(dropErr);
        db.run(
          `CREATE TABLE IF NOT EXISTS note_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL UNIQUE,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          )`,
          (imgErr) => {
            if (imgErr) return reject(imgErr);
            db.all("PRAGMA table_info(notes)", (pragmaErr, columns) => {
              if (pragmaErr) return reject(pragmaErr);
              const columnNames = columns.map((col) => col.name);
              const expectedColumns = ["id", "content", "updated_at"];
              const isExpectedSchema =
                columnNames.length === expectedColumns.length &&
                expectedColumns.every((name) => columnNames.includes(name));

              const proceed = () => {
                ensureDefaultNote().then(resolve).catch(reject);
              };

              if (columnNames.length === 0) {
                createNotesTable().then(resolve).catch(reject);
              } else if (!isExpectedSchema) {
                db.run("DROP TABLE IF EXISTS notes", (dropNotesErr) => {
                  if (dropNotesErr) return reject(dropNotesErr);
                  createNotesTable().then(resolve).catch(reject);
                });
              } else {
                proceed();
              }
            });
          }
        );
      });
    });
  });

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

const getNoteState = async () => {
  const note =
    (await dbGet("SELECT content, updated_at FROM notes WHERE id = ?", [
      NOTE_ID
    ])) ?? {};
  const rawTimestamp = note.updated_at ?? null;
  let normalizedTimestamp = rawTimestamp;
  if (typeof rawTimestamp === "string") {
    const trimmed = rawTimestamp.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
      normalizedTimestamp = `${trimmed.replace(" ", "T")}Z`;
    }
  }
  return {
    content: note.content ?? "",
    updatedAt: normalizedTimestamp
  };
};

const updateNote = async (content) => {
  await dbRun(
    "UPDATE notes SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [content, NOTE_ID]
  );
  return getNoteState();
};

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

const insertImage = (filename) =>
  dbRun("INSERT INTO note_images (filename) VALUES (?)", [filename]);

const deleteImageRecord = (filename) =>
  dbRun("DELETE FROM note_images WHERE filename = ?", [filename]);

const getAllImages = () =>
  dbAll("SELECT id, filename, created_at FROM note_images ORDER BY created_at ASC");

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer);

let activeLock = null;
let lockTimeout = null;

const clearLock = () => {
  if (lockTimeout) {
    clearTimeout(lockTimeout);
    lockTimeout = null;
  }
  if (activeLock) {
    activeLock = null;
    io.emit("note:unlock");
  }
};

const setLock = (holderSocket) => {
  const holderId = holderSocket.id;
  const expiresAt = Date.now() + LOCK_DURATION_MS;
  if (lockTimeout) clearTimeout(lockTimeout);
  activeLock = { holderId, expiresAt };
  lockTimeout = setTimeout(() => {
    lockTimeout = null;
    activeLock = null;
    io.emit("note:unlock");
  }, LOCK_DURATION_MS);
  holderSocket.emit("note:lock", { ...activeLock, isSelf: true });
  holderSocket.broadcast.emit("note:lock", { ...activeLock, isSelf: false });
};

const isLockedFor = (socketId) =>
  activeLock &&
  activeLock.holderId !== socketId &&
  activeLock.expiresAt > Date.now();

app.use(morgan("dev"));
app.use(bodyParser.json({ limit: "1mb" }));
app.get('/manifest.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=UTF-8');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.get("/api/note", async (_req, res) => {
  try {
    res.json(await getNoteState());
  } catch (err) {
    console.error("Failed to load note:", err);
    res.status(500).json({ error: "Notiz konnte nicht geladen werden." });
  }
});

app.put("/api/note", async (req, res) => {
  const { content } = req.body ?? {};
  if (typeof content !== "string") {
    return res.status(400).json({ error: "Feld 'content' muss ein String sein." });
  }

  try {
    const state = await updateNote(content);
    io.emit("note:state", state);
    res.json(state);
  } catch (err) {
    console.error("Failed to save note:", err);
    res.status(500).json({ error: "Notiz konnte nicht gespeichert werden." });
  }
});

// Bilder statisch ausliefern
app.use("/uploads", express.static(UPLOADS_DIR));

// GET /api/images - alle Bilder auflisten
app.get("/api/images", async (_req, res) => {
  try {
    const rows = await getAllImages();
    const images = rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      url: `/uploads/${r.filename}`,
      createdAt: r.created_at
    }));
    res.json(images);
  } catch (err) {
    console.error("Failed to list images:", err);
    res.status(500).json({ error: "Bilder konnten nicht geladen werden." });
  }
});

// POST /api/images - Upload (ein oder mehrere Bilder)
app.post("/api/images", (req, res, next) => {
  upload.array("image", 10)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    const files = req.files ?? [];
    if (files.length === 0) {
      return res.status(400).json({ error: "Keine Dateien hochgeladen." });
    }
    const results = [];
    for (const file of files) {
      await insertImage(file.filename);
      results.push({ filename: file.filename, url: `/uploads/${file.filename}` });
    }
    res.json(results);
  } catch (err) {
    console.error("Upload failed:", err);
    res.status(500).json({ error: "Upload fehlgeschlagen." });
  }
});

// DELETE /api/images/:filename - Bild loeschen
app.delete("/api/images/:filename", async (req, res) => {
  const { filename } = req.params;
  if (!filename) {
    return res.status(400).json({ error: "Ungültiger Dateiname." });
  }
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!filePath.startsWith(UPLOADS_DIR + path.sep)) {
    return res.status(400).json({ error: "Ungültiger Dateiname." });
  }
  try {
    await deleteImageRecord(filename);
    await unlink(filePath).catch((err) => {
  if (err.code !== "ENOENT") console.warn("Could not delete file:", filePath, err.code);
});
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete failed:", err);
    res.status(500).json({ error: "Löschen fehlgeschlagen." });
  }
});

// POST /share-target - Android-Share (Bilder + Text)
app.post("/share-target", (req, res, next) => {
  upload.array("image", 10)(req, res, (err) => {
    if (err) {
      // Bei multer-Fehler (z.B. falscher MIME-Typ): trotzdem zu / weiterleiten
      return res.redirect(303, "/");
    }
    next();
  });
}, async (req, res) => {
  try {
    const files = req.files ?? [];
    for (const file of files) {
      await insertImage(file.filename);
    }
  } catch (err) {
    console.error("Share-target upload failed:", err);
  }
  res.redirect(303, "/");
});

app.use((_req, res) => {
  res.status(404).json({ error: "Route nicht gefunden." });
});

const PORT = process.env.PORT ?? 8085;

runMigrations()
  .then(() => {
    io.on("connection", async (socket) => {
      try {
        socket.emit("note:state", await getNoteState());
        if (activeLock && activeLock.expiresAt > Date.now()) {
          socket.emit("note:lock", {
            ...activeLock,
            isSelf: activeLock.holderId === socket.id
          });
        }
      } catch (err) {
        console.error("Initial state failed:", err);
      }

      socket.on("note:fetch", async () => {
        try {
          socket.emit("note:state", await getNoteState());
        } catch (err) {
          console.error("Fetch state failed:", err);
          socket.emit("note:error", "Notiz konnte nicht geladen werden.");
        }
      });

      socket.on("note:edit", async ({ content } = {}) => {
        if (isLockedFor(socket.id)) {
          socket.emit(
            "note:error",
            "Änderung gesperrt – bitte kurz warten."
          );
          socket.emit("note:lock", {
            ...activeLock,
            isSelf: activeLock.holderId === socket.id
          });
          return;
        }
        if (typeof content !== "string") return;
        try {
          const state = await updateNote(content);
          io.emit("note:state", state);
          setLock(socket);
        } catch (err) {
          console.error("Socket save failed:", err);
          socket.emit("note:error", "Notiz konnte nicht gespeichert werden.");
        }
      });

      socket.on("disconnect", () => {
        if (activeLock && activeLock.holderId === socket.id) {
          clearLock();
        }
      });
    });

    httpServer.listen(PORT, () => {
      console.log(`Server läuft auf http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Migration fehlgeschlagen:", err);
    process.exit(1);
  });
