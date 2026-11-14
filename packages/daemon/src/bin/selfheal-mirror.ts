#!/usr/bin/env node
import type { CommandExecutor } from '../executor/types.js'
import type { MirrorReconcileEvidence, MirrorReconcilePool } from '../services/ahr-mirror-reconcile.js'
import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { AhrMirrorReconcileResult as AhrMirrorReconcileResultSchema } from '@anas/shared'
import { ProdExecutor } from '../executor/prod.js'
import { reconcileMirrorBand } from '../services/ahr-mirror-reconcile.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { resolveContext } from '../services/selfheal-map.js'
import { memberDataSectors } from '../services/selfheal-repair.js'

/**
 * `node dist/bin/selfheal-mirror.js [--evidence <file>] [--passes N] <mountpoint> <band>`
 * — the DEV/TEST entry that lets the selfheal.2 suite drive the real mirror
 * reconcile as its `MIRROR_CMD` (story selfheal.11, cases 9a/9b).
 *
 * Not an operator tool and not the product path: the verb reaches users as the
 * confirm-gated `POST /v1/ahr/:name/mirror-reconcile` job, with this same
 * service underneath. What lives here is the argv / exit-code / sidecar shape
 * the suite's contract defines:
 *
 *   exit 0 reconciled · 2 residual · 3 refused · 1 internal error
 *
 * The EVIDENCE GATE is the same one the parity entry carries, for the same
 * reason: on a rig there is no daemon, no job queue and therefore no completed
 * scrub job to read the band's mismatch count out of. `--evidence <file>` is
 * the rig's stand-in — a JSON file with a bounded check's `mismatch_cnt`
 * (> 0) — and with no such file the entry refuses (exit 3,
 * `no-mirror-mismatch`) before touching anything, exactly as the product route
 * does when the lookup has no proof.
 *
 * `--passes N` bounds arm A. It is a TEST knob, not a bypass: case 9b needs arm
 * A held to one pass so the run falls through to arm B on a rig where a second
 * scrub might have healed the band by luck. Every other gate, both arms and the
 * verifying check run exactly as they do in the job.
 */

const EXIT = {
  reconciled: 0,
  internal: 1,
  residual: 2,
  refused: 3,
} as const

const INTEGER_ARG_RE = /^\d+$/

/**
 * The pool this mountpoint belongs to, or a rig-shaped stand-in built from the
 * dm table — the same construction the parity entry uses, and the same reason:
 * a loop rig is not an AHR pool and never will be.
 */
async function poolFor(executor: CommandExecutor, mountpoint: string): Promise<MirrorReconcilePool> {
  try {
    const pool = (await readAhrPools(executor)).find(p => p.mounted && p.mountpoint === mountpoint)
    if (pool)
      return pool
  }
  catch {
    // Not a node with AHR pools — fall through to the rig shape.
  }
  const ctx = await resolveContext(executor, mountpoint)
  const arrays = []
  for (const [index, band] of ctx.bands.entries()) {
    if (band.geometry === null)
      throw new Error(`band ${index + 1} (${band.device}): ${band.error ?? 'its geometry could not be read'}`)
    const sectors = await memberDataSectors(band.geometry)
    // cr3: a band whose data size could not be read is not a band of size 0 —
    // the height is what every estimate the run prints is computed from.
    if (sectors === null)
      throw new Error(`band ${index + 1} (${band.device}): no member reports a readable rd<n>/size, so the band's height is unknown`)
    arrays.push({
      band: index + 1,
      device: band.geometry.device,
      heightBytes: sectors * 512,
      members: band.geometry.members.filter(m => m !== null),
    })
  }
  return { name: 'rig', mountpoint, mounted: true, arrays }
}

