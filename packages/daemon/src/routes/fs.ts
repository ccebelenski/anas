import type { FsBrowseResult, FsEntryType } from '@anas/shared'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { AbsolutePath, forbiddenMessage, isPathWithin, privilegeSatisfied } from '@anas/shared'
import { currentRequestAuthority } from '../jobs/authority.js'
import { parseExports } from '../parsers/exports.js'
import { readZfsMountpoints } from '../parsers/pve-storage.js'
import { parseSmbConf } from '../parsers/smb-conf.js'

// GET /v1/fs/browse?path=<abs> — read-only directory listing for the UI's
// directory picker and gentle path validation (Epic 16.9). It lists, it never
// touches: no mutation, node fs only (plus the reads that name the managed
// roots, cr.62). Absolute paths only.
//
// BOUNDED FOR READERS (cr.62, review L11). The daemon lists as root, so an
// unbounded browse let any Sys.Audit login enumerate /root, /etc/pve/priv or
// /etc/anas/creds — and every file in them with `?files=1`. The rule:
//
//   - Sys.Modify (on `/`): unbounded, as before. Every picker that browses the
//     node is in a dialog that changes something (a backup or cloud-sync
//     source, a restore's new location) and may name any directory — a
//     host-configuration backup of /etc is the ordinary case — and Sys.Modify
//     is PVE's scope for changing the node (EPICS §2, the H4 ruling): a path
//     door is not closed on authorization grounds.
//   - Anyone else: only INSIDE a managed root — an SMB share path, an NFS
//     export path, or a ZFS dataset mountpoint (the same three sources the
//     ownership walk reads, services/identity-ids.ts) — directories and, with
//     `?files=1`, files. Outside them: 403 naming Sys.Modify, logged.
//   - `/` is never a root. A share or export of `/` (legal under the H4
//     ruling) and the OS root dataset of a ZFS-root PVE install
//     (rpool/ROOT/pve-1, mounted at `/`) would otherwise make the bound the
//     whole host.
//   - The bound is checked on the REAL path (symlinks resolved, the nearest
//     existing ancestor for a path that does not exist yet), so a symlink
//     inside a share cannot carry a reader to /root.
//   - An unreadable source (smb.conf, exports, `zfs list`) contributes no
//     roots and is logged: a missing fact only tightens the bound.

// Cap the child-directory listing so a pathological directory can't produce an
// unbounded response. Silent truncation is banned — over the cap sets a flag the
// UI surfaces as "list truncated".
const MAX_DIRS = 500

export interface FsRouteOptions {
  /** For `zfs list` (the dataset mountpoints); without one, no dataset roots. */
  executor?: CommandExecutor
  /** smb.conf location (default /etc/samba/smb.conf). */
  smbConfPath?: string
  /** /etc/exports location (default /etc/exports). */
  exportsPath?: string
  /** Test seam: the managed roots, replacing the three reads. */
  managedRoots?: () => Promise<string[]>
}

/** The real path of `p`, or of its nearest existing ancestor with the rest re-attached. */
async function realOrNearest(p: string): Promise<string> {
  try {
    return await realpath(p)
  }
  catch {
    const parent = dirname(p)
    if (parent === p)
      return p
    return join(await realOrNearest(parent), basename(p))
  }
}

/**
 * The managed roots (cr.62): SMB share paths, NFS export paths and ZFS dataset
 * mountpoints, normalised, never `/`. Each source that cannot be read is
 * logged and contributes nothing.
 */
async function readManagedRoots(opts: FsRouteOptions, log: FastifyBaseLogger): Promise<string[]> {
  const roots: string[] = []
  const smbConf = opts.smbConfPath ?? process.env.SMB_CONF_PATH ?? '/etc/samba/smb.conf'
  try {
    roots.push(...parseSmbConf(await readFile(smbConf, 'utf8')).shares.map(sh => sh.path))
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      log.warn(`fs.browse: ${smbConf} unreadable — no SMB share roots (${err instanceof Error ? err.message : String(err)})`)
  }
  const exportsFile = opts.exportsPath ?? '/etc/exports'
  try {
    roots.push(...parseExports(await readFile(exportsFile, 'utf8')).map(e => e.path))
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      log.warn(`fs.browse: ${exportsFile} unreadable — no NFS export roots (${err instanceof Error ? err.message : String(err)})`)
  }
  if (opts.executor) {
    const zfs = await readZfsMountpoints(opts.executor)
    if (zfs === null)
      log.warn('fs.browse: zfs list unreadable — no dataset roots')
    else
      roots.push(...zfs.map(z => z.mountpoint))
  }
  return roots
}

export async function fsRoutes(server: FastifyInstance, opts: FsRouteOptions = {}) {
  server.get<{
    Querystring: { path?: string, files?: string }
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

    // cr.62 (review L11): a reader browses only inside the managed roots.
    // `null` authority is the daemon's own work (no HTTP request), never a client.
    const authority = currentRequestAuthority()
    const mayModify = authority === null
      || (authority.privileges !== null && privilegeSatisfied(authority.privileges, 'Sys.Modify'))
    if (!mayModify) {
      const real = await realOrNearest(path)
      const listed = opts.managedRoots ? await opts.managedRoots() : await readManagedRoots(opts, request.log)
      const roots = await Promise.all(
        listed.filter(r => r.startsWith('/')).map(r => resolve(r)).filter(r => r !== '/').map(realOrNearest),
      )
      if (!roots.some(r => r !== '/' && isPathWithin(r, real))) {
        const user = authority?.user ?? 'this user'
        request.log.warn(`[authz] fs.browse refused: ${user} (no Sys.Modify) asked for ${path}${real === path ? '' : ` (${real})`}, outside every share, export and dataset mountpoint`)
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: `${forbiddenMessage(user, 'Sys.Modify')} Without it, browsing is limited to the node's shares, exports and dataset mountpoints, and ${path} is outside them.`,
          },
        })
      }
    }

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

    // Child FILES are listed only when the caller opts in (`?files=1`, story
    // backup2.5 — the picker also single-selects a file). Absent otherwise, so
    // "not requested" is never mistaken for "none there", and every pre-flag
    // caller gets byte-identical responses.
    const wantFiles = request.query.files === '1' || request.query.files === 'true'

    if (isDir) {
      try {
        const entries = await readdir(path, { withFileTypes: true })
        const names: string[] = []
        const fileNames: string[] = []
        for (const ent of entries) {
          let childIsDir = ent.isDirectory()
          let childIsFile = ent.isFile()
          // A symlink child may point at a directory — follow it (best-effort)
          // so the picker can descend into symlinked directories. Fail-open:
          // an unreadable / dangling symlink is simply skipped.
          if (!childIsDir && ent.isSymbolicLink()) {
            try {
              const cst = await stat(join(path, ent.name))
              childIsDir = cst.isDirectory()
              childIsFile = cst.isFile()
            }
            catch {
              childIsDir = false
              childIsFile = false
            }
          }
          if (childIsDir) {
            names.push(ent.name)
          }
          else if (wantFiles && childIsFile) {
            fileNames.push(ent.name)
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
        if (wantFiles) {
          fileNames.sort()
          if (fileNames.length > MAX_DIRS) {
            result.files = fileNames.slice(0, MAX_DIRS)
            result.truncated = true
          }
          else {
            result.files = fileNames
          }
        }
      }
      catch {
        // Unreadable directory (permission) — fail-open to an empty listing;
        // the path still exists and is a dir, the picker just shows no children.
        result.dirs = []
        if (wantFiles) {
          result.files = []
        }
      }
    }

    return { data: result }
  })
}
