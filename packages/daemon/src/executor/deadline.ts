import { AsyncLocalStorage } from 'node:async_hooks'
import { basename } from 'node:path'

/**
 * Executor deadlines (cr.34, WAVE3-DESIGN §6.2).
 *
 * Node's own `execFile` timeout is not a deadline (probe P02,
 * docs/probes/wave3/02-exec-timeout-semantics.txt): it sends ONE signal to ONE
 * pid and then waits for the child to exit, so a child that ignores SIGTERM
 * keeps the call pending forever (case B) and a grandchild that holds the
 * pipe is orphaned (case C). The executor therefore owns its deadline: every
 * child leads its own process group, the deadline signals the GROUP (TERM,
 * grace, KILL, grace) and then settles the call no matter what — by
 * REJECTING with {@link CommandTimeoutError}, never by resolving with an exit
 * code a reader could take for "nothing there" (§6.1 gap 3).
 *
 * This module holds the policy (lanes, budgets, the error, the registry of
 * children that could not be killed); `prod.ts` holds the mechanism.
 */

/** Where a command runs, which decides its default budget. */
export type Lane = 'request' | 'job' | 'background'

/** The store the lane rides in: the lane, and the job id inside a job. */
export interface LaneContext {
  lane: Lane
  jobId?: string
}

const laneStorage = new AsyncLocalStorage<LaneContext>()

/**
 * Run `fn` (and everything it awaits or schedules) in `ctx`'s lane. The
 * daemon's request hooks enter the request lane, the job queue's `execute`
 * the job lane, the boot work in index.ts the background lane.
 */
export function runInLane<T>(ctx: LaneContext, fn: () => T): T {
  return laneStorage.run(ctx, fn)
}

/** The lane in effect here. No store means background (§8.1 "a lane cannot be determined"). */
export function currentLane(): LaneContext {
  return laneStorage.getStore() ?? { lane: 'background' }
}

/**
 * Default budget per command, by lane (§6.2 table). The request lane's 10 s is
 * two orders of magnitude above the slowest read measured on the stunt node
 * (185 ms, P01); a job or background command that legitimately takes longer
 * than 300 s says so at its call site (`timeoutMs`, or `null` + `longRunning`).
 */
export const LANE_BUDGET_MS: Readonly<Record<Lane, number>> = Object.freeze({
  request: 10_000,
  job: 300_000,
  background: 300_000,
})

/** After the deadline's SIGTERM to the group: how long before SIGKILL. */
export const TERM_GRACE_MS = 5_000
/** After the SIGKILL: how long before the call settles anyway (the child may be in D state). */
export const KILL_GRACE_MS = 2_000

/**
 * A command run under `/usr/bin/timeout` already has a deadline its caller
 * classifies (exit 124 → "unreachable", "did not answer"); the executor's own
 * deadline sits this far above the wrapper's so the wrapper always answers
 * first and the executor only catches a wrapper that itself cannot end (its
 * child stuck in the kernel, which `timeout` waits for).
 */
export const TIMEOUT_WRAPPER_MARGIN_MS = 5_000

const TIMEOUT_BIN = '/usr/bin/timeout'

/**
 * The deadline part of an exec's options. Either a number of milliseconds, or
 * `null` — no deadline at all — which REQUIRES a `longRunning` reason (a data
 * mover, a tree-sized ACL apply). Every `null` site is listed by a unit test
 * (`null-sites.test.ts`), so a new unbounded call is a visible diff.
 */
export type DeadlineOptions
  = | { timeoutMs?: number, longRunning?: undefined }
    | { timeoutMs: null, longRunning: string }

/** What one call's deadline resolved to. */
export interface ResolvedDeadline {
  lane: Lane
  jobId?: string
  /** Milliseconds, or null for no deadline. */
  budgetMs: number | null
  /** Where the budget came from. */
  source: 'lane' | 'call' | 'wrapper'
  /** The reason a `null` site gave. */
  longRunning?: string
}

/** GNU `timeout` DURATION: a number with an optional s/m/h/d suffix. */
const DURATION_RE = /^(\d+(?:\.\d+)?)([smhd]?)$/
const UNIT_MS: Record<string, number> = { '': 1000, 's': 1000, 'm': 60_000, 'h': 3_600_000, 'd': 86_400_000 }

function durationMs(text: string): number | null {
  const m = DURATION_RE.exec(text)
  if (!m)
    return null
  return Number(m[1]) * UNIT_MS[m[2]]
}

/**
 * Parse a `/usr/bin/timeout [OPTION] DURATION COMMAND …` argv: the wrapper's
 * duration plus its kill-after, the index of the wrapped command, or null when
 * the argv is not one we can read (then the lane default applies).
 */
export function parseTimeoutWrapper(args: string[]): { ms: number, commandIndex: number } | null {
  let killAfterMs = 0
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (a === '--') {
      i++
      break
    }
    if (!a.startsWith('-') || a === '-')
      break
    if (a === '-s' || a === '--signal') {
      i += 2
      continue
    }
    if (a === '-k' || a === '--kill-after') {
      const k = durationMs(args[i + 1] ?? '')
      if (k === null)
        return null
      killAfterMs = k
      i += 2
      continue
    }
    if (a.startsWith('--kill-after=') || (a.startsWith('-k') && a.length > 2)) {
      const k = durationMs(a.startsWith('-k') ? a.slice(2) : a.slice('--kill-after='.length))
      if (k === null)
        return null
      killAfterMs = k
      i++
      continue
    }
    // -sKILL, --signal=KILL, --preserve-status, --foreground, -v, --verbose
    i++
  }
  const d = durationMs(args[i] ?? '')
  if (d === null)
    return null
  return { ms: d + killAfterMs, commandIndex: i + 1 }
}

