import type { AhrArraySync, AhrPool } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  ahrScrubRunning,
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
    assert.equal(zfsScrubSetArgs('tank', false).join(' '), 'set org.debian:periodic-scrub=disable tank')
  })

  it('setZfsScrubEnabled throws on a failed set', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: 'permission denied', exitCode: 1 } })
    await assert.rejects(() => setZfsScrubEnabled(mock, 'tank', true), /permission denied/)
  })
})

describe('scrub schedules — AHR/md mdcheck timers (node-global)', () => {
  it('parseMdcheckEnabled reads systemctl is-enabled output', () => {
    assert.equal(parseMdcheckEnabled('enabled\n'), true)
    assert.equal(parseMdcheckEnabled('enabled-runtime\n'), true)
    assert.equal(parseMdcheckEnabled('disabled\n'), false)
    assert.equal(parseMdcheckEnabled('static\n'), false)
    assert.equal(parseMdcheckEnabled(''), false)
  })

  it('readAhrScrubState reflects mdcheck_start.timer and carries the node-global note', async () => {
    const on = new MockExecutor()
    on.addFixture({ command: SYSTEMCTL, args: ['is-enabled', 'mdcheck_start.timer'], result: { stdout: 'enabled\n', stderr: '', exitCode: 0 } })
    const st = await readAhrScrubState(on, 'tank')
    assert.equal(st.enabled, true)
    assert.equal(st.mechanism, 'mdcheck-timer')
    assert.equal(st.cadence, 'monthly')
    assert.match(st.note ?? '', /node-global/)

    // is-enabled exits nonzero for `disabled` but still prints the word.
    const off = new MockExecutor()
    off.addFixture({ command: SYSTEMCTL, args: ['is-enabled', 'mdcheck_start.timer'], result: { stdout: 'disabled\n', stderr: '', exitCode: 1 } })
    assert.equal((await readAhrScrubState(off, 'tank')).enabled, false)
  })

  it('setAhrScrubEnabled enables/disables BOTH mdcheck timers with --now', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    await setAhrScrubEnabled(mock, true)
    await setAhrScrubEnabled(mock, false)
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.deepEqual(cmds, [
      'enable --now mdcheck_start.timer mdcheck_continue.timer',
      'disable --now mdcheck_start.timer mdcheck_continue.timer',
    ])
  })

  it('setAhrScrubEnabled throws on failure', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: 'unit not found', exitCode: 1 } })
    await assert.rejects(() => setAhrScrubEnabled(mock, true), /unit not found/)
  })

  it('readAhrScrubState carries a running check, and omits the key when idle', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: SYSTEMCTL, args: ['is-enabled', 'mdcheck_start.timer'], result: { stdout: 'enabled\n', stderr: '', exitCode: 0 } })
    const running = { percent: 12.4 }
    assert.deepEqual((await readAhrScrubState(mock, 'tank', running)).running, running)
    assert.equal('running' in (await readAhrScrubState(mock, 'tank')), false)
    // The absence of a COMPLETION record (the sanctioned divergence) is
    // unaffected by the presence of live progress — they are different facts.
    assert.equal((await readAhrScrubState(mock, 'tank', running)).lastScrub, null)
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
