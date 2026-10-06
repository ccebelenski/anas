import type { APIRequestContext } from '@playwright/test'
import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { apiCtx, awaitJob, runJob, V1 } from './fixtures/cloud-api'
import { destroyDataset, poolExists, releaseHolds, skipIfFixtureMissing, sshExec } from './fixtures/stunt-node'

/**
 * Story ident.4 — "act on what is actually there" — LIVE PROOF on the stunt
 * node, through the PVE origin's `/anas` forward (the UI's own door), every
 * claim checked through the API AND on the node itself (sshExec).
 *
 *   1. (a) two replication TASKS on one source, to two local targets, run
 *      alternately (A, B, A, B): each chain's newest base is held on the
 *      source under ITS OWN tag (`anas-repl-<sha256("local\n<target>")[:12]>`),
 *      both at once; A's base survives B's runs (`zfs destroy` of it is
 *      refused — held), and A's next run is an incremental that succeeds.
 *      Before ident.4 the one global `anas-repl` tag came off A's base on
 *      B's run, retention could destroy it, and A failed "diverged".
 *   2. (e) a configured-but-failed CIFS line (TEST-NET server, never
 *      mountable) whose target carries a loop-backed ext4 the operator
 *      mounted by hand: Remove (and Unmount) answer 409 `mount-mismatch`
 *      naming `/dev/loopN (ext4)`; the ext4 stays mounted and the fstab line
 *      stays.
 *   3. (b) a cloud remote PUT changing the s3 `endpoint` answers 409 +
 *      X-Anas-Confirm-Code naming the task that uses the remote directly AND
 *      the task that reaches it through a crypt wrapper; the confirmed resend
 *      writes the new endpoint.
 *   4. (f) a share whose `#recycle` was replaced by a symlink is SKIPPED by
 *      the purge runner with the note; the directory behind the link is
 *      untouched. The runner is the installed one (path from the
 *      anas-recycle.service ExecStart) pointed at a private smb.conf with
 *      `--smbconf`, so the node's real smb.conf is never edited.
 *
 * Fixture preconditions (nothing else is assumed):
 *   - pool `testpool` (setup-test-data.sh); the spec creates and destroys
 *     `testpool/ident4src`, `testpool/ident4a`, `testpool/ident4b`;
 *   - `mkfs.ext4` + loop devices on the node (stock PVE);
 *   - rclone installed (the cloud specs' own precondition); the spec adds and
 *     removes the remotes `ident4s3` / `ident4crypt` and the tasks
 *     `ident4-direct` / `ident4-wrapped` — nothing is ever contacted (an s3
 *     remote is only a config section until a run);
 *   - `anas-recycle.service` installed (install.sh / the smbsvc fixture);
 *   - the build under test DEPLOYED (the runner and the daemon are the node's).
 * Everything the spec creates lives under `/var/tmp/ident4-*`, `/mnt/ident4-cifs`
 * and the names above, and is removed in afterAll (best-effort).
 */

const POOL = 'testpool'
const SRC = `${POOL}/ident4src`
const TGT_A = `${POOL}/ident4a`
const TGT_B = `${POOL}/ident4b`
const TASK_A = 'ident4-a'
const TASK_B = 'ident4-b'

const CIFS_MP = '/mnt/ident4-cifs'
const LOOP_IMG = '/var/tmp/ident4-ext4.img'

const S3_REMOTE = 'ident4s3'
const CRYPT_REMOTE = 'ident4crypt'
const DIRECT_TASK = 'ident4-direct'
const WRAPPED_TASK = 'ident4-wrapped'
const CLOUD_SRC = '/var/tmp/ident4-cloudsrc'

const RECYCLE_DIR = '/var/tmp/ident4-recycle'
const RECYCLE_SERVICE = 'anas-recycle.service'

/** The chain's hold tag — the daemon's own formula (services/replication-holds.ts). */
function holdTag(targetFull: string): string {
  return `anas-repl-${createHash('sha256').update(`local\n${targetFull}`).digest('hex').slice(0, 12)}`
}