/**
 * The deadline one exec gets. Throws (a programming error, never a runtime
 * condition) when the options break the rules: `null` without a reason, a
 * reason without `null`, a budget that is not a positive finite number.
 */
export function resolveDeadline(
  command: string,
  args: string[],
  opts?: { timeoutMs?: number | null, longRunning?: string },
  budgets: Readonly<Record<Lane, number>> = LANE_BUDGET_MS,
): ResolvedDeadline {
  const { lane, jobId } = currentLane()
  const base = { lane, ...(jobId !== undefined ? { jobId } : {}) }
  const label = commandLabel(command, args)
  const timeoutMs = opts?.timeoutMs
  const longRunning = opts?.longRunning
  if (timeoutMs === null) {
    if (typeof longRunning !== 'string' || longRunning.trim() === '')
      throw new TypeError(`exec '${label}': timeoutMs: null (no deadline) requires a longRunning reason`)
    return { ...base, budgetMs: null, source: 'call', longRunning }
  }
  if (longRunning !== undefined)
    throw new TypeError(`exec '${label}': longRunning is only meaningful with timeoutMs: null`)
  if (timeoutMs !== undefined) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new TypeError(`exec '${label}': timeoutMs must be a positive number of milliseconds, got ${timeoutMs}`)
    return { ...base, budgetMs: timeoutMs, source: 'call' }
  }
  if (command === TIMEOUT_BIN) {
    const wrapper = parseTimeoutWrapper(args)
    if (wrapper)
      return { ...base, budgetMs: wrapper.ms + TIMEOUT_WRAPPER_MARGIN_MS, source: 'wrapper' }
  }
  return { ...base, budgetMs: budgets[lane], source: 'lane' }
}

/**
 * A short human name for a command: the executable's basename plus its
 * subcommand (`zpool status`), seen through a `/usr/bin/timeout` wrapper so
 * the name is the command that hung, not the wrapper.
 */
export function commandLabel(command: string, args: string[]): string {
  let cmd = command
  let rest = args
  if (command === TIMEOUT_BIN) {
    const wrapper = parseTimeoutWrapper(args)
    if (wrapper && wrapper.commandIndex < args.length) {
      cmd = args[wrapper.commandIndex]
      rest = args.slice(wrapper.commandIndex + 1)
    }
  }
  const sub = rest[0]
  const name = basename(cmd)
  return sub !== undefined && sub !== '' && !sub.startsWith('-') && !sub.startsWith('/') ? `${name} ${sub}` : name
}

/** `10 s`, `300 s`, `200 ms` — whole seconds where they are whole. */
export function formatBudget(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`
}

/**
 * A command that did not finish within its deadline. The call REJECTS with
 * this — a timeout is never an exit code (§6.2 "Reject, not resolve").
 *
 * `jobErrorCode` makes a job that dies of it fail with `error.code: 'TIMEOUT'`
 * (the queue reads that field); the daemon's error handler answers an uncaught
 * one on the request path with 503 `TIMEOUT`.
 */
export class CommandTimeoutError extends Error {
  readonly jobErrorCode = 'TIMEOUT'
  /** `zpool status` — the command's short name. */
  readonly label: string

  constructor(
    readonly command: string,
    readonly args: string[],
    readonly lane: Lane,
    readonly budgetMs: number,
    /** True when the child had still not exited after the SIGKILL grace (uninterruptible sleep). */
    readonly abandoned: boolean,
    readonly jobId?: string,
  ) {
    const label = commandLabel(command, args)
    const head = abandoned
      ? `'${label}' did not finish within ${formatBudget(budgetMs)} and could not be stopped: it is stuck in the kernel and still running`
      : `'${label}' did not finish within ${formatBudget(budgetMs)} and was stopped`
    const cause = 'a suspended pool, a hung disk or mount, or an unresponsive remote host is the usual cause'
    const tail = lane === 'job' ? '; what it was acting on is in an unknown state — check it before retrying' : ''
    super(`${head} (${cause})${tail}`)
    this.name = 'CommandTimeoutError'
    this.label = label
  }
}

/** One child the executor gave up on: it outlived its SIGKILL (§6.2 step 3). */
export interface AbandonedChild {
  pid: number
  /** Short name (`zpool status`). */
  label: string
  command: string
  args: string[]
  lane: Lane
  jobId?: string
  budgetMs: number
  /** ISO time the executor stopped waiting for it. */
  since: string
}

/**
 * Children that could not be killed and are still running. An entry goes when
 * its child finally exits (the executor listens for that); a daemon restart
 * clears the list, and systemd's cgroup stop takes the child with the daemon
 * (F7). Shown on GET /v1/health and as a dashboard warning.
 */
export class AbandonedRegistry {
  private readonly children = new Map<number, AbandonedChild>()

  add(child: AbandonedChild): void {
    this.children.set(child.pid, child)
  }

  remove(pid: number): void {
    this.children.delete(pid)
  }

  /** Oldest first. */
  list(): AbandonedChild[] {
    // Two steps on an array we own (`toSorted()` is ES2023; this package targets ES2022).
    const all = [...this.children.values()]
    all.sort((a, b) => a.since.localeCompare(b.since) || a.pid - b.pid)
    return all
  }

  get size(): number {
    return this.children.size
  }
}

/** The daemon's one registry — the production executor writes it, health and the dashboard read it. */
export const abandonedChildren = new AbandonedRegistry()
