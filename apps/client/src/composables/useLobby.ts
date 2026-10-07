// Lobby connection: durable board state + ephemeral presence over one socket.
//
// Mirrors the server split. Canvas objects are optimistic-local and converge by
// last-write-wins; cursors and viewports are fire-and-forget and never stored.

import { ref, onUnmounted, getCurrentInstance } from 'vue'
import type { AgentEvent } from '../types'

const API_BASE = import.meta.env.VITE_API_BASE || ''

/**
 * wss:// when the page is https. This was hardcoded to ws://, which a browser
 * blocks as mixed content the moment the dashboard is served over TLS — so the
 * board would silently never connect once deployed.
 */
function wsBase(): string {
  if (import.meta.env.VITE_WS_BASE) return import.meta.env.VITE_WS_BASE
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  // Same-origin behind a reverse proxy; :4000 only in local dev.
  const host = import.meta.env.DEV ? `${window.location.hostname}:4000` : window.location.host
  return `${proto}//${host}`
}

export type CanvasObjectType =
  | 'artifact' | 'note' | 'frame' | 'stroke' | 'shape' | 'link' | 'image'

export interface CanvasObject {
  id: string
  lobby_id?: string
  type: CanvasObjectType
  event_id?: number
  parent_id?: string
  x: number; y: number; w: number; h: number; z: number
  rotation: number
  props?: Record<string, any>
  version: number
  version_nonce: number
  created_by?: string
  updated_by?: string
  updated_at: number
  deleted?: boolean
  seq: number
}

export interface ChatMessage {
  id: number
  lobby_id?: string
  author_user: string
  author_kind: 'human' | 'agent' | 'system'
  body: string
  reply_to?: number
  mentions?: string[]
  ref_object_id?: string
  ts: number
  deleted?: boolean
  seq: number
}

export interface Annotation {
  id: number
  lobby_id?: string
  user_id: string
  text: string
  target_type: 'event' | 'object' | 'point'
  target_id?: string
  anchor_x?: number
  anchor_y?: number
  thread_parent?: number
  resolved?: boolean
  deleted?: boolean
  timestamp: number
  seq: number
}

export interface Peer {
  user_id: string
  display_name?: string
  color?: string
  cursor?: { x: number; y: number }
  viewport?: { x: number; y: number; zoom: number }
  selection?: string[]
  typing?: boolean
  ts: number
}

export interface LobbyOptions {
  code: string
  userId: string
  displayName?: string
  color?: string
  token?: string
}

/** Client-side cursor throttle. The server coalesces too; this saves the frames. */
const CURSOR_SEND_MS = 40

function nonce(): number {
  return Math.floor(Math.random() * 2147483647)
}

