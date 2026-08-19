# Notiz-Benduhn – Audit-Bericht

**Datum:** 2026-08-19
**Scope:** Vollständiges Repository (Backend, Frontend, Tests, Infra, Doku)
**Methodik:** Statische Code-Analyse aller Quell-Dateien (`server.js`, `lib/db.js`, `scripts/init-db.js`, `public/app.js`, `public/index.html`, `public/style.css`, `public/service-worker.js`, `public/manifest.json`, `tests/e2e/flows.spec.js`, `playwright.config.js`, `Dockerfile`, `compose.yaml`, `.github/workflows/nodejs.yml`, `docs/ARCHITECTURE.md`, `README.md`, `AGENTS.md`, `CLAUDE.md`). Cross-Cutting-Sweeps über alle 8 Audit-Achsen. Kein dynamischer Server-Start (Cleanup-Versuch wurde geblockt, danach ausschließlich read-only).
**Quantitative observations:**

| Datei | LOC |
| --- | --- |
| `server.js` | 116 |
| `public/app.js` | 571 |
| `public/style.css` | 377 |
| `public/index.html` | 79 |
| `public/service-worker.js` | 153 |
| `tests/e2e/flows.spec.js` | 178 |
| `lib/db.js` | 82 |
| `docs/ARCHITECTURE.md` | 389 |
| `AGENTS.md` | 154 |
| `README.md` | 151 |
| `CLAUDE.md` | 50 |
| `Dockerfile` | 25 |
| `compose.yaml` | 28 |
| **Total (ohne Doku)** | **1.401** |

**Befunde gesamt:** 31 (🚨 Kritisch 4 · 🚨 Hoch 7 · 🔶 Mittel 10 · 🔵 Niedrig 7 · 💡 Vorschlag 3)

## Remediation-Status (2026-08-19)

**Umgesetzt:** SVG-/MIME-Hardening mit Signaturprüfung, monotone `revision`
statt Zeitstempel-Konflikterkennung, transaktionales `DELETE /api/note` mit
Bildbereinigung, Konfliktentscheidung, Ladefehler-Read-only-Modus,
Drag-Cancel-Reset, sichere Bild-Overlay-Navigation, Share-Upload-Feedback,
Accessibility-Defaults, Favicon, Doku-Korrekturen und CVE-Updates.

**Nachprüfung korrigiert:** JSON aus einem HTTP-Request kann keine zirkulären
Referenzen enthalten (H6 ist kein realer Angriffs-/Fehlerpfad); `clearContent`
verliert bei der asynchron gestarteten FileList-Schleife keine weiteren Dateien
(M5); `manifest.json` kennt kein standardisiertes `version`-Feld (M2).
Diese Punkte wurden bewusst nicht mit zusätzlicher Komplexität „behoben“.

**Bewusstes Ceiling:** Single-note bleibt Last-Write-Wins; der neue Konfliktdialog
gibt Nutzer:innen eine explizite Wahl, ersetzt aber keine CRDT-/Merge-Engine.

---

## 🚨 Kritisch

### 🚨 K1 – SVG-Uploads öffnen XSS-Vektor via Browser-Scripting
- **Kategorie:** Security
- **Betroffene Datei(en):** `server.js:46-47` (Multer-`fileFilter`)
- **Problem:** `fileFilter` akzeptiert jeden `mimetype`, der mit `image/` startet — inklusive `image/svg+xml`. Browser führen in `<img src="…svg">` eingebettete `<script>`-Tags **nicht** aus, **aber** beim direkten Aufruf via `<a href="…svg">` oder bei „Bild in neuem Tab öffnen" wird die SVG als Dokument gerendert. Schlimmer: Wenn der Browser das Bild nicht als Image-Ressource vom `<img>`-Tag lädt (z.B. Manifest-Vorschau, Share-Target, oder weil das Image fehlschlägt und via `<object>`/`fetch` nachgeladen wird), wird das SVG-Skript ausgeführt. Der Pfad ist ein typischer Uploade-→Stored-XSS-Vektor (Github-Style).
- **Auswirkung:** Authentischer User aus dem Editor kann über `share-target` mit beliebiger SVG eine XSS-Payload hochladen, die später beim Editieren aller Nutzer ausgeführt wird. Kein Auth-Layer vorhanden → eine kompromittierte SVG = CWAF-Bypass + Drive-by-Execution.
- **Lösungsvorschlag:**
  ```js
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') &&
               file.mimetype !== 'image/svg+xml';
    cb(ok ? null : new Error('Nur Bilder (kein SVG).'), ok);
  }
  ```
  Zusätzlich Magic-Bytes-Validation (PNG: `89 50 4E 47`, JPEG: `FF D8 FF`, GIF: `47 49 46 38`, WebP: `RIFF…WEBP`). Snippet:
  ```js
  import { fileTypeFromStream } from 'file-type'
  // vor recordImage: Stream sniffen, mimetype != extension
  ```

