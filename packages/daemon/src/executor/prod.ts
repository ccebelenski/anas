import type { ChildProcess } from 'node:child_process'
import type { AbandonCause, AbandonedRegistry, Lane, ResolvedDeadline } from './deadline.js'
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
import { spawn } from 'node:child_process'
import { close, fsync, open, readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import {
  abandonedChildren,
  commandLabel,
  CommandTimeoutError,
  KILL_GRACE_MS,
  LANE_BUDGET_MS,
  resolveDeadline,
  TERM_GRACE_MS,
} from './deadline.js'

/** Promisified `open(2)` — the caller owns the fd, so the stream cannot close it. */
function openFd(path: string, flags: string | number): Promise<number> {
  return new Promise((resolve, reject) => {
    open(path, flags, (err, fd) => (err ? reject(err) : resolve(fd)))
  })
}

/** `pos:` line of `/proc/self/fdinfo/<fd>` — the open file description's offset. */
const FDINFO_POS_RE = /^pos:\s*(\d+)$/m

/** Best-effort close: the outcome is already decided by the time this runs. */
function closeFd(fd: number): void {
  close(fd, () => {})
}

/**
 * Hand a freshly spawned child to an `onSpawn` caller (rclone.5). Only a child
 * that actually got a pid is handed over — a spawn failure has nothing to
 * signal, and its rejection is the caller's answer. `exit` settles on the
 * process's own `exit` (not stdio `close`): what a canceller waits for is the
 * process being gone.
 */
export function announceSpawn(child: ChildProcess, onSpawn: ((child: SpawnedChild) => void) | undefined): void {
  if (!onSpawn || child.pid === undefined)
    return
  let gone = false
  const exit = new Promise<void>((resolve) => {
    const done = (): void => {
      gone = true
      resolve()
    }
    child.once('exit', done)
    child.once('error', done)
  })
  const pgid = child.pid
  onSpawn({
    pid: child.pid,
    kill: signal => (gone ? false : child.kill(signal)),
    // The child was spawned `detached`, so it leads a group whose id is its
    // pid. Addressed even after the leader exited: a member it left behind is
    // still in the group (cr.48).
    killGroup: (signal) => {
      try {
        process.kill(-pgid, signal)
        return true
      }
      catch {
        // ESRCH: nothing of the group is left to signal.
        return false
      }
    },
    exited: () => gone,
    exit,
  })
}

/** The historical default, kept for every caller that does not ask for more. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024

/**
 * How much of a teeing exec's stderr the RESULT keeps: the last 64 KiB. This
 * is the arithmetic behind the number — a `--stats 30s` rclone run emits about
 * 1.15 MB of stats JSON per day (DESIGN ground truth 2026-09-23), and the only
 * things post-run code reads from stderr are the FINAL stats object and the
 * error lines, which all arrive in the last seconds of a run. 64 KiB holds
 * hours of them; a multi-day run's earlier stats are progress, already
 * consumed by the tee, and not worth a day's worth of daemon memory.
 */
const STDERR_TAIL_CHARS = 64 * 1024

/**
 * Decodes stderr chunks multi-byte-safely, hands each decoded piece to a live
 * sink, and keeps only the last {@link STDERR_TAIL_CHARS} characters for the
 * result. Split out of the teeing exec path so the two properties that matter —
 * a UTF-8 character split across pipe reads, and the bounded tail — are
 * testable on hand-picked chunk splits, which an OS pipe will not hand you on
 * demand.
 */
export class StderrTee {
  private readonly decoder = new StringDecoder('utf8')
  private tail = ''

  constructor(private readonly sink: (chunk: string) => void) {}

  /** One raw stderr chunk, as the pipe delivered it. */
  write(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk))
  }

  /** End of stderr: flushes a pending multi-byte character. Returns the tail. */
  finish(): string {
    this.consume(this.decoder.end())
    return this.tail
  }

  private consume(chunk: string): void {
    if (!chunk)
      return
    this.sink(chunk)
    this.tail += chunk
    if (this.tail.length > STDERR_TAIL_CHARS) {
      this.tail = this.tail.slice(-STDERR_TAIL_CHARS)
      // Cut at the next line break so the tail re-parses cleanly (a partial
      // first line would read as a phantom raw line). A tail made of ONE line
      // longer than the cap keeps its raw cut — bounded is the point, and no
      // line is worth unbounding it for.
      const nl = this.tail.indexOf('\n')
      if (nl >= 0)
        this.tail = this.tail.slice(nl + 1)
    }
  }
}

