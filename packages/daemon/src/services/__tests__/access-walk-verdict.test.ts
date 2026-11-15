import type { SpawnedChild } from '../../executor/types.js'
import type { JobCancellation, JobContext } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ProdExecutor } from '../../executor/prod.js'
import { JobCancelledError } from '../../jobs/queue.js'
import { accessDirIo, createAccessService, mountIdsAt } from '../access.js'
import { btrfsListStandIn } from './btrfs-list-stand-in.js'

/**
 * cr3.shares, fourth review: how the writer READS the walk helper's answer,
 * and the plan's btrfs subvolume read. The helper is stood in (its own
 * behaviour is proven for real in access-acl-walk.test.ts); everything else
 * is the real writer on a real scratch directory.
 *
 *  - completed, nothing left out -> the result carries the counts;
 *  - completed, an entry swapped / an error / a filesystem nobody named ->
 *    INCOMPLETE: the job completes and says what was left out;
 *  - refused (exit 2) -> "No permissions were changed";
 *  - stopped part-way (exit 3) or no readable answer -> a failure that says
 *    files may already have changed;
 *  - a cancel -> the helper's process group is stopped and the job ends
 *    cancelled.
 *  - btrfs: `btrfs subvolume list` that answers nothing usable is a FAILED
 *    read (the plan refuses), and each nested subvolume it names is a root of
 *    its own, pinned and handed to the helper.
 */

const REAL_IO = { ...accessDirIo }
const HELPER = fileURLToPath(new URL('../anas-acl-walk.pl', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'anas-cr3-verdict-'))
after(() => {
  Object.assign(accessDirIo, REAL_IO)
  rmSync(scratch, { recursive: true, force: true })
})

const REPORT = { done: true, visited: { files: 10, dirs: 3 }, changed: { mode: 13 }, failed: { mode: 0 }, skipped: { links: 0, other: 0 }, swapped: 0, vanished: 0, boundary: 0, boundaries: [], nestedRoots: 0, zfsControl: 0, tooDeep: 0, errors: 0, maxDepth: 863, notes: [], accounted: true }
const REQ = { applyToExisting: true, entries: [{ kind: 'everyone' as const, level: 'read' as const }] }

type Answer = (stdin: string, fds: number[], onSpawn?: (c: SpawnedChild) => void) => Promise<{ stdout: string, stderr: string, exitCode: number, signal?: string }>

/** Answers that announce their own child (the cancel test). */
const answersSpawn = new Set<Answer>()

/** A child that has already exited, as the executor hands it over once the process is gone. */
function exitedChild(): SpawnedChild {
  return { pid: 1, kill: () => false, killGroup: () => false, exited: () => true, exit: Promise.resolve() }
}

/** The real tools for the reads; `answer` stands in for the helper, `override` for any other command. */
function executor(answer: Answer, override: (cmd: string, args: string[]) => { stdout: string, stderr: string, exitCode: number } | Error | null = () => null) {
  const calls: { command: string, args: string[], timeoutMs?: number | null }[] = []
  return {
    calls,
    async exec(command: string, args: string[], opts?: { inheritedFds?: number[], stdin?: string, onSpawn?: (c: SpawnedChild) => void, timeoutMs?: number | null }) {
      calls.push({ command, args, timeoutMs: opts?.timeoutMs })
      if (command === '/usr/bin/perl') {
        // Fifth review D1: the real executor announces EVERY child it spawns
        // (onSpawn), so the stand-in does too, in every test.
        if (!answersSpawn.has(answer))
          opts?.onSpawn?.(exitedChild())
        return answer(opts?.stdin ?? '', opts?.inheritedFds ?? [], opts?.onSpawn)
      }
      const o = override(command, args) ?? btrfsListStandIn(command, args)
      if (o instanceof Error)
        throw o
      if (o)
        return o
      const r = spawnSync(command, args, { encoding: 'utf8', input: opts?.stdin, stdio: ['pipe', 'pipe', 'pipe', ...(opts?.inheritedFds ?? [])] })
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 }
    },
  }
}

const answering = (report: unknown, exitCode = 0): Answer => async () => ({ stdout: `${JSON.stringify(report)}\n`, stderr: '', exitCode })

