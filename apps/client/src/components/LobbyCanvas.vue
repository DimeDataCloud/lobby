<!--
  The board.

  Objects are ARTIFACTS, not agents. Every generated thing — a diff, an image,
  a deployed URL, a research bundle — is its own movable, selectable,
  annotatable object rendered by EventCard in place. Agents show up as presence
  and as a work-in-flight lane, not as containers.

  One transform, every layer. The previous canvas positioned nodes in unscaled
  pixels with transform-origin:center while the SVG layer used 0 0, so nodes and
  their connector lines drifted apart at any zoom other than 100%. Grid, strokes,
  objects and cursors now share a single `world` transform with a common origin,
  which makes them correct by construction rather than by matching arithmetic.
-->
<template>
  <div
    ref="containerEl"
    class="board"
    :class="{ panning: isPanning, 'tool-hand': tool === 'hand' }"
    @wheel.prevent="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointerleave="onPointerUp"
    @contextmenu.prevent
  >
    <!-- grid: same transform, so it tracks the world exactly -->
    <div class="grid" :style="gridStyle"></div>

    <!-- strokes + frames + connectors -->
    <svg class="layer svg-layer" :style="worldStyle">
      <polyline
        v-for="s in visibleStrokes"
        :key="s.id"
        :points="strokePoints(s)"
        :stroke="s.props?.color || '#f97316'"
        :stroke-width="s.props?.width || 2"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <polyline
        v-if="drawing.length > 1"
        :points="drawing.map(p => `${p[0]},${p[1]}`).join(' ')"
        :stroke="myColor"
        :stroke-width="2"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>

    <!-- objects -->
    <div class="layer" :style="worldStyle">
      <div
        v-for="o in visibleObjects"
        :key="o.id"
        class="obj"
        :class="{ selected: selection.has(o.id), frame: o.type === 'frame' }"
        :style="objStyle(o)"
        @pointerdown.stop="onObjectPointerDown($event, o)"
      >
        <!-- far out: a chip. Rendering hundreds of full cards at low zoom is
             what makes a board feel slow, and none of the detail is legible. -->
        <div v-if="lod === 'chip'" class="chip" :style="{ borderColor: chipColor(o) }">
          <span class="chip-icon">{{ chipIcon(o) }}</span>
          <span class="chip-label">{{ chipLabel(o) }}</span>
        </div>

        <!-- notes -->
        <div v-else-if="o.type === 'note'" class="note">
          <textarea
            class="note-input"
            :value="o.props?.text || ''"
            placeholder="Note…"
            @pointerdown.stop
            @input="onNoteInput(o, ($event.target as HTMLTextAreaElement).value)"
          />
        </div>

        <div v-else-if="o.type === 'frame'" class="frame-label">
          {{ o.props?.title || 'Frame' }}
        </div>

        <!-- artifacts rendered from an observed event -->
        <EventCard
          v-else-if="o.type === 'artifact' && eventFor(o)"
          :event="eventFor(o)!"
          :expanded="lod === 'detail'"
          @click="$emit('selectEvent', eventFor(o))"
        />

        <!-- artifacts a bot posted directly. Their content is in props, not an
             event, so eventFor() cannot resolve them — these used to fall through
             to the fallback below and draw as a box reading "artifact". -->
        <ArtifactCard
          v-else-if="o.type === 'artifact'"
          :object="o"
          :expanded="lod === 'detail'"
          :pins="pinCount(o.id)"
        />

        <div v-else class="obj-fallback">{{ o.type }}</div>

        <div v-if="o.updated_by && o.updated_by !== userId" class="obj-author">
          {{ o.updated_by }}
        </div>
      </div>
    </div>

    <!-- annotation pins: world-anchored, counter-scaled so they stay legible -->
    <div class="layer" :style="worldStyle">
      <button
        v-for="p in visiblePins"
        :key="p.a.id"
        class="pin"
        :class="{ open: openPin?.id === p.a.id }"
        :style="pinStyle(p)"
        :title="p.a.text"
        @pointerdown.stop
        @click.stop="openPin = openPin?.id === p.a.id ? null : p.a"
      >
        <span class="pin-dot">{{ initial(p.a.user_id) }}</span>
        <span v-if="threadCount(p.a) > 1" class="pin-count">{{ threadCount(p.a) }}</span>
      </button>
    </div>

    <!-- open thread, in screen space so it never scales into unreadability -->
    <div v-if="openPin" class="thread" :style="threadStyle(openPin)" @pointerdown.stop @wheel.stop>
      <div class="thread-head">
        <strong>{{ openPin.user_id }}</strong>
        <span class="thread-time">{{ shortTime(openPin.timestamp) }}</span>
        <button class="thread-x" @click="openPin = null">✕</button>
      </div>
      <div class="thread-body">{{ openPin.text }}</div>
      <div v-for="r in repliesTo(openPin)" :key="r.id" class="thread-reply">
        <strong>{{ r.user_id }}</strong> {{ r.text }}
      </div>
      <form class="thread-form" @submit.prevent="submitReply">
        <input v-model="replyDraft" placeholder="Reply…" />
        <button type="submit" :disabled="!replyDraft.trim()">↵</button>
      </form>
      <div class="thread-actions">
        <button @click="$emit('resolvePin', openPin.id); openPin = null">Resolve</button>
        <button v-if="openPin.user_id === userId" class="danger" @click="$emit('deletePin', openPin.id); openPin = null">Delete</button>
      </div>
    </div>

    <!-- new pin being written -->
    <div v-if="pinDraft" class="thread" :style="draftStyle" @pointerdown.stop @wheel.stop>
      <div class="thread-head">
        <strong>{{ pinDraft.target_type === 'object' ? 'Comment on object' : 'Comment' }}</strong>
        <button class="thread-x" @click="pinDraft = null">✕</button>
      </div>
      <form class="thread-form" @submit.prevent="submitPin">
        <input ref="pinInputEl" v-model="pinDraftText" placeholder="What about it?" />
        <button type="submit" :disabled="!pinDraftText.trim()">↵</button>
      </form>
    </div>

    <!-- following a peer's viewport -->
    <div v-if="following" class="following" :style="{ borderColor: followColor }">
      Following <strong>{{ following }}</strong>
      <button @click="$emit('stopFollow')">stop (Esc)</button>
    </div>

    <!-- other people's cursors -->
    <div class="layer cursors" :style="worldStyle">
      <div
        v-for="p in peerList"
        :key="p.user_id"
        class="cursor"
        :style="cursorStyle(p)"
      >
        <svg width="18" height="18" viewBox="0 0 18 18">
          <path d="M2 2 L2 14 L6 10.5 L8.5 15.5 L11 14 L8.5 9.5 L14 9 Z"
                :fill="p.color || '#888'" stroke="#000" stroke-width="0.75" />
        </svg>
        <span class="cursor-name" :style="{ background: p.color || '#888' }">
          {{ p.display_name || p.user_id }}
        </span>
      </div>
    </div>

    <!-- selection marquee -->
    <div v-if="marquee" class="marquee" :style="marqueeStyle"></div>

    <!-- tool rail -->
    <div class="tools">
      <button
        v-for="t in TOOLS"
        :key="t.id"
        class="tool"
        :class="{ active: tool === t.id }"
        :title="`${t.label} (${t.key})`"
        @click="tool = t.id"
      >{{ t.icon }}</button>
    </div>

    <!-- zoom -->
    <div class="zoom">
      <button @click="zoomBy(1.2)">+</button>
      <button @click="zoomBy(1 / 1.2)">−</button>
      <button @click="resetView">⤢</button>
      <span class="zoom-pct">{{ Math.round(scale * 100) }}%</span>
      <span class="lod-badge" :title="`level of detail: ${lod}`">{{ lod }}</span>
    </div>

    <!-- minimap: the whole board, and where everyone is in it -->
    <div
      v-if="liveObjects.length"
      ref="minimapEl"
      class="minimap"
      title="Click to jump"
      @pointerdown.stop="onMinimapClick"
    >
      <div
        v-for="o in liveObjects"
        :key="o.id"
        class="mm-obj"
        :style="miniStyle(o)"
      />
      <div
        v-for="p in peerList"
        :key="'c' + p.user_id"
        class="mm-peer"
        :style="miniPeerStyle(p)"
      />
      <div class="mm-view" :style="miniViewStyle" />
    </div>

    <!-- counts: rendered vs total is the honest signal that culling works -->
    <div class="stats">
      {{ visibleObjects.length }} / {{ liveObjects.length }} shown
      <span v-if="peerList.length"> · {{ peerList.length }} live</span>
    </div>

    <div v-if="liveObjects.length === 0" class="empty">
      Nothing on the board yet — artifacts land here as agents work.
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import EventCard from './EventCard.vue'
import ArtifactCard from './ArtifactCard.vue'
import type { AgentEvent } from '../types'
import type { Annotation, CanvasObject, Peer } from '../composables/useLobby'
import { getSourceColor, getEventEmoji, truncate, colorFor } from '../composables/useEventColors'

