import { z } from 'zod'

// --- Reusable validators ---

/**
 * True if `s` contains a control character or a Unicode line separator:
 *
 *  - C0 (0x00–0x1F) and DEL (0x7F): NUL, TAB, newline, carriage return, ...;
 *  - C1 (0x80–0x9F), which holds NEL (U+0085, a line break to Python's
 *    `splitlines`, and so to rtslib/targetcli) and no printable character;
 *  - LINE SEPARATOR (U+2028) and PARAGRAPH SEPARATOR (U+2029): line
 *    terminators to every JavaScript regex (`.` stops at them, `^`/`$` with
 *    the m flag match at them), so a value carrying one reads back from a
 *    config file as two lines in ANAS's own parsers (cr3.core).
 *
 * Space (0x20) and every other printable character are allowed, including
 * non-ASCII text and non-ASCII spaces (a Japanese comment's U+3000, a pasted
 * U+00A0): they end no line in any reader ANAS writes for. A reader that
 * SPLITS a value on whitespace (a list entry, an option token) needs its own,
 * wider rule. Implemented as a char-code scan (not a control-character regex)
 * so it stays lint-clean and unambiguous.
 *
 * Security: control characters are the vehicle for config/command injection
 * across ANAS — a newline forges an extra /etc/fstab, smb.conf, or /etc/exports
 * line (or an extra systemd `ExecStart=` directive) and a NUL truncates. We
 * reject them at the schema boundary while preserving every legitimate printable
 * character (spaces in paths/comments, `.`/`:`/`-` in ZFS names, etc.). Every
 * config writer's own gate (smb.conf, /etc/exports, rclone.conf, unit files)
 * asks this same function, so the rule is one rule.
 */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c <= 0x1F || (c >= 0x7F && c <= 0x9F) || c === 0x2028 || c === 0x2029)
      return true
  }
  return false
}

/**
 * A single-line string: any printable text WITHOUT control characters or line
 * separators ({@link hasControlChars}: no newline/CR/TAB/NUL, no C1/NEL, no
 * U+2028/U+2029). Used for values written verbatim into line-based config
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

/**
 * The sub-resource names the datasets router reads out of a dataset path
 * (`<dataset>/snapshots[/<snap>]`, `<dataset>/access`, `<dataset>/permissions`).
 * A dataset whose path has one of these as a SEGMENT reads, to the router, like
 * a sub-route of its parent (audit #12: destroying `tank/snapshots/old` once
 * destroyed `tank@old`). New names may not carry them (story ident.1); an
 * existing dataset with such a segment stays readable and addressable — the
 * router asks whether the full path names an existing dataset first.
 */
export const RESERVED_DATASET_SEGMENTS = ['snapshots', 'access', 'permissions'] as const

/** The first reserved sub-resource segment of `path` (`/`-separated), or null. */
export function reservedDatasetSegment(path: string): string | null {
  for (const seg of path.split('/')) {
    if ((RESERVED_DATASET_SEGMENTS as readonly string[]).includes(seg))
      return seg
  }
  return null
}

/** The refusal text for a reserved segment (create, clone, rename). */
export function reservedDatasetSegmentMessage(seg: string): string {
  return `'${seg}' is reserved (it names a dataset sub-resource) and cannot be a dataset name segment`
}

/**
 * A NEW dataset's path (create, clone, rename — story ident.1): a
 * {@link DatasetPath} with no segment equal to a reserved sub-resource name.
 * Reads keep {@link DatasetPath}, so an existing dataset with such a segment
 * remains addressable.
 */
export const NewDatasetPath = DatasetPath.superRefine((path, ctx) => {
  const seg = reservedDatasetSegment(path)
  if (seg)
    ctx.addIssue({ code: 'custom', message: reservedDatasetSegmentMessage(seg) })
})

// --- Recursive exclude lists ---

/** What an exclude list belongs to — names what has to be recursive about it. */
export type ExcludeOwner = 'schedule' | 'replication'

