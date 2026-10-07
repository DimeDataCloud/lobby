<template>
  <div class="canvas-container" ref="containerEl" @wheel.prevent="onWheel" @mousedown="onPanStart" @mousemove="onPanMove" @mouseup="onPanEnd" @mouseleave="onPanEnd">
    <!-- Grid background -->
    <div class="canvas-grid" :style="gridStyle"></div>

    <!-- SVG layer for connections -->
    <svg class="canvas-svg" :style="svgStyle">
      <line
        v-for="conn in connections"
        :key="conn.id"
        :x1="conn.x1" :y1="conn.y1" :x2="conn.x2" :y2="conn.y2"
        :stroke="conn.color" :stroke-width="1.5" :stroke-dasharray="conn.dashed ? '4 3' : 'none'"
        :opacity="conn.opacity"
      />
    </svg>

    <!-- Agent nodes with rich event cards -->
    <div
      v-for="node in agentNodes"
      :key="node.id"
      class="agent-node"
      :class="{ selected: node.id === selectedNodeId, dimmed: selectedNodeId && node.id !== selectedNodeId }"
      :style="nodeStyle(node)"
      @click.stop="onNodeClick(node)"
    >
      <div class="node-glow" :style="{ background: node.color, opacity: node.active ? 0.15 : 0.05 }"></div>
      
      <!-- Node header -->
      <div class="node-header">
        <div class="node-icon">{{ node.icon }}</div>
        <div class="node-label">{{ node.label }}</div>
        <div class="node-status" :class="{ active: node.active }"></div>
      </div>
      
      <!-- Node sub-label -->
      <div class="node-sub">{{ node.subLabel }}</div>
      
      <!-- Recent events as mini cards -->
      <div class="node-events">
        <div
          v-for="(ev, idx) in node.recentEvents"
          :key="ev.id || idx"
          class="mini-event-card"
          :class="getEventClass(ev.event_type)"
          @click.stop="onEventClick(ev)"
        >
          <span class="mini-event-icon">{{ getEventEmoji(ev.event_type) }}</span>
          <span class="mini-event-summary">{{ truncate(ev.summary || formatEventSummary(ev), 40) }}</span>
          <span class="mini-event-time">{{ formatTime(ev.timestamp) }}</span>
        </div>
        <div v-if="node.recentEvents.length === 0" class="no-events">No events yet</div>
      </div>
      
      <div class="node-stats" v-if="node.eventCount > 0">{{ node.eventCount }} events</div>
    </div>

    <!-- Zoom controls -->
    <div class="zoom-controls">
      <button class="zoom-btn" @click="zoomIn">+</button>
      <button class="zoom-btn" @click="zoomOut">−</button>
      <button class="zoom-btn" @click="resetView">⟲</button>
      <span class="zoom-level">{{ Math.round(scale * 100) }}%</span>
    </div>

    <!-- Minimap -->
    <div class="canvas-minimap" v-if="agentNodes.length > 0">
      <div class="minimap-viewport" :style="minimapViewportStyle"></div>
      <div
        v-for="node in agentNodes"
        :key="'mm-' + node.id"
        class="minimap-dot"
        :style="minimapDotStyle(node)"
        :title="node.label"
      ></div>
    </div>

    <!-- Canvas legend — the sources actually present, not a fixed list. Teams
         bring their own bots, so any `source` string can show up here. -->
    <div class="canvas-legend" v-if="presentSources.length">
      <div class="legend-item" v-for="s in presentSources" :key="s">
        <span class="legend-dot" :style="{ background: getSourceColor(s) }"></span> {{ s }}
      </div>
    </div>

    <!-- Empty state -->
    <div v-if="agentNodes.length === 0" class="canvas-empty">
      No agents yet. Send events to populate the canvas.
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import type { AgentEvent } from '../types'
import { getSourceColor, getEventEmoji, shortId, truncate } from '../composables/useEventColors'

const props = defineProps<{
  events: AgentEvent[]
  savedPositions?: Record<string, { x: number; y: number }>
  userId?: string
}>()

const emit = defineEmits<{
  (e: 'selectEvent', event: AgentEvent): void
  (e: 'nodeMoved', data: { agent_id: string; x: number; y: number; updated_by: string }): void
}>()

