import { spawnSync } from 'node:child_process'

const WHITESPACE_RE = /\s+/
const LEADING_SLASHES_RE = /^\/+/

/**
 * `btrfs subvolume list <mountpoint>` for a test that is not root, on a
 * scratch tree that sits on btrfs (a TMPDIR under the worktree on a btrfs
 * home): the real tool needs CAP_SYS_ADMIN and refuses ("Operation not
 * permitted"), which the plan rightly reads as a FAILED read. This answers
 * what root would see for a scratch tree with no nested subvolume: the one
 * subvolume the mount shows (its `subvol=` option), in the tool's own line
 * shape. Null for any other command, or when the mount is not btrfs.
 */
export function btrfsListStandIn(command: string, args: string[]): { stdout: string, stderr: string, exitCode: number } | null {
  if (command !== '/usr/bin/btrfs' || args[0] !== 'subvolume' || args[1] !== 'list' || process.getuid?.() === 0)
    return null
  const r = spawnSync('/usr/bin/findmnt', ['-no', 'FSTYPE,OPTIONS', '--target', args[2] ?? ''], { encoding: 'utf8' })
  const [fstype, options = ''] = r.stdout.trim().split(WHITESPACE_RE)
  if (fstype !== 'btrfs')
    return null
  const subvol = (options.split(',').find(o => o.startsWith('subvol=')) ?? 'subvol=/').slice('subvol='.length).replace(LEADING_SLASHES_RE, '')
  return { stdout: subvol === '' ? '' : `ID 256 gen 1 top level 5 path ${subvol}\n`, stderr: '', exitCode: 0 }
}
