import assert from 'node:assert'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { ANAS_BACKUP_NOTIFY_TEMPLATE, ANAS_NOTIFY_TEMPLATE, pveNotify } from '../pve-notify.js'

describe('pveNotify', () => {
  it('invokes perl with severity/title/message as argv (no interpolation)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({
      command: '/usr/bin/perl',
      result: { stdout: '', stderr: '', exitCode: 0 },
    })
    await pveNotify(executor, 'warning', 'array degraded', 'md/tank-r1 degraded')
    const call = executor.calls[0]
    assert.equal(call.command, '/usr/bin/perl')
    assert.equal(call.args[0], '-e')
    assert.ok(call.args[1].includes(ANAS_NOTIFY_TEMPLATE))
    assert.deepEqual(call.args.slice(2), ['warning', 'array degraded', 'md/tank-r1 degraded'])
    // the perl body must read @ARGV, never embed the values
    assert.ok(!call.args[1].includes('array degraded'))
  })

  it('defaults to the AHR template when none is given (every pre-16.12 caller)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
    await pveNotify(executor, 'info', 'title', 'message')
    const body = executor.calls[0].args[1]
    assert.ok(body.includes(`'${ANAS_NOTIFY_TEMPLATE}'`))
    assert.ok(!body.includes(ANAS_BACKUP_NOTIFY_TEMPLATE))
  })

  it('a template parameter selects BOTH the rendered template and the matcher type (16.12)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
    await pveNotify(executor, 'error', 'backup failed', 'detail', ANAS_BACKUP_NOTIFY_TEMPLATE)
    const body = executor.calls[0].args[1]
    // PVE::Notify::notify(sev, <template>, data, { type => <template> })
    assert.ok(body.includes(`notify($sev, '${ANAS_BACKUP_NOTIFY_TEMPLATE}'`))
    assert.ok(body.includes(`type => '${ANAS_BACKUP_NOTIFY_TEMPLATE}'`))
    assert.ok(!body.includes(ANAS_NOTIFY_TEMPLATE))
    // Values still ride @ARGV — the template name is the only interpolation.
    assert.deepEqual(executor.calls[0].args.slice(2), ['error', 'backup failed', 'detail'])
  })

  it('refuses a template name outside the shipped shape — nothing is executed', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
    await assert.doesNotReject(pveNotify(executor, 'info', 't', 'm', 'anas\'); system("rm -rf /"); ('))
    assert.deepEqual(executor.calls, [])
  })

  it('swallows delivery failure (non-zero exit) without throwing', async () => {
    const executor = new MockExecutor()
    executor.addFixture({
      command: '/usr/bin/perl',
      result: { stdout: '', stderr: 'no recipients', exitCode: 255 },
    })
    await assert.doesNotReject(pveNotify(executor, 'error', 't', 'm'))
  })

  it('swallows a missing perl entirely (mock throws on unknown command)', async () => {
    const executor = new MockExecutor()
    await assert.doesNotReject(pveNotify(executor, 'info', 't', 'm'))
  })
})