const props = defineProps<{
  objects: Map<string, CanvasObject>
  peers: Map<string, Peer>
  events: AgentEvent[]
  userId: string
  myColor?: string
  readOnly?: boolean
  annotations?: Annotation[]
  /** user_id whose viewport this board is mirroring, if any */
  following?: string | null
}>()

const emit = defineEmits<{
  (e: 'put', patch: Partial<CanvasObject> & { id: string }): void
  (e: 'remove', id: string): void
  (e: 'presence', cursor: { x: number; y: number }, viewport: { x: number; y: number; zoom: number }): void
  (e: 'selectEvent', ev: AgentEvent | undefined): void
  (e: 'pin', a: { text: string; target_type: 'object' | 'point'; target_id?: string; anchor_x: number; anchor_y: number; thread_parent?: number }): void
  (e: 'resolvePin', id: number): void
  (e: 'deletePin', id: number): void
  (e: 'stopFollow'): void
}>()

const TOOLS = [
  { id: 'select',  icon: '⌖', label: 'Select',  key: 'V' },
  { id: 'hand',    icon: '✋', label: 'Pan',     key: 'H' },
  { id: 'pen',     icon: '✎', label: 'Pen',     key: 'P' },
  { id: 'note',    icon: '▭', label: 'Note',    key: 'N' },
  { id: 'frame',   icon: '⬚', label: 'Frame',   key: 'F' },
  { id: 'comment', icon: '💬', label: 'Comment', key: 'C' },
] as const
type ToolId = typeof TOOLS[number]['id']

