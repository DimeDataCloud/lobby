// Outbound email.
//
// This exists so sign-in does not depend on anybody registering an OAuth app.
// Registering one is a five-minute job that only the operator can do, and it was
// the single thing standing between this product and its first paying customer —
// a bad place for a blocker to live.
//
// Three decisions worth stating:
//
// 1. TRANSPORTS ARE HTTP APIS, NOT SMTP. Bun has no SMTP client, and hand-rolling
//    one means owning TLS negotiation, line-ending rules and multi-line reply
//    parsing in a path that authenticates people. Every provider here offers a
//    one-POST HTTP API instead. Adding another is the ~10 lines of a `send`.
//
// 2. THE `log` TRANSPORT REFUSES TO RUN IN PRODUCTION. It prints the sign-in link
//    to stdout, which is perfect for local development and is a full account
//    takeover for anyone who can read logs. It is therefore gated on NODE_ENV,
//    not on good intentions.
//
// 3. A SEND FAILURE IS NEVER REPORTED TO THE CALLER IN DETAIL. "We could not send
//    to that address" plus a server-side log is the whole story a stranger gets;
//    provider error text leaks which addresses exist and what we run.

export type Transport = 'smtp2go' | 'resend' | 'log';

export interface MailConfig {
  transport: Transport;
  from: string;
  fromName: string;
  apiKey: string;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Null when no transport is configured, which is a supported state: the server
 * runs, and the sign-in screen offers the invite-code path instead of pretending
 * email works.
 */
export function mailConfig(): MailConfig | null {
  const explicit = (process.env.MAIL_TRANSPORT || '').toLowerCase().trim();
  const from = (process.env.MAIL_FROM || '').trim();
  const fromName = (process.env.MAIL_FROM_NAME || 'Lobby').trim();

  if (explicit === 'log') {
    // Deliberately awkward to switch on by accident.
    if (process.env.NODE_ENV === 'production') return null;
    return { transport: 'log', from: from || 'lobby@localhost', fromName, apiKey: '' };
  }

  const smtp2go = (process.env.SMTP2GO_API_KEY || '').trim();
  if (smtp2go && from) return { transport: 'smtp2go', from, fromName, apiKey: smtp2go };

  const resend = (process.env.RESEND_API_KEY || '').trim();
  if (resend && from) return { transport: 'resend', from, fromName, apiKey: resend };

  return null;
}

export function mailConfigured(): boolean {
  return mailConfig() !== null;
}

/**
 * Why a config problem is distinguished from a delivery problem: the first is
 * ours and belongs in the startup path, the second is transient and belongs in a
 * retry. The caller only ever surfaces a generic message either way.
 */
export class MailError extends Error {}

export async function sendMail(mail: Mail): Promise<void> {
  const cfg = mailConfig();
  if (!cfg) throw new MailError('No mail transport is configured');

  if (!isEmail(mail.to)) throw new MailError('Not a deliverable address');

  switch (cfg.transport) {
    case 'log':      return sendViaLog(cfg, mail);
    case 'smtp2go':  return sendViaSmtp2go(cfg, mail);
    case 'resend':   return sendViaResend(cfg, mail);
  }
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

async function sendViaLog(cfg: MailConfig, mail: Mail): Promise<void> {
  console.log(
    `\n──── mail (transport=log, NOT delivered) ────\n` +
    `to:      ${mail.to}\n` +
    `from:    ${cfg.fromName} <${cfg.from}>\n` +
    `subject: ${mail.subject}\n\n${mail.text}\n` +
    `─────────────────────────────────────────────\n`
  );
}

async function sendViaSmtp2go(cfg: MailConfig, mail: Mail): Promise<void> {
  const res = await fetch('https://api.smtp2go.com/v3/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Smtp2go-Api-Key': cfg.apiKey },
    body: JSON.stringify({
      sender: `${cfg.fromName} <${cfg.from}>`,
      to: [mail.to],
      subject: mail.subject,
      text_body: mail.text,
      ...(mail.html ? { html_body: mail.html } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const body: any = await res.json().catch(() => null);
  // SMTP2GO answers 200 with a per-recipient failure count, so HTTP status alone
  // is not proof of anything.
  const sent = Number(body?.data?.succeeded ?? 0);
  if (!res.ok || sent < 1) {
    throw new MailError(
      body?.data?.error || body?.error || `smtp2go rejected the send (HTTP ${res.status})`
    );
  }
}

async function sendViaResend(cfg: MailConfig, mail: Mail): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      from: `${cfg.fromName} <${cfg.from}>`,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body: any = await res.json().catch(() => null);
    throw new MailError(body?.message || `resend rejected the send (HTTP ${res.status})`);
  }
}

// ---------------------------------------------------------------------------

/**
 * Deliberately permissive. This is a deliverability sniff test to reject obvious
 * junk and anything with a newline in it — not an attempt to encode RFC 5322,
 * which regexes famously get wrong by excluding real addresses.
 */
export function isEmail(s: string): boolean {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 3 || t.length > 254) return false;
  if (/[\s<>"\\]/.test(t)) return false;          // header injection, and junk
  const at = t.indexOf('@');
  if (at < 1 || at !== t.lastIndexOf('@')) return false;
  const domain = t.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

/**
 * Lowercased and trimmed, and nothing else. Notably it does NOT strip dots or
 * `+tags`: those rules differ per provider, and applying Gmail's to everyone
 * silently merges two different people's accounts at some hosts.
 */
export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}
