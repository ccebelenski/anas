/**
 * Cloud run display helpers (rclone.6) — the ONE stalled rule, shared by the
 * daemon (which builds the run detail) and the PVE UI (which renders the
 * "stalled for N s" label from it), so both copies answer from one function
 * and one test-vector file (`test-vectors/stalled-samples.json`).
 *
 * The samples the rule reads are the daemon's OWN byte-delta samples
 * (`CloudRunDetail.speedSamples`), never rclone's `speed`: rclone 1.60's
 * `stats.speed` is an exponentially weighted average that decays toward zero
 * but never reaches it on a stall, and its averaging loop stops 60 s after
 * the transferring set empties and never restarts — so rclone's own `speed`
 * and `eta` can freeze mid-run (review batch A, 2026-09-25).
 */

/**
 * The stats cadence the daemon pins on every run (`--stats 5s`, rclone.6).
 * Trailing zero samples convert to stalled seconds at this interval; the
 * daemon's `--stats` argv value is derived from THIS number, so the two
 * cannot drift.
 */
export const CLOUD_STATS_INTERVAL_SECS = 5

/** How many consecutive zero samples mean "stalled" (the 2026-09-25 ruling). */
export const STALLED_SAMPLES = 3

/**
 * The slice of `CloudRunDetail` the stalled rule reads. Loosely typed on
 * purpose: the ES5 UI hands it a plain job-detail object, the daemon a typed
 * one, and an absent field must degrade to "no verdict" rather than throw.
 */
export interface StalledRunShape {
  speedSamples?: readonly unknown[] | null
  transfers?: number | null
  totalTransfers?: number | null
  transferring?: readonly unknown[] | null
}

/**
 * The stalled rule: the run is stalled when at least the last
 * {@link STALLED_SAMPLES} samples are 0 while files are still outstanding —
 * `transfers < totalTransfers`, or files are in flight right now
 * (`transferring` non-empty; rclone counts a finished batch into `transfers`
 * only at the stats tick, so the in-flight set is the second witness).
 *
 * Returns the seconds the run has been stalled (the trailing zero samples at
 * the pinned cadence), or null when it is not stalled. A run with no samples
 * at all is never stalled — a run that has printed one stats object has no
 * delta to read yet.
 */
export function stalledFor(detail: StalledRunShape): number | null {
  const samples = Array.isArray(detail?.speedSamples) ? detail.speedSamples : []
  if (samples.length === 0)
    return null
  const transfers = Number(detail.transfers) || 0
  const totalTransfers = Number(detail.totalTransfers) || 0
  const transferring = Array.isArray(detail.transferring) ? detail.transferring.length : 0
  if (!(transfers < totalTransfers) && transferring === 0)
    return null
  let zeros = 0
  for (let i = samples.length - 1; i >= 0 && Number(samples[i]) === 0; i--)
    zeros++
  return zeros >= STALLED_SAMPLES ? zeros * CLOUD_STATS_INTERVAL_SECS : null
}