/** Options for the production executor. The timing knobs and seams exist for tests. */
export interface ProdExecutorOptions {
  /** Per-lane default budgets in ms (default {@link LANE_BUDGET_MS}). */
  laneBudgetsMs?: Partial<Record<Lane, number>>
  /** SIGTERM → SIGKILL grace (default {@link TERM_GRACE_MS}). */
  termGraceMs?: number
  /** SIGKILL → settle-anyway grace (default {@link KILL_GRACE_MS}). */
  killGraceMs?: number
  /** Where abandoned children are recorded (default: the daemon's one registry). */
  registry?: AbandonedRegistry
  /**
   * Signal a process group. The seam a test replaces with a no-op to model a
   * child no signal can stop (a process in uninterruptible sleep).
   */
  signalGroup?: (pgid: number, signal: NodeJS.Signals) => void
}

/** Send `signal` to the process group `pgid` leads; a group that is already gone is not an error. */
export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  }
  catch {
    // ESRCH: nothing of the group is left to signal.
  }
}

interface WatchConfig {
  termGraceMs: number
  killGraceMs: number
  registry: AbandonedRegistry
  signalGroup: (pgid: number, signal: NodeJS.Signals) => void
}

/**
 * One call's deadline (cr.34, WAVE3-DESIGN §6.2 "On the deadline"). The
 * children were spawned `detached`, so each leads its own process group:
 *
 *   1. at the deadline, SIGTERM to every child's GROUP (a grandchild holding
 *      the pipe dies with its parent — P02 case D, not orphaned as in case C);
 *   2. {@link WatchConfig.termGraceMs} later, SIGKILL to every group not yet
 *      closed (a child that ignores TERM — P02 case B — cannot ignore this);
 *   3. {@link WatchConfig.killGraceMs} after that, settle ANYWAY: a child in
 *      uninterruptible sleep survives SIGKILL until its kernel call returns,
 *      and the call must not wait for it. Such a child goes into the abandoned
 *      registry until it exits.
 *
 * Whichever way it ends after the deadline fired — the children closed during
 * a grace, or step 3 — the call REJECTS with {@link CommandTimeoutError}.
 *
 * The executor ends a call early on the same ladder (cr.34r): a child over its
 * `maxBuffer` is {@link abort}ed — its group signalled, escalated, its pipes
 * let go of, and it is abandoned if it outlives the SIGKILL — and the call
 * rejects with the caller's error instead of the timeout. Before cr.34r an
 * overflow signalled the child's pid alone and never let go of the pipes, so
 * a grandchild still writing (`sh -c '…; yes >&2'`) kept the daemon's event
 * loop busy for good.
 */
class DeadlineWatch {
  /**
   * The executor is ending the call (the deadline fired, or {@link abort}):
   * whatever the children do next, the call rejects — with {@link failure},
   * else with a {@link CommandTimeoutError}.
   */
  stopping = false
  /** The error an {@link abort} settles with; null for the deadline's own. */
  private failure: Error | null = null
  /** Why the executor is ending the call — recorded on any child it abandons. */
  private cause: AbandonCause = 'deadline'
  private done = false
  private readonly timers: NodeJS.Timeout[] = []
  private readonly members: { child: ChildProcess, command: string, args: string[], exited: boolean, closed: boolean }[]

  /**
   * @param children each child with its own argv (a pipeline's consumer is
   *   recorded as itself if it is the one left stuck); the call's error is
   *   named after the FIRST (the command, or a pipeline's producer).
   */
  constructor(
    children: { child: ChildProcess, command: string, args: string[] }[],
    private readonly deadline: ResolvedDeadline,
    private readonly cfg: WatchConfig,
    /** Rejects the call: a {@link CommandTimeoutError}, or an {@link abort}'s own error. */
    private readonly onSettle: (err: Error) => void,
  ) {
    this.members = children.map(({ child, command, args }) => {
      const m = { child, command, args, exited: false, closed: false }
      child.once('exit', () => {
        m.exited = true
      })
      child.once('close', () => {
        m.closed = true
      })
      return m
    })
    if (deadline.budgetMs !== null)
      this.timers.push(setTimeout(() => this.expire(), deadline.budgetMs))
  }

