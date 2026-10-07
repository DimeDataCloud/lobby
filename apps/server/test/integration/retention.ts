// Retention: it deletes what it should, and — the point of this file — it never
// deletes what the board is still using.
//
//   bun run apps/server/test/integration/retention.ts
//
// `canvas_objects.event_id` resolves an artifact's content. So a retention policy
// written the obvious way (DELETE FROM events WHERE timestamp < cutoff) blanks out
// old board artifacts, reproducing the "grey box reading artifact" bug this project
// already shipped once. Most of what follows exists to prove that does not happen.
//
// Runs directly against the module and a real database rather than through HTTP:
// retention is a scheduled job, and the assertions are about row survival.

import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { Database } from 'bun:sqlite';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
  if (!ok) failures++;
};
const section = (s: string) => console.log('\n=== ' + s + ' ===');

const dbPath = join(tmpdir(), `lobby-retention-${Date.now()}.db`);
const db = new Database(dbPath);

const DAY = 86400_000;
const now = Date.now();
const ancient = now - 400 * DAY;
const old = now - 120 * DAY;
const recent = now - 2 * DAY;

// Schema, matching the shapes the product creates.
db.exec(`
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL, agent_id TEXT NOT NULL, event_type TEXT NOT NULL,
    session_id TEXT NOT NULL, payload TEXT NOT NULL, timestamp INTEGER NOT NULL
  );
  CREATE TABLE canvas_objects (
    id TEXT PRIMARY KEY, lobby_id TEXT NOT NULL, type TEXT NOT NULL,
    event_id INTEGER, props TEXT, deleted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL,
    user_id TEXT, text TEXT, timestamp INTEGER NOT NULL
  );
  CREATE TABLE presence (
    user_id TEXT, lobby_id TEXT, last_seen INTEGER NOT NULL
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
    org_id TEXT, actor TEXT NOT NULL, actor_kind TEXT NOT NULL DEFAULT 'human',
    action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT
  );
`);

const addEvent = (ts: number, note: string): number => {
  db.prepare(`INSERT INTO events (source, agent_id, event_type, session_id, payload, timestamp)
              VALUES ('claude-code','a1','tool_use','s1',?,?)`).run(JSON.stringify({ note }), ts);
  return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as any).id);
};
const addObject = (id: string, eventId: number | null, deleted = 0) => {
  db.prepare(`INSERT INTO canvas_objects (id, lobby_id, type, event_id, props, deleted, updated_at)
              VALUES (?,?,?,?,?,?,?)`).run(id, 'ROOM01', 'artifact', eventId, '{}', deleted, now);
};
const count = (sql: string, ...p: any[]) => Number((db.prepare(sql).get(...p) as any).n);

// The fixture.
const orphanAncient = addEvent(ancient, 'ancient, nothing points at it');
const orphanOld = addEvent(old, 'old, nothing points at it');
const pinnedByBoard = addEvent(ancient, 'ancient, but an artifact renders from it');
const pinnedByDeleted = addEvent(ancient, 'ancient, only a DELETED artifact points at it');
const pinnedByNote = addEvent(ancient, 'ancient, but someone commented on it');
const recentOrphan = addEvent(recent, 'recent');

addObject('obj_live', pinnedByBoard, 0);
addObject('obj_gone', pinnedByDeleted, 1);
addObject('obj_standalone', null, 0);          // a lobby_post artifact: no event_id
db.prepare('INSERT INTO annotations (event_id, user_id, text, timestamp) VALUES (?,?,?,?)')
  .run(pinnedByNote, 'u1', 'why did this happen?', ancient);

db.prepare('INSERT INTO presence (user_id, lobby_id, last_seen) VALUES (?,?,?)')
  .run('ghost', 'ROOM01', now - 3 * DAY);
db.prepare('INSERT INTO presence (user_id, lobby_id, last_seen) VALUES (?,?,?)')
  .run('here', 'ROOM01', now - 60_000);

for (const [at, action] of [[ancient, 'user.signin'], [old, 'workspace.create'], [recent, 'user.signin']] as const) {
  db.prepare(`INSERT INTO audit_log (at, actor, actor_kind, action) VALUES (?,?,?,?)`)
    .run(at, 'usr_1', 'human', action);
}

