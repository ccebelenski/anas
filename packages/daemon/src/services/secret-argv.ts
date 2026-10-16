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
 *    that echoed a secret back instead of carrying it on argv: replaces every
 *    spelling of every in-scope value a tool can print ({@link secretForms})
 *    in a result string with the literal `[secret]`, so a secret still never
 *    rides in a reply.
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
 * A value is masked in EVERY form a tool can echo it back in (cr.48e widened
 * the set, cr.55 widened it to the spellings Go tools print — rclone and pbc's
 * HTTP layers are Go): {@link secretForms} lists them — the plain value, its
 * `encodeURIComponent` form, the `+`-for-space form of that encoding, Go's
 * `url.QueryEscape` form, the bodies of Go's `%q` quoting and of a JSON string
 * (Go's HTML-safe `json.Marshal` and the plain escape), each of them for the
 * stored value AND its two Unicode normalisations when those differ. Values
 * are matched LONGEST FIRST, so a secret value that contains another is masked
 * whole. A value (or form) SHORTER than 4 characters is not masked: replacing
 * so short a string would shred ordinary text (it could be any word). Empty
 * values cannot match anything and are ignored.
 *
 * OUT OF SCOPE, recorded: the BASE64 form. A tool does not echo a credential
 * base64-encoded in an error line — the forms above are what rclone, pbc and
 * the HTTP layer actually print. Also recorded: the secret schemas
 * (`BackupRepoWrite.secret` and `BackupRepoTestRequest.secret`,
 * shared/schemas/backup.ts) set NO minimum length, so a 3-character secret
 * rides through unmasked — widening the mask below 4 characters would shred
 * ordinary text, and shortening a credential is the operator's call, not ours
 * (operator ruling 2026-10-16, "secret minimum length — not ANAS's to
 * enforce"). The converse is recorded too (review 2026-10-16 L6, cr.55): a
 * secret that is an ordinary WORD (`copy`) is still masked, so the masked line
 * ("Failed to [secret]: 403 Forbidden") lets a reader guess it from the
 * context. The mask keeps masking it — printing the value is strictly worse
 * than a guessable gap — and the cure the review names (a minimum length on
 * the secret schemas) is the one the same ruling closed.
 *
 * The verdict classifiers never see the masked text — the classification runs
 * on the RAW output and only what leaves in the result is masked.
 */
export function maskSecretValues(text: string, secretValues: string[]): string {
  const forms = new Set<string>()
  for (const value of secretValues) {
    for (const form of secretForms(value))
      forms.add(form)
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

/** The 4-character floor of {@link maskSecretValues}, checked PER FORM. */
const MASK_FLOOR = 4

/** The characters `encodeURIComponent` leaves bare and Go's `url.QueryEscape` escapes. */
const QUERY_ESCAPE_EXTRA_RE = /[!'()*]/g

/** What Go's `json.Marshal` (HTML-safe by default) escapes beyond a plain JSON escape. */
const GO_JSON_HTML_RE = /[<>&\u2028\u2029]/g

/**
 * Every spelling of `value` the mask replaces (exported for the tests that pin
 * each form). The floor is checked per form: an eligible plain value's encoded
 * forms are always at least as long (encoding never shrinks), but a NORMALISED
 * form can be shorter than the value (NFC composes). A value under the floor
 * yields nothing at all — its forms are not a way around the floor.
 *
 *  - the stored value, and its `normalize('NFC')` / `normalize('NFD')` forms
 *    when they differ (a tool that round-trips the credential through a
 *    normalising layer prints bytes that never match the stored string);
 *  - for each of those: `encodeURIComponent` (rclone and pbc echo URLs, where
 *    the value is percent-encoded); the same with `%20` as `+` (the
 *    application/x-www-form-urlencoded spelling a tool echoes when it prints
 *    the request body it was handed); Go's `url.QueryEscape` (cr.55, L6 —
 *    `encodeURIComponent` leaves `!'()*` bare where Go escapes them, and Go
 *    writes space as `+`: `p@ss!w0rd(x)` prints `p%40ss%21w0rd%28x%29`); the
 *    BODY of Go's `%q` / `strconv.Quote` (cr.55, L6 — `"` and `\` backslashed,
 *    control characters as `\n`-style or `\xHH` escapes: a Go error that
 *    quotes the value prints `"ab\"cd\\ef9"`, whose body never matches the
 *    stored `ab"cd\ef9`); and the BODY of a JSON string, both as JavaScript
 *    escapes it and as Go's `json.Marshal` does (which also writes `<`, `>`,
 *    `&`, U+2028 and U+2029 as `\u003c`-style escapes) — rclone's
 *    `--use-json-log` puts every message inside a JSON string.
 */
export function secretForms(value: string): string[] {
  if (value === '' || value.length < MASK_FLOOR)
    return []
  const bases = [value]
  for (const normalised of [value.normalize('NFC'), value.normalize('NFD')]) {
    if (!bases.includes(normalised))
      bases.push(normalised)
  }
  const forms = new Set<string>()
  for (const base of bases) {
    forms.add(base)
    let encoded: string
    try {
      encoded = encodeURIComponent(base)
    }
    catch {
      encoded = base // a lone surrogate in a stored value masks nothing extra
    }
    forms.add(encoded)
    // The form-urlencoded spelling: the same encoding, space as `+`.
    forms.add(encoded.split('%20').join('+'))
    // Go's url.QueryEscape: everything but [A-Za-z0-9-_.~] escaped, space `+`.
    forms.add(encoded.replace(QUERY_ESCAPE_EXTRA_RE, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).split('%20').join('+'))
    forms.add(goQuoteBody(base))
    const json = JSON.stringify(base).slice(1, -1)
    forms.add(json)
    forms.add(json.replace(GO_JSON_HTML_RE, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))
  }
  return [...forms].filter(f => f.length >= MASK_FLOOR)
}

/** Go's `strconv.Quote` short escapes, by character. */
const GO_QUOTE_SHORT: Record<string, string> = {
  '\x07': '\\a',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
  '"': '\\"',
  '\\': '\\\\',
}

/**
 * The body of Go's `strconv.Quote(value)` (what `%q` prints between its
 * quotes) for the characters a stored credential can hold: the short escapes,
 * `\xHH` for any other ASCII control character, every other character — ASCII
 * or printable Unicode — as itself.
 */
function goQuoteBody(value: string): string {
  let out = ''
  for (const ch of value) {
    const short = GO_QUOTE_SHORT[ch]
    if (short !== undefined)
      out += short
    // An ASCII control character (or DEL) with no short escape: `\xHH`.
    else if (ch.charCodeAt(0) < 0x20 || ch === '\x7F')
      out += `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
    else
      out += ch
  }
  return out
}

/** Every character a RegExp literal could interpret — escaped by {@link escapeRegExp}. */
const REGEX_METACHARS_RE = /[.*+?^${}()|[\]\\]/g

/** Escape every character a RegExp literal could interpret, verbatim. */
function escapeRegExp(s: string): string {
  return s.replace(REGEX_METACHARS_RE, '\\$&')
}
