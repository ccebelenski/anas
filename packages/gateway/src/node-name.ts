import { readlinkSync } from 'node:fs'
import os from 'node:os'

/**
 * Node identity — who this gateway thinks it is.
 *
 * This is load-bearing for routing: `/api/nodes/<node>/v1/*` is served locally
 * when `<node>` is THIS node and forwarded to a peer otherwise. `<node>` comes
 * from the PVE UI, which always uses the PVE **node name** — which is NOT
 * necessarily `os.hostname()`. On a host whose hostname is an FQDN
 * (`pve-atlas.internal.example.com`) the PVE node name is the short form
 * (`pve-atlas`), so guessing identity from the raw hostname makes a gateway fail
 * to recognise its own node and forward the request to itself (issue #5).
 *
 * PVE answers the question authoritatively: `/etc/pve/local` is a symlink to
 * `/etc/pve/nodes/<nodename>` on every node. We read it once at startup.
 */

/** Node names are hostnames: alphanumerics, dots, hyphens. */
export const NODE_NAME_RE = /^[a-z0-9.-]+$/i

/** Which tier of the resolution chain produced the node name. */
export type NodeNameSource = 'ANAS_NODE_NAME' | 'pve-local' | 'hostname'

/** PVE's per-node symlink to `/etc/pve/nodes/<nodename>`. */
export const DEFAULT_PVE_LOCAL_PATH = '/etc/pve/local'

export interface ResolvedNodeName {
  /** The node name this gateway answers to. */
  nodeName: string
  /** Which tier won — logged at startup so the operator can see it. */
  source: NodeNameSource
  /** The `/etc/pve/local` path consulted (default or ANAS_PVE_LOCAL_PATH). */
  pveLocalPath: string
}

/**
 * The hostname up to the first dot. A PVE node name is always the SHORT
 * hostname, never the FQDN.
 */
export function shortHostname(hostname: string): string {
  const short = hostname.split('.', 1)[0]
  return short.length > 0 ? short : hostname
}

/**
 * Read the PVE node name out of the `/etc/pve/local` symlink.
 *
 * The target is `nodes/<name>` (relative, as PVE writes it) or an absolute
 * `/etc/pve/nodes/<name>`; anything that is not shaped like that — plus every
 * error (path absent, not a symlink, pmxcfs not mounted, non-PVE dev box) — is
 * a miss, never a throw. Callers fall through to the next tier.
 */
export function readPveNodeName(localPath: string): string | undefined {
  let target: string
  try {
    target = readlinkSync(localPath)
  }
  catch {
    return undefined
  }

  const parts = target.split('/').filter(part => part.length > 0)
  if (parts.length < 2)
    return undefined
  const name = parts.at(-1)
  // Must live directly under a `nodes/` directory, or it isn't PVE's answer.
  if (name === undefined || parts.at(-2) !== 'nodes')
    return undefined
  if (name === '.' || name === '..' || !NODE_NAME_RE.test(name))
    return undefined
  return name
}

/**
 * Resolve this gateway's node identity, in order:
 *
 *   1. `ANAS_NODE_NAME` — explicit operator/dev override.
 *   2. `readlink /etc/pve/local` — PVE's own authoritative node name, matching
 *      exactly what the PVE UI puts in `/api2/json/nodes/<node>/...` URLs.
 *      (Path overridable with `ANAS_PVE_LOCAL_PATH` for tests.)
 *   3. The SHORT hostname — a best effort off a PVE node (dev boxes), and
 *      never the raw FQDN.
 *
 * Non-throwing: every failure falls through to the next tier.
 */
export function resolveNodeName(
  env: NodeJS.ProcessEnv = process.env,
  hostname: () => string = () => os.hostname(),
): ResolvedNodeName {
  const pveLocalPath = env.ANAS_PVE_LOCAL_PATH ?? DEFAULT_PVE_LOCAL_PATH

  const override = env.ANAS_NODE_NAME
  if (override !== undefined && override.length > 0)
    return { nodeName: override, source: 'ANAS_NODE_NAME', pveLocalPath }

  const fromPve = readPveNodeName(pveLocalPath)
  if (fromPve !== undefined)
    return { nodeName: fromPve, source: 'pve-local', pveLocalPath }

  return { nodeName: shortHostname(hostname()), source: 'hostname', pveLocalPath }
}

/** Human-readable name for the winning tier, for the startup log line. */
export function describeNodeNameSource(resolved: {
  source: NodeNameSource
  pveLocalPath: string
}): string {
  switch (resolved.source) {
    case 'ANAS_NODE_NAME':
      return 'ANAS_NODE_NAME'
    case 'pve-local':
      return resolved.pveLocalPath
    case 'hostname':
      return 'hostname'
  }
}
