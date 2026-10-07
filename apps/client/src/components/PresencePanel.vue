<template>
  <div class="presence-panel" v-if="show">
    <div class="panel-header">
      <span>👥 Online ({{ users.length }})</span>
      <button class="panel-close" @click="$emit('close')">×</button>
    </div>
    <div class="panel-body">
      <div v-if="users.length === 0" class="panel-empty">No users online</div>
      <div
        v-for="user in users"
        :key="user.user_id"
        class="presence-user"
        :class="{ 'is-self': user.user_id === myUserId }"
      >
        <div class="user-avatar" :style="{ background: user.color }">
          {{ user.display_name.charAt(0).toUpperCase() }}
        </div>
        <div class="user-info">
          <div class="user-name">
            {{ user.display_name }}
            <span v-if="user.user_id === myUserId" class="self-badge">you</span>
          </div>
          <div class="user-status">
            <span class="status-dot" :class="{ online: user.online }"></span>
            <span v-if="user.current_lobby">🏠 {{ user.current_lobby }}</span>
            <span v-else-if="user.current_view">👁 {{ user.current_view }}</span>
            <span v-else>idle</span>
          </div>
        </div>
        <div class="user-last-seen">{{ timeAgo(user.last_seen) }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  show: boolean
  users: any[]
  myUserId: string
}>()

defineEmits<{
  (e: 'close'): void
}>()

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 10) return 'now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}
</script>

<style scoped>
.presence-panel {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 280px;
  background: #0d0d10;
  border-left: 1px solid #1e1e24;
  z-index: 50;
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 20px rgba(0,0,0,0.3);
}
.panel-header {
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
.panel-close {
  background: none;
  border: none;
  color: #666;
  font-size: 18px;
  cursor: pointer;
}
.panel-close:hover { color: #fff; }
.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.panel-empty {
  text-align: center;
  padding: 40px 20px;
  color: #555;
  font-size: 12px;
}
.presence-user {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  margin-bottom: 4px;
  transition: background 0.15s;
}
.presence-user:hover { background: #111114; }
.presence-user.is-self { background: #f9731608; }
.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}
.user-info { flex: 1; min-width: 0; }
.user-name {
  font-size: 12px;
  font-weight: 600;
  color: #e0e0e6;
  display: flex;
  align-items: center;
  gap: 6px;
}
.self-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: #f9731618;
  color: #f97316;
  font-weight: 600;
}
.user-status {
  font-size: 10px;
  color: #666;
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #555;
}
.status-dot.online {
  background: #10b981;
  box-shadow: 0 0 6px #10b98166;
}
.user-last-seen {
  font-size: 9px;
  color: #444;
  font-family: 'JetBrains Mono', monospace;
}
</style>
