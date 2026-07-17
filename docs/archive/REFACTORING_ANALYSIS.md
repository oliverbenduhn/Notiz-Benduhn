# SOLID/DRY Analyse und Refactoring-Empfehlungen

## Executive Summary

Die aktuelle Codebasis funktioniert, leidet aber unter mehreren architektonischen Problemen:
- **Monolithische Struktur**: Alle Verantwortlichkeiten in einzelnen Dateien
- **Fehlende Testbarkeit**: Direkte Abhängigkeiten, keine Dependency Injection
- **Code-Duplizierung**: Ähnliche Logik an mehreren Stellen
- **Komplexität**: Verschachtelte Callbacks, globale Variablen

**Geschätzter Refactoring-Aufwand**: 2-3 Tage für vollständige Umstrukturierung

---

## 🔴 Kritische SOLID-Verstöße

### 1. Single Responsibility Principle (SRP) - SCHWERWIEGEND

#### Problem: server.js (264 Zeilen, 8+ Verantwortlichkeiten)

**Aktuelle Verantwortlichkeiten in einer Datei:**
1. Datenbankverbindung & Konfiguration
2. Schema-Migrationen
3. Promise-Wrapper für SQLite
4. Business-Logik (getNoteState, updateNote)
5. Lock-Management (aktiveLock, setLock, clearLock, isLockedFor)
6. Express-Setup & Middleware
7. HTTP-Routen
8. Socket.io-Ereignisbehandlung

**Auswirkungen:**
- Unmöglich zu unit-testen ohne echte Datenbank
- Änderungen an einer Verantwortlichkeit beeinflussen andere
- 200+ Zeilen unübersichtlicher Code

#### Problem: public/app.js (511 Zeilen, 7+ Verantwortlichkeiten)

**Aktuelle Verantwortlichkeiten:**
1. Socket.io-Verbindungsverwaltung
2. UI-Status-Updates
3. Lock-Management (Client-seitig)
4. Font-Size-Persistierung
5. Formular-Status-Management
6. Share-Target-Integration
7. Service Worker-Kommunikation

---

### 2. Dependency Inversion Principle (DIP) - HOCH

#### Problem: Direkte SQLite-Abhängigkeit ohne Abstraktion

```javascript
// server.js - Zeile 15
const db = new sqlite3.Database(DB_PATH);  // Direkte Abhängigkeit!

// Überall im Code:
db.get(sql, params, callback);
db.run(sql, params, callback);
```

**Auswirkungen:**
- Unmöglich, andere Datenbanken zu verwenden
- Keine Mock-Datenbank für Tests
- Migrationen sind fest an SQLite gebunden

---

### 3. Open/Closed Principle (OCP) - MITTEL

#### Problem: Erweiterung erfordert Änderungen am Kern-Code

**Beispiel: Neue Note-Felder hinzufügen**
```javascript
// Änderungen nötig in:
// 1. server.js - createNotesTable()
// 2. server.js - runMigrations()
// 3. server.js - getNoteState()
// 4. server.js - updateNote()
// 5. scripts/init-db.js
// 6. public/app.js - applyRemoteState()
```

Stattdessen sollte es ein Schema-Objekt oder eine Konfiguration geben.

---

## 🟡 DRY-Verstöße (Don't Repeat Yourself)

### 1. Timestamp-Normalisierung - DUPLIZIERT

**In server.js (Zeilen 108-115):**
```javascript
const rawTimestamp = note.updated_at ?? null;
let normalizedTimestamp = rawTimestamp;
if (typeof rawTimestamp === "string") {
  const trimmed = rawTimestamp.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    normalizedTimestamp = `${trimmed.replace(" ", "T")}Z`;
  }
}
```

**In public/app.js (Zeilen 92-99):**
```javascript
if (typeof timestamp === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)) {
  date = new Date(timestamp);
} else if (typeof timestamp === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) {
  date = new Date(`${timestamp.replace(" ", "T")}Z`);
}
```

### 2. Promise-Wrapping-Pattern - WIEDERHOLT

```javascript
// Zeilen 86-92 (dbGet)
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

// Zeilen 94-101 (dbRun)
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) => {
      if (err) reject(err);
      else resolve(this);
    });
  });
```

Kann durch generische Lösung ersetzt werden.

### 3. Socket-Error-Handling - 5x WIEDERHOLT

