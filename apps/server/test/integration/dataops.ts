// Export and deletion, against a real server.
//
//   bun run apps/server/test/integration/dataops.ts
//
// The deletion tests query the database directly afterwards rather than trusting
// the API's own report. "We deleted it" checked against the thing that reported
// deleting it is not a test — the failure this catches is content surviving in a
// table nobody remembered, which an API response would happily not mention.

import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { rmSync } from 'fs';
import { Database } from 'bun:sqlite';

const PORT = 4779;
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const dbPath = join(tmpdir(), `lobby-dataops-${stamp}.db`);
const entry = resolve(import.meta.dir, '../../src/index.ts');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
  if (!ok) failures++;
};
const section = (s: string) => console.log('\n=== ' + s + ' ===');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const proc = Bun.spawn(['bun', 'run', entry], {
  env: {
    ...process.env,
    SERVER_PORT: String(PORT),
    DB_PATH: dbPath,
    REQUIRE_AUTH: 'true',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    PUBLIC_ORIGIN: BASE,
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

  const sdb = new Database(dbPath);
  const { createHash, randomBytes } = await import('node:crypto');
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
  const now = Date.now();

  function makeUser(name: string) {
    const uid = `usr_${randomBytes(8).toString('hex')}`;
    const orgId = `org_${randomBytes(8).toString('hex')}`;
    const tok = `lbs_${randomBytes(32).toString('base64url')}`;
    sdb.prepare(`INSERT INTO users (id,email,name,avatar_url,provider,provider_subject,created_at,last_seen)
                 VALUES (?,?,?,?,?,?,?,?)`)
      .run(uid, `${name}@example.test`, name, null, 'github', `gh-${name}-${stamp}`, now, now);
    sdb.prepare('INSERT INTO orgs (id,name,plan,seat_limit,owner_user_id,created_at) VALUES (?,?,?,?,?,?)')
      .run(orgId, `${name} Ltd`, 'organization', 5, uid, now);
    sdb.prepare('INSERT INTO org_members (org_id,user_id,role,seat_active,joined_at) VALUES (?,?,?,1,?)')
      .run(orgId, uid, 'owner', now);
    sdb.prepare('INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
      .run(`ses_${randomBytes(8).toString('hex')}`, uid, sha256(tok), now, now + 3600_000);
    return { uid, orgId, tok };
  }

  const owner = makeUser('alice');
  const other = makeUser('mallory');

  // A room with something in every table we care about.
  const ws = await (await post('/lobbies', { name: 'export-me', org_id: owner.orgId }, owner.tok)).json();
  const CODE = ws.code;
  await post(`/lobbies/${CODE}/agent/post`, { kind: 'diff', title: 'a change', body: 'diff --git' }, owner.tok);
  await post(`/lobbies/${CODE}/agent/post`, { kind: 'doc', title: 'a document', body: 'words' }, owner.tok);
  await post(`/lobbies/${CODE}/messages`, { body: 'hello team' }, owner.tok);
  await post(`/lobbies/${CODE}/annotations`, { text: 'look at this', target_type: 'point', anchor_x: 5, anchor_y: 5 }, owner.tok);
  await post('/events', {
    source: 'claude-code', agent_id: 'a1', event_type: 'code_fixed', session_id: 's1',
    lobby_id: CODE, payload: { file: 'x.ts' }, timestamp: Date.now(),
  });

  section('export');
  const res = await api(`/lobbies/${CODE}/export`, {}, owner.tok);
  const data = await res.json();
  check('owner can export', res.status === 200, `HTTP ${res.status}`);
  check('it is a versioned format', data.format === 'lobby.workspace.v1', String(data.format));
  check('it downloads as a file',
    (res.headers.get('content-disposition') || '').includes(`lobby-${CODE}.json`),
    String(res.headers.get('content-disposition')));
  check('artifacts came out', data.counts?.artifacts >= 2, JSON.stringify(data.counts));
  check('chat came out', data.counts?.messages >= 1);
  check('pins came out', data.counts?.annotations >= 1);
  check('the roster came out', data.counts?.members >= 1);

  section('an export is a document, not escaped documents');
  const artifact = (data.artifacts || []).find((a: any) => a.props?.title);
  check('props is parsed JSON, not a string',
    !!artifact && typeof artifact.props === 'object', typeof artifact?.props);

  section('an export never carries live credentials');
  const raw = JSON.stringify(data);
  check('no member token hashes', !raw.includes('token_hash') && !/\$argon2/.test(raw));
  check('no token prefixes', !raw.includes('token_prefix'));
  check('no session material', !raw.includes('lbs_'));

  section('export is owner-only and org-scoped');
  check("another org's owner cannot export this room",
    (await api(`/lobbies/${CODE}/export`, {}, other.tok)).status === 404);
  check('an anonymous caller cannot export',
    (await api(`/lobbies/${CODE}/export`)).status === 404);

  section('deleting a workspace removes its content, not just its row');
  const before = {
    objects: (sdb.prepare('SELECT COUNT(*) n FROM canvas_objects WHERE lobby_id = ?').get(CODE) as any).n,
    messages: (sdb.prepare('SELECT COUNT(*) n FROM messages WHERE lobby_id = ?').get(CODE) as any).n,
    annotations: (sdb.prepare('SELECT COUNT(*) n FROM annotations WHERE lobby_id = ?').get(CODE) as any).n,
    members: (sdb.prepare('SELECT COUNT(*) n FROM members WHERE lobby_id = ?').get(CODE) as any).n,
  };
  check('the room had content to lose', before.objects > 0 && before.messages > 0 && before.members > 0,
    JSON.stringify(before));

  check('delete succeeds', (await api(`/lobbies/${CODE}`, { method: 'DELETE' }, owner.tok)).status === 200);

  // Queried straight from the database, not from the API that just claimed to
  // have deleted it.
  for (const [table, col] of [
    ['canvas_objects', 'lobby_id'], ['messages', 'lobby_id'],
    ['annotations', 'lobby_id'], ['members', 'lobby_id'], ['events', 'lobby_id'],
  ] as const) {
    const n = (sdb.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${col} = ?`).get(CODE) as any).n;
    check(`${table} is empty afterwards`, Number(n) === 0, `${n} rows left`);
  }
  check('and the member token hashes are gone with it',
    Number((sdb.prepare('SELECT COUNT(*) n FROM members WHERE lobby_id = ?').get(CODE) as any).n) === 0);

  section('deleting an organisation');
  const room1 = await (await post('/lobbies', { name: 'r1', org_id: owner.orgId }, owner.tok)).json();
  const room2 = await (await post('/lobbies', { name: 'r2', org_id: owner.orgId }, owner.tok)).json();
  await post(`/lobbies/${room1.code}/agent/post`, { kind: 'doc', title: 'in room one' }, owner.tok);
  await post(`/lobbies/${room2.code}/messages`, { body: 'in room two' }, owner.tok);

  const preview = await (await api(`/orgs/${owner.orgId}/deletion-preview`, {}, owner.tok)).json();
  check('a preview says what would go', preview.would_delete?.workspaces === 2,
    JSON.stringify(preview.would_delete));

  section('deletion demands confirmation');
  const noConfirm = await api(`/orgs/${owner.orgId}`, { method: 'DELETE', body: '{}' }, owner.tok);
  const noConfirmBody = await noConfirm.json();
  check('a bare DELETE is refused', noConfirm.status === 400, `HTTP ${noConfirm.status}`);
  check('and it tells you exactly what to send', noConfirmBody.code === 'confirm_required',
    String(noConfirmBody.error).slice(0, 90));
  check('a wrong confirmation is refused',
    (await api(`/orgs/${owner.orgId}`, { method: 'DELETE', body: JSON.stringify({ confirm: 'wrong' }) }, owner.tok)).status === 400);

  section('a non-owner cannot delete the organisation');
  check("another org's owner gets 404",
    (await api(`/orgs/${owner.orgId}`, { method: 'DELETE', body: JSON.stringify({ confirm: 'alice Ltd' }) }, other.tok)).status === 404);

  section('confirmed deletion removes everything');
  const del = await api(`/orgs/${owner.orgId}`, {
    method: 'DELETE', body: JSON.stringify({ confirm: 'alice Ltd' }),
  }, owner.tok);
  check('delete succeeds with the right confirmation', del.status === 200, `HTTP ${del.status}`);

  check('the org is gone',
    Number((sdb.prepare('SELECT COUNT(*) n FROM orgs WHERE id = ?').get(owner.orgId) as any).n) === 0);
  check('its workspaces are gone',
    Number((sdb.prepare('SELECT COUNT(*) n FROM lobbies WHERE org_id = ?').get(owner.orgId) as any).n) === 0);
  for (const code of [room1.code, room2.code]) {
    const objs = (sdb.prepare('SELECT COUNT(*) n FROM canvas_objects WHERE lobby_id = ?').get(code) as any).n;
    const msgs = (sdb.prepare('SELECT COUNT(*) n FROM messages WHERE lobby_id = ?').get(code) as any).n;
    check(`nothing left in ${code}`, Number(objs) === 0 && Number(msgs) === 0, `${objs} objects, ${msgs} messages`);
  }
  check('the org audit trail went with it',
    Number((sdb.prepare('SELECT COUNT(*) n FROM audit_log WHERE org_id = ?').get(owner.orgId) as any).n) === 0);

  section("another org's data was untouched");
  check("the other org still exists",
    Number((sdb.prepare('SELECT COUNT(*) n FROM orgs WHERE id = ?').get(other.orgId) as any).n) === 1);

  sdb.close();
  console.log('\n=== verdict ===');
  console.log(failures === 0 ? 'PASS' : `FAIL — ${failures} check(s)`);
} finally {
  cleanup();
}

process.exit(failures === 0 ? 0 : 1);
