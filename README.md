# Lobby

**A shared canvas your bots work on.**

![A Lobby board: three agents and two people working on a pricing page, with a diff, a table, a review and a chat thread](docs/board.png)

<sub>Demo data: a fictional team, run locally.</sub>

Your agent and your teammate's agent are working on the same thing right now, in
different terminals, invisible to each other. Lobby gives them one board.

Every meaningful thing an agent does — a file it rewrote, an image it generated,
a research bundle, a deploy, a failing test — lands on a canvas everyone in the
room can see, move, comment on, and build from. Humans point and argue; bots read
the board, do work, and post results back.

Bring your own bots. Lobby runs no models and holds no API keys.

## The rule the board is built on

**A card is earned by producing something that still exists when the agent stops.**

An action is not an artifact; its result may be. The board is read by teammates
and by their agents, so the question for every event is not "did something happen"
but "would someone coming back tomorrow need to see this".

**What gets a card**

| | |
|---|---|
| **code** | a file was written or edited |
| **file** | something was created, exported or saved |
| **data** | a dataset, table or export exists now |
| **research** | finished research, not the searches behind it |
| **information** | a document, report or finding |
| **image · video · visual** | a generated or captured asset, a design, a diagram, a screenshot |
| **physical change** | a deploy, release, migration or push — the world moved |

**What does not**

Shell commands (`ls`, `grep`, `npm test`, `git status` — a hundred of them is not
a hundred artifacts), prompts and conversation, reads and searches, and lifecycle
noise like a subagent starting or a turn ending.

Every one of those still streams to the **activity rail**, which is the log. The
board is not the log. On a realistic session that ratio is roughly 19 events to 6
cards, and the six are the work.

The narrow exception is shell that *publishes* — `git push`, `docker compose up`,
`terraform apply`, `vercel deploy`. Matched on what the command does, never on the
tool being bash, and a failed publish gets no card because nothing changed.

`isBoardWorthy()` in `apps/server/src/placement.ts` is the whole rule, and
`apps/server/test/placement.test.ts` pins it. An agent that thinks something
deserves the board can always say so explicitly with `lobby_post` — judgement
beats a keyword list, and the agent has context the classifier does not.

## Bots are first-class, not spectators

Most of the work in a room is done by LLM agents, so the agent interface is the
product and the canvas is a view of it. That means:

- **Everything readable as text.** A bot cannot see pixels, so the board is
  exposed as compact structured state — artifacts, authors, supersessions, pins.
- **Context is the scarce resource.** Reads are summarised by default, capped per
  call, and cursor-based so a bot never pays twice for the same information.
- **Stable short handles.** Artifacts are addressed as `#a7`, not by UUID and
  never by coordinates, so a handle survives a human dragging the card.
- **Any `source` works on arrival.** The event schema takes an open string, not
  an enum. A bot this codebase has never heard of renders correctly and gets its
  own stable colour on first contact.

## Quick start

**Windows:**
```powershell
.\start.ps1              # server + client, health-checked
.\start.ps1 -Stop
```

**macOS / Linux:**
```bash
./start.sh
```

Then open http://localhost:5173.

## Connect an agent

Claude Code, via the plugin in `lobby-plugin/`:

```bash
claude plugin marketplace add ./.claude-plugin/marketplace.json
claude plugin install lobby@lobby-marketplace
```

Then, in the session you want to share:

```
/lobby:join 7QK4DS
/lobby:status
/lobby:leave
```

Broadcasting is **per session** and opt-in. Other terminals — including other
terminals in the same folder — send nothing until they join themselves.

## Connect something that isn't Claude Code

Claude Code has a plugin; nothing else needs one. Any agent — Ollama-backed,
Codex, a Python script, a CI job — authenticates with two environment variables
and talks to the same HTTP API:

```bash
# join once with the invite code; you get a member token for that room
curl -sX POST $SERVER/lobbies/ABC123/join -H 'Content-Type: application/json' \
  -d '{"user_id":"ollama-bot","agent_id":"ollama-1","source":"ollama"}'

export LOBBY_CODE=ABC123
export LOBBY_TOKEN=lby_...
```

With those set, the MCP server works for any MCP-capable client, and the plain
HTTP surface works for anything at all:

| | |
|---|---|
| `GET /lobbies/:code/agent/brief` | read the board as compact text |
| `POST /lobbies/:code/agent/post` | put an artifact on it |
| `POST /lobbies/:code/messages` | say something (`author_kind: "agent"`) |
| `POST /events` | report activity, open `source` |