```javascript
// app.js - Zeilen 325-357
socket.io.on("error", (err) => { ... });
socket.io.on("connect_error", (err) => { ... });
socket.io.on("reconnect_error", (err) => { ... });
socket.io.on("reconnect_failed", (err) => { ... });
socket.io.on("connect_timeout", () => { ... });
```

Alle verwenden `interpretSocketError()` mit leicht unterschiedlichen Kontexten.

### 4. Lock-Timer-Management - DUPLIZIERT

Client und Server haben ähnliche Lock-Timer-Logik mit `setTimeout`, `clearTimeout`, `clearInterval`.

---

## 🎯 Konkrete Refactoring-Schritte

### Phase 1: Backend-Architektur (Tag 1-2)

#### Schritt 1.1: Datenbank-Abstraktionsschicht erstellen

**Neue Datei: `lib/database/NoteRepository.js`**
```javascript
export class NoteRepository {
  constructor(db) {
    this.db = db;
  }

  async getNote(id) {
    const row = await this.db.get(
      "SELECT content, updated_at FROM notes WHERE id = ?",
      [id]
    );
    return row ? this.mapToNote(row) : null;
  }

  async updateNote(id, content) {
    await this.db.run(
      "UPDATE notes SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [content, id]
    );
    return this.getNote(id);
  }

  mapToNote(row) {
    return {
      content: row.content ?? "",
      updatedAt: this.normalizeTimestamp(row.updated_at)
    };
  }

  normalizeTimestamp(raw) {
    if (!raw || typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
      return `${trimmed.replace(" ", "T")}Z`;
    }
    return raw;
  }
}
```

**Vorteile:**
- ✅ Testbar mit Mock-Datenbank
- ✅ Timestamp-Logik zentral
- ✅ Einfach erweiterbar

#### Schritt 1.2: SQLite-Wrapper mit einheitlichem Interface

**Neue Datei: `lib/database/SqliteAdapter.js`**
```javascript
export class SqliteAdapter {
  constructor(database) {
    this.database = database;
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.database.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.database.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.database.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
}
```

#### Schritt 1.3: Lock-Management extrahieren

**Neue Datei: `lib/locking/LockManager.js`**
```javascript
export class LockManager {
  constructor(durationMs = 10000) {
    this.durationMs = durationMs;
    this.activeLock = null;
    this.lockTimeout = null;
  }

  acquire(holderId) {
    this.clear();

    const expiresAt = Date.now() + this.durationMs;
    this.activeLock = { holderId, expiresAt };

    return new Promise((resolve) => {
      this.lockTimeout = setTimeout(() => {
        this.clear();
        resolve();
      }, this.durationMs);
    });
  }

  isLockedFor(socketId) {
    return (
      this.activeLock &&
      this.activeLock.holderId !== socketId &&
      this.activeLock.expiresAt > Date.now()
    );
  }

  clear() {
    if (this.lockTimeout) {
      clearTimeout(this.lockTimeout);
      this.lockTimeout = null;
    }
    this.activeLock = null;
  }

  getState() {
    return this.activeLock;
  }
}
```

**Vorteile:**
- ✅ Testbar ohne Socket.io
- ✅ Wiederverwendbar
- ✅ Klare Verantwortlichkeit

#### Schritt 1.4: Socket-Handler extrahieren

