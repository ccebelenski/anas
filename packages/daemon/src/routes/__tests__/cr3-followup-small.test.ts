import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { createServer } from '../../server.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { collectDiskInventory, DiskInventoryUnreadableError } from '../disks.js'
import { serveMdAbsent } from './md-absent.js'

/** cr3.followup item 9 — the small ones. */

const r = (exitCode: number, stdout: string, stderr = ''): ExecResult => ({ stdout, stderr, exitCode })
const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const NO_LIO = { configfsRoot: '/nonexistent-anas-cr3', saveconfigPath: '/nonexistent-anas-cr3' }

function lsblkWorld(lsblk: ExecResult): MockExecutor {
  const ex = new MockExecutor()
  ex.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: lsblk })
  ex.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: r(0, '') })
  ex.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: r(0, '{"output_version":{"command":"zpool status","vers_major":0,"vers_minor":1},"pools":{}}\n') })
  return serveMdAbsent(ex)
}

describe('cr3.followup 9(a) — a failed lsblk is said, never "Unexpected end of JSON input"', () => {
  it('a non-zero exit names lsblk and why', async () => {
    const ex = lsblkWorld(r(32, '', 'lsblk: failed to access sysfs directory: /sys/dev/block: No such file or directory\n'))
    await assert.rejects(collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO), (err: Error) => {
      assert.match(err.message, /^the disk list \(lsblk\) could not be read \(lsblk exited 32: lsblk: failed to access sysfs directory/)
      return true
    })
  })

  it('exit 0 with output that is not its JSON tree is said too', async () => {
    const ex = lsblkWorld(r(0, 'NAME SIZE\nsda 1G\n'))
    await assert.rejects(collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO), /^DiskListUnreadableError: the disk list \(lsblk\) could not be read \(the output is not lsblk's JSON tree\)/)
  })

  it('GET /v1/disks answers 503 with the sentence, never a bare 500', async () => {
    const server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.prependFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: r(1, '', 'lsblk: cannot open /sys: Permission denied\n') })
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/disks', headers: IDENTITY })
      assert.equal(res.statusCode, 503, res.body)
      assert.match((res.json() as { error: { message: string } }).error.message, /the disk list \(lsblk\) could not be read \(lsblk exited 1: lsblk: cannot open \/sys: Permission denied\)/)
    }
    finally {
      await server.close()
    }
  })
})

describe('cr3.followup 9(c) — the server answers DiskInventoryUnreadableError as disks.ts says it does', () => {
  it('a route that lets it through answers 409 reason unreadable with its sentence, never a bare 500', async () => {
    const server = createServer({ mock: true, logger: false })
    server.get('/v1/__cr3-followup-probe', async () => {
      throw new DiskInventoryUnreadableError('the disk inventory could not tell pool members from free disks (zpool status exited 1)')
    })
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/__cr3-followup-probe', headers: IDENTITY })
      assert.equal(res.statusCode, 409, res.body)
      const error = (res.json() as { error: { code: string, reason: string, message: string } }).error
      assert.equal(error.code, 'CONFLICT')
      assert.equal(error.reason, 'unreadable')
      assert.equal(error.message, 'the disk inventory could not tell pool members from free disks (zpool status exited 1); refusing a disk it cannot judge')
    }
    finally {
      await server.close()
    }
  })
})
