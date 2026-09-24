/**
 * Cloud sync — remotes (story rclone.1): the bounded `lsjson` Test probe.
 *
 * `POST /v1/cloud/remotes/test` is the mounts / repo-Test shape (DESIGN
 * "Cloud sync — rclone"): a `timeout`-bounded
 * `rclone lsjson <remote>:<path> --max-depth 1 --contimeout 10s --timeout 30s
 * --retries 1 --low-level-retries 1` — a dead network can never hang the API.
 *
 * The verdict is a CLASSIFIER over rclone's message, not its exit code:
 * rclone 1.60 exits 1 for EVERY `NewFs` failure (unreachable, authentication
 * and unknown-remote alike — GT 2026-09-23), so only exit 0 (ok), exit 3
 * (missing directory) and exit 124 (the `timeout` wrapper fired) are
 * decisive on their own. An unrecognised failure is `error` with rclone's
 * last output line verbatim — never a wrong bucket.
 *
 * An UNSAVED dialog is served through an environment-defined remote —
 * `RCLONE_CONFIG_ANASTEST_<KEY>` on the child's env, never the file and never
 * argv — so nothing is written before the user saves. The values follow the
 * file's secret rule: password-TYPED keys (rclone's `IsPassword`, via
 * `passwordKeysFor`) go in OBSCURED (through `obscure()`), the rest plain.
 *
 * GROUND TRUTH 2026-09-24 (stunt node, rclone v1.60.1, Debian 13) — three
 * facts decide the shape below:
 *
 *  1. rclone's sftp backend AUTODETECTS the remote shell on the first connect
 *     and PERSISTS what it learned (`shell_type`, `md5sum_command`,
 *     `sha1sum_command`) into whatever `--config` file it was given. For a
 *     SAVED remote those three keys are appended to that remote's own
 *     section; for an ENV-DEFINED remote they are written as a NEW
 *     `[anastest]` section — and with no config file present at all, rclone
 *     CREATES one holding just `[anastest]`. Other sections and comments
 *     survive the rewrite. A probe of an unsaved dialog must therefore never
 *     be pointed at ANAS's own store, or a dialog the user never saved would
 *     leave a section behind in it.
 *  2. The same env probe run with `--config <a private temp copy>` writes
 *     those keys into the COPY and leaves the real file byte-identical — so
 *     the unsaved probe copies `/etc/anas/rclone.conf` into a 0700 temp dir
 *     (under `/run/anas` on a node), probes against the copy, and removes the
 *     dir in a `finally`. The copy is there because a backend may legitimately
 *     need the file (a `crypt` remote wrapping a saved one); nothing rclone
 *     writes into it outlives the probe. A SAVED-remote probe keeps the real
 *     file: rclone appending its detection keys to that remote's own section
 *     is accepted — the INI writer keeps foreign keys and the API lists them.
 *  3. An env-defined remote's password MUST be obscured: a plain one fails
 *     with `input too short when revealing password - is it obscured?`, since
 *     rclone de-obscures every `IsPassword` field wherever it comes from.
 *     (`rclone config dump` then returns the OBSCURED value — the API never
 *     reveals it; `rclone reveal <value>` is the operator's own door.)
 *
 * The captured failure lines the classifier reads (all exit 1 except where
 * noted):
 *   not-found    (exit 3) `Failed to lsjson with 2 errors: last error was: error in ListJSON: directory not found`
 *   auth         `Failed to create file system for "anastest:": NewFs: couldn't connect SSH: ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password], no supported methods remain`
 *   unreachable  `Failed to create file system for "anastest:": NewFs: couldn't connect SSH: dial tcp 192.0.2.1:22: i/o timeout`
 *   unknown      `Failed to create file system for "nosuchremote:": didn't find section in config file`
 */

import type { CloudProvider, CloudRemoteTestResult, CloudRemoteWrite } from '@anas/shared'
import type { Dirent } from 'node:fs'
import type { CommandExecutor } from '../executor/types.js'
import type { RcloneConfigPaths } from './rclone-config.js'
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isSecretKey,
  obscure,
  passwordKeysFor,
  providerOption,
  RCLONE,
  rcloneBaseArgs,

  RemoteNotFoundError,
} from './rclone-config.js'
import { assertNoSecretValues } from './secret-argv.js'

