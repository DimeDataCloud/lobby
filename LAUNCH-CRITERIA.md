# What "ready to be public" means here

This is the bar Lobby has to clear before a stranger can pay for it. I wrote it
rather than inheriting it, so the reasoning is stated and you can disagree with a
specific line instead of the whole thing.

Each item is pass/fail, and each one names how it is checked. "It looks fine" is
not a check. Anything I could not verify is listed as unverified rather than
quietly assumed — the point of the list is that it cannot flatter itself.

Status column: **PASS** verified · **FAIL** verified broken · **?** not verified.

## A — A stranger can actually use it

| | Criterion | How it is checked | Status |
|---|---|---|---|
| A1 | Someone with no connection to us can create an account unaided | A configured sign-in provider | **BLOCKED** — needs the GitHub OAuth app registered |
| A2 | No screen a stranger reaches names an environment variable, a config key, or an internal file | `ops/browser-check.mjs`, 8 views | PASS — was FAIL |
| A3 | The front door says what this is and what to do next, in one screen | Read it as a stranger | PASS |
| A4 | A wrong or expired invite code fails with a sentence a human wrote | `ops/browser-check.mjs` | PASS — was FAIL, badly |

**Why A1 is first, and why it is still blocked.** Everything else is decoration if
accounts cannot be created. The owner is registering the GitHub OAuth app; it is
five minutes of work that only someone with access to the org can do, so it stays
listed as the blocker rather than worked around.

Email sign-in was built before that decision and remains in the tree, inert without
a mail key — `/auth/providers` simply omits it. It is not the path; it is not in
the way either.

The **entire OAuth callback path** is now tested against a stub provider speaking
GitHub's protocol (47 checks). What that cannot cover is DNS.

## B — Nothing here lies

| | Criterion | How it is checked | Status |
|---|---|---|---|
| B1 | Every command in every doc runs as written, from the directory the doc implies | Extracted all 90 and ran them | PASS — two were broken |
| B2 | Every capability claim is backed by a test, or the claim is deleted | Grep claims → find the test | PASS |
| B3 | No doc describes a feature that does not exist | Read every doc against the code | PASS |

Two failures here, both found by extracting every fenced command and running it:
`just test` in the PR instructions (the justfile had been deleted), and the
artifact-render test, which could not run from the directory its own documentation
specified. The test lists had also drifted across four documents; there is now one
runner and the documents point at it.

**Why this is a launch criterion at all.** This repo has already shipped one doc
written by an agent that overstated itself, and one test suite listing a command
that could never have run. A doc that lies is worse than a missing doc: it
converts a five-minute problem into an afternoon.

## C — It has been looked at

| | Criterion | How it is checked | Status |
|---|---|---|---|
| C1 | Every view rendered at 1440px and at 390px, looked at, no broken layout | `ops/browser-check.mjs` + screenshots reviewed by eye | PASS — was FAIL |
| C2 | Zero uncaught console errors on load of every view | CDP console capture | PASS |
| C3 | Every artifact kind renders its content, not a placeholder | `apps/client/test-artifact-render.mjs` | PASS — the test itself was broken |
| C4 | No interactive control physically covers another | Geometry check in `ops/browser-check.mjs` | PASS — was FAIL |

**Why.** The worst bug this project shipped — bot artifacts drawing as a grey box
reading "artifact" — was invisible to every server-side test and obvious in one
glance. Any criterion list for this product that does not include *looking at it*
has learned nothing.

## D — Someone else's data

| | Criterion | How it is checked | Status |
|---|---|---|---|
| D1 | Backups survive loss of the host, or no customer-facing text claims they do | Read every durability claim | PASS — the claim was scoped to the truth, not the other way round |
| D2 | No table grows without bound | `apps/server/test/integration/retention.ts` | PASS — was FAIL on two tables |
| D3 | A customer can export everything and delete everything, for real | `dataops.ts` integration test | PASS |
| D4 | A database dump does not hand over live credentials | Tokens hashed at rest | PASS |

**Why D1 is worded that way.** Off-box backup needs a destination and credentials
I do not have. The criterion is therefore not "backups are perfect" — it is
"we do not tell a customer something untrue about their data." That I can meet
today; the stronger version is one config away and marked in the runbook.

## E — Hostile input

