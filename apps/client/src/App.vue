<template>
  <div class="app" @keydown="onKeydown">
    <!-- Header bar -->
    <header class="header">
      <div class="header-left">
        <div class="logo-group">
          <span class="logo-icon">◆</span>
          <span class="logo-text">Agent Observability</span>
          <span class="version-badge">v1.0</span>
        </div>
        <span class="conn-status" :class="{ online: connected }">
          <span class="status-dot"></span>
          {{ connected ? 'Live' : 'Disconnected' }}
        </span>
        <div class="view-toggle">
          <button class="view-btn" :class="{ active: viewMode === 'timeline' }" @click="viewMode = 'timeline'" title="Timeline view (Ctrl+1)">
            <span class="view-btn-icon">☰</span> Timeline
            <kbd>⌘1</kbd>
          </button>
          <button class="view-btn" :class="{ active: viewMode === 'canvas' }" @click="viewMode = 'canvas'" title="Canvas view (Ctrl+2)">
            <span class="view-btn-icon">◈</span> Canvas
            <kbd>⌘2</kbd>
          </button>
          <button class="view-btn" :class="{ active: showAgents }" @click="showAgents = !showAgents" title="Agent registry (Ctrl+3)">
            <span class="view-btn-icon">👥</span> Agents
          </button>
          <button class="view-btn" :class="{ active: showCollaborators }" @click="showCollaborators = !showCollaborators">
            <span class="view-btn-icon">🧑</span> Collab
          </button>
          <button class="view-btn" :class="{ active: showSwitcher }" @click="showSwitcher = !showSwitcher">
            <span class="view-btn-icon">🔄</span> Models
          </button>
          <button class="view-btn" :class="{ active: showPresence }" @click="showPresence = !showPresence" title="Online users">
            <span class="view-btn-icon">👥</span> Users
            <span v-if="onlineUsers.length > 0" class="view-btn-badge">{{ onlineUsers.length }}</span>
          </button>
          <button class="view-btn" :class="{ active: showActivityFeed }" @click="showActivityFeed = !showActivityFeed" title="Live activity feed">
            <span class="view-btn-icon">📡</span> Live
            <span class="view-btn-pulse" :class="{ active: connected }"></span>
          </button>
        </div>
      </div>
      <div class="header-right">
        <div class="header-stats">
          <div class="stat-item" title="Filtered events">
            <span class="stat-value">{{ filteredEvents.length }}</span>
            <span class="stat-label">events</span>
          </div>
          <div class="stat-item" title="Active sources">
            <span class="stat-value">{{ activeSources }}</span>
            <span class="stat-label">sources</span>
          </div>
          <div class="stat-item" title="Active agents">
            <span class="stat-value">{{ activeAgents }}</span>
            <span class="stat-label">agents</span>
          </div>
          <div class="stat-item" title="Active users">
            <span class="stat-value">{{ activeUsers }}</span>
            <span class="stat-label">users</span>
          </div>
        </div>
        <button class="header-action-btn" @click="showFilters = !showFilters" :class="{ active: showFilters }" title="Toggle filters (Ctrl+F)">
          <span>🔍</span>
          <span v-if="activeFilterCount > 0" class="filter-count">{{ activeFilterCount }}</span>
        </button>
        <button class="header-action-btn" @click="showShortcuts = true" title="Keyboard shortcuts (?)">
          <span>⌨</span>
        </button>
      </div>
    </header>

    <!-- Lobby bar -->
    <transition name="slide-down">
      <div class="lobby-bar" v-if="lobby">
        <div class="lobby-info">
          <span class="lobby-icon">🏠</span>
          <span class="lobby-name">{{ lobby.name }}</span>
          <span class="lobby-vis-badge" :class="lobby.visibility">{{ lobby.visibility }}</span>
          <span class="lobby-code" @click="copyLobbyCode" :title="'Click to copy: ' + lobby.code">
            {{ lobby.code }}
            <span class="copy-hint">📋</span>
          </span>
        </div>
        <div class="lobby-actions">
          <span class="lobby-members">
            <span class="member-dots">
              <span v-for="i in Math.min(lobby.members?.length || 0, 5)" :key="i" class="member-dot" :style="{ background: memberColors[i-1] }"></span>
            </span>
            {{ lobby.members?.length || 0 }} members
          </span>
          <button class="lobby-btn invite" @click="copyInviteLink">📋 Copy Invite</button>
          <button class="lobby-btn leave" @click="leaveLobby">Leave</button>
        </div>
      </div>
    </transition>

    <!-- Filter panel -->
    <transition name="slide-down">
      <div class="filters" v-if="showFilters">
        <div class="filter-group">
          <label>Source</label>
          <select v-model="filters.source" class="filter-select">
            <option value="">All</option>
            <option v-for="s in filterOptions.sources" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
        <div class="filter-group">
          <label>Model</label>
          <select v-model="filters.model" class="filter-select">
            <option value="">All</option>
            <option v-for="m in filterOptions.models" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <div class="filter-group">
          <label>Provider</label>
          <select v-model="filters.provider" class="filter-select">
            <option value="">All</option>
            <option v-for="p in filterOptions.providers" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <div class="filter-group">
          <label>Event Type</label>
          <select v-model="filters.eventType" class="filter-select">
            <option value="">All</option>
            <option v-for="e in filterOptions.event_types" :key="e" :value="e">{{ e }}</option>
          </select>
        </div>
        <div class="filter-group">
          <label>Agent</label>
          <select v-model="filters.agentId" class="filter-select">
            <option value="">All</option>
            <option v-for="a in filterOptions.agent_ids" :key="a" :value="a">{{ shortId(a) }}</option>
          </select>
        </div>
        <div class="filter-group">
          <label>User</label>
          <select v-model="filters.userId" class="filter-select">
            <option value="">All</option>
            <option v-for="u in filterOptions.user_ids" :key="u" :value="u">{{ u }}</option>
          </select>
        </div>
        <div class="filter-group">
          <label>Workspace</label>
          <select v-model="filters.workspaceId" class="filter-select">
            <option value="">All</option>
            <option v-for="w in filterOptions.workspace_ids" :key="w" :value="w">{{ w }}</option>
          </select>
        </div>
        <div class="filter-group">
          <label>Lobby</label>
          <select v-model="filters.lobbyId" class="filter-select">
            <option value="">All</option>
            <option v-for="l in filterOptions.lobby_ids" :key="l" :value="l">🏠 {{ l }}</option>
          </select>
        </div>
        <div class="filter-actions">
          <button class="btn-clear" @click="clearFilters" v-if="hasFilters">Clear All</button>
          <button class="btn-save" @click="showFilters = false">Done</button>
        </div>
      </div>
    </transition>

    <!-- Main content area -->
    <div class="main-content">
      <!-- Timeline view -->
      <div v-show="viewMode === 'timeline'" class="timeline" ref="timelineEl">
        <div v-if="filteredEvents.length === 0 && events.length === 0" class="empty-state-hero">
          <div class="empty-icon">📡</div>
          <h2>Waiting for events</h2>
          <p>Start a producer or send test events to populate the dashboard.</p>
          <div class="empty-actions">
            <button class="empty-cta" @click="sendTestEvent">🚀 Send Test Event</button>
            <button class="empty-cta secondary" @click="showLobbyCreate = true">🏠 Create Lobby</button>
          </div>
        </div>
        <div v-else-if="filteredEvents.length === 0" class="empty-state-hero">
          <div class="empty-icon">🔍</div>
          <h2>No matching events</h2>
          <p>Try adjusting your filters or clearing them.</p>
          <button class="empty-cta" @click="clearFilters">Clear Filters</button>
        </div>
        <div v-else class="timeline-list">
          <div
            v-for="event in filteredEvents"
            :key="event.id || event.timestamp"
            class="timeline-item"
          >
            <EventCard
              :event="event"
              @click="selectEvent"
              @expand="selectEvent"
            />
          </div>
        </div>
      </div>

      <!-- Canvas view -->
      <AgentCanvas
        v-show="viewMode === 'canvas'"
        :events="filteredEvents"
        :saved-positions="savedPositions"
        :user-id="myUserId"
        @selectEvent="selectEvent"
        @nodeMoved="onNodeMoved"
      />
    </div>

    <!-- Event detail modal -->
    <transition name="fade">
      <div v-if="selectedEvent" class="modal-overlay" @click.self="closeModal" @keydown.escape="closeModal">
        <div class="modal" ref="modalEl">
          <div class="modal-header">
            <div class="modal-title">
              <span class="modal-emoji">{{ getEventEmoji(selectedEvent.event_type) }}</span>
              <span class="modal-type">{{ formatEventType(selectedEvent.event_type) }}</span>
              <span class="modal-source" :style="{ color: getSourceColor(selectedEvent.source) }">{{ selectedEvent.source }}</span>
            </div>
            <div class="modal-header-actions">
              <button class="modal-action-btn" @click="copyEventPayload" title="Copy payload">📋</button>
              <button class="modal-action-btn" @click="closeModal" title="Close (Esc)">×</button>
            </div>
          </div>
          <div class="modal-body">
            <div class="detail-grid">
              <div class="detail-row"><span class="detail-label">Source</span><span class="detail-value">{{ selectedEvent.source }}</span></div>
              <div class="detail-row"><span class="detail-label">Agent ID</span><span class="detail-value mono">{{ selectedEvent.agent_id }}</span></div>
              <div class="detail-row" v-if="selectedEvent.parent_agent_id"><span class="detail-label">Parent</span><span class="detail-value mono">{{ selectedEvent.parent_agent_id }}</span></div>
              <div class="detail-row"><span class="detail-label">Session</span><span class="detail-value mono">{{ selectedEvent.session_id }}</span></div>
              <div class="detail-row" v-if="selectedEvent.model"><span class="detail-label">Model</span><span class="detail-value">{{ selectedEvent.model }}</span></div>
              <div class="detail-row" v-if="selectedEvent.provider"><span class="detail-label">Provider</span><span class="detail-value">{{ selectedEvent.provider }}</span></div>
              <div class="detail-row" v-if="selectedEvent.user_id"><span class="detail-label">User</span><span class="detail-value">{{ selectedEvent.user_id }}</span></div>
              <div class="detail-row" v-if="selectedEvent.workspace_id"><span class="detail-label">Workspace</span><span class="detail-value">{{ selectedEvent.workspace_id }}</span></div>
              <div class="detail-row" v-if="selectedEvent.lobby_id"><span class="detail-label">Lobby</span><span class="detail-value accent">{{ selectedEvent.lobby_id }}</span></div>
              <div class="detail-row"><span class="detail-label">Timestamp</span><span class="detail-value mono">{{ new Date(selectedEvent.timestamp).toISOString() }}</span></div>
              <div class="detail-row" v-if="selectedEvent.summary"><span class="detail-label">Summary</span><span class="detail-value">{{ selectedEvent.summary }}</span></div>
            </div>
            <div class="detail-payload">
              <div class="detail-payload-header">
                <span class="detail-label">Payload</span>
                <button class="modal-action-btn small" @click="copyEventPayload">Copy</button>
              </div>
              <pre><code>{{ JSON.stringify(selectedEvent.payload, null, 2) }}</code></pre>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- Agent sidebar -->
    <transition name="slide-right">
      <div class="agent-sidebar" v-if="showAgents">
        <div class="sidebar-header">
          <span>Agents ({{ agents.length }})</span>
          <button class="sidebar-close" @click="showAgents = false">×</button>
        </div>
        <div class="agent-list">
          <div
            v-for="agent in agents"
            :key="agent.agent_id"
            class="agent-card"
            :style="{ borderColor: getSourceColor(agent.source) }"
            @click="filters.agentId = agent.agent_id; showAgents = false"
          >
            <div class="agent-card-status" :class="{ active: agent.status === 'active' }"></div>
            <div class="agent-card-name">{{ shortId(agent.agent_id) }}</div>
            <div class="agent-card-source" :style="{ color: getSourceColor(agent.source) }">{{ agent.source }}</div>
            <div class="agent-card-meta">
              <span v-if="agent.model">{{ agent.model }}</span>
              <span class="agent-events">{{ agent.event_count }} evts</span>
            </div>
            <div class="agent-card-sub" v-if="agent.user_id">{{ agent.user_id }}</div>
          </div>
          <div v-if="agents.length === 0" class="sidebar-empty">No agents registered yet.</div>
        </div>
      </div>
    </transition>

    <!-- Collaborator sidebar -->
    <CollaboratorPanel
      :agents="agents"
      :show="showCollaborators"
      @close="showCollaborators = false"
      @filterUser="(uid: string) => { filters.userId = uid; showCollaborators = false }"
    />

    <!-- Model switcher sidebar -->
    <ModelSwitcher
      :events="filteredEvents"
      :current-model="currentModel"
      :current-provider="currentProvider"
      :show="showSwitcher"
      @close="showSwitcher = false"
      @switch="(m: { model: string; provider: string }) => { filters.model = m.model; filters.provider = m.provider; showSwitcher = false }"
    />

    <!-- Presence panel -->
    <PresencePanel
      :show="showPresence"
      :users="onlineUsers"
      :my-user-id="myUserId"
      @close="showPresence = false"
    />

    <!-- Activity feed -->
    <ActivityFeed
      :show="showActivityFeed"
      :events="recentActivityEvents"
      :is-streaming="connected"
      @close="showActivityFeed = false"
      @selectEvent="selectEvent"
    />

    <!-- Annotation panel -->
    <AnnotationPanel
      :show="showAnnotations"
      :annotations="currentAnnotations"
      :event-id="selectedEvent?.id || null"
      :lobby-id="lobby?.code || null"
      :user-id="myUserId"
      @close="showAnnotations = false"
      @addAnnotation="onAddAnnotation"
    />

    <!-- Lobby create modal -->
    <transition name="fade">
      <div v-if="showLobbyCreate" class="modal-overlay" @click.self="showLobbyCreate = false">
        <div class="modal modal-sm">
          <div class="modal-header">
            <span>🏠 Create Lobby</span>
            <button class="modal-close" @click="showLobbyCreate = false">×</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>Lobby Name</label>
              <input v-model="lobbyNameInput" class="form-input" placeholder="e.g. Project Phoenix" @keydown.enter="createLobby" />
            </div>
            <div class="form-group">
              <label>Visibility</label>
              <select v-model="lobbyVisInput" class="form-input">
                <option value="private">Private (invite only)</option>
                <option value="unlisted">Unlisted (anyone with link)</option>
                <option value="public">Public (listed)</option>
              </select>
            </div>
            <button class="form-submit" @click="createLobby" :disabled="!lobbyNameInput.trim()">Create & Join</button>
          </div>
        </div>
      </div>
    </transition>

    <!-- Keyboard shortcuts modal -->
    <transition name="fade">
      <div v-if="showShortcuts" class="modal-overlay" @click.self="showShortcuts = false">
        <div class="modal modal-sm">
          <div class="modal-header">
            <span>⌨ Keyboard Shortcuts</span>
            <button class="modal-close" @click="showShortcuts = false">×</button>
          </div>
          <div class="modal-body">
            <div class="shortcut-list">
              <div class="shortcut-row"><kbd>Ctrl+1</kbd><span>Timeline view</span></div>
              <div class="shortcut-row"><kbd>Ctrl+2</kbd><span>Canvas view</span></div>
              <div class="shortcut-row"><kbd>Ctrl+3</kbd><span>Agent registry</span></div>
              <div class="shortcut-row"><kbd>Ctrl+F</kbd><span>Toggle filters</span></div>
              <div class="shortcut-row"><kbd>Ctrl+K</kbd><span>Join lobby</span></div>
              <div class="shortcut-row"><kbd>Ctrl+N</kbd><span>New lobby</span></div>
              <div class="shortcut-row"><kbd>Esc</kbd><span>Close modal / sidebar</span></div>
              <div class="shortcut-row"><kbd>?</kbd><span>Show shortcuts</span></div>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- Toast notifications -->
    <div class="toast-container">
      <transition-group name="toast">
        <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.type">
          <span class="toast-icon">{{ toast.icon }}</span>
          <span class="toast-message">{{ toast.message }}</span>
        </div>
      </transition-group>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import type { AgentEvent, FilterOptions } from './types'
