// What earns a card on the board.
//
// This is a PRODUCT rule, not an implementation detail, which is why it gets its
// own test file: the board is what teammates and their agents read, and its value
// is entirely a function of what is kept off it. A board showing every `ls` is one
// nobody looks at, and then the artifacts on it may as well not be there.
//
// The rule under test: a card is earned by producing something that still exists
// when the agent stops. An action is not an artifact; its result may be.
//
//   bun test

import { describe, it, expect } from 'bun:test';
import { isBoardWorthy } from '../src/placement';
import type { AgentEvent } from '../src/types';

const ev = (over: Partial<AgentEvent>): AgentEvent => ({
  source: 'claude-code',
  agent_id: 'a1',
  event_type: 'tool_call',
  session_id: 's1',
  payload: {},
  timestamp: Date.now(),
  ...over,
} as AgentEvent);

const tool = (name: string, payload: Record<string, any> = {}) =>
  ev({ event_type: 'tool_result', payload: { tool_name: name, ...payload } });

const shell = (command: string, extra: Record<string, any> = {}) =>
  tool('Bash', { tool_input: { command }, ...extra });

describe('things a teammate needs to see', () => {
  it('keeps a file that was written', () => {
    expect(isBoardWorthy(tool('Write', { tool_input: { file_path: 'src/api.ts' } }))).toBe(true);
  });

  it('keeps a file that was edited', () => {
    expect(isBoardWorthy(tool('Edit'))).toBe(true);
    expect(isBoardWorthy(tool('MultiEdit'))).toBe(true);
    expect(isBoardWorthy(tool('NotebookEdit'))).toBe(true);
  });

  it('keeps generated images, video and other visuals', () => {
    for (const t of ['image_generated', 'video_generated', 'screenshot_captured',
                     'design_published', 'diagram_created', 'render_complete']) {
      expect(isBoardWorthy(ev({ event_type: t }))).toBe(true);
    }
  });

  it('keeps finished research, reports and analysis', () => {
    for (const t of ['research_complete', 'report_generated', 'analysis_complete',
                     'document_created']) {
      expect(isBoardWorthy(ev({ event_type: t }))).toBe(true);
    }
  });

  it('keeps data that now exists', () => {
    for (const t of ['data_exported', 'dataset_created', 'query_complete']) {
      expect(isBoardWorthy(ev({ event_type: t }))).toBe(true);
    }
  });

  it('keeps changes to the world outside the session', () => {
    for (const t of ['website_deployed', 'deploy_complete', 'release_published',
                     'migration_applied']) {
      expect(isBoardWorthy(ev({ event_type: t }))).toBe(true);
    }
  });
});

describe('the noise that used to bury it', () => {
  // Every shell tool was previously auto-promoted, so a session doing ordinary
  // work buried its own three real diffs under a hundred command cards.
  it('drops ordinary shell commands', () => {
    for (const c of [
      'ls -la', 'cd apps/server', 'cat package.json', 'grep -rn foo src/',
      'curl -s https://example.com', 'npm test', 'npm run build', 'echo hi',
      'mkdir -p dist', 'rm -rf node_modules', 'git status', 'git diff',
      'bun test', 'node ops/test-all.mjs', 'pwd', 'which node',
    ]) {
      expect(isBoardWorthy(shell(c))).toBe(false);
    }
  });

  it('drops prompts and anything else a person typed', () => {
    expect(isBoardWorthy(ev({ event_type: 'user_prompt', payload: { prompt: 'fix the bug' } }))).toBe(false);
  });

  it('drops reading and searching, which produce nothing', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS']) {
      expect(isBoardWorthy(tool(t))).toBe(false);
    }
  });

  it('drops lifecycle status', () => {
    for (const t of ['session_start', 'session_end', 'turn_start', 'turn_end',
                     'subagent_start', 'subagent_stop', 'delegation_start',
                     'delegation_complete', 'compression', 'notification']) {
      expect(isBoardWorthy(ev({ event_type: t }))).toBe(false);
    }
  });

  it('drops a bare error — it is a status, and the rail carries it', () => {
    expect(isBoardWorthy(ev({ event_type: 'error' }))).toBe(false);
  });
});

