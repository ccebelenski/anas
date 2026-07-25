import os from 'node:os'

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
  /** This node's name — used to decide local vs. remote routing. */
  nodeName: string
  /** Path to the local anasd Unix socket. */
  anasdSocket: string
  /** Auth provider selector ('pve' | 'dev'). */
  authProvider: string | undefined
  /** Cluster CA bundle used to verify the TLS hop to peer gateways. */
  clusterCa: string
}

export function loadConfig(env = process.env): GatewayConfig {
  return {
    host: env.ANAS_HOST ?? '127.0.0.1',
    port: env.ANAS_PORT ? Number.parseInt(env.ANAS_PORT, 10) : 3000,
    pvePort: env.ANAS_PVE_PORT ? Number.parseInt(env.ANAS_PVE_PORT, 10) : 8006,
    nodeName: env.ANAS_NODE_NAME ?? os.hostname(),
    anasdSocket: env.ANASD_SOCKET ?? '/run/anas/anasd.sock',
    authProvider: env.ANAS_AUTH_PROVIDER,
    clusterCa: env.ANAS_CLUSTER_CA ?? '/etc/pve/pve-root-ca.pem',
  }
}
