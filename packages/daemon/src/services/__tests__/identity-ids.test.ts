import type { ExecOptions, ExecResult, PipelineOptions, PipelineResult } from '../../executor/types.js'
import type { FindmntNode } from '../../parsers/findmnt.js'
import type { OwnershipReadOpts, PickReservations } from '../identity-ids.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CommandTimeoutError } from '../../executor/deadline.js'
import { MockExecutor } from '../../executor/mock.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { GuardReads } from '../../safety/guard.js'
import {
  aclFindArgs,
  ACLTYPE_ARGS,
  aclWalkRoots,
  ID_PICK_TRIES,
  idHolder,
  idOwnership,
  ownerFindArgs,
  parseAclIds,
  parsePosixAclFilesystems,
  parseSpaceIds,
  pickId,
  shareWalkRoots,
  spaceArgs,
} from '../identity-ids.js'
import { mountIndex } from '../nested-filesystems.js'

/**
 * Story cr.29 — the uid / gid a create uses (services/identity-ids.ts).
 *
 * FIXTURES (ruling (l): fakes print captured output):
 *  - `zfs userspace`: there is NO capture under `fixtures/`. The one capture
 *    is probe P06 (docs/probes/wave2/06-identity-allocation.txt, stunt node,
 *    2026-10-15): `zfs userspace -Hpn gtbackup` printed the default fields,
 *    `POSIX User<TAB>0<TAB>512<TAB>1`. The daemon asks for `-o name` only,
 *    so the fake answers with that row's NAME column (`0`) — a spelled-out
 *    rewrite of the capture (its second tab field), read from the probe file
 *    below. Further ids are that line with the number rewritten.
 *  - `findmnt --json`: `fixtures/mounts/findmnt-full.json` (stunt node,
 *    story 18.1) — ext4 `/`, vfat `/boot/efi`, ZFS `/mnttest` and
 *    `/mnttest/data`, nfs4 and cifs client mounts, an autofs automount.
 *  - `find … -uid N -print -quit`: no capture; a hit is one path line (what
 *    `-print` writes), no hit is empty output, exit 0.
 *  - `getent passwd <n>`: exit 2 and no output for a number nobody holds
 *    (getent(1): "One or more supplied key could not be found"); a holder is
 *    a passwd line.
 *  - `timeout … stat -f` (cr.29b, the root-exists probe after a failed find):
 *    `fixtures/mounts/stat-f-exit-codes.txt` (stunt node, story 18.1) through
 *    `mockFixtures.statF` — "ext4 root (healthy local)" for a root that
 *    exists, "nonexistent path" for one that does not, the ESTALE case for
 *    one that cannot be read.
 *  - cr.59/cr.59n `find … -type d -execdir getfacl -n -p -c -E -s {} + |
 *    sort -u`: {@link GETFACL_CAPTURE}, captured 2026-10-16 on the
 *    development host (Fedora, acl 2.4.0 — the node runs 2.3.2, same entry
 *    format — GNU findutils 4.10.0) over a scratch tree made for it: a
 *    directory given `setfacl -m u:1005:r-x` and `setfacl -d -m
 *    u:1005:r-x,g:1005:r-x` (the access editor’s access + default grant), a
 *    file created after it (it inherits both), a file below given
 *    `setfacl -m g:1007:rw-`, a plain file, and a dangling symlink. Verbatim
 *    stdout of `find -P <dir> -xdev -type d -execdir getfacl -n -p -c -E -s
 *    {} + | LC_ALL=C sort -u`; the blank line is getfacl’s record separator.
 *    cr.59n narrowed the walk from `! -type l` to `-type d`; these are that
 *    same tree re-captured, so the file-only records the old capture held
 *    are gone: the two files’ base entries the directories do not share
 *    (`user::rw-`, `group::r--`, `mask::r--`, `mask::rw-`, `other::r--`),
 *    the inherited file’s ACCESS `group:1005:r-x` (the directory holds that
 *    grant only as a default entry) and `group:1007:rw-` — the hand-written
 *    file-level grant cr.59n accepts as the miss. Links can still never
 *    reach getfacl: under `-P` find follows none and `-type` tests the link
 *    itself, so a symlink is type `l` even pointing at a directory. (The
 *    old capture’s rationale stands for any link find does hand over:
 *    getfacl on the dangling link printed `getfacl: <dir>/dangling: No such
 *    file or directory`, exit 1.) A walk into a mode-000 directory: find
 *    printed `/usr/bin/find: ‘locked’: Permission denied`, exit 1 (path
 *    rewritten below to the test’s root).
 *  - `zfs get -H -p -o name,value -t filesystem acltype`: no capture; one
 *    `name<TAB>value` line per filesystem (zfs-get(8) `-H`: "tab-delimited",
 *    no header), value `off` unless a test switches a filesystem to `posix`.
 *  - `cat /proc/mdstat` (the AHR pool read): `fixtures/ahr/mdstat-clean.txt`
 *    with its md lines dropped — a node with no arrays (its Personalities
 *    and `unused devices: <none>` lines).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const P06 = readFileSync(join(__dirname, '../../../../../docs/probes/wave2/06-identity-allocation.txt'), 'utf-8')
const FINDMNT_FULL = readFileSync(join(FIXTURES, 'mounts/findmnt-full.json'), 'utf-8')
const FINDMNT_NESTED = readFileSync(join(FIXTURES, 'backup/findmnt-nested.json'), 'utf-8')
const FINDMNT_AHR0 = readFileSync(join(FIXTURES, 'ahr/findmnt-ahr0.json'), 'utf-8')
const MDSTAT_NO_ARRAYS = readFileSync(join(FIXTURES, 'ahr/mdstat-clean.txt'), 'utf-8')
  .split('\n')
  .filter(l => l.startsWith('Personalities') || l.startsWith('unused devices'))
  .map(l => `${l}\n`)
  .join('')

/** cr.59n: the captured directories-only `getfacl -n -p -c -E -s | sort -u` lines (see FIXTURES above). */
const GETFACL_CAPTURE = [
  '',
  'default:group:1005:r-x',
  'default:group::r-x',
  'default:mask::r-x',
  'default:other::r-x',
  'default:user:1005:r-x',
  'default:user::rwx',
  'group::r-x',
  'mask::r-x',
  'other::r-x',
  'user:1005:r-x',
  'user::rwx',
].map(l => `${l}\n`).join('')
/** The capture's lines without a named entry other than `default:group:1005` (a default-only grant). */
const DEFAULT_GROUP_ONLY = GETFACL_CAPTURE.split('\n').filter(l => !/^(?:user|group):\d/.test(l) && !/^default:user:\d/.test(l)).join('\n')

