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
 * is a live, exact-case passdb check (pdbedit); `locked` is a disabled
 * account; `local` distinguishes a user ANAS can manage from a
 * directory-provided one (which is read-only here — provisioned in AD/LDAP,
 * Epic 14).
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
  /**
   * Has a Samba passdb entry that really serves this account (can authenticate
   * to SMB): stored under EXACTLY this name, with the uid Samba resolves equal
   * to the account's (identity.3, #68). A case-different entry does not count.
   */
  smbEnabled: z.boolean(),
  /**
   * Present only when the passdb holds an entry Samba would use for this
   * account but stored under a different case (or unmapped) — the stored name,
   * so the panel can say what to repair; `smbEnabled` is false then. Setting
   * the SMB password again replaces the entry (identity.3). Absent = no such
   * entry, exactly as an older daemon would send it.
   */
  smbEntryMismatch: z.string().optional(),
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
  /**
   * Present only when the group is a USER-PRIVATE group (identity.1c): a user
   * with the same name has this group as its PRIMARY group (gid match). ANAS
   * creates users WITHOUT one (`useradd -N`), so a private group here belongs
   * to a pre-existing account the list merely explains — nothing is changed.
   */
  privateGroupOf: z.string().optional(),
})
export type ShareGroup = z.infer<typeof ShareGroup>

// --- Write models ---

/**
 * Name for a locally-created user or group: exactly what `useradd`/`groupadd`
 * accept on Debian (identity.1a) — a letter or underscore (upper OR lowercase)
 * start, then letters/digits/underscore/hyphen; a trailing `$` allows machine
 * accounts. Mixed case is legal (an operator may type `Alice`), so the UI
 * validator mirrors this rule verbatim.
 */
export const IdentityName = z.string()
  .min(1)
  .max(32)
  .regex(/^[A-Z_][\w-]*\$?$/i, 'must be a valid user/group name (letter or underscore, then letters, digits, _ and -; optional trailing $)')
export type IdentityName = z.infer<typeof IdentityName>

/**
 * Lenient name for a path param that resolves an EXISTING identity to read or
 * manage (NOT to create). Directory identities (LDAP/AD) surface through
 * getent in forms POSIX rules forbid — dots (`john.doe`), uppercase (`Alice`),
 * and the AD forms `DOMAIN\user` / `user@domain` — so the strict create regex
 * (`IdentityName`) would 400 a name that legitimately appears in the users
 * list, breaking the source-agnostic seam.
 *
 * Safety: these values become execFile argv to getent/usermod/gpasswd, so we
 * still reject anything that could inject an option or corrupt a passwd line —
 * a leading `-` (option injection), whitespace, control chars, NUL, `:` (the
 * passwd field delimiter), and `/`. Dots, uppercase, `@`, and backslash are
 * allowed. Mutations stay safe regardless because they re-gate on
 * isLocalUser/isLocalGroup before touching anything.
 */
export const LookupName = z.string()
  .min(1)
  .max(256)
  // First char: not `-` and not forbidden; rest: no forbidden chars. Forbidden
  // = whitespace, control (\x00-\x1f, \x7f), `:` (passwd delimiter), and `/`.
  // eslint-disable-next-line no-control-regex
  .regex(/^[^-\s:/\x00-\x1F\x7F][^\s:/\x00-\x1F\x7F]*$/, 'must be a valid identity name')
export type LookupName = z.infer<typeof LookupName>

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
