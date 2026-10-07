// Server-render ArtifactCard against the exact shapes lobby_post writes.
// This exists because the backend accepted bot-posted artifacts, production
// verified them, and the board drew a grey box reading "artifact" — a failure
// that is invisible to every server-side test.
import { build } from 'esbuild';
import { writeFileSync, unlinkSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Anchored on this file, not the cwd — the documented invocation runs it from
// the repo root, where a cwd-relative entry cannot resolve the component.
const dir = dirname(fileURLToPath(import.meta.url));
const entry = join(dir, '.art-entry.js');
writeFileSync(entry, `
import { renderToString } from 'vue/server-renderer';
import { createSSRApp, h } from 'vue';
import ArtifactCard from './src/components/ArtifactCard.vue';
globalThis.__render = (object, expanded) =>
  renderToString(createSSRApp({ render: () => h(ArtifactCard, { object, expanded }) }));
`);

const out = join(dir, '.art-bundle.cjs');

// Clean up however this exits. The tidy-up used to sit on the happy path only, so
// a build failure left .art-entry.js in the working tree — where it turned up in
// `git status` and very nearly got committed.
process.on('exit', () => {
  for (const f of [entry, out]) { try { unlinkSync(f); } catch {} }
});
await build({
  entryPoints: [entry], bundle: true, outfile: out, format: 'cjs', platform: 'node',
  external: ['vue', 'vue/server-renderer'], logLevel: 'error',
  plugins: [{
    name: 'vue-sfc',
    setup(b) {
      b.onLoad({ filter: /\.vue$/ }, async (args) => {
        const { parse, compileScript } = await import('vue/compiler-sfc');
        const src = await readFile(args.path, 'utf8');
        const { descriptor } = parse(src, { filename: args.path });
        const script = compileScript(descriptor, { id: 'art', inlineTemplate: true });
        return { contents: script.content, loader: 'ts' };
      });
    },
  }],
});
await import(pathToFileURL(out).href);
try { unlinkSync(entry); } catch {}

const now = Date.now();
const mk = (kind, title, body, extra = {}) => ({
  id: 'ag_a7_x', handle: 'a7', type: 'artifact', created_by: 'dan-bot',
  updated_at: now - 90_000,
  props: { agent_kind: kind, title, body, author_kind: 'agent', ...extra },
});

const CASES = [
  ['diff', mk('diff', 'auth.ts — reject expired sessions',
    'diff --git a/auth.ts\n@@ -14,6 +14,9 @@\n+  if (expired) return null;\n-  return session;'),
    ['auth.ts', 'expired', 'a7']],
  ['doc', mk('doc', 'API surface review', 'The public surface is 41 routes.'),
    ['API surface review', '41 routes']],
  ['image', mk('image', 'login screen v2', 'https://example.test/shot.png'),
    ['<img', 'shot.png']],
  ['data', mk('data', 'failing tests',
    JSON.stringify([{ module: 'auth', failing: 12 }, { module: 'canvas', failing: 3 }])),
    ['module', 'auth', '12']],
  ['link', mk('link', 'the deploy', 'https://lobby.dimedata.cloud/board'),
    ['lobby.dimedata.cloud']],
  ['note', mk('note', 'a thought', 'we should cache this'), ['we should cache this']],
  ['revision', mk('diff', 'auth.ts (v2)', '+ fixed', { supersedes: 'a4' }), ['revises #a4']],
  ['superseded', mk('diff', 'auth.ts', '+ old', { superseded_by: 'a9' }),
    ['superseded by #a9', 'stale']],
  ['author+time', mk('doc', 'x', 'y'), ['dan-bot', 'm ago']],
];

let fails = 0;
for (const [name, obj, expects] of CASES) {
  let text;
  try {
    text = (await globalThis.__render(obj, false)).replace(/\s+/g, ' ');
  } catch (e) {
    console.log(`  FAIL  ${name.padEnd(12)} threw: ${e.message}`);
    fails++;
    continue;
  }
  const missing = expects.filter((e) => !text.includes(e));
  const ok = missing.length === 0;
  if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(12)} ${ok ? text.slice(0, 74) : 'missing: ' + missing.join(', ')}`);
}

// The exact regression this file exists to catch.
const plain = (await globalThis.__render(mk('diff', 'a title', 'a body'), false))
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const regressed = plain === 'artifact' || !plain.includes('a title');
console.log(`  ${regressed ? 'FAIL' : 'PASS'}  ${'regression'.padEnd(12)} a bot-posted artifact shows its content, not the word "artifact"`);
if (regressed) fails++;

// Kinds with their own renderer must not ALSO fall through to the plain-text
// body. A stray v-if between v-else-if branches once started a second chain
// whose v-else printed every diff, image and table twice, and every check above
// still passed, because `includes` cannot see a duplicate.
for (const [name, obj] of CASES.filter(([n]) => ['diff', 'image', 'data', 'link'].includes(n))) {
  const html = await globalThis.__render(obj, false);
  const doubled = /class="text"/.test(html);
  console.log(`  ${doubled ? 'FAIL' : 'PASS'}  ${('once:' + name).padEnd(12)} body rendered by its own renderer only`);
  if (doubled) fails++;
}

try { unlinkSync(out); } catch {}
console.log(fails === 0 ? '\nPASS — every artifact kind renders' : `\nFAIL — ${fails} case(s)`);
process.exit(fails === 0 ? 0 : 1);
