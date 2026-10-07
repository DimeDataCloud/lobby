#!/usr/bin/env node
/**
 * Lobby CLI + hook relay.
 *
 * Node, not Python. The previous plugin invoked `python3`, which does not exist
 * on Windows (the bare name usually opens the Microsoft Store), so every hook
 * was a silent no-op on this machine before it ever reached a bug.
 *
 * Commands:
 *   lobby join <CODE>    bind THIS session and start broadcasting
 *   lobby leave          unbind and stop
 *   lobby status         what is bound, and to what
 *   lobby relay --event <HookEvent>   (internal) called by hooks, reads stdin
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import {
  SERVER, DATA_DIR, BINDINGS,
  loadBindings, saveBindings, currentSessionId, resolveBinding,
} from '../lib/binding.mjs';

// State (data dir, bindings, session resolution) lives in ../lib/binding.mjs so
// the MCP server resolves the exact same credential this relay does.

// ---------------------------------------------------------------------------
// Redaction — runs BEFORE anything leaves the machine.
//
// This is the only layer that truly counts. Server-side scrubbing is a second
// net, but by then the secret has already crossed the network and is in our
// logs. Patterns are linear-time on purpose: a catastrophically backtracking
// regex here would hang the user's session on every tool call.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, '[redacted:anthropic-key]'],
  [/sk-[A-Za-z0-9]{20,}/g, '[redacted:api-key]'],
  [/ghp_[A-Za-z0-9]{20,}/g, '[redacted:github-token]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted:github-pat]'],
  [/gho_[A-Za-z0-9]{20,}/g, '[redacted:github-oauth]'],
  [/AKIA[0-9A-Z]{16}/g, '[redacted:aws-key]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[redacted:slack-token]'],
  [/lby_[A-Za-z0-9]+_[A-Za-z0-9]+/g, '[redacted:lobby-token]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[redacted:private-key]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '[redacted:jwt]'],
  // KEY=value / SECRET: value / TOKEN="value"
  [/\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"'&;|]{6,}/gi,
   (_m, k) => `${k}=[redacted]`],
];

/** Paths whose mere contents should never be transmitted. */
const PATH_DENYLIST = [
  /(^|[\\/])\.env($|\.|[^\\/]*$)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|[\\/])credentials(\.[a-z]+)?$/i,
  // Any directory whose name advertises that it holds keys or secrets. This
  // replaced a single hardcoded personal path and covers the whole class.
  /(^|[\\/])[.\w-]*(keys|secrets|vault)([\\/]|$)/i,
  /(^|[\\/])\.kube([\\/]|$)/i,
  /(^|[\\/])\.docker[\\/]config\.json$/i,
  /(^|[\\/])\.config[\\/](gcloud|gh|doctl)([\\/]|$)/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])terraform\.tfstate/i,
];

function isDeniedPath(p) {
  if (typeof p !== 'string' || !p) return false;
  return PATH_DENYLIST.some((re) => re.test(p));
}

