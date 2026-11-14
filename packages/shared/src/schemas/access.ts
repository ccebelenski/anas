import { z } from 'zod'
import { LookupName } from './identity.js'

// ============================================================================
// Filesystem access — the layered permissions editor (Epic 4.7.2).
//
// Plain-language access on a dataset mountpoint. The base three principals
// (owner / owning-group / everyone) map to POSIX mode bits; extra named
// principals map to POSIX ACL entries (acltype=posixacl). Granting a principal
// also sets a matching DEFAULT ACL (+ setgid) so files created later inherit
// the grant. NFSv4 ACLs are deferred to Epic 14.
// ============================================================================

/** Plain-language access level. POSIX max for a principal is rwx (read-write). */
export const AccessLevel = z.enum(['none', 'read', 'read-write'])
export type AccessLevel = z.infer<typeof AccessLevel>

/**
 * One principal's grant.
 *   base:  kind = 'owner' | 'owning-group' | 'everyone'  (mode bits / ACL base)
 *   named: kind = 'user' | 'group' with `name`           (ACL entries)
 */
export const AccessEntry = z.object({
  kind: z.enum(['owner', 'owning-group', 'everyone', 'user', 'group']),
  /**
   * System user/group name — required iff kind is 'user' or 'group'.
   * cr.53 (L16): `LookupName`, the identity module's argv-safe name rule —
   * it rejects a leading `-` (option injection), whitespace, control
   * characters, `/`, and `:` (the ACL spec's field delimiter: a name
   * carrying one could otherwise smuggle extra entries into the
   * declarative `setfacl` spec), while still accepting every form the
   * editor reads back from a live ACL — directory identities (`DOMAIN\\user`,
   * `user@domain`, `john.doe`) and the bare numeric id of an orphaned
   * entry. The strict create rule (`IdentityName`) is wrong here: this
   * editor manages EXISTING identities, and a name it cannot express
   * would lock a tree out of its own permissions dialog.
   */
  name: LookupName.optional(),
  level: AccessLevel,
  /**
   * Read-only marker (set by the daemon): the principal's uid/gid no longer
   * resolves to a name — an orphan from a user/group deleted outside ANAS (or a
   * departed directory identity). `name` is then the bare numeric id. The UI
   * surfaces it as "unknown (uid N)" so it can be recognised and removed.
   */
  unresolved: z.boolean().optional(),
  /**
   * cr3.shares (second review): the entry's live permission bits as the
   * directory reads them (`rwx`, `r-x`, `-w-`, `r--` ... — for a group-class
   * entry, what the mask lets it do). Set by the daemon on a read; when they
   * are not exactly the level's own bits (none `---`, read `r-x`,
   * read-write `rwx`) the row is CUSTOM and the panel shows the bits. In a
   * request (third review D3) the panel echoes them for a named row whose
   * level the operator did not change: bits equal to the live ones keep the
   * row exactly as it is; a row sent without them, or at a level other than
   * the one read, is restated at its level. Absent from an older daemon.
   */
  perms: z.string().regex(/^[r-][w-][x-]$/).optional(),
})
  .refine(
    e => (e.kind === 'user' || e.kind === 'group') ? !!e.name : e.name === undefined,
    'name is required for user/group entries and forbidden for base entries',
  )
export type AccessEntry = z.infer<typeof AccessEntry>

/**
 * The access state of a dataset mountpoint (GET
 * /v1/pools/:name/datasets/*path/access).
 */
export const DatasetAccess = z.object({
  owner: z.string(),
  group: z.string(),
  /** `setfacl`/`getfacl` present on the host — named entries are possible */
  aclSupported: z.boolean(),
  /**
   * `acltype=posixacl` on this dataset AND the ACL was readable — named ACL
   * entries below are the real thing. False when ACLs are off, and also when
   * they are on but `getfacl` failed (see `aclDegraded`): the entries are then
   * a mode-bit approximation, and claiming healthy ACLs would be a lie the
   * client acts on (#37).
   */
  aclEnabled: z.boolean(),
  /**
   * `acltype` says POSIX ACLs are on, but `getfacl` could not be read — the
   * entries are derived from the mode bits and any named grants are NOT shown.
   * The client must not present this as the truth or offer a destructive edit.
   */
  aclDegraded: z.boolean().optional(),
  /** Base three (always) + any named user/group entries */
  entries: z.array(AccessEntry),
  /** Raw `getfacl` text for the Advanced panel, or null when no/unsupported ACLs */
  aclText: z.string().nullable(),
  /**
   * cr3.shares (second review, coordinator ruling): the revision of what this
   * read saw — the same hash the route-to-job binding computes. Sent back as
   * `expectedRevision`, it refuses an Apply made from a stale read (409
   * STATE_CHANGED, "reload"). Absent from an older daemon.
   */
  revision: z.string().optional(),
  /**
   * Which filesystem family the directory sits on (access.1/access.2) — the
   * one input the shared Permissions dialog needs to state where the targets
   * differ: `zfs` has the `acltype` switch and a recursive apply walks into
   * child datasets; `ahr` (btrfs) has POSIX ACLs natively and a recursive
   * apply sweeps the subvolumes under `@data` as one tree; `other` is any
   * other Linux filesystem a share path may sit on. Additive and optional: the
   * datasets route leaves it out (its payload is unchanged), and a client
   * reads absence as `zfs`.
   */
  backing: z.enum(['zfs', 'ahr', 'other']).optional(),
})
export type DatasetAccess = z.infer<typeof DatasetAccess>

