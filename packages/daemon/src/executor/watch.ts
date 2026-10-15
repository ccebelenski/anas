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
import { commandLabel, CommandTimeoutError } from './deadline.js'

/**
 * An executor that passes every call through and remembers two things about
 * them (cr.35): which calls ended in a {@link CommandTimeoutError} — even when
 * the caller caught it and carried on with an empty answer — and which calls
 * are still running.
 *
 * It exists for the dashboard: its collectors fail open by catching every
 * error, which made a pool whose `zpool status` hung read as "no pools". The
 * dashboard hands each collector its own watched executor, so a timeout the
 * collector swallowed still marks that section unavailable, and a section
 * that runs out of time can name the command it was waiting for.
 */
export class WatchedExecutor implements CommandExecutor {
  /** Every timeout a call through this executor ended in, in order. */
  readonly timeouts: CommandTimeoutError[] = []
  private readonly running = new Map<number, { label: string, since: number }>()
  private nextId = 0

  constructor(private readonly inner: CommandExecutor, private readonly now: () => number = Date.now) {}

  /** The short name of the longest-running call still in flight, if any. */
  oldestRunning(): string | undefined {
    let oldest: { label: string, since: number } | undefined
    for (const r of this.running.values()) {
      if (!oldest || r.since < oldest.since)
        oldest = r
    }
    return oldest?.label
  }

  exec(command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    return this.watch(commandLabel(command, args), () => this.inner.exec(command, args, opts))
  }

  pipeline(cmd1: string, args1: string[], cmd2: string, args2: string[], opts?: PipelineOptions): Promise<PipelineResult> {
    return this.watch(commandLabel(cmd1, args1), () => this.inner.pipeline(cmd1, args1, cmd2, args2, opts))
  }

  execToStream(command: string, args: string[], target: ExecStreamTarget, opts?: ExecStreamOptions): Promise<ExecStreamResult> {
    return this.watch(commandLabel(command, args), () => this.inner.execToStream(command, args, target, opts))
  }

  private async watch<T>(label: string, call: () => Promise<T>): Promise<T> {
    const id = this.nextId++
    this.running.set(id, { label, since: this.now() })
    try {
      return await call()
    }
    catch (err) {
      if (err instanceof CommandTimeoutError)
        this.timeouts.push(err)
      throw err
    }
    finally {
      this.running.delete(id)
    }
  }
}
