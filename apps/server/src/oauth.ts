// GitHub and Google sign-in.
//
// Authorization-code flow, exchanged server-side. There is no password anywhere
// in this product: no hashing to get wrong, no reset emails to send, no
// credential database worth stealing.
//
// Two things here are security-critical rather than plumbing:
//
// 1. `state` IS SINGLE-USE AND BOUND TO A ROW WE CREATED. A callback arriving
//    with a state we never issued is a forged sign-in — either CSRF, or an
//    attacker trying to graft their own account onto a victim's browser. It is
//    consumed on read, so a replayed callback also fails.
//
// 2. GITHUB EMAILS ARE ONLY TRUSTED WHEN VERIFIED. GitHub will happily report an
//    unverified address on the profile. Since a provider-asserted email is what
//    a human reads to decide who someone is, taking an unverified one lets
//    anybody present themselves as anyone. Unverified means we store no email at
//    all rather than storing a lie — and note that accounts.ts never keys
//    identity on email regardless, which is the second line of defence.

import type { Database } from 'bun:sqlite';
import { createOAuthState, consumeOAuthState, type ProfileFromProvider } from './accounts';

export type Provider = 'github' | 'google';

export interface ProviderConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Where each provider's endpoints live.
 *
 * These are overridable for two reasons, one of which is not testing:
 *
 * - GitHub Enterprise Server is the same protocol on a customer's own hostname,
 *   so an enterprise deployment is configuration rather than a code change.
 * - It makes the callback path testable. Without this, everything between "the
 *   browser comes back with a code" and "a session cookie is set" could only be
 *   exercised by talking to github.com — which is why that stretch of code went
 *   to production unrun. A stub provider now covers it end to end.
 *
 * Nothing here is a secret; the client secret is separate and never in a URL.
 */
interface Endpoints {
  authorize: string;
  token: string;
  profile: string;
  emails?: string;
}

function endpoints(p: Provider): Endpoints {
  if (p === 'github') {
    const api = (process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');
    const web = (process.env.GITHUB_WEB_BASE || 'https://github.com').replace(/\/$/, '');
    return {
      authorize: `${web}/login/oauth/authorize`,
      token: `${web}/login/oauth/access_token`,
      profile: `${api}/user`,
      emails: `${api}/user/emails`,
    };
  }
  const oauth = (process.env.GOOGLE_OAUTH_BASE || 'https://accounts.google.com').replace(/\/$/, '');
  const token = (process.env.GOOGLE_TOKEN_BASE || 'https://oauth2.googleapis.com').replace(/\/$/, '');
  const api = (process.env.GOOGLE_API_BASE || 'https://openidconnect.googleapis.com').replace(/\/$/, '');
  return {
    authorize: `${oauth}/o/oauth2/v2/auth`,
    token: `${token}/token`,
    profile: `${api}/v1/userinfo`,
  };
}

export function providerConfig(p: Provider): ProviderConfig | null {
  const clientId = process.env[p === 'github' ? 'GITHUB_CLIENT_ID' : 'GOOGLE_CLIENT_ID'] || '';
  const clientSecret = process.env[p === 'github' ? 'GITHUB_CLIENT_SECRET' : 'GOOGLE_CLIENT_SECRET'] || '';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function configuredProviders(): Provider[] {
  return (['github', 'google'] as Provider[]).filter((p) => providerConfig(p) !== null);
}

/** Where the provider sends the browser back. Must match the app registration. */
export function callbackUrl(origin: string, p: Provider): string {
  return `${origin.replace(/\/$/, '')}/auth/${p}/callback`;
}

// ---------------------------------------------------------------------------
// Step 1 — send the browser to the provider
// ---------------------------------------------------------------------------

export function authorizeUrl(
  db: Database,
  p: Provider,
  origin: string,
  redirectAfter?: string
): string | null {
  const cfg = providerConfig(p);
  if (!cfg) return null;
  const state = createOAuthState(db, p, safeRedirect(redirectAfter));

  const ep = endpoints(p);

  if (p === 'github') {
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: callbackUrl(origin, p),
      scope: 'read:user user:email',
      state,
    });
    return `${ep.authorize}?${q}`;
  }

  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: callbackUrl(origin, p),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    // Force account choice rather than silently reusing whichever Google account
    // the browser happens to be signed into.
    prompt: 'select_account',
  });
  return `${ep.authorize}?${q}`;
}

