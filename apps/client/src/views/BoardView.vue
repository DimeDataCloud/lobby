<!--
  Canvas-primary layout.

  The board fills the screen and everything else is a rail. Timeline and the
  agent registry stop being peer tabs: the feed becomes a collapsible rail, and
  the registry becomes "work in flight" — which agent is doing what, right now.
-->
<template>
  <div class="board-view">
    <!-- top bar -->
    <header class="topbar">
      <div class="brand">◆ <span>Lobby</span></div>

      <div v-if="lobbyCode" class="lobby-chip">
        <span class="lobby-name">{{ lobbyName || lobbyCode }}</span>
        <button class="code" :title="copied ? 'Copied' : 'Copy invite code'" @click="copyCode">
          {{ lobbyCode }} <span class="copy-icon">{{ copied ? '✓' : '⧉' }}</span>
        </button>
      </div>

      <div class="avatars">
        <button
          v-for="p in roster"
          :key="p.user_id"
          class="avatar"
          :class="{ following: following === p.user_id, clickable: p.live && p.user_id !== userId }"
          :style="{ background: p.color, outlineColor: p.live ? p.color : 'transparent' }"
          :title="p.user_id === userId ? 'You'
            : p.live ? `${p.user_id} — click to follow their view`
            : p.user_id"
          @click="toggleFollow(p)"
        >{{ initials(p.user_id) }}</button>
      </div>

      <div class="spacer" />

      <div class="conn" :class="{ live: connected }">
        <span class="dot" /> {{ connected ? 'LIVE' : 'OFFLINE' }}
      </div>
      <button class="rail-toggle" @click="railOpen = !railOpen">{{ railOpen ? '▶' : '◀' }}</button>
    </header>

    <div class="body">
      <!-- the product -->
      <main class="canvas-host">
        <LobbyCanvas
          v-if="lobbyCode"
          ref="canvasEl"
          :objects="objects"
          :peers="peers"
          :events="events"
          :user-id="userId"
          :my-color="myColor"
          :annotations="annotationList"
          :following="following"
          @put="putObject"
          @remove="removeObject"
          @presence="onPresence"
          @select-event="selected = $event || null"
          @pin="pin"
          @resolve-pin="resolvePin"
          @delete-pin="deletePin"
          @stop-follow="following = null"
        />

        <!--
          A brand-new room is an empty canvas with no way to make anything
          happen — the room only fills up once somebody connects a bot, and
          nothing on screen says so. This is where a new team gives up, so it
          gets the whole canvas until the first artifact arrives.
        -->
        <div v-if="lobbyCode && isEmpty" class="onboard">
          <div class="onboard-card">
            <h2>Connect your first bot</h2>
            <p>
              Nothing is on this board yet. It fills up when an agent joins and
              starts producing work — Lobby runs no models of its own.
            </p>

            <ol>
              <li>
                Add the marketplace, once per machine — needs a local checkout
                of the (private) Lobby repo:
                <code class="cmd">claude plugin marketplace add ./.claude-plugin/marketplace.json</code>
              </li>
              <li>
                Install the plugin:
                <code class="cmd">claude plugin install lobby@lobby-marketplace</code>
              </li>
              <li>
                In the Claude Code session you want to share:
                <code class="cmd">/lobby:join {{ lobbyCode }}</code>
              </li>
            </ol>

            <div class="waiting">
              <span class="pulse" /> Waiting for the first artifact…
            </div>

            <p class="hand-off">
              Working with someone else? Send them the invite code
              <button class="code-inline" @click="copyCode">
                {{ lobbyCode }} <span>{{ copied ? '✓' : '⧉' }}</span>
              </button>
              — their bot posts to this same board.
            </p>

            <details class="no-plugin">
              <summary>Guest without repo access, or not using Claude Code?</summary>
              <p>
                The plugin needs a local checkout of the Lobby source, which is
                private. Any agent can connect without it — join over plain
                HTTP and it gets a token scoped to this one room:
              </p>
              <code class="cmd cmd-block">curl -sX POST {{ serverOrigin }}/lobbies/{{ lobbyCode }}/join \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"joe","agent_id":"joe-1","source":"external"}'</code>
              <p>
                That returns a <code>lby_…</code> token. Set it and the room
                code as env vars and the same HTTP surface (and MCP, for any
                MCP-capable client) works from there:
              </p>
              <code class="cmd cmd-block">export LOBBY_CODE={{ lobbyCode }}
