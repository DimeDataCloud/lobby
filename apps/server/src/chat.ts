// Room chat — the humans-and-agents channel that sits beside the board.
//
// Two things make this different from the canvas:
//
// 1. Messages are append-only. There is no LWW merge because there is no
//    concurrent edit — you write a line, it exists. Editing history in a shared
//    room is a trust problem, not a feature, so a delete is a tombstone that
//    keeps the row and its seq. Everyone converges on the same transcript.
//
// 2. They ride the same `seq` counter as canvas objects and events. One counter
//    across all three means a client that reconnects can ask a single question —
//    "what happened after N?" — and get board changes and conversation back in
//    the true interleaved order they occurred in, not two streams it has to
//    guess how to merge.

import type { Database } from 'bun:sqlite';
import { nextSeq } from './schema';

export type AuthorKind = 'human' | 'agent' | 'system';

export interface ChatMessage {
  id: number;
  lobby_id: string;
  author_user: string;
  author_kind: AuthorKind;
  body: string;
  reply_to?: number;
  /** user_ids named with @ — resolved client-side, stored so a notifier can read them */
  mentions?: string[];
  /** a canvas object this line is about, so "this one" has a referent */
  ref_object_id?: string;
  ts: number;
  deleted: boolean;
  seq: number;
}

/** Long enough for a paragraph of context, short enough that no one pastes a log file. */
export const MAX_BODY = 4000;
const MAX_MENTIONS = 32;

const SELECT_COLS = `
  id, lobby_id, author_user, author_kind, body, reply_to, mentions,
  ref_object_id, ts, deleted, seq
`;

function hydrate(row: any): ChatMessage {
  return {
    id: row.id,
    lobby_id: row.lobby_id,
    author_user: row.author_user,
    author_kind: row.author_kind,
    // A tombstone must not still carry its text — the client is not the thing
    // enforcing the delete.
    body: row.deleted ? '' : row.body,
    reply_to: row.reply_to ?? undefined,
    mentions: row.mentions ? safeParse(row.mentions) : undefined,
    ref_object_id: row.ref_object_id || undefined,
    ts: row.ts,
    deleted: !!row.deleted,
    seq: row.seq,
  };
}

function safeParse(s: string): any {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : undefined;
  } catch { return undefined; }
}

export interface PostInput {
  body: string;
  reply_to?: number;
  mentions?: string[];
  ref_object_id?: string;
  author_kind?: AuthorKind;
}

export class ChatError extends Error {}

/**
 * Append one message. `author` comes from the caller's token, never from the
 * body — the same rule the canvas uses, for the same reason: otherwise anyone
 * in the room can put words in anyone else's mouth.
 */
export function postMessage(
  db: Database,
  lobbyId: string,
  input: PostInput,
  author: string
): ChatMessage {
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) throw new ChatError('Message body is required');
  if (body.length > MAX_BODY) throw new ChatError(`Message exceeds ${MAX_BODY} characters`);

  const mentions = Array.isArray(input.mentions)
    ? input.mentions.filter(m => typeof m === 'string' && m).slice(0, MAX_MENTIONS)
    : undefined;

  // A reply must point at a message in THIS lobby. Without the lobby_id check a
  // member could thread onto a message in a room they cannot read and learn that
  // its id exists.
  let replyTo: number | undefined;
  if (input.reply_to !== undefined && input.reply_to !== null) {
    const n = Number(input.reply_to);
    if (!Number.isInteger(n)) throw new ChatError('reply_to must be a message id');
    const parent = db
      .prepare('SELECT id FROM messages WHERE id = ? AND lobby_id = ?')
      .get(n, lobbyId) as any;
    if (!parent) throw new ChatError('reply_to does not exist in this lobby');
    replyTo = n;
  }

  const kind: AuthorKind =
    input.author_kind === 'agent' || input.author_kind === 'system' ? input.author_kind : 'human';

  const run = db.transaction(() => {
    const seq = nextSeq(db);
    const ts = Date.now();
    const res = db.prepare(`
      INSERT INTO messages
        (lobby_id, author_user, author_kind, body, reply_to, mentions, ref_object_id, ts, deleted, seq)
      VALUES (?,?,?,?,?,?,?,?,0,?)
    `).run(
      lobbyId, author, kind, body, replyTo ?? null,
      mentions && mentions.length ? JSON.stringify(mentions) : null,
      input.ref_object_id || null, ts, seq
    );
    return {
      id: Number(res.lastInsertRowid),
      lobby_id: lobbyId,
      author_user: author,
      author_kind: kind,
      body,
      reply_to: replyTo,
      mentions,
      ref_object_id: input.ref_object_id || undefined,
      ts,
      deleted: false,
      seq,
    } as ChatMessage;
  });

  return run();
}

/**
 * Backlog, oldest-first. `before_seq` pages backwards through history: the newest
 * `limit` messages strictly older than that cursor. Tombstones are included —
 * a client that already rendered the line needs to be told it was withdrawn.
 */
export function getMessages(
  db: Database,
  lobbyId: string,
  opts?: { limit?: number; beforeSeq?: number }
): ChatMessage[] {
  const limit = clamp(opts?.limit, 100, 500);
  const params: any[] = [lobbyId];
  let sql = `SELECT ${SELECT_COLS} FROM messages WHERE lobby_id = ?`;
  if (opts?.beforeSeq !== undefined && Number.isFinite(opts.beforeSeq) && opts.beforeSeq > 0) {
    sql += ' AND seq < ?';
    params.push(opts.beforeSeq);
  }
  // Newest N in SQL, then flipped — taking the oldest N would page the wrong end
  // of a long room.
  sql += ' ORDER BY seq DESC LIMIT ?';
  params.push(limit);
  return (db.prepare(sql).all(...params) as any[]).map(hydrate).reverse();
}

/** Delta for reconnect — same contract as the canvas `since` query. */
export function getMessagesSince(
  db: Database,
  lobbyId: string,
  since: number,
  limit = 500
): ChatMessage[] {
  return (db.prepare(`
    SELECT ${SELECT_COLS} FROM messages
    WHERE lobby_id = ? AND seq > ?
    ORDER BY seq ASC LIMIT ?
  `).all(lobbyId, since, clamp(limit, 500, 1000)) as any[]).map(hydrate);
}

export function getMessage(db: Database, lobbyId: string, id: number): ChatMessage | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM messages WHERE id = ? AND lobby_id = ?`)
    .get(id, lobbyId) as any;
  return row ? hydrate(row) : null;
}

/**
 * Withdraw a message. Gets a fresh seq so clients that are caught up still learn
 * about it — reusing the original seq would put the tombstone in the past, below
 * every cursor, and it would never be delivered.
 *
 * Returns null when the message is not in this lobby. Authorization (author or
 * owner) is the caller's job: this module does not know about roles.
 */
export function deleteMessage(db: Database, lobbyId: string, id: number): ChatMessage | null {
  const existing = db
    .prepare('SELECT id, deleted FROM messages WHERE id = ? AND lobby_id = ?')
    .get(id, lobbyId) as any;
  if (!existing) return null;
  if (existing.deleted) return getMessage(db, lobbyId, id);

  const run = db.transaction(() => {
    const seq = nextSeq(db);
    db.prepare("UPDATE messages SET deleted = 1, body = '', seq = ? WHERE id = ? AND lobby_id = ?")
      .run(seq, id, lobbyId);
    return getMessage(db, lobbyId, id);
  });
  return run();
}

function clamp(v: any, fallback: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return Math.min(fallback, max);
  return Math.min(Math.floor(n), max);
}
