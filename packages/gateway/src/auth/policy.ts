import type { AuthUser, Privilege } from './types.js'

/**
 * The one rule (EPICS §2 "Authorization follows PVE"; docs/WAVE2-DESIGN.md A3):
 * GET and HEAD need `Sys.Audit` on `/`, every other method needs `Sys.Modify`
 * on `/`. Method-based, no exceptions, no route table — a new route needs no
 * row. PVE answered what the user holds (AnasProxy.pm, signed); the gateway
 * decides here.
 */
export function requiredPrivilege(method: string): Privilege {
  const m = method.toUpperCase()
  return m === 'GET' || m === 'HEAD' ? 'Sys.Audit' : 'Sys.Modify'
}

/** The 403 sentence (§5 row 11): PVE's own "Permission check failed (<path>, <priv>)" form. */
export function forbiddenMessage(user: string, privilege: Privilege): string {
  return `Permission check failed (/, ${privilege}): ${user} does not have it. `
    + 'ANAS asks the privilege PVE asks for its own disk and ZFS operations.'
}

/** The privilege `user` lacks for `method`, or undefined when it may proceed. */
export function missingPrivilege(user: AuthUser, method: string): Privilege | undefined {
  const need = requiredPrivilege(method)
  return user.privileges.includes(need) ? undefined : need
}
