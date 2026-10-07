// The MCP server, driven over real stdio against a stub backend.
//
//   node lobby-plugin/test/mcp.test.mjs
//
// What matters here is not that the JSON-RPC framing works — it is that a bot
// cannot talk its way into another room. The tool schemas deliberately expose no
// lobby, member or author parameter, and these tests assert that a model passing
// them anyway changes nothing about the request that goes out.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_MJS = join(HERE, '..', 'mcp', 'server.mjs');

let dataDir;
let backend;
let backendUrl;
let requests = [];

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'lobby-mcp-'));
  mkdirSync(dataDir, { recursive: true });

  // A session already joined to room ABC123 with a member token.
  writeFileSync(join(dataDir, 'bindings.json'), JSON.stringify({
    sessions: { 'test-session': { lobby: 'ABC123', token: 'lby_test_secret' } },
    cwds: {},
  }));

  backend = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.includes('/agent/brief')) {
        res.end(JSON.stringify({ text: 'room: test\nyou: alice\n#a1  doc  a thing  by bob 1s ago', cursor: 42, truncated: false }));
      } else if (req.url.includes('/agent/artifact/a1')) {
        res.end(JSON.stringify({ text: '#a1 doc\n<untrusted from="bob" kind="doc">\nhello\n</untrusted>' }));
      } else if (req.url.includes('/agent/artifact/')) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'no artifact' }));
      } else if (req.url.includes('/agent/post')) {
        res.statusCode = 201;
        res.end(JSON.stringify({ handle: 'a9', id: 'ag_a9_x', seq: 9, deduped: false }));
      } else if (req.url.includes('/members')) {
        res.end(JSON.stringify([{ user_id: 'alice', role: 'owner' }, { user_id: 'bob-bot', role: 'editor' }]));
      } else if (req.url.includes('/messages')) {
        res.statusCode = 201;
        res.end(JSON.stringify({ id: 1 }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Lobby not found' }));
      }
    });
  });
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  backendUrl = `http://127.0.0.1:${backend.address().port}`;
});

after(() => {
  try { backend.close(); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

/** Start the MCP server, run a sequence of requests, collect the responses. */
function rpc(messages, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_MJS], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDir,
        CLAUDE_CODE_SESSION_ID: 'test-session',
        LOBBY_SERVER_URL: backendUrl,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    let buf = '';
    proc.stdout.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) { try { out.push(JSON.parse(line)); } catch {} }
      }
      if (out.length >= messages.filter((m) => m.id !== undefined).length) {
        setTimeout(() => { proc.kill(); resolve(out); }, 60);
      }
    });
    proc.on('error', reject);
    setTimeout(() => { proc.kill(); resolve(out); }, 8000);
    for (const m of messages) proc.stdin.write(JSON.stringify(m) + '\n');
  });
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
const callTool = (id, name, args) =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const textOf = (r) => r?.result?.content?.[0]?.text || '';

