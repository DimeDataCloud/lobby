// The OAuth callback path, end to end, against a stub provider.
//
//   bun run apps/server/test/integration/oauth.ts
//
// WHY THIS EXISTS. Every other test in this repo mints sessions directly in the
// database, which is what a *completed* callback does. That left the callback
// itself — CSRF state handling, the code-for-token exchange, the profile fetch,
// the email-verification rule, and setting the session cookie — as the one stretch
// of authentication code that had never executed anywhere, including production.
//
// A stub provider closes that. It speaks GitHub's and Google's actual protocol on
// localhost, and the server reaches it because the provider endpoints are
// configurable (which GitHub Enterprise needs anyway). The only thing not covered
// here is DNS: in production the same code talks to github.com instead.
//
// The stub also asserts what the server SENDS it — notably that `redirect_uri`
// matches the registered callback exactly, which is the single most common reason
// a real OAuth setup fails.

import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { rmSync } from 'fs';
import { Database } from 'bun:sqlite';

const PORT = 4781;
const STUB = 4782;
const BASE = `http://localhost:${PORT}`;
const STUB_BASE = `http://localhost:${STUB}`;
const dbPath = join(tmpdir(), `lobby-oauth-${Date.now()}.db`);
const entry = resolve(import.meta.dir, '../../src/index.ts');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
  if (!ok) failures++;
};
const section = (s: string) => console.log('\n=== ' + s + ' ===');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The stub provider
// ---------------------------------------------------------------------------

/** What the stub saw, so the test can assert on the server's outbound request. */
const seen: { tokenBody?: Record<string, string>; profileAuth?: string } = {};

/** Per-code behaviour, so one stub covers the happy path and the failure modes. */
const CODES: Record<string, { token?: string; fail?: string }> = {
  good: { token: 'gho_stubtoken_verified' },
  unverified: { token: 'gho_stubtoken_unverified' },
  noemail: { token: 'gho_stubtoken_noemail' },
  badprofile: { token: 'gho_stubtoken_badprofile' },
  rejected: { fail: 'bad_verification_code' },
};

const stub = Bun.serve({
  port: STUB,
  async fetch(req) {
    const url = new URL(req.url);
    const j = (data: any, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

    // --- token exchange ---
    if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
      const form = new URLSearchParams(await req.text());
      seen.tokenBody = Object.fromEntries(form.entries());
      const code = form.get('code') || '';
      const behaviour = CODES[code];
      if (!behaviour || behaviour.fail) {
        return j({ error: behaviour?.fail || 'bad_verification_code', error_description: 'The code is incorrect or expired.' }, 200);
      }
      return j({ access_token: behaviour.token, token_type: 'bearer', scope: 'read:user,user:email' });
    }

    // --- profile ---
    if (url.pathname === '/user' && req.method === 'GET') {
      seen.profileAuth = req.headers.get('authorization') || '';
      const tok = seen.profileAuth.replace(/^Bearer\s+/i, '');
      if (tok === 'gho_stubtoken_badprofile') return j({ message: 'Bad credentials' }, 401);
      return j({ id: 424242, login: 'stubby', name: 'Stub McTest', avatar_url: `${STUB_BASE}/av.png` });
    }

    if (url.pathname === '/user/emails' && req.method === 'GET') {
      const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (tok === 'gho_stubtoken_noemail') return j([], 200);
      if (tok === 'gho_stubtoken_unverified') {
        // The trap: GitHub will report an address that nobody proved they own.
        return j([{ email: 'liar@example.test', primary: true, verified: false }]);
      }
      return j([
        { email: 'secondary@example.test', primary: false, verified: true },
        { email: 'stubby@example.test', primary: true, verified: true },
      ]);
    }

    // --- google's shape, to prove the same plumbing covers it ---
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await req.text());
      seen.tokenBody = Object.fromEntries(form.entries());
      return j({ access_token: 'ya29.stub', token_type: 'Bearer' });
    }
    if (url.pathname === '/v1/userinfo') {
      return j({ sub: 'goog-stub-1', email: 'stubby@example.test', email_verified: true, name: 'Stub McTest' });
    }

    return new Response('not found', { status: 404 });
  },
});

