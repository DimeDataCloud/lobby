// Canvas convergence invariants.
//
// These are the properties multiplayer correctness rests on. If one of these
// breaks, two people on the same board silently see different things — the
// worst class of bug in this product, because nothing errors.
//
//   bun test

import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { initSchema } from '../src/schema';
import {
  upsertObject, deleteObject, getObjects, getObjectsSince, getObject, wins,
} from '../src/canvas';

const L = 'TESTLOBBY';
const open: Array<{ db: Database; path: string }> = [];

function freshDb(): Database {
  const path = join(tmpdir(), `lobby-canvas-${Date.now()}-${Math.floor(Math.random() * 1e9)}.db`);
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  initSchema(db);
  open.push({ db, path });
  return db;
}

afterEach(() => {
  while (open.length) {
    const { db, path } = open.pop()!;
    try { db.close(false); } catch {}
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(path + suffix, { force: true }); } catch {}
    }
  }
});

describe('last-write-wins predicate', () => {
  it('prefers the higher version', () => {
    expect(wins({ version: 3, version_nonce: 1 }, { version: 2, version_nonce: 999 })).toBe(true);
    expect(wins({ version: 1, version_nonce: 999 }, { version: 2, version_nonce: 1 })).toBe(false);
  });

  it('breaks version ties on nonce, deterministically both ways', () => {
    expect(wins({ version: 2, version_nonce: 50 }, { version: 2, version_nonce: 10 })).toBe(true);
    expect(wins({ version: 2, version_nonce: 10 }, { version: 2, version_nonce: 50 })).toBe(false);
  });

  it('rejects an exact tie so identical rebroadcasts do not churn seq', () => {
    expect(wins({ version: 2, version_nonce: 10 }, { version: 2, version_nonce: 10 })).toBe(false);
  });
});

describe('create and update', () => {
  it('creates with defaults and assigns a seq', () => {
    const db = freshDb();
    const r = upsertObject(db, L, { id: 'o1', type: 'artifact', event_id: 42, x: 10, y: 20 }, 'alice');
    expect(r.accepted).toBe(true);
    expect(r.object.seq).toBeGreaterThan(0);
    expect(r.object.w).toBe(320);
  });

  it('merges partial updates instead of clobbering unspecified fields', () => {
    const db = freshDb();
    upsertObject(db, L, { id: 'o1', type: 'artifact', event_id: 42, x: 10, y: 20 }, 'alice');
    const r = upsertObject(db, L, { id: 'o1', x: 99, version: 2, version_nonce: 5 }, 'bob');
    expect(r.accepted).toBe(true);
    expect(r.object.x).toBe(99);
    expect(r.object.event_id).toBe(42);   // untouched
    expect(r.object.y).toBe(20);          // untouched
  });

  it('rejects a stale write and hands back the winner so the loser can repair', () => {
    const db = freshDb();
    upsertObject(db, L, { id: 'o1', type: 'note', x: 10 }, 'alice');
    upsertObject(db, L, { id: 'o1', x: 99, version: 2, version_nonce: 5 }, 'bob');

    const stale = upsertObject(db, L, { id: 'o1', x: -1, version: 1, version_nonce: 999 }, 'carol');
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toBe('stale');
    expect(stale.object.x).toBe(99);
    expect(getObject(db, L, 'o1')!.x).toBe(99);
  });
});

describe('deletes are tombstones', () => {
  it('hides from the snapshot but reports in the delta', () => {
    const db = freshDb();
    upsertObject(db, L, { id: 'o1', type: 'note' }, 'alice');
    const del = deleteObject(db, L, 'o1', 'alice');

    expect(del!.accepted).toBe(true);
    expect(getObjects(db, L).some(o => o.id === 'o1')).toBe(false);
    expect(getObjectsSince(db, L, 0).some(o => o.id === 'o1' && o.deleted)).toBe(true);
  });

  it('cannot be resurrected by a client that never saw the delete', () => {
    const db = freshDb();
    upsertObject(db, L, { id: 'o1', type: 'note' }, 'alice');
    deleteObject(db, L, 'o1', 'alice');

    const zombie = upsertObject(db, L, { id: 'o1', x: 5, version: 1, version_nonce: 1 }, 'laggy');
    expect(zombie.accepted).toBe(false);
    expect(getObjects(db, L).some(o => o.id === 'o1')).toBe(false);
  });

  it('returns null when deleting something that never existed', () => {
    const db = freshDb();
    expect(deleteObject(db, L, 'ghost', 'alice')).toBeNull();
  });
});