export LOBBY_TOKEN=lby_...</code>
            </details>
          </div>
        </div>

        <div v-else-if="!lobbyCode" class="no-lobby">
          <template v-if="unknownCode">
            <h2>No workspace with that code</h2>
            <p>
              There's no workspace here matching
              <strong class="bad-code">{{ unknownCode }}</strong>. Invite codes are six
              characters and expire when the workspace is deleted — check it with
              whoever sent it, or try again below.
            </p>
          </template>
          <template v-else>
            <h2>No lobby open</h2>
            <p>Create a room, or join one with an invite code.</p>
          </template>
          <div class="no-lobby-actions">
            <input v-model="joinCode" placeholder="INVITE CODE" maxlength="6" @keyup.enter="joinLobby" />
            <button class="primary" @click="joinLobby">Join</button>
            <button @click="createLobby">New lobby</button>
          </div>
          <p v-if="err" class="err">{{ err }}</p>
        </div>
      </main>

      <!-- rail -->
      <aside v-if="railOpen && lobbyCode" class="rail">
        <section class="rail-section">
          <h3>Work in flight</h3>
          <div v-if="working.length === 0" class="muted">Nothing running.</div>
          <div v-for="a in working" :key="a.agent_id" class="agent-row">
            <span class="agent-dot" :class="a.status" />
            <div class="agent-main">
              <div class="agent-id">{{ a.user_id || a.agent_id.slice(0, 12) }}</div>
              <div class="agent-sub">{{ a.last_event_type || '—' }}</div>
            </div>
            <span class="agent-src" :style="{ color: sourceColor(a.source) }">{{ a.source }}</span>
          </div>
          <div v-if="collisions.length" class="collision">
            ⚠ {{ collisions.length }} file{{ collisions.length > 1 ? 's' : '' }} touched by more than one agent
          </div>
        </section>

        <section class="rail-section grow">
          <div class="rail-tabs">
            <button :class="{ active: railTab === 'chat' }" @click="railTab = 'chat'">
              Chat<span v-if="unread" class="badge">{{ unread }}</span>
            </button>
            <button :class="{ active: railTab === 'activity' }" @click="railTab = 'activity'">Activity</button>
            <button
              v-if="railTab === 'chat' && selectedObjectId && chatRefObject !== selectedObjectId"
              class="attach"
              title="Point the next message at the selected object"
              @click="chatRefObject = selectedObjectId"
            >◈ attach</button>
          </div>

          <ChatPanel
            v-if="railTab === 'chat'"
            :messages="messages"
            :user-id="userId"
            :ref-object-id="chatRefObject"
            @send="sendChat"
            @delete="deleteMessage"
            @focus-object="focusObject"
            @clear-ref="chatRefObject = null"
          />

          <div v-else class="feed" ref="feedEl">
            <div
              v-for="e in feed"
              :key="e.id"
              class="feed-row"
              :style="{ borderLeftColor: sourceColor(e.source) }"
              @click="selected = e"
            >
              <span class="feed-time">{{ formatTime(e.timestamp) }}</span>
              <span class="feed-icon">{{ getEventEmoji(e.event_type) }}</span>
              <span class="feed-text">{{ truncate(e.summary || e.event_type, 42) }}</span>
            </div>
          </div>
        </section>
      </aside>
    </div>

    <!-- detail -->
    <div v-if="selected" class="modal-backdrop" @click="selected = null">
      <div class="modal" @click.stop>
        <div class="modal-head">
          <strong>{{ selected.event_type }}</strong>
          <button @click="selected = null">✕</button>
        </div>
        <EventCard :event="selected" :expanded="true" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import LobbyCanvas from '../components/LobbyCanvas.vue'
import ChatPanel from '../components/ChatPanel.vue'
import EventCard from '../components/EventCard.vue'
import { useLobby } from '../composables/useLobby'
import { getSourceColor, getEventEmoji, formatTime, truncate, colorFor } from '../composables/useEventColors'
import { useAccount } from '../composables/useAccount'
import type { AgentEvent } from '../types'

const API_BASE = import.meta.env.VITE_API_BASE || ''
// Display-only, for the fallback curl snippet — same-origin unless VITE_API_BASE overrides it.
const serverOrigin = API_BASE || (typeof location !== 'undefined' ? location.origin : '')

