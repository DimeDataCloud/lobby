// The agent-facing view of a lobby.
//
// Most of the work in a room is done by LLM agents, so this is the primary
// interface and the Vue canvas is a view of the same state. Four constraints
// drive every decision here, and each one is a bug if reversed:
//
// 1. A BOT CANNOT SEE PIXELS. Everything a human perceives on the board has to
//    be expressible as compact text: what exists, who made it, what supersedes
//    what, what is pinned on it. Geometry is deliberately NOT reported — it is
//    noise to a reader that cannot see, and it changes every time a human drags
//    a card.
//
// 2. CONTEXT IS THE SCARCE RESOURCE. Every read costs the caller's own context
//    window. So: summaries by default, `detail` opt-in, a hard character budget
//    per call, and a `since` cursor so nothing is ever paid for twice. The
//    shared `seq` counter makes exact deltas free — this is what it was for.
//
// 3. ADDRESSES MUST BE STABLE AND SHORT. Artifacts are `#a7`, assigned once and
//    never reused. Not uuids (waste tokens, unreadable) and never coordinates
//    (a human drags the card and every reference a bot holds goes stale).
//
// 4. EVERYTHING HERE IS UNTRUSTED INPUT. A card body, a chat line, a pin, even
//    a display name was authored by somebody else's agent, and it is being fed
//    to a model that has shell access on its operator's machine. Foreign text
//    is fenced and labelled on the way out — see wrapUntrusted.

import type { Database } from 'bun:sqlite';
import { nextSeq, currentSeq } from './schema';
import { upsertObject, getObject, type CanvasObject } from './canvas';

// ---------------------------------------------------------------------------
// Untrusted content
// ---------------------------------------------------------------------------

/**
 * Fence text that some other party wrote before it reaches a model.
 *
 * Escaped, not stripped. Silently removing the delimiter teaches an attacker
 * exactly what the filter looks for and invites them to nest it; replacing it
 * with a visible marker leaves the payload inert AND legible, so a human
 * reviewing the transcript can see an attempt was made.
 *
 * This is not a guarantee. It is a clear boundary that makes the model's job
 * possible — nothing downstream should treat fenced content as instructions.
 */
