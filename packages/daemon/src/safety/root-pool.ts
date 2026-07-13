import { readFileSync } from 'node:fs'

/**
 * Root/boot-pool detection for the destroy block (Principle 14, Level 1).
 *
 * Destroying the pool that holds the running root filesystem must be impossible
 * — there is no override. The check is best-effort and cheap (no command
 * execution, no new whitelist entry):
 *
 *   1. Well-known names — 'rpool' and 'bpool' are the ZFS-on-root / Proxmox
 *      defaults. Matching by name blocks the common case even before we look at
 *      what is actually mounted.
 *   2. /proc/mounts — the pool backing a `zfs` filesystem mounted at `/`. This
 *      catches non-default root-pool names by reading a kernel-maintained file
 *      (a plain read, not a parsed command).
 *
 * If /proc/mounts is unreadable we fall back to the name list only. A pool that
 * is neither well-known nor the live root pool is not blocked here — it still
 * goes through the confirmation gate.
 */

const WELL_KNOWN_ROOT_POOLS = new Set(['rpool', 'bpool'])
const WHITESPACE = /\s+/

/** Derive the pool name backing the zfs filesystem mounted at `/`, or null. */
export function rootPoolFromMounts(mounts: string): string | null {
  for (const line of mounts.split('\n')) {
    const parts = line.split(WHITESPACE)
    if (parts.length < 3)
      continue
    const [source, target, fstype] = parts
    if (target === '/' && fstype === 'zfs') {
      // source is a dataset path like "rpool/ROOT/pve-1" — the pool is the head.
      const pool = source.split('/')[0]
      return pool || null
    }
  }
  return null
}

/**
 * True if `name` is the root/boot pool. `readMounts` is injectable for tests;
 * it defaults to reading /proc/mounts.
 */
export function isRootPool(
  name: string,
  readMounts: () => string = () => readFileSync('/proc/mounts', 'utf8'),
): boolean {
  if (WELL_KNOWN_ROOT_POOLS.has(name))
    return true
  try {
    return rootPoolFromMounts(readMounts()) === name
  }
  catch {
    return false
  }
}
