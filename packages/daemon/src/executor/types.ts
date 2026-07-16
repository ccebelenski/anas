/** Result of a command execution. */
export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Result of a two-process pipeline (`cmd1 | cmd2`). Both exit codes are
 * reported independently — a pipeline succeeds only when BOTH are zero. Each
 * side's stderr is captured separately so the caller can attribute a failure to
 * the producer (left) or the consumer (right). `stdout` is the consumer's
 * stdout (the tail of the pipe).
 */
export interface PipelineResult {
  /** Exit code of the producer, cmd1 (the left / send side). */
  leftExitCode: number
  /** Exit code of the consumer, cmd2 (the right / recv side). */
  rightExitCode: number
  /** stderr captured from the producer (cmd1). */
  leftStderr: string
  /** stderr captured from the consumer (cmd2). */
  rightStderr: string
  /** stdout captured from the consumer (cmd2) — the pipeline's final output. */
  stdout: string
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

  /**
   * Execute a two-process pipeline: `cmd1 args1 | cmd2 args2`.
   *
   * NO SHELL — both processes are spawned directly (spawn, never a shell), so
   * argv is never re-parsed. cmd1's stdout is piped to cmd2's stdin; both
   * stderrs and cmd2's stdout are captured. The Promise resolves with BOTH exit
   * codes (the pipeline is a success only when both are zero); it rejects only
   * if a process fails to start (ENOENT/EACCES). This is the primitive behind
   * `zfs send | zfs recv` (Epic 5.5).
   *
   * @param cmd1 - Absolute path to the producer (e.g. '/usr/sbin/zfs' for send)
   * @param args1 - Producer arguments as an array
   * @param cmd2 - Absolute path to the consumer (e.g. '/usr/sbin/zfs' for recv)
   * @param args2 - Consumer arguments as an array
   */
  pipeline: (cmd1: string, args1: string[], cmd2: string, args2: string[]) => Promise<PipelineResult>
}
