import type { FindmntNode } from '../parsers/findmnt.js'

/**
 * "Is what is mounted at this target the thing that is CONFIGURED there?"
 * (story ident.4 (c)/(e), audit #16 #18 #44).
 *
 * A mountpoint is only a path. A failed CIFS line at `/mnt/media` and a local
 * disk the operator mounted at `/mnt/media` by hand look identical to a check
 * that asks "is anything mounted at /mnt/media?" — and that question is how a
 * Remove unmounted the operator's disk and how a backup read a different
 * filesystem than its source names. This module answers the stricter question
 * from the two facts the daemon already has: the configured spec (fstab
 * fs_spec + fs_vfstype, or a ZFS dataset name) and the kernel's live row
 * (`findmnt` source + fstype). Pure; nothing here touches a mountpoint.
 *
 * What can be compared, and what cannot (stated, not papered over):
 *   - the FSTYPE family always (`nfs`≡`nfs4`, `cifs`≡`smb3`); `auto`/`none`
 *     (and so every bind line) compare nothing;
 *   - the SOURCE where the spec and the kernel use the same words: network
 *     shares (server case-insensitive, export/share path with a trailing slash
 *     dropped; a CIFS share name is case-insensitive) and ZFS datasets (exact).
 *     A `UUID=`/`LABEL=`/device spec is not comparable with the kernel's
 *     device name without a resolution this module does not do, so for those
 *     the fstype alone decides.
 */

/** What the kernel has at one target: the real filesystem on top, and whether an automount placeholder is armed there. */
export interface LiveAtTarget {
  /** The top-most non-`autofs` mount at the target (what `umount` would take off). */
  real?: FindmntNode
  /** An `x-systemd.automount` placeholder (`autofs`) sits at the target. */
  armed: boolean
}

/** The live state at `target`, from the flattened findmnt rows. */
export function liveAtTarget(nodes: FindmntNode[], target: string): LiveAtTarget {
  let real: FindmntNode | undefined
  let armed = false
  for (const n of nodes) {
    if (n.target !== target)
      continue
    if (n.fstype === 'autofs')
      armed = true
    else
      real = n // depth-first: a later row at the same target is stacked on top
  }
  return real ? { real, armed } : { armed }
}

/** The fstype family: the kernel reports `nfs4` for an fstab `nfs` line, `smb3` is cifs. */
function fstypeFamily(fstype: string): string {
  const t = fstype.trim().toLowerCase()
  if (t === 'nfs' || t === 'nfs4')
    return 'nfs'
  if (t === 'cifs' || t === 'smb3' || t === 'smbfs')
    return 'cifs'
  return t
}

const TRAILING_SLASHES_RE = /\/+$/
const CIFS_LEAD_RE = /^[/\\]+/
const CIFS_SEP_RE = /[/\\]+/
const IPV6_BRACKETS_RE = /^\[|\]$/g

function trimPath(p: string): string {
  const t = p.replace(TRAILING_SLASHES_RE, '')
  return t === '' && p.startsWith('/') ? '/' : t
}

/** `//server/share/sub` → `{server, path}` (lower-cased: SMB names are case-insensitive). */
function cifsParts(spec: string): { server: string, path: string } {
  const parts = spec.trim().replace(CIFS_LEAD_RE, '').split(CIFS_SEP_RE).filter(Boolean)
  return { server: (parts[0] ?? '').toLowerCase(), path: parts.slice(1).join('/').toLowerCase() }
}

/** `server:/export` → `{server, path}`; a bracketed IPv6 server keeps its colons. */
function nfsParts(spec: string): { server: string, path: string } {
  const s = spec.trim()
  let idx: number
  if (s.startsWith('[')) {
    const close = s.indexOf(']')
    idx = close === -1 ? -1 : s.indexOf(':', close)
  }
  else {
    idx = s.indexOf(':/')
    if (idx === -1)
      idx = s.indexOf(':')
  }
  if (idx === -1)
    return { server: '', path: s }
  return { server: s.slice(0, idx).replace(IPV6_BRACKETS_RE, '').toLowerCase(), path: trimPath(s.slice(idx + 1)) }
}

/** The configured side of a comparison. */
export interface ConfiguredSpec {
  /** fstab fs_spec, or the ZFS dataset name. */
  spec: string
  /** fstab fs_vfstype, or `zfs`. */
  fstype: string
}

/** Does the kernel's live row at the target carry the configured spec? */
export function specMatchesLive(configured: ConfiguredSpec, live: FindmntNode): boolean {
  const family = fstypeFamily(configured.fstype)
  if (family === '' || family === 'auto' || family === 'none')
    return true
  if (family !== fstypeFamily(live.fstype))
    return false
  if (family === 'nfs') {
    const a = nfsParts(configured.spec)
    const b = nfsParts(live.source)
    return a.server === b.server && a.path === b.path
  }
  if (family === 'cifs') {
    const a = cifsParts(configured.spec)
    const b = cifsParts(live.source)
    return a.server === b.server && a.path === b.path
  }
  if (family === 'zfs')
    return configured.spec === live.source
  return true
}

/** The sentence that names what is mounted at a target (ASCII — it lands in job errors and journald). */
export function describeLive(node: FindmntNode): string {
  return `${node.source || '(no source)'} (${node.fstype || 'unknown type'})`
}
