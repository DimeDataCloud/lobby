# Runbook

What to do when something is wrong. Written to be followed at 3am by someone who
did not build this.

---

## Restore from backup

**Symptom:** the database is corrupt, was deleted, or lost data you need back.

Backups live in `/data/backups` inside the `lobby_data` volume, named
`lobby-<ISO timestamp>.db`. They are taken every 6 hours, verified on write, and
14 are kept.

### 1. Stop writing to the broken database

```bash
docker compose -f /opt/lobby/docker-compose.yml stop lobby
```

Do this first. Restoring underneath a running server gives you a half-old,
half-new database and no way to tell which rows are which.

### 2. Pick a backup

```bash
docker run --rm -v lobby_data:/data alpine ls -la /data/backups
```

Newest is usually right. If you are recovering from corruption rather than
deletion, and you do not know when it started, prefer an older one — a backup
taken after the corruption will contain it.

### 3. Verify it BEFORE you rely on it

```bash
docker run --rm -v lobby_data:/data oven/bun:1 \
  bun -e 'const{Database}=require("bun:sqlite");
          const d=new Database("/data/backups/<FILE>",{readonly:true});
          console.log(d.prepare("PRAGMA integrity_check").get());
          console.log(d.prepare("SELECT COUNT(*) n FROM lobbies").get());'
```

Expect `integrity_check: "ok"` and a plausible workspace count. Every backup was
verified when written, but a disk can rot a file afterwards and this costs
seconds.

### 4. Keep the broken one

```bash
docker run --rm -v lobby_data:/data alpine \
  sh -c 'cp /data/events.db /data/events.db.broken-$(date +%s) 2>/dev/null; true'
```

Never overwrite the damaged database. It is the only evidence of what went
wrong, and sometimes it holds rows the backup does not.

### 5. Restore

```bash
docker run --rm -v lobby_data:/data alpine sh -c '
  rm -f /data/events.db-wal /data/events.db-shm
  cp /data/backups/<FILE> /data/events.db'
```

Delete the WAL and SHM files. They belong to the *old* database, and leaving
them beside a restored one is how a clean restore turns into fresh corruption.

### 6. Start, and check

```bash
docker compose -f /opt/lobby/docker-compose.yml up -d lobby
docker logs lobby --tail 20
curl -s https://lobby.dimedata.cloud/healthz
```

Then open a workspace you know had content and confirm it is there.

### What you lose

Up to one backup interval — 6 hours by default. Everything written between the
last backup and the failure is gone. If that is unacceptable for a customer,
lower `BACKUP_INTERVAL_MS`; the snapshot takes ~10ms on a small database, so a
tighter interval is cheap.

---

## Known weakness: backups share a volume with the database

`BACKUP_DIR=/data/backups` is inside the same Docker volume as `events.db`.

This protects against: corruption, accidental deletion, a bad migration, a
customer deleting something they wanted.

It does **not** protect against: volume loss, disk failure, or the host going
away. Those take the backups with them.

Fixing it means copying backups off the box — object storage, another host,
anything not this disk. Until that exists, do not tell a customer their data is
protected against hardware failure, because it is not.

---

## Turning sign-in on

Sign-in is **off** until OAuth apps exist. The server runs fine without it —
`/auth/providers` returns an empty list and the UI hides the buttons — but nobody
can create an account, so no seats can be sold. This is the last step between the
deployment and a customer.

**GitHub alone is enough.** Providers are independent: configure one and it is
offered, and the others are simply absent from `/auth/providers`. The customers
here are developers, so GitHub is the one that matters; Google can wait until
somebody asks for it.

Both providers need the callback URL to match **exactly**, including scheme and
trailing path. A mismatch fails at the provider with an error the app never sees,
and it is the single most common reason a first OAuth setup does not work.

Everything downstream of the provider is covered by
`apps/server/test/integration/oauth.ts` — 47 checks against a stub that speaks
GitHub's own protocol, including CSRF state, the code exchange, the
unverified-email rule and open-redirect refusal. So if sign-in fails after
registering the app, suspect the callback URL or the client secret before the code.

### GitHub

1. github.com → Settings → Developer settings → **OAuth Apps** → New OAuth App
2. Homepage URL: `https://lobby.dimedata.cloud`
3. Authorization callback URL: `https://lobby.dimedata.cloud/auth/github/callback`
4. Generate a client secret. It is shown **once**.

### Google

1. console.cloud.google.com → APIs & Services → **Credentials**
2. Create credentials → OAuth client ID → Web application
3. Authorised redirect URI: `https://lobby.dimedata.cloud/auth/google/callback`
4. Configure the consent screen. External + "In production" is required before
   anyone outside your own account can sign in — in "Testing" it silently only
   works for accounts you list.

### Then

```bash
# on the host, in /opt/lobby/.env  — GitHub alone is a complete configuration
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
# optional, only if you also registered a Google client
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

docker compose -f /opt/lobby/docker-compose.yml up -d
curl -s https://lobby.dimedata.cloud/auth/providers
# expect {"providers":["github"]}  — or ["github","google"] if you set both
```

Then sign in yourself once, end to end, before telling anyone else it works. That
single real sign-in is the one thing no test here can substitute for: the callback
path is fully covered against a stub, but whether github.com behaves like the stub
is only knowable by doing it.

**Redirect URIs are built from `PUBLIC_ORIGIN`, never from the request's Host
header** — that is deliberate, because a Host header is attacker-controlled and
using it to build a redirect turns a login flow into a token thief. So if
`PUBLIC_ORIGIN` is wrong, sign-in breaks in a way that looks like the provider's
fault.

