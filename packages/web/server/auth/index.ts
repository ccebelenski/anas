import type { AuthProvider } from './types'
import { DevAuthProvider } from './providers/dev'
import { PveAuthProvider } from './providers/pve'

export type { AuthProvider, AuthUser } from './types'

let provider: AuthProvider | null = null

/** Get the current auth provider. */
export function getAuthProvider(): AuthProvider {
  if (provider) return provider

  const configured = process.env.ANAS_AUTH_PROVIDER

  if (configured === 'dev') {
    provider = new DevAuthProvider()
  } else {
    provider = new PveAuthProvider()
  }

  console.log(`[auth] Using ${provider.name} auth provider`)
  return provider
}