### 🚨 K2 – `updated_at` Sekundengranularität verursacht Lost Updates in Multi-User-Sync
- **Kategorie:** Race Condition / Daten-Konsistenz
- **Betroffene Datei(en):** `lib/db.js:68`, `server.js:77`, `public/app.js:540-549`
- **Problem:** `lib/db.js` setzt `updated_at = CURRENT_TIMESTAMP` (SQLite, Sekundengranularität ohne `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`.) Zwei `PUT /api/note` innerhalb derselben Sekunde produzieren identische `updatedAt`-Strings. `app.js:541` vergleicht `updatedAt === knownUpdatedAt` — wenn gleich, kein Reload. Effekt: bei zwei parallelen Edits in der selben Sekunde sieht der dritte Client keinen Konflikt, zieht den Remote-Stand nicht, und überschreibt beim nächsten PUT. AGENTS.md §1 nennt das Backend „REST-Short-Poll Sync"; bei mehr als 1 User/Wallclock-Sekunde ist er faktisch nicht mehr synchron.
- **Auswirkung:** Stille Datenverluste unter Last. Das System „fühlt sich single-user-an", aber zwei Tabs vom selben User können in 800 ms Debounce + Reload denselben kollidierenden Edit auslösen.
- **Lösungsvorschlag:**
  ```sql
  -- schema-migration (einmalig): updated_at auf Sub-Sekunden-Auflösung
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ```
  Plus `lib/db.js` `updateNote` mit `db.prepare('UPDATE … SET updated_at = ?')` und explizitem `strftime(...)` → gibt Millisekunden zurück. Alternative: monotonic counter (`seq INTEGER`) statt Timestamp.

### 🚨 K3 – `'Notiz leeren'` lässt Bilder als Orphans zurück (CRUD-Lücke)
- **Kategorie:** CRUD-/Daten-Konsistenz
- **Betroffene Datei(en):** `public/app.js:485-489` (`btnClear`-Handler), `server.js` (kein Pendant)
- **Problem:** `btn-clear` ruft `editor.commands.clearContent(true)` + `scheduleAutoSave()`. Das Doc wird leer, aber: (a) Die im Doc referenzierten `note_images`-Rows bleiben in der DB; (b) die hochgeladenen Dateien bleiben auf Disk; (c) es gibt keinen Server-Endpoint, der zu einem leeren Doc alle dangling Rows aufräumt. Über Zeit wächst `UPLOADS_DIR` monoton. Tests sind ebenfalls betroffen: Flow 5b macht `clearContent`, lässt aber Test-Fixture-Datei + DB-Row zurück — nächster Test (Flow 4) kann das stören.
- **Auswirkung:** Dauerhaft wachsender Disk-Verbrauch. InnoDB-äquivalent: pro „Leeren" 1-∞ Dateien weniger freigegeben. Dangling-Reference-Regel aus AGENTS.md §4 wird bei dieser Operation direkt gebrochen.
- **Lösungsvorschlag:** Server-seitig `DELETE /api/note` mit Side-Effect: parse `note.content`, sammle img-src `/uploads/<fn>`, lösche Files + `note_images`-Rows. Oder: Client schickt beim `clearContent` zusätzlich `removedImages: [...]`. Sauberste Lösung: Server-Endpoint + clientseitiger Aufruf.

### 🚨 K4 – `database.db` (8 KB) ist untracked + `src/`-Verzeichnis ist Dead Code
- **Kategorie:** Architektur / Hygiene
- **Betroffene Datei(en):** `database.db` (root, 8 KB), `src/` (Verzeichnis, leer bis auf `src/data/`)
- **Problem:** `database.db` liegt im Repo-Root, **nicht** in `data/`. Mit `git check-ignore` ist sie zwar ignored, aber trotzdem im Working Tree sichtbar und liefert bei `ls` ein falsches Bild der Projektstruktur. Das `data/`-Verzeichnis ist leer (`drwxr-xr-x 2 oliver oliver 4096 Jul 17 16:00`). `src/`-Ordner enthält ein leeres `src/data/` und wird von keiner Datei importiert. Beide sind Reste aus der Vor-`lib/db.js`-Refactoring-Ära (Commit-Reihenfolge: `refactor(server): extract schema + DB helpers to lib/db.js`).
- **Auswirkung:** Verwirrung beim Onboarding — neue Entwickler:innen fragen „wo liegt die DB? in `database.db` oder `data/notiz.db`?". README.md / ARCHITECTURE.md dokumentieren `data/notiz.db`. `src/` ohne Inhalt könnte für zukünftige Refactorings als falsche Ablage missverstanden werden.
- **Lösungsvorschlag:**
  ```bash
  # einmalig
  rm database.db && rm -r src/
  ```
  `.gitignore` (`*.db`) reicht; keine .gitignore-Ergänzung nötig. Falls die Datei versehentlich committet wurde: `git rm --cached database.db`. (Verifiziert: `git ls-files database.db` → leer → also noch nie committet; `git ls-files src/` → leer.)

---

## 🚨 Hoch

