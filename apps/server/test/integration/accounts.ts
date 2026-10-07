// Accounts, organisations and seats, against a REAL server with REQUIRE_AUTH=true.
//
//   bun run apps/server/test/integration/accounts.ts
//
// OAuth itself is not exercised — that needs GitHub and Google. What is
// exercised is everything downstream of it, which is where the bugs that cost
// money or leak data live: seat limits, cross-org isolation, and the fact that
// extending guard() with a session branch did not quietly weaken member tokens.
//
// Sessions are minted directly against the database, which is exactly what a
// successful OAuth callback does after the provider hands back a profile.

import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { rmSync } from 'fs';
import { Database } from 'bun:sqlite';

const PORT = 4775;
const BASE = `http://localhost:${PORT}`;
const dbPath = join(tmpdir(), `lobby-accounts-${Date.now()}.db`);
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

  // Mint users + sessions the way a completed OAuth callback would.
  const sdb = new Database(dbPath);
  const { createHash, randomBytes } = await import('node:crypto');
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

  function makeUser(provider: string, subject: string, name: string) {
    const uid = `usr_${randomBytes(8).toString('hex')}`;
    const now = Date.now();
    sdb.prepare(`INSERT INTO users (id,email,name,avatar_url,provider,provider_subject,created_at,last_seen)
                 VALUES (?,?,?,?,?,?,?,?)`)
      .run(uid, `${name}@example.test`, name, null, provider, subject, now, now);
    const orgId = `org_${randomBytes(8).toString('hex')}`;
    sdb.prepare('INSERT INTO orgs (id,name,plan,seat_limit,owner_user_id,created_at) VALUES (?,?,?,?,?,?)')
      .run(orgId, `${name} workspace`, 'personal', 1, uid, now);
    sdb.prepare('INSERT INTO org_members (org_id,user_id,role,seat_active,joined_at) VALUES (?,?,?,1,?)')
      .run(orgId, uid, 'owner', now);
    const token = `lbs_${randomBytes(32).toString('base64url')}`;
    sdb.prepare('INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
      .run(`ses_${randomBytes(8).toString('hex')}`, uid, sha256(token), now, now + 3600_000);
    return { uid, orgId, token, name };
  }

  section('identity');
  const alice = makeUser('github', 'gh-1', 'alice');
  const bob = makeUser('google', 'goog-1', 'bob');
  const me = await (await api('/auth/me', {}, alice.token)).json();
  check('a session resolves to the right user', me.user?.name === 'alice', JSON.stringify(me.user));
  check('and lists their personal org', me.orgs?.length === 1 && me.orgs[0].plan === 'personal');
  check('personal plan is one seat at $19.99',
    me.orgs[0].seat_limit === 1 && me.orgs[0].price_cents === 1999);
  check('an anonymous caller is nobody, not an error',
    (await (await api('/auth/me')).json()).user === null);

  section('the same human on two providers is two accounts, deliberately');
  const aliceGoogle = makeUser('google', 'goog-alice', 'alice');
  check('same name and email did not merge the accounts', aliceGoogle.uid !== alice.uid);

  section('workspaces belong to the org that made them');
  const ws = await (await post('/lobbies', { name: 'design-jam' }, alice.token)).json();
  check('created workspace is attached to the org', ws.org_id === alice.orgId, String(ws.org_id));
  check('creator is the signed-in user, not a body-supplied name', ws.created_by === alice.uid);
  const list = await (await api(`/orgs/${alice.orgId}/workspaces`, {}, alice.token)).json();
  check('it shows in the org workspace list', list.workspaces?.some((w: any) => w.code === ws.code));

  section('a signed-in member reaches the board without a bearer token');
  check('org member reads the room by cookie alone',
    (await api(`/lobbies/${ws.code}/agent/brief`, {}, alice.token)).status === 200);
  check('and can write to it',
    (await post(`/lobbies/${ws.code}/agent/post`, { kind: 'doc', title: 'from a browser' }, alice.token)).status === 201);

  section('cross-org isolation');
  check("an outsider's session gets 404, not 403 — org ids stay unguessable",
    (await api(`/lobbies/${ws.code}/agent/brief`, {}, bob.token)).status === 404);
  check('and cannot write',
    (await post(`/lobbies/${ws.code}/agent/post`, { kind: 'doc', title: 'x' }, bob.token)).status === 404);
  check("an outsider cannot read another org's roster",
    (await api(`/orgs/${alice.orgId}/members`, {}, bob.token)).status === 404);
  check("an outsider cannot list another org's workspaces",
    (await api(`/orgs/${alice.orgId}/workspaces`, {}, bob.token)).status === 404);

  section('member tokens still work — the guard was extended, not replaced');
  const tokenRoom = await (await post('/lobbies', { name: 'bot-room', created_by: 'a-bot' })).json();
  check('a bearer member token still authorizes',
    (await fetch(`${BASE}/lobbies/${tokenRoom.code}/agent/brief`, {
      headers: { Authorization: `Bearer ${tokenRoom.token}` },
    })).status === 200);
  check('anonymous is still refused with an identical 404',
    (await api(`/lobbies/${tokenRoom.code}/agent/brief`)).status === 404);

  section('seats');
  const org = await (await post('/orgs', { name: 'Acme', plan: 'organization' }, alice.token)).json();
  check('organisation plan is 5 seats for $80', org.seat_limit === 5, JSON.stringify(org));

  const extras = Array.from({ length: 5 }, (_, i) => makeUser('github', `gh-fill-${i}`, `user${i}`));
  const results: number[] = [];
  for (const u of extras) {
    results.push((await post(`/orgs/${org.id}/members`, { user_id: u.uid }, alice.token)).status);
  }
  check('four more fit into the five seats', results.slice(0, 4).every((s) => s === 201), results.join(','));
  const overflow = await post(`/orgs/${org.id}/members`, { user_id: extras[4].uid }, alice.token);
  const overflowBody = await overflow.json();
  check('the sixth is refused', overflow.status === 402, `HTTP ${overflow.status}`);
  check('refusal is "buy a seat", not "forbidden"', overflowBody.code === 'seat_limit');
  check('and says so in words a human can act on', /seat/i.test(overflowBody.error || ''), overflowBody.error);

  section('seats free up when someone leaves');
  check('releasing a seat succeeds',
    (await api(`/orgs/${org.id}/members/${extras[0].uid}`, { method: 'DELETE' }, alice.token)).status === 200);
  check('the freed seat can be reused',
    (await post(`/orgs/${org.id}/members`, { user_id: extras[4].uid }, alice.token)).status === 201);

  section('the owner cannot be removed out from under the org');
  const kickOwner = await api(`/orgs/${org.id}/members/${alice.uid}`, { method: 'DELETE' }, alice.token);
  check('removing the owner is refused', kickOwner.status === 400, `HTTP ${kickOwner.status}`);

  section('seat limit cannot be cut below what is in use');
  const shrink = await api(`/orgs/${org.id}`, { method: 'PATCH', body: JSON.stringify({ seat_limit: 2 }) }, alice.token);
  check('shrinking below occupied seats is refused', shrink.status === 409, `HTTP ${shrink.status}`);
  check('growing the seat count works',
    (await api(`/orgs/${org.id}`, { method: 'PATCH', body: JSON.stringify({ seat_limit: 8 }) }, alice.token)).status === 200);

  section('role enforcement');
  const member = extras[1];
  check('a plain member can read the roster',
    (await api(`/orgs/${org.id}/members`, {}, member.token)).status === 200);
  check('a plain member cannot invite',
    (await post(`/orgs/${org.id}/members`, { user_id: bob.uid }, member.token)).status === 403);
  check('a plain member cannot change the plan',
    (await api(`/orgs/${org.id}`, { method: 'PATCH', body: JSON.stringify({ seat_limit: 20 }) }, member.token)).status === 403);

  section('sessions');
  check('logout clears the session',
    (await post('/auth/logout', {}, alice.token)).status === 200);
  check('and the token stops working',
    (await (await api('/auth/me', {}, alice.token)).json()).user === null);
  check('a forged session token is nobody',
    (await (await api('/auth/me', {}, 'lbs_totally-made-up')).json()).user === null);

  section('sign-in surface');
  const provs = await (await api('/auth/providers')).json();
  check('providers list is present (empty without client ids configured)',
    Array.isArray(provs.providers), JSON.stringify(provs));
  const unconfigured = await api('/auth/github', { redirect: 'manual' } as any);
  check('an unconfigured provider says so rather than 500ing',
    [302, 503].includes(unconfigured.status), `HTTP ${unconfigured.status}`);

  sdb.close();
  console.log('\n=== verdict ===');
  console.log(failures === 0 ? 'PASS' : `FAIL — ${failures} check(s)`);
} finally {
  cleanup();
}

process.exit(failures === 0 ? 0 : 1);