/**
 * Only ever redirect within our own app. An open redirect here would let a
 * phishing link launder itself through a domain the user trusts, and the login
 * flow is exactly where people have their guard down.
 */
export function safeRedirect(target?: string | null): string {
  if (!target) return '/';
  if (!target.startsWith('/') || target.startsWith('//')) return '/';
  return target;
}

// ---------------------------------------------------------------------------
// Step 2 — the browser comes back with a code
// ---------------------------------------------------------------------------

export class OAuthError extends Error {}

export async function handleCallback(
  db: Database,
  p: Provider,
  origin: string,
  code: string | null,
  state: string | null
): Promise<{ profile: ProfileFromProvider; redirect: string }> {
  const cfg = providerConfig(p);
  if (!cfg) throw new OAuthError(`${p} sign-in is not configured on this server`);
  if (!code) throw new OAuthError('No authorization code returned');
  if (!state) throw new OAuthError('Missing state');

  const st = consumeOAuthState(db, state, p);
  if (!st) throw new OAuthError('This sign-in link is invalid or has already been used. Start again.');

  const accessToken = await exchangeCode(p, cfg, origin, code);
  const profile = p === 'github'
    ? await githubProfile(accessToken)
    : await googleProfile(accessToken);

  return { profile, redirect: safeRedirect(st.redirect) };
}

async function exchangeCode(p: Provider, cfg: ProviderConfig, origin: string, code: string): Promise<string> {
  const url = endpoints(p).token;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: callbackUrl(origin, p),
      ...(p === 'google' ? { grant_type: 'authorization_code' } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    throw new OAuthError(body?.error_description || body?.error || `Token exchange failed (HTTP ${res.status})`);
  }
  return body.access_token as string;
}

async function githubProfile(token: string): Promise<ProfileFromProvider> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'lobby',
  };

  const ep = endpoints('github');
  const me: any = await getJson(ep.profile, headers, 'GitHub');
  if (!me?.id) throw new OAuthError('GitHub did not return a profile');

  // The profile email can be unverified or hidden. Take the verified primary
  // from the dedicated endpoint, and accept no email rather than an unverified
  // one — see note 2 at the top.
  let email: string | null = null;
  try {
    const emails: any[] = await getJson(ep.emails!, headers);
    email = emails?.find((e) => e.primary && e.verified)?.email
         ?? emails?.find((e) => e.verified)?.email
         ?? null;
  } catch { /* scope may be absent; carry on without an email */ }

  return {
    provider: 'github',
    subject: String(me.id),
    email,
    name: me.name || me.login || null,
    avatar_url: me.avatar_url || null,
  };
}

async function googleProfile(token: string): Promise<ProfileFromProvider> {
  const me: any = await getJson(endpoints('google').profile, {
    Authorization: `Bearer ${token}`,
  }, 'Google');
  if (!me?.sub) throw new OAuthError('Google did not return a profile');
  return {
    provider: 'google',
    subject: String(me.sub),
    // Same rule as GitHub: an unverified address is not evidence of anything.
    email: me.email_verified ? me.email : null,
    name: me.name || null,
    avatar_url: me.picture || null,
  };
}

async function getJson(url: string, headers: Record<string, string>, who = 'The provider'): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    // The URL stays in the server log, not in the message. A user-facing error
    // naming an internal endpoint is noise to them and reconnaissance to
    // everyone else — and on an Enterprise deployment it discloses the host.
    console.error(`[oauth] ${url} returned ${res.status}`);
    throw new OAuthError(`${who} could not be reached just now. Try signing in again.`);
  }
  return res.json();
}
