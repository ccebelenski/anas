import type { CommandExecutor, ExecResult } from '../executor/types.js'

/**
 * Shared AHR exec helper: run a command, throw its stderr on non-zero exit.
 * A leaf module (executor types only) so every AHR service can import it
 * without risking a cycle.
 */
export async function run(executor: CommandExecutor, command: string, args: string[]): Promise<ExecResult> {
  const r = await executor.exec(command, args)
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `${command} ${args[0] ?? ''} exited ${r.exitCode}`)
  return r
}
