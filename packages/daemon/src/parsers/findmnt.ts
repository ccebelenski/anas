import type { MountKind } from '@anas/shared'

/**
 * Parser for `findmnt --json` (util-linux). findmnt reads the kernel mount table
 * (`/proc/self/mountinfo`), so it NEVER touches a mountpoint's filesystem and
 * never hangs — even on a dead NFS server (proven in ground truth §4). This is
 * the SAFE backbone of the mount inventory.
 *
 * Each filesystem object is `{ target, source, fstype, options, children? }`.
 * The tree is flattened depth-first; the caller filters pseudo-filesystems and
 * disambiguates kind. An `x-systemd.automount` mountpoint appears as an `autofs`
 * placeholder (`source: "systemd-1"`), optionally STACKED with the real fs on
 * the same target once accessed — both rows are returned so the caller can tell
 * "armed" from "mounted".
 */

/** One flattened mount from findmnt (effective/kernel view). */
export interface FindmntNode {
  target: string
  source: string
  fstype: string
  /** Effective (negotiated) mount options as a comma string. */
  options: string
}

interface RawFs {
  target?: string
  source?: string
  fstype?: string
  options?: string
  children?: RawFs[]
}

/**
 * Kernel pseudo-filesystems the inventory never surfaces. `autofs` is
 * deliberately NOT here — its placeholder is a load-bearing signal for
 * automounts. `fuse.lxcfs` and the `/etc/pve` `fuse` mount are PVE/system
 * plumbing, not user storage.
 */
const PSEUDO_FSTYPES = new Set([
  'sysfs',
  'proc',
  'devtmpfs',
  'devpts',
  'tmpfs',
  'cgroup',
  'cgroup2',
  'securityfs',
  'pstore',
  'bpf',
  'tracefs',
  'debugfs',
  'fusectl',
  'configfs',
  'mqueue',
  'hugetlbfs',
  'binfmt_misc',
  'nfsd',
  'rpc_pipefs',
  'fuse',
  'fuse.lxcfs',
  // swap is not a mount (findmnt never lists it), but an fstab `swap` line would
  // otherwise leak through the fstab overlay as a bogus unmounted `none` row.
  'swap',
])

/** Is this fstype a kernel/system pseudo-filesystem (dropped from the inventory)? */
export function isPseudoFstype(fstype: string): boolean {
  return PSEUDO_FSTYPES.has(fstype)
}

/**
 * Kernel/system mount-point roots. Anything mounted at or under these is OS
 * plumbing, never user storage. This catches the case the fstype filter misses:
 * a systemd `autofs` PLACEHOLDER over a pseudo-fs (e.g. `binfmt_misc` at
 * `/proc/sys/fs/binfmt_misc`) reports fstype `autofs` — which we deliberately
 * keep for real user automounts — so it leaks into the inventory as a spurious
 * "armed" row on every node unless we also filter by target.
 */
const SYSTEM_TARGET_PREFIXES = ['/proc/', '/sys/', '/dev/', '/run/']

/** Is this mount target OS plumbing (`/proc/*`, `/sys/*`, `/dev/*`, `/run/*`)? */
export function isSystemMountTarget(target: string): boolean {
  return SYSTEM_TARGET_PREFIXES.some(p => target.startsWith(p))
}

/**
 * Should this mount (from findmnt OR fstab) be dropped from the inventory —
 * kernel/system plumbing, not user storage. The SINGLE predicate both the
 * active-mount filter and the fstab overlay share, so they can never disagree
 * (a `proc /proc` fstab line once leaked through as a ghost "unconfigured" row
 * because only the active path filtered).
 */
export function isIgnoredMount(fstype: string, mountpoint: string): boolean {
  return isPseudoFstype(fstype) || isSystemMountTarget(mountpoint)
}

/** `host:/export` NFS source shape (host, then `:/`). */
const NFS_SOURCE_RE = /^[^/]+:\//

/**
 * Flatten `findmnt --json` output into a depth-first list of every mount,
 * including stacked children. Total and fail-safe: malformed input yields an
 * empty list (never throws). Rows missing a target are skipped.
 */
export function parseFindmnt(text: string): FindmntNode[] {
  let root: { filesystems?: RawFs[] }
  try {
    root = JSON.parse(text)
  }
  catch {
    return []
  }
  const out: FindmntNode[] = []
  const walk = (fs: RawFs): void => {
    if (typeof fs.target === 'string') {
      out.push({
        target: fs.target,
        source: fs.source ?? '',
        fstype: fs.fstype ?? '',
        options: fs.options ?? '',
      })
    }
    for (const child of fs.children ?? [])
      walk(child)
  }
  for (const fs of root.filesystems ?? [])
    walk(fs)
  return out
}

/**
 * Disambiguate a mount's kind from its fstype and source (ground truth §1):
 * `source` of `//host/share` = CIFS, `host:/export` = NFS, a pool name = ZFS,
 * `systemd-1` = an autofs placeholder, a device/`UUID=` = local.
 */
export function classifyKind(fstype: string, source: string): MountKind {
  if (fstype === 'cifs' || fstype === 'smb3')
    return 'cifs'
  if (fstype === 'nfs' || fstype === 'nfs4')
    return 'nfs'
  if (fstype === 'zfs')
    return 'zfs'
  if (fstype === 'autofs')
    return 'autofs'
  // A bind mount reports the underlying fstype but a device-path source that is
  // itself a directory; findmnt can't always tell, so this stays best-effort.
  if (source.startsWith('/dev/') || source.startsWith('UUID=') || source.startsWith('PARTUUID=') || source.startsWith('LABEL='))
    return 'local'
  if (source.startsWith('//'))
    return 'cifs'
  if (NFS_SOURCE_RE.test(source))
    return 'nfs'
  return 'other'
}

/** Does an effective-options string mark the mount read-only? */
export function optionsReadOnly(options: string): boolean {
  return options.split(',').includes('ro')
}
