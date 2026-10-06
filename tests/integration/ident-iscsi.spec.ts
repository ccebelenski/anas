import type { APIRequestContext } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { apiCtx, awaitJob, V1 } from './fixtures/cloud-api'
import { STUNT_HOST } from './fixtures/pve-ui'
import { poolExists, skipIfFixtureMissing, sshExec } from './fixtures/stunt-node'

/**
 * LIVE PROOF for story ident.2 — iSCSI LUNs and whole-image restore act on the
 * SERVED device (audit #8 #9 #10), over the real daemon, real LIO and real ZFS
 * on the stunt node. API-only (request contexts carrying the PVEAuthCookie,
 * through the PVE origin's /anas forward — the door the panels use).
 *
 *   1. Rename-and-recreate a zvol under a live LUN: LIO keeps serving the
 *      renamed volume while the path names a new one. A grow and a delete with
 *      "Also destroy" are both refused 409 `served-device-mismatch` (no confirm
 *      code), and neither volume is touched. A plain delete (unmap only) still
 *      goes through its confirm — the way to drop that LUN.
 *   2. Delete + add within the confirm TTL: a delete code minted for the LUN at
 *      index 0 is replayed after that LUN was deleted and a NEW LUN took index
 *      0. The replay is a fresh 409 challenge, never a 202 — the code binds the
 *      serial and the backstore, not the index.
 *   3. Whole-image restore to a re-created LUN: a restore code minted for the
 *      LUN is replayed after the LUN was deleted and re-created (new serial,
 *      same index, same volume) → a fresh 409 challenge; and a restore asked
 *      for after the volume was renamed and re-created under the live LUN is
 *      refused 409 `served-device-mismatch` before the confirm gate.
 *
 * FIXTURE: the node's own `gtiscsi` pool (present on every stunt node; never
 * modified here beyond the throwaway `gtiscsi/identproof-*` volumes this spec
 * creates and destroys), and for (3) the shared PBS repository `pbsgt`
 * (registered from test/pbs-node/config.local if absent and KEPT, exactly as
 * the backup specs leave it). Test (3) leaves its backup snapshots on PBS in the
 * per-LUN group `host/lun-<serial>` (a fresh serial each run; 64 MiB sparse).
 * The proof target `identproof` and the block task `identproof` are created and
 * removed by this spec.
 */

const POOL = 'gtiscsi'
const TARGET_NAME = 'identproof'
const DUMMY_INITIATOR = 'iqn.2005-03.org.openiscsi:anas.ident.proof'
const VOL = (s: string) => `${POOL}/identproof-${s}`
const SIZE_64M = 64 * 1024 * 1024

const TASK = 'identproof'
const REPO = 'pbsgt'
const PBS_HOST = '192.168.200.51'
const PBS_PORT = 8007
const PBS_DATASTORE = 'gtstore'
const PBS_TOKEN_ID = 'root@pam!anas'
const PBS_CONFIG_LOCAL = new URL('../../test/pbs-node/config.local', import.meta.url).pathname

interface Lun { index: number, name: string, serial: string | null, backingPath: string, size: number | null }

// ---- node-side helpers ------------------------------------------------------

/** Create a zvol and wait for its /dev/zvol link (udev is asynchronous). */
async function createZvol(ds: string): Promise<void> {
  await sshExec(`zfs create -V 64M ${ds} && udevadm settle && test -e /dev/zvol/${ds}`)
}

/** Rename a zvol away and create a NEW one at the old name — under the live LUN. */
async function renameAndRecreate(ds: string): Promise<void> {
  await sshExec(`zfs rename ${ds} ${ds}-old && udevadm settle && zfs create -V 64M ${ds} && udevadm settle && test -e /dev/zvol/${ds}`)
}

async function volsize(ds: string): Promise<number> {
  return Number(await sshExec(`zfs get -Hp -o value volsize ${ds}`))
}

/** Destroy every throwaway volume this spec could have left. Never throws. */
async function destroyProofVolumes(): Promise<void> {
  await sshExec(`for d in $(zfs list -H -o name -t volume -r ${POOL} | grep '^${POOL}/identproof-'); do zfs destroy -r "$d"; done`).catch(() => {})
}

// ---- API helpers ------------------------------------------------------------