/**
 * The SHAPE rules an exclude list is held to, stated once for every schema that
 * carries one (snapx.1 (#71) put them on the recursive snapshot schedule;
 * rrep.1a moves them out of that schema's `superRefine` into here because a
 * recursive replication takes the same list over the same sweep): an exclude
 * needs a recursive target, and every entry is a STRICT descendant of the root
 * it excludes from. Returns the message for the FIRST violation, or null when
 * the list is shaped legally — each caller adds the issue at its own path, so
 * each keeps its own validation report.
 *
 * An absent or empty list is the plain recursive operation and is never an
 * issue, recursive or not (a schedule stored before the field parses back
 * without it, and an empty list means "nothing skipped"). Whether an entry
 * EXISTS on the live tree stays the route's question — a schema never reads ZFS.
 *
 * `rootDataset` is the full dataset name the list excludes from: a schedule's
 * `target.dataset`, a replication task's pool-rooted source. Pass null where the
 * boundary cannot know it — the one-off replicate request, whose source is in
 * the URL — which checks the recursive rule and leaves the child rule to the
 * route that has the name (rrep.1's run branch).
 *
 * `owner` decides only which "requires" sentence the recursive rule speaks, so
 * both callers keep their own product wording verbatim:
 * 'Exclude requires a recursive schedule' / 'Exclude requires a recursive replication'.
 */
export function excludeShapeIssue(
  rootDataset: string | null,
  recursive: boolean | undefined,
  exclude: string[] | undefined,
  owner: ExcludeOwner,
): string | null {
  if (!exclude || exclude.length === 0)
    return null
  if (recursive !== true) {
    return owner === 'schedule'
      ? 'Exclude requires a recursive schedule'
      : 'Exclude requires a recursive replication'
  }
  if (rootDataset === null)
    return null
  const prefix = `${rootDataset}/`
  for (const name of exclude) {
    if (!name.startsWith(prefix))
      return `Exclude '${name}' is not a child dataset of '${rootDataset}'`
  }
  return null
}

/** Snapshot name */
export const SnapshotName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\w:.-]+$/, 'Invalid snapshot name')

/**
 * The `anas-` prefix marks the snapshot names ANAS OWNS: the schedule
 * convention `anas-<bucket>-<utc>` (and the transient run scaffolding under
 * `anas-backup-` / `anas-cloud-`) parses from this prefix, and ZFS prune
 * additionally treats an UNSTAMPED name that parses as scheduled as the
 * legacy-owned snapshots of the one schedule covering the dataset. The
 * daemon's naming module imports this constant — one definition of the
 * prefix, schema and engine alike.
 */
export const SCHEDULED_SNAPSHOT_PREFIX = 'anas-'

/** The refusal for a manual snapshot name inside the ANAS-owned prefix. */
export function reservedSnapshotPrefixMessage(): string {
  return `'${SCHEDULED_SNAPSHOT_PREFIX}' is reserved for scheduled snapshots — choose another name`
}

/**
 * A MANUAL snapshot name (create, rename — story cr.20, audit #1's remaining
 * gap): a {@link SnapshotName} outside the {@link SCHEDULED_SNAPSHOT_PREFIX}
 * space. Matched case-sensitively on purpose (unlike the Samba section names
 * of {@link NewShareName}): ZFS and btrfs snapshot labels are case-sensitive,
 * and the retention parser that scopes pruning matches the lowercase prefix
 * exactly — `Anas-foo` is a harmless ordinary name. Reads keep
 * {@link SnapshotName}; an existing `anas-*` snapshot stays addressable.
 */
export const NewSnapshotName = SnapshotName.superRefine((name, ctx) => {
  if (name.startsWith(SCHEDULED_SNAPSHOT_PREFIX))
    ctx.addIssue({ code: 'custom', message: reservedSnapshotPrefixMessage() })
})

/** SMB share name */
export const ShareName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\w-]+$/, 'Must be alphanumeric with underscores or hyphens')

