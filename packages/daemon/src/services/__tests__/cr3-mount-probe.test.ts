import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MountTestRequest, normalizeMountTarget } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { runMountTest } from '../mounts.js'

/**
 * cr3.mounts M7 and L8 — the preflight probe mount (POST /v1/mounts/test and
 * the credential rotation share it).
 *
 * M7: the probe directory used to be removed with `rm -rf` in a `finally`,
 * whatever the unmount said — and a `timeout` (124) skipped the unmount
 * entirely. A probe mount still up at that point (a busy unmount, a mount the
 * kernel finished after the helper was killed) would have had its LIVE
 * remote share walked and deleted as far as the credentials allowed. The
 * fake below stands for a probe mount that stayed up: the "share's" file is
 * written into the probe directory by the mount, and the unmount fails.
 *
 * L8: a server that begins with `-` reached `mount ... <spec> <dir>` with no
 * `--`.
 */

// The probe's mount point lives under the daemon's runtime dir (cr3.mounts
// follow-up) — a private stand-in for /run/anas per test.
let runtimeRoot = ''
const savedRuntime = process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR
beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), 'anas-cr3-probe-'))
  process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR = join(runtimeRoot, 'run', 'anas')
})
afterEach(async () => {
  if (savedRuntime === undefined)
    delete process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR
  else
    process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR = savedRuntime
  await rm(runtimeRoot, { recursive: true, force: true })
})

const TIMEOUT = '/usr/bin/timeout'
const UMOUNT = '/usr/bin/umount'
const STAGES = { resolves: async () => true, tcpReachable: async () => true }

/** A mock whose probe mount leaves a file in the probe dir (the "share") and whose unmount answers `umount`. */
function probeHarness(mountExit: number, umount: ExecResult) {
  const exec = new MockExecutor()
  const seen: { probeDir?: string, umountArgs?: string[] } = {}
  const orig = exec.exec.bind(exec)
  exec.exec = async (command, args, opts) => {
    if (command === TIMEOUT) {
      seen.probeDir = args.at(-1)!
      await writeFile(join(seen.probeDir, 'precious-file-on-the-share'), 'data')
      return { stdout: '', stderr: mountExit === 124 ? '' : '', exitCode: mountExit }
    }
    if (command === UMOUNT) {
      seen.umountArgs = args
      return umount
    }
    return orig(command, args, opts)
  }
  return { exec, seen }
}

