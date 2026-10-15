import type { AuthProvider, AuthRequest, AuthResult } from '../types.js'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { ASSERTION_HEADER, verifyAssertion } from '../assertion.js'

/** Path whose presence marks a real PVE node (the dev-auth tripwire). */
const AUTHKEY_PATH = '/etc/pve/authkey.pub'

/** Resolve a Linux user name to its uid with id(1); -1 when there is none. */
export function resolveLinuxUid(name: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('/usr/bin/id', ['-u', '--', name], (err, stdout) => {
      if (err) {
        console.warn(`[auth] Cannot resolve the uid of PAM user '${name}'`)
        resolve(-1)
        return
      }
      const uid = Number.parseInt(stdout.trim(), 10)
      resolve(Number.isNaN(uid) ? -1 : uid)
    })
  })
}

/**
 * The uid ANAS records for a PVE user id. Only the `pam` realm is a Linux
 * account; `alice@pve` is not the local `alice` (review M6 #45, F5), so every
 * other realm gets -1 and no lookup is made. A PVE user name may itself
 * contain `@`; the realm is after the last one.
 */
export async function uidForUser(userid: string, resolve: (name: string) => Promise<number> = resolveLinuxUid): Promise<number> {
  const at = userid.lastIndexOf('@')
  if (at <= 0 || userid.slice(at + 1) !== 'pam')
    return -1
  return resolve(userid.slice(0, at))
}

export interface PveAuthProviderOptions {
  /** Seconds since the epoch; overridable for tests. */
  now?: () => number
  /** Linux uid resolver for `@pam` users; overridable for tests. */
  resolveUid?: (name: string) => Promise<number>
}

/**
 * PVE auth provider (cr.27). The gateway no longer verifies tickets itself:
 * PVE's own `auth_handler` does, inside pveproxy (AnasProxy.pm), together with
 * the enabled/expired user check, TFA and the CSRF token, and PVE's own
 * `$rpcenv->check` answers Sys.Audit / Sys.Modify on `/`. The answer reaches
 * this gateway as the signed X-Anas-Auth header (assertion.ts), and this
 * provider believes a request only when that signature verifies, is fresh and
 * names this exact method and path.
 */
export class PveAuthProvider implements AuthProvider {
  readonly name = 'pve'
  private readonly now: () => number
  private readonly resolveUid: (name: string) => Promise<number>

  constructor(private readonly key: Buffer, opts: PveAuthProviderOptions = {}) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.resolveUid = opts.resolveUid ?? resolveLinuxUid
  }

  async authenticate(request: AuthRequest): Promise<AuthResult> {
    const v = verifyAssertion(this.key, request.headers[ASSERTION_HEADER], {
      method: request.method,
      path: request.url,
      nowS: this.now(),
    })
    if (!v.ok)
      return v
    const uid = await uidForUser(v.userid, this.resolveUid)
    return { ok: true, user: { name: v.userid, uid, privileges: v.privileges } }
  }

  /** Check if Proxmox auth key exists on disk (the dev-auth tripwire). */
  static isAvailable(): boolean {
    try {
      readFileSync(AUTHKEY_PATH)
      return true
    }
    catch {
      return false
    }
  }
}
