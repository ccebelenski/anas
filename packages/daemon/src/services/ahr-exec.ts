import type { CommandExecutor, ExecResult } from '../executor/types.js'
import { enrichBusyError } from './busy-diagnosis.js'

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
