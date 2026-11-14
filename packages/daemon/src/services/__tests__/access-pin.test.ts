import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { accessDirIo, createAccessService, safeResolve } from '../access.js'
import { btrfsListStandIn } from './btrfs-list-stand-in.js'

/**
 * cr3.shares H2, the review of the first fix: a `realpath -e` check followed
 * by root writes on the same PATH STRING lost a race 1501 times in 2808 (a
 * loop exchanging the directory with a symlink). Every single-directory write
 * now goes through ONE descriptor opened no-follow and proven by readlink;
 * the tools name `/proc/self/fd/3`. These tests make the swap happen at the
 * exact instants a race would hit (through the pin's own seam), on a real
 * scratch tree with the real tools, and read the result with getfacl/stat.
 *
 * Then the ONE resolution (second review): the daemon walks the configured
 * path itself and follows a symbolic link only when root owns the link and
 * every directory from `/` down to the one holding it is root's and writable
 * by no one else — the OpenSSH safe-path rule.
 */

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })
const REAL_IO = { ...accessDirIo }
const HELPER = fileURLToPath(new URL('../anas-acl-walk.pl', import.meta.url))

const scratch = mkdtempSync(join(tmpdir(), 'anas-cr3-pin-'))
after(() => {
  Object.assign(accessDirIo, REAL_IO)
  rmSync(scratch, { recursive: true, force: true })
})

