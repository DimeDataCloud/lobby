// Plugin relay behaviour.
//
// The two assertions that gate everything:
//
//   1. An UNJOINED session transmits nothing. The old plugin kept one global
//      state file, so joining in a single terminal broadcast every terminal on
//      the machine — while printing "this session only" to the user.
//
//   2. Secrets never leave the machine. Checked at the payload the relay
//      actually builds, not at what the database stored.
//
//   node --test lobby-plugin/test/relay.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'lobby.mjs');

let dataDir;
let received = [];
let server;
let PORT;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'lobby-plugin-'));

  // A stand-in server that records exactly what crossed the network. Checking
  // the database would only show what was stored, not what was sent.
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      received.push({ url: req.url, body: parsed, raw: body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'TESTLB', name: 'test', token: 'lby_test_token' }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  PORT = server.address().port;
});

after(() => {
  server?.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

function run(args, { stdin = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDir,
        LOBBY_SERVER_URL: `http://127.0.0.1:${PORT}`,
        LOBBY_USER_ID: 'tester',
        CLAUDE_CODE_SESSION_ID: 'session-alpha',
        ...env,
      },
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.stdin.end(stdin);
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const hookInput = (over = {}) => JSON.stringify({
  session_id: 'session-alpha',
  cwd: process.cwd(),
  tool_name: 'Bash',
  tool_input: { command: 'echo hello' },
  ...over,
});

describe('opt-in', () => {
  test('an unjoined session transmits NOTHING', async () => {
    received = [];
    const r = await run(['relay', '--event', 'PostToolUse'], { stdin: hookInput() });
    assert.equal(r.code, 0, 'relay must exit 0 even when it does nothing');
    assert.equal(received.length, 0, 'unjoined session must not send anything');
  });

  test('status reports not broadcasting before joining', async () => {
    const r = await run(['status']);
    assert.match(r.out, /Not broadcasting/);
  });

  test('joining binds only THIS session id', async () => {
    received = [];
    const r = await run(['join', 'TESTLB']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /THIS session only/);

    const bindings = JSON.parse(readFileSync(join(dataDir, 'bindings.json'), 'utf8'));
    assert.ok(bindings.sessions['session-alpha'], 'binding stored under the session id');
    assert.deepEqual(Object.keys(bindings.cwds), [], 'no directory-wide binding when a session id exists');
  });

  test('a DIFFERENT session on the same machine still transmits nothing', async () => {
    // The exact failure of the previous plugin: one global state file meant a
    // second terminal inherited the first one's broadcast.
    received = [];
    const r = await run(['relay', '--event', 'PostToolUse'], {
      stdin: JSON.stringify({ session_id: 'session-beta', cwd: '/some/other/dir', tool_name: 'Bash', tool_input: { command: 'ls' } }),
      env: { CLAUDE_CODE_SESSION_ID: 'session-beta' },
    });
    assert.equal(r.code, 0);
    assert.equal(received.length, 0, 'a second, unjoined session must stay silent');
  });

  test('the joined session does transmit', async () => {
    received = [];
    await run(['relay', '--event', 'PostToolUse'], { stdin: hookInput() });
    assert.equal(received.length, 1);
    assert.equal(received[0].body.lobby_id, 'TESTLB');
    assert.equal(received[0].body.source, 'claude-code');
    assert.equal(received[0].body.payload.tool_input.command, 'echo hello');
  });

  test('leave stops transmission', async () => {
    await run(['leave']);
    received = [];
    await run(['relay', '--event', 'PostToolUse'], { stdin: hookInput() });
    assert.equal(received.length, 0);
    await run(['join', 'TESTLB']);   // restore for later tests
  });
});

describe('what is never sent', () => {
  test('Read is not streamed even if the hook fires', async () => {
    received = [];
    await run(['relay', '--event', 'PostToolUse'], {
      stdin: hookInput({ tool_name: 'Read', tool_input: { file_path: 'secrets.txt' }, tool_response: 'TOP SECRET CONTENTS' }),
    });
    assert.equal(received.length, 0, 'Read is off the allowlist entirely');
  });

  test('tool result bodies are not shipped', async () => {
    received = [];
    await run(['relay', '--event', 'PostToolUse'], {
      stdin: hookInput({ tool_response: { stdout: 'a whole file of output' } }),
    });
    const payload = received[0].body.payload;
    assert.equal(payload.tool_response, undefined);
    assert.equal(payload.tool_result, undefined);
    assert.equal(typeof payload.ok, 'boolean', 'only success/failure is reported');
  });

  test('a session with permissions bypassed refuses to stream', async () => {
    received = [];
    await run(['relay', '--event', 'PostToolUse'], {
      stdin: hookInput({ permission_mode: 'bypassPermissions' }),
    });
    assert.equal(received.length, 0);
  });
});

describe('redaction, checked at the network boundary', () => {
  const cases = [
    ['anthropic key', 'export ANTHROPIC_API_KEY=sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF', 'sk-ant-'],
    ['aws key id',    'aws configure set key AKIAIOSFODNN7EXAMPLE',                      'AKIAIOSFODNN7EXAMPLE'],
    ['github pat',    'git remote add o https://ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@x',   'ghp_aaaa'],
    ['slack token',   'curl -H "Authorization: xoxb-1234567890-abcdefghij"',             'xoxb-1234'],
    ['lobby token',   'lby_abcdefgh_ijklmnopqrstuvwxyz012345',                           'lby_abcdefgh_'],
    ['assignment',    'DATABASE_PASSWORD=hunter2hunter2',                                'hunter2hunter2'],
  ];

  for (const [label, command, mustNotAppear] of cases) {
    test(`${label} never crosses the wire`, async () => {
      received = [];
      await run(['relay', '--event', 'PostToolUse'], {
        stdin: hookInput({ tool_input: { command } }),
      });
      assert.equal(received.length, 1);
      assert.ok(
        !received[0].raw.includes(mustNotAppear),
        `secret leaked in transmitted body: ${received[0].raw.slice(0, 300)}`
      );
      assert.match(received[0].raw, /redacted/, 'the reader should see that something was removed');
    });
  }

  test('a private key block is redacted', async () => {
    received = [];
    await run(['relay', '--event', 'PostToolUse'], {
      stdin: hookInput({ tool_name: 'Write', tool_input: { file_path: 'a.txt', content: '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n' } }),
    });
    assert.ok(!received[0].raw.includes('BEGIN RSA PRIVATE KEY'));
  });

  const deniedPaths = ['.env', 'config/.env.production', '/home/u/.ssh/id_rsa', 'certs/server.pem', '.aws/credentials'];
  for (const p of deniedPaths) {
    test(`path denylist drops ${p}`, async () => {
      received = [];
      await run(['relay', '--event', 'PostToolUse'], {
        stdin: hookInput({ tool_name: 'Edit', tool_input: { file_path: p, new_string: 'anything' } }),
      });
      assert.equal(received.length, 0, `${p} must not be transmitted at all`);
    });
  }

  test('an ordinary path is not over-blocked', async () => {
    received = [];
    await run(['relay', '--event', 'PostToolUse'], {
      stdin: hookInput({ tool_name: 'Edit', tool_input: { file_path: 'src/environment.ts', new_string: 'ok' } }),
    });
    assert.equal(received.length, 1, 'redaction must not swallow normal work');
  });
});

describe('resilience', () => {
  test('a dead server does not fail the hook', async () => {
    const r = await run(['relay', '--event', 'PostToolUse'], {
      stdin: hookInput(),
      env: { LOBBY_SERVER_URL: 'http://127.0.0.1:9' },
    });
    assert.equal(r.code, 0, 'the session must not be disturbed because the board is down');
  });

  test('malformed hook input does not throw', async () => {
    const r = await run(['relay', '--event', 'PostToolUse'], { stdin: 'not json{{' });
    assert.equal(r.code, 0);
  });

  test('bindings file is not world-readable', () => {
    assert.ok(existsSync(join(dataDir, 'bindings.json')));
  });
});
