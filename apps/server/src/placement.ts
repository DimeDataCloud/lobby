// Auto-placement: turning an incoming event into an object on the board.
//
// This happens SERVER-side on purpose. If each connected client created the
// object for an arriving event, every client would create its own copy of the
// same artifact — a race with as many duplicates as there are viewers. One
// writer, one object, everybody sees the same board.
//
// Layout is lane-per-author, which is what makes parallel work *read* as
// parallel: your agent's output flows down one column, mine down the next.
// Lanes are only an initial position — anyone can drag anything anywhere, and
// the stored x/y wins from then on.

import type { Database } from 'bun:sqlite';
import type { AgentEvent } from './types';
import { upsertObject, type CanvasObject } from './canvas';
import { nextHandle } from './agent';

const CARD_W = 340;
const CARD_H = 190;
const GAP_X = 40;
const GAP_Y = 28;
const LANE_W = CARD_W + GAP_X;

// ---------------------------------------------------------------------------
// What earns a card
//
// ONE RULE: a card is earned by producing something that still exists when the
// agent stops. An action is not an artifact; its result may be.
//
// The board is read by other people and other people's agents. It is not an
// activity log — the activity rail is, and every event still goes there. So the
// question for each event is not "did something happen" but "would a teammate
// coming back tomorrow need to see this".
//
// What qualifies, and it maps to how people actually describe their work:
//
//   code              a file was written or edited
//   file              something was created, exported or saved
//   data              a dataset, table or export exists now
//   research          a finished piece of research, not the searches behind it
//   information       a written document, report or finding
//   image / video     a generated or captured asset
//   visual            a design, render, diagram or screenshot
//   physical change   a deploy, a release, a migration, a push — the world moved
//
// What does NOT, however interesting it was at the time:
//
//   - Shell commands. Running `ls`, `grep`, `curl`, `npm test` or `cd` is an
//     action. A hundred of them is not a hundred artifacts, and burying three
//     real diffs under them is how a board becomes something nobody reads. The
//     narrow exception is below, and it is about publishing, not running.
//   - Prompts and conversation. What somebody typed belongs in the chat rail.
//   - Reads and searches. Looking at something produces nothing.
//   - Lifecycle. A subagent starting, a turn ending, a context compaction —
//     status, not output. The rail shows it.
//
// An agent that believes something deserves the board can always say so
// explicitly with `lobby_post`. That is the deliberate escape hatch: judgement
// beats a keyword list, and the agent has the context this classifier does not.
// ---------------------------------------------------------------------------

/**
 * Events where the producer has already declared it made something. These are
 * self-describing: an agent does not emit `image_generated` unless an image
 * exists.
 */
const ARTIFACT_EVENTS = new Set([
  // image / video / visual
  'image_generated', 'video_generated', 'screenshot_captured',
  'design_published', 'diagram_created', 'render_complete',
  // research / information
  'research_complete', 'report_generated', 'analysis_complete', 'document_created',
  // data
  'data_exported', 'dataset_created', 'query_complete',
  // code / file
  'code_fixed', 'file_created', 'artifact_created',
  // physical changes — the world outside the session moved
  'website_deployed', 'deploy_complete', 'release_published', 'migration_applied',
]);

/**
 * Tools that change a file. This is "code" and "file" in the list above, and it
 * is the single largest source of genuinely useful cards: a teammate wants to
 * see what changed in the repo.
 */
const FILE_CHANGING_TOOLS = new Set([
  'write', 'write_file', 'create_file',
  'edit', 'multiedit', 'notebookedit', 'notebook_edit',
  'patch', 'apply_patch',
]);

const SHELL_TOOLS = new Set(['bash', 'shell', 'terminal', 'run', 'execute_command']);

/**
 * Shell commands that PUBLISH rather than merely run.
 *
 * Shell is excluded wholesale — it was the flood — but a deploy, a release or a
 * push is exactly the "physical change" a teammate needs to know about, and
 * losing those to a blanket rule would be its own failure. Matched on what the
 * command *does*, never on the tool being bash.
 *
 * Deliberately narrow. `npm run build` is not here: a build is an intermediate,
 * and the deploy that follows is the thing that changed the world. When in
 * doubt it is left off, because a missing card is a smaller problem than a board
 * nobody trusts.
 */
