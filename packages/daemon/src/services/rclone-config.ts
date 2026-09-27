/**
 * Cloud sync — remotes (story rclone.1): the ONE rclone.conf module.
 *
 * Remotes live in ANAS's OWN rclone.conf (`/etc/anas/rclone.conf`, 0600 root —
 * DESIGN "Remotes = ANAS's own rclone.conf"). Root's `~/.config/rclone` is
 * never read or written; the anasd unit runs with no `HOME`, so the path is
 * passed on every invocation as `--config <file> --ask-password=false`.
 *
 * Reads go through `rclone config dump` (JSON) — ANAS never parses secret
 * values back out of the file itself. Writes are ANAS's own surgical INI edit
 * (`parsers/rclone-conf.ts`): rclone's config verbs would carry a secret on
 * argv (GT 2026-09-23: the rc verbs take input only as an argv string), so
 * the section is written by hand and rclone reads the file back as the GATE —
 * `config dump` must parse it and list the section, else the PREVIOUS bytes go
 * back (byte-identical rollback, the `testparm` pattern).
 *
 * Secrets: password-TYPED values (rclone's `IsPassword`) are obscured through
 * `rclone obscure -` over STDIN before they touch the file; secrets only by
 * the name rule (s3 `secret_access_key`, b2 `key`) are stored PLAIN — rclone
 * would not reveal an obscured value there. A secret value never enters an
 * argv (guarded by the shared `secret-argv.ts` backstop, the iSCSI ruling),
 * and a secret value is never returned (responses carry `secretsSet` only).
 *
 * A password-PROTECTED (encrypted) config file is reported as a fact
 * (`encrypted: true`) and refuses every mutation (`ConfigEncryptedError` →
 * the route's `409 config-encrypted`) — ANAS neither prompts nor stores the
 * passphrase.
 */

import type { CloudProvider, CloudProviderOption, CloudRemote, CloudRemoteWrite } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { CLOUD_BACKEND_GUIDES, CloudProvider as CloudProviderSchema } from '@anas/shared'
import { z } from 'zod'
import { listSections, parseRcloneConf, removeSection, upsertSection } from '../parsers/rclone-conf.js'
import { withFileLock } from './file-lock.js'
import { assertNoSecretValues } from './secret-argv.js'

// ── The binary, the file, the argv every invocation starts with ────────────

/** The rclone binary (Debian's `rclone` package — a hard dependency). */
export const RCLONE = '/usr/bin/rclone'

/** ANAS's own rclone.conf — env-overridable for tests. */
export function defaultRcloneConfigFile(): string {
  return process.env.ANAS_RCLONE_CONFIG ?? '/etc/anas/rclone.conf'
}

/**
 * The argv prefix of EVERY rclone invocation in this module. The daemon runs
 * with no `HOME`, so the config path is explicit on every call (GT
 * 2026-09-23), and `--ask-password=false` keeps rclone from prompting a
 * daemon (an encrypted file must fail loudly, not hang).
 */
export function rcloneBaseArgs(configFile: string): string[] {
  return ['--config', configFile, '--ask-password=false']
}

/** The paths of the rclone config store — overridable for tests. */
export interface RcloneConfigPaths {
  configFile: string
}

/** Default paths (env-overridable, else the system location). */
export function defaultRcloneConfigPaths(): RcloneConfigPaths {
  return { configFile: defaultRcloneConfigFile() }
}

// ── The secret-key rule ────────────────────────────────────────────────────

/**
 * The generic name rule (DESIGN): a key is secret when its name ends in
 * `pass`, `password`, `secret`, `token` or `key` — the WHOLE key, or a whole
 * suffix at an `_` boundary:
 *
 *   secret:  `key`, `pass`, `password`, `secret_access_key`, `client_secret`,
 *            `token`, `sse_customer_key`, `key_file_pass`
 *   not:     `access_key_id`, `key_file`, `sse_kms_key_id`, `pubkey_file`,
 *            `key_use_agent`
 *
 * rclone 1.60 has no `Sensitive` flag, so this rule stands in for it — it is
 * a heuristic and is stated as one. `option` (when known) makes rclone's own
 * `IsPassword`/secret fact authoritative: `option.secret` wins either way.
 *
 * A BOOL option is never a secret. `sftp.ask_password` and `ftp.ask_password`
 * match the name rule but hold `true`/`false` — hiding those would leave a
 * stored `ask_password = true` neither showable nor clearable in the dialog.
 * rclone's own flag still wins: a bool rclone ever typed as a password (or
 * flagged secret) stays secret.
 */
