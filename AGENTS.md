# AGENTS.md — Working Rules for AI Assistants

This file is the single source of truth for coding conventions, architecture
boundaries, and anti-patterns in this repository. Read it fully before making
any non-trivial change.

## Project at a glance

- **Name:** Notiz-Benduhn
- **Purpose:** Single shared note (one document for everyone). Real-time sync
  via short-poll PUT, not WebSockets. Editor = Tiptap via ESM-CDN, no build step.
- **Version:** `v0.1.0` — kept in sync between `package.json` and
  `public/index.html` `<title>` + `#app-version` span.
- **Stack:** Node 18+ ES-Modules, Express 4, better-sqlite3 12, Multer 2,
  Tiptap 2 (CDN), vanilla CSS, Playwright 1.61 (tests only).

## File map

| Path                      | Role                                              |
| ------------------------- | ------------------------------------------------- |
| `server.js`               | HTTP API + DB init + image upload                 |
| `scripts/init-db.js`      | CLI migration (mirrors `server.js` schema)        |
| `public/index.html`       | Static shell + theme boot script                  |
| `public/app.js`           | Tiptap editor, slash menu, image NodeView, dialog |
| `public/style.css`        | All styling, dark mode via `[data-theme="dark"]`  |
| `public/manifest.json`    | PWA manifest + share-target                       |
| `public/service-worker.js`| App-shell cache + share-target POST handler       |
| `tests/e2e/flows.spec.js` | Playwright E2E covering 5 user flows + UX audits  |
| `playwright.config.js`    | Two projects: desktop-chrome, mobile-iphone14     |
| `compose.yaml` / `Dockerfile` | Container build, port 8085, volume `/data`   |

## Code conventions

- **ES Modules** (`import`/`export`), `"type": "module"` in `package.json`.
- **2-space** indentation. **Double quotes** for strings. No semicolons stripped
  (style is mixed in existing files — match the surrounding file).
- **German** user-facing text (titles, errors, dialogs). **English** identifiers
  (variables, functions, routes).
- **Lowercase** route names (`/api/note`, `/api/images`). Resources are
  singular when there's only one instance (`note`, `note_images`).
- **No build step.** Frontend loads Tiptap + plugins via `https://esm.sh/`.
  Do not introduce a bundler.
- **No frameworks on the frontend.** Vanilla JS only. DOM helpers must come
  from this file or stdlib (`document.*`, `AbortController`, etc.).

## Architecture boundaries (HARD)

1. **DB access only in `server.js` and `scripts/init-db.js`.** No
   `better-sqlite3` import anywhere else. Frontend never touches SQLite.

2. **One row, one note.** The `note` table has `CHECK (id = 1)`. Never
   `INSERT` a second row. Treat the singleton as the source of truth for the
   entire document.

3. **PUT `/api/note` is the only write path for note content.** Frontend caches
   nothing across reloads — it re-fetches on every page load.

4. **Image lifecycle:**
   - Upload → `POST /api/images` (multipart, field `image`).
   - Server stores file under `UPLOADS_DIR` and inserts row in `note_images`.
   - Frontend inserts the image as a Tiptap NodeView (see
     `createImageNodeView`), referencing the returned `url`.
   - Delete → `DELETE /api/images/:filename` removes DB row and file.
   - The `url` in the doc must point to an existing `note_images` row, otherwise
     it's a dangling reference (server cannot detect this; consider it a
     consistency rule).

5. **Tiptap nodes with custom DOM = NodeView, full stop.** External DOM
   mutation around a node (`insertBefore`/`appendChild` outside PM's rendering
   pipeline) causes a re-render loop. See `createImageNodeView` for the
   sanctioned pattern.

6. **Editor reference is captured in module closure.** `public/app.js` defines
   `const editor = new Editor({...})` and closures capture it. Don't try to
   reach the editor from outside the module — expose operations via the
   closure, not by exposing `editor` on `window`.

