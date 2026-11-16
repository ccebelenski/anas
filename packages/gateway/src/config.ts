import type { NodeNameSource } from './node-name.js'
import { resolveNodeName } from './node-name.js'

/**
 * Runtime configuration, resolved from the environment.
 *
 * Every value has a sensible production default; env vars exist for the
 * dev loop and for operators who need to deviate (see docs/DESIGN.md).
 */
export interface GatewayConfig {
  /** Loopback host the gateway binds to. Default 127.0.0.1 (pveproxy forwards here). */
  host: string
  /** TCP port the gateway listens on (loopback, plain HTTP). */
  port: number
  /**
   * PVE UI port on peer nodes — the cross-node forward target. pveproxy on the
   * peer terminates TLS at `:8006` and routes `/anas/*` to that node's gateway.
   */
  pvePort: number
  /**
   * This node's PVE name — used to decide local vs. remote routing. Resolved
   * once at startup from PVE itself (see node-name.ts), NOT guessed from
   * `os.hostname()`: an FQDN hostname made a gateway fail to recognise its own
   * node and forward requests to itself (issue #5).
   */
  nodeName: string
  /** Which tier of the resolution chain produced `nodeName` (startup log). */
  nodeNameSource?: NodeNameSource
  /** The `/etc/pve/local` path consulted while resolving `nodeName`. */
  pveLocalPath?: string
  /** Path to the local anasd Unix socket. */
  anasdSocket: string
  /** Auth provider selector ('pve' | 'dev'). */
  authProvider: string | undefined
  /** Cluster CA bundle used to verify the TLS hop to peer gateways. */
  clusterCa: string
  /**
   * PVE cluster membership file — maps node name → IP. PVE peers are NOT
   * DNS-resolvable; PVE routes by the cluster's known addresses, so cross-node
   * forwarding resolves the peer's IP here rather than trusting DNS.
   */
  membersPath: string
  /**
   * pmxcfs's per-node directory (`/etc/pve/nodes`). A peer that serves the
   * custom certificate held there for it (`<node>/pveproxy-ssl.pem`, ACME or
   * uploaded) is trusted for the forward as well as a cluster-CA chain
   * (CORE-M1). Optional: absent means the default.
   */
  pveNodesDir?: string
  /**
   * Test overrides for the timeout ladder (cr.35, proxy.ts). Production always
   * runs at the proxy's defaults — 20 s to the local anasd socket, 5 s to
   * connect to a peer and 25 s for its answer; the overrides exist so each
   * timeout PATH is testable without the real wait.
   */
  socketTimeoutMs?: number
  forwardConnectTimeoutMs?: number
  forwardResponseTimeoutMs?: number
}

/** The one shape a port variable may take: digits, whole (`\d` is ASCII-only). */
const PORT_PATTERN = /^\d+$/

/**
 * Read a port from the environment (cr4). Only a plain port number is a port:
 * `Number.parseInt` read `3000abc` as 3000 (the trailing junk silently
 * ignored) and `abc` as NaN, so one mis-typed line in /etc/default/anas could
 * bind a port nobody chose, or none at all. Anything that is not digits in
 * 1..65535 throws here — before the first bind — naming the variable, the
 * value found and the file to fix. An unset or empty variable keeps the
 * default, exactly as before.
 */
function portFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  const port = PORT_PATTERN.test(raw) ? Number(raw) : Number.NaN
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid ${name}='${raw}'. ${name} must be a port number: digits only, from 1 to 65535. `
      + `Set ${name} in /etc/default/anas to a number such as ${fallback}, or remove the line to use ${fallback}.`,
    )
  }
  return port
}

export function loadConfig(
  env = process.env,
  hostname?: () => string,
): GatewayConfig {
  const node = resolveNodeName(env, hostname)
  return {
    host: env.ANAS_HOST ?? '127.0.0.1',
    port: portFromEnv(env, 'ANAS_PORT', 3000),
    pvePort: portFromEnv(env, 'ANAS_PVE_PORT', 8006),
    nodeName: node.nodeName,
    nodeNameSource: node.source,
    pveLocalPath: node.pveLocalPath,
    anasdSocket: env.ANASD_SOCKET ?? '/run/anas/anasd.sock',
    authProvider: env.ANAS_AUTH_PROVIDER,
    clusterCa: env.ANAS_CLUSTER_CA ?? '/etc/pve/pve-root-ca.pem',
    membersPath: env.ANAS_MEMBERS_PATH ?? '/etc/pve/.members',
    pveNodesDir: env.ANAS_PVE_NODES_DIR ?? '/etc/pve/nodes',
  }
}