function redactString(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

const MAX_STRING = 4000;

/** Deep-redact, truncate, and drop anything path-denied. */
function scrub(value, depth = 0) {
  if (depth > 6) return '[truncated:depth]';
  if (typeof value === 'string') {
    const r = redactString(value);
    return r.length > MAX_STRING ? r.slice(0, MAX_STRING) + `…[truncated ${r.length - MAX_STRING}]` : r;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(file_path|path|notebook_path)$/i.test(k) && isDeniedPath(v)) return { _redacted: 'sensitive-path' };
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// What we are willing to send
//
// Deny by default. `Read` is never streamed: its result is the full contents of
// whatever the user opened, and the value-per-risk is terrible. Edit/Write
// diffs are what a board should show anyway.
// ---------------------------------------------------------------------------

const STREAMED_TOOLS = new Set([
  'bash', 'edit', 'write', 'multiedit', 'notebookedit',
  'task', 'webfetch', 'websearch', 'glob', 'grep',
]);

const EVENT_TYPE_MAP = {
  PreToolUse: 'tool_call',
  PostToolUse: 'tool_result',
  UserPromptSubmit: 'user_prompt',
  Stop: 'turn_end',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  Notification: 'notification',
  PreCompact: 'compression',
};

function buildPayload(hookEvent, input) {
  const tool = String(input.tool_name || '');
  const lower = tool.toLowerCase();

  switch (hookEvent) {
    case 'PreToolUse':
    case 'PostToolUse': {
      if (!STREAMED_TOOLS.has(lower)) return null;   // deny by default
      const p = { tool_name: tool, tool_input: scrub(input.tool_input || {}) };
      if (p.tool_input && p.tool_input._redacted) return null;
      // Never ship a tool result body; it is the widest surface for leaking
      // file contents. Success and a short preview is enough for a card.
      if (hookEvent === 'PostToolUse') {
        const r = input.tool_response ?? input.tool_result;
        p.ok = !(r && (r.error || r.is_error));
        if (typeof r === 'string') p.preview = scrub(r.slice(0, 400));
      }
      return p;
    }
    case 'UserPromptSubmit':
      return { prompt: scrub(String(input.prompt || '').slice(0, 2000)) };
    case 'SessionStart':
      return { source: input.source, model: input.model, cwd: basename(String(input.cwd || '')) };
    case 'SessionEnd':
      return { reason: input.reason };
    case 'Stop':
      return { stop_hook_active: !!input.stop_hook_active };
    case 'SubagentStart':
    case 'SubagentStop':
      return { agent_type: input.agent_type, agent_id: input.agent_id };
    default:
      return {};
  }
}

function summarize(hookEvent, payload) {
  if (!payload) return hookEvent;
  if (payload.tool_name) {
    const i = payload.tool_input || {};
    const detail = i.command || i.file_path || i.pattern || i.path || i.url || '';
    return `${payload.tool_name}${detail ? ': ' + String(detail).slice(0, 90) : ''}`;
  }
  if (payload.prompt) return String(payload.prompt).slice(0, 90);
  return EVENT_TYPE_MAP[hookEvent] || hookEvent;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function post(path, body, token) {
  const res = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdJoin(code) {
  if (!code) { console.error('Usage: /lobby:join <CODE>'); process.exit(1); }
  code = code.trim().toUpperCase();

  const sessionId = currentSessionId();
  const cwd = process.cwd();
  const userId = process.env.LOBBY_USER_ID || process.env.USERNAME || process.env.USER || 'unknown';
  const agentId = sessionId ? `cc-${sessionId.slice(0, 12)}` : `cc-${basename(cwd)}`;

  let lobby;
  try {
    lobby = await post(`/lobbies/${code}/join`, {
      user_id: userId, agent_id: agentId, source: 'claude-code',
      display_name: userId,
    });
  } catch (e) {
    console.error(`Could not join ${code}: ${e.message}`);
    console.error(`Server: ${SERVER}  (set LOBBY_SERVER_URL to change)`);
    process.exit(1);
  }

  const b = loadBindings();
  const binding = {
    lobby: code, user_id: userId, agent_id: agentId,
    token: lobby.token || b.sessions[sessionId]?.token,
    cwd, joined_at: Date.now(),
  };
  if (sessionId) b.sessions[sessionId] = binding; else b.cwds[cwd] = binding;
  saveBindings(b);

  console.log(`Joined lobby ${code}${lobby.name ? ` (${lobby.name})` : ''}`);
  // The server is printed on SUCCESS, not only on failure. Two people trying to
  // share a board have no other way to notice that one of them is on
  // localhost — the default — and the other is on the deployment. Both joins
  // succeed, both look right, and the boards are simply different.
  console.log(`  server       : ${SERVER}`);
  console.log(`  broadcasting : THIS session only`);
  console.log(`  bound by     : ${sessionId ? 'session id' : 'working directory (' + cwd + ')'}`);
  console.log(`  agent        : ${agentId}`);
  if (SERVER.includes('localhost') || SERVER.includes('127.0.0.1')) {
    console.log(`  note: this is a LOCAL server. To share a board with someone else,`);
    console.log(`        set LOBBY_SERVER_URL to the deployment before joining.`);
  }
  if (!sessionId) {
    console.log(`  note: this Claude Code build does not expose a session id, so the`);
    console.log(`        binding covers this directory rather than this one terminal.`);
  }
}

function cmdLeave() {
  const sessionId = currentSessionId();
  const cwd = process.cwd();
  const b = loadBindings();
  const had = (sessionId && b.sessions[sessionId]) || b.cwds[cwd];
  if (sessionId) delete b.sessions[sessionId];
  delete b.cwds[cwd];
  saveBindings(b);
  console.log(had ? `Left lobby ${had.lobby}. Broadcasting stopped.` : 'This session was not in a lobby.');
}

function cmdStatus() {
  const sessionId = currentSessionId();
  const cwd = process.cwd();
  const binding = resolveBinding(sessionId, cwd);
  if (!binding) {
    console.log('Not broadcasting. This session is not joined to any lobby.');
    console.log(`Server: ${SERVER}`);
    console.log('Join with /lobby:join CODE, or set LOBBY_CODE and LOBBY_TOKEN');
    console.log('in the environment if this is not a Claude Code session.');
    return;
  }
  const b = loadBindings();
  const others = Object.keys(b.sessions).length + Object.keys(b.cwds).length - 1;
  // Where the credential came from, because "I joined but nothing arrives" is
  // almost always a binding resolving from somewhere other than you expect.
  const via = { session: 'this session', env: 'LOBBY_CODE / LOBBY_TOKEN', cwd: 'this directory' };
  console.log(`Broadcasting to lobby ${binding.lobby}`);
  console.log(`  agent  : ${binding.agent_id}`);
  console.log(`  user   : ${binding.user_id}`);
  console.log(`  bound  : ${via[binding.from] || 'unknown'}`);
  console.log(`  server : ${SERVER}`);
  if (others > 0) console.log(`  (${others} other session/directory binding${others > 1 ? 's' : ''} on this machine)`);
}

/**
 * Hook relay. Must be fast and must never fail loudly — a hook that throws or
 * hangs degrades every tool call in the session.
 */
async function cmdRelay(hookEvent) {
  const raw = await readStdin().catch(() => '');
  let input = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch { /* keep going */ }

  const sessionId = input.session_id || currentSessionId();
  const cwd = input.cwd || process.cwd();

  // THE opt-in check, and the first thing that happens. An unjoined session
  // exits here having sent nothing.
  const binding = resolveBinding(sessionId, cwd);
  if (!binding) return;

  // Refuse to stream from a session running with permissions bypassed. Lobby
  // plus --dangerously-skip-permissions means anything that reaches this
  // session can act without a gate, and users enable it by accident.
  if (input.permission_mode === 'bypassPermissions') return;

  const payload = buildPayload(hookEvent, input);
  if (payload === null) return;   // tool not on the allowlist

  const event = {
    source: 'claude-code',
    agent_id: binding.agent_id,
    session_id: sessionId || binding.agent_id,
    event_type: EVENT_TYPE_MAP[hookEvent] || hookEvent.toLowerCase(),
    user_id: binding.user_id,
    workspace_id: basename(cwd) || 'default',
    lobby_id: binding.lobby,
    payload,
    summary: summarize(hookEvent, payload),
    timestamp: Date.now(),
  };
  if (input.model) { event.model = input.model; event.provider = 'anthropic'; }

  try {
    await post('/events', event, binding.token);
  } catch {
    // Silent. The user's session must not be disturbed because a board is down.
  }
}

// ---------------------------------------------------------------------------

const [, , cmd, ...rest] = process.argv;

try {
  switch (cmd) {
    case 'join':   await cmdJoin(rest[0]); break;
    case 'leave':  cmdLeave(); break;
    case 'status': cmdStatus(); break;
    case 'relay': {
      const i = rest.indexOf('--event');
      await cmdRelay(i >= 0 ? rest[i + 1] : '');
      break;
    }
    default:
      console.log('Usage: lobby <join CODE|leave|status>');
  }
} catch (err) {
  // Relay failures must never surface as a hook error.
  if (cmd === 'relay') process.exit(0);
  console.error(String(err?.message || err));
  process.exit(1);
}
process.exit(0);
