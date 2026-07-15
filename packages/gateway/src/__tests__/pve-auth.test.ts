import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { PveAuthProvider } from '../auth/providers/pve.js'

/**
 * The gateway verifies PVEAuthCookie tickets against Proxmox's RSA public key.
 * Proxmox rotates that key ~daily (live key → authkey.pub.old, fresh
 * authkey.pub), which used to 401 every ticket until the gateway was restarted.
 * These tests prove the provider re-reads the key on a rotation and self-heals,
 * while still rejecting forgeries — using real RSA keys and real ticket
 * signatures (no mocking of crypto).
 */

function makeKeypair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

/** Build a real PVE ticket cookie: PVE:user@realm:HEXTIME::base64(RSA-SHA1 sig). */
function makeTicket(privateKeyPem: string, opts: { user?: string, realm?: string, ts?: number } = {}): string {
  const user = opts.user ?? 'root'
  const realm = opts.realm ?? 'pam'
  const ts = opts.ts ?? Math.floor(Date.now() / 1000)
  const hex = (ts >>> 0).toString(16).toUpperCase().padStart(8, '0')
  const plaintext = `PVE:${user}@${realm}:${hex}`
  const signature = createSign('RSA-SHA1').update(plaintext).sign(privateKeyPem, 'base64')
  return `${plaintext}::${signature}`
}

describe('PveAuthProvider key rotation', () => {
  let dir: string
  let pubPath: string
  let oldPath: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'anas-authkey-'))
    pubPath = join(dir, 'authkey.pub')
    oldPath = join(dir, 'authkey.pub.old')
  })

  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('validates a ticket signed by the current key', async () => {
    const k1 = makeKeypair()
    writeFileSync(pubPath, k1.publicKey)
    const provider = new PveAuthProvider(pubPath, oldPath)

    const user = await provider.validateToken(makeTicket(k1.privateKey))
    assert.ok(user, 'a ticket signed by the loaded key must validate')
    assert.equal(user!.name, 'root')
  })

  it('self-heals after the authkey rotates, without being reconstructed', async () => {
    const k1 = makeKeypair()
    writeFileSync(pubPath, k1.publicKey)
    const provider = new PveAuthProvider(pubPath, oldPath)

    // Confirm the pre-rotation key works (this also leaves the reload throttle
    // untouched, since a hit never checks disk).
    assert.ok(await provider.validateToken(makeTicket(k1.privateKey)))

    // Rotate exactly as Proxmox does: previous key → .old, fresh key → .pub.
    const k2 = makeKeypair()
    writeFileSync(oldPath, k1.publicKey)
    writeFileSync(pubPath, k2.publicKey)
    // Force a distinct mtime so the mtime gate fires even on same-ms writes.
    const future = new Date(Date.now() + 5000)
    utimesSync(pubPath, future, future)

    // A ticket signed by the NEW key validates without restarting the gateway.
    const fresh = await provider.validateToken(makeTicket(k2.privateKey))
    assert.ok(fresh, 'a ticket signed by the rotated key must validate after reload')
    assert.equal(fresh!.name, 'root')

    // A still-valid ticket signed by the PREVIOUS key also verifies (grace
    // period via authkey.pub.old).
    assert.ok(
      await provider.validateToken(makeTicket(k1.privateKey)),
      'a ticket from the prior key must still verify against authkey.pub.old',
    )
  })

  it('rejects a ticket signed by a key that is not on disk (no forgery)', async () => {
    const k1 = makeKeypair()
    writeFileSync(pubPath, k1.publicKey)
    const provider = new PveAuthProvider(pubPath, oldPath)

    const forged = makeKeypair()
    const user = await provider.validateToken(makeTicket(forged.privateKey))
    assert.equal(user, null, 'a signature from an unknown key must never validate')
  })

  it('rejects an expired ticket even if correctly signed', async () => {
    const k1 = makeKeypair()
    writeFileSync(pubPath, k1.publicKey)
    const provider = new PveAuthProvider(pubPath, oldPath)

    // 3 hours old — past the 2h ticket lifetime.
    const old = Math.floor(Date.now() / 1000) - 3 * 3600
    const user = await provider.validateToken(makeTicket(k1.privateKey, { ts: old }))
    assert.equal(user, null, 'an expired ticket must not validate')
  })
})
