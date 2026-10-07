// Accounts, organisations and seats.
//
// This sits BESIDE the member-token system in auth.ts rather than replacing it,
// because humans and bots are different things and want different credentials:
//
//   human → OAuth → session cookie → every workspace in their orgs
//   bot   → lby_… member token     → exactly one workspace, forever
//
// A machine credential scoped to a single room is exactly right for an agent,
// and auth.ts already does it well. Widening it to "this bot can reach anything
// its operator can" would mean a leaked token from one room opens every room the
// operator belongs to.
//
// Three decisions worth stating, because each is a trap if reversed:
//
// 1. USERS ARE UNIQUE ON (provider, subject), NOT ON EMAIL. The same human
//    signing in with GitHub and then Google is two rows until they deliberately
//    link them. Merging on matching email looks helpful and is an account
//    takeover: anyone who can get an OAuth provider to assert an email they do
//    not control inherits the existing account.
//
// 2. A PERSONAL ACCOUNT IS AN ORG WITH ONE SEAT. Not a separate concept with a
//    parallel code path — every permission check, every seat count and every
//    workspace lookup then has exactly one shape, and upgrading personal to
//    organisation is an UPDATE rather than a migration.
//
// 3. SESSION TOKENS ARE HASHED WITH SHA-256, NOT ARGON2. This is deliberate and
//    is NOT the mistake it looks like next to auth.ts. Argon2 exists to make
//    guessing a LOW-entropy secret expensive. A session token here is 256 bits
//    of CSPRNG output — unguessable by construction — and it is verified on
//    every single request, where a deliberately slow hash would be a self-
//    inflicted denial of service.

import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';

export type OrgRole = 'owner' | 'admin' | 'member';
export type Plan = 'personal' | 'organization';

const ROLE_RANK: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 };

/**
 * What a plan includes. Additional seats are sold on top of an organisation's
 * included five; personal is deliberately not expandable — buying a second seat
 * means you have a team, which is the organisation plan.
 */
