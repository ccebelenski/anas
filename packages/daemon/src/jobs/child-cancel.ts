import type { SpawnedChild } from '../executor/types.js'
import type { CancelMeta, JobCancellation, JobContext } from './queue.js'
import { JobCancelledError } from './queue.js'

/**
 * The ONE cancel hook a job registers for the tool it runs (rclone.5): the
 * cloud sync direct run (rclone) and the backup direct run
 * (proxmox-backup-client) both stop their child the same way, so the ladder
 * lives here once.
 *
 * The ladder: SIGINT (both tools finish or abandon their in-flight work and
 * exit; rclone stops after its in-flight transfers, PBS discards the
 * unfinished snapshot), wait up to {@link CANCEL_SIGNAL_WAIT_MS}; a SECOND
 * SIGINT if the child is still alive, wait again; still alive → the cancel
 * FAILS with the reason and the run continues untouched. No SIGKILL: a tool
 * killed mid-write leaves nothing it can clean up, and the story's contract is
 * that a cancel either stops the run cleanly or says it could not.
 *
 * The job's own `finally` (the transient snapshot's destroy) is untouched by
 * any of this — the child's exit is what ends the exec the body is awaiting,
 * and the body unwinds normally from there.
 */

/** How long each SIGINT is given before the next step of the ladder. */
export const CANCEL_SIGNAL_WAIT_MS = 10_000

/**
 * The child could not be signalled AT ALL — no SIGINT left this process. The
 * executor's `kill` reports false both for a child that already exited (the
 * run is ending on its own) and for one that never really ran (the executor's
 * `error` event — a spawn failure behind a wrapper), so the reason claims
 * neither: it says what happened (nothing could be signalled) and what that
 * means (the run continues on its own). The cancel FAILS with it — the run is
 * not cancelled — and {@link ChildCancel.signalled} stays false, which is what
 * keeps a run that finished on its own from ever being labelled cancelled.
 */
export class ChildUnsignallableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChildUnsignallableError'
  }
}

export interface ChildCancelOptions {
  /** Per-signal wait (default {@link CANCEL_SIGNAL_WAIT_MS}); tests shorten it. */
  waitMs?: number
}

/** Resolve true when `exit` settles within `ms`, false on the timeout. */
async function exitedWithin(exit: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(resolve, ms, false)
  })
  try {
    return await Promise.race([exit.then(() => true as const), timeout])
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Stop a running child with the SIGINT ladder. Resolves once it has exited;
 * throws with the reason when it has not after the second signal (the child is
 * left running — the run continues), or when the FIRST signal could not be
 * delivered at all ({@link ChildUnsignallableError}: the process may have
 * already exited, or may never have really run — either way the run is ending
 * or continuing on its own, and the cancel fails).
 */
export async function stopChild(child: SpawnedChild, label: string, opts: ChildCancelOptions = {}): Promise<void> {
  const waitMs = opts.waitMs ?? CANCEL_SIGNAL_WAIT_MS
  const seconds = Math.round(waitMs / 1000)
  if (child.exited() || !child.kill('SIGINT')) {
    throw new ChildUnsignallableError(
      `${label} (pid ${child.pid}) could not be signalled (it may have already exited); the run continues on its own`,
    )
  }
  if (await exitedWithin(child.exit, waitMs))
    return
  if (!child.kill('SIGINT') || await exitedWithin(child.exit, waitMs))
    return
  throw new Error(
    `${label} (pid ${child.pid}) did not stop after two SIGINTs ${seconds} s apart — the run continues`,
  )
}

/**
 * Wire a job's cancel hook to the child its body is about to spawn.
 *
 * Construct it at the START of the body (the job is cancellable from then on)
 * and pass {@link ChildCancel.onSpawn} as the exec's `onSpawn`. A cancel that
 * arrives before the child exists is accepted at once and the child is stopped
 * the moment it appears — the run never gets going.
 */
export class ChildCancel {
  private child: SpawnedChild | undefined
  /** True once a SIGINT was actually delivered to the child (see {@link signalled}). */
  private delivered = false
  /** True when the spawn-time stop attempt could not signal the child at all. */
  private spawnUnsignallable = false

  constructor(
    private readonly ctx: JobContext | undefined,
    private readonly label: string,
    meta: CancelMeta = {},
    private readonly opts: ChildCancelOptions = {},
  ) {
    ctx?.onCancel(async () => this.stop(), meta)
  }

  /** The exec's `onSpawn` — records the child; stops it at once when a cancel is already pending. */
  readonly onSpawn = (child: SpawnedChild): void => {
    this.child = child
    if (this.ctx?.cancellation()) {
      // Fire-and-forget: the cancel was already accepted, and a child that
      // survives the ladder here simply runs on — its exit ends the body.
      // Through `stop`, so a signal that cannot be delivered here (a spawn
      // failure behind the wrapper) is remembered — see
      // {@link stoppedOnPurpose}.
      void this.stop().catch((err) => {
        if (err instanceof ChildUnsignallableError)
          this.spawnUnsignallable = true
      })
    }
  }

  /** Is a cancel pending or accepted for this job? */
  requested(): boolean {
    return this.cancellation() != null
  }

  /** The accepted or pending cancellation, or null — the context's own answer. */
  cancellation(): JobCancellation | null {
    return this.ctx?.cancellation() ?? null
  }

  /**
   * Did the hook actually deliver a SIGINT to the child? Settles with the
   * hook's own ladder, so a body that ends the instant its child dies may read
   * it before the hook has returned — {@link stoppedOnPurpose} is the question
   * a body asks.
   */
  signalled(): boolean {
    return this.delivered
  }

  /**
   * Was this run being stopped on purpose — a SIGINT went out, or a child that
   * could take one was stopped at spawn? Answerable the moment the body ends,
   * with no race: the child either existed to be signalled (spawned, and the
   * spawn-time signal was deliverable) or it never did. False when no child
   * was ever spawned, or when the spawn-time signal could not be delivered —
   * a spawn failure — which is what keeps a run that never got going from
   * being reported as stopped on purpose.
   */
  stoppedOnPurpose(): boolean {
    return this.delivered || (this.child !== undefined && !this.spawnUnsignallable)
  }

  private async stop(): Promise<void> {
    if (!this.child)
      return
    try {
      await stopChild(this.child, this.label, this.opts)
      this.delivered = true
    }
    catch (err) {
      // The first SIGINT is the only ladder step before which nothing was
      // delivered: every later failure still means the child was signalled.
      if (!(err instanceof ChildUnsignallableError))
        this.delivered = true
      throw err
    }
  }
}

/**
 * The pre-flight boundary check both runners share (rclone.5 review): a cancel
 * accepted before the child exists must end the run AT ONCE — not after the
 * whole pre-flight has read the mount tables, taken and swept a transient
 * snapshot and resolved secrets for a run that was already stopped on purpose.
 * Call it at each pre-flight boundary with what the next step would have done
 * (before the guard, before the snapshots, before the exec); when a cancel is
 * accepted it throws {@link JobCancelledError}, which unwinds through every
 * `finally` on the way — the transient snapshot's destroy included — and ends
 * the job `cancelled`.
 */
export function assertRunNotCancelled(cancel: ChildCancel, next: string): void {
  const by = cancel.cancellation()
  if (by)
    throw new JobCancelledError(`cancelled by ${by.user} at ${by.at} before ${next}`)
}
