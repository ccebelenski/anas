/**
 * Parser for `zpool list -j` output.
 * Extracts: pool summaries (size, allocated, free, fragmentation, etc.)
 */

import type { PoolSummary, PoolUnmanaged } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import { PoolName } from '@anas/shared'
import { CommandTimeoutError } from '../executor/deadline.js'
import { parseDedupRatio, parseHumanSize, parsePercent, parseZfsJson } from './utils.js'

interface ZfsPropertyRaw {
  value: string
  source: { type: string, data: string }
}

interface ZfsPoolListRaw {
  name: string
  state: string
  properties: Record<string, ZfsPropertyRaw>
}

interface ZpoolListOutput {
  pools: Record<string, ZfsPoolListRaw>
}

const SINGLE_QUOTE_RE = /'/g

/** zpool's own sentence for "no pool is imported" (a whole line, either stream). */
const NO_POOLS_LINE = 'no pools available'
/**
 * libzfs_init's three refusals, EXACTLY as zpool prints them (OpenZFS 2.4.x
 * `lib/libzfs/os/linux/libzfs_util_os.c` `libzfs_error_init`, printed by
 * `cmd/zpool/zpool_main.c` as `fprintf(stderr, "%s\n",
 * libzfs_error_init(errno)); return (1);`): exit 1, nothing on stdout, the
 * FIRST stderr line one of these sentences. Two of them can also occur with
 * the module loaded (a missing /dev/zfs, minor exhaustion), so they mean "ZFS
 * is not available" only together with an absent `/sys/module/zfs` — which
 * {@link execZpool} checks, marking the answer {@link ZFS_MODULE_ABSENT_TAG}.
 */
const LIBZFS_INIT_LINES: ReadonlySet<string> = new Set([
  'The ZFS modules cannot be auto-loaded.',
  'The ZFS modules are not loaded.',
  '/dev/zfs and /proc/self/mounts are required.',
])
/**
 * The stderr {@link execZpool} answers with when the `zpool` binary does not
 * exist (spawn ENOENT): no ZFS userland, so no pool is imported. Never a
 * string zpool itself prints.
 */
export const ZPOOL_ABSENT_STDERR = 'anasd: /usr/sbin/zpool is not installed (no ZFS userland on this node)'
/**
 * The prefix {@link execZpool} puts before libzfs_init's sentence when it has
 * ALSO seen that `/sys/module/zfs` does not exist (cr3 re-review 2 item 3):
 * only that combination is "ZFS is not available". Never printed by zpool.
 */
export const ZFS_MODULE_ABSENT_TAG = 'anasd: the zfs kernel module is not loaded (/sys/module/zfs is absent): '
/** The stderr {@link execZpool} answers with when `zpool` could not be started for another reason (EACCES, ...). */
const ZPOOL_SPAWN_FAILED_PREFIX = 'anasd: the zpool command could not be run'
const ZPOOL = '/usr/sbin/zpool'
const TEST = '/usr/bin/test'
/** zpool's sentences are translated: every read that matches one forces the C locale. */
const C_LOCALE = { env: { LC_ALL: 'C' } }

/**
 * Run a READ-ONLY `zpool` command (list / status / import scan / upgrade) for
 * a reader that must tell "no ZFS here" and "could not run" from an answer
 * (cr3):
 *  - LC_ALL=C, so the sentences below are zpool's English ones;
 *  - a spawn ENOENT resolves as {@link ZPOOL_ABSENT_STDERR} ("no ZFS
 *    userland"), which {@link zfsUnavailableReason} reads as ZFS unavailable;
 *  - any other spawn failure (EACCES, ...) resolves as a non-zero exit naming
 *    it, which every reader reads as UNREADABLE (503 / unknown), never a 500;
 *  - libzfs_init's exact answer (exit 1, empty stdout, first stderr line one
 *    of {@link LIBZFS_INIT_LINES}) is checked against `/sys/module/zfs`: only
 *    when the module directory is absent is the answer tagged
 *    {@link ZFS_MODULE_ABSENT_TAG}; with the module present, or the check
 *    unanswered, it stays an ordinary failed read (unreadable).
 * A timeout still rejects (the route's 503 TIMEOUT).
 */
