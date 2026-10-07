<!--
  The board is the product, so it is what loads — once we know who you are.

  Three states:
    · a lobby in the URL  → the board, signed in or not. An invite code is a
      valid credential on its own, which is how a guest joins without a seat.
    · signed out, no lobby → sign-in and workspace picker.
    · signed in, no lobby  → the same picker, listing their workspaces.

  The original multi-view dashboard stays reachable at ?legacy=1 for cross-lobby
  observability rather than being deleted.
-->
<template>
  <div v-if="!ready" class="boot">Loading…</div>
  <template v-else>
    <App v-if="legacy" />
    <BoardView v-else-if="hasLobby" />
    <SignInView v-else />
    <button
      v-if="hasLobby || legacy"
      class="mode-switch"
      :title="legacy ? 'Open the board' : 'Open the legacy dashboard'"
      @click="toggle"
    >
      {{ legacy ? '◆ Board' : '☰ Dashboard' }}
    </button>
  </template>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import BoardView from './views/BoardView.vue'
import SignInView from './views/SignInView.vue'
import App from './App.vue'
import { useAccount } from './composables/useAccount'

const { refresh } = useAccount()

const legacy = ref(new URLSearchParams(location.search).has('legacy'))
const hasLobby = ref(!!new URLSearchParams(location.hash.slice(1)).get('lobby'))
const ready = ref(false)

// Resolve the session before rendering. Mounting the board first and then
// discovering who you are makes presence briefly claim the wrong identity.
onMounted(async () => {
  await refresh()
  ready.value = true
})

function toggle() {
  const url = new URL(location.href)
  if (legacy.value) url.searchParams.delete('legacy')
  else url.searchParams.set('legacy', '1')
  location.href = url.toString()
}
</script>

<style scoped>
.boot {
  position: fixed; inset: 0; display: grid; place-items: center;
  background: #0d0d0f; color: #6a6a76;
  font: 400 13px Inter, ui-sans-serif, system-ui, sans-serif;
}
/* Bottom-LEFT, and lifted clear of the canvas stats line.
   It used to sit bottom-right at z-index 200, which put it directly on top of the
   chat composer — measured overlap 92x29px, i.e. covering the send button. The
   right-hand column belongs to the rail; this is a secondary affordance and gets
   out of its way. */
.mode-switch {
  position: fixed; left: 12px; bottom: 44px;
  z-index: 200;
  background: rgba(17,17,20,.92);
  border: 1px solid #26262e; border-radius: 8px;
  color: #7a7a86; padding: 6px 10px; cursor: pointer;
  font: 500 11px ui-monospace, 'JetBrains Mono', monospace;
  backdrop-filter: blur(8px);
}
.mode-switch:hover { color: #f97316; border-color: #f97316; }
</style>