**Neue Datei: `lib/socket/NoteSocketHandler.js`**
```javascript
export class NoteSocketHandler {
  constructor(noteRepository, lockManager) {
    this.noteRepository = noteRepository;
    this.lockManager = lockManager;
  }

  async handleConnection(socket, io) {
    // Initial state senden
    const note = await this.noteRepository.getNote(1);
    socket.emit("note:state", note);

    // Lock-Status senden
    const lockState = this.lockManager.getState();
    if (lockState && lockState.expiresAt > Date.now()) {
      socket.emit("note:lock", {
        ...lockState,
        isSelf: lockState.holderId === socket.id
      });
    }

    // Event-Handler registrieren
    socket.on("note:fetch", () => this.handleFetch(socket));
    socket.on("note:edit", (data) => this.handleEdit(socket, io, data));
    socket.on("disconnect", () => this.handleDisconnect(socket, io));
  }

  async handleFetch(socket) {
    try {
      const note = await this.noteRepository.getNote(1);
      socket.emit("note:state", note);
    } catch (err) {
      console.error("Fetch failed:", err);
      socket.emit("note:error", "Notiz konnte nicht geladen werden.");
    }
  }

  async handleEdit(socket, io, { content } = {}) {
    if (this.lockManager.isLockedFor(socket.id)) {
      socket.emit("note:error", "Änderung gesperrt – bitte kurz warten.");
      return;
    }

    if (typeof content !== "string") return;

    try {
      const note = await this.noteRepository.updateNote(1, content);
      io.emit("note:state", note);

      // Lock erwerben
      await this.lockManager.acquire(socket.id);
      io.emit("note:lock", {
        ...this.lockManager.getState(),
        isSelf: true
      });
      socket.broadcast.emit("note:lock", {
        ...this.lockManager.getState(),
        isSelf: false
      });
    } catch (err) {
      console.error("Edit failed:", err);
      socket.emit("note:error", "Notiz konnte nicht gespeichert werden.");
    }
  }

  handleDisconnect(socket, io) {
    const lockState = this.lockManager.getState();
    if (lockState && lockState.holderId === socket.id) {
      this.lockManager.clear();
      io.emit("note:unlock");
    }
  }
}
```

#### Schritt 1.5: Neue server.js (orchestriert nur noch)

**Refactored: `server.js`**
```javascript
import express from "express";
import bodyParser from "body-parser";
import morgan from "morgan";
import sqlite3 from "sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";

import { SqliteAdapter } from "./lib/database/SqliteAdapter.js";
import { NoteRepository } from "./lib/database/NoteRepository.js";
import { LockManager } from "./lib/locking/LockManager.js";
import { NoteSocketHandler } from "./lib/socket/NoteSocketHandler.js";
import { runMigrations } from "./lib/database/migrations.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "database.db");
const PORT = process.env.PORT ?? 8085;

// Dependencies erstellen
const rawDb = new sqlite3.Database(DB_PATH);
const db = new SqliteAdapter(rawDb);
const noteRepository = new NoteRepository(db);
const lockManager = new LockManager(10000);
const socketHandler = new NoteSocketHandler(noteRepository, lockManager);

// Express-App
const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer);

app.use(morgan("dev"));
app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// HTTP-Routen
app.get("/api/note", async (_req, res) => {
  try {
    const note = await noteRepository.getNote(1);
    res.json(note);
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
    const note = await noteRepository.updateNote(1, content);
    io.emit("note:state", note);
    res.json(note);
  } catch (err) {
    console.error("Failed to save note:", err);
    res.status(500).json({ error: "Notiz konnte nicht gespeichert werden." });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Route nicht gefunden." });
});

// Socket.io
io.on("connection", (socket) => {
  socketHandler.handleConnection(socket, io);
});

// Server starten
runMigrations(db)
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`Server läuft auf http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Migration fehlgeschlagen:", err);
    process.exit(1);
  });
```

**Vorher:** 264 Zeilen, 8 Verantwortlichkeiten
**Nachher:** ~70 Zeilen, 1 Verantwortlichkeit (Orchestrierung)

---

### Phase 2: Frontend-Architektur (Tag 2-3)

#### Schritt 2.1: Socket-Manager extrahieren

**Neue Datei: `public/lib/SocketManager.js`**
```javascript
export class SocketManager {
  constructor(socket, callbacks) {
    this.socket = socket;
    this.callbacks = callbacks;
    this.isConnected = false;
    this.setupListeners();
  }

  setupListeners() {
    this.socket.on("connect", () => {
      this.isConnected = true;
      this.callbacks.onConnect?.();
    });

    this.socket.on("disconnect", (reason) => {
      this.isConnected = false;
      this.callbacks.onDisconnect?.(reason);
    });

    this.socket.on("note:state", (payload) => {
      this.callbacks.onNoteState?.(payload);
    });

    this.socket.on("note:lock", (payload) => {
      this.callbacks.onLock?.(payload);
    });

    this.socket.on("note:unlock", () => {
      this.callbacks.onUnlock?.();
    });

    this.socket.on("note:error", (message) => {
      this.callbacks.onError?.(message);
    });

    // Alle Error-Events zentral behandeln
    const errorEvents = ["error", "connect_error", "reconnect_error", "reconnect_failed"];
    errorEvents.forEach((event) => {
      this.socket.io.on(event, (err) => {
        this.callbacks.onSocketError?.(event, err);
      });
    });
  }

