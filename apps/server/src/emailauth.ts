// Sign-in by emailed link.
//
// No passwords, same as the OAuth path: nothing to hash wrong, nothing to reset,
// and a database dump contains no credential worth cracking.
//
// Five decisions, each of which is a real vulnerability if reversed:
//
// 1. THE LINK IS SINGLE-USE AND SHORT-LIVED. A magic link is a bearer credential
//    sitting in an inbox, and inboxes get forwarded, backed up and breached. It is
//    deleted on redemption, so a link in a forwarded email is already spent.
//
// 2. ONLY ITS HASH IS STORED. A read of this table must not yield a working
//    sign-in link for every pending address. SHA-256 rather than argon2 is
//    deliberate and mirrors sessions: the token is 256 bits of CSPRNG output, so
//    there is no low-entropy secret for a slow hash to protect, and this is
//    verified on a user-facing request path.
//
// 3. REDEEMING ONE LINK KILLS THAT ADDRESS'S OTHER PENDING LINKS. Otherwise every
//    link you ever requested stays live until it expires, and the oldest email in
//    the thread is as good as the newest.
//
// 4. REQUESTS ARE CAPPED PER ADDRESS, NOT ONLY PER IP. Without this, the endpoint
//    is a free mail cannon aimed at anyone's inbox — the abuse is against a third
//    party, so limiting only the caller's IP does not cover it.
//
// 5. THE RESPONSE IS IDENTICAL WHETHER OR NOT THE ADDRESS HAS AN ACCOUNT. This
//    endpoint must never become an account-existence oracle.
//
// Identity note: the user row is keyed (provider='email', subject=<address>).
// Someone who signs in by email and later by Google is two accounts on purpose —
// see accounts.ts note 1. Merging them on a matching email address is an account
// takeover, not a convenience.

import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import type { ProfileFromProvider } from './accounts';
import { sendMail, isEmail, normalizeEmail, mailConfigured } from './mail';

const TTL_MS = 15 * 60_000;
const MAX_PER_ADDRESS_PER_HOUR = 5;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function initEmailAuth(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_links (
      token_hash TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      redirect   TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip         TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_email_links_email ON email_links(email)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_email_links_expires ON email_links(expires_at)');
}

export class EmailAuthError extends Error {}

/** Not configured is a normal state, and the sign-in screen says so in English. */
export function emailAuthAvailable(): boolean {
  return mailConfigured();
}

// ---------------------------------------------------------------------------
// Step 1 — ask for a link
// ---------------------------------------------------------------------------

/**
 * Issues and sends a link. Throws only for input we refuse outright (a malformed
 * address, or too many requests for that address); a delivery failure is raised
 * as EmailAuthError with a generic message and logged server-side.
 */
export async function startEmailSignIn(
  db: Database,
  rawEmail: string,
  origin: string,
  opts?: { redirect?: string; ip?: string }
): Promise<{ email: string }> {
  const email = normalizeEmail(String(rawEmail || ''));
  if (!isEmail(email)) throw new EmailAuthError('That does not look like an email address.');

  const recent = db
    .prepare('SELECT COUNT(*) AS n FROM email_links WHERE email = ? AND created_at > ?')
    .get(email, Date.now() - 60 * 60_000) as any;
  if (Number(recent?.n || 0) >= MAX_PER_ADDRESS_PER_HOUR) {
    throw new EmailAuthError(
      'That address has been sent several sign-in links already. Check the inbox, or try again later.'
    );
  }

  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(
    'INSERT INTO email_links (token_hash, email, redirect, created_at, expires_at, ip) VALUES (?,?,?,?,?,?)'
  ).run(sha256(token), email, safeRedirect(opts?.redirect), now, now + TTL_MS, opts?.ip ?? null);

  const link = `${origin.replace(/\/$/, '')}/auth/email/callback?token=${encodeURIComponent(token)}`;

  try {
    await sendMail({ to: email, subject: 'Your Lobby sign-in link', text: bodyText(link), html: bodyHtml(link) });
  } catch (err) {
    // The row is left in place; it expires on its own. Deleting it here would let
    // a caller probe delivery behaviour by watching the rate-limit count move.
    console.error('[emailauth] send failed:', err instanceof Error ? err.message : err);
    throw new EmailAuthError('We could not send to that address. Check it and try again.');
  }

  return { email };
}

// ---------------------------------------------------------------------------
// Step 2 — redeem it
// ---------------------------------------------------------------------------

export function consumeEmailLink(
  db: Database,
  token: string | null
): { profile: ProfileFromProvider; redirect: string } {
  if (!token) throw new EmailAuthError('That sign-in link is not valid.');

  const hash = sha256(token);
  const row = db.prepare('SELECT * FROM email_links WHERE token_hash = ?').get(hash) as any;

  // One message for missing, expired and already-used. Distinguishing them tells
  // an attacker holding a stale link which of those it is, and tells an honest
  // user nothing they can act on differently.
  const invalid = 'That sign-in link has expired or has already been used. Ask for a new one.';
  if (!row) throw new EmailAuthError(invalid);

  db.prepare('DELETE FROM email_links WHERE token_hash = ?').run(hash);
  if (Number(row.expires_at) <= Date.now()) throw new EmailAuthError(invalid);

  // Decision 3: every other pending link for this address dies with the redemption.
  db.prepare('DELETE FROM email_links WHERE email = ?').run(row.email);

  return {
    profile: {
      provider: 'email',
      subject: row.email,
      email: row.email,
      // No display name: nobody asserted one. The address is what we know, and
      // inventing a name from the local-part is a guess shown to their teammates.
      name: null,
      avatar_url: null,
    },
    redirect: safeRedirect(row.redirect),
  };
}

export function sweepEmailLinks(db: Database): void {
  db.prepare('DELETE FROM email_links WHERE expires_at <= ?').run(Date.now());
}

/** Same rule as the OAuth path: only ever redirect inside our own app. */
export function safeRedirect(target?: string | null): string {
  if (!target) return '/';
  if (!target.startsWith('/') || target.startsWith('//')) return '/';
  return target;
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

function bodyText(link: string): string {
  return [
    'Here is your sign-in link for Lobby:',
    '',
    link,
    '',
    'It works once and expires in 15 minutes.',
    '',
    'If you did not ask for this, you can ignore it — nobody can sign in without',
    'opening the link, and it will expire on its own.',
  ].join('\n');
}

function bodyHtml(link: string): string {
  // Inline styles and a table-free layout: every interesting mail client strips
  // <style> blocks, and half of them mangle floats.
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#0d0d0f;font-family:-apple-system,Segoe UI,Inter,sans-serif;">
  <div style="max-width:440px;margin:0 auto;background:#131318;border:1px solid #26262e;border-radius:14px;padding:28px;">
    <h1 style="margin:0 0 4px;font-size:22px;font-weight:600;color:#e0e0e6;">Lobby</h1>
    <p style="margin:0 0 22px;font-size:13px;color:#7a7a86;">A shared canvas your bots work on.</p>
    <p style="margin:0 0 18px;font-size:14px;color:#e0e0e6;line-height:1.6;">Here is your sign-in link.</p>
    <a href="${escapeAttr(link)}"
       style="display:block;background:#f97316;color:#0d0d0f;text-decoration:none;text-align:center;
              padding:12px 16px;border-radius:9px;font-weight:600;font-size:14px;">Sign in to Lobby</a>
    <p style="margin:18px 0 0;font-size:12px;color:#7a7a86;line-height:1.6;">
      It works once and expires in 15 minutes. If you did not ask for this you can
      ignore it — nobody can sign in without opening the link.
    </p>
  </div>
</body></html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
