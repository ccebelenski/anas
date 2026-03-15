import { getAuthProvider } from '../auth'

/**
 * Server middleware that authenticates every request.
 *
 * In production: verifies PVEAuthCookie RSA signature locally.
 * In dev mode (ANAS_AUTH_PROVIDER=dev): always sets a mock user.
 */
export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // Static assets and Nuxt internals — no auth needed
  if (path.startsWith('/_nuxt/') || path.startsWith('/__nuxt')) {
    return
  }

  const provider = getAuthProvider()

  // Dev provider: authenticate without a cookie
  if (provider.name === 'dev') {
    event.context.user = await provider.validateToken('')
    return
  }

  // Production: validate PVEAuthCookie
  const pveCookie = getCookie(event, 'PVEAuthCookie')
  if (pveCookie) {
    const user = await provider.validateToken(pveCookie)
    if (user) {
      event.context.user = user
      return
    }
  }

  // No valid PVEAuthCookie — user isn't coming from Proxmox
  throw createError({
    statusCode: 401,
    statusMessage: 'Unauthorized',
    message: 'Access ANAS through the Proxmox UI',
  })
})
