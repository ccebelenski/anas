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

/** Query params for GET /v1/fs/browse — an absolute path is required. */
export const FsBrowseQuery = z.object({
  path: AbsolutePath,
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
  /** True when the child listing was capped — the UI must say "list truncated". */
  truncated: z.boolean().optional(),
})
export type FsBrowseResult = z.infer<typeof FsBrowseResult>