const containerEl = ref<HTMLElement | null>(null)
const tool = ref<ToolId>('select')
const scale = ref(1)
const panX = ref(0)
const panY = ref(0)
const selection = ref<Set<string>>(new Set())
const myColor = computed(() => props.myColor || '#f97316')

const isPanning = ref(false)
const size = ref({ w: 1200, h: 800 })

let dragMode: 'none' | 'pan' | 'move' | 'draw' | 'marquee' = 'none'
let dragStart = { x: 0, y: 0 }
let panStart = { x: 0, y: 0 }
const moving = ref<Array<{ id: string; ox: number; oy: number }>>([])
/**
 * Live drag offset, applied at RENDER time.
 *
 * The obvious implementation mutates obj.x/obj.y on the objects in the map, but
 * those objects are not reactive and the map identity does not change, so the
 * drag would be invisible until something else forced a re-render. Rendering
 * from an offset also means the source of truth is untouched until the gesture
 * ends, which is what lets one durable write cover the whole drag.
 */
const dragDelta = ref<{ dx: number; dy: number } | null>(null)
const movingIds = computed(() => new Set(moving.value.map(m => m.id)))
const drawing = ref<Array<[number, number]>>([])
const marquee = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null)

// ---- transforms ------------------------------------------------------------
// ONE style object for every layer. Anything that needs to sit in world space
// uses this and nothing else.

const worldStyle = computed(() => ({
  transform: `translate(${panX.value}px, ${panY.value}px) scale(${scale.value})`,
  transformOrigin: '0 0',
}))

const gridStyle = computed(() => {
  const s = 40 * scale.value
  return {
    backgroundSize: `${s}px ${s}px`,
    backgroundPosition: `${panX.value}px ${panY.value}px`,
  }
})

function toWorld(clientX: number, clientY: number) {
  const rect = containerEl.value!.getBoundingClientRect()
  return {
    x: (clientX - rect.left - panX.value) / scale.value,
    y: (clientY - rect.top - panY.value) / scale.value,
  }
}

// ---- level of detail -------------------------------------------------------
// Zoomed out, a full EventCard is unreadable AND expensive. Three tiers keep
// the board legible and the frame rate up.

const lod = computed<'chip' | 'card' | 'detail'>(() => {
  if (scale.value < 0.4) return 'chip'
  if (scale.value > 1.2) return 'detail'
  return 'card'
})

// ---- culling ---------------------------------------------------------------

const liveObjects = computed(() => Array.from(props.objects.values()).filter(o => !o.deleted))

/** Visible world rect, padded so objects do not pop in at the edge while panning. */
const viewRect = computed(() => {
  const pad = 300 / scale.value
  return {
    x1: -panX.value / scale.value - pad,
    y1: -panY.value / scale.value - pad,
    x2: (-panX.value + size.value.w) / scale.value + pad,
    y2: (-panY.value + size.value.h) / scale.value + pad,
  }
})

const visibleObjects = computed(() => {
  const r = viewRect.value
  return liveObjects.value
    .filter(o => o.x + o.w >= r.x1 && o.x <= r.x2 && o.y + o.h >= r.y1 && o.y <= r.y2)
    .sort((a, b) => a.z - b.z || a.seq - b.seq)
})

const visibleStrokes = computed(() => visibleObjects.value.filter(o => o.type === 'stroke'))

const peerList = computed(() =>
  Array.from(props.peers.values()).filter(p => p.user_id !== props.userId && p.cursor)
)

// Events indexed once per change, not re-scanned per object.
const eventIndex = computed(() => {
  const m = new Map<number, AgentEvent>()
  for (const e of props.events) if (e.id != null) m.set(e.id, e)
  return m
})
function eventFor(o: CanvasObject): AgentEvent | undefined {
  return o.event_id != null ? eventIndex.value.get(o.event_id) : undefined
}

// ---- rendering helpers -----------------------------------------------------

function objStyle(o: CanvasObject) {
  const d = dragDelta.value && movingIds.value.has(o.id) ? dragDelta.value : null
  return {
    left: `${o.x + (d?.dx ?? 0)}px`,
    top: `${o.y + (d?.dy ?? 0)}px`,
    width: `${o.w}px`,
    ...(o.type === 'stroke' ? {} : { minHeight: `${o.h}px` }),
    zIndex: String(o.z ?? 0),
  }
}

function strokePoints(o: CanvasObject): string {
  const pts: Array<[number, number]> = o.props?.points || []
  return pts.map(p => `${o.x + p[0]},${o.y + p[1]}`).join(' ')
}

function cursorStyle(p: Peer) {
  return {
    left: `${p.cursor!.x}px`,
    top: `${p.cursor!.y}px`,
    // Counter-scale so the pointer stays a constant on-screen size at any zoom.
    transform: `scale(${1 / scale.value})`,
    transformOrigin: '0 0',
  }
}

const marqueeStyle = computed(() => {
  if (!marquee.value) return {}
  const m = marquee.value
  const x1 = Math.min(m.x1, m.x2), y1 = Math.min(m.y1, m.y2)
  return {
    left: `${x1 * scale.value + panX.value}px`,
    top: `${y1 * scale.value + panY.value}px`,
    width: `${Math.abs(m.x2 - m.x1) * scale.value}px`,
    height: `${Math.abs(m.y2 - m.y1) * scale.value}px`,
  }
})

