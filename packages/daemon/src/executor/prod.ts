import type { CommandExecutor, ExecOptions, ExecResult, PipelineResult } from './types.js'
import { execFile, spawn } from 'node:child_process'

/**
 * Production executor — runs real commands via execFile.
 *
 * execFile is used instead of exec to prevent shell interpretation
 * and command injection. Arguments are passed as an array.
 */
export class ProdExecutor implements CommandExecutor {
  exec(command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        command,
        args,
        {
          maxBuffer: 10 * 1024 * 1024,
          // Merge secret env (e.g. pbc's PBS_PASSWORD, Epic 16) over the
          // daemon's own environment for the child only — never on argv.
          ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
        },
        (err, stdout, stderr) => {
          // System errors (ENOENT, EACCES) — command couldn't start
          if (err && typeof err.code === 'string') {
            reject(err)
            return
          }

          // Process exited (possibly non-zero) — that's a valid result. For an
          // async execFile error the numeric exit code lives on `err.code`
          // (NOT `err.status`, which is a spawnSync-only field); preserving it
          // is load-bearing for callers that classify by the exact code — e.g.
          // `timeout` exit 124 → mount 'unreachable' (Epic 18). A signal kill
          // (err.code === null) has no exit code, so fall back to 1.
          const errCode = err ? (err as { code?: unknown }).code : undefined
          const exitCode = err ? (typeof errCode === 'number' ? errCode : 1) : 0

          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode,
          })
        },
      )

      // Feed stdin for secrets (e.g. smbpasswd -s reads the password here, so
      // it never lands in argv / the process list), then close the stream.
      if (opts?.stdin !== undefined && child.stdin) {
        child.stdin.on('error', () => {
          // Ignore EPIPE if the child exits before consuming stdin — the
          // execFile callback above already reports the real outcome.
        })
        child.stdin.end(opts.stdin)
      }
    })
  }

  /**
   * Run `cmd1 args1 | cmd2 args2` as two real processes joined by an OS pipe —
   * NO shell (spawn, argv arrays), so nothing is re-parsed. cmd1.stdout →
   * cmd2.stdin; both stderrs and cmd2.stdout are buffered. Resolves with both
   * exit codes; the caller decides success (both zero).
   *
   * Early-exit safety: if the consumer (recv) dies before the producer (send)
   * finishes, the producer would otherwise block forever writing into a dead
   * pipe. We unpipe and SIGTERM it so no orphaned `zfs send` lingers. Symmetric
   * cleanup runs if a process fails to spawn (the other is killed before we
   * reject).
   */
  pipeline(cmd1: string, args1: string[], cmd2: string, args2: string[]): Promise<PipelineResult> {
    return new Promise((resolve, reject) => {
      const left = spawn(cmd1, args1, { stdio: ['ignore', 'pipe', 'pipe'] })
      const right = spawn(cmd2, args2, { stdio: ['pipe', 'pipe', 'pipe'] })

      let leftStderr = ''
      let rightStderr = ''
      let rightStdout = ''
      let leftExit: number | null = null
      let rightExit: number | null = null
      let leftClosed = false
      let rightClosed = false
      let settled = false

      left.stderr.on('data', (d) => {
        leftStderr += d
      })
      right.stderr.on('data', (d) => {
        rightStderr += d
      })
      right.stdout.on('data', (d) => {
        rightStdout += d
      })

      // Join the two processes. EPIPE is expected when the consumer exits early
      // (the producer is still writing) — swallow it; the exit codes are the
      // real signal.
      left.stdout.pipe(right.stdin)
      left.stdout.on('error', () => {})
      right.stdin.on('error', () => {})

      // A close code of null means the process was terminated by a signal
      // (e.g. our SIGTERM below) — treat that as a non-zero (failed) exit.
      const codeOf = (code: number | null): number => (code === null ? 1 : code)

      const maybeResolve = (): void => {
        if (settled || !leftClosed || !rightClosed)
          return
        settled = true
        resolve({
          leftExitCode: leftExit ?? 1,
          rightExitCode: rightExit ?? 1,
          leftStderr,
          rightStderr,
          stdout: rightStdout,
        })
      }

      // A spawn failure (ENOENT/EACCES) on either side kills the other and
      // rejects — the caller treats this like exec's "couldn't start" throw.
      const onStartError = (err: Error): void => {
        if (settled)
          return
        settled = true
        left.kill('SIGTERM')
        right.kill('SIGTERM')
        reject(err)
      }
      left.on('error', onStartError)
      right.on('error', onStartError)

      left.on('close', (code) => {
        leftClosed = true
        leftExit = codeOf(code)
        maybeResolve()
      })

      right.on('close', (code) => {
        rightClosed = true
        rightExit = codeOf(code)
        // Consumer gone before the producer finished: detach the pipe and
        // terminate the producer so a half-streamed `zfs send` never zombies.
        if (!leftClosed) {
          left.stdout.unpipe(right.stdin)
          left.kill('SIGTERM')
        }
        maybeResolve()
      })
    })
  }
}