/** `timeout` binary — wraps the probe so a dead network can never hang us. */
const TIMEOUT = '/usr/bin/timeout'

/** The whole probe's wall budget, in seconds (the `timeout` argument). */
export const PROBE_TIMEOUT_S = 45

/**
 * The env-defined remote's name. A saved `anastest` in the file would be
 * shadowed by the env vars for the duration of the probe (rclone's own
 * precedence), and no fixture or operator remote uses the name.
 */
export const PROBE_REMOTE_NAME = 'anastest'

/** The environment prefix of the env-defined remote's options. */
export const PROBE_ENV_PREFIX = `RCLONE_CONFIG_${PROBE_REMOTE_NAME.toUpperCase()}_`

/**
 * Where an UNSAVED probe's private config copy is made: anasd's own runtime
 * directory (tmpfs, root-only, created by the unit). Absent — a test host, a
 * dev box — the system temp directory stands in.
 */
export const PROBE_TMP_BASE = '/run/anas'

/**
 * The mkdtemp prefix of an UNSAVED probe's private config directory — exact,
 * and shared by {@link makeProbeConfigDir} and {@link sweepStaleProbeDirs} so
 * a sweep can never mistake anything else for a probe dir.
 */
export const PROBE_TMP_PREFIX = 'anas-rclone-probe-'

// ── The verdict classifier ─────────────────────────────────────────────────

/** Network-level failures (a host that does not answer). */
const UNREACHABLE_RE = /i\/o timeout|connection refused|no such host|no route to host|network is unreachable/
/** Credential / permission failures (a host that answers "no"). */
const AUTH_RE = /unable to authenticate|handshake failed|401|403|AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|permission denied|Unauthorized/
/** A remote-side path that does not exist (also exit 3 on its own). */
const NOT_FOUND_RE = /directory not found/
/** A remote name the config file does not carry — a LOCAL fault, not a verdict. */
const UNKNOWN_REMOTE_RE = /didn't find section in config file/
/** The remote name rclone names in a `Failed to create file system` line. */
const FS_NAME_RE = /Failed to create file system for "([^"]+)":/
/** The trailing colon of an fs reference (`name:`) — stripped from the name. */
const TRAILING_COLON_RE = /:$/

/**
 * The verdict of a probe result. `exitCode` is the `timeout` wrapper's (124 =
 * it fired); `output` is rclone's STDERR — its log lines (the `ERROR`/
 * `Failed to …` lines the buckets read). stdout is the `lsjson` payload: a
 * partial `[` on a listing failure, which is not a message, so it is not read.
 *
 *  - 0 → `ok`; 124 → `unreachable` (a stalled connect can FOLLOW a logged
 *    line — the last line rides along, it is not discarded),
 *  - 3 or `directory not found` → `not-found`,
 *  - a network line → `unreachable`, an auth line → `auth`,
 *  - `didn't find section in config file` → `RemoteNotFoundError` (the route
 *    answers 4xx — the remote is not saved, that is a local fact),
 *  - anything else → `error` with rclone's LAST NON-EMPTY line verbatim
 *    (never the whole output — the line may name the remote and host, that
 *    is fine; a raw byte dump is not).
 */
export function classifyProbe(exitCode: number, output: string): CloudRemoteTestResult {
  if (exitCode === 0)
    return { verdict: 'ok', message: '' }
  if (exitCode === 124)
    // The wrapper fired — but rclone may have logged a line before it hung
    // (an auth attempt, then a stalled connect). Its last word is carried.
    return { verdict: 'unreachable', message: lastNonEmptyLine(output) }
  const message = lastNonEmptyLine(output)
  if (exitCode === 3 || NOT_FOUND_RE.test(output))
    return { verdict: 'not-found', message }
  if (UNREACHABLE_RE.test(output))
    return { verdict: 'unreachable', message }
  if (AUTH_RE.test(output))
    return { verdict: 'auth', message }
  if (UNKNOWN_REMOTE_RE.test(output)) {
    const name = (FS_NAME_RE.exec(output)?.[1] ?? '').replace(TRAILING_COLON_RE, '')
    throw new RemoteNotFoundError(name)
  }
  return { verdict: 'error', message }
}