// Identity comes from the session when there is one. Signed out — local dev, or
// a guest who was handed an invite code — it falls back to a locally generated
// name, which is how the product worked before accounts existed.
const { identity } = useAccount()
const userId = computed(() => identity.value.id)

const lobbyCode = ref<string | null>(new URLSearchParams(location.hash.slice(1)).get('lobby'))

// A member token is per room. Signed-in members of the owning org do not need
// one — the session cookie authorizes them — but a guest with an invite link
// does, and so does a bot.
const token = ref<string | undefined>(
  (lobbyCode.value && localStorage.getItem(`lobby.token.${lobbyCode.value}`)) || undefined
)
const lobbyName = ref<string | null>(null)
const joinCode = ref('')
const err = ref<string | null>(null)
// A code that came from the URL and turned out not to exist. Held separately from
// `err` so the empty state can name it back to them — "ZZZZZZ" is the one piece
// of information that makes the message actionable rather than generic.
const unknownCode = ref<string | null>(null)
const copied = ref(false)
const railOpen = ref(true)
const selected = ref<AgentEvent | null>(null)
const agents = ref<any[]>([])
const feedEl = ref<HTMLElement | null>(null)

const myColor = computed(() => colorFor(userId.value))
const sourceColor = getSourceColor

// The live connection. Held in a shallowRef and read through computeds rather
// than copied into local refs: the objects map keeps the SAME identity when it
// changes, so `mirror.value = source.value` is a no-op under Vue's Object.is
// check and the board silently never re-renders. Computeds track the source
// ref's own invalidation instead, which triggerRef drives correctly.
const lobbyRef = shallowRef<ReturnType<typeof useLobby> | null>(null)

const connected = computed(() => lobbyRef.value?.connected.value ?? false)
const events = computed<AgentEvent[]>(() => lobbyRef.value?.events.value ?? [])
const objects = computed<Map<string, any>>(() => lobbyRef.value?.objects.value ?? new Map())
const peers = computed<Map<string, any>>(() => lobbyRef.value?.peers.value ?? new Map())
const messages = computed<any[]>(() => lobbyRef.value?.messages.value ?? [])
const annotationList = computed<any[]>(() =>
  Array.from((lobbyRef.value?.annotations.value ?? new Map()).values())
)

/**
 * Nothing has ever happened in this room.
 *
 * Deliberately checks objects AND events: a room where somebody drew a note but
 * no bot has connected is still a room that needs the onboarding, and a room
 * with events but no canvas objects is one where placement is filtering
 * everything out — in both cases "connect a bot" is the right next step.
 */
const isEmpty = computed(() => objects.value.size === 0 && events.value.length === 0)

function makeLobby(code: string) {
  const l = useLobby({
    code,
    userId: userId.value,
    displayName: userId.value,
    color: myColor.value,
    token: token.value,
  })
  watch(l.error, v => { if (v) err.value = v })
  return l
}

function putObject(patch: any) { lobbyRef.value?.putObject(patch) }
function removeObject(id: string) { lobbyRef.value?.removeObject(id) }
function onPresence(cursor: any, viewport: any) { lobbyRef.value?.sendPresence(cursor, viewport) }

// ---- chat and pins ---------------------------------------------------------

const railTab = ref<'chat' | 'activity'>('chat')
const chatRefObject = ref<string | null>(null)
const canvasEl = ref<any>(null)
const following = ref<string | null>(null)

function sendChat(body: string, extra: any) {
  lobbyRef.value?.sendChat(body, extra)
  chatRefObject.value = null
}
function deleteMessage(id: number) { lobbyRef.value?.deleteMessage(id) }
function pin(a: any) { lobbyRef.value?.pin(a) }
function resolvePin(id: number) { lobbyRef.value?.resolveAnnotation(id, true) }
function deletePin(id: number) { lobbyRef.value?.deleteAnnotation(id) }
function focusObject(id: string) { canvasEl.value?.focusObject(id) }

/** Exactly one selected object is the only unambiguous thing to attach. */
const selectedObjectId = computed<string | null>(() => {
  const sel = canvasEl.value?.selection as Set<string> | undefined
  return sel && sel.size === 1 ? Array.from(sel)[0] : null
})

