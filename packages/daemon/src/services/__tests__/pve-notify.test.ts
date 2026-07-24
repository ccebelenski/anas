import { describe, it } from 'node:test'
import assert from 'node:assert'
import { MockExecutor } from '../../executor/mock.js'
import { ANAS_NOTIFY_TEMPLATE, pveNotify } from '../pve-notify.js'

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