async function runWith(name: string, answer: Answer, ctx?: JobContext) {
  Object.assign(accessDirIo, REAL_IO)
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  const ex = executor(answer)
  const acc = createAccessService({ executor: ex as never, pveStorageCfg: join(scratch, 'none.cfg'), aclWalkScript: HELPER })
  const planned = await acc.planSetAccess({ kind: 'share', path: dir, home: null }, REQ)
  assert.ok(planned.ok, JSON.stringify(planned))
  return acc.runSetAccess(planned.value, () => {}, ctx)
}

describe('the writer reads the walk helper\'s answer (cr3.shares, fourth review)', () => {
  it('a completed walk with nothing left out: the result carries the counts, no INCOMPLETE', async () => {
    const r = await runWith('clean', answering(REPORT))
    assert.deepEqual((r.walk as { visited: unknown }).visited, { files: 10, dirs: 3 })
    assert.equal(r.incomplete, undefined)
  })

  it('a swapped entry: the job completes INCOMPLETE and names it', async () => {
    const r = await runWith('swapped', answering({ ...REPORT, swapped: 1, notes: [{ kind: 'swapped', name: 'team/plan.odt', ino: 77 }] }))
    assert.equal(r.incomplete, true)
    assert.match(String(r.message), /^INCOMPLETE: the walk finished, but 1 entry changed while the walk read it and was not touched \(team\/plan\.odt\)/)
  })

  it('a failed change and a filesystem the confirmation did not name: INCOMPLETE, both said', async () => {
    const r = await runWith('errors', answering({ ...REPORT, changed: { mode: 11 }, failed: { mode: 2 }, errors: 2, boundary: 1, boundaries: [{ name: 'mnt/usb', leaf: 'usb', parent: 2, dev: 9, ino: 1, mnt: 99 }], notes: [{ kind: 'error', op: 'mode', name: 'a', message: 'Operation not permitted' }] }))
    assert.equal(r.incomplete, true)
    assert.match(String(r.message), /2 change\(s\) failed \(mode: 2 of 13\) \(a\)/)
    assert.match(String(r.message), /1 folder on another filesystem that the confirmation did not name was not entered \(mnt\/usb\)/)
    assert.match(String(r.message), /Changed: mode 11 of 13 \(10 file\(s\) and 3 folder\(s\) reached\); apply again/)
  })

  it('counts that do not add up: never "every other entry was changed" (fifth review D3)', async () => {
    const r = await runWith('unaccounted', answering({ ...REPORT, accounted: false, accountingError: 'mode: 0 changed + 1 failed of 13' }))
    assert.equal(r.incomplete, true)
    assert.match(String(r.message), /its counts do not add up \(mode: 0 changed \+ 1 failed of 13\), so some entries may not have been changed/)
    assert.doesNotMatch(String(r.message), /Changed:/)
  })

  it('entries that disappeared while the walk read them: INCOMPLETE with a sentence of their own (sixth review)', async () => {
    const notes = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map(name => ({ kind: 'vanished', name }))
    const r = await runWith('vanished', answering({ ...REPORT, vanished: 300, notes }))
    assert.equal(r.incomplete, true)
    assert.match(String(r.message), /^INCOMPLETE: the walk finished, but 300 entries disappeared while the walk read them \(f1, f2, f3, f4, f5, and more\); any that were moved rather than deleted may not have been changed\. Changed: mode 13 of 13/)
    assert.doesNotMatch(String(r.message), /changed while/, 'never folded into the "folder changed while it was walked" sentence')
  })

  it('one vanished entry, next to a folder that changed: each said in its own sentence (sixth review)', async () => {
    const r = await runWith('vanished-one', answering({ ...REPORT, vanished: 1, changing: 1, notes: [{ kind: 'changing', name: 'team' }, { kind: 'vanished', name: 'team/plan.odt', ino: 77 }] }))
    assert.equal(r.incomplete, true)
    assert.match(String(r.message), /1 folder changed while it was walked, so entries added or renamed there may have been missed \(team\)/)
    assert.match(String(r.message), /1 entry disappeared while the walk read it \(team\/plan\.odt\); if it was moved rather than deleted it may not have been changed/)
  })

  it('a refusal (exit 2): no permissions were changed', async () => {
    await assert.rejects(runWith('refused', answering({ refused: 'too few file descriptors for the walk (8 levels)' }, 2)), /^Error: No permissions were changed: too few file descriptors/)
  })

  it('a walk stopped part-way (exit 3): a failure that says how far it got', async () => {
    await assert.rejects(runWith('aborted', answering({ ...REPORT, done: undefined, aborted: 'could not return to \'a\'' }, 3)), /^Error: The permission walk stopped part-way: could not return to 'a' — 10 file\(s\) and 3 folder\(s\) reached/)
  })

  it('no readable answer (killed): a failure that says files may already have changed', async () => {
    await assert.rejects(runWith('killed', async () => ({ stdout: '', stderr: '', exitCode: 1, signal: 'SIGKILL' })), /^Error: The permission walk was killed \(SIGKILL\) before it finished — some files may already have been changed/)
  })

  it('no readable answer, no signal: a failure that says files may already have changed, with what it said', async () => {
    await assert.rejects(runWith('garbled', async () => ({ stdout: 'Out of memory!\n', stderr: 'panic\n', exitCode: 1 })), /^Error: The permission walk ended without a readable report \(exit 1\) — some files may already have been changed\. panic$/)
  })

  it('a cancel stops the helper\'s whole process group and the job ends cancelled', async () => {
    let hook: ((by: JobCancellation) => Promise<void>) | null = null
    let cancelled: JobCancellation | null = null
    const ctx = {
      onCancel: (h: (by: JobCancellation) => Promise<void>) => { hook = h },
      cancellation: () => cancelled,
    } as unknown as JobContext
    const signalled: string[] = []
    const answer: Answer = async (_stdin, _fds, onSpawn) => {
      let exited = false
      let done!: () => void
      const exit = new Promise<void>((resolve) => {
        done = resolve
      })
      const child: SpawnedChild = {
        pid: 4242,
        kill: () => false,
        killGroup: (sig) => {
          signalled.push(sig)
          exited = true
          done()
          return true
        },
        exited: () => exited,
        exit,
      }
      onSpawn?.(child)
      cancelled = { user: 'root@pam', at: '2026-11-14T00:00:00Z' }
      await hook!(cancelled)
      await exit
      return { stdout: '', stderr: '', exitCode: 1, signal: 'SIGTERM' }
    }
    answersSpawn.add(answer)
    await assert.rejects(runWith('cancel', answer, ctx), (err: unknown) => err instanceof JobCancelledError && /stopped by root@pam/.test(err.message))
    assert.deepEqual(signalled, ['SIGTERM'], 'the process group got SIGTERM')
  })
})