/** The last non-empty line of a (log) output — rclone's final word. */
function lastNonEmptyLine(output: string): string {
  return output.split('\n').map(l => l.trim()).filter(l => l !== '').at(-1) ?? ''
}

// ── The probe itself ───────────────────────────────────────────────────────

/** The target of a Test: a SAVED remote by name, or an UNSAVED dialog. */
export interface RcloneProbeTarget {
  /** A saved remote (a `[name]` section in the config file). */
  name?: string
  /** An unsaved dialog — served through the env-defined remote, never written. */
  remote?: CloudRemoteWrite
}

export interface RcloneProbeOptions {
  /** The remote-side path to list (default: the remote root). */
  path?: string
  /**
   * The trimmed provider catalogue — required for an UNSAVED target (it
   * decides which option values are password-typed and go in obscured).
   */
  providers?: CloudProvider[]
  /**
   * Base directory for an UNSAVED probe's private config copy (default
   * {@link PROBE_TMP_BASE}, falling back to the system temp directory when
   * that is absent). Injectable so the tests can hold it somewhere writable.
   */
  tmpBase?: string
}

/**
 * The private `--config` an UNSAVED probe runs against: a fresh 0700 temp
 * directory holding a 0600 COPY of ANAS's own store (when there is one — an
 * absent store means rclone starts from nothing, which is also fine). rclone
 * writes its sftp shell detection into THIS file (GT fact 1), and the whole
 * directory goes away with the probe.
 */
async function makeProbeConfigDir(configFile: string, base?: string): Promise<{ dir: string, configFile: string }> {
  let parent = base ?? PROBE_TMP_BASE
  try {
    await stat(parent)
  }
  catch {
    parent = tmpdir()
  }
  const dir = await mkdtemp(join(parent, PROBE_TMP_PREFIX))
  await chmod(dir, 0o700)
  const copy = join(dir, 'rclone.conf')
  try {
    await writeFile(copy, await readFile(configFile, 'utf-8'), { encoding: 'utf-8', mode: 0o600 })
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      throw err
  }
  return { dir, configFile: copy }
}

/**
 * Remove STALE probe config directories — what a daemon killed mid-probe
 * (OOM, SIGKILL, power) leaves behind: the `finally` in {@link testRemote}
 * never ran, and each survivor is a 0700 directory holding a full COPY of
 * ANAS's store (obscured passwords, plain name-rule secrets) until the next
 * boot. Swept once at daemon start, before any probe of this process can
 * exist. Matches the exact {@link PROBE_TMP_PREFIX}, any age, directories
 * only. A missing base directory is not an error — nothing stale can live in
 * a directory that does not exist (a dev box without `/run/anas`). Returns
 * the swept directory names.
 */
export async function sweepStaleProbeDirs(base: string = PROBE_TMP_BASE): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(base, { withFileTypes: true })
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return []
    throw err
  }
  const swept: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PROBE_TMP_PREFIX))
      continue
    try {
      await rm(join(base, entry.name), { recursive: true, force: true })
      swept.push(entry.name)
    }
    catch {
      // Left for the next boot — one stubborn dir must not stop the sweep.
    }
  }
  return swept
}

/**
 * Run the bounded `lsjson` probe and classify it.
 *
 *  - a SAVED target probes `<name>:<path>` straight from ANAS's own file (the
 *    three sftp detection keys rclone appends to that remote's section are
 *    accepted — GT fact 1; the INI writer keeps foreign keys),
 *  - an UNSAVED target probes `<PROBE_REMOTE_NAME>:<path>` with the options
 *    on the child's ENVIRONMENT (`RCLONE_CONFIG_ANASTEST_<KEY UPPERCASED>`,
 *    `IsPassword` values obscured through `obscure()` first) — never the file,
 *    never argv — and against a PRIVATE 0700 temp copy of the store, removed
 *    in a `finally`, so the `[anastest]` section rclone would persist cannot
 *    land in ANAS's own file (GT facts 1 and 2). The argv tail (the
 *    `lsjson <fs>` argument — a path a user typed) still rides the shared
 *    secret-VALUES guard: a value in scope that would ride it is refused, and
 *    the error names nothing (secret-argv).
 *
 * Throws `RemoteNotFoundError` when the config file does not carry the name
 * (the route's 404) and a plain `SecretOnArgvError` when the guard fires.
 */