function haveAcl(): boolean {
  try {
    const p = join(scratch, 'probe')
    mkdirSync(p)
    execFileSync('setfacl', ['-m', 'u:4242:r-x', '--', p], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
}
const HAVE_ACL = haveAcl()

/** A real executor; the pinned fds handed to the child at 3, 4, ... */
function realExecutor() {
  return {
    calls: [] as { command: string, args: string[] }[],
    async exec(command: string, args: string[], opts?: { inheritedFds?: number[], stdin?: string, onSpawn?: (c: unknown) => void }) {
      this.calls.push({ command, args })
      if (command === '/usr/bin/chown')
        return ok('')
      // Announce the child as the real executor does (fifth review D1).
      opts?.onSpawn?.({ pid: 1, kill: () => false, killGroup: () => false, exited: () => true, exit: Promise.resolve() })
      const listed = btrfsListStandIn(command, args)
      if (listed)
        return listed
      const r = spawnSync(command, args, { encoding: 'utf8', input: opts?.stdin, stdio: ['pipe', 'pipe', 'pipe', ...(opts?.inheritedFds ?? [])] })
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 }
    },
  }
}

const GRANT = { entries: [
  { kind: 'owner' as const, level: 'read-write' as const },
  { kind: 'owning-group' as const, level: 'read' as const },
  { kind: 'everyone' as const, level: 'read' as const },
  { kind: 'user' as const, name: '4242', level: 'read-write' as const },
] }

/** A fresh `share/projects` directory beside a `victim` directory. */
function tree(name: string): { projects: string, victim: string, aside: string } {
  const root = join(scratch, name)
  mkdirSync(join(root, 'share', 'projects'), { recursive: true })
  mkdirSync(join(root, 'victim'))
  execFileSync('chmod', ['0700', join(root, 'victim')])
  return { projects: join(root, 'share', 'projects'), victim: join(root, 'victim'), aside: join(root, 'share', 'projects.moved') }
}

function victimUntouched(victim: string): boolean {
  const acl = execFileSync('getfacl', ['-pcn', '--', victim], { encoding: 'utf8' })
  return !acl.includes('4242') && (lstatSync(victim).mode & 0o7777) === 0o700
}

describe('every single-directory write goes through the pinned descriptor (cr3.shares H2)', { skip: HAVE_ACL ? false : 'no setfacl or no POSIX ACLs on the temp filesystem' }, () => {
  it('a swap AFTER the pin: the writes land on the directory that was checked, never on the link\'s target', async () => {
    Object.assign(accessDirIo, REAL_IO)
    const t = tree('after-pin')
    const ex = realExecutor()
    const acc = createAccessService({ executor: ex as never, pveStorageCfg: join(scratch, 'none.cfg') })
    const planned = await acc.planSetAccess({ kind: 'share', path: t.projects, home: null }, GRANT)
    assert.ok(planned.ok, JSON.stringify(planned))
    // The swap: right after the pin is proven, the name becomes a link to the victim.
    accessDirIo.readlink = async (p: string) => {
      const name = await REAL_IO.readlink(p)
      renameSync(t.projects, t.aside)
      symlinkSync(t.victim, t.projects)
      return name
    }
    await acc.runSetAccess(planned.value, () => {})
    Object.assign(accessDirIo, REAL_IO)
    assert.ok(victimUntouched(t.victim), 'the victim was not written')
    assert.match(execFileSync('getfacl', ['-pcn', '--', t.aside], { encoding: 'utf8' }), /user:4242:rwx/, 'the checked directory got the grant')
    assert.ok(ex.calls.filter(c => ['/usr/bin/setfacl', '/usr/bin/chmod'].includes(c.command)).every(c => c.args.at(-1) === '/proc/self/fd/3'))
  })

  it('a swap BEFORE the open (final component a link): the no-follow open refuses, nothing written', async () => {
    Object.assign(accessDirIo, REAL_IO)
    const t = tree('before-open')
    const acc = createAccessService({ executor: realExecutor() as never, pveStorageCfg: join(scratch, 'none.cfg') })
    const planned = await acc.planSetAccess({ kind: 'share', path: t.projects, home: null }, GRANT)
    assert.ok(planned.ok)
    accessDirIo.open = async (p: string) => {
      renameSync(t.projects, t.aside)
      symlinkSync(t.victim, t.projects)
      return REAL_IO.open(p)
    }
    await assert.rejects(acc.runSetAccess(planned.value, () => {}), /could not be opened as a plain directory/)
    Object.assign(accessDirIo, REAL_IO)
    assert.ok(victimUntouched(t.victim))
  })

  it('an EARLIER component swapped before the open: the readlink proof refuses, nothing written', async () => {
    Object.assign(accessDirIo, REAL_IO)
    const t = tree('earlier')
    const decoyShare = join(scratch, 'earlier', 'decoy')
    mkdirSync(join(decoyShare, 'projects'), { recursive: true })
    const share = join(scratch, 'earlier', 'share')
    const acc = createAccessService({ executor: realExecutor() as never, pveStorageCfg: join(scratch, 'none.cfg') })
    const planned = await acc.planSetAccess({ kind: 'share', path: t.projects, home: null }, GRANT)
    assert.ok(planned.ok)
    accessDirIo.open = async (p: string) => {
      renameSync(share, `${share}.moved`)
      symlinkSync(decoyShare, share)
      return REAL_IO.open(p)
    }
    await assert.rejects(acc.runSetAccess(planned.value, () => {}), /swapped for a symbolic link after the check/)
    Object.assign(accessDirIo, REAL_IO)
    assert.doesNotMatch(execFileSync('getfacl', ['-pcn', '--', join(decoyShare, 'projects')], { encoding: 'utf8' }), /4242/)
  })
})

describe('the pin proves the object; the walk helper gets every pinned root (cr3.shares, third review N1, fourth review)', { skip: HAVE_ACL ? false : 'no setfacl or no POSIX ACLs on the temp filesystem' }, () => {
  it('a directory replaced by ANOTHER directory of the same name after the plan is refused before any write', async () => {
    Object.assign(accessDirIo, REAL_IO)
    const t = tree('replaced')
    const acc = createAccessService({ executor: realExecutor() as never, pveStorageCfg: join(scratch, 'none.cfg') })
    const planned = await acc.planSetAccess({ kind: 'share', path: t.projects, home: null }, GRANT)
    assert.ok(planned.ok)
    // Same path, a different directory: readlink still matches, the inode does not.
    renameSync(t.projects, t.aside)
    mkdirSync(t.projects)
    await assert.rejects(acc.runSetAccess(planned.value, () => {}), /no longer the directory the change was planned for/)
    assert.doesNotMatch(execFileSync('getfacl', ['-pcn', '--', t.projects], { encoding: 'utf8' }), /4242/)
    assert.doesNotMatch(execFileSync('getfacl', ['-pcn', '--', t.aside], { encoding: 'utf8' }), /4242/)
  })

  // Fourth review: `chmod -h` is gone with find (was: "a node whose chmod
  // does not accept -h refuses a recursive apply"). What stands in its place:
  // the writer hands the helper every pinned root and reads its refusal as
  // "nothing changed".
  it('a recursive apply hands the helper each pinned root at fd 3, 4, ... and the job on stdin; a refusal changes nothing and says so', async () => {
    Object.assign(accessDirIo, REAL_IO)
    const t = tree('helper-refuses')
    const seen: { args: string[], stdin: string, fds: number, fd3: string }[] = []
    const ex = realExecutor()
    const exec = ex.exec.bind(ex)
    ex.exec = async (command: string, args: string[], opts?: { inheritedFds?: number[], stdin?: string, onSpawn?: (c: unknown) => void }) => {
      if (command !== '/usr/bin/perl')
        return exec(command, args, opts)
      opts?.onSpawn?.({ pid: 1, kill: () => false, killGroup: () => false, exited: () => true, exit: Promise.resolve() })
      const fds = opts?.inheritedFds ?? []
      seen.push({ args, stdin: opts?.stdin ?? '', fds: fds.length, fd3: readlinkSync(`/proc/self/fd/${fds[0]}`) })
      return { stdout: '{"refused":"the walk root is not the directory the change was planned for"}\n', stderr: '', exitCode: 2 }
    }
    const acc = createAccessService({ executor: ex as never, pveStorageCfg: join(scratch, 'none.cfg'), aclWalkScript: HELPER })
    const planned = await acc.planSetAccess({ kind: 'share', path: t.projects, home: null }, { ...GRANT, applyToExisting: true })
    assert.ok(planned.ok, JSON.stringify(planned))
    await assert.rejects(acc.runSetAccess(planned.value, () => {}), /^Error: No permissions were changed: the walk root is not the directory/)
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].args, [HELPER])
    assert.equal(seen[0].fds, 1)
    assert.equal(seen[0].fd3, t.projects, 'the inherited descriptor is the pinned root')
    const job = JSON.parse(seen[0].stdin) as { roots: { fd: number, path: string, dev: number, ino: number }[] }
    const st = lstatSync(t.projects)
    assert.deepEqual(job.roots, [{ fd: 3, path: t.projects, dev: st.dev, ino: st.ino, zfs: false }])
    assert.equal(ex.calls.some(c => ['/usr/bin/find', '/usr/bin/chmod', '/usr/bin/setfacl'].includes(c.command)), false, 'nothing else wrote')
  })
})