import { useWebSocket } from './composables/useWebSocket'
import type { AgentRecord } from './composables/useWebSocket'
import { getSourceColor, getEventEmoji, formatTime, shortId, truncate } from './composables/useEventColors'
import AgentCanvas from './components/AgentCanvas.vue'
import CollaboratorPanel from './components/CollaboratorPanel.vue'
import ModelSwitcher from './components/ModelSwitcher.vue'
import EventCard from './components/EventCard.vue'
import PresencePanel from './components/PresencePanel.vue'
import ActivityFeed from './components/ActivityFeed.vue'
import AnnotationPanel from './components/AnnotationPanel.vue'

const { events, agents, connected } = useWebSocket()

// View state
const viewMode = ref<'timeline' | 'canvas'>('timeline')
const showAgents = ref(false)
const showCollaborators = ref(false)
const showSwitcher = ref(false)
const showFilters = ref(true)
const showShortcuts = ref(false)
const showPresence = ref(false)
const showActivityFeed = ref(false)
const showAnnotations = ref(false)

// Lobby state
const lobby = ref<any>(null)
const showLobbyCreate = ref(false)
const lobbyNameInput = ref('')
const lobbyVisInput = ref('private')

// Toast notifications
interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'info'
  icon: string
}
const toasts = ref<Toast[]>([])
let toastId = 0

function addToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' }
  const toast: Toast = { id: ++toastId, message, type, icon: icons[type] }
  toasts.value.push(toast)
  setTimeout(() => {
    toasts.value = toasts.value.filter(t => t.id !== toast.id)
  }, 3000)
}

// Member dot colors
const memberColors = ['#f97316', '#a78bfa', '#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6']

// Multiplayer state
const myUserId = ref('user-' + Math.random().toString(36).slice(2, 8))
const myDisplayName = ref('User-' + myUserId.value.slice(-4))
const onlineUsers = ref<any[]>([])
const recentActivityEvents = ref<AgentEvent[]>([])
const currentAnnotations = ref<any[]>([])
const savedPositions = ref<Record<string, { x: number; y: number }>>({})
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

// Register presence
async function registerPresence() {
  try {
    await fetch('/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: myUserId.value,
        display_name: myDisplayName.value,
        color: memberColors[Math.floor(Math.random() * memberColors.length)],
        online: true,
        current_lobby: lobby.value?.code || null,
        current_view: viewMode.value,
      })
    })
  } catch { /* silent */ }
}

// Heartbeat
function startHeartbeat() {
  heartbeatTimer = setInterval(async () => {
    try {
      await fetch('/presence/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: myUserId.value })
      })
    } catch { /* silent */ }
  }, 15000)
}

