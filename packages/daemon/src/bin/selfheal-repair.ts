#!/usr/bin/env node
import type { AhrPool, SelfhealDiagnostics, SelfhealOutcome, SelfhealStep, SelfhealStepName } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { writeFile } from 'node:fs/promises'
import process from 'node:process'
import { SelfhealOutcome as SelfhealOutcomeSchema } from '@anas/shared'
import { ProdExecutor } from '../executor/prod.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { repairBlock, SelfhealRunError } from '../services/selfheal-repair.js'

/**
 * `node dist/bin/selfheal-repair.js <mountpoint> <file> <block>` — the DEV/TEST
 * entry point that lets the selfheal.2 loop-device suite drive the real engine
 * as its `REPAIR_CMD` (story selfheal.5).
 *
 * It is deliberately NOT an operator tool and NOT the product path: repair
 * reaches users as a confirm-gated job in selfheal.6, with the same engine
 * underneath. What lives here is only the argv/exit-code/sidecar shape the
 * suite's contract defines, so the engine can be held to the same acceptance
 * bar as the reference implementation it replaces:
 *
 *   exit 0 repaired · 2 unrepairable · 3 diagnosed-above-md ·
 *   4 mapping-abort · 5 not-examined · 70 injected failure · 1 internal error
 *
 * The JSON outcome goes to stdout. `REPAIR_REPORT=<path>` additionally writes
 * the suite's snake_case sidecar; `REPAIR_FAIL_AT=<step>` raises an injected
 * failure immediately before that step, which is how case 4 proves the md
 * knobs are restored and the transient snapshot destroyed at EVERY step
 * boundary. Both env vars belong to the harness contract, which is why they
 * are read HERE and not in the service — the engine takes a `beforeStep` hook
 * and knows nothing about environment variables.
 */

const EXIT = {
  'repaired': 0,
  'internal': 1,
  'unrepairable': 2,
  'above-md': 3,
  'mapping-abort': 4,
  // Seventh pass, F3: a block nobody looked at is not a block that was found
  // healthy, so it does not share `mapping-abort`'s exit code either.
  'not-examined': 5,
  'injected': 70,
} as const

/** A non-negative integer argument. */
const BLOCK_ARG_RE = /^\d+$/

/** Raised by the `beforeStep` hook when `REPAIR_FAIL_AT` names the next step. */
class InjectedFailure extends Error {}

/** The suite reads snake_case keys; the engine speaks the shared schema. */
function sidecar(
  outcome: SelfhealOutcome | null,
  steps: SelfhealStep[],
  diagnostics: SelfhealDiagnostics,
  injectedAt: string | null,
): Record<string, unknown> {
  const map = diagnostics.mapping
  return {
    outcome: outcome?.outcome ?? 'injected',
    reason: outcome?.reason ?? '',
    // cr3 (AHR-HEAL-H1): the code that tells `run-stopped` from the other
    // not-examined reasons, and the confirmation a written block skipped.
    reason_code: outcome?.reasonCode ?? null,
    postcheck_skipped: outcome?.postcheckSkipped ?? null,
    file: outcome?.file ?? null,
    block: outcome?.block ?? null,
    steps_done: steps.filter(s => s.ok).map(s => s.name),
    injected_at: injectedAt,
    precheck_mismatch: diagnostics.precheckMismatch ?? null,
    postcheck_mismatch: diagnostics.postcheckMismatch ?? null,
    disk: map?.memberIndex ?? null,
    moff: map?.memberOffset ?? null,
    md_byte: map?.mdByte ?? null,
    // The ARRAY the repair actually used — the two numbers that say WHICH band
    // of a multi-band pool answered (the suite's case 7 cross-checks them
    // against its own reading of the dm table), and the reference
    // implementation has reported them since it was written.
    level: map?.level ?? null,
    n: map?.raidDisks ?? null,
    chunk: map?.chunkBytes ?? null,
    stripe: map?.stripe ?? null,
    parity_disk: map?.parityIndex ?? null,
    q_disk: map?.qIndex ?? null,
    compressed: map?.compressed ?? null,
    blob_logical: map?.blobLogical ?? null,
    blob_sectors: map?.blobSectors ?? null,
    bad_sectors: diagnostics.badSectors ?? [],
    candidate_csum: diagnostics.candidateCsum ?? null,
    stored_csum: diagnostics.storedCsum ?? null,
    reconstruction: diagnostics.reconstruction ?? null,
    cleanup_errors: diagnostics.cleanupErrors,
  }
}

/**
 * The AHR pool this mountpoint belongs to, or null.
 *
 * selfheal.6 hands the engine a pool it already has; here there is only a
 * mountpoint, so the topology is read and matched on it. Null is a normal
 * answer — a hand-built loop rig (which is what the selfheal.2 suite runs on)
 * is not an AHR pool, and the engine's flat-pool pin covers it.
 */
async function poolFor(executor: CommandExecutor, mountpoint: string): Promise<AhrPool | null> {
  try {
    const pools = await readAhrPools(executor)
    return pools.find(p => p.mounted && p.mountpoint === mountpoint) ?? null
  }
  catch {
    return null
  }
}

async function main(): Promise<number> {
  const [mountpoint, file, blockText] = process.argv.slice(2)
  if (!mountpoint || !file || !blockText || !BLOCK_ARG_RE.test(blockText)) {
    process.stderr.write('usage: selfheal-repair <mountpoint> <file> <block>\n')
    return EXIT.internal
  }

  const failAt = process.env.REPAIR_FAIL_AT ?? null
  const reportPath = process.env.REPAIR_REPORT
  const executor = new ProdExecutor()

  let outcome: SelfhealOutcome | null = null
  let steps: SelfhealStep[] = []
  let diagnostics: SelfhealDiagnostics = { cleanupErrors: [] }
  let code: number = EXIT.internal

  try {
    outcome = await repairBlock(
      executor,
      { mountpoint, file, block: Number(blockText), pool: await poolFor(executor, mountpoint) },
      {
        beforeStep: (name: SelfhealStepName) => {
          if (failAt === name)
            throw new InjectedFailure(`REPAIR_FAIL_AT=${name}`)
        },
      },
    )
    // Validate at the boundary, the same as any value leaving the daemon.
    SelfhealOutcomeSchema.parse(outcome)
    steps = outcome.steps
    diagnostics = outcome.diagnostics ?? diagnostics
    code = EXIT[outcome.outcome]
    process.stdout.write(`${JSON.stringify(outcome, null, 1)}\n`)
  }
  catch (error) {
    if (error instanceof SelfhealRunError) {
      steps = error.steps
      diagnostics = error.diagnostics
      code = error.cause instanceof InjectedFailure ? EXIT.injected : EXIT.internal
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  }

  if (reportPath)
    await writeFile(reportPath, `${JSON.stringify(sidecar(outcome, steps, diagnostics, failAt), null, 1)}\n`)
  return code
}

main().then(
  (code) => { process.exitCode = code },
  (error: unknown) => {
    process.stderr.write(`selfheal-repair internal error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = EXIT.internal
  },
)