// Zoomed-out chips have to describe bot-posted artifacts too, or a board at low
// zoom becomes a grid of identical grey squares.
const ARTIFACT_ICONS: Record<string, string> = {
  diff: '◈', doc: '📄', image: '🖼', data: '▦', link: '🔗', note: '▭', error: '💥',
}

function chipColor(o: CanvasObject) {
  const ev = eventFor(o)
  if (ev) return getSourceColor(ev.source)
  // Author colour, so a chip still says *who* at any zoom.
  return o.created_by ? colorFor(o.created_by, 45) : '#555'
}
function chipIcon(o: CanvasObject) {
  const ev = eventFor(o)
  if (ev) return getEventEmoji(ev.event_type)
  if (o.type === 'artifact') return ARTIFACT_ICONS[String(o.props?.agent_kind)] || '◻'
  return o.type === 'note' ? '▭' : '◻'
}
function chipLabel(o: CanvasObject) {
  const ev = eventFor(o)
  if (ev) return truncate(ev.summary || ev.event_type, 22)
  return truncate(o.props?.title || o.props?.text || o.type, 22)
}

/** Unresolved pins on one object, for the count on its card. */
function pinCount(id: string): number {
  return (props.annotations || []).filter(
    (a: any) => a.target_id === id && !a.resolved && !a.deleted
  ).length
}

// ---- annotation pins -------------------------------------------------------
//
// A pin lives in BOARD space. An object pin without its own anchor hangs off the
// object's top-right corner, so it follows the card when someone moves it rather
// than staying behind at the coordinates where the comment happened to be made.

const openPin = ref<Annotation | null>(null)
const replyDraft = ref('')
const pinDraft = ref<{ x: number; y: number; target_type: 'object' | 'point'; target_id?: string } | null>(null)
const pinDraftText = ref('')
const pinInputEl = ref<HTMLInputElement | null>(null)

/** Top-level pins only — replies render inside their parent's thread. */
const rootPins = computed(() =>
  (props.annotations || []).filter(a => !a.thread_parent && a.target_type !== 'event')
)

function anchorOf(a: Annotation): { x: number; y: number } | null {
  if (a.target_type === 'object' && a.target_id) {
    const o = props.objects.get(a.target_id)
    if (o) return { x: o.x + o.w, y: o.y }
    // The object is gone or not loaded; fall back to the stored anchor if the
    // pin has one, otherwise there is nowhere honest to draw it.
  }
  if (a.anchor_x === undefined || a.anchor_y === undefined) return null
  return { x: a.anchor_x, y: a.anchor_y }
}

const visiblePins = computed(() => {
  const r = viewRect.value
  const out: Array<{ a: Annotation; x: number; y: number }> = []
  for (const a of rootPins.value) {
    const p = anchorOf(a)
    if (!p) continue
    if (p.x < r.x1 || p.x > r.x2 || p.y < r.y1 || p.y > r.y2) continue
    out.push({ a, x: p.x, y: p.y })
  }
  return out
})

function pinStyle(p: { x: number; y: number }) {
  return {
    left: `${p.x}px`,
    top: `${p.y}px`,
    transform: `scale(${1 / scale.value})`,
    transformOrigin: '0 100%',
  }
}

function repliesTo(a: Annotation): Annotation[] {
  return (props.annotations || [])
    .filter(x => x.thread_parent === a.id)
    .sort((x, y) => x.seq - y.seq)
}
function threadCount(a: Annotation): number {
  return 1 + repliesTo(a).length
}

/** World point -> screen point, for popovers that must not scale. */
function toScreen(x: number, y: number) {
  return { left: x * scale.value + panX.value, top: y * scale.value + panY.value }
}

function threadStyle(a: Annotation) {
  const p = anchorOf(a)
  if (!p) return { display: 'none' }
  const s = toScreen(p.x, p.y)
  return { left: `${s.left + 16}px`, top: `${s.top + 10}px` }
}

const draftStyle = computed(() => {
  if (!pinDraft.value) return {}
  const s = toScreen(pinDraft.value.x, pinDraft.value.y)
  return { left: `${s.left + 16}px`, top: `${s.top + 10}px` }
})

function submitPin() {
  const d = pinDraft.value
  const text = pinDraftText.value.trim()
  if (!d || !text) return
  emit('pin', {
    text,
    target_type: d.target_type,
    target_id: d.target_id,
    anchor_x: d.x,
    anchor_y: d.y,
  })
  pinDraft.value = null
  pinDraftText.value = ''
  tool.value = 'select'
}

function submitReply() {
  const parent = openPin.value
  const text = replyDraft.value.trim()
  if (!parent || !text) return
  const p = anchorOf(parent)
  emit('pin', {
    text,
    target_type: parent.target_type === 'object' ? 'object' : 'point',
    target_id: parent.target_id,
    anchor_x: p?.x ?? 0,
    anchor_y: p?.y ?? 0,
    thread_parent: parent.id,
  })
  replyDraft.value = ''
}

