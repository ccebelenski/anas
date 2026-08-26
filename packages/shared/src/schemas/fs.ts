import { z } from 'zod'
import { AbsolutePath } from './common.js'

// --- Filesystem browse (read-only UI support; Epic 16.9) ---
//
// One generic endpoint backing directory pickers and gentle path validation
// (backup archive paths first; Epic 17 targets and share-create later).
// Read-only, absolute paths only — it lists, it never touches.

/** The kind of thing at a browsed path. */
export const FsEntryType = z.enum(['dir', 'file', 'other', 'missing'])
export type FsEntryType = z.infer<typeof FsEntryType>

/**
 * Query params for GET /v1/fs/browse — an absolute path is required.
 *
 * `files=1` OPTS IN to listing regular files alongside the child directories
 * (story backup2.5: the picker single-selects a directory OR a file, and
 * backup2.4's image source is a file). It is opt-in on purpose: a directory
 * picker must not pay for a file listing it will not show, and every caller
 * written before this flag existed keeps the exact response it already had.
 */
export const FsBrowseQuery = z.object({
  path: AbsolutePath,
  files: z.coerce.boolean().optional(),
})
export type FsBrowseQuery = z.infer<typeof FsBrowseQuery>

/** Result of browsing a path. `dirs` is populated only when type='dir'. */
export const FsBrowseResult = z.object({
  /** The normalized path that was inspected (resolved, no trailing `..`). */
  path: z.string(),
  /** Whether something exists at the path. */
  exists: z.boolean(),
  /** What kind of thing it is (via stat — a symlink to a dir reports 'dir'). */
  type: FsEntryType,
  /** Sorted child directory names (dotdirs included). Empty unless type='dir'. */
  dirs: z.array(z.string()),
  /**
   * Sorted child FILE names. Present only when the caller asked for them
   * (`?files=1`) — absent, not `[]`, otherwise, so "not requested" never reads
   * as "none there". Additive: a picker that only chooses directories never
   * sees this key.
   */
  files: z.array(z.string()).optional(),
  /** True when the child listing was capped — the UI must say "list truncated". */
  truncated: z.boolean().optional(),
})
export type FsBrowseResult = z.infer<typeof FsBrowseResult>
