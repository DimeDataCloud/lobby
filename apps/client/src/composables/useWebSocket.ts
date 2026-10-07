import { ref, onMounted, onUnmounted } from 'vue'
import type { AgentEvent } from '../types'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const WS_BASE = import.meta.env.VITE_WS_BASE || `ws://${window.location.hostname}:4000`

export interface AgentRecord {
  agent_id: string
  source: string
  model?: string
  provider?: string
  user_id?: string
  workspace_id?: string
  parent_agent_id?: string
  status: string
  last_event_type?: string
  last_event_at?: number
  first_seen_at: number
  event_count: number
}

export function useWebSocket() {
  const events = ref<AgentEvent[]>([])
  const agents = ref<AgentRecord[]>([])
  const connected = ref(false)
  let ws: WebSocket | null = null
  let reconnectTimer: number | null = null

  function connect() {
    ws = new WebSocket(`${WS_BASE}/stream`)

    ws.onopen = () => {
      connected.value = true
      console.log('[ws] connected')
    }

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data)
        if (data.type === 'initial') {
          events.value = data.data
        } else if (data.type === 'event') {
          events.value.push(data.data)
          if (events.value.length > 1000) {
            events.value = events.value.slice(-1000)
          }
        } else if (data.type === 'batch') {
          events.value.push(...data.data)
          if (events.value.length > 1000) {
            events.value = events.value.slice(-1000)
          }
        } else if (data.type === 'agents') {
          agents.value = data.data
        } else if (data.type === 'agent_update') {
          const idx = agents.value.findIndex(a => a.agent_id === data.data.agent_id)
          if (idx >= 0) {
            agents.value[idx] = data.data
          } else {
            agents.value.push(data.data)
          }
        }
      } catch (e) {
        console.error('[ws] parse error', e)
      }
    }

    ws.onclose = () => {
      connected.value = false
      console.log('[ws] disconnected, reconnecting in 3s')
      reconnectTimer = window.setTimeout(connect, 3000)
    }

    ws.onerror = (err) => {
      console.error('[ws] error', err)
    }
  }

  async function loadRecent() {
    try {
      // `credentials: 'include'` is required, not optional. /events/recent and
      // /agents were unauthenticated until 2026-08-11 — they are gated now — and
      // without the session cookie these two calls 401 for every signed-in user
      // while still "working" for nobody. This is the precise bug useLobby.ts's
      // req() helper warns about: "a call site that forgets credentials: 'include'
      // works fine for the first and 404s for the second."
      const res = await fetch(`${API_BASE}/events/recent?limit=300`, { credentials: 'include' })
      if (res.ok) {
        events.value = await res.json()
      }
      const agentRes = await fetch(`${API_BASE}/agents`, { credentials: 'include' })
      if (agentRes.ok) {
        agents.value = await agentRes.json()
      }
    } catch (e) {
      console.error('Failed to load recent events', e)
    }
  }

  onMounted(() => {
    loadRecent()
    connect()
  })

  onUnmounted(() => {
    if (ws) ws.close()
    if (reconnectTimer) clearTimeout(reconnectTimer)
  })

  return { events, agents, connected }
}