const SECRET_SUFFIX_RE = /(?:^|_)(?:pass|password|secret|token|key)$/

export function isSecretKey(key: string, option?: Partial<Pick<CloudProviderOption, 'secret' | 'type'>>): boolean {
  if (option?.secret)
    return true
  if (option?.type === 'bool')
    return false
  return SECRET_SUFFIX_RE.test(key)
}

// ── The OAuth token paste ──────────────────────────────────────────────────

/**
 * The refusal sentence for a `token` option that never becomes a JSON object
 * — the same sentence the dialog marks into the field (72-cloud.js). Answered
 * as a 400 at every door that accepts remote options, never rclone's own Go
 * unmarshal error from inside the write or the probe.
 */
export const OAUTH_TOKEN_ERROR
  = 'The token must be the JSON block rclone authorize prints, starting with { and ending with }'

/** A paste carrying one of `rclone authorize`'s marker lines (extraction case). */
const OAUTH_TOKEN_MARKER_RE = /Paste the following|End paste/

/** The result of normalising a pasted `rclone authorize` output. */
export interface NormalizedOAuthToken {
  /** False when the text is not (and cannot be trimmed to) a JSON object. */
  ok: boolean
  /** The text to send — the normalised paste, or '' when nothing was typed. */
  value: string
}

/**
 * Normalise a pasted `rclone authorize` output to the bare JSON object text.
 * `rclone authorize` prints THREE things — a `Paste the following …  --->`
 * marker line, the token JSON object, and `<---End paste` — and a paste of
 * the whole output, or of the object wrapped in the quotes of a JSON-encoded
 * string, fails inside rclone with a Go unmarshal error instead of a sentence
 * (human-pass finding 2026-09-25).
 *
 *   trim; marker lines present ⇒ keep only what lies between them (in
 *   practice the first `{` through the matching last `}`); one pair of double
 *   quotes wrapping a JSON-encoded string is unwrapped ONCE; what remains
 *   must JSON.parse to a PLAIN object — never a string, number or array. The
 *   object's KEYS are the backend's business and are not validated. An EMPTY
 *   value is nothing to validate ('' is the dialog's "(unchanged)" and the
 *   update route's keep-as-stored marker).
 *
 * The same contract the field applies on blur (72-cloud.js
 * `normalizeOAuthToken`) — validate at both boundaries, Principle 6.
 */
export function normalizeOAuthToken(text: string): NormalizedOAuthToken {
  let s = String(text ?? '').trim()
  if (s === '')
    return { ok: true, value: '' }
  if (OAUTH_TOKEN_MARKER_RE.test(s)) {
    const start = s.indexOf('{')
    const end = s.lastIndexOf('}')
    if (start < 0 || end <= start)
      return { ok: false, value: s }
    s = s.slice(start, end + 1).trim()
  }
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const inner: unknown = JSON.parse(s)
      if (typeof inner === 'string')
        s = inner.trim()
    }
    catch {
      // Left as-is; the object check below refuses it.
    }
  }
  let obj: unknown
  try {
    obj = JSON.parse(s)
  }
  catch {
    return { ok: false, value: s }
  }
  const plain = typeof obj === 'object' && obj !== null && !Array.isArray(obj)
  return { ok: plain, value: s }
}

// ── The provider catalogue (rclone config providers) ───────────────────────

/** The raw shape of `rclone config providers` (1.60), per option. */
interface RawProviderOption {
  Name?: string
  Help?: string
  Type?: string
  Required?: boolean
  IsPassword?: boolean
  DefaultStr?: string
  Examples?: { Value?: string, Help?: string, Provider?: string }[]
  Provider?: string
  Advanced?: boolean
  /** 0 = shown in config UIs; anything else = hidden. */
  Hide?: number
}

interface RawProvider {
  Name?: string
  Description?: string
  Options?: RawProviderOption[]
}

