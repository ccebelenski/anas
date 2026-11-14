import type { MockExecutor } from '../../executor/mock.js'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import { spawnSync } from 'node:child_process'

/**
 * cr3 (second review): every cloud preview resolves its source CHECKED
 * (`timeout -s KILL 5 realpath -e -- <path>`) and refuses when that read
 * fails. The test worlds' sources are real scratch directories, so the mock
 * answers that call with the REAL `realpath` — unless the world registered an
 * exact fixture of its own (that answer wins: the mock is asked first).
 */
const TIMEOUT = '/usr/bin/timeout'
const REALPATH = '/usr/bin/realpath'

export function passThroughRealpath(mock: MockExecutor): void {
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
    const r = await orig(command, args, opts)
    if (command === TIMEOUT && args[3] === REALPATH && r.exitCode === 127 && r.stderr.startsWith('mock: command not found')) {
      const real = spawnSync(REALPATH, args.slice(4), { encoding: 'utf8' })
      return { stdout: real.stdout, stderr: real.stderr, exitCode: real.status ?? 1 }
    }
    return r
  }
}