export async function testRemote(
  executor: CommandExecutor,
  paths: RcloneConfigPaths,
  target: RcloneProbeTarget,
  opts: RcloneProbeOptions = {},
): Promise<CloudRemoteTestResult> {
  if ((target.name === undefined) === (target.remote === undefined))
    throw new Error('a probe target needs exactly one of name or remote')

  const path = opts.path ?? ''
  let fs: string
  let env: Record<string, string> | undefined
  const secretValues: string[] = []
  // The `--config` the PROBE runs against: ANAS's own file for a saved
  // remote, a private throwaway copy for an unsaved dialog (GT fact 2).
  let probeConfig = paths.configFile
  let tmpDir: string | undefined

  if (target.name !== undefined) {
    fs = `${target.name}:${path}`
  }
  else {
    const remote = target.remote!
    if (!opts.providers)
      throw new Error('testing an unsaved remote needs the provider catalogue (which options are password-typed)')
    fs = `${PROBE_REMOTE_NAME}:${path}`
    env = { [`${PROBE_ENV_PREFIX}TYPE`]: remote.type }
    const passwordKeys = passwordKeysFor(opts.providers, remote.type)
    for (const [key, value] of Object.entries(remote.options)) {
      if (isSecretKey(key, providerOption(opts.providers, remote.type, key)))
        secretValues.push(value)
      // `rclone obscure -` neither opens nor writes the config file, so it
      // still names ANAS's own path — only the LISTING gets the copy.
      env[`${PROBE_ENV_PREFIX}${key.toUpperCase()}`] = passwordKeys.has(key)
        ? await obscure(executor, value, paths.configFile)
        : value
    }
    const tmp = await makeProbeConfigDir(paths.configFile, opts.tmpBase)
    tmpDir = tmp.dir
    probeConfig = tmp.configFile
  }

  try {
    const args = probeArgs(probeConfig, fs)
    // The dynamic tail (the fs argument — a path a user typed — and the flags
    // after it) must not carry a plain secret value. The skip count is the
    // static prefix's own length (timeout + rclone + the --config base +
    // lsjson — {@link probeStaticPrefix}); anything shorter leaves those
    // static tokens in the checked tail, where a secret value that is a
    // substring of the temp config path or of `false` refuses a clean probe.
    assertNoSecretValues(args, secretValues, probeStaticPrefix(probeConfig).length)

    const result = await executor.exec(TIMEOUT, args, env ? { env } : undefined)
    return classifyProbe(result.exitCode, result.stderr)
  }
  finally {
    // The copy must not outlive the probe — and a cleanup failure must not
    // mask the probe's own error.
    if (tmpDir !== undefined)
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The probe's STATIC argv prefix — `timeout 45 rclone --config <file>
 * --ask-password=false lsjson`: every token before the one dynamic `<fs>`
 * the caller typed. The probe's argv carries two leading tokens ahead of the
 * rclone base (`timeout` and the binary itself), so the secret-VALUES guard
 * must skip THIS many tokens — derived here, never a hard-coded `base.length
 * + 2` — or its checked tail would hold the static `--config <path>` and
 * `--ask-password=false`, where a small secret value like `false` legally
 * matches and a legitimate probe is refused.
 */
export function probeStaticPrefix(configFile: string): string[] {
  return [String(PROBE_TIMEOUT_S), RCLONE, ...rcloneBaseArgs(configFile), 'lsjson']
}

/**
 * The full probe argv — `timeout 45 rclone --config <file>
 * --ask-password=false lsjson <fs> --max-depth 1 --contimeout 10s --timeout
 * 30s --retries 1 --low-level-retries 1`. The timeout shape and the flag
 * spelling are the design's; exported so the tests assert the exact argv the
 * executor sees (a drift in either silently changes what is bounded).
 */
export function probeArgs(configFile: string, fs: string): string[] {
  return [
    ...probeStaticPrefix(configFile),
    fs,
    '--max-depth',
    '1',
    '--contimeout',
    '10s',
    '--timeout',
    '30s',
    '--retries',
    '1',
    '--low-level-retries',
    '1',
  ]
}
