import type { CommandExecutor } from '../executor/types.js'
import { stat } from 'node:fs/promises'
import { ZFS } from './zfs-snapshot.js'

/**
 * ZVOL SNAPSHOT DEVICES for an `img` archive (story backup2.4).
 *
 * A ZFS volume's snapshot has data the instant it is taken, but no device node:
 * `snapdev` defaults to `hidden`, so `/dev/zvol/<pool>/<vol>@<snap>` simply does
 * not exist (GT-43). Publishing it is a PROPERTY CHANGE on somebody else's
 * volume, which under the guest rule means the whole cycle has to be
 * set → use → put back exactly as found:
 *
 *   1. READ the property first (`zfs get -Hp -o name,value,source snapdev`).
 *      The SOURCE is the part that matters: `default`/`inherited` and `local`
 *      need different restores, and GT-46 proved that `zfs set snapdev=hidden`
 *      is NOT a restore — it leaves `source=local` where there was `default`.
 *   2. `zfs set snapdev=visible <vol>` — only when it is not visible already. A
 *      volume that was already visible is left completely alone, including on
 *      the way out: ANAS restores what ANAS changed, nothing else.
 *   3. `udevadm settle`, then POLL for the node. GT-44 measured `zfs set`
 *      returning at 44 ms and the node appearing at 54 ms — so the node is NOT
 *      there the instant the set returns, and a poll (which normally resolves on
 *      the first pass) is both correct and cheap.
 *   4. Back up `<device>@<label>` — hard read-only (`blockdev --getro` = 1,
 *      opening for write gives `Read-only file system`) and a stable
 *      point-in-time view: after the live volume changed, a second `.img` backup
 *      of the snapshot device reported `had to backup 0 B ... reused 100%`
 *      (GT-45).
 *   5. RESTORE in a `finally`: `zfs inherit snapdev <vol>` when the property was
 *      inherited, `zfs set snapdev=<prior value>` when it was genuinely local.
 *      A restore that fails is a WARNING on a completed backup, never a failure
 *      — the data is already safe, and the leftover property is nameable.
 *
 * The transient snapshot itself is NOT this module's business: it is the
 * backup2.3 lifecycle, taken with `zfs snapshot -r` on the volume (which is a
 * dataset like any other) and destroyed in the run's own `finally`.
 */

const UDEVADM = '/usr/bin/udevadm'

/** Trailing whitespace on a `zfs get -H` row. */
const TRAILING_WS_RE = /\s+$/

/** How long to wait for the snapshot device node (GT-44: it took ~10 ms). */
export const SNAPDEV_NODE_ATTEMPTS = 40
export const SNAPDEV_NODE_INTERVAL_MS = 50

/** `<device>@<label>` — the snapshot volume's own device path. */
export function zvolSnapshotDevice(device: string, label: string): string {
  return `${device}@${label}`
}

/**
 * `zfs get -Hp -o name,value,source snapdev <volume>` — structured, one row.
 *
 * This is the argv the ground-truth capture used verbatim (`zvol-snapdev.txt`:
 * `gtbackup/vol1\thidden\tlocal`), so the parser below is written against real
 * output rather than an assumed column set.
 */
export function snapdevGetArgs(volume: string): string[] {
  return ['get', '-Hp', '-o', 'name,value,source', 'snapdev', volume]
}

/** The `snapdev` property as ZFS reports it: the value and where it came from. */
export interface SnapdevProperty {
  /** `hidden` or `visible`. */
  value: string
  /** `default`, `local`, `inherited from <dataset>`, `received`, `temporary`. */
  source: string
}

/**
 * Parse one `zfs get -Hp -o name,value,source` row: `<name>\t<value>\t<source>`,
 * tab-separated and header-less (real capture, `zvol-snapdev.txt`). The NAME is
 * discarded — the caller asked about one volume — and any other shape is null,
 * which the caller treats as "could not read" and refuses to act on.
 */
export function parseSnapdevProperty(stdout: string): SnapdevProperty | null {
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(TRAILING_WS_RE, '')
    if (!line.trim())
      continue
    const fields = line.split('\t')
    if (fields.length < 3)
      return null
    const value = fields[1].trim()
    // `inherited from <dataset>` carries a space, never a tab — the tail is
    // rejoined so a source with more structure still round-trips whole.
    const source = fields.slice(2).join('\t').trim()
    if (!value || !source)
      return null
    return { value, source }
  }
  return null
}

/**
 * The argv that puts the property back exactly as it was.
 *
 * `local` is the ONLY source with a value of its own to restore; everything else
 * (`default`, `inherited from …`, `received`, `temporary`) is restored by
 * REMOVING the local value, which is what `zfs inherit` does and what
 * `zfs set snapdev=hidden` conspicuously does not (GT-46).
 */
export function snapdevRestoreArgs(volume: string, prior: SnapdevProperty): string[] {
  return prior.source === 'local'
    ? ['set', `snapdev=${prior.value}`, volume]
    : ['inherit', 'snapdev', volume]
}

