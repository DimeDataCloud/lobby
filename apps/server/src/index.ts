import { initDatabase, insertEvent, getFilterOptions, getRecentEvents, getEventsSince, getCurrentSeq, updateEventHITLResponse, upsertAgent, getAgents, getAgent, updateAgentStatus, sweepAgentStatuses, createLobby, getLobby, listLobbies, joinLobby, leaveLobby, getLobbyByAgent, getLobbyMembers, deleteLobby, initPresence, upsertPresence, getOnlineUsers, getLobbyPresence, heartbeatPresence, initAnnotations, addAnnotation, getAnnotations, getLobbyAnnotations, initCanvasSync, updateNodePosition, getNodePositions, db } from './db';
import { getObjects, getObjectsSince, upsertObject, deleteObject, clampLimit, getObject as getObjectById } from './canvas';
import { roomBrief, artifactDetail, postArtifact, AgentError } from './agent';
import { postMessage, getMessages, getMessagesSince, getMessage, deleteMessage, ChatError } from './chat';
import {
  createAnnotation, listAnnotations, getAnnotationsSince, getAnnotation,
  setResolved, deleteAnnotation, lobbiesForEvent, AnnotationError,
} from './annotations';
import { placeArtifact } from './placement';
import { setEphemeral, getEphemeral, dropEphemeral, sweepEphemeral, RateLimiter, Coalescer } from './ephemeral';
import {
  REQUIRE_AUTH, extractToken, resolveToken, authorizes, issueMemberToken,
  listMembers, revokeMember, getMemberByUser, touchMember, sweepTokenCache, hasRole,
} from './auth';
import type { Member, Role } from './auth';
import {
  initAccounts, upsertUser, getUser, createOrg, getOrg, orgsForUser, membership,
  hasOrgRole, seatsUsed, addOrgMember, deactivateSeat, setSeatLimit, setPlan,
  createSession, resolveSession, destroySession, sweepSessions,
  sessionCookie, sessionCookieHeader, clearSessionCookie,
  setLobbyOrg, orgOfLobby, lobbiesForOrg, SeatError, PLANS,
  redeemPromoCode, PromoError,
} from './accounts';
import {
  authorizeUrl, handleCallback, configuredProviders, safeRedirect, OAuthError,
  type Provider,
} from './oauth';
import {
  initEmailAuth, startEmailSignIn, consumeEmailLink, sweepEmailLinks,
  emailAuthAvailable, EmailAuthError,
} from './emailauth';
import { initAudit, audit, readAudit, pruneAudit, clientIp } from './audit';
import { pruneEvents, retentionPolicy } from './retention';
import { exportWorkspace, deleteWorkspaceData, deleteOrgData, previewOrgDeletion } from './dataops';
import { backupConfig, scheduleBackups, runBackup, backupHistory, listBackups, lastGoodBackup } from './backup';
import { clientKey, check as throttleCheck, bucketFor, tooMany, sweepThrottle } from './throttle';
import { resolve } from 'node:path';
import type { AgentEvent, HumanInTheLoopResponse } from './types';

initDatabase(process.env.DB_PATH || 'events.db');
initPresence();
initAnnotations();
initCanvasSync();
initAccounts(db);
initEmailAuth(db);
initAudit(db);

// Backups are opt-in by env because local development does not want them, and
// silently backing up a developer's scratch database to an unexpected directory
// is worse than not backing up at all. Deployments MUST set BACKUP_DIR.
const BACKUP = backupConfig();
if (BACKUP) scheduleBackups(db, BACKUP);
else console.warn('[backup] BACKUP_DIR is not set — no backups will be taken');

const wsClients = new Set<any>();

// Lobby-scoped WebSocket clients: Map<lobbyCode, Set<ws>>
const lobbyWsClients = new Map<string, Set<any>>();

// --- Relay config ---
// Forward received events to an upstream server.
// Set RELAY_URL=http://upstream:4000/events to enable.
// Set RELAY_MODE=forward-only to skip local storage (pure relay, no DB).
// Set RELAY_API_KEY to add an Authorization header to relayed events.
const RELAY_URL = process.env.RELAY_URL || '';
const RELAY_MODE = process.env.RELAY_MODE || 'store-and-forward'; // or "forward-only"
const RELAY_API_KEY = process.env.RELAY_API_KEY || '';
const RELAY_ENABLED = RELAY_URL.length > 0;

// A runaway producer or a malicious member should not be able to fill the disk
// in one request.
const MAX_BATCH = parseInt(process.env.MAX_BATCH || '500');

/** Built dashboard, served from the same origin as the API. Unset = API only. */
const STATIC_DIR = process.env.STATIC_DIR || '';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function securityHeaders(path: string): Record<string, string> {
  const ext = path.slice(path.lastIndexOf('.'));
  const isHtml = ext === '.html';
  return {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // Content-Security-Policy. The board renders text, titles and bodies written
    // by other people's agents, so an XSS here is cross-tenant: one workspace
    // stealing another's session. Vue compiles templates at build time, so no
    // 'unsafe-eval' is needed; 'unsafe-inline' for styles only, which Vue's
    // scoped-style output requires and which cannot execute.
    ...(isHtml
      ? {
          'Content-Security-Policy': [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            // Avatars come from GitHub and Google after sign-in.
            "img-src 'self' data: blob: https:",
            "connect-src 'self' ws: wss:",
            "font-src 'self' data:",
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "object-src 'none'",
          ].join('; '),
          'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
          'Cross-Origin-Opener-Policy': 'same-origin',
        }
      : {}),
    // Hashed asset filenames are immutable; the shell must never be cached or
    // a deploy leaves people on the old bundle indefinitely.
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
  };
}

async function relayEvent(event: AgentEvent): Promise<void> {
  if (!RELAY_ENABLED) return;
  try {
    const relayHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (RELAY_API_KEY) relayHeaders['Authorization'] = `Bearer ${RELAY_API_KEY}`;
    await fetch(RELAY_URL, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify(event),
    });
  } catch (err) {
    // Non-blocking — relay failures don't affect local processing
    console.error('[relay] Forward failed:', err);
  }
}

async function sendResponseToAgent(wsUrl: string, response: HumanInTheLoopResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let isResolved = false;
    const cleanup = () => { if (ws) { try { ws.close(); } catch {} } };

    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        if (isResolved) return;
        try {
          ws!.send(JSON.stringify(response));
          setTimeout(() => {
            cleanup();
            if (!isResolved) { isResolved = true; resolve(); }
          }, 500);
        } catch (err) {
          cleanup();
          if (!isResolved) { isResolved = true; reject(err); }
        }
      };
      ws.onerror = (err) => {
        cleanup();
        if (!isResolved) { isResolved = true; reject(err); }
      };
      setTimeout(() => {
        if (!isResolved) { cleanup(); isResolved = true; reject(new Error('Timeout')); }
      }, 5000);
    } catch (err) {
      cleanup();
      if (!isResolved) { isResolved = true; reject(err); }
    }
  });
}

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

function fanoutGlobal(message: string): void {
  wsClients.forEach(client => {
    try { client.send(message); } catch { wsClients.delete(client); }
  });
}

function fanoutLobby(lobbyCode: string, message: string, exclude?: any): void {
  const clients = lobbyWsClients.get(lobbyCode);
  if (!clients) return;
  clients.forEach(client => {
    if (client === exclude) return;
    try { client.send(message); } catch { clients.delete(client); }
  });
}

// ---------------------------------------------------------------------------
// WebSocket admission
//
// WebSockets are NOT covered by CORS. Without an explicit Origin check any page
// on the internet can open a socket to this server from a visitor's browser and
// read whatever that connection is allowed to read — cross-site WebSocket
// hijacking. The check has to happen here, before the upgrade.
//
// Caddy passes Origin through unmodified, so this works identically behind the
// reverse proxy.
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');

  // Non-browser clients (the CLI, monitors, curl) send no Origin at all. They
  // are not subject to the browser's ambient-credential problem, so absence is
  // allowed; presence must match.
  if (!origin) return true;

  if (ALLOWED_ORIGINS.length > 0) return ALLOWED_ORIGINS.includes(origin);

  // Dev default: localhost only. Deployments must set ALLOWED_ORIGINS.
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

interface WsData {
  lobbyCode?: string;
  userId: string;
  role?: Role;
  /** durable ops (canvas writes) — these hit SQLite, so the budget is tight */
  limiter: RateLimiter;
  /** ephemeral frames — bounds parse cost only, so the budget is generous */
  ephemeralLimiter: RateLimiter;
  /** throttles ephemeral FAN-OUT without ever dropping the newest frame */
  coalescer?: Coalescer;
}

/** Broadcast at most once per this interval per user — 25fps is plenty for a cursor. */
const EPHEMERAL_BROADCAST_MS = parseInt(process.env.EPHEMERAL_BROADCAST_MS || '40');

// ---------------------------------------------------------------------------
// Authorization gate
//
// ONE function every lobby-scoped route goes through. Scattering the membership
// check across handlers is exactly how one route gets forgotten, and the
// forgotten one is always a GET-by-id — which is where IDOR lands.
//
// A presented token is ALWAYS enforced, even when REQUIRE_AUTH is off: a valid
// token for lobby X must never read lobby Y regardless of deployment mode.
// REQUIRE_AUTH only decides whether an *absent* token is tolerated.
// ---------------------------------------------------------------------------

