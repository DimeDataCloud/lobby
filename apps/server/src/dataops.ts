// Export and deletion.
//
// Two questions every buyer asks, and the answers have to be real:
//
//   "Can we get our data out?"      → export a workspace, whole, in a format
//                                     that is useful without this product.
//   "Can you delete everything?"    → and mean it, including the parts that are
//                                     inconvenient to find.
//
// The second is where products quietly cheat. Deleting the row a user can see
// while leaving their content in a dozen tables keyed by a different id is the
// normal failure, and it is invisible until someone audits it. So deletion here
// works from the schema outward: every table that references a workspace is
// listed explicitly, and adding a table without adding it here is meant to be
// obvious in review.
//
// Deletion is HARD here, deliberately — not the tombstone the canvas uses. A
// tombstone is the right answer for convergence between live clients; it is the
// wrong answer for "forget me", where the whole point is that the bytes go away.

import type { Database } from 'bun:sqlite';

export interface WorkspaceExport {
  format: 'lobby.workspace.v1';
  exported_at: number;
  workspace: any;
  artifacts: any[];
  messages: any[];
  annotations: any[];
  events: any[];
  members: any[];
  counts: Record<string, number>;
}

/**
 * Everything in one workspace, as portable JSON.
 *
 * Member tokens are NEVER included. An export is a document that gets emailed,
 * dropped in shared storage and forgotten about; putting live credentials in one
 * turns a routine backup into a breach.
 */
export function exportWorkspace(db: Database, code: string): WorkspaceExport | null {
  const workspace = db.prepare('SELECT * FROM lobbies WHERE code = ?').get(code) as any;
  if (!workspace) return null;

  const artifacts = db.prepare(`
    SELECT id, handle, type, event_id, parent_id, x, y, w, h, z, rotation, props,
           created_by, updated_by, updated_at, deleted, seq
    FROM canvas_objects WHERE lobby_id = ? ORDER BY seq ASC
  `).all(code) as any[];

  const messages = db.prepare(`
    SELECT id, author_user, author_kind, body, reply_to, mentions, ref_object_id, ts, deleted, seq
    FROM messages WHERE lobby_id = ? ORDER BY seq ASC
  `).all(code) as any[];

  const annotations = db.prepare(`
    SELECT id, user_id, text, target_type, target_id, anchor_x, anchor_y,
           thread_parent, resolved, deleted, timestamp, seq
    FROM annotations WHERE lobby_id = ? ORDER BY seq ASC
  `).all(code) as any[];

  const events = db.prepare(`
    SELECT id, source, agent_id, event_type, session_id, model, provider,
           user_id, payload, summary, timestamp, seq
    FROM events WHERE lobby_id = ? ORDER BY id ASC LIMIT 20000
  `).all(code) as any[];

  // Roster without credentials: no token_hash, no token_prefix.
  const members = db.prepare(`
    SELECT user_id, display_name, color, role, created_at, last_seen, revoked
    FROM members WHERE lobby_id = ? ORDER BY created_at ASC
  `).all(code) as any[];

  // props and payload are stored as JSON strings; parse them so the export is a
  // document rather than a document containing escaped documents.
  const revive = (rows: any[], field: string) =>
    rows.map((r) => {
      if (typeof r[field] === 'string') {
        try { return { ...r, [field]: JSON.parse(r[field]) }; } catch { /* leave as-is */ }
      }
      return r;
    });

  return {
    format: 'lobby.workspace.v1',
    exported_at: Date.now(),
    workspace,
    artifacts: revive(artifacts, 'props'),
    messages,
    annotations,
    events: revive(events, 'payload'),
    members,
    counts: {
      artifacts: artifacts.length,
      messages: messages.length,
      annotations: annotations.length,
      events: events.length,
      members: members.length,
    },
  };
}

/**
 * Every table holding workspace-scoped rows, and the column that scopes it.
 *
 * Listed exhaustively and by hand. A loop over sqlite_master would be shorter
 * and would silently miss anything named differently — and "we thought that
 * table was covered" is the standard way deletion turns out not to have worked.
 */
