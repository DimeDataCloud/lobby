export interface AgentEvent {
  id?: number
  source: string
  agent_id: string
  parent_agent_id?: string
  event_type: string
  session_id: string
  model?: string
  provider?: string
  user_id?: string
  workspace_id?: string
  lobby_id?: string
  payload: Record<string, any>
  summary?: string
  timestamp: number
  humanInTheLoop?: any
  humanInTheLoopStatus?: any
}

export interface FilterOptions {
  sources: string[]
  agent_ids: string[]
  event_types: string[]
  models: string[]
  providers: string[]
  session_ids: string[]
  user_ids: string[]
  workspace_ids: string[]
  lobby_ids: string[]
}