<template>
  <div class="annotation-panel" v-if="show">
    <div class="ann-header">
      <span>💬 Comments ({{ annotations.length }})</span>
      <button class="ann-close" @click="$emit('close')">×</button>
    </div>
    <div class="ann-body">
      <div v-if="annotations.length === 0" class="ann-empty">No comments yet. Be the first!</div>
      <div v-for="ann in annotations" :key="ann.id" class="ann-item">
        <div class="ann-avatar" :style="{ background: getUserColor(ann.user_id) }">
          {{ ann.user_id.charAt(0).toUpperCase() }}
        </div>
        <div class="ann-content">
          <div class="ann-header-row">
            <span class="ann-user">{{ ann.user_id }}</span>
            <span class="ann-time">{{ formatTime(ann.timestamp) }}</span>
          </div>
          <div class="ann-text">{{ ann.text }}</div>
        </div>
      </div>
    </div>
    <div class="ann-input-area">
      <input
        v-model="newComment"
        class="ann-input"
        placeholder="Add a comment..."
        @keydown.enter="submitComment"
      />
      <button class="ann-submit" @click="submitComment" :disabled="!newComment.trim()">Send</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { formatTime } from '../composables/useEventColors'

const props = defineProps<{
  show: boolean
  annotations: any[]
  eventId: number | null
  lobbyId: string | null
  userId: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'addAnnotation', data: { event_id: number; user_id: string; text: string; lobby_id?: string }): void
}>()

const newComment = ref('')

const userColors: Record<string, string> = {}

function getUserColor(userId: string): string {
  if (!userColors[userId]) {
    const colors = ['#f97316', '#a78bfa', '#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6']
    userColors[userId] = colors[Object.keys(userColors).length % colors.length]
  }
  return userColors[userId]
}

function submitComment() {
  if (!newComment.value.trim() || !props.eventId) return
  emit('addAnnotation', {
    event_id: props.eventId,
    user_id: props.userId,
    text: newComment.value.trim(),
    lobby_id: props.lobbyId || undefined,
  })
  newComment.value = ''
}
</script>

<style scoped>
.annotation-panel {
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
.ann-header {
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
.ann-close {
  background: none;
  border: none;
  color: #666;
  font-size: 18px;
  cursor: pointer;
}
.ann-close:hover { color: #fff; }
.ann-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.ann-empty {
  text-align: center;
  padding: 40px 20px;
  color: #555;
  font-size: 12px;
}
.ann-item {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  margin-bottom: 4px;
  transition: background 0.15s;
}
.ann-item:hover { background: #111114; }
.ann-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}
.ann-content { flex: 1; min-width: 0; }
.ann-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 3px;
}
.ann-user {
  font-size: 11px;
  font-weight: 600;
  color: #ccc;
}
.ann-time {
  font-size: 9px;
  color: #555;
  font-family: 'JetBrains Mono', monospace;
}
.ann-text {
  font-size: 11px;
  color: #888;
  line-height: 1.4;
  word-break: break-word;
}
.ann-input-area {
  display: flex;
  gap: 6px;
  padding: 10px 12px;
  border-top: 1px solid #1e1e24;
  flex-shrink: 0;
}
.ann-input {
  flex: 1;
  background: #111114;
  color: #e0e0e6;
  border: 1px solid #1e1e24;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11px;
  font-family: inherit;
  outline: none;
}
.ann-input:focus { border-color: #f97316; }
.ann-submit {
  background: #f97316;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 14px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}
.ann-submit:hover { background: #e8650a; }
.ann-submit:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
