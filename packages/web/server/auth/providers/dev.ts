import type { AuthProvider, AuthUser } from '../types'

/**
 * Dev auth provider — accepts any token, returns a mock user.
 *
 * For development and testing only. Never use in production.
 */
export class DevAuthProvider implements AuthProvider {
  readonly name = 'dev'

  async validateToken(_token: string): Promise<AuthUser | null> {
    return { name: 'devuser', uid: 1000 }
  }
}
