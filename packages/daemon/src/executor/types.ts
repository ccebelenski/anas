/** Result of a command execution. */
export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  /**
   * The POSIX signal name that killed the child (`SIGKILL`), when one did.
   * A signal death has NO exit code, so `exitCode` reports a plain 1 and the
   * only honest record of what happened is here. Optional and additive: absent
   * means the process exited normally (or the executor could not tell).
   *
   * It exists because a killed `proxmox-backup-client` says nothing on stderr
   * but progress, and a progress line is not a reason (live-proof F16).
   */
  signal?: string
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

/**
 * Where a streaming exec sends the child's STDOUT (story backup2.7).
 *
 * The whole reason this exists is GT-39: `proxmox-backup-client restore` REFUSES
 * every existing target — a regular file, the `/dev/zvol/<pool>/<vol>` symlink
 * and the resolved `/dev/zdNN` alike — and `--overwrite` does not help. The one
 * working path to an existing block object is `restore … -` with the caller
 * owning the destination file descriptor (GT-40), which is exactly what this is.
 */
export interface ExecStreamTarget {
  /** Absolute path the child's stdout is written into. */
  path: string
  /**
   * open(2) flags for that path, as `fs.createWriteStream` takes them.
   *
   * A BLOCK DEVICE gets the numeric `O_WRONLY` — never `'w'`, whose `O_CREAT |
   * O_TRUNC` says something meaningless about a device node and would be a lie
   * about intent. A regular image FILE gets `'w'`, which rewrites it in place:
   * the inode is kept (open+truncate, not unlink+create) so the LIO fileio
   * backstore keeps pointing at the same object and never has to be recreated.
   */
  flags: string | number
}

/** Result of a streaming exec: the usual, plus what actually reached the target. */
export interface ExecStreamResult {
  stderr: string
  exitCode: number
  /** Bytes the write stream put on the target — the partial-write evidence. */
  bytesWritten: number
}

/** Optional options for a streaming exec. */
export interface ExecStreamOptions extends ExecOptions {
  /**
   * Called with each chunk of the child's STDERR as it arrives. pbc emits its
   * restore progress there, CR-terminated, at a roughly doubling interval
   * (GT-59), so a job that wants live progress has to read it as it comes
   * rather than waiting for the process to exit.
   */
  onStderr?: (chunk: string) => void
}

/** Optional execution options. */
export interface ExecOptions {
  /**
   * Text written to the process's stdin, then closed. Use this for secrets
   * (e.g. `smbpasswd -s` reads the password from stdin) so they never appear
   * in argv / the process list.
   */
  stdin?: string
  /**
   * Extra environment variables MERGED over the daemon's own environment. Use
   * this for secrets a tool reads from the environment (e.g. pbc's
   * `PBS_PASSWORD` / `PBS_REPOSITORY` — Epic 16) so they never land in argv /
   * the process list. Values here override the inherited environment for the
   * child only.
   */
  env?: Record<string, string>
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

  /**
   * Execute a command with its STDOUT streamed straight into a file or device
   * ANAS opens itself (story backup2.7).
   *
   * NO SHELL and NO redirect string — the child is spawned directly (argv
   * array) and its stdout is piped into an `fs.createWriteStream` on `target`.
   * That is the difference between this and {@link exec}: `exec` buffers stdout
   * in memory, which is impossible for a multi-gigabyte block image, and it has
   * nowhere to put it anyway.
   *
   * The stream is FSYNCED before the promise resolves: a restore that returned
   * with data still in the page cache would call a LUN restored while a power
   * loss could still lose the tail of it.
   *
   * Resolves with the exit code, the buffered stderr, and the byte count the
   * stream actually wrote (the evidence for a partial write); rejects only if
   * the process fails to start or the target cannot be opened.
   */
  execToStream: (
    command: string,
    args: string[],
    target: ExecStreamTarget,
    opts?: ExecStreamOptions,
  ) => Promise<ExecStreamResult>
}
