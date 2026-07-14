import { z } from 'zod'

// ============================================================================
// Filesystem access — the layered permissions editor (Epic 4.7.2).
//
// Plain-language access on a dataset mountpoint. The base three principals
// (owner / owning-group / everyone) map to POSIX mode bits; extra named
// principals map to POSIX ACL entries (acltype=posixacl). Granting a principal
// also sets a matching DEFAULT ACL (+ setgid) so files created later inherit
// the grant (decided 2026-07-14). NFSv4 ACLs are deferred to Epic 14.
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
  /** `acltype=posixacl` on this dataset — named ACL entries are in effect */
  aclEnabled: z.boolean(),
  /** Base three (always) + any named user/group entries */
  entries: z.array(AccessEntry),
  /** Raw `getfacl` text for the Advanced panel, or null when no/unsupported ACLs */
  aclText: z.string().nullable(),
})
export type DatasetAccess = z.infer<typeof DatasetAccess>

/**
 * Set access (PUT /v1/pools/:name/datasets/*path/access). `entries` is the
 * full desired set (base + named). Naming a user/group entry enables POSIX
 * ACLs on the dataset (acltype=posixacl) as a side effect, with a default ACL
 * so new files inherit. `applyToExisting` recurses over current descendants.
 */
export const SetAccessRequest = z.object({
  owner: z.string().optional(),
  group: z.string().optional(),
  entries: z.array(AccessEntry).optional(),
  applyToExisting: z.boolean().optional(),
})
  .refine(
    b => b.owner !== undefined || b.group !== undefined || b.entries !== undefined,
    'set at least one of owner, group, entries',
  )
export type SetAccessRequest = z.infer<typeof SetAccessRequest>
