import type { Lane } from './deadline.js'
import type {
  CommandExecutor,
  ExecOptions,
  ExecResult,
  ExecStreamOptions,
  ExecStreamResult,
  ExecStreamTarget,
  PipelineOptions,
  PipelineResult,
  SpawnedChild,
} from './types.js'
import { CommandTimeoutError, resolveDeadline } from './deadline.js'

/** A canned response for a specific command + args pattern. */
export interface MockFixture {
  /** Command to match (e.g. '/usr/sbin/zpool') */
  command: string
  /** Args pattern to match. If omitted, matches any args for this command. */
  args?: string[]
  /**
   * A predicate over the argv, for an argument the code makes unpredictable on
   * purpose (a random probe name). Matched with the exact-args fixtures, ahead
   * of command-only ones. exec() only.
   */
  argsMatch?: (args: string[]) => boolean
  /** The result to return. */
  result?: ExecResult
  /**
   * A SEQUENCE of results, one dequeued per matching call (the last repeats once
   * exhausted). Lets a test script a state transition (e.g. `systemctl show`
   * going activating → inactive). Takes precedence over `result`.
   */
  results?: ExecResult[]
  /**
   * Replay the stderr through `onStderr` (the default) or hold it back. The
   * real executor tees stderr whenever a caller asks for live progress; an
   * executor that buffers WITHOUT teeing is a different (broken) reality, and
   * the re-read fallback in `execRclone` exists for exactly that case — a test
   * can only reach it by suppressing the tee here.
   */
  teeStderr?: boolean
  /**
   * rclone.5 — a LIVE child: the call does not resolve until the child is
   * stopped by a signal (or {@link MockExecutor.finishLive}), and a caller that
   * passed `onSpawn` gets a handle whose `kill` the mock records in
   * {@link MockExecutor.signals}. This is how a cancel test drives the SIGINT
   * ladder without a real process.
   */
  live?: MockLiveChild
  /**
   * The exec REJECTS with this error instead of resolving — a process that
   * could not start (ENOENT/EACCES), the contract `execFile` has. A live child
   * and a throwing fixture are mutually exclusive: a throw means nothing ever
   * spawned, so no `onSpawn` runs either.
   */
  throws?: Error
  /**
   * cr.34 — the command never answers: the exec REJECTS with the
   * {@link CommandTimeoutError} the real executor raises at the end of the
   * call's deadline (lane default or its own `timeoutMs`), at once — a test
   * never waits for a real budget. `abandoned: true` models a child that
   * survived its SIGKILL (uninterruptible sleep).
   */
  timesOut?: { abandoned?: boolean }
}

/** One recorded call's deadline, as the real executor would apply it (cr.34). */
export interface MockDeadlineCall {
  command: string
  args: string[]
  lane: Lane
  jobId?: string
  /** Milliseconds, or null for a `longRunning` call. */
  budgetMs: number | null
  source: 'lane' | 'call' | 'wrapper'
  longRunning?: string
}

/** How a {@link MockFixture.live} child answers signals. */
export interface MockLiveChild {
  /**
   * How many signals it takes to stop the child (default 1). `Infinity` = a
   * child that ignores every signal — the "run continues" case.
   */
  signalsToExit?: number
  /** What the call resolves with once a signal stops it (default: SIGINT death). */
  onSignal?: ExecResult
}

/** A canned response for a specific pipeline (cmd1 | cmd2) pattern. */
export interface MockPipelineFixture {
  cmd1: string
  /** cmd1 args to match. If omitted, matches any args for cmd1. */
  args1?: string[]
  cmd2: string
  /** cmd2 args to match. If omitted, matches any args for cmd2. */
  args2?: string[]
  result: PipelineResult
}

/** A recorded pipeline invocation, for test assertions on the exact argv. */
export interface MockPipelineCall {
  cmd1: string
  args1: string[]
  cmd2: string
  args2: string[]
}

/** A canned response for a streaming exec (story backup2.7). */
export interface MockStreamFixture {
  command: string
  /** Args pattern to match. If omitted, matches any args for this command. */
  args?: string[]
  /**
   * The result, verbatim — including `signal` (D5): a fixture replaying a
   * killed child carries the signal NAME the real executor would report.
   */
  result: ExecStreamResult
  /** Simulate a process that could not start / a target that could not open. */
  throws?: Error
}

/** A recorded streaming invocation — argv PLUS where the bytes were headed. */
export interface MockStreamCall {
  command: string
  args: string[]
  target: ExecStreamTarget
}

/**
 * Mock executor — returns fixture data for development and testing.
 *
 * Register fixtures for specific command/args patterns. Unmatched
 * commands return a default "command not found" error.
 */
export class MockExecutor implements CommandExecutor {
  private fixtures: MockFixture[] = []
  private pipelineFixtures: MockPipelineFixture[] = []
  private streamFixtures: MockStreamFixture[] = []

  /** Every exec() call made, in order — tests assert the exact argv here. */
  readonly calls: { command: string, args: string[] }[] = []

