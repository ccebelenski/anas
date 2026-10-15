/**
 * The two privileges ANAS asks PVE about, on `/` (EPICS §2 "Authorization
 * follows PVE"; docs/WAVE2-DESIGN.md A1): `Sys.Audit` to read, `Sys.Modify`
 * to change — what PVE asks for its own ZFS, LVM and directory disk verbs.
 */
export const PRIVILEGES = ['Sys.Audit', 'Sys.Modify'] as const
export type Privilege = typeof PRIVILEGES[number]

/** Authenticated user identity, and what PVE grants it on `/`. */
export interface AuthUser {
  /** The full PVE user id, realm included (`alice@pve`, `root@pam`). */
  name: string
  /** The Linux uid for a `@pam` user; -1 for every other realm. */
  uid: number
  /** The privileges PVE grants this user on `/`. */
  privileges: readonly Privilege[]
}

/** What a provider sees of a request. */
export interface AuthRequest {
  method: string
  /** The request-target exactly as received (path and query). */
  url: string
  headers: Record<string, string | string[] | undefined>
}

/** A refusal's `reason` is for the log, never the client. */
export type AuthResult
  = | { ok: true, user: AuthUser }
    | { ok: false, reason: string }

/**
 * Auth provider interface.
 *
 * Two implementations: PVE (believes only what pveproxy signed — see
 * providers/pve.ts) and Dev (accepts everything, for development/testing).
 */
export interface AuthProvider {
  /** Provider name for logging/config. */
  readonly name: string

  /** Who is asking, and what PVE grants them on `/`. */
  authenticate: (request: AuthRequest) => Promise<AuthResult>
}
