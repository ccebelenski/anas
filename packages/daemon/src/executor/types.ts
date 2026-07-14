/** Result of a command execution. */
export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Optional execution options. */
export interface ExecOptions {
  /**
   * Text written to the process's stdin, then closed. Use this for secrets
   * (e.g. `smbpasswd -s` reads the password from stdin) so they never appear
   * in argv / the process list.
   */
  stdin?: string
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
   * @param opts - Optional execution options (e.g. stdin for secrets)
   * @returns The command result (stdout, stderr, exitCode)
   * @throws If the command cannot be started (not found, permission denied)
   */
  exec: (command: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>
}