describe('a cancelled share grant stays a cancel (fifth review D1)', () => {
  it('grantOnSharePath lets the job end cancelled instead of turning the cancel into a "failed" grant', async () => {
    Object.assign(accessDirIo, REAL_IO)
    const dir = join(scratch, 'grant-cancel')
    mkdirSync(dir, { recursive: true })
    let hook: ((by: JobCancellation) => Promise<void>) | null = null
    let cancelled: JobCancellation | null = null
    const ctx = {
      onCancel: (h: (by: JobCancellation) => Promise<void>) => {
        hook = h
      },
      cancellation: () => cancelled,
    } as unknown as JobContext
    const answer: Answer = async (_stdin, _fds, onSpawn) => {
      let exited = false
      const child: SpawnedChild = {
        pid: 4242,
        kill: () => false,
        killGroup: () => {
          exited = true
          return true
        },
        exited: () => exited,
        exit: Promise.resolve(),
      }
      onSpawn?.(child)
      cancelled = { user: 'root@pam', at: '2026-11-14T00:00:00Z' }
      await hook!(cancelled)
      return { stdout: '', stderr: '', exitCode: 1, signal: 'SIGTERM' }
    }
    answersSpawn.add(answer)
    const acc = createAccessService({ executor: executor(answer) as never, pveStorageCfg: join(scratch, 'none.cfg'), aclWalkScript: HELPER })
    await assert.rejects(
      acc.grantOnSharePath(dir, { validUsers: [], guestOk: true, readOnly: false }, true, () => {}, { recursiveConfirmed: true, ctx }),
      (err: unknown) => err instanceof JobCancelledError,
    )
  })
})

