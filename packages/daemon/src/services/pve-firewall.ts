/**
 * PVE firewall — READ ONLY (story `iscsi.6`).
 *
 * A portal can bind perfectly, listen in `ss -lntp`, and still be unreachable
 * because `pve-firewall` is dropping 3260/tcp. LIO cannot tell anyone that (it
 * will not even tell you a portal's ADDRESS is gone — GT-24), and the operator
 * has no reason to suspect the firewall while the target looks healthy in every
 * ANAS screen. So ANAS looks, and says one line.
 *
 * It says it and nothing more. PVE territory is read-only and hands-off
 * (§2 standing ruling, story 3.25/18): `/etc/pve/firewall/*.fw` is parsed,
 * NEVER written, and no "fix it for me" button will ever exist here — a
 * firewall rule is the one thing on a Proxmox node that is unambiguously the
 * administrator's, and ANAS adding one silently would be indefensible.
 *
 * FAIL-OPEN in both directions, and asymmetrically so:
 *
 *   - `enabled: null` — the check could not run (`pve-firewall` absent, exec
 *     failure). No advisory: a node without PVE's firewall must never be told
 *     it has a firewall problem.
 *   - `admits3260: null` — the status is known but the RULES could not be read
 *     (no `.fw` file readable, a parse failure). No advisory either: "I could
 *     not read your rules" is not evidence that a rule is missing.
 *
 * The advisory is raised on exactly one POSITIVE state: enabled, rules readable,
 * and nothing in them admits 3260/tcp inbound.
 *
 * Ground truth (stunt node, 2026-08-25, read-only capture):
 *
 *   # pve-firewall status
 *   Status: disabled/running
 *
 * — one line, `<enabled|disabled>/<running|stopped>`, exit 0 either way. The
 * node's `/etc/pve/firewall/` was an EMPTY directory (no `cluster.fw`, no
 * `host.fw`), which is the stock state and reads as "no rules". The firewall was
 * never enabled there (GT open question 5), so the enabled-side behaviour is
 * proven against synthetic `.fw` fixtures and owes a live proof in `iscsi.7`.
 */

import type { IscsiFirewallAdvisory } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** `pve-firewall` on a PVE node. */
export const PVE_FIREWALL = '/usr/sbin/pve-firewall'

/** Where PVE keeps its firewall config (pmxcfs; cluster-wide). */
export const PVE_FIREWALL_DIR = '/etc/pve/firewall'

/** The iSCSI well-known port. */
export const ISCSI_PORT = 3260

/** `Status: enabled/running` — the word before the slash is the answer. */
const STATUS_RE = /^\s*Status:\s*([a-z]+)\b/im

/** A section header: `[RULES]`, `[OPTIONS]`, `[group foo]`, `[IPSET x]`. */
const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/

/** `enable: 1` inside an `[OPTIONS]` section. */
const ENABLE_RE = /^\s*enable:\s*(\d+)\s*$/i

/** `-dport 3260` / `--dport 3260:3270` / `-dport 22,3260`. */
const DPORT_RE = /(?:^|\s)--?dport\s+(\S+)/i

/** Whitespace splitter for a rule line's tokens. */
const WHITESPACE_RE = /\s+/

/** `-macro NAME` — a port restriction ANAS deliberately does not expand. */
const MACRO_RE = /(?:^|\s)--?macro\s+\S+/i

/** `-p tcp` / `-proto tcp`. */
const PROTO_RE = /(?:^|\s)--?(?:p|proto)\s+(\S+)/i

/** A numeric port or a `low:high` range token inside a `-dport` list. */
const PORT_RANGE_RE = /^(\d+)(?::(\d+))?$/

/**
 * Does a `-dport` VALUE cover `port`? PVE passes the value through to
 * iptables/nftables, so it can be a single port, a comma list, or a `low:high`
 * range — and it can also be a service NAME (`ssh`). A name is never matched:
 * there is no name for 3260 in `/etc/services` on a stock Debian, and guessing
 * would produce a false "you are fine".
 */
export function dportCoversPort(value: string, port: number): boolean {
  for (const token of value.split(',')) {
    const m = token.trim().match(PORT_RANGE_RE)
    if (!m)
      continue
    const low = Number(m[1])
    const high = m[2] === undefined ? low : Number(m[2])
    if (port >= low && port <= high)
      return true
  }
  return false
}

/**
 * Does one `.fw` rule line admit `port`/tcp inbound?
 *
 * Requirements, all of them: it is an `IN` rule, its action is `ACCEPT`, its
 * protocol is tcp (or unstated — an ACCEPT with no `-p` admits every protocol),
 * and its `-dport` covers the port. A rule with NO `-dport` at all is an
 * accept-everything rule and counts.
 *
 * Deliberately narrow on three counts. A MACRO rule is never expanded — PVE
 * writes those as `IN SSH(ACCEPT) -source …`, whose action token is not a bare
 * `ACCEPT`, and ANAS carries no copy of PVE's macro table (a stale copy would
 * lie); an explicit `-macro` on an otherwise bare ACCEPT is refused for the same
 * reason, because such a rule is port-RESTRICTED and reading it as
 * accept-everything would be the dangerous direction. And a disabled rule
 * (`|IN ACCEPT …`, PVE's leading-pipe form) is skipped. Every one of those can
 * only ever cause a FALSE advisory ("no rule admits it" when one does), which is
 * the harmless direction: the advisory says "add one in PVE", and an operator
 * who already has one will see that they do.
 */
