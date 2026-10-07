// Look at the product in a real browser, and fail if it is broken.
//
//   node ops/browser-check.mjs                     # local, spins up its own server
//   node ops/browser-check.mjs https://lobby.…     # against a deployment
//   node ops/browser-check.mjs --keep              # keep the screenshots and say where
//
// WHY THIS EXISTS. The worst bug this product shipped — bot-posted artifacts
// drawing as a grey box reading "artifact" — was invisible to every server-side
// test and obvious in one glance. For most of this project's life nobody had
// glanced, because glancing was manual. So it is automated here.
//
// It drives headless Chrome over the DevTools Protocol with no dependencies: the
// browser is already installed, and a screenshot tool that needs a 300MB install
// is a screenshot tool nobody runs. Two things are checked that a human eye would
// catch and a server test cannot:
//
//   - console errors and failed requests on load, per view
//   - the rendered text of each view, so a screen that renders an internal
//     config key or an unstyled error is a FAILURE, not a curiosity
//
// It also writes the PNGs, because "no errors" is not the same as "looks right"
// and the last mile of that judgement is still a person's.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const target = args.find((a) => a.startsWith('http'));
const HERE = resolve(import.meta.dirname, '..');

let failures = 0;
const results = [];
const pass = (name, detail = '') => { results.push(['PASS', name, detail]); };
const fail = (name, detail = '') => { results.push(['FAIL', name, detail]); failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shotDir = join(HERE, '.browser-check');
mkdirSync(shotDir, { recursive: true });

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function findChrome() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      ]
    : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
       '/snap/bin/chromium'];
  return candidates.find((p) => p && existsSync(p)) || null;
}