  /** The call settled before the deadline (or failed to start): stop watching. */
  cancel(): void {
    this.done = true
    for (const t of this.timers)
      clearTimeout(t)
  }

  /** Every child closed after the deadline fired: nothing left to wait for, settle now. */
  settleNow(): void {
    this.final()
  }

  /**
   * Signal each group that may still have members. A group whose leader
   * exited is still signalled while its stdio is open — a grandchild holding
   * the pipe is exactly what step 1 is for.
   */
  private signal(signal: NodeJS.Signals): void {
    for (const m of this.members) {
      if (m.closed || m.child.pid === undefined)
        continue
      this.cfg.signalGroup(m.child.pid, signal)
    }
  }

  /**
   * End the call now, for a reason that is not the deadline (a child over its
   * `maxBuffer`): the deadline's ladder from `first`, and the call settles
   * with `err` once every child has closed, or at step 3 with the survivors
   * abandoned under `cause`. A call already stopping keeps its first reason.
   *
   * The pipes are let go of at step 3 (or by the close), not here: while a
   * pipe is open, a `close` still means every holder of it is gone, which is
   * what tells the ladder a TERM-ignoring grandchild is still there to KILL.
   * The caller stops reading once {@link stopping} is set; the pipe keeps
   * draining, so no writer blocks before its signal arrives.
   */
  abort(err: Error, cause: AbandonCause, first: 'SIGTERM' | 'SIGKILL'): void {
    if (this.done || this.stopping)
      return
    this.failure = err
    this.cause = cause
    this.stop(first)
  }

  private expire(): void {
    if (this.done || this.stopping)
      return
    this.stop('SIGTERM')
  }

  /** Steps 1–3 from `first`: a SIGKILL start skips the TERM grace. */
  private stop(first: 'SIGTERM' | 'SIGKILL'): void {
    // The budget's own timer must not restart the ladder (or re-label the
    // reason) once an abort has begun it.
    for (const t of this.timers.splice(0))
      clearTimeout(t)
    this.stopping = true
    this.signal(first)
    const settleLater = (): void => {
      this.timers.push(setTimeout(() => this.final(), this.cfg.killGraceMs))
    }
    if (first === 'SIGKILL') {
      settleLater()
      return
    }
    this.timers.push(setTimeout(() => {
      if (this.done)
        return
      this.signal('SIGKILL')
      settleLater()
    }, this.cfg.termGraceMs))
  }

  private final(): void {
    if (this.done)
      return
    this.cancel()
    const budgetMs = this.deadline.budgetMs ?? 0
    const stuck = this.members.filter(m => !m.exited && m.child.pid !== undefined)
    const since = new Date().toISOString()
    for (const m of stuck) {
      const pid = m.child.pid as number
      this.cfg.registry.add({
        pid,
        label: commandLabel(m.command, m.args),
        command: m.command,
        args: [...m.args],
        lane: this.deadline.lane,
        ...(this.deadline.jobId !== undefined ? { jobId: this.deadline.jobId } : {}),
        budgetMs,
        cause: this.cause,
        since,
      })
      // `exited` was false just now and events are not concurrent with this
      // callback, so this listener sees the exit whenever it comes.
      m.child.once('exit', () => this.cfg.registry.remove(pid))
    }
    // Let go of the pipes: an unkillable child (or a grandchild that escaped
    // the group) must not keep this call, or the daemon's buffers, alive.
    for (const m of this.members) {
      m.child.stdin?.destroy()
      m.child.stdout?.destroy()
      m.child.stderr?.destroy()
    }
    if (this.failure) {
      this.onSettle(this.failure)
      return
    }
    const first = this.members[0]
    this.onSettle(new CommandTimeoutError(
      first.command,
      [...first.args],
      this.deadline.lane,
      budgetMs,
      stuck.length > 0,
      this.deadline.jobId,
    ))
  }
}

/**
 * Production executor (cr.34): ONE spawn-based implementation behind every
 * door — `exec` (buffered and teeing), `pipeline` and `execToStream`.
 *
 * Arguments are always an argv array handed to `spawn` (never a shell), so
 * nothing is re-parsed. Every child is spawned `detached`: it leads its own
 * process group, which is what lets a deadline stop a child together with
 * whatever it started (P02 case D). Detaching changes signalling, not
 * lifetime: anasd.service keeps systemd's default `KillMode=control-group`,
 * so the groups still stop with the daemon (WAVE3-DESIGN F7).
 *
 * `execFile` is no longer used: it cannot take `detached` as a documented
 * option, and its own `timeout` signals one pid once and then waits — the
 * case-B hang this story exists to remove.
 */
