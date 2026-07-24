import type { CommandExecutor, ExecResult } from '../executor/types.js'

/**
 * Shared AHR daemon exec helper.
 *
 * Run a command, throwing a stderr-carrying error on non-zero exit. This is the
 * single home for the throw-on-nonzero wrapper the AHR service layer relies on —
 * previously copied verbatim into ahr-create / ahr-destroy / ahr-scrub /
 * ahr-snapshots / ahr-spare. Kept in its own leaf module (executor types only,
 * no other AHR import) so every AHR service can pull it without risking an
 * import cycle.
 */
export async function run(executor: CommandExecutor, command: string, args: string[]): Promise<ExecResult> {
  const r = await executor.exec(command, args)
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `${command} ${args[0] ?? ''} exited ${r.exitCode}`)
  return r
}
