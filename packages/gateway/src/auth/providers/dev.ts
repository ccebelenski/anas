import type { AuthProvider, AuthResult } from '../types.js'
import { PRIVILEGES } from '../types.js'

/**
 * Dev auth provider — accepts any request, returns a mock user holding both
 * privileges (no pveproxy in the dev loop, so no hand-off to verify;
 * docs/WAVE2-DESIGN.md A4).
 *
 * For development and testing only. Never use in production: createAuthProvider
 * refuses to arm it on a real PVE node without an explicit override.
 */
export class DevAuthProvider implements AuthProvider {
  readonly name = 'dev'

  async authenticate(): Promise<AuthResult> {
    return { ok: true, user: { name: 'devuser', uid: 1000, privileges: [...PRIVILEGES] } }
  }
}