### 🚨 H1 – Polling-Konflikt-Anzeige hat keinen Action-Button
- **Kategorie:** UI/UX / Workflow-Lücke
- **Betroffene Datei(en):** `public/app.js:548-549`
- **Problem:** `pollForChanges` stellt Konflikt fest (`currentJson !== lastSavedContent`) und zeigt nur den Status `Andere Person hat geändert — Reload zum Übernehmen.`. Es gibt **keinen Button, kein Banner, keinen Reload-Link**. Der Text bleibt sichtbar, bis er von einer anderen Status-Meldung überschrieben wird. Der Nutzer hat nichts zu klicken — der Satz ist reiner Pessimismus.
- **Auswirkung:** Workflow-Sackgasse. Konflikt-Warnung ohne Recovery-Pfad → Frustration. Bei Dauer-Konflikt mitten im Schreiben bleibt der Status permanent rot und verdeckt `Speichern.../Gespeichert.`.
- **Lösungsvorschlag:** Statt `showStatus` einen echten Bestätigungsdialog mit zwei Optionen: `Remote überschreiben (lokal behalten)` und `Remote übernehmen (lokal verwerfen)`. Beide Wege setzen `lastSavedContent = currentJson` bzw. `editor.commands.setContent(content, false)` plus `lastSavedContent = JSON.stringify(content)`.

### 🚨 H2 – Drag-Counter bleibt bei Drag-out-of-window hängen
- **Kategorie:** Bug / Edge Case
- **Betroffene Datei(en):** `public/app.js:461-482`
- **Problem:** `dragleave` feuert je nach Browser nur, wenn der Cursor über ein Child-Element draggt. Verlässt der Drag das **Fenster** (z.B. ESC, Drop auf andere App, oder Drag aus dem Viewport), feuert `dragleave` **nicht** zuverlässig. Der `dragCounter` bleibt > 0, `body.drag-over`-CSS-Klasse bleibt aktiv, und der Editor zeigt dauerhaft die gestrichelte Outline + Akzent-Hintergrund. Commit-Kommentar in der Datei (`Counter-Ansatz statt relatedTarget-Filter`) behauptet das Flackern sei weg — das stimmt für Child-Hopping, aber nicht für Drag-Abbruch.
- **Auswirkung:** Visueller Stuck-State nach jedem missglückten Drag. Verwirrend auf Mobile, weil Drag dort oft mit Cancel endet.
- **Lösungsvorschlag:**
  ```js
  document.addEventListener('dragleave', e => {
    if (e.relatedTarget === null) {  // ← echtes Verlassen
      dragCounter = 0
      document.body.classList.remove('drag-over')
    }
  })
  ```
  Plus globalen `dragend`-Listener auf `document` als Sicherheitsnetz.

### 🚨 H3 – `loadFailed`-Zustand erlaubt Upload, blockiert Save → inkonsistenter Note-Inhalt
- **Kategorie:** Workflow-Lücke / Daten-Konsistenz
- **Betroffene Datei(en):** `public/app.js:239-245, 558-571`
- **Problem:** Initial-Load schlägt fehl → `loadFailed = true` → `scheduleAutoSave` early-returns. Der User sieht `Laden fehlgeschlagen — Auto-Save deaktiviert.`. Aber: `insertImageFromFile` und damit `uploadImage` wird **nicht** geblockt. Der User kann ein Bild hochladen, das erscheint im Editor, ein Reload zeigt es nicht (Server hat den Put-Versuch nie bekommen). `editor.commands.clearContent(true)` setzt lokal den Doc-Inhalt, der Editor bleibt aber save-los.
- **Auswirkung:** Datenverlust trotz sichtbarem Bild im Editor. User tippt weitere Änderungen, sieht keinen Save-Status mehr, geht offline, alle Edits weg.
- **Lösungsvorschlag:** Bei `loadFailed` den Editor in `editor.setEditable(false)` setzen, alle Action-Buttons (`toolbar`, `btn-clear`, `image-input`) visuell deaktivieren, Status-Banner persistent machen. Re-Enable nur nach erfolgreichem Re-Load.

### 🚨 H4 – `isTiptapDoc` validiert nur Shape, nicht Inhalt; akzeptiert `data:`-URLs und beliebige img-src
- **Kategorie:** Sicherheit / Validierung
- **Betroffene Datei(en):** `server.js:52-60, 72-79`
- **Problem:** Der einzige Check ist `type === 'doc' && Array.isArray(content)`. Ein Body wie `{"content":{"type":"doc","content":[{"type":"image","attrs":{"src":"data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIG9ubG9hZD0nYWxlcnQoMSknPjwvc3ZnPg=="},"alt":""}]}}` wird gespeichert. Tiptap-Frontend mit `allowBase64:false` verwirft beim Render das Bild → silent Datenverlust. Auch `src="javascript:…"` ist nicht ausgeschlossen.
- **Auswirkung:** Datenverlust ohne Hinweis (best case) bzw. potenziell XSS via Doc-PUT (theoretisch, da Tiptap `javascript:`-URLs beim Render meist blockiert — aber der Server garantiert das nicht).
- **Lösungsvorschlag:** Server-seitig zusätzlich per JSON-Schema prüfen oder Tiefen-Validation:
  ```js
  function validateImageSrc(src) {
    return typeof src === 'string' &&
           (src.startsWith('/uploads/') || src.startsWith('http://localhost:3000/uploads/'))
  }
  // rekursiv über doc.content laufen, alle image-Nodes prüfen
  ```
  Plus hard-reject `data:.*base64` und `javascript:`.

