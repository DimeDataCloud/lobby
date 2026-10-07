// Membership and tokens.
//
// Three decisions worth stating, because each one is a trap if reversed:
//
// 1. TOKENS ARE HASHED AT REST (argon2id). The database holds other people's
//    source code and prompts; a dump must not also hand over the keys to keep
//    reading it live.
//
// 2. TOKENS CARRY A LOOKUP PREFIX. Verifying an argon2 hash is intentionally
//    slow. Without an indexed prefix you would have to verify the candidate
//    against every member row in the table to find out whose token it is, which
//    is O(n) slow hashes per request. The prefix identifies the row; the secret
//    is then verified once.
//
// 3. VERIFIED TOKENS ARE CACHED IN MEMORY, briefly. argon2 at ~50-100ms per
//    verification on every REST call and every WebSocket upgrade would dominate
//    request latency. The cache is keyed on the raw token, expires quickly, and
//    is invalidated on revoke.
//
// The `lby_` prefix is deliberate: leaked credentials are greppable, and secret
// scanners can be taught one obvious pattern.

import type { Database } from 'bun:sqlite';

export type Role = 'owner' | 'editor' | 'viewer';

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export interface Member {
  id: number;
  lobby_id: string;
  user_id: string;
  display_name?: string;
  color?: string;
  role: Role;
  created_at: number;
  last_seen?: number;
}

/**
 * Auth is enforced when REQUIRE_AUTH is on. It defaults OFF for local
 * development so the dashboard runs without a login, and MUST be ON for any
 * deployment — an unlisted URL is not access control.
 */
export const REQUIRE_AUTH =
  (process.env.REQUIRE_AUTH || '').toLowerCase() === 'true' ||
  process.env.REQUIRE_AUTH === '1';

const TOKEN_CACHE_MS = 30_000;
const cache = new Map<string, { member: Member; expires: number }>();

// ---------------------------------------------------------------------------
// Token creation
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomString(len: number): string {
  // crypto, not Math.random: these are credentials. Math.random is predictable
  // and was how lobby join codes were generated.
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Crypto-random lobby invite code. Unambiguous alphabet, no I/O/0/1. */
export function generateJoinCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[bytes[i] % chars.length];
  return out;
}

export interface IssuedToken {
  token: string;
  member: Member;
}

/**
 * Create (or re-issue for) a member and return the plaintext token exactly
 * once. It is never recoverable afterwards — only its hash is stored.
 */
export async function issueMemberToken(
  db: Database,
  lobbyId: string,
  userId: string,
  role: Role,
  opts?: { display_name?: string; color?: string }
): Promise<IssuedToken> {
  const prefix = randomString(8);
  const secret = randomString(32);
  const token = `lby_${prefix}_${secret}`;
  const hash = await Bun.password.hash(secret, { algorithm: 'argon2id' });
  const now = Date.now();

  const existing = db
    .prepare('SELECT id FROM members WHERE lobby_id = ? AND user_id = ?')
    .get(lobbyId, userId) as any;

  if (existing) {
    db.prepare(`
      UPDATE members SET role = ?, token_hash = ?, token_prefix = ?, revoked = 0,
                         display_name = COALESCE(?, display_name),
                         color = COALESCE(?, color),
                         last_seen = ?
      WHERE id = ?
    `).run(role, hash, prefix, opts?.display_name ?? null, opts?.color ?? null, now, existing.id);
    invalidateMember(existing.id);
  } else {
    db.prepare(`
      INSERT INTO members (lobby_id, user_id, display_name, color, role, token_hash, token_prefix, created_at, last_seen, revoked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(lobbyId, userId, opts?.display_name ?? null, opts?.color ?? null, role, hash, prefix, now, now);
  }

  const member = getMemberByUser(db, lobbyId, userId)!;
  return { token, member };
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

/** Pull a bearer token from the Authorization header, or ?token= as a fallback. */
export function extractToken(req: Request, url: URL): string | null {
  const header = req.headers.get('authorization');
  if (header && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();

  // Query fallback exists only because a browser cannot set headers on a
  // WebSocket handshake. URLs land in logs, referrers and history, so this is
  // the weaker path and never the documented one for REST.
  return url.searchParams.get('token');
}

export async function resolveToken(db: Database, token: string | null): Promise<Member | null> {
  if (!token || !token.startsWith('lby_')) return null;

  const cached = cache.get(token);
  if (cached && cached.expires > Date.now()) return cached.member;

  const parts = token.split('_');
  if (parts.length !== 3) return null;
  const [, prefix, secret] = parts;

  const row = db
    .prepare('SELECT * FROM members WHERE token_prefix = ? AND revoked = 0')
    .get(prefix) as any;
  if (!row || !row.token_hash) return null;

  let ok = false;
  try {
    ok = await Bun.password.verify(secret, row.token_hash);
  } catch {
    return null;
  }
  if (!ok) return null;

  const member = hydrateMember(row);
  cache.set(token, { member, expires: Date.now() + TOKEN_CACHE_MS });
  return member;
}

export function revokeMember(db: Database, memberId: number): void {
  db.prepare('UPDATE members SET revoked = 1, token_hash = NULL WHERE id = ?').run(memberId);
  invalidateMember(memberId);
}

function invalidateMember(memberId: number): void {
  for (const [token, entry] of cache) {
    if (entry.member.id === memberId) cache.delete(token);
  }
}

/** Drop expired cache entries so a long-lived process does not grow forever. */
export function sweepTokenCache(): void {
  const now = Date.now();
  for (const [token, entry] of cache) {
    if (entry.expires <= now) cache.delete(token);
  }
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export function hasRole(member: Member | null, min: Role): boolean {
  if (!member) return false;
  return ROLE_RANK[member.role] >= ROLE_RANK[min];
}

/**
 * The single tenancy check. A member is only ever authorized against the lobby
 * their token was issued for — this is what stops a valid token for lobby X
 * reading lobby Y, which is where IDOR always lands.
 */
export function authorizes(member: Member | null, lobbyId: string, min: Role): boolean {
  if (!member) return false;
  if (member.lobby_id !== lobbyId) return false;
  return hasRole(member, min);
}

// ---------------------------------------------------------------------------

export function getMemberByUser(db: Database, lobbyId: string, userId: string): Member | null {
  const row = db
    .prepare('SELECT * FROM members WHERE lobby_id = ? AND user_id = ?')
    .get(lobbyId, userId) as any;
  return row ? hydrateMember(row) : null;
}

export function listMembers(db: Database, lobbyId: string): Member[] {
  return (db
    .prepare('SELECT * FROM members WHERE lobby_id = ? AND revoked = 0 ORDER BY created_at ASC')
    .all(lobbyId) as any[]).map(hydrateMember);
}

export function touchMember(db: Database, memberId: number): void {
  db.prepare('UPDATE members SET last_seen = ? WHERE id = ?').run(Date.now(), memberId);
}

function hydrateMember(row: any): Member {
  return {
    id: row.id,
    lobby_id: row.lobby_id,
    user_id: row.user_id,
    display_name: row.display_name || undefined,
    color: row.color || undefined,
    role: (row.role || 'editor') as Role,
    created_at: row.created_at,
    last_seen: row.last_seen || undefined,
  };
}
