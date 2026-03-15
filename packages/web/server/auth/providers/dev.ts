import type { AuthProvider, AuthUser, LoginCredentials } from '../types'

/**
 * Dev auth provider — accepts any login.
 *
 * For development and testing only. Never use in production.
 */
export class DevAuthProvider implements AuthProvider {
  readonly name = 'dev'

  async authenticate(credentials: LoginCredentials): Promise<AuthUser | null> {
    return {
      name: credentials.username,
      uid: 1000,
    }
  }
}