const PUBLISHING_COMMANDS: RegExp[] = [
  /\bgit\s+push\b/,
  /\bgit\s+tag\b/,
  /\bgh\s+release\s+create\b/,
  /\bnpm\s+publish\b/,
  /\byarn\s+publish\b/,
  /\bpnpm\s+publish\b/,
  /\bcargo\s+publish\b/,
  /\btwine\s+upload\b/,
  /\bdocker\s+push\b/,
  // `docker compose up`, and the -f/-p flag forms that carry a VALUE between the
  // subcommand and `up` (`docker-compose -f /opt/app/compose.yml up -d`).
  /\bdocker[\s-]compose\b[^\n]*?\bup\b/,
  /\bkubectl\s+apply\b/,
  /\bhelm\s+(?:install|upgrade)\b/,
  /\bterraform\s+apply\b/,
  /\b(?:vercel|netlify|wrangler|fly|flyctl|eb|serverless)\s+deploy\b/,
  /\bprisma\s+migrate\s+deploy\b/,
  /\balembic\s+upgrade\b/,
  /\b(?:rails|artisan)\s+db:migrate\b/,
];

/** Read the command out of whichever shape the producer used. */
function commandOf(payload: any): string {
  return String(
    payload?.command ??
    payload?.tool_input?.command ??
    payload?.input?.command ??
    ''
  );
}

/**
 * Commands that only TALK about publishing.
 *
 * `grep -rn "git push" docs/` and `cat scripts/deploy.sh` contain the words but
 * change nothing — they are reads, and promoting them puts a card on the board
 * that claims a deploy happened when it did not. Which is worse than missing a
 * card: it is a card that lies.
 *
 * Two ways they give themselves away, and both are checked because either alone
 * lets something through:
 *
 *   - the command STARTS with a reading tool, whatever it goes on to mention
 *   - the publishing phrase appears inside quotes, i.e. as an argument rather
 *     than as the thing being run
 */
const READING_COMMANDS =
  /^\s*(?:sudo\s+)?(?:grep|rg|ag|cat|less|more|head|tail|ls|find|echo|printf|awk|sed|diff|wc|file|stat|which|type|man|git\s+log|git\s+show|git\s+diff|git\s+status)\b/;

function onlyMentionsPublishing(cmd: string): boolean {
  if (READING_COMMANDS.test(cmd)) return true;
  // Strip quoted sections; if no publishing phrase survives, every match was an
  // argument to something else.
  const unquoted = cmd.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  return !PUBLISHING_COMMANDS.some((re) => re.test(unquoted));
}

export function isBoardWorthy(event: AgentEvent): boolean {
  if (ARTIFACT_EVENTS.has(event.event_type)) return true;

  if (event.event_type === 'tool_call' || event.event_type === 'tool_result') {
    const tool = String(event.payload?.tool_name || '').toLowerCase();
    if (FILE_CHANGING_TOOLS.has(tool)) return true;

    // Shell: only if the command published something.
    if (SHELL_TOOLS.has(tool)) {
      const cmd = commandOf(event.payload);
      if (!cmd) return false;
      // A failed publish did not change anything, so it is not an artifact —
      // it is an incident, and the rail carries it.
      if (event.payload?.ok === false) return false;
      if (!PUBLISHING_COMMANDS.some((re) => re.test(cmd))) return false;
      return !onlyMentionsPublishing(cmd);
    }
  }

  return false;
}

/** Which column this author owns, allocating a new one on first sight. */
function laneFor(db: Database, lobbyId: string, author: string): number {
  const mine = db.prepare(`
    SELECT json_extract(props, '$.lane') AS lane
    FROM canvas_objects
    WHERE lobby_id = ? AND type = 'artifact' AND created_by = ?
    LIMIT 1
  `).get(lobbyId, author) as any;
  if (mine && mine.lane !== null && mine.lane !== undefined) return Number(mine.lane);

  const max = db.prepare(`
    SELECT MAX(CAST(json_extract(props, '$.lane') AS INTEGER)) AS m
    FROM canvas_objects
    WHERE lobby_id = ? AND type = 'artifact'
  `).get(lobbyId) as any;
  return max && max.m !== null && max.m !== undefined ? Number(max.m) + 1 : 0;
}

