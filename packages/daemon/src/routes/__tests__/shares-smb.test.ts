import type { Job, JobAccepted, SmbGlobalConfig, SmbShare, SmbShareDetail } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

const SAMPLE_CONF = [
  '# test smb.conf',
  '',
  '[global]',
  '\tworkgroup = WORKGROUP',
  '\tserver string = ANAS Storage',
  '\tinterfaces = lo eth0',
  '\tbind interfaces only = yes',
  '\tlog level = 1',
  '',
  '[media]',
  '\tcomment = Media library',
  '\tpath = /tank/media',
  '\tbrowseable = yes',
  '\tread only = no',
  '\tvalid users = media @smbusers',
  '',
  '[archive]',
  '\tpath = /tank/archive',
  '\tread only = yes',
  '',
].join('\n')

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('SMB share routes', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string | undefined
  let confPath: string | undefined

  function startServer(conf = SAMPLE_CONF): ReturnType<typeof createServer> {
    dir = mkdtempSync(join(tmpdir(), 'anas-smb-test-'))
    confPath = join(dir, 'smb.conf')
    writeFileSync(confPath, conf, 'utf8')
    server = createServer({ mock: true, logger: false, smbConfPath: confPath })
    return server
  }

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
      confPath = undefined
    }
  })

  // --- GET list ----------------------------------------------------------
  describe('GET /v1/shares/smb', () => {
    it('lists ALL shares (Principle 11), excluding [global]', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'GET', url: '/v1/shares/smb' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: SmbShare[] }
      assert.deepEqual(data.map(d => d.name).sort(), ['archive', 'media'])
      const media = data.find(d => d.name === 'media')!
      assert.equal(media.path, '/tank/media')
      assert.equal(media.readOnly, false)
      assert.deepEqual(media.validUsers, ['media', '@smbusers'])
    })

    it('sets pathExists true for a live path and false for a missing one (stale)', async () => {
      dir = mkdtempSync(join(tmpdir(), 'anas-smb-test-'))
      const livePath = join(dir, 'live')
      mkdirSync(livePath)
      const missingPath = join(dir, 'gone') // deliberately never created
      confPath = join(dir, 'smb.conf')
      writeFileSync(confPath, [
        '[global]',
        '\tworkgroup = WORKGROUP',
        '',
        '[live]',
        `\tpath = ${livePath}`,
        '',
        '[stale]',
        `\tpath = ${missingPath}`,
        '',
      ].join('\n'), 'utf8')
      server = createServer({ mock: true, logger: false, smbConfPath: confPath })
      const res = await server.inject({ method: 'GET', url: '/v1/shares/smb' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: SmbShare[] }
      assert.equal(data.find(d => d.name === 'live')!.pathExists, true)
      assert.equal(data.find(d => d.name === 'stale')!.pathExists, false)
    })

    it('returns an empty list when smb.conf is missing', async () => {
      dir = mkdtempSync(join(tmpdir(), 'anas-smb-test-'))
      confPath = join(dir, 'does-not-exist.conf')
      server = createServer({ mock: true, logger: false, smbConfPath: confPath })
      const res = await server.inject({ method: 'GET', url: '/v1/shares/smb' })
      assert.equal(res.statusCode, 200)
      assert.deepEqual((res.json() as { data: SmbShare[] }).data, [])
    })
  })

  // --- GET global --------------------------------------------------------
  describe('GET /v1/shares/smb/global', () => {
    it('returns the parsed [global] config', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'GET', url: '/v1/shares/smb/global' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: SmbGlobalConfig }
      assert.equal(data.workgroup, 'WORKGROUP')
      assert.equal(data.serverString, 'ANAS Storage')
      assert.deepEqual(data.interfaces, ['lo', 'eth0'])
      assert.equal(data.bindInterfacesOnly, true)
    })
  })

  // --- PUT global --------------------------------------------------------
  describe('PUT /v1/shares/smb/global', () => {
    it('202 and surgically updates only the changed key', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/global',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ workgroup: 'ANASDOM' }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      const written = readFileSync(confPath!, 'utf8')
      assert.ok(written.includes('\tworkgroup = ANASDOM'))
      // Only that value changed; the unknown directive and shares survive.
      assert.ok(written.includes('\tlog level = 1'))
      assert.ok(written.includes('[media]'))
      assert.equal(written.split('\n').length, SAMPLE_CONF.split('\n').length)
    })

    it('rejects without identity headers', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/global',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ workgroup: 'X' }),
      })
      assert.equal(res.statusCode, 401)
    })

    it('409 CONFIRMATION_REQUIRED when the interface binding changes with live connections', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/global',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        // current interfaces = "lo eth0"; this drops eth0 → a real binding change.
        payload: JSON.stringify({ interfaces: ['lo'] }),
      })
      assert.equal(res.statusCode, 409)
      assert.equal((res.json() as { error: { code: string } }).error.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'])
      const warnings = (res.json() as { error: { warnings: string[] } }).error.warnings
      assert.ok(warnings.some(w => w.includes('active SMB connection')))
      // The file was NOT touched — the change is still pending confirmation.
      assert.ok(readFileSync(confPath!, 'utf8').includes('\tinterfaces = lo eth0'))
    })

    it('applies the interface change once confirmed', async () => {
      const s = startServer()
      const first = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/global',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ interfaces: ['lo'] }),
      })
      assert.equal(first.statusCode, 409)
      const code = first.headers['x-anas-confirm-code'] as string
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/global',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json', 'x-anas-confirm': code },
        payload: JSON.stringify({ interfaces: ['lo'] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.ok(readFileSync(confPath!, 'utf8').includes('\tinterfaces = lo'))
    })

    // The SMB Settings dialog always sends all four fields. On a stock config
    // that names neither, blanks must NOT become empty directives (issue #42).
    it('a blank workgroup / server string writes no empty directives', async () => {
      const stock = [
        '[global]',
        '\tlog level = 1',
        '',
        '[media]',
        '\tpath = /tank/media',
        '',
      ].join('\n')
      const s = startServer(stock)
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/global',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          workgroup: '',
          serverString: '',
          interfaces: [],
          bindInterfacesOnly: false,
        }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      const written = readFileSync(confPath!, 'utf8')
      assert.ok(!written.includes('workgroup'), 'no empty workgroup directive')
      assert.ok(!written.includes('server string'), 'no empty server string directive')
      assert.equal(written, stock, 'an untouched settings save changes nothing')
    })

    it('clears an existing workgroup rather than blanking it', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/global',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ workgroup: '' }),
      })
      assert.equal(res.statusCode, 202)
      await waitForJob(s, (res.json() as JobAccepted).job.id)
      const written = readFileSync(confPath!, 'utf8')
      assert.ok(!written.includes('workgroup'), 'the directive is gone, not left empty')
      assert.ok(written.includes('\tserver string = ANAS Storage'), 'siblings untouched')
    })

    it('does NOT gate a reorder-only interfaces change (functionally a no-op)', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/global',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        // same set as current ("lo eth0"), just reordered → not a binding change.
        payload: JSON.stringify({ interfaces: ['eth0', 'lo'] }),
      })
      assert.equal(res.statusCode, 202)
    })
  })

  // --- GET detail --------------------------------------------------------
  describe('GET /v1/shares/smb/:name', () => {
    it('returns the share plus live connections from smbstatus', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'GET', url: '/v1/shares/smb/media' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: SmbShareDetail }
      assert.equal(data.name, 'media')
      assert.deepEqual(data.connections, [{ user: 'media', machine: '10.0.0.50' }])
      // /tank/media does not exist in the test env → observed stale.
      assert.equal(data.pathExists, false)
    })

    it('returns [] connections for a share with none', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'GET', url: '/v1/shares/smb/archive' })
      assert.equal(res.statusCode, 200)
      assert.deepEqual((res.json() as { data: SmbShareDetail }).data.connections, [])
    })

    it('404 for an unknown share', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'GET', url: '/v1/shares/smb/nope' })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
    })
  })

  // --- POST create -------------------------------------------------------
  describe('POST /v1/shares/smb', () => {
    it('202, appends the stanza, and leaves prior content byte-identical', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'POST',
        url: '/v1/shares/smb',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'photos', path: '/tank/photos', comment: 'Photos' }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'smb.share.add')
      const job = await waitForJob(s, body.job.id)
      assert.equal(job.status, 'completed')
      const written = readFileSync(confPath!, 'utf8')
      assert.ok(written.startsWith(SAMPLE_CONF), 'existing content preserved verbatim')
      assert.ok(written.includes('[photos]'))
      assert.ok(written.includes('\tpath = /tank/photos'))
    })

    it('409 when the share already exists', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'POST',
        url: '/v1/shares/smb',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'media', path: '/tank/media' }),
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
    })

    it('400 on an invalid share name', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'POST',
        url: '/v1/shares/smb',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'bad/name', path: '/tank/x' }),
      })
      assert.equal(res.statusCode, 400)
    })
  })

  // --- PUT update --------------------------------------------------------
  describe('PUT /v1/shares/smb/:name', () => {
    it('202 and changes only the targeted key', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/media',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ readOnly: true }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      const written = readFileSync(confPath!, 'utf8')
      assert.ok(written.includes('\tread only = yes'))
      // media's other keys and the archive share are intact.
      assert.ok(written.includes('\tvalid users = media @smbusers'))
      assert.ok(written.includes('[archive]'))
    })

    it('404 for an unknown share', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/nope',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ readOnly: true }),
      })
      assert.equal(res.statusCode, 404)
    })

    // The edit dialog always sends the FULL field set, so a save is normally a
    // removal (cleared list / blank comment) AND an insert in one request —
    // the shape that used to write into the NEXT stanza (issue #36).
    it('keeps a full-field-set save inside the edited stanza (issue #36)', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/media',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          path: '/tank/media',
          comment: '',
          browseable: true,
          readOnly: false,
          guestOk: true, // absent in [media] → an insert
          validUsers: [], // present in [media] → a removal
          hostsAllow: [],
          hostsDeny: [],
        }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')

      const list = await s.inject({ method: 'GET', url: '/v1/shares/smb' })
      const shares = (list.json() as { data: SmbShare[] }).data
      const media = shares.find(x => x.name === 'media')!
      const archive = shares.find(x => x.name === 'archive')!
      assert.equal(media.guestOk, true)
      assert.deepEqual(media.validUsers, [])
      // The neighbouring stanza did NOT inherit the guest access.
      assert.equal(archive.guestOk, false)
      assert.equal(archive.readOnly, true)
      // [archive] is byte-identical, and no empty comment was injected.
      const written = readFileSync(confPath!, 'utf8')
      assert.ok(written.includes('[archive]\n\tpath = /tank/archive\n\tread only = yes\n'))
      assert.ok(!written.includes('comment = \n'), 'no empty comment directive')
    })

    it('a save that changes nothing leaves smb.conf byte-identical', async () => {
      const s = startServer()
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/media',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          path: '/tank/media',
          comment: 'Media library',
          browseable: true,
          readOnly: false,
          guestOk: false,
          validUsers: ['media', '@smbusers'],
          hostsAllow: [],
          hostsDeny: [],
        }),
      })
      assert.equal(res.statusCode, 202)
      await waitForJob(s, (res.json() as JobAccepted).job.id)
      assert.equal(readFileSync(confPath!, 'utf8'), SAMPLE_CONF)
    })
  })

  // --- DELETE ------------------------------------------------------------
  describe('DELETE /v1/shares/smb/:name', () => {
    it('409 CONFIRMATION_REQUIRED with a code, warning about active connections', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'DELETE', url: '/v1/shares/smb/media', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'])
      const warnings = res.json().error.warnings as string[]
      assert.ok(warnings.some(w => w.includes('active connection')))
    })

    it('proceeds to 202 and removes only the stanza when confirmed', async () => {
      const s = startServer()
      const first = await s.inject({ method: 'DELETE', url: '/v1/shares/smb/archive', headers: IDENTITY_HEADERS })
      assert.equal(first.statusCode, 409)
      const code = first.headers['x-anas-confirm-code'] as string
      const res = await s.inject({
        method: 'DELETE',
        url: '/v1/shares/smb/archive',
        headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      const written = readFileSync(confPath!, 'utf8')
      assert.ok(!written.includes('[archive]'))
      // media + global untouched.
      assert.ok(written.includes('[media]'))
      assert.ok(written.includes('[global]'))
    })

    it('404 for an unknown share', async () => {
      const s = startServer()
      const res = await s.inject({ method: 'DELETE', url: '/v1/shares/smb/nope', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 404)
    })
  })
})

