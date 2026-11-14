/**
 * cr3.iscsi, second review — the reviewer's reproducing probes (holes.ts) as
 * route tests: the REAL routes over the captured restore-hole tree, relabelled
 * in memory to an ANAS-shaped IQN (the capture files stay as captured).
 */
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { createServer } from '../../server.js'
import { TARGETCLI } from '../../services/iscsi-mutate.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/iscsi')
const fx = (n: string) => readFileSync(join(FIX, n), 'utf-8')
const GT = 'iqn.2026-08.dev.anas.gtiscsi:target1'
const A = 'iqn.2026-08.dev.gtiscsi.anas:target1'
const ID = { 'x-anas-user': 'root@pam', 'x-anas-user-uid': '0', 'x-anas-privileges': 'Sys.Audit,Sys.Modify', 'x-anas-request-id': '11111111-2222-4333-8444-555555555555' }
const ENV_KEYS = ['ANAS_ISCSI_CONFIGFS', 'ANAS_ISCSI_SAVECONFIG', 'ANAS_ISCSI_SYS_BLOCK', 'ANAS_STORAGE_CFG', 'ANAS_ISCSI_INITIATOR_NAME', 'ANAS_ISCSI_BACKING_PRESENT', 'ANAS_ISCSI_DEVICE_STAT'] as const
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

/** One extra TPG on target A, with nothing live in it (its saved LUN is a hole). */
function tpg2Lines(): string[] {
  const p = `iscsi/${A}/tpgt_2`
  return [`D ${p}`, `F ${p}/enable = 1`, `D ${p}/attrib`, `F ${p}/attrib/authentication = 0`, `F ${p}/attrib/generate_node_acls = 0`, `F ${p}/attrib/demo_mode_discovery = 0`, `F ${p}/dynamic_sessions = `, `D ${p}/np`, `D ${p}/acls`, `D ${p}/lun`]
}

function saveconfig(opts: { tpg2Hole?: boolean } = {}): string {
  const s = JSON.parse(fx('saveconfig-final.json'))
  s.targets[0].wwn = A
  if (opts.tpg2Hole) {
    const t2 = JSON.parse(JSON.stringify(s.targets[0].tpgs[0]))
    t2.tag = 2
    t2.node_acls = []
    t2.portals = []
    t2.luns = [{ alias: 'x2', alua_tg_pt_gp_name: 'default_tg_pt_gp', index: 5, storage_object: '/backstores/block/f_vol' }]
    s.targets[0].tpgs.push(t2)
    s.storage_objects.push({ ...s.storage_objects[0], name: 'f_vol', dev: '/dev/zvol/gtiscsi/fvol', wwn: 'aaaaaaaa-2222-3333-4444-555555555555' })
  }
  return JSON.stringify(s)
}

let dir: string | undefined
let server: ReturnType<typeof createServer> | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir)
    await rm(dir, { recursive: true, force: true })
  dir = undefined
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined)
      delete process.env[k]
    else
      process.env[k] = saved[k]
  }
})

/**
 * `hole`: the zvol LUN 0 did not restore. `noDataset`: the image's directory is
 * on no ANAS storage (a GOOD read calls the target foreign). `zfsFail`: `zfs
 * list` fails, so whose storage the image is on cannot be judged.
 */