/**
 * The recursive permission walk's report (cr3.shares, fourth review): the
 * counts anas-acl-walk answers, carried on an `fs.setAccess` job's result as
 * `walk` (and the share grant's). `notes` is a bounded list (50) of what was
 * left out, each with the path under its root and the inode.
 */
export const AccessWalkNote = z.object({
  kind: z.enum(['swapped', 'boundary', 'tooDeep', 'error', 'notEntered', 'changing', 'overrun', 'vanished']),
  name: z.string(),
  ino: z.number().optional(),
  op: z.string().optional(),
  message: z.string().optional(),
})
export type AccessWalkNote = z.infer<typeof AccessWalkNote>

/**
 * A filesystem boundary the walk met and did not enter (fifth review D6):
 * its path as seen (bounded), where it was met (the directory's inode and the
 * entry's name), device, inode and mount id — the daemon matches the mount
 * id and the place against what the confirmation named (a mount id is reused
 * once its mount is gone).
 */
export const AccessWalkBoundary = z.object({
  name: z.string(),
  /** The entry's own name in the directory it was met in. */
  leaf: z.string(),
  /** The inode of that directory. */
  parent: z.number(),
  dev: z.number(),
  ino: z.number(),
  mnt: z.number().nullable(),
})
export type AccessWalkBoundary = z.infer<typeof AccessWalkBoundary>

export const AccessWalkReport = z.object({
  /** Present (true) when the walk completed. */
  done: z.boolean().optional(),
  /** Why the helper refused before changing anything. */
  refused: z.string().optional(),
  /** Why the walk stopped part-way. */
  aborted: z.string().optional(),
  visited: z.object({ files: z.number(), dirs: z.number() }).default({ files: 0, dirs: 0 }),
  /** Per step: how many entries the tool changed (operands it did not refuse). */
  changed: z.record(z.string(), z.number()).default({}),
  /** Per step: how many entries it failed on (fifth review D3: each one counted). */
  failed: z.record(z.string(), z.number()).default({}),
  skipped: z.object({ links: z.number(), other: z.number() }).default({ links: 0, other: 0 }),
  /** Entries that changed between their listing and their opening: never touched. */
  swapped: z.number().default(0),
  /**
   * Entries whose name was gone when the walk looked at or opened it (sixth
   * review): deleted, or moved where the walk may not have met them again —
   * the walk cannot tell which. Any makes the job INCOMPLETE.
   */
  vanished: z.number().default(0),
  /** Entries whose open found them gone and that were met again under another name in the same folder, and acted on there. */
  returned: z.number().default(0),
  /** Entries on another mount or device that is not a root of the walk: never entered or touched. */
  boundary: z.number().default(0),
  /** Those boundaries, with their identity (bounded; the rest counted in `boundariesDropped`). */
  boundaries: z.array(AccessWalkBoundary).default([]),
  boundariesDropped: z.number().default(0),
  /** Directories that are roots of their own (a child dataset, a nested subvolume). */
  nestedRoots: z.number().default(0),
  /** `.zfs` control directories skipped at a ZFS root. */
  zfsControl: z.number().default(0),
  /** Directories acted on but not entered (deeper than the walk's descriptor budget). */
  tooDeep: z.number().default(0),
  /** Directories acted on but not entered (the reopen failed). */
  notEntered: z.number().default(0),
  /** Directories that changed while they were walked (fifth review (a)). */
  changing: z.number().default(0),
  /** Directories whose reads were stopped at their bound (fifth review (b)). */
  overrun: z.number().default(0),
  errors: z.number().default(0),
  maxDepth: z.number().optional(),
  notes: z.array(AccessWalkNote).default([]),
  notesDropped: z.number().default(0),
  /** The helper checked that its counts add up (fifth review D3). */
  accounted: z.boolean().default(false),
  accountingError: z.string().optional(),
})
export type AccessWalkReport = z.infer<typeof AccessWalkReport>