/** source snapshot name → hold tags on it (one `zfs holds -H` over every snapshot). */
async function sourceHolds(): Promise<Map<string, string[]>> {
  const out = await sshExec(`zfs list -H -t snapshot -o name ${SRC} | xargs -r zfs holds -H`)
  const holds = new Map<string, string[]>()
  for (const line of out.split('\n').filter(Boolean)) {
    const [snap, tag] = line.split('\t')
    const name = snap.split('@')[1]
    holds.set(name, [...(holds.get(name) ?? []), tag])
  }
  return holds
}

/** The newest snapshot of `ds` that the source also has — the chain's base. */
async function newestCommon(target: string): Promise<string> {
  const src = new Set((await sshExec(`zfs list -H -t snapshot -o name -s createtxg ${SRC}`)).split('\n').map(l => l.split('@')[1]))
  const tgt = (await sshExec(`zfs list -H -t snapshot -o name -s createtxg ${target}`)).split('\n').map(l => l.split('@')[1])
  const common = tgt.filter(n => src.has(n))
  expect(common.length, `${target} shares a snapshot with ${SRC}`).toBeGreaterThan(0)
  return common.at(-1) as string
}

/**
 * Run a replication task through its OWN unit (the Run-now door starts it
 * `--no-block`) and wait for that invocation to end; it must succeed.
 */
async function runReplicationTask(ctx: APIRequestContext, name: string): Promise<void> {
  // Run-now starts the unit with `systemctl start --no-block` and answers
  // `{ started: true }`; the run is systemd's. Completion is the runner's
  // result line in the unit's journal, newer than the request (node clock).
  const unit = `anas-repl-${name}.service`
  const since = (await sshExec('date +%s')).trim()
  const res = await ctx.post(`${V1}/replication/tasks/${name}/run`, { data: {} })
  expect(res.status(), await res.text()).toBe(202)
  const deadline = Date.now() + 180_000
  for (;;) {
    const lines = await sshExec(`journalctl -u ${unit} --since @${since} -o cat --no-pager 2>/dev/null || true`)
    const done = lines.split('\n').find(l => l.startsWith('{') && l.includes('"result"'))
    const failed = lines.split('\n').find(l => /Failed with result|failed/i.test(l))
    if (done)
      return
    if (failed)
      throw new Error(`${unit} failed: ${failed}`)
    if (Date.now() > deadline)
      throw new Error(`${unit} did not finish a new run within 180s`)
    await new Promise(r => setTimeout(r, 1000))
  }
}

async function deleteIfPresent(ctx: APIRequestContext, url: string): Promise<void> {
  const res = await ctx.delete(url).catch(() => null)
  if (res?.status() === 202) {
    const { id } = (await res.json()).job
    await awaitJob(ctx, id).catch(() => {})
  }
}

test.describe.configure({ mode: 'serial' })

