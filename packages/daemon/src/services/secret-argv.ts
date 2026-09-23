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
