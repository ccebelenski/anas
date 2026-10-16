import type { MountKind } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'

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
 * Is this text findmnt's OWN shape — an object whose `filesystems` is an
 * array? THE shape gate for a fail-closed caller (cr.23 review): valid JSON
 * of another shape (`{}`, `[]`, `{"filesystems":42}`, …) is as UNREADABLE as
 * broken JSON, so a caller that must not read a corrupt table as "no mounts"
 * asks this before trusting {@link parseFindmnt}. It never throws.
 */
export function isFindmntTable(text: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return false
  }
  return typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { filesystems?: unknown }).filesystems)
}

/**
 * Flatten `findmnt --json` output into a depth-first list of every mount,
 * STRICTLY (story cr.60, review L26): `null` unless the text is findmnt's own
 * shape at EVERY depth — an object whose `filesystems` is an array of objects,
 * each `children` (when present) an array of objects. A malformed row deeper
 * down (`children: 42`, a `null` filesystem) is as unreadable as broken JSON:
 * a fail-closed caller must never read a corrupt table as "fewer mounts".
 * Rows without a string `target` are skipped (not a shape fault). Never throws.
 */
export function parseFindmntTable(text: string): FindmntNode[] | null {
  if (!isFindmntTable(text))
    return null
  const root = JSON.parse(text) as { filesystems: unknown[] }
  const out: FindmntNode[] = []
  const walk = (fs: unknown): boolean => {
    if (typeof fs !== 'object' || fs === null || Array.isArray(fs))
      return false
    const row = fs as RawFs
    if (typeof row.target === 'string') {
      out.push({
        target: row.target,
        source: typeof row.source === 'string' ? row.source : '',
        fstype: typeof row.fstype === 'string' ? row.fstype : '',
        options: typeof row.options === 'string' ? row.options : '',
      })
    }
    if (row.children === undefined)
      return true
    if (!Array.isArray(row.children))
      return false
    return row.children.every(walk)
  }
  return root.filesystems.every(walk) ? out : null
}

/**
 * Flatten `findmnt --json` output into a depth-first list of every mount,
 * including stacked children. Lenient: broken JSON yields an empty list.
 * (Not total: a malformed row deeper down — `children: 42` — throws, which
 * the cr.23 readers relied on; cr.60 kept that and gave the fail-closed
 * readers {@link parseFindmntTable} / {@link readFindmntTable}, where
 * unreadable is `null`, never "nothing mounted".) Rows missing a target are
 * skipped.
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

/** The findmnt binary every mount-family reader runs. */
export const FINDMNT_BIN = '/usr/bin/findmnt'

/**
 * THE strict mount-table read (story cr.60, review L26): `findmnt --json`
 * (or `args`), its text when the command started, exited 0 AND answered in
 * findmnt's shape at every depth — else `null`, UNREADABLE. A non-zero exit
 * is never "nothing mounted", whatever its stdout carries. Never throws (a
 * process that could not start, or ran out its deadline, is unreadable too).
 */
export async function readFindmntTable(executor: CommandExecutor, args: readonly string[] = ['--json']): Promise<string | null> {
  try {
    const r = await executor.exec(FINDMNT_BIN, [...args])
    if (r.exitCode !== 0)
      return null
    return parseFindmntTable(r.stdout) === null ? null : r.stdout
  }
  catch {
    return null
  }
}

/**
 * THE stacked-mount rule (story cr.60, review L26), stated once for every
 * mount-family reader: findmnt lists the mounts at one target bottom-first
 * (depth-first; a mount stacked over another is its child), so at each
 * target the LAST non-`autofs` row is the filesystem on top — what a path
 * lookup reaches and what `umount` takes off. An `autofs` placeholder is the
 * target's row only when no real filesystem sits there (an armed automount);
 * stacked with a real one it is never the identity. `liveAtTarget`
 * (services/mount-match) answers the same rule for one target.
 */
export function effectiveMounts(nodes: FindmntNode[]): Map<string, FindmntNode> {
  const byTarget = new Map<string, FindmntNode>()
  for (const node of nodes) {
    const existing = byTarget.get(node.target)
    if (existing && node.fstype === 'autofs' && existing.fstype !== 'autofs')
      continue
    byTarget.set(node.target, node)
  }
  return byTarget
}

/** The effective REAL (non-`autofs`) row at `target` by {@link effectiveMounts}' rule; undefined when none. */
export function effectiveMountAt(nodes: FindmntNode[], target: string): FindmntNode | undefined {
  const node = effectiveMounts(nodes.filter(n => n.target === target)).get(target)
  return node && node.fstype !== 'autofs' ? node : undefined
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
  // A CephFS mon-list source (`a,b,c:/`) matches the NFS `host:/path` shape,
  // so fstype must win over the source fallthrough.
  if (fstype === 'ceph' || fstype === 'fuse.ceph-fuse' || fstype === 'fuse.ceph')
    return 'ceph'
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