test.describe('ident.4 — act on what is actually there (live)', () => {
  test.setTimeout(600_000)

  test.afterAll(async ({ playwright }) => {
    const ctx = await apiCtx(playwright)
    try {
      // (a)
      for (const t of [TASK_A, TASK_B])
        await deleteIfPresent(ctx, `${V1}/replication/tasks/${t}`)
      for (const ds of [SRC, TGT_A, TGT_B]) {
        await releaseHolds(ds)
        await destroyDataset(ds)
      }
      // (e) — the ext4 first, so the CIFS line can go through its own door.
      await sshExec(`umount ${CIFS_MP} 2>/dev/null; rm -f ${LOOP_IMG}; true`).catch(() => {})
      await deleteIfPresent(ctx, `${V1}/mounts/${encodeURIComponent(CIFS_MP)}?removeMountpointDir=true`)
      // (b)
      for (const t of [DIRECT_TASK, WRAPPED_TASK])
        await deleteIfPresent(ctx, `${V1}/cloud/tasks/${t}`)
      await deleteIfPresent(ctx, `${V1}/cloud/remotes/${CRYPT_REMOTE}`)
      await deleteIfPresent(ctx, `${V1}/cloud/remotes/${S3_REMOTE}`)
      // (f)
      await sshExec(`rm -rf ${RECYCLE_DIR} ${CLOUD_SRC}`).catch(() => {})
    }
    finally {
      await ctx.dispose()
    }
  })

  test('(a) two replication tasks on one source keep BOTH incremental bases held, each under its own tag', async ({ playwright }) => {
    skipIfFixtureMissing(!(await poolExists(POOL)), 'testpool not present — run setup-test-data.sh')
    const ctx = await apiCtx(playwright)
    try {
      for (const ds of [SRC, TGT_A, TGT_B]) {
        await releaseHolds(ds)
        await destroyDataset(ds)
      }
      for (const t of [TASK_A, TASK_B])
        await deleteIfPresent(ctx, `${V1}/replication/tasks/${t}`)
      await sshExec(`zfs create ${SRC} && dd if=/dev/urandom of=/${SRC}/seed bs=64k count=4 status=none`)

      for (const [name, dataset] of [[TASK_A, 'ident4a'], [TASK_B, 'ident4b']]) {
        await runJob(ctx, 'post', `${V1}/replication/tasks`, {
          name,
          source: { pool: POOL, dataset: 'ident4src' },
          target: { pool: POOL, dataset },
          // Never fires on its own — every run here is a Run-now.
          schedule: '2030-01-01 00:00:00',
          snapshotFirst: true,
          enabled: false,
        })
      }

      // A, B, A, B — each run snapshots the source first, so each chain's base
      // moves on every run of its own, and the other chain's runs come between.
      for (const name of [TASK_A, TASK_B, TASK_A, TASK_B]) {
        await runReplicationTask(ctx, name)
        await sshExec(`dd if=/dev/urandom of=/${SRC}/f-$(date +%s%N) bs=64k count=1 status=none`)
      }

      const tagA = holdTag(TGT_A)
      const tagB = holdTag(TGT_B)
      const baseA = await newestCommon(TGT_A)
      const baseB = await newestCommon(TGT_B)
      expect(baseA).not.toBe(baseB)

      const holds = await sourceHolds()
      // Each chain's base carries its own tag — BOTH at once, after B ran last.
      expect(holds.get(baseA) ?? [], `${SRC}@${baseA} holds`).toContain(tagA)
      expect(holds.get(baseB) ?? [], `${SRC}@${baseB} holds`).toContain(tagB)
      // Exactly one snapshot per chain is held (a run releases only its own older holds).
      expect([...holds.values()].filter(t => t.includes(tagA))).toHaveLength(1)
      expect([...holds.values()].filter(t => t.includes(tagB))).toHaveLength(1)
      // Neither run left the old global tag behind on anything.
      expect([...holds.values()].flat()).not.toContain('anas-repl')
      // The target side holds its own base under the same tag.
      expect(await sshExec(`zfs holds -H ${TGT_A}@${baseA}`)).toContain(tagA)
      expect(await sshExec(`zfs holds -H ${TGT_B}@${baseB}`)).toContain(tagB)

      // The bug's consequence, refused: retention (or anyone) cannot destroy
      // A's base out from under it now that B has run after A.
      const destroy = await sshExec(`zfs destroy ${SRC}@${baseA} 2>&1; echo "exit=$?"`)
      expect(destroy).toMatch(/dataset is busy|exit=1/)
      expect(await sshExec(`zfs list -H -o name ${SRC}@${baseA}`)).toBe(`${SRC}@${baseA}`)

      // …and A's next run is the incremental it should be.
      await runReplicationTask(ctx, TASK_A)
      const newBaseA = await newestCommon(TGT_A)
      expect(newBaseA).not.toBe(baseA)
      const after = await sourceHolds()
      expect(after.get(newBaseA) ?? []).toContain(tagA)
      expect(after.get(baseA) ?? [], 'A released its own older hold').not.toContain(tagA)
      expect(after.get(baseB) ?? [], 'B\'s base untouched by A\'s run').toContain(tagB)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('(e) a local filesystem at a failed CIFS line\'s target survives Remove — 409 naming what is there', async ({ playwright }) => {
    const ctx = await apiCtx(playwright)
    try {
      await sshExec(`umount ${CIFS_MP} 2>/dev/null; true`)
      await deleteIfPresent(ctx, `${V1}/mounts/${encodeURIComponent(CIFS_MP)}`)
      // The CIFS line: TEST-NET server, never mountable, written but not mounted.
      await runJob(ctx, 'post', `${V1}/mounts`, {
        type: 'cifs',
        server: '192.0.2.9',
        remotePath: 'nope',
        mountpoint: CIFS_MP,
        persistent: true,
        mountNow: false,
      })
      expect(await sshExec(`grep -cE '[[:space:]]${CIFS_MP}[[:space:]]' /etc/fstab`)).toBe('1')

      // The operator's own disk at that target.
      await sshExec(`truncate -s 32M ${LOOP_IMG} && mkfs.ext4 -q -F ${LOOP_IMG} && mount -o loop ${LOOP_IMG} ${CIFS_MP} && touch ${CIFS_MP}/operator-data`)
      const loopDev = (await sshExec(`findmnt -n -o SOURCE ${CIFS_MP}`)).trim()
      expect(loopDev).toMatch(/^\/dev\/loop\d+$/)

      for (const [verb, call] of [
        ['Removing', () => ctx.delete(`${V1}/mounts/${encodeURIComponent(CIFS_MP)}`)],
        ['Unmounting', () => ctx.post(`${V1}/mounts/${encodeURIComponent(CIFS_MP)}/state`, { data: { action: 'unmount' } })],
      ] as const) {
        const res = await call()
        expect(res.status(), await res.text()).toBe(409)
        const err = (await res.json()).error
        expect(err.reason).toBe('mount-mismatch')
        expect(err.message).toContain(`${verb} refused`)
        expect(err.message).toContain(`${loopDev} (ext4)`)
        expect(err.message).toContain('//192.0.2.9/nope (cifs)')
      }

      // The node: the ext4 is still mounted with its data, the fstab line stays.
      expect((await sshExec(`findmnt -n -o SOURCE,FSTYPE ${CIFS_MP}`)).replace(/\s+/g, ' ')).toBe(`${loopDev} ext4`)
      expect(await sshExec(`test -e ${CIFS_MP}/operator-data && echo yes`)).toBe('yes')
      expect(await sshExec(`grep -cE '[[:space:]]${CIFS_MP}[[:space:]]' /etc/fstab`)).toBe('1')

      // Once the operator takes their disk away, Remove goes through its own door.
      await sshExec(`umount ${CIFS_MP} && rm -f ${LOOP_IMG}`)
      await runJob(ctx, 'delete', `${V1}/mounts/${encodeURIComponent(CIFS_MP)}?removeMountpointDir=true`)
      expect(await sshExec(`grep -cE '[[:space:]]${CIFS_MP}[[:space:]]' /etc/fstab || true`)).toBe('0')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('(b) a remote PUT changing the endpoint answers 409 + confirm naming the tasks, direct and through a wrapper', async ({ playwright }) => {
    const ctx = await apiCtx(playwright)
    try {
      for (const t of [DIRECT_TASK, WRAPPED_TASK])
        await deleteIfPresent(ctx, `${V1}/cloud/tasks/${t}`)
      await deleteIfPresent(ctx, `${V1}/cloud/remotes/${CRYPT_REMOTE}`)
      await deleteIfPresent(ctx, `${V1}/cloud/remotes/${S3_REMOTE}`)
      await sshExec(`mkdir -p ${CLOUD_SRC}`)

      await runJob(ctx, 'post', `${V1}/cloud/remotes`, {
        name: S3_REMOTE,
        type: 's3',
        options: { provider: 'Other', endpoint: 'http://192.0.2.10:9000', access_key_id: 'ident4', secret_access_key: 'ident4-secret' },
      })
      await runJob(ctx, 'post', `${V1}/cloud/remotes`, {
        name: CRYPT_REMOTE,
        type: 'crypt',
        options: { remote: `${S3_REMOTE}:bucket/enc`, password: 'ident4-pass' },
      })
      const task = (name: string, remote: string) => ({
        name,
        source: CLOUD_SRC,
        remote,
        path: 'bucket/x',
        mode: 'copy',
        schedule: '2030-01-01 00:00:00',
        enabled: false,
        notify: 'on-failure',
      })
      await runJob(ctx, 'post', `${V1}/cloud/tasks`, task(DIRECT_TASK, S3_REMOTE))
      await runJob(ctx, 'post', `${V1}/cloud/tasks`, task(WRAPPED_TASK, CRYPT_REMOTE))

      const url = `${V1}/cloud/remotes/${S3_REMOTE}`
      const body = { options: { endpoint: 'http://192.0.2.11:9000' } }
      const res = await ctx.put(url, { data: body })
      expect(res.status(), await res.text()).toBe(409)
      const err = (await res.json()).error
      expect(err.code).toBe('CONFIRMATION_REQUIRED')
      expect(err.message).toContain(DIRECT_TASK)
      expect(err.message).toContain(`${WRAPPED_TASK} (through ${CRYPT_REMOTE})`)
      expect(err.warnings).toContain('endpoint: http://192.0.2.10:9000 -> http://192.0.2.11:9000')
      const code = res.headers()['x-anas-confirm-code']
      expect(code).toBeTruthy()
      // Nothing written before the confirm.
      expect(await sshExec(`grep -c '192.0.2.10:9000' /etc/anas/rclone.conf`)).toBe('1')

      await runJob(ctx, 'put', url, body, { headers: { 'x-anas-confirm': code } })
      expect(await sshExec(`grep -c '192.0.2.11:9000' /etc/anas/rclone.conf`)).toBe('1')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('(f) a #recycle replaced by a symlink is skipped by the purge with a note', async () => {
    const unit = await sshExec(`systemctl cat ${RECYCLE_SERVICE}`).catch(() => '')
    const execStart = unit.split('\n').find(l => l.trim().startsWith('ExecStart='))
    skipIfFixtureMissing(!execStart, `${RECYCLE_SERVICE} not installed — install.sh / smbsvc-fixture.sh up`)
    const runner = execStart!.split('=', 2)[1].trim()

    await sshExec(`rm -rf ${RECYCLE_DIR} && mkdir -p ${RECYCLE_DIR}/share ${RECYCLE_DIR}/victim`)
    await sshExec(`printf 'not recycled\\n' > ${RECYCLE_DIR}/victim/precious.txt`)
    // The share user's move: the bin is now a link to somewhere else.
    await sshExec(`ln -s ${RECYCLE_DIR}/victim '${RECYCLE_DIR}/share/#recycle'`)
    const conf = [
      '[ident4linked]',
      `\tpath = ${RECYCLE_DIR}/share`,
      '\tvfs objects = recycle',
      '\trecycle:repository = #recycle',
      '\t# anas:recycle-purge-days = 30',
      '',
    ].join('\n')
    await sshExec(`echo ${Buffer.from(conf, 'utf8').toString('base64')} | base64 -d > ${RECYCLE_DIR}/smb.conf`)

    const out = await sshExec(`${runner} --smbconf ${RECYCLE_DIR}/smb.conf`)
    expect(out).toContain('anas-recycle: share=ident4linked skipped (#recycle is a symbolic link - not followed)')
    expect(out).toContain('anas-recycle: done (purged=0 skipped=1 failed=0)')
    expect(await sshExec(`cat ${RECYCLE_DIR}/victim/precious.txt`)).toBe('not recycled')
    expect(await sshExec(`test -L '${RECYCLE_DIR}/share/#recycle' && echo link`)).toBe('link')
  })
})