describe('the plan\'s btrfs subvolume read (cr3.shares, fourth review)', () => {
  /**
   * A scratch "pool": `dir` as a btrfs mount of subvolume @data, with the
   * directories of the captured nested subvolumes (`sv`, `plain/sv2`,
   * `sv/deep` — fixtures/ahr/btrfs-subvol-list-nested-mounted.txt).
   */
  function pool(name: string) {
    const dir = join(scratch, name)
    mkdirSync(join(dir, 'sv', 'deep'), { recursive: true })
    mkdirSync(join(dir, 'plain', 'sv2'), { recursive: true })
    const table = JSON.stringify({ filesystems: [
      { target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw', children: [
        { target: dir, source: '/dev/mapper/ahr0', fstype: 'btrfs', options: 'rw,relatime,subvol=/@data' },
      ] },
    ] })
    return { dir, table }
  }

  async function plan(name: string, list: { stdout: string, stderr: string, exitCode: number } | Error, io: Partial<typeof accessDirIo> = {}) {
    Object.assign(accessDirIo, REAL_IO, io)
    const { dir, table } = pool(name)
    const runs: { stdin: string, fds: number }[] = []
    const ex = executor(async (stdin, fds) => {
      runs.push({ stdin, fds: fds.length })
      return { stdout: `${JSON.stringify(REPORT)}\n`, stderr: '', exitCode: 0 }
    }, (cmd, args) => {
      if (cmd === '/usr/bin/findmnt' && args.join(' ') === '--json')
        return { stdout: table, stderr: '', exitCode: 0 }
      if (cmd === '/usr/bin/btrfs')
        return list
      return null
    })
    const acc = createAccessService({ executor: ex as never, pveStorageCfg: join(scratch, 'none.cfg'), aclWalkScript: HELPER })
    const planned = await acc.planSetAccess({ kind: 'share', path: dir, home: null }, REQ)
    return { dir, planned, acc, runs, calls: ex.calls }
  }
  const out = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })
  /** The `btrfs subvolume list` block of fixtures/ahr/btrfs-subvol-list-nested-mounted.txt, verbatim. */
  const NESTED_LIST = (() => {
    const lines = readFileSync(fileURLToPath(new URL('../../fixtures/ahr/btrfs-subvol-list-nested-mounted.txt', import.meta.url)), 'utf-8').split('\n')
    const at = lines.indexOf('### $ btrfs subvolume list /mnt/anas-ahr/n2ahr')
    return lines.slice(at + 1, lines.findIndex((l, i) => i > at && l.startsWith('### exit='))).map(l => `${l}\n`).join('')
  })()

  it('RED (cr3.nodefix D2): the CAPTURED list of an AHR mount names three nested subvolumes: each is a root of its own, pinned, handed to the helper', async () => {
    // The capture's own `btrfs subvolume list /mnt/anas-ahr/n2ahr` lines: on a
    // `subvol=/@data` mount the nested ones print relative to @data (`sv`,
    // `plain/sv2`, `sv/deep`). This test used to type `path @data/sub`, the
    // top-level-mount shape, which a subvolume mount never prints.
    // Review R2: the plan confirms each placement is a subvolume root (inode
    // 256 on a device of its own, as captured); these scratch folders are
    // plain, so the confirmation's own lstat says what a subvolume says.
    const real = REAL_IO.subvolumeLstat
    const scratchSub = (p: string) => ['/sv', '/plain/sv2', '/sv/deep'].some(s => p.endsWith(`/nested${s}`))
    const subvolumeLstat = async (p: string) => {
      const st = await real(p)
      return scratchSub(p) ? Object.assign(Object.create(st) as typeof st, { ino: 256, dev: st.dev + 1000 + p.length }) : st
    }
    const { dir, planned, acc, runs } = await plan('nested', out(NESTED_LIST), { subvolumeLstat })
    assert.ok(planned.ok, JSON.stringify(planned))
    await acc.runSetAccess(planned.value, () => {})
    const job = JSON.parse(runs[0].stdin) as { roots: { fd: number, path: string, dev: number, ino: number }[] }
    const sv = lstatSync(join(dir, 'sv'))
    assert.deepEqual(job.roots.map(r => [r.fd, r.path]), [[3, dir], [4, join(dir, 'plain', 'sv2')], [5, join(dir, 'sv')], [6, join(dir, 'sv', 'deep')]])
    assert.deepEqual([job.roots[2].dev, job.roots[2].ino], [sv.dev, sv.ino])
    assert.equal(runs[0].fds, 4)
  })

  it('an EMPTY list on a mount of a subvolume is a failed read: the plan refuses (never "no nested subvolumes")', async () => {
    const { planned } = await plan('empty', out(''))
    assert.equal(planned.ok, false)
    if (!planned.ok)
      assert.match(planned.failure.body.error.message, /btrfs subvolumes under .* could not be listed \(btrfs subvolume list did not list the mounted subvolume '@data' itself\)/)
  })

  it('cr3.nodefix review R2: the same CAPTURED list where the folders are plain (not subvolume roots): the plan refuses, naming the first', async () => {
    const { dir, planned, runs } = await plan('notsub', out(NESTED_LIST))
    assert.equal(planned.ok, false)
    if (!planned.ok)
      assert.ok(planned.failure.body.error.message.includes(`(btrfs subvolume list named ${dir}/sv as a subvolume, and ${dir}/sv is a plain folder, not a subvolume; `), planned.failure.body.error.message)
    assert.equal(runs.length, 0)
  })

  it('a line the parser cannot read is a failed read', async () => {
    const { planned } = await plan('garbled', out('ID 256 gen 9 top level 5 path @data\nERROR: something odd\n'))
    assert.equal(planned.ok, false)
    if (!planned.ok)
      assert.match(planned.failure.body.error.message, /answered lines it could not read/)
  })

  it('a list that does not answer in time is a failed read', async () => {
    const { planned } = await plan('hung', new Error('btrfs timed out after 60000 ms'))
    assert.equal(planned.ok, false)
    if (!planned.ok)
      assert.match(planned.failure.body.error.message, /did not answer: btrfs timed out/)
  })

  it('the list read carries a deadline (60 s), and the walk none (a whole tree; the job cancel stops it)', async () => {
    const { planned, acc, calls } = await plan('deadline', out('ID 256 gen 9 top level 5 path @data\n'))
    assert.ok(planned.ok, JSON.stringify(planned))
    await acc.runSetAccess(planned.value, () => {})
    assert.deepEqual(calls.filter(c => c.command === '/usr/bin/btrfs').map(c => [c.args.join(' '), c.timeoutMs]), [[`subvolume list ${join(scratch, 'deadline')}`, 60_000]])
    assert.deepEqual(calls.filter(c => c.command === '/usr/bin/perl').map(c => c.timeoutMs), [null])
  })
})