/** Distinct agent systems seen in this room, so the legend matches reality. */
const presentSources = computed(() =>
  [...new Set(props.events.map(e => e.source).filter(Boolean))].sort()
)

// View state
const scale = ref(1)
const panX = ref(0)
const panY = ref(0)
const isPanning = ref(false)
const panStartX = ref(0)
const panStartY = ref(0)
const selectedNodeId = ref<string | null>(null)
const containerEl = ref<HTMLElement | null>(null)

// Drag state
const isDragging = ref(false)
const dragNodeId = ref<string | null>(null)
const dragStartX = ref(0)
const dragStartY = ref(0)
const dragNodeStartX = ref(0)
const dragNodeStartY = ref(0)

// Agent node type
interface AgentNode {
  id: string
  label: string
  subLabel: string
  x: number
  y: number
  color: string
  icon: string
  active: boolean
  eventCount: number
  lastEvent: AgentEvent | null
  source: string
  model?: string
  parent_id?: string
  recentEvents: AgentEvent[]
}

// Build agent nodes from events
const agentNodes = computed<AgentNode[]>(() => {
  const nodeMap = new Map<string, AgentNode>()

  for (const ev of props.events) {
    const id = ev.agent_id
    if (!nodeMap.has(id)) {
      // Use saved position if available, otherwise spiral layout
      const saved = props.savedPositions?.[id]
      const index = nodeMap.size
      const angle = index * 0.5
      const radius = 200 + index * 40
      nodeMap.set(id, {
        id,
        label: shortId(id),
        subLabel: ev.source,
        x: saved ? saved.x : 400 + radius * Math.cos(angle),
        y: saved ? saved.y : 300 + radius * Math.sin(angle),
        color: getSourceColor(ev.source),
        icon: getEventEmoji(ev.event_type),
        active: false,
        eventCount: 0,
        lastEvent: null,
        source: ev.source,
        model: ev.model,
        parent_id: ev.parent_agent_id,
        recentEvents: [],
      })
    }
    const node = nodeMap.get(id)!
    node.eventCount++
    node.lastEvent = ev

    // Active if last event was within 30 seconds
    const age = Date.now() - ev.timestamp
    node.active = age < 30000

    // Update icon to most recent event type
    node.icon = getEventEmoji(ev.event_type)

    // Update model if available
    if (ev.model) node.model = ev.model

    // Add to recent events (keep last 5)
    node.recentEvents = [ev, ...node.recentEvents.filter(e => e.id !== ev.id)].slice(0, 5)
  }

  return Array.from(nodeMap.values())
})

// Connection lines between parent and child agents
const connections = computed(() => {
  const conns: Array<{id: string, x1: number, y1: number, x2: number, y2: number, color: string, opacity: number, dashed: boolean}> = []

  for (const node of agentNodes.value) {
    if (!node.parent_id) continue
    const parent = agentNodes.value.find(n => n.id === node.parent_id)
    if (!parent) continue

    conns.push({
      id: `${parent.id}-${node.id}`,
      x1: parent.x,
      y1: parent.y,
      x2: node.x,
      y2: node.y,
      color: node.color,
      opacity: 0.4,
      dashed: false,
    })
  }

  return conns
})

// Styles
const gridStyle = computed(() => ({
  transform: `translate(${panX.value}px, ${panY.value}px) scale(${scale.value})`,
}))

const svgStyle = computed(() => ({
  transform: `translate(${panX.value}px, ${panY.value}px) scale(${scale.value})`,
}))

function nodeStyle(node: AgentNode) {
  return {
    left: `${node.x}px`,
    top: `${node.y}px`,
    transform: `translate(${panX.value}px, ${panY.value}px) scale(${scale.value})`,
    borderColor: node.color,
  }
}

// Pan & zoom handlers
function onWheel(e: WheelEvent) {
  const delta = e.deltaY > 0 ? 0.9 : 1.1
  const newScale = Math.max(0.2, Math.min(3, scale.value * delta))
  scale.value = newScale
}

function onPanStart(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('.agent-node')) return
  isPanning.value = true
  panStartX.value = e.clientX - panX.value
  panStartY.value = e.clientY - panY.value
}