/**
 * Following is a local decision — the peer's viewport is already streaming on
 * the ephemeral channel, so this costs no extra traffic. Only live peers can be
 * followed; a name in the roster with no socket has no viewport to mirror.
 */
function toggleFollow(p: { user_id: string; live: boolean }) {
  if (!p.live || p.user_id === userId.value) return
  following.value = following.value === p.user_id ? null : p.user_id
}

// Unread count, so a message that lands while you are reading the activity feed
// is not silently lost.
const seenCount = ref(0)
const unread = computed(() => Math.max(0, messages.value.length - seenCount.value))
watch([messages, railTab], () => {
  if (railTab.value === 'chat') seenCount.value = messages.value.length
}, { immediate: true })

// ---- rail data -------------------------------------------------------------

const working = computed(() =>
  agents.value
    .filter(a => a.status === 'active' || a.status === 'idle')
    .sort((a, b) => (b.last_event_at || 0) - (a.last_event_at || 0))
    .slice(0, 12)
)

const feed = computed(() => events.value.slice(-60).reverse())

/** Two agents touching the same path is the collision worth surfacing. */
const collisions = computed(() => {
  const byPath = new Map<string, Set<string>>()
  for (const e of events.value.slice(-300)) {
    const p = e.payload?.tool_input?.file_path || e.payload?.path || e.payload?.file_path
    if (!p) continue
    if (!byPath.has(p)) byPath.set(p, new Set())
    byPath.get(p)!.add(e.agent_id)
  }
  return Array.from(byPath.entries()).filter(([, set]) => set.size > 1).map(([p]) => p)
})

const roster = computed(() => {
  const out = new Map<string, { user_id: string; color: string; live: boolean }>()
  for (const a of agents.value) {
    if (a.user_id) out.set(a.user_id, { user_id: a.user_id, color: colorFor(a.user_id), live: false })
  }
  for (const p of peers.value.values()) {
    out.set(p.user_id, { user_id: p.user_id, color: p.color || colorFor(p.user_id), live: true })
  }
  out.set(userId.value, { user_id: userId.value, color: myColor.value, live: true })
  return Array.from(out.values()).slice(0, 10)
})

function initials(id: string) {
  return id.replace(/[^a-zA-Z0-9]/g, ' ').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

// ---- lobby lifecycle -------------------------------------------------------

/**
 * Member tokens are per room, keyed by code.
 *
 * They were previously all stored under one `lobby.token` key, so joining a
 * second room overwrote the credential for the first and left you locked out of
 * a room you were still a member of.
 */
function rememberToken(code: string, t?: string) {
  if (!t) return
  token.value = t
  localStorage.setItem(`lobby.token.${code}`, t)
}

async function createLobby() {
  err.value = null
  try {
    const res = await fetch(`${API_BASE}/lobbies`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${identity.value.label}'s room`, visibility: 'private', created_by: userId.value }),
    })
    if (!res.ok) throw new Error(`create failed (${res.status})`)
    const data = await res.json()
    rememberToken(data.code, data.token)
    openLobby(data.code, data.name)
  } catch (e: any) { err.value = e.message }
}

async function joinLobby() {
  const code = joinCode.value.trim().toUpperCase()
  if (!code) return
  err.value = null
  try {
    const res = await fetch(`${API_BASE}/lobbies/${code}/join`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId.value, agent_id: `browser-${userId.value}`, source: 'browser' }),
    })
    if (!res.ok) throw new Error(res.status === 404 ? 'No lobby with that code' : `join failed (${res.status})`)
    const data = await res.json()
    rememberToken(code, data.token)
    openLobby(code, data.name)
  } catch (e: any) { err.value = e.message }
}

function openLobby(code: string, name?: string) {
  lobbyRef.value?.disconnect()
  lobbyCode.value = code
  lobbyName.value = name || null
  // Pick up whichever token belongs to THIS room. Without this, switching rooms
  // carries the previous room's credential and the server rejects it.
  token.value = localStorage.getItem(`lobby.token.${code}`) || undefined
  location.hash = `lobby=${code}`
  lobbyRef.value = makeLobby(code)
  loadAgents()
}

function copyCode() {
  if (!lobbyCode.value) return
  navigator.clipboard.writeText(lobbyCode.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 1400)
}

