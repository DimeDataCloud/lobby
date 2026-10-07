// Agent lifecycle.
//
// Status used to be hardcoded 'active' on every write with nothing ever ageing
// an agent out, so /health's idle and stopped counts were structurally always
// zero. The work-in-flight lane reads from this, so a wrong status here shows
// up as a UI that claims everyone is busy forever.
//
//   bun test

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import {
  initDatabase, upsertAgent, getAgent, sweepAgentStatuses, statusForEvent,
  AGENT_STALE_MS, AGENT_STOPPED_MS,
} from '../src/db';
import type { AgentEvent } from '../src/types';

const dbPath = join(tmpdir(), `lobby-agents-${Date.now()}-${Math.floor(Math.random() * 1e9)}.db`);

beforeAll(() => initDatabase(dbPath));
afterAll(() => {
  for (const s of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + s, { force: true }); } catch {}
  }
});

function ev(over: Partial<AgentEvent>): AgentEvent {
  return {
    source: 'test', agent_id: 'a', event_type: 'tool_call', session_id: 's',
    payload: {}, timestamp: Date.now(), ...over,
  } as AgentEvent;
}

describe('statusForEvent', () => {
  it('treats turn-closing events as settled and everything else as working', () => {
    expect(statusForEvent('turn_end')).toBe('idle');
    expect(statusForEvent('session_end')).toBe('idle');
    expect(statusForEvent('subagent_stop')).toBe('idle');
    expect(statusForEvent('delegation_complete')).toBe('idle');

    expect(statusForEvent('tool_call')).toBe('active');
    expect(statusForEvent('user_prompt')).toBe('active');
    expect(statusForEvent('some_unknown_future_event')).toBe('active');
  });
});

describe('registration', () => {
  it('derives status on FIRST sight, not just on update', () => {
    // The regression: the INSERT branch hardcoded 'active', so an agent whose
    // first observed event was a turn_end registered as busy.
    upsertAgent(ev({ agent_id: 'fresh-idle', event_type: 'turn_end' }));
    expect(getAgent('fresh-idle')!.status).toBe('idle');

    upsertAgent(ev({ agent_id: 'fresh-active', event_type: 'tool_call' }));
    expect(getAgent('fresh-active')!.status).toBe('active');
  });

  it('flips status as work starts and finishes', () => {
    upsertAgent(ev({ agent_id: 'flip', event_type: 'tool_call' }));
    expect(getAgent('flip')!.status).toBe('active');

    upsertAgent(ev({ agent_id: 'flip', event_type: 'turn_end' }));
    expect(getAgent('flip')!.status).toBe('idle');

    upsertAgent(ev({ agent_id: 'flip', event_type: 'user_prompt' }));
    expect(getAgent('flip')!.status).toBe('active');
  });

  it('counts events and backfills fields it learns later', () => {
    upsertAgent(ev({ agent_id: 'learn', event_type: 'tool_call' }));
    upsertAgent(ev({ agent_id: 'learn', event_type: 'tool_call', model: 'claude-opus-5', provider: 'anthropic' }));
    const a = getAgent('learn')!;
    expect(a.event_count).toBe(2);
    expect(a.model).toBe('claude-opus-5');

    // A later event without model must not wipe what we already know.
    upsertAgent(ev({ agent_id: 'learn', event_type: 'tool_call' }));
    expect(getAgent('learn')!.model).toBe('claude-opus-5');
  });
});

describe('sweep', () => {
  it('ages silent agents to stale, then stopped', () => {
    const now = Date.now();
    upsertAgent(ev({ agent_id: 'quiet', event_type: 'tool_call', timestamp: now }));
    expect(getAgent('quiet')!.status).toBe('active');

    // Not silent long enough yet.
    sweepAgentStatuses(now + 1000);
    expect(getAgent('quiet')!.status).toBe('active');

    sweepAgentStatuses(now + AGENT_STALE_MS + 1000);
    expect(getAgent('quiet')!.status).toBe('stale');

    sweepAgentStatuses(now + AGENT_STOPPED_MS + 1000);
    expect(getAgent('quiet')!.status).toBe('stopped');
  });

  it('sends a long-silent agent straight to stopped in one sweep', () => {
    // An agent that crashed hours ago should not need two sweep ticks to
    // settle — otherwise a restarted server reports a wrong status for 30s.
    const now = Date.now();
    upsertAgent(ev({ agent_id: 'crashed', event_type: 'tool_call', timestamp: now }));
    sweepAgentStatuses(now + AGENT_STOPPED_MS + 1);
    expect(getAgent('crashed')!.status).toBe('stopped');
  });

  it('reports only agents whose status actually changed', () => {
    const now = Date.now();
    upsertAgent(ev({ agent_id: 'recent', event_type: 'tool_call', timestamp: now }));
    const changed = sweepAgentStatuses(now + 1000).map(a => a.agent_id);
    expect(changed).not.toContain('recent');

    const changed2 = sweepAgentStatuses(now + AGENT_STOPPED_MS + 1).map(a => a.agent_id);
    expect(changed2).toContain('recent');

    // Idempotent: a second identical sweep has nothing left to report.
    expect(sweepAgentStatuses(now + AGENT_STOPPED_MS + 2).map(a => a.agent_id)).not.toContain('recent');
  });

  it('revives a stopped agent when it speaks again', () => {
    const now = Date.now();
    upsertAgent(ev({ agent_id: 'revived', event_type: 'tool_call', timestamp: now }));
    sweepAgentStatuses(now + AGENT_STOPPED_MS + 1);
    expect(getAgent('revived')!.status).toBe('stopped');

    upsertAgent(ev({ agent_id: 'revived', event_type: 'tool_call', timestamp: Date.now() }));
    expect(getAgent('revived')!.status).toBe('active');
  });
});
