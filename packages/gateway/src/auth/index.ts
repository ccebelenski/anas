import type { AuthProvider } from './types.js'
import { DevAuthProvider } from './providers/dev.js'
import { PveAuthProvider } from './providers/pve.js'

export type { AuthProvider, AuthUser } from './types.js'

/**
 * Build an auth provider from the ANAS_AUTH_PROVIDER env var.
 *
 * `dev` → DevAuthProvider (accepts everything). Anything else (default)
 * → PveAuthProvider (RSA-SHA1 verification of PVEAuthCookie).
 *
 * Unlike a module-level singleton, this returns a fresh provider each call
 * so the gateway can construct one per server instance (and tests can inject
 * their own via server options).
 */
export function createAuthProvider(configured = process.env.ANAS_AUTH_PROVIDER): AuthProvider {
  const provider: AuthProvider = configured === 'dev'
    ? new DevAuthProvider()
    : new PveAuthProvider()

  console.warn(`[auth] Using ${provider.name} auth provider`)
  return provider
}
