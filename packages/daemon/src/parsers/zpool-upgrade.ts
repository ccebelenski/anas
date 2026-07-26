/**
 * Parser for `zpool upgrade` (no args) output.
 *
 * `zpool upgrade` has NO structured/JSON mode across supported OpenZFS versions,
 * so a text parse is the only option here (documented deviation from "prefer
 * structured output" — there is none). We extract the set of pool names that
 * have supported-but-disabled features — the pools for which a `zpool upgrade
 * <pool>` would actually do something. Used to availability-gate the UI's
 * Upgrade action.
 *
 * The relevant section looks like:
 *
 *     This system supports ZFS pool feature flags.
 *
 *     All pools are formatted using feature flags.
 *
 *
 *     Some supported features are not enabled on the following pools. Once this
 *     is done, the pool may become incompatible with software that does not
 *     support the features. See zpool-features(7) for details.
 *
 *     POOL  FEATURE
 *     ---------------
 *     tank
 *           hole_birth
 *           embedded_data
 *     pond
 *           large_blocks
 *
 * Pool names sit at column 0 (no leading whitespace) as a single token; feature
 * names are indented beneath each. When every pool is fully upgraded the section
 * is absent (instead: "Every feature flags pool has all supported and requested
 * features enabled.") and this returns an empty set.
 *
 * Fail-open: anything we cannot positively parse yields an empty set, so the UI
 * simply does not gate on it rather than breaking.
 */

/** The "there are pools to upgrade" section marker. */
const NOT_ENABLED_MARKER = /not enabled on the following pools/i
/** A column-0 pool-name line: a single non-whitespace token. */
const POOL_NAME_RE = /^\S+$/
/** The table's dashes separator line. */
const DASHES_RE = /^-+$/
/** The "POOL  FEATURE" table header. */
const HEADER_RE = /^POOL\s+FEATURE\b/
const TRAILING_CR_RE = /\r$/
const LEADING_WS_RE = /^\s/

/**
 * Parse `zpool upgrade` (no args) into the set of pool names that have
 * supported-but-disabled features. Empty when all pools are fully upgraded or
 * the output is unrecognizable.
 */
export function parseZpoolUpgrade(stdout: string): Set<string> {
  const pools = new Set<string>()
  if (!stdout || !NOT_ENABLED_MARKER.test(stdout))
    return pools

  const lines = stdout.split('\n')

  // Only start collecting once we're past the section marker: earlier
  // paragraphs ("This system supports…") are multi-token sentences and would
  // be rejected by POOL_NAME_RE anyway, but keying off the marker is explicit.
  let inSection = false
  for (const raw of lines) {
    const line = raw.replace(TRAILING_CR_RE, '')
    if (!inSection) {
      if (NOT_ENABLED_MARKER.test(line))
        inSection = true
      continue
    }
    // Indented lines are feature names; skip. Blank lines, the table header
    // and the dashes separator are structural; skip. What remains at column 0
    // as a single bare token is a pool name.
    if (line.length === 0 || LEADING_WS_RE.test(line))
      continue
    if (HEADER_RE.test(line) || DASHES_RE.test(line))
      continue
    if (POOL_NAME_RE.test(line))
      pools.add(line)
  }

  return pools
}