// Load online users
async function loadOnlineUsers() {
  try {
    const res = await fetch('/presence')
    if (res.ok) onlineUsers.value = await res.json()
  } catch { /* silent */ }
}

// Load saved canvas positions
async function loadCanvasPositions() {
  try {
    const res = await fetch('/canvas/positions')
    if (res.ok) {
      const positions = await res.json()
      const map: Record<string, { x: number; y: number }> = {}
      for (const p of positions) {
        map[p.agent_id] = { x: p.x, y: p.y }
      }
      savedPositions.value = map
    }
  } catch { /* silent */ }
}

// Load annotations for selected event
async function loadAnnotations(eventId: number) {
  try {
    const res = await fetch(`/annotations/${eventId}`)
    if (res.ok) currentAnnotations.value = await res.json()
  } catch { currentAnnotations.value = [] }
}

// Add annotation
async function onAddAnnotation(data: { event_id: number; user_id: string; text: string; lobby_id?: string }) {
  try {
    const res = await fetch('/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    if (res.ok) {
      const ann = await res.json()
      currentAnnotations.value.push(ann)
      addToast('Comment added', 'success')
    }
  } catch { addToast('Failed to add comment', 'error') }
}

// Canvas node moved
async function onNodeMoved(data: { agent_id: string; x: number; y: number; updated_by: string }) {
  try {
    await fetch('/canvas/position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
  } catch { /* silent */ }
}

// Track recent activity (last 50 events for feed)
watch(() => events.value.length, () => {
  recentActivityEvents.value = events.value.slice(-50).reverse()
})

// Auto-join lobby from URL hash
async function autoJoinLobby() {
  const hash = window.location.hash
  const match = hash.match(/lobby=([A-Z0-9]+)/i)
  if (match) await joinLobby(match[1])
}

async function createLobby() {
  if (!lobbyNameInput.value.trim()) return
  try {
    const res = await fetch('/lobbies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: lobbyNameInput.value.trim(), visibility: lobbyVisInput.value, created_by: 'dashboard' })
    })
    if (res.ok) {
      const data = await res.json()
      lobby.value = data
      showLobbyCreate.value = false
      lobbyNameInput.value = ''
      addToast(`Lobby "${data.name}" created`, 'success')
    }
  } catch (e) { addToast('Failed to create lobby', 'error') }
}