  emit(event, data) {
    this.socket.emit(event, data);
  }

  getSocketId() {
    return this.socket.id;
  }
}
```

#### Schritt 2.2: Status-Manager extrahieren

**Neue Datei: `public/lib/StatusManager.js`**
```javascript
export class StatusManager {
  constructor(statusElement) {
    this.element = statusElement;
  }

  set(message, variant = "idle") {
    this.element.textContent = message;
    this.element.dataset.variant = variant;
  }

  success(message) {
    this.set(message, "success");
  }

  error(message) {
    this.set(message, "error");
  }

  info(message) {
    this.set(message, "info");
  }
}
```

#### Schritt 2.3: Lock-UI-Manager extrahieren

**Neue Datei: `public/lib/LockUIManager.js`**
```javascript
export class LockUIManager {
  constructor(noteField, statusManager) {
    this.noteField = noteField;
    this.statusManager = statusManager;
    this.currentLock = null;
    this.lockTimer = null;
    this.countdownInterval = null;
    this.wasLockedForUs = false;
  }

  apply(lock, mySocketId) {
    this.clear();
    this.currentLock = lock;

    if (!lock) {
      this.unlock();
      return;
    }

    if (lock.isSelf || lock.holderId === mySocketId) {
      this.unlock();
      return;
    }

    this.lock(lock);
  }

  lock(lock) {
    this.wasLockedForUs = true;
    this.setEditingEnabled(false);

    const remainingMs = Math.max(0, lock.expiresAt - Date.now());

    this.updateCountdown();
    this.countdownInterval = setInterval(() => this.updateCountdown(), 1000);
    this.lockTimer = setTimeout(() => this.unlock(), remainingMs);
  }

  unlock() {
    const shouldNotify = this.wasLockedForUs;
    this.wasLockedForUs = false;
    this.setEditingEnabled(true);

    if (shouldNotify) {
      this.statusManager.success("Bearbeitung wieder möglich.");
    }
  }

  updateCountdown() {
    if (!this.currentLock) return;
    const remainingMs = Math.max(0, this.currentLock.expiresAt - Date.now());
    const seconds = Math.ceil(remainingMs / 1000);
    this.statusManager.info(
      `Bearbeitung durch anderen Nutzer gesperrt (${seconds}s)`
    );
  }

  setEditingEnabled(enabled) {
    this.noteField.readOnly = !enabled;
    this.noteField.classList.toggle("is-locked", !enabled);
    if (!enabled) {
      this.noteField.blur();
    }
  }