describe('convergence', () => {
  it('lands on identical state regardless of arrival order', () => {
    // Three concurrent edits, four different arrival orders. Under LWW every
    // replica must agree — this is the whole basis of optimistic local editing.
    const ops = [
      { id: 'x', type: 'note' as const, x: 1, version: 1, version_nonce: 10 },
      { id: 'x', x: 2, version: 2, version_nonce: 77 },
      { id: 'x', x: 3, version: 2, version_nonce: 12 },
    ];
    const orders = [[0, 1, 2], [0, 2, 1], [2, 1, 0], [1, 2, 0], [2, 0, 1]];
    const finals = orders.map(order => {
      const db = freshDb();
      for (const i of order) upsertObject(db, L, ops[i] as any, 'r');
      const o = getObject(db, L, 'x')!;
      return JSON.stringify({ x: o.x, v: o.version, n: o.version_nonce, d: o.deleted });
    });

    expect(new Set(finals).size).toBe(1);
    expect(finals[0]).toContain('"v":2');
    expect(finals[0]).toContain('"n":77');   // highest nonce at the highest version
    expect(finals[0]).toContain('"x":2');
  });
});

describe('delta cursor', () => {
  it('replays strictly above the caller cursor, in seq order', () => {
    const db = freshDb();
    const a = upsertObject(db, L, { id: 'a', type: 'note' }, 'u');
    upsertObject(db, L, { id: 'b', type: 'note' }, 'u');
    const c = upsertObject(db, L, { id: 'c', type: 'note' }, 'u');

    const since = getObjectsSince(db, L, a.object.seq);
    expect(since.map(o => o.id)).toEqual(['b', 'c']);
    expect(since[0].seq).toBeLessThan(since[1].seq);
    expect(getObjectsSince(db, L, c.object.seq)).toHaveLength(0);
  });
});

describe('lobby scoping', () => {
  it('never leaks another lobby through snapshot, delta, or direct get', () => {
    const db = freshDb();
    upsertObject(db, L, { id: 'mine', type: 'note' }, 'u');
    upsertObject(db, 'OTHER', { id: 'theirs', type: 'note' }, 'u');

    expect(getObjects(db, L).some(o => o.id === 'theirs')).toBe(false);
    expect(getObjectsSince(db, L, 0).some(o => o.id === 'theirs')).toBe(false);
    expect(getObject(db, L, 'theirs')).toBeNull();
  });

  it('allows the same object id in two different lobbies', () => {
    // Object ids are client-generated. With `id` as a global primary key, an id
    // used in one lobby permanently blocked that id everywhere else: the insert
    // died on a UNIQUE constraint, and a client could probe for the existence of
    // ids in lobbies it cannot read. The key is composite (lobby_id, id).
    const db = freshDb();
    const a = upsertObject(db, 'LOBBY-A', { id: 'shared-id', type: 'note', x: 1 }, 'alice');
    const b = upsertObject(db, 'LOBBY-B', { id: 'shared-id', type: 'note', x: 2 }, 'bob');

    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(true);
    expect(getObject(db, 'LOBBY-A', 'shared-id')!.x).toBe(1);
    expect(getObject(db, 'LOBBY-B', 'shared-id')!.x).toBe(2);

    // Editing one must not touch the other.
    upsertObject(db, 'LOBBY-A', { id: 'shared-id', x: 42, version: 5, version_nonce: 1 }, 'alice');
    expect(getObject(db, 'LOBBY-A', 'shared-id')!.x).toBe(42);
    expect(getObject(db, 'LOBBY-B', 'shared-id')!.x).toBe(2);

    // Deleting in one must not tombstone the other.
    deleteObject(db, 'LOBBY-A', 'shared-id', 'alice');
    expect(getObjects(db, 'LOBBY-A').some(o => o.id === 'shared-id')).toBe(false);
    expect(getObjects(db, 'LOBBY-B').some(o => o.id === 'shared-id')).toBe(true);
  });
});

describe('viewport culling', () => {
  it('includes overlapping and straddling objects, excludes distant ones', () => {
    const db = freshDb();
    upsertObject(db, L, { id: 'near',     type: 'note', x: 0,    y: 0,    w: 100, h: 100 }, 'u');
    upsertObject(db, L, { id: 'far',      type: 'note', x: 9000, y: 9000, w: 100, h: 100 }, 'u');
    // Straddles the viewport edge — must still be returned, or cards pop in
    // late while panning.
    upsertObject(db, L, { id: 'straddle', type: 'note', x: 150,  y: 150,  w: 400, h: 400 }, 'u');

    const visible = getObjects(db, L, { bbox: [-50, -50, 200, 200] }).map(o => o.id);
    expect(visible).toContain('near');
    expect(visible).toContain('straddle');
    expect(visible).not.toContain('far');
  });
});
