// What is actually going on in a room.
//
//   node ops/lobby-debug.mjs ABC123              # local
//   node ops/lobby-debug.mjs ABC123 --live       # against production
//   node ops/lobby-debug.mjs ABC123 --watch      # refresh until Ctrl-C
//   node ops/lobby-debug.mjs ABC123 --raw        # full JSON, for piping to jq
//
// WHY THIS EXISTS. When a multi-agent test goes wrong the question is always the
// same and is never answerable from the UI: did the agent fail to post, or did it
// post and the board is not rendering it? Those have completely different causes —
// one is the agent or its credential, the other is the client — and guessing wrong
// costs an afternoon. This asks the server directly and prints both sides.
//
// A token is only needed for a room this machine has not joined. If ops/
// multi-agent-test.mjs created the room, or the browser has, pass LOBBY_TOKEN;
// otherwise the tool joins as a read-only observer and says so.

const args = process.argv.slice(2);
const CODE = (args.find((a) => !a.startsWith('-')) || '').toUpperCase();
const LIVE = args.includes('--live');
const WATCH = args.includes('--watch');
const RAW = args.includes('--raw');

const SERVER = (process.env.LOBBY_SERVER_URL
  || (LIVE ? 'https://lobby.dimedata.cloud' : 'http://localhost:4000')).replace(/\/$/, '');
let TOKEN = process.env.LOBBY_TOKEN || null;