/** One `--flag <value>` pair, pulled out of argv along with its value. */
function takeOption(argv: string[], flag: string): string | null {
  const at = argv.indexOf(flag)
  if (at < 0 || at + 1 >= argv.length)
    return null
  const value = argv[at + 1]
  argv.splice(at, 2)
  return value
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const evidenceFile = takeOption(argv, '--evidence')
  const passesText = takeOption(argv, '--passes')
  const [mountpoint, bandText] = argv.filter(a => !a.startsWith('--'))
  if (!mountpoint || !bandText || !INTEGER_ARG_RE.test(bandText)) {
    process.stderr.write('usage: selfheal-mirror [--evidence <file>] [--passes N] <mountpoint> <band>\n')
    return EXIT.internal
  }
  const band = Number(bandText)
  const executor = new ProdExecutor()

  const evidence = async (): Promise<MirrorReconcileEvidence> => {
    if (evidenceFile) {
      try {
        const parsed = JSON.parse(await readFile(evidenceFile, 'utf8')) as { mismatch_cnt?: unknown }
        if (typeof parsed.mismatch_cnt === 'number' && parsed.mismatch_cnt > 0)
          return { ok: true, mismatchCnt: parsed.mismatch_cnt, jobId: `dev:--evidence ${evidenceFile}` }
      }
      catch {
        // an unreadable or malformed evidence file is no evidence
      }
      return {
        ok: false,
        code: 'no-mirror-mismatch',
        reason: `the evidence file ${evidenceFile} records no mismatch on this band — it must be a JSON file with the bounded check's mismatch_cnt > 0`,
      }
    }
    return {
      ok: false,
      code: 'no-mirror-mismatch',
      reason: 'no completed scrub job is on record (this dev entry has no job queue) — pass --evidence <file> with a bounded check\'s count',
    }
  }

  try {
    const result = await reconcileMirrorBand(executor, await poolFor(executor, mountpoint), band, {
      updateProgress: message => process.stderr.write(`${message}\n`),
      evidence,
      ...(passesText && INTEGER_ARG_RE.test(passesText) ? { scrubPasses: Number(passesText) } : {}),
      // The rig polls fast: a 200 MiB band's check is seconds, and the
      // product's 5 s poll would watch the whole thing happen between two looks.
      pollIntervalMs: 250,
      startTimeoutMs: 15000,
    })
    AhrMirrorReconcileResultSchema.parse(result)
    process.stdout.write(`${JSON.stringify(result, null, 1)}\n`)
    if (process.env.MIRROR_REPORT)
      await writeFile(process.env.MIRROR_REPORT, `${JSON.stringify(sidecar(result), null, 1)}\n`)
    return EXIT[result.outcome]
  }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    if (process.env.MIRROR_REPORT) {
      await writeFile(process.env.MIRROR_REPORT, `${JSON.stringify({
        outcome: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }, null, 1)}\n`)
    }
    return EXIT.internal
  }
}

/** The suite reads snake_case keys; the service speaks the shared schema. */
function sidecar(result: ReturnType<typeof AhrMirrorReconcileResultSchema.parse>): Record<string, unknown> {
  return {
    outcome: result.outcome,
    reason: result.reason ?? '',
    pool: result.pool,
    band: result.band,
    array: result.array,
    arm: result.arm,
    passes: result.passes.map(p => ({ corrected: p.corrected, mismatch_after: p.mismatchAfter })),
    rows_compared: result.rowsCompared,
    rows_differing: result.rowsDiffering,
    rows_written: { leg0: result.rowsWritten.leg0, leg1: result.rowsWritten.leg1 },
    free_space_rows: result.freeSpaceRows,
    unchecked_rows: result.uncheckedRows,
    unresolved_rows: result.unresolvedRows,
    // cr3 (AHR-HEAL-H3/L12): rows set aside with NO verdict about their data.
    undecided_rows: result.undecidedRows,
    mismatch_before: result.mismatchBefore,
    mismatch_after: result.mismatchAfter,
    reason_code: result.reasonCode ?? null,
    btrfs_errors: result.btrfsErrors ?? null,
    findings: (result.findings ?? []).map(f => f.path),
    durations: result.durations,
  }
}

main().then(
  (code) => { process.exitCode = code },
  (error: unknown) => {
    process.stderr.write(`selfheal-mirror internal error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = EXIT.internal
  },
)