/**
 * The parsed JSON of `rclone config providers` → the trimmed catalogue the
 * dialog renders from. The binary prints a BARE JSON list of backends (GT
 * 2026-09-23, v1.60.1 — the fixture is that output verbatim). Per option:
 * `secret = IsPassword || the name rule` (a BOOL option is never secret —
 * `sftp.ask_password`), `password = IsPassword` (the
 * obscure-in-file set — a different fact from `secret`), `default =
 * DefaultStr`, options with `Hide !== 0` dropped (rclone hides `test_mode`-
 * style knobs from config UIs).
 *
 * rclone.4 — the curated backends of the ONE curation table
 * (`@anas/shared` `cloud-guide.ts`) are marked `curated: true` (review batch
 * B: the marker, not a `guide`'s presence — the OAuth backends carry no
 * guide sentence any more, their one instruction being the token sentence the
 * dialog renders with the token field), carry `guide` when the table has one
 * (and `ownClient` when it names fields for a private OAuth client), and
 * each option's `essential` says whether the dialog renders it in the
 * primary section: on a curated backend `essential` is the table's list (the
 * guide sentence, where present, names where those values come from); on an
 * uncurated backend `essential = !advanced` — today's layout, nothing added.
 * A curated name absent from the node's rclone is simply never looked up —
 * the table never invents a backend or an option. The output is validated
 * against the shared schema.
 */
export function trimProviders(raw: unknown): CloudProvider[] {
  if (!Array.isArray(raw))
    throw new Error('rclone config providers: unexpected output shape (not a provider list)')
  const list = raw as RawProvider[]
  const trimmed: CloudProvider[] = list.map(p => ({
    name: String(p.Name ?? ''),
    description: String(p.Description ?? ''),
    options: (Array.isArray(p.Options) ? p.Options : [])
      .filter(o => (o.Hide ?? 0) === 0)
      .map((o) => {
        const name = String(o.Name ?? '')
        const type = String(o.Type ?? '')
        const curatedEntry = CLOUD_BACKEND_GUIDES[String(p.Name ?? '')]
        return {
          name,
          help: String(o.Help ?? ''),
          type,
          required: o.Required === true,
          // The option's own TYPE goes through the rule, so a bool named like
          // a secret (`ask_password`) comes out `secret: false`.
          secret: o.IsPassword === true || isSecretKey(name, { type }),
          password: o.IsPassword === true,
          default: String(o.DefaultStr ?? ''),
          examples: (Array.isArray(o.Examples) ? o.Examples : []).map(e => ({
            value: String(e.Value ?? ''),
            help: String(e.Help ?? ''),
            provider: String(e.Provider ?? ''),
          })),
          provider: String(o.Provider ?? ''),
          advanced: o.Advanced === true,
          // Curated ⇒ the table's essential list; uncurated ⇒ today's
          // behaviour (`!advanced`) — the dialog groups by this one flag.
          essential: curatedEntry
            ? curatedEntry.essential.includes(name)
            : o.Advanced !== true,
        }
      }),
    curated: !!CLOUD_BACKEND_GUIDES[String(p.Name ?? '')],
    guide: CLOUD_BACKEND_GUIDES[String(p.Name ?? '')]?.guide,
    ownClient: CLOUD_BACKEND_GUIDES[String(p.Name ?? '')]?.ownClient,
  }))
  const parsed = z.array(CloudProviderSchema).safeParse(trimmed)
  if (!parsed.success)
    throw new Error(`rclone config providers: trimmed shape failed validation: ${parsed.error.issues[0]?.message}`)
  return parsed.data
}

/** The first option of `type` named `key` (a backend may repeat an option per provider filter). */
export function providerOption(
  providers: CloudProvider[],
  type: string,
  key: string,
): CloudProviderOption | undefined {
  return providers.find(p => p.name === type)?.options.find(o => o.name === key)
}

/** The option names rclone types as PASSWORDS (`IsPassword`) for that type — the obscure-in-file set. */
export function passwordKeysFor(providers: CloudProvider[], type: string): Set<string> {
  return new Set(
    (providers.find(p => p.name === type)?.options ?? [])
      .filter(o => o.password)
      .map(o => o.name),
  )
}

// ── rclone version + config reads ──────────────────────────────────────────

/** rclone's last non-empty output line (stderr first, then stdout). */
function lastOutputLine(result: ExecResult): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
  return lines.at(-1) ?? ''
}

