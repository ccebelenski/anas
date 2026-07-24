import type { RemotesPaths } from '../replication-remotes.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  ensureKeypair,
  fingerprintFromBlob,
  fingerprintOf,
  knownHostField,
  parseScan,
  pinHostKey,
  readRemotes,
  RemotesConflictError,
  writeRemotes,
} from '../replication-remotes.js'

const SSH_KEYGEN = '/usr/bin/ssh-keygen'
const SSH_KEYSCAN = '/usr/bin/ssh-keyscan'

const REMOTE = { name: 'nas1', host: '10.0.0.9', port: 22, user: 'root' }
const REMOTE_B = { name: 'nas2', host: '10.0.0.10', port: 2222, user: 'admin' }

// A plausible ed25519 host-key blob (any base64 hashes deterministically).
const ED_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExamp1'
const RSA_BLOB = 'AAAAB3NzaC1yc2EAAAADAQABAAABgExampleRsaKeyBlobExampleRsaKeyBlob00'

describe('replication remotes registry (Epic 5.5.2 — corosync store)', () => {
  let dir: string
  let paths: RemotesPaths
  let prevNode: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-remotes-'))
    paths = {
      registryFile: join(dir, 'sub', 'remotes.json'), // sub/ exercises mkdir -p
      keyPath: join(dir, 'priv', 'replication_key'),
      knownHostsFile: join(dir, 'priv', 'known_hosts'),
    }
    prevNode = process.env.ANAS_NODENAME
    process.env.ANAS_NODENAME = 'node1'
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    if (prevNode === undefined)
      delete process.env.ANAS_NODENAME
    else
      process.env.ANAS_NODENAME = prevNode
  })

  // --- read / CAS write ------------------------------------------------------
  it('absent registry reads as version 0, empty remotes', async () => {
    const reg = await readRemotes(paths)
    assert.equal(reg.version, 0)
    assert.deepEqual(reg.remotes, [])
  })

  it('CAS write round-trips: version bumps, updatedBy = node, remotes persist', async () => {
    const w = await writeRemotes(paths, 0, [REMOTE])
    assert.equal(w.version, 1)
    assert.equal(w.updatedBy, 'node1')
    const reg = await readRemotes(paths)
    assert.equal(reg.version, 1)
    assert.deepEqual(reg.remotes, [REMOTE])
    // Written atomically to the (mkdir -p'd) target path.
    assert.match(await readFile(paths.registryFile, 'utf-8'), /"nas1"/)
  })

  it('a stale expectedVersion throws RemotesConflictError with the current version', async () => {
    await writeRemotes(paths, 0, [REMOTE]) // → version 1
    await assert.rejects(
      writeRemotes(paths, 0, [REMOTE, REMOTE_B]),
      (e: unknown) => e instanceof RemotesConflictError && e.currentVersion === 1,
    )
  })

  it('concurrent write BETWEEN read and CAS → conflict (beforeRead hook)', async () => {
    await writeRemotes(paths, 0, [REMOTE]) // → version 1; caller believes it is at 1
    // A competing writer bumps the file to version 2 in the CAS window.
    const competing = {
      version: 2,
      updatedBy: 'other',
      updatedAt: new Date().toISOString(),
      remotes: [REMOTE_B],
    }
    await assert.rejects(
      writeRemotes(paths, 1, [REMOTE], {
        beforeRead: async () => {
          await writeFile(paths.registryFile, JSON.stringify(competing), 'utf-8')
        },
      }),
      (e: unknown) => e instanceof RemotesConflictError && e.currentVersion === 2,
    )
    // The competing write survived — we never clobbered it.
    assert.equal((await readRemotes(paths)).version, 2)
  })

  // --- keypair ---------------------------------------------------------------
  it('ensureKeypair runs ssh-keygen once with the fixed empty-passphrase argv', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: SSH_KEYGEN, result: { stdout: '', stderr: '', exitCode: 0 } })
    await ensureKeypair(mock, paths)
    const keygen = mock.calls.filter(c => c.command === SSH_KEYGEN)
    assert.equal(keygen.length, 1)
    assert.deepEqual(keygen[0].args, ['-t', 'ed25519', '-N', '', '-C', 'anas-replication', '-f', paths.keyPath])
  })

  it('ensureKeypair is idempotent: an existing .pub skips ssh-keygen and returns it', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: SSH_KEYGEN, result: { stdout: '', stderr: '', exitCode: 0 } })
    // First call creates the priv dir (mkdir -p) and runs (mock) keygen.
    await ensureKeypair(mock, paths)
    // Simulate keygen having produced the public key, then re-run.
    await writeFile(`${paths.keyPath}.pub`, 'ssh-ed25519 AAAA anas-replication\n', 'utf-8')
    mock.clearFixtures()
    const pub = await ensureKeypair(mock, paths)
    assert.equal(pub, 'ssh-ed25519 AAAA anas-replication')
    assert.equal(mock.calls.filter(c => c.command === SSH_KEYGEN).length, 0)
  })

  // --- host-key pinning ------------------------------------------------------
  it('fingerprintFromBlob matches ssh-keygen SHA256 shape', () => {
    const fp = fingerprintFromBlob(ED_BLOB)
    assert.match(fp, /^SHA256:[A-Za-z0-9+/]+$/)
    assert.doesNotMatch(fp, /=$/) // padding stripped
  })

  it('parseScan skips comments/blank lines and fingerprints each key', () => {
    const scan = `# comment\n10.0.0.9 ssh-ed25519 ${ED_BLOB}\n\n10.0.0.9 ssh-rsa ${RSA_BLOB}\n`
    const keys = parseScan(scan)
    assert.equal(keys.length, 2)
    assert.equal(keys[0].keyType, 'ssh-ed25519')
    assert.equal(keys[0].fingerprint, fingerprintFromBlob(ED_BLOB))
  })

  it('pinHostKey appends scanned keys, returns the ed25519 fingerprint, fingerprintOf finds it', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: SSH_KEYSCAN,
      args: ['-p', '22', '--', '10.0.0.9'],
      result: { stdout: `10.0.0.9 ssh-rsa ${RSA_BLOB}\n10.0.0.9 ssh-ed25519 ${ED_BLOB}\n`, stderr: '', exitCode: 0 },
    })
    const fp = await pinHostKey(mock, paths, '10.0.0.9', 22)
    assert.equal(fp, fingerprintFromBlob(ED_BLOB)) // ed25519 preferred
    const known = await readFile(paths.knownHostsFile, 'utf-8')
    assert.match(known, /ssh-ed25519/)
    assert.match(known, /ssh-rsa/)
    assert.equal(await fingerprintOf(paths, '10.0.0.9', 22), fingerprintFromBlob(ED_BLOB))
  })

  it('fingerprintOf returns null for an unknown host and honours the [host]:port field', async () => {
    assert.equal(await fingerprintOf(paths, 'nope', 22), null)
    assert.equal(knownHostField('h', 22), 'h')
    assert.equal(knownHostField('h', 2222), '[h]:2222')
    await mkdir(join(dir, 'priv'), { recursive: true })
    await writeFile(paths.knownHostsFile, `[10.0.0.9]:2222 ssh-ed25519 ${ED_BLOB}\n`, 'utf-8')
    assert.equal(await fingerprintOf(paths, '10.0.0.9', 2222), fingerprintFromBlob(ED_BLOB))
    assert.equal(await fingerprintOf(paths, '10.0.0.9', 22), null) // wrong port field
  })
})
