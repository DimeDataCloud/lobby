// Colour, emoji and formatting shared by every view.
//
// ONE hash lives here. There were previously two — `avatarColor` in
// CollaboratorPanel and `colorFor` in BoardView — with different constants and
// different HSL, while BoardView's comment claimed it used "the same hash the
// collaborator panel already uses". The same person came out two colours
// depending on which panel you looked at.

/** Stable hue in [0,360) for any string. The one hash. */
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/**
 * Participant colour — humans and bots alike. `lightness` exists because avatar
 * chips carry white text and need a darker fill than a cursor or a selection halo.
 */
export function colorFor(id: string, lightness = 60): string {
  return `hsl(${hashHue(id)} 70% ${lightness}%)`;
}

/** Avatar fill: same hue as the cursor, dark enough for white text on top. */
export function avatarColor(id: string): string {
  return `hsl(${hashHue(id)} 55% 35%)`;
}

// Well-known agent systems get a fixed colour so they stay recognisable across
// rooms. Anything else — and "anything else" is the point, since teams bring
// their own bots — gets a stable colour from the same hash rather than being
// lumped into one shared "unknown" swatch.
const PINNED_SOURCES: Record<string, string> = {
  'claude-code': '#a78bfa', // purple
  codex: '#10b981',         // green
  opencode: '#3b82f6',      // blue
  browser: '#94a3b8',       // slate — a human acting directly, not an agent
};

export function getSourceColor(source: string): string {
  return PINNED_SOURCES[source] || colorFor(source || 'unknown', 55);
}

// Event type emojis
const EVENT_EMOJIS: Record<string, string> = {
  session_start: '🚀',
  session_end: '🏁',
  turn_start: '▶️',
  turn_end: '🛑',
  tool_call: '🔧',
  tool_result: '✅',
  tool_failure: '❌',
  permission_request: '🔐',
  notification: '🔔',
  subagent_start: '🟢',
  subagent_stop: '👥',
  delegation_start: '📤',
  delegation_complete: '📦',
  compression: '🗜️',
  user_prompt: '💬',
  api_call: '⚡',
  model_switch: '🔄',
  error: '💥',
};

export function getEventEmoji(eventType: string): string {
  return EVENT_EMOJIS[eventType] || '📋';
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function shortId(id: string): string {
  return id.substring(0, 8);
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.substring(0, max) + '...';
}