async function startPin(x: number, y: number, targetId?: string) {
  openPin.value = null
  pinDraft.value = { x, y, target_type: targetId ? 'object' : 'point', target_id: targetId }
  pinDraftText.value = ''
  await nextTick()
  // Focused on the NEXT frame, not this one. Focusing inside the pointerdown
  // that opened the popover loses the focus again to the browser's own default
  // handling of the same gesture — and then every letter typed goes to the
  // board's tool shortcuts instead of the comment.
  requestAnimationFrame(() => pinInputEl.value?.focus())
}

function initial(id: string) {
  return (id || '?').replace(/[^a-zA-Z0-9]/g, '').slice(0, 1).toUpperCase() || '?'
}
function shortTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ---- follow mode -----------------------------------------------------------
//
// Mirroring someone's viewport is the cheapest way to say "look at this". The
// peer's viewport already arrives on the ephemeral channel, so following costs
// no extra traffic — it is a local decision to apply what is already streaming.

const followColor = computed(() => {
  const p = props.following ? props.peers.get(props.following) : null
  return p?.color || '#f97316'
})

watch(
  () => {
    if (!props.following) return null
    const p = props.peers.get(props.following)
    return p?.viewport ? `${p.viewport.x},${p.viewport.y},${p.viewport.zoom}` : null
  },
  (v) => {
    if (!v) return
    const [x, y, z] = v.split(',').map(Number)
    if (![x, y, z].every(Number.isFinite)) return
    panX.value = x; panY.value = y; scale.value = z
  }
)

// ---- minimap ---------------------------------------------------------------

const MINIMAP = { w: 160, h: 110, pad: 8 }
const minimapEl = ref<HTMLElement | null>(null)

/** World bounds of everything, plus the current viewport so you never fall off it. */
const worldBounds = computed(() => {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const o of liveObjects.value) {
    x1 = Math.min(x1, o.x); y1 = Math.min(y1, o.y)
    x2 = Math.max(x2, o.x + o.w); y2 = Math.max(y2, o.y + o.h)
  }
  const v = viewRect.value
  x1 = Math.min(x1, v.x1); y1 = Math.min(y1, v.y1)
  x2 = Math.max(x2, v.x2); y2 = Math.max(y2, v.y2)
  if (!Number.isFinite(x1)) return { x1: 0, y1: 0, x2: 1000, y2: 700 }
  // Never let the box collapse — a zero dimension divides by zero below.
  return { x1, y1, x2: Math.max(x2, x1 + 1), y2: Math.max(y2, y1 + 1) }
})

const miniScale = computed(() => {
  const b = worldBounds.value
  return Math.min(
    (MINIMAP.w - MINIMAP.pad * 2) / (b.x2 - b.x1),
    (MINIMAP.h - MINIMAP.pad * 2) / (b.y2 - b.y1)
  )
})

function toMini(x: number, y: number) {
  const b = worldBounds.value
  return {
    x: (x - b.x1) * miniScale.value + MINIMAP.pad,
    y: (y - b.y1) * miniScale.value + MINIMAP.pad,
  }
}

function miniStyle(o: CanvasObject) {
  const p = toMini(o.x, o.y)
  return {
    left: `${p.x}px`, top: `${p.y}px`,
    width: `${Math.max(2, o.w * miniScale.value)}px`,
    height: `${Math.max(2, o.h * miniScale.value)}px`,
  }
}

function miniPeerStyle(p: Peer) {
  const m = toMini(p.cursor!.x, p.cursor!.y)
  return { left: `${m.x}px`, top: `${m.y}px`, background: p.color || '#888' }
}

const miniViewStyle = computed(() => {
  const v = viewRect.value
  const a = toMini(v.x1, v.y1)
  return {
    left: `${a.x}px`, top: `${a.y}px`,
    width: `${(v.x2 - v.x1) * miniScale.value}px`,
    height: `${(v.y2 - v.y1) * miniScale.value}px`,
  }
})

/** Click the minimap to centre the real view on that point. */
function onMinimapClick(e: PointerEvent) {
  const el = minimapEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const b = worldBounds.value
  const wx = (e.clientX - r.left - MINIMAP.pad) / miniScale.value + b.x1
  const wy = (e.clientY - r.top - MINIMAP.pad) / miniScale.value + b.y1
  panX.value = size.value.w / 2 - wx * scale.value
  panY.value = size.value.h / 2 - wy * scale.value
  broadcast()
}

// ---- interaction -----------------------------------------------------------

function onWheel(e: WheelEvent) {
  const rect = containerEl.value!.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top

  if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 0) {
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const next = Math.min(8, Math.max(0.05, scale.value * factor))
    // Zoom toward the pointer: keep the world point under the cursor fixed.
    panX.value = mx - (mx - panX.value) * (next / scale.value)
    panY.value = my - (my - panY.value) * (next / scale.value)
    scale.value = next
    broadcast()
  }
}

function zoomBy(f: number) {
  const next = Math.min(8, Math.max(0.05, scale.value * f))
  const cx = size.value.w / 2, cy = size.value.h / 2
  panX.value = cx - (cx - panX.value) * (next / scale.value)
  panY.value = cy - (cy - panY.value) * (next / scale.value)
  scale.value = next
  broadcast()
}

function resetView() {
  scale.value = 1; panX.value = 0; panY.value = 0
  broadcast()
}