export function ruleAdmitsPort(line: string, port: number): boolean {
  const text = line.trim()
  if (text.length === 0 || text.startsWith('#') || text.startsWith('|'))
    return false
  const words = text.split(WHITESPACE_RE)
  if (words[0]?.toUpperCase() !== 'IN' || words[1]?.toUpperCase() !== 'ACCEPT')
    return false
  const proto = text.match(PROTO_RE)?.[1]?.toLowerCase()
  if (proto !== undefined && proto !== 'tcp')
    return false
  const dport = text.match(DPORT_RE)?.[1]
  if (dport === undefined) {
    // A bare ACCEPT admits everything; one carrying a macro does NOT — the
    // macro is the port restriction, and ANAS cannot read it.
    return !MACRO_RE.test(text)
  }
  return dportCoversPort(dport, port)
}

/** The `[RULES]` lines of a `.fw` file (section-aware; other sections ignored). */
export function rulesSection(text: string): string[] {
  const out: string[] = []
  let inRules = false
  for (const line of text.split('\n')) {
    const section = line.match(SECTION_RE)
    if (section) {
      inRules = section[1].trim().toUpperCase() === 'RULES'
      continue
    }
    if (inRules)
      out.push(line)
  }
  return out
}

/** `[OPTIONS] enable: 1` — PVE's own on/off switch, or null when unstated. */
export function optionsEnable(text: string): boolean | null {
  let inOptions = false
  for (const line of text.split('\n')) {
    const section = line.match(SECTION_RE)
    if (section) {
      inOptions = section[1].trim().toUpperCase() === 'OPTIONS'
      continue
    }
    if (!inOptions)
      continue
    const m = line.match(ENABLE_RE)
    if (m)
      return m[1] !== '0'
  }
  return null
}

/** `Status: enabled/running` → true; `disabled/…` → false; anything else null. */
export function parseFirewallStatus(stdout: string): boolean | null {
  const m = stdout.match(STATUS_RE)
  if (!m)
    return null
  const word = m[1].toLowerCase()
  if (word === 'enabled')
    return true
  if (word === 'disabled')
    return false
  return null
}

export interface PveFirewallOptions {
  /** `/etc/pve/firewall` override — the tests point it at a temp dir. */
  firewallDir?: string
}

/** Read one `.fw` file; null when it is not there or cannot be read. */
async function readFw(dir: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(dir, name), 'utf-8')
  }
  catch {
    return null
  }
}

/**
 * The advisory for this node. Reads `pve-firewall status` and, when the
 * firewall is on, `cluster.fw` + `host.fw` for a rule admitting 3260/tcp.
 *
 * `cluster.fw`'s `[OPTIONS] enable:` is consulted only as a FALLBACK for the
 * status command (a node where `pve-firewall` is not installed at all has no
 * firewall, and a `.fw` file alone does not create one).
 */
export async function readPveFirewallAdvisory(
  executor: CommandExecutor,
  opts: PveFirewallOptions = {},
): Promise<IscsiFirewallAdvisory> {
  const dir = opts.firewallDir ?? PVE_FIREWALL_DIR
  let enabled: boolean | null = null
  try {
    const r = await executor.exec(PVE_FIREWALL, ['status'])
    if (r.exitCode === 0)
      enabled = parseFirewallStatus(r.stdout)
  }
  catch {
    enabled = null
  }

  const clusterText = await readFw(dir, 'cluster.fw')
  if (enabled === null && clusterText !== null)
    enabled = optionsEnable(clusterText)

  if (enabled !== true)
    return { enabled, admits3260: null, advisory: null }

  const hostText = await readFw(dir, 'host.fw')
  if (clusterText === null && hostText === null) {
    // Enabled, but nothing readable to judge the rules by. Say nothing —
    // "I could not read your rules" is not "you have no rule".
    return { enabled: true, admits3260: null, advisory: null }
  }

  const lines = [
    ...(clusterText === null ? [] : rulesSection(clusterText)),
    ...(hostText === null ? [] : rulesSection(hostText)),
  ]
  const admits = lines.some(line => ruleAdmitsPort(line, ISCSI_PORT))
  return {
    enabled: true,
    admits3260: admits,
    advisory: admits
      ? null
      : `PVE firewall is enabled and no rule admits ${ISCSI_PORT}/tcp — add one in PVE (Datacenter or Node → Firewall); ANAS never edits firewall rules.`,
  }
}