/** The captured `zfs userspace -Hpn` row, and its name column (the `-o name` form). */
const USERSPACE_ROW = P06.split('\n').find(l => l.startsWith('POSIX User\t'))!
assert.equal(USERSPACE_ROW, 'POSIX User\t0\t512\t1')
const NAME_COLUMN = USERSPACE_ROW.split('\t')[1]
assert.equal(NAME_COLUMN, '0')
/** `-o name` output listing these ids: the captured name column, the number rewritten. */
function spaceOutput(ids: number[]): string {
  return ids.map(id => NAME_COLUMN.replace('0', String(id))).map(l => `${l}\n`).join('')
}

const ZFS = '/usr/sbin/zfs'
const FIND = '/usr/bin/find'
const FINDMNT = '/usr/bin/findmnt'
const GETENT = '/usr/bin/getent'
const TIMEOUT = '/usr/bin/timeout'
const SORT = '/usr/bin/sort'
const CAT = '/usr/bin/cat'
const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** The smb.conf of these tests: one share on ext4 `/srv/smb/share1` (the 18.1 Samba share), one on ZFS. */
const SMB_CONF = '[global]\nworkgroup = WORKGROUP\n\n[share1]\npath = /srv/smb/share1\n\n[data]\npath = /mnttest/data\n'

interface Node {
  datasets: string[]
  /** dataset → ids `zfs userspace` lists. */
  userspace: Record<string, number[]>
  /** `find` root → uid → the first path it prints. */
  owned: Record<string, Record<number, string>>
  /** getent passwd <n> holders. */
  holders: Record<number, string>
  /** getent group <n> holders (cr.29c); absent = nobody. */
  groupHolders?: Record<number, string>
  /** cr.29b: walk roots that do not exist (find fails; stat says ENOENT). */
  missing?: string[]
  fail?: (command: string, args: string[]) => ExecResult | 'timeout' | undefined
  /** cr.59: dataset → its `acltype` (absent = `off`). */
  acltype?: Record<string, string>
  /** cr.59: ACL walk root → what `getfacl … | sort -u` prints there (absent = nothing). */
  acls?: Record<string, string>
  /** cr.59: a failing ACL walk (the pipeline's answer). */
  aclFail?: (root: string) => PipelineResult | undefined
  /** The mount table findmnt prints (default findmnt-full.json). */
  findmnt?: string
}

function fakeNode(node: Node): { executor: MockExecutor, calls: { command: string, args: string[], timeoutMs?: number }[] } {
  const executor = new MockExecutor()
  const calls: { command: string, args: string[], timeoutMs?: number }[] = []
  executor.exec = async (command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
    calls.push({ command, args, timeoutMs: opts?.timeoutMs ?? undefined })
    const failed = node.fail?.(command, args)
    if (failed === 'timeout')
      throw new CommandTimeoutError(command, args, 'request', opts?.timeoutMs ?? 0, false)
    if (failed)
      return failed
    if (command === ZFS && args[0] === 'list')
      return ok(node.datasets.map(d => `${d}\n`).join(''))
    if (command === ZFS && (args[0] === 'userspace' || args[0] === 'groupspace'))
      return ok(spaceOutput(node.userspace[args.at(-1)!] ?? []))
    if (command === ZFS && args[0] === 'get')
      return ok(node.datasets.map(d => `${d}\t${node.acltype?.[d] ?? 'off'}\n`).join(''))
    if (command === CAT && args[0] === '/proc/mdstat')
      return ok(MDSTAT_NO_ARRAYS)
    if (command === FINDMNT)
      return ok(node.findmnt ?? FINDMNT_FULL)
    if (command === TIMEOUT && args.includes('-f')) {
      // `timeout -k 1 2 stat -f -c %t -- <path>` (services/share-path.ts).
      return node.missing?.includes(args.at(-1)!)
        ? mockFixtures.statF('nonexistent path')
        : mockFixtures.statF('ext4 root (healthy local)')
    }
    if (command === FIND && node.missing?.includes(args[1])) {
      // find(1) on an absent start point: its complaint, exit 1, no output.
      return { stdout: '', stderr: `find: '${args[1]}': No such file or directory\n`, exitCode: 1 }
    }
    if (command === FIND) {
      const root = args[1]
      const test = args.includes('-uid') ? args.indexOf('-uid') : args.indexOf('-gid')
      const hit = node.owned[root]?.[Number(args[test + 1])]
      return ok(hit ? `${hit}\n` : '')
    }
    if (command === GETENT && args[0] === 'group') {
      // A `getent group` line: `name:x:gid:` (no members), like the
      // route tests' `users:x:100:` from the stunt-node capture.
      const holder = node.groupHolders?.[Number(args[1])]
      return holder ? ok(`${holder}:x:${args[1]}:\n`) : { stdout: '', stderr: '', exitCode: 2 }
    }
    if (command === GETENT) {
      const holder = node.holders[Number(args[1])]
      return holder ? ok(`${holder}:x:${args[1]}:100::/home/${holder}:/usr/sbin/nologin\n`) : { stdout: '', stderr: '', exitCode: 2 }
    }
    return { stdout: '', stderr: `unexpected ${command}`, exitCode: 127 }
  }
  // cr.59/cr.59n: the ACL walk, `find … -type d -execdir getfacl … {} + | sort -u`.
  executor.pipeline = async (cmd1: string, args1: string[], cmd2: string, args2: string[], opts?: PipelineOptions): Promise<PipelineResult> => {
    calls.push({ command: `${cmd1} | ${cmd2}`, args: [...args1, '|', ...args2], timeoutMs: opts?.timeoutMs ?? undefined })
    const root = args1[1]
    const failed = node.aclFail?.(root)
    if (failed)
      return failed
    if (node.missing?.includes(root))
      return { leftExitCode: 1, rightExitCode: 0, leftStderr: `/usr/bin/find: ‘${root}’: No such file or directory\n`, rightStderr: '', stdout: '' }
    return { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: node.acls?.[root] ?? '' }
  }
  return { executor, calls }
}