const VERSION_LINE_RE = /^rclone v(\d+(?:\.\d+)*)(?:[-+][0-9A-Za-z.+-]*)?/

/**
 * `rclone version` → the bare version (`rclone v1.60.1-DEV` → `1.60.1`).
 * Throws a plain message when the binary is missing or the output is
 * unrecognised — the route decides how to present it.
 */
export async function rcloneVersion(executor: CommandExecutor): Promise<string> {
  const result = await executor.exec(RCLONE, ['version'])
  if (result.exitCode !== 0)
    throw new Error(`rclone version failed: ${lastOutputLine(result) || `exit ${result.exitCode}`}`)
  const line = result.stdout.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  const m = VERSION_LINE_RE.exec(line)
  if (!m)
    throw new Error(`unrecognized rclone version output: ${line}`)
  return m[1]!
}

/** A password-protected config file's failure signature. */
const ENCRYPTED_CONFIG_RE = /password|encrypted|decrypt/i

/** The rclone config read: the raw file text, the encrypted flag, the remotes. */
export interface RcloneConfigRead {
  /** The raw file text (`''` when the file is absent). */
  text: string
  /** The config file is password-protected (refuses every mutation). */
  encrypted: boolean
  /** The remotes, secrets stripped, sorted by name (empty when encrypted). */
  remotes: CloudRemote[]
  /**
   * The file existed on disk before this read. `text === ''` is NOT enough to
   * tell absent from an existing EMPTY file — the gate's rollback must restore
   * an existing empty file as empty, not delete it.
   */
  existedBefore: boolean
}

/**
 * Read the config: the file text (absent ⇒ `''`) plus `rclone config dump`.
 *
 *  - exit 0 → the dump parsed into remotes (`options` = non-secret keys,
 *    `secretsSet` = the secret keys that are set — a secret value never
 *    comes back),
 *  - non-zero whose output mentions `password` / `encrypted` / `decrypt`
 *    → `{ encrypted: true, remotes: [] }` — a password-protected file,
 *  - any other non-zero → an Error carrying rclone's last output line.
 *
 * `secrets` are the plain SECRET values in scope at the caller (an in-flight
 * write's secret options) — the argv guard runs for them too, on the dynamic
 * tail only (the base args are ANAS constants, `secret-argv.ts`).
 */
export async function readConfig(
  paths: RcloneConfigPaths,
  executor: CommandExecutor,
  providers?: CloudProvider[],
  secrets: string[] = [],
): Promise<RcloneConfigRead> {
  let text = ''
  let existedBefore = false
  try {
    text = await readFile(paths.configFile, 'utf-8')
    existedBefore = true
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      throw err
  }

  const base = rcloneBaseArgs(paths.configFile)
  const args = [...base, 'config', 'dump']
  assertNoSecretValues(args, secrets, base.length)
  const result = await executor.exec(RCLONE, args)

  if (result.exitCode === 0) {
    let dump: Record<string, unknown>
    try {
      dump = JSON.parse(result.stdout)
    }
    catch {
      // The dump output is not echoed: it can carry a plain name-rule secret
      // (an s3 secret_access_key), and the error must not become the leak.
      throw new Error('rclone config dump returned output that is not JSON')
    }
    return { text, encrypted: false, remotes: dumpToRemotes(dump, providers), existedBefore }
  }

  if (ENCRYPTED_CONFIG_RE.test(`${result.stderr}\n${result.stdout}`))
    return { text, encrypted: true, remotes: [], existedBefore }
  throw new Error(`rclone config dump failed: ${lastOutputLine(result) || `exit ${result.exitCode}`}`)
}

/** A `config dump` JSON object → the secret-stripped remotes, sorted by name. */
function dumpToRemotes(dump: Record<string, unknown>, providers?: CloudProvider[]): CloudRemote[] {
  const remotes: CloudRemote[] = []
  for (const [name, rawEntry] of Object.entries(dump)) {
    if (typeof rawEntry !== 'object' || rawEntry === null)
      continue
    const entry = rawEntry as Record<string, unknown>
    const type = typeof entry.type === 'string' ? entry.type : ''
    const options: Record<string, string> = {}
    const secretsSet: string[] = []
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'type' || typeof value !== 'string')
        continue
      if (isSecretKey(key, providerOption(providers ?? [], type, key)))
        secretsSet.push(key)
      else
        options[key] = value
    }
    remotes.push({ name, type, options, secretsSet: secretsSet.sort() })
  }
  remotes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return remotes
}

