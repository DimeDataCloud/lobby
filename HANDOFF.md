# Lobby — Handoff

## Quick Start

```powershell
.\start.ps1              # starts both, health-checks, reuses anything already up
.\start.ps1 -Stop        # stop them again
```

Then open http://localhost:5173

`start.ps1` is the supported entry point on Windows; `./start.sh` covers
macOS/Linux. Both processes must be running — the Vite dev server proxies API
calls to the Bun server on port 4000.

## What This Is

A shared canvas that agents work on. Any agent system — Claude Code, Codex,
OpenCode, or anything that can make an HTTP request — reports what it does, and
the meaningful results land as rich interactive cards on an infinite canvas that
the whole team sees live. Humans comment, pin and rearrange; bots read the board
and post work back to it.

Lobby runs no models and holds no API keys. Teams bring their own bots.

**The rule the board is built on:** outputs and changes, never prompts or
conversation. `isBoardWorthy()` in `apps/server/src/placement.ts` decides what
earns a card. Talk lives in the chat rail.

**Bots are the primary operators**, so the agent-facing surface is the product
and the canvas is a view of it — compact structured reads, per-call token caps,
cursor-based deltas off the shared `seq`, and stable short handles for artifacts.

## Architecture

```
Browser (Vue 3 + Vite :5173)
    │
    ├─ Proxy ──► Bun Server (:4000)
    │               ├─ SQLite (events.db)
    │               ├─ REST API (events, lobbies, presence, annotations, canvas)
    │               └─ WebSocket (real-time broadcast)
    │
    └─ Claude Code Plugin (Python hooks)
                    └─ Opt-in broadcasting to server
```

## Key Files

| File | Purpose |
|------|---------|
| `apps/server/src/index.ts` | Bun server — all REST endpoints + WebSocket |
| `apps/server/src/db.ts` | SQLite schema, queries, migrations |
| `apps/server/src/types.ts` | TypeScript interfaces |
| `apps/client/src/App.vue` | Main dashboard layout, filters, keyboard shortcuts, multiplayer state |
| `apps/client/src/components/EventCard.vue` | Rich event rendering (10+ content types) |
| `apps/client/src/components/AgentCanvas.vue` | Infinite canvas with draggable nodes, minimap |
| `apps/client/src/components/PresencePanel.vue` | Online users sidebar |
| `apps/client/src/components/ActivityFeed.vue` | Live event stream with animations |
| `apps/client/src/components/AnnotationPanel.vue` | Comments on events |
| `apps/client/vite.config.ts` | Vite proxy config — ALL API routes must be listed here |
| `plugin/hooks/send_event.py` | Claude Code hook — opt-in event broadcaster |
| `plugin/commands/lobby_*.py` | `/lobby:create`, `/lobby:join`, `/lobby:leave` |

## API Endpoints

```
GET  /health
POST /events                    — Insert event (auto-tags lobby_id if agent joined lobby)
GET  /events/recent?limit=N
GET  /events/filter-options
WS   /stream                    — General WebSocket (all events + agent updates)

POST /lobbies                   — Create lobby
GET  /lobbies                   — List public/unlisted
GET  /lobbies/:code             — Get lobby by code
POST /lobbies/:code/join        — Join lobby
POST /lobbies/:code/leave       — Leave lobby
DELETE /lobbies/:code           — Delete lobby
GET  /lobbies/:code/events      — Lobby-scoped events
WS   /lobby/:code/stream        — Lobby-scoped WebSocket

POST /presence                  — Register/update user presence
GET  /presence                  — List online users
GET  /presence/lobby/:code      — Users in a lobby
POST /presence/heartbeat        — Keep presence alive

POST /annotations               — Add comment on event
GET  /annotations/:eventId      — Get comments for event
GET  /annotations/lobby/:code   — Recent lobby comments

POST /canvas/position           — Save node position (drag sync, legacy)
GET  /canvas/positions          — Get all saved positions (legacy)

GET  /lobbies/:code/canvas              — Board snapshot (bbox culling)
GET  /lobbies/:code/canvas/since?seq=   — Delta, tombstones included
POST /lobbies/:code/canvas              — Create/update an object (LWW)
DELETE /lobbies/:code/canvas/:id        — Tombstone

GET  /lobbies/:code/messages            — Chat backlog, oldest-first
GET  /lobbies/:code/messages/since?seq= — Chat delta
POST /lobbies/:code/messages            — Post a message (viewer+)
DELETE /lobbies/:code/messages/:id      — Withdraw (author or owner)

GET  /lobbies/:code/annotations         — Board pins (filter by target)
GET  /lobbies/:code/annotations/since?seq=
POST /lobbies/:code/annotations         — Pin on an event, object or point (editor+)
PATCH  /lobbies/:code/annotations/:id   — Resolve / reopen
DELETE /lobbies/:code/annotations/:id   — Withdraw (author or owner)
```

Every `/lobbies/:code/*` route goes through one membership guard. Under
`REQUIRE_AUTH=true` an anonymous caller gets the same `404` for a real invite
code as for an invented one — the code is the secret for an unlisted room, so a
`401`-vs-`404` difference would make codes enumerable. The legacy `/annotations`
routes are gated by the same guard; they were open to anyone until 2026-07-28.