/**
 * Samba's three special section names (audit #23): `[global]` is the server
 * configuration, and `homes`/`printers` are the documented service-template
 * sections Samba interprets specially. A share ANAS wrote under one of these
 * names collides with Samba's own handling of the section (a second `[global]`
 * is merged into the first) while the parser reads `global` as the global
 * section — so ANAS could neither show nor delete what it wrote. The special
 * names and their case-insensitive matching are Samba's documented behaviour
 * (man smb.conf — from memory); our own parser already folds section names
 * the same way (`parseDoc` lowercases the key, `findSection` matches
 * case-insensitively), which is what would otherwise let `Global` slip
 * through as "a different share" than the existing `[global]`.
 */
export const RESERVED_SMB_SECTIONS = ['global', 'homes', 'printers'] as const

/** The reserved Samba section name `name` folds to, or null when it reserves nothing. */
export function reservedSmbSection(name: string): string | null {
  const lower = name.toLowerCase()
  return (RESERVED_SMB_SECTIONS as readonly string[]).find(s => s === lower) ?? null
}

/** The refusal text for a reserved section name (create door). */
export function reservedSmbSectionMessage(name: string): string {
  return `'${name}' is a reserved Samba section name and cannot be a share name`
}

/**
 * The name of a NEW SMB share (POST — story cr.20, audit #23): a
 * {@link ShareName} that is not one of Samba's special sections, refused
 * case-insensitively (Samba matches section names case-insensitively). Reads
 * keep {@link ShareName}: a hand-written `[homes]` with a path stays a
 * listable, manageable share, exactly like it was before this gate.
 */
export const NewShareName = ShareName.superRefine((name, ctx) => {
  const reserved = reservedSmbSection(name)
  if (reserved)
    ctx.addIssue({ code: 'custom', message: reservedSmbSectionMessage(name) })
})

/**
 * Absolute filesystem path, no traversal. Rejects control characters and line
 * separators ({@link hasControlChars}: newline, CR, TAB, NUL, C1/NEL,
 * U+2028/U+2029, ...) so a path can never break out of its line/field when written
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

// --- The user id on the gateway -> anasd hop (cr3.core CORE-M3) ---

/**
 * A PVE user id is UTF-8 (`用户@pve`), but an HTTP header value is latin1:
 * Node refuses to send a character above U+00FF (ERR_INVALID_CHAR), which
 * turned every request of such a user into a 502 "anasd unavailable". The
 * gateway therefore sends a user id that is not plain printable ASCII (or that
 * holds a `%`) percent-encoded as UTF-8 and says so in this header; the daemon
 * decodes it before anything reads `x-anas-user`. A plain ASCII id goes as it
 * always did, with no marker, so the systemd runners, the udev script and a
 * root socket client keep sending what they send today.
 */
export const USER_ENCODING_HEADER = 'x-anas-user-encoding'
/** The one encoding {@link USER_ENCODING_HEADER} names. */
export const USER_ENCODING_PERCENT_UTF8 = 'percent-utf8'

/** True when `userid` cannot travel as a raw header value unambiguously. */
export function userHeaderNeedsEncoding(userid: string): boolean {
  for (let i = 0; i < userid.length; i++) {
    const c = userid.charCodeAt(i)
    if (c < 0x21 || c > 0x7E || c === 0x25)
      return true
  }
  return false
}

/**
 * The `x-anas-user` value for `userid`, percent-encoded as UTF-8; undefined
 * when the string is not well-formed Unicode (a lone surrogate), which a user
 * id decoded from a signed assertion never is: the caller then sends no user,
 * which the daemon refuses (fail closed).
 */
export function encodeUserHeader(userid: string): string | undefined {
  try {
    return encodeURIComponent(userid)
  }
  catch {
    return undefined
  }
}

/** The user id an encoded `x-anas-user` carries; undefined when malformed. */
export function decodeUserHeader(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value)
    return decoded.length > 0 ? decoded : undefined
  }
  catch {
    return undefined
  }
}

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