function onPointerDown(e: PointerEvent) {
  const w = toWorld(e.clientX, e.clientY)
  dragStart = w

  // Middle mouse or the hand tool always pans, whatever else is selected.
  if (e.button === 1 || tool.value === 'hand' || e.shiftKey) {
    dragMode = 'pan'
    isPanning.value = true
    panStart = { x: panX.value - e.clientX, y: panY.value - e.clientY }
    return
  }

  // A click on empty board with the comment tool asks "what about here?"
  if (tool.value === 'comment') {
    startPin(w.x, w.y)
    return
  }

  // Clicking away closes an open thread, the way any popover should.
  openPin.value = null
  pinDraft.value = null

  if (props.readOnly) return

  if (tool.value === 'pen') {
    dragMode = 'draw'
    drawing.value = [[w.x, w.y]]
    return
  }

  if (tool.value === 'note' || tool.value === 'frame') {
    const id = crypto.randomUUID()
    emit('put', {
      id,
      type: tool.value === 'note' ? 'note' : 'frame',
      x: w.x, y: w.y,
      w: tool.value === 'note' ? 220 : 480,
      h: tool.value === 'note' ? 140 : 320,
      props: tool.value === 'frame' ? { title: 'Frame' } : { text: '' },
    })
    tool.value = 'select'
    return
  }

  // Empty-space drag with the select tool = marquee.
  dragMode = 'marquee'
  marquee.value = { x1: w.x, y1: w.y, x2: w.x, y2: w.y }
  if (!e.shiftKey) selection.value = new Set()
}

function onObjectPointerDown(e: PointerEvent, o: CanvasObject) {
  if (tool.value === 'comment') {
    e.stopPropagation()
    const w = toWorld(e.clientX, e.clientY)
    startPin(w.x, w.y, o.id)
    return
  }
  if (tool.value === 'hand' || props.readOnly) return
  e.stopPropagation()

  if (e.shiftKey) {
    selection.value.has(o.id) ? selection.value.delete(o.id) : selection.value.add(o.id)
  } else if (!selection.value.has(o.id)) {
    selection.value = new Set([o.id])
  }
  selection.value = new Set(selection.value)

  dragMode = 'move'
  dragStart = toWorld(e.clientX, e.clientY)
  moving.value = Array.from(selection.value)
    .map(id => props.objects.get(id))
    .filter((x): x is CanvasObject => !!x)
    .map(x => ({ id: x.id, ox: x.x, oy: x.y }))
}

function onPointerMove(e: PointerEvent) {
  const w = toWorld(e.clientX, e.clientY)

  if (dragMode === 'pan') {
    panX.value = e.clientX + panStart.x
    panY.value = e.clientY + panStart.y
  } else if (dragMode === 'draw') {
    drawing.value.push([w.x, w.y])
  } else if (dragMode === 'marquee' && marquee.value) {
    marquee.value = { ...marquee.value, x2: w.x, y2: w.y }
  } else if (dragMode === 'move') {
    // Render-time only during the drag. Committing every frame would be a
    // durable write per mouse-move.
    dragDelta.value = { dx: w.x - dragStart.x, dy: w.y - dragStart.y }
  }

  broadcast(w)
}

function onPointerUp() {
  if (dragMode === 'move') {
    // ONE durable write per object, at the end of the gesture.
    const d = dragDelta.value
    if (d && (d.dx !== 0 || d.dy !== 0)) {
      for (const m of moving.value) {
        emit('put', { id: m.id, x: m.ox + d.dx, y: m.oy + d.dy })
      }
    }
    moving.value = []
    dragDelta.value = null
  } else if (dragMode === 'draw' && drawing.value.length > 1) {
    const xs = drawing.value.map(p => p[0])
    const ys = drawing.value.map(p => p[1])
    const minX = Math.min(...xs), minY = Math.min(...ys)
    emit('put', {
      id: crypto.randomUUID(),
      type: 'stroke',
      x: minX, y: minY,
      w: Math.max(1, Math.max(...xs) - minX),
      h: Math.max(1, Math.max(...ys) - minY),
      props: {
        color: myColor.value,
        width: 2,
        points: drawing.value.map(p => [p[0] - minX, p[1] - minY]),
      },
    })
    drawing.value = []
  } else if (dragMode === 'marquee' && marquee.value) {
    const m = marquee.value
    const x1 = Math.min(m.x1, m.x2), x2 = Math.max(m.x1, m.x2)
    const y1 = Math.min(m.y1, m.y2), y2 = Math.max(m.y1, m.y2)
    if (Math.abs(x2 - x1) > 4 || Math.abs(y2 - y1) > 4) {
      for (const o of liveObjects.value) {
        if (o.x + o.w >= x1 && o.x <= x2 && o.y + o.h >= y1 && o.y <= y2) selection.value.add(o.id)
      }
      selection.value = new Set(selection.value)
    }
    marquee.value = null
  }

  dragMode = 'none'
  isPanning.value = false
}

let noteTimer: number | null = null
function onNoteInput(o: CanvasObject, text: string) {
  // Debounced: a durable write per keystroke would be one SQLite row per
  // character typed.
  if (noteTimer) clearTimeout(noteTimer)
  noteTimer = window.setTimeout(() => {
    emit('put', { id: o.id, props: { ...(o.props || {}), text } })
  }, 400)
}

