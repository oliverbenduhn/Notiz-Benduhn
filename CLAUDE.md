# CLAUDE.md

Claude-Code-specific notes for this repository. The full rule set lives in
[`AGENTS.md`](./AGENTS.md) — read that first.

## Context

Notiz-Benduhn is a single-shared-note PWA. The current code is **REST-only**
(Express + better-sqlite3 + Multer). There is **no Socket.io and no locking**
despite what older docs in this repo once said. If you see references to
`note:edit` / `note:state` / `activeLock` in the repo, they are stale — the
actual current events are HTTP `GET /api/note` and `PUT /api/note`.

The frontend is Tiptap loaded via ESM-CDN — **no build step**. UI logic is
vanilla JS in a single `public/app.js`. CSS in `public/style.css`.

## Tools and how to run them

| Task                         | Command                                                  |
| ---------------------------- | -------------------------------------------------------- |
| Boot the dev server          | `npm run dev` (port 3000)                                |
| Run migrations               | `npm run migrate`                                        |
| Run E2E tests                | `npm run test:e2e`                                       |
| Install Playwright browsers  | `node node_modules/@playwright/test/cli.js install chromium` |
| Inspect a single spec        | `node node_modules/@playwright/test/cli.js test tests/e2e/flows.spec.js:65` |
| Open trace for a failure     | `node node_modules/@playwright/test/cli.js show-trace test-results/<dir>/trace.zip` |

The Playwright suite starts its own server on `:3737` via `webServer` —
do not start the dev server before `npm run test:e2e`.

## Verification checklist before declaring done

For changes that touch the editor (`public/app.js`):

1. `npm run test:e2e` — all 13 specs must pass on both projects.
2. Manually load `http://localhost:3000`, type, save, reload, upload
   an image, delete an image — the round-trip is the real test.

For changes that touch the API (`server.js`):

1. `curl http://localhost:3000/api/note` returns the current content.
2. `curl -X PUT -H 'Content-Type: application/json' -d '{"content":{"type":"doc","content":[]}}' http://localhost:3000/api/note` succeeds.
3. `npm run test:e2e` still passes.

## Where to go for context

- [`AGENTS.md`](./AGENTS.md) — coding conventions, architecture boundaries,
  anti-patterns, Tiptap gotchas, test conventions.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — system overview, data
  model, API contract, deployment, ops runbook.
- [`README.md`](./README.md) — what the app is and how to run it.