<template>
  <div class="event-card" :style="{ borderColor: sourceColor }" @click.stop="onClick">
    <!-- Card header -->
    <div class="card-header">
      <div class="card-header-left">
        <span class="card-source" :style="{ color: sourceColor }">{{ event.source }}</span>
        <span class="card-type-badge">{{ eventTypeLabel }}</span>
      </div>
      <div class="card-header-right">
        <span class="card-time">{{ formatTime(event.timestamp) }}</span>
        <button class="card-copy-btn" @click.stop="copyPayload" title="Copy payload">📋</button>
      </div>
    </div>

    <!-- Card content based on event type -->
    <div class="card-content">
      
      <!-- Tool call: terminal/command -->
      <div v-if="toolKind === 'command'" class="content-terminal">
        <div class="content-label">⌨️ {{ event.payload.tool_name }}</div>
        <pre class="code-block"><code>{{ commandText || 'command' }}</code></pre>
        <div v-if="exitCode !== undefined" class="exit-code" :class="{ success: exitCode === 0 }">
          Exit: {{ exitCode }}
        </div>
      </div>

      <!-- Tool call: file operations -->
      <div v-else-if="toolKind" class="content-file">
        <div class="content-label">
          📄 {{ toolKind === 'write' ? 'File Written' : toolKind === 'patch' ? 'File Edited' : 'File Read' }}
        </div>
        <div class="file-path">{{ filePath || 'unknown' }}</div>
        <div class="file-action">
          <span class="action-badge" :class="toolKind === 'write' ? 'write' : toolKind === 'patch' ? 'patch' : 'read'">
            {{ toolKind === 'write' ? 'Created' : toolKind === 'patch' ? 'Patched' : 'Read' }}
          </span>
          <span v-if="event.payload.lines_written" class="file-meta">{{ event.payload.lines_written }} lines</span>
          <span v-else-if="event.payload.diff_lines" class="file-meta">{{ event.payload.diff_lines }} changes</span>
        </div>
        <pre v-if="event.payload.preview" class="code-preview"><code>{{ truncate(event.payload.preview, 200) }}</code></pre>
      </div>

      <!-- Image generated -->
      <div v-else-if="event.event_type === 'image_generated' || event.payload.image_url" class="content-image">
        <div class="content-label">🖼️ Image Generated</div>
        <img :src="event.payload.image_url || event.payload.url" :alt="event.payload.prompt || 'Generated image'" class="generated-image" loading="lazy" />
        <div v-if="event.payload.prompt" class="image-prompt">{{ truncate(event.payload.prompt, 100) }}</div>
        <a v-if="event.payload.download_url" :href="event.payload.download_url" target="_blank" class="download-link">⬇ Download</a>
      </div>

      <!-- Research/files produced -->
      <div v-else-if="event.event_type === 'research_complete' || event.payload.files" class="content-research">
        <div class="content-label">📚 Research Complete</div>
        <div v-if="event.payload.topic" class="research-topic">{{ event.payload.topic }}</div>
        <div class="files-list">
          <div v-for="(file, idx) in (event.payload.files || []).slice(0, 5)" :key="idx" class="file-item">
            <span class="file-icon">📎</span>
            <span class="file-name">{{ file.name || file }}</span>
            <span v-if="file.size" class="file-size">{{ formatFileSize(file.size) }}</span>
            <a v-if="file.url" :href="file.url" target="_blank" class="file-link" @click.stop>Open</a>
          </div>
          <div v-if="(event.payload.files || []).length > 5" class="file-more">+{{ event.payload.files.length - 5 }} more files</div>
        </div>
        <div v-if="event.payload.summary" class="research-summary">{{ truncate(event.payload.summary, 150) }}</div>
      </div>

      <!-- Website/HTML produced -->
      <div v-else-if="event.event_type === 'website_deployed' || event.payload.url || event.payload.deploy_url" class="content-website">
        <div class="content-label">🌐 Website Deployed</div>
        <div v-if="event.payload.title" class="website-title">{{ event.payload.title }}</div>
        <a :href="event.payload.url || event.payload.deploy_url" target="_blank" class="website-link" @click.stop>
          🔗 {{ event.payload.url || event.payload.deploy_url }}
        </a>
        <img v-if="event.payload.screenshot_url" :src="event.payload.screenshot_url" class="website-preview" loading="lazy" />
        <div v-if="event.payload.files_deployed" class="deploy-meta">{{ event.payload.files_deployed }} files deployed</div>
      </div>

      <!-- Code fix/diff -->
      <div v-else-if="event.event_type === 'code_fixed' || event.payload.diff" class="content-diff">
        <div class="content-label">🔧 Code Fix</div>
        <div v-if="event.payload.file" class="diff-file">File: {{ event.payload.file }}</div>
        <pre v-if="event.payload.diff" class="diff-block"><code>{{ event.payload.diff }}</code></pre>
        <div v-if="event.payload.description" class="fix-description">{{ event.payload.description }}</div>
      </div>

      <!-- Delegation/subagent -->
      <div v-else-if="['delegation_start', 'subagent_start'].includes(event.event_type)" class="content-delegation">
        <div class="content-label">🤖 Subagent Started</div>
        <div v-if="event.payload.goal" class="subagent-goal">{{ truncate(event.payload.goal, 120) }}</div>
        <div class="subagent-meta">
          <span v-if="event.payload.task_count">{{ event.payload.task_count }} tasks</span>
          <span v-if="event.payload.agent_id">Agent: {{ shortId(event.payload.agent_id) }}</span>
        </div>
      </div>

      <!-- Subagent complete -->
      <div v-else-if="event.event_type === 'subagent_stop'" class="content-delegation-complete">
        <div class="content-label">✅ Subagent Complete</div>
        <div v-if="event.payload.exit_reason" class="exit-reason">{{ event.payload.exit_reason }}</div>
        <div v-if="event.payload.summary" class="subagent-summary">{{ truncate(event.payload.summary, 150) }}</div>
        <a v-if="event.payload.transcript_url" :href="event.payload.transcript_url" target="_blank" class="transcript-link" @click.stop>View Transcript</a>
      </div>

      <!-- User prompt -->
      <div v-else-if="event.event_type === 'user_prompt'" class="content-prompt">
        <div class="content-label">💬 User Prompt</div>
        <div class="prompt-text">{{ event.payload.prompt || event.payload.message_preview || '...' }}</div>
      </div>

      <!-- Error -->
      <div v-else-if="event.event_type === 'error'" class="content-error">
        <div class="content-label">❌ Error</div>
        <pre class="error-block"><code>{{ event.payload.error || event.payload.raw || event.payload.message }}</code></pre>
      </div>

      <!-- Generic fallback -->
      <div v-else class="content-generic">
        <div class="content-label">{{ getEventEmoji(event.event_type) }} {{ formatEventType(event.event_type) }}</div>
        <div v-if="event.summary" class="generic-summary">{{ event.summary }}</div>
        <pre v-else-if="event.payload" class="generic-payload"><code>{{ JSON.stringify(event.payload, null, 2).slice(0, 300) }}</code></pre>
      </div>
    </div>

    <!-- Card footer -->
    <div class="card-footer">
      <div class="card-footer-left">
        <span v-if="event.model" class="card-model">{{ event.model }}</span>
        <span v-if="event.provider" class="card-provider">{{ event.provider }}</span>
        <span v-if="event.lobby_id" class="card-lobby">🏠 {{ event.lobby_id }}</span>
        <span v-if="event.user_id" class="card-user">{{ event.user_id }}</span>
      </div>
      <button v-if="isExpandable" class="expand-btn" @click.stop="onExpand">
        {{ expanded ? '▲ Less' : '▼ More' }}
      </button>
    </div>

    <!-- Expanded content -->
    <transition name="expand">
      <div v-if="expanded" class="card-expanded">
        <pre class="full-payload"><code>{{ JSON.stringify(event.payload, null, 2) }}</code></pre>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { AgentEvent } from '../types'