async function guard(
  req: Request,
  url: URL,
  lobbyId: string,
  min: Role
): Promise<{ member: Member | null } | Response> {
  const token = extractToken(req, url);
  const member = await resolveToken(db, token);

  if (member) {
    if (!authorizes(member, lobbyId, min)) return json({ error: 'Forbidden' }, 403);
    return { member };
  }

  if (token) return json({ error: 'Invalid or revoked token' }, 401);

  // A signed-in human reaching a workspace their organisation owns. This branch
  // exists so people do not have to hold a per-room bearer token in a browser;
  // bots still use member tokens above and are untouched by it.
  //
  // Derives the same Member shape the rest of the code already handles, so every
  // downstream route stays exactly as it was. Role comes from the org: owners and
  // admins get owner rights in their rooms, everyone else edits.
  const user = resolveSession(db, sessionCookie(req));
  if (user) {
    const orgId = orgOfLobby(db, lobbyId);
    if (orgId) {
      const m = membership(db, orgId, user.id);
      if (m && m.seat_active) {
        const synthetic: Member = {
          id: -1,
          lobby_id: lobbyId,
          user_id: user.id,
          display_name: user.name || undefined,
          role: hasOrgRole(m, 'admin') ? 'owner' : 'editor',
          created_at: m.joined_at,
        };
        // Ranked by auth.ts's own comparison, not a second copy of the table.
        if (!hasRole(synthetic, min)) return json({ error: 'Forbidden' }, 403);
        return { member: synthetic };
      }
      // Signed in, but not in the org that owns this room. Same answer a
      // nonexistent room gives, so a logged-in user cannot enumerate either.
      if (REQUIRE_AUTH) return json({ error: 'Lobby not found' }, 404);
    }
  }

  // No token, and auth is required. Answer exactly as a nonexistent lobby would,
  // so an anonymous prober cannot tell a real invite code from a wrong guess.
  // The codes ARE the secret for unlisted rooms; a 401-vs-404 difference turns
  // them into something enumerable.
  if (REQUIRE_AUTH) return json({ error: 'Lobby not found' }, 404);

  // Local development only. Deployments set REQUIRE_AUTH=true.
  return { member: null };
}

/**
 * The gate for routes that are NOT lobby-scoped.
 *
 * guard() above is excellent and 29 call sites use it correctly — but it takes a
 * `lobbyId`, so it can only protect lobby-scoped routes. Five routes are global:
 * /events/recent, /events/since, /agents, /agents/:id and /presence. They never had
 * a lobbyId to pass, so they never called guard(), so they were never authorized at
 * all. On 2026-08-11 an anonymous request to production returned the agent table —
 * including `user_id` values identifying a CLIENT — and 300 recent events with
 * payloads. REQUIRE_AUTH=true was set the whole time and did nothing for them,
 * because the check it gates was never reached.
 *
 * This is exactly the failure guard()'s own comment warns about: "Scattering the
 * membership check across handlers is exactly how one route gets forgotten." The
 * centralisation was real; these routes just sat outside what it centralised.
 *
 * Asks the weaker question guard() asks first — "is there ANY valid principal?" —
 * because these routes span lobbies by design and there is no single room to check
 * membership against. Same two accepted identities as everywhere else: a member
 * token, or a session cookie. Same REQUIRE_AUTH escape hatch, so local dev is
 * unchanged.
 *
 * Returns a Response to send when the caller is not authorized, or null to continue.
 */
async function requirePrincipal(req: Request, url: URL): Promise<Response | null> {
  if (!REQUIRE_AUTH) return null;

  const token = extractToken(req, url);
  if (token) {
    const member = await resolveToken(db, token);
    if (member) return null;
    return json({ error: 'Invalid or revoked token' }, 401);
  }

  if (resolveSession(db, sessionCookie(req))) return null;

  return json({ error: 'Unauthorized' }, 401);
}

/**
 * Paths exempt from rate limiting: health checks (limiting your own monitoring
 * manufactures outages) and static assets (one page load is dozens of them).
 */
const STATIC_PATHS = /^\/(health|healthz|assets\/|favicon|manifest|icon|robots)/;

/**
 * Largest request body accepted.
 *
 * 1MB by default, against a 24KB cap on an artifact body and a 256KB WebSocket
 * frame — so it is generous for everything the product legitimately does while
 * still being two orders of magnitude below what would hurt. Raise it only if
 * something real needs it; the reason it exists is in the check below.
 */
const MAX_BODY_BYTES = Math.max(
  16 * 1024,
  parseInt(process.env.MAX_BODY_BYTES || '', 10) || 1024 * 1024
);

/**
 * Constant-time string compare for secrets.
 *
 * `a === b` on a secret returns as soon as two bytes differ, and that timing is
 * measurable over enough samples. Comparing digests rather than raw input also
 * means unequal lengths do not short-circuit.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = new Bun.CryptoHasher('sha256').update(a).digest();
  const hb = new Bun.CryptoHasher('sha256').update(b).digest();
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

const isResponse = (v: any): v is Response => v instanceof Response;

/**
 * Organisation-scoped gate, the sibling of guard() for routes that are about an
 * org rather than a room. Deliberately answers 404 for "you are not in this org"
 * so org ids are no more enumerable than invite codes are.
 */
function orgGuard(req: Request, orgId: string, min: 'owner' | 'admin' | 'member'):
  { user: NonNullable<ReturnType<typeof resolveSession>> } | Response {
  const user = resolveSession(db, sessionCookie(req));
  if (!user) return json({ error: 'Sign in first' }, 401);
  if (!getOrg(db, orgId)) return json({ error: 'Not found' }, 404);
  const m = membership(db, orgId, user.id);
  if (!m || !m.seat_active) return json({ error: 'Not found' }, 404);
  if (!hasOrgRole(m, min)) return json({ error: 'Forbidden' }, 403);
  return { user };
}

/**
 * The origin to hand OAuth providers as a redirect target.
 *
 * PUBLIC_ORIGIN wins because it is the only value that is definitely right: the
 * Host header is attacker-controlled, and using it to build a redirect_uri is
 * how host-header injection turns a login flow into a token-stealing redirect.
 * The request is only consulted in local development where nothing is set.
 */
function publicOrigin(req: Request): string {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, '');
  try { return new URL(req.url).origin; } catch { return 'http://localhost:4000'; }
}