function broadcast(cursor?: { x: number; y: number }) {
  emit('presence',
    cursor || { x: 0, y: 0 },
    { x: panX.value, y: panY.value, zoom: scale.value })
}

// ---- keyboard --------------------------------------------------------------

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return

  // A composer is open. Single-letter tool shortcuts must not fire behind it —
  // if focus lands anywhere but the field, typing a comment silently switches
  // tools instead. Escape still gets through, below.
  if ((pinDraft.value || openPin.value) && e.key !== 'Escape') return

  const map: Record<string, ToolId> = {
    v: 'select', h: 'hand', p: 'pen', n: 'note', f: 'frame', c: 'comment',
  }
  if (map[e.key.toLowerCase()]) { tool.value = map[e.key.toLowerCase()]; return }

  if ((e.key === 'Delete' || e.key === 'Backspace') && selection.value.size && !props.readOnly) {
    for (const id of selection.value) emit('remove', id)
    selection.value = new Set()
    e.preventDefault()
  }
  if (e.key === 'Escape') {
    selection.value = new Set()
    openPin.value = null
    pinDraft.value = null
    // Escape is also how you get your own camera back.
    if (props.following) emit('stopFollow')
  }
}

let ro: ResizeObserver | null = null
onMounted(() => {
  window.addEventListener('keydown', onKey)
  if (containerEl.value) {
    const measure = () => {
      const r = containerEl.value!.getBoundingClientRect()
      size.value = { w: r.width, h: r.height }
    }
    measure()
    ro = new ResizeObserver(measure)
    ro.observe(containerEl.value)
  }
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  ro?.disconnect()
  if (noteTimer) clearTimeout(noteTimer)
})

/** Centre the view on one object and select it — what "show me that" means. */
function focusObject(id: string) {
  const o = props.objects.get(id)
  if (!o) return
  panX.value = size.value.w / 2 - (o.x + o.w / 2) * scale.value
  panY.value = size.value.h / 2 - (o.y + o.h / 2) * scale.value
  selection.value = new Set([id])
  broadcast()
}

defineExpose({ resetView, focusObject, selection })
</script>

<style scoped>
.board {
  position: absolute; inset: 0;
  overflow: hidden;
  background: #0a0a0c;
  cursor: default;
  touch-action: none;
  user-select: none;
}
.board.tool-hand { cursor: grab; }
.board.panning { cursor: grabbing; }

.grid {
  position: absolute; inset: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px);
  pointer-events: none;
}

/* Every world-space layer shares one transform — see the note at the top. */
.layer {
  position: absolute; inset: 0;
  pointer-events: none;
  will-change: transform;
}
.layer > * { pointer-events: auto; }
.svg-layer { overflow: visible; }
.cursors > * { pointer-events: none; }

