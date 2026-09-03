/**
 * A stub LUN is never served — the quarantine (story `iscsi.8`).
 *
 * ## The failure this exists for
 *
 * `targetctl restore` does not skip a fileio backing whose file is missing: it
 * **creates** the file, at the size recorded in `saveconfig.json`, whenever the
 * mountpoint directory still exists. A filesystem that failed to mount, or
 * mounted late, therefore hands an initiator a disk that is exactly the right
 * size, carries exactly the right serial, and is full of zeros (live-proof wave
 * 2, finding F2 — hit twice on the stunt node, the second time unprompted, when
 * a power cycle dropped an AHR pool's disks).
 *
 * Every other layer says the node is healthy, because by every other measure it
 * is: nothing is missing, the LUN is `ACTIVATED`, the diff has nothing to
 * report. An operator who does not already know to look finds out when a
 * filesystem on the initiator does not mount — or, worse, when something writes
 * to the placeholder.
 *
 * ## What quarantine does, and what it deliberately does not
 *
 * For each stub, under the daemon-wide iSCSI mutex:
 *
 *   1. **unmap that LUN only** — `luns delete lun<n>`. LUN-level, never
 *      TPG-level: LIO's enable flag lives on the target portal group, so
 *      disabling would take every healthy sibling LUN offline with it. rtslib
 *      removes the LUN's MappedLUNs from every ACL as part of the delete, which
 *      is the same sequence `deleteIscsiLun` has used since `iscsi.4`.
 *   2. **delete the stub backstore** — so nothing can re-map it and no `zfs`/
 *      `umount` operation is blocked by a backstore holding a file open.
 *   3. **delete the file ONLY when both stub signals agree** (0 bytes AND on the
 *      wrong filesystem). One signal is enough to stop serving it; only two are
 *      enough to prove the file is LIO's placeholder and nobody's data. The
 *      `st_size` is re-checked immediately before the `unlink`, inside the lock.
 *   4. **leave the persisted record alone, and NEVER `saveconfig`.** This is the
 *      point of the whole design. `saveconfig.json` still describes the LUN, so
 *      the very next health read reports an ordinary `missingLuns` hole and
 *      `POST /v1/iscsi/health/repair` (story `iscsi.5`) puts the LUN back —
 *      same index, same serial, same attributes — the moment the filesystem is
 *      mounted again. A save here would erase the LUN from the saved config and
 *      turn a recoverable accident into a permanent loss (GT-22).
 *
 * ## Whose stub it is
 *
 * The quarantine is a mutation, so it wears the same gate every other mutating
 * path has (story `iscsi.5`): a stub whose target is **foreign** — by IQN
 * shape, or because a sibling LUN's backing positively resolves onto non-ANAS
 * storage — is REPORTED (the stub verdict itself is ownership-blind) but never
 * acted on. Somebody else's LUN is not unmapped and nobody's file is unlinked,
 * however placeholder-shaped it looks. The skip is told in journald
 * (`result=skipped`) and recorded nowhere else: an `outcomes` entry would read
 * as "ANAS took it offline", which the boot scan counts and says.
 *
 * ## Why it runs where it runs
 *
 * At daemon start, and on every `/v1/iscsi/health` read and every dashboard
 * warning collection. Those are the moments ANAS looks at the iSCSI tree at all
 * — there is no poller and there will not be one (Principle 7). Detection is a
 * cheap gate: a node with no stub never takes the lock, never re-reads, and pays
 * only the `stat` and `findmnt` the read layer already does.
 *
 * Idempotent and fail-open throughout: no LIO, no `targetcli`, an unreadable
 * mount table or a `targetcli` that refuses all end in "nothing was quarantined"
 * and a log line, never an exception that breaks a dashboard.
 */

import type { IscsiHealth, IscsiStubLun, IscsiTargetDetail } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { IscsiPaths, IscsiReadContext } from './iscsi.js'
import { stat, unlink } from 'node:fs/promises'
import { computeIscsiHealth } from './iscsi-health.js'
import { runTargetcli, tpgPath, withIscsiLock } from './iscsi-mutate.js'
import { buildIscsiTargets, readIscsiContext } from './iscsi.js'

/** What one quarantine pass did, per stub. */
export interface IscsiQuarantineOutcome {
  targetIqn: string
  lunIndex: number
  backstoreName: string
  backingPath: string
  /** Was the LUN unmapped and its backstore deleted? */
  quarantined: boolean
  /** Was the 0-byte placeholder removed (both signals agreed)? */
  fileRemoved: boolean
  /** Why it could not be quarantined, when it could not. */
  error?: string
}

export interface IscsiQuarantineOptions extends IscsiPaths {
  /** journald sink; defaults to stdout, which systemd hands to the journal. */
  log?: (line: string) => void
}