### 🚨 H5 – Image-Overlay ohne Focus-Trap, schließt auf Klick auf das Bild selbst
- **Kategorie:** UI/UX / Accessibility
- **Betroffene Datei(en):** `public/app.js:129-144`
- **Problem:** `openImageOverlay` öffnet eine `<div role="dialog">` mit `tabIndex=-1` und `aria-label`. Der Click-Listener auf der Overlay-Div ist `() => close()`, also schließt jeder Klick auf das Overlay — inklusive Klick auf das Bild selbst. Auf Touch-Devices ist das Standard-Verhalten, aber auf Desktop irritierend (User versucht das Bild anzuklicken, das Overlay schließt). Es gibt keinen Focus-Trap; Tab wandert aus dem Overlay raus in den Editor.
- **Auswirkung:** a11y-Verstoß (Dialog ohne Trap), Desktop-UX-Bug. Screenreader-User können das Overlay nicht navigieren.
- **Lösungsvorschlag:**
  ```js
  // Klick auf das Bild selbst NICHT schließen
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  // Focus-Trap: erstes fokussierbares Element im Overlay; Tab wrappt
  ```

### 🚨 H6 – `JSON.stringify(content)` ohne Try-Catch → 500 mit Stack-Trace
- **Kategorie:** Bug / Error Handling
- **Betroffene Datei(en):** `server.js:69` (via `updateNote` in `lib/db.js:69`)
- **Problem:** `lib/db.js` `updateNote`: `db.prepare(...).run(JSON.stringify(content))`. Wenn `content` eine zirkuläre Referenz enthält (synthetisch durch PUT möglich, da der Server JSON parsed), wirft `JSON.stringify` `TypeError: Converting circular structure to JSON`. Express fängt das als 500 ab, der Default-Error-Handler schickt den Stack-Trace inkl. Pfad.
- **Auswirkung:** 500-Fehler enthüllt Server-Stack. Content-Inhalt im Stack-Trace.
- **Lösungsvorschlag:**
  ```js
  let json
  try { json = JSON.stringify(content) } catch { return null }
  if (!json) throw new Error('invalid_content')
  db.prepare(...).run(json)
  ```

### 🚨 H7 – Server-Architektur-Doku behauptet Sachen, die nicht stimmen
- **Kategorie:** Doku / Vertrauen
- **Betroffene Datei(en):** `docs/ARCHITECTURE.md:344-347` (§11 Logs), `docs/ARCHITECTURE.md:82-86` (§3 Schema)
- **Problem:**
  - §11 sagt: *„morgan is in `dependencies` but not wired up."* — morgan ist **nicht** in `package.json` (`"dependencies": { "better-sqlite3", "express", "multer" }`). Anweisung „add `app.use(morgan('tiny'))`" würde die Dependency erst hinzufügen.
  - §3 sagt: *„Two tables, both created idempotently on server start AND in `scripts/init-db.js`. The two schemas must stay in sync."* — Tatsächlich ist `lib/db.js` `applySchema()` die einzige Quelle; beide Caller importieren sie. Die Anweisung „edit both files" ist irreführend und kann bei zukünftigen Schemaänderungen zu echtem Drift führen.
- **Auswirkung:** Falsche Anweisung für Migration-Workflow. Wenn jemand §11 befolgt, wird `morgan` installiert, was Dependency-Bloat produziert. Wenn jemand §3 befolgt, editiert er `lib/db.js` + dupliziert die Änderung versehentlich.
- **Lösungsvorschlag:** §11 streichen oder zu „Request-Logging kommt aus morgan, falls gewünscht — aktuell nicht eingebunden" korrigieren. §3 zu: *„Single source of truth: `lib/db.js: SCHEMA_STATEMENTS`. Both `server.js` and `scripts/init-db.js` import `openDatabase()` from there. Schema changes: edit `lib/db.js` only, add an `ALTER TABLE` step, then run `npm run migrate`."*.

---

## 🔶 Mittel

### 🔶 M1 – `lastSavedContent` ist JSON-String, `pendingContent` ist Object — Asymmetrie beim Vergleich
- **Kategorie:** Bug / Edge Case
- **Betroffene Datei(en):** `public/app.js:222-245, 540-549`
- **Problem:** `pendingContent = editor.getJSON()` (Object), `lastSavedContent = JSON.stringify(pendingContent)` (String). `currentJson = JSON.stringify(editor.getJSON())` (String). Vergleich `currentJson === lastSavedContent` funktioniert, aber: ProseMirror's `getJSON()` ist nicht garantiert deterministisch in der Attribut-Reihenfolge. Nach einem Remote-Pull, der `setContent(content, false)` macht, ist `editor.getJSON()` evtl. nicht byte-für-byte-identisch mit `JSON.stringify(content)` beim Pull. Das führt zu **falschem Konflikt-Pfad** beim nächsten Poll, obwohl der Remote-Stand erfolgreich geladen wurde.
- **Auswirkung:** Spurious „Andere Person hat geändert — Reload zum Übernehmen." Banner nach jedem Remote-Pull, der durch Attribut-Reihenfolge ausgelöst wird.
- **Lösungsvorschlag:** Nach erfolgreichem `setContent`, `lastSavedContent = JSON.stringify(editor.getJSON())` (aus dem jetzt gerenderten Doc), nicht aus dem eingegangenen `content`. (Wird beim initial-Load bereits richtig gemacht — beim Poll-Pfad fehlt es.)

