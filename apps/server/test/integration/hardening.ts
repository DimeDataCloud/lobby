// Backups, rate limiting and the audit log, against a real server.
//
//   bun run apps/server/test/integration/hardening.ts
//
// These are the three things a security review asks about and the three whose
// failure modes are silent. A backup nobody has restored, a rate limit nobody
// has tripped, and an audit log nobody has read are all indistinguishable from
// not having them — so each one here is exercised for real, including the
// restore.

import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { rmSync, mkdirSync, readdirSync, writeFileSync, statSync } from 'fs';
import { Database } from 'bun:sqlite';

const PORT = 4777;
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const dbPath = join(tmpdir(), `lobby-harden-${stamp}.db`);
const backupDir = join(tmpdir(), `lobby-backups-${stamp}`);
const ADMIN_KEY = 'test-admin-key-do-not-ship';
const entry = resolve(import.meta.dir, '../../src/index.ts');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
  if (!ok) failures++;
};
const section = (s: string) => console.log('\n=== ' + s + ' ===');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

mkdirSync(backupDir, { recursive: true });

const proc = Bun.spawn(['bun', 'run', entry], {
  env: {
    ...process.env,
    SERVER_PORT: String(PORT),
    DB_PATH: dbPath,
    REQUIRE_AUTH: 'true',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    PUBLIC_ORIGIN: BASE,
    BACKUP_DIR: backupDir,
    BACKUP_INTERVAL_MS: '60000',
    ADMIN_KEY,
    TRUST_PROXY: '1',
  },
  stdout: 'pipe',
  stderr: 'pipe',
});

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}
function cleanup() {
  try { proc.kill(); } catch {}
  for (const s of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + s, { force: true }); } catch {}
  }
  try { rmSync(backupDir, { recursive: true, force: true }); } catch {}
}

const api = (path: string, init: RequestInit = {}, cookie?: string) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: `lobby_session=${cookie}` } : {}),
      ...(init.headers || {}),
    },
  });
const post = (p: string, b: any, c?: string) =>
  api(p, { method: 'POST', body: JSON.stringify(b) }, c);

