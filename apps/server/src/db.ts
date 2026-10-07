import { Database } from 'bun:sqlite';
import type { AgentEvent, FilterOptions } from './types';
import { initSchema, nextSeq, currentSeq } from './schema';
import { generateJoinCode } from './auth';

let db: Database;

export function initDatabase(dbPath?: string): void {
  db = new Database(dbPath || 'events.db');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      parent_agent_id TEXT,
      event_type TEXT NOT NULL,
      session_id TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      user_id TEXT,
      workspace_id TEXT,
      payload TEXT NOT NULL,
      summary TEXT,
      timestamp INTEGER NOT NULL,
      humanInTheLoop TEXT,
      humanInTheLoopStatus TEXT
    )
  `);

  // Migrations: add columns if missing
  try {
    const columns = db.prepare("PRAGMA table_info(events)").all() as any[];
    const colNames = columns.map(c => c.name);
    if (!colNames.includes('parent_agent_id')) db.exec('ALTER TABLE events ADD COLUMN parent_agent_id TEXT');
    if (!colNames.includes('model')) db.exec('ALTER TABLE events ADD COLUMN model TEXT');
    if (!colNames.includes('provider')) db.exec('ALTER TABLE events ADD COLUMN provider TEXT');
    if (!colNames.includes('user_id')) db.exec('ALTER TABLE events ADD COLUMN user_id TEXT');
    if (!colNames.includes('workspace_id')) db.exec('ALTER TABLE events ADD COLUMN workspace_id TEXT');
    if (!colNames.includes('humanInTheLoop')) db.exec('ALTER TABLE events ADD COLUMN humanInTheLoop TEXT');
    if (!colNames.includes('humanInTheLoopStatus')) db.exec('ALTER TABLE events ADD COLUMN humanInTheLoopStatus TEXT');
    if (!colNames.includes('summary')) db.exec('ALTER TABLE events ADD COLUMN summary TEXT');
  } catch {
    // table was just created — no migration needed
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_source ON events(source)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_id ON events(agent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_event_type ON events(event_type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_id ON events(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_model ON events(model)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_provider ON events(provider)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_user_id ON events(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_workspace_id ON events(workspace_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_timestamp ON events(timestamp)');

  // Agent registry — agents as first-class accounts
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      user_id TEXT,
      workspace_id TEXT,
      parent_agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_event_type TEXT,
      last_event_at INTEGER,
      first_seen_at INTEGER NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 1,
      metadata TEXT
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agents_workspace_id ON agents(workspace_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agents_source ON agents(source)');

  // Lobbies
  initLobbies();

  // Migrate: add lobby_id to events if missing
  try {
    const cols = db.prepare("PRAGMA table_info(events)").all() as any[];
    const colNames = cols.map(c => c.name);
    if (!colNames.includes('lobby_id')) db.exec('ALTER TABLE events ADD COLUMN lobby_id TEXT');
  } catch {}
  db.exec('CREATE INDEX IF NOT EXISTS idx_lobby_id ON events(lobby_id)');

  // Canvas objects, members, chat, file activity, and the shared seq counter.
  // Must run last — it backfills seq on the tables created above.
  initSchema(db);
}

/** Current high-water mark of the shared sequence, without consuming one. */
export function getCurrentSeq(): number {
  return currentSeq(db);
}

export function insertEvent(event: AgentEvent): AgentEvent {
  const timestamp = event.timestamp || Date.now();

  let humanInTheLoopStatus = event.humanInTheLoopStatus;
  if (event.humanInTheLoop && !humanInTheLoopStatus) {
    humanInTheLoopStatus = { status: 'pending' };
  }

  // seq and the row are taken in one transaction. Split across two statements a
  // reader can observe the number before the row exists, treat itself as caught
  // up, and permanently skip the event.
  const write = db.transaction(() => {
    const seq = nextSeq(db);
    const result = db.prepare(`
      INSERT INTO events (source, agent_id, parent_agent_id, event_type, session_id, model, provider, user_id, workspace_id, lobby_id, payload, summary, timestamp, seq, humanInTheLoop, humanInTheLoopStatus)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.source,
      event.agent_id,
      event.parent_agent_id || null,
      event.event_type,
      event.session_id,
      event.model || null,
      event.provider || null,
      event.user_id || null,
      event.workspace_id || null,
      event.lobby_id || null,
      JSON.stringify(event.payload),
      event.summary || null,
      timestamp,
      seq,
      event.humanInTheLoop ? JSON.stringify(event.humanInTheLoop) : null,
      humanInTheLoopStatus ? JSON.stringify(humanInTheLoopStatus) : null
    );
    return { id: result.lastInsertRowid as number, seq };
  });

  const { id, seq } = write();

  return { ...event, id, seq, timestamp, humanInTheLoopStatus };
}

