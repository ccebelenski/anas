<script setup lang="ts">
// PVE ticket handoff page (story 13.3).
//
// Loaded in an iframe by the PVE UI integration script as
// `/auth/handoff?to=/storage/pools`. It performs the cross-node
// postMessage handshake that hands the (cluster-valid) PVEAuthCookie
// ticket from the parent PVE UI frame to this ANAS origin, then
// redirects to the requested view in embedded mode.
//
// See docs/DESIGN.md "PVE UI Integration — Ticket handoff (cross-node auth)".

// No app chrome — this renders inside the PVE iframe.
definePageMeta({ layout: false })

const timedOut = ref(false)

/**
 * Validate the `to` target to prevent open redirects. It must be a
 * same-origin absolute path: start with a single `/`, and never contain
 * a scheme (`://`), protocol-relative prefix (`//`), or backslashes.
 * Anything invalid or missing falls back to `/`.
 */
function sanitizeTarget(raw: string | null | undefined): string {
  if (!raw)
    return '/'
  if (!raw.startsWith('/'))
    return '/'
  if (raw.startsWith('//'))
    return '/'
  if (raw.includes('://'))
    return '/'
  if (raw.includes('\\'))
    return '/'
  return raw
}

/** Append `embedded=1`, respecting any existing query string. */
function withEmbedded(target: string): string {
  return `${target + (target.includes('?') ? '&' : '?')}embedded=1`
}

onMounted(() => {
  const params = new URLSearchParams(window.location.search)
  const target = sanitizeTarget(params.get('to'))

  // The expected origin of the parent PVE UI frame. The handoff page is
  // always served from the same hostname the browser used to reach ANAS,
  // and the PVE UI runs on port 8006 of that host.
  const pveOrigin = `https://${window.location.hostname}:8006`

  let done = false
  let readyTimer: ReturnType<typeof setInterval> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined

  function cleanup() {
    if (readyTimer !== undefined)
      clearInterval(readyTimer)
    if (deadline !== undefined)
      clearTimeout(deadline)
    window.removeEventListener('message', onMessage)
  }

  function redirect() {
    window.location.replace(withEmbedded(target))
  }

  function onMessage(event: MessageEvent) {
    // Reject any message that does not come from the expected PVE UI origin.
    if (event.origin !== pveOrigin)
      return

    const data = event.data as { type?: unknown, ticket?: unknown } | null
    if (!data || data.type !== 'anas:handoff:ticket')
      return
    if (typeof data.ticket !== 'string' || data.ticket.length === 0)
      return
    if (done)
      return

    done = true
    cleanup()

    // Set the cookie on this (ANAS) origin. Secure + SameSite=Lax matches
    // how PVE sets it; validation happens server-side on every request.
    document.cookie
      = `PVEAuthCookie=${data.ticket}; path=/; secure; samesite=lax`

    redirect()
  }

  window.addEventListener('message', onMessage)

  // Optimization: if a valid session already exists on this origin, skip
  // the handshake entirely. Probe a cheap authenticated endpoint — a
  // non-401 response means we're already authenticated.
  fetch('/api/pools', { credentials: 'same-origin' })
    .then((res) => {
      if (done)
        return
      if (res.status !== 401) {
        done = true
        cleanup()
        redirect()
      }
    })
    .catch(() => {
      // Network/probe failure — fall through to the handshake.
    })

  function sendReady() {
    // The parent may attach its listener after our iframe loads, so we
    // announce readiness repeatedly until a ticket arrives or we time out.
    window.parent.postMessage({ type: 'anas:handoff:ready' }, pveOrigin)
  }

  sendReady()
  readyTimer = setInterval(() => {
    if (done)
      return
    sendReady()
  }, 500)

  // Give up after ~5s and show a plain instruction.
  deadline = setTimeout(() => {
    if (done)
      return
    done = true
    cleanup()
    timedOut.value = true
  }, 5000)
})
</script>

<template>
  <div class="handoff">
    <p v-if="timedOut" class="handoff__message">
      Not authenticated — log into the Proxmox UI first, then reload.
    </p>
    <p v-else class="handoff__message">
      Connecting…
    </p>
  </div>
</template>

<style scoped>
.handoff {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  margin: 0;
  font-family: system-ui, -apple-system, sans-serif;
}

.handoff__message {
  color: #333;
  font-size: 0.95rem;
}
</style>
