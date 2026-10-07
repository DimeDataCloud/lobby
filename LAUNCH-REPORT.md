# Launch readiness — what was found, and what it cost

2026-07-30. Measured against `LAUNCH-CRITERIA.md`, which was written first so the
bar could not be quietly lowered to match what the product happened to do.

Eleven defects. Six were in the product, five were in the tests, tools and
documentation — which matters, because the five are why the six could hide.

## The one that says the most

**A mistyped invite code rendered a convincing fake workspace.**

`BoardView` took the room code straight from the URL hash and connected without
ever asking the server whether that room existed. The result was a complete,
believable board: the room header showing the code, the "Connect your first bot"
onboarding, the instruction to run `/lobby:join ZZZZZZ`, and — the detail that
makes it bad — *"Waiting for the first artifact…"*.

Someone who mistyped one character of an invite link would have followed those
instructions and waited forever for a board that was never created. No error, no
clue, and the product would have looked broken rather than mistyped.

Every server-side test passed throughout. The endpoints were all correct. Nothing
was wrong except what a person saw, and for most of this project's life nobody had
looked.

The fix redeems the code at `POST /lobbies/:code/join` rather than checking with a
`GET`, and that distinction is worth keeping: for an anonymous caller the server
answers a `GET` for a *real* private room with 404, exactly as it answers a wrong
guess, so that invite codes cannot be brute-forced by probing. A `GET` therefore
cannot tell "missing" from "no credential yet", and using it would have rejected
every genuine guest arriving from an invite link. `/join` answers 404 only when the
room really is absent — and hands back the token the browser needs anyway, so
validating and joining are one request with no window between them.

## Everything else, with the reasoning

### 1. The sign-in screen told strangers to set `GITHUB_CLIENT_ID`

With no provider configured, the product's welcome screen printed its own
environment-variable names. An internal config error, shown as the first thing a
customer sees. Now it says accounts are not open yet and points at the invite-code
path; the diagnosis belongs in the server log.

### 2. A 60MB request body was accepted in 0.9 seconds

No HTTP body size limit existed. The WebSocket has had a payload cap since the
start; HTTP had nothing. `await req.json()` buffers the entire body before any
handler sees it, so on a 512MB container a handful of concurrent large POSTs
exhausts the process — and this is multi-tenant, so that is every customer's board
going down together.

Now refused with 413 in 8ms, before buffering, at a 1MB default. Verified that a
legitimate 24KB artifact — the largest the product accepts — still posts.

### 3. `pruneAudit` had never been called

It was imported by `index.ts` and invoked nowhere. Meanwhile `AUDIT_RETENTION_DAYS`
was set in `docker-compose.yml` and reported by `/admin/backups`. The product
advertised a retention policy it did not have, in the one area — audit data —
where a customer is most likely to ask.

### 4. The `events` table had no retention at all

The fastest-growing table in an active deployment, never pruned, on a box with one
volume shared with the backups.

The trap here is worth recording because the obvious fix is wrong:
`canvas_objects.event_id` resolves an artifact's *content*, so
`DELETE FROM events WHERE timestamp < cutoff` blanks out old board artifacts —
reproducing the grey-box bug this project already shipped once, arriving by a
different road. Retention now never deletes an event a live artifact or an open
annotation still points at, however old, and reports how many it kept so that
"retention is 90 days but the table is not shrinking" is not a mystery.

Board content is never deleted by age. A tool that quietly eats a team's work after
ninety days is not one anyone can rely on.

### 5. OAuth errors leaked internal endpoint URLs

A failed profile fetch told the user `http://…/user returned 401`. Reconnaissance
to a stranger, and on a GitHub Enterprise deployment it would disclose the internal
hostname. Now: "GitHub could not be reached just now. Try signing in again," with
the URL in the server log where it belongs.

### 6. A floating button covered the chat composer's send button

Measured 92×29px of overlap. The legacy-dashboard toggle was pinned bottom-right at
`z-index: 200`, directly on top of the control you need to send a message.

## The five in the scaffolding

These are the reason the six above survived.

### 7. The artifact-render test could not run as documented

It wrote its build entry to `process.cwd()` with a relative import, so it only
worked if you happened to `cd apps/client` first. The documented invocation — from
the repo root, in `SESSION-STATE.md` — failed every time.

That test exists specifically to guard the worst bug this product ever shipped
(bot-posted artifacts drawing as a grey box reading "artifact"). The guard was
unrunnable, and "all green as of the last commit" was one test short of true.

### 8. `just test` in the PR instructions could not run

`CONTRIBUTING.md` told contributors to verify their work with `just test`. The
justfile had been deleted. A contributor's first instruction was a dead end.

### 9. The test list had drifted across four documents

`TESTING.md`, `SECURITY.md`, `CONTRIBUTING.md` and `SESSION-STATE.md` each carried
their own copy. Newly added suites were missing from three of them. There is now
one runner, `ops/test-all.mjs`, and the documents point at it.