export function getFilterOptions(): FilterOptions {
  const sources = db.prepare('SELECT DISTINCT source FROM events ORDER BY source').all() as any[];
  const agentIds = db.prepare('SELECT DISTINCT agent_id FROM events ORDER BY agent_id DESC LIMIT 500').all() as any[];
  const eventTypes = db.prepare('SELECT DISTINCT event_type FROM events ORDER BY event_type').all() as any[];
  const models = db.prepare('SELECT DISTINCT model FROM events WHERE model IS NOT NULL ORDER BY model').all() as any[];
  const providers = db.prepare('SELECT DISTINCT provider FROM events WHERE provider IS NOT NULL ORDER BY provider').all() as any[];
  const sessionIds = db.prepare('SELECT DISTINCT session_id FROM events ORDER BY session_id DESC LIMIT 500').all() as any[];
  const userIds = db.prepare('SELECT DISTINCT user_id FROM events WHERE user_id IS NOT NULL ORDER BY user_id').all() as any[];
  const workspaceIds = db.prepare('SELECT DISTINCT workspace_id FROM events WHERE workspace_id IS NOT NULL ORDER BY workspace_id').all() as any[];

  const lobbyIds = db.prepare('SELECT DISTINCT lobby_id FROM events WHERE lobby_id IS NOT NULL ORDER BY lobby_id').all() as any[];

  return {
    sources: sources.map(r => r.source),
    agent_ids: agentIds.map(r => r.agent_id),
    event_types: eventTypes.map(r => r.event_type),
    models: models.map(r => r.model),
    providers: providers.map(r => r.provider),
    session_ids: sessionIds.map(r => r.session_id),
    user_ids: userIds.map(r => r.user_id),
    workspace_ids: workspaceIds.map(r => r.workspace_id),
    lobby_ids: lobbyIds.map(r => r.lobby_id)
  };
}

const EVENT_COLS = `
  id, source, agent_id, parent_agent_id, event_type, session_id, model, provider,
  user_id, workspace_id, lobby_id, payload, summary, timestamp, seq,
  humanInTheLoop, humanInTheLoopStatus
`;

function hydrateEvent(row: any): AgentEvent {
  return {
    id: row.id,
    source: row.source,
    agent_id: row.agent_id,
    parent_agent_id: row.parent_agent_id || undefined,
    event_type: row.event_type,
    session_id: row.session_id,
    model: row.model || undefined,
    provider: row.provider || undefined,
    user_id: row.user_id || undefined,
    workspace_id: row.workspace_id || undefined,
    lobby_id: row.lobby_id || undefined,
    payload: safeJson(row.payload),
    summary: row.summary || undefined,
    timestamp: row.timestamp,
    seq: row.seq === null ? undefined : row.seq,
    humanInTheLoop: row.humanInTheLoop ? safeJson(row.humanInTheLoop) : undefined,
    humanInTheLoopStatus: row.humanInTheLoopStatus ? safeJson(row.humanInTheLoopStatus) : undefined
  };
}

/** A single malformed payload should degrade one card, never fail the query. */
function safeJson(s: string | null): any {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return { _unparseable: true, raw: String(s).slice(0, 500) }; }
}

/**
 * Ordered by `id`, not `timestamp`. Hooks routinely fire several events inside
 * the same millisecond, and ordering on a colliding timestamp shuffles them.
 */