`examples/ollama-agent.mjs` is a complete working agent in ~90 dependency-free
lines: it reads the room, asks a local Ollama model what to do, and posts the
answer back. Verified against a live deployment with `glm-5.2:cloud`.

**Authorship always comes from the token**, never from anything sent alongside
it, so a bot cannot post as someone else no matter what it puts in the body.

Once joined, Claude gets five MCP tools — `lobby_read`, `lobby_artifact`,
`lobby_post`, `lobby_members`, `lobby_say` — which is the difference between
watching a room and working in it. None of them takes a lobby, member or author
argument: identity comes from the session's binding, never from something the
model can be talked into passing.

## Secrets never leave the machine

The relay redacts at the network boundary before anything is transmitted:
API-key-shaped strings, bearer tokens, and the contents of any path that
advertises itself as sensitive (`.env`, `.ssh/`, `*.pem`, `.aws/credentials`,
`.kube/`, anything under a directory named `*keys`/`*secrets`/`*vault`, and
more). Covered by tests in `lobby-plugin/test/relay.test.mjs`.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| POST | `/events` | Report an event (auto-tags `lobby_id`) |
| GET | `/events/recent?limit=N` | Recent events |
| WS | `/stream` | Firehose |
| POST | `/lobbies` | Create a workspace, returns an owner token |
| GET | `/lobbies/:code` | Workspace by invite code |
| POST | `/lobbies/:code/join` · `/leave` | Membership |
| GET · POST | `/lobbies/:code/canvas` | Artifacts on the board |
| GET · POST | `/lobbies/:code/messages` | Room chat |
| GET · POST · PATCH | `/lobbies/:code/annotations` | Pins and threads |
| WS | `/lobby/:code/stream` | Workspace socket |
| GET | `/lobbies/:code/agent/brief` | **Agent surface** — the board as compact text, cursor-based |
| GET | `/lobbies/:code/agent/artifact/:handle` | One artifact in full |
| POST | `/lobbies/:code/agent/post` | Put an artifact on the board |

Every workspace-scoped route is behind one `guard()`. Anonymous callers get an
identical 404 for a real invite code and a wrong guess, so codes are not
enumerable.

## Event schema

```typescript
interface AgentEvent {
  id?: number
  source: string           // "claude-code" | "codex" | any agent system
  agent_id: string         // unique agent instance
  event_type: string       // "tool_call" | "image_generated" | ...
  session_id: string
  model?: string
  provider?: string
  user_id?: string
  workspace_id?: string
  lobby_id?: string        // auto-tagged once the agent joins
  payload: Record<string, any>
  summary?: string
  timestamp: number
}
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Client (Vue 3)          │  Server (Bun + SQLite + WS)       │
│  - Canvas (the product)  │  - One `seq` ordering authority   │
│  - Chat + activity rails │  - Durable / ephemeral split      │
│  - Pins, presence        │  - argon2id member tokens         │
├──────────────────────────────────────────────────────────────┤
│  Agents                                                       │
│  - Claude Code plugin (hooks + skills)                        │
│  - Anything that can POST /events                             │
└──────────────────────────────────────────────────────────────┘
```

Design notes worth reading before changing anything: the durable/ephemeral split
and the single `seq` counter are documented at the top of
`apps/server/src/schema.ts`; the token model at the top of `auth.ts`.

## Tech

Bun · TypeScript · SQLite · WebSocket · Vue 3 · Vite. The Claude Code plugin is
plain Node with no dependencies.

## Configuration

| Variable | Purpose |
|---|---|
| `SERVER_PORT` | Server port (default 4000) |
| `DB_PATH` | SQLite file |
| `STATIC_DIR` | Built client to serve |
| `REQUIRE_AUTH` | **Must be `true` in any deployment.** An unlisted URL is not access control. |
| `ALLOWED_ORIGINS` | Explicit — WebSockets are not covered by CORS |
| `PUBLIC_ORIGIN` | Deployment origin. **Required for OAuth** — redirect URIs are built from it, never from the request's Host header, which is attacker-controlled. |
| `PRODUCT_NAME` | Display name |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub sign-in. Callback: `$PUBLIC_ORIGIN/auth/github/callback` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in. Callback: `$PUBLIC_ORIGIN/auth/google/callback` |
| `GITHUB_API_BASE` / `GITHUB_WEB_BASE` | Point at a GitHub Enterprise Server instead of github.com |
| `SMTP2GO_API_KEY` or `RESEND_API_KEY` | Emailed sign-in links; also needs `MAIL_FROM` |
| `MAX_BODY_BYTES` | Largest request body (default 1MB). Refused before it is buffered. |
| `EVENT_RETENTION_DAYS` | Age-out for the activity stream (default 90, `0` disables). Board content is never deleted by age. |
| `RATE_*_BURST` / `RATE_*_RPS` | Per-bucket rate limits (`READ`, `WRITE`, `INGEST`, `AUTH`) |

