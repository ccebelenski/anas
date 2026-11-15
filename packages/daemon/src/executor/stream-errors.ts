/**
 * How a streaming exec ({@link CommandExecutor.execToStream}) can REJECT, as
 * far as the target is concerned (cr3.lunrestore, review2 B).
 *
 * A whole-image restore must tell "nothing reached the device" from "an
 * unknown amount did": the first restores the previous state, the second keeps
 * the LUN offline. A plain rejection proves neither, so every rejection that is
 * NOT one of these two is read as "unknown how much was written".
 */

/**
 * The child was never started, so nothing was written: the target could not be
 * opened, `spawn` threw, or the child failed to spawn (no pid). Only the
 * executor can say this; it is never inferred from a message.
 */
export class StreamNotStartedError extends Error {
  /** The errno code of the underlying failure (`ENOENT`, `EACCES`), when it had one. */
  readonly code?: string

  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'StreamNotStartedError'
    const code = (cause as { code?: unknown } | undefined)?.code
    if (typeof code === 'string')
      this.code = code
  }
}

/**
 * The child exited 0, but the fsync of the target failed: the bytes it wrote
 * may not be on the medium. `bytesWritten` is the descriptor's count (0 when
 * the child wrote through a description of its own).
 */
export class StreamFlushError extends Error {
  constructor(message: string, readonly bytesWritten: number) {
    super(message)
    this.name = 'StreamFlushError'
  }
}
