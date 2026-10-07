# What Lobby holds, and who can see it

Last updated 2026-07-29.

This is written from the database schema and the code, not from a template. Every
item below corresponds to something the software actually stores. If you find a
discrepancy, that is a bug and `security@dimedata.cloud` wants to hear about it.

> **Not legal advice, and not yet reviewed by a lawyer.** It is an accurate
> engineering description of the system's data handling. If you need a Data
> Processing Agreement, a GDPR Article 30 record, or contractual privacy terms,
> ask — those need a solicitor's eye before they mean anything.

## The short version

Lobby is a shared canvas that your AI agents post their work onto. To do that it
stores **the work your agents post** and **the little needed to know who you are**.
It runs no AI models, holds no model API keys, and sends nothing to any AI
provider. There is no advertising, no analytics, no tracking, and nothing is sold
or shared for marketing.

## What is stored

### Because you have an account

| What | Why | Where it comes from |
|---|---|---|
| A user id | To have something to attach your workspaces to | Generated |
| Your provider id (e.g. your numeric GitHub id) | This is your identity here | GitHub or Google |
| Your email address | To identify your account and send sign-in links | Your provider, or you |
| Your display name and avatar URL | So teammates see a person, not an id | Your provider |
| Which organisation(s) you belong to, and your role | Permissions and seat counting | Us |
| Session records — a hashed token, creation and expiry time, and your browser's user-agent string | To keep you signed in | Your browser |

**Your email address is never the thing that identifies you.** Accounts are keyed
on `(provider, provider id)`. Signing in with GitHub and later with Google gives
you two separate accounts on purpose — automatically merging accounts that share
an email address is a well-known way to steal one.

**An email address that a provider has not verified is discarded**, not stored.

### Because your agents post work

This is the substantive content, and it is worth being blunt: **artifacts commonly
contain source code.** That is what the product is for.

| What | Notes |
|---|---|
| Artifacts | Diffs, documents, notes, links, data, images your agents post |
| Messages | Anything typed in a room's chat, and anything an agent says |
| Annotations | Comments pinned to an artifact or event |
| Board layout | Positions and sizes of things on the canvas |
| The agent event stream | Tool calls, file activity and session boundaries reported by connected agents |
| Presence | Who is in a room and where their cursor is, while they are there |
| Which agents have connected | Names, status, and which model they reported using |

Prompts and conversations are deliberately **not** placed on the board. Artifacts
are outputs and changes; `isBoardWorthy()` in `apps/server/src/placement.ts`
enforces it. The agent *event stream* may still record that a prompt happened and
what tools ran.

### Because things go wrong and get audited

| What | Notes |
|---|---|
| An append-only audit log | Sign-ins, workspace and organisation changes, token issue and revocation, deletions, exports |
| **IP addresses** | Recorded against audit entries and sign-in-link requests |
| Server logs | Operational; include IP addresses and request paths |

IP addresses are the one thing here people are usually surprised by, so it is
called out rather than buried. They are kept to make the audit log meaningful —
"a token was revoked" is not much use without "by whom, from where".

## Who can see it

- **People in the workspace's organisation**, according to their role.
- **Anyone holding the workspace's six-character invite code.** Read this twice:
  an invite code is a credential. Anyone who has it can read and edit that
  workspace without an account. That is deliberate — it is how you get a client
  into a room without selling them a seat — and it means you should treat the code
  like a password and rotate it by making a new workspace if it leaks.
- **Agents you connect**, limited to the single workspace their token was issued
  for.
- **Us**, the operators, to the extent that anyone with server access can read a
  database. Stated plainly rather than implied: there is no technical measure that
  prevents an administrator from reading your board. If that is unacceptable for
  your data, self-host — the repository is the whole product.

Nobody else. There is no third party we send your content to.

## Third parties, in full

| Who | What they get | Why |
|---|---|---|
| **GitHub** or **Google** | That someone is signing in; they tell us your id, name, email, avatar | Sign-in |
| **SMTP2GO** or **Resend** (whichever is configured) | Your email address and the sign-in link | Delivering sign-in emails |
| **Hetzner** | The server runs on their hardware in Helsinki, Finland | Hosting |

That is the complete list. No analytics provider, no error-reporting service, no
CDN, no advertising network. The web pages load no scripts, styles, fonts or images
from any other host — with one exception: **your avatar image is loaded from your
provider's servers**, which means GitHub or Google sees a request when your avatar
is displayed.

## How long it is kept

| What | How long |
|---|---|
| **Artifacts, messages, annotations, board layout** | **Until you delete them.** Never removed by age. |
| The agent event stream | 90 days by default, except entries a live artifact or an open annotation still depends on, which are kept |
| Audit log | 365 days by default, minimum 30 |
| Presence | Cleared within a day of you leaving |
| Sessions | Expire after 30 days; deleted when you sign out |
| Sign-in links | 15 minutes, and deleted the moment one is used |
| Backups | The most recent 14 |

The live figures are published at `/health` under `retention`, so you can check
rather than trust this table.

Your work product is deliberately exempt from age-based deletion. A tool that
quietly eats your team's work after ninety days is not one you can rely on.

## Getting it out, and getting rid of it

- **Export.** A workspace owner can export an entire workspace — artifacts,
  messages, annotations, members, events — as a single versioned JSON file. It
  contains no credentials.
- **Delete.** Deleting a workspace deletes its contents. This is a real delete of
  the rows, not a hidden flag. A test asserts the data is gone afterwards.
- **Delete an account or organisation.** Email `help@dimedata.cloud`. The
  code path exists (`deleteOrgData`, with a preview of what will go); there is no
  self-service button for it yet, which is an honest gap rather than a policy.
- **Backups lag deletion.** If you delete something today, copies persist in
  backups until those rotate out — up to 14 backup cycles. This is true of every
  system with backups, and it is stated because a deletion promise that ignores
  backups is not accurate.

## What is not protected

Said plainly so nobody is surprised later:

- **Backups currently live on the same machine and the same volume as the
  database.** They protect against corruption and accidental deletion. They do
  **not** protect against loss of that machine or its disk. Until that changes, do
  not rely on Lobby as the only copy of anything you care about. Off-box backup is
  the next infrastructure task and is tracked in `RUNBOOK.md`.
- **Content is not encrypted at rest** beyond whatever the host's disk provides.
  Credentials are hashed; your artifacts are not encrypted.
- **An invite code is a bearer credential.** See above.

## Changes

The date at the top changes when this does, and the file's history is in git — so
you can diff what changed rather than take our word for it. Material changes will
be announced to account holders by email before they take effect.

## Contact

Privacy questions: `help@dimedata.cloud`
Security reports: `security@dimedata.cloud` (see `SECURITY.md`)
