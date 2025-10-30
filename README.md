# Notiz-Benduhn
Eine Private PWA App für meine Notizen

## Projektstatus

- Status: In Entwicklung (Proof of Concept)
- Branch: `main`
- Kernfunktionen implementiert:
  - Echtzeit-Synchronisation einer einzigen Notiz zwischen Clients über WebSockets (Express + Socket.io)
  - Persistenz in einer lokalen SQLite-Datenbank (Migrationen über `scripts/init-db.js`)
  - Progressive Web App: `manifest.json`, `service-worker.js` und App-Icons sind vorhanden

## Architektur / Aufbau

- Backend: `server.js` (Express + Socket.io)
- Frontend: `public/` (`index.html`, `app.js`, `style.css`, `manifest.json`, `service-worker.js`)
- Datenbank-/Skripte: `scripts/init-db.js` erstellt die nötigen Tabellen und die Datei `database.db`

## Setup (lokal)

Voraussetzungen: Node.js und npm installiert.

In der Projektwurzel ausführen (PowerShell-Beispiele):

```powershell
npm install
npm run migrate   # führt scripts/init-db.js aus und legt die SQLite-DB an
npm run dev       # startet den Server mit nodemon (Entwicklung)
# oder
npm start         # startet den Server ohne nodemon
```

Hinweis: Führe `npm run migrate` vor dem ersten Start aus oder nach Schemaänderungen.

## Socket.io-Ereignisse (kurz)

- `note:state` (Server → Client): { content, updatedAt } – wird bei Verbindung und nach Änderungen gesendet
- `note:edit` (Client → Server): { content } – speichert die Änderung und broadcastet sie
- `note:fetch` (Client → Server): fordert aktuellen Stand an (nützlich nach Reconnect)
- `note:error` (Server → Client): Fehlerhinweise beim Speichern

## Bekannte Einschränkungen und To-dos

- Keine automatisierten Tests vorhanden (manuelle Prüfungen empfohlen)
- `LICENSE` ist noch nicht hinzugefügt (noch kein rechtlicher Rahmen)
- `database.db` liegt lokal und gehört nicht ins Repo (wird in `.gitignore` ausgeschlossen)

## Nächste Schritte / Vorschläge

1. `LICENSE` (z. B. MIT) hinzufügen
2. Minimaltests einführen (z. B. mit `vitest` oder `jest`) und CI (GitHub Actions)
3. Optional: Backup-Skript für die Datenbank oder Remote-Synchronisation

## Projektstruktur (Kurz)

```text
server.js
public/
  ├─ index.html
  ├─ app.js
  ├─ style.css
  ├─ manifest.json
  └─ service-worker.js
scripts/
  └─ init-db.js
.gitignore
```

## Kontakt

Repository: `https://github.com/oliverbenduhn/Notiz-Benduhn`

---

Wenn du möchtest, erstelle ich jetzt die `LICENSE` (MIT) und ergänze ein kurzes GitHub Actions-Template für CI (z. B. Node.js-Test-Workflow).
