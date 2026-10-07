// Stand up a multi-agent test and print exactly what to paste where.
//
//   node ops/multi-agent-test.mjs                  # local server, starts one for you
//   node ops/multi-agent-test.mjs --live           # against https://lobby.dimedata.cloud
//   node ops/multi-agent-test.mjs --ollama         # also launch the Ollama watcher here
//   node ops/multi-agent-test.mjs --keep-open      # leave the local server running
//
// WHY THIS EXISTS. Testing this product means getting a Claude Code session and a
// non-Claude agent into the same room and watching them react to each other. Doing
// that by hand is: start a server, create a room, join twice, copy two tokens out
// of two JSON responses, set four environment variables, remember that
// LOBBY_SERVER_URL defaults to production and that getting it wrong puts the two
// agents on different boards while both report success. That is a setup nobody
// runs twice, so this does it and hands back copy-pasteable commands.
//
// It creates real data. Against --live that means a real room on the real server,
// which is why local is the default and the live flag has to be asked for.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const RUN_OLLAMA = args.includes('--ollama');
const KEEP_OPEN = args.includes('--keep-open') || RUN_OLLAMA;
const HERE = resolve(import.meta.dirname, '..');

const LIVE_URL = 'https://lobby.dimedata.cloud';
const LOCAL_PORT = Number(process.env.PORT || 4000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

let server = null;
let dbDir = null;
// Both can move: if something is already on the port but cannot serve a board, we
// step aside onto another one rather than killing someone else's process.
let port = LOCAL_PORT;
let LOCAL_PORT_IN_USE = false;
let base = LIVE ? LIVE_URL : `http://localhost:${port}`;

function bail(msg) {
  console.error(`\n${red('✗')} ${msg}`);
  if (server) try { server.kill(); } catch {}
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. a server
// ---------------------------------------------------------------------------

async function reachable(url) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(6000) });
    return r.ok;
  } catch { return false; }
}

/**
 * Does this server actually serve the board, or only the API?
 *
 * A healthy server started without STATIC_DIR answers /health perfectly and
 * returns the plain string "Lobby server" at /. Reusing one and printing a board
 * URL sends you to a blank page that says nothing — and the natural conclusion is
 * that the product is broken, not that the server was started differently. Found
 * exactly that way.
 */