---

## Turning on the backup status endpoint

`/admin/backups` 404s unless `ADMIN_KEY` is set. That is the safe default — the
route describes the whole deployment, not one tenant.

```bash
openssl rand -base64 32          # generate one
# put it in /opt/lobby/.env as ADMIN_KEY=..., then:
docker compose -f /opt/lobby/docker-compose.yml up -d
```

Store it wherever the other operational credentials live — **not** in the repo,
and not in a Google-synced folder.

---

## A credential leaked

### A bot's member token (`lby_…`)

Scoped to exactly one workspace, which is the point — a leaked bot token opens
that room and nothing else.

```bash
# find the member id
curl -s -H "Authorization: Bearer <owner token>" \
  https://lobby.dimedata.cloud/lobbies/<CODE>/members

# revoke
curl -s -X DELETE -H "Authorization: Bearer <owner token>" \
  https://lobby.dimedata.cloud/lobbies/<CODE>/members/<MEMBER_ID>
```

Revocation is immediate for new requests. Verified tokens are cached in memory
for up to 30 seconds and the cache is invalidated on revoke, so there is no
lingering window.

The member re-joins with `/lobby:join CODE` to get a fresh token.

### A person's session

Sessions are hashed at rest and expire after 30 days. To end one immediately,
delete the row:

```bash
docker exec lobby bun -e '
  const {Database}=require("bun:sqlite");
  const d=new Database("/data/events.db");
  console.log(d.prepare("DELETE FROM sessions WHERE user_id = ?").run("<USER_ID>"));'
```

### `ADMIN_KEY`

Rotate it in `.env` and restart. It grants read-only backup status and nothing
else, but it does describe the deployment.

### If the database itself leaked

Member tokens are argon2id hashes and session tokens are SHA-256 of 256-bit
random values, so neither is recoverable from a dump. What *is* in there in the
clear: every artifact body, every chat message, every file path. Treat it as a
content breach, not a credential breach, and notify accordingly.

---

## The disk is filling up

Three things grow: the database, backups, and the events table inside the
database.

```bash
docker exec lobby sh -c 'ls -la /data/events.db; du -sh /data/backups'
docker system df
```

- **Backups** — lower `BACKUP_KEEP` (default 14). Each is roughly the size of the
  database.
- **Events** — the firehose of everything agents report. This is the fastest
  growing table in an active deployment. There is currently **no retention
  policy on it**; if it becomes a problem, that is the first thing to add.
- **Audit log** — bounded by `AUDIT_RETENTION_DAYS` (default 365).

Do not delete backups to make room without checking `/admin/backups` first.

---

## The service is down

```bash
docker ps --filter name=lobby
docker logs lobby --tail 50
curl -s -o /dev/null -w '%{http_code}\n' https://lobby.dimedata.cloud/healthz
```

- **Container not running** → `docker compose -f /opt/lobby/docker-compose.yml up -d`
- **Container unhealthy, restarting** → read the logs. The usual cause is a
  missing required env var; `PUBLIC_ORIGIN` is mandatory and compose refuses to
  start without it.
- **Container healthy but the domain fails** → the problem is the reverse proxy,
  not this service. Check that the proxy is attached to `lobby_net`:
  `docker network inspect lobby_net`.

Reload the proxy rather than restarting it — a restart drops every live site on
the box and can lose certificates.

---

## Someone is hammering the service

Rate limits are on by default and answer `429` with `Retry-After`. If one caller
is still causing problems:

- Limits are per identity when the caller presents a token or session, per IP
  otherwise. A single abusive *token* is best handled by revoking the member.
- `TRUST_PROXY` must be set for per-IP limiting to work behind the proxy.
  Without it every caller shares one bucket, which looks like the limiter
  misfiring on innocent users.
- Buckets are in memory. Restarting the container clears them.

---

## "Who deleted this?"

```bash
curl -s -H "Cookie: lobby_session=<owner session>" \
  "https://lobby.dimedata.cloud/orgs/<ORG_ID>/audit?action=workspace.delete"
```

The audit log records sign-ins, membership and seat changes, workspace
create/delete/export, and org deletion — with actor, target and timestamp.
Retention defaults to 365 days.

Note that **deleting an organisation deletes its audit log too**. If you need the
trail after a customer leaves, it exists only in backups taken before the
deletion.

---

## Checking on backups

```bash
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  https://lobby.dimedata.cloud/admin/backups | jq
```

Returns the schedule, the last good run, recent history and what is on disk.
Requires `ADMIN_KEY` to be set in `/opt/lobby/.env`; without it the route 404s.

**If `last_good` is old or null, treat it as an incident.** A failing backup is
silent by design — nothing else about the service changes.

---

## Deploying

```bash
# from a clean checkout
git archive HEAD | ssh -i <key> root@<host> "cd /opt/lobby && tar -x"
ssh -i <key> root@<host> "cd /opt/lobby && docker compose up -d --build"
```

The client is built inside the image, so no separate frontend upload is needed.

Verify afterwards:

```bash
node ops/verify-deploy.mjs
```

It exercises security headers, the auth surface, rate limits, the agent surface,
untrusted-content fencing, idempotency, export, the WebSocket over TLS, and
deletion — against the live host, creating and removing one throwaway workspace.

### Rolling back

```bash
git checkout <previous good commit>
# then the same two commands
```

The database is not touched by a deploy, so a rollback is safe unless the deploy
included a schema migration. Migrations here are additive and guarded, so an
older build tolerates newer columns.
