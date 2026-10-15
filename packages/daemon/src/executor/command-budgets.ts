import type {
  CommandExecutor,
  ExecOptions,
  ExecResult,
  ExecStreamOptions,
  ExecStreamResult,
  ExecStreamTarget,
  PipelineOptions,
  PipelineResult,
} from './types.js'
import { currentLane, parseTimeoutWrapper } from './deadline.js'

/**
 * cr.35 — the §6.3 per-command budgets that differ from the lane default
 * (WAVE3-DESIGN §6.3: "smartctl 15 s", "ssh … 15 s", "proxmox-backup-client
 * reads 15 s", "`zpool import` scan 15 s", "snapshot list 15 s",
 * "`zfs send -nP` 15 s").
 *
 * They are applied by {@link CommandBudgetExecutor}, which the daemon puts in
 * front of its executor (server.ts): a call that names no budget of its own
 * and is not under a `/usr/bin/timeout` wrapper gets its row's budget as an
 * explicit `timeoutMs` — in the request lane, and for a row marked
 * `allLanes`, everywhere. In a job the other rows' commands keep the job
 * lane's 300 s: a snapshot list over 10k+ snapshots, or a remote's, must not
 * fail a replication run at 15 s.
 *
 * One table at the one door every daemon exec passes, so a NEW call site of
 * one of these commands gets its row's budget without knowing about it (a
 * table test pins every row against the argv the real call sites build).
 *
 * The ladder (§6.2): the gateway hangs up on anasd at 20 s, so a budget that
 * reached it could only answer a browser through the gateway's 504, never
 * with the daemon's own verdict. Every request-path budget is therefore at
 * most 15 s — the daemon answers first (the two display reads sit below that
 * too: `dashboard.ts` section budget, `DiskIdentityCache.loadMany` wait).
 */

/** One row of the table. */
export interface CommandBudget {
  /** Short name used by the table test and the docs. */
  readonly id: string
  readonly budgetMs: number
  /**
   * Also outside the request lane: a command that never legitimately takes
   * minutes anywhere, so a job or a background pull gets the same bound
   * instead of the 300 s default.
   */
  readonly allLanes?: boolean
  /** Does this argv belong to the row? Matched on the executable's absolute path and the argv the call sites build. */
  readonly matches: (command: string, args: readonly string[]) => boolean
}

const TIMEOUT_BIN = '/usr/bin/timeout'
const SMARTCTL_BIN = '/usr/sbin/smartctl'
const SSH_BIN = '/usr/bin/ssh'
const SSH_KEYSCAN_BIN = '/usr/bin/ssh-keyscan'
const PBC_BIN = '/usr/bin/proxmox-backup-client'
const ZPOOL_BIN = '/usr/sbin/zpool'
const ZFS_BIN = '/usr/sbin/zfs'
const LSOF_BIN = '/usr/bin/lsof'
const FUSER_BIN = '/usr/bin/fuser'

/** `-t <types>` names snapshots (`snapshot`, `snap`, `all`, or a comma list holding one). */
function typesIncludeSnapshots(args: readonly string[]): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '-t')
      continue
    if (args[i + 1].split(',').some(t => t === 'snapshot' || t === 'snap' || t === 'all'))
      return true
  }
  return false
}

export const COMMAND_BUDGETS: readonly CommandBudget[] = Object.freeze([
  // A USB bridge or a SAS disk waking (for another reader) can take seconds;
  // `-n standby` never wakes one itself. Every lane: the identity probe runs
  // from jobs too (the composability re-check), and a probe the cache dedups
  // must not be shared for 300 s.
  { id: 'smartctl', budgetMs: 15_000, allLanes: true, matches: c => c === SMARTCTL_BIN },
  // Remote reads over ssh: ConnectTimeout=10 (buildSshArgv) ends a dead host
  // at 10 s; a connected remote whose zfs hangs gets the rest.
  { id: 'ssh', budgetMs: 15_000, matches: c => c === SSH_BIN },
  // `ssh-keyscan -T 10` bounds each connection; the executor sits above it.
  { id: 'ssh-keyscan', budgetMs: 15_000, allLanes: true, matches: c => c === SSH_KEYSCAN_BIN },
  // Snapshot/group listings and the repo probe talk to the PBS server. (The
  // catalog shell has its own `timeout` wrapper, which wins.)
  { id: 'proxmox-backup-client', budgetMs: 15_000, matches: c => c === PBC_BIN },
  // On the request path `zpool import` is always the device SCAN (the import
  // itself is a job). 145 ms on 6 disks (P01), scales with disk count.
  { id: 'zpool import (scan)', budgetMs: 15_000, matches: (c, a) => c === ZPOOL_BIN && a[0] === 'import' },
  // `zfs list|get -t snapshot`: 34 ms on the stunt node, scales with
  // snapshot count (10k+ snapshots on a real node is ordinary).
  { id: 'zfs snapshot list', budgetMs: 15_000, matches: (c, a) => c === ZFS_BIN && (a[0] === 'list' || a[0] === 'get') && typesIncludeSnapshots(a) },
  // On the request path `zfs send` is always the `-nvP` dry run (the real
  // send is a pipeline in a job): it walks the stream's blocks.
  { id: 'zfs send -nP', budgetMs: 15_000, matches: (c, a) => c === ZFS_BIN && a[0] === 'send' },
  // §6.3 "`lsof +f --`, `fuser -m` … walks /proc; hangs where the mount
  // hangs — 10 s", in a job too (the busy-unmount diagnosis runs in one).
  { id: 'lsof', budgetMs: 10_000, allLanes: true, matches: c => c === LSOF_BIN },
  { id: 'fuser', budgetMs: 10_000, allLanes: true, matches: c => c === FUSER_BIN },
])

/** The row this argv belongs to, if any (lane aside). */
export function commandBudgetRow(command: string, args: readonly string[]): CommandBudget | undefined {
  return COMMAND_BUDGETS.find(r => r.matches(command, args))
}

/**
 * The options a call should run with: unchanged when it named its own budget
 * (or `null` + a reason), runs under a `timeout` wrapper, or no row applies
 * in this lane; otherwise its row's budget as `timeoutMs`.
 */
export function withCommandBudget<O extends { timeoutMs?: number | null, longRunning?: string }>(
  command: string,
  args: readonly string[],
  opts: O | undefined,
): O | undefined {
  if (opts?.timeoutMs !== undefined || opts?.longRunning !== undefined)
    return opts
  if (command === TIMEOUT_BIN && parseTimeoutWrapper([...args]))
    return opts
  const row = commandBudgetRow(command, args)
  if (!row || (currentLane().lane !== 'request' && row.allLanes !== true))
    return opts
  return { ...(opts ?? {}), timeoutMs: row.budgetMs } as O
}

/**
 * The daemon's executor with the table applied (server.ts wraps the
 * production or mock executor in it). Everything else passes through.
 */
export class CommandBudgetExecutor implements CommandExecutor {
  constructor(readonly inner: CommandExecutor) {}

  exec(command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    return this.inner.exec(command, args, withCommandBudget(command, args, opts))
  }

  pipeline(cmd1: string, args1: string[], cmd2: string, args2: string[], opts?: PipelineOptions): Promise<PipelineResult> {
    return this.inner.pipeline(cmd1, args1, cmd2, args2, withCommandBudget(cmd1, args1, opts))
  }

  execToStream(command: string, args: string[], target: ExecStreamTarget, opts?: ExecStreamOptions): Promise<ExecStreamResult> {
    return this.inner.execToStream(command, args, target, withCommandBudget(command, args, opts))
  }
}