/** Next free slot down that column. */
function depthOfLane(db: Database, lobbyId: string, lane: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS c
    FROM canvas_objects
    WHERE lobby_id = ? AND type = 'artifact'
      AND CAST(json_extract(props, '$.lane') AS INTEGER) = ?
  `).get(lobbyId, lane) as any;
  return row ? Number(row.c) : 0;
}

// ---------------------------------------------------------------------------
// Describing the card
//
// An event-derived card needs a `kind`, a `title` and a `handle` for the same
// reason a posted one does: the agent surface is the product. Without a handle
// the brief query skips the row entirely, so a teammate's agent reads "board —
// empty" while five cards sit on the canvas. Without a title it renders as
// "(untitled)".
//
// The vocabulary is the one people use for their own work — code, file, data,
// research, image, visual, deploy — not the producer's internal event names.
// ---------------------------------------------------------------------------

const KIND_BY_EVENT: Record<string, string> = {
  image_generated: 'image', video_generated: 'video', screenshot_captured: 'image',
  design_published: 'visual', diagram_created: 'visual', render_complete: 'visual',
  research_complete: 'research', report_generated: 'doc',
  analysis_complete: 'research', document_created: 'doc',
  data_exported: 'data', dataset_created: 'data', query_complete: 'data',
  code_fixed: 'diff', file_created: 'file', artifact_created: 'note',
  website_deployed: 'deploy', deploy_complete: 'deploy',
  release_published: 'deploy', migration_applied: 'deploy',
};

/** The file this event touched, whichever shape the producer used. */
function pathOf(payload: any): string {
  return String(
    payload?.file_path ?? payload?.path ??
    payload?.tool_input?.file_path ?? payload?.tool_input?.path ??
    payload?.input?.file_path ?? ''
  );
}

function describe(event: AgentEvent): { kind: string; title: string } {
  const payload: any = event.payload || {};

  const declared = KIND_BY_EVENT[event.event_type];
  if (declared) {
    // The producer said what it made; prefer whatever it called it.
    const title =
      payload.title || payload.name || payload.summary || event.summary ||
      event.event_type.replace(/_/g, ' ');
    return { kind: declared, title: String(title).slice(0, 200) };
  }

  const tool = String(payload.tool_name || '').toLowerCase();

  if (FILE_CHANGING_TOOLS.has(tool)) {
    const path = pathOf(payload);
    const created = tool.includes('write') || tool.includes('create');
    return {
      // A written file is a file; an edit to one is a change to code.
      kind: created ? 'file' : 'diff',
      title: path ? `${created ? 'Wrote' : 'Edited'} ${path}` : (event.summary || `${tool} change`),
    };
  }

  if (SHELL_TOOLS.has(tool)) {
    const cmd = commandOf(payload).trim();
    // The command IS the description here — "git push origin master" tells a
    // teammate everything. Truncated, because some deploy invocations are long.
    return { kind: 'deploy', title: cmd.slice(0, 200) };
  }

  return { kind: 'note', title: event.summary || event.event_type.replace(/_/g, ' ') };
}

/**
 * Create the board object for an event. Returns null when the event does not
 * deserve a card, or when it already has one.
 */
export function placeArtifact(
  db: Database,
  event: AgentEvent
): CanvasObject | null {
  if (!event.lobby_id || event.id == null) return null;
  if (!isBoardWorthy(event)) return null;

  // Idempotent: replaying or double-delivering an event must not stack two
  // cards on top of each other.
  const existing = db.prepare(
    `SELECT id FROM canvas_objects WHERE lobby_id = ? AND event_id = ? LIMIT 1`
  ).get(event.lobby_id, event.id) as any;
  if (existing) return null;

  const author = event.user_id || event.agent_id || 'unknown';
  const lane = laneFor(db, event.lobby_id, author);
  const depth = depthOfLane(db, event.lobby_id, lane);
  const { kind, title } = describe(event);

  const result = upsertObject(
    db,
    event.lobby_id,
    {
      id: `ev-${event.id}`,
      type: 'artifact',
      event_id: event.id,
      x: lane * LANE_W,
      y: depth * (CARD_H + GAP_Y),
      w: CARD_W,
      h: CARD_H,
      z: 0,
      props: {
        lane,
        author,
        source: event.source,
        agent_kind: kind,
        title,
        // Marks this as derived from an event rather than posted deliberately.
        // The client uses it to render from the event; an agent reading the
        // brief sees the same kind and title either way.
        from_event: true,
      },
    },
    author
  );

  if (!result.accepted || !result.object) return null;

  // The handle is assigned after the upsert, exactly as postArtifact does it,
  // because upsertObject's shape does not carry one.
  //
  // This is what makes the card readable by an AGENT. The brief query filters on
  // `handle IS NOT NULL`, so before this every event-derived card was invisible
  // to every teammate's bot — a board showing five artifacts answered "board —
  // empty" when the other side's Claude asked what was on it.
  db.prepare('UPDATE canvas_objects SET handle = ? WHERE lobby_id = ? AND id = ?')
    .run(nextHandle(db, event.lobby_id), event.lobby_id, result.object.id);

  return result.object;
}