export async function execZpool(executor: CommandExecutor, args: string[]): Promise<ExecResult> {
  let r: ExecResult
  try {
    r = await executor.exec(ZPOOL, args, C_LOCALE)
  }
  catch (err: unknown) {
    if (err instanceof CommandTimeoutError)
      throw err
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'ENOENT')
      return { stdout: '', stderr: ZPOOL_ABSENT_STDERR, exitCode: 127 }
    return { stdout: '', stderr: `${ZPOOL_SPAWN_FAILED_PREFIX} (${e?.code ?? 'spawn failed'}: ${e instanceof Error ? e.message : String(err)})`, exitCode: 126 }
  }
  const first = r.stderr.split('\n')[0]?.trim() ?? ''
  if (r.exitCode === 1 && r.stdout.trim() === '' && LIBZFS_INIT_LINES.has(first)) {
    const module = await executor.exec(TEST, ['-d', '/sys/module/zfs']).catch(() => null)
    if (module?.exitCode === 1)
      return { ...r, stderr: `${ZFS_MODULE_ABSENT_TAG}${r.stderr}` }
  }
  return r
}

/**
 * Did zpool ANSWER that there are no pools (cr3)? Its "no pools available"
 * sentence as a whole line on stdout or stderr (zpool prints it only without
 * `-j`; tolerated), or ZFS not being available on the node
 * ({@link zfsUnavailableReason}). Nothing else is.
 */
export function zpoolSaysNoPools(r: { stdout: string, stderr: string }): boolean {
  const text = `${r.stdout}\n${r.stderr}`
  return text.split('\n').some(line => line.trim() === NO_POOLS_LINE)
    || zfsUnavailableReason(r) !== null
}

/**
 * The plain statement that ZFS is not available on this node (cr3), or null.
 * Only two answers say so, both made by {@link execZpool}: `zpool` not
 * installed, or libzfs_init's refusal WITH `/sys/module/zfs` absent (the
 * {@link ZFS_MODULE_ABSENT_TAG} answer). A raw libzfs sentence — module
 * present, or a reader that did not go through execZpool — is not.
 */
export function zfsUnavailableReason(r: { stdout: string, stderr: string }): string | null {
  if (r.stderr.trim() === ZPOOL_ABSENT_STDERR)
    return 'ZFS is not available on this node: the zpool command is not installed'
  if (r.stdout.trim() === '' && r.stderr.startsWith(ZFS_MODULE_ABSENT_TAG)) {
    const line = r.stderr.slice(ZFS_MODULE_ABSENT_TAG.length).split('\n')[0].trim()
    return `ZFS is not available on this node: ${line} (the zfs kernel module is not loaded)`
  }
  return null
}

/**
 * A zpool `-j` listing's stdout, judged (cr3): `'empty'` (nothing printed),
 * `'json'` (a JSON object whose `pools` is an object — OpenZFS always emits
 * `pools` when it prints JSON), or `'other'` (anything else: text, an array,
 * an object without a `pools` object).
 */
export function zpoolJsonShape(stdout: string): 'empty' | 'json' | 'other' {
  const text = stdout.trim()
  if (text === '')
    return 'empty'
  try {
    const doc = JSON.parse(text) as { pools?: unknown } | null
    return typeof doc === 'object' && doc !== null && !Array.isArray(doc)
      && typeof doc.pools === 'object' && doc.pools !== null && !Array.isArray(doc.pools)
      ? 'json'
      : 'other'
  }
  catch {
    return 'other'
  }
}

/**
 * Whether a zpool `-j` answer (`list` or `status`) is one a reader can act on,
 * or WHY it is not (cr3, widening cr.64b2's honest empty without a node
 * capture of a pool-less node). ANSWERED: exit 0 with a JSON object (its
 * `pools` empty or absent) or with nothing printed; or zpool's no-pools
 * sentence on either stream at any exit ({@link zpoolSaysNoPools}) with no
 * JSON on stdout. UNREADABLE: a non-zero exit without that sentence, or exit
 * 0 with output that is neither JSON nor the sentence. A timeout or a spawn
 * failure other than ENOENT rejects before this is asked.
 */
