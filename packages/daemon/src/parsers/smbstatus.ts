/**
 * Parser for `smbstatus` output → live SMB connections per share.
 *
 * Prefer `smbstatus --json` (Samba 4.15+, Principle 13 — structured output);
 * fall back to the classic text listing when JSON is unavailable. Both yield a
 * map of share (service) name → SmbConnection[], where a connection is a
 * `{ user, machine }` pair (one per tree-connect to that share).
 */

import type { SmbConnection } from '@anas/shared'

/** "ipv4:1.2.3.4:port" / "ipv6:[::1]:445" → capture the address portion. */
const MACHINE_RE = /^ipv[46]:(.+?)(?::\d+)?$/
/** Surrounding brackets on an IPv6 address. */
const BRACKETS_RE = /^\[|\]$/g
/** Header row of the `smbstatus -S` connected-services table. */
const SERVICE_HEADER_RE = /^Service\s+pid\s+/i
/** A service row: `<service>  <pid>  <machine> ...`. */
const SERVICE_ROW_RE = /^(\S+)\s+\d+\s+(\S+)/

/** `smbstatus --json` (subset we consume). */
interface SmbStatusJson {
  sessions?: Record<string, {
    username?: string
    remote_machine?: string
    hostname?: string
  }>
  tcons?: Record<string, {
    service?: string
    session_id?: string
    machine?: string
  }>
}

/** Strip an `smbstatus` "ipv4:1.2.3.4:port" hostname down to the address. */
function cleanMachine(value: string | undefined): string {
  if (!value)
    return ''
  // hostname forms: "ipv4:10.0.0.5:49610", "ipv6:[::1]:445", or a bare host.
  const m = MACHINE_RE.exec(value)
  if (m)
    return m[1].replace(BRACKETS_RE, '')
  return value
}

/**
 * Parse `smbstatus --json` into a map of service name → connections. Each tree
 * connection (`tcon`) is one connection to its `service`; the user comes from
 * the linked session (falling back to 'guest' when unresolved).
 */
export function parseSmbStatusJson(stdout: string): Record<string, SmbConnection[]> {
  const data = JSON.parse(stdout) as SmbStatusJson
  const byService: Record<string, SmbConnection[]> = {}

  for (const tcon of Object.values(data.tcons ?? {})) {
    const service = tcon.service
    if (!service || service === 'IPC$')
      continue
    const session = tcon.session_id ? data.sessions?.[tcon.session_id] : undefined
    const user = session?.username || 'guest'
    const machine = cleanMachine(tcon.machine || session?.remote_machine || session?.hostname)
    const list = byService[service] ??= []
    list.push({ user, machine })
  }

  return byService
}

/**
 * Parse the classic `smbstatus -S` (connected services) text block as a
 * fallback. Columns: `Service  pid  Machine  Connected at ...`. The user is not
 * present in this listing, so it is reported as 'guest' (best effort — the JSON
 * path is preferred whenever Samba supports it).
 */
export function parseSmbStatusText(stdout: string): Record<string, SmbConnection[]> {
  const byService: Record<string, SmbConnection[]> = {}
  let inServices = false

  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd()
    if (SERVICE_HEADER_RE.test(line)) {
      inServices = true
      continue
    }
    if (!inServices)
      continue
    if (line.startsWith('---') || line.trim() === '')
      continue
    // "media   12345   10.0.0.5   Mon Jul 13 ..." → service, pid, machine.
    const m = SERVICE_ROW_RE.exec(line)
    if (!m)
      continue
    const service = m[1]
    if (service === 'IPC$')
      continue
    const list = byService[service] ??= []
    list.push({ user: 'guest', machine: cleanMachine(m[2]) })
  }

  return byService
}
