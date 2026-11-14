import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { accessDirIo, createAccessService } from '../access.js'
import { btrfsListStandIn } from './btrfs-list-stand-in.js'

/**
 * cr3.shares H2, the second review's races as permanent real-tool tests: a
 * swapper (renameat2 RENAME_EXCHANGE in a loop, the review's own swap.py)
 * flips a directory with a symbolic link while the REAL planner and writer
 * run the REAL find/setfacl/chmod (chown is stubbed: a test is no root).
 *
 *  - walkrace: a recursive apply (`applyToExisting`). Before the fix the walk
 *    started at the path: 481 of 537 runs changed the victim. Every walk now
 *    starts at its root's pinned descriptor.
 *  - ownrace: a root-owned link (by inode, through the lstat seam — a test
 *    cannot chown) in a USER-writable directory, exchanged with the user's
 *    own link to another dataset. Before the fix 6 of 14 bound runs wrote the
 *    other dataset. The safe-path walk never follows a link in a directory a
 *    user can write.
 *
 *  - inwalk (third review D1): INSIDE the pinned walk, an entry find has
 *    already typed (a plain file, a directory) is exchanged with the user's
 *    link to something OUTSIDE the tree; plain `chmod ./name` resolved the
 *    name again and followed the link (8 of 649 runs moved a file outside
 *    the tree 0600 -> 0646; a directory swapped for a link to a directory
 *    outside became 2755). The fourth review found `chmod -h` (coreutils
 *    9.7) and `setfacl -P` (acl 2.3.2) racing the same way; the walk is now
 *    anas-acl-walk, which acts on each entry's pinned descriptor — these
 *    run it through the REAL writer (access-acl-walk.test.ts has the
 *    per-step matrix).
 *
 * Bounded: a few seconds each. Skipped without python3 (the swapper) or
 * without POSIX ACLs on the temp filesystem.
 */

const SWAP = `import ctypes, sys, time
libc = ctypes.CDLL(None, use_errno=True)
a, b, end = sys.argv[1].encode(), sys.argv[2].encode(), time.time() + float(sys.argv[3])
while time.time() < end:
    libc.renameat2(-100, a, -100, b, 2)
`
const SECONDS = 4
const HELPER = fileURLToPath(new URL('../anas-acl-walk.pl', import.meta.url))

const scratch = mkdtempSync(join(tmpdir(), 'anas-cr3-race-'))
const REAL_IO = { ...accessDirIo }
after(() => {
  Object.assign(accessDirIo, REAL_IO)
  rmSync(scratch, { recursive: true, force: true })
})

function can(): string | false {
  try {
    execFileSync('python3', ['-c', 'import ctypes'], { stdio: 'ignore' })
    const p = join(scratch, 'probe')
    mkdirSync(p)
    execFileSync('setfacl', ['-m', 'u:nobody:r-x', '--', p], { stdio: 'ignore' })
    return false
  }
  catch {
    return 'needs python3 (the swapper) and POSIX ACLs on the temp filesystem'
  }
}
const SKIP = can()

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })
const executor = {
  async exec(cmd: string, args: string[], o?: { inheritedFds?: number[], stdin?: string, onSpawn?: (c: unknown) => void }) {
    if (cmd === '/usr/bin/chown')
      return ok('')
    // Announce the child as the real executor does (fifth review D1).
    o?.onSpawn?.({ pid: 1, kill: () => false, killGroup: () => false, exited: () => true, exit: Promise.resolve() })
    const listed = btrfsListStandIn(cmd, args)
    if (listed)
      return listed
    const r = spawnSync(cmd, args, { encoding: 'utf8', input: o?.stdin, stdio: ['pipe', 'pipe', 'pipe', ...(o?.inheritedFds ?? [])] })
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 }
  },
}

function swapper(a: string, b: string) {
  return spawn('python3', ['-I', '-c', SWAP, a, b, String(SECONDS + 1)], { stdio: 'ignore' })
}

const REQ = { entries: [{ kind: 'everyone' as const, level: 'read-write' as const }, { kind: 'user' as const, name: 'nobody', level: 'read-write' as const }] }

function victimChanged(dir: string, file?: string): boolean {
  if ((statSync(dir).mode & 0o7777) !== 0o700)
    return true
  if (file && (statSync(file).mode & 0o7777) !== 0o600)
    return true
  return execFileSync('getfacl', ['-pcR', '--', dir], { encoding: 'utf8' }).includes('nobody')
}

