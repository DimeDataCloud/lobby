// The event schema every agent system reports against.
//
// `source` is deliberately an open string, not an enum. Teams bring their own
// bots, so a source this codebase has never heard of must work on arrival — it
// gets a stable colour from the hash in useEventColors and renders like any other.

export interface AgentEvent {
  id?: number;
  source: string;          // "claude-code" | "codex" | "opencode" | any agent system
  agent_id: string;         // session_id or delegation_id — unique agent instance
  parent_agent_id?: string; // for subagents: parent session
  event_type: string;       // "tool_call" | "tool_result" | "turn_end" | "delegation_start" | etc.
  session_id: string;        // logical session
  model?: string;            // "kimi-k3" | "claude-sonnet-4" | etc.
  provider?: string;         // "ollama" | "anthropic" | "openai" | etc.
  user_id?: string;          // which user owns this agent (multi-tenant)
  workspace_id?: string;     // which workspace/project this agent runs in
  lobby_id?: string;          // which lobby this event belongs to (for lobby-scoped streaming)
  payload: Record<string, any>;
  summary?: string;
  timestamp: number;
  seq?: number;              // ordering authority — see schema.ts. Assigned on write.
  // Optional HITL
  humanInTheLoop?: HumanInTheLoop;
  humanInTheLoopStatus?: HumanInTheLoopStatus;
}

export interface HumanInTheLoop {
  question: string;
  responseWebSocketUrl: string;
  type: 'question' | 'permission' | 'choice';
  choices?: string[];
  timeout?: number;
  requiresResponse?: boolean;
}

export interface HumanInTheLoopResponse {
  response?: string;
  permission?: boolean;
  choice?: string;
  agentEvent: AgentEvent;
  respondedAt: number;
  respondedBy?: string;
}

export interface HumanInTheLoopStatus {
  status: 'pending' | 'responded' | 'timeout' | 'error';
  respondedAt?: number;
  response?: HumanInTheLoopResponse;
}

export interface FilterOptions {
  sources: string[];
  agent_ids: string[];
  event_types: string[];
  models: string[];
  providers: string[];
  session_ids: string[];
  user_ids: string[];
  workspace_ids: string[];
  lobby_ids: string[];
}

// --- Lobby types ---

export interface Lobby {
  id?: number;
  code: string;           // 6-char invite code, unique
  name: string;
  visibility: 'public' | 'unlisted' | 'private';
  created_by: string;    // user_id of creator
  created_at: number;
  members: LobbyMember[]; // populated on read
}

export interface LobbyMember {
  user_id: string;
  agent_id: string;
  source: string;
  joined_at: number;
}

// --- Presence types ---

export interface PresenceUser {
  user_id: string;
  display_name: string;
  color: string;
  online: boolean;
  last_seen: number;
  current_lobby?: string;
  current_view?: string;
  cursor_position?: { x: number; y: number };
}

// --- Annotation types ---

export interface Annotation {
  id?: number;
  event_id: number;
  user_id: string;
  text: string;
  timestamp: number;
  lobby_id?: string;
}

// --- Canvas sync types ---

export interface CanvasNodePosition {
  agent_id: string;
  x: number;
  y: number;
  updated_by: string;
  updated_at: number;
}