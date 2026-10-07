<!--
  Sign-in and workspace picker.

  Shown when nobody is signed in and no invite code is in the URL. An invite code
  still works without an account — a guest holding one goes straight to the board,
  which is how you get a client into a room without selling them a seat.
-->
<template>
  <div class="gate">
    <div class="panel">
      <h1>Lobby</h1>
      <p class="tag">A shared canvas your bots work on.</p>

      <div v-if="error" class="err">{{ error }}</div>

      <template v-if="!signedIn">
        <!-- Sent state replaces the form entirely: leaving the form up invites a
             second submit, which just burns another of their five links. -->
        <div v-if="linkSentTo" class="sent">
          <div class="sent-mark">✓</div>
          <p class="sent-h">Check your email</p>
          <p class="sent-b">
            A sign-in link is on its way to <strong>{{ linkSentTo }}</strong>. It works
            once and expires in 15 minutes.
          </p>
          <button class="linkish" @click="linkSentTo = null">Use a different address</button>
        </div>

        <template v-else>
          <form v-if="oauthProviders.length || emailEnabled" class="email" @submit.prevent="emailSignIn">
            <template v-if="emailEnabled">
              <label for="signin-email">Email</label>
              <div class="row">
                <input
                  id="signin-email" v-model="email" type="email" inputmode="email"
                  autocomplete="email" placeholder="you@company.com" :disabled="sending"
                />
                <button type="submit" :disabled="!email.trim() || sending">
                  {{ sending ? 'Sending…' : 'Send link' }}
                </button>
              </div>
              <p class="hint">No password. We email you a link that signs you in.</p>
            </template>

            <div v-if="emailEnabled && oauthProviders.length" class="or"><span>or</span></div>

            <div v-if="oauthProviders.length" class="providers">
              <button
                v-for="p in oauthProviders" :key="p" type="button"
                class="provider" @click="signIn(p)"
              >
                <span class="mark">{{ p === 'github' ? '⌥' : 'G' }}</span>
                Continue with {{ p === 'github' ? 'GitHub' : 'Google' }}
              </button>
            </div>
          </form>

          <!-- Nothing configured. A stranger gets a human sentence and a way in;
               the operator gets the diagnosis in the server log, not on the
               product's front door. -->
          <p v-else class="note">
            Accounts aren't open on this server yet. If someone sent you an invite
            code, you can join a workspace with it below.
          </p>
        </template>
      </template>

      <template v-else>
        <div class="who">
          <img v-if="user?.avatar_url" :src="user.avatar_url" alt="" class="avatar" />
          <div>
            <div class="name">{{ user?.name || user?.email }}</div>
            <button class="linkish" @click="signOut">Sign out</button>
          </div>
        </div>

        <div class="orgs" v-if="orgs.length">
          <label>Organisation</label>
          <select :value="activeOrg?.id" @change="onOrg">
            <option v-for="o in orgs" :key="o.id" :value="o.id">
              {{ o.name }} — {{ o.seats_used }}/{{ o.seat_limit }} seats
            </option>
          </select>
          <p class="seats" v-if="activeOrg">
            {{ activeOrg.plan === 'personal' ? 'Personal' : 'Organisation' }} ·
            {{ money(activeOrg.price_cents) }}
            <template v-if="activeOrg.extra_seat_cents">
              · {{ money(activeOrg.extra_seat_cents) }} per additional seat
            </template>
            <template v-if="activeOrg.seats_used >= activeOrg.seat_limit">
              <br /><strong>All seats are in use.</strong>
              {{ activeOrg.plan === 'personal'
                 ? 'Upgrade to an organisation to add teammates.'
                 : 'Add a seat to invite more people.' }}
            </template>
          </p>
        </div>

        <div class="workspaces">
          <label>Workspaces</label>
          <p v-if="!workspaces.length" class="note">
            None yet. Create one, then connect a bot to it.
          </p>
          <button v-for="w in workspaces" :key="w.code" class="ws" @click="open(w.code)">
            <span class="ws-name">{{ w.name }}</span>
            <span class="ws-code">{{ w.code }}</span>
          </button>
          <form class="create" @submit.prevent="create">
            <input v-model="newName" placeholder="New workspace name" maxlength="80" />
            <button type="submit" :disabled="!newName.trim() || busy">Create</button>
          </form>
        </div>
      </template>

      <form class="join" @submit.prevent="join">
        <label>Have an invite code?</label>
        <div class="row">
          <input v-model="code" placeholder="7QK4DS" maxlength="6" @input="code = code.toUpperCase()" />
          <button type="submit" :disabled="code.length < 4">Join</button>
        </div>
      </form>
    </div>

    <!-- Reachable from the front door, deliberately. Asking someone to trust you
         with their source code while hiding what you do with it is not a position
         worth defending. -->
    <footer class="legal">
      <a href="/legal/privacy.html">Privacy</a>
      <span aria-hidden="true">·</span>
      <a href="/legal/terms.html">Terms</a>
      <span aria-hidden="true">·</span>
      <a href="/legal/security.html">Security</a>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAccount, money } from '../composables/useAccount'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const { user, orgs, providers, signedIn, activeOrg, refresh, signIn, signOut, setOrg } = useAccount()

