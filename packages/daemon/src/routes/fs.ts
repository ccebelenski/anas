import type { FsBrowseResult, FsEntryType } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AbsolutePath } from '@anas/shared'

// GET /v1/fs/browse?path=<abs> — read-only directory listing for the UI's
// directory picker and gentle path validation (Epic 16.9). It lists, it never
// touches: no mutation, no execFile, node fs only. Absolute paths only.

// Cap the child-directory listing so a pathological directory can't produce an
// unbounded response. Silent truncation is banned — over the cap sets a flag the
// UI surfaces as "list truncated".
const MAX_DIRS = 500

export async function fsRoutes(server: FastifyInstance) {
  server.get<{
    Querystring: { path?: string }
  }>('/fs/browse', async (request, reply) => {
    const parsed = AbsolutePath.safeParse(request.query.path)
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: `Invalid path: ${parsed.error.issues[0]?.message ?? 'an absolute path is required'}`,
        },
      })
    }

    // Normalize (resolve `.`/trailing slashes; AbsolutePath already forbids
    // `..`). We operate on — and return — the normalized path, so no traversal
    // games survive: the caller sees exactly what was inspected.
    const path = resolve(parsed.data)

    // stat (not lstat) so a symlink to a directory reports 'dir' and lists.
    let type: FsEntryType
    let isDir = false
    try {
      const st = await stat(path)
      if (st.isDirectory()) {
        type = 'dir'
        isDir = true
      }
      else if (st.isFile()) {
        type = 'file'
      }
      else {
        type = 'other'
      }
    }
    catch {
      // ENOENT (and any stat failure — a dangling symlink, permission) reads as
      // "nothing usable here". exists=false, no listing.
      const result: FsBrowseResult = { path, exists: false, type: 'missing', dirs: [] }
      return { data: result }
    }

    const result: FsBrowseResult = { path, exists: true, type, dirs: [] }

    if (isDir) {
      try {
        const entries = await readdir(path, { withFileTypes: true })
        const names: string[] = []
        for (const ent of entries) {
          let childIsDir = ent.isDirectory()
          // A symlink child may point at a directory — follow it (best-effort)
          // so the picker can descend into symlinked directories. Fail-open:
          // an unreadable / dangling symlink is simply skipped.
          if (!childIsDir && ent.isSymbolicLink()) {
            try {
              const cst = await stat(join(path, ent.name))
              childIsDir = cst.isDirectory()
            }
            catch {
              childIsDir = false
            }
          }
          if (childIsDir) {
            names.push(ent.name)
          }
        }
        names.sort()
        if (names.length > MAX_DIRS) {
          result.dirs = names.slice(0, MAX_DIRS)
          result.truncated = true
        }
        else {
          result.dirs = names
        }
      }
      catch {
        // Unreadable directory (permission) — fail-open to an empty listing;
        // the path still exists and is a dir, the picker just shows no children.
        result.dirs = []
      }
    }

    return { data: result }
  })
}