async function joinLobby(code: string) {
  try {
    const res = await fetch(`/lobbies/${code.toUpperCase()}`)
    if (!res.ok) { addToast('Lobby not found', 'error'); return }
    lobby.value = await res.json()
    addToast(`Joined lobby: ${lobby.value.name}`, 'success')
  } catch (e) { addToast('Failed to join lobby', 'error') }
}

async function leaveLobby() {
  const name = lobby.value?.name
  lobby.value = null
  window.location.hash = ''
  if (name) addToast(`Left lobby: ${name}`, 'info')
}

function copyLobbyCode() {
  if (!lobby.value?.code) return
  navigator.clipboard.writeText(lobby.value.code)
  addToast('Code copied: ' + lobby.value.code, 'success')
}

function copyInviteLink() {
  if (!lobby.value?.code) return
  const link = `${window.location.origin}${window.location.pathname}#lobby=${lobby.value.code}`
  navigator.clipboard.writeText(link)
  addToast('Invite link copied', 'success')
}

function showJoinLobby() {
  const code = prompt('Enter lobby invite code:')
  if (code) joinLobby(code.trim())
}

// Current model
const currentModel = computed(() => {
  for (let i = events.value.length - 1; i >= 0; i--) {
    if (events.value[i].model) return events.value[i].model
  }
  return ''
})
const currentProvider = computed(() => {
  for (let i = events.value.length - 1; i >= 0; i--) {
    if (events.value[i].provider) return events.value[i].provider
  }
  return ''
})

// Filters
const filterOptions = ref<FilterOptions>({
  sources: [], agent_ids: [], event_types: [], models: [], providers: [],
  session_ids: [], user_ids: [], workspace_ids: [], lobby_ids: []
})

const filters = ref({
  source: '', model: '', provider: '', eventType: '', agentId: '', userId: '', workspaceId: '', lobbyId: ''
})

const selectedEvent = ref<AgentEvent | null>(null)
const timelineEl = ref<HTMLElement | null>(null)
const modalEl = ref<HTMLElement | null>(null)
const autoScroll = ref(true)

const hasFilters = computed(() =>
  filters.value.source || filters.value.model || filters.value.provider ||
  filters.value.eventType || filters.value.agentId || filters.value.userId ||
  filters.value.workspaceId || filters.value.lobbyId
)

const activeFilterCount = computed(() => {
  let count = 0
  if (filters.value.source) count++
  if (filters.value.model) count++
  if (filters.value.provider) count++
  if (filters.value.eventType) count++
  if (filters.value.agentId) count++
  if (filters.value.userId) count++
  if (filters.value.workspaceId) count++
  if (filters.value.lobbyId) count++
  return count
})

const filteredEvents = computed(() => {
  return events.value.filter(e => {
    if (filters.value.source && e.source !== filters.value.source) return false
    if (filters.value.model && e.model !== filters.value.model) return false
    if (filters.value.provider && e.provider !== filters.value.provider) return false
    if (filters.value.eventType && e.event_type !== filters.value.eventType) return false
    if (filters.value.agentId && e.agent_id !== filters.value.agentId) return false
    if (filters.value.userId && e.user_id !== filters.value.userId) return false
    if (filters.value.workspaceId && e.workspace_id !== filters.value.workspaceId) return false
    if (filters.value.lobbyId && e.lobby_id !== filters.value.lobbyId) return false
    return true
  })
})

const activeSources = computed(() => new Set(filteredEvents.value.map(e => e.source)).size)
const activeAgents = computed(() => new Set(filteredEvents.value.map(e => e.agent_id)).size)
const activeUsers = computed(() => new Set(filteredEvents.value.map(e => e.user_id).filter(Boolean)).size)

function selectEvent(event: AgentEvent) {
  selectedEvent.value = event
  if (event.id) {
    loadAnnotations(event.id)
    showAnnotations.value = true
  }
}

function closeModal() {
  selectedEvent.value = null
}

function copyEventPayload() {
  if (!selectedEvent.value) return
  navigator.clipboard.writeText(JSON.stringify(selectedEvent.value.payload, null, 2))
  addToast('Payload copied to clipboard', 'success')
}

function formatEventType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}

function clearFilters() {
  filters.value = { source: '', model: '', provider: '', eventType: '', agentId: '', userId: '', workspaceId: '', lobbyId: '' }
}

async function loadFilterOptions() {
  try {
    const res = await fetch('/events/filter-options')
    if (res.ok) filterOptions.value = await res.json()
  } catch (e) { /* silent */ }
}