export function wrapUntrusted(text: string, author: string, kind = 'content'): string {
  const safe = String(text ?? '')
    .replace(/<\/?untrusted[^>]*>/gi, (m) => `[escaped:${m.replace(/[<>]/g, '')}]`);
  const who = String(author || 'unknown').replace(/[<>\n\r]/g, '').slice(0, 64);
  return `<untrusted from="${who}" kind="${kind}">\n${safe}\n</untrusted>`;
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

/**
 * Next short handle for a lobby: a1, a2, ... az, a10 (base36, no padding).
 *
 * Counter is per lobby and monotonic, so a handle is never reused even after
 * its artifact is tombstoned — a bot holding a stale reference gets "gone",
 * never somebody else's artifact.
 */
export function nextHandle(db: Database, lobbyId: string): string {
  const name = `handle:${lobbyId}`;
  const row = db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, 1)
    ON CONFLICT(name) DO UPDATE SET value = value + 1
    RETURNING value
  `).get(name) as any;
  return 'a' + Number(row.value).toString(36);
}

export function resolveHandle(db: Database, lobbyId: string, handle: string): CanvasObject | null {
  const h = String(handle || '').replace(/^#/, '').trim();
  if (!h) return null;
  const row = db
    .prepare('SELECT id FROM canvas_objects WHERE lobby_id = ? AND handle = ?')
    .get(lobbyId, h) as any;
  return row ? getObject(db, lobbyId, row.id) : null;
}

// ---------------------------------------------------------------------------
// Posting an artifact
// ---------------------------------------------------------------------------

/** The artifact kinds the board renders. Open-ended: unknown kinds still land. */
export type ArtifactKind = 'diff' | 'doc' | 'image' | 'data' | 'link' | 'note';

export interface PostInput {
  kind: ArtifactKind | string;
  title: string;
  body?: string;
  /** Revision of an existing artifact, by handle. The new one supersedes it. */
  supersedes?: string;
  /** Retry-safety. Same key twice returns the first result, never a duplicate. */
  idem_key?: string;
  x?: number;
  y?: number;
}

export interface PostResult {
  handle: string;
  id: string;
  seq: number;
  /** true when this call matched a previous one and nothing new was written */
  deduped: boolean;
  supersedes?: string;
}

const MAX_BODY = 24_000;

/**
 * Put an artifact on the board on behalf of `actor`.
 *
 * `actor` comes from the caller's verified token and is never taken from the
 * request payload — a bot that can name its own author can impersonate every
 * other member of the room.
 */
export function postArtifact(
  db: Database,
  lobbyId: string,
  input: PostInput,
  actor: string
): PostResult {
  const title = String(input.title || '').slice(0, 300).trim();
  if (!title) throw new AgentError('title is required');

  if (input.idem_key) {
    const prior = db.prepare(
      'SELECT id, handle, seq FROM canvas_objects WHERE lobby_id = ? AND idem_key = ?'
    ).get(lobbyId, String(input.idem_key)) as any;
    if (prior) {
      return { handle: prior.handle, id: prior.id, seq: prior.seq, deduped: true };
    }
  }

  let parentId: string | undefined;
  let supersedesHandle: string | undefined;
  if (input.supersedes) {
    const target = resolveHandle(db, lobbyId, input.supersedes);
    if (!target) throw new AgentError(`no artifact ${input.supersedes} in this room`);
    parentId = target.id;
    supersedesHandle = String(input.supersedes).replace(/^#/, '');
  }

  const handle = nextHandle(db, lobbyId);
  const id = `ag_${handle}_${Math.random().toString(36).slice(2, 8)}`;
  const body = String(input.body ?? '').slice(0, MAX_BODY);

  const res = upsertObject(db, lobbyId, {
    id,
    type: 'artifact',
    parent_id: parentId,
    x: Number.isFinite(input.x as number) ? Number(input.x) : 0,
    y: Number.isFinite(input.y as number) ? Number(input.y) : 0,
    w: 380,
    h: 280,
    props: {
      agent_kind: String(input.kind || 'note'),
      title,
      body,
      author_kind: 'agent',
      supersedes: supersedesHandle,
    },
  }, actor);

  db.prepare('UPDATE canvas_objects SET handle = ?, idem_key = ? WHERE lobby_id = ? AND id = ?')
    .run(handle, input.idem_key ? String(input.idem_key) : null, lobbyId, id);

  // Supersession is a property of the OLD artifact too, so the board can grey it
  // out without walking every object looking for children.
  if (parentId) {
    const old = getObject(db, lobbyId, parentId);
    if (old) {
      upsertObject(db, lobbyId, {
        id: parentId,
        props: { ...(old.props || {}), superseded_by: handle },
      }, actor);
    }
  }

  return { handle, id, seq: res.object.seq, deduped: false, supersedes: supersedesHandle };
}

export class AgentError extends Error {}

// ---------------------------------------------------------------------------
// Reading the room
// ---------------------------------------------------------------------------

export interface ReadOpts {
  since?: number;
  detail?: boolean;
  limit?: number;
  /** Hard ceiling on returned characters. ~4 chars per token. */
  budget?: number;
}

const DEFAULT_BUDGET = 12_000;   // ≈3k tokens
const MAX_BUDGET = 40_000;       // ≈10k tokens

export interface RoomBrief {
  text: string;
  cursor: number;
  truncated: boolean;
}

/**
 * The whole room as one bounded block of text: what it is, who is here, what is
 * on the board, and what is addressed to you.
 *
 * Returned as prose rather than JSON on purpose. A model reads this far more
 * reliably than nested objects, and it costs roughly half the tokens of the
 * equivalent JSON once braces, quotes and key repetition are counted.
 */
export function roomBrief(
  db: Database,
  lobbyId: string,
  viewer: string,
  opts: ReadOpts = {}
): RoomBrief {
  const budget = Math.min(Math.max(Number(opts.budget) || DEFAULT_BUDGET, 1000), MAX_BUDGET);
  const since = Number(opts.since) || 0;
  const cursor = currentSeq(db);
  const out: string[] = [];
  let truncated = false;

  const room = db.prepare('SELECT code, name FROM lobbies WHERE code = ? OR id = ?')
    .get(lobbyId, lobbyId) as any;

  const members = db.prepare(
    'SELECT user_id, role FROM members WHERE lobby_id = ? AND revoked = 0 ORDER BY created_at'
  ).all(lobbyId) as any[];

  out.push(
    `room: ${room?.name || lobbyId}${room?.code ? ` (#${room.code})` : ''} · ` +
    `${members.length} member${members.length === 1 ? '' : 's'} · seq ${cursor}`
  );
  out.push(`you: ${viewer}`);
  if (since) out.push(`(changes since seq ${since})`);
  out.push('');

  // --- artifacts -----------------------------------------------------------
  const rows = db.prepare(`
    SELECT id, handle, props, created_by, updated_at, seq, deleted
    FROM canvas_objects
    WHERE lobby_id = ? AND type = 'artifact' AND seq > ? AND handle IS NOT NULL
    ORDER BY seq DESC LIMIT ?
  `).all(lobbyId, since, clamp(opts.limit, 40)) as any[];

  const pinCounts = pinCountsByTarget(db, lobbyId);

  if (rows.length) {
    out.push(`board — ${rows.length} artifact${rows.length === 1 ? '' : 's'}`);
    for (const r of rows) {
      const p = safeParse(r.props) || {};
      if (p.superseded_by) continue;   // only current versions in the summary
      const mine = r.created_by === viewer ? '  ← yours' : '';
      const pins = pinCounts.get(r.id);
      const flags = [
        r.deleted ? 'removed' : '',
        p.supersedes ? `revises #${p.supersedes}` : '',
        pins ? `${pins} pin${pins === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' · ');

      out.push(
        `#${r.handle}  ${String(p.agent_kind || 'note').padEnd(6)}  ` +
        `${truncate(p.title || '(untitled)', 52)}  ` +
        `by ${r.created_by || 'unknown'} ${ago(r.updated_at)}` +
        (flags ? `  [${flags}]` : '') + mine
      );

      if (opts.detail && p.body) {
        out.push(indent(wrapUntrusted(truncate(p.body, 2000), r.created_by || 'unknown', p.agent_kind || 'artifact')));
      }
      if (joined(out).length > budget) { truncated = true; break; }
    }
    out.push('');
  } else if (!since) {
    out.push('board — empty');
    out.push('');
  }

  // --- pins addressed to the viewer ----------------------------------------
  if (!truncated) {
    const pins = db.prepare(`
      SELECT a.id, a.text, a.user_id, a.timestamp, a.target_id, c.handle
      FROM annotations a
      LEFT JOIN canvas_objects c ON c.id = a.target_id AND c.lobby_id = a.lobby_id
      WHERE a.lobby_id = ? AND a.resolved = 0 AND a.deleted = 0 AND a.seq > ?
      ORDER BY a.seq DESC LIMIT 20
    `).all(lobbyId, since) as any[];

    const forMe = pins.filter(
      (p) => mentions(p.text, viewer) || ownsTarget(db, lobbyId, p.target_id, viewer)
    );
    if (forMe.length) {
      out.push(`pins for you (${forMe.length})`);
      for (const p of forMe) {
        out.push(
          `${p.handle ? '#' + p.handle : '(board)'}  ${wrapUntrusted(truncate(p.text, 400), p.user_id, 'pin')}  — ${ago(p.timestamp)}`
        );
      }
      out.push('');
    }
  }

  // --- who else is working -------------------------------------------------
  if (!truncated) {
    const busy = db.prepare(`
      SELECT agent_id, path, MAX(ts) AS ts FROM file_activity
      WHERE lobby_id = ? AND ts > ?
      GROUP BY agent_id, path ORDER BY ts DESC LIMIT 10
    `).all(lobbyId, Date.now() - 10 * 60_000) as any[];
    const others = busy.filter((b) => b.agent_id !== viewer);
    if (others.length) {
      out.push('others working (avoid collisions)');
      for (const b of others) out.push(`${b.agent_id}  ${truncate(b.path, 70)}  ${ago(b.ts)}`);
      out.push('');
    }
  }

  let text = joined(out);
  if (text.length > budget) {
    text = text.slice(0, budget) + '\n… truncated. Narrow with `since` or raise `budget`.';
    truncated = true;
  }
  return { text, cursor, truncated };
}

