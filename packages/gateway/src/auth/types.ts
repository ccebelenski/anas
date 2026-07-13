/** Authenticated user identity. */
export interface AuthUser {
  name: string
  uid: number
}

/**
 * Auth provider interface.
 *
 * Two implementations: PVE (validates PVEAuthCookie against Proxmox)
 * and Dev (accepts everything, for development/testing).
 */
export interface AuthProvider {
  /** Provider name for logging/config. */
  readonly name: string

  /**
   * Validate a PVEAuthCookie or equivalent token.
   * Returns the user if valid, null otherwise.
   */
  validateToken: (token: string) => Promise<AuthUser | null>
}
