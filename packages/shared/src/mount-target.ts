// Mount target normalisation (Epic 18 — the Mounts wizard's Server +
// Share/Export-path fields). The operator types a server and a share (CIFS)
// or export path (NFS); the write side folds them into one fstab spec
// (`//host/share`, `host:/export`). Until this existed the typed input went
// to `mount` verbatim: `//10.0.0.212` failed the DNS stage ("Could not
// resolve host '//10.0.0.212'"), a trailing-slash server plus an empty share
// built `//host/` and came back as the kernel's "CIFS: VFS: Malformed UNC in
// devname" / `mount error(22)` — which the verdict table then reported as
// "unreachable — no route to the server", blaming the network for a typo.
//
// PURE: it decides the normal form from the two typed strings alone, so the
// SAME rules run at every boundary. The daemon (buildSpec, POST /mounts,
// POST /mounts/test) imports it; the browser (packages/pve-integration/src/
// 67-mounts.js) carries a small ES5 port of it — the browser cannot import
// this package, and that port is the ONE permitted duplicate; keep both in
// lockstep. `problems` carries the guiding sentence(s) a 400 should show.

import type { MountType } from './schemas/mounts.js'

/** A normalised mount target plus the problems that block it. */
export interface MountTarget {
  /** Normalised server — a host or address, never a path. `''` when unusable. */
  server: string
  /** Normalised share (CIFS) or export path (NFS). */
  remotePath: string
  /** Guiding sentences for a 400 (e.g. an empty CIFS share). Empty when fine. */
  problems: string[]
}

/** A pasted URL scheme in front of the server (`smb://host`, `cifs://`, `nfs://`). */
const SERVER_SCHEME_RE = /^(?:smb|cifs|nfs):\/\//i
/** A leading UNC / Windows path marker (`//host`, `\\host`). */
const SERVER_LEAD_RE = /^(?:\/|\\)+/
/** A trailing path marker on a server (`host/`, `host\`). */
const SERVER_TRAIL_RE = /(?:\/|\\)+$/
/** The first path separator inside a pasted URL/UNC (`host/share`, `host\share`). */
const SERVER_SEG_RE = /\/|\\/
/** A CIFS share's separators, wherever pasted with backslashes. */
const SHARE_SEP_RE = /\\/g
/** The outer slashes on a CIFS share (an inner prefix path is kept). */
const SHARE_OUTER_RE = /^\/+|\/+$/g
/** The leading slashes on an NFS export path (exactly one is re-added). */
const PATH_LEAD_RE = /^\/+/

/**
 * Normalise the server field. Returns the host plus, for NFS, an EXPORT part
 * the server field carried (`host:/export` pasted into one field).
 *
 *  - trim; strip a leading `smb://` / `cifs://` / `nfs://` scheme; strip a
 *    leading `//` or `\\` (UNC marker, mixed separators tolerated).
 *  - CIFS: the server is the host ONLY — a pasted `//host/share` /
 *    `smb://host/share` / `\\host\share` keeps everything before the first
 *    separator, which also consumes a trailing `/` or `\` (`10.0.0.212/` →
 *    `10.0.0.212`). The share part is DROPPED, never moved into the share
 *    field (the share stays as typed).
 *  - NFS: the server ends at the colon that precedes the export path — the
 *    same boundary `parseSpec` splits on, so an unbracketed IPv6 never
 *    mis-splits (`2001:db8::1` stays whole; its colons never precede a `/`).
 *    A trailing lone `:` (`host:`) is stripped with no export part.
 *  - IPv6 brackets are kept intact either way (`[2001:db8::1]` survives).
 */
function normalizeServer(type: MountType, raw: string): { server: string, export: string } {
  let s = (raw ?? '').trim().replace(SERVER_SCHEME_RE, '').replace(SERVER_LEAD_RE, '').replace(SERVER_TRAIL_RE, '')
  if (type === 'nfs') {
    if (s.endsWith(':'))
      return { server: s.slice(0, -1), export: '' }
    const idx = s.indexOf(':/')
    if (idx !== -1)
      return { server: s.slice(0, idx), export: s.slice(idx + 1) }
    return { server: s, export: '' }
  }
  const i = s.search(SERVER_SEG_RE)
  if (i !== -1)
    s = s.slice(0, i)
  return { server: s, export: '' }
}

/**
 * Normalise the typed Server + Share/Export-path pair into the canonical form
 * the spec is built from (see the module note for the failure it prevents).
 *
 *  - CIFS `remotePath`: backslashes become `/`; the outer slashes are noise —
 *    an inner prefix path is kept (`share/sub` stays `share/sub`).
 *  - NFS `remotePath`: exactly one leading `/`; a blank field is the export
 *    root (`/`). A pasted `host:/export` fills a BLANK export field only — a
 *    typed path always wins (CIFS has no such adoption: the share stays as
 *    typed).
 *
 * `problems` (a 400's guiding sentences, in order): an empty server after
 * normalisation; an empty CIFS share (NFS is fine at the export root).
 */
export function normalizeMountTarget(
  type: MountType,
  req: { server?: string, remotePath?: string },
): MountTarget {
  const { server, export: serverExport } = normalizeServer(type, req.server ?? '')
  let remotePath = (req.remotePath ?? '').trim()
  if (type === 'cifs') {
    remotePath = remotePath.replace(SHARE_SEP_RE, '/').replace(SHARE_OUTER_RE, '')
  }
  else {
    if (!remotePath && serverExport)
      remotePath = serverExport
    remotePath = remotePath === '' ? '/' : `/${remotePath.replace(PATH_LEAD_RE, '')}`
  }
  const problems: string[] = []
  if (!server)
    problems.push('server is required')
  if (type === 'cifs' && !remotePath)
    problems.push('share name is required (the name of the share on the server, e.g. `pictures`)')
  return { server, remotePath, problems }
}
