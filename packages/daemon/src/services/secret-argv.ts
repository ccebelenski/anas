/**
 * The executor-side argv-secret guard — ONE module, ONE error, two checks.
 *
 * A secret on argv is visible in `ps` to every local user (the iSCSI CHAP
 * ruling, docs/ISCSI-GROUND-TRUTH.md GT-35; rclone's own config verbs take
 * input only as an argv string, GT 2026-09-23). So ANAS never puts a secret
 * value on a command line, and the refusal below is the executor-side
 * backstop that makes the rule structural instead of a comment.
 *
 * Both checks throw the one {@link SecretOnArgvError}, and its message names
 * the matched PARAMETER — or nothing — never a token: a matching token
 * carries the secret itself, and the refusal must not become the leak.
 *
 *  - {@link assertNoSecretArgs} — the token-SHAPE check (from iscsi-mutate):
 *    an argv token matching a pattern (today the `password=`-style targetcli
 *    parameters) is refused whatever value it carries. The caller keeps its
 *    own regex constant and passes it in.
 *  - {@link assertNoSecretValues} — the value-membership check (from
 *    rclone-config): an argv token CONTAINING one of the plain secret values
 *    in scope is refused. The leading `skipLeading` tokens are the caller's
 *    own STATIC argv (ANAS constants — e.g. rclone's `--config <file>`
 *    `--ask-password=false` base, where a small secret value like `false` or
 *    a path letter may legally match) and are never checked; only the
 *    dynamic tail is.
 *  - {@link maskSecretValues} — the OUTPUT-side mirror (cr.48b), for a child
 *    that echoed a secret back instead of carrying it on argv: replaces the
 *    plain and URL-encoded forms of every in-scope value in a result string
 *    with the literal `[secret]`, so a secret still never rides in a reply.
 *
 * Extracted 2026-09-23 from the two private copies (story rclone.1: "the
 * iscsi-mutate argv guard is reused as the executor-side backstop").
 */

/** Thrown when a command invocation would carry a secret on argv. */
export class SecretOnArgvError extends Error {
  /**
   * `detail` is the matched PARAMETER NAME (e.g. `password`) — never a token
   * and never a value. Absent = the value-membership check, which names
   * nothing at all.
   */
  constructor(detail?: string) {
    super(
      detail !== undefined
        ? `refusing to run the command with '${detail}=' on the command line — a secret must never ride argv`
        : 'refusing to run the command with a secret value on the command line — a secret must never ride argv',
    )
    this.name = 'SecretOnArgvError'
  }
}

/**
 * Throw if any argv token matches the secret parameter SHAPE `patternRe`.
 * The error names the matched parameter (the pattern's first capture, else
 * the match with anything after its first `=` cut off) — never the token.
 *
 * The pattern must match the parameter shape and stop at `=`: a pattern that
 * reaches into the VALUE would put the secret in the refusal.
 */
export function assertNoSecretArgs(args: string[], patternRe: RegExp): void {
  for (const a of args) {
    const m = patternRe.exec(a)
    if (m)
      throw new SecretOnArgvError(m[1] ?? m[0]!.split('=')[0])
  }
}

/**
 * Throw if any DYNAMIC argv token contains one of the plain `secretValues`
 * in scope. `skipLeading` tokens are the caller's static argv (ANAS
 * constants) and are skipped — only the dynamic tail is checked, with
 * `includes` (a secret can ride a joined token like `--pass=x`).
 *
 * Empty values cannot match anything and are ignored.
 */
export function assertNoSecretValues(args: string[], secretValues: string[], skipLeading = 0): void {
  const nonEmpty = secretValues.filter(s => s !== '')
  if (nonEmpty.length === 0)
    return
  for (const a of args.slice(skipLeading)) {
    if (nonEmpty.some(s => a.includes(s)))
      throw new SecretOnArgvError()
  }
}

/**
 * Mask every occurrence of every secret value in `text` with the literal
 * `[secret]` — the OUTPUT-side mirror of {@link assertNoSecretValues}: the argv
 * guard refuses a secret ON a command line, this masks one a child may have
 * ECHOED into its output (cr.48b: a backend that answers a bad credential with
 * the value verbatim, or an rclone/pbc line that echoes the URL it was pointed
 * at). A secret never rides in a reply, whatever a tool answers.
 *
 * Both the plain value and its `encodeURIComponent` form are masked (rclone and
 * pbc echo URLs, where the value is percent-encoded). Values are matched
 * LONGEST FIRST, so a secret value that contains another is masked whole. A
 * value SHORTER than 4 characters is not masked: replacing so short a string
 * would shred ordinary text (it could be any word). Empty values cannot match
 * anything and are ignored.
 *
 * The verdict classifiers never see the masked text — the classification runs
 * on the RAW output and only what leaves in the result is masked.
 */
export function maskSecretValues(text: string, secretValues: string[]): string {
  const forms = new Set<string>()
  for (const value of secretValues) {
    // The 4-character floor guards the plain value; the encoded form of an
    // eligible value is always at least as long (encoding never shrinks).
    if (value === '' || value.length < 4)
      continue
    forms.add(value)
    let encoded: string
    try {
      encoded = encodeURIComponent(value)
    }
    catch {
      encoded = value // a lone surrogate in a stored value masks nothing extra
    }
    if (encoded !== value)
      forms.add(encoded)
  }
  if (forms.size === 0)
    return text
  // eslint-disable-next-line e18e/prefer-array-to-sorted -- toSorted() is ES2023; this package targets ES2022 (no such lib member)
  const longestFirst = [...forms].sort((a, b) => b.length - a.length)
  // The pattern is built from the CALLER'S secret values — any two calls can
  // differ, so it can never live at module scope.
  const pattern = new RegExp(longestFirst.map(escapeRegExp).join('|'), 'g')
  // A function replacement, not a string: `[secret]` has no `$` of its own, but
  // a `$&` in the match must never slip through as a replacement directive.
  return text.replace(pattern, () => '[secret]')
}

/** Every character a RegExp literal could interpret — escaped by {@link escapeRegExp}. */
const REGEX_METACHARS_RE = /[.*+?^${}()|[\]\\]/g

/** Escape every character a RegExp literal could interpret, verbatim. */
function escapeRegExp(s: string): string {
  return s.replace(REGEX_METACHARS_RE, '\\$&')
}
