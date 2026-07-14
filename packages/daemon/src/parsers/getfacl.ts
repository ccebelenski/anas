/**
 * Parser + level helpers for POSIX ACLs (Epic 4.7.2, layered access editor).
 *
 * `getfacl -pcE <path>` prints one ACL entry per line, no comment header (`-c`)
 * and no `#effective` rights comments (`-E`). We still parse defensively: if an
 * effective-rights comment IS present (tab-separated `\t#effective:r--`), it is
 * stripped and the entry's GRANTED perms are kept — the layered UI reports the
 * level a principal was granted, not what the mask currently clamps it to (the
 * mask is managed to `rwx` so the two agree anyway).
 *
 * Entry forms:
 *   user::rwx            → owner (mode bits)
 *   group::r-x           → owning group (mode bits)
 *   other::---           → everyone (mode bits)
 *   user:alice:rwx       → named user ACL entry
 *   group:staff:r-x      → named group ACL entry
 *   mask::rwx            → the ACL mask (managed; not shown as a principal)
 *   default:user::rwx    → the default (inheritance) ACL, same sub-forms
 */

import type { AccessLevel } from '@anas/shared'

/** One named (user/group) ACL entry: the principal and its granted perms. */
export interface ParsedAclEntry {
  type: 'user' | 'group'
  name: string
  perms: string
}

/** The base three + mask + named entries of one ACL (access or default). */
export interface ParsedAclSet {
  /** `user::` perms (owner). */
  owner: string
  /** `group::` perms (owning group). */
  owningGroup: string
  /** `other::` perms (everyone). */
  everyone: string
  /** `mask::` perms, if present. */
  mask?: string
  /** Named user/group entries, in file order. */
  named: ParsedAclEntry[]
}

/** A full parsed ACL: the access ACL plus the default ACL when present. */
export interface ParsedAcl extends ParsedAclSet {
  /** The default (inheritance) ACL — only present when `default:` lines exist. */
  default?: ParsedAclSet
}

function emptySet(): ParsedAclSet {
  return { owner: '', owningGroup: '', everyone: '', named: [] }
}

/**
 * Assign one `type:qualifier:perms` triple into an ACL set. Base entries have an
 * empty qualifier (`user::`, `group::`, `other::`); named entries carry a name.
 */
function assign(set: ParsedAclSet, type: string, qualifier: string, perms: string): void {
  switch (type) {
    case 'user':
      if (qualifier === '')
        set.owner = perms
      else
        set.named.push({ type: 'user', name: qualifier, perms })
      break
    case 'group':
      if (qualifier === '')
        set.owningGroup = perms
      else
        set.named.push({ type: 'group', name: qualifier, perms })
      break
    case 'other':
      set.everyone = perms
      break
    case 'mask':
      set.mask = perms
      break
    // Unknown tag → ignore (forward-compatible).
  }
}

/**
 * Parse `getfacl -pcE` (or `-pE`) output into a structured ACL. Comment/header
 * lines (`# file:` …) and blank lines are skipped; `default:`-prefixed lines
 * populate the default ACL. Perms keep only the granted field — any trailing
 * `\t#effective:` comment is dropped.
 */
export function parseGetfacl(text: string): ParsedAcl {
  const access = emptySet()
  let def: ParsedAclSet | undefined

  for (const raw of text.split('\n')) {
    // Drop any effective-rights comment (tab-separated), then trim.
    const line = raw.split('\t')[0].trim()
    if (!line || line.startsWith('#'))
      continue

    let spec = line
    let isDefault = false
    if (spec.startsWith('default:')) {
      isDefault = true
      spec = spec.slice('default:'.length)
    }

    // `type:qualifier:perms` — perms is the last colon-delimited field.
    const firstColon = spec.indexOf(':')
    const lastColon = spec.lastIndexOf(':')
    if (firstColon === -1 || lastColon === firstColon)
      continue
    const type = spec.slice(0, firstColon)
    const qualifier = spec.slice(firstColon + 1, lastColon)
    const perms = spec.slice(lastColon + 1)

    if (isDefault) {
      def ??= emptySet()
      assign(def, type, qualifier, perms)
    }
    else {
      assign(access, type, qualifier, perms)
    }
  }

  return def ? { ...access, default: def } : access
}

// ============================================================================
// Level ↔ perms helpers.
//
// Reading a level back from perms: `w` → read-write; `r` without `w` → read;
// no `r` → none. We deliberately ignore `x` on read: a directory needs execute
// (search) to be usable at all, and the granted `r-x`/`rwx` shapes carry it.
// ============================================================================

/** Granted perms string (e.g. `rwx`, `r-x`, `---`) → plain-language level. */
export function permsToLevel(perms: string): AccessLevel {
  if (perms.includes('w'))
    return 'read-write'
  if (perms.includes('r'))
    return 'read'
  return 'none'
}

/**
 * A single octal mode digit (r=4, w=2, x=1) → level. Same rule as permsToLevel:
 * write bit → read-write; read bit without write → read; else none.
 */
export function modeDigitToLevel(digit: number): AccessLevel {
  if (digit & 2)
    return 'read-write'
  if (digit & 4)
    return 'read'
  return 'none'
}

/** Level → octal mode digit: none=0, read=5 (r-x), read-write=7 (rwx). */
export function levelToOctalDigit(level: AccessLevel): number {
  switch (level) {
    case 'none': return 0
    case 'read': return 5
    case 'read-write': return 7
  }
}

/**
 * Level → a `setfacl` perms field.
 *   none        → `---`
 *   read        → `r-x` on the mountpoint dir; `r-X` when applying recursively
 *   read-write  → `rwx`
 *
 * The capital `X` grants execute only to directories (and files that already
 * have it), so a recursive grant does not sprinkle spurious execute onto plain
 * data files. On the mountpoint itself (always a directory) lowercase `x` is
 * fine. `setfacl` resolves `X` per file, so one `--set` spec is correct for the
 * whole tree. In a DEFAULT ACL, `X` resolves against the directory (→ x) and is
 * stored as `r-x`; the mask derived from a new file's create mode still clamps
 * inherited execute off data files, so inheritance stays clean either way.
 */
export function levelToAclPerms(level: AccessLevel, recursive: boolean): string {
  switch (level) {
    case 'none': return '---'
    case 'read': return recursive ? 'r-X' : 'r-x'
    case 'read-write': return 'rwx'
  }
}
