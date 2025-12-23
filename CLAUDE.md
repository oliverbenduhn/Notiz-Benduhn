# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Notiz-Benduhn is a Progressive Web App (PWA) for real-time synchronized note-taking. The app maintains a single shared note that synchronizes across multiple clients using WebSockets, with SQLite persistence.

## Commands

### Development
```bash
npm install              # Install dependencies
npm run migrate          # Initialize/reset database (scripts/init-db.js)
npm run dev              # Start server with nodemon (auto-reload)
npm start                # Start server without auto-reload
```

### Database
Always run `npm run migrate` before first start or after schema changes. The migration script drops existing tables and recreates them with a clean state.

## Architecture

### Real-time Synchronization Flow
The app uses an optimistic locking mechanism to prevent edit conflicts:

1. **Lock Acquisition**: When a client edits via `note:edit`, the server grants them a 10-second exclusive lock
2. **Lock Enforcement**: Other clients receive `note:lock` events and enter read-only mode
3. **Lock Release**: Lock expires after 10 seconds or when holder disconnects
4. **State Broadcast**: All changes are broadcast via `note:state` to keep clients synchronized

### Frontend State Management (public/app.js)
The client maintains multiple state variables to handle concurrent editing:
- `lastServerContent`: Latest confirmed server state
- `lastSentContent`: Content sent and awaiting acknowledgment
- `queuedContent`: Edits made while waiting for server confirmation
- `hasPendingAck`: Prevents sending multiple requests simultaneously

Client uses a debounced auto-save pattern (250ms delay) and intelligent conflict resolution:
- If local content advances while acknowledgment is pending, queue the new content
- On receiving `note:state`, compare with pending and queued content to decide whether to apply or skip
- Preserve cursor position when applying remote updates

### Backend (server.js)
- **Database**: Single SQLite instance with inline migrations on startup
- **Lock Management**: In-memory `activeLock` object with timeout-based expiration
- **Events**: `note:edit` triggers lock acquisition, database update, and broadcast
- **API Endpoints**: `/api/note` (GET/PUT) for HTTP-based access alongside Socket.io

### Database Schema
The `notes` table enforces a singleton pattern:
```sql
CREATE TABLE notes (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Constraint ensures only one row
  content TEXT DEFAULT '',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
)
```

## Socket.io Events

### Client → Server
- `note:edit { content }` - Save edit and acquire lock
- `note:fetch` - Request current state (useful after reconnect)

### Server → Client
- `note:state { content, updatedAt }` - Full note state (on connect and after edits)
- `note:lock { holderId, expiresAt, isSelf }` - Lock acquired by a client
- `note:unlock` - Lock released (timeout or disconnect)
- `note:error <message>` - Save operation failed

## Code Style

- ES Modules (`import`/`export`)
- 2-space indentation
- Double quotes for strings
- Lowercase route names (`/api/note`)
- Camelcase for JavaScript variables/functions
- German language for user-facing messages (error messages, UI text)

## Important Constraints

- **Single Note**: The database schema enforces exactly one note (id = 1)
- **Lock Duration**: Hardcoded to 10 seconds (`LOCK_DURATION_MS`)
- **Database Location**: `database.db` in project root (not committed to git)
- **Auto-Save Delay**: 250ms debounce on client (`AUTO_SEND_DELAY`)

## GitHub Actions CI

The workflow (`.github/workflows/nodejs.yml`) runs on push/PR to `main`:
1. Checkout and setup Node.js 18
2. Install dependencies with `npm ci`
3. Run migrations (conditionally with `--if-present`)
4. Run lint if configured (not currently implemented)
5. Run tests if configured (not currently implemented)

## Development Workflow

When modifying the database schema:
1. Update both `server.js` migrations (lines 20-85) and `scripts/init-db.js`
2. Run `npm run migrate` to apply changes locally
3. Test with multiple browser tabs to verify real-time sync

When adding Socket.io events:
1. Define handler in `server.js` within the `io.on("connection")` callback
2. Add client-side listener in `public/app.js`
3. Consider lock state interactions and pending acknowledgment logic

## Testing Recommendations

No automated tests exist. Manual testing checklist:
- Run `npm run migrate` to ensure clean database state
- Start server with `npm run dev`
- Open in multiple browser tabs/devices
- Verify simultaneous typing behavior and lock enforcement
- Test disconnect/reconnect scenarios
- Verify beforeunload save hook
- Test PWA installation and offline behavior
