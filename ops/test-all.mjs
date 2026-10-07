// Run every suite that does not need a browser or a second person, and summarise.
//
//   node ops/test-all.mjs              # everything runnable
//   node ops/test-all.mjs --with-live   # also the two that need a running server
//
// WHY THIS EXISTS. The test commands were a list in a markdown file, which means
// running "all of them" was a manual loop that nobody completes when one suite in
// the middle takes 40 seconds. A green light has to be one command or it does not
// get used — and a documented command that has never been run is how this repo
// ended up shipping a test suite listing an invocation that could not work.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = resolve(import.meta.dirname, '..');
const WITH_LIVE = process.argv.includes('--with-live');


const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const SUITES = [
  { name: 'unit', cmd: 'bun', args: ['test'], cwd: join(HERE, 'apps/server'), what: '22 unit tests' },

  { name: 'auth', cmd: 'bun', args: ['run', 'apps/server/test/integration/auth.ts'], what: 'authz, IDOR, enumeration' },
  { name: 'accounts', cmd: 'bun', args: ['run', 'apps/server/test/integration/accounts.ts'], what: 'orgs, seats, isolation' },
  { name: 'oauth', cmd: 'bun', args: ['run', 'apps/server/test/integration/oauth.ts'], what: 'the OAuth callback path' },
  { name: 'emailauth', cmd: 'bun', args: ['run', 'apps/server/test/integration/emailauth.ts'], what: 'emailed sign-in links' },
  { name: 'retention', cmd: 'bun', args: ['run', 'apps/server/test/integration/retention.ts'], what: 'deletes history, not work' },
  { name: 'agent', cmd: 'bun', args: ['run', 'apps/server/test/integration/agent.ts'], what: 'the agent surface' },
  { name: 'hardening', cmd: 'bun', args: ['run', 'apps/server/test/integration/hardening.ts'], what: 'backups + real restore' },
  { name: 'dataops', cmd: 'bun', args: ['run', 'apps/server/test/integration/dataops.ts'], what: 'export + real deletion' },

  { name: 'relay', cmd: 'node', args: ['lobby-plugin/test/relay.test.mjs'], what: 'redaction' },
  { name: 'mcp', cmd: 'node', args: ['lobby-plugin/test/mcp.test.mjs'], what: 'MCP + identity isolation' },
  { name: 'render', cmd: 'node', args: ['apps/client/test-artifact-render.mjs'], what: 'every artifact kind draws' },
];

const NEEDS_SERVER = [
  { name: 'chat', cmd: 'bun', args: ['run', 'apps/server/test/integration/chat.ts'], what: 'chat, live server' },
  { name: 'multiplayer', cmd: 'bun', args: ['run', 'apps/server/test/integration/multiplayer.ts'], what: 'presence, live server' },
];

function run(suite) {
  return new Promise((resolve_) => {
    const started = Date.now();
    // Windows needs a shell: `bun` and `node` resolve through .cmd shims, and Node
    // refuses to spawn a .cmd directly (EINVAL). Passing ONE command string rather
    // than a command plus an args array is what avoids DEP0190 — which fires on the
    // args-array form and printed its warning into the middle of the results table.
    // Every path here is a literal in this file; nothing is caller-supplied.
    const isWin = process.platform === 'win32';
    const line = [suite.cmd, ...suite.args].join(' ');
    const p = isWin
      ? spawn(line, { cwd: suite.cwd || HERE, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(suite.cmd, suite.args, { cwd: suite.cwd || HERE, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => resolve_({ ...suite, ok: false, ms: Date.now() - started, out: e.message }));
    p.on('close', (code) => resolve_({ ...suite, ok: code === 0, code, ms: Date.now() - started, out }));
  });
}

console.log(`\n${b('Lobby — every suite that does not need a browser or a second person')}\n`);

const planned = WITH_LIVE ? [...SUITES, ...NEEDS_SERVER] : SUITES;
const results = [];

for (const suite of planned) {
  process.stdout.write(`  ${suite.name.padEnd(12)} ${dim(suite.what.padEnd(28))} `);
  const r = await run(suite);
  results.push(r);
  const secs = (r.ms / 1000).toFixed(1);
  console.log(r.ok ? `${green('PASS')} ${dim(`${secs}s`)}` : `${red('FAIL')} ${dim(`${secs}s`)}`);
}

const failed = results.filter((r) => !r.ok);

if (failed.length) {
  console.log(`\n${b('Output from what failed')}`);
  for (const f of failed) {
    console.log(`\n${red(`── ${f.name} `.padEnd(60, '─'))}`);
    // The tail is where a verdict lives; the head is usually a banner.
    const lines = f.out.trim().split(/\r?\n/);
    console.log(lines.slice(-24).join('\n'));
  }
}

if (!WITH_LIVE) {
  console.log(`\n${dim('Not run (need a server up — start it with .\\start.ps1, then --with-live):')}`);
  for (const s of NEEDS_SERVER) console.log(dim(`  ${s.name.padEnd(12)} ${s.what}`));
}

console.log(`\n${dim('Not covered here:')}`);
console.log(dim('  browser        node ops/browser-check.mjs'));
console.log(dim('  a deployment   node ops/verify-deploy.mjs'));
console.log(dim('  two agents     node ops/multi-agent-test.mjs --keep-open'));

const total = results.length;
const passed = total - failed.length;
console.log(`\n${b('verdict')}  ${failed.length === 0
  ? green(`PASS — ${passed}/${total}`)
  : red(`FAIL — ${passed}/${total} passed, ${failed.map((f) => f.name).join(', ')} failed`)}\n`);

process.exitCode = failed.length === 0 ? 0 : 1;