export class ProdExecutor implements CommandExecutor {
  private readonly budgets: Record<Lane, number>
  private readonly cfg: WatchConfig

  constructor(opts: ProdExecutorOptions = {}) {
    this.budgets = { ...LANE_BUDGET_MS, ...opts.laneBudgetsMs }
    this.cfg = {
      termGraceMs: opts.termGraceMs ?? TERM_GRACE_MS,
      killGraceMs: opts.killGraceMs ?? KILL_GRACE_MS,
      registry: opts.registry ?? abandonedChildren,
      signalGroup: opts.signalGroup ?? signalProcessGroup,
    }
  }

  /**
   * Run a command and collect its output.
   *
   * Without `onStderr` both streams are buffered, each up to `maxBuffer`
   * (default 10 MiB) — `execFile`'s contract: stdin is an open pipe (written
   * and closed only when `stdin` is given), over the cap the child's group
   * gets SIGTERM (then the deadline's escalation, cr.34r) and the call
   * rejects with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` once the group is gone.
   *
   * With `onStderr` (rclone's JSON stats, rclone.2 slice 2) stderr is TEED to
   * the callback as it arrives and NOT retained: the result carries the last
   * {@link STDERR_TAIL_CHARS} characters only, decoded multi-byte-safely, so a
   * multi-day run's stats log never accumulates in the daemon (execFile could
   * not do this: it buffers both streams up to `maxBuffer` with no opt-out).
   * stdin is `ignore` unless given; over the stdout cap the child's group
   * gets SIGKILL.
   *
   * Both: spawn failures reject (ENOENT/EACCES), a non-zero exit resolves
   * (never throws), exit codes pass through exactly (`timeout`'s 124 is
   * load-bearing for the mount probe), a signal death reports `exitCode: 1`
   * plus the signal name (live-proof F16), EPIPE on stdin is ignored, and the
   * deadline rejects with {@link CommandTimeoutError}.
   */
  exec(command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const deadline = resolveDeadline(command, args, opts, this.budgets)
      const tee = opts?.onStderr ? new StderrTee(opts.onStderr) : null
      const child = spawn(command, args, {
        detached: true,
        stdio: [tee && opts?.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        // Merge secret env (e.g. pbc's PBS_PASSWORD, Epic 16) over the
        // daemon's own environment for the child only — never on argv.
        ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
      })

      let settled = false
      // Declared before `fail` uses it; assigned at once below.
      let watch: DeadlineWatch | undefined
      const fail = (err: Error): void => {
        if (settled)
          return
        settled = true
        watch?.cancel()
        reject(err)
      }
      watch = new DeadlineWatch([{ child, command, args }], deadline, this.cfg, fail)

      const maxBuffer = opts?.maxBuffer ?? DEFAULT_MAX_BUFFER
      // Over the cap the call is ended on the deadline's own ladder (cr.34r):
      // the child's whole GROUP is signalled and escalated, the pipes are let
      // go of, and a survivor is abandoned — a grandchild on the inherited
      // pipe must not outlive the call, or keep the daemon reading from it.
      // The call rejects with the overflow's error once the group is gone.
      const overflow = (stream: 'stdout' | 'stderr'): void => {
        if (tee) {
          // The teeing path's cap is on stdout alone; the run's output is
          // unrepresentable, so the group gets SIGKILL at once.
          watch.abort(new Error(`stdout exceeded maxBuffer (${maxBuffer} bytes)`), 'maxBuffer', 'SIGKILL')
          return
        }
        // execFile's contract: over the cap, SIGTERM and an error carrying
        // its code (a string code, so callers file it with the spawn failures).
        watch.abort(
          Object.assign(new RangeError(`${stream} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
          'maxBuffer',
          'SIGTERM',
        )
      }

      const stdoutChunks: Buffer[] = []
      let stdoutBytes = 0
      // Once the executor is ending the call (deadline or overflow) its output
      // no longer matters: the pipes keep draining, nothing is kept or teed.
      child.stdout?.on('data', (d: Buffer) => {
        if (settled || watch.stopping)
          return
        stdoutBytes += d.length
        if (stdoutBytes > maxBuffer) {
          overflow('stdout')
          return
        }
        stdoutChunks.push(d)
      })

      const stderrChunks: Buffer[] = []
      let stderrBytes = 0
      child.stderr?.on('data', (d: Buffer) => {
        if (settled || watch.stopping)
          return
        if (tee) {
          tee.write(d)
          return
        }
        stderrBytes += d.length
        if (stderrBytes > maxBuffer) {
          overflow('stderr')
          return
        }
        stderrChunks.push(d)
      })

      if (child.stdin) {
        child.stdin.on('error', () => {
          // Ignore EPIPE if the child exits before consuming stdin — the
          // close handler below reports the real outcome.
        })
        // Feed stdin for secrets (e.g. smbpasswd -s reads the password here,
        // so it never lands in argv / the process list), then close it.
        if (opts?.stdin !== undefined)
          child.stdin.end(opts.stdin)
      }

      // Spawn failures only (ENOENT, EACCES) — the process never started.
      child.on('error', fail)

      child.on('close', (code, signal) => {
        if (watch.stopping) {
          watch.settleNow()
          return
        }
        if (settled)
          return
        settled = true
        watch.cancel()
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          // `finish` flushes the decoder: the tail bytes of a multi-byte
          // character split across the last two reads are only now decodable.
          stderr: tee ? tee.finish() : Buffer.concat(stderrChunks).toString('utf8'),
          exitCode: code === null ? 1 : code,
          ...(signal ? { signal } : {}),
        })
      })

      announceSpawn(child, opts?.onSpawn)
    })
  }

  /**
   * Run `cmd1 args1 | cmd2 args2` as two real processes — NO shell (spawn,
   * argv arrays), so nothing is re-parsed. cmd1.stdout → cmd2.stdin; both
   * stderrs and cmd2.stdout are buffered. Resolves with both exit codes; the
   * caller decides success (both zero).
   *
   * Early-exit safety: if the consumer (recv) dies before the producer (send)
   * finishes, the producer would otherwise block forever writing into a dead
   * pipe. We unpipe and SIGTERM it so no orphaned `zfs send` lingers. Symmetric
   * cleanup runs if a process fails to spawn (the other is killed before we
   * reject).
   *
   * The deadline covers the pair: both groups are signalled, and the call
   * rejects with {@link CommandTimeoutError} named after the producer.
   */
  pipeline(cmd1: string, args1: string[], cmd2: string, args2: string[], opts?: PipelineOptions): Promise<PipelineResult> {
    return new Promise((resolve, reject) => {
      const deadline = resolveDeadline(cmd1, args1, opts, this.budgets)
      const left = spawn(cmd1, args1, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const right = spawn(cmd2, args2, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })

      let leftStderr = ''
      let rightStderr = ''
      let rightStdout = ''
      let leftExit: number | null = null
      let rightExit: number | null = null
      let leftClosed = false
      let rightClosed = false
      let settled = false

      const watch = new DeadlineWatch([{ child: left, command: cmd1, args: args1 }, { child: right, command: cmd2, args: args2 }], deadline, this.cfg, (err) => {
        if (settled)
          return
        settled = true
        reject(err)
      })

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
        if (watch.stopping) {
          watch.settleNow()
          return
        }
        settled = true
        watch.cancel()
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
        watch.cancel()
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

  /**
   * Run `command args` with its STDOUT going straight into `target` (story
   * backup2.7). NO shell, NO redirect string — spawn with an argv array and a
   * descriptor ANAS opened itself.
   *
   * The four things that are load-bearing here:
   *
   *  - **The child's fd 1 IS our descriptor**, handed to `spawn` as a raw fd
   *    rather than a Node pipe the parent copies out of. Live-proof wave 2
   *    found out why that matters: libuv backs a `'pipe'` stdio slot with a
   *    `socketpair(2)`, and `proxmox-backup-client`'s `-` target opens
   *    `/dev/stdout` BY PATH — which on a socket fails with
   *    `unable to open /dev/stdout - No such device or address (os error 6)`,
   *    so every image restore died before writing a byte. A real file or block
   *    descriptor reopens through `/proc/self/fd/1` exactly as the shell
   *    redirect the ground truth used does.
   *  - **The flags come from the caller.** A block device is opened `O_WRONLY`
   *    (no `O_CREAT`, no `O_TRUNC`); an image file is opened `'w'`, which keeps
   *    the inode so the LIO fileio backstore never has to be recreated.
   *  - **fsync before resolve.** The promise settling means the bytes are on
   *    the medium, not in the page cache — a restore that reported success with
   *    the tail still buffered would be a lie a power loss makes expensive.
   *  - **`bytesWritten` is reported even on failure.** It is the ONLY evidence
   *    that a mid-stream failure left a half-written device: pbc leaves no
   *    marker of any kind (GT-60), so this number is what the job's "the image
   *    was partially written" verdict is built on. The child writes through the
   *    SAME open file description, so the offset it advanced is ours to read
   *    back from `/proc/self/fdinfo/<fd>`.
   *
   * `onSpawn` is honoured (cr.34): an image restore can be signalled like any
   * other run. A deadline rejects with {@link CommandTimeoutError} (the
   * descriptor is closed, nothing is fsynced or counted).
   */
  async execToStream(
    command: string,
    args: string[],
    target: ExecStreamTarget,
    opts?: ExecStreamOptions,
  ): Promise<ExecStreamResult> {
    // Resolved before anything is opened: a bad deadline option is a
    // programming error and must not leave a descriptor behind.
    const deadline = resolveDeadline(command, args, opts, this.budgets)
    // The fd is opened HERE and stays ours: an fsync has to happen on a
    // still-open descriptor, and the byte count is read off it after the child
    // exits.
    const fd = await openFd(target.path, target.flags)
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(command, args, {
          detached: true,
          // fd 1 is the descriptor itself — see the note above.
          stdio: ['ignore', fd, 'pipe'],
          ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
        })
      }
      catch (err) {
        closeFd(fd)
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }

      // NOTE (rclone.2 slice 2 review): stderr is retained UNBOUNDED here — the
      // same pre-tee pattern `exec` had. pbc's restore writes progress lines at
      // a roughly doubling interval (GT-59), so a restore's whole stderr is a
      // few MB at worst and the buffering has never hurt; the fix `exec` needed
      // (days of `--stats 30s` JSON) does not apply to this shape. Revisit only
      // if a stream target's tool learns to talk NDJSON on stderr.
      let stderr = ''
      let settled = false

      const watch = new DeadlineWatch([{ child, command, args }], deadline, this.cfg, (err) => {
        if (settled)
          return
        settled = true
        closeFd(fd)
        reject(err)
      })

      const settle = (exitCode: number, signal?: string): void => {
        if (settled)
          return
        if (watch.stopping) {
          watch.settleNow()
          return
        }
        settled = true
        watch.cancel()
        const bytesWritten = fdPosition(fd)
        // FSYNC on a descriptor that is still ours: the child has exited, so
        // every byte it wrote is in the page cache and nowhere else yet.
        fsync(fd, (err) => {
          closeFd(fd)
          if (err && exitCode === 0) {
            reject(err)
            return
          }
          resolve({ stderr, exitCode, bytesWritten, ...(signal ? { signal } : {}) })
        })
      }

      child.stderr?.on('data', (d) => {
        const chunk = String(d)
        stderr += chunk
        opts?.onStderr?.(chunk)
      })

      child.on('error', (err) => {
        if (settled)
          return
        settled = true
        watch.cancel()
        closeFd(fd)
        reject(err)
      })

      child.on('close', (code, signal) => {
        // A signal kill leaves no numeric code; report it as a failure rather
        // than inventing a zero — and carry the signal NAME through (D5): it is
        // the only record of how the process ended, and a killed image restore
        // must say "killed by SIGKILL", not quote a progress line as its reason.
        settle(code === null ? 1 : code, signal ?? undefined)
      })

      announceSpawn(child, opts?.onSpawn)
    })
  }
}

/**
 * How far the shared file description has advanced — the byte count a child
 * that inherited our fd wrote. `pos:` in `/proc/self/fdinfo/<fd>` is the
 * offset of the open file description, which the child shares with us because
 * `spawn` dup'd the descriptor rather than opening its own.
 *
 * Best-effort by design: an unreadable fdinfo must not turn a good restore into
 * a failure, so it reads as 0 and the caller's own "the client said complete but
 * N bytes arrived" warning is what surfaces the disagreement.
 */
function fdPosition(fd: number): number {
  try {
    const m = FDINFO_POS_RE.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))
    return m ? Number(m[1]) : 0
  }
  catch {
    return 0
  }
}