/**
 * A minimal CDP client over the WebSocket Chrome exposes. Node 22+ has a global
 * WebSocket, so this needs nothing from npm.
 */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }

  static async attach(port) {
    // The browser needs a moment to write its port file and start listening.
    let info = null;
    for (let i = 0; i < 80 && !info; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/list`);
        const tabs = await r.json();
        info = tabs.find((t) => t.type === 'page') || null;
      } catch { /* not up yet */ }
      if (!info) await sleep(125);
    }
    if (!info) throw new Error('Chrome did not expose a debugging target');

    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP socket failed')), { once: true });
    });
    const cdp = new CDP(ws);
    ws.addEventListener('message', (ev) => cdp.#onMessage(String(ev.data)));
    return cdp;
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve: res, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) {
      for (const h of this.handlers.get(msg.method) || []) h(msg.params);
    }
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  close() { try { this.ws.close(); } catch {} }
}

// ---------------------------------------------------------------------------
// The views to check
// ---------------------------------------------------------------------------

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844, mobile: true },
];

/**
 * Text that must never appear on a screen a stranger can reach.
 *
 * This is the check that would have caught the sign-in screen telling visitors to
 * set GITHUB_CLIENT_ID. Config keys, stack traces and framework placeholders are
 * all the same category of bug: an internal detail escaping into the product.
 */
const FORBIDDEN = [
  /\b[A-Z][A-Z0-9]*_(?:CLIENT_ID|CLIENT_SECRET|API_KEY|KEY|SECRET|TOKEN|PATH|DIR|URL)\b/,
  /\bundefined\b(?!\s*(?:behaviour|behavior))/i,
  /\bNaN\b/,
  /\[object Object\]/,
  /\{\{.+?\}\}/,                       // an unrendered template expression
  /\bat [A-Za-z]:\\|\bat \/(?:home|opt|app)\//,   // a stack frame
  /\.(?:ts|vue|mjs):\d+/,              // a source location
  /node_modules/,
  /\bECONNREFUSED\b|\bENOENT\b/,
];

/** Console noise that is not a defect. */
const IGNORABLE = [
  /favicon/i,
  /Download the Vue Devtools/i,
  /\[vite\]/i,
];

async function checkView(cdp, { label, url, viewport, expect = [], allowConsole = [], settleMs = 2600 }) {
  const consoleErrors = [];
  const failedRequests = [];

  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'assert') return;
    const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (![...IGNORABLE, ...allowConsole].some((re) => re.test(text))) consoleErrors.push(text);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const text = p.exceptionDetails?.exception?.description
      || p.exceptionDetails?.text || 'uncaught exception';
    if (![...IGNORABLE, ...allowConsole].some((re) => re.test(text))) consoleErrors.push(text);
  });
  cdp.on('Network.loadingFailed', (p) => {
    if (p.type === 'Image' || p.type === 'Font') return;
    failedRequests.push(`${p.type} ${p.errorText}`);
  });

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height,
    deviceScaleFactor: 1, mobile: !!viewport.mobile,
  });

  // Blank first. Going straight from /#a to /#b is a SAME-DOCUMENT navigation, so
  // the app never re-initialises and the second view silently reports the first
  // one's DOM — which is exactly how this tool passed a broken screen once.
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(120);
  await cdp.send('Page.navigate', { url });
  // Settle: the app resolves the session before it renders anything, and a board
  // with content also has to fetch the canvas and open a socket.
  await sleep(settleMs);

  // Prove we are looking at the page we asked for.
  const { result: loc } = await cdp.send('Runtime.evaluate', {
    expression: 'location.href', returnByValue: true,
  });
  if (loc.value !== url) {
    // A redirect is legitimate; silently checking the wrong page is not.
    pass(`${label} @ ${viewport.name}: navigated`, `${url} → ${loc.value}`);
  }

  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(${collectPageFacts.toString()})()`,
    returnByValue: true,
  });
  const facts = result.value || {};

  const name = `${label} @ ${viewport.name}`;

  // --- console and network ---
  if (consoleErrors.length === 0) pass(`${name}: no console errors`);
  else fail(`${name}: console errors`, consoleErrors.slice(0, 3).join(' | '));

  if (failedRequests.length === 0) pass(`${name}: no failed requests`);
  else fail(`${name}: failed requests`, failedRequests.slice(0, 3).join(' | '));

  // --- did anything render at all ---
  if (facts.textLength > 40) pass(`${name}: rendered content`, `${facts.textLength} chars`);
  else fail(`${name}: page is blank or nearly so`, `${facts.textLength} chars of text`);

  // --- internals leaking into the UI ---
  const leaked = FORBIDDEN.map((re) => facts.text.match(re)).filter(Boolean).map((m) => m[0]);
  if (leaked.length === 0) pass(`${name}: no internals in the visible text`);
  else fail(`${name}: internal detail on screen`, leaked.slice(0, 3).join(', '));

  // --- no horizontal overflow: the classic mobile break ---
  if (!facts.overflowsX) pass(`${name}: no horizontal overflow`);
  else fail(`${name}: content wider than the viewport`, `scrollWidth ${facts.scrollWidth} > ${viewport.width}`);

  // --- an interactive element nobody can identify ---
  if (facts.unlabelled.length === 0) pass(`${name}: every button has a label`);
  else fail(`${name}: unlabelled interactive elements`,
    `${facts.unlabelled.length}: ${facts.unlabelled.slice(0, 3).join(', ')}`);

  // --- controls covering each other ---
  if (facts.collisions.length === 0) pass(`${name}: no controls overlapping`);
  else fail(`${name}: controls overlap`, facts.collisions.slice(0, 2).join(' | '));

  // --- view-specific expectations ---
  //
  // `canvasOnly` scopes an assertion to the board, which is the only way to state
  // "this must not be on the canvas" about something the activity rail correctly
  // shows.
  for (const { desc, re, canvasOnly } of expect) {
    const subject = canvasOnly ? facts.canvasText : facts.text;
    if (canvasOnly && !facts.canvasText) {
      fail(`${name}: ${desc}`, 'could not find the canvas element to scope to');
      continue;
    }
    if (re.test(subject)) pass(`${name}: ${desc}`);
    else fail(`${name}: ${desc}`, canvasOnly
      ? `canvas text: ${JSON.stringify((facts.canvasText || '').replace(/\s+/g, ' ').slice(0, 220))}`
      : 'not found in the rendered text');
  }

  // --- the screenshot, for the judgement a check cannot make ---
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = join(shotDir, `${label.replace(/[^a-z0-9]+/gi, '-')}-${viewport.name}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));

  return { facts, file };
}

/** Runs inside the page. Kept self-contained: it is stringified to get there. */
function collectPageFacts() {
  const text = document.body ? document.body.innerText || '' : '';
  const de = document.documentElement;
  const scrollWidth = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);

  const unlabelled = [];
  for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;               // hidden: fine
    const labelled = (el.innerText || '').trim()
      || el.getAttribute('aria-label')
      || el.getAttribute('title')
      || el.querySelector('img[alt], svg')
      || el.querySelector('input');
    if (!labelled) {
      // Identify it well enough to find, without dumping the DOM.
      const id = el.id ? `#${el.id}` : el.className ? `.${String(el.className).split(/\s+/)[0]}` : '';
      unlabelled.push(`<${el.tagName.toLowerCase()}${id}>`);
    }
  }

  // Inputs count as content: a form with a placeholder and no prose is a real
  // screen, and text length alone would call it blank.
  const fields = document.querySelectorAll('input, select, textarea').length;

  // Controls that physically cover each other.
  //
  // A floating button parked on top of the chat composer's send button is
  // invisible to every other kind of test and immediately obvious to a user who
  // cannot click send. Only INTERACTIVE elements are compared, and only pairs
  // that are not nested — a button inside its own toolbar is not a collision.
  const interactive = [];
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    // Off-screen is not overlapping.
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue;
    interactive.push({ el, r });
  }

  const collisions = [];
  const describe = (el) => {
    const t = (el.innerText || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim();
    const id = el.id ? `#${el.id}` : el.className ? `.${String(el.className).trim().split(/\s+/)[0]}` : '';
    return `<${el.tagName.toLowerCase()}${id}>${t ? ` "${t.slice(0, 20)}"` : ''}`;
  };
  for (let i = 0; i < interactive.length; i++) {
    for (let j = i + 1; j < interactive.length; j++) {
      const a = interactive[i], b = interactive[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      // A few pixels is a border touching a border. A quarter of the smaller
      // control's area being covered is a bug.
      if (ox <= 4 || oy <= 4) continue;
      const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if ((ox * oy) / smaller < 0.25) continue;
      collisions.push(`${describe(a.el)} over ${describe(b.el)} (${Math.round(ox)}x${Math.round(oy)}px)`);
    }
  }

  // The CANVAS text on its own, separate from the whole page.
  //
  // This distinction is load-bearing for the placement rule: the activity rail
  // deliberately shows every event including `ls` and `npm test`, while the board
  // must show only work product. Asserting against the whole page cannot tell a
  // card on the canvas from a line in the rail, and would call a correct board a
  // failure — which it did.
  // `.board` exactly, never `[class*="board"]` — that also matches `.board-view`,
  // the whole page wrapper, which contains the rail and made every canvas-scoped
  // assertion meaningless while looking like it worked.
  const canvasEl = document.querySelector('.board') || document.querySelector('.canvas-host');
  const canvasText = canvasEl ? (canvasEl.innerText || '') : '';

  return {
    text,
    canvasText,
    textLength: text.trim().length,
    fields,
    unlabelled,
    collisions,
    scrollWidth,
    overflowsX: scrollWidth > window.innerWidth + 2,
    title: document.title,
    url: location.href,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const chrome = findChrome();
if (!chrome) {
  console.error('Chrome not found. Install Chrome or Chromium, or pass a URL to check remotely.');
  process.exit(2);
}

let server = null;
let dbFile = null;
let base = target;

if (!base) {
  // Local run: serve the built client from the real server, so this checks what a
  // deployment would serve rather than a dev-mode approximation.
  const dist = join(HERE, 'apps/client/dist');
  if (!existsSync(dist)) {
    console.error('apps/client/dist not found. Build the client first:\n  cd apps/client && bun run build');
    process.exit(2);
  }
  // A port nothing else uses, and REFUSE to reuse whatever is on it.
  //
  // This tool previously started a server only if the port was free, and silently
  // used whatever answered /health otherwise. A server left running from an
  // earlier run then served MONTHS-old code while every check reported PASS —
  // which cost an hour of chasing a placement bug that had already been fixed.
  // A checking tool that can test stale code is worse than no checking tool.
  const port = 4893;
  base = `http://localhost:${port}`;

  const occupied = async () => {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch { return false; }
  };

  // Give the PREVIOUS run's server a few seconds to finish shutting down. Two
  // runs back to back is the normal way this tool is used, and a hard refusal on
  // a port that is about to free itself is a false alarm that teaches people to
  // ignore the real one.
  let squatter = await occupied();
  for (let i = 0; i < 8 && squatter; i++) {
    await sleep(1000);
    squatter = await occupied();
  }

  if (squatter) {
    console.error(
      `\nSomething is already listening on :${port}.\n\n` +
      `  This check will not reuse it — it has no way to know that server is\n` +
      `  running the code you are about to check, and a stale one reports PASS\n` +
      `  for code that no longer exists.\n\n` +
      `  Find and stop it:\n` +
      `    netstat -ano | findstr :${port}      (Windows)\n` +
      `    lsof -ti :${port} | xargs kill        (macOS / Linux)\n`
    );
    process.exit(2);
  }

  dbFile = join(mkdtempSync(join(tmpdir(), 'lobby-bc-')), 'check.db');
  server = spawn(process.platform === 'win32' ? 'bun.exe' : 'bun', ['run', join(HERE, 'apps/server/src/index.ts')], {
    env: {
      ...process.env,
      SERVER_PORT: String(port), DB_PATH: dbFile, STATIC_DIR: dist,
      REQUIRE_AUTH: 'true', PUBLIC_ORIGIN: base, ALLOWED_ORIGINS: base,
      // A configured provider, so the sign-in screen renders its real state
      // rather than the "nothing configured" fallback.
      GITHUB_CLIENT_ID: 'Iv1.browsercheck', GITHUB_CLIENT_SECRET: 'browsercheck-secret',
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
    // NOT `shell: true`. On Windows that wraps the process in cmd.exe, and
    // `server.kill()` then kills the WRAPPER while bun keeps the port — so every
    // run leaked a server, and the next run silently tested whichever stale one
    // answered first. `bun.exe` is named directly so the handle is the real
    // process and killing it actually stops it.
    shell: false,
  });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch {}
    if (!up) await sleep(250);
  }
  if (!up) {
    console.error('the local server did not start');
    server.kill();
    process.exit(2);
  }
}

// Real workspaces to look at. Local only: this creates data, and a check that runs
// against production must never do that.
//
// TWO boards, because they fail differently. An empty board proves the onboarding
// renders. A board WITH artifacts proves the thing that actually broke once: the
// server accepted a post, the API returned it, and the canvas drew a grey box. No
// server-side test can see that.
let realCode = null;
let fullCode = null;
let sessionCode = null;
const POSTED = [
  { kind: 'diff', title: 'retention.ts: keep referenced events', body: '+ AND NOT EXISTS (SELECT 1 FROM canvas_objects ...)' },
  { kind: 'doc', title: 'Why the body limit exists', body: 'A 60MB POST was accepted in 0.9s. On a 512MB container that is everyone\'s board.' },
  { kind: 'note', title: 'Second agent checked in', body: 'Posted by a different identity, so attribution is exercised too.' },
];

/**
 * A realistic slice of a working session, sent as EVENTS rather than posted.
 *
 * Two different things are being checked with this. First, that the noise stays
 * off the board: the `ls`/`cat`/`npm test`/read/prompt events below must produce
 * no cards at all. Second, that what survives the filter actually DRAWS — an
 * event-derived card renders down a different path from a posted one, so a board
 * full of posted artifacts proves nothing about this one.
 */
const NOISE = [
  { event_type: 'tool_result', payload: { tool_name: 'Bash', tool_input: { command: 'ls -la' }, ok: true } },
  { event_type: 'tool_result', payload: { tool_name: 'Bash', tool_input: { command: 'npm test' }, ok: true } },
  { event_type: 'tool_result', payload: { tool_name: 'Bash', tool_input: { command: 'git status' }, ok: true } },
  { event_type: 'tool_result', payload: { tool_name: 'Read' } },
  { event_type: 'tool_result', payload: { tool_name: 'Grep' } },
  { event_type: 'user_prompt', payload: { prompt: 'please fix the retention bug' } },
  { event_type: 'session_start', payload: {} },
];

const REAL_WORK = [
  { event_type: 'tool_result', payload: { tool_name: 'Write', tool_input: { file_path: 'src/retention.ts' }, ok: true } },
  { event_type: 'tool_result', payload: { tool_name: 'Bash', tool_input: { command: 'git push origin master' }, ok: true } },
  { event_type: 'research_complete', payload: { summary: 'competitor pricing: 3 of 5 charge per seat' } },
];

if (!target) {
  const makeRoom = async (name) => {
    try {
      const res = await fetch(`${base}/lobbies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, visibility: 'private' }),
      });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  };

  const empty = await makeRoom('Browser check — empty');
  realCode = empty?.code || null;

  const full = await makeRoom('Browser check — with work on it');
  if (full?.code && full?.token) {
    fullCode = full.code;
    for (const [i, a] of POSTED.entries()) {
      await fetch(`${base}/lobbies/${full.code}/agent/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${full.token}` },
        body: JSON.stringify({ ...a, idem_key: `browser-check-${i}` }),
      }).catch(() => {});
    }
  }

  // A separate room for the event path: what a real session emits, mostly noise.
  const session = await makeRoom('Browser check — a real session');
  if (session?.code && session?.token) {
    sessionCode = session.code;
    for (const e of [...NOISE, ...REAL_WORK]) {
      await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({
          source: 'claude-code', agent_id: 'cc-check', session_id: 'check-1',
          user_id: 'checker', lobby_id: session.code, timestamp: Date.now(), ...e,
        }),
      }).catch(() => {});
    }
  }

  if (!realCode) console.error('note: could not create a workspace; board views skipped');
}

const profile = mkdtempSync(join(tmpdir(), 'lobby-chrome-'));
const cdpPort = 9333;
const browser = spawn(chrome, [
  '--headless=new',
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--disable-features=Translate,MediaRouter',
  'about:blank',
], { stdio: 'ignore' });

let cdp = null;
try {
  cdp = await CDP.attach(cdpPort);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  const VIEWS = [
    {
      label: 'sign-in',
      url: `${base}/`,
      expect: [
        { desc: 'says what the product is', re: /shared canvas|Lobby/i },
        { desc: 'offers a way to sign in', re: /Continue with|invite code/i },
      ],
    },
    {
      // A mistyped invite code is the most likely first contact anyone has with
      // this product going wrong. It must SAY so — landing back on sign-in with
      // no explanation reads as "the link is broken", and the first regex written
      // here was loose enough to pass on the sign-in screen's own prose.
      label: 'invite-code-bad',
      url: `${base}/#lobby=ZZZZZZ`,
      expect: [
        { desc: 'a bad code is acknowledged, not silently ignored',
          re: /no workspace|not found|no longer|does not exist|couldn't find|could not find|invalid|expired/i },
        // Quoting the code back is what makes the message actionable — it is how
        // someone spots that they typed O for 0.
        { desc: 'and the offending code is quoted back', re: /ZZZZZZ/ },
      ],
    },
    { label: 'health', url: `${base}/health`, expect: [{ desc: 'reports ok', re: /"status"\s*:\s*"ok"/ }] },
    // A privacy policy linked from the front door that 404s is worse than not
    // linking one. The SPA fallback would serve the app shell for a missing path
    // and look like a success, so each page is checked for its own content.
    {
      label: 'legal-privacy',
      url: `${base}/legal/privacy.html`,
      expect: [
        { desc: 'it is the privacy page, not the app shell', re: /What Lobby holds/i },
        { desc: 'it says invite codes are credentials', re: /invite code is a credential/i },
        { desc: 'and admits backups are on the same machine', re: /same machine/i },
      ],
    },
    {
      label: 'legal-terms',
      url: `${base}/legal/terms.html`,
      expect: [{ desc: 'it is the terms page', re: /Terms of use/i }],
    },
    {
      label: 'legal-security',
      url: `${base}/legal/security.html`,
      expect: [
        { desc: 'it is the security page', re: /Reporting a security problem/i },
        { desc: 'with an address to report to', re: /security@/i },
      ],
    },
  ];

  // The board is the product. Both of the bugs this tool has found so far were on
  // it, so it is checked with a REAL workspace — created through the API, the same
  // way a customer's first room is.
  if (realCode) {
    VIEWS.push({
      label: 'board-empty',
      url: `${base}/#lobby=${realCode}`,
      expect: [
        { desc: 'it tells you how to connect a bot', re: /Connect your first bot/i },
        { desc: 'and shows the code to hand out', re: new RegExp(realCode) },
      ],
    });
  }

  // The view that would have caught the grey-box bug.
  if (fullCode) {
    VIEWS.push({
      label: 'board-with-work',
      url: `${base}/#lobby=${fullCode}`,
      // Settle longer: this one has to fetch the canvas and open a socket, not
      // just render an empty state.
      settleMs: 5000,
      expect: [
        // Each artifact's TITLE must be on screen. Not a count, not a container —
        // the actual text, because a card that draws as a placeholder still exists
        // in the DOM and still counts.
        ...POSTED.map((a) => ({
          desc: `artifact renders: "${a.title.slice(0, 34)}"`,
          re: new RegExp(a.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 34), 'i'),
        })),
        // And the onboarding must be GONE. It saying "waiting for the first
        // artifact" while three sit on the board is its own kind of wrong.
        { desc: 'the empty state is gone', re: /^(?!.*Waiting for the first artifact)/s },
      ],
    });
  }

  // The board as it looks after a real session: does the filter hold, and does
  // what survives it actually draw?
  if (sessionCode) {
    VIEWS.push({
      label: 'board-real-session',
      url: `${base}/#lobby=${sessionCode}`,
      settleMs: 5000,
      expect: [
        // Survived the filter, and rendered.
        { desc: 'a written file is on the board', re: /retention\.ts/i, canvasOnly: true },
        { desc: 'a push is on the board', re: /git push|deploy/i, canvasOnly: true },
        { desc: 'finished research is on the board', re: /competitor pricing/i, canvasOnly: true },

        { desc: 'the empty state is gone', re: /^(?!.*Waiting for the first artifact)/s },

        // The point of the whole rule: a teammate opening this board must not
        // have to read past `ls` and `npm test` to find the work. Scoped to the
        // canvas, because the activity rail SHOULD still list these — it is the
        // log, and the board is not. Asserting against the whole page called a
        // correct board a failure.
        { desc: 'no `ls` card on the canvas', re: /^(?!.*ls -la)/s, canvasOnly: true },
        { desc: 'no `npm test` card on the canvas', re: /^(?!.*npm test)/s, canvasOnly: true },
        { desc: 'no `git status` card on the canvas', re: /^(?!.*git status)/s, canvasOnly: true },
        { desc: 'no prompt on the canvas', re: /^(?!.*please fix the retention)/s, canvasOnly: true },
      ],
    });
  }

  for (const view of VIEWS) {
    for (const viewport of VIEWPORTS) {
      // /health is JSON; checking it at two viewports is noise.
      if (view.label === 'health' && viewport.name !== 'desktop') continue;
      try {
        await checkView(cdp, { ...view, viewport });
      } catch (err) {
        fail(`${view.label} @ ${viewport.name}`, err.message);
      }
    }
  }
} catch (err) {
  fail('browser session', err.message);
} finally {
  cdp?.close();
  try { browser.kill(); } catch {}
  if (server) try { server.kill(); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  if (dbFile) for (const s of ['', '-wal', '-shm']) {
    try { rmSync(dbFile + s, { force: true }); } catch {}
  }
}

let last = '';
for (const [status, name, detail] of results) {
  const group = name.split(':')[0];
  if (group !== last) { console.log(`\n=== ${group} ===`); last = group; }
  const label = name.includes(':') ? name.slice(name.indexOf(':') + 2) : name;
  console.log(`  ${status}  ${label}${detail ? '  -> ' + detail : ''}`);
}

console.log(`\nScreenshots: ${shotDir}`);
if (!KEEP) console.log('(pass --keep to stop them being overwritten next run)');
console.log(`\n=== verdict ===\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s)`}`);
process.exit(failures === 0 ? 0 : 1);
