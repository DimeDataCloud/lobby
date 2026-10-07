<!--
  Room chat.

  Deliberately plain. The board is the product; this is the channel beside it,
  and every pixel it spends competing for attention is one the artifacts lose.

  Two behaviours worth knowing:

  - The list auto-scrolls only when you are already at the bottom. Yanking the
    view down while someone is reading backscroll is the single most common way
    a chat panel becomes annoying.
  - Agents get a distinct badge. In a room where half the participants are
    processes, "who said this" is load-bearing information, not decoration.
-->
<template>
  <div class="chat">
    <div ref="listEl" class="messages" @scroll="onScroll">
      <div v-if="!messages.length" class="empty">No messages yet.</div>

      <div
        v-for="m in messages"
        :key="m.id"
        :data-id="m.id"
        class="msg"
        :class="{ mine: m.author_user === userId, withdrawn: m.deleted }"
      >
        <div class="msg-head">
          <span class="who" :style="{ color: colorFor(m.author_user) }">{{ m.author_user }}</span>
          <span v-if="m.author_kind !== 'human'" class="kind">{{ m.author_kind }}</span>
          <span class="when">{{ time(m.ts) }}</span>
          <button
            v-if="!m.deleted && m.author_user === userId"
            class="withdraw"
            title="Withdraw"
            @click="$emit('delete', m.id)"
          >✕</button>
        </div>

        <div v-if="m.deleted" class="body gone">message withdrawn</div>
        <div v-else class="body">
          <button
            v-if="m.reply_to && parentOf(m)"
            class="quote"
            :title="parentOf(m)!.body"
            @click="scrollTo(m.reply_to!)"
          >↩ {{ parentOf(m)!.author_user }}: {{ trunc(parentOf(m)!.body, 48) }}</button>
          <span>{{ m.body }}</span>
          <button
            v-if="m.ref_object_id"
            class="ref"
            title="Show the object this refers to"
            @click="$emit('focusObject', m.ref_object_id!)"
          >◈ on the board</button>
        </div>

        <button v-if="!m.deleted" class="reply" title="Reply" @click="replyTo = m">↩</button>
      </div>
    </div>

    <div v-if="replyTo" class="replying">
      replying to <strong>{{ replyTo.author_user }}</strong>
      <button @click="replyTo = null">✕</button>
    </div>

    <div v-if="refObjectId" class="replying">
      attaching <strong>selected object</strong>
      <button @click="$emit('clearRef')">✕</button>
    </div>

    <form class="composer" @submit.prevent="submit">
      <input
        v-model="draft"
        :placeholder="placeholder"
        maxlength="4000"
        @keydown.esc="replyTo = null"
      />
      <button type="submit" :disabled="!draft.trim()">↵</button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import type { ChatMessage } from '../composables/useLobby'

const props = defineProps<{
  messages: ChatMessage[]
  userId: string
  /** id of a canvas object the next message should point at */
  refObjectId?: string | null
}>()

const emit = defineEmits<{
  (e: 'send', body: string, extra: { reply_to?: number; ref_object_id?: string }): void
  (e: 'delete', id: number): void
  (e: 'focusObject', id: string): void
  (e: 'clearRef'): void
}>()

const draft = ref('')
const replyTo = ref<ChatMessage | null>(null)
const listEl = ref<HTMLElement | null>(null)
const pinnedToBottom = ref(true)

const placeholder = computed(() =>
  replyTo.value ? `Reply to ${replyTo.value.author_user}…` : 'Message the room…'
)

const byId = computed(() => {
  const m = new Map<number, ChatMessage>()
  for (const x of props.messages) m.set(x.id, x)
  return m
})
function parentOf(m: ChatMessage): ChatMessage | undefined {
  return m.reply_to != null ? byId.value.get(m.reply_to) : undefined
}

function submit() {
  const body = draft.value.trim()
  if (!body) return
  emit('send', body, {
    reply_to: replyTo.value?.id,
    ref_object_id: props.refObjectId || undefined,
  })
  draft.value = ''
  replyTo.value = null
  pinnedToBottom.value = true
}

function onScroll() {
  const el = listEl.value
  if (!el) return
  // 24px of slack: "close enough to the bottom" should survive sub-pixel
  // scroll positions and a half-rendered last line.
  pinnedToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

function scrollTo(id: number) {
  const el = listEl.value?.querySelector(`[data-id="${id}"]`) as HTMLElement | null
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

watch(() => props.messages.length, async () => {
  if (!pinnedToBottom.value) return
  await nextTick()
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
})

onMounted(async () => {
  await nextTick()
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
})

function colorFor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return `hsl(${Math.abs(h) % 360} 70% 62%)`
}
function time(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function trunc(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
</script>

<style scoped>
.chat { display: flex; flex-direction: column; min-height: 0; flex: 1; }

.messages { flex: 1; overflow-y: auto; min-height: 0; padding-right: 2px; }
.empty { color: #45454f; font: 400 12px ui-sans-serif, system-ui; padding: 6px 0; }

.msg { position: relative; padding: 5px 22px 5px 0; border-radius: 5px; }
.msg:hover { background: #131318; }
.msg:hover .reply { opacity: 1; }
.msg.withdrawn { opacity: .55; }

.msg-head { display: flex; align-items: baseline; gap: 6px; }
.who { font: 600 11px ui-sans-serif, system-ui; }
.kind {
  font: 500 8px ui-monospace, monospace; text-transform: uppercase; letter-spacing: .08em;
  color: #0a0a0c; background: #6366f1; border-radius: 3px; padding: 1px 3px;
}
.when { font: 400 9px ui-monospace, monospace; color: #45454f; }
.withdraw {
  margin-left: auto; background: none; border: none; color: #5a5a66;
  cursor: pointer; font-size: 10px; padding: 0 2px;
}
.withdraw:hover { color: #ef4444; }

.body {
  font: 400 12px/1.45 ui-sans-serif, system-ui; color: #c8c8d2;
  word-break: break-word; white-space: pre-wrap;
}
.body.gone { color: #4a4a55; font-style: italic; }

.quote, .ref {
  display: block; margin: 2px 0;
  background: #16161c; border: 1px solid #26262e; border-radius: 4px;
  color: #7a7a88; padding: 2px 5px; cursor: pointer;
  font: 400 10px ui-sans-serif, system-ui; text-align: left; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.quote:hover, .ref:hover { border-color: #f97316; color: #f0a868; }

.reply {
  position: absolute; right: 2px; top: 4px; opacity: 0;
  background: none; border: none; color: #5a5a66; cursor: pointer; font-size: 11px;
  transition: opacity .12s ease;
}
.reply:hover { color: #f97316; }

.replying {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 6px; margin-top: 4px;
  background: #16161c; border: 1px solid #26262e; border-radius: 5px;
  font: 400 10px ui-sans-serif, system-ui; color: #8a8a96;
}
.replying strong { color: #c8c8d2; font-weight: 600; }
.replying button { margin-left: auto; background: none; border: none; color: #5a5a66; cursor: pointer; }

.composer { display: flex; gap: 6px; margin-top: 8px; }
.composer input {
  flex: 1; min-width: 0;
  background: #131318; border: 1px solid #26262e; border-radius: 6px;
  color: #e2e2e8; padding: 7px 9px;
  font: 400 12px ui-sans-serif, system-ui; outline: none;
}
.composer input:focus { border-color: #f97316; }
.composer button {
  background: #f97316; border: none; border-radius: 6px;
  color: #0a0a0c; width: 32px; cursor: pointer; font-size: 13px; font-weight: 700;
}
.composer button:disabled { background: #26262e; color: #55555f; cursor: default; }
</style>