  /** Every pipeline() call made, in order — tests assert the exact argv here. */
  readonly pipelineCalls: MockPipelineCall[] = []

  /** Every execToStream() call, in order — argv AND the target descriptor. */
  readonly streamCalls: MockStreamCall[] = []

  /**
   * Every call's deadline (exec, pipeline, execToStream), in order — resolved
   * with the same rules and in the same lane as the production executor, so
   * a lane test asserts what a real child would have been given (cr.34). A
   * call whose options break the rules (`null` without a reason) REJECTS
   * here exactly as it would in production.
   */
  readonly deadlines: MockDeadlineCall[] = []

  /**
   * Every signal sent to a live child through its `onSpawn` handle, in order.
   * `group: true` marks one sent through `killGroup` (cr.48) — absent for the
   * PID-only `kill`.
   */
  readonly signals: { pid: number, signal: string, group?: true }[] = []

  /** Live children still running, by pid — {@link finishLive} ends them. */
  private readonly liveChildren = new Map<number, (result: ExecResult) => void>()
  private nextPid = 4000

  /** Register a fixture. More specific matches (with args) take priority. */
  addFixture(fixture: MockFixture): this {
    this.fixtures.push(fixture)
    return this
  }

  /**
   * Register a fixture AHEAD of every earlier one (cr.35): a test that turns
   * one command of the dev server's seeded set into a never-answering one
   * (`timesOut`) without clearing the rest. Matching order is otherwise
   * unchanged — exact args, then `argsMatch`, then command-only.
   */
  prependFixture(fixture: MockFixture): this {
    this.fixtures.unshift(fixture)
    return this
  }

  /** Register a pipeline fixture. Unmatched pipelines default to success. */
  addPipelineFixture(fixture: MockPipelineFixture): this {
    this.pipelineFixtures.push(fixture)
    return this
  }

  /** Register a streaming fixture. Unmatched streams answer "not found" (127). */
  addStreamFixture(fixture: MockStreamFixture): this {
    this.streamFixtures.push(fixture)
    return this
  }

  /** Clear all fixtures (including pipeline fixtures and recorded calls). */
  clearFixtures(): void {
    this.fixtures = []
    this.pipelineFixtures = []
    this.streamFixtures = []
    this.calls.length = 0
    this.pipelineCalls.length = 0
    this.streamCalls.length = 0
    this.signals.length = 0
    this.deadlines.length = 0
  }

  /** Resolve and record a call's deadline; throws as production does on bad options. */
  private recordDeadline(command: string, args: string[], opts?: { timeoutMs?: number | null, longRunning?: string }): MockDeadlineCall {
    const d = resolveDeadline(command, args, opts)
    const call: MockDeadlineCall = { command, args, ...d }
    this.deadlines.push(call)
    return call
  }

  /** The rejection a never-answering command ends in (`timesOut` fixtures). */
  private timeoutOf(call: MockDeadlineCall, abandoned: boolean): CommandTimeoutError {
    return new CommandTimeoutError(call.command, call.args, call.lane, call.budgetMs ?? 0, abandoned, call.jobId)
  }

  /**
   * End every live child still running with `result` (default exit 0) — the
   * "it finished on its own" branch of a cancel test.
   */
  finishLive(result: ExecResult = { stdout: '', stderr: '', exitCode: 0 }): void {
    for (const [pid, end] of [...this.liveChildren]) {
      this.liveChildren.delete(pid)
      end(result)
    }
  }

  /**
   * A live child: replay the fixture's stderr (the progress so far), hand the
   * caller a signal handle, and resolve only when enough signals arrived or
   * the test finishes it.
   */
  private liveExec(fixture: MockFixture & { live: MockLiveChild }, opts?: ExecOptions): Promise<ExecResult> {
    const pid = this.nextPid++
    const needed = fixture.live.signalsToExit ?? 1
    const stopped: ExecResult = fixture.live.onSignal
      ?? { stdout: '', stderr: '', exitCode: 1, signal: 'SIGINT' }
    return new Promise<ExecResult>((resolve) => {
      let gone = false
      let received = 0
      let markExit: () => void = () => {}
      const exit = new Promise<void>((r) => {
        markExit = r
      })
      const end = (result: ExecResult): void => {
        if (gone)
          return
        gone = true
        this.liveChildren.delete(pid)
        markExit()
        resolve(result)
      }
      this.liveChildren.set(pid, end)
      const initial = this.resultOf(fixture)
      if (initial.stderr && opts?.onStderr && fixture.teeStderr !== false)
        opts.onStderr(initial.stderr)
      const signal = (sig: NodeJS.Signals, group: boolean): boolean => {
        if (gone)
          return false
        this.signals.push(group ? { pid, signal: sig, group: true } : { pid, signal: sig })
        received++
        if (received >= needed)
          end(stopped)
        return true
      }
      const child: SpawnedChild = {
        pid,
        kill: sig => signal(sig, false),
        // A mock child is its own whole group (cr.48): the record says which
        // door the signal came through.
        killGroup: sig => signal(sig, true),
        exited: () => gone,
        exit,
      }
      opts?.onSpawn?.(child)
    })
  }

