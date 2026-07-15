import type { AuthProvider, AuthUser } from '../types.js'
import { execFile } from 'node:child_process'
import { createVerify } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

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
 * Minimum gap between disk re-checks for a rotated authkey. Proxmox rotates the
 * ticket-signing key ~daily; this only bounds how often a *failing* verify may
 * touch the filesystem, so a flood of bad/forged tickets can't hammer it.
 */
const RELOAD_CHECK_INTERVAL_MS = 1000

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
  /** mtime (ms) of authkey.pub when pubKeys were last loaded (0 = unread). */
  private authkeyMtimeMs = 0
  /** Last time we checked disk for a rotated key, for throttling. */
  private lastReloadCheckMs = 0

  constructor(
    private readonly authkeyPath: string = AUTHKEY_PATH,
    private readonly authkeyOldPath: string = AUTHKEY_OLD_PATH,
  ) {
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

    // Verify the RSA signature against any loaded public key. Proxmox rotates
    // its ticket-signing authkey (~daily): it moves the live key to
    // authkey.pub.old and writes a fresh authkey.pub. A gateway that only read
    // the key at startup would then 401 every ticket until restarted. So on a
    // miss for an otherwise well-formed, unexpired ticket, re-read the key from
    // disk (mtime-gated + throttled) and retry once before rejecting.
    let valid = this.verifyAgainstLoaded(parsed)
    if (!valid && this.reloadIfRotated())
      valid = this.verifyAgainstLoaded(parsed)
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
      this.pubKeys.push(readFileSync(this.authkeyPath, 'utf8'))
      this.authkeyMtimeMs = statSync(this.authkeyPath).mtimeMs
    }
    catch {
      this.authkeyMtimeMs = 0
      console.error(`[auth] Cannot read ${this.authkeyPath} — PVE ticket verification will fail`)
    }

    try {
      this.pubKeys.push(readFileSync(this.authkeyOldPath, 'utf8'))
    }
    catch {
      // Old key is optional — only exists after key rotation
    }
  }

  /** True if the parsed ticket verifies against any currently-loaded key. */
  private verifyAgainstLoaded(parsed: { plaintext: string, signature: string }): boolean {
    return this.pubKeys.some(key =>
      this.verifySignature(parsed.plaintext, parsed.signature, key),
    )
  }

  /**
   * Reload keys from disk if authkey.pub has rotated since we last read it.
   * Throttled to at most once per RELOAD_CHECK_INTERVAL_MS (a stream of bad
   * tickets can't hammer the FS) and mtime-gated (we only rebuild pubKeys when
   * the file actually changed). Returns true when keys were reloaded, so the
   * caller re-verifies against the fresh set.
   */
  private reloadIfRotated(): boolean {
    const now = Date.now()
    if (now - this.lastReloadCheckMs < RELOAD_CHECK_INTERVAL_MS)
      return false
    this.lastReloadCheckMs = now

    try {
      if (statSync(this.authkeyPath).mtimeMs === this.authkeyMtimeMs)
        return false
    }
    catch {
      // stat failed (key briefly absent mid-rotation) — try a reload anyway.
    }

    this.loadKeys()
    return true
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