try {
  if (!(await waitForServer())) {
    console.error('server did not start');
    console.error(await new Response(proc.stderr).text());
    cleanup();
    process.exit(1);
  }

  // A signed-in owner, the way a finished OAuth callback leaves things.
  const sdb = new Database(dbPath);
  const { createHash, randomBytes } = await import('node:crypto');
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
  const uid = `usr_${randomBytes(8).toString('hex')}`;
  const orgId = `org_${randomBytes(8).toString('hex')}`;
  const sessTok = `lbs_${randomBytes(32).toString('base64url')}`;
  const now = Date.now();
  sdb.prepare(`INSERT INTO users (id,email,name,avatar_url,provider,provider_subject,created_at,last_seen)
               VALUES (?,?,?,?,?,?,?,?)`)
    .run(uid, 'owner@example.test', 'owner', null, 'github', `gh-${stamp}`, now, now);
  sdb.prepare('INSERT INTO orgs (id,name,plan,seat_limit,owner_user_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(orgId, 'Acme', 'organization', 5, uid, now);
  sdb.prepare('INSERT INTO org_members (org_id,user_id,role,seat_active,joined_at) VALUES (?,?,?,1,?)')
    .run(orgId, uid, 'owner', now);
  sdb.prepare('INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
    .run(`ses_${randomBytes(8).toString('hex')}`, uid, sha256(sessTok), now, now + 3600_000);

  // ---------------------------------------------------------------- AUDIT ---
  section('audit log records what happened');
  const ws = await (await post('/lobbies', { name: 'audited-room', org_id: orgId }, sessTok)).json();
  check('workspace created', !!ws.code, JSON.stringify(ws).slice(0, 120));

  const auditRes = await api(`/orgs/${orgId}/audit`, {}, sessTok);
  const auditBody = await auditRes.json();
  check('owner can read the audit log', auditRes.status === 200, `HTTP ${auditRes.status}`);
  const created = (auditBody.entries || []).find((e: any) => e.action === 'workspace.create');
  check('workspace creation was recorded', !!created, JSON.stringify(auditBody.entries?.[0] || {}).slice(0, 140));
  check('it names the actor and the target',
    created?.actor === uid && created?.target === ws.code);
  check('and reports a retention window', Number(auditBody.retention_days) >= 30);

  section('deletion is recorded before the row disappears');
  await api(`/lobbies/${ws.code}`, { method: 'DELETE' }, sessTok);
  const afterDelete = await (await api(`/orgs/${orgId}/audit`, {}, sessTok)).json();
  const del = (afterDelete.entries || []).find((e: any) => e.action === 'workspace.delete');
  check('workspace deletion was recorded', !!del);
  check('and still knows the name of what was deleted',
    typeof del?.detail === 'string' && del.detail.includes('audited-room'), String(del?.detail));

  section('the audit log is org-scoped and privilege-scoped');
  const outsiderTok = `lbs_${randomBytes(32).toString('base64url')}`;
  const outsider = `usr_${randomBytes(8).toString('hex')}`;
  sdb.prepare(`INSERT INTO users (id,email,name,avatar_url,provider,provider_subject,created_at,last_seen)
               VALUES (?,?,?,?,?,?,?,?)`)
    .run(outsider, 'x@example.test', 'outsider', null, 'github', `gh-out-${stamp}`, now, now);
  sdb.prepare('INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
    .run(`ses_${randomBytes(8).toString('hex')}`, outsider, sha256(outsiderTok), now, now + 3600_000);
  check("an outsider gets 404, not someone else's history",
    (await api(`/orgs/${orgId}/audit`, {}, outsiderTok)).status === 404);
  check('an anonymous caller is refused',
    (await api(`/orgs/${orgId}/audit`)).status === 401);

  // -------------------------------------------------------------- BACKUPS ---
  section('backups');
  const adminHdr = { Authorization: `Bearer ${ADMIN_KEY}` };
  check('the backup endpoint is hidden without the key',
    (await api('/admin/backups')).status === 404);
  check('and with a wrong key',
    (await api('/admin/backups', { headers: { Authorization: 'Bearer wrong' } })).status === 404);

  const st = await (await api('/admin/backups', { headers: adminHdr })).json();
  check('backups are configured', st.configured === true, JSON.stringify(st).slice(0, 120));

  // Wait for the boot backup (scheduled ~30s in) rather than reaching into the
  // module: this asserts the thing that actually protects customer data.
  let onDisk: any[] = [];
  for (let i = 0; i < 50; i++) {
    const s = await (await api('/admin/backups', { headers: adminHdr })).json();
    onDisk = s.on_disk || [];
    if (onDisk.length) break;
    await sleep(1000);
  }
  check('a backup was taken', onDisk.length > 0, `${onDisk.length} file(s)`);
  check('and it is not empty', (onDisk[0]?.bytes || 0) > 10_000, `${onDisk[0]?.bytes} bytes`);

  const history = (await (await api('/admin/backups', { headers: adminHdr })).json()).history || [];
  check('the run was verified, not just written',
    history.some((h: any) => h.ok && h.verified === true), JSON.stringify(history[0] || {}));

  section('a backup actually restores');
  const backupFile = join(backupDir, onDisk[0].file);
  const restored = new Database(backupFile, { readonly: true });
  const integrity: any = restored.prepare('PRAGMA integrity_check').get();
  check('restored copy passes integrity_check',
    (integrity?.integrity_check ?? Object.values(integrity)[0]) === 'ok');
  const tables = (restored.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[])
    .map((r) => r.name);
  for (const t of ['lobbies', 'canvas_objects', 'users', 'orgs', 'audit_log']) {
    check(`restored copy has ${t}`, tables.includes(t));
  }
  const auditRows = restored.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as any;
  check('and the audit history survived the round trip', Number(auditRows.n) > 0, `${auditRows.n} rows`);
  restored.close();

  section('a corrupt snapshot is rejected rather than kept');
  const { verifyBackup } = await import('../../src/backup');
  const junk = join(backupDir, 'lobby-corrupt.db');
  writeFileSync(junk, 'this is not a database');
  const v = verifyBackup(junk);
  check('garbage fails verification', v.ok === false, v.error);
  const emptyPath = join(backupDir, 'lobby-empty.db');
  const empty = new Database(emptyPath); empty.exec('CREATE TABLE t (x)'); empty.close();
  const ve = verifyBackup(emptyPath);
  check('a valid but wrong database also fails — integrity_check alone is not enough',
    ve.ok === false, ve.error);
  // Windows keeps a handle on a just-closed SQLite file for a moment. These are
  // scratch files inside a directory the finally block removes anyway, so a
  // failure to unlink them here is not a test result.
  for (const f of [junk, emptyPath, emptyPath + '-wal', emptyPath + '-shm']) {
    try { rmSync(f, { force: true }); } catch {}
  }

  // --------------------------------------------------------- RATE LIMITING ---
  section('rate limiting');
  // Auth bucket is the tightest (10 burst), and each caller IP gets its own.
  let limited = 0;
  let firstRetryAfter: string | null = null;
  for (let i = 0; i < 25; i++) {
    const r = await api('/auth/providers', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
    if (r.status === 429) {
      limited++;
      firstRetryAfter ??= r.headers.get('retry-after');
    }
  }
  check('a burst on the auth bucket gets throttled', limited > 0, `${limited}/25 refused`);
  check('and the 429 says when to come back', !!firstRetryAfter, `Retry-After: ${firstRetryAfter}`);

  section('one caller cannot throttle everybody else');
  const other = await api('/auth/providers', { headers: { 'X-Forwarded-For': '198.51.100.4' } });
  check('a different caller is unaffected', other.status === 200, `HTTP ${other.status}`);

  section('health checks are never rate limited');
  let healthOk = 0;
  for (let i = 0; i < 40; i++) {
    if ((await fetch(`${BASE}/health`, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).ok) healthOk++;
  }
  check('monitoring keeps working under a burst', healthOk === 40, `${healthOk}/40`);

  section('an enormous request body is refused before it is buffered');
  // Measured before this limit existed: a 60MB POST was accepted in 0.9s. On a
  // 512MB container a few concurrent ones exhaust the process and take every
  // customer's board down with it. `await req.json()` buffers the whole body
  // first, so the refusal has to happen before any handler touches it.
  {
    const started = Date.now();
    const r = await fetch(`${BASE}/lobbies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.77' },
      body: JSON.stringify({ name: 'A'.repeat(4 * 1024 * 1024), visibility: 'private' }),
    });
    const ms = Date.now() - started;
    check('a 4MB body is refused', r.status === 413, `HTTP ${r.status}`);
    const body = await r.json().catch(() => ({}));
    check('and it says what the limit is', typeof body.limit_bytes === 'number',
      JSON.stringify(body).slice(0, 90));
    // Rejecting fast is the point — a slow rejection means it buffered anyway.
    check('refused quickly, not after buffering', ms < 3000, `${ms}ms`);
  }

  section('but a legitimately large artifact still posts');
  {
    const room = await (await api('/lobbies', {
      method: 'POST',
      body: JSON.stringify({ name: 'big artifact', visibility: 'private' }),
    })).json();
    // 24_000 is MAX_BODY in agent.ts: the largest artifact the product accepts.
    const r = await fetch(`${BASE}/lobbies/${room.code}/agent/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${room.token}` },
      body: JSON.stringify({ kind: 'doc', title: 'at the artifact limit', body: 'x'.repeat(24_000) }),
    });
    check('a 24KB artifact body is accepted', r.ok, `HTTP ${r.status}`);
  }

  sdb.close();
  console.log('\n=== verdict ===');
  console.log(failures === 0 ? 'PASS' : `FAIL — ${failures} check(s)`);
} finally {
  cleanup();
}

process.exit(failures === 0 ? 0 : 1);