describe('shell that publishes is a physical change, and stays', () => {
  it('keeps pushes, releases and publishes', () => {
    for (const c of [
      'git push origin master',
      'git push -u origin feature/x',
      'git tag v1.2.0',
      'gh release create v1.2.0 --notes "..."',
      'npm publish --access public',
      'cargo publish',
      'twine upload dist/*',
      'docker push registry.example.com/app:latest',
    ]) {
      expect(isBoardWorthy(shell(c))).toBe(true);
    }
  });

  it('keeps deploys and migrations', () => {
    for (const c of [
      'docker compose up -d --build',
      'docker-compose -f /opt/lobby/docker-compose.yml up -d',
      'kubectl apply -f k8s/',
      'helm upgrade lobby ./chart',
      'terraform apply -auto-approve',
      'vercel deploy --prod',
      'wrangler deploy',
      'fly deploy',
      'prisma migrate deploy',
      'alembic upgrade head',
    ]) {
      expect(isBoardWorthy(shell(c))).toBe(true);
    }
  });

  it('does NOT keep a publish that failed — nothing changed', () => {
    expect(isBoardWorthy(shell('git push origin master', { ok: false }))).toBe(false);
    expect(isBoardWorthy(shell('vercel deploy --prod', { ok: false }))).toBe(false);
  });

  it('is not fooled by a publishing word inside an ordinary command', () => {
    // The point of matching the command rather than the tool: these mention
    // deploys and pushes without doing either.
    for (const c of [
      'grep -rn "git push" docs/',
      'cat scripts/deploy.sh',
      'echo "remember to npm publish"',
      'ls dist/deploy',
      'git log --grep="docker push"',
    ]) {
      expect(isBoardWorthy(shell(c))).toBe(false);
    }
  });

  it('reads the command from whichever shape the producer used', () => {
    // Claude Code nests it under tool_input; other producers put it top-level.
    expect(isBoardWorthy(tool('Bash', { command: 'git push origin main' }))).toBe(true);
    expect(isBoardWorthy(tool('Bash', { input: { command: 'terraform apply' } }))).toBe(true);
  });

  it('drops shell with no command at all rather than guessing', () => {
    expect(isBoardWorthy(tool('Bash'))).toBe(false);
  });
});

describe('the ratio, on a realistic session', () => {
  it('a working session yields a readable board, not a log', () => {
    // Roughly what an hour of real work emits: mostly looking and running,
    // occasionally producing. Before this rule every Bash line was a card.
    const session: AgentEvent[] = [
      ev({ event_type: 'session_start' }),
      ev({ event_type: 'user_prompt', payload: { prompt: 'add retention' } }),
      tool('Read'), tool('Grep'), tool('Glob'), tool('Read'),
      shell('ls apps/server/src'), shell('cat package.json'), shell('grep -rn prune src/'),
      tool('Write', { tool_input: { file_path: 'src/retention.ts' } }),   // card
      shell('bun test'), shell('npm run build'), shell('node ops/test-all.mjs'),
      tool('Edit', { tool_input: { file_path: 'src/index.ts' } }),        // card
      shell('git status'), shell('git diff'), shell('git add -A'),
      shell('git commit -m "feat: retention"'),
      shell('git push origin master'),                                    // card
      ev({ event_type: 'turn_end' }),
      ev({ event_type: 'session_end' }),
    ];

    const cards = session.filter(isBoardWorthy);
    expect(cards.length).toBe(3);
    // The board holds the two file changes and the push. Everything else
    // happened, is in the activity rail, and is not an artifact.
    expect(session.length - cards.length).toBe(18);
  });
});
