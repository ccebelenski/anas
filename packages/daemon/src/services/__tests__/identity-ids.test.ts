import type { ExecOptions, ExecResult } from '../../executor/types.js'
import type { OwnershipReadOpts, PickReservations } from '../identity-ids.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CommandTimeoutError } from '../../executor/deadline.js'
import { MockExecutor } from '../../executor/mock.js'
import { GuardReads } from '../../safety/guard.js'
import {
  ID_PICK_TRIES,
  idHolder,
  idOwnership,
  ownerFindArgs,
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
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const P06 = readFileSync(join(__dirname, '../../../../../docs/probes/wave2/06-identity-allocation.txt'), 'utf-8')
const FINDMNT_FULL = readFileSync(join(FIXTURES, 'mounts/findmnt-full.json'), 'utf-8')

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
  fail?: (command: string, args: string[]) => ExecResult | 'timeout' | undefined
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
    if (command === FINDMNT)
      return ok(FINDMNT_FULL)
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
  it('nothing anywhere → owns: false, one zfs list, one findmnt, one userspace per dataset, one find per walked root', async () => {
    const { executor, calls } = fakeNode(BASE)
    assert.deepEqual(await idOwnership('uid', 1005, opts(executor)), { owns: false })
    assert.deepEqual(calls.map(c => `${c.command} ${c.args[0]}`), [
      `${ZFS} list`,
      `${FINDMNT} --json`,
      `${ZFS} userspace`,
      `${ZFS} userspace`,
      `${FIND} -P`,
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