## Anti-patterns (DO NOT)

- **No `window.confirm` / `window.alert`.** Use the `confirmDialog()` helper
  (native `<dialog>`). Why: blocking, unthemable, ugly on mobile.
- **No `:hover`-only UI for destructive actions.** Use
  `@media (hover: none)` to make touch devices see the control. The image
  delete button is the canonical example.
- **No direct DOM wrapping of editor content.** This is what triggered the
  infinite re-render loop before NodeView was introduced.
- **No multi-note support without an explicit decision.** Adding rows to the
  `note` table violates the `CHECK` constraint and breaks the assumption that
  one document == one row.
- **No bare `image/*` paths in saved content without a `note_images` row.**
  A `GET /uploads/<file>` works regardless, but `DELETE /api/images/<file>`
  then 404s and orphans the file.
- **No mutating state outside transactions.** When changing editor state from
  event handlers (toolbar buttons, slash commands), go through a Tiptap chain
  (`editor.chain().focus().<...>().run()`), not direct view manipulation.
- **No `eval`, no `Function()`, no inline event handlers in HTML.** CSP is
  not set, but don't make the codebase worse.

## Tiptap-specific gotchas (read before touching the editor)

- **Suggestion plugin's `onKeyDown` receives only `{ editor, event, range }`.**
  No `query`, no `items`. Derive both from `editor.state.doc.textBetween(
  range.from, range.to, '\n')` and re-run the filter. See `SlashMenu` in
  `public/app.js`.
- **`props.editor` is `undefined` inside `onKeyDown`.** Use the module-level
  `editor` closure variable instead.
- **`addNodeView()` must return a function `(props) => NodeView`, not a
  NodeView directly.** The function receives `{ node, getPos, view,
  decorations, editor, extension }`. Use `getPos()` for the current document
  position — do not cache `node` references (ProseMirror nodes are immutable;
  the reference goes stale on the next transaction).

## Test conventions

- **Playwright only.** No Vitest, Jest, or Mocha — keep the dev-dep surface
  small.
- **Tests live in `tests/e2e/`** with names `*.spec.js`.
- **Workers must be 1** (`playwright.config.js`): all tests share the singleton
  note row.
- **Reset state per test** via `PUT /api/note` with `{content:{type:"doc",
  content:[]}}` in `beforeEach`.
- **Use real Chromium, not WebKit**, on this machine (WebKit needs gtk-4 +
  gstreamer). The mobile project emulates iPhone 14 viewport with
  `isMobile: true` + `hasTouch: true` on Chromium.
- **Assertion priority:** visible DOM state (`toBeVisible`, `toHaveText`,
  `toHaveCount`) over attribute/state queries. Visible-to-the-user is what
  matters.

## Inline documentation rule

- Every non-trivial helper (more than ~5 lines, or with non-obvious side
  effects) gets a **1–2 line comment explaining *why***, not *what*.
- Place the comment on the line above the function, not inside it (keeps the
  diff clean).
- Comments are in English even when the surrounding code is German UI.

## Commands

| Command            | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `npm install`      | Install all deps (incl. dev)                 |
| `npm run migrate`  | Run `scripts/init-db.js`, create tables      |
| `npm run dev`      | Start with `nodemon`, hot reload             |
| `npm start`        | Start without reload (production smoke test) |
| `npm run test:e2e` | Playwright suite (starts its own server)     |
| `node node_modules/@playwright/test/cli.js install chromium` | Browser install (no WebKit) |

## Environment variables

| Var           | Default                            | Notes                              |
| ------------- | ---------------------------------- | ---------------------------------- |
| `PORT`        | `3000`                             | Express listen port                |
| `DB_PATH`     | `data/notiz.db`                    | SQLite file path (parent auto-created) |
| `UPLOADS_DIR` | `<dirname DB_PATH>/uploads`        | Image storage                      |
| `NODE_ENV`    | unset                              | `development` enables `nodemon`    |