export function useLobby(opts: LobbyOptions) {
  const connected = ref(false)
  const events = ref<AgentEvent[]>([])
  const peers = ref<Map<string, Peer>>(new Map())
  const members = ref<any[]>([])
  const lastSeq = ref(0)
  const error = ref<string | null>(null)

  // The map is REPLACED on every commit rather than mutated in place.
  //
  // Mutating it and calling triggerRef looks cheaper, but the map keeps the same
  // identity — so when it is passed down as a prop, the child's `props.objects`
  // never changes under Vue's Object.is check and its computeds never
  // invalidate. The board silently renders nothing, with no error anywhere.
  // Copying a few thousand entries is microseconds; correctness is worth more.
  const objects = ref<Map<string, CanvasObject>>(new Map())
  const commit = () => { objects.value = new Map(objects.value) }

  // Chat and pins keep the same discipline: replace the container, never mutate
  // it in place, or a child component's props never see the change.
  const messages = ref<ChatMessage[]>([])
  const annotations = ref<Map<number, Annotation>>(new Map())

  let ws: WebSocket | null = null
  let reconnectTimer: number | null = null
  let reconnectDelay = 1000
  let cursorTimer: number | null = null
  let pendingCursor: { c?: [number, number]; v?: [number, number, number] } | null = null
  let closedByUs = false

  const auth = () => (opts.token ? `&token=${encodeURIComponent(opts.token)}` : '')
  const authHeaders = () =>
    opts.token ? { Authorization: `Bearer ${opts.token}` } : undefined

  /**
   * Every request out of this composable, through one function.
   *
   * There are two ways to be authorized — a member token (bots, and guests
   * holding an invite) and a session cookie (a signed-in member of the owning
   * organisation) — and a call site that forgets `credentials: 'include'` works
   * fine for the first and 404s for the second. That is the kind of bug that
   * only shows up for signed-in users on someone else's machine.
   */
  const req = (url: string, init: RequestInit = {}) =>
    fetch(url, {
      ...init,
      credentials: 'include',
      headers: { ...(authHeaders() || {}), ...(init.headers || {}) },
    })

  // ---- last-write-wins ----------------------------------------------------

  function wins(incoming: CanvasObject, current: CanvasObject | undefined): boolean {
    if (!current) return true
    if (incoming.version !== current.version) return incoming.version > current.version
    return incoming.version_nonce > current.version_nonce
  }

  /** Apply a remote object, honouring LWW so a slow echo cannot undo a local edit. */
  function applyRemote(obj: CanvasObject, silent = false) {
    const cur = objects.value.get(obj.id)
    if (!wins(obj, cur)) return
    if (obj.deleted) objects.value.delete(obj.id)
    else objects.value.set(obj.id, obj)
    if (obj.seq > lastSeq.value) lastSeq.value = obj.seq
    if (!silent) commit()
  }

  // ---- durable writes -----------------------------------------------------

  /**
   * Optimistic local edit, then broadcast. The object appears immediately; if
   * the server rejects it as stale it sends the winner back and applyRemote
   * repairs us.
   */
  function putObject(patch: Partial<CanvasObject> & { id: string }): CanvasObject {
    const cur = objects.value.get(patch.id)
    const next: CanvasObject = {
      type: 'note', x: 0, y: 0, w: 320, h: 200, z: 0, rotation: 0,
      ...(cur || {}),
      ...patch,
      version: (cur?.version ?? 0) + 1,
      version_nonce: nonce(),
      updated_by: opts.userId,
      updated_at: Date.now(),
      seq: cur?.seq ?? 0,
    } as CanvasObject

    objects.value.set(next.id, next)
    commit()
    send({ t: 'obj', op: 'upsert', o: next })
    return next
  }

  function removeObject(id: string) {
    const cur = objects.value.get(id)
    objects.value.delete(id)
    commit()
    send({ t: 'obj', op: 'delete', o: { id, version: (cur?.version ?? 0) + 1, version_nonce: nonce() } })
  }

  // ---- chat ---------------------------------------------------------------

  /**
   * Apply one message, keyed by id. The server echoes the sender's own line back
   * — unlike a cursor, the author needs the authoritative id/ts/seq — so this
   * has to be an upsert, not an append, or every message you send appears twice.
   */
  function applyMessage(m: ChatMessage, silent = false) {
    const i = messages.value.findIndex(x => x.id === m.id)
    if (i >= 0) messages.value[i] = m
    else messages.value.push(m)
    if (m.seq > lastSeq.value) lastSeq.value = m.seq
    if (!silent) messages.value = [...messages.value].sort((a, b) => a.seq - b.seq)
  }

  function sendChat(body: string, extra?: { reply_to?: number; ref_object_id?: string; mentions?: string[] }) {
    const text = body.trim()
    if (!text) return
    send({ t: 'chat', body: text, ...extra })
  }

  async function deleteMessage(id: number) {
    try {
      await req(`${API_BASE}/lobbies/${opts.code}/messages/${id}`, {
        method: 'DELETE',
              })
      // The tombstone arrives over the socket like any other change.
    } catch (e) {
      console.error('[lobby] delete message failed', e)
    }
  }

  // ---- annotations --------------------------------------------------------

  function applyAnnotation(a: Annotation, silent = false) {
    // Resolved and deleted pins leave the board but stay reachable by query —
    // dropping them from the live map is what makes them disappear here.
    if (a.deleted || a.resolved) annotations.value.delete(a.id)
    else annotations.value.set(a.id, a)
    if (a.seq > lastSeq.value) lastSeq.value = a.seq
    if (!silent) annotations.value = new Map(annotations.value)
  }

  async function pin(a: {
    text: string
    target_type: 'event' | 'object' | 'point'
    target_id?: string | number
    anchor_x?: number
    anchor_y?: number
    thread_parent?: number
  }) {
    try {
      const res = await req(`${API_BASE}/lobbies/${opts.code}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a),
      })
      if (!res.ok) {
        error.value = (await res.json().catch(() => ({}))).error || `pin failed (${res.status})`
        return null
      }
      const saved = await res.json()
      applyAnnotation(saved)
      return saved as Annotation
    } catch (e: any) {
      error.value = e.message
      return null
    }
  }

  async function resolveAnnotation(id: number, resolved = true) {
    try {
      await req(`${API_BASE}/lobbies/${opts.code}/annotations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved }),
      })
    } catch (e) {
      console.error('[lobby] resolve failed', e)
    }
  }

  async function deleteAnnotation(id: number) {
    try {
      await req(`${API_BASE}/lobbies/${opts.code}/annotations/${id}`, {
        method: 'DELETE',
              })
    } catch (e) {
      console.error('[lobby] delete annotation failed', e)
    }
  }

  // ---- ephemeral ----------------------------------------------------------

  /**
   * Cursor and viewport. Coalesced client-side: only the newest position in a
   * frame window is sent, and the trailing send guarantees the final position
   * arrives rather than being dropped mid-move.
   */
  function sendPresence(cursor?: { x: number; y: number }, viewport?: { x: number; y: number; zoom: number }) {
    pendingCursor = {
      c: cursor ? [cursor.x, cursor.y] : pendingCursor?.c,
      v: viewport ? [viewport.x, viewport.y, viewport.zoom] : pendingCursor?.v,
    }
    if (cursorTimer !== null) return
    const flush = () => {
      cursorTimer = null
      if (!pendingCursor) return
      const p = pendingCursor
      pendingCursor = null
      send({ t: 'e', n: opts.displayName, col: opts.color, ...p })
      // Trailing window: if more movement arrived while we waited, send again.
      cursorTimer = window.setTimeout(() => {
        cursorTimer = null
        if (pendingCursor) sendPresence()
      }, CURSOR_SEND_MS)
    }
    flush()
  }

  function sendSelection(ids: string[]) {
    send({ t: 'e', s: ids })
  }

  function send(msg: any) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)) } catch {}
    }
  }

  // ---- catch-up -----------------------------------------------------------

  /**
   * Replay strictly above the last seq we applied. This is what makes a
   * reconnect lossless instead of "reload everything and hope".
   */
  async function catchUp() {
    // Captured BEFORE the awaits. The socket's own snapshot messages are landing
    // at the same time and moving lastSeq forward; reading it after the fetch
    // would skip whatever arrived in between.
    const cursor = lastSeq.value
    try {
      if (cursor > 0) {
        // Chat and pins share the counter, so one cursor covers all three. The
        // socket resends a 100-message backlog on open, but a delta is what
        // catches a withdrawal that happened further back than that window.
        const [msgs, anns] = await Promise.all([
          req(`${API_BASE}/lobbies/${opts.code}/messages/since?seq=${cursor}`),
          req(`${API_BASE}/lobbies/${opts.code}/annotations/since?seq=${cursor}`),
        ])
        if (msgs.ok) {
          const data = await msgs.json()
          for (const m of data.messages) applyMessage(m, true)
          messages.value = [...messages.value].sort((a, b) => a.seq - b.seq)
        }
        if (anns.ok) {
          const data = await anns.json()
          for (const a of data.annotations) applyAnnotation(a, true)
          annotations.value = new Map(annotations.value)
        }
      }
    } catch (e) {
      console.error('[lobby] chat catch-up failed', e)
    }
    try {
      if (cursor === 0) {
        const res = await req(`${API_BASE}/lobbies/${opts.code}/canvas`)
        if (res.ok) {
          const data = await res.json()
          for (const o of data.objects) applyRemote(o, true)
          lastSeq.value = Math.max(lastSeq.value, data.seq || 0)
          commit()
        }
      } else {
        const res = await fetch(
          `${API_BASE}/lobbies/${opts.code}/canvas/since?seq=${cursor}`,
          
        )
        if (res.ok) {
          const data = await res.json()
          for (const o of data.objects) applyRemote(o, true)
          commit()
        }
      }
    } catch (e) {
      console.error('[lobby] catch-up failed', e)
    }
  }

  // ---- socket -------------------------------------------------------------

  function connect() {
    const url = `${wsBase()}/lobby/${opts.code}/stream?user_id=${encodeURIComponent(opts.userId)}${auth()}`
    ws = new WebSocket(url)

    ws.onopen = async () => {
      connected.value = true
      error.value = null
      reconnectDelay = 1000
      await catchUp()
    }

    ws.onmessage = (raw) => {
      let msg: any
      try { msg = JSON.parse(raw.data) } catch { return }

      switch (msg.type) {
        case 'initial':
          events.value = msg.data
          if (msg.seq) lastSeq.value = Math.max(lastSeq.value, msg.seq)
          break

        case 'event':
          events.value.push(msg.data)
          if (events.value.length > 2000) events.value = events.value.slice(-2000)
          if (msg.data.seq > lastSeq.value) lastSeq.value = msg.data.seq
          break

        case 'canvas_snapshot':
          for (const o of msg.data) applyRemote(o, true)
          commit()
          break

        case 'canvas_object':
          applyRemote(msg.data)
          break

        case 'chat_backlog':
          for (const m of msg.data) applyMessage(m, true)
          messages.value = [...messages.value].sort((a, b) => a.seq - b.seq)
          break

        case 'chat_message':
          applyMessage(msg.data)
          break

        case 'annotation_snapshot':
          for (const a of msg.data) applyAnnotation(a, true)
          annotations.value = new Map(annotations.value)
          break

        case 'annotation':
          applyAnnotation(msg.data)
          break

        case 'presence_roster':
          for (const p of msg.data) peers.value.set(p.user_id, p)
          peers.value = new Map(peers.value)
          break

        case 'ephemeral':
          peers.value.set(msg.data.user_id, msg.data)
          peers.value = new Map(peers.value)
          break

        case 'presence_leave':
          peers.value.delete(msg.data.user_id)
          peers.value = new Map(peers.value)
          break

        case 'lobby_members':
          members.value = msg.data
          break

        case 'error':
          error.value = msg.error
          break
      }
    }

    ws.onclose = () => {
      connected.value = false
      if (closedByUs) return
      // Backoff, capped. A tight reconnect loop against a server that is down
      // is just a self-inflicted flood.
      reconnectTimer = window.setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 15000)
    }

    ws.onerror = () => { /* onclose handles recovery */ }
  }

  function disconnect() {
    closedByUs = true
    if (ws) ws.close()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (cursorTimer) clearTimeout(cursorTimer)
  }

  connect()
  // Only bind the lifecycle hook when there IS a component to bind to. Opening a
  // second lobby happens inside a click handler, not setup(), and registering
  // there warned on every switch while binding to nothing. The caller disconnects
  // the previous connection explicitly, so nothing leaks either way.
  if (getCurrentInstance()) onUnmounted(disconnect)

  return {
    connected, error, events, objects, peers, members, lastSeq,
    messages, annotations,
    putObject, removeObject, sendPresence, sendSelection, disconnect,
    sendChat, deleteMessage, pin, resolveAnnotation, deleteAnnotation,
  }
}
