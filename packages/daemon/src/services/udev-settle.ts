/**
 * `udevadm settle`, bounded (cr.35, WAVE3-DESIGN §6.3).
 *
 * settle waits for the udev event queue to drain. Its own default timeout is
 * 120 s; a node whose queue never drains (a flapping device, a hung rule)
 * would hold a job slot for that long at every call. `--timeout=60` makes
 * udevadm give up and exit 1 at 60 s — each caller already handles that the
 * way it handles any settle failure — and the executor's own deadline sits
 * 30 s above it, so the executor only catches a settle that cannot end at all.
 *
 * One definition for the seven call sites (AHR create/cache/spare/expand and
 * the backup zvol path), so the argv and the budget never drift apart.
 */

export const UDEVADM = '/usr/bin/udevadm'

/** `udevadm settle --timeout=60`. */
export const UDEVADM_SETTLE_ARGS: readonly string[] = Object.freeze(['settle', '--timeout=60'])

/** The executor's deadline for it: the wrapper's 60 s plus 30 s. */
export const UDEVADM_SETTLE_BUDGET_MS = 90_000

/** The argv as a fresh array (callers' exec signatures take `string[]`). */
export function udevSettleArgs(): string[] {
  return [...UDEVADM_SETTLE_ARGS]
}
