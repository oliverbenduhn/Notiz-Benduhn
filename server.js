import express from "express";
import bodyParser from "body-parser";
import morgan from "morgan";
import sqlite3 from "sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "database.db");
sqlite3.verbose();

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
        db.all("PRAGMA table_info(notes)", (pragmaErr, columns) => {
          if (pragmaErr) return reject(pragmaErr);
          const columnNames = columns.map((col) => col.name);
          const expectedColumns = ["id", "content", "updated_at"];
          const isExpectedSchema =
            columnNames.length === expectedColumns.length &&
            expectedColumns.every((name) => columnNames.includes(name));

          const proceed = () => {
            ensureDefaultNote()
              .then(resolve)
              .catch(reject);
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
app.use(express.static(path.join(__dirname, "public")));

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
