import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { parseSnapshotList, zfsSnapshotDetailArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'

/**
 * cr3 DATASETS-SCHEDULES-H1: a forced rollback's confirm scope, its hold gate
 * and its warning are what `zfs rollback -r` destroys — every snapshot whose
 * createtxg is greater than the target's — never the snapshots ahead of it
 * in a list sorted by `creation` time. The constructed dataset: `snap2` is a
 * RECEIVED replication base (its sender's creation time, a day before
 * `snap1`, received after `snap1` was taken here: a greater createtxg) and
 * carries a replication hold; `snap3` is a later local snapshot.
 */

const ZFS = '/usr/sbin/zfs'
const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

const SNAPS: [string, string, string][] = [
  ['snap1', 'Mon Jul 13 10:00:00 UTC 2026', '120'],
  ['snap2', 'Sun Jul 12 10:00:00 UTC 2026', '240'],
  ['snap3', 'Tue Jul 14 10:00:00 UTC 2026', '300'],
]
const HELD = 'testpool/media@snap2'

function detailJson(snaps: [string, string, string][]): string {
  return JSON.stringify({
    output_version: { command: 'zfs list', vers_major: 0, vers_minor: 1 },
    datasets: Object.fromEntries(snaps.map(([s, c, t]) => [`testpool/media@${s}`, {
      name: `testpool/media@${s}`,
      type: 'SNAPSHOT',
      pool: 'testpool',
      createtxg: t,
      dataset: 'testpool/media',
      snapshot_name: s,
      properties: {
        creation: { value: c, source: { type: 'NONE', data: '-' } },
        used: { value: '0B', source: { type: 'NONE', data: '-' } },
        referenced: { value: '128M', source: { type: 'NONE', data: '-' } },
      },
    }])),
  })
}

const HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
}

describe('cr3 H1: forced rollback sweeps by createtxg', () => {
  let dir: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: string[] = []
  let txgList: ExecResult = ok('')
  const saved = {
    configfs: process.env.ANAS_ISCSI_CONFIGFS,
    saveconfig: process.env.ANAS_ISCSI_SAVECONFIG,
    block: process.env.ANAS_ISCSI_SYS_BLOCK,
    storage: process.env.ANAS_STORAGE_CFG,
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-rollback-'))
    await mkdir(join(dir, 'configfs'))
    process.env.ANAS_ISCSI_CONFIGFS = join(dir, 'configfs')
    process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'absent-block')
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    txgList = ok(SNAPS.map(([s, , t]) => `testpool/media@${s}\t${t}\n`).join(''))
    calls = []
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    const detail = zfsSnapshotDetailArgs('testpool/media').join('\0')
    mock.exec = async (command, args, opts) => {
      calls.push(`${command} ${args.join(' ')}`)
      if (command === ZFS && args.join('\0') === detail)
        return ok(detailJson(SNAPS))
      if (command === ZFS && args.join(' ') === 'list -t snapshot -Hp -o name,createtxg -d 1 -- testpool/media')
        return txgList
      if (command === ZFS && args[0] === 'list' && args[2] === 'bookmark')
        return ok('')
      if (command === ZFS && args[0] === 'holds') {
        const names = args.slice(args.indexOf('--') + 1)
        return ok(names.filter(n => n === HELD).map(n => `${n}\tanas-repl-684abe8ac24d\tThu Oct 15 16:59 2026\n`).join(''))
      }
      if (command === ZFS && args[0] === 'rollback')
        return ok('')
      return orig(command, args, opts)
    }
    await server.ready()
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const [key, value] of [
      ['ANAS_ISCSI_CONFIGFS', saved.configfs],
      ['ANAS_ISCSI_SAVECONFIG', saved.saveconfig],
      ['ANAS_ISCSI_SYS_BLOCK', saved.block],
      ['ANAS_STORAGE_CFG', saved.storage],
    ] as const) {
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
  })

  const rollback = (force: boolean) => server!.inject({
    method: 'POST',
    url: `/v1/pools/testpool/datasets/media/snapshots/snap1/rollback${force ? '?force=true' : ''}`,
    headers: { ...HEADERS, 'x-anas-request-id': randomUUID() },
  })

  it('the hold gate reads the holds of every snapshot with a greater createtxg and refuses the held received base', async () => {
    const res = await rollback(true)
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.reason, 'snapshot-held')
    assert.match(res.json().error.message, /testpool\/media@snap2 held by/)
    assert.deepEqual(calls.filter(c => c.includes(' holds ')), [`${ZFS} holds -H -- testpool/media@snap2 testpool/media@snap3`])
    assert.ok(!calls.some(c => c.includes(' rollback ')), 'nothing rolled back')
  })

  it('the force confirm names (and binds) every snapshot with a greater createtxg', async () => {
    // No hold anywhere: the confirm is minted, and names snap2 as well.
    txgList = ok(SNAPS.map(([s, , t]) => `testpool/media@${s}\t${t}\n`).join(''))
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const inner = mock.exec
    mock.exec = async (command, args, opts) => (command === ZFS && args[0] === 'holds') ? ok('') : inner(command, args, opts)
    const res = await rollback(true)
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    const warnings = res.json().error.warnings as string[]
    assert.ok(warnings.includes('Destroyed by force: testpool/media@snap2, testpool/media@snap3.'), warnings.join('\n'))
    assert.ok(warnings.some(w => w.startsWith('Force destroys the 2 snapshot(s)')), warnings.join('\n'))
  })

  it('a plain rollback names the newer snapshots by createtxg', async () => {
    const res = await rollback(false)
    assert.equal(res.statusCode, 409, res.body)
    const warnings = res.json().error.warnings as string[]
    assert.ok(warnings.some(w => w.startsWith('2 more recent snapshot(s) exist (snap2, snap3)')), warnings.join('\n'))
  })

  it('a createtxg listing that cannot be read refuses the forced rollback (never "nothing newer")', async () => {
    let n = 0
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const inner = mock.exec
    // The bound id reads the same argv first; the sweep read fails.
    mock.exec = async (command, args, opts) => {
      if (command === ZFS && args.join(' ') === 'list -t snapshot -Hp -o name,createtxg -d 1 -- testpool/media' && n++ > 0)
        return { stdout: '', stderr: 'I/O error', exitCode: 1 }
      return inner(command, args, opts)
    }
    const res = await rollback(true)
    assert.equal(res.statusCode, 409, res.body)
    assert.notEqual(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(!calls.some(c => c.includes(' rollback ')))
  })
})

describe('cr3 H1: parseSnapshotList orders by createtxg', () => {
  it('a received snapshot with an older creation time but a greater createtxg sorts as newer', () => {
    const snaps = parseSnapshotList(detailJson(SNAPS))
    assert.deepEqual(snaps.map(s => s.snapshotName), ['snap3', 'snap2', 'snap1'])
  })

  it('falls back to creation time when a row has no createtxg', () => {
    const json = JSON.parse(detailJson(SNAPS))
    delete json.datasets['testpool/media@snap3'].createtxg
    const snaps = parseSnapshotList(json)
    assert.deepEqual(snaps.map(s => s.snapshotName), ['snap3', 'snap1', 'snap2'])
  })
})