import { getSourceColor, getEventEmoji, formatTime, shortId, truncate } from '../composables/useEventColors'

const props = defineProps<{
  event: AgentEvent
  compact?: boolean
  /** Forced open by the canvas at high zoom (level-of-detail 'detail'). */
  expanded?: boolean
}>()

const emit = defineEmits<{
  (e: 'click', event: AgentEvent): void
  (e: 'expand', event: AgentEvent): void
}>()

const localExpanded = ref(false)
const expanded = computed(() => props.expanded || localExpanded.value)

const sourceColor = computed(() => getSourceColor(props.event.source))

// ---------------------------------------------------------------------------
// Tool-name normalisation.
//
// Every agent system names its tools differently, and the board must render all
// of them. The original renderers matched one vocabulary ('terminal',
// 'write_file', 'patch', 'read_file'); Claude Code emits 'Bash', 'Write',
// 'Edit', 'MultiEdit', 'Read', so every real Claude Code event fell through to
// the raw JSON fallback and the board looked broken on first genuine use.
// Payload shapes differ too — some producers put `command` at the top level,
// Claude Code nests it under `tool_input`. Normalise both, and keep the map
// open so a new bot's vocabulary is one entry rather than a new renderer.
// ---------------------------------------------------------------------------

const TOOL_KINDS: Record<string, 'command' | 'write' | 'patch' | 'read'> = {
  terminal: 'command', bash: 'command', shell: 'command', run: 'command',
  write_file: 'write', write: 'write', create_file: 'write',
  patch: 'patch', edit: 'patch', multiedit: 'patch', apply_patch: 'patch',
  read_file: 'read', read: 'read',
}

