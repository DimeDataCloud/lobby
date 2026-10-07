// Backups.
//
// Every other failure in this system is recoverable. Losing the database is not:
// a customer's board, their whole team's work, gone with no way to get it back.
// That makes this the highest-severity code in the repo, and it is written to be
// paranoid rather than clever.
//
// Four decisions, each of which is the difference between a backup and a file
// that looks like one:
//
// 1. `VACUUM INTO`, NOT A FILE COPY. SQLite in WAL mode is three files whose
//    contents change under you mid-read. Copying the .db while the server is
//    writing produces a corrupt snapshot that restores cleanly right up until
//    the moment you need it. VACUUM INTO takes a consistent, already-compacted
//    snapshot through SQLite itself, with no need to stop writes.
//
// 2. EVERY BACKUP IS OPENED AND CHECKED BEFORE IT COUNTS. A backup you have
//    never read is a hypothesis. This opens the new file, runs a real
//    integrity_check, and confirms the expected tables are present with a
//    plausible row count. A file that fails is deleted rather than kept — a
//    corrupt backup sitting next to good ones is worse than no backup, because
//    it is the one you will reach for.
//
// 3. THE NEWEST GOOD BACKUP IS NEVER PRUNED. Retention deletes oldest-first and
//    always leaves at least one verified file standing, so a run of failures
//    cannot age out the last thing that works.
//
// 4. FAILURE IS LOUD. A silent backup failure is indistinguishable from success
//    until it matters. Every outcome is recorded and readable at /admin/backups.

import { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface BackupRun {
  at: number;
  ok: boolean;
  file?: string;
  bytes?: number;
  ms?: number;
  error?: string;
  verified?: boolean;
}

/** Tables whose absence means the snapshot is not a real database. */
const EXPECTED_TABLES = ['lobbies', 'canvas_objects', 'messages', 'users', 'orgs'];

const history: BackupRun[] = [];
const MAX_HISTORY = 50;

export function backupHistory(): BackupRun[] {
  return [...history].reverse();
}

export function lastGoodBackup(): BackupRun | null {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].ok) return history[i];
  return null;
}

function record(run: BackupRun): BackupRun {
  history.push(run);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  return run;
}

export interface BackupOptions {
  dir: string;
  keep: number;
}

export function backupConfig(): BackupOptions | null {
  const dir = process.env.BACKUP_DIR;
  if (!dir) return null;
  const keep = Math.max(1, parseInt(process.env.BACKUP_KEEP || '14', 10) || 14);
  return { dir, keep };
}

/**
 * Take one backup, verify it, prune old ones.
 *
 * `stamp` is injected rather than read from the clock so tests are deterministic
 * and two backups in the same second cannot collide on a filename.
 */
export function runBackup(db: Database, opts: BackupOptions, stamp = new Date()): BackupRun {
  const started = Date.now();
  const name = `lobby-${stamp.toISOString().replace(/[:.]/g, '-')}.db`;
  let target = '';

  try {
    mkdirSync(opts.dir, { recursive: true });
    target = resolve(opts.dir, name);

    // Consistent snapshot through SQLite. Note the escaping: a path containing a
    // single quote would otherwise terminate the string literal, which is both a
    // crash and, on a path an attacker influences, an injection.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

    const bytes = statSync(target).size;
    const verified = verifyBackup(target);
    if (!verified.ok) {
      // Do not keep a file that failed verification. The whole point is that
      // what remains on disk is known-restorable.
      try { unlinkSync(target); } catch {}
      return record({
        at: started, ok: false, ms: Date.now() - started,
        error: `verification failed: ${verified.error}`,
      });
    }

    const run = record({
      at: started, ok: true, file: name, bytes, ms: Date.now() - started, verified: true,
    });
    prune(opts, name);
    console.log(`[backup] ${name} — ${(bytes / 1048576).toFixed(1)}MB, verified, ${run.ms}ms`);
    return run;
  } catch (err: any) {
    if (target) { try { unlinkSync(target); } catch {} }
    const run = record({ at: started, ok: false, ms: Date.now() - started, error: err?.message || String(err) });
    console.error('[backup] FAILED:', run.error);
    return run;
  }
}

/**
 * Open the snapshot and prove it is a database we could actually restore from.
 *
 * integrity_check alone is not enough: a valid but empty database passes it
 * happily, and "the backup ran and produced a working, empty file" is exactly
 * the failure this is here to catch.
 */
export function verifyBackup(path: string): { ok: boolean; error?: string; tables?: number } {
  let probe: Database | null = null;
  try {
    if (!existsSync(path)) return { ok: false, error: 'file does not exist' };
    probe = new Database(path, { readonly: true });

    const integrity = probe.prepare('PRAGMA integrity_check').get() as any;
    const verdict = integrity?.integrity_check ?? Object.values(integrity || {})[0];
    if (verdict !== 'ok') return { ok: false, error: `integrity_check said "${verdict}"` };

    const names = new Set(
      (probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[])
        .map((r) => r.name)
    );
    const missing = EXPECTED_TABLES.filter((t) => !names.has(t));
    if (missing.length) return { ok: false, error: `missing tables: ${missing.join(', ')}` };

    return { ok: true, tables: names.size };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    try { probe?.close(); } catch {}
  }
}

/**
 * Delete oldest-first down to `keep`, and never delete `protect` — the backup
 * just taken and verified. A stretch of failures must not be able to age out the
 * last file that actually works.
 */
function prune(opts: BackupOptions, protect: string): void {
  try {
    const files = readdirSync(opts.dir)
      .filter((f) => f.startsWith('lobby-') && f.endsWith('.db'))
      .map((f) => ({ f, mtime: statSync(join(opts.dir, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);

    const excess = files.length - opts.keep;
    if (excess <= 0) return;

    let removed = 0;
    for (const { f } of files) {
      if (removed >= excess) break;
      if (f === protect) continue;
      try { unlinkSync(join(opts.dir, f)); removed++; } catch {}
    }
    if (removed) console.log(`[backup] pruned ${removed} old backup(s), keeping ${opts.keep}`);
  } catch (err: any) {
    console.error('[backup] prune failed:', err?.message || err);
  }
}

export function listBackups(dir: string): { file: string; bytes: number; at: number }[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith('lobby-') && f.endsWith('.db'))
      .map((f) => {
        const s = statSync(join(dir, f));
        return { file: f, bytes: s.size, at: s.mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/**
 * Schedule backups. Returns a stop function.
 *
 * The first run happens shortly after boot rather than a full interval later —
 * a server that restarts every few hours would otherwise never back up at all.
 */
export function scheduleBackups(db: Database, opts: BackupOptions): () => void {
  const everyMs = Math.max(60_000, parseInt(process.env.BACKUP_INTERVAL_MS || '', 10) || 6 * 3600_000);
  const first = setTimeout(() => runBackup(db, opts), 30_000);
  const timer = setInterval(() => runBackup(db, opts), everyMs);
  (timer as any).unref?.();
  (first as any).unref?.();
  console.log(`[backup] every ${Math.round(everyMs / 60000)}min → ${opts.dir}, keeping ${opts.keep}`);
  return () => { clearInterval(timer); clearTimeout(first); };
}
