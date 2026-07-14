import { z } from 'zod'

// ============================================================================
// Identity — system users & groups for SHARE ACCESS ONLY (Epic 8).
//
// Two hard rules encoded here (see docs/DESIGN.md and EPICS Epic 8/14):
//   1. Source-agnostic — every identity is resolved via getent/nsswitch, so
//      local, LDAP, and AD users all surface the same way. `local` marks the
//      ones ANAS can manage (present in the local files DB) vs directory users
//      it only consumes.
//   2. Share, not login — a user ANAS creates has NO login shell and NO Unix
//      password; it exists to own files (uid/gid → NFS) and optionally hold an
//      SMB password (Samba passdb). It cannot log into the box or PVE.
// ============================================================================

// --- Lean picker identities (high-frequency reads: owner/group/valid-users) ---

/** A pickable system user (getent passwd, filtered to real accounts). */
export const SystemUser = z.object({
  name: z.string(),
  uid: z.number().int().nonnegative(),
})
export type SystemUser = z.infer<typeof SystemUser>

/** A pickable system group (getent group). */
export const SystemGroup = z.object({
  name: z.string(),
  gid: z.number().int().nonnegative(),
})
export type SystemGroup = z.infer<typeof SystemGroup>

// --- Enriched management models (the Share Users panel) ---

/**
 * A share user with the extra facts the management panel needs. `smbEnabled`
 * is a live passdb check (pdbedit); `locked` is a disabled account; `local`
 * distinguishes a user ANAS can manage from a directory-provided one (which is
 * read-only here — provisioned in AD/LDAP, Epic 14).
 */
export const ShareUser = z.object({
  name: z.string(),
  uid: z.number().int().nonnegative(),
  /** GECOS/full name, or null */
  fullName: z.string().nullable(),
  /** Primary group name, or null if unresolved */
  primaryGroup: z.string().nullable(),
  /** All groups the user belongs to (primary + supplementary) */
  groups: z.array(z.string()),
  /** Has a Samba passdb entry (can authenticate to SMB) */
  smbEnabled: z.boolean(),
  /** Account disabled (login + SMB revoked) without deletion */
  locked: z.boolean(),
  /** Resolvable from the local files DB → ANAS can manage it (vs directory) */
  local: z.boolean(),
})
export type ShareUser = z.infer<typeof ShareUser>

/** A group with its members and whether ANAS can manage it. */
export const ShareGroup = z.object({
  name: z.string(),
  gid: z.number().int().nonnegative(),
  members: z.array(z.string()),
  local: z.boolean(),
})
export type ShareGroup = z.infer<typeof ShareGroup>

// --- Write models ---

/**
 * POSIX-ish name for a locally-created user or group. Lowercase start, then
 * lowercase/digits/underscore/hyphen; a trailing `$` allows machine accounts.
 */
export const IdentityName = z.string()
  .min(1)
  .max(32)
  .regex(/^[a-z_][a-z0-9_-]*\$?$/, 'must be a valid POSIX user/group name')
export type IdentityName = z.infer<typeof IdentityName>

/**
 * Create a local share user (POST /v1/identity/users). Made with no login
 * shell and no Unix password; if `smbPassword` is given, an SMB passdb entry is
 * created so they can authenticate to SMB shares.
 */
export const CreateShareUserRequest = z.object({
  name: IdentityName,
  fullName: z.string().optional(),
  /** Supplementary groups to add the user to */
  groups: z.array(z.string()).optional(),
  /** If set, also create the SMB passdb entry with this password */
  smbPassword: z.string().min(1).optional(),
})
export type CreateShareUserRequest = z.infer<typeof CreateShareUserRequest>

/** Set (or replace) a user's SMB password (POST /v1/identity/users/:name/smb-password). */
export const SetSmbPasswordRequest = z.object({
  password: z.string().min(1),
})
export type SetSmbPasswordRequest = z.infer<typeof SetSmbPasswordRequest>

/** Enable or disable a user without deleting it (PUT /v1/identity/users/:name). */
export const SetUserEnabledRequest = z.object({
  enabled: z.boolean(),
})
export type SetUserEnabledRequest = z.infer<typeof SetUserEnabledRequest>

/** Create a local group (POST /v1/identity/groups). */
export const CreateGroupRequest = z.object({
  name: IdentityName,
})
export type CreateGroupRequest = z.infer<typeof CreateGroupRequest>

/** Add/remove group members (PUT /v1/identity/groups/:name/members). */
export const UpdateGroupMembersRequest = z.object({
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
})
  .refine(
    b => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0,
    'add or remove at least one member',
  )
export type UpdateGroupMembersRequest = z.infer<typeof UpdateGroupMembersRequest>
