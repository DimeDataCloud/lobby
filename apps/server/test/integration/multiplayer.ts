// Live multiplayer integration check. Needs a RUNNING server (.start.ps1).
//   bun run apps/server/test/integration/multiplayer.ts
// Not a bun:test file on purpose — it drives real sockets against a real process.
// Two real WebSocket clients in one lobby.
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

const BASE = process.env.LOBBY_TEST_BASE || 'http://localhost:4000';
const WSB  = BASE.replace(/^http/, 'ws');
// Resolved from this file, not hardcoded — an absolute path pinned the test to
// one machine and one checkout, and broke the moment the repo moved.
const DB   = process.env.LOBBY_TEST_DB || join(import.meta.dir, '..', '..', 'events.db');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
  if (!ok) failures++;
};
const section = (s: string) => console.log('\n=== ' + s + ' ===');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class Client {
  ws!: WebSocket;
  seen: any[] = [];
  constructor(public name: string, public url: string) {}
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onmessage = (e) => { try { this.seen.push(JSON.parse(String(e.data))); } catch {} };
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(this.name + ' failed to connect'));
      setTimeout(() => reject(new Error(this.name + ' connect timeout')), 5000);
    });
  }
  send(o: any) { this.ws.send(JSON.stringify(o)); }
  ofType(t: string) { return this.seen.filter(m => m.type === t); }
  close() { try { this.ws.close(); } catch {} }
}

// ---- lobby ----------------------------------------------------------------
const lobby = await (await fetch(`${BASE}/lobbies`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'ws-verify', visibility: 'private', created_by: 'tester' }),
})).json();
const CODE = lobby.code;
console.log('lobby:', CODE);

// ---- origin check ---------------------------------------------------------
section('WebSocket admission (cross-site hijacking guard)');
{
  const res = await fetch(`${BASE}/lobby/${CODE}/stream`, {
    headers: { Origin: 'https://evil.example.com', Connection: 'Upgrade', Upgrade: 'websocket' },
  });
  check('foreign Origin rejected at upgrade', res.status === 403, `HTTP ${res.status}`);

  const ok = await fetch(`${BASE}/lobby/${CODE}/stream`, {
    headers: { Origin: 'http://localhost:5173', Connection: 'Upgrade', Upgrade: 'websocket' },
  }).catch(() => null);
  check('localhost Origin not 403', !ok || ok.status !== 403, ok ? `HTTP ${ok.status}` : 'upgraded');
}

// ---- two clients ----------------------------------------------------------
section('two clients in one lobby');
const alice = new Client('alice', `${WSB}/lobby/${CODE}/stream?user_id=alice`);
const bob   = new Client('bob',   `${WSB}/lobby/${CODE}/stream?user_id=bob`);
await alice.connect();
await bob.connect();
await sleep(300);

check('initial payload delivered', alice.ofType('initial').length === 1);
check('canvas snapshot on join',   alice.ofType('canvas_snapshot').length === 1);
check('presence roster on join',   alice.ofType('presence_roster').length === 1);

// ---- ephemeral cursors ----------------------------------------------------
section('ephemeral cursors');
const presenceRowsBefore = (() => {
  const db = new Database(DB, { readonly: true });
  const r = db.prepare('SELECT COUNT(*) c FROM presence').get() as any;
  const w = db.prepare("SELECT COUNT(*) c FROM presence WHERE cursor_x IS NOT NULL").get() as any;
  db.close(false);
  return { rows: r.c, withCursor: w.c };
})();

bob.seen.length = 0;
alice.seen.length = 0;
const FRAMES = 200;
for (let i = 0; i < FRAMES; i++) {
  alice.send({ t: 'e', n: 'Alice', col: '#f97316', c: [i, i * 2], v: [0, 0, 1] });
}
await sleep(600);