describe('cr3.mounts M7 — the probe directory is removed with rmdir only; a failed unmount is reported', () => {
  it('a probe mount that would not unmount: the share\'s file survives, the verdict says what was left', async () => {
    const { exec, seen } = probeHarness(0, { stdout: '', stderr: 'umount: target is busy.\n', exitCode: 32 })
    const result = await runMountTest(exec, { type: 'nfs', server: 'nas', remotePath: '/export' }, STAGES)
    try {
      assert.equal(result.verdict, 'ok')
      assert.ok(seen.probeDir)
      assert.equal(await readFile(join(seen.probeDir, 'precious-file-on-the-share'), 'utf8'), 'data', 'nothing inside the probe dir is ever deleted')
      assert.match(result.cleanup ?? '', /could not be unmounted \(umount: target is busy\.\)/)
      assert.match(result.cleanup ?? '', /was left in place \(ENOTEMPTY\)/)
      assert.deepEqual(seen.umountArgs, ['--', seen.probeDir])
    }
    finally {
      if (seen.probeDir)
        await rm(seen.probeDir, { recursive: true, force: true })
    }
  })

  it('a probe that timed out (124) is unmounted too — never skipped — and a directory that will not go is reported', async () => {
    const { exec, seen } = probeHarness(124, { stdout: '', stderr: 'umount: not mounted.\n', exitCode: 32 })
    const result = await runMountTest(exec, { type: 'nfs', server: 'nas', remotePath: '/export' }, STAGES)
    try {
      assert.deepEqual(seen.umountArgs, ['--', seen.probeDir], 'the unmount ran after the timeout')
      assert.notEqual(result.verdict, 'ok')
      // "not mounted" after a timeout is expected; the rmdir is the proof, and it failed here.
      assert.doesNotMatch(result.cleanup ?? '', /could not be unmounted/)
      assert.match(result.cleanup ?? '', /left in place/)
      assert.equal(await readFile(join(seen.probeDir!, 'precious-file-on-the-share'), 'utf8'), 'data')
    }
    finally {
      if (seen.probeDir)
        await rm(seen.probeDir, { recursive: true, force: true })
    }
  })

  it('a clean probe leaves no directory and reports no cleanup', async () => {
    const exec = new MockExecutor()
    let probeDir = ''
    const orig = exec.exec.bind(exec)
    exec.exec = async (command, args, opts) => {
      if (command === TIMEOUT) {
        probeDir = args.at(-1)!
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (command === UMOUNT)
        return { stdout: '', stderr: '', exitCode: 0 }
      return orig(command, args, opts)
    }
    const result = await runMountTest(exec, { type: 'nfs', server: 'nas', remotePath: '/export' }, STAGES)
    assert.equal(result.verdict, 'ok')
    assert.equal(result.cleanup, undefined)
    await assert.rejects(stat(probeDir), { code: 'ENOENT' })
  })

  it('the probe mount point is a private 0700 directory under the daemon\'s runtime dir, never os.tmpdir()', async () => {
    const exec = new MockExecutor()
    let seen: { dir: string, mode: number } | undefined
    const orig = exec.exec.bind(exec)
    exec.exec = async (command, args, opts) => {
      if (command === TIMEOUT) {
        const dir = args.at(-1)!
        seen = { dir, mode: (await stat(dir)).mode & 0o777 }
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (command === UMOUNT)
        return { stdout: '', stderr: '', exitCode: 0 }
      return orig(command, args, opts)
    }
    await runMountTest(exec, { type: 'nfs', server: 'nas', remotePath: '/export' }, STAGES)
    const base = process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR!
    assert.ok(seen && seen.dir.startsWith(`${base}/anas-mount-probe-mnt-`), `${seen?.dir} is under the runtime dir`)
    assert.ok(!seen!.dir.startsWith(`${tmpdir()}/anas-mount-probe-`), 'not os.tmpdir()')
    assert.equal(seen!.mode, 0o700)
    assert.deepEqual(await readdir(base), [], 'nothing left behind')
  })
})

describe('cr3.mounts L8 — a server beginning with `-` never reaches mount(8) as a flag', () => {
  it('the shared normaliser refuses it (every door: create, test, and the panel port)', () => {
    for (const type of ['nfs', 'cifs'] as const) {
      const n = normalizeMountTarget(type, { server: '-aoremount,ro,x-a', remotePath: 'share' })
      assert.ok(n.problems.some(p => /must not begin with '-'/.test(p)), `${type}: ${JSON.stringify(n.problems)}`)
    }
    assert.deepEqual(normalizeMountTarget('nfs', { server: 'nas-1', remotePath: '/x' }).problems, [], 'a dash inside a host is fine')
  })

  it('the probe argv puts `--` before the spec (probe p4)', async () => {
    const exec = new MockExecutor()
    exec.addFixture({ command: TIMEOUT, result: { stdout: '', stderr: 'x', exitCode: 32 } })
    await runMountTest(exec, MountTestRequest.parse({ type: 'nfs', server: 'nas', remotePath: '/export' }), STAGES)
    const probe = exec.calls.find(c => c.command === TIMEOUT)!
    const dash = probe.args.indexOf('--')
    assert.ok(dash > 0, probe.args.join(' '))
    assert.equal(probe.args[dash + 1], 'nas:/export')
  })
})

describe('cr3.mounts review 2 (6) — the start-up sweep of probe directories a crashed daemon left', () => {
  it('unmounts a leftover probe mount (never lazy, never forced), rmdirs every probe dir (never recursive), leaves everything else', async () => {
    const { mkdir: mk, writeFile: wf } = await import('node:fs/promises')
    const { sweepStaleMountProbes, MOUNT_PROBE_MOUNT_PREFIX, MOUNT_PROBE_CREDS_PREFIX } = await import('../mounts.js')
    const base = process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR!
    const mounted = join(base, `${MOUNT_PROBE_MOUNT_PREFIX}aaaa`)
    const stuck = join(base, `${MOUNT_PROBE_MOUNT_PREFIX}bbbb`)
    const idle = join(base, `${MOUNT_PROBE_MOUNT_PREFIX}cccc`)
    const creds = join(base, `${MOUNT_PROBE_CREDS_PREFIX}dddd`)
    const other = join(base, 'anas-rclone-probe-eeee')
    for (const d of [mounted, stuck, idle, creds, other])
      await mk(d, { recursive: true })
    await wf(join(creds, 'probe.cred'), 'username=u\npassword=p\n', { mode: 0o600 })
    // The "share" content a still-mounted probe shows — never walked into.
    await wf(join(stuck, 'share-file'), 'data')
    const exec = new MockExecutor()
    const table = { filesystems: [{ target: '/', source: 'rpool/ROOT/pve-1', fstype: 'zfs', options: 'rw', children: [
      { target: mounted, source: 'nas:/e', fstype: 'nfs4', options: 'rw' },
      { target: stuck, source: '//nas/s', fstype: 'cifs', options: 'rw' },
    ] }] }
    exec.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: JSON.stringify(table), stderr: '', exitCode: 0 } })
    const umounts: string[][] = []
    const orig = exec.exec.bind(exec)
    exec.exec = async (command, args, opts) => {
      // cr3.followup 9(b): the umount runs bounded, under timeout(1).
      if (command === '/usr/bin/timeout' && args.includes(UMOUNT)) {
        umounts.push(args)
        return args.at(-1) === stuck ? { stdout: '', stderr: 'umount: target is busy.', exitCode: 32 } : { stdout: '', stderr: '', exitCode: 0 }
      }
      return orig(command, args, opts)
    }
    // The directories stand for ones a crashed daemon left: made before "now".
    const report = await sweepStaleMountProbes(exec, base, Date.now() + 60_000)
    assert.deepEqual(umounts, [['-k', '1', '10', UMOUNT, '--', mounted], ['-k', '1', '10', UMOUNT, '--', stuck]], 'one plain umount per probe mount — no -l, no -f — bounded by timeout -k 1 10')
    await assert.rejects(stat(mounted), { code: 'ENOENT' })
    await assert.rejects(stat(idle), { code: 'ENOENT' })
    await assert.rejects(stat(creds), { code: 'ENOENT' })
    assert.equal(await readFile(join(stuck, 'share-file'), 'utf8'), 'data', 'a probe dir still mounted is never walked')
    await stat(other) // not ours: untouched
    assert.deepEqual(report.removed.sort(), [mounted, idle, creds].map(p => p.split('/').pop()).sort())
    assert.equal(report.failures.length, 1)
    assert.match(report.failures[0], /could not be unmounted \(umount: target is busy\.\)/)
  })

  it('an unreadable mount table unmounts nothing, still never recurses, and says so', async () => {
    const { mkdir: mk } = await import('node:fs/promises')
    const { sweepStaleMountProbes, MOUNT_PROBE_MOUNT_PREFIX } = await import('../mounts.js')
    const base = process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR!
    const d = join(base, `${MOUNT_PROBE_MOUNT_PREFIX}ffff`)
    await mk(d, { recursive: true })
    const exec = new MockExecutor()
    exec.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: '', stderr: 'x', exitCode: 1 } })
    const report = await sweepStaleMountProbes(exec, base, Date.now() + 60_000)
    assert.equal(exec.calls.filter(c => c.command === UMOUNT).length, 0)
    assert.ok(report.failures.some(f => /mount table/.test(f)), JSON.stringify(report))
    // An empty directory still goes (rmdir would refuse a mountpoint).
    await assert.rejects(stat(d), { code: 'ENOENT' })
  })

  it('review 3 (8): a symlinked probe.cred, a creds dir with more in it, a symlinked dir and a dir made after start are all left', async () => {
    const { mkdir: mk, writeFile: wf, symlink } = await import('node:fs/promises')
    const { sweepStaleMountProbes, MOUNT_PROBE_MOUNT_PREFIX, MOUNT_PROBE_CREDS_PREFIX } = await import('../mounts.js')
    const base = process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR!
    const elsewhere = join(runtimeRoot, 'elsewhere')
    await mk(elsewhere, { recursive: true })
    await wf(join(elsewhere, 'probe.cred'), 'keep')
    const credSym = join(base, `${MOUNT_PROBE_CREDS_PREFIX}sym`)
    const credTwo = join(base, `${MOUNT_PROBE_CREDS_PREFIX}two`)
    await mk(credSym, { recursive: true })
    await mk(credTwo, { recursive: true })
    await symlink(join(elsewhere, 'probe.cred'), join(credSym, 'probe.cred'))
    await wf(join(credTwo, 'probe.cred'), 'p')
    await wf(join(credTwo, 'other'), 'o')
    await symlink(elsewhere, join(base, `${MOUNT_PROBE_MOUNT_PREFIX}link`))
    const exec = new MockExecutor()
    exec.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: '{"filesystems":[]}', stderr: '', exitCode: 0 } })
    const report = await sweepStaleMountProbes(exec, base, Date.now() + 60_000)
    await stat(join(credSym, 'probe.cred')) // the symlink is not unlinked
    assert.equal(await readFile(join(credTwo, 'probe.cred'), 'utf8'), 'p')
    assert.equal(await readFile(join(elsewhere, 'probe.cred'), 'utf8'), 'keep')
    await stat(join(base, `${MOUNT_PROBE_MOUNT_PREFIX}link`))
    assert.equal(report.failures.filter(f => /other than a single regular probe\.cred/.test(f)).length, 2, JSON.stringify(report))
    // A probe directory made after this process started is this process's own.
    const mine = join(base, `${MOUNT_PROBE_MOUNT_PREFIX}mine`)
    await mk(mine)
    const again = await sweepStaleMountProbes(exec, base, Date.now() - 60_000)
    await stat(mine)
    assert.ok(!again.removed.includes(`${MOUNT_PROBE_MOUNT_PREFIX}mine`))
  })

  it('cr3.followup 9(b): a umount that does not finish is bounded — reported, the directory left, the sweep goes on', async () => {
    const { mkdir: mk } = await import('node:fs/promises')
    const { sweepStaleMountProbes, MOUNT_PROBE_MOUNT_PREFIX } = await import('../mounts.js')
    const base = process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR!
    const dead = join(base, `${MOUNT_PROBE_MOUNT_PREFIX}dead`)
    const idle = join(base, `${MOUNT_PROBE_MOUNT_PREFIX}idle`)
    for (const d of [dead, idle])
      await mk(d, { recursive: true })
    const exec = new MockExecutor()
    const table = { filesystems: [{ target: '/', source: 'rpool/ROOT/pve-1', fstype: 'zfs', options: 'rw', children: [
      { target: dead, source: 'deadnas:/e', fstype: 'nfs4', options: 'rw,hard' },
    ] }] }
    exec.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: JSON.stringify(table), stderr: '', exitCode: 0 } })
    // timeout(1)'s own answer when TERM ended the umount at its bound.
    exec.addFixture({ command: '/usr/bin/timeout', args: ['-k', '1', '10', UMOUNT, '--', dead], result: { stdout: '', stderr: '', exitCode: 124 } })
    const report = await sweepStaleMountProbes(exec, base, Date.now() + 60_000)
    assert.ok(report.failures.some(f => f.includes(`'${dead}' could not be unmounted (umount did not finish within 10 s)`)), JSON.stringify(report))
    await stat(dead)
    assert.ok(report.removed.includes(`${MOUNT_PROBE_MOUNT_PREFIX}idle`), 'the sweep went on to the next directory')
    // The call carries its own short deadline, never the 300 s background budget.
    const d = exec.deadlines.find(x => x.command === '/usr/bin/timeout')
    assert.ok(d && d.source === 'call' && d.budgetMs !== null && d.budgetMs <= 15_000, JSON.stringify(d))
  })

  it('no runtime directory is nothing to sweep', async () => {
    const { sweepStaleMountProbes } = await import('../mounts.js')
    const report = await sweepStaleMountProbes(new MockExecutor(), join(runtimeRoot, 'absent'))
    assert.deepEqual(report, { removed: [], failures: [] })
  })
})
