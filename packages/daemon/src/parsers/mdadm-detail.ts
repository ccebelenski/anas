/**
 * Parser for `mdadm --detail --export <dev>` (Epic 11 + AHR).
 *
 * KEY=VALUE output — the structured way to resolve an md array's identity
 * (GT-13). This is how ANAS matches arrays: kernel `mdNNN` numbers reshuffle
 * across operations and reboots, and even the `/dev/md/<name>` symlink is
 * unstable (GT-3: `ahr0-r2` after hotplug assembly, `anas-pve:ahr0-r1` —
 * homehost-prefixed — after a clean boot). Only MD_UUID and the superblock
 * name are stable; {@link stripHomehost} + {@link matchAhrArrayName} normalize
 * both observed name forms to the AHR `<pool>-r<band>` convention.
 *
 * Export deliberately lacks per-member STATE (only ROLE/DEV) — member health
 * comes from /proc/mdstat flags (see parsers/mdstat.ts).
 */

/** Args for `mdadm` to export one array's detail as KEY=VALUE. */
export function mdadmDetailExportArgs(device: string): string[] {
  return ['--detail', '--export', device]
}

/** One member from the MD_DEVICE_<token>_ROLE/_DEV key pairs. */
export interface MdadmExportMember {
  /** Member device path, e.g. "/dev/sdc1". */
  dev: string
  /** Raid role: a numeric string, or "spare". */
  role: string
}

/** Structured view of one `--detail --export` block. Absent keys are null. */
export interface MdadmDetailExport {
  /** MD_LEVEL, e.g. "raid5". */
  level: string | null
  /** MD_DEVICES — configured raid device count. */
  devices: number | null
  /** MD_METADATA, e.g. "1.2". */
  metadata: string | null
  /** MD_UUID — the stable array identity. */
  uuid: string | null
  /** MD_DEVNAME — the /dev/md/<name> assembly name (unstable, GT-3). */
  devName: string | null
  /** MD_NAME — superblock name, possibly homehost-prefixed (GT-3). */
  name: string | null
  members: MdadmExportMember[]
}

const KV_RE = /^(\w+)=(.*)$/
const MEMBER_KEY_RE = /^MD_DEVICE_(.+)_(ROLE|DEV)$/

/**
 * Parse `mdadm --detail --export` KEY=VALUE output. Tolerant: unknown keys are
 * ignored, missing keys yield nulls, and partial output (e.g. a grep-filtered
 * capture) still parses — proven against the stage-0 fixtures.
 */
export function parseMdadmDetailExport(text: string): MdadmDetailExport {
  const out: MdadmDetailExport = {
    level: null,
    devices: null,
    metadata: null,
    uuid: null,
    devName: null,
    name: null,
    members: [],
  }
  // token → partial member, paired across the _ROLE and _DEV keys.
  const memberParts = new Map<string, { dev?: string, role?: string }>()

  for (const line of text.split('\n')) {
    const kv = line.trim().match(KV_RE)
    if (!kv)
      continue
    const [, key, value] = kv

    const memberKey = key.match(MEMBER_KEY_RE)
    if (memberKey) {
      const entry = memberParts.get(memberKey[1]) ?? {}
      if (memberKey[2] === 'ROLE')
        entry.role = value
      else entry.dev = value
      memberParts.set(memberKey[1], entry)
      continue
    }

    switch (key) {
      case 'MD_LEVEL':
        out.level = value
        break
      case 'MD_DEVICES': {
        const n = Number.parseInt(value, 10)
        out.devices = Number.isNaN(n) ? null : n
        break
      }
      case 'MD_METADATA':
        out.metadata = value
        break
      case 'MD_UUID':
        out.uuid = value
        break
      case 'MD_DEVNAME':
        out.devName = value
        break
      case 'MD_NAME':
        out.name = value
        break
    }
  }

  for (const [, entry] of memberParts) {
    if (entry.dev)
      out.members.push({ dev: entry.dev, role: entry.role ?? '' })
  }
  return out
}

/**
 * Strip an optional `homehost:` prefix from a superblock name (GT-3):
 * `anas-pve:ahr0-r1` → `ahr0-r1`; a name without a prefix passes through.
 * md names cannot contain `:`, so everything before the first colon is the
 * homehost.
 */
export function stripHomehost(name: string): string {
  const colon = name.indexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}

/** An AHR array name decomposed into its pool + band. */
export interface AhrArrayName {
  pool: string
  band: number
}

/** The deterministic AHR array naming convention: `<pool>-r<band>` (§2.6). */
const AHR_NAME_RE = /^([a-z][\w-]*)-r([1-9]\d*)$/i

/**
 * Match a (homehost-tolerant) array name against the AHR `<pool>-r<N>`
 * convention. Returns null for foreign/non-AHR arrays — those are simply not
 * ANAS's to manage (guest philosophy).
 */
export function matchAhrArrayName(name: string): AhrArrayName | null {
  const m = stripHomehost(name).match(AHR_NAME_RE)
  if (!m)
    return null
  return { pool: m[1], band: Number.parseInt(m[2], 10) }
}
