import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { escapeSystemdInstance, syncZfsImportUnit, zfsImportUnitName } from '../zfs-import-unit.js'

const SYSTEMCTL = '/usr/bin/systemctl'

/**
 * Boot-import units (issue #22) — PVE parity with PVE/API2/Disks/ZFS.pm, which
 * enables `zfs-import@<escaped-pool>.service` on create and disables it on
 * destroy (their fix for Proxmox bug #2554).
 */
describe('escapeSystemdInstance — systemd non-path instance escaping', () => {
  it('passes an ordinary pool name through verbatim', () => {
    assert.equal(escapeSystemdInstance('tank'), 'tank')
  })

  it('escapes a hyphen as \\x2d (systemd does NOT pass - through)', () => {
    assert.equal(escapeSystemdInstance('my-pool'), 'my\\x2dpool')
  })

  it('passes dots, colons, underscores and digits through mid-name', () => {
    assert.equal(escapeSystemdInstance('pool.one_two:3'), 'pool.one_two:3')
  })

  it('escapes a LEADING dot so no unit is named .something', () => {
    assert.equal(escapeSystemdInstance('.hidden'), '\\x2ehidden')
  })

  it('maps / to - (the path separator systemd reserves)', () => {
    assert.equal(escapeSystemdInstance('a/b'), 'a-b')
  })

  it('escapes any other byte as lowercase two-digit hex', () => {
    assert.equal(escapeSystemdInstance('a b'), 'a\\x20b')
    assert.equal(escapeSystemdInstance('a@b'), 'a\\x40b')
    // Multi-byte UTF-8 escapes per byte (é = 0xc3 0xa9).
    assert.equal(escapeSystemdInstance('é'), '\\xc3\\xa9')
  })

  it('names the unit zfs-import@<escaped>.service', () => {
    assert.equal(zfsImportUnitName('tank'), 'zfs-import@tank.service')
    assert.equal(zfsImportUnitName('my-pool'), 'zfs-import@my\\x2dpool.service')
  })
})

describe('syncZfsImportUnit — best-effort enable/disable', () => {
  it('runs systemctl enable <unit> and returns null on success', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })

    assert.equal(await syncZfsImportUnit(ex, 'tank', 'enable'), null)
    assert.deepEqual(ex.calls, [{ command: SYSTEMCTL, args: ['enable', 'zfs-import@tank.service'] }])
  })

  it('runs systemctl disable <unit> on the destroy side', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })

    assert.equal(await syncZfsImportUnit(ex, 'tank', 'disable'), null)
    assert.deepEqual(ex.calls, [{ command: SYSTEMCTL, args: ['disable', 'zfs-import@tank.service'] }])
  })

  it('never throws on failure — returns a one-line warning carrying stderr', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: 'Failed to enable unit: No such file\n', exitCode: 1 } })

    const warning = await syncZfsImportUnit(ex, 'tank', 'enable')
    assert.ok(typeof warning === 'string')
    assert.ok(!warning.includes('\n'), 'warning is a single line')
    assert.ok(warning.includes('zfs-import@tank.service'))
    assert.ok(warning.includes('Failed to enable unit: No such file'))
  })

  it('falls back to the exit code when the failure is silent', async () => {
    const ex = new MockExecutor()
    // No fixture at all — the mock answers 127 "command not found" with stderr.
    const warning = await syncZfsImportUnit(ex, 'tank', 'disable')
    assert.ok(typeof warning === 'string' && warning.includes('zfs-import@tank.service'))
  })

  it('survives an executor that throws', async () => {
    const throwing = {
      exec: async () => {
        throw new Error('boom')
      },
      pipeline: async () => ({ leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: '' }),
    }
    const warning = await syncZfsImportUnit(throwing, 'tank', 'enable')
    assert.ok(typeof warning === 'string' && warning.includes('boom'))
  })
})