function opts(executor: MockExecutor, extra: Partial<OwnershipReadOpts> = {}): OwnershipReadOpts {
  return {
    executor,
    reads: new GuardReads(),
    smbConf: async () => SMB_CONF,
    exports: async () => '',
    ...extra,
  }
}

/** A reservation table like the route's (a plain set). */
function reservations(taken = new Set<number>()): PickReservations & { taken: Set<number> } {
  return {
    taken,
    held: n => taken.has(n),
    take: (n) => {
      if (taken.has(n))
        return false
      taken.add(n)
      return true
    },
  }
}

const BASE: Node = { datasets: ['mnttest', 'mnttest/data'], userspace: { 'mnttest': [0], 'mnttest/data': [0] }, owned: {}, holders: {} }

describe('cr.29 — zfs userspace / find argv and parsing', () => {
  it('asks zfs for numeric POSIX ids only, one field, parsable (zfs-userspace(8): -H -p -n -o name -t)', () => {
    assert.deepEqual(spaceArgs('uid', 'tank/media'), ['userspace', '-H', '-p', '-n', '-o', 'name', '-t', 'posixuser', '--', 'tank/media'])
    assert.deepEqual(spaceArgs('gid', 'tank/media'), ['groupspace', '-H', '-p', '-n', '-o', 'name', '-t', 'posixgroup', '--', 'tank/media'])
  })

  it('parses the -o name form of the P06 capture; the default-field row itself is an unknown shape (null)', () => {
    assert.deepEqual(parseSpaceIds(spaceOutput([0, 1004, 1005])), [0, 1004, 1005])
    assert.deepEqual(parseSpaceIds(''), [])
    assert.equal(parseSpaceIds(`${USERSPACE_ROW}\n`), null)
  })

  it('bounds find the way nf.1 does (-P, -xdev, the mounts below pruned) and stops at the first match', () => {
    assert.deepEqual(
      ownerFindArgs('uid', 1005, { path: '/srv/share', xdev: true, prune: ['/srv/share/nfs', '/srv/share/a*b'] }),
      ['-P', '/srv/share', '-xdev', '(', '-path', '/srv/share/nfs', '-o', '-path', '/srv/share/a\\*b', ')', '-prune', '-o', '-uid', '1005', '-print', '-quit'],
    )
    // btrfs: subvolumes are not mounts, so no -xdev (access-walk.ts).
    assert.deepEqual(ownerFindArgs('gid', 1002, { path: '/ahr/p0', xdev: false, prune: [] }), ['-P', '/ahr/p0', '-gid', '1002', '-print', '-quit'])
  })
})

describe('cr.29 — which share roots are walked (findmnt-full.json)', () => {
  const mounts = mountIndex(FINDMNT_FULL)

  it('a share on ext4 is walked; a share on ZFS is left to the accounting; NFS, CIFS and the automount are never walked', () => {
    const roots = shareWalkRoots(['/srv/smb/share1', '/mnttest/data', '/mnt/anas-nfs', '/mnt/anas-cifs', '/mnt/anas-auto'], mounts)
    assert.deepEqual(roots, [{ path: '/srv/smb/share1', xdev: true, prune: [] }])
  })

  it('every mount below a walked root is pruned; a LOCAL non-ZFS one (vfat /boot/efi) becomes a root of its own', () => {
    const roots = shareWalkRoots(['/boot'], mounts)
    assert.deepEqual(roots, [
      { path: '/boot', xdev: true, prune: ['/boot/efi'] },
      { path: '/boot/efi', xdev: true, prune: [] },
    ])
  })

  it('a share inside another share on the same filesystem is not walked twice', () => {
    const roots = shareWalkRoots(['/srv/smb/share1', '/srv/smb', '/srv/smb/'], mounts)
    assert.deepEqual(roots.map(r => r.path), ['/srv/smb'])
  })
})

