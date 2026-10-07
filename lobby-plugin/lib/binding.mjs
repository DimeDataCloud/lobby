// Where a session's lobby binding lives, and how to find it.
//
// Shared by the hook relay (bin/lobby.mjs) and the MCP server (mcp/server.mjs).
// It is one module rather than two copies because both of the rules below are
// silent when broken — you get "joined successfully" and then nothing ever
// arrives, with no error anywhere to explain it.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const SERVER = process.env.LOBBY_SERVER_URL || 'http://localhost:4000';

/**
 * Where state lives.
 *
 * Inside a Claude Code session, CLAUDE_PLUGIN_DATA is set for us and is the only
 * correct answer. ${CLAUDE_PLUGIN_ROOT} is NOT — it is a versioned install
 * directory that is garbage-collected roughly two weeks after an update, so
 * anything written there is lost.
 *
 * Outside a session — running `lobby join` straight from a shell — the variable
 * is unset, and a naive fallback of ".../data/lobby" writes to a DIFFERENT
 * directory than the hooks read from: Claude Code names the directory
 * "<plugin>-<marketplace>", e.g. "lobby-lobby-marketplace". That mismatch looks
 * exactly like "the hooks are broken". So prefer an existing installed data
 * directory over the bare name.
 */
export function resolveDataDir() {
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;

  const root = join(homedir(), '.claude', 'plugins', 'data');
  const bare = join(root, 'lobby');
  try {
    const candidates = readdirSync(root)
      .filter((d) => d === 'lobby' || d.startsWith('lobby-'))
      // Prefer "lobby-<marketplace>" over bare "lobby": that is what an
      // installed plugin actually uses.
      .sort((a, b) => b.length - a.length);
    if (candidates.length) return join(root, candidates[0]);
  } catch { /* no plugins installed yet */ }
  return bare;
}

export const DATA_DIR = resolveDataDir();
export const BINDINGS = join(DATA_DIR, 'bindings.json');

export function loadBindings() {
  try {
    return JSON.parse(readFileSync(BINDINGS, 'utf8'));
  } catch {
    return { sessions: {}, cwds: {} };
  }
}

export function saveBindings(b) {
  mkdirSync(dirname(BINDINGS), { recursive: true });
  writeFileSync(BINDINGS, JSON.stringify(b, null, 2), { mode: 0o600 });
}

/**
 * The session this process belongs to.
 *
 * CLAUDE_SESSION_ID does not exist as an environment variable — the real name is
 * CLAUDE_CODE_SESSION_ID. Getting this wrong is what made the old plugin's "this
 * session only" promise false: it fell back to one global state file, so joining
 * in one terminal broadcast EVERY terminal on the machine.
 */
export function currentSessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || null;
}

/**
 * Credentials straight from the environment.
 *
 * This is how anything that is NOT Claude Code joins a room: an Ollama-backed
 * harness, Codex, a Python script, a CI job. Those have no session id and no
 * interactive `/lobby:join` to run, and without this path the product's claim
 * that any agent system can participate was only true for one.
 *
 * `LOBBY_USER_ID` is optional and only affects the display name; authorship on
 * the server always comes from the token, never from anything sent alongside it.
 */
export function envBinding() {
  const lobby = process.env.LOBBY_CODE;
  const token = process.env.LOBBY_TOKEN;
  if (!lobby || !token) return null;
  return {
    lobby: lobby.trim().toUpperCase(),
    token: token.trim(),
    user_id: process.env.LOBBY_USER_ID || 'agent',
    agent_id: process.env.LOBBY_AGENT_ID || `env-${(process.env.LOBBY_USER_ID || 'agent')}`,
    source: process.env.LOBBY_SOURCE || 'custom',
    from: 'env',
  };
}

/**
 * Resolve the binding for the running process, and say where it came from.
 *
 * Order matters:
 *
 *   1. session id — an interactive `/lobby:join` in THIS terminal. Most explicit,
 *      so it wins. If env came first, a token left exported in a shell profile
 *      would silently override the room you just joined, which is a confusing
 *      failure that looks like the join not working.
 *   2. environment — the non-Claude path above.
 *   3. working directory — the fallback for Claude Code builds that do not
 *      export a session id.
 */
export function resolveBinding(sessionId, cwd) {
  const b = loadBindings();
  if (sessionId && b.sessions[sessionId]) return { ...b.sessions[sessionId], from: 'session' };
  const env = envBinding();
  if (env) return env;
  if (cwd && b.cwds[cwd]) return { ...b.cwds[cwd], from: 'cwd' };
  return null;
}