function onPanMove(e: MouseEvent) {
  if (isDragging.value) {
    // Node drag
    const dx = (e.clientX - dragStartX.value) / scale.value
    const dy = (e.clientY - dragStartY.value) / scale.value
    const node = agentNodes.value.find(n => n.id === dragNodeId.value)
    if (node) {
      node.x = dragNodeStartX.value + dx
      node.y = dragNodeStartY.value + dy
    }
    return
  }
  if (!isPanning.value) return
  panX.value = e.clientX - panStartX.value
  panY.value = e.clientY - panStartY.value
}

function onPanEnd() {
  if (isDragging.value && dragNodeId.value) {
    const node = agentNodes.value.find(n => n.id === dragNodeId.value)
    if (node && props.userId) {
      emit('nodeMoved', {
        agent_id: node.id,
        x: Math.round(node.x),
        y: Math.round(node.y),
        updated_by: props.userId,
      })
    }
  }
  isPanning.value = false
  isDragging.value = false
  dragNodeId.value = null
}

function onNodeDragStart(e: MouseEvent, node: AgentNode) {
  e.stopPropagation()
  e.preventDefault()
  isDragging.value = true
  dragNodeId.value = node.id
  dragStartX.value = e.clientX
  dragStartY.value = e.clientY
  dragNodeStartX.value = node.x
  dragNodeStartY.value = node.y
}

function zoomIn() { scale.value = Math.min(3, scale.value * 1.2) }
function zoomOut() { scale.value = Math.max(0.2, scale.value * 0.8) }
function resetView() { scale.value = 1; panX.value = 0; panY.value = 0; selectedNodeId.value = null }

function onNodeClick(node: AgentNode) {
  selectedNodeId.value = node.id
  if (node.lastEvent) {
    emit('selectEvent', node.lastEvent)
  }
}

function onEventClick(event: AgentEvent) {
  emit('selectEvent', event)
}

function formatEventSummary(event: AgentEvent): string {
  const p = event.payload
  if (p.command) return p.command
  if (p.tool_name) return `${p.tool_name}(...)`
  if (p.goal) return p.goal
  if (p.prompt) return p.prompt
  if (p.url) return p.url
  return event.event_type
}

function getEventClass(eventType: string): string {
  const classMap: Record<string, string> = {
    'tool_call': 'event-tool',
    'tool_result': 'event-result',
    'tool_failure': 'event-error',
    'image_generated': 'event-image',
    'research_complete': 'event-research',
    'website_deployed': 'event-website',
    'code_fixed': 'event-fix',
    'subagent_start': 'event-agent',
    'subagent_stop': 'event-complete',
    'user_prompt': 'event-prompt',
    'error': 'event-error',
  }
  return classMap[eventType] || 'event-generic'
}

// Auto-fit when nodes first appear
watch(() => agentNodes.value.length, (count, oldCount) => {
  if (count > 0 && oldCount === 0 && containerEl.value) {
    // Center the view
    const rect = containerEl.value.getBoundingClientRect()
    panX.value = rect.width / 2 - 400
    panY.value = rect.height / 2 - 300
  }
})

// Minimap
const minimapViewportStyle = computed(() => {
  const mmW = 180, mmH = 120
  const vw = containerEl.value?.clientWidth || 1200
  const vh = containerEl.value?.clientHeight || 800
  const sx = mmW / (vw / scale.value)
  const sy = mmH / (vh / scale.value)
  return {
    width: `${Math.max(10, sx)}px`,
    height: `${Math.max(10, sy)}px`,
    left: `${(-panX.value / (vw / scale.value)) * (mmW / (vw / scale.value))}px`,
    top: `${(-panY.value / (vh / scale.value)) * (mmH / (vh / scale.value))}px`,
  }
})

function minimapDotStyle(node: AgentNode) {
  const mmW = 180, mmH = 120
  const vw = containerEl.value?.clientWidth || 1200
  const vh = containerEl.value?.clientHeight || 800
  return {
    left: `${(node.x / (vw / scale.value)) * (mmW / (vw / scale.value))}px`,
    top: `${(node.y / (vh / scale.value)) * (mmH / (vh / scale.value))}px`,
    background: node.color,
  }
}
</script>

<style scoped>
.canvas-container {
  flex: 1;
  position: relative;
  overflow: hidden;
  cursor: grab;
  background: #0a0a0c;
}
.canvas-container:active { cursor: grabbing; }

.canvas-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
  background-size: 40px 40px;
  transform-origin: 0 0;
}

.canvas-svg {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
  transform-origin: 0 0;
  pointer-events: none;
}