function sendTestEvent() {
  fetch('/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'browser',
      agent_id: 'test-' + Date.now(),
      event_type: 'user_prompt',
      session_id: 'test-session',
      user_id: 'dashboard',
      payload: { prompt: 'Hello from the dashboard! This is a test event.' },
      summary: 'Test event from dashboard',
      timestamp: Date.now()
    })
  }).then(() => addToast('Test event sent', 'success'))
    .catch(() => addToast('Failed to send test event', 'error'))
}

// Keyboard shortcuts
function onKeydown(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

  if (e.ctrlKey || e.metaKey) {
    switch (e.key) {
      case '1': e.preventDefault(); viewMode.value = 'timeline'; break
      case '2': e.preventDefault(); viewMode.value = 'canvas'; break
      case '3': e.preventDefault(); showAgents.value = !showAgents.value; break
      case 'f': e.preventDefault(); showFilters.value = !showFilters.value; break
      case 'k': e.preventDefault(); showJoinLobby(); break
      case 'n': e.preventDefault(); showLobbyCreate.value = true; break
    }
  }

  if (e.key === 'Escape') {
    if (selectedEvent.value) { closeModal(); return }
    if (showAgents.value) { showAgents.value = false; return }
    if (showCollaborators.value) { showCollaborators.value = false; return }
    if (showSwitcher.value) { showSwitcher.value = false; return }
    if (showShortcuts.value) { showShortcuts.value = false; return }
    if (showLobbyCreate.value) { showLobbyCreate.value = false; return }
  }

  if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
    showShortcuts.value = !showShortcuts.value
  }
}

onMounted(() => {
  loadFilterOptions()
  autoJoinLobby()
  loadOnlineUsers()
  loadCanvasPositions()
  registerPresence()
  startHeartbeat()
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
})

watch(() => events.value.length, async () => {
  if (viewMode.value === 'timeline' && autoScroll.value && timelineEl.value) {
    await nextTick()
    timelineEl.value.scrollTop = timelineEl.value.scrollHeight
  }
  if (events.value.length % 20 === 0) loadFilterOptions()
})
</script>

<style scoped>
/* ===== APP LAYOUT ===== */
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #0a0a0c;
  color: #e0e0e6;
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Inter', system-ui, monospace;
}

/* ===== HEADER ===== */
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 16px;
  height: 44px;
  background: #0d0d10;
  border-bottom: 1px solid #1e1e24;
  z-index: 30;
  flex-shrink: 0;
}
.header-left { display: flex; align-items: center; gap: 16px; }
.header-right { display: flex; align-items: center; gap: 8px; }

.logo-group {
  display: flex;
  align-items: center;
  gap: 8px;
}
.logo-icon {
  font-size: 16px;
  color: #f97316;
  font-weight: 700;
}
.logo-text {
  font-size: 13px;
  font-weight: 700;
  color: #f0f0f5;
  letter-spacing: -0.3px;
}
.version-badge {
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 3px;
  background: #f9731618;
  color: #f97316;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.conn-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #555;
  font-weight: 500;
}
.conn-status.online { color: #10b981; }
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #555;
}
.conn-status.online .status-dot {
  background: #10b981;
  box-shadow: 0 0 6px #10b98166;
}

/* View toggle */
.view-toggle {
  display: flex;
  gap: 2px;
  background: #111114;
  border-radius: 6px;
  padding: 2px;
}
.view-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  color: #777;
  border: none;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
  white-space: nowrap;
}
.view-btn:hover { color: #ccc; background: #1a1a20; }
.view-btn.active {
  background: #1e1e26;
  color: #f0f0f5;
  box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}
.view-btn kbd {
  font-size: 9px;
  color: #555;
  margin-left: 2px;
  font-family: inherit;
}
.view-btn-icon { font-size: 12px; }
.view-btn-badge {
  background: #f97316;
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}
.view-btn-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #555;
  transition: all 0.3s;
}
.view-btn-pulse.active {
  background: #10b981;
  box-shadow: 0 0 6px #10b98166;
  animation: pulse-dot 1.5s ease-in-out infinite;
}
@keyframes pulse-dot {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.8); opacity: 0.4; }
}