### 10. The browser check passed a broken screen

Written during this pass, and its first version had the bug it was built to catch.
Navigating from `/#a` to `/#b` is a same-document change, so the app never
re-initialised and the second view silently reported the *first* view's DOM — which
is how it reported a healthy board while looking at the sign-in screen. It now
loads `about:blank` between views and asserts the URL it landed on.

Recorded because a checking tool that can pass a broken thing is worse than no
tool: it converts an unknown into a false assurance.

It had a second gap of the same shape: it only ever looked at an **empty** board.
The bug this project actually shipped — server accepts a post, API returns it,
canvas draws a grey box — can only happen on a board with work on it, which was the
one state never checked. It now creates a second workspace, posts three artifacts of
different kinds, and asserts each *title* is on screen. Not a count, not a
container: the actual text, because a placeholder card still exists in the DOM and
still counts.

### 11. The multi-agent harness printed a board URL that showed plain text

Found by using it the way its owner would, rather than by testing its output.

It reused any server answering `/health` on port 4000. A server started without
`STATIC_DIR` answers `/health` perfectly and returns the plain string
`Lobby server` at `/` — so the harness handed over a board URL that renders a blank
page. The natural conclusion is that the product is broken, not that the server was
started differently.

It now verifies the server can actually serve the app, says so plainly when it
cannot, and steps aside onto another port rather than killing someone else's
process.

## One suspected bug that was not one

Recorded because the discipline only means something if the misses are logged too.

A manual screenshot of a live board showed *"Waiting for the first artifact…"* and
`0 / 0 shown` while `ops/lobby-debug.mjs` confirmed an artifact on the server. That
is exactly the signature of the grey-box bug, and it was chased as one.

It was not. `--virtual-time-budget` fast-forwards timers, which breaks the async
sequencing the board depends on, so the screenshot caught it mid-load. The proper
check — real settle time, real network — renders all three artifacts. The
measurement was wrong, not the product.

The useful outcome is the permanent guard, which now exists either way.

## What was built

| | |
|---|---|
| `ops/browser-check.mjs` | Headless Chrome over CDP, no dependencies. Console errors, failed requests, internals leaking into visible text, horizontal overflow, unlabelled controls, overlapping controls, and every artifact title actually on screen — 138 checks across 10 views at desktop and phone. Writes PNGs, because "no errors" is not "looks right". |
| `ops/test-all.mjs` | Every suite that needs no browser and no second person. 12/12 in ~53s. |
| `ops/multi-agent-test.mjs` | One command from nothing to two agents on one board, with copy-pasteable commands in the right shell syntax. |
| `ops/lobby-debug.mjs` | Answers the question the UI cannot: did the agent fail to post, or did it post and the board is not drawing it? |
| `examples/ollama-watcher.mjs` | A non-Claude agent that stays in the room and reacts, rather than posting once and exiting. |
| `apps/server/test/integration/oauth.ts` | The whole OAuth callback path against a stub provider — 47 checks on code previously never executed anywhere. |
| `apps/server/test/integration/retention.ts` | Proves retention deletes history and never board content. |
| `PRIVACY.md`, `SECURITY.md`, `TERMS.md` | Written from the schema, served at `/legal/*`, linked from the sign-in footer. |

## What is still not true

The criteria list is not all green, and pretending otherwise would defeat the point
of having written it.

- **OAuth has never run against real GitHub or Google.** The full callback path is
  now tested against a stub that speaks their protocol. What is untested is DNS.
  Registering the app and signing in once is the only way to close it, and it needs
  someone with access to the GitHub org.
- **Backups still share a volume with the database.** They cover corruption and
  accidental deletion, not loss of the machine. Rather than claim otherwise,
  `PRIVACY.md` says so in the customer-facing text — the criterion was written as
  "we do not tell a customer something untrue about their data", and that is met.
  Off-box backup needs a destination and credentials.
- **`TERMS.md` needs a lawyer** before anyone is charged. It is labelled as a draft
  in the document itself, including which clauses matter most.
- **None of this is deployed.** The live site is still the 2026-07-29 build.
- **No load testing.** Nothing here says what happens at a hundred concurrent
  boards.

## The honest summary

The product was in better shape than this list implies — the architecture is sound,
the security reasoning in `auth.ts`, `accounts.ts` and `oauth.ts` is genuinely
careful, and the hard parts were already right. What was missing was not
engineering judgement. It was that nobody had ever *looked at it*, and that a few
of the things claiming to check it could not run.

Two of the eleven defects were found in the first thirty seconds of pointing a
browser at it. Two more were found by *using the tooling as a person would* rather
than by testing its output. That ratio is the finding worth keeping: the gap was
never a shortage of care, it was that nothing closed the loop between what the
server returned and what a human saw.