if (!CODE) {
  console.error(`Usage: node ops/lobby-debug.mjs CODE [--live] [--watch] [--raw]

  CODE            the six-character workspace code
  --live          talk to https://lobby.dimedata.cloud instead of localhost
  --watch         refresh every 3s
  --raw           dump JSON instead of a report

  LOBBY_TOKEN     a member token, if you have one
  LOBBY_SERVER_URL  overrides the server entirely`);
  process.exit(2);
}

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ago = (ts) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const api = (path, init = {}) =>
  fetch(`${SERVER}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });

/**
 * Get a credential if we do not have one.
 *
 * Joining is how an invite code is redeemed, and it is also the only way to tell a
 * missing room from an unauthorised one: an unauthenticated GET answers 404 for
 * both, deliberately, so that invite codes cannot be brute-forced by probing.
 */
async function ensureToken() {
  if (TOKEN) return 'supplied';
  const r = await api(`/lobbies/${CODE}/join`, {
    method: 'POST',
    body: JSON.stringify({ user_id: 'debug-observer', agent_id: 'lobby-debug', source: 'debug' }),
  });
  if (r.status === 404) return 'no-such-room';
  if (!r.ok) return `join-failed-${r.status}`;
  const j = await r.json().catch(() => ({}));
  if (!j.token) return 'join-gave-no-token';
  TOKEN = j.token;
  return 'joined';
}

async function collect() {
  const out = { server: SERVER, code: CODE, at: new Date().toISOString() };

  try {
    out.health = await (await api('/health')).json();
  } catch (e) {
    out.healthError = e.message;
    return out;
  }

  out.tokenSource = await ensureToken();
  if (out.tokenSource === 'no-such-room') return out;

  const get = async (path, key) => {
    try {
      const r = await api(path);
      out[`${key}Status`] = r.status;
      if (r.ok) out[key] = await r.json();
    } catch (e) { out[`${key}Error`] = e.message; }
  };

  await Promise.all([
    get(`/lobbies/${CODE}`, 'lobby'),
    get(`/lobbies/${CODE}/members`, 'members'),
    get(`/lobbies/${CODE}/canvas`, 'canvas'),
    get(`/lobbies/${CODE}/messages?limit=12`, 'messages'),
    get(`/lobbies/${CODE}/agent/brief`, 'brief'),
    get(`/presence?lobby=${CODE}`, 'presence'),
    get('/agents', 'agents'),
  ]);

  return out;
}

function report(d) {
  const lines = [];
  const L = (s = '') => lines.push(s);

  L();
  L(`${b('Lobby debug')} ${dim(`${d.server}  ·  ${new Date(d.at).toISOString().slice(11, 19)}`)}`);
  L();

  if (d.healthError) {
    L(`${red('✗ server unreachable')}  ${d.healthError}`);
    L();
    L(`  Is it running? ${dim(LIVE ? '' : 'Locally:  .\\start.ps1')}`);
    return lines.join('\n');
  }

  L(`${green('✓')} server ok ${dim(`seq ${d.health.seq} · ${d.health.connections?.global ?? 0} global sockets · ` +
    `${d.health.connections?.lobbies ?? 0} rooms with listeners`)}`);
  if (d.health.retention) {
    L(`  ${dim(`retention: events ${d.health.retention.event_retention_days}d · board content ${d.health.retention.board_content}`)}`);
  }
  L();

  if (d.tokenSource === 'no-such-room') {
    L(`${red(`✗ no workspace ${CODE} on this server`)}`);
    L();
    L(`  ${yellow('Most likely cause:')} the wrong server. A code that exists locally does`);
    L(`  not exist in production and the reverse. This checked ${b(d.server)}.`);
    L(`  ${dim(LIVE ? 'Drop --live to check localhost.' : 'Add --live to check production.')}`);
    return lines.join('\n');
  }
  if (d.tokenSource !== 'supplied' && d.tokenSource !== 'joined') {
    L(`${red(`✗ could not get a credential: ${d.tokenSource}`)}`);
    return lines.join('\n');
  }
  L(`${dim(`credential: ${d.tokenSource === 'supplied' ? 'LOBBY_TOKEN from the environment' : 'joined as a temporary observer'}`)}`);
  L();

  // --- the room ---
  if (d.lobby) {
    L(`${b('Workspace')}  ${cyan(d.lobby.code)}  "${d.lobby.name}"  ${dim(`${d.lobby.visibility} · created ${ago(d.lobby.created_at)} · last_seq ${d.lobby.last_seq}`)}`);
  } else {
    L(`${b('Workspace')}  ${red(`could not read it (HTTP ${d.lobbyStatus})`)}`);
  }
  L();

  // --- who is in it ---
  const members = d.members?.members || d.lobby?.members || [];
  L(`${b('Members')} ${dim(`(${members.length})`)}`);
  if (!members.length) L(`  ${dim('none')}`);
  for (const m of members) {
    L(`  ${m.user_id || m.agent_id || '?'}  ${dim(`${m.role || '—'} · seen ${ago(m.last_seen)}`)}`);
  }
  L();

  // --- agents the server has heard from ---
  const agents = d.agents?.agents || d.agents || [];
  const inRoom = Array.isArray(agents) ? agents : [];
  L(`${b('Agents the server has heard from')} ${dim(`(${inRoom.length})`)}`);
  if (!inRoom.length) {
    L(`  ${dim('none — no agent has reported an event to this server yet')}`);
  }
  for (const a of inRoom.slice(0, 10)) {
    const dot = a.status === 'active' ? green('●') : a.status === 'idle' ? yellow('●') : dim('●');
    L(`  ${dot} ${a.user_id || a.agent_id}  ${dim(`${a.source || '?'} · ${a.status} · ${a.model || 'no model reported'} · ${ago(a.last_event_at || a.updated_at)}`)}`);
  }
  L();

  // --- presence ---
  const present = d.presence?.users || d.presence || [];
  const list = Array.isArray(present) ? present : [];
  L(`${b('Present right now')} ${dim(`(${list.length})`)}`);
  if (!list.length) L(`  ${dim('nobody has a live socket open')}`);
  for (const p of list.slice(0, 10)) L(`  ${p.user_id}  ${dim(ago(p.last_seen))}`);
  L();

  // --- THE question: what is on the board ---
  const objects = d.canvas?.objects || [];
  const live = objects.filter((o) => !o.deleted);
  const tombstoned = objects.length - live.length;
  L(`${b('On the board')} ${dim(`(${live.length} live${tombstoned ? `, ${tombstoned} deleted` : ''})`)}`);
  if (!live.length) {
    L(`  ${dim('empty')}`);
  }
  for (const o of live.slice(0, 14)) {
    const kind = o.props?.agent_kind || o.type;
    const title = (o.props?.title || '').slice(0, 46) || dim('(no title)');
    const bodyLen = (o.props?.body || '').length;
    // The distinction that matters: an artifact with no body renders as a grey box.
    const flag = bodyLen === 0 && !o.props?.url ? red('  ← NO BODY: will render as a placeholder') : '';
    L(`  ${cyan(`#${o.handle || o.id?.slice(-4)}`)} ${String(kind).padEnd(8)} ${title} ${dim(`· by ${o.created_by || '?'} · ${bodyLen}b · ${ago(o.updated_at)}`)}${flag}`);
  }
  L();

  // --- chat ---
  const msgs = d.messages?.messages || [];
  L(`${b('Last messages')} ${dim(`(${msgs.length})`)}`);
  if (!msgs.length) L(`  ${dim('none')}`);
  for (const m of msgs.slice(-8)) {
    const who = m.author_user || m.author || '?';
    const tag = m.author_kind === 'agent' ? dim('[bot]') : dim('[human]');
    L(`  ${tag} ${who}: ${(m.body || '').slice(0, 74)} ${dim(ago(m.created_at || m.timestamp))}`);
  }
  L();

  // --- what an agent sees, which is not the same as what the board holds ---
  if (d.brief?.text !== undefined) {
    const t = (d.brief.text || '').trim();
    L(`${b('What an agent reads')} ${dim(`(cursor ${d.brief.cursor}, ${t.length} chars)`)}`);
    if (!t) {
      L(`  ${dim('nothing — a joining agent would see an empty room')}`);
    } else {
      for (const line of t.split('\n').slice(0, 10)) L(`  ${dim('│')} ${line.slice(0, 88)}`);
      if (t.split('\n').length > 10) L(`  ${dim('│ …')}`);
    }
    L();
  } else if (d.briefStatus) {
    L(`${b('What an agent reads')}  ${red(`brief failed (HTTP ${d.briefStatus})`)}`);
    L();
  }

  // --- the interpretation, so the numbers do not have to be read cold ---
  L(b('Reading of the above'));
  const agentCount = inRoom.length;
  if (!live.length && !agentCount) {
    L(`  ${yellow('Nothing has happened yet.')} No agent has reported in and the board is`);
    L(`  empty. If an agent should be running, its credential or its server URL is`);
    L(`  the first thing to check — a wrong LOBBY_SERVER_URL succeeds silently onto`);
    L(`  a different board.`);
  } else if (!live.length && agentCount) {
    L(`  ${yellow('Agents are connected but the board is empty.')} They are reporting events`);
    L(`  without posting artifacts. Events are the activity stream; artifacts are`);
    L(`  what the board draws. An agent that only emits events shows in the rail,`);
    L(`  not on the canvas.`);
  } else if (live.some((o) => !(o.props?.body || '').length && !o.props?.url)) {
    L(`  ${red('At least one artifact has no body.')} That renders as a grey placeholder.`);
    L(`  This is the failure the client render test guards; if it is happening, the`);
    L(`  poster sent a title with no content.`);
  } else {
    const authors = new Set(live.map((o) => o.created_by).filter(Boolean));
    L(`  ${green('Working.')} ${live.length} artifact(s) from ${authors.size} author(s)` +
      `${authors.size > 1 ? green(' — more than one agent has posted, which is the thing this product is for') : dim(' — only one author so far')}.`);
  }
  L();

  return lines.join('\n');
}

async function once() {
  const d = await collect();
  if (RAW) { console.log(JSON.stringify(d, null, 2)); return d; }
  console.log(report(d));
  return d;
}

if (WATCH) {
  process.on('SIGINT', () => { console.log('\n'); process.exit(0); });
  for (;;) {
    process.stdout.write('\x1b[2J\x1b[H');
    await once();
    console.log(dim('  refreshing every 3s — Ctrl-C to stop'));
    await sleep(3000);
  }
} else {
  const d = await once();
  const bad = !!d.healthError || d.tokenSource === 'no-such-room';
  // process.exit() here trips a libuv assertion on Windows when fetch's keep-alive
  // sockets are still closing ("!(handle->flags & UV_HANDLE_CLOSING)"). Setting the
  // code and letting the loop drain is the same outcome without the scary line.
  process.exitCode = bad ? 1 : 0;
}