const isForwardedHttps = (req: Request) =>
  (req.headers.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';

// ---------------------------------------------------------------------------
// Ingest — ONE path
//
// /events and /events/batch previously had separate implementations, and the
// batch one skipped validation, upsertAgent, lobby auto-tagging and the lobby
// broadcast. Two ingest paths that diverge silently is how a board ends up
// missing exactly the events someone was trying to show you.
// ---------------------------------------------------------------------------

function validateEvent(e: any): string | null {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'Event must be an object';
  if (!e.source || !e.agent_id || !e.event_type || !e.payload) {
    return 'Missing required fields: source, agent_id, event_type, payload';
  }
  if (typeof e.payload !== 'object') return 'payload must be an object';
  return null;
}

function ingestEvent(raw: AgentEvent): AgentEvent {
  if (!raw.session_id) raw.session_id = raw.agent_id;
  if (!raw.timestamp) raw.timestamp = Date.now();

  // Auto-tag with the agent's lobby when the producer did not say.
  if (!raw.lobby_id) {
    const lobby = getLobbyByAgent(raw.agent_id);
    if (lobby) raw.lobby_id = lobby.code;
  }

  if (RELAY_MODE === 'forward-only') return raw;

  const saved = insertEvent(raw);
  upsertAgent(raw);
  return saved;
}

function broadcastEvent(saved: AgentEvent): void {
  const message = JSON.stringify({ type: 'event', data: saved });
  fanoutGlobal(message);
  if (saved.lobby_id) fanoutLobby(saved.lobby_id, message);

  // Put a card on the board for results worth seeing. Server-side so every
  // viewer gets the same single object rather than each creating a duplicate.
  if (saved.lobby_id && RELAY_MODE !== 'forward-only') {
    try {
      const placed = placeArtifact(db, saved);
      if (placed) {
        fanoutLobby(saved.lobby_id, JSON.stringify({ type: 'canvas_object', data: placed }));
      }
    } catch (err) {
      // A placement failure must never lose the event itself.
      console.error('[placement] failed:', err);
    }
  }

  if (RELAY_MODE !== 'forward-only') {
    const agent = getAgent(saved.agent_id);
    if (agent) {
      const agentMsg = JSON.stringify({ type: 'agent_update', data: agent });
      fanoutGlobal(agentMsg);
      if (saved.lobby_id) fanoutLobby(saved.lobby_id, agentMsg);
    }
  }

  relayEvent(saved);
}

const server = Bun.serve({
  port: parseInt(process.env.SERVER_PORT || '4000'),

  async fetch(req: Request) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    // ---- rate limiting -----------------------------------------------------
    // Before routing, so a new endpoint is covered the day it is written rather
    // than the day someone remembers to add a limiter to it.
    //
    // Health checks are exempt: rate-limiting your own monitoring turns a busy
    // minute into a false alarm about being down. Static assets are exempt
    // because one page load is dozens of them and they are served from disk.
    if (!STATIC_PATHS.test(url.pathname)) {
      // Identity, when the caller has offered one. A bearer token or session
      // cookie gets its own bucket; everyone else shares the IP fallback.
      const ident =
        extractToken(req, url) ||
        sessionCookie(req) ||
        null;
      const verdict = throttleCheck(clientKey(req, ident), bucketFor(req.method, url.pathname));
      if (!verdict.ok) return tooMany(verdict.retryAfter || 1, headers);
    }

    // ---- request body size -------------------------------------------------
    //
    // Refused BEFORE any handler reads the body, because `await req.json()`
    // buffers the whole thing in memory first. Without this the container accepts
    // a 60MB POST in under a second — measured — and a handful of concurrent ones
    // exhausts a 512MB limit and takes every customer's board down with it. The
    // WebSocket has had a payload cap since the start; HTTP had none.
    //
    // Content-Length can be absent or a lie, so this is the cheap first line only:
    // it costs nothing and stops the honest-but-enormous case. Bun enforces its own
    // ceiling on the actual stream.
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const declared = Number(req.headers.get('content-length') || 0);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return json({
          error: `Request body too large. The limit is ${Math.floor(MAX_BODY_BYTES / 1024)}KB.`,
          limit_bytes: MAX_BODY_BYTES,
        }, 413);
      }
    }

    // POST /events — receive a new event from any producer
    if (url.pathname === '/events' && req.method === 'POST') {
      try {
        const event: AgentEvent = await req.json();

        const invalid = validateEvent(event);
        if (invalid) return json({ error: invalid }, 400);

        const savedEvent = ingestEvent(event);
        broadcastEvent(savedEvent);
        return json(savedEvent);
      } catch (error) {
        console.error('Error processing event:', error);
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // POST /events/batch — same path as /events, once per element
    if (url.pathname === '/events/batch' && req.method === 'POST') {
      try {
        const events: AgentEvent[] = await req.json();
        if (!Array.isArray(events)) return json({ error: 'Expected array' }, 400);
        if (events.length > MAX_BATCH) {
          return json({ error: `Batch too large (max ${MAX_BATCH})` }, 413);
        }

        // Validate the whole batch before writing any of it. Previously a bad
        // event halfway through left a partial write with no way to tell how far
        // it got.
        for (let i = 0; i < events.length; i++) {
          const invalid = validateEvent(events[i]);
          if (invalid) return json({ error: `events[${i}]: ${invalid}` }, 400);
        }

        const saved = events.map(ingestEvent);
        for (const ev of saved) broadcastEvent(ev);

        return json({ count: saved.length, seq: saved.length ? saved[saved.length - 1].seq : undefined });
      } catch (error) {
        console.error('Error processing batch:', error);
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // GET /events/filter-options
    if (url.pathname === '/events/filter-options' && req.method === 'GET') {
      const options = getFilterOptions();
      return new Response(JSON.stringify(options), {
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    // GET /events/recent?limit=&lobby=
    // limit is clamped in getRecentEvents: `?limit=abc` used to bind NaN and
    // `?limit=99999999` serialised the entire table.
    if (url.pathname === '/events/recent' && req.method === 'GET') {
      const denied = await requirePrincipal(req, url);
      if (denied) return denied;
      try {
        const limit = url.searchParams.get('limit');
        const lobby = url.searchParams.get('lobby') || undefined;
        return json(getRecentEvents(limit === null ? 300 : (limit as any), lobby));
      } catch (error) {
        console.error('Error reading recent events:', error);
        return json({ error: 'Query failed' }, 500);
      }
    }

    // GET /events/since?seq=&lobby= — delta feed for reconnect catch-up
    if (url.pathname === '/events/since' && req.method === 'GET') {
      const denied = await requirePrincipal(req, url);
      if (denied) return denied;
      try {
        const since = Number(url.searchParams.get('seq') || '0');
        if (!Number.isFinite(since) || since < 0) return json({ error: 'Invalid seq' }, 400);
        const lobby = url.searchParams.get('lobby') || undefined;
        const events = getEventsSince(since, lobby);
        return json({ seq: getCurrentSeq(), events });
      } catch (error) {
        console.error('Error reading delta:', error);
        return json({ error: 'Query failed' }, 500);
      }
    }

    // POST /events/:id/respond — HITL response
    if (url.pathname.match(/^\/events\/\d+\/respond$/) && req.method === 'POST') {
      const id = parseInt(url.pathname.split('/')[2]);
      try {
        const response: HumanInTheLoopResponse = await req.json();
        response.respondedAt = Date.now();

        const updatedEvent = updateEventHITLResponse(id, response);
        if (!updatedEvent) {
          return new Response(JSON.stringify({ error: 'Event not found' }), {
            status: 404, headers: { ...headers, 'Content-Type': 'application/json' }
          });
        }

        if (updatedEvent.humanInTheLoop?.responseWebSocketUrl) {
          try {
            await sendResponseToAgent(updatedEvent.humanInTheLoop.responseWebSocketUrl, response);
          } catch (error) {
            console.error('Failed to send HITL response to agent:', error);
          }
        }

        const message = JSON.stringify({ type: 'event', data: updatedEvent });
        wsClients.forEach(client => {
          try { client.send(message); } catch { wsClients.delete(client); }
        });

        return new Response(JSON.stringify(updatedEvent), {
          headers: { ...headers, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Error processing HITL response:', error);
        return new Response(JSON.stringify({ error: 'Invalid request' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
    }

    // GET /agents — list all registered agents
    if (url.pathname === '/agents' && req.method === 'GET') {
      const denied = await requirePrincipal(req, url);
      if (denied) return denied;
      const filter: any = {};
      if (url.searchParams.get('source')) filter.source = url.searchParams.get('source')!;
      if (url.searchParams.get('user_id')) filter.user_id = url.searchParams.get('user_id')!;
      if (url.searchParams.get('workspace_id')) filter.workspace_id = url.searchParams.get('workspace_id')!;
      if (url.searchParams.get('status')) filter.status = url.searchParams.get('status')!;
      const agents = getAgents(Object.keys(filter).length > 0 ? filter : undefined);
      return new Response(JSON.stringify(agents), {
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    // GET /agents/:id — get a specific agent
    if (url.pathname.startsWith('/agents/') && req.method === 'GET') {
      const denied = await requirePrincipal(req, url);
      if (denied) return denied;
      const agentId = decodeURIComponent(url.pathname.split('/')[2]);
      const agent = getAgent(agentId);
      if (!agent) {
        return new Response(JSON.stringify({ error: 'Agent not found' }), {
          status: 404, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify(agent), {
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    // PATCH /agents/:id — update agent status
    if (url.pathname.startsWith('/agents/') && (req.method === 'PATCH' || req.method === 'PUT')) {
      const agentId = decodeURIComponent(url.pathname.split('/')[2]);
      try {
        const body = await req.json();
        if (body.status) {
          const ok = updateAgentStatus(agentId, body.status);
          if (!ok) {
            return new Response(JSON.stringify({ error: 'Agent not found' }), {
              status: 404, headers: { ...headers, 'Content-Type': 'application/json' }
            });
          }
          const agent = getAgent(agentId);
          // Broadcast agent update
          const agentMsg = JSON.stringify({ type: 'agent_update', data: agent });
          wsClients.forEach(client => {
            try { client.send(agentMsg); } catch { wsClients.delete(client); }
          });
          return new Response(JSON.stringify(agent), {
            headers: { ...headers, 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ error: 'No status provided' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid request' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
    }

    // ===== LOBBY ENDPOINTS =====

    // POST /lobbies — create a new lobby
    if (url.pathname === '/lobbies' && req.method === 'POST') {
      try {
        const body = await req.json();
        if (!body.name) {
          return new Response(JSON.stringify({ error: 'Missing required field: name' }), {
            status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
          });
        }
        const visibility = body.visibility || 'private';
        // A signed-in human is the authoritative creator; `created_by` in the
        // body is only trusted for token-authenticated and local-dev callers,
        // otherwise anyone could create rooms attributed to someone else.
        const signedIn = resolveSession(db, sessionCookie(req));
        const createdBy = signedIn?.id || body.created_by || 'unknown';
        const lobby = createLobby(body.name, visibility, createdBy);

        // Attach the workspace to an organisation so teammates reach it through
        // their seat rather than by passing a bearer token around.
        if (signedIn) {
          const orgs = orgsForUser(db, signedIn.id);
          const wanted = body.org_id
            ? orgs.find((o) => o.id === body.org_id)
            : orgs[0];   // personal org, created at first sign-in
          if (body.org_id && !wanted) return json({ error: 'Not a member of that organisation' }, 403);
          if (wanted) setLobbyOrg(db, lobby.code, wanted.id);
        }

        // The creator is the owner, and this is the only time the plaintext
        // token exists. Only its argon2id hash is stored.
        const issued = await issueMemberToken(db, lobby.code, createdBy, 'owner', {
          display_name: body.display_name || signedIn?.name || undefined,
          color: body.color,
        });

        const attachedOrg = signedIn ? orgOfLobby(db, lobby.code) : null;
        audit(db, {
          org_id: attachedOrg, actor: createdBy,
          actor_kind: signedIn ? 'human' : 'agent',
          action: 'workspace.create', target: lobby.code,
          detail: { name: lobby.name, visibility }, ip: clientIp(req),
        });
        return json({
          ...lobby,
          org_id: attachedOrg,
          token: issued.token,
          member: issued.member,
        }, 201);
      } catch (error) {
        console.error('Error creating lobby:', error);
        return new Response(JSON.stringify({ error: 'Invalid request' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
    }

    // GET /lobbies — list public/unlisted lobbies
    if (url.pathname === '/lobbies' && req.method === 'GET') {
      const denied = await requirePrincipal(req, url);
      if (denied) return denied;
      const lobbies = listLobbies();
      return new Response(JSON.stringify(lobbies), {
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    // GET /lobbies/:code — get a specific lobby by code
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);

      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;

      const lobby = getLobby(code);
      // Never return token material, even hashed.
      return json({ ...lobby, members: listMembers(db, code) });
    }

    // GET /lobbies/:code/members
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/members$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      return json(listMembers(db, code));
    }

    // DELETE /lobbies/:code/members/:id — owner revokes a member's access
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/members\/\d+$/) && req.method === 'DELETE') {
      const parts = url.pathname.split('/');
      const code = parts[2];
      const memberId = parseInt(parts[4]);
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);

      const g = await guard(req, url, code, 'owner');
      if (isResponse(g)) return g;

      const target = listMembers(db, code).find(m => m.id === memberId);
      if (!target) return json({ error: 'Member not found' }, 404);
      revokeMember(db, memberId);
      return json({ success: true, revoked: memberId });
    }

    // POST /lobbies/:code/join — join a lobby
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/join$/) && req.method === 'POST') {
      const code = url.pathname.split('/')[2];
      try {
        const body = await req.json();
        if (!body.user_id || !body.agent_id) {
          return new Response(JSON.stringify({ error: 'Missing required fields: user_id, agent_id' }), {
            status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
          });
        }
        const lobby = joinLobby(code, body.user_id, body.agent_id, body.source || 'unknown');
        if (!lobby) return json({ error: 'Lobby not found' }, 404);

        // Issue a member token unless this user already holds one. Re-issuing on
        // every join would silently invalidate the token their other sessions
        // are still using.
        const existing = getMemberByUser(db, code, body.user_id);
        let token: string | undefined;
        if (!existing) {
          const issued = await issueMemberToken(db, code, body.user_id, body.role === 'viewer' ? 'viewer' : 'editor', {
            display_name: body.display_name,
            color: body.color,
          });
          token = issued.token;
        }
        // Notify all lobby WebSocket clients about the new member
        const lobbyClients = lobbyWsClients.get(code);
        if (lobbyClients) {
          const joinMsg = JSON.stringify({ type: 'lobby_member_joined', data: { lobby: lobby.code, user_id: body.user_id, agent_id: body.agent_id } });
          lobbyClients.forEach(client => {
            try { client.send(joinMsg); } catch { lobbyClients.delete(client); }
          });
        }
        return json({ ...lobby, token, member: existing || getMemberByUser(db, code, body.user_id) });
      } catch (error) {
        console.error('Error joining lobby:', error);
        return new Response(JSON.stringify({ error: 'Invalid request' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
    }

    // POST /lobbies/:code/leave — leave a lobby
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/leave$/) && req.method === 'POST') {
      const code = url.pathname.split('/')[2];
      try {
        const body = await req.json();
        if (!body.agent_id) {
          return new Response(JSON.stringify({ error: 'Missing required field: agent_id' }), {
            status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
          });
        }
        const left = leaveLobby(code, body.agent_id);
        // Notify lobby WebSocket clients
        const lobbyClients = lobbyWsClients.get(code);
        if (lobbyClients) {
          const leaveMsg = JSON.stringify({ type: 'lobby_member_left', data: { lobby: code, agent_id: body.agent_id } });
          lobbyClients.forEach(client => {
            try { client.send(leaveMsg); } catch { lobbyClients.delete(client); }
          });
        }
        return new Response(JSON.stringify({ success: left }), {
          headers: { ...headers, 'Content-Type': 'application/json' }
        });
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid request' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
    }

    // DELETE /lobbies/:code — delete a lobby. Owner only; this was wide open,
    // so anyone who knew a 6-character code could destroy someone else's room.
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+$/) && req.method === 'DELETE') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);

      const g = await guard(req, url, code, 'owner');
      if (isResponse(g)) return g;

      // Recorded BEFORE the row goes away — afterwards there is nothing left to
      // name, and "a workspace that no longer exists was deleted by someone" is
      // not an audit trail.
      audit(db, {
        org_id: orgOfLobby(db, code), actor: g.member?.user_id || 'unknown',
        action: 'workspace.delete', target: code,
        detail: { name: getLobby(code)?.name }, ip: clientIp(req),
      });

      // deleteLobby() only ever removed the lobbies row and lobby_members, so a
      // "deleted" workspace left behind every artifact, message, pin and event —
      // plus its members rows, which hold token hashes. Deleting a room now
      // deletes the room.
      const report = deleteWorkspaceData(db, code);
      const deleted = true;
      console.log(`[data] workspace ${code} deleted — ${report.total} rows`);

      // Close all lobby WS connections
      const lobbyClients = lobbyWsClients.get(code);
      if (lobbyClients) {
        lobbyClients.forEach(client => {
          try { client.send(JSON.stringify({ type: 'lobby_deleted', data: { code } })); } catch {}
        });
        lobbyWsClients.delete(code);
      }
      return new Response(JSON.stringify({ success: deleted }), {
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    // GET /lobbies/:code/events — events for one lobby
    //
    // Filtered in SQL. It used to fetch the newest 300 events globally and then
    // filter in JS, so on a busy server a quiet lobby rendered completely empty
    // — its events were real, just never in the last 300 rows.
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/events$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      const limit = url.searchParams.get('limit');
      return json(getRecentEvents(limit === null ? 300 : (limit as any), code));
    }

    // WS /lobby/:code/stream — lobby-scoped WebSocket channel
    if (url.pathname.match(/^\/lobby\/[A-Z0-9]+\/stream$/)) {
      if (!originAllowed(req)) return json({ error: 'Origin not allowed' }, 403);
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);

      // Authorized BEFORE the handshake. A socket streams every event in the
      // lobby, so this is the single most important place not to skip the check.
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      if (g.member) touchMember(db, g.member.id);

      // Identity comes from the token when present. Trusting ?user_id= would let
      // anyone claim to be anyone on the board.
      const data: WsData = {
        lobbyCode: code,
        userId: g.member?.user_id || (url.searchParams.get('user_id') || 'anon').slice(0, 64),
        role: g.member?.role || 'editor',
        limiter: new RateLimiter(30, 15),            // durable writes
        ephemeralLimiter: new RateLimiter(600, 300), // cursor frames
      };
      const success = server.upgrade(req, { data });
      if (success) return undefined;
      return json({ error: 'WebSocket upgrade failed' }, 400);
    }

    // ===== CANVAS OBJECTS =====

    // GET /lobbies/:code/canvas?bbox=x1,y1,x2,y2 — board snapshot
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/canvas$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;

      let bbox: [number, number, number, number] | undefined;
      const raw = url.searchParams.get('bbox');
      if (raw) {
        const parts = raw.split(',').map(Number);
        if (parts.length === 4 && parts.every(Number.isFinite)) {
          bbox = parts as [number, number, number, number];
        }
      }
      return json({
        seq: getCurrentSeq(),
        objects: getObjects(db, code, { bbox, limit: clampLimit(url.searchParams.get('limit'), 5000) }),
      });
    }

    // GET /lobbies/:code/canvas/since?seq= — delta, tombstones included
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/canvas\/since$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      const since = Number(url.searchParams.get('seq') || '0');
      if (!Number.isFinite(since) || since < 0) return json({ error: 'Invalid seq' }, 400);
      return json({ seq: getCurrentSeq(), objects: getObjectsSince(db, code, since) });
    }

    // POST /lobbies/:code/canvas — create or update an object (LWW)
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/canvas$/) && req.method === 'POST') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      // Writing to the board is an editor action — a viewer can look, not draw.
      const g = await guard(req, url, code, 'editor');
      if (isResponse(g)) return g;
      try {
        const body = await req.json();
        if (!body || typeof body.id !== 'string' || !body.id) {
          return json({ error: 'Missing required field: id' }, 400);
        }
        // Authorship comes from the token when there is one — never from the
        // request body, which the caller controls.
        const actor = g.member?.user_id || body.updated_by || body.created_by;
        const result = upsertObject(db, code, body, actor);
        if (result.accepted) {
          fanoutLobby(code, JSON.stringify({ type: 'canvas_object', data: result.object }));
        }
        // A rejected write still returns the winner, so the caller repairs
        // itself rather than silently diverging.
        return json(result, result.accepted ? 200 : 409);
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // DELETE /lobbies/:code/canvas/:id — tombstone
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/canvas\/[^/]+$/) && req.method === 'DELETE') {
      const parts = url.pathname.split('/');
      const code = parts[2];
      const id = decodeURIComponent(parts[4]);
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'editor');
      if (isResponse(g)) return g;
      const result = deleteObject(db, code, id, g.member?.user_id || url.searchParams.get('by') || undefined);
      if (!result) return json({ error: 'Object not found' }, 404);
      fanoutLobby(code, JSON.stringify({ type: 'canvas_object', data: result.object }));
      return json(result);
    }

    // ===== ROOM CHAT =====
    //
    // Chat is gated at `viewer`, not `editor`. A viewer cannot change the board,
    // but a person invited to watch who is not allowed to say anything is a
    // read-only screenshare, not a room. Spam is bounded by the rate limiter on
    // the socket path, not by taking speech away from a role.

    // GET /lobbies/:code/messages?limit=&before_seq= — backlog, oldest-first
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/messages$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      const beforeSeq = Number(url.searchParams.get('before_seq') || '0');
      return json({
        seq: getCurrentSeq(),
        messages: getMessages(db, code, {
          limit: clampLimit(url.searchParams.get('limit'), 500),
          beforeSeq: Number.isFinite(beforeSeq) && beforeSeq > 0 ? beforeSeq : undefined,
        }),
      });
    }

    // GET /lobbies/:code/messages/since?seq= — delta, tombstones included
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/messages\/since$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      const since = Number(url.searchParams.get('seq') || '0');
      if (!Number.isFinite(since) || since < 0) return json({ error: 'Invalid seq' }, 400);
      return json({ seq: getCurrentSeq(), messages: getMessagesSince(db, code, since) });
    }

    // POST /lobbies/:code/messages — say something
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/messages$/) && req.method === 'POST') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      try {
        const body = await req.json();
        // Authorship from the token, never the body. Unauthenticated local dev
        // is the only case where the body gets a say.
        const author = g.member?.user_id || (REQUIRE_AUTH ? null : body.author_user);
        if (!author) return json({ error: 'Cannot determine author' }, 400);
        const saved = postMessage(db, code, body, author);
        fanoutLobby(code, JSON.stringify({ type: 'chat_message', data: saved }));
        return json(saved, 201);
      } catch (err) {
        if (err instanceof ChatError) return json({ error: err.message }, 400);
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // DELETE /lobbies/:code/messages/:id — withdraw. Author or owner only.
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/messages\/\d+$/) && req.method === 'DELETE') {
      const parts = url.pathname.split('/');
      const code = parts[2];
      const id = parseInt(parts[4]);
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      const existing = getMessage(db, code, id);
      if (!existing) return json({ error: 'Message not found' }, 404);
      // Deleting someone else's words is an owner action. An editor moderating
      // the room would be a different product decision than the one made here.
      const isAuthor = !!g.member && g.member.user_id === existing.author_user;
      const isOwner = g.member?.role === 'owner';
      if (REQUIRE_AUTH && !isAuthor && !isOwner) {
        return json({ error: 'Forbidden: only the author or the lobby owner can delete a message' }, 403);
      }
      const result = deleteMessage(db, code, id);
      if (result) fanoutLobby(code, JSON.stringify({ type: 'chat_message', data: result }));
      return json(result);
    }

    // ===== AGENT SURFACE =====
    // The interface bots actually use. Everything here answers in compact text
    // rather than JSON: a model reads it more reliably and it costs roughly half
    // the tokens once braces, quotes and repeated keys are counted.
    //
    // Identity always comes from the verified token. No route here accepts an
    // author, member or lobby in its payload — a bot that can name its own
    // identity can impersonate every other member of the room.

    // GET /lobbies/:code/agent/brief?since=&detail=1&budget=&limit=
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/agent\/brief$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      const viewer = g.member?.user_id || 'anonymous';
      const brief = roomBrief(db, code, viewer, {
        since: Number(url.searchParams.get('since')) || 0,
        detail: url.searchParams.get('detail') === '1',
        budget: Number(url.searchParams.get('budget')) || undefined,
        limit: Number(url.searchParams.get('limit')) || undefined,
      });
      return json(brief);
    }

    // GET /lobbies/:code/agent/artifact/:handle — one artifact in full
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/agent\/artifact\/[a-z0-9]+$/i) && req.method === 'GET') {
      const parts = url.pathname.split('/');
      const code = parts[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      try {
        return json({ text: artifactDetail(db, code, parts[5], g.member?.user_id || 'anonymous') });
      } catch (err) {
        if (err instanceof AgentError) return json({ error: err.message }, 404);
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // POST /lobbies/:code/agent/post — put an artifact on the board
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/agent\/post$/) && req.method === 'POST') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'editor');
      if (isResponse(g)) return g;
      const actor = g.member?.user_id || (REQUIRE_AUTH ? null : 'anonymous');
      if (!actor) return json({ error: 'Cannot determine author' }, 400);
      try {
        const body = await req.json();
        const result = postArtifact(db, code, body, actor);
        if (!result.deduped) {
          const obj = getObjectById(db, code, result.id);
          if (obj) fanoutLobby(code, JSON.stringify({ type: 'canvas_object', data: obj }));
        }
        return json(result, result.deduped ? 200 : 201);
      } catch (err) {
        if (err instanceof AgentError) return json({ error: err.message }, 400);
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // ===== ANNOTATIONS ON THE BOARD =====

    // GET /lobbies/:code/annotations?target_type=&target_id=&resolved=1
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/annotations$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      const t = url.searchParams.get('target_type');
      return json({
        seq: getCurrentSeq(),
        annotations: listAnnotations(db, code, {
          targetType: t === 'event' || t === 'object' || t === 'point' ? t : undefined,
          targetId: url.searchParams.get('target_id') || undefined,
          includeResolved: url.searchParams.get('resolved') === '1',
          limit: clampLimit(url.searchParams.get('limit'), 2000),
        }),
      });
    }

    // GET /lobbies/:code/annotations/since?seq=
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/annotations\/since$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      const since = Number(url.searchParams.get('seq') || '0');
      if (!Number.isFinite(since) || since < 0) return json({ error: 'Invalid seq' }, 400);
      return json({ seq: getCurrentSeq(), annotations: getAnnotationsSince(db, code, since) });
    }

    // POST /lobbies/:code/annotations — pin a comment on an event, object or point
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/annotations$/) && req.method === 'POST') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      // A pin is a mark on the board, so it is an editor action.
      const g = await guard(req, url, code, 'editor');
      if (isResponse(g)) return g;
      try {
        const body = await req.json();
        const author = g.member?.user_id || (REQUIRE_AUTH ? null : body.user_id);
        if (!author) return json({ error: 'Cannot determine author' }, 400);
        const saved = createAnnotation(db, code, body, author);
        fanoutLobby(code, JSON.stringify({ type: 'annotation', data: saved }));
        return json(saved, 201);
      } catch (err) {
        if (err instanceof AnnotationError) return json({ error: err.message }, 400);
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // PATCH /lobbies/:code/annotations/:id — resolve or reopen a thread
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/annotations\/\d+$/) && req.method === 'PATCH') {
      const parts = url.pathname.split('/');
      const code = parts[2];
      const id = parseInt(parts[4]);
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'editor');
      if (isResponse(g)) return g;
      try {
        const body = await req.json();
        if (typeof body.resolved !== 'boolean') return json({ error: 'resolved must be a boolean' }, 400);
        const result = setResolved(db, code, id, body.resolved);
        if (!result) return json({ error: 'Annotation not found' }, 404);
        fanoutLobby(code, JSON.stringify({ type: 'annotation', data: result }));
        return json(result);
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // DELETE /lobbies/:code/annotations/:id — author or owner
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/annotations\/\d+$/) && req.method === 'DELETE') {
      const parts = url.pathname.split('/');
      const code = parts[2];
      const id = parseInt(parts[4]);
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'editor');
      if (isResponse(g)) return g;
      const existing = getAnnotation(db, code, id);
      if (!existing) return json({ error: 'Annotation not found' }, 404);
      const isAuthor = !!g.member && g.member.user_id === existing.user_id;
      const isOwner = g.member?.role === 'owner';
      if (REQUIRE_AUTH && !isAuthor && !isOwner) {
        return json({ error: 'Forbidden: only the author or the lobby owner can delete an annotation' }, 403);
      }
      const result = deleteAnnotation(db, code, id);
      if (result) fanoutLobby(code, JSON.stringify({ type: 'annotation', data: result }));
      return json(result);
    }

    // GET /lobbies/:code/presence — who is live on the board right now
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/presence$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      return json(getEphemeral(code));
    }

    // ===== MULTIPLAYER ENDPOINTS =====

    // POST /presence — register or update user presence
    if (url.pathname === '/presence' && req.method === 'POST') {
      try {
        const body = await req.json();
        if (!body.user_id || !body.display_name) {
          return new Response(JSON.stringify({ error: 'Missing required fields: user_id, display_name' }), {
            status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
          });
        }
        upsertPresence(body);
        // Broadcast presence update to all clients
        const presenceMsg = JSON.stringify({ type: 'presence_update', data: body });
        wsClients.forEach(client => {
          try { client.send(presenceMsg); } catch { wsClients.delete(client); }
        });
        if (body.current_lobby) {
          const lobbyClients = lobbyWsClients.get(body.current_lobby);
          if (lobbyClients) {
            lobbyClients.forEach(client => {
              try { client.send(presenceMsg); } catch { lobbyClients.delete(client); }
            });
          }
        }
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...headers, 'Content-Type': 'application/json' }
        });
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid request' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
    }

    // GET /presence — get all online users
    if (url.pathname === '/presence' && req.method === 'GET') {
      const denied = await requirePrincipal(req, url);
      if (denied) return denied;
      const users = getOnlineUsers();
      return new Response(JSON.stringify(users), {
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    // GET /presence/lobby/:code — get users in a lobby
    if (url.pathname.match(/^\/presence\/lobby\/[A-Z0-9]+$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[3];
      const users = getLobbyPresence(code);
      return new Response(JSON.stringify(users), {
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    // POST /presence/heartbeat — keep presence alive
    if (url.pathname === '/presence/heartbeat' && req.method === 'POST') {
      try {
        const body = await req.json();
        if (body.user_id) heartbeatPresence(body.user_id);
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...headers, 'Content-Type': 'application/json' }
        });
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid request' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
    }

    // ----- legacy annotation routes -------------------------------------------
    //
    // These predate lobby scoping and were wide open: anyone could POST a comment
    // into any room and GET every comment in it by guessing a 6-character code.
    // The Phase 1c auth pass missed them because they are not lobby-path-shaped,
    // so the membership guard never ran. They now route through the same guard
    // as everything else. Clients should move to /lobbies/:code/annotations.

    // POST /annotations — add a comment on an event
    if (url.pathname === '/annotations' && req.method === 'POST') {
      try {
        const body = await req.json();
        if (!body.event_id || !body.text) {
          return json({ error: 'Missing required fields: event_id, text' }, 400);
        }
        // No lobby means no room to authorize against. Under REQUIRE_AUTH that
        // is a refusal, not a global comment.
        const code = typeof body.lobby_id === 'string' ? body.lobby_id : '';
        if (!code) {
          if (REQUIRE_AUTH) return json({ error: 'lobby_id is required' }, 400);
          const annotation = addAnnotation(body.event_id, body.user_id || 'anon', body.text);
          const annMsg = JSON.stringify({ type: 'annotation', data: annotation });
          wsClients.forEach(client => {
            try { client.send(annMsg); } catch { wsClients.delete(client); }
          });
          return json(annotation, 201);
        }
        if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
        const g = await guard(req, url, code, 'editor');
        if (isResponse(g)) return g;
        const author = g.member?.user_id || (REQUIRE_AUTH ? null : body.user_id);
        if (!author) return json({ error: 'Cannot determine author' }, 400);
        const saved = createAnnotation(
          db, code, { text: body.text, target_type: 'event', target_id: body.event_id }, author
        );
        fanoutLobby(code, JSON.stringify({ type: 'annotation', data: saved }));
        return json(saved, 201);
      } catch (err) {
        if (err instanceof AnnotationError) return json({ error: err.message }, 400);
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // GET /annotations/:eventId — comments on one event, scoped to rooms the
    // caller is actually in. An event can be discussed in more than one lobby,
    // and a member of one must not read the other's thread.
    if (url.pathname.match(/^\/annotations\/\d+$/) && req.method === 'GET') {
      const eventId = parseInt(url.pathname.split('/')[2]);
      if (!REQUIRE_AUTH) return json(getAnnotations(eventId));
      const out: any[] = [];
      for (const code of lobbiesForEvent(db, eventId)) {
        const g = await guard(req, url, code, 'viewer');
        if (isResponse(g)) continue;
        out.push(...listAnnotations(db, code, {
          targetType: 'event', targetId: String(eventId), includeResolved: true,
        }));
      }
      return json(out);
    }

    // GET /annotations/lobby/:code — recent comments in one lobby
    if (url.pathname.match(/^\/annotations\/lobby\/[A-Z0-9]+$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[3];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'viewer');
      if (isResponse(g)) return g;
      return json(getLobbyAnnotations(code));
    }

    // POST /canvas/position — update a node position (drag sync)
    if (url.pathname === '/canvas/position' && req.method === 'POST') {
      try {
        const body = await req.json();
        if (!body.agent_id || body.x === undefined || body.y === undefined) {
          return new Response(JSON.stringify({ error: 'Missing required fields: agent_id, x, y' }), {
            status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
          });
        }
        updateNodePosition(body.agent_id, body.x, body.y, body.updated_by || 'unknown');
        // Broadcast position update to all clients
        const posMsg = JSON.stringify({ type: 'canvas_position', data: body });
        wsClients.forEach(client => {
          try { client.send(posMsg); } catch { wsClients.delete(client); }
        });
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...headers, 'Content-Type': 'application/json' }
        });
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid request' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
    }

    // GET /canvas/positions — get all saved node positions
    if (url.pathname === '/canvas/positions' && req.method === 'GET') {
      const positions = getNodePositions();
      return new Response(JSON.stringify(positions), {
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    // ===== SIGN-IN, ORGS AND SEATS =====

    // GET /auth/providers — which sign-in buttons the client should show.
    if (url.pathname === '/auth/providers' && req.method === 'GET') {
      const providers: string[] = [...configuredProviders()];
      if (emailAuthAvailable()) providers.push('email');
      return json({ providers });
    }

    // POST /auth/email/start — send a sign-in link.
    //
    // Answers the same way for an address that has an account and one that does
    // not: this endpoint must not become a way to ask whether someone is a
    // customer. Refusals are only for input we will not process at all.
    if (url.pathname === '/auth/email/start' && req.method === 'POST') {
      if (!emailAuthAvailable()) {
        return json({ error: 'Email sign-in is not available on this server.' }, 503);
      }
      const body = await req.json().catch(() => ({}));
      try {
        await startEmailSignIn(db, String(body?.email || ''), publicOrigin(req), {
          redirect: typeof body?.redirect === 'string' ? body.redirect : undefined,
          ip: clientIp(req),
        });
        return json({ ok: true, sent: true });
      } catch (err) {
        if (err instanceof EmailAuthError) return json({ error: err.message }, 400);
        console.error('[auth/email/start]', err);
        return json({ error: 'Could not send a sign-in link. Try again shortly.' }, 500);
      }
    }

    // GET /auth/email/callback — redeem the link.
    //
    // Always a redirect, never a JSON body: this URL is opened by a mail client,
    // and the person on the other end needs to land in the product or on a screen
    // that tells them what to do next.
    if (url.pathname === '/auth/email/callback' && req.method === 'GET') {
      try {
        const { profile, redirect } = consumeEmailLink(db, url.searchParams.get('token'));
        const { user } = upsertUser(db, profile);
        const { token } = createSession(db, user.id, req.headers.get('user-agent') || undefined);
        audit(db, {
          actor: user.id, action: 'user.signin',
          detail: { provider: 'email' }, ip: clientIp(req),
          org_id: orgsForUser(db, user.id)[0]?.id ?? null,
        });
        return new Response(null, {
          status: 302,
          headers: {
            ...headers,
            // Redirect drops the token from the visible URL, so it does not sit
            // in history or leak through a Referer on the next navigation.
            Location: safeRedirect(redirect),
            'Set-Cookie': sessionCookieHeader(token, url.protocol === 'https:' || isForwardedHttps(req)),
          },
        });
      } catch (err) {
        const msg = err instanceof EmailAuthError ? err.message : 'Sign-in failed';
        return new Response(null, {
          status: 302,
          headers: { ...headers, Location: `/?auth_error=${encodeURIComponent(msg)}` },
        });
      }
    }

    // GET /auth/:provider — start the flow
    if (url.pathname.match(/^\/auth\/(github|google)$/) && req.method === 'GET') {
      const p = url.pathname.split('/')[2] as Provider;
      const target = authorizeUrl(db, p, publicOrigin(req), url.searchParams.get('redirect'));
      if (!target) return json({ error: `${p} sign-in is not configured on this server` }, 503);
      return new Response(null, { status: 302, headers: { ...headers, Location: target } });
    }

    // GET /auth/:provider/callback — the browser comes back
    if (url.pathname.match(/^\/auth\/(github|google)\/callback$/) && req.method === 'GET') {
      const p = url.pathname.split('/')[2] as Provider;
      try {
        const { profile, redirect } = await handleCallback(
          db, p, publicOrigin(req), url.searchParams.get('code'), url.searchParams.get('state')
        );
        const { user } = upsertUser(db, profile);
        const { token } = createSession(db, user.id, req.headers.get('user-agent') || undefined);
        audit(db, {
          actor: user.id, action: 'user.signin',
          detail: { provider: p }, ip: clientIp(req),
          org_id: orgsForUser(db, user.id)[0]?.id ?? null,
        });
        return new Response(null, {
          status: 302,
          headers: {
            ...headers,
            Location: safeRedirect(redirect),
            'Set-Cookie': sessionCookieHeader(token, url.protocol === 'https:' || isForwardedHttps(req)),
          },
        });
      } catch (err) {
        const msg = err instanceof OAuthError ? err.message : 'Sign-in failed';
        return new Response(null, {
          status: 302,
          headers: { ...headers, Location: `/?auth_error=${encodeURIComponent(msg)}` },
        });
      }
    }

    // POST /auth/logout
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      const tok = sessionCookie(req);
      if (tok) destroySession(db, tok);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...headers, 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie },
      });
    }

    // GET /auth/me — who am I, and which orgs am I in
    if (url.pathname === '/auth/me' && req.method === 'GET') {
      const user = resolveSession(db, sessionCookie(req));
      if (!user) return json({ user: null, orgs: [] });
      const orgs = orgsForUser(db, user.id).map((o) => ({
        ...o,
        seats_used: seatsUsed(db, o.id),
        price_cents: PLANS[o.plan]?.priceCents ?? null,
        extra_seat_cents: PLANS[o.plan]?.extraSeatCents ?? null,
      }));
      return json({ user: { id: user.id, name: user.name, email: user.email, avatar_url: user.avatar_url }, orgs });
    }

    // POST /orgs — create an organisation
    if (url.pathname === '/orgs' && req.method === 'POST') {
      const user = resolveSession(db, sessionCookie(req));
      if (!user) return json({ error: 'Sign in first' }, 401);
      const body = await req.json().catch(() => ({}));
      const name = String(body?.name || '').trim().slice(0, 80);
      if (!name) return json({ error: 'name is required' }, 400);
      const plan = body?.plan === 'organization' ? 'organization' : 'personal';
      return json(createOrg(db, name, user.id, plan), 201);
    }

    // GET /orgs/:id/members — the roster and the seat count
    if (url.pathname.match(/^\/orgs\/[\w-]+\/members$/) && req.method === 'GET') {
      const orgId = url.pathname.split('/')[2];
      const g = orgGuard(req, orgId, 'member');
      if (isResponse(g)) return g;
      const org = getOrg(db, orgId)!;
      const rows = db.prepare(`
        SELECT m.user_id, m.role, m.seat_active, m.joined_at, u.name, u.email, u.avatar_url
        FROM org_members m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ? ORDER BY m.joined_at ASC
      `).all(orgId) as any[];
      return json({
        org: { ...org, seats_used: seatsUsed(db, orgId) },
        members: rows.map((r) => ({ ...r, seat_active: !!r.seat_active })),
      });
    }

    // POST /orgs/:id/members — add someone. Fails loudly when out of seats.
    if (url.pathname.match(/^\/orgs\/[\w-]+\/members$/) && req.method === 'POST') {
      const orgId = url.pathname.split('/')[2];
      const g = orgGuard(req, orgId, 'admin');
      if (isResponse(g)) return g;
      const body = await req.json().catch(() => ({}));
      const target = String(body?.user_id || '');
      if (!getUser(db, target)) return json({ error: 'No such user' }, 404);
      try {
        const role = ['owner', 'admin', 'member'].includes(body?.role) ? body.role : 'member';
        const added = addOrgMember(db, orgId, target, role, g.user.id);
        audit(db, {
          org_id: orgId, actor: g.user.id, action: 'org.member_add',
          target, detail: { role }, ip: clientIp(req),
        });
        return json(added, 201);
      } catch (err) {
        // 402 rather than 403: this is not "you may not", it is "buy a seat".
        if (err instanceof SeatError) return json({ error: err.message, code: 'seat_limit' }, 402);
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // DELETE /orgs/:id/members/:userId — release a seat
    if (url.pathname.match(/^\/orgs\/[\w-]+\/members\/[\w-]+$/) && req.method === 'DELETE') {
      const parts = url.pathname.split('/');
      const g = orgGuard(req, parts[2], 'admin');
      if (isResponse(g)) return g;
      try {
        deactivateSeat(db, parts[2], parts[4]);
        audit(db, {
          org_id: parts[2], actor: g.user.id, action: 'org.member_remove',
          target: parts[4], ip: clientIp(req),
        });
        return json({ ok: true, seats_used: seatsUsed(db, parts[2]) });
      } catch (err) {
        return json({ error: err instanceof SeatError ? err.message : 'Invalid request' }, 400);
      }
    }

    // PATCH /orgs/:id — plan and seat count
    if (url.pathname.match(/^\/orgs\/[\w-]+$/) && req.method === 'PATCH') {
      const orgId = url.pathname.split('/')[2];
      const g = orgGuard(req, orgId, 'owner');
      if (isResponse(g)) return g;
      const body = await req.json().catch(() => ({}));
      try {
        const before = getOrg(db, orgId)!;
        if (body?.plan === 'personal' || body?.plan === 'organization') setPlan(db, orgId, body.plan);
        if (Number.isFinite(body?.seat_limit)) setSeatLimit(db, orgId, Number(body.seat_limit));
        const after = getOrg(db, orgId)!;
        if (after.plan !== before.plan) {
          audit(db, { org_id: orgId, actor: g.user.id, action: 'org.plan_change',
                      detail: { from: before.plan, to: after.plan }, ip: clientIp(req) });
        }
        if (after.seat_limit !== before.seat_limit) {
          audit(db, { org_id: orgId, actor: g.user.id, action: 'org.seats_change',
                      detail: { from: before.seat_limit, to: after.seat_limit }, ip: clientIp(req) });
        }
        return json({ ...after, seats_used: seatsUsed(db, orgId) });
      } catch (err) {
        if (err instanceof SeatError) return json({ error: err.message, code: 'seat_limit' }, 409);
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // POST /orgs/:id/promo — redeem a promo code onto this org. No Stripe
    // involved and no card is ever collected; this sets the plan directly.
    if (url.pathname.match(/^\/orgs\/[\w-]+\/promo$/) && req.method === 'POST') {
      const orgId = url.pathname.split('/')[2];
      const g = orgGuard(req, orgId, 'owner');
      if (isResponse(g)) return g;
      const body = await req.json().catch(() => ({}));
      if (typeof body?.code !== 'string' || !body.code.trim()) {
        return json({ error: 'A promo code is required.' }, 400);
      }
      try {
        const org = redeemPromoCode(db, body.code, orgId, g.user.id);
        audit(db, { org_id: orgId, actor: g.user.id, action: 'org.promo_redeemed',
                    detail: { code: body.code.trim().toUpperCase() }, ip: clientIp(req) });
        return json({ ...org, seats_used: seatsUsed(db, orgId) });
      } catch (err) {
        if (err instanceof PromoError) return json({ error: err.message, code: 'promo_invalid' }, 400);
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // GET /orgs/:id/audit — who did what. Admins and owners; a plain member
    // reading the whole org's activity is not the same thing as using the app.
    if (url.pathname.match(/^\/orgs\/[\w-]+\/audit$/) && req.method === 'GET') {
      const orgId = url.pathname.split('/')[2];
      const g = orgGuard(req, orgId, 'admin');
      if (isResponse(g)) return g;
      return json({
        entries: readAudit(db, {
          org_id: orgId,
          since: Number(url.searchParams.get('since')) || undefined,
          before: Number(url.searchParams.get('before')) || undefined,
          action: url.searchParams.get('action') || undefined,
          actor: url.searchParams.get('actor') || undefined,
          limit: Number(url.searchParams.get('limit')) || undefined,
        }),
        retention_days: Math.max(30, parseInt(process.env.AUDIT_RETENTION_DAYS || '', 10) || 365),
      });
    }

    // GET /lobbies/:code/export — the whole workspace as portable JSON.
    // Owner-only: an export is every message and artifact in the room at once,
    // which is a different thing from being able to read the room.
    if (url.pathname.match(/^\/lobbies\/[A-Z0-9]+\/export$/) && req.method === 'GET') {
      const code = url.pathname.split('/')[2];
      if (!getLobby(code)) return json({ error: 'Lobby not found' }, 404);
      const g = await guard(req, url, code, 'owner');
      if (isResponse(g)) return g;

      const data = exportWorkspace(db, code);
      if (!data) return json({ error: 'Lobby not found' }, 404);
      audit(db, {
        org_id: orgOfLobby(db, code), actor: g.member?.user_id || 'unknown',
        action: 'workspace.export', target: code,
        detail: data.counts, ip: clientIp(req),
      });
      return new Response(JSON.stringify(data, null, 2), {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="lobby-${code}.json"`,
        },
      });
    }

    // GET /orgs/:id/deletion-preview — what "delete everything" would remove.
    // Irreversible actions should be previewable; a count in front of the
    // confirm button is the difference between a decision and a mis-click.
    if (url.pathname.match(/^\/orgs\/[\w-]+\/deletion-preview$/) && req.method === 'GET') {
      const orgId = url.pathname.split('/')[2];
      const g = orgGuard(req, orgId, 'owner');
      if (isResponse(g)) return g;
      return json({ org_id: orgId, would_delete: previewOrgDeletion(db, orgId) });
    }

    // DELETE /orgs/:id — delete the organisation and everything it owns.
    //
    // Requires the org's exact name as confirmation. A destructive endpoint that
    // fires on a bare DELETE is one stray curl from unrecoverable, and this is
    // the one action in the product with no undo.
    if (url.pathname.match(/^\/orgs\/[\w-]+$/) && req.method === 'DELETE') {
      const orgId = url.pathname.split('/')[2];
      const g = orgGuard(req, orgId, 'owner');
      if (isResponse(g)) return g;
      const org = getOrg(db, orgId)!;
      const body = await req.json().catch(() => ({}));
      if (String(body?.confirm || '') !== org.name) {
        return json({
          error: `To delete this organisation, send {"confirm": ${JSON.stringify(org.name)}}. This cannot be undone.`,
          code: 'confirm_required',
        }, 400);
      }
      // Logged before the org's audit rows are removed with it — this entry is
      // the last thing written about the org, and it survives only in backups.
      audit(db, {
        org_id: orgId, actor: g.user.id, action: 'data.delete',
        target: orgId, detail: previewOrgDeletion(db, orgId), ip: clientIp(req),
      });
      const report = deleteOrgData(db, orgId);
      console.log(`[data] org ${orgId} deleted by ${g.user.id}:`, JSON.stringify(report.workspaces.length) + ' workspace(s)');
      return json(report);
    }

    // GET /admin/backups — operator-only. Deliberately NOT org-scoped and NOT
    // reachable with a normal session: it describes the whole deployment.
    if (url.pathname === '/admin/backups' && req.method === 'GET') {
      const key = process.env.ADMIN_KEY;
      if (!key) return json({ error: 'Not found' }, 404);
      const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      // Length-independent compare, so response timing does not leak the key.
      if (!given || !timingSafeEqualStr(given, key)) return json({ error: 'Not found' }, 404);
      return json({
        configured: !!BACKUP,
        dir: BACKUP?.dir ?? null,
        keep: BACKUP?.keep ?? null,
        last_good: lastGoodBackup(),
        history: backupHistory(),
        on_disk: BACKUP ? listBackups(BACKUP.dir) : [],
      });
    }

    // GET /orgs/:id/workspaces — the rooms this org owns
    if (url.pathname.match(/^\/orgs\/[\w-]+\/workspaces$/) && req.method === 'GET') {
      const orgId = url.pathname.split('/')[2];
      const g = orgGuard(req, orgId, 'member');
      if (isResponse(g)) return g;
      return json({ workspaces: lobbiesForOrg(db, orgId) });
    }

    // GET /health  (and /healthz — what the deploy check hits)
    if ((url.pathname === '/health' || url.pathname === '/healthz') && req.method === 'GET') {
      const agents = getAgents();
      const count = (s: string) => agents.filter(a => a.status === s).length;
      return json({
        status: 'ok',
        timestamp: Date.now(),
        seq: getCurrentSeq(),
        relay: {
          enabled: RELAY_ENABLED,
          mode: RELAY_MODE,
          target: RELAY_URL || 'none',
        },
        agents: {
          total: agents.length,
          active: count('active'),
          idle: count('idle'),
          stale: count('stale'),
          stopped: count('stopped'),
        },
        connections: {
          global: wsClients.size,
          lobbies: lobbyWsClients.size,
        },
        // Published so "what do you delete, and when" has a machine-readable
        // answer, and so the claim lives next to the code that would have to
        // change to make it false.
        retention: retentionPolicy(),
      });
    }

    // WebSocket upgrade — global (non-lobby) stream
    if (url.pathname === '/stream') {
      if (!originAllowed(req)) return json({ error: 'Origin not allowed' }, 403);
      const data: WsData = {
        userId: (url.searchParams.get('user_id') || 'anon').slice(0, 64),
        limiter: new RateLimiter(30, 15),            // durable writes
        ephemeralLimiter: new RateLimiter(600, 300), // cursor frames
      };
      const success = server.upgrade(req, { data });
      if (success) return undefined;
      return json({ error: 'WebSocket upgrade failed' }, 400);
    }

    // ---- static client -----------------------------------------------------
    //
    // Serving the built dashboard from the same origin as the API means the
    // WebSocket is same-origin too: no CORS, no mixed-content block, and the
    // Origin check has one obvious allowed value.
    if (STATIC_DIR && req.method === 'GET') {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      // Path traversal guard: resolve, then confirm the result is still inside
      // the static root before reading anything.
      const resolved = resolve(STATIC_DIR, rel || 'index.html');
      if (resolved.startsWith(resolve(STATIC_DIR))) {
        const file = Bun.file(resolved);
        if (await file.exists()) {
          return new Response(file, { headers: securityHeaders(resolved) });
        }
      }
      // SPA fallback — any unmatched path renders the app shell.
      const index = Bun.file(resolve(STATIC_DIR, 'index.html'));
      if (await index.exists()) {
        return new Response(index, { headers: securityHeaders('index.html') });
      }
    }

    return new Response('Lobby server', {
      headers: { ...headers, 'Content-Type': 'text/plain' }
    });
  },

  websocket: {
    // Bun defaults both of these to 16MB. On a 3.7GB box already running five
    // other containers that is a cheap memory-exhaustion vector: a handful of
    // sockets each buffering 16MB is the whole machine. Nothing this protocol
    // sends is anywhere near 256KB.
    maxPayloadLength: parseInt(process.env.WS_MAX_PAYLOAD || String(256 * 1024)),
    backpressureLimit: parseInt(process.env.WS_BACKPRESSURE || String(1024 * 1024)),
    // Drop a client that cannot keep up rather than buffering for it forever.
    closeOnBackpressureLimit: true,
    idleTimeout: 120,

    open(ws) {
      const lobbyCode = (ws.data as any)?.lobbyCode;

      if (lobbyCode) {
        // Lobby-scoped connection
        console.log(`Lobby WebSocket client connected for lobby: ${lobbyCode}`);
        if (!lobbyWsClients.has(lobbyCode)) {
          lobbyWsClients.set(lobbyCode, new Set());
        }
        lobbyWsClients.get(lobbyCode)!.add(ws);

        // Send lobby info + initial events for this lobby
        const lobby = getLobby(lobbyCode);
        if (lobby) {
          ws.send(JSON.stringify({ type: 'lobby_info', data: lobby }));
        }

        // Lobby-scoped in SQL, not filtered from a global window — see the
        // GET /lobbies/:code/events note.
        ws.send(JSON.stringify({
          type: 'initial',
          data: getRecentEvents(300, lobbyCode),
          seq: getCurrentSeq(),
        }));

        // Board state, so a joining client renders the canvas without waiting
        // for events to replay.
        ws.send(JSON.stringify({ type: 'canvas_snapshot', data: getObjects(db, lobbyCode) }));

        if (lobby) {
          ws.send(JSON.stringify({ type: 'lobby_members', data: getLobbyMembers(lobby.id) }));
        }

        // Who is live on the board right now, so a joining client sees other
        // cursors immediately instead of waiting for them to move.
        ws.send(JSON.stringify({ type: 'presence_roster', data: getEphemeral(lobbyCode) }));

        // The conversation and the pins are part of the room's state, not a
        // second thing to go fetch: someone who joins mid-discussion should read
        // what was said the moment the board appears.
        ws.send(JSON.stringify({ type: 'chat_backlog', data: getMessages(db, lobbyCode, { limit: 100 }) }));
        ws.send(JSON.stringify({ type: 'annotation_snapshot', data: listAnnotations(db, lobbyCode) }));
      } else {
        // General connection (original behavior)
        console.log('WebSocket client connected');
        wsClients.add(ws);
        const events = getRecentEvents(300);
        ws.send(JSON.stringify({ type: 'initial', data: events }));
        const agents = getAgents();
        ws.send(JSON.stringify({ type: 'agents', data: agents }));
      }
    },
    message(ws, raw) {
      const d = ws.data as WsData;

      let msg: any;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      switch (msg.t) {
        // ---- ephemeral: cursor / viewport / selection / typing ------------
        // Never touches the database. See ephemeral.ts.
        case 'e': {
          if (!d.lobbyCode) return;
          if (!d.ephemeralLimiter.take()) return;

          // Always apply — this is in-memory and free. Only the broadcast is
          // throttled, so the newest position is never the one discarded.
          setEphemeral(d.lobbyCode, d.userId, {
            display_name: msg.n,
            color: msg.col,
            cursor: msg.c ? { x: msg.c[0], y: msg.c[1] } : undefined,
            viewport: msg.v ? { x: msg.v[0], y: msg.v[1], zoom: msg.v[2] } : undefined,
            selection: msg.s,
            typing: msg.typing,
          });

          if (!d.coalescer) {
            const lobbyCode = d.lobbyCode;
            const userId = d.userId;
            d.coalescer = new Coalescer(EPHEMERAL_BROADCAST_MS, () => {
              const latest = getEphemeral(lobbyCode).find(e => e.user_id === userId);
              if (!latest) return;
              // Echoing to the sender would fight their own local cursor.
              fanoutLobby(lobbyCode, JSON.stringify({ type: 'ephemeral', data: latest }), ws);
            });
          }
          d.coalescer.schedule();
          return;
        }

        // ---- durable: canvas object create / update / delete --------------
        case 'obj': {
          if (!d.lobbyCode || !msg.o || typeof msg.o.id !== 'string') return;
          // A viewer can watch the board but not change it. Enforced here too,
          // not only on the REST route — otherwise the socket is a way around it.
          if (d.role === 'viewer') {
            try { ws.send(JSON.stringify({ type: 'error', error: 'Forbidden: viewer role cannot edit the board' })); } catch {}
            return;
          }
          // Tight budget: every accepted op is a SQLite write.
          if (!d.limiter.take()) return;
          try {
            const result = msg.op === 'delete'
              ? deleteObject(db, d.lobbyCode, msg.o.id, d.userId)
              : upsertObject(db, d.lobbyCode, msg.o, d.userId);

            if (!result) return;
            if (result.accepted) {
              fanoutLobby(d.lobbyCode, JSON.stringify({ type: 'canvas_object', data: result.object }));
            } else {
              // Hand the winner back so the losing client repairs itself.
              try {
                ws.send(JSON.stringify({ type: 'canvas_object', data: result.object, rejected: true }));
              } catch {}
            }
          } catch (err) {
            console.error('[ws] canvas op failed:', err);
          }
          return;
        }

        // ---- durable: chat ------------------------------------------------
        // Viewers may speak (see the REST note); every role pays the write
        // limiter, because a message is a SQLite row like any other.
        case 'chat': {
          if (!d.lobbyCode || !msg.body) return;
          if (!d.limiter.take()) return;
          try {
            const saved = postMessage(db, d.lobbyCode, {
              body: String(msg.body),
              reply_to: msg.reply_to,
              mentions: msg.mentions,
              ref_object_id: msg.ref_object_id,
              author_kind: msg.author_kind,
            }, d.userId);
            // Echoed to the sender too: unlike a cursor, the author needs the
            // server's id, ts and seq to reconcile their optimistic line.
            fanoutLobby(d.lobbyCode, JSON.stringify({ type: 'chat_message', data: saved }));
          } catch (err) {
            const reason = err instanceof ChatError ? err.message : 'Message rejected';
            try { ws.send(JSON.stringify({ type: 'error', error: reason })); } catch {}
          }
          return;
        }

        // ---- durable: annotation pin --------------------------------------
        case 'ann': {
          if (!d.lobbyCode || !msg.a) return;
          if (d.role === 'viewer') {
            try { ws.send(JSON.stringify({ type: 'error', error: 'Forbidden: viewer role cannot pin comments' })); } catch {}
            return;
          }
          if (!d.limiter.take()) return;
          try {
            const saved = createAnnotation(db, d.lobbyCode, msg.a, d.userId);
            fanoutLobby(d.lobbyCode, JSON.stringify({ type: 'annotation', data: saved }));
          } catch (err) {
            const reason = err instanceof AnnotationError ? err.message : 'Annotation rejected';
            try { ws.send(JSON.stringify({ type: 'error', error: reason })); } catch {}
          }
          return;
        }

        case 'ping':
          try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch {}
          return;
      }
    },

    close(ws) {
      const d = ws.data as WsData;
      d?.coalescer?.cancel();
      const lobbyCode = d?.lobbyCode;
      if (lobbyCode) {
        const clients = lobbyWsClients.get(lobbyCode);
        if (clients) {
          clients.delete(ws);
          if (clients.size === 0) lobbyWsClients.delete(lobbyCode);
        }
        // Drop the cursor immediately rather than leaving it frozen on everyone
        // else's board until the TTL expires.
        dropEphemeral(lobbyCode, d.userId);
        fanoutLobby(lobbyCode, JSON.stringify({ type: 'presence_leave', data: { user_id: d.userId } }));
      } else {
        wsClients.delete(ws);
      }
    },
    error(ws, error) {
      console.error('WebSocket error:', error);
      const d = ws.data as WsData;
      d?.coalescer?.cancel();
      const lobbyCode = d?.lobbyCode;
      if (lobbyCode) {
        const clients = lobbyWsClients.get(lobbyCode);
        if (clients) {
          clients.delete(ws);
          if (clients.size === 0) lobbyWsClients.delete(lobbyCode);
        }
        dropEphemeral(lobbyCode, d.userId);
        fanoutLobby(lobbyCode, JSON.stringify({ type: 'presence_leave', data: { user_id: d.userId } }));
      } else {
        wsClients.delete(ws);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Agent status sweep
//
// Agents that crash or whose terminal is closed never send a closing event.
// Without this they read as busy forever and the work-in-flight lane lies.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Retention, on a slow clock of its own.
//
// It runs daily rather than every sweep because deleting rows is expensive and
// nothing here is urgent — and it runs at all because `pruneAudit` had been
// imported and never called since it was written. AUDIT_RETENTION_DAYS was set in
// docker-compose.yml and reported by /admin/backups the whole time, so the product
// claimed a retention policy it did not have.
// ---------------------------------------------------------------------------
const RETENTION_MS = 24 * 60 * 60_000;
let lastRetention = 0;

function runRetention(): void {
  const now = Date.now();
  if (now - lastRetention < RETENTION_MS) return;
  lastRetention = now;
  try {
    const audits = pruneAudit(db);
    if (audits > 0) console.log(`[retention] removed ${audits} audit entries past the window`);
    pruneEvents(db);
  } catch (err) {
    console.error('[retention] failed:', err);
  }
}

const SWEEP_MS = parseInt(process.env.SWEEP_MS || '30000');
const sweepTimer = setInterval(() => {
  try {
    for (const agent of sweepAgentStatuses()) {
      fanoutGlobal(JSON.stringify({ type: 'agent_update', data: agent }));
    }
    // Reap cursors whose socket died without a clean close, so a ghost cursor
    // does not sit frozen on everyone else's board.
    for (const gone of sweepEphemeral()) {
      fanoutLobby(gone.lobby, JSON.stringify({ type: 'presence_leave', data: { user_id: gone.user_id } }));
    }
    sweepTokenCache();
    // Expired sessions and stale OAuth states. Left alone, an abandoned sign-in
    // attempt is a row that never goes away.
    sweepSessions(db);
    // Unredeemed sign-in links. Each one is a live credential until it expires,
    // so this sweep is a security control and not only housekeeping.
    sweepEmailLinks(db);
    // Rate-limit buckets are keyed on caller-controlled values, so an unbounded
    // map here is a memory-exhaustion bug wearing a rate limiter's clothes.
    sweepThrottle();
    runRetention();
  } catch (err) {
    console.error('[sweep] failed:', err);
  }
}, SWEEP_MS);

// ---------------------------------------------------------------------------
// Graceful shutdown — stop accepting, drain, then close the database cleanly so
// the WAL is checkpointed instead of left for recovery on next boot.
// ---------------------------------------------------------------------------
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] shutting down...`);
  clearInterval(sweepTimer);
  try { await server.stop(); } catch {}
  for (const ws of wsClients) { try { ws.close(); } catch {} }
  for (const set of lobbyWsClients.values()) {
    for (const ws of set) { try { ws.close(); } catch {} }
  }
  try { db.close(false); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log(`🚀 Server running on http://localhost:${server.port}`);
console.log(`📊 WebSocket: ws://localhost:${server.port}/stream`);
console.log(`📮 POST events to: http://localhost:${server.port}/events`);
console.log(`📦 POST batch to: http://localhost:${server.port}/events/batch`);
console.log(`👥 Agent registry: http://localhost:${server.port}/agents`);
console.log(`🏠 Lobby CRUD: http://localhost:${server.port}/lobbies`);
console.log(`🏠 Lobby WS: ws://localhost:${server.port}/lobby/:code/stream`);
if (RELAY_ENABLED) {
  console.log(`🔄 Relay: ${RELAY_MODE} → ${RELAY_URL}`);
} else {
  console.log(`🔄 Relay: disabled (set RELAY_URL to enable)`);
}