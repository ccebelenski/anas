import { PROXY_KEY_PATH, removeProxyKey, writeProxyKey } from './auth/proxy-key.js'
import { loadConfig } from './config.js'
import { DEFAULT_PVE_LOCAL_PATH, describeNodeNameSource } from './node-name.js'
import { createServer } from './server.js'

/**
 * The gateway is an internal loopback service: pveproxy terminates TLS at
 * `:8006` and forwards `/anas/*` to `127.0.0.1:3000` over plain HTTP. There is
 * no public origin and no TLS here — the cert lives on PVE's front door.
 */
async function main() {
  const config = loadConfig()

  // cr.27: the hand-off key pveproxy signs X-Anas-Auth with (auth/proxy-key.ts).
  // Written before the gateway listens, rotated by every start. Without it
  // pveproxy can vouch for nobody, so a failure to write it stops the start
  // (systemd shows the line); the dev loop has no pveproxy and needs none.
  let proxyKey: Buffer | undefined
  if (config.authProvider !== 'dev') {
    try {
      proxyKey = writeProxyKey(PROXY_KEY_PATH)
    }
    catch (err) {
      console.error(`[authz] ${(err as Error).message}`)
      process.exit(1)
    }
  }

  const server = createServer({ config, ...(proxyKey ? { proxyKey } : {}) })

  const shutdown = async () => {
    server.log.info('Shutting down...')
    // With the key gone pveproxy answers 502 "ANAS gateway not ready" rather
    // than sign for a gateway that is no longer there.
    if (proxyKey)
      removeProxyKey(PROXY_KEY_PATH, proxyKey)
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  try {
    await server.listen({ port: config.port, host: config.host })
    // Name the identity SOURCE: node identity decides local-vs-peer routing, so
    // when it is wrong (issue #5) the operator must be able to see where it came
    // from without guessing.
    const nodeSource = describeNodeNameSource({
      source: config.nodeNameSource ?? 'hostname',
      pveLocalPath: config.pveLocalPath ?? DEFAULT_PVE_LOCAL_PATH,
    })
    server.log.info(
      `anas gateway listening on http://${config.host}:${config.port} `
      + `(node '${config.nodeName}' (from ${nodeSource}), anasd ${config.anasdSocket})`,
    )
  }
  catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

main()