export function getRecentEvents(limit: number = 300, lobbyId?: string): AgentEvent[] {
  const capped = clampLimit(limit, 2000);
  const where = lobbyId ? 'WHERE lobby_id = ?' : '';
  const params: any[] = lobbyId ? [lobbyId, capped] : [capped];

  const rows = db.prepare(`
    SELECT ${EVENT_COLS} FROM events
    ${where}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params) as any[];

  return rows.map(hydrateEvent).reverse();
}

/**
 * Delta feed. This is how a reconnecting client catches up without gaps or
 * duplicates: it replays strictly above the last seq it actually applied.
 */
export function getEventsSince(since: number, lobbyId?: string, limit = 1000): AgentEvent[] {
  const capped = clampLimit(limit, 2000);
  const where = lobbyId ? 'WHERE seq > ? AND lobby_id = ?' : 'WHERE seq > ?';
  const params: any[] = lobbyId ? [since, lobbyId, capped] : [since, capped];

  const rows = db.prepare(`
    SELECT ${EVENT_COLS} FROM events
    ${where}
    ORDER BY seq ASC
    LIMIT ?
  `).all(...params) as any[];

  return rows.map(hydrateEvent);
}

export function clampLimit(v: any, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return Math.min(300, max);
  return Math.min(Math.floor(n), max);
}

export function updateEventHITLResponse(id: number, response: any): AgentEvent | null {
  const status = {
    status: 'responded',
    respondedAt: response.respondedAt,
    response
  };

  db.prepare('UPDATE events SET humanInTheLoopStatus = ? WHERE id = ?')
    .run(JSON.stringify(status), id);

  // Selects lobby_id along with everything else. The old query omitted it, so
  // the event returned here lost its lobby and the follow-up broadcast could
  // not be routed to the lobby channel.
  const row = db.prepare(`SELECT ${EVENT_COLS} FROM events WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return hydrateEvent(row);
}

export { db };

// --- Agent Registry ---

/**
 * Event types that mean "this agent just finished a turn". Anything else that
 * arrives means it is mid-flight.
 *
 * Status was previously hardcoded to 'active' on every write and nothing ever
 * aged an agent out, so /health's idle and stopped counts were structurally
 * always zero and the work-in-flight lane had no signal to render.
 */
const SETTLED_EVENTS = new Set([
  'turn_end', 'session_end', 'subagent_stop', 'delegation_complete',
]);

export const AGENT_STALE_MS   = 5 * 60 * 1000;
export const AGENT_STOPPED_MS = 30 * 60 * 1000;

export function statusForEvent(eventType: string): 'active' | 'idle' {
  return SETTLED_EVENTS.has(eventType) ? 'idle' : 'active';
}

export function upsertAgent(event: AgentEvent): void {
  const now = event.timestamp || Date.now();
  const existing = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(event.agent_id) as any;

  if (existing) {
    // Update last seen, event count, model/provider if changed
    db.prepare(`
      UPDATE agents SET
        last_event_type = ?,
        last_event_at = ?,
        event_count = event_count + 1,
        status = ?,
        model = COALESCE(?, model),
        provider = COALESCE(?, provider),
        user_id = COALESCE(?, user_id),
        workspace_id = COALESCE(?, workspace_id)
      WHERE agent_id = ?
    `).run(
      event.event_type,
      now,
      statusForEvent(event.event_type),
      event.model || null,
      event.provider || null,
      event.user_id || null,
      event.workspace_id || null,
      event.agent_id
    );
  } else {
    // Register new agent. Status is derived from the event exactly as on the
    // update path — hardcoding 'active' here meant an agent whose very first
    // observed event was a turn_end registered as busy.
    db.prepare(`
      INSERT INTO agents (agent_id, source, model, provider, user_id, workspace_id, parent_agent_id, status, last_event_type, last_event_at, first_seen_at, event_count, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      event.agent_id,
      event.source,
      event.model || null,
      event.provider || null,
      event.user_id || null,
      event.workspace_id || null,
      event.parent_agent_id || null,
      statusForEvent(event.event_type),
      event.event_type,
      now,
      now,
      JSON.stringify({})
    );
  }
}

export interface AgentRecord {
  agent_id: string;
  source: string;
  model?: string;
  provider?: string;
  user_id?: string;
  workspace_id?: string;
  parent_agent_id?: string;
  status: string;
  last_event_type?: string;
  last_event_at?: number;
  first_seen_at: number;
  event_count: number;
  metadata?: Record<string, any>;
}

export function getAgents(filter?: { source?: string; user_id?: string; workspace_id?: string; status?: string }): AgentRecord[] {
  let sql = 'SELECT * FROM agents WHERE 1=1';
  const params: any[] = [];

  if (filter?.source) { sql += ' AND source = ?'; params.push(filter.source); }
  if (filter?.user_id) { sql += ' AND user_id = ?'; params.push(filter.user_id); }
  if (filter?.workspace_id) { sql += ' AND workspace_id = ?'; params.push(filter.workspace_id); }
  if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status); }

  sql += ' ORDER BY last_event_at DESC';

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(row => ({
    ...row,
    model: row.model || undefined,
    provider: row.provider || undefined,
    user_id: row.user_id || undefined,
    workspace_id: row.workspace_id || undefined,
    parent_agent_id: row.parent_agent_id || undefined,
    last_event_type: row.last_event_type || undefined,
    last_event_at: row.last_event_at || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  }));
}

export function getAgent(agentId: string): AgentRecord | null {
  const row = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as any;
  if (!row) return null;
  return {
    ...row,
    model: row.model || undefined,
    provider: row.provider || undefined,
    user_id: row.user_id || undefined,
    workspace_id: row.workspace_id || undefined,
    parent_agent_id: row.parent_agent_id || undefined,
    last_event_type: row.last_event_type || undefined,
    last_event_at: row.last_event_at || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

export function updateAgentStatus(agentId: string, status: string): boolean {
  const result = db.prepare('UPDATE agents SET status = ? WHERE agent_id = ?').run(status, agentId);
  return result.changes > 0;
}

/**
 * Age agents out by silence. An agent that crashed, or whose terminal was
 * closed, never sends a closing event — without this sweep it shows as busy
 * forever and the work-in-flight lane lies.
 *
 * Returns only the agents whose status actually changed, so the caller
 * broadcasts a handful of rows rather than the whole registry every tick.
 */
export function sweepAgentStatuses(now: number = Date.now()): AgentRecord[] {
  const changed: AgentRecord[] = [];

  const demote = (from: string[], to: string, olderThanMs: number) => {
    const cutoff = now - olderThanMs;
    const rows = db.prepare(`
      SELECT agent_id FROM agents
      WHERE status IN (${from.map(() => '?').join(',')})
        AND last_event_at IS NOT NULL AND last_event_at < ?
    `).all(...from, cutoff) as any[];

    for (const r of rows) {
      db.prepare('UPDATE agents SET status = ? WHERE agent_id = ?').run(to, r.agent_id);
      const rec = getAgent(r.agent_id);
      if (rec) changed.push(rec);
    }
  };

  // Order matters: stopped is checked first so a long-silent agent lands on
  // 'stopped' directly instead of being demoted twice across two sweeps.
  demote(['active', 'idle', 'stale'], 'stopped', AGENT_STOPPED_MS);
  demote(['active', 'idle'],          'stale',   AGENT_STALE_MS);

  return changed;
}

// --- Lobbies ---

export function initLobbies(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lobbies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      created_by TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_lobbies_code ON lobbies(code)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_lobbies_visibility ON lobbies(visibility)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS lobby_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lobby_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      source TEXT,
      joined_at INTEGER NOT NULL,
      UNIQUE(lobby_id, agent_id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_lobby_members_lobby_id ON lobby_members(lobby_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_lobby_members_agent_id ON lobby_members(agent_id)');
}

export function createLobby(name: string, visibility: string, createdBy: string): any {
  const code = generateLobbyCode();
  const now = Date.now();
  db.prepare('INSERT INTO lobbies (code, name, visibility, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(code, name, visibility, createdBy, now);
  const row = db.prepare('SELECT * FROM lobbies WHERE code = ?').get(code) as any;
  return { ...row, members: [] };
}

export function getLobby(code: string): any | null {
  const row = db.prepare('SELECT * FROM lobbies WHERE code = ?').get(code) as any;
  if (!row) return null;
  const members = db.prepare('SELECT * FROM lobby_members WHERE lobby_id = ?').all(row.id) as any[];
  return { ...row, members };
}

export function listLobbies(): any[] {
  const rows = db.prepare("SELECT * FROM lobbies WHERE visibility IN ('public', 'unlisted') ORDER BY created_at DESC").all() as any[];
  return rows.map(row => {
    const members = db.prepare('SELECT * FROM lobby_members WHERE lobby_id = ?').all(row.id) as any[];
    return { ...row, members };
  });
}

export function joinLobby(code: string, userId: string, agentId: string, source: string): any | null {
  const lobby = db.prepare('SELECT * FROM lobbies WHERE code = ?').get(code) as any;
  if (!lobby) return null;
  const now = Date.now();
  try {
    db.prepare('INSERT INTO lobby_members (lobby_id, user_id, agent_id, source, joined_at) VALUES (?, ?, ?, ?, ?)').run(lobby.id, userId, agentId, source, now);
  } catch {
    // Already a member — that's fine
  }
  return getLobby(code);
}

export function leaveLobby(code: string, agentId: string): boolean {
  const lobby = db.prepare('SELECT * FROM lobbies WHERE code = ?').get(code) as any;
  if (!lobby) return false;
  const result = db.prepare('DELETE FROM lobby_members WHERE lobby_id = ? AND agent_id = ?').run(lobby.id, agentId);
  return result.changes > 0;
}

/**
 * An agent may belong to several lobbies. The previous query took whichever row
 * SQLite happened to return first, so auto-tagging picked a lobby arbitrarily
 * and could silently flip between them. Most recent join wins, deterministically.
 */
export function getLobbyByAgent(agentId: string): any | null {
  const member = db.prepare(
    'SELECT lobby_id FROM lobby_members WHERE agent_id = ? ORDER BY joined_at DESC, id DESC LIMIT 1'
  ).get(agentId) as any;
  if (!member) return null;
  return db.prepare('SELECT * FROM lobbies WHERE id = ?').get(member.lobby_id) as any || null;
}

export function getLobbyMembers(lobbyId: number): any[] {
  return db.prepare('SELECT * FROM lobby_members WHERE lobby_id = ?').all(lobbyId) as any[];
}

export function deleteLobby(code: string): boolean {
  const lobby = db.prepare('SELECT id FROM lobbies WHERE code = ?').get(code) as any;
  if (!lobby) return false;
  db.prepare('DELETE FROM lobby_members WHERE lobby_id = ?').run(lobby.id);
  db.prepare('DELETE FROM lobbies WHERE id = ?').run(lobby.id);
  return true;
}

/**
 * Invite codes are credentials — anyone holding one can ask to join. They were
 * generated with Math.random(), which is predictable; a 6-character code from a
 * predictable source is not a secret. Now crypto-random, with a bounded retry
 * so a collision cannot recurse without limit.
 */
function generateLobbyCode(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateJoinCode();
    const existing = db.prepare('SELECT code FROM lobbies WHERE code = ?').get(code) as any;
    if (!existing) return code;
  }
  throw new Error('Could not allocate a unique lobby code');
}

// ===== PRESENCE =====

export function initPresence(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS presence (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      color TEXT NOT NULL,
      online INTEGER NOT NULL DEFAULT 1,
      last_seen INTEGER NOT NULL,
      current_lobby TEXT,
      current_view TEXT,
      cursor_x REAL,
      cursor_y REAL
    )
  `);
}

export function upsertPresence(user: { user_id: string; display_name: string; color: string; online?: boolean; current_lobby?: string; current_view?: string; cursor_position?: { x: number; y: number } }): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO presence (user_id, display_name, color, online, last_seen, current_lobby, current_view, cursor_x, cursor_y)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name,
      color = excluded.color,
      online = excluded.online,
      last_seen = excluded.last_seen,
      current_lobby = excluded.current_lobby,
      current_view = excluded.current_view,
      cursor_x = excluded.cursor_x,
      cursor_y = excluded.cursor_y
  `).run(
    user.user_id, user.display_name, user.color,
    user.online !== false ? 1 : 0, now,
    user.current_lobby || null, user.current_view || null,
    // Cursor deliberately NOT persisted. It used to be written here on every
    // update, which is a SQLite write at cursor frequency (20-30Hz per user).
    // Cursors now ride the ephemeral WebSocket channel and touch no database.
    // The columns stay so old rows still read; they are never written again.
    null, null
  );
}

export function getOnlineUsers(): any[] {
  return db.prepare("SELECT * FROM presence WHERE online = 1 AND last_seen > ?").all(Date.now() - 60000) as any[];
}

export function getLobbyPresence(lobbyCode: string): any[] {
  return db.prepare("SELECT * FROM presence WHERE current_lobby = ? AND online = 1 AND last_seen > ?").all(lobbyCode, Date.now() - 60000) as any[];
}

export function heartbeatPresence(userId: string): void {
  db.prepare("UPDATE presence SET last_seen = ?, online = 1 WHERE user_id = ?").run(Date.now(), userId);
}

// ===== ANNOTATIONS =====

export function initAnnotations(): void {
  // The full modern shape, not the 2026-era five columns.
  //
  // This runs AFTER initSchema (see initDatabase), so a brand-new database used
  // to end up with the legacy table and never receive the generalising ALTERs —
  // the migration only touches tables that already exist. Result: board pins
  // worked on a database that had been through the upgrade and silently failed
  // on a fresh one, which is exactly backwards from what testing catches.
  // Declaring the columns here makes both paths land in the same place.
  //
  // `event_id` stays NOT NULL for compatibility with the old rows; non-event
  // targets store 0 and read their identity from target_type/target_id. See
  // annotations.ts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS annotations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id      INTEGER NOT NULL,
      user_id       TEXT NOT NULL,
      text          TEXT NOT NULL,
      timestamp     INTEGER NOT NULL,
      lobby_id      TEXT,
      target_type   TEXT NOT NULL DEFAULT 'event',
      target_id     TEXT,
      anchor_x      REAL,
      anchor_y      REAL,
      thread_parent INTEGER,
      resolved      INTEGER NOT NULL DEFAULT 0,
      deleted       INTEGER NOT NULL DEFAULT 0,
      seq           INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ann_lobby_seq ON annotations(lobby_id, seq)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ann_target    ON annotations(target_type, target_id)');
}

export function addAnnotation(eventId: number, userId: string, text: string, lobbyId?: string): any {
  const now = Date.now();
  // Stamped with target_type and a seq like every other write, so a row created
  // through the legacy path is still visible to the delta queries.
  const seq = nextSeq(db);
  const result = db.prepare(
    `INSERT INTO annotations (event_id, user_id, text, timestamp, lobby_id, target_type, target_id, seq)
     VALUES (?, ?, ?, ?, ?, 'event', ?, ?)`
  ).run(eventId, userId, text, now, lobbyId || null, String(eventId), seq);
  return { id: result.lastInsertRowid, event_id: eventId, user_id: userId, text, timestamp: now, lobby_id: lobbyId, target_type: 'event', target_id: String(eventId), seq };
}

export function getAnnotations(eventId: number): any[] {
  return db.prepare('SELECT * FROM annotations WHERE event_id = ? ORDER BY timestamp ASC').all(eventId) as any[];
}

export function getLobbyAnnotations(lobbyCode: string, limit: number = 50): any[] {
  return db.prepare('SELECT * FROM annotations WHERE lobby_id = ? ORDER BY timestamp DESC LIMIT ?').all(lobbyCode, limit) as any[];
}

// ===== CANVAS SYNC =====

export function initCanvasSync(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_positions (
      agent_id TEXT PRIMARY KEY,
      x REAL NOT NULL,
      y REAL NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

export function updateNodePosition(agentId: string, x: number, y: number, updatedBy: string): void {
  db.prepare(`
    INSERT INTO canvas_positions (agent_id, x, y, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET x = excluded.x, y = excluded.y, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(agentId, x, y, updatedBy, Date.now());
}

export function getNodePositions(): any[] {
  return db.prepare('SELECT * FROM canvas_positions').all() as any[];
}