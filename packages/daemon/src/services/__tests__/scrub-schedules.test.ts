import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
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
    assert.deepEqual(await readZfsScrubState(on, 'tank'), { target: { kind: 'zfs', pool: 'tank' }, enabled: true, cadence: 'monthly', mechanism: 'zfs-property' })

    const off = new MockExecutor()
    off.addFixture({ command: ZFS, args: zfsScrubGetArgs('tank'), result: { stdout: 'disable\n', stderr: '', exitCode: 0 } })
    assert.equal((await readZfsScrubState(off, 'tank')).enabled, false)

    // Unreadable → fail-open to on (never a false "scrubbing is off").
    const err = new MockExecutor()
    err.addFixture({ command: ZFS, args: zfsScrubGetArgs('tank'), result: { stdout: '', stderr: 'no such pool', exitCode: 1 } })
    assert.equal((await readZfsScrubState(err, 'tank')).enabled, true)
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
})
