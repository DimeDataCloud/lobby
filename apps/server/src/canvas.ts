// Canvas objects — the artifact board.
//
// Convergence is last-write-wins on (version, version_nonce), which is
// Excalidraw's rule. It is deterministic: every client applying the same set of
// updates in any order ends up with the same object, with no central lock and
// no server round-trip before a local edit shows.
//
// The subtle part is deletes. If a delete removed the row, a client that had
// not yet seen it would re-broadcast its stale copy and resurrect the object.
// So deletes are tombstones that carry a version like any other edit.

import type { Database } from 'bun:sqlite';
import { nextSeq } from './schema';

export type CanvasObjectType =
  | 'artifact'   // renders an event (EventCard) on the board
  | 'note'       // sticky note
  | 'frame'      // grouping container
  | 'stroke'     // freehand pen
  | 'shape'      // rect / ellipse / arrow
  | 'link'
  | 'image';

export interface CanvasObject {
  id: string;
  lobby_id: string;
  type: CanvasObjectType;
  event_id?: number;
  /**
   * The artifact's public name — `a7`, rendered as `#a7`.
   *
   * Read-only here: it is assigned once, by whoever created the artifact
   * (`postArtifact` or `placeArtifact`), and never travels in an update. It is
   * SELECTed because it is how a person and an agent refer to the same card in
   * conversation; without it the board cannot show what a bot is talking about.
   */
  handle?: string;
  parent_id?: string;
  x: number; y: number; w: number; h: number; z: number;
  rotation: number;
  props?: Record<string, any>;
  version: number;
  version_nonce: number;
  created_by?: string;
  updated_by?: string;
  updated_at: number;
  deleted: boolean;
  seq: number;
}

const SELECT_COLS = `
  id, lobby_id, type, event_id, parent_id, x, y, w, h, z, rotation, props, handle,
  version, version_nonce, created_by, updated_by, updated_at, deleted, seq
`;

function hydrate(row: any): CanvasObject {
  return {
    id: row.id,
    lobby_id: row.lobby_id,
    type: row.type,
    event_id: row.event_id === null ? undefined : row.event_id,
    handle: row.handle || undefined,
    parent_id: row.parent_id || undefined,
    x: row.x, y: row.y, w: row.w, h: row.h, z: row.z,
    rotation: row.rotation,
    props: row.props ? safeParse(row.props) : undefined,
    version: row.version,
    version_nonce: row.version_nonce,
    created_by: row.created_by || undefined,
    updated_by: row.updated_by || undefined,
    updated_at: row.updated_at,
    deleted: !!row.deleted,
    seq: row.seq,
  };
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}

/**
 * True when `incoming` should replace `current` under last-write-wins.
 * Ties on version are broken by nonce so two clients editing concurrently
 * converge on the same winner rather than flip-flopping.
 */
export function wins(
  incoming: { version: number; version_nonce: number },
  current: { version: number; version_nonce: number }
): boolean {
  if (incoming.version !== current.version) return incoming.version > current.version;
  return incoming.version_nonce > current.version_nonce;
}

export interface UpsertResult {
  accepted: boolean;
  object: CanvasObject;
  /** set when the write was rejected as stale — the caller should not broadcast */
  reason?: 'stale';
}

/**
 * Create or update an object. Returns the authoritative row either way: on
 * rejection the caller can send the winner back so the losing client repairs
 * itself instead of silently diverging.
 */