/**
 * The audit line for one quarantined LUN.
 *
 * journald is the audit log (no ANAS-written files, the standing ruling), and
 * this is a key=value line like the AHR boot scan's so `journalctl -u anasd
 * --grep iscsi.quarantine` reads as a table. It records the two signals, not
 * just the verdict: an operator asking "why did my LUN disappear" gets the
 * numbers that decided it.
 */
function auditLine(stub: IscsiStubLun, result: { quarantined: boolean, fileRemoved: boolean, error?: string }): string {
  return `iscsi.quarantine target=${stub.targetIqn} lun=${stub.lunIndex} backstore=${stub.backstoreName} `
    + `path=${stub.backingPath} persistedSize=${stub.persistedSize} actualSize=${stub.actualSize ?? 'unknown'} `
    + `containingMount=${stub.containingMount ?? 'unknown'} expectedMount=${stub.expectedMount ?? 'unknown'} `
    + `zeroSized=${stub.zeroSized} wrongMount=${stub.wrongMount} `
    + `result=${result.quarantined ? 'unmapped' : 'failed'} fileRemoved=${result.fileRemoved}`
    + `${result.error ? ` detail=${result.error}` : ''}`
}

/**
 * The audit line for a stub ANAS saw but must not touch: its target is foreign
 * (story `iscsi.5`), so hands-off applies to the quarantine like to every other
 * mutation. Same key=value table as {@link auditLine}, with `result=skipped` —
 * deliberately not `failed`, which would claim a tear-down was attempted — and
 * the ownership derivation that decided it, so the line explains WHY it was
 * left alone and not just that it was.
 */
function skipLine(stub: IscsiStubLun, target: IscsiTargetDetail): string {
  return `iscsi.quarantine target=${stub.targetIqn} lun=${stub.lunIndex} backstore=${stub.backstoreName} `
    + `path=${stub.backingPath} result=skipped `
    + `detail=foreign target — hands-off (${target.ownershipReason}: ${target.ownershipDetail})`
}

/**
 * Tear one stub out of the live tree. Assumes the caller holds the iSCSI mutex.
 *
 * The two `targetcli` calls are the same pair `deleteIscsiLun` runs, in the same
 * order and one command per invocation (GT-5), and there is no third: the save
 * is what must not happen.
 */
async function quarantineOne(
  executor: CommandExecutor,
  stub: IscsiStubLun,
  tpgTagged: { tpgTag: number },
): Promise<{ quarantined: boolean, fileRemoved: boolean, error?: string }> {
  try {
    await runTargetcli(executor, [
      `${tpgPath(stub.targetIqn, tpgTagged.tpgTag)}/luns`,
      'delete',
      `lun${stub.lunIndex}`,
    ])
    await runTargetcli(executor, ['/backstores/fileio', 'delete', stub.backstoreName])
  }
  catch (err) {
    return { quarantined: false, fileRemoved: false, error: err instanceof Error ? err.message : String(err) }
  }

  // The file goes only when BOTH signals agreed AND it is still 0 bytes right
  // now. The re-check costs one `stat` and is the difference between deleting a
  // placeholder and deleting whatever arrived at that path since the read.
  let fileRemoved = false
  if (stub.zeroSized && stub.wrongMount) {
    try {
      const st = await stat(stub.backingPath)
      if (st.isFile() && st.size === 0) {
        await unlink(stub.backingPath)
        fileRemoved = true
      }
    }
    catch {
      // Already gone, or not ours to remove. The LUN is unmapped either way,
      // which is the part that matters.
    }
  }
  return { quarantined: true, fileRemoved }
}

/**
 * Read the iSCSI tree, quarantine any stub, and return the health that describes
 * what is true AFTERWARDS.
 *
 * The three-phase shape is deliberate:
 *
 *   1. **detect, outside the lock** — one ordinary read. Almost always the whole
 *      story: no stub, no lock, no second read.
 *   2. **re-detect and act, inside the lock** — because a fileio RESIZE
 *      legitimately deletes and recreates its own backstore, and a verdict
 *      reached outside the mutex could be describing that half-second. Whatever
 *      the lock sees is what gets torn down.
 *   3. **re-read afterwards** — so the caller's health is the post-quarantine
 *      truth (`missingLuns` + `degraded`), which is exactly what Repair reads.
 *      The stubs found in phase 2 are carried onto it, because they are the only
 *      record that the hole was a placeholder rather than an ordinary absence.
 */
