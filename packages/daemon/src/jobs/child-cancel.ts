import type { SpawnedChild } from '../executor/types.js'
import type { CancelMeta, JobContext } from './queue.js'

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
 * left running — the run continues), or when it had already exited before the
 * first signal (the run is ending on its own, so there is nothing to cancel).
 */
export async function stopChild(child: SpawnedChild, label: string, opts: ChildCancelOptions = {}): Promise<void> {
  const waitMs = opts.waitMs ?? CANCEL_SIGNAL_WAIT_MS
  const seconds = Math.round(waitMs / 1000)
  if (child.exited() || !child.kill('SIGINT'))
    throw new Error(`${label} (pid ${child.pid}) has already exited — the run is finishing on its own`)
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
      void stopChild(child, this.label, this.opts).catch(() => {})
    }
  }

  /** Is a cancel pending or accepted for this job? */
  requested(): boolean {
    return this.ctx?.cancellation() != null
  }

  private async stop(): Promise<void> {
    if (!this.child)
      return
    await stopChild(this.child, this.label, this.opts)
  }
}
