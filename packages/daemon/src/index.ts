import type { CommandExecutor } from './executor/types.js'
import { chmodSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { createServer } from './server.js'
import { ahrBootScan } from './services/ahr-boot-scan.js'

// Default to the same socket the gateway expects (/run/anas/anasd.sock). A
// no-env manual launch must NOT land the trust-boundary socket in world-writable
// /tmp. Production sets ANASD_SOCKET via systemd; `npm run dev` sets it too.
const SOCKET_PATH = process.env.ANASD_SOCKET ?? '/run/anas/anasd.sock'
const MOCK = process.argv.includes('--mock')

async function main() {
  // Clean up stale socket from a previous crash
  if (existsSync(SOCKET_PATH)) {
    unlinkSync(SOCKET_PATH)
  }

  const server = createServer({ mock: MOCK })

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
    // The socket IS the trust boundary (Principle 9): anasd trusts the X-Anas-*
    // identity headers precisely because only local root can reach the socket.
    // Don't leave that resting on the default umask — lock it to root-only
    // (0600) explicitly. Guard to the unix-socket case (a future TCP mode has no
    // filesystem path to chmod) and never let a chmod hiccup take the daemon down.
    try {
      if (existsSync(SOCKET_PATH) && statSync(SOCKET_PATH).isSocket())
        chmodSync(SOCKET_PATH, 0o600)
    }
    catch (err) {
      server.log.warn(`could not chmod anasd socket to 0600: ${(err as Error).message}`)
    }
    server.log.info(`anasd listening on ${SOCKET_PATH}${MOCK ? ' (mock mode)' : ''}`)

    // AHR boot scan (AHR-DESIGN §5.1/§8, GT-8): recover inactive-assembled
    // arrays via the verified ladder, flip orphaned 'running' expansion
    // intents to 'halted' (operator must Resume), and re-attach observation of
    // kernel-owned reshapes. Non-blocking; failures are logged, never fatal.
    // Skipped in mock mode — there is no real md state to recover.
    if (!MOCK) {
      const executor = (server as unknown as { executor: CommandExecutor }).executor
      void ahrBootScan(executor).then((report) => {
        if (report.recovered.length || report.haltedIntents.length || report.observedReshapes.length)
          server.log.info(`ahr boot scan: recovered=[${report.recovered.join(',')}] haltedIntents=[${report.haltedIntents.join(',')}] observedReshapes=[${report.observedReshapes.join(',')}]`)
      }).catch((err) => {
        server.log.warn(`ahr boot scan failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }
  catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

main()
