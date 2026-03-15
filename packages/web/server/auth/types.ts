/** Authenticated user identity. */
export interface AuthUser {
  name: string
  uid: number
}

/** Credentials submitted to the login endpoint. */
export interface LoginCredentials {
  username: string
  password: string
}

/**
 * Auth provider interface.
 *
 * Three implementations: PVE (validates PVEAuthCookie against Proxmox),
 * PAM (system credentials), Dev (accepts anything).
 */
export interface AuthProvider {
  /** Provider name for logging/config. */
  readonly name: string

  /**
   * Authenticate with username/password credentials.
   * Returns the user on success, null on failure.
   */
  authenticate(credentials: LoginCredentials): Promise<AuthUser | null>

  /**
   * Validate an existing session token (e.g. PVEAuthCookie).
   * Returns the user if the token is valid, null otherwise.
   * Providers that don't support token validation return null.
   */
  validateToken?(token: string): Promise<AuthUser | null>
}
