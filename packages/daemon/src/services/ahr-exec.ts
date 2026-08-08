import type { CommandExecutor, ExecResult } from '../executor/types.js'
import { enrichBusyError } from './busy-diagnosis.js'

/**
 * LVM refuses to build or extend a VG whose PVs disagree on logical block size
 * (`devices/allow_mixed_block_sizes`, default 0 → "Devices have inconsistent
 * logical block sizes"). AHR bands legitimately disagree: an md array inherits
 * `max(logical_block_size)` of its members, so a 4Kn disk makes ITS bands 4096
 * while the 512e-only bands above it stay 512 — the exact geometry mixed-media
 * hybrid RAID exists to serve (issue #8).
 *
 * The mix is safe HERE because the filesystem is made after the VG and btrfs
 * uses a 4 KiB sector size regardless of the device's logical block size, so
 * the stacked LV (4096, the max of its PVs) is always satisfied.
 *
 * Passed per command via `--config` — /etc/lvm/lvm.conf is PVE's, not ours
 * (Principle 12, guest not owner): flipping the host-wide default would change
 * LVM's behavior for PVE's own storage.
 *
 * The single home of this argument pair — every AHR LVM mutation (create and
 * expand alike) MUST pass it, or the two paths diverge into one working and
 * one refusing on the same disk set.
 */
export const LVM_MIXED_BLOCK_ARGS = ['--config', 'devices/allow_mixed_block_sizes=1']

/** Options for {@link run}. */
export interface RunOptions {
  /**
   * The mountpoint this command unmounts. On a busy-class failure, the thrown
   * error is enriched with the holding processes (story 3.29) — additive only,
   * the primary error is never masked. Only pass this for umount-style calls.
   */
  busyPath?: string
}

/**
 * Shared AHR exec helper: run a command, throw its stderr on non-zero exit.
 * A leaf module (executor types + busy-diagnosis, itself executor-types-only)
 * so every AHR service can import it without risking a cycle.
 *
 * When `opts.busyPath` is given and the failure is a busy-class one, the thrown
 * message names the processes holding the path open (story 3.29).
 */
export async function run(
  executor: CommandExecutor,
  command: string,
  args: string[],
  opts?: RunOptions,
): Promise<ExecResult> {
  const r = await executor.exec(command, args)
  if (r.exitCode !== 0) {
    const base = r.stderr.trim() || `${command} ${args[0] ?? ''} exited ${r.exitCode}`
    throw new Error(opts?.busyPath ? await enrichBusyError(executor, base, opts.busyPath) : base)
  }
  return r
}
