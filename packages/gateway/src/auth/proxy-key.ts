import { randomBytes } from 'node:crypto'
import { closeSync, fchmodSync, fchownSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The hand-off key (cr.27, docs/WAVE2-DESIGN.md A2.1). At startup the gateway
 * creates 32 random bytes, writes them atomically to /run/anas/proxy.key,
 * `root:www-data 0640`, and keeps them in memory. pveproxy workers run as
 * www-data and read it through the group to sign X-Anas-Auth; nothing else
 * but root can. A restart rotates it. It is a runtime credential like the
 * daemon's socket, not state about what ANAS manages (Principle 11), which is
 * why it lives under /run and is never written by the installer.
 *
 * AnasProxy.pm reads the same path ($AnasProxy::KEY_FILE); the two must agree.
 */
export const PROXY_KEY_PATH = '/run/anas/proxy.key'

/** The group pveproxy's workers run as. */
export const PROXY_KEY_GROUP = 'www-data'

export const PROXY_KEY_MODE = 0o640
export const PROXY_KEY_BYTES = 32

const NUMERIC_RE = /^\d+$/

/** Resolve a group name to its gid from an /etc/group-format file. */
export function groupId(name: string, groupFile = '/etc/group'): number | undefined {
  let text: string
  try {
    text = readFileSync(groupFile, 'utf8')
  }
  catch {
    return undefined
  }
  for (const line of text.split('\n')) {
    const [group, , gid] = line.split(':')
    if (group === name && gid !== undefined && NUMERIC_RE.test(gid))
      return Number(gid)
  }
  return undefined
}

export interface WriteProxyKeyOptions {
  /** Owner uid. Default 0 (root). */
  uid?: number
  /** Owner gid. Default: the gid of `www-data` in /etc/group. */
  gid?: number
  /** Key bytes, for tests. Default: 32 random bytes. */
  key?: Buffer
  /** The group database the gid is looked up in. Default /etc/group. */
  groupFile?: string
}

/**
 * Create the key and write it atomically (a temp file in the same directory,
 * mode and owner set on the open descriptor before a byte is written, fsync,
 * rename). Throws `cannot write <path>: <why>` on any failure — the gateway
 * then refuses to start (§5 row 12), because without the key pveproxy can
 * sign nothing and every request would be refused.
 */
export function writeProxyKey(path: string = PROXY_KEY_PATH, opts: WriteProxyKeyOptions = {}): Buffer {
  const key = opts.key ?? randomBytes(PROXY_KEY_BYTES)
  const uid = opts.uid ?? 0
  const gid = opts.gid ?? groupId(PROXY_KEY_GROUP, opts.groupFile)
  if (gid === undefined)
    throw new Error(`cannot write ${path}: group '${PROXY_KEY_GROUP}' not found in ${opts.groupFile ?? '/etc/group'} (pveproxy could not read the key)`)

  const tmp = `${path}.${process.pid}.tmp`
  let fd: number | undefined
  try {
    // /run/anas is created by anasd's unit; make sure of it (0755, as there).
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
    // A temp file left by a crashed start with the same pid would fail 'wx'.
    try {
      unlinkSync(tmp)
    }
    catch {}
    fd = openSync(tmp, 'wx', 0o600)
    fchownSync(fd, uid, gid)
    fchmodSync(fd, PROXY_KEY_MODE)
    writeSync(fd, key)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, path)
  }
  catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      }
      catch {}
    }
    try {
      unlinkSync(tmp)
    }
    catch {}
    throw new Error(`cannot write ${path}: ${(err as Error).message}`)
  }
  return key
}

/**
 * At shutdown, remove the key — only if it is still the one this process
 * wrote (a newer gateway may already have replaced it). Best effort: with the
 * key gone pveproxy answers 502 "ANAS gateway not ready" instead of signing
 * for a gateway that is not there.
 */
export function removeProxyKey(path: string, key: Buffer): void {
  try {
    if (readFileSync(path).equals(key))
      unlinkSync(path)
  }
  catch {}
}
