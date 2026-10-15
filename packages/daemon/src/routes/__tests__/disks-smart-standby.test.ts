import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

/**
 * GET /v1/disks/:id/smart runs smartctl with `-n standby` so a spun-down disk
 * is reported as standby, never woken to read it. The standby payload is the
 * empty shape plus `standby: true` (attributes []).
 */

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

const SDA_ID = 'ata-Samsung_SSD_870_S6PPNG0R400123'

describe('GET /v1/disks/:id/smart — standby disk is not woken', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('a standby smartctl result for -a returns data.standby === true and empty attributes', async () => {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.addFixture({
      command: '/usr/sbin/smartctl',
      args: ['-n', 'standby', '-a', '--json', '/dev/sda'],
      result: {
        stdout: JSON.stringify({
          smartctl: { messages: [{ string: 'Device is in STANDBY mode, exit(2)', severity: 'information' }] },
        }),
        stderr: '',
        exitCode: 2,
      },
    })

    const res = await server.inject({
      method: 'GET',
      url: `/v1/disks/${SDA_ID}/smart`,
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: Record<string, unknown> }
    assert.equal(data.standby, true)
    assert.deepEqual(data.attributes, [])
    assert.equal(data.supported, false)
    assert.equal(data.overallHealth, 'UNKNOWN')
  })

  it('an awake disk returns real SMART data with standby absent-or-false', async () => {
    server = createServer({ mock: true, logger: false })

    const res = await server.inject({
      method: 'GET',
      url: `/v1/disks/${SDA_ID}/smart`,
      headers: IDENTITY_HEADERS,
    })

    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: Record<string, unknown> }
    assert.notEqual(data.standby, true)
  })
})
