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
/** True when ANAS_ALLOW_INSECURE_DEV_AUTH explicitly opts into dev auth on a real node. */
function devAuthOverrideSet(): boolean {
  const v = process.env.ANAS_ALLOW_INSECURE_DEV_AUTH
  return v === '1' || v === 'true'
}

export function createAuthProvider(configured = process.env.ANAS_AUTH_PROVIDER): AuthProvider {
  if (configured === 'dev') {
    // Dev auth authenticates EVERY request as devuser — a total auth bypass.
    // On a real PVE node (authkey present) refuse to arm it unless an explicit
    // second override is set, so a stray ANAS_AUTH_PROVIDER=dev on production
    // fails visibly at startup instead of silently accepting everyone. On a
    // non-PVE dev/test host (no authkey) it just works, as before.
    if (PveAuthProvider.isAvailable() && !devAuthOverrideSet()) {
      throw new Error(
        'dev auth is a total authentication bypass and this looks like a real PVE node '
        + '(/etc/pve/authkey.pub exists); set ANAS_ALLOW_INSECURE_DEV_AUTH=1 to override',
      )
    }
    const provider = new DevAuthProvider()
    console.warn(`[auth] Using ${provider.name} auth provider`)
    return provider
  }

  const provider = new PveAuthProvider()
  console.warn(`[auth] Using ${provider.name} auth provider`)
  return provider
}
