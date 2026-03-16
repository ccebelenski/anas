import type { AuthProvider, AuthUser } from '../types'
import { execFile } from 'node:child_process'
import { createVerify } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** PVEAuthCookie format: PVE:user@realm:TIMESTAMP::base64_signature */
const PVE_TICKET_RE = /^(PVE:([^@]+)@[^:]+:([0-9A-F]{8}))::(.+)$/

/** Ticket lifetime: 2 hours (matches Proxmox default). */
const TICKET_LIFETIME_S = 7200

/** Clock skew tolerance: 5 minutes into the future (matches Proxmox). */
const CLOCK_SKEW_S = 300

/** Path to Proxmox RSA public key for ticket verification. */
const AUTHKEY_PATH = '/etc/pve/authkey.pub'
const AUTHKEY_OLD_PATH = '/etc/pve/authkey.pub.old'

/**
 * PVE auth provider — verifies PVEAuthCookie locally using Proxmox's
 * RSA public key.
 *
 * No network calls. The ticket is RSA-signed by Proxmox with a 2048-bit
 * key. We verify the signature using the public key at /etc/pve/authkey.pub,
 * then check the embedded timestamp for expiry.
 */
export class PveAuthProvider implements AuthProvider {
  readonly name = 'pve'

  private pubKeys: string[] = []

  constructor() {
    this.loadKeys()
  }

  async validateToken(cookie: string): Promise<AuthUser | null> {
    const parsed = this.parseTicket(cookie)
    if (!parsed)
      return null

    // Check expiry
    const age = Math.floor(Date.now() / 1000) - parsed.timestamp
    if (age < -CLOCK_SKEW_S || age > TICKET_LIFETIME_S)
      return null

    // Verify RSA signature against any loaded public key
    const valid = this.pubKeys.some(key =>
      this.verifySignature(parsed.plaintext, parsed.signature, key),
    )
    if (!valid)
      return null

    const uid = await this.resolveUid(parsed.username)
    return { name: parsed.username, uid }
  }

  private parseTicket(cookie: string): {
    plaintext: string
    username: string
    timestamp: number
    signature: string
  } | null {
    const match = cookie.match(PVE_TICKET_RE)
    if (!match)
      return null

    return {
      plaintext: match[1]!,
      username: match[2]!,
      timestamp: Number.parseInt(match[3]!, 16),
      signature: match[4]!,
    }
  }

  private verifySignature(plaintext: string, signatureB64: string, pubKey: string): boolean {
    try {
      const verifier = createVerify('RSA-SHA1')
      verifier.update(plaintext)
      return verifier.verify(pubKey, signatureB64, 'base64')
    }
    catch {
      return false
    }
  }

  /** Load RSA public keys from disk. Tries current and previous (for key rotation). */
  private loadKeys(): void {
    this.pubKeys = []

    try {
      this.pubKeys.push(readFileSync(AUTHKEY_PATH, 'utf8'))
    }
    catch {
      console.error(`[auth] Cannot read ${AUTHKEY_PATH} — PVE ticket verification will fail`)
    }

    try {
      this.pubKeys.push(readFileSync(AUTHKEY_OLD_PATH, 'utf8'))
    }
    catch {
      // Old key is optional — only exists after key rotation
    }
  }

  /** Resolve a username to a UID via id(1). Returns -1 for non-PAM realm users. */
  private resolveUid(username: string): Promise<number> {
    return new Promise((resolve) => {
      execFile('/usr/bin/id', ['-u', username], (err, stdout) => {
        if (err) {
          console.warn(`[auth] Cannot resolve UID for '${username}' — non-PAM realm user?`)
          resolve(-1)
          return
        }
        const uid = Number.parseInt(stdout.trim(), 10)
        resolve(Number.isNaN(uid) ? -1 : uid)
      })
    })
  }

  /** Check if Proxmox auth key exists on disk. */
  static isAvailable(): boolean {
    try {
      readFileSync(AUTHKEY_PATH)
      return true
    }
    catch {
      return false
    }
  }
}
