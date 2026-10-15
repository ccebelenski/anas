import type { Privilege } from './types.js'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { PRIVILEGES } from './types.js'

/**
 * The hand-off from pveproxy to the gateway (cr.27, docs/WAVE2-DESIGN.md A2.1).
 *
 * AnasProxy.pm, inside pveproxy, asks PVE who the user is (its own
 * `auth_handler`: ticket, user enabled, TFA, CSRF on every method but GET) and
 * which of Sys.Audit / Sys.Modify PVE grants on `/` (`$rpcenv->check`), then
 * states the answer in this header, signed with the key this gateway wrote at
 * startup (proxy-key.ts):
 *
 *   X-Anas-Auth: v1;user=<userid>;privs=<Sys.Audit,Sys.Modify|Sys.Audit|>;ts=<epoch>;mac=<hex>
 *
 *   mac = HMAC-SHA256(key, "v1\n<user>\n<privs>\n<ts>\n<METHOD>\n<path?query>")
 *
 * over the fields exactly as sent (the user id percent-encoded, so a `;` or
 * `,` in a PVE user name cannot split the header) and the request-target the
 * gateway received. The gateway listens on loopback, where any local uid can
 * reach it (F11), so it believes nothing that does not carry this MAC.
 */
export const ASSERTION_HEADER = 'x-anas-auth'

/** |now − ts| may be at most this many seconds. */
export const ASSERTION_MAX_SKEW_S = 30

const VERSION = 'v1'
const ASSERTION_RE = /^v1;user=([\w.~@!%-]+);privs=([\w.,]*);ts=(\d{1,12});mac=([0-9a-f]{64})$/
/** The bytes AnasProxy's _escape_field leaves as they are. */
const UNRESERVED_RE = /[\w.~@!-]/
const HEX2_RE = /^[0-9A-F]{2}$/i

function mac(key: Buffer, user: string, privs: string, ts: string, method: string, path: string): Buffer {
  return createHmac('sha256', key)
    .update([VERSION, user, privs, ts, method, path].join('\n'), 'utf8')
    .digest()
}

/** Percent-encode the user id's UTF-8 bytes as AnasProxy's _escape_field does. */
function escapeUser(userid: string): string {
  let out = ''
  for (const byte of Buffer.from(userid, 'utf8')) {
    const c = String.fromCharCode(byte)
    out += UNRESERVED_RE.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** Decode a percent-encoded user field to a UTF-8 string; undefined if malformed. */
function unescapeUser(field: string): string | undefined {
  const bytes: number[] = []
  for (let i = 0; i < field.length; i++) {
    const c = field[i]!
    if (c === '%') {
      const hex = field.slice(i + 1, i + 3)
      if (!HEX2_RE.test(hex))
        return undefined
      bytes.push(Number.parseInt(hex, 16))
      i += 2
    }
    else {
      bytes.push(c.charCodeAt(0))
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))
  }
  catch {
    return undefined
  }
}

/**
 * Sign an assertion — what AnasProxy.pm does. The gateway never signs on the
 * request path; this exists so the tests can speak the protocol (and the
 * known-answer vectors in packages/pve-integration/perl/t/fixtures prove the
 * two implementations agree).
 */
export function signAssertion(key: Buffer, a: {
  userid: string
  privileges: readonly Privilege[]
  ts: number
  method: string
  path: string
}): string {
  const user = escapeUser(a.userid)
  const privs = a.privileges.join(',')
  const ts = String(a.ts)
  const m = mac(key, user, privs, ts, a.method, a.path).toString('hex')
  return `${VERSION};user=${user};privs=${privs};ts=${ts};mac=${m}`
}

export type VerifyResult
  = | { ok: true, userid: string, privileges: Privilege[] }
    | { ok: false, reason: string }

/**
 * Verify an assertion against the request the gateway received. Every failure
 * names which check failed (for the log; the client gets one sentence).
 */
export function verifyAssertion(
  key: Buffer,
  header: string | string[] | undefined,
  request: { method: string, path: string, nowS: number },
): VerifyResult {
  if (header === undefined)
    return { ok: false, reason: 'no proxy assertion' }
  if (Array.isArray(header))
    return { ok: false, reason: 'more than one proxy assertion' }
  if (!header.startsWith(`${VERSION};`))
    return { ok: false, reason: 'unsupported or malformed proxy assertion version' }
  const m = header.match(ASSERTION_RE)
  if (!m)
    return { ok: false, reason: 'malformed proxy assertion' }
  const [, user, privs, ts, sent] = m as unknown as [string, string, string, string, string]

  const skew = request.nowS - Number(ts)
  if (Math.abs(skew) > ASSERTION_MAX_SKEW_S)
    return { ok: false, reason: `stale proxy assertion (ts is ${skew} s from now, limit ${ASSERTION_MAX_SKEW_S} s)` }

  const want = mac(key, user, privs, ts, request.method, request.path)
  const got = Buffer.from(sent, 'hex')
  if (got.length !== want.length || !timingSafeEqual(got, want))
    return { ok: false, reason: 'bad proxy assertion MAC (forged, tampered, or signed for another method or path)' }

  const userid = unescapeUser(user)
  if (userid === undefined || userid === '')
    return { ok: false, reason: 'proxy assertion carries an undecodable user id' }

  const list = privs === '' ? [] : privs.split(',')
  const privileges: Privilege[] = []
  for (const p of list) {
    if (!(PRIVILEGES as readonly string[]).includes(p) || privileges.includes(p as Privilege))
      return { ok: false, reason: `proxy assertion carries an unknown or repeated privilege '${p}'` }
    privileges.push(p as Privilege)
  }
  return { ok: true, userid, privileges }
}
