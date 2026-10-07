// Annotations — a comment attached to something on the board.
//
// The original table could only comment on an event. A board where you can
// discuss the timeline but not the artifact you are both looking at gets the
// conversation wrong: people point at things. So a target is now one of
//
//   event   — the timeline row (what the old table did)
//   object  — a canvas object: an artifact card, a note, a frame
//   point   — a bare board coordinate, for "what goes here?"
//
// `object` and `point` pins carry anchor_x/anchor_y in BOARD space, not screen
// space. Storing screen coordinates would pin the comment to whatever the author
// happened to be zoomed to, and it would land somewhere else for everyone else.
//
// Legacy note: the base table declares `event_id INTEGER NOT NULL`, and SQLite
// cannot relax that without rebuilding the table. Non-event pins therefore store
// 0 there and it is never surfaced — `target_type`/`target_id` are the real
// identity. Rebuilding a table that live rows already point at is not worth it
// for one unused column.

import type { Database } from 'bun:sqlite';
import { nextSeq } from './schema';

export type AnnotationTarget = 'event' | 'object' | 'point';

export interface Annotation {
  id: number;
  lobby_id: string;
  user_id: string;
  text: string;
  target_type: AnnotationTarget;
  target_id?: string;
  anchor_x?: number;
  anchor_y?: number;
  thread_parent?: number;
  resolved: boolean;
  deleted: boolean;
  timestamp: number;
  seq: number;
}

export const MAX_TEXT = 2000;

const SELECT_COLS = `
  id, lobby_id, user_id, text, target_type, target_id, anchor_x, anchor_y,
  thread_parent, resolved, deleted, timestamp, seq
`;

export class AnnotationError extends Error {}

function hydrate(row: any): Annotation {
  return {
    id: row.id,
    lobby_id: row.lobby_id,
    user_id: row.user_id,
    text: row.deleted ? '' : row.text,
    target_type: row.target_type,
    target_id: row.target_id ?? undefined,
    anchor_x: row.anchor_x ?? undefined,
    anchor_y: row.anchor_y ?? undefined,
    thread_parent: row.thread_parent ?? undefined,
    resolved: !!row.resolved,
    deleted: !!row.deleted,
    timestamp: row.timestamp,
    seq: row.seq,
  };
}

export interface CreateInput {
  text: string;
  target_type?: AnnotationTarget;
  target_id?: string | number;
  anchor_x?: number;
  anchor_y?: number;
  thread_parent?: number;
}

export function createAnnotation(
  db: Database,
  lobbyId: string,
  input: CreateInput,
  author: string
): Annotation {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new AnnotationError('text is required');
  if (text.length > MAX_TEXT) throw new AnnotationError(`text exceeds ${MAX_TEXT} characters`);

  const targetType: AnnotationTarget =
    input.target_type === 'object' || input.target_type === 'point' ? input.target_type : 'event';

  const targetId = input.target_id === undefined || input.target_id === null
    ? undefined
    : String(input.target_id);

  if (targetType !== 'point' && !targetId) {
    throw new AnnotationError(`target_id is required for target_type=${targetType}`);
  }
  if (targetType === 'event' && !/^\d+$/.test(targetId!)) {
    throw new AnnotationError('event target_id must be an event id');
  }

  // A pin with no coordinates cannot be drawn. Object pins may omit them and
  // hang off the object's own box; point pins have nothing else to fall back on.
  const ax = numOrUndef(input.anchor_x);
  const ay = numOrUndef(input.anchor_y);
  if (targetType === 'point' && (ax === undefined || ay === undefined)) {
    throw new AnnotationError('point annotations need anchor_x and anchor_y');
  }

  // Threading is scoped to the lobby for the same reason replies are in chat:
  // otherwise a member learns which ids exist in rooms they cannot read.
  let parent: number | undefined;
  if (input.thread_parent !== undefined && input.thread_parent !== null) {
    const n = Number(input.thread_parent);
    if (!Number.isInteger(n)) throw new AnnotationError('thread_parent must be an annotation id');
    const row = db.prepare('SELECT id FROM annotations WHERE id = ? AND lobby_id = ?').get(n, lobbyId);
    if (!row) throw new AnnotationError('thread_parent does not exist in this lobby');
    parent = n;
  }

  const run = db.transaction(() => {
    const seq = nextSeq(db);
    const ts = Date.now();
    const legacyEventId = targetType === 'event' ? Number(targetId) : 0;
    const res = db.prepare(`
      INSERT INTO annotations
        (event_id, user_id, text, timestamp, lobby_id, target_type, target_id,
         anchor_x, anchor_y, thread_parent, resolved, deleted, seq)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?)
    `).run(
      legacyEventId, author, text, ts, lobbyId, targetType, targetId ?? null,
      ax ?? null, ay ?? null, parent ?? null, seq
    );
    return {
      id: Number(res.lastInsertRowid),
      lobby_id: lobbyId,
      user_id: author,
      text,
      target_type: targetType,
      target_id: targetId,
      anchor_x: ax,
      anchor_y: ay,
      thread_parent: parent,
      resolved: false,
      deleted: false,
      timestamp: ts,
      seq,
    } as Annotation;
  });

  return run();
}

