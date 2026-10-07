// Who is signed in, and which organisations they belong to.
//
// One module-level store rather than per-component state: the board, the
// workspace picker and the seat panel all need the same answer, and fetching it
// three times produces three chances to disagree about whether you are logged in.

import { ref, computed } from 'vue'

const API_BASE = import.meta.env.VITE_API_BASE || ''

export interface Account {
  id: string
  name: string | null
  email: string | null
  avatar_url: string | null
}

export interface Org {
  id: string
  name: string
  plan: 'personal' | 'organization'
  seat_limit: number
  seats_used: number
  owner_user_id: string
  role: 'owner' | 'admin' | 'member'
  price_cents: number | null
  extra_seat_cents: number | null
}

const user = ref<Account | null>(null)
const orgs = ref<Org[]>([])
const providers = ref<string[]>([])
const loaded = ref(false)
const activeOrgId = ref<string | null>(localStorage.getItem('lobby.org'))

export function useAccount() {
  const signedIn = computed(() => user.value !== null)

  const activeOrg = computed<Org | null>(() =>
    orgs.value.find((o) => o.id === activeOrgId.value) || orgs.value[0] || null
  )

  /**
   * Identity for presence and authorship.
   *
   * Signed in, this is the real account. Signed out — local development, or a
   * guest holding an invite token — it falls back to a locally generated name,
   * which is what the whole product used before accounts existed.
   */
  const identity = computed(() => {
    if (user.value) return { id: user.value.id, label: user.value.name || user.value.email || 'you' }
    let local = localStorage.getItem('lobby.user')
    if (!local) {
      local = `guest-${Math.random().toString(36).slice(2, 6)}`
      localStorage.setItem('lobby.user', local)
    }
    return { id: local, label: local }
  })

  async function refresh() {
    try {
      const [meRes, provRes] = await Promise.all([
        fetch(`${API_BASE}/auth/me`, { credentials: 'include' }),
        fetch(`${API_BASE}/auth/providers`, { credentials: 'include' }),
      ])
      const me = await meRes.json()
      user.value = me.user || null
      orgs.value = me.orgs || []
      providers.value = (await provRes.json()).providers || []
      if (!orgs.value.some((o) => o.id === activeOrgId.value)) {
        activeOrgId.value = orgs.value[0]?.id || null
      }
    } catch {
      user.value = null
      orgs.value = []
    } finally {
      loaded.value = true
    }
  }

  function signIn(provider: string) {
    // Come back to whatever was open, so signing in from inside a room does not
    // dump you at the front page.
    const back = location.pathname + location.search + location.hash
    location.href = `${API_BASE}/auth/${provider}?redirect=${encodeURIComponent(back)}`
  }

  async function signOut() {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' })
    user.value = null
    orgs.value = []
    location.href = '/'
  }

  function setOrg(id: string) {
    activeOrgId.value = id
    localStorage.setItem('lobby.org', id)
  }

  return { user, orgs, providers, loaded, signedIn, activeOrg, identity, refresh, signIn, signOut, setOrg }
}

/** $19.99 → "$19.99". Prices are cents on the wire so nothing rounds badly. */
export function money(cents: number | null): string {
  if (cents === null || cents === undefined) return '—'
  return `$${(cents / 100).toFixed(2)}`
}