async function loadAgents() {
  try {
    const res = await fetch(`${API_BASE}/agents`)
    if (res.ok) agents.value = await res.json()
  } catch {}
}

// Keep the feed pinned to newest unless the user has scrolled up to read.
watch(feed, async () => {
  await nextTick()
  const el = feedEl.value
  if (el && el.scrollTop < 40) el.scrollTop = 0
})

/**
 * Follow the URL hash. Sharing a room is "send someone the link", and the back
 * button should work, so the hash has to be a live input rather than something
 * read once at startup.
 */
function onHashChange() {
  const code = new URLSearchParams(location.hash.slice(1)).get('lobby')
  if (code && code !== lobbyCode.value) openLobby(code)
}

let agentTimer: number | null = null
onMounted(async () => {
  // A code out of the URL is UNVERIFIED input. Rendering the board on the
  // strength of it alone produced a convincing fake workspace for any typo:
  // header, onboarding steps, "waiting for the first artifact…", all for a room
  // that does not exist. Someone who mistyped one character of an invite link
  // would have sat there waiting forever. Confirm the room is real first.
  if (lobbyCode.value) {
    const found = await redeemCode(lobbyCode.value)
    if (!found) {
      unknownCode.value = lobbyCode.value
      lobbyCode.value = null
      loadAgents()
      agentTimer = window.setInterval(loadAgents, 10000)
      window.addEventListener('hashchange', onHashChange)
      return
    }
    // Connect after setup, so useLobby's onUnmounted hook binds to this component.
    lobbyRef.value = makeLobby(lobbyCode.value)
  }
  loadAgents()
  agentTimer = window.setInterval(loadAgents, 10000)
  window.addEventListener('hashchange', onHashChange)
})

/**
 * Redeem a code that arrived in the URL, and report whether it was real.
 *
 * This deliberately POSTs to /join rather than GETting the room, and the reason
 * matters: for an anonymous caller the server answers a GET for a REAL private
 * room with 404, exactly as it answers a wrong guess, so that an invite code
 * cannot be brute-forced by probing. A GET therefore cannot tell "missing" from
 * "you have no credential yet" — using it to decide would reject every genuine
 * guest arriving from an invite link.
 *
 * /join is the endpoint an invite code is *meant* to be redeemed at: it answers
 * 404 only when the room genuinely is not there, and on success it hands back the
 * member token this browser needs anyway. Validating and joining are the same
 * request, so there is no window where one succeeded and the other did not.
 */
