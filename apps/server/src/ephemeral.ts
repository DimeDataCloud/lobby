// Ephemeral presence — cursors, viewports, selections, typing.
//
// This is the other half of the durable/ephemeral split, and it deliberately
// touches no database at all.
//
// Cursor movement runs at 20-30Hz per user. The previous design wrote cursor
// x/y into the `presence` TABLE on every update, which is a SQLite write storm
// at cursor frequency and the reason a canvas would feel fine with one user and
// melt with three.
//
// The trade is explicit and correct: this state is lossy and disposable. If a
// frame is dropped the next one supersedes it 40ms later; if the process
// restarts, clients re-announce on reconnect. Nothing here is worth persisting,
// so nothing here is persisted.

export interface Ephemeral {
  user_id: string;
  display_name?: string;
  color?: string;
  cursor?: { x: number; y: number };
  viewport?: { x: number; y: number; zoom: number };
  selection?: string[];
  typing?: boolean;
  ts: number;
}

/** lobby code -> user_id -> state */
const rooms = new Map<string, Map<string, Ephemeral>>();

/** A user is dropped from the roster after this long without a frame. */
export const EPHEMERAL_TTL_MS = 45_000;

/** Selections are capped so one client cannot broadcast a huge array. */
const MAX_SELECTION = 200;

function room(lobby: string): Map<string, Ephemeral> {
  let r = rooms.get(lobby);
  if (!r) { r = new Map(); rooms.set(lobby, r); }
  return r;
}

/**
 * Merge a partial frame into a user's ephemeral state and return the merged
 * value for broadcast. Partial so a client can send only what changed — a
 * cursor move need not restate the viewport.
 */
export function setEphemeral(
  lobby: string,
  userId: string,
  patch: Partial<Ephemeral>
): Ephemeral {
  const r = room(lobby);
  const prev = r.get(userId);
  const next: Ephemeral = {
    user_id: userId,
    display_name: pick(patch.display_name, prev?.display_name),
    color: pick(patch.color, prev?.color),
    cursor: sanitizePoint(patch.cursor) ?? prev?.cursor,
    viewport: sanitizeViewport(patch.viewport) ?? prev?.viewport,
    selection: patch.selection
      ? patch.selection.filter(s => typeof s === 'string').slice(0, MAX_SELECTION)
      : prev?.selection,
    typing: patch.typing !== undefined ? !!patch.typing : prev?.typing,
    ts: Date.now(),
  };
  r.set(userId, next);
  return next;
}

/** Everyone currently present, minus anyone who has gone quiet past the TTL. */
export function getEphemeral(lobby: string): Ephemeral[] {
  const r = rooms.get(lobby);
  if (!r) return [];
  const cutoff = Date.now() - EPHEMERAL_TTL_MS;
  const live: Ephemeral[] = [];
  for (const [userId, state] of r) {
    if (state.ts < cutoff) r.delete(userId);
    else live.push(state);
  }
  if (r.size === 0) rooms.delete(lobby);
  return live;
}

export function dropEphemeral(lobby: string, userId: string): void {
  const r = rooms.get(lobby);
  if (!r) return;
  r.delete(userId);
  if (r.size === 0) rooms.delete(lobby);
}

/** Sweep every room. Returns the users that expired, so they can be announced. */
export function sweepEphemeral(): Array<{ lobby: string; user_id: string }> {
  const cutoff = Date.now() - EPHEMERAL_TTL_MS;
  const gone: Array<{ lobby: string; user_id: string }> = [];
  for (const [lobby, r] of rooms) {
    for (const [userId, state] of r) {
      if (state.ts < cutoff) { r.delete(userId); gone.push({ lobby, user_id: userId }); }
    }
    if (r.size === 0) rooms.delete(lobby);
  }
  return gone;
}

export function roomCount(): number { return rooms.size; }

// ---------------------------------------------------------------------------
// Rate limiting
//
// A token bucket per connection. Ephemeral frames are cheap but unbounded by
// nature, and one buggy or hostile client should not be able to saturate the
// fan-out loop for everyone else in the room.
// ---------------------------------------------------------------------------

/**
 * Leading + trailing throttle.
 *
 * Cursors must never be hard-dropped by a rate limiter, because the frame you
 * drop is the newest one — the cursor then sits frozen mid-path until the user
 * happens to move again. The right behaviour is to discard the *intermediate*
 * frames and always deliver the latest, which is what a trailing edge gives you.
 *
 * Ingest rate is decoupled from fan-out rate: state updates on every frame
 * (in-memory, free), broadcast happens at most once per interval, and the final
 * position is always sent.
 */
export class Coalescer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;

  constructor(private intervalMs: number, private flush: () => void) {}

  schedule(): void {
    if (this.timer) { this.pending = true; return; }   // trailing flush will pick it up
    this.flush();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending) { this.pending = false; this.schedule(); }
    }, this.intervalMs);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
  }
}

export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(private capacity: number, private refillPerSec: number) {
    this.tokens = capacity;
    this.last = Date.now();
  }

  /** True if the caller may proceed. */
  take(cost = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.last) / 1000) * this.refillPerSec
    );
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

// ---------------------------------------------------------------------------

function pick<T>(a: T | undefined, b: T | undefined): T | undefined {
  return a !== undefined ? a : b;
}

function finite(n: any): boolean {
  return typeof n === 'number' && Number.isFinite(n);
}

/** NaN/Infinity from a client would poison every other client's renderer. */
function sanitizePoint(p: any): { x: number; y: number } | undefined {
  if (!p || !finite(p.x) || !finite(p.y)) return undefined;
  return { x: p.x, y: p.y };
}

function sanitizeViewport(v: any): { x: number; y: number; zoom: number } | undefined {
  if (!v || !finite(v.x) || !finite(v.y) || !finite(v.zoom)) return undefined;
  // Clamped to the same range the canvas UI allows, so a bad value cannot make
  // a follower's viewport jump somewhere unrecoverable.
  const zoom = Math.min(8, Math.max(0.05, v.zoom));
  return { x: v.x, y: v.y, zoom };
}