.agent-node {
  position: absolute;
  width: 280px;
  padding: 10px 12px;
  background: #151518;
  border: 2px solid #333;
  border-radius: 12px;
  cursor: pointer;
  transform-origin: center center;
  transition: opacity 0.2s, box-shadow 0.2s;
  user-select: none;
  z-index: 10;
}
.agent-node:hover {
  box-shadow: 0 0 20px rgba(255,255,255,0.1);
}
.agent-node.selected {
  box-shadow: 0 0 24px rgba(249,131,22,0.4);
  border-color: #f97316;
}
.agent-node.dimmed {
  opacity: 0.3;
}

.node-glow {
  position: absolute;
  inset: -2px;
  border-radius: 12px;
  filter: blur(8px);
  z-index: -1;
}

.node-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.node-icon {
  font-size: 18px;
}
.node-label {
  font-size: 13px;
  font-weight: 700;
  color: #e0e0e6;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.node-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #333;
}
.node-status.active {
  background: #10b981;
  box-shadow: 0 0 6px #10b981;
}

.node-sub {
  font-size: 10px;
  color: #666;
  margin-bottom: 8px;
}

.node-events {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 6px;
}
.mini-event-card {
  background: #0d0d0f;
  border: 1px solid #2a2a2e;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 10px;
  cursor: pointer;
  transition: all 0.12s;
  display: flex;
  align-items: center;
  gap: 6px;
}
.mini-event-card:hover {
  background: #1a1a1e;
  border-color: #444;
}
.mini-event-card.event-tool { border-left: 3px solid #f97316; }
.mini-event-card.event-result { border-left: 3px solid #10b981; }
.mini-event-card.event-error { border-left: 3px solid #ef4444; }
.mini-event-card.event-image { border-left: 3px solid #a78bfa; }
.mini-event-card.event-research { border-left: 3px solid #3b82f6; }
.mini-event-card.event-website { border-left: 3px solid #f59e0b; }
.mini-event-card.event-fix { border-left: 3px solid #14b8a6; }
.mini-event-card.event-agent { border-left: 3px solid #8b5cf6; }
.mini-event-card.event-complete { border-left: 3px solid #10b981; }
.mini-event-card.event-prompt { border-left: 3px solid #6b7280; }
.mini-event-icon { font-size: 12px; }
.mini-event-summary {
  flex: 1;
  color: #ccc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mini-event-time {
  font-size: 9px;
  color: #555;
  min-width: 45px;
  text-align: right;
}
.no-events {
  font-size: 9px;
  color: #444;
  text-align: center;
  padding: 8px;
}

.node-stats {
  font-size: 9px;
  text-align: center;
  color: #555;
  margin-top: 4px;
}

.zoom-controls {
  position: absolute;
  bottom: 16px;
  right: 16px;
  display: flex;
  gap: 4px;
  align-items: center;
  background: #151518;
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid #2a2a2e;
  z-index: 20;
}
.zoom-btn {
  background: #1e1e22;
  color: #ccc;
  border: 1px solid #333;
  border-radius: 4px;
  width: 26px;
  height: 26px;
  font-size: 14px;
  cursor: pointer;
  font-family: inherit;
  display: flex;
  align-items: center;
  justify-content: center;
}
.zoom-btn:hover { background: #2a2a2e; border-color: #f97316; }
.zoom-level {
  font-size: 11px;
  color: #888;
  margin-left: 4px;
  min-width: 36px;
  text-align: center;
}

.canvas-legend {
  position: absolute;
  bottom: 16px;
  left: 16px;
  display: flex;
  gap: 12px;
  background: #111114;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid #1e1e24;
  z-index: 20;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: #888;
}
.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.canvas-minimap {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  width: 180px;
  height: 120px;
  background: #0d0d10;
  border: 1px solid #1e1e24;
  border-radius: 8px;
  z-index: 20;
  overflow: hidden;
  opacity: 0.7;
  transition: opacity 0.2s;
}
.canvas-minimap:hover { opacity: 1; }
.minimap-viewport {
  position: absolute;
  border: 1px solid #f9731666;
  background: #f9731608;
  border-radius: 2px;
  z-index: 2;
  pointer-events: none;
}
.minimap-dot {
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  z-index: 1;
}

.canvas-empty {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #555;
  font-size: 14px;
}
</style>