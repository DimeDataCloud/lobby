// Data retention.
//
// The `events` table is the fastest-growing thing in an active deployment: every
// tool call, file edit and prompt boundary a connected agent reports lands here,
// and until now nothing ever removed one. On a box with a 3.8GB memory limit and
// a single volume shared with the backups, unbounded growth is not a tidiness
// problem — it is the outage that takes every customer's board down at once.
//
// THE TRAP, stated first because it is not obvious and it is expensive:
// `canvas_objects.event_id` references `events.id`. An artifact derived from an
// event resolves its CONTENT through that row. So the naive
//
//     DELETE FROM events WHERE timestamp < cutoff
//
// silently blanks out board artifacts — the exact "grey box reading artifact" bug
// this project already shipped once, arriving by a different road. Retention here
// therefore never deletes an event that a live canvas object still points at, no
// matter how old it is. The board is the product; the event stream is history of
// how it got that way.
//
// Two more decisions worth stating:
//
// 1. NOTHING ON THE BOARD IS EVER DELETED BY AGE. Artifacts, messages and
//    annotations are the customer's work product. A product that quietly eats work
//    after 90 days is not one you can sell to a team, and "we deleted it, check
//    the retention policy" is not a support answer anyone accepts. Only the
//    activity *stream* is aged out, and it is derivable observability data.
//
// 2. DELETION IS BATCHED AND BOUNDED. A first run against a table that has been
//    growing for months would otherwise be one enormous transaction that blocks
//    every request and balloons the WAL. It deletes in chunks, and stops after a
//    budget, picking up where it left off on the next sweep.

import type { Database } from 'bun:sqlite';

/** Zero or negative disables age-based deletion entirely. */
function retentionDays(): number {
  const raw = process.env.EVENT_RETENTION_DAYS;
  if (raw === undefined || raw === '') return 90;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 90;
  return n;
}

const BATCH = 2_000;
const MAX_PER_SWEEP = 20_000;

export interface RetentionResult {
  events_deleted: number;
  presence_deleted: number;
  kept_referenced: number;
}

export function pruneEvents(db: Database): RetentionResult {
  const days = retentionDays();
  const result: RetentionResult = { events_deleted: 0, presence_deleted: 0, kept_referenced: 0 };

  // Presence is ephemeral by definition: a row is a cursor position for a session
  // that has since ended. Anything not seen for a day is dead regardless of the
  // event policy.
  try {
    const p = db.prepare('DELETE FROM presence WHERE last_seen < ?').run(Date.now() - 24 * 60 * 60_000);
    result.presence_deleted = Number(p.changes || 0);
  } catch { /* table may not exist in an old database */ }

  if (days <= 0) return result;

  const cutoff = Date.now() - days * 24 * 60 * 60_000;

  // How many past-cutoff events are pinned, and therefore deliberately kept.
  // Counts BOTH reasons — board artifacts and annotations — because the question
  // this number answers is "retention is 90 days, so why is the table not
  // shrinking", and a count that covered only one reason would answer it wrongly.
  try {
    const pinned = db.prepare(`
      SELECT COUNT(*) AS n FROM events e
      WHERE e.timestamp < ?
        AND (   EXISTS (SELECT 1 FROM canvas_objects c WHERE c.event_id = e.id AND c.deleted = 0)
             OR EXISTS (SELECT 1 FROM annotations a WHERE a.event_id = e.id) )
    `).get(cutoff) as any;
    result.kept_referenced = Number(pinned?.n || 0);
  } catch { /* canvas_objects may not exist yet */ }

  // Batched, bounded, and skipping anything the board still needs.
  //
  // annotations.event_id is checked too: an unresolved comment pinned to an event
  // is a conversation someone is still having.
  const del = db.prepare(`
    DELETE FROM events WHERE id IN (
      SELECT e.id FROM events e
      WHERE e.timestamp < ?
        AND NOT EXISTS (SELECT 1 FROM canvas_objects c WHERE c.event_id = e.id AND c.deleted = 0)
        AND NOT EXISTS (SELECT 1 FROM annotations a WHERE a.event_id = e.id)
      LIMIT ?
    )
  `);

  for (;;) {
    let changes = 0;
    try {
      changes = Number(del.run(cutoff, BATCH).changes || 0);
    } catch (err) {
      console.error('[retention] events prune failed:', err instanceof Error ? err.message : err);
      break;
    }
    result.events_deleted += changes;
    if (changes < BATCH) break;                       // caught up
    if (result.events_deleted >= MAX_PER_SWEEP) break; // resume next sweep
  }

  if (result.events_deleted > 0) {
    console.log(
      `[retention] removed ${result.events_deleted} events older than ${days}d` +
      (result.kept_referenced ? `; kept ${result.kept_referenced} still referenced by the board` : '')
    );
  }

  return result;
}

/** What the policy currently is, for /health and the runbook. */
export function retentionPolicy(): { event_retention_days: number; board_content: string } {
  const days = retentionDays();
  return {
    event_retention_days: days,
    // Stated in the API because a customer asking "what do you delete" deserves a
    // machine-readable answer, and because writing it here keeps the claim next to
    // the code that would have to change to make it false.
    board_content: 'never deleted by age; removed only when you delete it',
  };
}