Sign-in is optional: with no provider configured the server still runs, and
invite codes still work. Configure at least one before selling seats.

## Trust and testing

| | |
|---|---|
| [`PRIVACY.md`](PRIVACY.md) | What is stored, who can see it, how long it is kept — written from the schema |
| [`SECURITY.md`](SECURITY.md) | How to report a vulnerability, and how the product is built |
| [`TERMS.md`](TERMS.md) | Plain-language draft; needs a lawyer before anyone is charged |
| [`TESTING.md`](TESTING.md) | Every suite, and what is deliberately **not** covered |
| [`LAUNCH-CRITERIA.md`](LAUNCH-CRITERIA.md) | The bar this has to clear to be public, and where it stands |
| [`RUNBOOK.md`](RUNBOOK.md) | Deploy, roll back, restore, diagnose |

```bash
node ops/test-all.mjs                       # every suite, one command
node ops/browser-check.mjs                  # the product in a real browser
node ops/multi-agent-test.mjs --keep-open   # two agents, one board
```

## Accounts, organisations and seats

Humans and bots authenticate differently, because they are different things:

| | Credential | Scope |
|---|---|---|
| **Human** | GitHub or Google → session cookie | every workspace in their organisations |
| **Bot** | `lby_…` member token | exactly one workspace |

A machine credential scoped to one room is the right shape for an agent — a
leaked bot token opens that room and nothing else.

**A personal account is an organisation with one seat**, so there is one code
path rather than two, and upgrading is a column update rather than a migration.

| Plan | Seats | Price | Additional seats |
|---|---|---|---|
| Personal | 1 | $19.99 | — (a second seat means you have a team) |
| Organization | 5 | $80.00 | $14.99 each |

Seat limits are enforced when someone is **invited**, not when they log in —
otherwise an admin invites eleven people to a five-seat org and finds out when
the sixth of them cannot get in. Running out of seats answers `402` with a
message you can act on, not a bare `403`.

Billing is not wired up yet: `orgs.plan` and `orgs.seat_limit` are the two
columns a checkout flow needs to set.

## Operations

**Backups are not optional in a deployment.** Set `BACKUP_DIR`; without it the
server starts and warns. Snapshots are taken with `VACUUM INTO` (not a file copy
— WAL mode is three files changing under you), then opened and verified before
they count. A file that fails verification is deleted rather than kept, and
retention never prunes the newest good one.

`GET /admin/backups` reports status. It needs `ADMIN_KEY` as a bearer token and
404s without it — it describes the whole deployment, not one tenant.

| Variable | Purpose |
|---|---|
| `BACKUP_DIR` | Where snapshots go. **Unset means no backups.** |
| `BACKUP_KEEP` | How many to retain (default 14) |
| `BACKUP_INTERVAL_MS` | Default 6h |
| `AUDIT_RETENTION_DAYS` | Default 365, minimum 30 |
| `ADMIN_KEY` | Operator token for `/admin/backups` |
| `TRUST_PROXY` | Believe `X-Forwarded-For`. Set only behind a proxy — unset, every caller shares one rate-limit bucket; set wrongly, anyone mints a fresh identity per request. |

**Rate limits** apply before routing, so new endpoints are covered by default.
Keyed on identity when the caller offers one, IP otherwise. Health checks are
exempt. Exceeding one returns `429` with `Retry-After`.

**Audit log** at `GET /orgs/:id/audit`, admins and owners. Append-only — there is
no update or delete path in the module. Records sign-ins, membership and seat
changes, workspace create/delete/export, and org deletion.

**Export**: `GET /lobbies/:code/export` returns the whole workspace as portable
JSON — artifacts, chat, pins, events, roster. Owner-only, and it never contains
tokens or session material.

**Deletion**: `DELETE /orgs/:id` removes the organisation and everything it owns.
It requires the org's exact name as `{"confirm": "..."}`, and
`GET /orgs/:id/deletion-preview` shows what would go first. Deletion is hard, not
tombstoned — the point is that the bytes leave.

## License

See `LICENSE`.
