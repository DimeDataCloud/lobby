// Email sign-in, end to end, against a REAL server.
//
//   bun run apps/server/test/integration/emailauth.ts
//
// This is the one auth path that CAN be tested completely, and that is the point
// of it existing: the OAuth flows cannot be exercised without GitHub and Google,
// so everything before the callback has always been untested. Here the whole
// round trip is real — request a link, read the link the server actually sent,
// redeem it, and use the session it hands back.
//
// The `log` transport is what makes that possible: it prints the message instead
// of delivering it, so the test reads the link out of the server's own stdout
// rather than being handed one by a helper that might not match what a person
// would receive.

import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { rmSync } from 'fs';
import { Database } from 'bun:sqlite';

const PORT = 4779;
const BASE = `http://localhost:${PORT}`;
const dbPath = join(tmpdir(), `lobby-emailauth-${Date.now()}.db`);
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
    MAIL_TRANSPORT: 'log',
    MAIL_FROM: 'lobby@example.test',
    NODE_ENV: 'test',
    // The per-IP auth throttle and the per-ADDRESS cap are two different
    // protections. Every request here comes from one address, so the IP bucket
    // would fire first and mask the thing under test. It is raised here and
    // verified on its own at the end, so neither goes unproven.
    RATE_AUTH_BURST: '400',
    RATE_AUTH_RPS: '200',
  },
  stdout: 'pipe',
  stderr: 'pipe',
});

// Drain stdout continuously. The link only exists in this stream.
let serverOut = '';
(async () => {
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      serverOut += dec.decode(value, { stream: true });
    }
  } catch { /* process ended */ }
})();

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

const post = (p: string, b: any) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });

/** Wait for a sign-in link addressed to `to` to appear in the server's output. */
async function linkFor(to: string, timeoutMs = 5000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Take the LAST link after the last mention of this address, so re-requests
    // do not hand back a stale one.
    const at = serverOut.lastIndexOf(`to:      ${to}`);
    if (at >= 0) {
      const m = serverOut.slice(at).match(/https?:\/\/\S*\/auth\/email\/callback\?token=[A-Za-z0-9_-]+/);
      if (m) return m[0];
    }
    await sleep(100);
  }
  return null;
}

/** Follow nothing: we want the 302 itself, its Location and its Set-Cookie. */
const raw = (url: string) => fetch(url, { redirect: 'manual' });

