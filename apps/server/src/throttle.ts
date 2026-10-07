// HTTP rate limiting.
//
// The WebSocket has had per-connection limits since the start; HTTP had none at
// all, which in a multi-tenant service means any single caller can exhaust the
// box for everyone else and run up the bill doing it.
//
// Built on the same token bucket the socket uses (ephemeral.ts) rather than a
// second implementation, so there is one definition of "too fast" in the system.
//
// Three things here are deliberate:
//
// 1. IDENTITY FIRST, IP SECOND. Limiting purely by IP punishes everyone behind
//    one office NAT and does nothing about a distributed abuser holding a valid
//    token. When we know who is calling, the bucket is theirs. IP is the
//    fallback for callers who have not identified themselves — which is exactly
//    the population that needs limiting most.
//
// 2. AUTH ROUTES GET THEIR OWN, TIGHTER BUCKET. Sign-in endpoints are where
//    people grind — and they are the cheapest place for us to say no.
//
// 3. A 429 CARRIES Retry-After. A limit that does not tell a well-behaved client
//    when to come back teaches it to hammer, which is the opposite of the point.

import { RateLimiter } from './ephemeral';

export type Bucket = 'read' | 'write' | 'auth' | 'ingest';

/**
 * capacity = burst allowance, refill = sustained rate per second.
 *
 * Generous enough that no honest user meets them: `write` at 40 burst / 4 per
 * second is far above human interaction speed and above what a working agent
 * produces, while still capping a runaway loop.
 */
const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/**
 * Overridable per deployment because the right ceiling depends on how many people
 * sit behind one address. A CI run or an office NAT is not an abuser, and a limit
 * that cannot be raised gets removed instead — which is worse.
 */
const LIMITS: Record<Bucket, { capacity: number; refill: number }> = {
  read:   { capacity: num('RATE_READ_BURST', 120),  refill: num('RATE_READ_RPS', 20) },
  write:  { capacity: num('RATE_WRITE_BURST', 40),  refill: num('RATE_WRITE_RPS', 4) },
  // hook relays are chatty by design
  ingest: { capacity: num('RATE_INGEST_BURST', 200), refill: num('RATE_INGEST_RPS', 40) },
  // 10 burst, then one per 5s. Tightest bucket: sign-in is where people grind,
  // and it is the cheapest place for us to say no.
  auth:   { capacity: num('RATE_AUTH_BURST', 10),   refill: num('RATE_AUTH_RPS', 0.2) },
};

interface Entry { limiter: RateLimiter; seen: number }

const buckets = new Map<string, Entry>();
const MAX_KEYS = 50_000;

/**
 * Client identity for limiting.
 *
 * The proxy header is only trusted when TRUST_PROXY is set, because
 * X-Forwarded-For is caller-supplied: taking it unconditionally lets anyone mint
 * a fresh identity per request and bypass limiting entirely.
 */
export function clientKey(req: Request, identity?: string | null): string {
  if (identity) return `id:${identity}`;
  if (process.env.TRUST_PROXY) {
    const fwd = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    if (fwd) return `ip:${fwd}`;
  }
  return 'ip:unknown';
}

export interface Verdict {
  ok: boolean;
  retryAfter?: number;
}

export function check(key: string, bucket: Bucket, cost = 1): Verdict {
  const id = `${bucket}:${key}`;
  let entry = buckets.get(id);
  if (!entry) {
    const { capacity, refill } = LIMITS[bucket];
    entry = { limiter: new RateLimiter(capacity, refill), seen: Date.now() };
    buckets.set(id, entry);
    // An unbounded map keyed on caller-controlled values is a memory-exhaustion
    // bug wearing a rate limiter's clothes.
    if (buckets.size > MAX_KEYS) sweepThrottle(true);
  }
  entry.seen = Date.now();

  if (entry.limiter.take(cost)) return { ok: true };
  const { refill } = LIMITS[bucket];
  return { ok: false, retryAfter: Math.max(1, Math.ceil(cost / refill)) };
}

/** Drop buckets nobody has touched recently. */
export function sweepThrottle(aggressive = false): void {
  const cutoff = Date.now() - (aggressive ? 60_000 : 10 * 60_000);
  for (const [k, v] of buckets) if (v.seen < cutoff) buckets.delete(k);
}

export function throttleSize(): number {
  return buckets.size;
}

/** For tests. */
export function resetThrottle(): void {
  buckets.clear();
}

export function tooMany(retryAfter: number, headers: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ error: 'Too many requests. Slow down.', retry_after: retryAfter }),
    {
      status: 429,
      headers: { ...headers, 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
    }
  );
}

/** Which bucket a request belongs in, from its method and path. */
export function bucketFor(method: string, pathname: string): Bucket {
  if (pathname.startsWith('/auth/') || pathname === '/orgs') return 'auth';
  if (pathname === '/events' || pathname === '/events/batch') return 'ingest';
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
}
