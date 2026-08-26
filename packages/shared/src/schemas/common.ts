import { z } from 'zod'

// --- Reusable validators ---

/**
 * True if `s` contains any ASCII control character (C0 range 0x00–0x1F, or DEL
 * 0x7F) — NUL, TAB, newline, carriage return, etc. Space (0x20) and every
 * printable character are allowed. Implemented as a char-code scan (not a
 * control-character regex) so it stays lint-clean and unambiguous.
 *
 * Security: control characters are the vehicle for config/command injection
 * across ANAS — a newline forges an extra /etc/fstab, smb.conf, or /etc/exports
 * line (or an extra systemd `ExecStart=` directive) and a NUL truncates. We
 * reject them at the schema boundary while preserving every legitimate printable
 * character (spaces in paths/comments, `.`/`:`/`-` in ZFS names, etc.).
 */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c <= 0x1F || c === 0x7F)
      return true
  }
  return false
}

/**
 * A single-line string: any printable text WITHOUT control characters (no
 * newline/CR/TAB/NUL). Used for values written verbatim into line-based config
 * files (smb.conf parameters, /etc/exports specs & options, fstab spec) where a
 * control character would break out of its field/line. Spaces and printable
 * punctuation are preserved.
 */
export const SingleLine = z
  .string()
  .refine(s => !hasControlChars(s), 'Control characters are not allowed')

/** ZFS pool name: alphanumeric, underscore, hyphen. No path separators. */
export const PoolName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z][\w-]*$/i, 'Must start with a letter and contain only alphanumeric, underscore, or hyphen')

/**
 * ZFS dataset path within a pool (e.g. "media/movies", "vm-100-disk-0",
 * "data.backup", "nfs:share"). Each `/`-separated component must begin with an
 * alphanumeric or underscore and may then contain alphanumerics plus the legal
 * ZFS name punctuation `_ - : .` — a strict superset of every legitimate ZFS
 * dataset name. None of those characters is a shell metacharacter, so a value
 * that passes is safe to pass as a single argument to `zfs`/`ssh … zfs`. The
 * leading-character rule additionally forecloses `-`-led option injection.
 */
export const DatasetPath = z
  .string()
  .min(1)
  .regex(
    /^\w[\w:.-]*(?:\/\w[\w:.-]*)*$/,
    'Invalid dataset path',
  )

/** Snapshot name */
export const SnapshotName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\w:.-]+$/, 'Invalid snapshot name')

/** SMB share name */
export const ShareName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\w-]+$/, 'Must be alphanumeric with underscores or hyphens')

/**
 * Absolute filesystem path, no traversal. Rejects control characters (newline,
 * CR, TAB, NUL, …) so a path can never break out of its line/field when written
 * into /etc/fstab, smb.conf, or /etc/exports. Spaces and printable punctuation
 * are preserved — a path like `/mnt/My Data` is legitimate (exports.ts
 * double-quotes whitespace paths).
 */
export const AbsolutePath = z
  .string()
  .startsWith('/', 'Must be an absolute path')
  .refine(p => !p.includes('..'), 'Path traversal not allowed')
  .refine(p => !hasControlChars(p), 'Control characters are not allowed')

/** Device path (must start with /dev/) */
export const DevicePath = z
  .string()
  .startsWith('/dev/', 'Must be a device path')
  .refine(p => !p.includes('..'), 'Path traversal not allowed')

/** ISO 8601 datetime string */
export const ISODateTime = z.string().datetime()

/** UUID (v4) */
export const UUID = z.string().uuid()

/** Disk by-id identifier, e.g. "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1" */
export const DiskId = z.string().min(1).regex(/^[\w.-]+$/, 'Invalid disk by-id identifier')

/**
 * WHEN a finished unattended run emits a PVE notification — vzdump's own two
 * modes, spelled ONCE for every family that has runs (backup 16.12, snapshot
 * schedules and replication 9.4). One vocabulary, one gate, one combo: the three
 * views must read identically (parallel construction), and a second enum would
 * be the same decision made twice.
 *
 * `always`     — every run that DID something notifies (success = info,
 *                completed-with-warnings = warning, failure = error).
 * `on-failure` — only the runs that went wrong notify (warning + error).
 *
 * The DEFAULT is deliberately per-family, not global — it is a judgement about
 * that family's run frequency, not about the modes:
 *   - backup defaults to `always` (vzdump parity; the cron mail it replaced sent
 *     every run's full output),
 *   - snapshot schedules and replication default to `on-failure` (a schedule can
 *     fire every 15 minutes; an `always` there would be spam nobody reads, and
 *     it keeps the pre-9.4-knob behaviour for schedules that predate the field).
 */
export const NotifyMode = z.enum(['always', 'on-failure'])
export type NotifyMode = z.infer<typeof NotifyMode>

// --- Shared formatting ---

/**
 * The canonical ANAS size formatter, shared by every operator-facing size in a
 * warning, guidance sentence, confirm dialog, or notification (AHR band math,
 * iSCSI LUN guidance, …).
 *
 * Convention: GiB below 1024 GiB, TiB at or above, at most two decimals with
 * trailing zeros dropped — "3.64 TiB pending", "2 GiB", never "3724 GiB" or
 * a noisy "2.00 GiB". Two decimals at TiB scale keeps ~10 GiB of resolution;
 * dropping trailing zeros keeps whole-disk sizes clean in operator strings.
 */
export function fmtBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3
  if (gib >= 1024)
    return `${Math.round((gib / 1024) * 100) / 100} TiB`
  return `${Math.round(gib * 100) / 100} GiB`
}