const got = bob.ofType('ephemeral');
check('peer receives cursor frames', got.length > 0, `${got.length} of ${FRAMES}`);
check('sender does NOT receive own cursor', alice.ofType('ephemeral').length === 0);
check('latest cursor position propagated',
  got.length > 0 && got[got.length - 1].data.cursor.x === FRAMES - 1,
  got.length ? JSON.stringify(got[got.length - 1].data.cursor) : 'none');
check('identity carried on the frame', got.length > 0 && got[0].data.user_id === 'alice');

const presenceRowsAfter = (() => {
  const db = new Database(DB, { readonly: true });
  const r = db.prepare('SELECT COUNT(*) c FROM presence').get() as any;
  const w = db.prepare("SELECT COUNT(*) c FROM presence WHERE cursor_x IS NOT NULL").get() as any;
  db.close(false);
  return { rows: r.c, withCursor: w.c };
})();
check(`${FRAMES} cursor frames wrote ZERO database rows`,
  presenceRowsAfter.rows === presenceRowsBefore.rows &&
  presenceRowsAfter.withCursor === presenceRowsBefore.withCursor,
  JSON.stringify({ before: presenceRowsBefore, after: presenceRowsAfter }));

// ---- garbage rejection ----------------------------------------------------
section('hostile input');
bob.seen.length = 0;
alice.send({ t: 'e', c: [NaN, Infinity], v: [0, 0, 99999] });
await sleep(250);
const bad = bob.ofType('ephemeral');
const vp = bad.length ? bad[bad.length - 1].data.viewport : null;
check('NaN cursor not propagated to peers',
  bad.every(m => !m.data.cursor || Number.isFinite(m.data.cursor.x)));
check('absurd zoom clamped', !vp || vp.zoom <= 8, JSON.stringify(vp));
alice.ws.send('not json at all{{{');
await sleep(150);
check('malformed frame does not kill the socket', alice.ws.readyState === WebSocket.OPEN);

// ---- durable canvas objects ----------------------------------------------
section('canvas objects over WebSocket');
bob.seen.length = 0;
alice.send({ t: 'obj', op: 'upsert', o: { id: 'ws-obj-1', type: 'note', x: 10, y: 20, props: { text: 'hi' } } });
await sleep(350);
const objMsgs = bob.ofType('canvas_object');
check('peer receives object create', objMsgs.length === 1, `${objMsgs.length}`);
check('object carries a seq', objMsgs.length > 0 && objMsgs[0].data.seq > 0);

// stale write must be rejected and the winner returned to the loser
bob.seen.length = 0;
alice.seen.length = 0;
alice.send({ t: 'obj', op: 'upsert', o: { id: 'ws-obj-1', x: 999, version: 1, version_nonce: 1 } });
await sleep(350);
const rejected = alice.seen.filter(m => m.type === 'canvas_object' && m.rejected);
check('stale write rejected back to sender', rejected.length === 1, `${rejected.length}`);
check('rejection carries the winning row', rejected.length > 0 && rejected[0].data.x === 10,
  rejected.length ? String(rejected[0].data.x) : 'none');
check('peers not told about a rejected write', bob.ofType('canvas_object').length === 0);

// snapshot survives a fresh join
const carol = new Client('carol', `${WSB}/lobby/${CODE}/stream?user_id=carol`);
await carol.connect();
await sleep(300);
const snap = carol.ofType('canvas_snapshot')[0];
check('late joiner gets board state', !!snap && snap.data.some((o: any) => o.id === 'ws-obj-1'));

// ---- disconnect -----------------------------------------------------------
section('disconnect');
bob.seen.length = 0;
alice.close();
await sleep(400);
const left = bob.ofType('presence_leave');
check('peers told when a cursor leaves', left.length >= 1 && left[0].data.user_id === 'alice',
  JSON.stringify(left.map(l => l.data.user_id)));

bob.close(); carol.close();
await fetch(`${BASE}/lobbies/${CODE}`, { method: 'DELETE' });

section('verdict');
console.log(failures === 0 ? 'PASS' : `FAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