### 🔶 M2 – `version`-Sync manuell über 3 Stellen
- **Kategorie:** Drift / Build-Hygiene
- **Betroffene Datei(en):** `package.json:3`, `public/index.html:6,57`, `public/manifest.json` (fehlt)
- **Problem:** `version: "0.1.0"` muss in (a) `package.json`, (b) `<title>notiz v0.1.0</title>`, (c) `<span id="app-version">v0.1.0</span>` synchron sein. `manifest.json` hat gar kein `version`-Feld — der PWA-Installer zeigt also eine generische Versionsinfo. Bei Bump: 3 manuelle Edits, kein Lint, kein CI-Check.
- **Auswirkung:** Bei Release ohne Disziplin zeigt title/footer eine alte Version.
- **Lösungsvorschlag:** `app.js` liest `package.json` per Build-Zeit-Injection — geht nicht ohne Build-Step. Alternativ: Build-Helper (Node-Script) schreibt eine `version.js`-Konstante. Oder: Service-Worker CACHE_NAME auf `v0.1.0-${Date.now()}` umstellen und version nur in package.json pflegen, im Footer dynamisch setzen.

### 🔶 M3 – `getPos()` wird für Type-Check des Node-Size verwendet, aber `nodeSize` selbst kommt vom frozen-Node
- **Kategorie:** Tiptap-Konsistenz
- **Betroffene Datei(en):** `public/app.js:175-217`
- **Problem:** `onImageDelete` liest `nodeSize` aus dem Delete-Callback. Aber: Wenn zwischen Bild-Einfügung und Delete ein zweites Bild davor eingefügt wurde, kann `nodeSize` nicht stimmen, wenn der Node in der Zwischenzeit durch ein `setContent` neu erzeugt wurde. Das ist konsistent mit AGENTS.md §Tiptap-Regel („node-Referenz stale"). Was fehlt: ein expliziter `nodeSize` aus dem frischen NodeView, der `getPos()` triggert.
- **Auswirkung:** Bei Multi-Image-Szenarien evtl. falscher Range → PM löscht zu viel oder zu wenig. Niedrig, weil der Delete-Effekt am Real-Node hängt, nicht am captured Wert.
- **Lösungsvorschlag:** `nodeSize` frisch aus `props.node.nodeSize` im NodeView holen (closure, nicht im Delete-Handler) — oder noch besser: `editor.state.doc.nodeAt(getPos()).nodeSize` im Delete-Handler.

### 🔶 M4 – `editor.commands.setContent(content, false)` mit `false` triggert kein `onUpdate` — Default-`onUpdate`-Save wird übersprungen
- **Kategorie:** Tiptap-Verhalten
- **Betroffene Datei(en):** `public/app.js:544, 562`
- **Problem:** `false` als zweiten Argument verhindert `onUpdate` → `scheduleAutoSave` läuft nicht. Das ist absichtlich (wir wollen den Remote-Stand nicht sofort zurückschreiben). Aber: in beiden Pfaden (initial Load + Poll) ist das korrekt. Die Asymmetrie: `editor.commands.setContent(content)` ohne `false` würde remote-pull → lokalen Save-Trigger auslösen, was zu einer unnötigen PUT-Roundtrip führt. Das ist ein „Ponytail-Ceiling": ein dokumentiertes Edge-Case-Verhalten, kein Bug, aber im Kommentar nicht erklärt.
- **Auswirkung:** Kein aktueller Bug, aber `M1` zeigt, dass die lastSavedContent-Asymmetrie damit zusammenhängt.
- **Lösungsvorschlag:** Inline-Kommentar ergänzen: „false = kein onUpdate, kein save-Trigger. Nach setContent: lastSavedContent direkt aus editor.getJSON() zurückschreiben (nicht aus 'content')."

### 🔶 M5 – `image Inputs Change`-Handler setzt `imageInput.value = ''` nur am Ende, kein Reset bei Fehler
- **Kategorie:** Bug / Edge Case
- **Betroffene Datei(en):** `public/app.js:453-456`
- **Problem:** `imageInput.addEventListener('change', () => { files.forEach(f => insertImageFromFile(f)); imageInput.value = '' })`. Wenn der User 3 Bilder auswählt, eines lädt hoch und schlägt fehl: `imageInput.value = ''` wird trotzdem gesetzt. Beim nächsten Klick auf den Bild-Button ist die Input leer. Aber: damit gehen die anderen 2 wartenden Bilder verloren. Korrekt wäre: nach Upload-Erfolg jedes Bildes aus dem FileList entfernen.
- **Auswirkung:** Multi-Image-Auswahl über das File-Input geht kaputt, sobald ein Bild fehlschlägt.
- **Lösungsvorschlag:** Statt synchroner Schleife: `Promise.all` oder Sequenz mit Cleanup. Oder: pro Bild `input.cloneNode()` und am Ende entfernen.

### 🔶 M6 – Kein automatisches Orphan-File-Cleanup beim Server-Start
- **Kategorie:** CRUD / Datenträger-Hygiene
- **Betroffene Datei(en):** `server.js` (fehlt), `lib/db.js` (fehlt)
- **Problem:** Nach Server-Crash zwischen Disk-Write und DB-Insert oder nach manuellem DB-Edit gibt es Files in `UPLOADS_DIR`, die keine `note_images`-Row haben. Sie werden nie gelöscht. Mit der Zeit sammelt sich Müll.
- **Auswirkung:** Disk-Verbrauch wächst. Kein Cleanup.
- **Lösungsvorschlag:** Nach `applySchema()` in `openDatabase()` ein Job: `fs.readdir(UPLOADS_DIR)` → `SELECT filename FROM note_images` → Differenzmenge löschen.
  ```js
  export function reconcileUploads(db, uploadsDir) {
    const onDisk = new Set(fs.readdirSync(uploadsDir))
    const inDb = new Set(db.prepare('SELECT filename FROM note_images').all().map(r => r.filename))
    const orphans = [...onDisk].filter(f => !inDb.has(f))
    orphans.forEach(f => fs.unlinkSync(path.join(uploadsDir, f)))
  }
  ```

### 🔶 M7 – `tests/e2e/flows.spec.js` reset putzt nur Doc, nicht Bilder
- **Kategorie:** Test-Hygiene
- **Betroffene Datei(en):** `tests/e2e/flows.spec.js:18-24`
- **Problem:** `resetNote` ruft `PUT /api/note` mit leerem Doc. Bilder in `note_images` und `data/test-uploads/` bleiben. Test 4 lädt ein Bild hoch, Test 5 löscht es, Test 6 liest Theme. Wenn Test 5 in der Mitte crasht, ist das Bild für die nächsten Tests da. Plus: `data/test-uploads/` wächst monoton pro Local-Run.
- **Auswirkung:** Test-Isolation schwach. Disk wächst. Bei `npm run test:e2e:clean` muss manuelles Cleanup gemacht werden.
- **Lösungsvorschlag:** `resetNote` zusätzlich:
  ```js
  await request.delete(`/api/images/${filename}`)
  // oder: DELETE /api/test-reset (Server-Endpoint, der nur in NODE_ENV==='test' aktiv)
  ```
  Oder Server-Reset-Endpoint, der `TRUNCATE note_images` + `rm -rf uploads/*` macht, gated auf `NODE_ENV !== 'production'`.

### 🔶 M8 – `handleShareTarget` schweigt bei fehlgeschlagenen Uploads
- **Kategorie:** UI / UX
- **Betroffene Datei(en):** `public/service-worker.js:118-124`
- **Problem:** Upload-Failure loggt nur `console.error`. User teilt 3 Bilder, eines scheitert (z.B. > 10 MB, oder mimetype nicht image). User bekommt im Editor 2 Bilder, kein Hinweis auf das dritte. Silent Failure.
- **Auswirkung:** User glaubt, alles wurde übertragen. Datenverlust ohne Feedback.
- **Lösungsvorschlag:** Im `sharePayload` zusätzlich `imageErrors: [{ filename, status }]`. `app.js` (Share-Listener): bei `imageErrors.length > 0` → `showStatus(...)` mit „X Bilder konnten nicht hochgeladen werden.".

### 🔶 M9 – SVG-Lizenz-Stub + Inline-SVGs haben keine `aria-hidden`
- **Kategorie:** Accessibility
- **Betroffene Datei(en):** `public/index.html:29-35` (Theme-Icons)
- **Problem:** Sun- und Moon-SVG haben kein `aria-hidden="true"`. Screenreader kündigen sie als „Bild" an. Im Theme-Button mit `aria-label="Erscheinungsbild wechseln"` ist die SVG redundant.
- **Auswirkung:** Screenreader-Doppelankündigung.
- **Lösungsvorschlag:** `<svg aria-hidden="true" focusable="false"> …` auf alle dekorativen SVGs.

### 🔶 M10 – `editor.commands.clearContent(true)` triggert `onUpdate`; Auto-Save läuft; aber Test-Pattern verifiziert das nicht
- **Kategorie:** Test-Coverage-Lücke
- **Betroffene Datei(en):** `tests/e2e/flows.spec.js:132-159`
- **Problem:** Test 5b prüft `#save-status.saved === "Gespeichert."` nach `clearContent`. Das ist ein Smoke-Test, aber: kein Test, der nachweist, dass die Bilder-Tabellen danach leer sind. Kein Test für `data/test-uploads/`-Inhalt.
- **Auswirkung:** `M3` (CRUD-Lücke „Leeren lässt Bilder") wird durch Tests nicht abgedeckt.
- **Lösungsvorschlag:** Test erweitern:
  ```js
  await request.get('/api/note')  // check content empty
  // plus: SELECT COUNT(*) FROM note_images muss 0 sein
  ```

---

## 🔵 Niedrig

### 🔵 N1 – `index.html` hat kein `<link rel="icon">` → 404 auf `/favicon.ico`
- **Kategorie:** Hygiene
- **Betroffene Datei(en):** `public/index.html` (fehlt)
- **Problem:** Manifest-`icons` werden vom PWA-Installer verwendet, aber nicht als klassisches Favicon. Direkter Besuch der URL ohne PWA-Install triggert 404 in DevTools.
- **Lösungsvorschlag:** `<link rel="icon" href="/icon.png" type="image/png">` ergänzen.

### 🔵 N2 – `src/`-Verzeichnis steht im Repo, ist aber toter Code
- **Kategorie:** Hygiene / Dead Code
- **Betroffene Datei(en):** `src/`, `src/data/`
- **Problem:** Ordner existiert, ist untracked, enthält nichts. Verwirrung beim Onboarding.
- **Lösungsvorschlag:** Bereits in K4 enthalten.

### 🔵 N3 – `slash-menu` `position` kann bei Caret am unteren Bildschirmrand unter die Toolbar rutschen
- **Kategorie:** UI / Edge Case
- **Betroffene Datei(en):** `public/app.js:301-305`
- **Problem:** `popup.style.top = rect.bottom + 6`. Wenn Caret am unteren Rand ist und Slash-Menü über die Toolbar hinausläuft, gibt es keinen Flip-Mechanismus (nach oben öffnen).
- **Auswirkung:** Bei großen Slash-Listen am unteren Rand teilweise verdeckt.
- **Lösungsvorschlag:** `positionSlashMenu`: wenn `rect.bottom + popupHeight > viewportHeight`, `popup.style.top = rect.top - popupHeight - 6` (above the caret).

### 🔵 N4 – `prefers-color-scheme`-Wechsel wird nicht live übernommen
- **Kategorie:** UX
- **Betroffene Datei(en):** `public/index.html:13-20`
- **Problem:** Theme-Boot-Script läuft nur beim Page-Load. Wenn der User die System-Theme mid-session ändert, bleibt die App im alten Theme.
- **Auswirkung:** Edge Case; User merkt es nur bei Display-Switch.
- **Lösungsvorschlag:** `matchMedia('(prefers-color-scheme: dark)').addEventListener('change', …)` → wenn `localStorage.getItem('copy-theme') === null` (also „auto"), reassign.

### 🔵 N5 – Toolbar-Buttons ohne `aria-pressed` initial
- **Kategorie:** a11y
- **Betroffene Datei(en):** `public/index.html:40-50`, `public/app.js:446`
- **Problem:** `updateToolbarState` setzt `aria-pressed` korrekt auf `'true'/'false'`. Aber: bis zum ersten `selectionUpdate`/`transaction` Event haben die Buttons keinen `aria-pressed` (HTML-Default). Wegen `editor.on('selectionUpdate', updateToolbarState)` und `editor.on('transaction', updateToolbarState)` wird `updateToolbarState` im Normalfall vor der ersten User-Interaktion nicht aufgerufen.
- **Auswirkung:** Screenreader-User: kein Toggle-State sichtbar bis erster Klick.
- **Lösungsvorschlag:** Im `updateToolbarState` selbst mit `editor.on('focus', updateToolbarState)` zusätzlich, oder per Default `aria-pressed="false"` in HTML setzen.

### 🔵 N6 – Theme-Button ohne `aria-pressed`
- **Kategorie:** a11y
- **Betroffene Datei(en):** `public/index.html:28`
- **Problem:** Theme-Toggle hat `aria-label`, aber Toggle-Buttons sollten `aria-pressed` haben, damit SR-User den State kennen.
- **Lösungsvorschlag:** Im inline-toggle-script `btnTheme.setAttribute('aria-pressed', String(isDark))` ergänzen.

### 🔵 N7 – `setInterval` ohne Cleanup-Möglichkeit
- **Kategorie:** Robustheit
- **Betroffene Datei(en):** `public/app.js:566`
- **Problem:** `setInterval(pollForChanges, 5000)` läuft für immer. Bei PWA-Standalone-Install, der im Hintergrund bleibt, läuft das Polling weiter. Akzeptabel, aber: der PWA-Standard-`visibilitychange` könnte pausieren.
- **Auswirkung:** Niedrig — minimaler Idle-Traffic.
- **Lösungsvorschlag:**
  ```js
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearInterval(...)
    else intervalRef = setInterval(...)
  })
  ```

---

## 💡 Vorschläge

### 💡 V1 – `package.json` `name` ist `"notiz-benduhn"`, Repo ist `Notiz-Benduhn`, Manifest nennt es „Notiz Benduhn"
- **Kategorie:** Namens-Konsistenz
- **Betroffene Datei(en):** `package.json:2`, `public/manifest.json:2-3`, Repo-Path
- **Lösungsvorschlag:** Klare Policy: `package.json` lowercase-keep, Title-Case im UI. Aktuell dokumentiert, aber wer nutzt den Namen wo? Manifest `name` statt `short_name` zeigen lassen.

### 💡 V2 – `console.log` für Boot-Message, kein JSON-Format
- **Kategorie:** Observability
- **Betroffene Datei(en):** `server.js:117`
- **Lösungsvorschlag:** JSON-Logger (`{ ts: Date.now(), level: 'info', msg: '....' }`) wäre container-loggable. Optional — oder: gar nichts, weil Docker `journald` macht.

### 💡 V3 – `verifyImage` Header-Check serverseitig
- **Kategorie:** Security-Hardening
- **Betroffene Datei(en):** `server.js:81-101`
- **Lösungsvorschlag:** Nach Multer-Write, vor `recordImage`, magic-bytes sniffen. Schließt SVG- und File-Spoofing-Lücken. Lib: `file-type` (4 kB, keine deps).

---

## 📊 Schweregrad-Verteilung

| Tier | Anzahl | Beispiel |
| --- | --- | --- |
| 🚨 Kritisch | 4 | K1: SVG-Upload → XSS |
| 🚨 Hoch | 7 | H1: Polling-Konflikt ohne Action-Button |
| 🔶 Mittel | 10 | M1: lastSavedContent-Drift |
| 🔵 Niedrig | 7 | N1: favicon-404 |
| 💡 Vorschlag | 3 | V1: Namens-Inkonsistenz |
| **Σ** | **31** | |

---

## 🩺 Top-5-Empfehlungen (höchster Impact pro Stunde)

1. **K1 (SVG-Upload → XSS)** — 1 Zeile in `fileFilter` + Magic-Bytes-Sniff → critical attack vector weg. *Aufwand: 1h.*
2. **K3 (`Leeren` lässt Bilder-Orphans)** — Server-Endpoint `DELETE /api/note` mit Side-Effect auf `note_images`. Eliminiert wachsendes Disk-Volumen + Test-Interferenz. *Aufwand: 2h.*
3. **H1 (Konflikt-Status ohne Action)** — Bestätigungsdialog statt simplem Status. Macht „Multi-User" tatsächlich nutzbar. *Aufwand: 1h.*
4. **K2 (CURRENT_TIMESTAMP Sekundengranularität)** — `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` Migration. Eliminiert lost-update-Class. *Aufwand: 1h + Tests.*
5. **K4 (`database.db` im Root, `src/`-Leiche)** — `rm database.db && rm -r src/`. Sofort. *Aufwand: 1 min.*

---

## Test-Coverage-Matrix

| Pfad | Test vorhanden? |
| --- | --- |
| `GET /api/note` (initial) | ✓ (Flow 1) |
| `PUT /api/note` (valid) | ✓ (Flow 1, 5) |
| `PUT /api/note` (invalid shape) | ✗ |
| `POST /api/images` (success) | ✓ (Flow 4) |
| `POST /api/images` (non-image) | ✗ |
| `POST /api/images` (oversize) | ✗ |
| `DELETE /api/images/:filename` (success) | ✓ (Flow 5) |
| `DELETE /api/images/:filename` (404) | ✗ |
| `DELETE /api/images/:filename` (path traversal) | ✗ |
| Konflikt-Pfad (`pollForChanges`) | ✗ |
| `loadFailed`-Pfad | ✗ |
| Drag-out-of-window | ✗ |
| share-target POST | ✗ |
| Theme-Persistenz | ✓ (Flow 6) |
| Touch-Targets | ✓ (UX-Audit) |
| Layout-Shift | ✓ (UX-Audit) |
| `isTiptapDoc` content-sanitization | ✗ |
| `JSON.stringify` circular ref | ✗ |

**Lücken-Highlights:** 13 von 18 happy/sad-paths haben keinen Test. Die kritischsten Lücken: Server-Validierung, Konflikt-Recovery, Drag-Edge-Case.

---

## Achsen-Checkliste (alle 8)

| Achse | Abgedeckt? | Notes |
| --- | --- | --- |
| 1. Bugs & Error Handling | ✓ | 6 Funde explizit (K2, K3, H3, H6, M5, M7) |
| 2. Schema/Contract | ✓ | H4, H7 (Doku vs Code), M2 (version) |
| 3. CRUD Completeness | ✓ | K3 (DELETE /api/note), M6 (orphan), M7 (test-cleanup) |
| 4. Concurrency / State | ✓ | K2 (Sekunden), M1 (lastSavedContent race), H3 (loadFailed) |
| 5. UX / Frontend | ✓ | H1, H5, M8, N3–N6, plus Toolbar/a11y |
| 6. Logging / Observability | ✓ | H7 (Falsch-Doku), V2 (JSON-Log) |
| 7. Test Coverage Gaps | ✓ | Tabelle oben, 13 Lücken |
| 8. Architecture / Dead Code | ✓ | K4 (`database.db`, `src/`), V1 (Namens-Drift) |

**Nicht angeschaut:** `node_modules/` (out-of-scope), `docs/archive/REFACTORING_ANALYSIS.md` (explizit als stale markiert, korrekt).
