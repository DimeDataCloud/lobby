// Authorization and tenant isolation, run against a REAL server started with
// REQUIRE_AUTH=true on a throwaway database.
//
// The cross-lobby check is the one that must never regress: a valid token for
// lobby X must not read, write, or even enumerate lobby Y. That is where IDOR
// always lands, and it is invisible until someone exploits it.
//
//   bun run apps/server/test/integration/auth.ts

import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { rmSync } from 'fs';

const PORT = 4771;
const BASE = `http://localhost:${PORT}`;
const dbPath = join(tmpdir(), `lobby-auth-${Date.now()}.db`);
const entry = resolve(import.meta.dir, '../../src/index.ts');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
  if (!ok) failures++;
};
const section = (s: string) => console.log('\n=== ' + s + ' ===');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const proc = Bun.spawn(['bun', 'run', entry], {
  env: {
    ...process.env,
    SERVER_PORT: String(PORT),
    DB_PATH: dbPath,
    REQUIRE_AUTH: 'true',
    ALLOWED_ORIGINS: 'http://localhost:5173',
  },
  stdout: 'pipe',
  stderr: 'pipe',
});

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {}
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

const api = (path: string, init: RequestInit = {}, token?: string) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });

try {
  if (!await waitForServer()) {
    console.error('server did not start');
    const err = await new Response(proc.stderr).text();
    console.error(err.slice(0, 3000));
    cleanup();
    process.exit(1);
  }

  // ---- setup: two independent lobbies ------------------------------------
  const lobbyA = await (await api('/lobbies', {
    method: 'POST',
    body: JSON.stringify({ name: 'alpha', visibility: 'private', created_by: 'alice' }),
  })).json();
  const lobbyB = await (await api('/lobbies', {
    method: 'POST',
    body: JSON.stringify({ name: 'beta', visibility: 'private', created_by: 'bob' }),
  })).json();

  section('token issuance');
  check('create returns a one-time plaintext token', typeof lobbyA.token === 'string' && lobbyA.token.startsWith('lby_'));
  check('creator is owner', lobbyA.member?.role === 'owner', lobbyA.member?.role);
  check('token is greppable (lby_ prefix)', /^lby_[A-Za-z0-9]+_[A-Za-z0-9]+$/.test(lobbyA.token));

  const tokenA = lobbyA.token as string;
  const tokenB = lobbyB.token as string;

  section('unauthenticated access is refused');
  // 404, not 401 — see the enumeration section below.
  check('no token -> 404', (await api(`/lobbies/${lobbyA.code}`)).status === 404);
  check('garbage token -> 401', (await api(`/lobbies/${lobbyA.code}`, {}, 'lby_aaaaaaaa_bbbbbbbb')).status === 401);
  check('non-lobby-shaped token -> 401', (await api(`/lobbies/${lobbyA.code}`, {}, 'hunter2')).status === 401);
  check('valid token -> 200', (await api(`/lobbies/${lobbyA.code}`, {}, tokenA)).status === 200);

  section('invite codes are not enumerable');
  // For an unlisted room the 6-character code IS the secret. If a real code
  // answers differently from a wrong guess, the code space becomes searchable
  // and the room stops being unlisted. Anonymous replies must be byte-identical.
  const BOGUS = 'ZZZZZZ';
  const realRes = await api(`/lobbies/${lobbyA.code}`);
  const fakeRes = await api(`/lobbies/${BOGUS}`);
  const realBody = await realRes.text();
  const fakeBody = await fakeRes.text();
  check('real code and bogus code return the same status',
    realRes.status === fakeRes.status, `${realRes.status} vs ${fakeRes.status}`);
  check('real code and bogus code return the same body',
    realBody === fakeBody, `${realBody} vs ${fakeBody}`);
  for (const [label, suffix] of [
    ['events', '/events'],
    ['canvas', '/canvas'],
    ['members', '/members'],
    ['presence', '/presence'],
  ] as const) {
    const r = await api(`/lobbies/${lobbyA.code}${suffix}`);
    const f = await api(`/lobbies/${BOGUS}${suffix}`);
    check(`anonymous ${label} is indistinguishable`,
      r.status === f.status && (await r.text()) === (await f.text()), `HTTP ${r.status}/${f.status}`);
  }

  section('CROSS-LOBBY ISOLATION (IDOR)');
  const paths = [
    ['lobby detail', `/lobbies/${lobbyB.code}`],
    ['events',       `/lobbies/${lobbyB.code}/events`],
    ['canvas',       `/lobbies/${lobbyB.code}/canvas`],
    ['canvas delta', `/lobbies/${lobbyB.code}/canvas/since?seq=0`],
    ['members',      `/lobbies/${lobbyB.code}/members`],
    ['presence',     `/lobbies/${lobbyB.code}/presence`],
  ];
  for (const [label, path] of paths) {
    const res = await api(path, {}, tokenA);
    check(`lobby-A token cannot read lobby-B ${label}`, res.status === 403, `HTTP ${res.status}`);
  }
  const wr = await api(`/lobbies/${lobbyB.code}/canvas`, {
    method: 'POST',
    body: JSON.stringify({ id: 'intruder', type: 'note' }),
  }, tokenA);
  check('lobby-A token cannot WRITE to lobby-B canvas', wr.status === 403, `HTTP ${wr.status}`);
  check('lobby-A token cannot DELETE lobby-B',
    (await api(`/lobbies/${lobbyB.code}`, { method: 'DELETE' }, tokenA)).status === 403);

  section('roles');
  const joined = await (await api(`/lobbies/${lobbyA.code}/join`, {
    method: 'POST',
    body: JSON.stringify({ user_id: 'carol', agent_id: 'carol-agent', role: 'viewer' }),
  }, tokenA)).json();
  const tokenViewer = joined.token as string;
  check('join issues a token', typeof tokenViewer === 'string' && tokenViewer.startsWith('lby_'));
  check('requested viewer role honoured', joined.member?.role === 'viewer', joined.member?.role);

  check('viewer CAN read the board',
    (await api(`/lobbies/${lobbyA.code}/canvas`, {}, tokenViewer)).status === 200);
  check('viewer CANNOT write the board',
    (await api(`/lobbies/${lobbyA.code}/canvas`, {
      method: 'POST', body: JSON.stringify({ id: 'v1', type: 'note' }),
    }, tokenViewer)).status === 403);
  check('viewer CANNOT delete the lobby',
    (await api(`/lobbies/${lobbyA.code}`, { method: 'DELETE' }, tokenViewer)).status === 403);
  check('owner CAN write the board',
    (await api(`/lobbies/${lobbyA.code}/canvas`, {
      method: 'POST', body: JSON.stringify({ id: 'o1', type: 'note', x: 5 }),
    }, tokenA)).status === 200);

  section('authorship is taken from the token, not the body');
  await api(`/lobbies/${lobbyA.code}/canvas`, {
    method: 'POST',
    body: JSON.stringify({ id: 'spoof', type: 'note', created_by: 'someone-else', updated_by: 'someone-else' }),
  }, tokenA);
  const board = await (await api(`/lobbies/${lobbyA.code}/canvas`, {}, tokenA)).json();
  const spoofed = board.objects.find((o: any) => o.id === 'spoof');
  check('claimed author in body is ignored', spoofed?.updated_by === 'alice', String(spoofed?.updated_by));

  section('revocation');
  const members = await (await api(`/lobbies/${lobbyA.code}/members`, {}, tokenA)).json();
  const carol = members.find((m: any) => m.user_id === 'carol');
  check('member list does not leak token material',
    carol && !('token_hash' in carol) && !('token_prefix' in carol),
    carol ? Object.keys(carol).join(',') : 'missing');

  await api(`/lobbies/${lobbyA.code}/members/${carol.id}`, { method: 'DELETE' }, tokenA);
  // Revocation must beat the verification cache, not wait it out.
  const afterRevoke = await api(`/lobbies/${lobbyA.code}/canvas`, {}, tokenViewer);
  check('revoked token is refused immediately', afterRevoke.status === 401, `HTTP ${afterRevoke.status}`);

  section('WebSocket upgrade is authorized before the handshake');
  const wsHeaders = { Connection: 'Upgrade', Upgrade: 'websocket', Origin: 'http://localhost:5173' };
  check('no token -> 404 (same answer as a nonexistent lobby)',
    (await fetch(`${BASE}/lobby/${lobbyA.code}/stream`, { headers: wsHeaders })).status === 404);
  check('lobby-B token on lobby-A -> 403',
    (await fetch(`${BASE}/lobby/${lobbyA.code}/stream?token=${encodeURIComponent(tokenB)}`, { headers: wsHeaders })).status === 403);
  check('revoked token -> 401',
    (await fetch(`${BASE}/lobby/${lobbyA.code}/stream?token=${encodeURIComponent(tokenViewer)}`, { headers: wsHeaders })).status === 401);
  const goodWs = await fetch(`${BASE}/lobby/${lobbyA.code}/stream?token=${encodeURIComponent(tokenA)}`, { headers: wsHeaders });
  check('valid token is not rejected', goodWs.status !== 401 && goodWs.status !== 403, `HTTP ${goodWs.status}`);

  section('owner can delete their own lobby');
  check('owner delete succeeds',
    (await api(`/lobbies/${lobbyA.code}`, { method: 'DELETE' }, tokenA)).status === 200);

  section('verdict');
  console.log(failures === 0 ? 'PASS' : `FAIL — ${failures} assertion(s)`);
} catch (err) {
  console.error('test harness error:', err);
  failures++;
} finally {
  cleanup();
}

process.exit(failures === 0 ? 0 : 1);