const code = ref('')
const newName = ref('')
const workspaces = ref<any[]>([])
const busy = ref(false)
const error = ref<string | null>(new URLSearchParams(location.search).get('auth_error'))

// Email sign-in
const email = ref('')
const sending = ref(false)
const linkSentTo = ref<string | null>(null)
const emailEnabled = computed(() => providers.value.includes('email'))
const oauthProviders = computed(() => providers.value.filter((p: string) => p !== 'email'))

async function emailSignIn() {
  const addr = email.value.trim()
  if (!addr) return
  sending.value = true
  error.value = null
  try {
    const r = await fetch(`${API_BASE}/auth/email/start`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      // Come back to whatever they were trying to reach, so an invite link in the
      // URL survives the round trip through their inbox.
      body: JSON.stringify({ email: addr, redirect: location.hash ? `/${location.hash}` : '/' }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { error.value = data.error || 'Could not send a sign-in link.'; return }
    linkSentTo.value = addr
    email.value = ''
  } catch {
    error.value = 'Could not reach the server. Check your connection and try again.'
  } finally {
    sending.value = false
  }
}

onMounted(async () => {
  await refresh()
  await loadWorkspaces()
})

async function loadWorkspaces() {
  if (!activeOrg.value) { workspaces.value = []; return }
  try {
    const r = await fetch(`${API_BASE}/orgs/${activeOrg.value.id}/workspaces`, { credentials: 'include' })
    workspaces.value = r.ok ? (await r.json()).workspaces || [] : []
  } catch { workspaces.value = [] }
}

function onOrg(e: Event) {
  setOrg((e.target as HTMLSelectElement).value)
  loadWorkspaces()
}

function open(c: string) {
  location.hash = `lobby=${c}`
  location.reload()
}

function join() {
  if (code.value.trim()) open(code.value.trim())
}

async function create() {
  const name = newName.value.trim()
  if (!name) return
  busy.value = true
  error.value = null
  try {
    const r = await fetch(`${API_BASE}/lobbies`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, visibility: 'private', org_id: activeOrg.value?.id }),
    })
    const data = await r.json()
    if (!r.ok) { error.value = data.error || 'Could not create the workspace'; return }
    // The owner token is the credential a bot will use for this room, so it is
    // kept even though the browser itself authenticates by session cookie.
    if (data.token) localStorage.setItem(`lobby.token.${data.code}`, data.token)
    newName.value = ''
    open(data.code)
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.gate {
  position: fixed; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 20px;
  background: radial-gradient(1200px 600px at 50% -10%, #16161c, #0d0d0f);
  color: #e0e0e6; font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  overflow: auto; padding: 32px 16px;
}
/* In the flow rather than pinned to the bottom: on a short phone viewport a fixed
   footer lands on top of the panel, and the panel is the thing you came for. */
.legal {
  display: flex; gap: 9px; align-items: center;
  font-size: 11.5px; color: #4a4a54; flex-wrap: wrap; justify-content: center;
}
.legal a { color: #6a6a76; text-decoration: none; }
.legal a:hover { color: #f97316; text-decoration: underline; }
.panel {
  width: min(440px, 100%); background: #131318;
  border: 1px solid #26262e; border-radius: 14px; padding: 28px;
  box-shadow: 0 24px 64px rgba(0,0,0,.5);
}
h1 { font-size: 26px; font-weight: 600; letter-spacing: -.02em; margin-bottom: 4px; }
.tag { color: #7a7a86; font-size: 13px; margin-bottom: 22px; }
.err {
  background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.35);
  color: #fca5a5; border-radius: 8px; padding: 9px 11px; font-size: 12.5px; margin-bottom: 16px;
}
.note { color: #7a7a86; font-size: 12.5px; line-height: 1.6; }
.note code { background: #1c1c22; border-radius: 4px; padding: 1px 5px; font-size: 11.5px; }

.hint { color: #6a6a76; font-size: 11.5px; margin-top: 8px; line-height: 1.5; }

/* A labelled rule, not a bare line — "or" is doing real work here, telling
   someone the two paths are alternatives rather than steps. */
.or {
  display: flex; align-items: center; gap: 10px;
  margin: 18px 0 16px; color: #5a5a66; font-size: 11px;
  text-transform: uppercase; letter-spacing: .1em;
}
.or::before, .or::after { content: ''; flex: 1; height: 1px; background: #22222a; }

.sent { text-align: center; padding: 8px 0 4px; }
.sent-mark {
  width: 38px; height: 38px; margin: 0 auto 14px; display: grid; place-items: center;
  border-radius: 50%; background: rgba(34,197,94,.12); border: 1px solid rgba(34,197,94,.4);
  color: #4ade80; font-size: 17px;
}
.sent-h { font-size: 15px; font-weight: 600; color: #e0e0e6; margin-bottom: 7px; }
.sent-b { font-size: 12.5px; color: #7a7a86; line-height: 1.65; margin-bottom: 14px; }
.sent-b strong { color: #e0e0e6; font-weight: 500; }

.providers { display: flex; flex-direction: column; gap: 9px; }
.provider {
  display: flex; align-items: center; gap: 10px; width: 100%;
  background: #1c1c22; border: 1px solid #2e2e38; border-radius: 9px;
  color: #e0e0e6; padding: 11px 14px; cursor: pointer; font-size: 13.5px;
  transition: border-color .15s, background .15s;
}
.provider:hover { border-color: #f97316; background: #202027; }
.mark {
  width: 20px; height: 20px; display: grid; place-items: center;
  background: #2e2e38; border-radius: 5px; font-size: 12px; font-weight: 700;
}

.who { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.avatar { width: 40px; height: 40px; border-radius: 50%; }
.name { font-size: 14px; font-weight: 600; }
.linkish {
  background: none; border: none; color: #7a7a86; cursor: pointer;
  font-size: 11.5px; padding: 2px 0; text-decoration: underline;
}
.linkish:hover { color: #f97316; }

label {
  display: block; font-size: 10px; font-weight: 700; letter-spacing: .1em;
  text-transform: uppercase; color: #6a6a76; margin-bottom: 7px;
}
.orgs, .workspaces, .join { margin-top: 20px; padding-top: 18px; border-top: 1px solid #22222a; }
select, input {
  width: 100%; background: #1c1c22; border: 1px solid #2e2e38; border-radius: 8px;
  color: #e0e0e6; padding: 9px 11px; font-size: 13px; outline: none;
  font-family: inherit;
}
select:focus, input:focus { border-color: #f97316; }
.seats { color: #7a7a86; font-size: 11.5px; margin-top: 8px; line-height: 1.6; }
.seats strong { color: #fbbf24; }

.ws {
  display: flex; align-items: center; justify-content: space-between; width: 100%;
  background: #1a1a20; border: 1px solid #26262e; border-radius: 8px;
  color: #e0e0e6; padding: 10px 12px; cursor: pointer; margin-bottom: 7px;
  font-size: 13px; font-family: inherit;
}
.ws:hover { border-color: #f97316; }
.ws-code { color: #6a6a76; font: 500 11px ui-monospace, monospace; }

.create, .row { display: flex; gap: 8px; margin-top: 10px; }
.create button, .row button {
  background: #f97316; border: none; border-radius: 8px; color: #0d0d0f;
  padding: 0 16px; font-weight: 600; font-size: 13px; cursor: pointer; white-space: nowrap;
  font-family: inherit;
}
.create button:disabled, .row button:disabled { opacity: .4; cursor: default; }
</style>
