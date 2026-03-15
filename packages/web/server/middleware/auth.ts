import { getAuthProvider, verifyToken } from '../auth'

/**
 * Server middleware that authenticates every request.
 *
 * Checks credentials in order:
 * 1. PVEAuthCookie (if PVE provider is active and cookie present)
 * 2. anas-token JWT cookie
 * 3. Reject with 401
 *
 * Public routes (login, health) are exempted.
 */
export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // Public routes — no auth required
  if (
    path.startsWith('/api/auth/login') ||
    path.startsWith('/api/health') ||
    path === '/login' ||
    // Static assets and Nuxt internals
    path.startsWith('/_nuxt/') ||
    path.startsWith('/__nuxt')
  ) {
    return
  }

  const provider = await getAuthProvider()

  // 1. Try PVEAuthCookie (for users coming from Proxmox UI)
  if (provider.name === 'pve' && provider.validateToken) {
    const pveCookie = getCookie(event, 'PVEAuthCookie')
    if (pveCookie) {
      const user = await provider.validateToken(pveCookie)
      if (user) {
        event.context.user = user
        return
      }
    }
  }

  // 2. Try anas-token JWT
  const anasToken = getCookie(event, 'anas-token')
  if (anasToken) {
    const user = await verifyToken(anasToken)
    if (user) {
      event.context.user = user
      return
    }
  }

  // 3. No valid credentials — reject
  // For page requests, redirect to login
  if (!path.startsWith('/api/')) {
    return sendRedirect(event, '/login')
  }

  // For API requests, return 401
  throw createError({
    statusCode: 401,
    statusMessage: 'Unauthorized',
    message: 'Authentication required',
  })
})