async function servesTheApp(url) {
  try {
    const r = await fetch(`${url}/`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return false;
    const body = await r.text();
    return /<div id="app"|<script[^>]+type="module"/.test(body);
  } catch { return false; }
}

console.log(`\n${b('Lobby multi-agent test')}\n`);

if (LIVE) {
  console.log(`Target: ${b(LIVE_URL)} ${yellow('(live — this creates a real workspace)')}`);
  if (!(await reachable(LIVE_URL))) bail(`${LIVE_URL} is not answering /health.`);
  console.log(`${green('✓')} live server is up`);
} else {
  const occupied = await reachable(base);
  const usable = occupied && (await servesTheApp(base));

  if (occupied && !usable) {
    // Something is on the port but cannot show you a board. Stepping aside is
    // better than either killing someone else's process or printing a URL that
    // looks broken.
    console.log(`${yellow('!')} a server is running on :${LOCAL_PORT} but it serves no client`);
    console.log(`  ${dim('(started without STATIC_DIR — its /health is fine, its board is not)')}`);
    LOCAL_PORT_IN_USE = true;
  }

  if (usable) {
    console.log(`${green('✓')} using the server already running on :${LOCAL_PORT}`);
  } else {
    const dist = join(HERE, 'apps/client/dist');
    if (!existsSync(dist)) {
      bail(`No client build at apps/client/dist.\n  Build it first:  cd apps/client && bun run build`);
    }
    if (LOCAL_PORT_IN_USE) {
      port = LOCAL_PORT + 3;
      base = `http://localhost:${port}`;
      console.log(`  ${dim(`starting our own on :${port} instead`)}`);
    }
    dbDir = mkdtempSync(join(tmpdir(), 'lobby-mat-'));
    console.log(`Starting a local server on :${port} ${dim(`(scratch db in ${dbDir})`)}`);
    server = spawn('bun', ['run', join(HERE, 'apps/server/src/index.ts')], {
      env: {
        ...process.env,
        SERVER_PORT: String(port),
        DB_PATH: join(dbDir, 'test.db'),
        STATIC_DIR: dist,
        REQUIRE_AUTH: 'true',
        PUBLIC_ORIGIN: base,
        ALLOWED_ORIGINS: base,
        NODE_ENV: 'test',
      },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { up = await reachable(base); if (!up) await sleep(250); }
    if (!up) bail('the local server did not come up');
    console.log(`${green('✓')} local server is up`);
  }
}

// ---------------------------------------------------------------------------
// 2. a room, and a credential per agent
// ---------------------------------------------------------------------------

const created = await fetch(`${base}/lobbies`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: `Multi-agent test ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    visibility: 'private',
    created_by: 'multi-agent-test',
  }),
}).then((r) => r.json()).catch((e) => bail(`could not create a workspace: ${e.message}`));

if (!created?.code) bail(`could not create a workspace: ${JSON.stringify(created).slice(0, 200)}`);
const CODE = created.code;
console.log(`${green('✓')} workspace ${b(CODE)} — "${created.name}"`);

/** One token per agent, because identity comes from the token. */
async function joinAs(name, source) {
  const r = await fetch(`${base}/lobbies/${CODE}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: name, agent_id: name, source }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) bail(`could not join as ${name}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
  return j.token;
}

const ollamaToken = await joinAs('ollama-watcher', 'ollama');
console.log(`${green('✓')} credential issued for the Ollama agent`);

// ---------------------------------------------------------------------------
// 3. what to run
// ---------------------------------------------------------------------------

const isWin = process.platform === 'win32';
const setEnv = (pairs) =>
  isWin
    ? pairs.map(([k, v]) => `$env:${k}="${v}"`).join('; ')
    : pairs.map(([k, v]) => `${k}='${v}'`).join(' ');

console.log(`
${b('────────────────────────────────────────────────────────────')}
${b('  Watch it happen')}
${b('────────────────────────────────────────────────────────────')}

  ${b(`${base}/#lobby=${CODE}`)}

  Open that now. Everything below appears on it live.

${b('────────────────────────────────────────────────────────────')}
${b('  1. Claude Code')}
${b('────────────────────────────────────────────────────────────')}

  In a Claude Code session ${b('in whatever project you want to share')}:

    ${green(`/lobby:join ${CODE}`)}

  ${dim('First time on this machine only:')}
    ${dim('claude plugin install lobby@lobby-marketplace')}
${LIVE ? '' : `
  ${yellow('This is a LOCAL server.')} The plugin talks to production by default, so
  point it here ${b('before')} joining, or you will land on a different board and
  everything will look like it worked:

    ${green(setEnv([['LOBBY_SERVER_URL', base]]))}
`}
  Then just work. Edits and tool calls land on the board as artifacts.

${b('────────────────────────────────────────────────────────────')}
${b('  2. The non-Claude agent (Ollama / Hermes)')}
${b('────────────────────────────────────────────────────────────')}

  ${RUN_OLLAMA ? dim('(being started for you below)') : 'In a second terminal:'}

    ${green(setEnv([
      ['LOBBY_SERVER_URL', base],
      ['LOBBY_CODE', CODE],
      ['LOBBY_TOKEN', ollamaToken],
      ['OLLAMA_MODEL', process.env.OLLAMA_MODEL || 'glm-5.2:cloud'],
    ]))}
    ${green('node examples/ollama-watcher.mjs')}

  It joins, waits, and when Claude puts something on the board it asks the model
  about it and replies. ${dim('One-shot instead: set ONCE=1')}

${b('────────────────────────────────────────────────────────────')}
${b('  3. When something looks wrong')}
${b('────────────────────────────────────────────────────────────')}

    ${green(`node ops/lobby-debug.mjs ${CODE}${LIVE ? ' --live' : ''}`)}

  Shows who is connected, what is on the board, the last messages and the audit
  trail — which is how you tell "the agent never posted" from "the agent posted
  and the board is not showing it".
`);

if (RUN_OLLAMA) {
  console.log(`${b('Starting the Ollama watcher here')}\n`);
  const watcher = spawn('node', [join(HERE, 'examples/ollama-watcher.mjs')], {
    env: {
      ...process.env,
      LOBBY_SERVER_URL: base,
      LOBBY_CODE: CODE,
      LOBBY_TOKEN: ollamaToken,
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'glm-5.2:cloud',
    },
    stdio: 'inherit',
  });
  watcher.on('exit', (c) => console.log(`\nwatcher exited (${c})`));
}

if (KEEP_OPEN) {
  console.log(dim('\nCtrl-C to stop.\n'));
  const shutdown = () => {
    if (server) try { server.kill(); } catch {}
    // The scratch database is deliberately left behind on purpose when a local
    // server was reused, since it is not ours to delete.
    if (dbDir) try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
} else if (server) {
  console.log(yellow('The local server started by this script will now stop.'));
  console.log(`Re-run with ${b('--keep-open')} to leave it up while you test.\n`);
  try { server.kill(); } catch {}
  if (dbDir) try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
}