async function redeemCode(code: string): Promise<boolean> {
  // Already hold a credential for this room — a returning owner. Nothing to
  // redeem, and re-joining would issue a second token for no reason.
  if (token.value) return true
  try {
    const res = await fetch(`${API_BASE}/lobbies/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId.value, agent_id: `browser-${userId.value}`, source: 'browser' }),
    })
    if (res.ok) {
      const data = await res.json().catch(() => null)
      if (data?.token) rememberToken(code, data.token)
      if (data?.name) lobbyName.value = data.name
      return true
    }
    // Only an outright 404 means the room is not there. A 403 is "real room,
    // you may not enter", which is a different sentence and not this one.
    return res.status !== 404
  } catch {
    // A network failure is not evidence the room is missing. Let the board load
    // and surface the connection problem, which is the accurate complaint.
    return true
  }
}
onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange)
  if (agentTimer) clearInterval(agentTimer)
  lobbyRef.value?.disconnect()
})
</script>

<style scoped>
.board-view { position: fixed; inset: 0; display: flex; flex-direction: column; background: #0a0a0c; color: #e2e2e8; }

.topbar {
  display: flex; align-items: center; gap: 14px;
  height: 46px; padding: 0 14px;
  background: #0d0d10; border-bottom: 1px solid #1c1c22;
  flex: 0 0 auto; z-index: 30;
}
.brand { font: 600 13px ui-monospace, 'JetBrains Mono', monospace; color: #f97316; }
.brand span { color: #e2e2e8; }
.spacer { flex: 1; }

.lobby-chip { display: flex; align-items: center; gap: 8px; }
.lobby-name { font: 500 13px ui-sans-serif, system-ui; color: #cfcfd8; }
.code {
  background: #16161b; border: 1px solid #2a2a32; border-radius: 6px;
  color: #f97316; padding: 3px 8px; cursor: pointer;
  font: 600 11px ui-monospace, monospace; letter-spacing: .08em;
}
.code:hover { border-color: #f97316; }
.copy-icon { color: #6a6a76; margin-left: 3px; }

.avatars { display: flex; gap: -4px; }
.avatar {
  width: 24px; height: 24px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font: 600 10px ui-sans-serif, system-ui; color: #0a0a0c;
  margin-left: -4px; outline: 2px solid transparent; outline-offset: 1px;
  border: 1.5px solid #0d0d10; padding: 0;
}
.avatar.clickable { cursor: pointer; }
.avatar.following { outline-color: #f97316 !important; outline-width: 2px; }

.conn { display: flex; align-items: center; gap: 6px; font: 500 10px ui-monospace, monospace; color: #6a6a76; letter-spacing: .1em; }
.conn .dot { width: 6px; height: 6px; border-radius: 50%; background: #555; }
.conn.live { color: #10b981; }
.conn.live .dot { background: #10b981; box-shadow: 0 0 8px #10b981; }

.rail-toggle { background: none; border: 1px solid #26262e; border-radius: 6px; color: #7a7a86; width: 26px; height: 24px; cursor: pointer; }

.body { flex: 1; display: flex; min-height: 0; }
.canvas-host { flex: 1; position: relative; min-width: 0; }

.rail {
  width: 300px; flex: 0 0 300px;
  background: #0d0d10; border-left: 1px solid #1c1c22;
  display: flex; flex-direction: column; min-height: 0;
}
.rail-section { padding: 12px; border-bottom: 1px solid #17171d; min-height: 0; }
.rail-section.grow { flex: 1; display: flex; flex-direction: column; }
.rail-section h3 {
  margin: 0 0 10px; font: 600 10px ui-monospace, monospace;
  color: #5a5a66; letter-spacing: .14em; text-transform: uppercase;
}
.muted { color: #4a4a55; font: 400 12px ui-sans-serif, system-ui; }

.rail-tabs { display: flex; gap: 4px; margin-bottom: 10px; }
.rail-tabs button {
  display: flex; align-items: center; gap: 5px;
  background: none; border: 1px solid transparent; border-radius: 5px;
  color: #5a5a66; padding: 3px 8px; cursor: pointer;
  font: 600 10px ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase;
}
.rail-tabs button:hover { color: #9a9aa6; }
.rail-tabs button.active { color: #f97316; border-color: #33333d; background: #131318; }
.rail-tabs .attach { margin-left: auto; color: #7a7a88; letter-spacing: .04em; }
.rail-tabs .attach:hover { color: #f0a868; }
.rail-tabs .badge {
  background: #f97316; color: #0a0a0c; border-radius: 8px;
  padding: 0 4px; font: 700 9px ui-monospace, monospace; letter-spacing: 0;
}

.agent-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.agent-dot { width: 7px; height: 7px; border-radius: 50%; background: #444; flex: 0 0 auto; }
.agent-dot.active { background: #10b981; box-shadow: 0 0 6px #10b981; }
.agent-dot.idle { background: #6a6a76; }
.agent-main { flex: 1; min-width: 0; }
.agent-id { font: 500 12px ui-sans-serif, system-ui; color: #d0d0d8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-sub { font: 400 10px ui-monospace, monospace; color: #55555f; }
.agent-src { font: 500 9px ui-monospace, monospace; }

.collision {
  margin-top: 10px; padding: 7px 9px;
  background: rgba(249,115,22,.10); border: 1px solid rgba(249,115,22,.3);
  border-radius: 6px; color: #f0a868; font: 400 11px ui-sans-serif, system-ui;
}

.feed { flex: 1; overflow-y: auto; min-height: 0; }
.feed-row {
  display: flex; align-items: baseline; gap: 7px;
  padding: 5px 7px; border-left: 2px solid #333;
  cursor: pointer; border-radius: 0 4px 4px 0;
}
.feed-row:hover { background: #15151a; }
.feed-time { font: 400 9px ui-monospace, monospace; color: #45454f; }
.feed-icon { font-size: 11px; }
.feed-text { font: 400 11px ui-sans-serif, system-ui; color: #9a9aa6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- first-run onboarding ---- */
.onboard {
  position: absolute; inset: 0; z-index: 5;
  display: grid; place-items: center; padding: 32px 20px; overflow: auto;
  background: radial-gradient(900px 500px at 50% 0%, rgba(249,115,22,.05), transparent 70%), #0d0d0f;
}
.onboard-card {
  width: min(520px, 100%);
  background: #131318; border: 1px solid #26262e; border-radius: 14px;
  padding: 28px 30px;
}
.onboard-card h2 { font-size: 20px; font-weight: 600; letter-spacing: -.01em; margin-bottom: 8px; }
.onboard-card > p { color: #7a7a86; font-size: 13px; line-height: 1.65; }
.onboard-card ol { margin: 20px 0 0; padding-left: 20px; }
.onboard-card li { color: #c8c8d0; font-size: 13px; line-height: 1.6; margin-bottom: 14px; }
.cmd {
  display: block; margin-top: 7px;
  background: #0d0d0f; border: 1px solid #26262e; border-radius: 7px;
  padding: 9px 11px; color: #f97316;
  font: 500 12px ui-monospace, 'JetBrains Mono', monospace;
  overflow-x: auto; white-space: nowrap;
}
.waiting {
  display: flex; align-items: center; gap: 9px; margin-top: 22px;
  padding-top: 18px; border-top: 1px solid #22222a;
  color: #7a7a86; font-size: 12.5px;
}
.pulse {
  width: 7px; height: 7px; border-radius: 50%; background: #f97316;
  animation: onboard-pulse 1.6s ease-in-out infinite;
}
@keyframes onboard-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
.hand-off { margin-top: 14px; font-size: 12.5px; color: #7a7a86; line-height: 1.7; }
.code-inline {
  background: #1c1c22; border: 1px solid #2e2e38; border-radius: 6px;
  color: #e0e0e6; padding: 2px 8px; cursor: pointer;
  font: 500 12px ui-monospace, 'JetBrains Mono', monospace;
}
.code-inline:hover { border-color: #f97316; }
.code-inline span { color: #6a6a76; margin-left: 4px; }
.no-plugin {
  margin-top: 16px; padding-top: 16px; border-top: 1px solid #22222a;
}
.no-plugin summary {
  color: #9a9aa6; font-size: 12.5px; cursor: pointer; user-select: none;
}
.no-plugin summary:hover { color: #c8c8d0; }
.no-plugin p {
  color: #7a7a86; font-size: 12.5px; line-height: 1.65; margin: 10px 0 0;
}
.no-plugin p code { color: #c8c8d0; font-size: 12px; }
.cmd-block { white-space: pre; }

.no-lobby {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
}
.no-lobby h2 { margin: 0; font: 600 18px ui-sans-serif, system-ui; color: #d0d0d8; }
.no-lobby p { margin: 0; color: #5a5a66; font: 400 13px ui-sans-serif, system-ui; max-width: 44ch; line-height: 1.6; }
/* Their code, quoted back. Monospace so O/0 and I/1 are distinguishable — which
   is the whole reason the invite alphabet excludes them. */
.bad-code {
  color: #fbbf24; font: 600 13px ui-monospace, 'JetBrains Mono', monospace;
  background: rgba(251,191,36,.1); border-radius: 4px; padding: 1px 5px;
}
.no-lobby-actions { display: flex; gap: 8px; margin-top: 8px; }
.no-lobby-actions input {
  background: #16161b; border: 1px solid #2a2a32; border-radius: 6px;
  color: #e2e2e8; padding: 8px 10px; width: 140px;
  font: 600 12px ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase;
}
.no-lobby-actions button {
  background: #16161b; border: 1px solid #2a2a32; border-radius: 6px;
  color: #c0c0c8; padding: 8px 14px; cursor: pointer; font: 500 12px ui-sans-serif, system-ui;
}
.no-lobby-actions button.primary { background: #f97316; border-color: #f97316; color: #0a0a0c; font-weight: 600; }
.err { color: #ef4444 !important; }

.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,.65);
  display: flex; align-items: center; justify-content: center; z-index: 100;
  backdrop-filter: blur(3px);
}
.modal { width: min(760px, 92vw); max-height: 84vh; overflow: auto; background: #0d0d10; border: 1px solid #26262e; border-radius: 12px; padding: 14px; }
.modal-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; color: #d0d0d8; }
.modal-head button { background: none; border: none; color: #7a7a86; cursor: pointer; font-size: 16px; }
</style>