// ---------------------------------------------------------------------------

const proc = Bun.spawn(['bun', 'run', entry], {
  env: {
    ...process.env,
    SERVER_PORT: String(PORT),
    DB_PATH: dbPath,
    REQUIRE_AUTH: 'true',
    ALLOWED_ORIGINS: BASE,
    PUBLIC_ORIGIN: BASE,
    GITHUB_CLIENT_ID: 'Iv1.stubclientid',
    GITHUB_CLIENT_SECRET: 'stub-client-secret-value',
    GOOGLE_CLIENT_ID: 'stub-google-client-id',
    GOOGLE_CLIENT_SECRET: 'stub-google-secret',
    GITHUB_WEB_BASE: STUB_BASE,
    GITHUB_API_BASE: STUB_BASE,
    GOOGLE_OAUTH_BASE: STUB_BASE,
    GOOGLE_TOKEN_BASE: STUB_BASE,
    GOOGLE_API_BASE: STUB_BASE,
    RATE_AUTH_BURST: '400',
    RATE_AUTH_RPS: '200',
    NODE_ENV: 'test',
  },
  stdout: 'pipe',
  stderr: 'pipe',
});

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
  } catch {}
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
  try { stub.stop(true); } catch {}
  for (const s of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + s, { force: true }); } catch {}
  }
}

