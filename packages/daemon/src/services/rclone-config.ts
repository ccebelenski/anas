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
import { CloudProvider as CloudProviderSchema } from '@anas/shared'
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
 */
const SECRET_SUFFIX_RE = /(?:^|_)(?:pass|password|secret|token|key)$/

export function isSecretKey(key: string, option?: CloudProviderOption): boolean {
  if (option?.secret)
    return true
  return SECRET_SUFFIX_RE.test(key)
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
 * dialog renders from. Per option: `secret = IsPassword || the name rule`,
 * `password = IsPassword` (the obscure-in-file set — a different fact from
 * `secret`), `default = DefaultStr`, options with `Hide !== 0` dropped
 * (rclone hides `test_mode`-style knobs from config UIs). The output is
 * validated against the shared schema.
 */
export function trimProviders(raw: unknown): CloudProvider[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { providers?: unknown }).providers))
    throw new Error('rclone config providers: unexpected output shape (no providers list)')
  const trimmed: CloudProvider[] = (raw as { providers: RawProvider[] }).providers.map(p => ({
    name: String(p.Name ?? ''),
    description: String(p.Description ?? ''),
    options: (Array.isArray(p.Options) ? p.Options : [])
      .filter(o => (o.Hide ?? 0) === 0)
      .map((o) => {
        const name = String(o.Name ?? '')
        return {
          name,
          help: String(o.Help ?? ''),
          type: String(o.Type ?? ''),
          required: o.Required === true,
          secret: o.IsPassword === true || isSecretKey(name),
          password: o.IsPassword === true,
          default: String(o.DefaultStr ?? ''),
          examples: (Array.isArray(o.Examples) ? o.Examples : []).map(e => ({
            value: String(e.Value ?? ''),
            help: String(e.Help ?? ''),
            provider: String(e.Provider ?? ''),
          })),
          provider: String(o.Provider ?? ''),
          advanced: o.Advanced === true,
        }
      }),
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
