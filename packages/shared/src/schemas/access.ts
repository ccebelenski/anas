import { z } from 'zod'

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
  /** System user/group name — required iff kind is 'user' or 'group' */
  name: z.string().optional(),
  level: AccessLevel,
  /**
   * Read-only marker (set by the daemon): the principal's uid/gid no longer
   * resolves to a name — an orphan from a user/group deleted outside ANAS (or a
   * departed directory identity). `name` is then the bare numeric id. The UI
   * surfaces it as "unknown (uid N)" so it can be recognised and removed.
   */
  unresolved: z.boolean().optional(),
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
  owner: z.string().optional(),
  group: z.string().optional(),
  entries: z.array(AccessEntry).optional(),
  /** Remove every named (user/group) ACL entry — the only way to clear them. */
  clearNamed: z.boolean().optional(),
  applyToExisting: z.boolean().optional(),
})
  .refine(
    b => b.owner !== undefined || b.group !== undefined || b.entries !== undefined || b.clearNamed === true,
    'set at least one of owner, group, entries, clearNamed',
  )
  .refine(
    b => !(b.clearNamed === true && (b.entries ?? []).some(e => e.kind === 'user' || e.kind === 'group')),
    'clearNamed cannot be combined with named user/group entries',
  )
export type SetAccessRequest = z.infer<typeof SetAccessRequest>