describe('cr.29 — does an id own anything?', () => {
  it('nothing anywhere → owns: false, one zfs list, one findmnt, one userspace per dataset, one find per walked root (then cr.59\'s ACL read)', async () => {
    const { executor, calls } = fakeNode(BASE)
    assert.deepEqual(await idOwnership('uid', 1005, opts(executor)), { owns: false })
    assert.deepEqual(calls.map(c => `${c.command} ${c.args[0]}`), [
      `${ZFS} list`,
      `${FINDMNT} --json`,
      `${ZFS} userspace`,
      `${ZFS} userspace`,
      `${FIND} -P`,
      // cr.59: the acltype of every filesystem, the AHR pools, one ACL walk
      // per root (the ZFS share has ACLs off, so only the ext4 one).
      `${ZFS} get`,
      `${CAT} /proc/mdstat`,
      `${FIND} | ${SORT} -P`,
    ])
    assert.deepEqual(calls[0].args, ['list', '-H', '-o', 'name', '-t', 'filesystem'])
    assert.deepEqual(calls[4].args, ['-P', '/srv/smb/share1', '-xdev', '-uid', '1005', '-print', '-quit'])
  })

  it('an id ZFS accounts for owns that filesystem (no walk needed)', async () => {
    const { executor, calls } = fakeNode({ ...BASE, userspace: { 'mnttest': [0], 'mnttest/data': [0, 1005] } })
    assert.deepEqual(await idOwnership('uid', 1005, opts(executor)), { owns: true, where: `the ZFS filesystem 'mnttest/data'` })
    assert.equal(calls.some(c => c.command === FIND), false)
  })

  it('an id that owns a file under a non-ZFS share root owns it (the first path find prints)', async () => {
    const { executor } = fakeNode({ ...BASE, owned: { '/srv/smb/share1': { 1005: '/srv/smb/share1/old/report.odt' } } })
    assert.deepEqual(await idOwnership('uid', 1005, opts(executor)), { owns: true, where: `'/srv/smb/share1/old/report.odt'` })
  })

  it('groups read groupspace and find -gid', async () => {
    const { executor, calls } = fakeNode({ ...BASE, owned: { '/srv/smb/share1': { 1002: '/srv/smb/share1/x' } } })
    assert.deepEqual(await idOwnership('gid', 1002, opts(executor)), { owns: true, where: `'/srv/smb/share1/x'` })
    assert.ok(calls.some(c => c.command === ZFS && c.args[0] === 'groupspace' && c.args.includes('posixgroup')))
    assert.ok(calls.some(c => c.command === FIND && c.args.includes('-gid')))
  })

  it('a find that matched AND exited non-zero still owns; one that matched nothing and exited non-zero is unreadable', async () => {
    const hit = fakeNode({ ...BASE, fail: c => c === FIND ? { stdout: '/srv/smb/share1/a\n', stderr: 'find: ‘/srv/smb/share1/gone’: No such file or directory', exitCode: 1 } : undefined })
    assert.deepEqual(await idOwnership('uid', 1005, opts(hit.executor)), { owns: true, where: `'/srv/smb/share1/a'` })
    const miss = fakeNode({ ...BASE, fail: c => c === FIND ? { stdout: '', stderr: 'find: ‘/srv/smb/share1/gone’: No such file or directory', exitCode: 1 } : undefined })
    assert.deepEqual(await idOwnership('uid', 1005, opts(miss.executor)), { unreadable: `the files under '/srv/smb/share1' (find: find: ‘/srv/smb/share1/gone’: No such file or directory)` })
  })

  it('cr.29b: a share root that does not exist owns nothing — find fails, stat says ENOENT, and the answer is owns: false', async () => {
    const { executor, calls } = fakeNode({ ...BASE, missing: ['/srv/smb/share1'] })
    assert.deepEqual(await idOwnership('uid', 1005, opts(executor)), { owns: false })
    // The probe is the share list's own (timeout, stat -f, C locale), asked
    // only after the find failed.
    const probe = calls.find(c => c.command === TIMEOUT)
    assert.deepEqual(probe?.args, ['-k', '1', '2', '/usr/bin/stat', '-f', '-c', '%t', '--', '/srv/smb/share1'])
    assert.ok(calls.findIndex(c => c.command === FIND) < calls.findIndex(c => c.command === TIMEOUT))
    // A root that exists is never stat'ed: a clean find is the whole answer.
    const clean = fakeNode(BASE)
    await idOwnership('uid', 1005, opts(clean.executor))
    assert.equal(clean.calls.some(c => c.command === TIMEOUT), false)
  })

  it('cr.29b: a missing root no longer blocks the pick — it picks the next id as if the root were empty', async () => {
    const { executor } = fakeNode({ ...BASE, missing: ['/srv/smb/share1'] })
    const r = await pickId('uid', [0, 1000, 1004], reservations(), opts(executor))
    assert.deepEqual(r, { id: 1005, skipped: [] })
  })

  it('cr.29b: a root that EXISTS but could not be walked, or cannot be stat\'ed, still refuses (permission, I/O, stale handle)', async () => {
    const denied = 'find: \'/srv/smb/share1/private\': Permission denied'
    // The root exists (stat answers): find's failure stands.
    const exists = fakeNode({ ...BASE, fail: c => c === FIND ? { stdout: '', stderr: denied, exitCode: 1 } : undefined })
    assert.deepEqual(await idOwnership('uid', 1005, opts(exists.executor)), { unreadable: `the files under '/srv/smb/share1' (find: ${denied})` })
    // The root itself cannot be stat'ed (ESTALE): not "missing", so it refuses.
    const stale = fakeNode({ ...BASE, fail: (c) => {
      if (c === FIND)
        return { stdout: '', stderr: 'find: \'/srv/smb/share1\': Stale file handle', exitCode: 1 }
      if (c === TIMEOUT)
        return mockFixtures.statF('ESTALE: held CWD in a subdir whose server-side inode was removed')
      return undefined
    } })
    const r = await idOwnership('uid', 1005, opts(stale.executor))
    assert.ok('unreadable' in r && /Stale file handle/.test(r.unreadable), JSON.stringify(r))
    // …and the pick refuses with it, never a guess.
    const pick = await pickId('uid', [0, 1000], reservations(), opts(fakeNode({ ...BASE, fail: c => c === FIND ? { stdout: '', stderr: denied, exitCode: 1 } : undefined }).executor))
    assert.equal('refusal' in pick && pick.refusal, 'unreadable')
  })

  it('every source that cannot be read is named: zfs list, zfs userspace, an unknown userspace shape, findmnt, smb.conf, /etc/exports', async () => {
    const cases: [Partial<Node>, Partial<OwnershipReadOpts>, RegExp][] = [
      [{ fail: (c, a) => c === ZFS && a[0] === 'list' ? { stdout: '', stderr: 'internal error', exitCode: 1 } : undefined }, {}, /^the list of ZFS filesystems \(zfs list: internal error\)$/],
      [{ fail: (c, a) => c === ZFS && a[0] === 'userspace' ? { stdout: '', stderr: 'cannot get used/quota for mnttest: permission denied', exitCode: 255 } : undefined }, {}, /^ZFS's per-user accounting of 'mnttest' \(zfs userspace: cannot get used\/quota for mnttest: permission denied\)$/],
      [{ fail: (c, a) => c === ZFS && a[0] === 'userspace' ? ok(`${USERSPACE_ROW}\n`) : undefined }, {}, /answered in an unknown shape/],
      [{ fail: c => c === FINDMNT ? ok('{}') : undefined }, {}, /^the mount table \(findmnt: answered in an unknown shape\)$/],
      [{}, { smbConf: async () => null }, /^smb\.conf/],
      [{}, { exports: async () => null }, /^\/etc\/exports/],
    ]
    for (const [node, extra, want] of cases) {
      const { executor } = fakeNode({ ...BASE, ...node })
      const r = await idOwnership('uid', 1005, opts(executor, extra))
      assert.ok('unreadable' in r, `${want}: ${JSON.stringify(r)}`)
      assert.match(r.unreadable, want)
    }
  })

  it('the whole check shares one deadline: each command gets what is left, a timeout or a spent budget is unreadable', async () => {
    let clock = 1_000_000
    const { executor, calls } = fakeNode({ ...BASE, fail: (c) => {
      clock += 2_000
      return c === FIND ? 'timeout' : undefined
    } })
    const r = await idOwnership('uid', 1005, opts(executor, { now: () => clock, budgetMs: 10_000 }))
    assert.deepEqual(r, { unreadable: `the files under '/srv/smb/share1' (the check did not finish within 10 s)` })
    // zfs list got the whole budget; each later command only what was left.
    assert.equal(calls[0].timeoutMs, 10_000)
    assert.ok(calls.slice(1).every(c => (c.timeoutMs ?? 0) < 10_000))
    // Spent before the walk: nothing more is run.
    clock = 2_000_000
    const late = fakeNode({ ...BASE, fail: () => {
      clock += 20_000
      return undefined
    } })
    const r2 = await idOwnership('uid', 1005, opts(late.executor, { now: () => clock, budgetMs: 10_000 }))
    assert.deepEqual(r2, { unreadable: 'the mount table (the check did not finish within 10 s)' })
  })
})

describe('cr.29 — getent by number', () => {
  it('exit 2 is free; a passwd line is its holder; anything else is unreadable', async () => {
    const { executor } = fakeNode({ ...BASE, holders: { 1005: 'carol' } })
    assert.deepEqual(await idHolder(executor, 'uid', 1006), { holder: null })
    // cr.29c: a user found by uid carries its primary gid (field 4 of the line).
    assert.deepEqual(await idHolder(executor, 'uid', 1005), { holder: 'carol', primaryGid: 100 })
    const broken = fakeNode({ ...BASE, fail: c => c === GETENT ? { stdout: '', stderr: '', exitCode: 1 } : undefined })
    assert.deepEqual(await idHolder(broken.executor, 'uid', 1005), { unreadable: 'the account database (getent passwd 1005: exit code 1)' })
  })
})

describe('cr.29 — the pick', () => {
  it('a free id is used: the highest in-band account + 1, never a hole below it (holes are deleted accounts\' numbers)', async () => {
    const { executor } = fakeNode(BASE)
    const r = await pickId('uid', [0, 33, 1000, 1004, 65534], reservations(), opts(executor))
    assert.deepEqual(r, { id: 1005, skipped: [] })
  })

  it('no in-band account at all: the band\'s first id, 1000', async () => {
    const { executor } = fakeNode(BASE)
    assert.deepEqual(await pickId('gid', [0, 100, 65534], reservations(), opts(executor)), { id: 1000, skipped: [] })
  })

  it('an id that owns a file under a share root is skipped, and so is one ZFS accounts for', async () => {
    const { executor } = fakeNode({
      ...BASE,
      userspace: { 'mnttest': [0], 'mnttest/data': [0, 1006] },
      owned: { '/srv/smb/share1': { 1005: '/srv/smb/share1/old/report.odt' } },
    })
    const r = await pickId('uid', [1000, 1004], reservations(), opts(executor))
    assert.deepEqual(r, {
      id: 1007,
      skipped: [
        { id: 1005, where: `'/srv/smb/share1/old/report.odt'` },
        { id: 1006, where: `the ZFS filesystem 'mnttest/data'` },
      ],
    })
  })

  it('an id a directory account holds (not enumerated, found by number) and an id promised to another create are skipped', async () => {
    const { executor } = fakeNode({ ...BASE, holders: { 1005: 'ldapuser' } })
    const table = reservations(new Set([1006]))
    assert.deepEqual(await pickId('uid', [1004], table, opts(executor)), { id: 1007, skipped: [] })
    assert.ok(table.taken.has(1007), 'the pick promised what it chose')
  })

  it('cr.29c: with `avoid`, a number the other kind holds is stepped over — enumerated, promised, or found by number', async () => {
    const { executor } = fakeNode({ ...BASE, groupHolders: { 1007: 'ldapgroup' } })
    // gid 1005 is a group's (enumerated), 1006 promised to a group create,
    // 1007 a directory group only a by-number lookup finds.
    const r = await pickId('uid', [1004], reservations(), opts(executor), { ids: [1005], held: n => n === 1006 })
    assert.deepEqual(r, { id: 1008, skipped: [] })
    // Without `avoid` the pick is cr.29's: 1005.
    assert.deepEqual(await pickId('uid', [1004], reservations(), opts(executor)), { id: 1005, skipped: [] })
  })

  it('cr.29c: avoiding is "where it can": when it leaves nothing in the band, the pick runs again without it', async () => {
    const { executor } = fakeNode(BASE)
    assert.deepEqual(await pickId('uid', [1000, 59999], reservations(), opts(executor), { ids: [60000], held: () => false }), { id: 60000, skipped: [] })
  })

  it('cr.29c: a by-number lookup of the other kind that fails refuses the pick (never a guess)', async () => {
    const { executor } = fakeNode({ ...BASE, fail: (c, a) => c === GETENT && a[0] === 'group' ? { stdout: '', stderr: '', exitCode: 1 } : undefined })
    assert.deepEqual(await pickId('uid', [1004], reservations(), opts(executor), { ids: [], held: () => false }), { refusal: 'unreadable', unreadable: 'the account database (getent group 1005: exit code 1)' })
  })

  it('two picks at once get different ids (the promise is taken synchronously after the last await)', async () => {
    const { executor } = fakeNode(BASE)
    const table = reservations()
    const [a, b] = await Promise.all([
      pickId('uid', [1004], table, opts(executor)),
      pickId('uid', [1004], table, opts(executor)),
    ])
    assert.ok('id' in a && 'id' in b)
    assert.deepEqual([a.id, b.id].sort(), [1005, 1006])
  })

  it('an unreadable source refuses the pick (never a guess)', async () => {
    const { executor } = fakeNode({ ...BASE, fail: c => c === FINDMNT ? { stdout: '', stderr: 'boom', exitCode: 1 } : undefined })
    assert.deepEqual(await pickId('uid', [1004], reservations(), opts(executor)), { refusal: 'unreadable', unreadable: 'the mount table (findmnt: boom)' })
  })

  it(`gives up after ${ID_PICK_TRIES} owning ids`, async () => {
    const owners = Array.from({ length: 100 }, (_, i) => 1005 + i)
    const { executor } = fakeNode({ ...BASE, userspace: { mnttest: owners } })
    const r = await pickId('uid', [1004], reservations(), opts(executor))
    assert.equal('refusal' in r && r.refusal, 'tries')
    assert.equal('skipped' in r && r.skipped.length, ID_PICK_TRIES)
  })

  it('the band\'s top is UID_MAX 60000 itself (cr.29c): a top account of 59999 picks 60000', async () => {
    const { executor } = fakeNode(BASE)
    assert.deepEqual(await pickId('uid', [1000, 59999], reservations(), opts(executor)), { id: 60000, skipped: [] })
  })

  it('the band is full above the top account: refused, not wrapped into a hole or past UID_MAX 60000', async () => {
    const { executor } = fakeNode(BASE)
    assert.deepEqual(await pickId('uid', [1000, 60000, 60001], reservations(), opts(executor)), { refusal: 'band-full', from: 60001 })
  })
})

describe('cr.59 — ids a POSIX ACL entry names are skipped too', () => {
  /** BASE with the ZFS share's filesystem switched to POSIX ACLs (what the access editor's first named grant does). */
  const POSIX: Node = { ...BASE, acltype: { 'mnttest/data': 'posix' } }

  it('argv: every acltype in one zfs get; the walk is nf.1\'s bounded find, directories only (cr.59n), into getfacl -n -p -c -E -s, then sort -u', async () => {
    assert.deepEqual(ACLTYPE_ARGS, ['get', '-H', '-p', '-o', 'name,value', '-t', 'filesystem', 'acltype'])
    assert.deepEqual(
      aclFindArgs({ path: '/srv/share', xdev: true, prune: ['/srv/share/nfs'] }),
      ['-P', '/srv/share', '-xdev', '(', '-path', '/srv/share/nfs', ')', '-prune', '-o', '-type', 'd', '-execdir', '/usr/bin/getfacl', '-n', '-p', '-c', '-E', '-s', '{}', '+'],
    )
    // btrfs (AHR): no -xdev, as nf.1.
    assert.deepEqual(aclFindArgs({ path: '/mnt/anas-ahr/ahr0', xdev: false, prune: [] }).slice(0, 3), ['-P', '/mnt/anas-ahr/ahr0', '-type'])
    const { executor, calls } = fakeNode(POSIX)
    await idOwnership('uid', 1005, opts(executor))
    const pipe = calls.find(c => c.command === `${FIND} | ${SORT}`)!
    assert.deepEqual(pipe.args.slice(pipe.args.indexOf('|')), ['|', '-u'])
  })

  it('parses the captured getfacl lines: user: and group: entries, access and default, name ids; base entries, mask and other name nobody', () => {
    const ids = parseAclIds(GETFACL_CAPTURE)!
    assert.deepEqual(ids.uid, new Set([1005]))
    // Only the capture's DEFAULT group line names a gid now (cr.59n dropped
    // the file records); an access `group:` entry still arrives from a
    // directory's own named group grant, e.g. `setfacl -m g:1007:rw- <dir>`.
    assert.deepEqual(ids.gid, new Set([1005]))
    assert.deepEqual(parseAclIds('group:1007:rw-\n'), { uid: new Set(), gid: new Set([1007]) })
    assert.deepEqual(parseAclIds(DEFAULT_GROUP_ONLY), { uid: new Set(), gid: new Set([1005]) })
    assert.deepEqual(parseAclIds(''), { uid: new Set(), gid: new Set() })
    // A shape -n -c -E never prints is unknown, never "no grants".
    assert.equal(parseAclIds('user:alice:r-x\n'), null)
    assert.equal(parseAclIds('# file: /srv/x\nuser:1005:r-x\n'), null)
    assert.equal(parseAclIds('user:1005:r-x\t#effective:r--\n'), null)
  })

  it('reads posix / posixacl as ACLs on, anything else off; an unknown line shape is null', () => {
    assert.deepEqual(parsePosixAclFilesystems('tank\toff\ntank/a\tposix\ntank/b\tposixacl\ntank/c\tnfsv4\n'), new Set(['tank/a', 'tank/b']))
    assert.equal(parsePosixAclFilesystems('NAME\tPROPERTY\tVALUE\tSOURCE\n'), null)
  })

  it('which roots the ACL walk reads (captured mount tables): ZFS filesystems with ACLs on (shared or not), never one with ACLs off, never NFS/CIFS/automounts', () => {
    // findmnt-nested.json: gtbackup and gtbackup/cdm are posixacl, gtiscsi noacl; the .zfs snapshot automount is dropped by mountIndex.
    const nested = mountIndex(FINDMNT_NESTED)
    assert.deepEqual(aclWalkRoots([], nested, new Set(['gtbackup', 'gtbackup/cdm'])), [
      { path: '/gtbackup', xdev: true, prune: ['/gtbackup/.zfs', '/gtbackup/cdm'] },
      { path: '/gtbackup/cdm', xdev: true, prune: ['/gtbackup/cdm/.zfs'] },
    ])
    // A share on a ZFS filesystem with ACLs off is not walked; the ext4 share is.
    const full = mountIndex(FINDMNT_FULL)
    assert.deepEqual(aclWalkRoots(['/srv/smb/share1', '/mnttest/data', '/mnt/anas-nfs', '/mnt/anas-cifs', '/mnt/anas-auto'], full, new Set()), [
      { path: '/srv/smb/share1', xdev: true, prune: [] },
    ])
    // Switched on, the same filesystem is walked (with its .zfs pruned).
    assert.deepEqual(aclWalkRoots([], full, new Set(['mnttest/data'])), [{ path: '/mnttest/data', xdev: true, prune: ['/mnttest/data/.zfs'] }])
    // An AHR pool's btrfs mount (findmnt-ahr0.json): walked without -xdev.
    assert.deepEqual(aclWalkRoots(['/mnt/anas-ahr/ahr0'], mountIndex(FINDMNT_AHR0), new Set()), [{ path: '/mnt/anas-ahr/ahr0', xdev: false, prune: [] }])
  })

  it('a local filesystem mounted below a share that is not itself walked is still reached (ownership and ACL walks alike)', () => {
    // findmnt-full.json's ZFS and ext4 rows, the ext4 one re-targeted below the ZFS share.
    const full = mountIndex(FINDMNT_FULL)
    const ext4 = full.get('/')!
    const mounts = new Map<string, FindmntNode>([
      ['/', ext4],
      ['/mnttest', full.get('/mnttest')!],
      ['/mnttest/data', full.get('/mnttest/data')!],
      ['/mnttest/data/scratch', { ...ext4, target: '/mnttest/data/scratch' }],
    ])
    assert.deepEqual(shareWalkRoots(['/mnttest/data'], mounts), [{ path: '/mnttest/data/scratch', xdev: true, prune: [] }])
    assert.deepEqual(aclWalkRoots(['/mnttest/data'], mounts, new Set()), [{ path: '/mnttest/data/scratch', xdev: true, prune: [] }])
  })

  it('a root with user:1005 and default:group:1005 entries: uid 1005 and gid 1005 are skipped and the next free id is picked', async () => {
    const { executor } = fakeNode({ ...POSIX, acls: { '/mnttest/data': GETFACL_CAPTURE } })
    assert.deepEqual(await pickId('uid', [1000, 1004], reservations(), opts(executor)), {
      id: 1006,
      skipped: [{ id: 1005, where: `an ACL entry under '/mnttest/data'` }],
    })
    // A DEFAULT entry alone is enough (new files inherit it).
    const def = fakeNode({ ...POSIX, acls: { '/mnttest/data': DEFAULT_GROUP_ONLY } })
    assert.deepEqual(await pickId('gid', [100, 1004], reservations(), opts(def.executor)), {
      id: 1006,
      skipped: [{ id: 1005, where: `an ACL entry under '/mnttest/data'` }],
    })
    // The number spaces stay apart: a group: entry does not hold a uid.
    const groupOnly = fakeNode({ ...POSIX, acls: { '/mnttest/data': DEFAULT_GROUP_ONLY } })
    assert.deepEqual(await pickId('uid', [1004], reservations(), opts(groupOnly.executor)), { id: 1005, skipped: [] })
  })

  it('the review\'s scenario (M6): alice (uid 1005, top of the band) holds u:1005:r-x + a default ACL on a share and owns no file; after her delete, bob is not given 1005', async () => {
    // The access editor's grant on the shared directory: the captured
    // directory's own two named entries, nothing else named anywhere.
    const grant = 'user::rwx\nuser:1005:r-x\ngroup::r-x\nmask::r-x\nother::r-x\ndefault:user::rwx\ndefault:user:1005:r-x\ndefault:group::r-x\ndefault:mask::r-x\ndefault:other::r-x\n'
    for (const line of grant.trim().split('\n'))
      assert.ok(GETFACL_CAPTURE.split('\n').includes(line), `${line} is a captured line`)
    const node: Node = { ...POSIX, acls: { '/mnttest/data': grant } }
    // alice is gone: the accounts are 1000 and 1004; ZFS accounts uid 0 only (she never wrote a file).
    const { executor } = fakeNode(node)
    const r = await pickId('uid', [0, 1000, 1004], reservations(), opts(executor))
    assert.deepEqual(r, { id: 1006, skipped: [{ id: 1005, where: `an ACL entry under '/mnttest/data'` }] })
    // The job door's re-check (idOwnership) sees the grant as well.
    assert.deepEqual(await idOwnership('uid', 1005, opts(fakeNode(node).executor)), { owns: true, where: `an ACL entry under '/mnttest/data'` })
  })

  it('cr.59n\'s accepted miss: a hand-written grant on a single FILE is not walked, so its id stays pickable', async () => {
    // The capture tree's inherited file also carries `setfacl -m u:1006:rwx`
    // (checked 2026-10-16): the old `! -type l` walk printed its
    // `user:1006:rwx` line, the `-type d` walk does not — the file's own
    // record is never read. That is the accepted miss: the grant names no
    // default entry, nothing inherits it, so uid 1006 is not in the skip set
    // and the pick uses it (only 1005, named by the directory, is skipped).
    const { executor } = fakeNode({ ...POSIX, acls: { '/mnttest/data': GETFACL_CAPTURE } })
    assert.deepEqual(await pickId('uid', [1004], reservations(), opts(executor)), {
      id: 1006,
      skipped: [{ id: 1005, where: `an ACL entry under '/mnttest/data'` }],
    })
  })

  it('the access editor\'s roots: a ZFS filesystem with ACLs on is walked though nothing shares it, and a mounted AHR pool; an unmounted pool is not', async () => {
    const { executor, calls } = fakeNode({ ...BASE, acltype: { mnttest: 'posix' }, acls: { '/mnttest': 'user:1005:r-x\n' } })
    const noShares = opts(executor, { smbConf: async () => '' })
    assert.deepEqual(await idOwnership('uid', 1005, noShares), { owns: true, where: `an ACL entry under '/mnttest'` })
    assert.deepEqual(calls.filter(c => c.command === `${FIND} | ${SORT}`).map(c => c.args[1]), ['/mnttest'])
    const ahr = fakeNode({ ...BASE, findmnt: FINDMNT_AHR0, acls: { '/mnt/anas-ahr/ahr0': 'default:group:1009:rwx\n' } })
    const pools = async () => [{ mountpoint: '/mnt/anas-ahr/ahr0', mounted: true }, { mountpoint: '/dev/ahr1/ahr1-vol', mounted: false }]
    assert.deepEqual(await idOwnership('gid', 1009, opts(ahr.executor, { smbConf: async () => '', ahrPools: pools })), { owns: true, where: `an ACL entry under '/mnt/anas-ahr/ahr0'` })
    assert.deepEqual(ahr.calls.filter(c => c.command === `${FIND} | ${SORT}`).map(c => c.args[1]), ['/mnt/anas-ahr/ahr0'])
  })

  it('one ACL walk per root and guard run, however many candidates the pick checks', async () => {
    const owners = [1005, 1006, 1007]
    const { executor, calls } = fakeNode({ ...POSIX, userspace: { 'mnttest': owners, 'mnttest/data': [0] }, acls: { '/mnttest/data': GETFACL_CAPTURE } })
    const r = await pickId('uid', [1004], reservations(), opts(executor))
    assert.deepEqual('id' in r && r.id, 1008)
    // Roots: the ext4 share and the posix ZFS share, once each.
    assert.deepEqual(calls.filter(c => c.command === `${FIND} | ${SORT}`).map(c => c.args[1]).sort(), ['/mnttest/data', '/srv/smb/share1'])
  })

  it('an ACL read that fails refuses the pick, named (the route answers id-check-unreadable): the walk, sort, an unknown shape, zfs get, the AHR pools', async () => {
    const denied = `/usr/bin/find: ‘/mnttest/data/locked’: Permission denied\n`
    const cases: [Partial<Node>, Partial<OwnershipReadOpts>, string][] = [
      [{ aclFail: root => root === '/mnttest/data' ? { leftExitCode: 1, rightExitCode: 0, leftStderr: denied, rightStderr: '', stdout: 'user:1005:r-x\n' } : undefined }, {}, `the ACLs under '/mnttest/data' (find … getfacl: /usr/bin/find: ‘/mnttest/data/locked’: Permission denied)`],
      [{ aclFail: () => ({ leftExitCode: 0, rightExitCode: 2, leftStderr: '', rightStderr: 'sort: write failed: /tmp/sortXYZ: No space left on device\n', stdout: '' }) }, {}, `the ACLs under '/mnttest/data' (sort: sort: write failed: /tmp/sortXYZ: No space left on device)`],
      [{ acls: { '/mnttest/data': 'user:alice:r-x\n' } }, {}, `the ACLs under '/mnttest/data' (getfacl answered in an unknown shape)`],
      [{ fail: (c, a) => c === ZFS && a[0] === 'get' ? { stdout: '', stderr: 'internal error', exitCode: 1 } : undefined }, {}, 'the ACL setting (acltype) of every ZFS filesystem (zfs get acltype: internal error)'],
      [{}, { ahrPools: async () => {
        throw new Error('the AHR topology could not be read (cat /proc/mdstat exited 1: cat: /proc/mdstat: Permission denied)')
      } }, 'the AHR pools (the AHR topology could not be read (cat /proc/mdstat exited 1: cat: /proc/mdstat: Permission denied))'],
    ]
    for (const [node, extra, want] of cases) {
      const { executor } = fakeNode({ ...POSIX, ...node })
      assert.deepEqual(await pickId('uid', [1004], reservations(), opts(executor, { smbConf: async () => '[data]\npath = /mnttest/data\n', ...extra })), { refusal: 'unreadable', unreadable: want })
    }
  })

  it('a walk root that does not exist holds no grant (cr.29b\'s probe), and the ACL walk runs inside the check\'s one deadline', async () => {
    const { executor, calls } = fakeNode({ ...POSIX, missing: ['/mnttest/data'] })
    assert.deepEqual(await idOwnership('uid', 1005, opts(executor, { smbConf: async () => '[data]\npath = /mnttest/data\n' })), { owns: false })
    assert.ok(calls.some(c => c.command === TIMEOUT && c.args.at(-1) === '/mnttest/data'))
    // A pipeline that does not finish in time is the deadline's sentence.
    let clock = 5_000_000
    const slow = fakeNode({ ...POSIX, fail: () => {
      clock += 1_000
      return undefined
    }, aclFail: () => {
      throw new CommandTimeoutError(FIND, [], 'request', 1, false)
    } })
    const r = await idOwnership('uid', 1005, opts(slow.executor, { now: () => clock, budgetMs: 10_000 }))
    assert.ok('unreadable' in r && /^the ACLs under '.*' \(the check did not finish within 10 s\)$/.test(r.unreadable), JSON.stringify(r))
    assert.ok(slow.calls.filter(c => c.command === `${FIND} | ${SORT}`).every(c => (c.timeoutMs ?? 0) > 0 && (c.timeoutMs ?? 0) < 10_000))
  })
})
