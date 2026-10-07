<template>
  <div class="collab-sidebar" v-if="show">
    <div class="sidebar-header">
      <span>Collaborators ({{ collaborators.length }})</span>
      <button class="sidebar-close" @click="$emit('close')">×</button>
    </div>
    <div class="collab-list">
      <div v-for="user in collaborators" :key="user.user_id" class="collab-card"
           @click="$emit('filterUser', user.user_id)">
        <div class="avatar" :style="{ background: avatarColor(user.user_id) }">
          {{ initials(user.user_id) }}
        </div>
        <div class="collab-info">
          <div class="collab-name">{{ user.user_id }}</div>
          <div class="collab-stats">
            <span class="collab-agent-count">{{ user.agent_count }} agent{{ user.agent_count > 1 ? 's' : '' }}</span>
            <span class="collab-events">{{ user.total_events }} events</span>
          </div>
          <div class="collab-sources">
            <span v-for="src in user.sources" :key="src" class="source-tag" :style="{ color: getSourceColor(src) }">{{ src }}</span>
          </div>
          <div class="collab-workspaces">
            <span v-for="ws in user.workspaces" :key="ws" class="ws-tag">{{ ws }}</span>
          </div>
        </div>
        <div class="collab-pulse" :class="{ active: user.is_active }"></div>
      </div>
      <div v-if="collaborators.length === 0" class="sidebar-empty">No collaborators yet.</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AgentRecord } from '../composables/useWebSocket'
import { getSourceColor, avatarColor } from '../composables/useEventColors'

const props = defineProps<{
  agents: AgentRecord[]
  show: boolean
}>()

defineEmits<{
  (e: 'close'): void
  (e: 'filterUser', userId: string): void
}>()

interface Collaborator {
  user_id: string
  agent_count: number
  total_events: number
  sources: string[]
  workspaces: string[]
  is_active: boolean
  last_seen: number
}

const collaborators = computed<Collaborator[]>(() => {
  const map = new Map<string, Collaborator>()

  for (const agent of props.agents) {
    if (!agent.user_id) continue
    const uid = agent.user_id

    if (!map.has(uid)) {
      map.set(uid, {
        user_id: uid,
        agent_count: 0,
        total_events: 0,
        sources: [],
        workspaces: [],
        is_active: false,
        last_seen: 0,
      })
    }

    const c = map.get(uid)!
    c.agent_count++
    c.total_events += agent.event_count
    c.last_seen = Math.max(c.last_seen, agent.last_event_at || 0)

    if (agent.status === 'active') c.is_active = true

    if (agent.source && !c.sources.includes(agent.source)) {
      c.sources.push(agent.source)
    }
    if (agent.workspace_id && !c.workspaces.includes(agent.workspace_id)) {
      c.workspaces.push(agent.workspace_id)
    }
  }

  return Array.from(map.values()).sort((a, b) => b.total_events - a.total_events)
})

function initials(name: string): string {
  if (!name) return '?'
  const parts = name.split(/[\s_-]/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.substring(0, 2).toUpperCase()
}

</script>

<style scoped>
.collab-sidebar {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 300px;
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
.collab-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.collab-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px;
  margin-bottom: 6px;
  background: #151518;
  border: 1px solid #2a2a2e;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
  position: relative;
}
.collab-card:hover { background: #1a1a1e; }

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
  text-transform: uppercase;
}

.collab-info {
  flex: 1;
  min-width: 0;
}
.collab-name {
  font-size: 13px;
  font-weight: 600;
  color: #e0e0e6;
}
.collab-stats {
  display: flex;
  gap: 8px;
  margin-top: 2px;
  font-size: 10px;
  color: #666;
}
.collab-agent-count { color: #c79559; }
.collab-sources {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.source-tag {
  font-size: 9px;
  font-weight: 600;
}
.collab-workspaces {
  display: flex;
  gap: 4px;
  margin-top: 3px;
  flex-wrap: wrap;
}
.ws-tag {
  font-size: 9px;
  color: #7a9c6a;
  background: #1a2a1a;
  padding: 1px 5px;
  border-radius: 3px;
}

.collab-pulse {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #333;
}
.collab-pulse.active {
  background: #10b981;
  box-shadow: 0 0 8px #10b981;
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.sidebar-empty {
  text-align: center;
  padding: 40px 20px;
  color: #555;
  font-size: 12px;
}
</style>