// ── Remote-to-remote references (cloudproof.2 finding 4) ───────────────────

/**
 * The option names that hold a REFERENCE to another remote (rclone 1.60
 * providers, captured `providers-1.60.1.json`): `remote` (crypt, alias,
 * cache, chunker, compress, hasher), `upstreams` (union, combine — space
 * separated, each entry optionally `dir=remote:path`). The name rule is the
 * OPTION name, not the backend list — any backend whose reference rides one
 * of these names is covered, and one rclone renames or adds such an option
 * the capture says so.
 */
const REMOTE_REFERENCE_OPTIONS = ['remote', 'upstreams', 'remotes']

/** The token split of a reference value: whitespace or commas. */
const REFERENCE_TOKEN_SPLIT_RE = /[\s,]+/

/** Does one option VALUE reference remote `name`? `myremote:path` shape. */
function valueReferencesRemote(value: string, name: string): boolean {
  const prefix = `${name}:`
  for (const token of value.split(REFERENCE_TOKEN_SPLIT_RE)) {
    // combine's `dir=remote:path` and union's quoted entries: the reference
    // is what follows the `=`, when there is one.
    const target = token.includes('=') ? token.slice(token.lastIndexOf('=') + 1) : token
    if (target.startsWith(prefix))
      return true
  }
  return false
}

/**
 * The remotes whose config references `name` — the wrapper remotes a delete
 * would strand (cloudproof.2 finding 4: DELETE of the sftp remote under a
 * crypt remote answered 202 and left the crypt remote pointing at a section
 * that no longer exists, every later use failing `didn't find section in
 * config file`). A reference is an option value in the `<name>:…` shape;
 * a mere PATH that contains the name (`/mnt/<name>/data`, `<name>2:bucket`)
 * is not a reference. Reference options are never secret, so the values are
 * present in the secret-stripped remotes. Sorted, unique.
 */
