import { existsSync, unlinkSync } from 'node:fs'
import { createServer } from './server.js'

const SOCKET_PATH = process.env.ANASD_SOCKET ?? '/tmp/anasd.sock'

async function main() {
  // Clean up stale socket from a previous crash
  if (existsSync(SOCKET_PATH)) {
    unlinkSync(SOCKET_PATH)
  }

  const server = createServer()

  // Clean shutdown on SIGTERM (systemd) and SIGINT (ctrl-c)
  const shutdown = async () => {
    server.log.info('Shutting down...')
    await server.close()
    // Socket file is cleaned up by Fastify on close
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  try {
    await server.listen({ path: SOCKET_PATH })
    server.log.info(`anasd listening on ${SOCKET_PATH}`)
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

main()