async function serve(opts: { hole: boolean, noDataset?: boolean, zfsFail?: boolean, tpg2Hole?: boolean }) {
  dir = await mkdtemp(join(tmpdir(), 'anas-cr3-review2-'))
  const root = join(dir, 'target')
  let m = (opts.hole ? fx('configfs-restore-hole.manifest') : fx('configfs-live.manifest')).split(GT).join(A)
  if (opts.tpg2Hole)
    m += `\n${tpg2Lines().join('\n')}\n`
  await materializeConfigfsManifest(m, root)
  await writeFile(join(dir, 'saveconfig.json'), saveconfig({ tpg2Hole: opts.tpg2Hole }))
  await mkdir(join(dir, 'block'), { recursive: true })
  process.env.ANAS_ISCSI_CONFIGFS = root
  process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'saveconfig.json')
  process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'block')
  process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
  process.env.ANAS_ISCSI_INITIATOR_NAME = join(dir, 'absent-initiatorname')
  process.env.ANAS_ISCSI_BACKING_PRESENT = '/dev/zvol/gtiscsi/vol1:/dev/zvol/gtiscsi/fvol:/gtiscsi/images/lun2.raw'
  process.env.ANAS_ISCSI_DEVICE_STAT = '/dev/zvol/gtiscsi/vol1=230:16;/dev/zvol/gtiscsi/fvol=230:48'
  server = createServer({ mock: true, logger: false })
  const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
  const orig = mock.exec.bind(mock)
  const targetcli: string[] = []
  mock.exec = async (command: string, args: string[], o?: unknown): Promise<ExecResult> => {
    if (command === TARGETCLI) {
      targetcli.push(args.join(' '))
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    if (command.endsWith('zfs') && args.join(' ') === 'list -H -o name,mountpoint') {
      if (opts.zfsFail)
        return { stdout: '', stderr: 'injected: zfs list failed', exitCode: 1 }
      return { stdout: opts.noDataset ? 'tank\t/tank\n' : 'gtiscsi\t/gtiscsi\n', stderr: '', exitCode: 0 }
    }
    if (command.endsWith('findmnt')) {
      const children = opts.noDataset ? [] : [{ target: '/gtiscsi', source: 'gtiscsi', fstype: 'zfs', options: 'rw' }]
      return { stdout: JSON.stringify({ filesystems: [{ target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw', children }] }), stderr: '', exitCode: 0 }
    }
    return orig(command, args, o)
  }
  await server.ready()
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const res = await server!.inject({ method, url, headers: { ...ID, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { payload: JSON.stringify(payload) } : {}) })
    return { status: res.statusCode, body: res.json() as { data?: unknown, job?: { id: string }, error?: { reason?: string, message: string } }, headers: res.headers }
  }
  return { call, targetcli }
}

const targetUrl = `/v1/iscsi/targets/${encodeURIComponent(A)}`

describe('cr3 review 2, D1 — an owner that could not be judged is never ANAS\'s own for a write', () => {
  it('S8b: zfs list fails, the image is on non-ANAS storage — a portal add is refused, nothing runs', async () => {
    // RED before: 202, `portals create` + `saveconfig` on a target a good
    // read calls foreign.
    const { call, targetcli } = await serve({ hole: false, noDataset: true, zfsFail: true })
    const res = await call('PUT', targetUrl, { portals: [{ address: '192.168.200.50', port: 3260 }, { address: '192.168.200.51', port: 3260 }] })
    assert.equal(res.status, 409, JSON.stringify(res.body))
    assert.equal(res.body.error?.reason, 'backing-ownership-unknown')
    assert.match(res.body.error!.message, /could not read the ZFS mountpoint table/)
    assert.match(res.body.error!.message, /Nothing was changed/)
    assert.doesNotMatch(res.body.error!.message, /not managed by ANAS|hands-off|foreign/i)
    assert.deepEqual(targetcli, [])
    // A LUN delete (the backing kept) is a write too.
    const del = await call('DELETE', `${targetUrl}/luns/1`)
    assert.equal(del.body.error?.reason, 'backing-ownership-unknown')
  })

  it('S8a control: the same target with a GOOD read is foreign, as before', async () => {
    const { call } = await serve({ hole: false, noDataset: true })
    const res = await call('PUT', targetUrl, { portals: [{ address: '192.168.200.50', port: 3260 }, { address: '192.168.200.51', port: 3260 }] })
    assert.equal(res.body.error?.reason, 'foreign-target')
  })

  it('S7b: zfs list fails, the zvol LUN is a hole — Repair blocks it with the sentence and runs nothing', async () => {
    // RED before: 202, the job ran 9 targetcli calls and a saveconfig.
    const { call, targetcli } = await serve({ hole: true, noDataset: true, zfsFail: true })
    const res = await call('POST', '/v1/iscsi/health/repair', {})
    assert.equal(res.status, 409, JSON.stringify(res.body))
    assert.match(res.body.error!.message, /could not read the ZFS mountpoint table/)
    assert.deepEqual(targetcli, [])
    // The node stays degraded, and every other change says why — never "use Repair".
    const other = await call('PUT', targetUrl, { portals: [{ address: '192.168.200.50', port: 3260 }] })
    assert.equal(other.status, 409)
    assert.doesNotMatch(other.body.error!.message, /use Repair/)
  })
})

describe('cr3 review 2, L8 — Repair never writes into a TPG ANAS did not create', () => {
  it('S5: a hole in a hand-added TPG of an ANAS target is blocked with the multi-TPG sentence', async () => {
    // RED before: 202 — the job recreated the LUN inside tpgt_2.
    const { call, targetcli } = await serve({ hole: false, tpg2Hole: true })
    const res = await call('POST', '/v1/iscsi/health/repair', {})
    assert.equal(res.status, 409, JSON.stringify(res.body))
    assert.match(res.body.error!.message, /target portal groups \(TPG 1, 2\)/)
    assert.match(res.body.error!.message, /use targetcli/)
    assert.deepEqual(targetcli, [])
    const other = await call('POST', '/v1/iscsi/targets', { name: 'probe', portals: [{ address: '192.168.200.50', port: 3261 }], acls: [{ initiatorIqn: 'iqn.1993-08.org.debian:01:x' }] })
    assert.equal(other.status, 409)
    assert.doesNotMatch(other.body.error!.message, /use Repair/)
  })
})