/**
 * Fifth review D1: every non-zero helper exit was reported as a user cancel
 * (`stoppedOnPurpose()` is true for any child the executor announced). These
 * run the REAL executor and the REAL helper, the job tampered with on its way
 * in exactly as the review's e2e probe did, and no cancel requested.
 */
describe('a helper exit that is not a cancel is never reported as one (fifth review D1)', () => {
  const prod = new ProdExecutor()
  /** A chmod that refuses every operand, naming it as the real tool does. */
  const refuser = join(scratch, 'refusing-chmod')
  writeFileSync(refuser, '#!/bin/sh\nseen=0\nfor a in "$@"; do [ "$seen" = 1 ] && echo "chmod: changing permissions of \'$a\': Operation not permitted" >&2; [ "$a" = "--" ] && seen=1; done\nexit 1\n', { mode: 0o755 })
  function tampered(name: string, tamper: { job?: (j: Record<string, any>) => void, script?: string, onSpawn?: (c: SpawnedChild) => void }) {
    Object.assign(accessDirIo, REAL_IO)
    const dir = join(scratch, name)
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 20; i++)
      writeFileSync(join(dir, `f${i}`), '')
    const calls: string[] = []
    const ex = {
      exec(command: string, args: string[], opts?: Record<string, any>) {
        calls.push(command)
        const listed = btrfsListStandIn(command, args)
        if (listed)
          return Promise.resolve(listed)
        if (command === '/usr/bin/perl' && opts?.stdin) {
          const job = JSON.parse(opts.stdin as string) as Record<string, any>
          tamper.job?.(job)
          const announce = opts.onSpawn as ((c: SpawnedChild) => void) | undefined
          opts = { ...opts, stdin: JSON.stringify(job), onSpawn: (c: SpawnedChild) => {
            announce?.(c)
            tamper.onSpawn?.(c)
          } }
        }
        return prod.exec(command, args, opts as never)
      },
    }
    const acc = createAccessService({ executor: ex as never, pveStorageCfg: join(scratch, 'none.cfg'), aclWalkScript: tamper.script ?? HELPER })
    return { dir, acc, calls }
  }
  async function run(t: ReturnType<typeof tampered>) {
    const planned = await t.acc.planSetAccess({ kind: 'share', path: t.dir, home: null }, REQ)
    assert.ok(planned.ok, JSON.stringify(planned))
    return t.acc.runSetAccess(planned.value, () => {})
  }

  it('the helper refuses (the root is not the planned directory): a failure, "No permissions were changed", never a cancel', async () => {
    const t = tampered('d1-refuse', {
      job: (j) => {
        j.roots[0].ino += 1
      },
    })
    await assert.rejects(run(t), (err: unknown) => !(err instanceof JobCancelledError) && /^No permissions were changed: the walk root '.*' is not the directory the change was planned for/.test((err as Error).message))
  })

  it('the helper script is missing: "could not be started", naming the path, nothing changed, never a cancel — and nothing ran', async () => {
    const missing = join(scratch, 'no-such-helper.pl')
    const t = tampered('d1-missing', { script: missing })
    await assert.rejects(run(t), (err: unknown) => !(err instanceof JobCancelledError) && (err as Error).message === `The permission walk could not be started: '${missing}' cannot be read (ENOENT) — no permission was changed`)
    assert.equal(t.calls.includes('/usr/bin/perl'), false, 'the helper was never run')
  })

  it('a share user cannot turn a finished walk into a failed job by naming things (fifth review D4)', async () => {
    // 400 levels of 255-byte names made of control characters (JSON writes
    // each as \\u0001), and a chmod that refuses every operand, naming it: 50
    // notes of 100 KiB paths overflowed the 10 MiB capture before.
    const t = tampered('d4-names', {
      job: (j) => {
        j.tools.chmod = refuser
      },
    })
    const deep = spawnSync('python3', ['-I', '-c', 'import os,sys\nos.chdir(sys.argv[1])\nn=bytes([1])*255\nfor i in range(400):\n    os.mkdir(n); os.chdir(n)\n', t.dir])
    assert.equal(deep.status, 0, String(deep.stderr))
    const r = await run(t)
    assert.equal(r.incomplete, true, 'the walk finished and says what failed')
    const walk = r.walk as { failed: Record<string, number>, notes: { name: string }[], notesDropped: number }
    assert.ok(walk.failed.mode > 400, `every refusal counted (${walk.failed.mode})`)
    assert.ok(walk.notes.every(n => n.name.length < 400), 'every note\'s path is bounded')
    assert.ok(walk.notesDropped > 0, 'the notes beyond the cap are counted')
  })

  it('the helper is killed from outside (SIGKILL, no cancel asked): a failure that says so, never a cancel', async () => {
    const slow = join(scratch, 'slow-setfacl')
    writeFileSync(slow, '#!/bin/sh\nsleep 5\nexec /usr/bin/setfacl "$@"\n', { mode: 0o755 })
    const t = tampered('d1-kill', {
      job: (j) => { j.tools.chmod = slow },
      onSpawn: c => setTimeout(() => { c.killGroup?.('SIGKILL') }, 300),
    })
    await assert.rejects(run(t), (err: unknown) => !(err instanceof JobCancelledError) && /^The permission walk was killed \(SIGKILL\) before it finished — some files may already have been changed/.test((err as Error).message))
  })
})