export function remotesReferencing(remotes: CloudRemote[], name: string): string[] {
  const refs = new Set<string>()
  for (const remote of remotes) {
    if (remote.name === name)
      continue
    for (const key of REMOTE_REFERENCE_OPTIONS) {
      const value = remote.options[key]
      if (value !== undefined && valueReferencesRemote(value, name)) {
        refs.add(remote.name)
        break
      }
    }
  }
  // eslint-disable-next-line e18e/prefer-array-to-sorted -- Set → sorted list
  return [...refs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// ── Mutation errors ────────────────────────────────────────────────────────

/** The section already exists (create). */
export class RemoteExistsError extends Error {
  constructor(name: string) {
    super(`remote '${name}' already exists`)
    this.name = 'RemoteExistsError'
  }
}

/** The section does not exist (update / remove). */
export class RemoteNotFoundError extends Error {
  constructor(name: string) {
    super(`remote '${name}' does not exist`)
    this.name = 'RemoteNotFoundError'
  }
}

/** The config file is password-protected — every mutation is refused. */
export class ConfigEncryptedError extends Error {
  constructor(configFile: string) {
    super(`the rclone config file ${configFile} is password-encrypted — ANAS neither prompts for nor stores the passphrase`)
    this.name = 'ConfigEncryptedError'
  }
}

/**
 * The `config dump` gate failed after a write — the PREVIOUS bytes have
 * already been put back (byte-identical rollback) before this is thrown.
 * `detail` is rclone's last output line (or a gate-mismatch sentence).
 */
export class RcloneConfigGateError extends Error {
  constructor(readonly detail: string) {
    super(`rclone could not read the config back after the write: ${detail}`)
    this.name = 'RcloneConfigGateError'
  }
}

// ── The obscure + the file write ───────────────────────────────────────────

/**
 * `rclone obscure -` with the value on STDIN — the only path a secret value
 * takes to the file. The value is never an argument (asserted); the result
 * is the obscured, reversible encoding rclone itself writes into the file.
 * `configFile` defaults to the default config path (every invocation carries
 * the base args) — pass it explicitly under a lock for consistency.
 */
export async function obscure(
  executor: CommandExecutor,
  value: string,
  configFile: string = defaultRcloneConfigFile(),
): Promise<string> {
  const base = rcloneBaseArgs(configFile)
  const args = [...base, 'obscure', '-']
  assertNoSecretValues(args, [value], base.length)
  const result = await executor.exec(RCLONE, args, { stdin: value })
  if (result.exitCode !== 0)
    throw new Error(`rclone obscure failed: ${lastOutputLine(result) || `exit ${result.exitCode}`}`)
  return result.stdout.trim()
}

/**
 * Write the config file atomically: write `<file>.tmp` with mode 0600, then
 * `rename` over the file (the rename is the atomic swap). The parent
 * directory is created 0700 when missing (an existing one is never chmodded
 * — we are a guest). A FAILED rename must not leave the `.tmp` behind — the
 * tmp is removed in a `finally` (`force` ignores the post-rename ENOENT).
 *
 * Test seam: the rename-failure path (a target that is a directory) is not
 * reachable through the public API — `readConfig` would refuse to read the
 * directory first — so the helper is exported for that one test.
 */
export async function writeConfigFileAtomic(paths: RcloneConfigPaths, text: string): Promise<void> {
  const dir = dirname(paths.configFile)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `${basename(paths.configFile)}.tmp`)
  await writeFile(tmp, text, { encoding: 'utf-8', mode: 0o600 })
  try {
    await rename(tmp, paths.configFile)
    await chmod(paths.configFile, 0o600).catch(() => {})
  }
  finally {
    // The tmp must not outlive the write; a cleanup failure must not mask
    // the write's own error.
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/**
 * The byte-identical rollback: the PREVIOUS text back, or the file removed
 * when it was ABSENT (`existedBefore === false`). An existing EMPTY file
 * (`existedBefore === true`, text `''`) comes back empty — not deleted.
 */
async function restoreConfigFile(
  paths: RcloneConfigPaths,
  previousText: string,
  existedBefore: boolean,
): Promise<void> {
  if (!existedBefore) {
    await rm(paths.configFile, { force: true })
    return
  }
  await writeConfigFileAtomic(paths, previousText)
}

// ── The gate ───────────────────────────────────────────────────────────────

/**
 * The post-write gate: `rclone config dump` must exit 0 AND agree with what
 * we wrote. Returns rclone's last output line when it does not, null when it
 * does. `expected` is the section's expected non-secret values (the `type`
 * key included) — secret keys are NOT compared: the dump never returns them,
 * and rclone revealing one would be the bug, not our mismatch.
 */
async function configDumpGate(
  paths: RcloneConfigPaths,
  executor: CommandExecutor,
  name: string,
  expected: Record<string, string>,
  secrets: string[],
): Promise<string | null> {
  const base = rcloneBaseArgs(paths.configFile)
  const args = [...base, 'config', 'dump']
  assertNoSecretValues(args, secrets, base.length)
  const result = await executor.exec(RCLONE, args)
  if (result.exitCode !== 0)
    return lastOutputLine(result) || `exit ${result.exitCode}`
  try {
    const dump = JSON.parse(result.stdout) as Record<string, Record<string, unknown> | undefined>
    const entry = dump[name]
    if (!entry)
      return `rclone's config dump does not list remote '${name}' after the write`
    for (const [key, value] of Object.entries(expected)) {
      if (entry[key] !== value)
        return `rclone's config dump disagrees on '${name}.${key}' after the write`
    }
    return null
  }
  catch {
    return 'rclone config dump returned invalid JSON after the write'
  }
}

// ── create / update / remove ───────────────────────────────────────────────

/** The section's CURRENT key → raw value map (file order, last duplicate wins). */
function existingSectionRaw(text: string, name: string): Map<string, string> {
  const section = listSections(parseRcloneConf(text)).find(s => s.name === name)
  if (!section)
    return new Map()
  return new Map(Object.entries(section.values))
}

/**
 * Create or update a remote — the surgical INI write + the config-dump gate.
 *
 *  - `create` refuses an existing name (`RemoteExistsError`); the section's
 *    `type` comes from the request.
 *  - `update` refuses an absent name (`RemoteNotFoundError`) and a type
 *    change (type is IMMUTABLE — a retype is a remove + create); keys absent
 *    from `input.options` stay exactly as written (an obscured password keeps
 *    its exact file spelling), a non-secret key given as `''` is removed, a
 *    secret key given as `''` is ignored (unchanged — the value is unreadable,
 *    so it cannot be cleared without being sent again).
 *  - every requested key must be a real option of the type (unknown ⇒ throw
 *    naming the key); a key the SECTION carries that the provider schema does
 *    not know is kept, never silently dropped (the gate reads the file back).
 *  - the section is rebuilt as `type` first, then keys in the PROVIDER'S
 *    option order; password-typed values that arrive in plain text are
 *    obscured via stdin; the write is temp-then-rename 0600 under the
 *    per-file lock.
 *  - GATE: `config dump` must exit 0 and list the section with the same
 *    non-secret values — else the PREVIOUS bytes go back byte-identically
 *    (absent-before ⇒ the file is removed; an existing empty file comes
 *    back empty) and `RcloneConfigGateError` carries rclone's last output
 *    line — with the rollback failure stated when the restore itself fails.
 *
 * Returns the remote with secrets stripped.
 */
export async function writeRemote(
  paths: RcloneConfigPaths,
  executor: CommandExecutor,
  input: CloudRemoteWrite,
  opts: { providers: CloudProvider[], mode: 'create' | 'update' },
): Promise<CloudRemote> {
  return withFileLock(paths.configFile, async () => {
    // The argv-guard set is the SECRET values of this write ONLY (the
    // name rule with the provider's option, `isSecretKey`) — every option
    // value is not a secret: a `host` of `h` or a `hard_delete` of `false`
    // must not trip on the static base args, where the config path may
    // contain `h` and `--ask-password=false` contains `false`. The OBSCLUDED
    // outputs are not secrets either — they are rclone's own encoding, and
    // the guard only ever sees these plain values in scope. (On `update`,
    // `input.type` is the type: it must equal the existing one or the call
    // throws before anything else runs.)
    const secretValues = Object.entries(input.options)
      .filter(([key]) => isSecretKey(key, providerOption(opts.providers, input.type, key)))
      .map(([, value]) => value)

    const current = await readConfig(paths, executor, opts.providers, secretValues)
    if (current.encrypted)
      throw new ConfigEncryptedError(paths.configFile)
    const existing = current.remotes.find(r => r.name === input.name)
    if (opts.mode === 'create' && existing)
      throw new RemoteExistsError(input.name)
    if (opts.mode === 'update' && !existing)
      throw new RemoteNotFoundError(input.name)

    // The type: set from the request on create, kept on update (immutable).
    const type = opts.mode === 'create' ? input.type : existing!.type
    if (opts.mode === 'update' && input.type !== type)
      throw new Error(`remote '${input.name}' is of type '${type}' — the type is immutable (remove and recreate to retype)`)

    const provider = opts.providers.find(p => p.name === type)
    if (!provider)
      throw new Error(`unknown remote type '${type}' — rclone's provider list knows no such backend`)

    const known = new Set(provider.options.map(o => o.name))
    for (const key of Object.keys(input.options)) {
      if (!known.has(key))
        throw new Error(`unknown option '${key}' for remote type '${type}'`)
    }

    // Compose the section: `type` first, then the provider's option order
    // (a backend repeats an option per provider filter — once per name),
    // then any key the section carries that the schema does not know.
    const entries: { key: string, value: string, fresh: boolean }[] = [{ key: 'type', value: type, fresh: false }]
    const added = new Set<string>(['type'])
    const removed = new Set<string>()
    const optionOrder: string[] = []
    for (const o of provider.options) {
      if (!optionOrder.includes(o.name))
        optionOrder.push(o.name)
    }

    const existingRaw = existingSectionRaw(current.text, input.name)
    for (const key of optionOrder) {
      const requested = input.options[key]
      if (requested === undefined) {
        // Absent: keep the section's current line verbatim (its exact file
        // spelling — an obscured password stays byte-for-byte).
        if (existingRaw.has(key)) {
          entries.push({ key, value: existingRaw.get(key)!, fresh: false })
          added.add(key)
        }
        continue
      }
      if (requested === '') {
        // '' removes a NON-secret key. A SECRET key given '' is the dialog's
        // "(unchanged)" marker — its value cannot be read back, so '' can
        // only mean "leave it as it is".
        if (isSecretKey(key, providerOption(opts.providers, type, key))) {
          if (existingRaw.has(key)) {
            entries.push({ key, value: existingRaw.get(key)!, fresh: false })
            added.add(key)
          }
        }
        else {
          removed.add(key) // never revived by the foreign-key pass below
        }
        continue
      }
      entries.push({ key, value: requested, fresh: true })
      added.add(key)
    }
    for (const [key, value] of existingRaw) {
      if (!added.has(key) && !removed.has(key)) {
        entries.push({ key, value, fresh: false })
        added.add(key)
      }
    }

    // Obscure every FRESH value rclone types as a password — via stdin only.
    const passwordKeys = passwordKeysFor(opts.providers, type)
    for (const entry of entries) {
      if (entry.fresh && passwordKeys.has(entry.key))
        entry.value = await obscure(executor, entry.value, paths.configFile)
    }

    const values: Record<string, string> = {}
    for (const e of entries)
      values[e.key] = e.value
    const newText = upsertSection(current.text, input.name, values)
    await writeConfigFileAtomic(paths, newText)

    // The gate: rclone reads the file back. On a miss, the PREVIOUS bytes go
    // back byte-identically before the error is thrown.
    const expected: Record<string, string> = { type }
    const secretsSet: string[] = []
    for (const e of entries) {
      if (e.key === 'type')
        continue
      if (isSecretKey(e.key, providerOption(opts.providers, type, e.key)))
        secretsSet.push(e.key)
      else
        expected[e.key] = e.value
    }
    const gateError = await configDumpGate(paths, executor, input.name, expected, secretValues)
    if (gateError !== null) {
      // The PREVIOUS bytes go back. A FAILED RESTORE must not replace the
      // gate error — the operator needs the gate reason, with the restore
      // failure stated (an fs error: paths and errnos, no secrets).
      try {
        await restoreConfigFile(paths, current.text, current.existedBefore)
      }
      catch {
        throw new RcloneConfigGateError(`${gateError} — and the rollback of the previous bytes also failed, so the config file may still hold the failed write`)
      }
      throw new RcloneConfigGateError(gateError)
    }

    return {
      name: input.name,
      type,
      options: Object.fromEntries(entries.filter(e => e.key !== 'type' && !secretsSet.includes(e.key)).map(e => [e.key, e.value])),
      secretsSet: secretsSet.sort(),
    }
  })
}

/**
 * Remove a remote: the section goes (header + lines + its separator blank),
 * temp-then-rename under the lock, and the same `config dump` gate with
 * byte-identical rollback — the dump must exit 0 and NOT list the remote.
 * (The "referenced by a task" refusal is the ROUTE's job, rclone.1's later
 * slice — the task store does not exist yet.)
 */
export async function removeRemote(
  paths: RcloneConfigPaths,
  executor: CommandExecutor,
  name: string,
): Promise<void> {
  return withFileLock(paths.configFile, async () => {
    const current = await readConfig(paths, executor)
    if (current.encrypted)
      throw new ConfigEncryptedError(paths.configFile)
    if (!current.remotes.some(r => r.name === name))
      throw new RemoteNotFoundError(name)

    const newText = removeSection(current.text, name)
    await writeConfigFileAtomic(paths, newText)

    // The gate: the dump must parse AND the remote must be gone.
    const base = rcloneBaseArgs(paths.configFile)
    const args = [...base, 'config', 'dump']
    assertNoSecretValues(args, [], base.length)
    const gate = await executor.exec(RCLONE, args)
    let gateError: string
    if (gate.exitCode !== 0) {
      gateError = lastOutputLine(gate) || `exit ${gate.exitCode}`
    }
    else {
      try {
        const dump = JSON.parse(gate.stdout) as Record<string, unknown>
        gateError = dump[name] === undefined ? '' : `rclone's config dump still lists remote '${name}' after the removal`
      }
      catch {
        gateError = 'rclone config dump returned invalid JSON after the write'
      }
    }
    if (gateError !== '') {
      // A failed RESTORE must not replace the gate error (same contract as
      // writeRemote): the gate reason stays, the restore failure is stated.
      try {
        await restoreConfigFile(paths, current.text, current.existedBefore)
      }
      catch {
        throw new RcloneConfigGateError(`${gateError} — and the rollback of the previous bytes also failed, so the config file may still hold the failed write`)
      }
      throw new RcloneConfigGateError(gateError)
    }
  })
}
