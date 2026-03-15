/** Result of a command execution. */
export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Command executor interface.
 *
 * All system command execution goes through this abstraction.
 * Prod uses execFile, Mock returns fixture data for development/testing.
 */
export interface CommandExecutor {
  /**
   * Execute a command with the given arguments.
   * @param command - Absolute path to the executable (e.g. '/usr/sbin/zpool')
   * @param args - Arguments as an array (never interpolated into a string)
   * @returns The command result (stdout, stderr, exitCode)
   * @throws If the command cannot be started (not found, permission denied)
   */
  exec(command: string, args: string[]): Promise<ExecResult>
}
