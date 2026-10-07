<!--
  An artifact a bot put on the board.

  Distinct from EventCard, which renders an observed *event* — something an agent
  was seen doing. This renders something an agent deliberately posted through
  lobby_post, where the content lives in props rather than in an event payload.

  These were previously falling through the canvas's `v-else` and drawing as a
  grey box containing the word "artifact": the backend accepted them, production
  verified them, and the board showed nothing. Anything a bot can post has to
  have a renderer here.
-->
<template>
  <article class="art" :class="[`k-${kind}`, { stale: !!supersededBy, expanded }]">
    <header class="art-h">
      <span class="art-icon">{{ ICONS[kind] || '◻' }}</span>
      <span class="art-title" :title="title">{{ title }}</span>
      <span class="art-handle" v-if="handle">#{{ handle }}</span>
    </header>

    <div class="art-meta">
      <span class="art-dot" :style="{ background: authorColor }" />
      <span class="art-author">{{ author }}</span>
      <span class="art-time">{{ ago }}</span>
      <span v-if="pins" class="art-pins" :title="`${pins} unresolved`">💬 {{ pins }}</span>
    </div>

    <!-- Supersession reads as historical, not broken. The old version stays on
         the board and stays openable, because the history is the point. -->
    <div v-if="supersededBy" class="art-flag stale-flag">
      superseded by #{{ supersededBy }}
    </div>
    <div v-else-if="revises" class="art-flag">revises #{{ revises }}</div>

    <div class="art-body">
      <!-- diff -->
      <pre v-if="kind === 'diff'" class="diff"><span
        v-for="(l, i) in diffLines" :key="i"
        :class="l.cls">{{ l.text }}</span></pre>

      <!-- image: a URL or data URI in the body -->
      <div v-else-if="kind === 'image' && imageSrc" class="img-wrap">
        <img :src="imageSrc" :alt="title" loading="lazy" />
      </div>

      <!-- data: an array of objects becomes a table. One template, so the
           "more rows" line stays inside this v-if chain; as a sibling v-if it
           started a second chain whose v-else printed the raw body under
           every diff, image and table card. -->
      <template v-else-if="kind === 'data' && table">
        <table class="tbl">
          <thead><tr><th v-for="c in table.cols" :key="c">{{ c }}</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in table.rows" :key="i">
              <td v-for="c in table.cols" :key="c">{{ cell(r[c]) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="table.more" class="more">+{{ table.more }} more rows</div>
      </template>

      <!-- link -->
      <a v-else-if="kind === 'link' && linkHref" class="link" :href="linkHref"
         target="_blank" rel="noopener noreferrer" @pointerdown.stop>
        <span class="link-host">{{ linkHost }}</span>
        <span class="link-url">{{ linkHref }}</span>
      </a>

      <!-- doc / note / anything else -->
      <div v-else class="text">{{ body }}</div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { colorFor } from '../composables/useEventColors'

const props = defineProps<{
  object: any
  expanded?: boolean
  pins?: number
}>()

const ICONS: Record<string, string> = {
  diff: '◈', doc: '📄', image: '🖼', data: '▦', link: '🔗', note: '▭', error: '💥',
}

const p = computed(() => props.object?.props || {})
const kind = computed(() => String(p.value.agent_kind || 'note'))
const title = computed(() => String(p.value.title || '(untitled)'))
const body = computed(() => String(p.value.body || ''))
const handle = computed(() => props.object?.handle || '')
const revises = computed(() => p.value.supersedes || null)
const supersededBy = computed(() => p.value.superseded_by || null)
const author = computed(() => props.object?.created_by || 'unknown')
const authorColor = computed(() => colorFor(author.value))

const ago = computed(() => {
  const d = Date.now() - Number(props.object?.updated_at || 0)
  if (d < 60_000) return `${Math.max(1, Math.round(d / 1000))}s ago`
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`
  return `${Math.round(d / 86_400_000)}d ago`
})

/** Colour the +/- lines. Capped: a 4,000-line diff must not hang the board. */
const diffLines = computed(() => {
  const limit = props.expanded ? 200 : 24
  return body.value.split('\n').slice(0, limit).map((text) => ({
    text,
    cls: text.startsWith('+') && !text.startsWith('+++') ? 'add'
       : text.startsWith('-') && !text.startsWith('---') ? 'del'
       : text.startsWith('@@') ? 'hunk' : '',
  }))
})

const imageSrc = computed(() => {
  const b = body.value.trim()
  return /^(https?:\/\/|data:image\/)/.test(b) ? b : null
})

const linkHref = computed(() => {
  const b = body.value.trim()
  return /^https?:\/\//.test(b) ? b : null
})
const linkHost = computed(() => {
  try { return new URL(linkHref.value!).hostname.replace(/^www\./, '') } catch { return '' }
})

/** An array of objects renders as a table; anything else falls back to text. */
const table = computed(() => {
  const b = body.value.trim()
  if (!b.startsWith('[')) return null
  try {
    const rows = JSON.parse(b)
    if (!Array.isArray(rows) || !rows.length || typeof rows[0] !== 'object') return null
    const cols = [...new Set(rows.flatMap((r: any) => Object.keys(r)))].slice(0, 5)
    const show = props.expanded ? 20 : 5
    return { cols, rows: rows.slice(0, show), more: Math.max(0, rows.length - show) }
  } catch { return null }
})

const cell = (v: any) =>
  v === null || v === undefined ? '—'
  : typeof v === 'object' ? JSON.stringify(v).slice(0, 30)
  : String(v).slice(0, 40)
</script>

<style scoped>
.art {
  display: flex; flex-direction: column; height: 100%; overflow: hidden;
  background: #16161c; border: 1px solid #26262e; border-radius: 10px;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}
.art.stale { opacity: .55; }
.art.stale:hover { opacity: .85; }

.art-h {
  display: flex; align-items: center; gap: 7px; flex-shrink: 0;
  padding: 9px 11px 6px;
}
.art-icon { font-size: 12px; }
.art-title {
  flex: 1; font-size: 12.5px; font-weight: 600; color: #e8e8ee;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.art-handle {
  font: 500 10px ui-monospace, 'JetBrains Mono', monospace;
  color: #6a6a76; background: #1f1f26; border-radius: 4px; padding: 1px 5px;
}

.art-meta {
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
  padding: 0 11px 8px; font-size: 10.5px; color: #6a6a76;
}
.art-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.art-author { color: #8a8a96; }
.art-pins { margin-left: auto; color: #f97316; }

.art-flag {
  flex-shrink: 0; margin: 0 11px 8px;
  font-size: 9.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
  color: #7a7a86; background: #1c1c22; border-radius: 4px; padding: 3px 7px;
  align-self: flex-start;
}
.stale-flag { color: #fbbf24; background: rgba(251,191,36,.1); }

.art-body {
  flex: 1; min-height: 0; overflow: hidden;
  padding: 0 11px 11px; font-size: 11.5px; color: #a8a8b4;
}
.art.expanded .art-body { overflow: auto; }

.diff {
  font: 400 10.5px/1.55 ui-monospace, 'JetBrains Mono', monospace;
  white-space: pre; overflow: hidden; display: flex; flex-direction: column;
}
.diff .add { color: #4ade80; }
.diff .del { color: #f87171; }
.diff .hunk { color: #60a5fa; }

.img-wrap { height: 100%; display: grid; place-items: center; overflow: hidden; }
.img-wrap img { max-width: 100%; max-height: 100%; border-radius: 5px; }

.tbl { width: 100%; border-collapse: collapse; font-size: 10.5px; }
.tbl th {
  text-align: left; font-size: 8.5px; font-weight: 700; letter-spacing: .07em;
  text-transform: uppercase; color: #6a6a76; padding: 3px 6px 3px 0;
  border-bottom: 1px solid #26262e; white-space: nowrap;
}
.tbl td {
  padding: 4px 6px 4px 0; color: #a8a8b4;
  border-bottom: 1px solid #1c1c22; white-space: nowrap;
}
.more { font-size: 10px; color: #6a6a76; padding-top: 5px; }

.link { display: flex; flex-direction: column; gap: 3px; text-decoration: none; }
.link-host { color: #f97316; font-size: 12px; font-weight: 600; }
.link-url { color: #6a6a76; font-size: 10.5px; word-break: break-all; }

.text { line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
</style>
