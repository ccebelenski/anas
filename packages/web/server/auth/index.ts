import type { AuthProvider } from './types'
import { DevAuthProvider } from './providers/dev'
import { PamAuthProvider } from './providers/pam'
import { PveAuthProvider } from './providers/pve'

export type { AuthProvider, AuthUser, LoginCredentials } from './types'
export { signToken, verifyToken } from './token'

let provider: AuthProvider | null = null

/** Get the current auth provider. Initializes on first call. */
export async function getAuthProvider(): Promise<AuthProvider> {
  if (provider) return provider

  const configured = process.env.ANAS_AUTH_PROVIDER

  if (configured === 'dev') {
    provider = new DevAuthProvider()
  } else if (configured === 'pam') {
    provider = new PamAuthProvider()
  } else if (configured === 'pve') {
    provider = new PveAuthProvider()
  } else {
    // Auto-detect: try PVE first, fall back to PAM
    const pveAvailable = await PveAuthProvider.isAvailable()
    if (pveAvailable) {
      provider = new PveAuthProvider()
    } else {
      provider = new PamAuthProvider()
    }
  }

  console.log(`[auth] Using ${provider.name} auth provider`)
  return provider
}