/**
 * Fifth review D6: the walk's boundaries are matched against what the plan
 * excluded by IDENTITY (mount id), never by count. The review's probe: the
 * plan excludes `share/m`; before the walk `m` is unmounted and an unnamed
 * filesystem appears at `share/x` — one boundary each way, so the old count
 * comparison said nothing was skipped unexpectedly.
 */
describe('boundaries are matched by identity, not by count (fifth review D6)', () => {
  async function excluding(name: string, answer: Answer, mountinfo?: (dir: string) => string) {
    Object.assign(accessDirIo, REAL_IO)
    const dir = join(scratch, name)
    mkdirSync(join(dir, 'm'), { recursive: true })
    const table = JSON.stringify({ filesystems: [
      { target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw', children: [
        { target: dir, source: '/dev/sdb1', fstype: 'ext4', options: 'rw', children: [
          { target: join(dir, 'm'), source: 'tmpfs', fstype: 'tmpfs', options: 'rw' },
        ] },
      ] },
    ] })
    accessDirIo.mountinfo = async () => mountinfo ? mountinfo(dir) : `50 1 8:1 / / rw - ext4 /dev/sda1 rw\n60 50 8:17 / ${dir} rw - ext4 /dev/sdb1 rw\n77 60 0:55 / ${join(dir, 'm')} rw - tmpfs tmpfs rw\n`
    const ex = executor(answer, cmd => cmd === '/usr/bin/findmnt' ? { stdout: table, stderr: '', exitCode: 0 } : null)
    const acc = createAccessService({ executor: ex as never, pveStorageCfg: join(scratch, 'none.cfg'), aclWalkScript: HELPER })
    try {
      const planned = await acc.planSetAccess({ kind: 'share', path: dir, home: null }, REQ)
      assert.ok(planned.ok, JSON.stringify(planned))
      assert.deepEqual(planned.value.walk?.excludedIds, [mountinfo ? null : { mnt: 77, parent: lstatSync(dir).ino, leaf: 'm' }], 'the plan recorded the excluded mount\'s identity (null when the table does not show it)')
      return await acc.runSetAccess(planned.value, () => {})
    }
    finally {
      Object.assign(accessDirIo, REAL_IO)
    }
  }
  /** A boundary as the helper reports it, met in the share's own directory. */
  function boundary(name: string, mnt: number | null, dir: string, dev = 55) {
    mkdirSync(dir, { recursive: true })
    return { name, leaf: name, parent: lstatSync(dir).ino, dev, ino: 1, mnt }
  }

  it('the excluded mount met where the plan saw it: complete', async () => {
    const r = await excluding('met', answering({ ...REPORT, boundary: 1, boundaries: [boundary('m', 77, join(scratch, 'met'))] }))
    assert.equal(r.incomplete, undefined, String(r.message))
  })

  it('the review\'s probe: the excluded mount gone, an unnamed one met instead — INCOMPLETE, naming both', async () => {
    // The kernel handed the new mount the SAME mount id and device number
    // (reused once the excluded one was unmounted — seen in the probe): only
    // where it sits tells them apart.
    const r = await excluding('swapped-mount', answering({ ...REPORT, boundary: 1, boundaries: [boundary('x', 77, join(scratch, 'swapped-mount'))] }))
    assert.equal(r.incomplete, true)
    assert.match(String(r.message), /1 folder on another filesystem that the confirmation did not name was not entered \(x\)/)
    assert.match(String(r.message), /1 filesystem the confirmation named as left alone was not where the walk looked \(unmounted or replaced since\), so what is there now was walked as part of the tree or left out \([^)]*\/swapped-mount\/m\)/)
  })

  it('a boundary the report could not carry counts as unnamed', async () => {
    const r = await excluding('dropped', answering({ ...REPORT, boundary: 2, boundaries: [boundary('m', 77, join(scratch, 'dropped'))], boundariesDropped: 1 }))
    assert.equal(r.incomplete, true)
    assert.match(String(r.message), /1 folder on another filesystem that the confirmation did not name/)
  })

  it('an excluded mount whose identity the plan could not read is never taken as met', async () => {
    const r = await excluding('unidentified', answering({ ...REPORT, boundary: 1, boundaries: [boundary('m', 77, join(scratch, 'unidentified'))] }), dir => `50 1 8:1 / / rw - ext4 /dev/sda1 rw\n60 50 8:17 / ${dir} rw - ext4 /dev/sdb1 rw\n`)
    assert.equal(r.incomplete, true)
    assert.match(String(r.message), /not where the walk looked/)
  })

  it('the same mount id and device at ANOTHER place is not the excluded mount', async () => {
    const near = boundary('m', 77, join(scratch, 'elsewhere'))
    const r = await excluding('elsewhere', answering({ ...REPORT, boundary: 1, boundaries: [{ ...near, parent: near.parent + 1 }] }))
    assert.equal(r.incomplete, true)
  })

  it('mountIdsAt: the visible mount of a stacked target, octal escapes read, null when absent', () => {
    const info = '10 1 0:1 / / rw - ext4 a rw\n20 10 0:2 / /srv/my\\040share rw - tmpfs t rw\n21 20 0:3 / /srv/my\\040share rw - tmpfs u rw\n'
    assert.deepEqual(mountIdsAt(info, ['/srv/my share', '/nowhere', '/']), [21, null, 10])
  })

  it('a different device at the same place and mount id still matches (btrfs reports a subvolume\'s own device)', async () => {
    const r = await excluding('otherdev', answering({ ...REPORT, boundary: 1, boundaries: [boundary('m', 77, join(scratch, 'otherdev'), 4242)] }))
    assert.equal(r.incomplete, undefined, String(r.message))
  })
})