/* Header stats */
.header-stats {
  display: flex;
  gap: 2px;
  background: #111114;
  border-radius: 6px;
  padding: 2px;
}
.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2px 10px;
  border-radius: 4px;
  cursor: default;
}
.stat-item:hover { background: #1a1a20; }
.stat-value {
  font-size: 13px;
  font-weight: 700;
  color: #e0e0e6;
  line-height: 1.2;
}
.stat-label {
  font-size: 8px;
  color: #555;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.header-action-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #111114;
  color: #888;
  border: 1px solid #1e1e24;
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
  position: relative;
}
.header-action-btn:hover { color: #ccc; border-color: #333; }
.header-action-btn.active { border-color: #f9731666; color: #f97316; }
.filter-count {
  position: absolute;
  top: -4px;
  right: -4px;
  background: #f97316;
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}

/* ===== LOBBY BAR ===== */
.lobby-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 16px;
  height: 36px;
  background: #0d0d10;
  border-bottom: 1px solid #1e1e24;
  font-size: 12px;
  flex-shrink: 0;
}
.lobby-info {
  display: flex;
  align-items: center;
  gap: 8px;
}
.lobby-icon { font-size: 14px; }
.lobby-name { font-weight: 700; color: #f0f0f5; }
.lobby-vis-badge {
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.lobby-vis-badge.private { background: #ef444418; color: #ef4444; }
.lobby-vis-badge.unlisted { background: #f59e0b18; color: #f59e0b; }
.lobby-vis-badge.public { background: #10b98118; color: #10b981; }
.lobby-code {
  font-family: 'JetBrains Mono', monospace;
  color: #f97316;
  font-weight: 700;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
  background: #f9731608;
  transition: background 0.15s;
}
.lobby-code:hover { background: #f9731618; }
.copy-hint { font-size: 9px; opacity: 0; transition: opacity 0.15s; }
.lobby-code:hover .copy-hint { opacity: 1; }

.lobby-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.lobby-members {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #666;
  font-size: 11px;
}
.member-dots {
  display: flex;
  gap: -4px;
}
.member-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid #0d0d10;
  margin-left: -2px;
}
.member-dot:first-child { margin-left: 0; }
.lobby-btn {
  background: #1a1a20;
  color: #888;
  border: 1px solid #2a2a30;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 10px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.lobby-btn:hover { color: #ccc; border-color: #444; }
.lobby-btn.invite:hover { border-color: #f9731666; color: #f97316; }
.lobby-btn.leave:hover { border-color: #ef444466; color: #ef4444; }

/* ===== FILTERS ===== */
.filters {
  display: flex;
  gap: 10px;
  padding: 8px 16px;
  background: #0d0d10;
  border-bottom: 1px solid #1e1e24;
  flex-wrap: wrap;
  align-items: flex-end;
  flex-shrink: 0;
}
.filter-group { display: flex; flex-direction: column; gap: 3px; }
.filter-group label {
  font-size: 9px;
  color: #555;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  font-weight: 600;
}
.filter-select {
  background: #111114;
  color: #e0e0e6;
  border: 1px solid #1e1e24;
  border-radius: 5px;
  padding: 5px 8px;
  font-size: 11px;
  font-family: inherit;
  outline: none;
  min-width: 100px;
  cursor: pointer;
  transition: border-color 0.15s;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%23555'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  padding-right: 24px;
}
.filter-select:hover { border-color: #333; }
.filter-select:focus { border-color: #f97316; box-shadow: 0 0 0 2px #f9731618; }

.filter-actions {
  display: flex;
  gap: 6px;
  align-items: flex-end;
  margin-left: auto;
}
.btn-clear {
  background: transparent;
  color: #ef4444;
  border: 1px solid #ef444433;
  border-radius: 5px;
  padding: 5px 12px;
  font-size: 10px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.btn-clear:hover { background: #ef444412; }
.btn-save {
  background: #f97316;
  color: #fff;
  border: none;
  border-radius: 5px;
  padding: 5px 14px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.btn-save:hover { background: #e8650a; }

/* ===== MAIN CONTENT ===== */
.main-content {
  flex: 1;
  overflow: hidden;
  position: relative;
}

/* ===== TIMELINE ===== */
.timeline {
  height: 100%;
  overflow-y: auto;
  background: #0a0a0c;
}
.timeline-list {
  padding: 8px 16px;
  max-width: 900px;
  margin: 0 auto;
}
.timeline-item {
  margin-bottom: 6px;
}

/* ===== EMPTY STATES ===== */
.empty-state-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  padding: 40px;
}
.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.5;
}
.empty-state-hero h2 {
  font-size: 18px;
  font-weight: 600;
  color: #888;
  margin-bottom: 8px;
}
.empty-state-hero p {
  font-size: 13px;
  color: #555;
  margin-bottom: 24px;
  max-width: 400px;
  line-height: 1.5;
}
.empty-actions {
  display: flex;
  gap: 8px;
}
.empty-cta {
  background: #f97316;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 20px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.empty-cta:hover { background: #e8650a; transform: translateY(-1px); }
.empty-cta.secondary {
  background: #1a1a20;
  color: #888;
  border: 1px solid #2a2a30;
}
.empty-cta.secondary:hover { color: #ccc; border-color: #444; }

/* ===== MODAL ===== */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.75);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: #111114;
  border: 1px solid #2a2a30;
  border-radius: 12px;
  width: 90%;
  max-width: 700px;
  max-height: 85vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0,0,0,0.5);
}
.modal-sm { max-width: 420px; }
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid #1e1e24;
  font-weight: 600;
  font-size: 13px;
  flex-shrink: 0;
}
.modal-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.modal-emoji { font-size: 16px; }
.modal-type { color: #e0e0e6; }
.modal-source {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 3px;
  background: #1a1a20;
}
.modal-header-actions {
  display: flex;
  gap: 4px;
}
.modal-action-btn {
  background: #1a1a20;
  color: #888;
  border: 1px solid #2a2a30;
  border-radius: 5px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.modal-action-btn:hover { color: #ccc; border-color: #444; }
.modal-action-btn.small { font-size: 10px; padding: 3px 8px; }
.modal-close {
  background: none;
  border: none;
  color: #666;
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
}
.modal-close:hover { color: #fff; }
.modal-body {
  padding: 18px;
  overflow-y: auto;
  flex: 1;
}

.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 16px;
}
.detail-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.detail-label {
  color: #555;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.detail-value {
  font-size: 12px;
  color: #ccc;
}
.detail-value.mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #888;
}
.detail-value.accent { color: #f97316; font-weight: 600; }

.detail-payload {
  border-top: 1px solid #1e1e24;
  padding-top: 12px;
}
.detail-payload-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.detail-payload pre {
  background: #0a0a0c;
  padding: 12px;
  border-radius: 6px;
  border: 1px solid #1e1e24;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #888;
  white-space: pre-wrap;
  max-height: 300px;
  overflow-y: auto;
  line-height: 1.5;
}

/* ===== FORMS ===== */
.form-group {
  margin-bottom: 14px;
}
.form-group label {
  display: block;
  font-size: 10px;
  color: #666;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}
.form-input {
  width: 100%;
  background: #0a0a0c;
  color: #e0e0e6;
  border: 1px solid #1e1e24;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}
.form-input:focus { border-color: #f97316; box-shadow: 0 0 0 2px #f9731618; }
.form-submit {
  width: 100%;
  background: #f97316;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
  margin-top: 4px;
}
.form-submit:hover { background: #e8650a; }
.form-submit:disabled { opacity: 0.4; cursor: not-allowed; }

/* ===== SHORTCUTS ===== */
.shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.shortcut-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
  font-size: 12px;
  color: #888;
}
.shortcut-row kbd {
  background: #1a1a20;
  color: #ccc;
  border: 1px solid #2a2a30;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 10px;
  font-family: inherit;
  min-width: 50px;
  text-align: center;
}

/* ===== TOASTS ===== */
.toast-container {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.toast {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #1a1a20;
  border: 1px solid #2a2a30;
  border-radius: 8px;
  padding: 10px 16px;
  font-size: 12px;
  color: #ccc;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  min-width: 250px;
}
.toast.success { border-color: #10b98133; }
.toast.error { border-color: #ef444433; }
.toast-icon { font-size: 14px; }
.toast-message { flex: 1; }

/* ===== AGENT SIDEBAR ===== */
.agent-sidebar {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 300px;
  background: #0d0d10;
  border-left: 1px solid #1e1e24;
  z-index: 50;
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 20px rgba(0,0,0,0.3);
}
.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #1e1e24;
  font-size: 13px;
  font-weight: 600;
  color: #e0e0e6;
  flex-shrink: 0;
}
.sidebar-close {
  background: none;
  border: none;
  color: #666;
  font-size: 18px;
  cursor: pointer;
}
.sidebar-close:hover { color: #fff; }
.agent-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.agent-card {
  position: relative;
  padding: 10px 12px;
  margin-bottom: 6px;
  background: #111114;
  border: 1px solid #1e1e24;
  border-left: 3px solid #333;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}
.agent-card:hover { background: #16161c; border-color: #2a2a30; }
.agent-card-status {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #333;
}
.agent-card-status.active {
  background: #10b981;
  box-shadow: 0 0 8px #10b98166;
}
.agent-card-name {
  font-size: 12px;
  font-weight: 600;
  color: #e0e0e6;
  font-family: 'JetBrains Mono', monospace;
}
.agent-card-source {
  font-size: 10px;
  font-weight: 600;
  margin-top: 2px;
}
.agent-card-meta {
  display: flex;
  gap: 8px;
  margin-top: 4px;
  font-size: 10px;
  color: #666;
}
.agent-card-sub {
  font-size: 10px;
  color: #c79559;
  margin-top: 2px;
}
.agent-events { color: #555; }
.sidebar-empty {
  text-align: center;
  padding: 40px 20px;
  color: #555;
  font-size: 12px;
}

/* ===== TRANSITIONS ===== */
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from, .fade-leave-to { opacity: 0; }

.slide-down-enter-active, .slide-down-leave-active {
  transition: all 0.2s ease;
}
.slide-down-enter-from, .slide-down-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.slide-right-enter-active, .slide-right-leave-active {
  transition: all 0.25s ease;
}
.slide-right-enter-from, .slide-right-leave-to {
  transform: translateX(100%);
}

.toast-enter-active {
  transition: all 0.3s ease;
}
.toast-leave-active {
  transition: all 0.2s ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(40px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(40px);
}

/* ===== SCROLLBAR ===== */
.timeline::-webkit-scrollbar,
.agent-list::-webkit-scrollbar,
.modal-body::-webkit-scrollbar {
  width: 6px;
}
.timeline::-webkit-scrollbar-track,
.agent-list::-webkit-scrollbar-track,
.modal-body::-webkit-scrollbar-track {
  background: transparent;
}
.timeline::-webkit-scrollbar-thumb,
.agent-list::-webkit-scrollbar-thumb,
.modal-body::-webkit-scrollbar-thumb {
  background: #1e1e24;
  border-radius: 3px;
}
.timeline::-webkit-scrollbar-thumb:hover,
.agent-list::-webkit-scrollbar-thumb:hover,
.modal-body::-webkit-scrollbar-thumb:hover {
  background: #2a2a30;
}
</style>