export function upsertObject(
  db: Database,
  lobbyId: string,
  incoming: Partial<CanvasObject> & { id: string; type?: CanvasObjectType },
  actor?: string
): UpsertResult {
  const run = db.transaction(() => {
    const existing = db
      .prepare(`SELECT ${SELECT_COLS} FROM canvas_objects WHERE id = ? AND lobby_id = ?`)
      .get(incoming.id, lobbyId) as any;

    const now = Date.now();

    if (!existing) {
      const seq = nextSeq(db);
      const obj: CanvasObject = {
        id: incoming.id,
        lobby_id: lobbyId,
        type: (incoming.type || 'note') as CanvasObjectType,
        event_id: incoming.event_id,
        parent_id: incoming.parent_id,
        x: num(incoming.x, 0), y: num(incoming.y, 0),
        w: num(incoming.w, 320), h: num(incoming.h, 200),
        z: num(incoming.z, 0), rotation: num(incoming.rotation, 0),
        props: incoming.props,
        version: num(incoming.version, 1),
        version_nonce: num(incoming.version_nonce, randNonce()),
        created_by: actor, updated_by: actor,
        updated_at: now,
        deleted: !!incoming.deleted,
        seq,
      };
      db.prepare(`
        INSERT INTO canvas_objects
          (id, lobby_id, type, event_id, parent_id, x, y, w, h, z, rotation, props,
           version, version_nonce, created_by, updated_by, updated_at, deleted, seq)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        obj.id, obj.lobby_id, obj.type, obj.event_id ?? null, obj.parent_id ?? null,
        obj.x, obj.y, obj.w, obj.h, obj.z, obj.rotation,
        obj.props ? JSON.stringify(obj.props) : null,
        obj.version, obj.version_nonce, obj.created_by ?? null, obj.updated_by ?? null,
        obj.updated_at, obj.deleted ? 1 : 0, obj.seq
      );
      return { accepted: true, object: obj } as UpsertResult;
    }

    const cur = hydrate(existing);
    const candidate = {
      version: num(incoming.version, cur.version + 1),
      version_nonce: num(incoming.version_nonce, randNonce()),
    };

    if (!wins(candidate, cur)) {
      return { accepted: false, object: cur, reason: 'stale' } as UpsertResult;
    }

    const seq = nextSeq(db);
    const merged: CanvasObject = {
      ...cur,
      type: (incoming.type || cur.type) as CanvasObjectType,
      event_id: incoming.event_id !== undefined ? incoming.event_id : cur.event_id,
      parent_id: incoming.parent_id !== undefined ? incoming.parent_id : cur.parent_id,
      x: num(incoming.x, cur.x), y: num(incoming.y, cur.y),
      w: num(incoming.w, cur.w), h: num(incoming.h, cur.h),
      z: num(incoming.z, cur.z), rotation: num(incoming.rotation, cur.rotation),
      props: incoming.props !== undefined ? incoming.props : cur.props,
      version: candidate.version,
      version_nonce: candidate.version_nonce,
      updated_by: actor || cur.updated_by,
      updated_at: now,
      deleted: incoming.deleted !== undefined ? !!incoming.deleted : cur.deleted,
      seq,
    };

    db.prepare(`
      UPDATE canvas_objects SET
        type = ?, event_id = ?, parent_id = ?, x = ?, y = ?, w = ?, h = ?, z = ?,
        rotation = ?, props = ?, version = ?, version_nonce = ?, updated_by = ?,
        updated_at = ?, deleted = ?, seq = ?
      WHERE id = ? AND lobby_id = ?
    `).run(
      merged.type, merged.event_id ?? null, merged.parent_id ?? null,
      merged.x, merged.y, merged.w, merged.h, merged.z, merged.rotation,
      merged.props ? JSON.stringify(merged.props) : null,
      merged.version, merged.version_nonce, merged.updated_by ?? null,
      merged.updated_at, merged.deleted ? 1 : 0, merged.seq,
      merged.id, lobbyId
    );
    return { accepted: true, object: merged } as UpsertResult;
  });

  return run();
}

/** Tombstone an object. Never removes the row — see the note at the top. */
export function deleteObject(
  db: Database,
  lobbyId: string,
  id: string,
  actor?: string
): UpsertResult | null {
  const existing = db
    .prepare(`SELECT version FROM canvas_objects WHERE id = ? AND lobby_id = ?`)
    .get(id, lobbyId) as any;
  if (!existing) return null;
  return upsertObject(
    db, lobbyId,
    { id, deleted: true, version: existing.version + 1, version_nonce: randNonce() },
    actor
  );
}

/**
 * Board snapshot: live objects only. This is what a client loads on join, so a
 * 5,000-object board never has to replay 50,000 events to render.
 */
export function getObjects(
  db: Database,
  lobbyId: string,
  opts?: { bbox?: [number, number, number, number]; limit?: number }
): CanvasObject[] {
  let sql = `SELECT ${SELECT_COLS} FROM canvas_objects WHERE lobby_id = ? AND deleted = 0`;
  const params: any[] = [lobbyId];

  if (opts?.bbox) {
    // Viewport culling. Compares against the object's own box so anything
    // overlapping the viewport is included, not just objects whose origin is.
    const [x1, y1, x2, y2] = opts.bbox;
    sql += ' AND x + w >= ? AND x <= ? AND y + h >= ? AND y <= ?';
    params.push(x1, x2, y1, y2);
  }

  sql += ' ORDER BY z ASC, seq ASC';
  const limit = clampLimit(opts?.limit, 5000);
  sql += ' LIMIT ?';
  params.push(limit);

  return (db.prepare(sql).all(...params) as any[]).map(hydrate);
}

/**
 * Delta since a cursor. Includes tombstones — a client that missed a delete
 * must learn about it, which is exactly what the snapshot query filters out.
 */
export function getObjectsSince(
  db: Database,
  lobbyId: string,
  since: number,
  limit = 2000
): CanvasObject[] {
  return (db.prepare(`
    SELECT ${SELECT_COLS} FROM canvas_objects
    WHERE lobby_id = ? AND seq > ?
    ORDER BY seq ASC LIMIT ?
  `).all(lobbyId, since, clampLimit(limit, 5000)) as any[]).map(hydrate);
}

export function getObject(db: Database, lobbyId: string, id: string): CanvasObject | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM canvas_objects WHERE id = ? AND lobby_id = ?`)
    .get(id, lobbyId) as any;
  return row ? hydrate(row) : null;
}

// ---- helpers ---------------------------------------------------------------

function num(v: any, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function randNonce(): number {
  // Range kept inside 2^31 so it round-trips through SQLite INTEGER and JSON
  // without precision surprises.
  return Math.floor(Math.random() * 2147483647);
}

export function clampLimit(v: any, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return Math.min(300, max);
  return Math.min(Math.floor(n), max);
}
