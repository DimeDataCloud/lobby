// Room chat + board annotations, against a REAL server with REQUIRE_AUTH=true.
//
// The checks that must never regress:
//   - authorship comes from the token, so nobody can post as someone else
//   - a lobby-A token cannot read or write lobby-B's conversation
//   - an anonymous caller cannot tell a real room from a made-up one
//   - a tombstone gets a NEW seq, or clients that are caught up never hear
//     about the delete
//
//   bun run apps/server/test/integration/chat.ts

import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { rmSync } from 'fs';

const PORT = 4772;
const BASE = `http://localhost:${PORT}`;
const dbPath = join(tmpdir(), `lobby-chat-${Date.now()}.db`);
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

const post = (path: string, body: any, token?: string) =>
  api(path, { method: 'POST', body: JSON.stringify(body) }, token);

try {
  if (!await waitForServer()) {
    console.error('server did not start');
    console.error((await new Response(proc.stderr).text()).slice(0, 3000));
    cleanup();
    process.exit(1);
  }

  const lobbyA = await (await post('/lobbies', { name: 'alpha', visibility: 'private', created_by: 'alice' })).json();
  const lobbyB = await (await post('/lobbies', { name: 'beta', visibility: 'private', created_by: 'bob' })).json();
  const tokenA = lobbyA.token as string;
  const tokenB = lobbyB.token as string;

  const carol = await (await post(`/lobbies/${lobbyA.code}/join`,
    { user_id: 'carol', agent_id: 'carol-agent', role: 'viewer' }, tokenA)).json();
  const tokenViewer = carol.token as string;

  section('posting');
  const first = await post(`/lobbies/${lobbyA.code}/messages`, { body: 'first line' }, tokenA);
  const m1 = await first.json();
  check('owner can post', first.status === 201, `HTTP ${first.status}`);
  check('message carries a seq', Number.isInteger(m1.seq) && m1.seq > 0, String(m1.seq));
  check('author taken from the token, not the body',
    m1.author_user === 'alice', String(m1.author_user));

  const spoof = await (await post(`/lobbies/${lobbyA.code}/messages`,
    { body: 'i am bob', author_user: 'bob', author_kind: 'system' }, tokenA)).json();
  check('claimed author in body is ignored', spoof.author_user === 'alice', String(spoof.author_user));

  check('empty body rejected',
    (await post(`/lobbies/${lobbyA.code}/messages`, { body: '   ' }, tokenA)).status === 400);
  check('oversized body rejected',
    (await post(`/lobbies/${lobbyA.code}/messages`, { body: 'x'.repeat(4001) }, tokenA)).status === 400);

  section('viewers may speak but not mark the board');
  const viewerSaid = await post(`/lobbies/${lobbyA.code}/messages`, { body: 'viewer here' }, tokenViewer);
  check('viewer CAN post a message', viewerSaid.status === 201, `HTTP ${viewerSaid.status}`);
  check('viewer CANNOT pin an annotation',
    (await post(`/lobbies/${lobbyA.code}/annotations`,
      { text: 'nope', target_type: 'point', anchor_x: 1, anchor_y: 2 }, tokenViewer)).status === 403);

  section('backlog and ordering');
  const backlog = await (await api(`/lobbies/${lobbyA.code}/messages`, {}, tokenA)).json();
  check('backlog returns every message', backlog.messages.length === 3, String(backlog.messages.length));
  check('backlog is oldest-first',
    backlog.messages.every((m: any, i: number) => i === 0 || m.seq > backlog.messages[i - 1].seq));
  check('viewer can read the backlog',
    (await api(`/lobbies/${lobbyA.code}/messages`, {}, tokenViewer)).status === 200);

  section('replies stay inside the lobby');
  const goodReply = await post(`/lobbies/${lobbyA.code}/messages`, { body: 'reply', reply_to: m1.id }, tokenA);
  check('reply to a message in this lobby is accepted', goodReply.status === 201);
  const bMsg = await (await post(`/lobbies/${lobbyB.code}/messages`, { body: 'over here' }, tokenB)).json();
  const crossReply = await post(`/lobbies/${lobbyA.code}/messages`, { body: 'x', reply_to: bMsg.id }, tokenA);
  check('reply to another lobby\'s message is refused', crossReply.status === 400, `HTTP ${crossReply.status}`);

  section('CROSS-LOBBY ISOLATION');
  for (const [label, path] of [
    ['messages',    `/lobbies/${lobbyB.code}/messages`],
    ['messages/since', `/lobbies/${lobbyB.code}/messages/since?seq=0`],
    ['annotations', `/lobbies/${lobbyB.code}/annotations`],
    ['annotations/since', `/lobbies/${lobbyB.code}/annotations/since?seq=0`],
  ] as const) {
    const res = await api(path, {}, tokenA);
    check(`lobby-A token cannot read lobby-B ${label}`, res.status === 403, `HTTP ${res.status}`);
  }
  check('lobby-A token cannot post into lobby-B',
    (await post(`/lobbies/${lobbyB.code}/messages`, { body: 'intruder' }, tokenA)).status === 403);
  check('lobby-A token cannot pin in lobby-B',
    (await post(`/lobbies/${lobbyB.code}/annotations`,
      { text: 'intruder', target_type: 'point', anchor_x: 0, anchor_y: 0 }, tokenA)).status === 403);

  section('anonymous callers learn nothing');
  const anonReal = await api(`/lobbies/${lobbyA.code}/messages`);
  const anonFake = await api('/lobbies/ZZZZZZ/messages');
  check('anonymous read is indistinguishable from a nonexistent lobby',
    anonReal.status === fakeStatus(anonFake) && (await anonReal.text()) === (await anonFake.text()),
    `HTTP ${anonReal.status}`);
  const anonPost = await post(`/lobbies/${lobbyA.code}/messages`, { body: 'hello?' });
  check('anonymous post is refused', anonPost.status === 404, `HTTP ${anonPost.status}`);
  check('legacy /annotations/lobby/:code now requires membership',
    (await api(`/annotations/lobby/${lobbyA.code}`)).status === 404);
  check('legacy lobby annotations readable WITH a member token',
    (await api(`/annotations/lobby/${lobbyA.code}`, {}, tokenA)).status === 200);
  check('legacy POST /annotations into another lobby is refused',
    (await post('/annotations', { event_id: 1, text: 'x', lobby_id: lobbyB.code }, tokenA)).status === 403);

  section('annotations on the board');
  const pin = await (await post(`/lobbies/${lobbyA.code}/annotations`,
    { text: 'why is this here?', target_type: 'point', anchor_x: 120, anchor_y: -40 }, tokenA)).json();
  check('point pin keeps its board coordinates', pin.anchor_x === 120 && pin.anchor_y === -40);
  check('point pin without coordinates is refused',
    (await post(`/lobbies/${lobbyA.code}/annotations`, { text: 'x', target_type: 'point' }, tokenA)).status === 400);
  check('object pin without a target is refused',
    (await post(`/lobbies/${lobbyA.code}/annotations`, { text: 'x', target_type: 'object' }, tokenA)).status === 400);

  const objPin = await (await post(`/lobbies/${lobbyA.code}/annotations`,
    { text: 'on the card', target_type: 'object', target_id: 'obj-1' }, tokenA)).json();
  const filtered = await (await api(
    `/lobbies/${lobbyA.code}/annotations?target_type=object&target_id=obj-1`, {}, tokenA)).json();
  check('pins filter by target', filtered.annotations.length === 1 && filtered.annotations[0].id === objPin.id);

  const resolved = await (await api(`/lobbies/${lobbyA.code}/annotations/${objPin.id}`,
    { method: 'PATCH', body: JSON.stringify({ resolved: true }) }, tokenA)).json();
  check('resolving takes a new seq', resolved.resolved === true && resolved.seq > objPin.seq,
    `${objPin.seq} -> ${resolved.seq}`);
  const open = await (await api(`/lobbies/${lobbyA.code}/annotations`, {}, tokenA)).json();
  check('resolved pins drop off the board', !open.annotations.some((a: any) => a.id === objPin.id));
  const all = await (await api(`/lobbies/${lobbyA.code}/annotations?resolved=1`, {}, tokenA)).json();
  check('resolved pins are still retrievable', all.annotations.some((a: any) => a.id === objPin.id));

  section('withdrawing a message');
  const viewerMsg = await viewerSaid.json();
  check('a third party cannot delete someone else\'s message',
    (await api(`/lobbies/${lobbyA.code}/messages/${m1.id}`, { method: 'DELETE' }, tokenViewer)).status === 403);
  const beforeSeq = viewerMsg.seq;
  const tombstone = await (await api(`/lobbies/${lobbyA.code}/messages/${viewerMsg.id}`,
    { method: 'DELETE' }, tokenViewer)).json();
  check('author can withdraw their own message', tombstone.deleted === true);
  check('tombstone carries no text', tombstone.body === '', JSON.stringify(tombstone.body));
  check('tombstone gets a NEW seq so caught-up clients hear about it',
    tombstone.seq > beforeSeq, `${beforeSeq} -> ${tombstone.seq}`);
  const delta = await (await api(`/lobbies/${lobbyA.code}/messages/since?seq=${beforeSeq}`, {}, tokenA)).json();
  check('delta since the original seq includes the tombstone',
    delta.messages.some((m: any) => m.id === viewerMsg.id && m.deleted));
  check('owner can delete a member\'s message',
    (await api(`/lobbies/${lobbyA.code}/messages/${spoof.id}`, { method: 'DELETE' }, tokenA)).status === 200);

  section('live over the socket');
  const wsUrl = (t: string) =>
    `ws://localhost:${PORT}/lobby/${lobbyA.code}/stream?user_id=x&token=${encodeURIComponent(t)}`;
  const seen: any[] = [];
  const listener = new WebSocket(wsUrl(tokenViewer));
  const speaker = new WebSocket(wsUrl(tokenA));
  listener.onmessage = e => { try { seen.push(JSON.parse(String(e.data))); } catch {} };
  await Promise.all([
    new Promise<void>((res, rej) => { listener.onopen = () => res(); setTimeout(() => rej(new Error('listener timeout')), 5000); }),
    new Promise<void>((res, rej) => { speaker.onopen = () => res(); setTimeout(() => rej(new Error('speaker timeout')), 5000); }),
  ]);
  await sleep(300);
  check('joining a room delivers the conversation so far',
    seen.some(m => m.type === 'chat_backlog' && Array.isArray(m.data) && m.data.length > 0));
  check('joining a room delivers the pins', seen.some(m => m.type === 'annotation_snapshot'));

  seen.length = 0;
  speaker.send(JSON.stringify({ t: 'chat', body: 'over the wire' }));
  await sleep(400);
  const live = seen.find(m => m.type === 'chat_message');
  check('peer receives the message live', !!live, live ? live.data.body : 'none');
  check('live message is attributed to the sender\'s token', live?.data?.author_user === 'alice');

  seen.length = 0;
  listener.send(JSON.stringify({ t: 'ann', a: { text: 'viewer pin', target_type: 'point', anchor_x: 1, anchor_y: 1 } }));
  await sleep(300);
  check('viewer pinning over the socket is refused there too',
    seen.some(m => m.type === 'error') && !seen.some(m => m.type === 'annotation'));

  listener.close();
  speaker.close();

  section('verdict');
  console.log(failures === 0 ? 'PASS' : `FAIL — ${failures} assertion(s)`);
} catch (err) {
  console.error('test harness error:', err);
  failures++;
} finally {
  cleanup();
}

function fakeStatus(r: Response): number { return r.status; }

process.exit(failures === 0 ? 0 : 1);
