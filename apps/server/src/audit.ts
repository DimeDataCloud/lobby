// Audit log.
//
// Two reasons this exists, and the second is the one that makes it unusual.
//
// The ordinary reason: any product sold to a company gets asked "who did what,
// and when" during procurement, and answering "we don't keep that" ends the
// conversation.
//
// The specific reason: autonomous agents write to shared boards here. When an
// artifact three people were working from disappears, "which bot did that, on
// whose credential, at what time" needs an answer that does not depend on
// someone having watched it happen. A human deleting the wrong thing is a
// mistake; a looping agent deleting forty things is an incident, and the two
// look identical without a log.
//
// Append-only, deliberately: there is no update or delete path in this module.
// A log that its own admins can quietly edit is not evidence of anything.

import type { Database } from 'bun:sqlite';

export type AuditAction =
  | 'user.signin' | 'user.signout'
  | 'org.create' | 'org.plan_change' | 'org.seats_change' | 'org.promo_redeemed'
  | 'org.member_add' | 'org.member_remove'
  | 'workspace.create' | 'workspace.delete' | 'workspace.export'
  | 'member.token_issue' | 'member.token_revoke'
  | 'artifact.delete'
  | 'data.export' | 'data.delete';

export interface AuditEntry {
  id: number;
  at: number;
  org_id: string | null;
  actor: string;
  actor_kind: 'human' | 'agent' | 'system';
  action: AuditAction | string;
  target: string | null;
  detail: string | null;
  ip: string | null;
}

export function initAudit(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         INTEGER NOT NULL,
      org_id     TEXT,
      actor      TEXT NOT NULL,
      actor_kind TEXT NOT NULL DEFAULT 'human',
      action     TEXT NOT NULL,
      target     TEXT,
      detail     TEXT,
      ip         TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_org_at ON audit_log(org_id, at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor, at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, at DESC)');
}

export interface RecordInput {
  org_id?: string | null;
  actor: string;
  actor_kind?: 'human' | 'agent' | 'system';
  action: AuditAction | string;
  target?: string | null;
  detail?: string | Record<string, any> | null;
  ip?: string | null;
}

/**
 * Write one entry.
 *
 * Never throws. An audit write that can fail a user's action turns a logging
 * problem into an outage, and a product that stops working when its log is full
 * is worse than one that keeps working and shouts about it.
 */
export function audit(db: Database, input: RecordInput): void {
  try {
    const detail = input.detail == null
      ? null
      : typeof input.detail === 'string'
        ? input.detail.slice(0, 2000)
        : JSON.stringify(input.detail).slice(0, 2000);

    db.prepare(`
      INSERT INTO audit_log (at, org_id, actor, actor_kind, action, target, detail, ip)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      Date.now(),
      input.org_id ?? null,
      String(input.actor).slice(0, 120),
      input.actor_kind || 'human',
      String(input.action).slice(0, 60),
      input.target ? String(input.target).slice(0, 200) : null,
      detail,
      input.ip ? String(input.ip).slice(0, 60) : null
    );
  } catch (err: any) {
    console.error('[audit] write failed:', err?.message || err);
  }
}

export interface AuditQuery {
  org_id: string;
  since?: number;
  action?: string;
  actor?: string;
  limit?: number;
  before?: number;
}

export function readAudit(db: Database, q: AuditQuery): AuditEntry[] {
  const where: string[] = ['org_id = ?'];
  const params: any[] = [q.org_id];

  if (q.since)  { where.push('at >= ?'); params.push(Number(q.since)); }
  if (q.before) { where.push('at < ?');  params.push(Number(q.before)); }
  if (q.action) { where.push('action = ?'); params.push(String(q.action)); }
  if (q.actor)  { where.push('actor = ?');  params.push(String(q.actor)); }

  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 1000);
  params.push(limit);

  return db.prepare(`
    SELECT * FROM audit_log WHERE ${where.join(' AND ')}
    ORDER BY at DESC, id DESC LIMIT ?
  `).all(...params) as AuditEntry[];
}

/**
 * Retention. Entries older than the window are dropped.
 *
 * Kept generous by default and configurable, because "how long do you keep audit
 * data" is itself a procurement question and the honest answers are a number,
 * not "forever" — forever is a storage bill and a liability, not a feature.
 */
export function pruneAudit(db: Database): number {
  const days = Math.max(30, parseInt(process.env.AUDIT_RETENTION_DAYS || '', 10) || 365);
  const cutoff = Date.now() - days * 86400_000;
  try {
    const r = db.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff);
    return Number(r.changes || 0);
  } catch {
    return 0;
  }
}

/** The caller's IP, when we are allowed to believe the header. */
export function clientIp(req: Request): string | null {
  if (!process.env.TRUST_PROXY) return null;
  const fwd = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return fwd || null;
}