const raw = (url: string) => fetch(url, { redirect: 'manual' });
const cookieFrom = (res: Response) => {
  const m = (res.headers.get('set-cookie') || '').match(/lobby_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};
const meWith = (cookie: string) =>
  fetch(`${BASE}/auth/me`, { headers: { Cookie: `lobby_session=${cookie}` } }).then((r) => r.json());
const errorOf = (res: Response) => {
  const loc = res.headers.get('location') || '';
  const m = loc.match(/auth_error=([^&]*)/);
  return m ? decodeURIComponent(m[1]) : null;
};

/** Start a flow and return the state the server issued. */
async function beginFlow(provider: 'github' | 'google', redirect?: string): Promise<{ state: string; location: string }> {
  const res = await raw(`${BASE}/auth/${provider}${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ''}`);
  const location = res.headers.get('location') || '';
  const state = new URL(location).searchParams.get('state') || '';
  return { state, location };
}

try {
  if (!(await waitForServer())) {
    console.error('server did not start');
    console.error(await new Response(proc.stderr).text());
    cleanup();
    process.exit(1);
  }

  section('both providers are offered');
  const provs = await (await fetch(`${BASE}/auth/providers`)).json();
  check('github is configured', provs.providers.includes('github'), JSON.stringify(provs.providers));
  check('google is configured', provs.providers.includes('google'));

  section('starting the flow');
  const { state, location } = await beginFlow('github');
  const authUrl = new URL(location);
  check('it redirects to the provider', authUrl.origin === STUB_BASE, authUrl.origin);
  check('at the authorize endpoint', authUrl.pathname === '/login/oauth/authorize', authUrl.pathname);
  check('carrying our client id', authUrl.searchParams.get('client_id') === 'Iv1.stubclientid');
  check('and a state', state.length > 20, `${state.length} chars`);
  check('asking only for the scopes we need',
    authUrl.searchParams.get('scope') === 'read:user user:email',
    String(authUrl.searchParams.get('scope')));

  // The failure that wastes an afternoon: this string must equal what is typed
  // into GitHub's app registration, character for character.
  check('the redirect_uri is exactly the documented callback',
    authUrl.searchParams.get('redirect_uri') === `${BASE}/auth/github/callback`,
    String(authUrl.searchParams.get('redirect_uri')));

  section('the happy path, all the way to a session');
  const ok = await raw(`${BASE}/auth/github/callback?code=good&state=${state}`);
  check('the callback is a redirect', ok.status === 302, `HTTP ${ok.status}`);
  check('with no error', errorOf(ok) === null, String(errorOf(ok)));
  check('it lands inside the app', ok.headers.get('location') === '/');
  const cookie = cookieFrom(ok);
  check('a session cookie is set', !!cookie);
  check('the cookie is HttpOnly', /HttpOnly/i.test(ok.headers.get('set-cookie') || ''));
  check('and SameSite=Lax, so the return trip from the provider carries it',
    /SameSite=Lax/i.test(ok.headers.get('set-cookie') || ''));

  check('the client secret was sent to the token endpoint, not the browser',
    seen.tokenBody?.client_secret === 'stub-client-secret-value');
  check('the exchange included the same redirect_uri',
    seen.tokenBody?.redirect_uri === `${BASE}/auth/github/callback`,
    String(seen.tokenBody?.redirect_uri));
  check('the profile was fetched with the access token, as a bearer',
    seen.profileAuth === 'Bearer gho_stubtoken_verified', String(seen.profileAuth));

  const me = await meWith(cookie!);
  check('the session is a signed-in user', !!me.user, JSON.stringify(me.user));
  check('named from the provider profile', me.user?.name === 'Stub McTest');
  check('with the VERIFIED PRIMARY email, not the secondary',
    me.user?.email === 'stubby@example.test', String(me.user?.email));
  check('and a personal org to work in', me.orgs?.length === 1 && me.orgs[0].plan === 'personal');

  const sdb = new Database(dbPath);
  const row = sdb.prepare('SELECT * FROM users WHERE provider = ? ORDER BY created_at DESC LIMIT 1')
    .get('github') as any;
  check('identity is keyed on the provider id, not the email',
    row?.provider_subject === '424242', String(row?.provider_subject));

  section('an unverified email is never stored');
  const { state: s2 } = await beginFlow('github');
  const unver = await raw(`${BASE}/auth/github/callback?code=unverified&state=${s2}`);
  const me2 = await meWith(cookieFrom(unver)!);
  check('the sign-in still succeeds', !!me2.user);
  check('but the unverified address was discarded', me2.user?.email !== 'liar@example.test',
    String(me2.user?.email));
  check('nothing anywhere holds the unverified address',
    !(sdb.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('liar@example.test') as any).n);

  section('no email at all is survivable');
  // Same GitHub id as the happy path, so this also proves a re-sign-in does not
  // wipe an email we already had.
  const { state: s3 } = await beginFlow('github');
  const noem = await raw(`${BASE}/auth/github/callback?code=noemail&state=${s3}`);
  check('sign-in succeeds without an email', !!cookieFrom(noem));
  const me3 = await meWith(cookieFrom(noem)!);
  check('and it is the same account as before', me3.user?.id === me.user?.id);
  check('the previously known email was not clobbered', me3.user?.email === 'stubby@example.test',
    String(me3.user?.email));

  section('CSRF: state has to be one we issued');
  const forged = await raw(`${BASE}/auth/github/callback?code=good&state=this-state-was-never-issued`);
  check('a forged state is refused', !!errorOf(forged), String(errorOf(forged)));
  check('no session is created', cookieFrom(forged) === null);
  check('the message tells the user to start again',
    /invalid or has already been used/i.test(errorOf(forged) || ''));

  const { state: s4 } = await beginFlow('github');
  await raw(`${BASE}/auth/github/callback?code=good&state=${s4}`);
  const replayed = await raw(`${BASE}/auth/github/callback?code=good&state=${s4}`);
  check('a replayed state is refused the second time', !!errorOf(replayed));
  check('and sets no cookie', cookieFrom(replayed) === null);

  const noState = await raw(`${BASE}/auth/github/callback?code=good`);
  check('a callback with no state is refused', !!errorOf(noState), String(errorOf(noState)));
  const { state: s5 } = await beginFlow('github');
  const noCode = await raw(`${BASE}/auth/github/callback?state=${s5}`);
  check('a callback with no code is refused', !!errorOf(noCode), String(errorOf(noCode)));

  section('an expired state is refused');
  const { state: s6 } = await beginFlow('github');
  sdb.prepare('UPDATE oauth_states SET created_at = ? WHERE state = ?')
    .run(Date.now() - 11 * 60_000, s6);
  const stale = await raw(`${BASE}/auth/github/callback?code=good&state=${s6}`);
  check('a state older than ten minutes does not sign anyone in',
    !!errorOf(stale) && cookieFrom(stale) === null);

  section('provider failures are handled, not leaked');
  const { state: s7 } = await beginFlow('github');
  const rejected = await raw(`${BASE}/auth/github/callback?code=rejected&state=${s7}`);
  check('a rejected code redirects with a message', rejected.status === 302 && !!errorOf(rejected),
    String(errorOf(rejected)));
  check('the message is the provider description, not a stack trace',
    !/\bat \/|\.ts:\d+|Error:/.test(errorOf(rejected) || ''), String(errorOf(rejected)));

  const { state: s8 } = await beginFlow('github');
  const badProfile = await raw(`${BASE}/auth/github/callback?code=badprofile&state=${s8}`);
  check('a profile fetch failure is handled', !!errorOf(badProfile), String(errorOf(badProfile)));
  check('and leaks no internal path', !/[A-Za-z]:\\|\/apps\/server\//.test(errorOf(badProfile) || ''));
  check('nor the access token', !/gho_stubtoken/.test(errorOf(badProfile) || ''));
  // An internal endpoint in a user-facing string is reconnaissance to a stranger
  // and, on an Enterprise deployment, discloses the internal hostname.
  check('nor the internal endpoint it failed to reach',
    !/localhost|127\.0\.0\.1|:\d{4}|https?:\/\//.test(errorOf(badProfile) || ''),
    String(errorOf(badProfile)));
  check('it says what to do instead',
    /try signing in again/i.test(errorOf(badProfile) || ''), String(errorOf(badProfile)));

  section('secrets never reach the user');
  const allErrors = [errorOf(rejected), errorOf(badProfile), errorOf(forged)].join(' ');
  check('no client secret in any error', !allErrors.includes('stub-client-secret-value'));
  check('no client secret in the server log either',
    !serverOut.includes('stub-client-secret-value'));

  section('no open redirect through the sign-in flow');
  const { state: s9 } = await beginFlow('github', 'https://evil.example.com/x');
  const abs = await raw(`${BASE}/auth/github/callback?code=good&state=${s9}`);
  check('an absolute redirect is discarded', abs.headers.get('location') === '/',
    String(abs.headers.get('location')));
  const { state: s10 } = await beginFlow('github', '//evil.example.com');
  const prel = await raw(`${BASE}/auth/github/callback?code=good&state=${s10}`);
  check('a protocol-relative redirect is discarded', prel.headers.get('location') === '/');
  const { state: s11 } = await beginFlow('github', '/#lobby=ABC123');
  const inApp = await raw(`${BASE}/auth/github/callback?code=good&state=${s11}`);
  check('an in-app redirect IS honoured, so invite links survive sign-in',
    inApp.headers.get('location') === '/#lobby=ABC123', String(inApp.headers.get('location')));

  section('state is bound to its provider');
  const { state: s12 } = await beginFlow('github');
  const crossed = await raw(`${BASE}/auth/google/callback?code=good&state=${s12}`);
  check("a github state cannot be spent on google's callback", !!errorOf(crossed),
    String(errorOf(crossed)));

  section('google works through the same plumbing');
  const { state: g1 } = await beginFlow('google');
  const gOk = await raw(`${BASE}/auth/google/callback?code=good&state=${g1}`);
  check('google sign-in completes', !!cookieFrom(gOk), String(errorOf(gOk)));
  const gMe = await meWith(cookieFrom(gOk)!);
  check('and yields a user', !!gMe.user, JSON.stringify(gMe.user));
  check('the same human on two providers is TWO accounts, deliberately',
    gMe.user?.id !== me.user?.id, `${me.user?.id} vs ${gMe.user?.id}`);
  check('even though the provider asserted the same email',
    gMe.user?.email === 'stubby@example.test' && me.user?.email === 'stubby@example.test');

  section('the sign-in was recorded');
  const audits = sdb.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.signin'")
    .get() as any;
  check('every successful sign-in is in the audit log', Number(audits.n) >= 5, `n=${audits.n}`);

  section('verdict');
  console.log(failures === 0 ? 'PASS' : `FAIL — ${failures} check(s)`);
} catch (err) {
  console.error('\nthrew:', err);
  failures++;
} finally {
  cleanup();
}

process.exit(failures === 0 ? 0 : 1);