/** One artifact in full, for when the summary was not enough. */
export function artifactDetail(
  db: Database,
  lobbyId: string,
  handle: string,
  viewer: string
): string {
  const obj = resolveHandle(db, lobbyId, handle);
  if (!obj) throw new AgentError(`no artifact ${handle} in this room`);
  const p = obj.props || {};
  const lines = [
    `#${handle.replace(/^#/, '')}  ${p.agent_kind || 'note'}  by ${obj.created_by || 'unknown'}  ${ago(obj.updated_at)}`,
    `title: ${truncate(String(p.title || ''), 300)}`,
  ];
  if (p.supersedes) lines.push(`revises: #${p.supersedes}`);
  if (p.superseded_by) lines.push(`superseded by: #${p.superseded_by}  (this is NOT the current version)`);
  if (obj.deleted) lines.push('status: removed from the board');

  const threads = db.prepare(`
    SELECT text, user_id, timestamp, resolved FROM annotations
    WHERE lobby_id = ? AND target_id = ? AND deleted = 0 ORDER BY seq ASC LIMIT 30
  `).all(lobbyId, obj.id) as any[];
  if (threads.length) {
    lines.push('', `pins (${threads.length})`);
    for (const t of threads) {
      lines.push(`${t.resolved ? '[resolved] ' : ''}${wrapUntrusted(truncate(t.text, 500), t.user_id, 'pin')}`);
    }
  }

  if (p.body) {
    lines.push('', wrapUntrusted(truncate(String(p.body), 12_000), obj.created_by || 'unknown', String(p.agent_kind || 'artifact')));
  }
  void viewer;
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pinCountsByTarget(db: Database, lobbyId: string): Map<string, number> {
  const rows = db.prepare(`
    SELECT target_id, COUNT(*) AS n FROM annotations
    WHERE lobby_id = ? AND resolved = 0 AND deleted = 0 AND target_type = 'object'
    GROUP BY target_id
  `).all(lobbyId) as any[];
  return new Map(rows.map((r) => [r.target_id, Number(r.n)]));
}

function ownsTarget(db: Database, lobbyId: string, targetId: string | null, viewer: string): boolean {
  if (!targetId) return false;
  const row = db.prepare('SELECT created_by FROM canvas_objects WHERE lobby_id = ? AND id = ?')
    .get(lobbyId, targetId) as any;
  return !!row && row.created_by === viewer;
}

/** Loose @mention match — bots are addressed by their member name. */
function mentions(text: string, viewer: string): boolean {
  if (!text || !viewer) return false;
  return new RegExp(`@${escapeRe(viewer)}\\b`, 'i').test(text);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function safeParse(s: any): any {
  if (!s) return null;
  try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; }
}

function truncate(s: any, max: number): string {
  const t = String(s ?? '');
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

function indent(s: string): string {
  return s.split('\n').map((l) => '    ' + l).join('\n');
}

function joined(lines: string[]): string {
  return lines.join('\n');
}

function clamp(v: any, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), 200);
}

function ago(ts: number): string {
  const d = Date.now() - Number(ts || 0);
  if (d < 60_000) return `${Math.max(1, Math.round(d / 1000))}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

export const __test = { ago, truncate, mentions };
void nextSeq;