  clear() {
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  isLockedForMe() {
    if (!this.currentLock) return false;
    if (this.currentLock.expiresAt && this.currentLock.expiresAt < Date.now()) {
      return false;
    }
    return !this.currentLock.isSelf;
  }
}
```

---

## 📊 Vergleich: Vorher vs. Nachher

### Testbarkeit

**Vorher:**
```javascript
// Unmöglich zu testen ohne echte Datenbank
const getNoteState = async () => {
  const note = await dbGet("SELECT...", [NOTE_ID]);
  // ...
};
```

**Nachher:**
```javascript
// Unit-Test mit Mock
test("NoteRepository.getNote normalisiert Timestamps", async () => {
  const mockDb = {
    get: jest.fn().mockResolvedValue({
      content: "Test",
      updated_at: "2025-01-01 12:00:00"
    })
  };

  const repo = new NoteRepository(mockDb);
  const note = await repo.getNote(1);

  expect(note.updatedAt).toBe("2025-01-01T12:00:00Z");
});
```

### Komplexität

| Datei | Vorher (Zeilen) | Nachher (Zeilen) | Verantwortlichkeiten |
|-------|-----------------|------------------|---------------------|
| server.js | 264 | ~70 | 8 → 1 |
| app.js | 511 | ~150 | 7 → 2 |
| **Gesamt** | **775** | **~450** | **Besser strukturiert** |

### Erweiterbarkeit

**Beispiel: Multi-User-Notizen hinzufügen**

**Vorher:** Änderungen in 15+ Stellen
**Nachher:**
1. `NoteRepository` erweitern
2. Neue Route in `server.js`
3. UI-Komponente hinzufügen

---

## 🧪 Test-Strategie

### Unit-Tests (NEU)

```javascript
// tests/database/NoteRepository.test.js
import { NoteRepository } from "../../lib/database/NoteRepository.js";

describe("NoteRepository", () => {
  test("normalizeTimestamp konvertiert SQLite-Format", () => {
    const repo = new NoteRepository(null);
    const result = repo.normalizeTimestamp("2025-01-01 12:00:00");
    expect(result).toBe("2025-01-01T12:00:00Z");
  });
});

// tests/locking/LockManager.test.js
import { LockManager } from "../../lib/locking/LockManager.js";

describe("LockManager", () => {
  test("isLockedFor gibt true für andere Sockets", () => {
    const manager = new LockManager(10000);
    manager.acquire("socket1");
    expect(manager.isLockedFor("socket2")).toBe(true);
    expect(manager.isLockedFor("socket1")).toBe(false);
  });
});
```

### Integration-Tests (NEU)

```javascript
// tests/integration/note-api.test.js
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";

describe("Note API", () => {
  test("PUT /api/note speichert Content", async () => {
    const app = createTestApp();
    const response = await request(app)
      .put("/api/note")
      .send({ content: "Test" })
      .expect(200);

    expect(response.body.content).toBe("Test");
  });
});
```

---

## 🎬 Implementierungs-Plan

### Tag 1: Backend-Grundlagen
1. ✅ `lib/database/SqliteAdapter.js` erstellen
2. ✅ `lib/database/NoteRepository.js` erstellen
3. ✅ `lib/locking/LockManager.js` erstellen
4. ✅ Unit-Tests für alle drei Klassen schreiben
5. ⏳ server.js refactoren (Dependencies injizieren)

### Tag 2: Backend-Fertigstellung
1. ⏳ `lib/socket/NoteSocketHandler.js` erstellen
2. ⏳ `lib/database/migrations.js` extrahieren
3. ⏳ Integration-Tests schreiben
4. ⏳ Manuelles Testing mit original Frontend

### Tag 3: Frontend-Refactoring
1. ⏳ `public/lib/SocketManager.js` erstellen
2. ⏳ `public/lib/StatusManager.js` erstellen
3. ⏳ `public/lib/LockUIManager.js` erstellen
4. ⏳ `public/lib/FontSizeManager.js` erstellen
5. ⏳ `public/app.js` neu schreiben (orchestriert nur noch)

---

## 💡 Zusätzliche Empfehlungen

### 1. TypeScript Migration (Optional, +1 Tag)
Für noch bessere Typsicherheit und Refactoring-Sicherheit.

### 2. Dependency Injection Container (Optional, +0.5 Tag)
```javascript
// lib/container.js
export function createContainer(config) {
  const db = new SqliteAdapter(new sqlite3.Database(config.dbPath));
  const noteRepository = new NoteRepository(db);
  const lockManager = new LockManager(config.lockDuration);
  const socketHandler = new NoteSocketHandler(noteRepository, lockManager);

  return { db, noteRepository, lockManager, socketHandler };
}
```

### 3. Environment-basierte Konfiguration
```javascript
// config/default.js
export default {
  database: {
    path: process.env.DB_PATH || "./database.db"
  },
  lock: {
    durationMs: parseInt(process.env.LOCK_DURATION_MS) || 10000
  },
  server: {
    port: parseInt(process.env.PORT) || 8085
  }
};
```

---

## ✅ Zusammenfassung der Vorteile

| Aspekt | Vorher | Nachher |
|--------|--------|---------|
| **Testbarkeit** | ❌ Keine Tests möglich | ✅ Unit + Integration Tests |
| **Wartbarkeit** | ❌ 264-Zeilen-Monolith | ✅ Kleine, fokussierte Module |
| **Erweiterbarkeit** | ❌ Änderungen überall | ✅ Neue Features isoliert |
| **Wiederverwendbarkeit** | ❌ Alles gekoppelt | ✅ Module wiederverwendbar |
| **Verständlichkeit** | ❌ Komplex, verschachtelt | ✅ Klare Struktur |
| **DRY-Compliance** | ❌ Viel Duplikation | ✅ Logik zentral |

**Empfehlung:** Schrittweise Migration beginnen mit Backend-Klassen, da diese den größten ROI bringen.
