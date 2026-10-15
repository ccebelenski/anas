import type { AhrArraySync, AhrPool } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { readScrubSchedule, renderScrubTimerUnit, SCRUB_SERVICE_NAME, SCRUB_TIMER_NAME, writeScrubUnits } from '../scrub-schedule-units.js'
import {
  ahrScrubNote,
  ahrScrubRunning,
  foreignMdArrays,
  isEnabledArgs,
  mdcheckToggleArgs,
  parseIsEnabled,
  parseMdcheckEnabled,
  parseZfsScrubEnabled,
  readAhrScrubState,
  readZfsScrubState,
  setAhrScrubEnabled,
  setZfsScrubEnabled,
  zfsScrubGetArgs,
  zfsScrubSetArgs,
} from '../scrub-schedules.js'

const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'

describe('scrub schedules — ZFS org.debian:periodic-scrub property (GT-2)', () => {
  it('only `disable` reads as off; unset/auto/enable all scrub (default on)', () => {
    assert.equal(parseZfsScrubEnabled('disable'), false)
    assert.equal(parseZfsScrubEnabled('-'), true)
    assert.equal(parseZfsScrubEnabled(''), true)
    assert.equal(parseZfsScrubEnabled('auto'), true)
    assert.equal(parseZfsScrubEnabled('enable'), true)
    assert.equal(parseZfsScrubEnabled(' disable \n'), false)
  })

  it('readZfsScrubState reflects the property and fails open to enabled', async () => {
    const on = new MockExecutor()
    on.addFixture({ command: ZFS, args: zfsScrubGetArgs('tank'), result: { stdout: '-\n', stderr: '', exitCode: 0 } })
    assert.deepEqual(await readZfsScrubState(on, 'tank'), { target: { kind: 'zfs', pool: 'tank' }, enabled: true, cadence: 'monthly', mechanism: 'zfs-property', lastScrub: null })

    const off = new MockExecutor()
    off.addFixture({ command: ZFS, args: zfsScrubGetArgs('tank'), result: { stdout: 'disable\n', stderr: '', exitCode: 0 } })
    assert.equal((await readZfsScrubState(off, 'tank')).enabled, false)

    // Unreadable → fail-open to on (never a false "scrubbing is off").
    const err = new MockExecutor()
    err.addFixture({ command: ZFS, args: zfsScrubGetArgs('tank'), result: { stdout: '', stderr: 'no such pool', exitCode: 1 } })
    assert.equal((await readZfsScrubState(err, 'tank')).enabled, true)

    // The caller's last-scrub verdict (read once from `zpool status` for every
    // pool) rides the state; absent, the pool honestly records none.
    const verdict = {
      function: 'SCRUB',
      state: 'FINISHED',
      finishedAt: '2026-08-03T07:23:11.000Z',
      durationSeconds: 19391,
      repairedBytes: 0,
      errors: 0,
    } as const
    assert.deepEqual((await readZfsScrubState(on, 'tank', verdict)).lastScrub, verdict)
  })

  it('readZfsScrubState carries the running pass, and omits the key when idle', async () => {
    const on = new MockExecutor()
    on.addFixture({ command: ZFS, args: zfsScrubGetArgs('tank'), result: { stdout: '-\n', stderr: '', exitCode: 0 } })
    const running = { function: 'SCRUB', percent: 43.2 } as const
    assert.deepEqual((await readZfsScrubState(on, 'tank', null, running)).running, running)
    // Idle: the field is ABSENT, not a null — an old daemon's payload exactly.
    assert.equal('running' in (await readZfsScrubState(on, 'tank')), false)
  })

  it('setZfsScrubEnabled writes enable/disable surgically', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    await setZfsScrubEnabled(mock, 'tank', false)
    await setZfsScrubEnabled(mock, 'tank', true)
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.deepEqual(cmds, [
      zfsScrubSetArgs('tank', false).join(' '),
      zfsScrubSetArgs('tank', true).join(' '),
    ])
    assert.equal(zfsScrubSetArgs('tank', false).join(' '), 'set -- org.debian:periodic-scrub=disable tank')
  })

  it('setZfsScrubEnabled throws on a failed set', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: 'permission denied', exitCode: 1 } })
    await assert.rejects(() => setZfsScrubEnabled(mock, 'tank', true), /permission denied/)
  })
})