// --- pvepool.1 review fixes: the share-path backstop -----------------------
//
// A share's `path` resolves onto the ZFS dataset whose mountpoint hosts it
// (longest prefix), and an OWNED dataset is no share target: the create (and
// an edit that MOVES the path) refuse 400 with the ownership reason. A path
// on the sibling dataset's mountpoint, or on no ZFS dataset at all, passes.
describe('SMB share path vs the PVE footprint (pvepool.1 review fixes)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string | undefined
  let prevCfg: string | undefined

  const CLAIM = 'zfspool: local-zfs\n\tpool testpool\n\tcontent images,rootdir\n\n'
  // testpool is the storage ROOT (mountpoint /testpool, owned) and
  // testpool/media the sibling this story exists to unlock (/testpool/media).
  const MOUNTPOINTS = 'testpool\t/testpool\ntestpool/media\t/testpool/media\n'

  function startServer(conf = SAMPLE_CONF): ReturnType<typeof createServer> {
    dir = mkdtempSync(join(tmpdir(), 'anas-smb-pve-'))
    prevCfg = process.env.ANAS_STORAGE_CFG
    const cfg = join(dir, 'storage.cfg')
    writeFileSync(cfg, CLAIM, 'utf8')
    process.env.ANAS_STORAGE_CFG = cfg
    const confPath = join(dir, 'smb.conf')
    writeFileSync(confPath, conf, 'utf8')
    server = createServer({ mock: true, logger: false, smbConfPath: confPath })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    // The footprint's reads: the mountpoint table (datasetOfPath's input),
    // the boot probe (readable, no bootfs — the system rule stays inactive),
    // and systemctl for the smbd reload the accepted creates end with.
    mock.addFixture({ command: '/usr/sbin/zfs', args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: MOUNTPOINTS, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: 'testpool\t-\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/findmnt', args: ['-n', '-o', 'SOURCE,FSTYPE', '/'], result: { stdout: '/dev/sda1\text4\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    return server
  }

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (prevCfg === undefined)
      delete process.env.ANAS_STORAGE_CFG
    else
      process.env.ANAS_STORAGE_CFG = prevCfg
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  it('a share on an OWNED mountpoint is refused 400 with the ownership reason', async () => {
    const s = startServer()
    const res = await s.inject({
      method: 'POST',
      url: '/v1/shares/smb',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'pve-root', path: '/testpool' }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    // The sentence names the resolved dataset AND the owning storage.
    assert.match(res.json().error.message, /'\/testpool'/)
    assert.match(res.json().error.message, /'testpool'/)
    assert.match(res.json().error.message, /local-zfs/)
    assert.match(res.json().error.message, /storage root/)
    // Nothing was written to smb.conf.
    assert.ok(!readFileSync(join(dir!, 'smb.conf'), 'utf8').includes('[pve-root]'))
  })

  it('a share on the SIBLING dataset\'s mountpoint passes the backstop', async () => {
    const s = startServer()
    const res = await s.inject({
      method: 'POST',
      url: '/v1/shares/smb',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'media2', path: '/testpool/media' }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(readFileSync(join(dir!, 'smb.conf'), 'utf8').includes('[media2]'))
  })

  it('a share on a NON-ZFS path is untouched by the backstop', async () => {
    const s = startServer()
    const res = await s.inject({
      method: 'POST',
      url: '/v1/shares/smb',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'scratch', path: '/srv/other' }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
  })

  it('an edit that MOVES the path onto an owned mountpoint is refused; one that keeps it is not', async () => {
    const s = startServer()
    // The move.
    const moved = await s.inject({
      method: 'PUT',
      url: '/v1/shares/smb/media',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: '/testpool' }),
    })
    assert.equal(moved.statusCode, 400)
    assert.match(moved.json().error.message, /storage root/)
    // The untouched edit — no `path` in the body — never asks the footprint
    // for a move and succeeds.
    const kept = await s.inject({
      method: 'PUT',
      url: '/v1/shares/smb/media',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ comment: 'still the media library' }),
    })
    assert.equal(kept.statusCode, 202)
    const job = await waitForJob(s, (kept.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
  })

  // pvepool.1 review fix 5, narrowed by the 2026-09-22 caveat-emptor ruling
  // (EPICS §2): a `dir` storage on a `legacy` dataset — its `zfs list`
  // mountpoint is a marker, not a path. Mounted, the path resolves onto the
  // DATASET (findmnt says where) and the dir storage owns it. Unmounted, the
  // dir keeps its CONFIGURED path and the backstop refuses against that path
  // — but ONLY while the path is (or may be) on ZFS: a readable findmnt table
  // that answers ext4 DROPS the dir and the share is allowed; an UNAVAILABLE
  // table keeps the tightening.
  const LEGACY_DIR_CFG = 'dir: dump\n\tpath /srv/dump\n\tcontent backup,iso\n'

  /**
   * A server whose storage.cfg is the legacy dir storage, whose `zfs list`
   * says `tank/dump legacy`, and whose `findmnt --json` answers `findmntJson`
   * with `findmntExit` (the server's default fixture is overridden by wrap,
   * not re-registered). The systemctl fixture backs the reload an ACCEPTED
   * create ends with.
   */
  function legacyServer(findmntJson: string, findmntExit = 0): ReturnType<typeof createServer> {
    dir = mkdtempSync(join(tmpdir(), 'anas-smb-pve-'))
    prevCfg = process.env.ANAS_STORAGE_CFG
    const cfg = join(dir, 'storage.cfg')
    writeFileSync(cfg, LEGACY_DIR_CFG, 'utf8')
    process.env.ANAS_STORAGE_CFG = cfg
    const confPath = join(dir, 'smb.conf')
    writeFileSync(confPath, SAMPLE_CONF, 'utf8')
    const s = createServer({ mock: true, logger: false, smbConfPath: confPath })
    const mock = (s as unknown as { executor: MockExecutor }).executor
    mock.addFixture({ command: '/usr/sbin/zfs', args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: 'tank/dump\tlegacy\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[]) => {
      if (command === '/usr/bin/findmnt' && args.join(' ') === '--json')
        return { stdout: findmntJson, stderr: '', exitCode: findmntExit }
      return orig(command, args)
    }
    return s
  }

  it('a share on a MOUNTED legacy dataset is refused with the dir-storage claim (review fix 5)', async () => {
    // findmnt knows where the `legacy` dataset actually sits: /srv/dump.
    const s = legacyServer(JSON.stringify({
      filesystems: [
        { target: '/srv/dump', source: 'tank/dump', fstype: 'zfs', options: 'rw' },
        { target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' },
      ],
    }))
    const res = await s.inject({
      method: 'POST',
      url: '/v1/shares/smb',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'dump-share', path: '/srv/dump' }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    // The path resolved onto the DATASET (via findmnt) and the dataset is the
    // dir storage — the dataset claim quotes the ownership reason.
    assert.match(res.json().error.message, /'\/srv\/dump'/)
    assert.match(res.json().error.message, /'tank\/dump'/)
    assert.match(res.json().error.message, /directory storage/)
    // Nothing was written to smb.conf.
    assert.ok(!readFileSync(join(dir!, 'smb.conf'), 'utf8').includes('[dump-share]'))
  })

  it('a share on an UNMOUNTED legacy dataset with an UNAVAILABLE mount table is refused against the dir path', async () => {
    // findmnt --json FAILS to read: whether /srv/dump sits on ZFS is UNKNOWN,
    // and missing facts may only tighten — the dir keeps its CONFIGURED path
    // and the backstop refuses against it (the same path rule mounts and
    // restore use).
    const s = legacyServer('', 1)
    const res = await s.inject({
      method: 'POST',
      url: '/v1/shares/smb',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'dump-share', path: '/srv/dump' }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    // The path-rule sentence names the storage and its configured path.
    assert.match(res.json().error.message, /'\/srv\/dump'/)
    assert.match(res.json().error.message, /PVE storage 'dump' claims/)
    assert.match(res.json().error.message, /shares cannot serve PVE territory/)
    assert.ok(!readFileSync(join(dir!, 'smb.conf'), 'utf8').includes('[dump-share]'))
  })

  it('a share on a dir-storage path findmnt READS as ext4 is ALLOWED (caveat-emptor ruling)', async () => {
    // The ruling (EPICS §2, 2026-09-22): the path rule claims only what a ZFS
    // filesystem serves. The legacy dataset is NOT mounted (no zfs mount in
    // the readable table), so /srv/dump is ext4 territory — a share there is
    // the operator's call.
    const s = legacyServer(JSON.stringify({
      filesystems: [{ target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' }],
    }))
    const res = await s.inject({
      method: 'POST',
      url: '/v1/shares/smb',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'dump-share', path: '/srv/dump/sub' }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(readFileSync(join(dir!, 'smb.conf'), 'utf8').includes('[dump-share]'))
  })
})

// ============================================================================
// Self-service on SMB shares — slice 1 (smbsvc.1): Previous Versions enable /
// disable round-trips on a mock ZFS share and a mock AHR share, the refusals,
// and the testparm-gated byte-identical rollback.
// ============================================================================

const TESTPARM = '/usr/bin/testparm'
const MOUNT_BIN = '/usr/bin/mount'

/**
 * The dev-mock pre-registers ground-truth AHR fixtures for pool `ahr0` (flat
 * layout, mountpoint `/mnt/anas-ahr/ahr0`) and they win first-match, so a
 * second pool's fixtures would never match. Instead of re-registering, wrap
 * `exec` and override ONLY the mount-table read that decides `subvolLayout` —
 * every other AHR read falls through to the dev fixtures (pool `ahr0`).
 */
function wrapAhrFindmnt(mock: MockExecutor, opts: { subvol?: string } = {}): void {
  const subvol = opts.subvol ?? 'subvolid=256,subvol=/@data'
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[]) => {
    if (command === '/usr/bin/findmnt' && args[0] === '--json' && args[1] === '--real') {
      return { stdout: JSON.stringify({ filesystems: [{
        target: '/',
        source: '/dev/sda1',
        fstype: 'ext4',
        options: 'rw,relatime,errors=remount-ro',
      }, {
        target: '/mnt/anas-ahr/ahr0',
        source: '/dev/mapper/ahr0-ahr0--vol',
        fstype: 'btrfs',
        options: `rw,relatime,space_cache=v2,${subvol}`,
      }] }), stderr: '', exitCode: 0 }
    }
    return orig(command, args)
  }
}

describe('SMB self-service (smbsvc.1 slice 1)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string | undefined
  let confPath: string | undefined
  let fstabPath: string | undefined
  let schedDir: string | undefined
  let savedEnv: { systemd?: string, fstab?: string } = {}

  const ZFS_SHARE_CONF = [
    '[global]',
    '\tworkgroup = WORKGROUP',
    '',
    '[media]',
    '\tpath = /testpool/media',
    '\tread only = no',
    '',
  ].join('\n')

  const AHR_SHARE_CONF = [
    '[global]',
    '\tworkgroup = WORKGROUP',
    '',
    '[media]',
    '\tpath = /mnt/anas-ahr/ahr0/media',
    '\tread only = no',
    '',
  ].join('\n')

  /**
   * A server with the footprint reads fixture-registered. `zfsTable` decides
   * whether the share's path resolves onto a ZFS dataset (empty = fall
   * through to AHR, where `wrapAhrFindmnt` steers the pool's layout).
   */
  function startSelfService(
    conf: string,
    opts: { zfsTable?: string, ahr?: { subvol?: string }, systemdUnits?: { id: string, cadence: string, dataset: string }[] } = {},
  ): ReturnType<typeof createServer> {
    dir = mkdtempSync(join(tmpdir(), 'anas-smb-selfsvc-'))
    fstabPath = join(dir, 'fstab')
    writeFileSync(fstabPath, '# test fstab\n', 'utf8')
    schedDir = join(dir, 'units')
    mkdirSync(schedDir)
    for (const u of opts.systemdUnits ?? []) {
      writeFileSync(join(schedDir, `anas-snap-${u.id}.service`), [
        '[Unit]',
        `# X-ANAS-Schedule=${JSON.stringify({
          id: u.id,
          name: u.id,
          target: { kind: 'zfs', dataset: u.dataset },
          cadence: u.cadence,
          retention: { daily: 7 },
          enabled: true,
        })}`,
        '',
        '[Service]',
        'Type=oneshot',
        '',
      ].join('\n'), 'utf8')
    }
    savedEnv = { systemd: process.env.ANAS_SYSTEMD_DIR, fstab: process.env.ANAS_FSTAB_PATH }
    process.env.ANAS_SYSTEMD_DIR = schedDir
    process.env.ANAS_FSTAB_PATH = fstabPath
    confPath = join(dir, 'smb.conf')
    writeFileSync(confPath, conf, 'utf8')
    server = createServer({ mock: true, logger: false, smbConfPath: confPath })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    // The footprint reads (datasetOfPath): mountpoint table + boot probe.
    mock.addFixture({ command: '/usr/sbin/zfs', args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: opts.zfsTable ?? '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: 'testpool\t-\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/findmnt', args: ['-n', '-o', 'SOURCE,FSTYPE', '/'], result: { stdout: '/dev/sda1\text4\n', stderr: '', exitCode: 0 } })
    // testparm gate + reload.
    mock.addFixture({ command: TESTPARM, result: { stdout: 'Loaded services file OK.', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    // The AHR `@snapshots` mount probe (not mounted yet → mount runs) + mount.
    mock.addFixture({ command: '/usr/bin/findmnt', args: ['-n', '-o', 'TARGET', '/mnt/anas-ahr-snapshots/ahr0'], result: { stdout: '', stderr: '', exitCode: 1 } })
    mock.addFixture({ command: MOUNT_BIN, result: { stdout: '', stderr: '', exitCode: 0 } })
    if (opts.ahr)
      wrapAhrFindmnt(mock, opts.ahr)
    return server
  }

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (savedEnv.systemd === undefined)
      delete process.env.ANAS_SYSTEMD_DIR
    else
      process.env.ANAS_SYSTEMD_DIR = savedEnv.systemd
    if (savedEnv.fstab === undefined)
      delete process.env.ANAS_FSTAB_PATH
    else
      process.env.ANAS_FSTAB_PATH = savedEnv.fstab
    savedEnv = {}
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
      confPath = undefined
      fstabPath = undefined
      schedDir = undefined
    }
  })

  // --- ZFS share -----------------------------------------------------------
  it('enable on a ZFS share writes the composed stanza; the detail derives the bucket', async () => {
    const s = startSelfService(ZFS_SHARE_CONF, { zfsTable: 'testpool\t/testpool\ntestpool/media\t/testpool/media\n' })
    const res = await s.inject({
      method: 'PUT',
      url: '/v1/shares/smb/media',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ previousVersions: { enabled: true } }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))

    const written = readFileSync(confPath!, 'utf8')
    const stanza = written.slice(written.indexOf('[media]'))
    assert.ok(stanza.includes('\tvfs objects = shadow_copy2\n'), written)
    assert.ok(stanza.includes('\tshadow:format = anas-daily-%Y-%m-%dT%H%M%SZ\n'), written)
    assert.ok(stanza.includes('\tshadow:snapdir = .zfs/snapshot\n'), written)
    assert.ok(stanza.includes('\tshadow:snapdirseverywhere = yes\n'), written)
    assert.ok(stanza.includes('\tshadow:localtime = no\n'), written)
    assert.ok(stanza.includes('\tshadow:sort = desc\n'), written)
    // No schedule exists → `daily` is the honest fallback, never a refusal.
    const detail = await s.inject({ method: 'GET', url: '/v1/shares/smb/media' })
    assert.deepEqual((detail.json() as { data: SmbShare }).data.previousVersions, { bucket: 'daily' })
  })

  it('the bucket is the FINEST enabled schedule on the dataset, read from the unit store', async () => {
    const s = startSelfService(ZFS_SHARE_CONF, {
      zfsTable: 'testpool\t/testpool\ntestpool/media\t/testpool/media\n',
      systemdUnits: [
        { id: 'nightly', cadence: 'daily', dataset: 'testpool/media' },
        { id: 'hourly', cadence: 'hourly', dataset: 'testpool/media' },
        { id: 'other', cadence: 'frequently', dataset: 'testpool/other' },
      ],
    })
    const res = await s.inject({
      method: 'PUT',
      url: '/v1/shares/smb/media',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ previousVersions: { enabled: true } }),
    })
    assert.equal(res.statusCode, 202)
    await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.ok(readFileSync(confPath!, 'utf8').includes('\tshadow:format = anas-hourly-%Y-%m-%dT%H%M%SZ\n'))
  })

  it('re-enabling with the same request leaves smb.conf byte-identical (testparm-gated no-op)', async () => {
    const s = startSelfService(ZFS_SHARE_CONF, { zfsTable: 'testpool\t/testpool\ntestpool/media\t/testpool/media\n' })
    const payload = JSON.stringify({ previousVersions: { enabled: true } })
    const first = await s.inject({ method: 'PUT', url: '/v1/shares/smb/media', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload })
    await waitForJob(s, (first.json() as JobAccepted).job.id)
    const afterFirst = readFileSync(confPath!, 'utf8')
    const second = await s.inject({ method: 'PUT', url: '/v1/shares/smb/media', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload })
    await waitForJob(s, (second.json() as JobAccepted).job.id)
    assert.equal(readFileSync(confPath!, 'utf8'), afterFirst)
  })

  it('disable removes the shadow keys and the composed line; the read model follows', async () => {
    const s = startSelfService(ZFS_SHARE_CONF, { zfsTable: 'testpool\t/testpool\ntestpool/media\t/testpool/media\n' })
    const enable = await s.inject({ method: 'PUT', url: '/v1/shares/smb/media', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ previousVersions: { enabled: true } }) })
    await waitForJob(s, (enable.json() as JobAccepted).job.id)
    const disable = await s.inject({ method: 'PUT', url: '/v1/shares/smb/media', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ previousVersions: null }) })
    assert.equal(disable.statusCode, 202)
    await waitForJob(s, (disable.json() as JobAccepted).job.id)
    const written = readFileSync(confPath!, 'utf8')
    assert.equal(written, ZFS_SHARE_CONF, 'disable restores the original bytes exactly')
    const detail = await s.inject({ method: 'GET', url: '/v1/shares/smb/media' })
    assert.equal((detail.json() as { data: SmbShare }).data.previousVersions, undefined)
  })

  // --- AHR share -----------------------------------------------------------
  it('enable on an AHR share writes the absolute snapdir and the ONE @snapshots fstab mount', async () => {
    const s = startSelfService(AHR_SHARE_CONF, { ahr: {} })
    const res = await s.inject({
      method: 'PUT',
      url: '/v1/shares/smb/media',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ previousVersions: { enabled: true } }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))

    const written = readFileSync(confPath!, 'utf8')
    const stanza = written.slice(written.indexOf('[media]'))
    assert.ok(stanza.includes('\tvfs objects = shadow_copy2\n'), written)
    assert.ok(stanza.includes('\tshadow:snapdir = /mnt/anas-ahr-snapshots/ahr0\n'), written)
    assert.ok(stanza.includes('\tshadow:snapdirseverywhere = no\n'), written)
    // The ONE fstab line, read-only, nofail, subvol=@snapshots — and the mount NOW.
    const fstab = readFileSync(fstabPath!, 'utf8')
    assert.equal(fstab.split('\n').filter(l => l.includes('/mnt/anas-ahr-snapshots/ahr0')).length, 1, fstab)
    assert.match(fstab, /^\/dev\/ahr0\/ahr0-vol\s+\/mnt\/anas-ahr-snapshots\/ahr0\s+btrfs\s+ro,nofail,subvol=@snapshots\s+0 0$/m)
    assert.ok((s as unknown as { executor: MockExecutor }).executor.calls
      .some(c => c.command === MOUNT_BIN && c.args[0] === '/mnt/anas-ahr-snapshots/ahr0'))
  })

  it('a second enable on the same AHR pool writes NO second fstab line and does not mount again', async () => {
    const s = startSelfService(AHR_SHARE_CONF, { ahr: {} })
    const payload = JSON.stringify({ previousVersions: { enabled: true } })
    for (let i = 0; i < 2; i++) {
      const res = await s.inject({ method: 'PUT', url: '/v1/shares/smb/media', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
    }
    const fstab = readFileSync(fstabPath!, 'utf8')
    assert.equal(fstab.split('\n').filter(l => l.includes('/mnt/anas-ahr-snapshots/ahr0')).length, 1, fstab)
    const mock = (s as unknown as { executor: MockExecutor }).executor
    // The probe fixture answers "not mounted" (exit 1) — matched twice max.
    const mountCalls = mock.calls.filter(c => c.command === MOUNT_BIN && c.args[0] === '/mnt/anas-ahr-snapshots/ahr0')
    assert.ok(mountCalls.length >= 1, 'the first enable mounts the snapshots subvolume')
    assert.ok(mountCalls.length <= 2, 'no mount storm on repeat enables')
  })

  it(`enable on a FLAT-layout AHR pool is refused: "pool 'ahr0' predates the snapshot layout…"`, async () => {
    const s = startSelfService(AHR_SHARE_CONF, { ahr: { subvol: 'subvolid=5,subvol=/' } })
    const res = await s.inject({
      method: 'PUT',
      url: '/v1/shares/smb/media',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ previousVersions: { enabled: true } }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /pool 'ahr0' predates the snapshot layout — Previous Versions needs @snapshots/)
    assert.ok(!readFileSync(confPath!, 'utf8').includes('shadow:'), 'nothing was written')
  })

  // --- Refusals ------------------------------------------------------------
  it(`enable on a share with a custom vfs objects line is refused with the share named`, async () => {
    const custom = ZFS_SHARE_CONF.replace('\tread only = no\n', '\tread only = no\n\tvfs objects = vfs_fruit_extras\n')
    const s = startSelfService(custom, { zfsTable: 'testpool\t/testpool\ntestpool/media\t/testpool/media\n' })
    const res = await s.inject({
      method: 'PUT',
      url: '/v1/shares/smb/media',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ previousVersions: { enabled: true } }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /share 'media' has a custom vfs objects line — remove it before enabling self-service features/)
    // The list/detail still flags the share as custom for the dialog to grey.
    const detail = await s.inject({ method: 'GET', url: '/v1/shares/smb/media' })
    const share = (detail.json() as { data: SmbShare }).data
    assert.deepEqual(share.vfsObjects, ['vfs_fruit_extras'])
    // Clearing on a custom share is NOT refused — and changes nothing.
    const clear = await s.inject({ method: 'PUT', url: '/v1/shares/smb/media', headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' }, payload: JSON.stringify({ previousVersions: null }) })
    assert.equal(clear.statusCode, 202)
    await waitForJob(s, (clear.json() as JobAccepted).job.id)
    assert.equal(readFileSync(confPath!, 'utf8'), custom)
  })

  it(`enable on a path that is neither ZFS nor AHR is refused: "…no snapshots to expose"`, async () => {
    const scratch = ZFS_SHARE_CONF.replace('/testpool/media', '/srv/scratch')
    const s = startSelfService(scratch)
    const res = await s.inject({
      method: 'PUT',
      url: '/v1/shares/smb/media',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ previousVersions: { enabled: true } }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /'\/srv\/scratch' is not on a ZFS dataset or an AHR pool — there are no snapshots to expose/)
  })

  it('a create that enables Previous Versions writes the stanza (and AHR mounts nothing until enable)', async () => {
    const s = startSelfService(ZFS_SHARE_CONF, { zfsTable: 'testpool\t/testpool\ntestpool/media\t/testpool/media\n' })
    const res = await s.inject({
      method: 'POST',
      url: '/v1/shares/smb',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'photos', path: '/testpool/media', previousVersions: { enabled: true } }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const written = readFileSync(confPath!, 'utf8')
    assert.ok(written.includes('[photos]'))
    assert.ok(written.includes('\tvfs objects = shadow_copy2\n'))
    assert.ok(written.includes('\tshadow:format = anas-daily-%Y-%m-%dT%H%M%SZ\n'))
  })

  it('a create enabling Previous Versions on a non-snapshot path is refused 400', async () => {
    const s = startSelfService(ZFS_SHARE_CONF)
    const res = await s.inject({
      method: 'POST',
      url: '/v1/shares/smb',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'scratch', path: '/srv/scratch', previousVersions: { enabled: true } }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /no snapshots to expose/)
    assert.ok(!readFileSync(confPath!, 'utf8').includes('[scratch]'))
  })

  it('a request that SETS recycle or timeMachine is refused (slice 1 ships Previous Versions only)', async () => {
    const s = startSelfService(ZFS_SHARE_CONF, { zfsTable: 'testpool\t/testpool\ntestpool/media\t/testpool/media\n' })
    for (const feature of [{ recycle: { purgeDays: 30 } }, { timeMachine: { maxSize: 1_000_000 } }]) {
      const res = await s.inject({
        method: 'PUT',
        url: '/v1/shares/smb/media',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify(feature),
      })
      assert.equal(res.statusCode, 400)
      assert.match(res.json().error.message, /not available in this version/)
      assert.ok(!readFileSync(confPath!, 'utf8').includes('recycle:'))
      assert.ok(!readFileSync(confPath!, 'utf8').includes('fruit:'))
    }
  })

  it('a failing testparm rolls the write back byte-identically and fails the job with the sentence', async () => {
    const s = startSelfService(ZFS_SHARE_CONF, { zfsTable: 'testpool\t/testpool\ntestpool/media\t/testpool/media\n' })
    const mock = (s as unknown as { executor: MockExecutor }).executor
    // The gate runs BEFORE the candidate /usr/bin/testparm fixture: register a
    // failure for the candidate temp file specifically.
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[]) => {
      if (command === TESTPARM && args[0] === '-s' && args[1]?.endsWith('.anas-testparm.tmp'))
        return { stdout: '', stderr: 'Unknown parameter encountered: "vfs objects"', exitCode: 1 }
      return orig(command, args)
    }
    const before = readFileSync(confPath!, 'utf8')
    const res = await s.inject({
      method: 'PUT',
      url: '/v1/shares/smb/media',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ previousVersions: { enabled: true } }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(s, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.match((job.error as { message: string }).message, /smb.conf failed testparm validation — the change was not applied/)
    assert.equal(readFileSync(confPath!, 'utf8'), before, 'the file stands byte-identical')
  })
})