async function targetIqn(ctx: APIRequestContext): Promise<string | null> {
  const list = await ctx.get(`${V1}/iscsi/targets`)
  if (!list.ok())
    return null
  const t = ((await list.json()).data.targets as Array<{ iqn: string }>).find(x => x.iqn.includes(TARGET_NAME))
  return t?.iqn ?? null
}

async function luns(ctx: APIRequestContext, iqn: string): Promise<Lun[]> {
  const res = await ctx.get(`${V1}/iscsi/targets/${encodeURIComponent(iqn)}`)
  expect(res.status()).toBe(200)
  return (await res.json()).data.luns as Lun[]
}

async function addLun(ctx: APIRequestContext, iqn: string, name: string, backing: string): Promise<void> {
  const res = await ctx.post(`${V1}/iscsi/targets/${encodeURIComponent(iqn)}/luns`, { data: { name, kind: 'zvol', backing } })
  expect(res.status(), await res.text()).toBe(202)
  const job = await awaitJob(ctx, (await res.json()).job.id)
  expect(job.status, job.error).toBe('completed')
}

/** Delete a LUN through its own confirm flow (backing kept). */
async function deleteLun(ctx: APIRequestContext, iqn: string, index: number): Promise<void> {
  const url = `${V1}/iscsi/targets/${encodeURIComponent(iqn)}/luns/${index}`
  const challenge = await ctx.delete(url)
  expect(challenge.status()).toBe(409)
  const code = challenge.headers()['x-anas-confirm-code']
  expect(code).toBeTruthy()
  const confirmed = await ctx.delete(url, { headers: { 'x-anas-confirm': code } })
  expect(confirmed.status(), await confirmed.text()).toBe(202)
  const job = await awaitJob(ctx, (await confirmed.json()).job.id)
  expect(job.status, job.error).toBe('completed')
}

/** Create the proof target (dummy ACL, the node's own portal). */
async function createTarget(ctx: APIRequestContext): Promise<string> {
  const res = await ctx.post(`${V1}/iscsi/targets`, {
    data: { name: TARGET_NAME, portals: [{ address: STUNT_HOST }], acls: [{ initiatorIqn: DUMMY_INITIATOR }] },
  })
  expect(res.status(), await res.text()).toBe(202)
  expect((await awaitJob(ctx, (await res.json()).job.id)).status).toBe('completed')
  const iqn = await targetIqn(ctx)
  expect(iqn).toBeTruthy()
  return iqn as string
}

/** Best-effort removal of the proof target and task (pre-clean AND teardown). */
async function cleanup(ctx: APIRequestContext): Promise<void> {
  try {
    const task = await ctx.get(`${V1}/backup/tasks/${TASK}`)
    if (task.status() === 200) {
      const del = await ctx.delete(`${V1}/backup/tasks/${TASK}`)
      if (del.status() === 202)
        await awaitJob(ctx, (await del.json()).job.id)
    }
    const iqn = await targetIqn(ctx)
    if (iqn) {
      for (const lun of await luns(ctx, iqn))
        await deleteLun(ctx, iqn, lun.index).catch(() => {})
      const del = await ctx.delete(`${V1}/iscsi/targets/${encodeURIComponent(iqn)}`)
      if (del.status() === 202)
        await awaitJob(ctx, (await del.json()).job.id)
    }
  }
  catch {
    // Best-effort only.
  }
  await destroyProofVolumes()
}