export async function readIscsiHealthWithQuarantine(
  executor: CommandExecutor,
  paths: IscsiQuarantineOptions = {},
  opts: { disabledDetail?: (target: IscsiTargetDetail) => string | undefined } = {},
): Promise<{ ctx: IscsiReadContext, targets: IscsiTargetDetail[], health: IscsiHealth, outcomes: IscsiQuarantineOutcome[] }> {
  const { log: logSeam, ...readPaths } = paths
  const log = logSeam ?? ((line: string) => process.stdout.write(`${line}\n`))

  const first = await read(executor, readPaths, opts)
  if (first.health.stubLuns.length === 0)
    return { ...first, outcomes: [] }

  const outcomes: IscsiQuarantineOutcome[] = []
  const acted = new Map<string, { quarantined: boolean, fileRemoved: boolean }>()
  const actedStubs: IscsiStubLun[] = []

  await withIscsiLock(async () => {
    // Re-read under the lock: the verdict that acts must be the verdict the
    // mutex saw, never the one a concurrent mutation had already invalidated.
    const fresh = await read(executor, readPaths, opts)
    for (const stub of fresh.health.stubLuns) {
      const target = fresh.targets.find(t => t.iqn === stub.targetIqn)
      if (!target)
        continue
      // Hands-off (story `iscsi.5`): the quarantine is a mutation, and this is
      // the gate every other mutating path already has. A foreign target's
      // stub is still REPORTED — it stays in the health diff with
      // `quarantined: false`, exactly the card a pure read gives — but ANAS
      // must not unmap somebody else's LUN or unlink their file, however
      // placeholder-shaped it looks. Deliberately no outcome: `outcomes` reads
      // as "ANAS took it offline", and the boot scan counts and says that.
      if (target.ownership !== 'anas') {
        log(skipLine(stub, target))
        continue
      }
      const result = await quarantineOne(executor, stub, { tpgTag: target.tpgTag })
      log(auditLine(stub, result))
      acted.set(stub.backingPath, { quarantined: result.quarantined, fileRemoved: result.fileRemoved })
      actedStubs.push({ ...stub, quarantined: result.quarantined, fileRemoved: result.fileRemoved })
      outcomes.push({
        targetIqn: stub.targetIqn,
        lunIndex: stub.lunIndex,
        backstoreName: stub.backstoreName,
        backingPath: stub.backingPath,
        quarantined: result.quarantined,
        fileRemoved: result.fileRemoved,
        ...(result.error ? { error: result.error } : {}),
      })
    }
  })

  if (outcomes.length === 0)
    return { ...first, outcomes }

  // The post-quarantine truth, with the stubs carried onto it. `stubLuns` is
  // recomputed from the fresh context: a stub ANAS could not tear down is still
  // a stub and still says so; one that is gone is reported from `acted`.
  const after = await read(executor, readPaths, opts, acted)
  const carried = new Set(after.health.stubLuns.map(s => s.backingPath))
  const stubLuns = [
    // A stub the tear-down could not remove is still live and still reported by
    // the fresh diff — with its `quarantined: false` from `acted`, so the card
    // says ANAS tried and failed rather than implying it is handled. (A stub
    // never in `acted` at all — a foreign target's, skipped before acting —
    // carries the same `false`, but there it is the pure read's meaning:
    // nothing was attempted, which is exactly right for hands-off.)
    ...after.health.stubLuns,
    ...actedStubs.filter(s => !carried.has(s.backingPath)),
  ]
  return {
    ctx: after.ctx,
    targets: after.targets,
    health: { ...after.health, stubLuns, degraded: after.health.degraded || stubLuns.length > 0 },
    outcomes,
  }
}

/** One gather + build + diff. */
async function read(
  executor: CommandExecutor,
  paths: IscsiPaths,
  opts: { disabledDetail?: (target: IscsiTargetDetail) => string | undefined },
  quarantined?: Map<string, { quarantined: boolean, fileRemoved: boolean }>,
): Promise<{ ctx: IscsiReadContext, targets: IscsiTargetDetail[], health: IscsiHealth }> {
  const ctx = await readIscsiContext(executor, paths)
  const targets = await buildIscsiTargets(ctx)
  const health = computeIscsiHealth(ctx, targets, {
    ...(opts.disabledDetail ? { disabledDetail: opts.disabledDetail } : {}),
    ...(quarantined ? { quarantined } : {}),
  })
  return { ctx, targets, health }
}

/**
 * The daemon-start pass: quarantine whatever the boot restore left behind, log
 * it, and answer with what was done. Never throws — a daemon must start.
 *
 * This is the case F2 was found in twice. `rtslib-fb-targetctl` runs long before
 * anasd, reports success, and leaves the placeholder serving; by the time anyone
 * looks at a screen an initiator may already be logged into a disk of zeros. The
 * first thing anasd can usefully do about iSCSI is take that away.
 */
export async function iscsiStubBootScan(
  executor: CommandExecutor,
  paths: IscsiQuarantineOptions = {},
): Promise<IscsiQuarantineOutcome[]> {
  try {
    const { outcomes } = await readIscsiHealthWithQuarantine(executor, paths)
    return outcomes
  }
  catch {
    return []
  }
}