.obj {
  position: absolute;
  border-radius: 8px;
  transition: box-shadow .12s ease;
}
.obj.selected { box-shadow: 0 0 0 2px #f97316, 0 8px 28px rgba(0,0,0,.5); }
.obj.frame {
  border: 1px dashed #3a3a44;
  background: rgba(255,255,255,0.012);
  border-radius: 12px;
}

.chip {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px;
  background: #141418;
  border: 1px solid #2a2a30;
  border-left-width: 3px;
  border-radius: 6px;
  font: 500 12px/1 ui-monospace, 'JetBrains Mono', monospace;
  color: #cfcfd6;
  white-space: nowrap;
}
.chip-icon { font-size: 13px; }

.note { height: 100%; }
.note-input {
  width: 100%; height: 100%;
  min-height: 120px;
  background: #2a2410;
  border: 1px solid #4a3f18;
  border-radius: 8px;
  color: #f0e6c8;
  padding: 10px;
  font: 400 13px/1.45 ui-sans-serif, system-ui;
  resize: none; outline: none;
}
.frame-label {
  position: absolute; top: -20px; left: 2px;
  font: 500 11px ui-monospace, monospace; color: #6a6a78;
}
.obj-fallback {
  padding: 10px; color: #888;
  background: #141418; border: 1px solid #2a2a30; border-radius: 8px;
  font: 400 12px ui-monospace, monospace;
}
.obj-author {
  position: absolute; bottom: -16px; right: 2px;
  font: 400 10px ui-monospace, monospace; color: #5a5a66;
}

.cursor { position: absolute; z-index: 9000; }
.cursor-name {
  position: absolute; left: 14px; top: 12px;
  padding: 2px 6px; border-radius: 4px;
  font: 500 11px ui-sans-serif, system-ui; color: #0a0a0c;
  white-space: nowrap;
}

.marquee {
  position: absolute;
  border: 1px solid #f97316;
  background: rgba(249,115,22,.10);
  pointer-events: none;
}

/* pins */
.pin {
  position: absolute;
  display: flex; align-items: center; gap: 3px;
  background: none; border: none; padding: 0; cursor: pointer;
  z-index: 8000;
}
.pin-dot {
  width: 20px; height: 20px; border-radius: 50% 50% 50% 2px;
  background: #f97316; color: #0a0a0c;
  display: flex; align-items: center; justify-content: center;
  font: 700 10px ui-sans-serif, system-ui;
  box-shadow: 0 2px 8px rgba(0,0,0,.55);
}
.pin.open .pin-dot { background: #fbbf24; }
.pin-count {
  font: 600 9px ui-monospace, monospace; color: #f0a868;
  background: #1a1a20; border: 1px solid #33333d; border-radius: 8px; padding: 0 4px;
}

.thread {
  position: absolute; z-index: 9500;
  width: 240px; padding: 9px;
  background: rgba(15,15,19,.97);
  border: 1px solid #33333d; border-radius: 9px;
  box-shadow: 0 12px 34px rgba(0,0,0,.6);
  backdrop-filter: blur(6px);
}
.thread-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 5px; }
.thread-head strong { font: 600 11px ui-sans-serif, system-ui; color: #e2e2e8; }
.thread-time { font: 400 9px ui-monospace, monospace; color: #45454f; }
.thread-x { margin-left: auto; background: none; border: none; color: #5a5a66; cursor: pointer; font-size: 11px; }
.thread-body { font: 400 12px/1.45 ui-sans-serif, system-ui; color: #c8c8d2; white-space: pre-wrap; word-break: break-word; }
.thread-reply {
  margin-top: 6px; padding-left: 8px; border-left: 2px solid #2a2a32;
  font: 400 11px/1.4 ui-sans-serif, system-ui; color: #a0a0ac;
}
.thread-reply strong { color: #d0d0d8; font-weight: 600; }
.thread-form { display: flex; gap: 5px; margin-top: 8px; }
.thread-form input {
  flex: 1; min-width: 0;
  background: #131318; border: 1px solid #26262e; border-radius: 5px;
  color: #e2e2e8; padding: 5px 7px; font: 400 11px ui-sans-serif, system-ui; outline: none;
}
.thread-form input:focus { border-color: #f97316; }
.thread-form button {
  background: #f97316; border: none; border-radius: 5px;
  color: #0a0a0c; width: 26px; cursor: pointer; font-weight: 700;
}
.thread-form button:disabled { background: #26262e; color: #55555f; cursor: default; }
.thread-actions { display: flex; gap: 6px; margin-top: 7px; }
.thread-actions button {
  background: #16161c; border: 1px solid #2a2a32; border-radius: 5px;
  color: #9a9aa6; padding: 3px 8px; cursor: pointer; font: 500 10px ui-sans-serif, system-ui;
}
.thread-actions button:hover { border-color: #f97316; color: #f0a868; }
.thread-actions .danger:hover { border-color: #ef4444; color: #ef4444; }

.following {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px; z-index: 9000;
  padding: 5px 10px;
  background: rgba(15,15,19,.94); border: 1px solid #f97316; border-radius: 20px;
  font: 400 11px ui-sans-serif, system-ui; color: #c8c8d2;
}
.following strong { color: #f0a868; }
.following button {
  background: none; border: none; color: #6a6a76; cursor: pointer;
  font: 500 10px ui-sans-serif, system-ui;
}
.following button:hover { color: #e2e2e8; }

.minimap {
  position: absolute; right: 12px; bottom: 48px;
  width: 160px; height: 110px;
  background: rgba(13,13,16,.92);
  border: 1px solid #26262e; border-radius: 8px;
  overflow: hidden; cursor: crosshair; z-index: 20;
}
.mm-obj { position: absolute; background: #3a3a46; border-radius: 1px; }
.mm-peer { position: absolute; width: 4px; height: 4px; border-radius: 50%; }
.mm-view {
  position: absolute; border: 1px solid #f97316;
  background: rgba(249,115,22,.08); pointer-events: none;
}

.tools {
  position: absolute; left: 12px; top: 50%;
  transform: translateY(-50%);
  display: flex; flex-direction: column; gap: 4px;
  padding: 6px;
  background: rgba(17,17,20,.92);
  border: 1px solid #26262e; border-radius: 10px;
  backdrop-filter: blur(8px);
  z-index: 20;
}
.tool {
  width: 32px; height: 32px;
  background: transparent; border: 1px solid transparent; border-radius: 7px;
  color: #8a8a96; font-size: 15px; cursor: pointer;
}
.tool:hover { color: #ddd; border-color: #33333d; }
.tool.active { background: #f97316; color: #0a0a0c; border-color: #f97316; }

.zoom {
  position: absolute; right: 12px; bottom: 12px;
  display: flex; align-items: center; gap: 4px;
  padding: 5px 8px;
  background: rgba(17,17,20,.92);
  border: 1px solid #26262e; border-radius: 8px;
  z-index: 20;
}
.zoom button {
  width: 24px; height: 24px;
  background: transparent; border: none; border-radius: 5px;
  color: #9a9aa6; cursor: pointer; font-size: 14px;
}
.zoom button:hover { background: #22222a; color: #eee; }
.zoom-pct { font: 500 11px ui-monospace, monospace; color: #8a8a96; min-width: 38px; text-align: center; }
.lod-badge {
  font: 500 9px ui-monospace, monospace; color: #5a5a66;
  border: 1px solid #2a2a32; border-radius: 4px; padding: 1px 4px;
}

.stats {
  position: absolute; left: 56px; bottom: 14px;
  font: 400 11px ui-monospace, monospace; color: #55555f;
  z-index: 20; pointer-events: none;
}
.empty {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  color: #45454f; font: 400 13px ui-sans-serif, system-ui;
  pointer-events: none;
}
</style>
