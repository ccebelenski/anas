import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'

/**
 * `cat /proc/mdstat` on a node with no md stack (cr3.followup): coreutils
 * `cat` exits 1 and prints its ENOENT line, nothing on stdout. readAhrPools
 * reads exactly this as "no md arrays" (`CAT_MISSING_RE`), so a disk list
 * built over it has no AHR members and every disk keeps its own status.
 */
export const MD_ABSENT: ExecResult = {
  stdout: '',
  stderr: 'cat: /proc/mdstat: No such file or directory\n',
  exitCode: 1,
}

const CAT = '/usr/bin/cat'

/**
 * Shared seam for test worlds that model a node WITHOUT md (cr3.followup):
 * an unanswered `cat /proc/mdstat` answers {@link MD_ABSENT}. Since the disk
 * list stopped reading a FAILED AHR topology as "no AHR members" (a failed
 * read makes every disk without positive evidence `unknown`, as a failed
 * `zpool status` does), a world that never answered the read is a node whose
 * md could not be read, not a node with none. A world that answers the read
 * itself keeps its own answer, registered before or after this call: only
 * the mock's own "command not found" is replaced.
 *
 * NOT a `*.test.ts` file: the test glob ignores it; it is a helper module.
 */
export function serveMdAbsent(mock: MockExecutor): MockExecutor {
  const orig = mock.exec.bind(mock)
  mock.exec = async (command, args, opts): Promise<ExecResult> => {
    const own = await orig(command, args, opts)
    const isMdstatRead = command === CAT
      && args.length === MDSTAT_CAT_ARGS.length
      && args.every((a, i) => a === MDSTAT_CAT_ARGS[i])
    return isMdstatRead && own.exitCode === 127 && own.stderr.startsWith('mock: command not found')
      ? { ...MD_ABSENT }
      : own
  }
  return mock
}