export const PLANS: Record<Plan, { seats: number; priceCents: number; extraSeatCents: number | null }> = {
  personal:     { seats: 1, priceCents: 1999, extraSeatCents: null },
  organization: { seats: 5, priceCents: 8000, extraSeatCents: 1499 },
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

export interface User {
  id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  provider: string;
  provider_subject: string;
  created_at: number;
}

export interface Org {
  id: string;
  name: string;
  plan: Plan;
  seat_limit: number;
  owner_user_id: string;
  created_at: number;
}

export interface OrgMembership {
  org_id: string;
  user_id: string;
  role: OrgRole;
  seat_active: boolean;
  joined_at: number;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function initAccounts(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id               TEXT PRIMARY KEY,
      email            TEXT,
      name             TEXT,
      avatar_url       TEXT,
      provider         TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      last_seen        INTEGER
    )
  `);
  // The identity key. Email is indexed for lookup but NEVER unique — see note 1.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_subject)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS orgs (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      plan          TEXT NOT NULL DEFAULT 'personal',
      seat_limit    INTEGER NOT NULL DEFAULT 1,
      owner_user_id TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_orgs_owner ON orgs(owner_user_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS org_members (
      org_id      TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'member',
      seat_active INTEGER NOT NULL DEFAULT 1,
      invited_by  TEXT,
      joined_at   INTEGER NOT NULL,
      PRIMARY KEY (org_id, user_id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      user_agent TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(token_hash)');

  // Short-lived CSRF state for the OAuth round trip. A row here is proof that
  // *this* browser started the flow, so a callback it did not ask for is refused.
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      state      TEXT PRIMARY KEY,
      provider   TEXT NOT NULL,
      redirect   TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  // Workspaces belong to an org. Nullable so rooms created before accounts
  // existed keep working — they are reachable by invite code as they always were.
  try {
    const cols = (db.prepare('PRAGMA table_info(lobbies)').all() as any[]).map((c) => c.name);
    if (cols.length && !cols.includes('org_id')) {
      db.exec('ALTER TABLE lobbies ADD COLUMN org_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_lobbies_org ON lobbies(org_id)');
    }
  } catch { /* lobbies not created yet; initLobbies runs its own */ }

  // Promo codes grant a plan directly — no Stripe involved, no card ever
  // collected. This is the comp path while billing is invoiced by hand.
  db.exec(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      code             TEXT PRIMARY KEY,
      plan             TEXT NOT NULL,
      seat_limit       INTEGER,
      max_redemptions  INTEGER,
      redeemed_count   INTEGER NOT NULL DEFAULT 0,
      expires_at       INTEGER,
      created_at       INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS promo_redemptions (
      code        TEXT NOT NULL,
      org_id      TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      redeemed_at INTEGER NOT NULL,
      PRIMARY KEY (code, org_id)
    )
  `);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;

export interface ProfileFromProvider {
  provider: string;
  subject: string;
  email?: string | null;
  name?: string | null;
  avatar_url?: string | null;
}

/**
 * Find or create the user behind an OAuth profile, and put them in a personal
 * org on first sight so they always have somewhere to make a workspace.
 */
export function upsertUser(db: Database, p: ProfileFromProvider): { user: User; created: boolean } {
  const now = Date.now();
  const existing = db
    .prepare('SELECT * FROM users WHERE provider = ? AND provider_subject = ?')
    .get(p.provider, p.subject) as any;

  if (existing) {
    // Refresh the display fields — people change their name and avatar — but
    // never the identity key.
    db.prepare('UPDATE users SET email = ?, name = ?, avatar_url = ?, last_seen = ? WHERE id = ?')
      .run(p.email ?? existing.email, p.name ?? existing.name, p.avatar_url ?? existing.avatar_url, now, existing.id);
    return { user: hydrateUser({ ...existing, email: p.email ?? existing.email }), created: false };
  }

  const userId = id('usr');
  db.prepare(`
    INSERT INTO users (id, email, name, avatar_url, provider, provider_subject, created_at, last_seen)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(userId, p.email ?? null, p.name ?? null, p.avatar_url ?? null, p.provider, p.subject, now, now);

  const user = getUser(db, userId)!;
  createOrg(db, `${p.name || p.email || 'My'} workspace`.slice(0, 80), userId, 'personal');
  return { user, created: true };
}

export function getUser(db: Database, userId: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  return row ? hydrateUser(row) : null;
}

function hydrateUser(r: any): User {
  return {
    id: r.id, email: r.email, name: r.name, avatar_url: r.avatar_url,
    provider: r.provider, provider_subject: r.provider_subject, created_at: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Orgs and seats
// ---------------------------------------------------------------------------

export function createOrg(db: Database, name: string, ownerUserId: string, plan: Plan = 'personal'): Org {
  const orgId = id('org');
  const now = Date.now();
  const seats = PLANS[plan].seats;
  db.prepare('INSERT INTO orgs (id, name, plan, seat_limit, owner_user_id, created_at) VALUES (?,?,?,?,?,?)')
    .run(orgId, name, plan, seats, ownerUserId, now);
  db.prepare('INSERT INTO org_members (org_id, user_id, role, seat_active, joined_at) VALUES (?,?,?,1,?)')
    .run(orgId, ownerUserId, 'owner', now);
  return getOrg(db, orgId)!;
}

export function getOrg(db: Database, orgId: string): Org | null {
  const r = db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId) as any;
  return r ? { ...r, seat_limit: Number(r.seat_limit) } as Org : null;
}

export function orgsForUser(db: Database, userId: string): (Org & { role: OrgRole })[] {
  return (db.prepare(`
    SELECT o.*, m.role FROM orgs o
    JOIN org_members m ON m.org_id = o.id
    WHERE m.user_id = ? AND m.seat_active = 1
    ORDER BY o.created_at ASC
  `).all(userId) as any[]).map((r) => ({ ...r, seat_limit: Number(r.seat_limit) }));
}

export function membership(db: Database, orgId: string, userId: string): OrgMembership | null {
  const r = db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?')
    .get(orgId, userId) as any;
  return r ? { ...r, seat_active: !!r.seat_active } : null;
}

export function hasOrgRole(m: OrgMembership | null, min: OrgRole): boolean {
  if (!m || !m.seat_active) return false;
  return ROLE_RANK[m.role] >= ROLE_RANK[min];
}

export function seatsUsed(db: Database, orgId: string): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND seat_active = 1')
    .get(orgId) as any;
  return Number(r?.n || 0);
}

export class SeatError extends Error {}

/**
 * Add someone to an org, or reactivate their seat.
 *
 * The seat check happens here rather than at sign-in because this is the moment
 * a decision is made. Failing at sign-in instead would let an admin invite
 * eleven people to a five-seat org and only discover the problem when the sixth
 * of them tries to log in.
 */
export function addOrgMember(
  db: Database,
  orgId: string,
  userId: string,
  role: OrgRole,
  invitedBy?: string
): OrgMembership {
  const org = getOrg(db, orgId);
  if (!org) throw new SeatError('No such organisation');

  const existing = membership(db, orgId, userId);
  if (existing?.seat_active) return existing;

  if (seatsUsed(db, orgId) >= org.seat_limit) {
    const extra = PLANS[org.plan]?.extraSeatCents;
    throw new SeatError(
      `${org.name} is using all ${org.seat_limit} of its seats. ` +
      (extra
        ? `Add another seat to invite more people.`
        : `The personal plan is one seat — upgrade to an organisation to add teammates.`)
    );
  }

  const now = Date.now();
  if (existing) {
    db.prepare('UPDATE org_members SET seat_active = 1, role = ?, joined_at = ? WHERE org_id = ? AND user_id = ?')
      .run(role, now, orgId, userId);
  } else {
    db.prepare('INSERT INTO org_members (org_id, user_id, role, seat_active, invited_by, joined_at) VALUES (?,?,?,1,?,?)')
      .run(orgId, userId, role, invitedBy ?? null, now);
  }
  return membership(db, orgId, userId)!;
}

/** Release a seat without deleting history. The owner's seat cannot be released. */
export function deactivateSeat(db: Database, orgId: string, userId: string): void {
  const org = getOrg(db, orgId);
  if (org && org.owner_user_id === userId) {
    throw new SeatError('The owner keeps their seat. Transfer ownership first.');
  }
  db.prepare('UPDATE org_members SET seat_active = 0 WHERE org_id = ? AND user_id = ?').run(orgId, userId);
}

export function setSeatLimit(db: Database, orgId: string, seats: number): void {
  const org = getOrg(db, orgId);
  if (!org) throw new SeatError('No such organisation');
  const used = seatsUsed(db, orgId);
  if (seats < used) {
    throw new SeatError(`${used} seats are in use. Remove members before reducing to ${seats}.`);
  }
  db.prepare('UPDATE orgs SET seat_limit = ? WHERE id = ?').run(Math.max(1, Math.floor(seats)), orgId);
}

export function setPlan(db: Database, orgId: string, plan: Plan): void {
  const included = PLANS[plan].seats;
  const used = seatsUsed(db, orgId);
  db.prepare('UPDATE orgs SET plan = ?, seat_limit = ? WHERE id = ?')
    .run(plan, Math.max(included, used), orgId);
}

// ---------------------------------------------------------------------------
// Promo codes — comps a plan directly, no Stripe, no card
// ---------------------------------------------------------------------------

export class PromoError extends Error {}

export interface PromoCode {
  code: string;
  plan: Plan;
  seat_limit: number | null;
  max_redemptions: number | null;
  redeemed_count: number;
  expires_at: number | null;
}

const normalizeCode = (code: string) => code.trim().toUpperCase();

/**
 * Create or replace a promo code. `maxRedemptions: null` is unlimited use;
 * `expiresAt: null` never expires.
 */
export function createPromoCode(
  db: Database, code: string, plan: Plan,
  opts: { seatLimit?: number | null; maxRedemptions?: number | null; expiresAt?: number | null } = {},
): PromoCode {
  const c = normalizeCode(code);
  db.prepare(`
    INSERT INTO promo_codes (code, plan, seat_limit, max_redemptions, redeemed_count, expires_at, created_at)
    VALUES (?,?,?,?,0,?,?)
    ON CONFLICT(code) DO UPDATE SET
      plan = excluded.plan, seat_limit = excluded.seat_limit,
      max_redemptions = excluded.max_redemptions, expires_at = excluded.expires_at
  `).run(c, plan, opts.seatLimit ?? null, opts.maxRedemptions ?? null, opts.expiresAt ?? null, Date.now());
  return getPromoCode(db, c)!;
}

export function getPromoCode(db: Database, code: string): PromoCode | null {
  return db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(normalizeCode(code)) as PromoCode | null;
}

/**
 * Apply a promo code to an org: sets its plan (and seat_limit, if the code
 * overrides it) with no payment step of any kind. One redemption per
 * (code, org) pair — reapplying the same code to the same org is a no-op
 * error rather than silently double-counting against max_redemptions.
 */
export function redeemPromoCode(db: Database, code: string, orgId: string, userId: string): Org {
  const c = normalizeCode(code);
  const promo = getPromoCode(db, c);
  if (!promo) throw new PromoError('That promo code is not valid.');
  if (promo.expires_at && promo.expires_at < Date.now()) throw new PromoError('That promo code has expired.');
  if (promo.max_redemptions !== null && promo.redeemed_count >= promo.max_redemptions) {
    throw new PromoError('That promo code has already been fully redeemed.');
  }
  const already = db.prepare('SELECT 1 FROM promo_redemptions WHERE code = ? AND org_id = ?').get(c, orgId);
  if (already) throw new PromoError('This organisation has already redeemed that code.');

  const org = getOrg(db, orgId);
  if (!org) throw new PromoError('No such organisation');

  setPlan(db, orgId, promo.plan);
  if (promo.seat_limit != null) setSeatLimit(db, orgId, promo.seat_limit);
  db.prepare('INSERT INTO promo_redemptions (code, org_id, user_id, redeemed_at) VALUES (?,?,?,?)')
    .run(c, orgId, userId, Date.now());
  db.prepare('UPDATE promo_codes SET redeemed_count = redeemed_count + 1 WHERE code = ?').run(c);

  return getOrg(db, orgId)!;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface IssuedSession { token: string; expiresAt: number; }

export function createSession(db: Database, userId: string, userAgent?: string): IssuedSession {
  const token = `lbs_${randomBytes(32).toString('base64url')}`;
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent) VALUES (?,?,?,?,?,?)')
    .run(id('ses'), userId, sha256(token), now, expiresAt, (userAgent || '').slice(0, 200));
  return { token, expiresAt };
}

export function resolveSession(db: Database, token: string | null): User | null {
  if (!token || !token.startsWith('lbs_')) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(sha256(token), Date.now()) as any;
  return row ? hydrateUser(row) : null;
}

export function destroySession(db: Database, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function sweepSessions(db: Database): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(Date.now() - 10 * 60_000);
}

/** Read the session cookie out of a request. */
export function sessionCookie(req: Request): string | null {
  const raw = req.headers.get('cookie') || '';
  const m = raw.match(/(?:^|;\s*)lobby_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function sessionCookieHeader(token: string, secure: boolean, maxAgeSec = SESSION_TTL_MS / 1000): string {
  // HttpOnly so a script cannot read it; SameSite=Lax so the OAuth redirect back
  // from the provider still carries it while cross-site POSTs do not.
  return `lobby_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSec)}` +
    (secure ? '; Secure' : '');
}

export const clearSessionCookie = 'lobby_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

// ---------------------------------------------------------------------------
// OAuth state
// ---------------------------------------------------------------------------

export function createOAuthState(db: Database, provider: string, redirect?: string): string {
  const state = randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO oauth_states (state, provider, redirect, created_at) VALUES (?,?,?,?)')
    .run(state, provider, redirect ?? null, Date.now());
  return state;
}

/** Single-use: consumed on read, so a replayed callback fails. */
export function consumeOAuthState(db: Database, state: string, provider: string): { redirect?: string } | null {
  const row = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?')
    .get(state, provider) as any;
  if (!row) return null;
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  if (Date.now() - Number(row.created_at) > 10 * 60_000) return null;
  return { redirect: row.redirect || undefined };
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export function setLobbyOrg(db: Database, lobbyCode: string, orgId: string): void {
  db.prepare('UPDATE lobbies SET org_id = ? WHERE code = ?').run(orgId, lobbyCode);
}

export function orgOfLobby(db: Database, lobbyCode: string): string | null {
  const r = db.prepare('SELECT org_id FROM lobbies WHERE code = ?').get(lobbyCode) as any;
  return r?.org_id || null;
}

export function lobbiesForOrg(db: Database, orgId: string): any[] {
  return db.prepare('SELECT * FROM lobbies WHERE org_id = ? ORDER BY created_at DESC').all(orgId) as any[];
}
