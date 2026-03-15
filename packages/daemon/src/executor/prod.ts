import type { CommandExecutor, ExecResult } from './types.js'
import { execFile } from 'node:child_process'

/**
 * Production executor — runs real commands via execFile.
 *
 * execFile is used instead of exec to prevent shell interpretation
 * and command injection. Arguments are passed as an array.
 */
export class ProdExecutor implements CommandExecutor {
  exec(command: string, args: string[]): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          // System errors (ENOENT, EACCES) — command couldn't start
          if (err && typeof err.code === 'string') {
            reject(err)
            return
          }

          // Process exited (possibly non-zero) — that's a valid result
          const exitCode = err ? (err as any).status ?? 1 : 0

          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode,
          })
        },
      )
    })
  }
}
