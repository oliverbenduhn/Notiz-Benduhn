# Notiz-Benduhn

Eine geteilte Notiz als PWA. Eine einzige Notiz, ein Editor (Tiptap), ein
Backend (Express + SQLite + Multer), ein einziger Browser-Tab reicht.

**Status:** v0.1.0 — Kernpfad stabil, ~370 Zeilen Backend, kein Build-Step
fürs Frontend. E2E-Tests grün (Desktop + iPhone-14-Emulation).

## Tech-Stack

| Bereich       | Technologie                              |
| ------------- | ---------------------------------------- |
| Runtime       | Node.js ≥ 18 (ES-Modules, `"type":"module"`) |
| HTTP          | Express 4                                |
| Persistenz    | better-sqlite3 12 (WAL-Mode)             |
| Uploads       | Multer 2 (Disk-Storage, 10 MB Limit)     |
| Editor        | Tiptap 2 via ESM-CDN (kein Bundler)      |
| Styling       | Vanilla CSS, Light/Dark via `[data-theme]` |
| PWA           | Manifest + Service-Worker (Share-Target) |
| Tests         | Playwright 1.61 (Chromium)               |
| Container     | Node 20 Bookworm-Slim, Multi-Stage nicht nötig |

## Voraussetzungen

- **Node.js ≥ 18** lokal (für `better-sqlite3`-Native-Build wird ein C++-Toolchain
  benötigt; unter Linux `build-essential` + `python3`, unter macOS Xcode-CLI).
- Optional: Docker + Docker Compose für den Container-Deploy.
- Optional: Playwright-Browser für E2E-Tests — siehe unten.

## Quickstart (lokal)

```bash
git clone https://github.com/oliverbenduhn/Notiz-Benduhn.git
cd Notiz-Benduhn
npm install
npm run migrate       # legt data/notiz.db + Tabellen an
npm run dev           # nodemon auf http://localhost:3000
```

Im Browser `http://localhost:3000` öffnen — die Notiz ist sofort editierbar.
Beim Schreiben erscheint rechts oben `Speichern...` → `Gespeichert.`. Bilder
per Toolbar-Klick, Drag-&-Drop oder Paste hochladen.

### Andere Skripte

| Befehl            | Zweck                                              |
| ----------------- | -------------------------------------------------- |
| `npm start`       | Server ohne Hot-Reload (für Produktions-Smoke-Test) |
| `npm run migrate` | Nur DB anlegen/resetten                            |
| `npm run test:e2e`| Playwright-Suite (startet eigenen Test-Server)      |

## Deployment (Docker)

```bash
docker compose up -d --build
```

Konfiguration in `compose.yaml`:

- **Port:** `8085` (Container) → `8085` (Host). Mit Reverse-Proxy (Traefik/Caddy)
  davor üblicherweise `:443` exponieren.
- **Volume:** `notiz_data:/data` — enthält `database.db` und `uploads/`.
- **Healthcheck:** `GET http://localhost:8085/api/note` alle 30 s.
- **User:** läuft als unprivilegierter `node`-User.
- **DB-Pfad im Container:** `/data/database.db` (überschreibbar via
  `DB_PATH`-Env).

Update-Routine:

```bash
cd /etc/komodo/stacks/notiz-benduhn   # oder dein Stack-Pfad
git pull origin main
docker compose build --no-cache
docker compose up -d
```

## Umgebungsvariablen

| Variable       | Default                  | Bedeutung                              |
| -------------- | ------------------------ | -------------------------------------- |
| `PORT`         | `3000`                   | Express-Listen-Port                    |
| `DB_PATH`      | `data/notiz.db`          | SQLite-Datei (Parent wird angelegt); `npm run migrate` nutzt denselben Default |
| `UPLOADS_DIR`  | `<DB_PATH>/uploads`      | Speicherort für Bilder                 |
| `NODE_ENV`     | (leer)                   | `development` aktiviert `nodemon`      |

## Daten-Persistenz

- **Eine Notiz, eine Zeile.** Die `note`-Tabelle hat `CHECK (id = 1)`. Alle
  Clients sehen denselben Inhalt.
- **WAL-Mode** aktiv — SQLite schreibt parallel, Lesezugriffe blockieren nicht.
- **Backups:** einfachste Methode ist `cp` der `.db`-Datei nach
  `PRAGMA wal_checkpoint(TRUNCATE)`. Siehe `docs/ARCHITECTURE.md` § Backup
  für Details.

## Wichtige Dateien

```
server.js                  Express-API + DB-Init + Image-Upload
scripts/init-db.js         CLI-Migration (für npm run migrate)
public/app.js              Tiptap-Editor, Slash-Menu, Image-NodeView, Dialog
public/index.html          App-Shell + Theme-Boot-Script
public/style.css           Light/Dark-Theme
public/manifest.json       PWA-Manifest inkl. Share-Target
public/service-worker.js   App-Shell-Cache + Share-Target POST-Handler
tests/e2e/flows.spec.js    Playwright-Suite (5 Flows + 2 Audits)
docs/ARCHITECTURE.md       System-Architektur, Schema, API-Referenz
AGENTS.md                  KI-Regelwerk (Konventionen, Boundaries, Anti-Patterns)
```

## API-Kurzübersicht

| Methode | Pfad                        | Zweck                                  |
| ------- | --------------------------- | -------------------------------------- |
| `GET`   | `/api/note`                 | Aktuelle Notiz lesen                   |
| `PUT`   | `/api/note`                 | Notiz speichern (JSON-Body, ≤ 1 MB)    |
| `POST`  | `/api/images`               | Bild-Upload (multipart, ≤ 10 MB)       |
| `DELETE`| `/api/images/:filename`     | Bild löschen (DB-Eintrag + Datei)      |

Details, Payloads und Fehlercodes: siehe `docs/ARCHITECTURE.md`.

## Tests

```bash
node node_modules/@playwright/test/cli.js install chromium   # einmalig
npm run test:e2e
```

- **Worker seriell** (alle Tests teilen eine Notiz-Zeile).
- **Zwei Projekte:** Desktop-Chrome 1280×800 + iPhone-14-Emulation
  (Chromium, da WebKit gtk-4/gstreamer braucht).
- **Coverage:** 5 User-Flows + 2 UX-Audits (Touch-Targets, Layout-Shift).
- **Reset** pro Test via `PUT /api/note`.

## Bekannte Grenzen / Roadmap

- **Eine geteilte Notiz** für alle Clients. Kein Multi-Note, kein User-Account,
  keine Berechtigungen. Wenn Multi-Tenancy gebraucht wird: erst Architektur
  überarbeiten, dann implementieren.
- **Kein Auth.** Wer die URL kennt, kann schreiben. Für Public-Deploys
  unbedingt hinter Auth-Layer (Reverse-Proxy-Basic-Auth o. ä.).
- **Service-Worker-Share-Target** funktioniert nur über HTTPS (Web-App-Manifest-
  Voraussetzung).
- **WebKit-Support** für Playwright fehlt mangels System-Libraries (gtk-4,
  gstreamer). Nicht-blockierend für die aktuelle Test-Coverage.

## Lizenz

Siehe `LICENSE`.

## Kontakt

Repository: <https://github.com/oliverbenduhn/Notiz-Benduhn>