/**
 * Board pins, oldest-first. Resolved threads stay out by default — a board that
 * accumulates every settled comment forever becomes unreadable — but they are
 * one query parameter away, never deleted.
 */
export function listAnnotations(
  db: Database,
  lobbyId: string,
  opts?: { targetType?: AnnotationTarget; targetId?: string; includeResolved?: boolean; limit?: number }
): Annotation[] {
  const params: any[] = [lobbyId];
  let sql = `SELECT ${SELECT_COLS} FROM annotations WHERE lobby_id = ? AND deleted = 0`;
  if (opts?.targetType) { sql += ' AND target_type = ?'; params.push(opts.targetType); }
  if (opts?.targetId)   { sql += ' AND target_id = ?';   params.push(opts.targetId); }
  if (!opts?.includeResolved) sql += ' AND resolved = 0';
  sql += ' ORDER BY seq ASC LIMIT ?';
  params.push(clamp(opts?.limit, 500, 2000));
  return (db.prepare(sql).all(...params) as any[]).map(hydrate);
}

/** Delta for reconnect. Includes resolved and deleted rows — that IS the change. */
export function getAnnotationsSince(
  db: Database,
  lobbyId: string,
  since: number,
  limit = 500
): Annotation[] {
  return (db.prepare(`
    SELECT ${SELECT_COLS} FROM annotations
    WHERE lobby_id = ? AND seq > ?
    ORDER BY seq ASC LIMIT ?
  `).all(lobbyId, since, clamp(limit, 500, 2000)) as any[]).map(hydrate);
}

export function getAnnotation(db: Database, lobbyId: string, id: number): Annotation | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM annotations WHERE id = ? AND lobby_id = ?`)
    .get(id, lobbyId) as any;
  return row ? hydrate(row) : null;
}

/** Which lobby an annotation belongs to — used to authorize the legacy routes. */
export function lobbyOfAnnotation(db: Database, id: number): string | null {
  const row = db.prepare('SELECT lobby_id FROM annotations WHERE id = ?').get(id) as any;
  return row?.lobby_id ?? null;
}

/** Every lobby that has a comment on this event, so the legacy per-event read can be scoped. */
export function lobbiesForEvent(db: Database, eventId: number): string[] {
  return (db.prepare(
    'SELECT DISTINCT lobby_id FROM annotations WHERE event_id = ? AND lobby_id IS NOT NULL'
  ).all(eventId) as any[]).map(r => r.lobby_id);
}

/** Resolve or reopen. Takes a new seq so caught-up clients hear about it. */
export function setResolved(
  db: Database,
  lobbyId: string,
  id: number,
  resolved: boolean
): Annotation | null {
  const existing = db.prepare('SELECT id FROM annotations WHERE id = ? AND lobby_id = ?').get(id, lobbyId);
  if (!existing) return null;
  const run = db.transaction(() => {
    const seq = nextSeq(db);
    db.prepare('UPDATE annotations SET resolved = ?, seq = ? WHERE id = ? AND lobby_id = ?')
      .run(resolved ? 1 : 0, seq, id, lobbyId);
    return getAnnotation(db, lobbyId, id);
  });
  return run();
}

/** Tombstone, same reasoning as chat: the row and its thread structure survive. */
export function deleteAnnotation(db: Database, lobbyId: string, id: number): Annotation | null {
  const existing = db
    .prepare('SELECT id, deleted FROM annotations WHERE id = ? AND lobby_id = ?')
    .get(id, lobbyId) as any;
  if (!existing) return null;
  if (existing.deleted) return getAnnotation(db, lobbyId, id);
  const run = db.transaction(() => {
    const seq = nextSeq(db);
    db.prepare("UPDATE annotations SET deleted = 1, text = '', seq = ? WHERE id = ? AND lobby_id = ?")
      .run(seq, id, lobbyId);
    return getAnnotation(db, lobbyId, id);
  });
  return run();
}

function numOrUndef(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function clamp(v: any, fallback: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return Math.min(fallback, max);
  return Math.min(Math.floor(n), max);
}