  async exec(command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    // Record for test assertions on the exact argv (e.g. the zfs hold calls).
    this.calls.push({ command, args })
    const deadline = this.recordDeadline(command, args, opts)
    // stdin (opts.stdin) and maxBuffer (opts.maxBuffer) are accepted for
    // interface parity but ignored — mock matching is by command + args only,
    // and secrets must never be matched on.
    // Try exact match (command + args) first, then command-only match
    const exactMatch = this.fixtures.find(
      f =>
        f.command === command
        && f.args !== undefined
        && f.args.length === args.length
        && f.args.every((a, i) => a === args[i]),
    ) ?? this.fixtures.find(f => f.command === command && f.argsMatch?.(args) === true)
    const match = exactMatch ?? this.fixtures.find(
      f => f.command === command && f.args === undefined && f.argsMatch === undefined,
    )
    if (match?.live)
      return this.liveExec({ ...match, live: match.live }, opts)
    if (match?.throws)
      throw match.throws
    if (match?.timesOut)
      throw this.timeoutOf(deadline, match.timesOut.abandoned === true)
    if (match)
      return this.tee(this.resultOf(match), match, opts)

    return {
      stdout: '',
      stderr: `mock: command not found: ${command}`,
      exitCode: 127,
    }
  }

  /**
   * Replay a fixture's stderr through the live progress sink the same way a
   * real child would, so a parser under test sees exactly the recorded bytes
   * (the contract `execToStream` has always had, now on `exec` too). A fixture
   * with `teeStderr: false` withholds it — see the field's note.
   */
  private tee(result: ExecResult, fixture?: MockFixture, opts?: ExecOptions): ExecResult {
    if (result.stderr && opts?.onStderr && fixture?.teeStderr !== false)
      opts.onStderr(result.stderr)
    return result
  }

  /** A fixture's next result — dequeue from `results` (last repeats), else `result`. */
  private resultOf(fixture: MockFixture): ExecResult {
    if (fixture.results && fixture.results.length > 0) {
      return fixture.results.length > 1 ? fixture.results.shift()! : fixture.results[0]
    }
    return fixture.result ?? { stdout: '', stderr: '', exitCode: 0 }
  }

  async pipeline(cmd1: string, args1: string[], cmd2: string, args2: string[], opts?: PipelineOptions): Promise<PipelineResult> {
    // Record the call so route tests can assert the exact send/recv argv.
    this.pipelineCalls.push({ cmd1, args1, cmd2, args2 })
    this.recordDeadline(cmd1, args1, opts)

    const sameArgs = (pattern: string[] | undefined, actual: string[]): boolean =>
      pattern === undefined || (pattern.length === actual.length && pattern.every((a, i) => a === actual[i]))

    const match = this.pipelineFixtures.find(
      f => f.cmd1 === cmd1 && f.cmd2 === cmd2 && sameArgs(f.args1, args1) && sameArgs(f.args2, args2),
    )
    if (match)
      return match.result

    // Default: both sides succeed (like the command-only exec fallbacks).
    return { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: '' }
  }

  /**
   * Streaming exec (story backup2.7). NOTHING is written anywhere — the mock
   * records the argv AND the target descriptor so a test can assert the exact
   * path and open flags a real restore would have used, which is the whole
   * safety property: `O_WRONLY` on a device (never `O_TRUNC`) and `'w'` on an
   * image file (same inode, rewritten in place).
   *
   * The call also lands in `calls` so a test can assert the ORDER of the whole
   * sequence — disable, restore, enable — in one list.
   */
  async execToStream(
    command: string,
    args: string[],
    target: ExecStreamTarget,
    opts?: ExecStreamOptions,
  ): Promise<ExecStreamResult> {
    this.calls.push({ command, args })
    this.streamCalls.push({ command, args, target })
    this.recordDeadline(command, args, opts)

    // Try exact match (command + args) first, then command-only match —
    // mirroring exec() so a catch-all fixture registered early cannot shadow a
    // specific one registered later.
    const exactMatch = this.streamFixtures.find(
      f =>
        f.command === command
        && f.args !== undefined
        && f.args.length === args.length
        && f.args.every((a, i) => a === args[i]),
    )
    const match = exactMatch ?? this.streamFixtures.find(
      f => f.command === command && f.args === undefined,
    )
    if (!match) {
      return {
        stderr: `mock: command not found: ${command}`,
        exitCode: 127,
        bytesWritten: 0,
      }
    }
    if (match.throws)
      throw match.throws
    // Replay the stderr through the progress sink the same way a live child
    // would — the parser under test then sees exactly the real bytes.
    if (match.result.stderr && opts?.onStderr)
      opts.onStderr(match.result.stderr)
    return match.result
  }
}
