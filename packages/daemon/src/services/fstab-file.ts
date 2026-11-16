import { readFile } from 'node:fs/promises'
import { errorWord } from './error-word.js'

/**
 * The fstab path this daemon is configured with: ANAS_FSTAB_PATH when set, else
 * /etc/fstab. A running server may use another file (mock mode seeds a copy),
 * so code under the server uses the path it is handed and calls this only as
 * the default when it was handed none.
 */
export function configuredFstabPath(): string {
  return process.env.ANAS_FSTAB_PATH ?? '/etc/fstab'
}

/**
 * One read of an fstab file: its text; ABSENT when the file is not there
 * (ENOENT, ENOTDIR); or there and unreadable, with the path and the reason.
 * An empty file is a read file with the text ''.
 */
export type FstabRead
  = | { state: 'read', text: string }
    | { state: 'absent' }
    | { state: 'unreadable', path: string, reason: string }

/** Reads `path` once and says which of the three it found. Never throws. */
export async function readFstab(path: string): Promise<FstabRead> {
  try {
    const text = await readFile(path, 'utf8')
    return { state: 'read', text }
  }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return { state: 'absent' }
    return { state: 'unreadable', path, reason: errorWord(err) }
  }
}

/** An fstab that is there and could not be read. Carries `path` and `reason`. */
export class FstabUnreadableError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path} could not be read (${reason}). Check the file, then try again.`)
    this.name = 'FstabUnreadableError'
  }
}

/**
 * The text of the fstab at `path`, where an ABSENT file reads as an empty one
 * (a node with no fstab configures nothing). Throws FstabUnreadableError when
 * the file is there and could not be read.
 */
export async function readFstabAbsentAsEmpty(path: string): Promise<string> {
  const read = await readFstab(path)
  if (read.state === 'read')
    return read.text
  if (read.state === 'absent')
    return ''
  throw new FstabUnreadableError(read.path, read.reason)
}
