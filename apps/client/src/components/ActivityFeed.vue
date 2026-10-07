<template>
  <div class="activity-feed" v-if="show">
    <div class="feed-header">
      <span>📡 Live Activity</span>
      <div class="feed-header-right">
        <span class="feed-pulse" :class="{ active: isStreaming }"></span>
        <span class="feed-count">{{ events.length }}</span>
        <button class="feed-close" @click="$emit('close')">×</button>
      </div>
    </div>
    <div class="feed-body" ref="feedBody">
      <div v-if="events.length === 0" class="feed-empty">Waiting for activity...</div>
      <TransitionGroup name="feed-item" tag="div" class="feed-list">
        <div
          v-for="event in events"
          :key="event.id || event.timestamp"
          class="feed-event"
          :class="getEventClass(event.event_type)"
          @click="$emit('selectEvent', event)"
        >
          <span class="feed-event-icon">{{ getEventEmoji(event.event_type) }}</span>
          <div class="feed-event-content">
            <div class="feed-event-header">
              <span class="feed-event-source" :style="{ color: getSourceColor(event.source) }">{{ event.source }}</span>
              <span class="feed-event-time">{{ formatTime(event.timestamp) }}</span>
            </div>
            <div class="feed-event-summary">{{ event.summary || formatEventSummary(event) }}</div>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import type { AgentEvent } from '../types'
import { getSourceColor, getEventEmoji, formatTime, shortId, truncate } from '../composables/useEventColors'

const props = defineProps<{
  show: boolean
  events: AgentEvent[]
  isStreaming: boolean
}>()

defineEmits<{
  (e: 'close'): void
  (e: 'selectEvent', event: AgentEvent): void
}>()

const feedBody = ref<HTMLElement | null>(null)

function getEventClass(eventType: string): string {
  const classMap: Record<string, string> = {
    'tool_call': 'ev-tool',
    'tool_result': 'ev-result',
    'tool_failure': 'ev-error',
    'image_generated': 'ev-image',
    'research_complete': 'ev-research',
    'website_deployed': 'ev-website',
    'code_fixed': 'ev-fix',
    'subagent_start': 'ev-agent',
    'subagent_stop': 'ev-complete',
    'user_prompt': 'ev-prompt',
    'error': 'ev-error',
  }
  return classMap[eventType] || 'ev-generic'
}

function formatEventSummary(event: AgentEvent): string {
  const p = event.payload
  if (p.command) return p.command
  if (p.tool_name) return `${p.tool_name}(...)`
  if (p.goal) return truncate(p.goal, 60)
  if (p.prompt) return truncate(p.prompt, 60)
  if (p.url) return p.url
  return event.event_type
}

watch(() => props.events.length, async () => {
  await nextTick()
  if (feedBody.value) {
    feedBody.value.scrollTop = feedBody.value.scrollHeight
  }
})
</script>

<style scoped>
.activity-feed {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 320px;
  background: #0d0d10;
  border-left: 1px solid #1e1e24;
  z-index: 50;
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 20px rgba(0,0,0,0.3);
}
.feed-header {
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
.feed-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.feed-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #555;
  transition: all 0.3s;
}
.feed-pulse.active {
  background: #10b981;
  box-shadow: 0 0 8px #10b98166;
  animation: pulse 1.5s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.5); opacity: 0.5; }
}
.feed-count {
  font-size: 10px;
  color: #555;
  font-family: 'JetBrains Mono', monospace;
}
.feed-close {
  background: none;
  border: none;
  color: #666;
  font-size: 18px;
  cursor: pointer;
}
.feed-close:hover { color: #fff; }
.feed-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}
.feed-empty {
  text-align: center;
  padding: 40px 20px;
  color: #555;
  font-size: 12px;
}
.feed-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.feed-event {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
  border-left: 3px solid transparent;
}
.feed-event:hover { background: #111114; }
.feed-event.ev-tool { border-left-color: #f97316; }
.feed-event.ev-result { border-left-color: #10b981; }
.feed-event.ev-error { border-left-color: #ef4444; }
.feed-event.ev-image { border-left-color: #a78bfa; }
.feed-event.ev-research { border-left-color: #3b82f6; }
.feed-event.ev-website { border-left-color: #f59e0b; }
.feed-event.ev-fix { border-left-color: #14b8a6; }
.feed-event.ev-agent { border-left-color: #8b5cf6; }
.feed-event.ev-complete { border-left-color: #10b981; }
.feed-event.ev-prompt { border-left-color: #6b7280; }
.feed-event-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }
.feed-event-content { flex: 1; min-width: 0; }
.feed-event-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2px;
}
.feed-event-source {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}
.feed-event-time {
  font-size: 9px;
  color: #555;
  font-family: 'JetBrains Mono', monospace;
}
.feed-event-summary {
  font-size: 10px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Feed item transitions */
.feed-item-enter-active {
  transition: all 0.3s ease;
}
.feed-item-leave-active {
  transition: all 0.2s ease;
}
.feed-item-enter-from {
  opacity: 0;
  transform: translateX(20px);
}
.feed-item-leave-to {
  opacity: 0;
  transform: translateX(-20px);
}
.feed-item-move {
  transition: transform 0.3s ease;
}
</style>