WebSocket frames (client → server): `{t:'e'}` ephemeral cursor/viewport,
`{t:'obj'}` canvas write, `{t:'chat'}` message, `{t:'ann'}` pin, `{t:'ping'}`.
Server → client adds `chat_backlog`, `chat_message`, `annotation_snapshot` and
`annotation` to the existing `initial` / `canvas_snapshot` / `canvas_object` /
`presence_roster` / `ephemeral` set.

## Event Schema

```typescript
interface AgentEvent {
  id?: number
  source: string           // open string — "claude-code" | "codex" | any agent system
  agent_id: string
  event_type: string       // "tool_call" | "image_generated" | "research_complete" | etc.
  session_id: string
  model?: string
  provider?: string
  user_id?: string
  workspace_id?: string
  lobby_id?: string        // Auto-tagged if agent joined lobby
  payload: Record<string, any>
  summary?: string
  timestamp: number
}
```

## EventCard Content Types

The EventCard component renders different content based on event type + payload:

- `tool_call` + `payload.tool_name === 'terminal'` → command + exit code
- `tool_call` + `['write_file','patch','read_file']` → file path + preview
- `image_generated` or `payload.image_url` → image + prompt + download link
- `research_complete` or `payload.files` → file list with links
- `website_deployed` or `payload.url` → URL + screenshot
- `code_fixed` or `payload.diff` → diff block
- `subagent_start` / `delegation_start` → goal + task count
- `subagent_stop` → exit reason + summary + transcript link
- `user_prompt` → prompt text
- `error` → error block

## Lobby Flow

1. User creates lobby → gets 6-char invite code
2. Share code with collaborators
3. Collaborators join via `/lobby:join CODE` or URL hash `#lobby=CODE`
4. Agent events auto-tagged with `lobby_id` when agent has joined
5. Lobby-scoped WebSocket broadcasts events only to lobby members
6. Presence shows who's in the lobby
7. Canvas node positions sync across all clients

## Plugin (Claude Code)

Install: `claude plugin marketplace add ./.claude-plugin/marketplace.json` →
`claude plugin install lobby@lobby-marketplace`

Commands:
- `/lobby:create "Name" --private` — Create + auto-join
- `/lobby:join CODE` — Join existing lobby
- `/lobby:leave` — Stop broadcasting

State file: `~/.lobby/session.json` — hook script is silent no-op without this file.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Ctrl+1 | Timeline view |
| Ctrl+2 | Canvas view |
| Ctrl+3 | Agent registry |
| Ctrl+F | Toggle filters |
| Ctrl+K | Join lobby |
| Ctrl+N | New lobby |
| Esc | Close modal/sidebar/thread · stop following a peer |
| ? | Show shortcuts |

Board tools (when the canvas has focus): `V` select · `H` pan · `P` pen ·
`N` note · `F` frame · `C` comment. Delete/Backspace removes the selection.
Click a live collaborator's avatar to mirror their viewport.

## Design System

- Background: `#0a0a0c` (ink), `#0d0d10`, `#111114`
- Accent: `#f97316` (blood orange)
- Borders: `#1e1e24`, `#2a2a30`
- Font: JetBrains Mono, SF Mono, Inter
- Effects: subtle glows, smooth transitions, backdrop blur on modals

## Common Pitfalls

1. **Vite proxy** — Every new API route must be added to `vite.config.ts` proxy list or the dashboard can't reach it.
2. **MSYS paths** — Use Windows paths (`C:/Users/...`) not `/c/Users/...` for Python scripts.
3. **Port conflicts** — Kill all node/bun processes before restarting: `taskkill /F /IM node.exe && taskkill /F /IM bun.exe`
4. **Lobby auto-tagging** — Only works if agent has joined via `joinLobby()` (DB membership check).
5. **WebSocket lobby scoping** — Clients connect to `/lobby/:code/stream`, not `/stream`.
6. **App.vue is large** (~1600 lines) — Be careful with patches, prefer targeted replacements.

## Current State (2026-07-28)

Verified in the running app, not inherited from an earlier doc.

- **Server** — Bun + SQLite. One shared `seq` counter across events, canvas
  objects, chat and annotations. Member tokens (argon2id, `lby_` prefix),
  owner/editor/viewer roles, every lobby-scoped read and write behind one guard.
- **Board** — artifact objects with LWW convergence and tombstones, 3-tier LOD,
  viewport culling, live cursors on an ephemeral channel that never touches the
  database, pen/note/frame, marquee select, minimap, follow-a-peer viewport.
- **Chat** — room conversation in the rail, replies, withdraw, object references,
  unread badge. Backlog delivered on socket open.
- **Annotations** — pins on an event, a canvas object, or a bare board point,
  anchored in board coordinates. Threads, resolve/reopen, author-or-owner delete.
- **Plugin** — installs and loads in Claude Code (3 skills, 6 hooks); real hook
  events verified reaching the board.
- **Deployed** — at `PUBLIC_ORIGIN`, own Docker network, no published
  ports, TLS via Caddy, `REQUIRE_AUTH=true`.

Tests: `bun test apps/server/test` (22 unit) plus three integration suites that
drive a real server —
`auth.ts` (authorization + IDOR + enumeration), `chat.ts` (chat, pins, sockets),
`multiplayer.ts` (two live WebSocket clients; needs `.\start.ps1` running).

## Next Steps / Ideas

- Full-text search across events and chat
- Export/import of a board
- Retention/cleanup policy for events and ephemeral rows
- Agent-authored chat (`author_kind: 'agent'`) wired into the producers
- Notification sounds / desktop notifications on mention