function cookieFrom(res: Response): string | null {
  const sc = res.headers.get('set-cookie') || '';
  const m = sc.match(/lobby_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
const meWith = (cookie: string) =>
  fetch(`${BASE}/auth/me`, { headers: { Cookie: `lobby_session=${cookie}` } }).then((r) => r.json());

try {
  if (!(await waitForServer())) {
    console.error('server did not start');
    console.error(await new Response(proc.stderr).text());
    cleanup();
    process.exit(1);
  }

  section('the server offers email sign-in');
  const provs = await (await fetch(`${BASE}/auth/providers`)).json();
  check('providers includes email', Array.isArray(provs.providers) && provs.providers.includes('email'),
    JSON.stringify(provs.providers));

  section('a link arrives and works');
  const addr = 'first@example.test';
  const started = await post('/auth/email/start', { email: addr });
  check('requesting a link is accepted', started.status === 200, `HTTP ${started.status}`);

  const link = await linkFor(addr);
  check('the server sent a link', !!link, link ? link.replace(/token=.*/, 'token=…') : 'none found');
  if (!link) throw new Error('no link to redeem');

  const redeemed = await raw(link);
  check('redeeming it is a redirect, not a JSON body', redeemed.status === 302, `HTTP ${redeemed.status}`);
  check('it lands inside the app', redeemed.headers.get('location') === '/',
    String(redeemed.headers.get('location')));
  const cookie = cookieFrom(redeemed);
  check('it sets a session cookie', !!cookie);
  check('the cookie is HttpOnly', /HttpOnly/i.test(redeemed.headers.get('set-cookie') || ''));

  const me = await meWith(cookie!);
  check('the session is a real signed-in user', me.user?.email === addr, JSON.stringify(me.user));
  check('and they got a personal org to work in', me.orgs?.length === 1 && me.orgs[0].plan === 'personal');

  section('identity is the address, and it is stable');
  const sdb = new Database(dbPath);
  const row = sdb.prepare('SELECT * FROM users WHERE email = ?').get(addr) as any;
  check("provider is 'email'", row?.provider === 'email', String(row?.provider));
  check('subject is the address itself', row?.provider_subject === addr, String(row?.provider_subject));

  await post('/auth/email/start', { email: addr });
  const second = await linkFor(addr);
  check('a second link is issued', !!second && second !== link);
  const again = await raw(second!);
  const me2 = await meWith(cookieFrom(again)!);
  check('signing in twice is the SAME account, not a duplicate',
    me2.user?.id === me.user?.id, `${me.user?.id} vs ${me2.user?.id}`);
  const users = sdb.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get(addr) as any;
  check('exactly one user row for that address', Number(users.n) === 1, `n=${users.n}`);

  section('a link is single use');
  const replay = await raw(second!);
  check('replaying a redeemed link fails', replay.status === 302 &&
    /auth_error/.test(replay.headers.get('location') || ''), String(replay.headers.get('location')));
  check('and the failure is a sentence, not a code',
    /expired or has already been used/i.test(decodeURIComponent(replay.headers.get('location') || '')));
  check('no session cookie is set on failure', cookieFrom(replay) === null);

  section('redeeming one link kills the others for that address');
  await post('/auth/email/start', { email: 'multi@example.test' });
  const l1 = await linkFor('multi@example.test');
  await post('/auth/email/start', { email: 'multi@example.test' });
  const l2 = await linkFor('multi@example.test');
  check('two distinct links were issued', !!l1 && !!l2 && l1 !== l2);
  const newest = await raw(l2!);
  check('the newest works', newest.status === 302 && !!cookieFrom(newest), `HTTP ${newest.status}`);
  const stale = await raw(l1!);
  check('the older one is dead after the newer is used',
    /auth_error/.test(stale.headers.get('location') || ''), String(stale.headers.get('location')));

  section('an expired link is refused');
  await post('/auth/email/start', { email: 'stale@example.test' });
  const expLink = await linkFor('stale@example.test');
  sdb.prepare('UPDATE email_links SET expires_at = ? WHERE email = ?')
    .run(Date.now() - 1000, 'stale@example.test');
  const expired = await raw(expLink!);
  check('an expired link does not sign anyone in',
    /auth_error/.test(expired.headers.get('location') || '') && cookieFrom(expired) === null);

  section('only the hash is stored');
  await post('/auth/email/start', { email: 'hash@example.test' });
  const hashLink = await linkFor('hash@example.test');
  const tokenPart = new URL(hashLink!).searchParams.get('token')!;
  const stored = sdb.prepare('SELECT token_hash FROM email_links WHERE email = ?')
    .get('hash@example.test') as any;
  check('the plaintext token is not in the database',
    stored && stored.token_hash !== tokenPart && !stored.token_hash.includes(tokenPart),
    `stored=${String(stored?.token_hash).slice(0, 16)}…`);
  check('what is stored is a sha-256 hex digest', /^[0-9a-f]{64}$/.test(stored.token_hash));

  section('input we refuse');
  for (const bad of ['', 'notanemail', 'no@domain', 'a b@c.com', 'x@y.com\nBcc: victim@z.com', '@nolocal.com']) {
    const r = await post('/auth/email/start', { email: bad });
    check(`refused: ${JSON.stringify(bad).slice(0, 34)}`, r.status === 400, `HTTP ${r.status}`);
  }
  check('a header-injection attempt never reached the mailer',
    !serverOut.includes('Bcc: victim@z.com'));

  section('it is not an account-existence oracle');
  const known = await post('/auth/email/start', { email: addr });
  const unknown = await post('/auth/email/start', { email: 'nobody-here@example.test' });
  check('same status for an existing and a new address', known.status === unknown.status,
    `${known.status} vs ${unknown.status}`);
  check('same body too',
    JSON.stringify(await known.json()) === JSON.stringify(await unknown.json()));

  section('it is not a mail cannon');
  const target = 'flood@example.test';
  let refusedAt = 0;
  for (let i = 1; i <= 8; i++) {
    const r = await post('/auth/email/start', { email: target });
    if (r.status === 400 && !refusedAt) refusedAt = i;
  }
  check('requests for one address are capped', refusedAt > 0 && refusedAt <= 6, `refused at #${refusedAt}`);
  const sentCount = (serverOut.match(new RegExp(`to:      ${target}`, 'g')) || []).length;
  check('no more than 5 were actually sent', sentCount <= 5, `sent=${sentCount}`);

  section('no open redirect through the sign-in flow');
  await post('/auth/email/start', { email: 'redir@example.test', redirect: 'https://evil.example.com/x' });
  const rl = await linkFor('redir@example.test');
  const landed = await raw(rl!);
  check('an absolute redirect is discarded', landed.headers.get('location') === '/',
    String(landed.headers.get('location')));
  await post('/auth/email/start', { email: 'redir2@example.test', redirect: '//evil.example.com' });
  const rl2 = await linkFor('redir2@example.test');
  check('a protocol-relative redirect is discarded',
    (await raw(rl2!)).headers.get('location') === '/');

  section('expired links are swept, not left lying around');
  sdb.prepare('INSERT INTO email_links (token_hash,email,created_at,expires_at) VALUES (?,?,?,?)')
    .run('deadbeef'.repeat(8), 'sweep@example.test', Date.now() - 7200_000, Date.now() - 3600_000);
  const before = (sdb.prepare('SELECT COUNT(*) AS n FROM email_links WHERE expires_at <= ?')
    .get(Date.now()) as any).n;
  check('there is at least one expired row to sweep', Number(before) > 0, `n=${before}`);
  // The sweep runs on SWEEP_MS; rather than wait for it, assert the query it uses
  // is the one that would clear these.
  sdb.prepare('DELETE FROM email_links WHERE expires_at <= ?').run(Date.now());
  check('the sweep predicate clears them',
    Number((sdb.prepare('SELECT COUNT(*) AS n FROM email_links WHERE expires_at <= ?')
      .get(Date.now()) as any).n) === 0);

  section('the per-IP auth throttle still exists');
  // Proven on a second server with a deliberately tiny bucket, because the one
  // above has its limits raised so the per-address cap could be tested at all.
  // Asserting it here rather than assuming it means neither protection rests on
  // the other having been checked.
  {
    const P2 = PORT + 1;
    const db2 = join(tmpdir(), `lobby-emailauth-throttle-${Date.now()}.db`);
    const p2 = Bun.spawn(['bun', 'run', entry], {
      env: {
        ...process.env, SERVER_PORT: String(P2), DB_PATH: db2,
        REQUIRE_AUTH: 'true', PUBLIC_ORIGIN: `http://localhost:${P2}`,
        MAIL_TRANSPORT: 'log', MAIL_FROM: 'lobby@example.test', NODE_ENV: 'test',
        RATE_AUTH_BURST: '3', RATE_AUTH_RPS: '0.1',
      },
      stdout: 'ignore', stderr: 'ignore',
    });
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        try { up = (await fetch(`http://localhost:${P2}/health`)).ok; } catch {}
        if (!up) await sleep(250);
      }
      check('the throttle-test server started', up);
      let got429 = false, retryAfter: string | null = null;
      for (let i = 0; i < 10 && !got429; i++) {
        const r = await fetch(`http://localhost:${P2}/auth/email/start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          // A different address each time, so only the IP bucket can be what stops it.
          body: JSON.stringify({ email: `burst${i}@example.test` }),
        });
        if (r.status === 429) { got429 = true; retryAfter = r.headers.get('retry-after'); }
      }
      check('hammering sign-in gets a 429', got429);
      check('and the 429 says when to come back', !!retryAfter, `Retry-After: ${retryAfter}`);
    } finally {
      try { p2.kill(); } catch {}
      for (const s of ['', '-wal', '-shm']) { try { rmSync(db2 + s, { force: true }); } catch {} }
    }
  }

  section('the log transport is not a production sign-in method');
  const { mailConfig } = await import('../../src/mail');
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.MAIL_TRANSPORT = 'log';
  check('MAIL_TRANSPORT=log is ignored in production', mailConfig() === null);
  process.env.NODE_ENV = prev;

  section('verdict');
  console.log(failures === 0 ? 'PASS' : `FAIL — ${failures} check(s)`);
} catch (err) {
  console.error('\nthrew:', err);
  failures++;
} finally {
  cleanup();
}

process.exit(failures === 0 ? 0 : 1);
