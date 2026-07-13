import os from 'node:os'

/**
 * Runtime configuration, resolved from the environment.
 *
 * Every value has a sensible production default; env vars exist for the
 * dev loop and for operators who need to deviate (see docs/DESIGN.md).
 */
export interface GatewayConfig {
  /** TCP port the gateway listens on. */
  port: number
  /** This node's name — used to decide local vs. remote routing. */
  nodeName: string
  /** Path to the local anasd Unix socket. */
  anasdSocket: string
  /** Auth provider selector ('pve' | 'dev'). */
  authProvider: string | undefined
  /** Explicit TLS cert path override (else PVE cert auto-detect). */
  tlsCert: string | undefined
  /** Explicit TLS key path override (else PVE cert auto-detect). */
  tlsKey: string | undefined
  /** Cluster CA bundle used to verify the TLS hop to peer gateways. */
  clusterCa: string
}

export function loadConfig(env = process.env): GatewayConfig {
  return {
    port: env.ANAS_PORT ? Number.parseInt(env.ANAS_PORT, 10) : 3000,
    nodeName: env.ANAS_NODE_NAME ?? os.hostname(),
    anasdSocket: env.ANASD_SOCKET ?? '/run/anas/anasd.sock',
    authProvider: env.ANAS_AUTH_PROVIDER,
    tlsCert: env.ANAS_TLS_CERT,
    tlsKey: env.ANAS_TLS_KEY,
    clusterCa: env.ANAS_CLUSTER_CA ?? '/etc/pve/pve-root-ca.pem',
  }
}
