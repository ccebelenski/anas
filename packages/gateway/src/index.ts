import { loadConfig } from './config.js'
import { createServer } from './server.js'

/**
 * The gateway is an internal loopback service: pveproxy terminates TLS at
 * `:8006` and forwards `/anas/*` to `127.0.0.1:3000` over plain HTTP. There is
 * no public origin and no TLS here — the cert lives on PVE's front door.
 */
async function main() {
  const config = loadConfig()

  const server = createServer({ config })

  const shutdown = async () => {
    server.log.info('Shutting down...')
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  try {
    await server.listen({ port: config.port, host: config.host })
    server.log.info(
      `anas gateway listening on http://${config.host}:${config.port} `
      + `(node '${config.nodeName}', anasd ${config.anasdSocket})`,
    )
  }
  catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

main()