function pbsCredentials(): { secret: string, fingerprint: string } {
  let text: string
  try {
    text = readFileSync(PBS_CONFIG_LOCAL, 'utf-8')
  }
  catch {
    throw new Error(`${PBS_CONFIG_LOCAL} is missing — run test/pbs-node/provision-pbs.sh first`)
  }
  const read = (key: string): string => {
    const line = text.split('\n').find(l => l.trim().startsWith(`${key}=`))
    return (line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')) ?? ''
  }
  return { secret: read('PBS_TOKEN_SECRET'), fingerprint: read('PBS_FINGERPRINT') }
}

/** The shared `pbsgt` repository: registered once, then KEPT. */
async function ensureRepo(ctx: APIRequestContext): Promise<void> {
  const res = await ctx.get(`${V1}/backup/repos`)
  expect(res.status()).toBe(200)
  const registry = (await res.json()).data as { version: number, repos: { name: string }[] }
  if (registry.repos.some(r => r.name === REPO))
    return
  const { secret, fingerprint } = pbsCredentials()
  const post = await ctx.post(`${V1}/backup/repos`, {
    data: {
      expectedVersion: registry.version,
      repo: { name: REPO, host: PBS_HOST, port: PBS_PORT, datastore: PBS_DATASTORE, authType: 'token', tokenId: PBS_TOKEN_ID, fingerprint, secret },
    },
  })
  expect(post.status(), await post.text()).toBe(202)
  expect((await awaitJob(ctx, (await post.json()).job.id)).status).toBe('completed')
}

// ---- the proofs -------------------------------------------------------------

test.describe('ident.2 — the served device is the LUN\'s identity', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(300_000)

  let ctx: APIRequestContext

  test.beforeAll(async ({ playwright }) => {
    ctx = await apiCtx(playwright)
    skipIfFixtureMissing(!(await poolExists(POOL)), `pool ${POOL} is not on the node`)
    await cleanup(ctx)
  })

  test.afterAll(async () => {
    if (ctx) {
      await cleanup(ctx)
      await ctx.dispose()
    }
  })

  test('rename-and-recreate a zvol under a live LUN: resize and delete-with-destroy refuse 409', async () => {
    const iqn = await createTarget(ctx)
    const enc = encodeURIComponent(iqn)
    try {
      await createZvol(VOL('a'))
      await addLun(ctx, iqn, 'identa', VOL('a'))
      const [lun] = await luns(ctx, iqn)
      expect(lun.backingPath).toBe(`/dev/zvol/${VOL('a')}`)

      // Before the swap the same grow request would be accepted; it is not
      // sent — the point is what happens after.
      await renameAndRecreate(VOL('a'))

      const grow = await ctx.put(`${V1}/iscsi/targets/${enc}/luns/${lun.index}`, { data: { size: 2 * SIZE_64M } })
      expect(grow.status()).toBe(409)
      const growErr = (await grow.json()).error
      expect(growErr.reason).toBe('served-device-mismatch')
      expect(growErr.message).toContain('LUN serves a different device than its path names')
      expect(grow.headers()['x-anas-confirm-code']).toBeFalsy()

      const destroy = await ctx.delete(`${V1}/iscsi/targets/${enc}/luns/${lun.index}?destroyBacking=true`)
      expect(destroy.status()).toBe(409)
      expect((await destroy.json()).error.reason).toBe('served-device-mismatch')
      expect(destroy.headers()['x-anas-confirm-code']).toBeFalsy()

      // Neither volume was touched: the new one keeps its size, the served
      // (renamed) one is still there.
      expect(await volsize(VOL('a'))).toBe(SIZE_64M)
      expect(await volsize(`${VOL('a')}-old`)).toBe(SIZE_64M)

      // The plain delete (unmap only) is the way to drop that LUN.
      await deleteLun(ctx, iqn, lun.index)
      expect(await luns(ctx, iqn)).toEqual([])
    }
    finally {
      await cleanup(ctx)
    }
  })

  test('delete + add within the confirm TTL: replaying the old code is a fresh challenge, never a delete', async () => {
    const iqn = await createTarget(ctx)
    const enc = encodeURIComponent(iqn)
    try {
      await createZvol(VOL('b'))
      await createZvol(VOL('c'))
      await addLun(ctx, iqn, 'identb', VOL('b'))
      const [first] = await luns(ctx, iqn)
      const url = `${V1}/iscsi/targets/${enc}/luns/${first.index}`

      // A code minted for LUN 'identb' at this index...
      const stale = await ctx.delete(url)
      expect(stale.status()).toBe(409)
      const staleCode = stale.headers()['x-anas-confirm-code']
      expect(staleCode).toBeTruthy()

      // ...then that LUN is deleted (its own confirm) and a new one takes the
      // lowest free index — the same one.
      await deleteLun(ctx, iqn, first.index)
      await addLun(ctx, iqn, 'identc', VOL('c'))
      const [second] = await luns(ctx, iqn)
      expect(second.index).toBe(first.index)
      expect(second.serial).not.toBe(first.serial)

      const replay = await ctx.delete(url, { headers: { 'x-anas-confirm': staleCode } })
      expect(replay.status()).toBe(409)
      expect((await replay.json()).error.code).toBe('CONFIRMATION_REQUIRED')
      expect(replay.headers()['x-anas-confirm-code']).not.toBe(staleCode)

      // The new LUN is untouched.
      const after = await luns(ctx, iqn)
      expect(after.map(l => [l.index, l.name, l.serial])).toEqual([[second.index, 'identc', second.serial]])
    }
    finally {
      await cleanup(ctx)
    }
  })

  test('whole-image restore to a re-created LUN refuses', async () => {
    await ensureRepo(ctx)
    const iqn = await createTarget(ctx)
    const enc = encodeURIComponent(iqn)
    try {
      await createZvol(VOL('d'))
      // A recognisable first block, so the backup carries real data.
      await sshExec(`printf 'identproof' | dd of=/dev/zvol/${VOL('d')} conv=notrunc status=none && sync`)
      await addLun(ctx, iqn, 'identd', VOL('d'))
      const [lun] = await luns(ctx, iqn)
      expect(lun.serial).toBeTruthy()

      // A block task for that LUN, run once.
      const create = await ctx.post(`${V1}/backup/tasks`, {
        data: {
          name: TASK,
          repository: REPO,
          kind: 'block',
          backupId: `lun-${lun.serial}`,
          archives: [{ name: 'disk', path: lun.backingPath, excludes: [], kind: 'img', lun: { targetIqn: iqn, index: lun.index } }],
          notify: 'on-failure',
          schedule: '2030-01-01 00:00:00',
          enabled: true,
        },
      })
      expect(create.status(), await create.text()).toBe(202)
      expect((await awaitJob(ctx, (await create.json()).job.id)).status).toBe('completed')
      const run = await ctx.post(`${V1}/backup/tasks/${TASK}/run`, { data: {} })
      expect(run.status(), await run.text()).toBe(202)
      const ran = await awaitJob(ctx, (await run.json()).job.id, 240_000)
      expect(ran.status, ran.error).toBe('completed')
      const snaps = await ctx.get(`${V1}/backup/tasks/${TASK}/snapshots`)
      expect(snaps.status()).toBe(200)
      const snapshot = ((await snaps.json()).data.snapshots as Array<{ snapshot: string, backupTime: number }>)
        .sort((a, b) => b.backupTime - a.backupTime)[0]
      expect(snapshot).toBeTruthy()

      const body = { kind: 'image', repo: REPO, snapshot: snapshot.snapshot, archive: 'disk.img', lun: { targetIqn: iqn, index: lun.index } }

      // (a) A code minted for THIS LUN...
      const challenge = await ctx.post(`${V1}/backup/restore`, { data: body })
      expect(challenge.status(), await challenge.text()).toBe(409)
      const code = challenge.headers()['x-anas-confirm-code']
      expect(code).toBeTruthy()

      // ...and the LUN is deleted and re-created at the same index over the
      // same volume (a NEW serial — a different disk to every initiator).
      await deleteLun(ctx, iqn, lun.index)
      await addLun(ctx, iqn, 'identd', VOL('d'))
      const [recreated] = await luns(ctx, iqn)
      expect(recreated.index).toBe(lun.index)
      expect(recreated.serial).not.toBe(lun.serial)

      const replay = await ctx.post(`${V1}/backup/restore`, { data: body, headers: { 'x-anas-confirm': code } })
      expect(replay.status()).toBe(409)
      expect((await replay.json()).error.code).toBe('CONFIRMATION_REQUIRED')

      // (b) The volume renamed and re-created under the live LUN: refused
      // before the confirm gate, no code.
      await renameAndRecreate(VOL('d'))
      const swapped = await ctx.post(`${V1}/backup/restore`, { data: body })
      expect(swapped.status()).toBe(409)
      const err = (await swapped.json()).error
      expect(err.reason).toBe('served-device-mismatch')
      expect(err.message).toContain('LUN serves a different device than its path names')
      expect(swapped.headers()['x-anas-confirm-code']).toBeFalsy()

      // Nothing was written: the served (renamed) volume still starts with the
      // marker, and the target is still enabled.
      expect(await sshExec(`dd if=/dev/zvol/${VOL('d')}-old bs=10 count=1 status=none`)).toBe('identproof')
      const t = await ctx.get(`${V1}/iscsi/targets/${enc}`)
      expect((await t.json()).data.enabled).toBe(true)
    }
    finally {
      await cleanup(ctx)
    }
  })
})