try {
  process.env.EVENT_RETENTION_DAYS = '90';
  const { pruneEvents, retentionPolicy } = await import('../../src/retention');

  section('before');
  check('6 events, 3 objects, 1 annotation', count('SELECT COUNT(*) AS n FROM events') === 6);

  const result = pruneEvents(db);

  section('what it deleted');
  check('the ancient orphan is gone',
    count('SELECT COUNT(*) AS n FROM events WHERE id = ?', orphanAncient) === 0);
  check('the 120-day orphan is gone',
    count('SELECT COUNT(*) AS n FROM events WHERE id = ?', orphanOld) === 0);
  check('it reported the deletions', result.events_deleted >= 2, `${result.events_deleted}`);

  section('what it must NEVER delete');
  // This is the whole reason the file exists.
  check('an event a LIVE artifact renders from survives, however old',
    count('SELECT COUNT(*) AS n FROM events WHERE id = ?', pinnedByBoard) === 1);
  check('and it was reported as kept, not silently skipped',
    result.kept_referenced >= 2, `kept_referenced=${result.kept_referenced}`);
  check('an event with an unresolved comment on it survives',
    count('SELECT COUNT(*) AS n FROM events WHERE id = ?', pinnedByNote) === 1);
  check('a recent event survives',
    count('SELECT COUNT(*) AS n FROM events WHERE id = ?', recentOrphan) === 1);

  section('a tombstoned artifact does not pin history forever');
  check('an event only a DELETED artifact referenced IS collected',
    count('SELECT COUNT(*) AS n FROM events WHERE id = ?', pinnedByDeleted) === 0);

  section('board content is never touched by age');
  check('every artifact still exists', count('SELECT COUNT(*) AS n FROM canvas_objects') === 3);
  check('including the one with no event behind it',
    count('SELECT COUNT(*) AS n FROM canvas_objects WHERE id = ?', 'obj_standalone') === 1);
  check('annotations are untouched', count('SELECT COUNT(*) AS n FROM annotations') === 1);

  section('no artifact was left pointing at a deleted event');
  // The failure mode in one query: a live object whose event has been collected
  // renders as a grey box saying "artifact".
  const dangling = count(`
    SELECT COUNT(*) AS n FROM canvas_objects c
    WHERE c.deleted = 0 AND c.event_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = c.event_id)
  `);
  check('zero dangling event references', dangling === 0, `${dangling} found`);

  section('presence');
  check('a day-old ghost cursor is swept',
    count('SELECT COUNT(*) AS n FROM presence WHERE user_id = ?', 'ghost') === 0);
  check('someone currently present is not',
    count('SELECT COUNT(*) AS n FROM presence WHERE user_id = ?', 'here') === 1);

  section('the audit log has a window, and it is enforced');
  // pruneAudit was imported and never called for its whole existence, while
  // AUDIT_RETENTION_DAYS was set in compose and reported by the API.
  process.env.AUDIT_RETENTION_DAYS = '90';
  const { pruneAudit } = await import('../../src/audit');
  const removed = pruneAudit(db);
  check('entries past the window are removed', removed === 2, `removed=${removed}`);
  check('recent entries stay', count('SELECT COUNT(*) AS n FROM audit_log') === 1);

  section('the floor on audit retention holds');
  process.env.AUDIT_RETENTION_DAYS = '1';
  db.prepare(`INSERT INTO audit_log (at, actor, actor_kind, action) VALUES (?,?,?,?)`)
    .run(now - 10 * DAY, 'usr_1', 'human', 'user.signin');
  // A 30-day floor is deliberate: an audit log a customer can configure down to
  // nothing is not evidence of anything, which is the reason to keep one.
  check('a 1-day setting does not delete a 10-day-old entry', pruneAudit(db) === 0);

  section('retention can be switched off');
  process.env.EVENT_RETENTION_DAYS = '0';
  const before = count('SELECT COUNT(*) AS n FROM events');
  addEvent(ancient, 'ancient, but retention is off');
  const off = pruneEvents(db);
  check('nothing is deleted by age when set to 0', off.events_deleted === 0);
  check('and the ancient event is still there',
    count('SELECT COUNT(*) AS n FROM events') === before + 1);

  section('the policy is reportable');
  process.env.EVENT_RETENTION_DAYS = '90';
  const policy = retentionPolicy();
  check('it states the event window', policy.event_retention_days === 90);
  check('and that board content is not deleted by age',
    /never deleted by age/i.test(policy.board_content), policy.board_content);

  section('verdict');
  console.log(failures === 0 ? 'PASS' : `FAIL — ${failures} check(s)`);
} catch (err) {
  console.error('\nthrew:', err);
  failures++;
} finally {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch {} }
}

process.exit(failures === 0 ? 0 : 1);
