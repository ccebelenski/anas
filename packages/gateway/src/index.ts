import { existsSync, readFileSync } from 'node:fs'
import { loadConfig } from './config.js'
import { createServer } from './server.js'

/** Candidate PVE cert pairs, in preference order (custom cert first, like pveproxy). */
const PVE_CERT_CANDIDATES = [
  { cert: '/etc/pve/local/pveproxy-ssl.pem', key: '/etc/pve/local/pveproxy-ssl.key' },
  { cert: '/etc/pve/local/pve-ssl.pem', key: '/etc/pve/local/pve-ssl.key' },
]

/**
 * Resolve TLS material.
 *
 * ANAS_TLS_CERT/KEY override everything. Otherwise auto-detect the PVE certs
 * (custom preferred over node cert). If none exist we serve plain HTTP — dev
 * only; the PVEAuthCookie is Secure, so real auth needs HTTPS.
 */
function resolveTls(
  config: ReturnType<typeof loadConfig>,
): { cert: Buffer, key: Buffer } | undefined {
  if (config.tlsCert && config.tlsKey) {
    return { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) }
  }

  for (const pair of PVE_CERT_CANDIDATES) {
    if (existsSync(pair.cert) && existsSync(pair.key)) {
      return { cert: readFileSync(pair.cert), key: readFileSync(pair.key) }
    }
  }

  return undefined
}

async function main() {
  const config = loadConfig()
  const https = resolveTls(config)

  const server = createServer({ config, https })

  if (!https) {
    server.log.warn(
      '[gateway] No TLS certs found (ANAS_TLS_CERT/KEY or PVE certs) — serving plain HTTP. '
      + 'The PVEAuthCookie is Secure, so browsers will withhold it: dev use only.',
    )
  }

  const shutdown = async () => {
    server.log.info('Shutting down...')
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  try {
    await server.listen({ port: config.port, host: '0.0.0.0' })
    server.log.info(
      `anas gateway listening on ${https ? 'https' : 'http'}://0.0.0.0:${config.port} `
      + `(node '${config.nodeName}', anasd ${config.anasdSocket})`,
    )
  }
  catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

main()
