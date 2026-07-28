/**
 * Parser + comparator for the LOCAL OpenZFS version (`zfs version`).
 *
 * Modelled on the REMOTE detector in routes/replication-remotes.ts (which runs
 * `zfs --version` over ssh) but for the node ANAS runs on — a plain execFile of
 * `zfs version`. Used to gate RAIDZ EXPANSION, which landed in OpenZFS 2.3.0
 * (story 3.31). Mirror-attach and replace are NOT version-gated.
 *
 * `zfs version` prints two lines:
 *
 *     zfs-2.3.1-1
 *     zfs-kmod-2.3.1-1
 *
 * The first (userland) line is preferred; on PVE the two match. Fail-soft:
 * anything unparseable yields null and the caller treats the node as unsupported.
 */

/** A parsed OpenZFS version triple. */
export interface ZfsVersion {
  /** Normalized "major.minor.patch", e.g. "2.3.1". */
  raw: string
  major: number
  minor: number
  patch: number
}

const ZFS_VERSION_RE = /zfs-(?:kmod-)?(\d+)\.(\d+)\.(\d+)/

/** Parse `zfs version` stdout into a version triple, or null if unrecognizable. */
export function parseZfsVersion(stdout: string): ZfsVersion | null {
  for (const line of stdout.split('\n')) {
    const m = line.match(ZFS_VERSION_RE)
    if (m) {
      const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
      return { raw: `${major}.${minor}.${patch}`, major, minor, patch }
    }
  }
  return null
}

/**
 * Whether an OpenZFS version supports RAIDZ expansion — i.e. is ≥ 2.3.0. Patch
 * level is irrelevant to the 2.3.0 boundary. A null version (undetectable) is
 * treated as unsupported.
 */
export function supportsRaidzExpansion(v: ZfsVersion | null): boolean {
  if (!v)
    return false
  if (v.major !== 2)
    return v.major > 2
  return v.minor >= 3
}