| | Criterion | How it is checked | Status |
|---|---|---|---|
| E1 | No response a stranger can trigger contains a stack trace, file path, or internal identifier | Fuzzed traversal, injection, malformed bodies, null bytes | PASS — OAuth errors leaked endpoint URLs |
| E2 | Every unauthenticated endpoint is rate limited | `hardening.ts` | PASS |
| E3 | No secret appears in the client bundle or in logs | Grep the built bundle for key shapes | PASS |
| E4 | A token for one workspace cannot read another | `auth.ts` integration test (IDOR) | PASS |
| E5 | A request body cannot exhaust the process | `hardening.ts` | PASS — **60MB was accepted in 0.9s** |

E5 was not on the original list. It was added after fuzzing found it, which is what
a criteria list is supposed to do — the check that finds nothing teaches you less
than the one that forces you to add a criterion.

## F — Being a real company about it

| | Criterion | How it is checked | Status |
|---|---|---|---|
| F1 | Privacy, terms and a security contact are reachable from the front door | `ops/browser-check.mjs` asserts each page serves its own content | PASS — none existed |
| F2 | What data is held, where it lives, and who can see it, stated plainly | `PRIVACY.md`, written from the schema | PASS — none existed |
| F3 | A security report has somewhere to go | `SECURITY.md` + `security@dimedata.cloud` | PASS — none existed |
| F4 | Terms exist and are honest about being a draft | `TERMS.md` | PARTIAL — **needs a lawyer before anyone is charged** |

**Why this is not optional.** Charging money for a thing that holds other
people's source code, without saying what you do with it, is the part that turns
a bug into a liability.

## G — It can be operated by someone who is not me

| | Criterion | How it is checked | Status |
|---|---|---|---|
| G1 | A deploy is provable, not hopeful | `ops/verify-deploy.mjs`, 40 live checks | PASS |
| G2 | A restore has actually been performed, not just written down | Hardening test does a real restore | PASS |
| G3 | The runbook alone is enough to deploy, roll back and diagnose | Follow it cold | PASS |

## H — The thing it is for

Lobby's premise is that agents from different vendors work on one board. That is
the demo, so it is a launch criterion, not a nice-to-have.

| | Criterion | How it is checked | Status |
|---|---|---|---|
| H1 | Two agents with separate identities both post to one board, correctly attributed | Run on a real board | PASS |
| H2 | When an agent misbehaves, there is somewhere to look | `ops/lobby-debug.mjs` | PASS |
| H3 | The whole multi-agent path is reproducible by someone else | `ops/multi-agent-test.mjs` — one command | PASS |
| H4 | An agent whose model is unavailable says so rather than inventing output | Exercised — the Ollama account is at its cap | PASS |

H4 was proven the hard way: the Ollama account hit its weekly limit mid-test, every
cloud model returned 429, and the agent posted "no model available" with the list it
tried. That is the behaviour you want and it is now the better-tested path.

**Real model output remains unproven** while the account is capped. The Lobby side —
join, read, post, attribute, fan out, dedupe — is fully exercised.

## Explicitly out of scope for launch

Named so they are decisions rather than oversights.

- **Billing.** Invoice the first teams by hand. `orgs.plan` and `orgs.seat_limit`
  are the two columns a Stripe checkout will set. Automating revenue collection
  before anyone wants to pay is the wrong order.
- **Account linking.** The same human via email and GitHub is two accounts.
  Merging on a matching email address is an account-takeover vector, so it needs
  a real verification flow and does not get a shortcut.
- **SSO / SAML.** Enterprise sales problem, not a launch problem.
- **Mobile-native.** The board is usable on a phone; it is not designed for one.

## Where it stands

**One blocker, one caveat, everything else met.**

| | |
|---|---|
| **A1 — accounts** | BLOCKED. Register the GitHub OAuth app. Only the org owner can. |
| **F4 — terms** | PARTIAL. Draft; needs a lawyer before charging anyone. |
| **D1 — backups** | Met as written ("we do not say anything untrue"), not as anyone would prefer. Off-box backup needs a destination. |
| Everything else | PASS, each against a named check that can be re-run. |

Ten defects were found and fixed getting here. `LAUNCH-REPORT.md` is the full
account with reasoning.

Every FAIL above became a PASS by a change to the product, not by a rewording of
the criterion — with one deliberate exception, D1, where the *claim* was the thing
that was wrong and scoping it to the truth was the correct fix.

One criterion (E5) was added partway through, after fuzzing found a 60MB request
body being accepted. A list that never grows while you work through it is a list
that was written to be passed.

**Deployed 2026-07-31** and verified against the live host: `ops/verify-deploy.mjs`
40/40, `ops/browser-check.mjs` 98 checks, container healthy at 16MB of 512MB, no
errors in the log, existing data intact across the deploy.
