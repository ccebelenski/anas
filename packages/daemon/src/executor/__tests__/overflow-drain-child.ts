/**
 * The child-process half of the cr.34r maxBuffer drain test
 * (deadline.test.ts). It runs ONE `/bin/sh -c <script>` through the real
 * ProdExecutor with a small `maxBuffer` and NO deadline, prints how the call
 * settled as one JSON line, and then simply returns: it never calls
 * `process.exit`, so the process ends only when nothing — a child, a pipe, a
 * timer — keeps its event loop alive. The parent runs it under an outer
 * timeout; exiting 0 inside it is the proof that an overflow lets go of
 * everything (before cr.34r a grandchild still writing kept the read side
 * open for good).
 *
 * argv: <script> <maxBuffer> <termGraceMs> <killGraceMs> [tee]
 */
import { AbandonedRegistry } from '../deadline.js'
import { ProdExecutor } from '../prod.js'

const [script, maxBuffer, termGraceMs, killGraceMs, mode] = process.argv.slice(2)
const registry = new AbandonedRegistry()
const exec = new ProdExecutor({ termGraceMs: Number(termGraceMs), killGraceMs: Number(killGraceMs), registry })
const t0 = Date.now()

/** One JSON line on stdout: what the parent reads. */
function report(outcome: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(outcome)}\n`)
}

exec.exec('/bin/sh', ['-c', script], {
  maxBuffer: Number(maxBuffer),
  // No deadline: the overflow, not a timer, has to end this call.
  timeoutMs: null,
  longRunning: 'the cr.34r drain test: only the overflow may end the call',
  ...(mode === 'tee' ? { onStderr: () => {} } : {}),
}).then(
  r => report({ resolved: r.exitCode, ms: Date.now() - t0 }),
  (err: Error & { code?: string }) => report({
    rejected: err.code ?? err.message,
    name: err.name,
    ms: Date.now() - t0,
    abandoned: registry.size,
  }),
)
