import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Test helper for the timers stamp dir (`systemdTimersStampDir`). Every test
 * that drives a unit-store REMOVAL must point `ANAS_TIMERS_STAMP_DIR` at a
 * scratch dir, or the removal's stamp unlink reaches the real
 * `/var/lib/systemd/timers` (live-proven: a planted stamp in an env-pointed
 * scratch dir was deleted by two tests that omitted the override — review
 * D1). ONE helper, because the save/set/restore dance was hand-copied per
 * test and the copies were exactly where the omission happened.
 *
 * `withStampDir` wraps a whole test body; `useStampDir` fits the
 * beforeEach/afterEach hook style. Both restore the caller's prior env value
 * (including "unset") and remove the scratch dir afterwards.
 */

/** Create a fresh stamp scratch dir and point the env at it until `restore()`. */
export async function useStampDir(): Promise<{ stampDir: string, restore: () => void }> {
  const stampDir = await mkdtemp(join(tmpdir(), 'anas-stamp-dir-'))
  const saved = process.env.ANAS_TIMERS_STAMP_DIR
  process.env.ANAS_TIMERS_STAMP_DIR = stampDir
  return {
    stampDir,
    restore: () => {
      if (saved === undefined)
        delete process.env.ANAS_TIMERS_STAMP_DIR
      else
        process.env.ANAS_TIMERS_STAMP_DIR = saved
    },
  }
}

/** Run `fn` with `ANAS_TIMERS_STAMP_DIR` pointed at a fresh scratch dir. */
export async function withStampDir<T>(fn: (stampDir: string) => Promise<T>): Promise<T> {
  const { stampDir, restore } = await useStampDir()
  try {
    return await fn(stampDir)
  }
  finally {
    restore()
    await rm(stampDir, { recursive: true, force: true })
  }
}