const toolKind = computed(() => {
  const name = String(props.event.payload?.tool_name || '').toLowerCase()
  return TOOL_KINDS[name]
})

const commandText = computed(() => {
  const p = props.event.payload || {}
  return p.command || p.tool_input?.command || p.input?.command || ''
})

const filePath = computed(() => {
  const p = props.event.payload || {}
  return p.path || p.file_path || p.tool_input?.file_path || p.tool_input?.path || p.input?.file_path || ''
})

const exitCode = computed(() => {
  const p = props.event.payload || {}
  return p.exit_code !== undefined ? p.exit_code : p.tool_result?.exit_code
})

const eventTypeLabel = computed(() => {
  const type = props.event.event_type
  return type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
})

const isExpandable = computed(() => {
  const p = props.event.payload
  return Object.keys(p).length > 2 || p.diff || p.command || p.files
})

function onClick() {
  emit('click', props.event)
}

function onExpand() {
  localExpanded.value = !localExpanded.value
  emit('expand', props.event)
}

function copyPayload() {
  navigator.clipboard.writeText(JSON.stringify(props.event.payload, null, 2))
}

function formatEventType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
</script>

<style scoped>
.event-card {
  background: #111114;
  border: 1px solid #1e1e24;
  border-left: 3px solid #333;
  border-radius: 8px;
  padding: 10px 14px;
  cursor: pointer;
  transition: all 0.15s ease;
  position: relative;
}
.event-card:hover {
  background: #15151a;
  border-color: #2a2a30;
  box-shadow: 0 2px 12px rgba(0,0,0,0.3);
  transform: translateY(-1px);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.card-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
.card-source {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.card-type-badge {
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 3px;
  background: #1a1a20;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}
.card-time {
  font-size: 10px;
  color: #555;
  font-family: 'JetBrains Mono', monospace;
}
.card-copy-btn {
  background: transparent;
  border: none;
  color: #555;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  transition: all 0.15s;
  opacity: 0;
}
.event-card:hover .card-copy-btn { opacity: 1; }
.card-copy-btn:hover { background: #1a1a20; color: #ccc; }

.card-content { margin-top: 2px; }
.content-label {
  font-size: 10px;
  font-weight: 600;
  color: #888;
  margin-bottom: 6px;
}

/* Terminal */
.content-terminal .code-block {
  background: #0a0a0c;
  padding: 8px 10px;
  border-radius: 5px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: #e0e0e6;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.4;
  border: 1px solid #1a1a20;
}
.exit-code {
  margin-top: 4px;
  font-size: 10px;
  color: #666;
  font-family: 'JetBrains Mono', monospace;
}
.exit-code.success { color: #10b981; }

/* File operations */
.file-path {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: #ccc;
  margin-bottom: 4px;
}
.content-file .code-preview {
  background: #0a0a0c;
  padding: 6px 8px;
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #777;
  white-space: pre-wrap;
  margin-top: 6px;
  border: 1px solid #1a1a20;
  line-height: 1.4;
}
.file-action { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
.action-badge {
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 3px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.action-badge.write { background: #10b98115; color: #10b981; }
.action-badge.patch { background: #f9731615; color: #f97316; }
.action-badge.read { background: #3b82f615; color: #3b82f6; }
.file-meta { font-size: 10px; color: #555; }

/* Image */
.content-image .generated-image {
  width: 100%;
  max-height: 200px;
  object-fit: cover;
  border-radius: 6px;
  margin-top: 4px;
  background: #0a0a0c;
  border: 1px solid #1a1a20;
}
.image-prompt {
  font-size: 10px;
  color: #777;
  margin-top: 6px;
  font-style: italic;
  line-height: 1.4;
}
.download-link {
  display: inline-block;
  margin-top: 6px;
  font-size: 10px;
  color: #f97316;
  text-decoration: none;
  font-weight: 600;
}
.download-link:hover { text-decoration: underline; }

/* Research */
.research-topic {
  font-size: 12px;
  font-weight: 600;
  color: #e0e0e6;
  margin-bottom: 6px;
}
.files-list { display: flex; flex-direction: column; gap: 3px; margin-top: 4px; }
.file-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  background: #0a0a0c;
  padding: 5px 8px;
  border-radius: 4px;
  border: 1px solid #1a1a20;
}
.file-icon { font-size: 12px; }
.file-name { flex: 1; color: #ccc; font-family: 'JetBrains Mono', monospace; font-size: 10px; }
.file-size { color: #555; font-size: 9px; }
.file-link {
  color: #3b82f6;
  font-size: 10px;
  text-decoration: none;
  font-weight: 600;
}
.file-link:hover { text-decoration: underline; }
.file-more {
  font-size: 10px;
  color: #555;
  text-align: center;
  padding: 4px;
}
.research-summary {
  font-size: 10px;
  color: #777;
  margin-top: 8px;
  line-height: 1.5;
}

/* Website */
.website-title {
  font-size: 12px;
  font-weight: 600;
  color: #e0e0e6;
  margin-bottom: 4px;
}
.website-link {
  display: block;
  font-size: 10px;
  color: #f97316;
  text-decoration: none;
  word-break: break-all;
  font-family: 'JetBrains Mono', monospace;
}
.website-link:hover { text-decoration: underline; }
.website-preview {
  width: 100%;
  max-height: 150px;
  object-fit: cover;
  border-radius: 6px;
  margin-top: 8px;
  background: #0a0a0c;
  border: 1px solid #1a1a20;
}
.deploy-meta {
  font-size: 10px;
  color: #555;
  margin-top: 4px;
}

/* Diff */
.diff-file {
  font-size: 11px;
  color: #888;
  margin-bottom: 4px;
  font-family: 'JetBrains Mono', monospace;
}
.diff-block {
  background: #0a0a0c;
  padding: 8px 10px;
  border-radius: 5px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #e0e0e6;
  white-space: pre-wrap;
  max-height: 150px;
  overflow-y: auto;
  line-height: 1.4;
  border: 1px solid #1a1a20;
}
.fix-description {
  font-size: 10px;
  color: #777;
  margin-top: 6px;
  line-height: 1.4;
}

/* Delegation */
.subagent-goal {
  font-size: 11px;
  color: #ccc;
  line-height: 1.5;
}
.subagent-meta {
  display: flex;
  gap: 12px;
  margin-top: 6px;
  font-size: 10px;
  color: #555;
}
.transcript-link {
  display: inline-block;
  margin-top: 6px;
  font-size: 10px;
  color: #3b82f6;
  text-decoration: none;
  font-weight: 600;
}
.transcript-link:hover { text-decoration: underline; }

/* Prompt */
.prompt-text {
  font-size: 11px;
  color: #ccc;
  line-height: 1.5;
  background: #0a0a0c;
  padding: 8px 10px;
  border-radius: 5px;
  border: 1px solid #1a1a20;
}

/* Error */
.error-block {
  background: #ef444412;
  color: #fca5a5;
  padding: 8px 10px;
  border-radius: 5px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  white-space: pre-wrap;
  line-height: 1.4;
  border: 1px solid #ef444422;
}

/* Generic */
.generic-summary {
  font-size: 11px;
  color: #ccc;
  line-height: 1.5;
}
.generic-payload {
  background: #0a0a0c;
  padding: 8px 10px;
  border-radius: 5px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: #666;
  white-space: pre-wrap;
  max-height: 100px;
  overflow-y: auto;
  border: 1px solid #1a1a20;
}

/* Footer */
.card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #1a1a20;
}
.card-footer-left {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.card-model, .card-provider {
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 3px;
  background: #1a1a20;
  color: #777;
  font-family: 'JetBrains Mono', monospace;
}
.card-lobby {
  font-size: 9px;
  color: #f97316;
  font-weight: 600;
}
.card-user {
  font-size: 9px;
  color: #c79559;
}
.expand-btn {
  background: transparent;
  border: 1px solid #2a2a30;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 9px;
  color: #666;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.expand-btn:hover {
  background: #1a1a20;
  color: #ccc;
  border-color: #444;
}

/* Expanded */
.card-expanded {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #2a2a30;
}
.full-payload {
  background: #0a0a0c;
  padding: 10px;
  border-radius: 5px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: #666;
  white-space: pre-wrap;
  max-height: 300px;
  overflow-y: auto;
  line-height: 1.5;
  border: 1px solid #1a1a20;
}

/* Expand transition */
.expand-enter-active {
  transition: all 0.2s ease;
}
.expand-leave-active {
  transition: all 0.15s ease;
}
.expand-enter-from, .expand-leave-to {
  opacity: 0;
  max-height: 0;
  overflow: hidden;
}
</style>
