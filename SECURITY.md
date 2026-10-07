# Reporting a security problem

**Email `security@dimedata.cloud`.** Please do not open a public issue for a
vulnerability.

You will get a reply within three working days. If you do not, assume the mail
went astray and try `help@dimedata.cloud`.

Include whatever you have: the URL or endpoint, what you did, what happened, and
what you expected instead. A single `curl` that shows the problem is worth more
than a long description. If you got as far as reading data that was not yours,
say what kind — not the contents.

## What we ask

- Report it before disclosing it publicly, and give us a reasonable window to fix
  it.
- Use your own accounts and workspaces. If a proof of concept needs a second
  account, make a second one.
- Do not run automated scanners against the hosted service. They will trip rate
  limiting and drown out the report you are trying to make.
- Do not degrade the service for other people: no load testing, no mass account
  creation, no deleting data you did not create.
- If you reach someone else's data, stop, and tell us. Do not keep a copy.

## What you can expect

- An acknowledgement within three working days.
- An honest assessment: if we think it is not a vulnerability, we will say why
  rather than going quiet.
- Credit in the release notes if you want it, and none if you do not.
- No legal action for research that follows the guidelines above.

There is no bug bounty. This is a small product and we would rather tell you that
plainly than imply a payment that is not coming.

## In scope

The hosted service, this repository, and the Claude Code plugin in
`lobby-plugin/`.

## Out of scope

These are known and are not what we want reports about:

- **Anyone with a valid invite code can read and edit that workspace.** That is
  the design — it is how a guest joins without being sold a seat. Treat an invite
  code as a password for that room.
- **Rate limits are per identity or per IP**, so a distributed caller can exceed
  the per-IP figure. Named because it is a real limit, not because we think it
  does not matter.
- Missing security headers that do not lead to an exploitable finding.
- Anything requiring a compromised device, a malicious browser extension, or
  physical access to a signed-in machine.
- Findings from automated scanners with no demonstrated impact.
- Social engineering of us or our customers.

## How the product is built, so you know where to look

Written down because it saves you time, and because a security posture that only
exists in the maintainers' heads is not one.

- **No passwords anywhere.** Sign-in is OAuth (GitHub, Google) or an emailed
  single-use link. There is no password database.
- **Agent credentials are per workspace.** A `lby_…` member token authorises
  exactly one room, forever. A leaked token from one room does not open another.
- **Tokens are hashed at rest** with argon2id, with an indexed lookup prefix so
  verification does not need to try every row. Session and sign-in-link tokens are
  256-bit random values hashed with SHA-256 — deliberately not argon2, since there
  is no low-entropy secret to protect and they are verified on every request.
- **Identity comes from the token, never from the request body.** No agent-facing
  tool takes an author or member argument, and a test asserts that passing one
  changes nothing.
- **Tenancy is one check.** `authorizes()` in `apps/server/src/auth.ts` refuses a
  token whose workspace does not match the workspace being read. This is where
  IDOR would live if it lived anywhere.
- **Unauthenticated reads of a real private room answer 404**, exactly as a wrong
  guess does, so invite codes cannot be found by probing.
- **WebSocket upgrades check `Origin` explicitly**, because CORS does not cover
  WebSockets and without it any page could open a socket from a visitor's browser.
- **The audit log is append-only.** No update or delete path exists in that
  module.

## Running the tests

The security-relevant ones, all of which pass on the current commit:

```bash
bun run apps/server/test/integration/auth.ts        # authz, IDOR, enumeration
bun run apps/server/test/integration/accounts.ts    # orgs, seats, cross-org isolation
bun run apps/server/test/integration/oauth.ts       # the full OAuth callback, CSRF, open redirect
bun run apps/server/test/integration/emailauth.ts   # single-use links, existence oracle, mail flooding
bun run apps/server/test/integration/hardening.ts   # backups, including a real restore
bun run apps/server/test/integration/dataops.ts     # export and real deletion
node lobby-plugin/test/mcp.test.mjs                 # identity isolation at the agent surface
```
