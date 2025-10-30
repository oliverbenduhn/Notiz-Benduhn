import express from "express";
import bodyParser from "body-parser";
import morgan from "morgan";
import sqlite3 from "sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "database.db");
sqlite3.verbose();

const db = new sqlite3.Database(DB_PATH);

const migrationStatements = [
  `CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    content TEXT,
    pos_x INTEGER DEFAULT 100,
    pos_y INTEGER DEFAULT 100,
    width INTEGER DEFAULT 220,
    height INTEGER DEFAULT 160,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )`
];

const runMigrations = () =>
  new Promise((resolve, reject) => {
    db.serialize(() => {
      for (const statement of migrationStatements) {
        db.run(statement, (err) => {
          if (err) reject(err);
        });
      }
      resolve();
    });
  });

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve(this);
      }
    });
  });

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });

const app = express();

app.use(morgan("dev"));
app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/workspaces", async (req, res) => {
  const { name } = req.body ?? {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "Workspace name is required." });
  }

  try {
    await dbRun("INSERT OR IGNORE INTO workspaces (name) VALUES (?)", [name]);
    const workspace = await dbGet("SELECT * FROM workspaces WHERE name = ?", [
      name
    ]);
    res.status(201).json(workspace);
  } catch (err) {
    console.error("Failed to create workspace:", err);
    res.status(500).json({ error: "Could not create workspace." });
  }
});

app.get("/api/workspaces/:name", async (req, res) => {
  const { name } = req.params;
  try {
    const workspace = await dbGet("SELECT * FROM workspaces WHERE name = ?", [
      name
    ]);
    if (!workspace) {
      return res.status(404).json({ error: "Workspace not found." });
    }
    const notes = await dbAll(
      "SELECT * FROM notes WHERE workspace_id = ? ORDER BY id ASC",
      [workspace.id]
    );
    res.json({ workspace, notes });
  } catch (err) {
    console.error("Failed to fetch workspace:", err);
    res.status(500).json({ error: "Could not fetch workspace." });
  }
});

app.post("/api/workspaces/:id/notes", async (req, res) => {
  const { id } = req.params;
  const {
    content = "",
    posX = 100,
    posY = 100,
    width = 220,
    height = 160
  } = req.body ?? {};

  try {
    const workspace = await dbGet("SELECT id FROM workspaces WHERE id = ?", [
      id
    ]);
    if (!workspace) {
      return res.status(404).json({ error: "Workspace not found." });
    }

    const result = await dbRun(
      `INSERT INTO notes (workspace_id, content, pos_x, pos_y, width, height)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, content, posX, posY, width, height]
    );
    const note = await dbGet("SELECT * FROM notes WHERE id = ?", [
      result.lastID
    ]);
    res.status(201).json(note);
  } catch (err) {
    console.error("Failed to create note:", err);
    res.status(500).json({ error: "Could not create note." });
  }
});

app.put("/api/notes/:id", async (req, res) => {
  const { id } = req.params;
  const { content, posX, posY, width, height } = req.body ?? {};

  const fields = [];
  const values = [];

  const pushField = (column, value) => {
    if (value !== undefined) {
      fields.push(`${column} = ?`);
      values.push(value);
    }
  };

  pushField("content", content);
  pushField("pos_x", posX);
  pushField("pos_y", posY);
  pushField("width", width);
  pushField("height", height);

  if (!fields.length) {
    return res.status(400).json({ error: "No updatable fields provided." });
  }

  try {
    await dbRun(
      `UPDATE notes
       SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [...values, id]
    );
    const note = await dbGet("SELECT * FROM notes WHERE id = ?", [id]);
    if (!note) {
      return res.status(404).json({ error: "Note not found." });
    }
    res.json(note);
  } catch (err) {
    console.error("Failed to update note:", err);
    res.status(500).json({ error: "Could not update note." });
  }
});

app.delete("/api/notes/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await dbRun("DELETE FROM notes WHERE id = ?", [id]);
    res.status(204).end();
  } catch (err) {
    console.error("Failed to delete note:", err);
    res.status(500).json({ error: "Could not delete note." });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const port = process.env.PORT ?? 3000;

runMigrations()
  .then(() => {
    app.listen(port, () => {
      console.log(`Webnote clone listening on http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to run migrations:", err);
    process.exit(1);
  });