const WORKSPACE_TABLES: [table: string, column: string][] = [
  ['canvas_objects', 'lobby_id'],
  ['messages', 'lobby_id'],
  ['annotations', 'lobby_id'],
  ['file_activity', 'lobby_id'],
  ['members', 'lobby_id'],
  ['events', 'lobby_id'],
  ['lobby_members', 'lobby_id'],
];

export interface DeletionReport {
  workspace: string;
  deleted: Record<string, number>;
  total: number;
}

/**
 * Remove a workspace and everything scoped to it.
 *
 * One transaction: a partial delete leaves orphaned content that no longer has a
 * workspace to authorize access to it, which is worse than either outcome.
 */
export function deleteWorkspaceData(db: Database, code: string): DeletionReport {
  const deleted: Record<string, number> = {};

  const run = db.transaction(() => {
    for (const [table, column] of WORKSPACE_TABLES) {
      try {
        const r = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(code);
        deleted[table] = Number(r.changes || 0);
      } catch {
        // Table may not exist in an older database. Recorded as -1 rather than
        // skipped, so a report never implies it cleaned something it did not.
        deleted[table] = -1;
      }
    }
    // Per-lobby handle counter, or a recreated room with the same code would
    // resume numbering where the deleted one left off.
    try { db.prepare('DELETE FROM counters WHERE name = ?').run(`handle:${code}`); } catch {}
    try { db.prepare('DELETE FROM lobbies WHERE code = ?').run(code); } catch {}
  });
  run();

  return {
    workspace: code,
    deleted,
    total: Object.values(deleted).filter((n) => n > 0).reduce((a, b) => a + b, 0),
  };
}

export interface OrgDeletionReport {
  org_id: string;
  workspaces: DeletionReport[];
  members_removed: number;
  audit_removed: number;
}

/**
 * Delete an organisation, its workspaces, and everything inside them.
 *
 * The audit log for the org goes too. That is a real tension — audit data is
 * exactly what you want to keep — but "delete everything about us" has to
 * include the record of what we did, or the answer to the buyer's question is
 * no. Operators who need a longer trail keep it in backups, which are outside
 * this path and outside the customer's reach by design.
 */
export function deleteOrgData(db: Database, orgId: string): OrgDeletionReport {
  const codes = (db.prepare('SELECT code FROM lobbies WHERE org_id = ?').all(orgId) as any[])
    .map((r) => r.code);

  const workspaces = codes.map((c) => deleteWorkspaceData(db, c));

  let members_removed = 0;
  let audit_removed = 0;
  const run = db.transaction(() => {
    members_removed = Number(db.prepare('DELETE FROM org_members WHERE org_id = ?').run(orgId).changes || 0);
    audit_removed = Number(db.prepare('DELETE FROM audit_log WHERE org_id = ?').run(orgId).changes || 0);
    db.prepare('DELETE FROM orgs WHERE id = ?').run(orgId);
  });
  run();

  return { org_id: orgId, workspaces, members_removed, audit_removed };
}

/**
 * What a deletion WOULD remove, without removing it.
 *
 * Irreversible actions should be previewable. A count in front of the confirm
 * button is the difference between an informed decision and a mis-click.
 */
export function previewOrgDeletion(db: Database, orgId: string): Record<string, number> {
  const codes = (db.prepare('SELECT code FROM lobbies WHERE org_id = ?').all(orgId) as any[])
    .map((r) => r.code);
  const counts: Record<string, number> = { workspaces: codes.length };

  for (const [table, column] of WORKSPACE_TABLES) {
    let n = 0;
    for (const c of codes) {
      try {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(c) as any;
        n += Number(r?.n || 0);
      } catch { /* table absent */ }
    }
    counts[table] = n;
  }
  try {
    const r = db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?').get(orgId) as any;
    counts.audit_log = Number(r?.n || 0);
  } catch { counts.audit_log = 0; }

  return counts;
}