describe('scrub schedules — AHR node-level anas-scrub timer (selfheal.4)', () => {
  const TIMER_IS_ENABLED = { command: SYSTEMCTL, args: isEnabledArgs(SCRUB_TIMER_NAME), result: { stdout: 'enabled\n', stderr: '', exitCode: 0 } }
  const TIMER_IS_DISABLED = { command: SYSTEMCTL, args: isEnabledArgs(SCRUB_TIMER_NAME), result: { stdout: 'disabled\n', stderr: '', exitCode: 1 } }
  const MDCHECK_ON = { command: SYSTEMCTL, args: isEnabledArgs('mdcheck_start.timer'), result: { stdout: 'enabled\n', stderr: '', exitCode: 0 } }
  const MDCHECK_OFF = { command: SYSTEMCTL, args: isEnabledArgs('mdcheck_start.timer'), result: { stdout: 'disabled\n', stderr: '', exitCode: 1 } }
  const TIMER_NEXT = {
    command: SYSTEMCTL,
    args: ['show', SCRUB_TIMER_NAME, '-p', 'NextElapseUSecRealtime'],
    result: { stdout: 'NextElapseUSecRealtime=Sun 2026-10-04 03:00:00 UTC\n', stderr: '', exitCode: 0 },
  }

  async function stateExecutor(opts: {
    timer?: 'on' | 'off'
    mdcheck?: 'on' | 'off'
    next?: boolean
  }): Promise<MockExecutor> {
    const mock = new MockExecutor()
    mock.addFixture(opts.timer === 'off' ? TIMER_IS_DISABLED : TIMER_IS_ENABLED)
    mock.addFixture(opts.mdcheck === 'on' ? MDCHECK_ON : MDCHECK_OFF)
    if (opts.next !== false)
      mock.addFixture(TIMER_NEXT)
    // Everything else systemctl is asked (daemon-reload, enable --now) succeeds;
    // the exact-args fixtures above still win where they match.
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    return mock
  }

  it('parseMdcheckEnabled / parseIsEnabled read systemctl is-enabled output', () => {
    assert.equal(parseMdcheckEnabled('enabled\n'), true)
    assert.equal(parseIsEnabled('enabled-runtime\n'), true)
    assert.equal(parseMdcheckEnabled('disabled\n'), false)
    assert.equal(parseIsEnabled('static\n'), false)
    assert.equal(parseIsEnabled(''), false)
  })

  it('enabled = in the timer\'s pool list AND the timer enabled; cadence + nextRun + phases ride along', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-scrub-state-'))
    try {
      const exec = await stateExecutor({ timer: 'on' })
      await writeScrubUnits(exec, dir, { kind: 'ahr-scrub', cadence: 'quarterly', pools: ['ahr0'] })
      const st = await readAhrScrubState(exec, 'ahr0', null, { dir })
      assert.equal(st.enabled, true)
      assert.equal(st.cadence, 'quarterly')
      assert.equal(st.mechanism, 'anas-scrub-timer')
      assert.equal(st.nextRun, '2026-10-04T03:00:00.000Z')
      assert.deepEqual(st.phases, ['md-parity', 'btrfs-checksums'])
      assert.equal(st.lastScrub, null, 'md keeps no completion record — never manufactured')

      // A pool NOT in the list is off even though the timer runs.
      const other = await readAhrScrubState(exec, 'ahr9', null, { dir })
      assert.equal(other.enabled, false)
      assert.equal(other.nextRun, null, 'an off pool claims no next run')
      assert.deepEqual(other.phases, ['md-parity', 'btrfs-checksums'])
      // And a listed pool with the timer disabled is off too.
      const timerOff = await stateExecutor({ timer: 'off' })
      await writeScrubUnits(timerOff, dir, { kind: 'ahr-scrub', cadence: 'monthly', pools: ['ahr0'] })
      const st2 = await readAhrScrubState(timerOff, 'ahr0', null, { dir })
      assert.equal(st2.enabled, false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('the note is honest: mdcheck on ⇒ "double parity check"; foreign md arrays are named', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-scrub-note-'))
    try {
      const exec = await stateExecutor({ mdcheck: 'on' })
      await writeScrubUnits(exec, dir, { kind: 'ahr-scrub', cadence: 'monthly', pools: ['ahr0'] })
      const st = await readAhrScrubState(exec, 'ahr0', null, {
        dir,
        mdKernelNames: ['md127', 'md126', 'md9'],
        ahrKernelNames: ['md127', 'md126'],
      })
      assert.match(st.note ?? '', /double parity check: mdcheck is on/)
      assert.match(st.note ?? '', /md9 is not an ANAS pool and is not scrubbed by ANAS/)

      // With mdcheck off and no foreign arrays, the mechanism sentence stands.
      const quiet = await stateExecutor({ mdcheck: 'off' })
      const st2 = await readAhrScrubState(quiet, 'ahr0', null, {
        dir,
        mdKernelNames: ['md127'],
        ahrKernelNames: ['md127'],
      })
      assert.match(st2.note ?? '', /node-level timer/)
      assert.doesNotMatch(st2.note ?? '', /mdcheck is on/)
      assert.equal(ahrScrubNote(false, []), 'one node-level timer scrubs the enabled AHR pools sequentially (phase 1 md parity, then phase 2 btrfs checksums)')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('the LEGACY state (no ANAS units, mdcheck on) reads as mdcheck-timer with the takeover note (review F1/F4)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-scrub-legacy-'))
    try {
      // A stock or 0.3.1-upgraded node: no ANAS units, mdcheck on. That is the
      // OS's own parity check running — reported as the mechanism it is, never
      // adopted onto the ANAS timer at daemon start.
      const exec = await stateExecutor({ timer: 'off', mdcheck: 'on' })
      const st = await readAhrScrubState(exec, 'ahr0', null, { dir })
      assert.equal(st.enabled, false)
      assert.equal(st.mechanism, 'mdcheck-timer')
      assert.match(st.note ?? '', /the OS's monthly md parity check \(mdcheck\) is on/)
      // Ruling 2026-09-14: the note names it as the DISTRO DEFAULT and says
      // ANAS puts it back when the last pool's scrub goes off — a rule, not a
      // claim about this node's history.
      assert.match(st.note ?? '', /the distro default, and what ANAS puts back when the last pool's periodic scrub is turned off/)
      assert.match(st.note ?? '', /Enabling ANAS periodic scrub takes it over \(md parity \+ btrfs checksums, two phases\)/)
      assert.doesNotMatch(st.note ?? '', /double parity check/)
      assert.doesNotMatch(st.note ?? '', /adopted/)

      // Both on is the true double — unchanged wording.
      assert.equal(ahrScrubNote(true, [], true), 'double parity check: mdcheck is on')
      // Timer off + mdcheck on names the legacy state; pure note function.
      assert.match(ahrScrubNote(true, [], false), /takes it over/)
      assert.equal(ahrScrubNote(false, [], false), 'one node-level timer scrubs the enabled AHR pools sequentially (phase 1 md parity, then phase 2 btrfs checksums)')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('foreignMdArrays diffs /proc/mdstat names against the AHR bands (fail-open to none)', () => {
    assert.deepEqual(foreignMdArrays(['md127', 'md9'], ['md127']), ['md9'])
    assert.deepEqual(foreignMdArrays(['md127'], ['md127']), [])
    assert.deepEqual(foreignMdArrays(undefined, ['md127']), [])
    assert.deepEqual(foreignMdArrays([], undefined), [])
  })

  it('carries a running check, and omits the key when idle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-scrub-running-'))
    try {
      const exec = await stateExecutor({})
      await writeScrubUnits(exec, dir, { kind: 'ahr-scrub', cadence: 'monthly', pools: ['tank'] })
      const running = { percent: 12.4 }
      assert.deepEqual((await readAhrScrubState(exec, 'tank', running, { dir })).running, running)
      assert.equal('running' in (await readAhrScrubState(exec, 'tank', null, { dir })), false)
      // The absence of a COMPLETION record (the sanctioned divergence) is
      // unaffected by the presence of live progress — they are different facts.
      assert.equal((await readAhrScrubState(exec, 'tank', running, { dir })).lastScrub, null)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  describe('setAhrScrubEnabled — the pool list + mdcheck handover', () => {
    let dir: string
    let mock: MockExecutor

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'anas-scrub-toggle-'))
      mock = new MockExecutor()
      mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('enabling the FIRST pool creates the units (monthly default) and DISABLES mdcheck', async () => {
      await setAhrScrubEnabled(mock, 'ahr0', true, { dir })
      assert.deepEqual(await readScrubSchedule(dir), { kind: 'ahr-scrub', cadence: 'monthly', pools: ['ahr0'] })
      const cmds = mock.calls.map(c => c.args.join(' '))
      assert.ok(cmds.includes(`enable --now ${SCRUB_TIMER_NAME}`))
      assert.ok(cmds.includes('disable --now mdcheck_start.timer mdcheck_continue.timer'), 'ANAS owns md checks on this node — mdcheck must go off on enable')
    })

    it('enabling ADDS to the list without disturbing the other pools or the cadence', async () => {
      await setAhrScrubEnabled(mock, 'ahr0', true, { dir, cadence: 'quarterly' })
      mock.calls.length = 0
      await setAhrScrubEnabled(mock, 'ahr1', true, { dir })
      assert.deepEqual(await readScrubSchedule(dir), { kind: 'ahr-scrub', cadence: 'quarterly', pools: ['ahr0', 'ahr1'] })
      // Every enable takes mdcheck over again — idempotent, never double-scheduled.
      assert.ok(mock.calls.some(c => c.args[0] === 'disable' && c.args.includes('mdcheck_start.timer')))
    })

    it('an explicit cadence rewrites the ONE node-level timer from any pool', async () => {
      await setAhrScrubEnabled(mock, 'ahr0', true, { dir })
      await setAhrScrubEnabled(mock, 'ahr0', true, { dir, cadence: 'quarterly' })
      assert.deepEqual(await readScrubSchedule(dir), { kind: 'ahr-scrub', cadence: 'quarterly', pools: ['ahr0'] })
      assert.match(renderScrubTimerUnit((await readScrubSchedule(dir))!), /OnCalendar=Sun \*-01,04,07,10-01\.\.07 03:00:00/)
    })

    it('disabling one of several removes the pool and leaves mdcheck OFF — ANAS still owns md checks', async () => {
      await setAhrScrubEnabled(mock, 'ahr0', true, { dir })
      await setAhrScrubEnabled(mock, 'ahr1', true, { dir })
      const before = mock.calls.length
      await setAhrScrubEnabled(mock, 'ahr0', false, { dir })
      assert.deepEqual((await readScrubSchedule(dir))?.pools, ['ahr1'])
      const cmds = mock.calls.slice(before).map(c => c.args.join(' '))
      assert.ok(!cmds.some(c => c.startsWith('enable --now mdcheck')), 'the timer still runs for ahr1 — mdcheck stays off')
    })

    it('disabling the LAST pool removes the units and RESTORES mdcheck (ruling 2026-09-14)', async () => {
      await setAhrScrubEnabled(mock, 'ahr0', true, { dir })
      await setAhrScrubEnabled(mock, 'ahr1', true, { dir })
      await setAhrScrubEnabled(mock, 'ahr0', false, { dir })
      const before = mock.calls.length

      await setAhrScrubEnabled(mock, 'ahr1', false, { dir })
      assert.equal(await readScrubSchedule(dir), null, 'the empty list removes the units')
      assert.deepEqual(await readdir(dir), [], 'both unit files are gone')
      // The node is stock again, and a stock node's mdcheck timers are ON: a
      // node left with NO parity check at all is not helping or guarding.
      const cmds = mock.calls.slice(before).map(c => c.args.join(' '))
      assert.ok(
        cmds.includes('enable --now mdcheck_start.timer mdcheck_continue.timer'),
        cmds.join(' | '),
      )
    })

    it('disabling a pool that was never enabled changes NOTHING — and never turns mdcheck on (N4)', async () => {
      // The node has no ANAS schedule at all, so the list is empty. Filtering
      // an absent pool out of it left an empty list, which read as "the LAST
      // pool just went off" — and the toggle then ran
      // `systemctl enable --now mdcheck_*.timer`, starting a node-wide md
      // parity check nobody asked for. mdcheck is given back only when ANAS
      // took it.
      await setAhrScrubEnabled(mock, 'ahr0', false, { dir })
      assert.equal(await readScrubSchedule(dir), null)
      assert.deepEqual(await readdir(dir), [])
      assert.deepEqual(mock.calls, [], 'a no-op disable issues no systemctl at all')

      // Same with a schedule that exists but does not name this pool: ahr1's
      // timer keeps running, and ahr0 was never on it.
      await setAhrScrubEnabled(mock, 'ahr1', true, { dir })
      const before = mock.calls.length
      await setAhrScrubEnabled(mock, 'ahr0', false, { dir })
      assert.deepEqual((await readScrubSchedule(dir))?.pools, ['ahr1'], 'ahr1 is untouched')
      assert.deepEqual(mock.calls.slice(before), [])
    })

    it('a FAILED mdcheck restore is logged, not thrown — the toggle still lands', async () => {
      const lines: string[] = []
      const origErr = process.stderr.write.bind(process.stderr)
      process.stderr.write = (s: string | Uint8Array) => {
        lines.push(String(s))
        return true
      }
      try {
        await setAhrScrubEnabled(mock, 'ahr0', true, { dir })
        mock.addFixture({
          command: SYSTEMCTL,
          args: mdcheckToggleArgs(true),
          result: { stdout: '', stderr: 'unit not found', exitCode: 1 },
        })
        await setAhrScrubEnabled(mock, 'ahr0', false, { dir })
        assert.equal(await readScrubSchedule(dir), null, 'the units still went')
        assert.ok(lines.some(l => l.includes('restore the mdcheck timers')), lines.join(''))
      }
      finally {
        process.stderr.write = origErr
      }
    })

    it('a FAILED mdcheck disable is logged, not thrown — the toggle still lands', async () => {
      const lines: string[] = []
      const origErr = process.stderr.write.bind(process.stderr)
      process.stderr.write = (s: string | Uint8Array) => {
        lines.push(String(s))
        return true
      }
      try {
        mock.addFixture({
          command: SYSTEMCTL,
          args: mdcheckToggleArgs(false),
          result: { stdout: '', stderr: 'unit not found', exitCode: 1 },
        })
        await setAhrScrubEnabled(mock, 'ahr0', true, { dir })
        assert.deepEqual((await readScrubSchedule(dir))?.pools, ['ahr0'])
        assert.ok(lines.some(l => l.includes('mdcheck')), 'the failure is said in journald, never silent')
      }
      finally {
        process.stderr.write = origErr
      }
    })

    it('a foreign anas-scrub unit is refused on BOTH directions — never rewritten, never deleted (review R10)', async () => {
      await writeFile(join(dir, SCRUB_SERVICE_NAME), '[Unit]\nDescription=someone else\'s unit\n')
      await assert.rejects(
        () => setAhrScrubEnabled(mock, 'ahr0', true, { dir }),
        (err: NodeJS.ErrnoException) => (err as Error).name === 'ForeignUnitError',
      )
      await assert.rejects(
        () => setAhrScrubEnabled(mock, 'ahr0', false, { dir }),
        /not an ANAS unit/,
      )
      // The foreign file is untouched — nothing was written, nothing deleted.
      assert.equal(await readFile(join(dir, SCRUB_SERVICE_NAME), 'utf-8'), '[Unit]\nDescription=someone else\'s unit\n')
      assert.equal(await readScrubSchedule(dir), null)
    })
  })
})

// The mdcheck adoption is GONE (review F1/F4, design reversal 2026-09-13):
// mdcheck's timers are enabled by default on a stock node, so "mdcheck is on"
// is not an opt-in, and a daemon that armed a monthly multi-hour scrub — and
// switched the OS parity check off — on its own was overreach. The per-pool
// toggle is the only thing that writes units. This guard is STRUCTURAL (third
// pass): it resolves the daemon's transitive static import graph from index.ts
// (a string scan over relative specifiers — no bundler) and asserts the scrub
// store never leaves the toggle route + store layer: no startup path outside
// routes/ imports it, and the unit-WRITE surface is named nowhere else. No
// startup path can write a unit or arm a timer, whatever a future edit adds;
// grepping index.ts's own text alone would miss the import arriving one hop
// away.
describe('no mdcheck adoption at daemon start (review F1/F4) — structural guard', () => {
  const SRC_ROOT = new URL('../../', import.meta.url)
  const INDEX_URL = new URL('../../index.ts', import.meta.url)
  const STORE_RE = /scrub-schedule-units|scrub-schedules/

  /** Relative './x.js' specifiers of a module's static imports (string scan). */
  function importSpecifiers(src: string): string[] {
    return Array.from(src.matchAll(/(?:\bfrom\s+|\bimport\s+)['"](\.[^'"]+)['"]/g), m => m[1])
  }

  /**
   * Modules reachable from `entry` over relative imports that stay inside
   * packages/daemon/src. Modules under routes/ are expanded only when asked:
   * the start-path walk treats them as leaves (their subtrees ARE the routes
   * trees), the per-route walk follows them all the way down.
   */
  async function reachableFrom(entry: URL, expandRoutes: boolean): Promise<Set<string>> {
    const seen = new Set<string>()
    const queue = [entry]
    while (queue.length > 0) {
      const url = queue.shift()!
      if (seen.has(url.href) || !url.href.startsWith(SRC_ROOT.href))
        continue
      seen.add(url.href)
      if (!expandRoutes && url.href.includes('/src/routes/'))
        continue
      const src = await readFile(fileURLToPath(url), 'utf-8')
      for (const spec of importSpecifiers(src)) {
        // Source imports name the COMPILED '.js'; the tree here is the '.ts'.
        const tsHref = new URL(spec, url).href.replace(/\.js$/, '.ts')
        queue.push(new URL(tsHref))
      }
    }
    return seen
  }

  it('nothing outside the routes tree on the start path reaches the scrub store', async () => {
    const offenders: string[] = []
    for (const href of await reachableFrom(INDEX_URL, false)) {
      if (href.includes('/src/routes/'))
        continue // the routes tree is the sanctioned door
      // The preset ruling (decision-tree F7) gives selfheal-reconcile ONE
      // read-only store read — the schedule the mdcheck-ownership note is
      // decided from. Its writes stay guarded by the next test, which holds
      // that file to the write verbs it may never name.
      if (href.endsWith('/services/selfheal-reconcile.ts'))
        continue
      // The store layer itself, reached through the F7 read (and through
      // ahr-scrub's borrow of mismatchCntArgs, now on the start path via
      // selfheal-reconcile → selfheal-repair → ahr-repair): these two files
      // legitimately name each other. What matters is that no NEW module on
      // the start path names the store — the write surface is guarded below.
      if (href.endsWith('/services/scrub-schedules.ts') || href.endsWith('/services/scrub-schedule-units.ts'))
        continue
      const src = await readFile(fileURLToPath(new URL(href)), 'utf-8')
      if (STORE_RE.test(src))
        offenders.push(href.slice(SRC_ROOT.href.length))
    }
    assert.deepEqual(offenders, [], 'the daemon start path imports the scrub store outside routes/')
  })

  it('the unit-WRITE surface is reachable only through the store layer and the toggle route', async () => {
    // ahr-scrub.ts borrows mismatchCntArgs from scrub-schedules (an argv
    // helper), so bare module reachability cannot read "only via routes/scrub.ts"
    // — the invariant that matters is the WRITE surface: writeScrubUnits /
    // removeScrubUnits are named only by the store layer itself, and the store
    // is wired only through routes/scrub.ts. The routes tree is NOT skipped
    // wholesale (fourth pass): skipping it let ANY route name the write
    // surface unnoticed — only routes/scrub.ts is the sanctioned door.
    const full = await reachableFrom(INDEX_URL, true)
    assert.ok(
      [...full].some(href => href.endsWith('/scrub-schedule-units.ts')),
      'the toggle wiring reaches the unit store — the guard watches a live path',
    )
    const offenders: string[] = []
    for (const href of full) {
      const rel = href.slice(SRC_ROOT.href.length)
      if (rel === 'services/scrub-schedules.ts' || rel === 'services/scrub-schedule-units.ts')
        continue // the store layer itself
      if (rel === 'routes/scrub.ts')
        continue // the sanctioned door
      const src = await readFile(fileURLToPath(new URL(href)), 'utf-8')
      if (rel === 'services/selfheal-reconcile.ts') {
        // The F7 exception is READ-ONLY and narrow: the mdcheck-ownership note
        // may read the schedule and mdcheck's is-enabled state, and may name
        // NO write surface at all — not the unit writes, not the toggle.
        if (/\bwriteScrubUnits\b|\bremoveScrubUnits\b|\bsetAhrScrubEnabled\b|\bsetMdcheck\b|\bmdcheckToggleArgs\b/.test(src))
          offenders.push(rel)
        continue
      }
      if (rel === 'services/pool-references.ts') {
        // The cr.24 exception is READ-ONLY and narrow: the pool-reference
        // helper reads the node-level schedule to LIST AHR scrub targets as
        // pool references (export/destroy warnings) and may name NO write
        // surface at all — not the unit writes, not the toggle.
        if (/\bwriteScrubUnits\b|\bremoveScrubUnits\b|\bsetAhrScrubEnabled\b|\bsetMdcheck\b|\bmdcheckToggleArgs\b/.test(src))
          offenders.push(rel)
        continue
      }
      if (/\bwriteScrubUnits\b|\bremoveScrubUnits\b|scrub-schedule-units/.test(src))
        offenders.push(rel)
    }
    assert.deepEqual(offenders, [], 'the scrub unit write surface leaked outside the store layer + toggle route')
  })

  it('and the module no longer even exports an adoption to call', async () => {
    const mod = await import('../scrub-schedules.js')
    for (const key of Object.keys(mod))
      assert.doesNotMatch(key, /[Aa]dopt/, `scrub-schedules must not export ${key}`)
  })
})

// md reports progress PER ARRAY and an AHR pool is a stack of band arrays, so
// the pool-level figure has to say something honest about several of them
// (Epic 17 stage 6). Everything here comes from the sync state the topology read
// already parsed out of /proc/mdstat — no new read for the Scrubs screen.
describe('ahrScrubRunning — the pool-level md check in flight', () => {
  const sync = (over: Partial<AhrArraySync>): AhrArraySync => ({
    action: 'check',
    percent: 50,
    speedBytesSec: 1024,
    etaSeconds: 60,
    ...over,
  })

  /** An AHR pool carrying only what this derivation looks at: its arrays' sync. */
  function poolWith(...syncs: (AhrArraySync | undefined)[]): AhrPool {
    return { arrays: syncs.map(s => (s ? { sync: s } : {})) } as unknown as AhrPool
  }

  it('one checking band reports its percent, speed and ETA', () => {
    assert.deepEqual(
      ahrScrubRunning(poolWith(sync({ percent: 12.4, speedBytesSec: 66355200, etaSeconds: 72 }))),
      { percent: 12.4, speedBytesSec: 66355200, etaSeconds: 72 },
    )
  })

  it('several checking bands: least-advanced percent, summed speed, longest ETA', () => {
    // The pool's check is not done until the LAST band is, its bands are
    // distinct devices whose throughputs add up, and the ETA is a floor.
    assert.deepEqual(
      ahrScrubRunning(poolWith(
        sync({ percent: 61.9, speedBytesSec: 100, etaSeconds: 18 }),
        sync({ percent: 12.4, speedBytesSec: 200, etaSeconds: 72 }),
      )),
      { percent: 12.4, speedBytesSec: 300, etaSeconds: 72 },
    )
  })

  it('a check md gave no rate or finish time for omits those fields, never zeroes them', () => {
    assert.deepEqual(
      ahrScrubRunning(poolWith(sync({ percent: 3, speedBytesSec: 0, etaSeconds: 0 }))),
      { percent: 3 },
    )
  })

  it('a band with no progress line at all (queued check) contributes nothing', () => {
    assert.equal(ahrScrubRunning(poolWith(undefined, undefined)), null)
  })

  it('a rebuild or a reshape is not a check — nothing is reported as running', () => {
    assert.equal(ahrScrubRunning(poolWith(sync({ action: 'recover' }), sync({ action: 'reshape' }))), null)
    assert.equal(ahrScrubRunning(poolWith(sync({ action: 'resync' }))), null)
  })

  it('an idle pool reports nothing', () => {
    assert.equal(ahrScrubRunning(poolWith()), null)
  })
})