/** One volume whose snapshot device the run needs published. */
export interface ZvolSnapshotSource {
  /** The volume dataset, e.g. `tank/vol1`. */
  volume: string
  /** Its stable live device path, `/dev/zvol/tank/vol1`. */
  device: string
  /** The transient snapshot label this run took. */
  label: string
}

/** Test seams: the node check and the poll budget. */
export interface ZvolSnapdevOptions {
  /** Does this device node exist? Defaults to a real `stat`. */
  deviceExists?: (path: string) => Promise<boolean>
  attempts?: number
  intervalMs?: number
}

function noop(): void {}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function nodeExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  }
  catch {
    return false
  }
}

/**
 * Publish every source's snapshot device, run `fn`, and put every `snapdev`
 * property back on the way out — success, failure or timeout alike.
 *
 * `fn` receives `volume -> snapshot device path`, which is what the expansion
 * already computed; the map is handed over so a caller can assert the run read
 * the node it published rather than re-deriving the path.
 *
 * Restore problems are appended to `warnings` (never thrown): a completed backup
 * must not be reported as failed because a property could not be put back, and
 * the warning names the volume and the exact command to run by hand.
 */
export async function withZvolSnapshotDevices<T>(
  executor: CommandExecutor,
  sources: ZvolSnapshotSource[],
  fn: (devices: Map<string, string>) => Promise<T>,
  warnings: string[],
  updateProgress: (message: string) => void = noop,
  opts: ZvolSnapdevOptions = {},
): Promise<T> {
  if (!sources.length)
    return fn(new Map())

  const exists = opts.deviceExists ?? nodeExists
  const attempts = opts.attempts ?? SNAPDEV_NODE_ATTEMPTS
  const intervalMs = opts.intervalMs ?? SNAPDEV_NODE_INTERVAL_MS

  const devices = new Map<string, string>()
  /** Only the volumes ANAS actually CHANGED get restored. */
  const toRestore: { volume: string, prior: SnapdevProperty }[] = []

  try {
    for (const source of sources) {
      const read = await executor.exec(ZFS, snapdevGetArgs(source.volume))
      const prior = read.exitCode === 0 ? parseSnapdevProperty(read.stdout) : null
      if (!prior) {
        // Refuse to change a property we could not read: without the prior
        // value and source there is no faithful restore, and leaving somebody
        // else's volume permanently altered is worse than a failed run that
        // says exactly why.
        throw new Error(
          `could not read the 'snapdev' property of volume '${source.volume}' `
          + `(${read.stderr.trim() || `zfs get exited with code ${read.exitCode}`}) - `
          + `ANAS will not change a property it cannot restore, so this image was not backed up`,
        )
      }

      const device = zvolSnapshotDevice(source.device, source.label)
      devices.set(source.volume, device)

      if (prior.value !== 'visible') {
        updateProgress(`publishing snapshot device for ${source.volume} (snapdev=visible, was ${prior.value}/${prior.source})`)
        const set = await executor.exec(ZFS, ['set', 'snapdev=visible', source.volume])
        if (set.exitCode !== 0) {
          const detail = set.stderr.trim() || `zfs set snapdev=visible exited with code ${set.exitCode}`
          throw new Error(`could not publish the snapshot device of volume '${source.volume}': ${detail}`)
        }
        toRestore.push({ volume: source.volume, prior })
      }
      else {
        updateProgress(`volume ${source.volume} already has snapdev=visible (${prior.source}) - left untouched`)
      }

      // udev owns the symlink; `settle` drains the queue, and the poll proves
      // the node is really there before pbc is pointed at it.
      await executor.exec(UDEVADM, ['settle'])
      let present = false
      for (let attempt = 0; attempt < attempts && !present; attempt++) {
        if (attempt > 0)
          await sleep(intervalMs)
        present = await exists(device)
      }
      if (!present) {
        throw new Error(
          `the snapshot device '${device}' never appeared after 'zfs set snapdev=visible ${source.volume}' `
          + `and 'udevadm settle' - the image was not backed up`,
        )
      }
      updateProgress(`archive source ${device} is ready (read-only snapshot device)`)
    }

    return await fn(devices)
  }
  finally {
    // Reverse order, and only what we changed. Never throws.
    const order = [...toRestore]
    order.reverse()
    for (const { volume, prior } of order) {
      const args = snapdevRestoreArgs(volume, prior)
      updateProgress(`restoring snapdev on ${volume} (zfs ${args.join(' ')})`)
      // No `throw` anywhere in this block, deliberately: a throw inside a
      // `finally` would REPLACE the error the wrapped work raised, and the
      // backup's own failure is always the more informative one.
      let detail: string | null = null
      try {
        const r = await executor.exec(ZFS, args)
        if (r.exitCode !== 0)
          detail = r.stderr.trim() || `zfs ${args[0]} exited with code ${r.exitCode}`
      }
      catch (err) {
        detail = err instanceof Error ? err.message : String(err)
      }
      if (detail !== null) {
        warnings.push(
          `the 'snapdev' property of volume '${volume}' could not be restored to ${prior.value} (${prior.source}): `
          + `${detail} - `
          + `run 'zfs ${args.join(' ')}' by hand; the volume's snapshot device nodes stay visible until then.`,
        )
      }
    }
  }
}