describe('protocol', () => {
  test('initialize advertises tools', async () => {
    const [r] = await rpc([init]);
    assert.equal(r.result.serverInfo.name, 'lobby');
    assert.ok(r.result.capabilities.tools);
  });

  test('tools/list returns the five tools', async () => {
    const out = await rpc([init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const names = out.find((m) => m.id === 2).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['lobby_artifact', 'lobby_members', 'lobby_post', 'lobby_read', 'lobby_say']);
  });

  test('an unknown method is an error, not a crash', async () => {
    const out = await rpc([init, { jsonrpc: '2.0', id: 2, method: 'nope/nope' }]);
    assert.equal(out.find((m) => m.id === 2).error.code, -32601);
  });
});

describe('identity cannot be argued for', () => {
  test('no tool exposes a lobby, member or author parameter', async () => {
    const out = await rpc([init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const tools = out.find((m) => m.id === 2).result.tools;
    const forbidden = ['lobby', 'lobby_id', 'code', 'member', 'member_id', 'user_id', 'author', 'token', 'actor'];
    for (const t of tools) {
      const props = Object.keys(t.inputSchema?.properties || {});
      const leak = props.filter((p) => forbidden.includes(p));
      assert.deepEqual(leak, [], `${t.name} exposes ${leak.join(', ')}`);
    }
  });

  test('passing a lobby anyway does not change the room that is contacted', async () => {
    requests = [];
    await rpc([init, callTool(2, 'lobby_post', {
      kind: 'doc', title: 'x',
      lobby: 'OTHER1', lobby_id: 'OTHER1', code: 'OTHER1', user_id: 'mallory', token: 'lby_stolen',
    })]);
    const posted = requests.find((r) => r.url.includes('/agent/post'));
    assert.ok(posted, 'no request reached the backend');
    assert.ok(posted.url.startsWith('/lobbies/ABC123/'), `contacted ${posted.url}`);
    assert.equal(posted.auth, 'Bearer lby_test_secret');
    const sent = JSON.parse(posted.body);
    for (const k of ['lobby', 'lobby_id', 'code', 'user_id', 'token', 'author', 'actor']) {
      assert.ok(!(k in sent), `forwarded ${k} to the server`);
    }
  });
});

describe('tools', () => {
  test('lobby_read returns the board and hands back a cursor', async () => {
    const out = await rpc([init, callTool(2, 'lobby_read', {})]);
    const t = textOf(out.find((m) => m.id === 2));
    assert.match(t, /#a1/);
    assert.match(t, /cursor: 42/);
  });

  test('lobby_read forwards since/detail/budget', async () => {
    requests = [];
    await rpc([init, callTool(2, 'lobby_read', { since: 7, detail: true, budget: 2000 })]);
    const r = requests.find((x) => x.url.includes('/agent/brief'));
    assert.match(r.url, /since=7/);
    assert.match(r.url, /detail=1/);
    assert.match(r.url, /budget=2000/);
  });

  test('lobby_artifact passes untrusted fencing through untouched', async () => {
    const out = await rpc([init, callTool(2, 'lobby_artifact', { handle: '#a1' })]);
    const t = textOf(out.find((m) => m.id === 2));
    assert.match(t, /<untrusted from="bob"/);
    assert.match(t, /<\/untrusted>/);
  });

  test('lobby_post reports the handle it landed on', async () => {
    const out = await rpc([init, callTool(2, 'lobby_post', { kind: 'diff', title: 'a change' })]);
    assert.match(textOf(out.find((m) => m.id === 2)), /#a9/);
  });

  test('lobby_post without a title fails before contacting the server', async () => {
    requests = [];
    const out = await rpc([init, callTool(2, 'lobby_post', { kind: 'doc' })]);
    const r = out.find((m) => m.id === 2);
    assert.equal(r.result.isError, true);
    assert.equal(requests.filter((x) => x.url.includes('/agent/post')).length, 0);
  });

  test('lobby_say referencing a missing artifact is refused, and says nothing', async () => {
    requests = [];
    const out = await rpc([init, callTool(2, 'lobby_say', { body: 'hi', ref_handle: 'a404' })]);
    assert.equal(out.find((m) => m.id === 2).result.isError, true);
    assert.equal(requests.filter((x) => x.url.includes('/messages')).length, 0);
  });

  test('lobby_members lists the room', async () => {
    const out = await rpc([init, callTool(2, 'lobby_members', {})]);
    const t = textOf(out.find((m) => m.id === 2));
    assert.match(t, /alice\s+owner/);
    assert.match(t, /bob-bot\s+editor/);
  });
});

describe('not joined', () => {
  test('every tool explains how to join rather than failing opaquely', async () => {
    const out = await rpc(
      [init, callTool(2, 'lobby_read', {}), callTool(3, 'lobby_post', { kind: 'doc', title: 'x' })],
      { CLAUDE_CODE_SESSION_ID: 'some-other-session' }
    );
    for (const id of [2, 3]) {
      const r = out.find((m) => m.id === id);
      assert.equal(r.result.isError, true);
      assert.match(textOf(r), /\/lobby:join/);
    }
  });
});

describe('errors', () => {
  test('a 404 explains that it is deliberately indistinguishable', async () => {
    const out = await rpc([init, callTool(2, 'lobby_artifact', { handle: 'zz' })]);
    const t = textOf(out.find((m) => m.id === 2));
    assert.match(t, /no artifact/i);
  });

  test('a malformed line does not kill the server', async () => {
    const out = await rpc([
      init,
      { __raw: true },
      callTool(2, 'lobby_members', {}),
    ]);
    assert.ok(out.find((m) => m.id === 2), 'server stopped responding after bad input');
  });
});