export function zpoolJsonUnreadable(r: { exitCode: number, stdout: string, stderr: string }, what: string): string | null {
  const shape = zpoolJsonShape(r.stdout)
  if (r.exitCode === 0 && shape !== 'other')
    return null
  if (shape !== 'json' && zpoolSaysNoPools(r))
    return null
  const line = (r.stderr.trim() || r.stdout.trim()).split('\n')[0]
  return r.exitCode === 0
    ? `${what} could not be read (exit 0 with output that is not its JSON: ${line.slice(0, 120)})`
    : `${what} could not be read (exit ${r.exitCode}${line ? `: ${line}` : ''})`
}

/**
 * Whether a `zpool list -j` answer is one a reader can act on, or a read that
 * could not see the pool set (cr.64b2, shared by the pool doors and the
 * dashboard since cr3): {@link zpoolJsonUnreadable}. `null` = the answer seen
 * (a listing, or the honest empty); anything else is the sentence saying the
 * listing could not be read: a reader refuses (503) or marks its section
 * unavailable, and never answers "no pools". After a null answer,
 * {@link parseZpoolList} reads every honest-empty shape as [].
 */
export function zpoolListUnreadable(list: { exitCode: number, stdout: string, stderr: string }): string | null {
  return zpoolJsonUnreadable(list, 'zpool list -j')
}

/**
 * A pool name as ONE shell word for a command the operator pastes (cr3
 * re-review item 4: ZFS allows spaces in a pool name, and `zpool export old
 * pool` exports two pools). Always single-quoted; an embedded single quote —
 * which ZFS refuses in a name, so never expected — is written `'\''`, the
 * house rule (`remoteShellWord`). A pool name carries no control character.
 */
function shellWord(name: string): string {
  return `'${name.replace(SINGLE_QUOTE_RE, `'\\''`)}'`
}

/**
 * The `unmanaged` marker for a pool whose name ANAS's `PoolName` refuses (cr3,
 * operator ruling 2026-11-14: the name rule is NOT widened). ZFS allows `.`,
 * `:` and spaces in a pool name; every ANAS verb validates the name first, so
 * such a pool would list as manageable and answer each action with a bare
 * 400. Null for every name ANAS accepts.
 */
export function unmanagedPoolName(name: string): PoolUnmanaged | null {
  if (PoolName.safeParse(name).success)
    return null
  return {
    reason: 'pool-name',
    message: `ANAS does not manage a pool named ${shellWord(name)}: ANAS accepts pool names of letters, digits, '_' and '-' only, starting with a letter. `
      + `The pool can be renamed by exporting it and importing it under a new name: zpool export ${shellWord(name)}, then zpool import ${shellWord(name)} <new name>.`,
  }
}

/**
 * Parse `zpool list -j` JSON output into pool summaries.
 * Note: This provides size/capacity data. State and health come from zpool-status parser.
 */
export function parseZpoolList(json: string | ZpoolListOutput): Omit<PoolSummary, 'scanRunning' | 'scanFunction' | 'trimSupported' | 'upgradeAvailable' | 'health' | 'pveStorages'>[] {
  // cr3: zpool's no-pools sentence (not JSON) is the honest empty — callers
  // ask zpoolListUnreadable first, which refuses a document with no `pools`.
  if (typeof json === 'string' && zpoolJsonShape(json) === 'other' && zpoolSaysNoPools({ stdout: json, stderr: '' }))
    return []
  const data: ZpoolListOutput = parseZfsJson(json, { pools: {} })
  return Object.values(data.pools).map((pool) => {
    const prop = (name: string) => pool.properties[name]?.value ?? '-'

    return {
      name: pool.name,
      state: pool.state as PoolSummary['state'],
      size: parseHumanSize(prop('size')),
      allocated: parseHumanSize(prop('allocated')),
      free: parseHumanSize(prop('free')),
      fragmentation: parsePercent(prop('fragmentation')),
      capacity: parsePercent(prop('capacity')),
      dedupRatio: parseDedupRatio(prop('dedupratio')),
    }
  })
}
