/**
 * Single source of truth for the stunt-node test target address.
 *
 * The address lived hardcoded in ~13 spots across the test tree even though
 * `test/stunt-node/config.sh` already defines `VM_IP`. Everything now derives
 * from here; NO other test file should contain the literal. Override at runtime
 * with `ANAS_STUNT_HOST` (keep it in sync with config.sh's VM_IP).
 */
const HOST = process.env.ANAS_STUNT_HOST ?? '192.168.200.50'

/** Bare host/IP of the stunt node (for SSH, cookie domains, etc.). */
export const STUNT_HOST = HOST

/** The stunt node's PVE node name (used in /api/nodes/<node>/… paths). */
export const NODE_NAME = process.env.ANAS_STUNT_NODE ?? 'anas-pve'

/** Proxmox VE web UI / API — the PVEAuthCookie origin. */
export const PVE_URL = `https://${HOST}:8006`

/**
 * The ANAS gateway, reached through pveproxy (story 12.2). The gateway binds
 * the loopback interface plain HTTP — `:3000` is not reachable from outside the
 * node — so every external address is the PVE origin's `/anas` forward, which
 * the AnasProxy hook strips and proxies to the loopback listener. Same origin
 * as the PVE UI, same PVEAuthCookie (the auth the pvepool spec uses).
 */
export const GATEWAY_URL = `${PVE_URL}/anas`
