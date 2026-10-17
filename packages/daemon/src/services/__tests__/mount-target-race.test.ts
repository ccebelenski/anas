import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { mountThroughOpenedDir, openMountTarget } from '../mounts.js'

/**
 * Story cr.52s-a (cr.52r review defect 4): `openMountTarget` lstat-walks the
 * mountpoint's parents and then opens the leaf `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`
 * (cr.52s-f F4: fs.constants.O_PATH is undefined on node 22 and 26 — the
 * written O_PATH flag folds to 0, and the probe showed a real O_PATH would
 * buy nothing) — two separate syscalls, and O_NOFOLLOW guards only the LAST
 * component. A
 * parent exchanged for a symlink between the walk and the open used to be
 * followed: under the flip loop below, 19,596 of 70,972 opens landed on the
 * victim directory. The fix proves after the open that the pinned inode IS
 * the checked path (`readlink /proc/self/fd/N`).
 *
 * The race is driven for real: a child process exchanges a real directory
 * `p` (holding `inner`) with a symlink `px -> victim` (also holding `inner`)
 * via renameat2(RENAME_EXCHANGE) in a tight loop, while this process opens
 * `p/inner` as fast as it can. No descriptor may ever resolve into `victim`,
 * and the race must actually have been hit (refusals naming the swap), or the
 * test proves nothing. Skipped when python3 or renameat2 is unavailable.
 */

const FLIPPER = [
  'import ctypes, sys, time',
  'libc = ctypes.CDLL(None, use_errno=True)',
  'a, b, secs = sys.argv[1].encode(), sys.argv[2].encode(), float(sys.argv[3])',
  'print("ready", flush=True)',
  'end = time.time() + secs',
  'while time.time() < end:',
  '    if libc.renameat2(-100, a, -100, b, 2) != 0:',
  '        print("renameat2-unavailable", ctypes.get_errno(), flush=True)',
  '        sys.exit(3)',
].join('\n')

const RACE_BUDGET_MS = 2000
const ENOUGH_RACE_REFUSALS = 50

describe('openMountTarget — the walk/open race (cr.52s-a, review defect 4)', () => {
  it('a parent exchanged for a symlink between the walk and the open never yields a descriptor on the victim', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'anas-mt-race-'))
    try {
      await mkdir(join(base, 'p', 'inner'), { recursive: true })
      await mkdir(join(base, 'victim', 'inner'), { recursive: true })
      await symlink(join(base, 'victim'), join(base, 'px'))
      const mp = join(base, 'p', 'inner')
      const victim = join(base, 'victim')

      const child = spawn('python3', ['-c', FLIPPER, join(base, 'p'), join(base, 'px'), String(RACE_BUDGET_MS / 1000 + 1)], { stdio: ['ignore', 'pipe', 'ignore'] })
      const started = await new Promise<'ready' | string>((resolve) => {
        child.on('error', err => resolve(`spawn failed: ${err.message}`))
        child.on('exit', code => resolve(`flipper exited ${code}`))
        child.stdout.once('data', (d: Buffer) => resolve(d.toString().trim().startsWith('ready') ? 'ready' : d.toString().trim()))
      })
      if (started !== 'ready') {
        t.skip(`cannot drive the race here (python3 with renameat2 is needed): ${started}`)
        return
      }
      const exited = new Promise<number | null>(resolve => child.on('exit', resolve))
      const flipper = { died: false }
      void exited.then(() => {
        flipper.died = true
      })

      let opened = 0
      let onVictim = 0
      let raceRefusals = 0
      let symlinkRefusals = 0
      const t0 = Date.now()
      while (Date.now() - t0 < RACE_BUDGET_MS && raceRefusals < ENOUGH_RACE_REFUSALS && !flipper.died) {
        try {
          const o = await openMountTarget(mp)
          // Which inode was pinned: the victim's `inner` is never renamed, so
          // a pin on it reads back under `victim/` whatever the flipper does.
          if (readlinkSync(`/proc/self/fd/${o.fd}`).startsWith(`${victim}/`))
            onVictim++
          opened++
          await o.close()
        }
        catch (err) {
          const message = (err as Error).message
          if (message.includes('not the checked path'))
            raceRefusals++
          else if (message.includes('symlink'))
            symlinkRefusals++
          else
            throw err
        }
      }
      child.kill('SIGKILL')
      const code = await exited
      if (code === 3) {
        t.skip('renameat2(RENAME_EXCHANGE) is unavailable on this filesystem/kernel')
        return
      }
      t.diagnostic(`opened=${opened} raceRefusals=${raceRefusals} symlinkRefusals=${symlinkRefusals} onVictim=${onVictim}`)
      assert.equal(onVictim, 0, `a descriptor landed on the victim directory (${onVictim} times) — the walk/open race is open`)
      assert.ok(raceRefusals > 0, `the race was never hit in ${RACE_BUDGET_MS} ms (opened=${opened}, symlinkRefusals=${symlinkRefusals}) — the test proved nothing`)
    }
    finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('mountThroughOpenedDir guarantees -c (--no-canonicalize) on the argv, and adds nothing when the caller passed it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'anas-mt-race-'))
    try {
      const mp = join(base, 'plain')
      await mkdir(mp)
      const executor = new MockExecutor()
      executor.addFixture({ command: '/usr/bin/mount', result: { stdout: '', stderr: '', exitCode: 0 } })
      await mountThroughOpenedDir(executor, mp, ['-t', 'nfs4', '--', 'h:/x'])
      await mountThroughOpenedDir(executor, mp, ['-c', '-t', 'nfs4', '--', 'h:/x'])
      assert.deepEqual(executor.calls.map(c => c.args), [
        ['-c', '-t', 'nfs4', '--', 'h:/x', '/proc/self/fd/3/.'],
        ['-c', '-t', 'nfs4', '--', 'h:/x', '/proc/self/fd/3/.'],
      ])
    }
    finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('an unswapped mountpoint still opens, and the pin names it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'anas-mt-race-'))
    try {
      const mp = join(base, 'plain')
      await mkdir(mp)
      const o = await openMountTarget(mp)
      try {
        assert.equal(readlinkSync(`/proc/self/fd/${o.fd}`), mp)
      }
      finally {
        await o.close()
      }
    }
    finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