describe('the safe-path rule: a link is followed only when root owns it and every directory above it (cr3.shares H2, second review)', () => {
  // A scratch "node": S stands in for `/`. Ownership cannot be set by a test,
  // so the walk's lstat seam reports it: every directory from `/` down through
  // S is root's and writable by no one else, EXCEPT the ones in USER_DIRS (a
  // share user can write there); a link is root's only when listed in
  // ROOT_LINKS — every other link is the test user's, as a share user's would
  // be. Everything else (existence, what is a link, where it points) is the
  // real filesystem's.
  const S = join(scratch, 'safe')
  const at = (p: string) => join(S, p)
  for (const d of ['tank/data/share/sub', 'tank/data/x', 'tank/data/victim', 'tank/data/elsewhere/deep', 'tank/other', 'tank/media/x', 'mnt/pve/my store/x', 'mnt/pve/local/x', 'srv', 'home/alice', 'pub/projects', 'pub/secret'])
    mkdirSync(at(d), { recursive: true })
  mkdirSync(at('mnt/vault'), { recursive: true })
  // An administrator's links (root's, in root-only directories).
  symlinkSync(at('tank/data/share'), at('srv/share'))
  symlinkSync(at('tank/data'), at('mnt/data'))
  symlinkSync(at('tank'), at('data'))
  // A share user's links.
  symlinkSync('../victim', at('tank/data/share/projects'))
  symlinkSync(at('tank/data/elsewhere'), at('tank/data/share/team'))
  symlinkSync(at('tank/other'), at('tank/data/share/other'))
  symlinkSync('/etc', at('tank/data/share/etc'))
  // A ROOT-owned link inside a user-writable directory (the ownrace shape),
  // and one inside a sticky world-writable directory.
  symlinkSync(at('pub/projects'), at('home/alice/projects'))
  mkdirSync(at('shared-tmp'))
  symlinkSync(at('tank/data/share'), at('shared-tmp/share'))
  const ROOT_LINKS = new Set([at('srv/share'), at('mnt/data'), at('data'), at('home/alice/projects'), at('shared-tmp/share')])
  const USER_DIRS = new Map<string, { uid: number, mode: number }>([
    [at('tank/data/share'), { uid: 1000, mode: 0o40775 }],
    [at('home/alice'), { uid: 1000, mode: 0o40755 }],
    [at('shared-tmp'), { uid: 0, mode: 0o41777 }], // sticky, world-writable
  ])

  async function seamLstat(p: string) {
    const st = await REAL_IO.lstat(p)
    if (st.isSymbolicLink())
      return ROOT_LINKS.has(p) ? Object.assign(st, { uid: 0 }) : Object.assign(st, { uid: st.uid === 0 ? 1000 : st.uid })
    const user = USER_DIRS.get(p)
    if (user)
      return Object.assign(st, user)
    return Object.assign(st, { uid: 0, mode: st.mode & ~0o022 })
  }

  /** The table the coordinator asked for: configured path → R, or the refusal. */
  const ALLOWED: [string, string, string][] = [
    ['a plain dataset directory', at('tank/data/x'), at('tank/data/x')],
    ['a PVE storage path', at('mnt/pve/local/x'), at('mnt/pve/local/x')],
    ['a PVE storage whose name has a space', at('mnt/pve/my store/x'), at('mnt/pve/my store/x')],
    ['/srv/share -> /tank/data/share (root\'s convenience link)', at('srv/share'), at('tank/data/share')],
    ['/srv/share/sub', at('srv/share/sub'), at('tank/data/share/sub')],
    ['/mnt/data -> /tank/data, /mnt/data/x', at('mnt/data/x'), at('tank/data/x')],
    ['/data -> /tank, /data/media/x', at('data/media/x'), at('tank/media/x')],
    ['`.`, `..` and `//` normalised', `${at('tank/data')}//./share/../x/`, at('tank/data/x')],
  ]
  const REFUSED: [string, string, RegExp][] = [
    ['a final component symlinked to ../victim', at('tank/data/share/projects'), /owned by uid/],
    ['a middle component symlinked', at('tank/data/share/team/deep'), /owned by uid/],
    ['a link into another dataset', at('tank/data/share/other'), /owned by uid/],
    ['a link to /etc', at('tank/data/share/etc'), /owned by uid/],
    ['a root-owned link inside a user-writable directory (the ownrace shape)', at('home/alice/projects'), /'.*home\/alice' is owned by uid 1000, not root/],
    ['a root-owned link inside a sticky world-writable directory', at('shared-tmp/share'), /writable by its group or by everyone/],
    ['a path that does not exist', at('tank/nowhere'), /does not exist/],
  ]

  for (const [what, path, real] of ALLOWED) {
    it(`allowed: ${what}`, async () => {
      accessDirIo.lstat = seamLstat as typeof accessDirIo.lstat
      const walked = await safeResolve(path)
      Object.assign(accessDirIo, REAL_IO)
      assert.deepEqual(walked, { real })
    })
  }
  for (const [what, path, why] of REFUSED) {
    it(`refused: ${what}`, async () => {
      accessDirIo.lstat = seamLstat as typeof accessDirIo.lstat
      const walked = await safeResolve(path)
      Object.assign(accessDirIo, REAL_IO)
      assert.ok('refusal' in walked, JSON.stringify(walked))
      if ('refusal' in walked)
        assert.match(walked.refusal, why)
    })
  }

  it('the share target and the gates stand on R; the plan refuses what the walk refused', async () => {
    accessDirIo.lstat = seamLstat as typeof accessDirIo.lstat
    const acc = createAccessService({ executor: realExecutor() as never, pveStorageCfg: join(scratch, 'none.cfg') })
    const allowed = await acc.resolveShareTarget(at('srv/share'))
    const refused = await acc.resolveShareTarget(at('home/alice/projects'))
    Object.assign(accessDirIo, REAL_IO)
    assert.deepEqual([allowed.path, allowed.configuredPath, allowed.pathRefusal], [at('tank/data/share'), at('srv/share'), undefined])
    const planned = await acc.planSetAccess(refused, { entries: [{ kind: 'everyone', level: 'none' }] })
    assert.equal(planned.ok, false)
    if (!planned.ok)
      assert.equal(planned.failure.status, 409)
  })
})