describe('the races of the second review, run for real (cr3.shares H2)', { skip: SKIP }, () => {
  it(`walkrace: a recursive apply under a directory/link swap never writes the victim (${SECONDS} s)`, async () => {
    Object.assign(accessDirIo, REAL_IO)
    const D = join(scratch, 'walk')
    mkdirSync(join(D, 'parent', 'team', 'media'), { recursive: true })
    mkdirSync(join(D, 'victim', 'media'), { recursive: true })
    writeFileSync(join(D, 'victim', 'media', 'secret'), 'x', { mode: 0o600 })
    symlinkSync('../victim', join(D, 'parent', '.x'))
    const P = join(D, 'parent', 'team', 'media')
    const V = join(D, 'victim', 'media')
    const acc = createAccessService({ executor: executor as never, pveStorageCfg: join(D, 'none.cfg'), aclWalkScript: HELPER })
    const sw = swapper(join(D, 'parent', 'team'), join(D, 'parent', '.x'))
    let ran = 0
    let hit = 0
    const end = Date.now() + SECONDS * 1000
    try {
      while (Date.now() < end) {
        execFileSync('chmod', ['0700', V])
        execFileSync('chmod', ['0600', join(V, 'secret')])
        spawnSync('setfacl', ['-b', V, join(V, 'secret')])
        const p = await acc.planSetAccess({ kind: 'share', path: P, home: null }, { ...REQ, applyToExisting: true })
        if (!p.ok)
          continue
        try {
          await acc.runSetAccess(p.value, () => {})
          ran++
        }
        catch {}
        if (victimChanged(V, join(V, 'secret')))
          hit++
      }
    }
    finally {
      sw.kill()
    }
    assert.ok(ran > 0, 'the walk ran at least once under the swap')
    assert.equal(hit, 0, `the victim changed after ${hit} attempts (${ran} runs completed)`)
  })

  it(`ownrace: a root-owned link in a user-writable directory is never followed, swapped or not (${SECONDS} s)`, async () => {
    const S = join(scratch, 'own')
    for (const d of ['tank/pub', 'tank/projects', 'tank/secret'])
      mkdirSync(join(S, d), { recursive: true })
    const P = join(S, 'tank', 'pub', 'projects')
    const V = join(S, 'tank', 'secret')
    symlinkSync(join(S, 'tank', 'projects'), P)
    symlinkSync(V, join(S, 'tank', 'pub', '.evil'))
    const adminIno = lstatSync(P).ino
    const userDir = join(S, 'tank', 'pub')
    // Root's link by inode; every directory root-only EXCEPT tank/pub, which
    // the share user owns and writes (as the review's probe set it up).
    accessDirIo.lstat = (async (p: string) => {
      const st = await REAL_IO.lstat(p)
      if (st.isSymbolicLink())
        return st.ino === adminIno ? Object.assign(st, { uid: 0 }) : Object.assign(st, { uid: 1000 })
      return p === userDir ? Object.assign(st, { uid: 1000 }) : Object.assign(st, { uid: 0, mode: st.mode & ~0o022 })
    }) as typeof accessDirIo.lstat
    const acc = createAccessService({ executor: executor as never, pveStorageCfg: join(S, 'none.cfg'), aclWalkScript: HELPER })
    const sw = swapper(P, join(S, 'tank', 'pub', '.evil'))
    let trials = 0
    let planned = 0
    let hit = 0
    const end = Date.now() + SECONDS * 1000
    try {
      while (Date.now() < end) {
        trials++
        execFileSync('chmod', ['0700', V])
        spawnSync('setfacl', ['-b', V])
        const t = await acc.resolveShareTarget(P)
        const p = await acc.planSetAccess(t, REQ)
        if (!p.ok)
          continue
        planned++
        try {
          await acc.runSetAccess(p.value, () => {})
        }
        catch {}
        if (victimChanged(V))
          hit++
      }
    }
    finally {
      sw.kill()
      Object.assign(accessDirIo, REAL_IO)
    }
    assert.ok(trials > 0)
    assert.equal(planned, 0, 'no plan stands on a link in a user-writable directory')
    assert.equal(hit, 0)
  })

  /** A tree wide enough that the walk is busy while a swapper flips several entries. */
  function inwalkTree(name: string): { R: string, victimFile: string, victimDir: string, pairs: [string, string][] } {
    const D = join(scratch, name)
    const R = join(D, 'share')
    mkdirSync(R, { recursive: true })
    for (let i = 0; i < 600; i++) {
      writeFileSync(join(R, `f${i}`), '')
      mkdirSync(join(R, `d${i}`))
    }
    mkdirSync(join(D, 'victim', 'dir'), { recursive: true })
    const victimFile = join(D, 'victim', 'secret')
    writeFileSync(victimFile, 'x', { mode: 0o600 })
    const victimDir = join(D, 'victim', 'dir')
    const pairs: [string, string][] = []
    for (let k = 0; k < 3; k++) {
      writeFileSync(join(R, `swapf${k}`), '')
      symlinkSync(victimFile, join(R, `.lf${k}`))
      pairs.push([join(R, `swapf${k}`), join(R, `.lf${k}`)])
      mkdirSync(join(R, `swapd${k}`))
      symlinkSync(victimDir, join(R, `.ld${k}`))
      pairs.push([join(R, `swapd${k}`), join(R, `.ld${k}`)])
    }
    return { R, victimFile, victimDir, pairs }
  }

  async function inwalkRace(name: string, req: Parameters<ReturnType<typeof createAccessService>['planSetAccess']>[1]): Promise<{ runs: number, hits: string[] }> {
    Object.assign(accessDirIo, REAL_IO)
    const t = inwalkTree(name)
    const acc = createAccessService({ executor: executor as never, pveStorageCfg: join(scratch, 'none.cfg'), aclWalkScript: HELPER })
    const swappers = t.pairs.map(([a, b]) => swapper(a, b))
    let runs = 0
    const hits: string[] = []
    const end = Date.now() + SECONDS * 1000
    try {
      while (Date.now() < end) {
        execFileSync('chmod', ['0600', t.victimFile])
        execFileSync('chmod', ['0700', t.victimDir])
        spawnSync('setfacl', ['-b', t.victimFile, t.victimDir])
        const p = await acc.planSetAccess({ kind: 'share', path: t.R, home: null }, req)
        if (!p.ok)
          continue
        runs++
        try {
          await acc.runSetAccess(p.value, () => {})
        }
        catch {}
        const f = statSync(t.victimFile).mode & 0o7777
        const d = statSync(t.victimDir).mode & 0o7777
        if (f !== 0o600 || d !== 0o700)
          hits.push(`file ${f.toString(8)} dir ${d.toString(8)}`)
      }
    }
    finally {
      for (const sw of swappers)
        sw.kill()
    }
    return { runs, hits }
  }

  it(`inwalk: the walk's chmod never follows a file swapped for a link mid-walk (${SECONDS} s)`, async () => {
    const { runs, hits } = await inwalkRace('inwalk-file', { applyToExisting: true, entries: [{ kind: 'everyone', level: 'read-write' }] })
    assert.ok(runs > 0)
    assert.deepEqual(hits, [], `a file outside the tree changed in ${hits.length} of ${runs} runs`)
  })

  it(`inwalk: the walk's setgid chmod never follows a directory swapped for a link mid-walk (${SECONDS} s)`, async () => {
    const { runs, hits } = await inwalkRace('inwalk-dir', REQ)
    assert.ok(runs > 0)
    assert.deepEqual(hits, [], `a directory outside the tree changed in ${hits.length} of ${runs} runs`)
  })

  it('a recursive "Everyone read-write" never reaches a FIFO or a socket (third review N2: regular files and directories only)', async () => {
    Object.assign(accessDirIo, REAL_IO)
    const R = join(scratch, 'special')
    mkdirSync(join(R, 'sub'), { recursive: true })
    writeFileSync(join(R, 'sub', 'file'), '', { mode: 0o600 })
    execFileSync('mkfifo', ['-m', '0600', join(R, 'sub', 'fifo')])
    const acc = createAccessService({ executor: executor as never, pveStorageCfg: join(scratch, 'none.cfg'), aclWalkScript: HELPER })
    const p = await acc.planSetAccess({ kind: 'share', path: R, home: null }, { applyToExisting: true, entries: [{ kind: 'everyone', level: 'read-write' }] })
    assert.ok(p.ok, JSON.stringify(p))
    await acc.runSetAccess(p.value, () => {})
    assert.equal(statSync(join(R, 'sub', 'fifo')).mode & 0o777, 0o600, 'the FIFO is untouched')
    assert.equal(statSync(join(R, 'sub', 'file')).mode & 0o007, 0o006, 'the regular file got everyone rw')
  })
})
