# Repository Guidelines

## Projektstruktur & Modulorganisation
Der Backend-Einstiegspunkt liegt in `server.js` und kombiniert Express mit Socket.io, um eine einzige Notiz in Echtzeit zu synchronisieren. Statische Assets (UI, Logik, Styles) liegen in `public/` (`index.html`, `app.js`, `style.css`). Das Frontend verbindet sich per WebSocket, empfängt `note:state`-Broadcasts und sendet Bearbeitungen via `note:edit`. Hilfsskripte wie die initiale Datenbankmigration befinden sich unter `scripts/` (`scripts/init-db.js`). Die erzeugte SQLite-Datei `database.db` wird im Projektstamm abgelegt und gehört nicht in die Versionsverwaltung.

## Build-, Test- und Entwicklungsbefehle
- `npm install`: Installiert Abhängigkeiten für Server und Hilfsskripte.
- `npm run dev`: Startet den Express-Server mit `nodemon`, lädt bei Quellcodeänderungen automatisch neu und nutzt `NODE_ENV=development`.
- `npm start`: Startet den Server ohne `nodemon`, gedacht für manuelle Produktionsprüfungen.
- `npm run migrate`: Führt `scripts/init-db.js` aus und legt notwendige Tabellen an; vor dem ersten Start und nach Schemaänderungen ausführen.

## Codestil & Benennungskonventionen
Halte dich an einheitliche Zweier-Einrückung, ES-Module (`import`/`export`) und bevorzugt doppelte Anführungszeichen, wie im bestehenden Code ersichtlich. Server-Routen sind klein geschrieben (`/api/note`) und spiegeln die einzige Ressource wider. Neue Dateien im Frontend sollten sprechende, kleingeschriebene Dateinamen erhalten (`note-status.js`). Linting ist nicht vorkonfiguriert; verwende bei Bedarf `npx prettier --write` mit dem Standardprofil und prüfe Änderungen manuell.

## Testleitlinien
Automatisierte Tests sind derzeit nicht eingerichtet. Ergänze bei neuen Features mindestens manuelle Prüfungen: Datenbankmigration (`npm run migrate`), Serverstart im Entwicklungsmodus, parallele Nutzung auf Desktop und Mobilgerät (gleichzeitiges Tippen prüfen), Verbindungstrennungen und Reconnect-Verhalten sowie manuelles Speichern/Aktualisieren über die Buttons. Wenn du Tests einführst, bevorzuge `vitest` oder `jest` und platziere Spezifikationen unter `tests/` mit Namen nach dem Muster `feature-name.spec.js`.

## Socket.io-Ereignisse
- `note:state` (Server → Client): Enthält `{ content, updatedAt }` und wird beim Verbindungsaufbau sowie nach jeder Änderung gesendet.
- `note:edit` (Client → Server): Übergibt `{ content }`, löst Persistierung in SQLite und Broadcast aus.
- `note:fetch` (Client → Server): Fordert den aktuellen Stand an, nützlich nach Reconnects.
- `note:error` (Server → Client): Teilt Fehler im Speichervorgang mit, Clients zeigen den Status an.

## Commit- & Pull-Request-Richtlinien
Formuliere Commit-Nachrichten auf Englisch und im Imperativ (`Improve auto-save feedback`). Ein Commit sollte eine logisch abgeschlossene Änderung enthalten. Pull Requests benötigen eine kurze Zusammenfassung (Problem, Lösung, Tests) und, falls vorhanden, Verweise auf Issue-IDs (`Fixes #12`). Füge Screenshots oder GIFs hinzu, wenn Frontend-Änderungen das Erscheinungsbild beeinflussen. Bitte führe `npm run migrate` sowie einen lokalen Smoke-Test aus, bevor du um Review bittest.
