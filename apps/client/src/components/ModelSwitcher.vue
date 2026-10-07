<template>
  <div class="switcher-sidebar" v-if="show">
    <div class="sidebar-header">
      <span>Model Switcher</span>
      <button class="sidebar-close" @click="$emit('close')">×</button>
    </div>
    <div class="switcher-body">
      <!-- User selector -->
      <div class="switcher-section" v-if="users.length > 1">
        <div class="section-label">Person</div>
        <div class="user-row">
          <div
            v-for="u in users"
            :key="u.user_id"
            class="user-chip"
            :class="{ selected: selectedUser === u.user_id }"
            @click="selectedUser = u.user_id"
          >
            <div class="chip-avatar" :style="{ background: avatarColor(u.user_id) }">{{ initials(u.user_id) }}</div>
            <span class="chip-name">{{ u.user_id }}</span>
          </div>
        </div>
      </div>

      <div class="switcher-section">
        <div class="section-label">Current</div>
        <div class="current-model" :style="{ borderColor: currentColor }">
          <div class="model-icon">🔄</div>
          <div class="model-info">
            <div class="model-name">{{ currentModel || 'unknown' }}</div>
            <div class="model-provider">{{ currentProvider || 'no provider' }}</div>
          </div>
          <div class="current-user" v-if="selectedUser">{{ selectedUser }}</div>
        </div>
      </div>

      <div class="switcher-section">
        <div class="section-label">Models Used{{ selectedUser ? ' by ' + selectedUser : '' }}</div>
        <div class="model-list">
          <div
            v-for="m in availableModels"
            :key="m.model"
            class="model-option"
            :class="{ active: m.model === currentModel }"
            @click="$emit('switch', m)"
          >
            <div class="model-option-name">{{ m.model }}</div>
            <div class="model-option-provider" :style="{ color: providerColor(m.provider) }">{{ m.provider }}</div>
            <div class="model-option-stats" v-if="m.last_used">last: {{ formatTime(m.last_used) }} · {{ m.event_count }} evts</div>
          </div>
          <div v-if="availableModels.length === 0" class="empty-text">No models seen yet.</div>
        </div>
      </div>

      <div class="switcher-section">
        <div class="section-label">Switch History{{ selectedUser ? ' · ' + selectedUser : '' }}</div>
        <div class="switch-history">
          <div v-for="sw in recentSwitches" :key="sw.id" class="switch-entry">
            <span class="switch-arrow">{{ sw.from_model }}</span>
            <span class="switch-icon">→</span>
            <span class="switch-arrow" :style="{ color: providerColor(sw.to_provider) }">{{ sw.to_model }}</span>
            <span class="switch-time">{{ formatTime(sw.timestamp) }}</span>
          </div>
          <div v-if="recentSwitches.length === 0" class="empty-text">No switches recorded.</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { AgentEvent } from '../types'
import { formatTime, avatarColor } from '../composables/useEventColors'

const props = defineProps<{
  events: AgentEvent[]
  currentModel?: string
  currentProvider?: string
  show: boolean
}>()

defineEmits<{
  (e: 'close'): void
  (e: 'switch', model: { model: string; provider: string }): void
}>()

// Auto-select first user, track selected user
const selectedUser = ref<string>('')

// Build user list from events
const users = computed(() => {
  const set = new Set<string>()
  for (const ev of props.events) {
    if (ev.user_id) set.add(ev.user_id)
  }
  return Array.from(set).map(uid => ({ user_id: uid }))
})

// Auto-select first user if none selected
watch(() => users.value.length, (n) => {
  if (n > 0 && !selectedUser.value) {
    selectedUser.value = users.value[0].user_id
  }
})

// Filter events to selected user (or all if none)
const userEvents = computed(() => {
  if (!selectedUser.value) return props.events
  return props.events.filter(e => e.user_id === selectedUser.value)
})

interface ModelOption {
  model: string
  provider: string
  last_used: number
  event_count: number
}