/**
 * What the share-path grant did (access.1) — the `grant` field of an SMB
 * share create/update job's result, present only when the request asked for
 * it. The share is created or updated whatever this says:
 *   applied — the entries below were written (`skipped` names principals
 *             that did not resolve and were left out);
 *   refused — a gate said no (PVE territory, an unreadable ACL); `message`
 *             is the gate's own sentence;
 *   failed  — a command failed mid-way; `message` is its error;
 *   nothing — no principal and no guest access, or nothing that grants
 *             access changed on an edit.
 */
export const ShareAccessGrantResult = z.object({
  status: z.enum(['applied', 'refused', 'failed', 'nothing']),
  message: z.string().optional(),
  /** The path the grant targeted. */
  path: z.string(),
  /**
   * The rows granted (named principals and/or everyone), each at the level it
   * ends with: the share's level, or the higher one a principal already had
   * (a grant never lowers).
   */
  granted: z.array(AccessEntry),
  /** `valid users` entries that were not granted (unresolvable names, `%` macros). */
  skipped: z.array(z.string()),
  applyToExisting: z.boolean(),
  /**
   * A recursive grant on a ZFS path (ruling 2026-10-11): the child datasets
   * mounted under the path whose POSIX ACLs were switched on before the walk.
   * Present when the walk was checked for them (empty = none needed it).
   */
  childAclEnabled: z.array(z.string()).optional(),
  /** Present when the share has guest access and a valid-users list: Samba admits no guest on such a share, so Everyone was not granted. */
  guestNote: z.string().optional(),
  /**
   * cr3.shares (fourth review): an applied recursive grant whose walk had to
   * leave something out (a swapped entry, an error, a filesystem nobody
   * named); `message` says what.
   */
  incomplete: z.boolean().optional(),
})
export type ShareAccessGrantResult = z.infer<typeof ShareAccessGrantResult>

/**
 * Set access (PUT /v1/pools/:name/datasets/*path/access, and since access.1/
 * access.2 PUT /v1/ahr/:name/access and the share routes' …/access). `entries` is the
 * desired set of the principals it mentions. Naming a user/group entry enables
 * POSIX ACLs on the dataset (acltype=posixacl) as a side effect, with a default
 * ACL so new files inherit. `applyToExisting` recurses over current descendants.
 *
 * DESTRUCTION IS EXPLICIT (#37): an `entries` list carrying no named user/group
 * row means "I am not changing the named grants", NEVER "delete them all". The
 * daemon strips named ACL entries only for `clearNamed: true`. A list that is
 * empty because a client failed to pre-fill itself is indistinguishable from a
 * deliberate one, so absence can never be read as intent — this is the contract
 * for any list-valued field whose emptiness would destroy data.
 */
export const SetAccessRequest = z.object({
  /**
   * New owner/group (cr.53 L16): `LookupName` — the editor resolves an
   * EXISTING identity, and this value rides into `chown`'s operand list
   * (a bare uid/gid number is legal there, and LookupName allows it). The
   * probe this closes: `{ owner: '--reference=/etc/shadow' }` was one PUT
   * away from a reference chown.
   */
  owner: LookupName.optional(),
  /** New owning group — the same rule as `owner`. */
  group: LookupName.optional(),
  entries: z.array(AccessEntry).optional(),
  /** Remove every named (user/group) ACL entry — the only way to clear them. */
  clearNamed: z.boolean().optional(),
  applyToExisting: z.boolean().optional(),
  /**
   * cr3.shares (second review, coordinator ruling): the `revision` of the
   * GET this edit was made from. When present and the directory no longer
   * reads the same, the PUT is refused 409 STATE_CHANGED (another edit
   * happened in between — reload). Absent = today's behaviour.
   */
  expectedRevision: z.string().max(128).optional(),
})
  .refine(
    b => b.owner !== undefined || b.group !== undefined || b.entries !== undefined || b.clearNamed === true,
    'set at least one of owner, group, entries, clearNamed',
  )
  .refine(
    b => !(b.clearNamed === true && (b.entries ?? []).some(e => e.kind === 'user' || e.kind === 'group')),
    'clearNamed cannot be combined with named user/group entries',
  )
  // cr3.shares (second review): one principal, one row — a body naming the
  // same user (or group) twice is refused, never resolved by "last wins".
  .refine(
    (b) => {
      const named = (b.entries ?? []).filter(e => e.kind === 'user' || e.kind === 'group').map(e => `${e.kind}:${e.name}`)
      return new Set(named).size === named.length
    },
    'a principal may appear only once in entries',
  )
  // Third review N4: one row per base principal too (two `everyone` rows).
  .refine(
    (b) => {
      const base = (b.entries ?? []).filter(e => e.kind === 'owner' || e.kind === 'owning-group' || e.kind === 'everyone').map(e => e.kind)
      return new Set(base).size === base.length
    },
    'owner, owning group and everyone may each appear only once in entries',
  )
export type SetAccessRequest = z.infer<typeof SetAccessRequest>
