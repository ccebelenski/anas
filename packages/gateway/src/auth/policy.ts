import type { AuthUser, Privilege } from './types.js'
import { privilegeSatisfied, READ_JOB_ROUTES, UUID } from '@anas/shared'
import { NODE_NAME_RE } from '../node-name.js'

/**
 * The one rule (EPICS §2 "Authorization follows PVE"; docs/WAVE2-DESIGN.md A3):
 * GET and HEAD need `Sys.Audit` on `/`, every other method needs `Sys.Modify`
 * on `/`. Method-based, no route table — one exception (cr.67, operator ruling
 * 2026-10-17): a POST whose daemon-side path is on the shared
 * {@link READ_JOB_ROUTES} list — the jobs that only read — needs `Sys.Audit`
 * too. PVE answered what the user holds (AnasProxy.pm, signed); the gateway
 * decides here.
 */
export function requiredPrivilege(method: string, path = ''): Privilege {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD')
    return 'Sys.Audit'
  if (m === 'POST' && isReadJobPath(path))
    return 'Sys.Audit'
  return 'Sys.Modify'
}

/**
 * The daemon-side path of a gateway path — everything after
 * `/api/nodes/<node>/v1` — derived from the RAW request line the way the node
 * handler derives it (cr.62): the `<node>` segment as sent, validated as a
 * node name, the tail sliced verbatim. Nothing is decoded, no query is
 * considered (the caller strips it) — so a `%2F` stays `%2F` and a `..`
 * segment stays a `..` segment, matching as itself. undefined when the path
 * is not of that shape at all.
 */
function daemonSidePath(path: string): string | undefined {
  const prefix = '/api/nodes/'
  if (!path.startsWith(prefix))
    return undefined
  const end = path.indexOf('/', prefix.length)
  const node = end > prefix.length ? path.slice(prefix.length, end) : undefined
  if (node === undefined || !NODE_NAME_RE.test(node))
    return undefined
  const marker = `${prefix}${node}/v1`
  if (!path.startsWith(`${marker}/`))
    return undefined
  return path.slice(marker.length)
}

/**
 * Is this gateway path (raw, query stripped) an EXACT hit on the shared
 * read-job exception? The three read doors match as whole paths; the cancel
 * door matches its shape with the job id validated by the job-id rule
 * (`UUID` — the same `z.string().uuid()` check `Job.id` carries), never a
 * bare wildcard. Trailing slashes, percent-encodings and dot segments are
 * not the exception: they match as the raw bytes they are.
 */
function isReadJobPath(path: string): boolean {
  const daemonPath = daemonSidePath(path)
  if (daemonPath === undefined)
    return false
  if ((READ_JOB_ROUTES.exact as readonly string[]).includes(daemonPath))
    return true
  const { prefix, suffix } = READ_JOB_ROUTES.cancel
  if (!daemonPath.startsWith(prefix) || !daemonPath.endsWith(suffix))
    return false
  const id = daemonPath.slice(prefix.length, daemonPath.length - suffix.length)
  return UUID.safeParse(id).success
}

/**
 * The 403 sentence (§5 row 11): PVE's own "Permission check failed (<path>,
 * <priv>)" form — in @anas/shared since cr.28, so the daemon's job-queue
 * backstop answers with the same words.
 */
export { forbiddenMessage } from '@anas/shared'

/** The privilege `user` lacks for `method` on `path`, or undefined when it may proceed. */
export function missingPrivilege(user: AuthUser, method: string, path = ''): Privilege | undefined {
  const need = requiredPrivilege(method, path)
  return privilegeSatisfied(user.privileges, need) ? undefined : need
}