const availableModels = computed<ModelOption[]>(() => {
  const map = new Map<string, ModelOption>()
  for (const ev of userEvents.value) {
    if (!ev.model) continue
    const key = `${ev.model}@${ev.provider || ''}`
    if (!map.has(key)) {
      map.set(key, {
        model: ev.model,
        provider: ev.provider || 'unknown',
        last_used: ev.timestamp,
        event_count: 0,
      })
    }
    const m = map.get(key)!
    m.event_count++
    m.last_used = Math.max(m.last_used, ev.timestamp)
  }
  return Array.from(map.values()).sort((a, b) => b.last_used - a.last_used)
})

const recentSwitches = computed(() => {
  return userEvents.value
    .filter(e => e.event_type === 'model_switch')
    .slice(-10)
    .reverse()
    .map(e => ({
      id: e.id,
      from_model: e.payload.from_model,
      from_provider: e.payload.from_provider,
      to_model: e.payload.to_model,
      to_provider: e.payload.to_provider,
      timestamp: e.timestamp,
    }))
})

const currentColor = computed(() => providerColor(props.currentProvider || ''))

function providerColor(provider: string): string {
  const colors: Record<string, string> = {
    ollama: '#f97316',
    anthropic: '#a78bfa',
    openai: '#10b981',
    google: '#3b82f6',
    deepseek: '#ec4899',
    xai: '#6b8aad',
  }
  return colors[provider] || '#888'
}

function initials(name: string): string {
  if (!name) return '?'
  const parts = name.split(/[\s_-]/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.substring(0, 2).toUpperCase()
}

</script>

<style scoped>
.switcher-sidebar {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 260px;
  background: #111113;
  border-left: 1px solid #2a2a2e;
  z-index: 50;
  display: flex;
  flex-direction: column;
}
.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid #2a2a2e;
  font-size: 13px;
  font-weight: 600;
  color: #e0e0e6;
}
.sidebar-close {
  background: none;
  border: none;
  color: #666;
  font-size: 18px;
  cursor: pointer;
}
.switcher-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.switcher-section {
  margin-bottom: 16px;
}
.section-label {
  font-size: 10px;
  text-transform: uppercase;
  color: #666;
  margin-bottom: 6px;
  padding-left: 2px;
}
.user-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.user-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 4px 4px;
  background: #151518;
  border: 1px solid #2a2a2e;
  border-radius: 20px;
  cursor: pointer;
  transition: background 0.15s;
}
.user-chip:hover { background: #1a1a1e; }
.user-chip.selected {
  border-color: #f97316;
  background: #1a1208;
}
.chip-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  color: #fff;
  text-transform: uppercase;
}
.chip-name {
  font-size: 11px;
  color: #ccc;
}
.current-model {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  background: #151518;
  border: 1px solid #2a2a2e;
  border-left: 3px solid #333;
  border-radius: 6px;
  position: relative;
}
.model-icon { font-size: 20px; }
.model-name {
  font-size: 13px;
  font-weight: 600;
  color: #e0e0e6;
}
.model-provider {
  font-size: 11px;
  color: #888;
}
.current-user {
  position: absolute;
  top: 8px;
  right: 10px;
  font-size: 9px;
  color: #c79559;
}
.model-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.model-option {
  padding: 8px 10px;
  background: #151518;
  border: 1px solid #2a2a2e;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}
.model-option:hover { background: #1a1a1e; }
.model-option.active {
  border-color: #f97316;
  background: #1a1208;
}
.model-option-name {
  font-size: 12px;
  font-weight: 600;
  color: #e0e0e6;
}
.model-option-provider {
  font-size: 10px;
  font-weight: 600;
  margin-top: 1px;
}
.model-option-stats {
  font-size: 9px;
  color: #555;
  margin-top: 2px;
}
.switch-history {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.switch-entry {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  padding: 4px 8px;
  background: #0d0d0f;
  border-radius: 4px;
  font-size: 10px;
}
.switch-arrow { color: #aaa; }
.switch-icon { color: #555; }
.switch-time { color: #444; margin-left: auto; }
.empty-text {
  color: #555;
  font-size: 11px;
  padding: 8px;
}
</style>