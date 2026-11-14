import type { CommandExecutor, ExecResult } from '../executor/types.js'
import type { TargetPlacement } from './replication-target.js'
import type { Transport } from './replication-transport.js'
import type { TreeFacts } from './replication-tree.js'
import { parseTreeList, parseTreeProps, parseTreeSnapshots, zfsTreeGetArgs, zfsTreeSnapshotsArgs } from '../parsers/zfs-tree.js'
import { pveDescendantsUnlistedMessage } from './pve-footprint.js'
import { isAtOrUnder, ZFS, ZFS_REMOTE, zfsTreeListArgs } from './zfs-snapshot.js'

/**
 * The fact READER of recursive replication (rrep.1b, #84, R1/R5): the six
 * listings the planner needs, each ONE command, each judged by EXIT CODE and
 * nothing else. A read that did not answer — a non-zero exit, an ssh that
 * could not connect (255), a line the parser refuses — refuses the run with
 * one sentence. It is NEVER read as "the dataset is absent", "no snapshots",
 * "not encrypted" or "not modified": those four are exactly what a `zfs send`
 * must not be launched on a guess about (fixture README, rrep.0 ground truth:
 * a missing dataset and an empty one differ ONLY by the exit code).
 *
 * No decisions live here beyond "could I read it" — the planner
 * (services/replication-tree.ts) decides everything else from the facts.
 */

export interface TreeReadDeps {
  /** The command executor for the LOCAL side (always the source; a local target too). */
  executor: CommandExecutor
  /** The SSH transport — used only when the target lives on a peer/remote. */
  transport: Transport
}

export interface TreeReadInput {
  /** The source root (always local, pool-qualified). */
  sourceRoot: string
  /** The target root (pool-qualified). */
  targetRoot: string
  /** The request's exclude list (shape and existence are the gate's questions). */
  exclude: string[]
  /** Where the target lives: this node, or a resolved peer/remote. */
  placement: TargetPlacement
}

export type TreeReadResult
  = | { ok: true, facts: TreeFacts }
    | { ok: false, message: string }

/** The sentence every read failure ends in. */
const REFUSING = ' — refusing the recursive replication'

/**
 * A read failure's sentence without the run's ending (repl.drift review 2,
 * defect 1): a status read or the daily check that could not read the tree
 * refuses nothing, so it says only what could not be read.
 */
export function readFailureReason(message: string): string {
  return message.endsWith(REFUSING) ? message.slice(0, -REFUSING.length) : message
}

function snapshotsUnreadable(root: string, onTarget: boolean): string {
  return `Could not list the snapshots under '${root}'${onTarget ? ' on the target' : ''}${REFUSING}`
}

/** A parser that refused a line: its own message, plus where it stops the run. */
function parseRefusal(err: unknown): { ok: false, message: string } {
  return { ok: false, message: `${err instanceof Error ? err.message : String(err)}${REFUSING}` }
}

/**
 * Read every fact the planner needs, or the first sentence saying why not.
 * Order is fixed: a failure returns at once, so no later read is attempted
 * (a run whose source listing failed must not go on to ask the target).
 */
export async function readTreeFacts(deps: TreeReadDeps, input: TreeReadInput): Promise<TreeReadResult> {
  const { executor, transport } = deps
  const { placement } = input
  // The target side: a local target is a second local `zfs`; a peer/remote is
  // `ssh ... zfs ...` (the unqualified remote binary, ZFS_REMOTE).
  return readTreeFactsWith({
    source: (args: string[]): Promise<ExecResult> => executor.exec(ZFS, args),
    target: placement.isRemote
      ? (args: string[]): Promise<ExecResult> => transport.sshExec(placement.resolved, [ZFS_REMOTE, ...args])
      : (args: string[]): Promise<ExecResult> => executor.exec(ZFS, args),
  }, { sourceRoot: input.sourceRoot, targetRoot: input.targetRoot, exclude: input.exclude, localTarget: !placement.isRemote })
}

/** `zfs <args>` on one side of the tree read. */
export type TreeZfsRunner = (args: string[]) => Promise<ExecResult>

/**
 * The same six reads over runners the caller built (repl.drift P1: a task's
 * status read and the daily check reach a peer/remote target through the task
 * list's own ssh reader, not through a resolved placement).
 */
export async function readTreeFactsWith(
  runners: { source: TreeZfsRunner, target: TreeZfsRunner },
  input: { sourceRoot: string, targetRoot: string, exclude: string[], localTarget: boolean },
): Promise<TreeReadResult> {
  const { sourceRoot, targetRoot, exclude } = input
  const sourceRunner = runners.source
  const targetRunner = runners.target

  // 1. The source's own tree. A failure is the same fact a failed recursive
  //    verb reports elsewhere: the subtree could not be listed.
  //    `zfs list -r -- <root>` always prints the root's own row FIRST; an
  //    exit 0 whose listing does not start with the root did not answer the
  //    question (rrep.1b fold 1, review B7) and is refused with the same
  //    sentence as a failed read, never read as an empty subtree.
  const treeRead = await sourceRunner(zfsTreeListArgs(sourceRoot))
  if (treeRead.exitCode !== 0)
    return { ok: false, message: pveDescendantsUnlistedMessage('replication', sourceRoot) }
  let sourceTree: string[]
  try {
    sourceTree = parseTreeList(treeRead.stdout)
  }
  catch (err) {
    return parseRefusal(err)
  }
  if (sourceTree[0] !== sourceRoot)
    return { ok: false, message: pveDescendantsUnlistedMessage('replication', sourceRoot) }

  // 2. Every snapshot of the source tree. Exit 0 with empty stdout is "no
  //    snapshots" — the planner refuses that itself (there is no S).
  const snapsRead = await sourceRunner(zfsTreeSnapshotsArgs(sourceRoot))
  if (snapsRead.exitCode !== 0)
    return { ok: false, message: snapshotsUnreadable(sourceRoot, false) }
  let sourceSnaps: Map<string, string[]>
  try {
    sourceSnaps = parseTreeSnapshots(snapsRead.stdout)
  }
  catch (err) {
    return parseRefusal(err)
  }

  // 3. The source tree's keystatus (R5f). A failure here is UNREADABLE, never
  //    "unencrypted".
  const keysRead = await sourceRunner(zfsTreeGetArgs(sourceRoot, ['keystatus']))
  if (keysRead.exitCode !== 0)
    return { ok: false, message: `Could not read the encryption state under '${sourceRoot}'${REFUSING}` }
  let sourceProps: Map<string, Record<string, string>>
  try {
    sourceProps = parseTreeProps(keysRead.stdout)
  }
  catch (err) {
    return parseRefusal(err)
  }

  // 4. Does the target root exist? Never ask `zfs list <root>` and read a
  //    non-zero exit as "absent" — an unreachable peer exits non-zero too.
  //    List the target POOL's tree instead: a reachable pool that does not
  //    contain the root is the only honest "absent". That listing always
  //    starts with the pool's own row; an exit 0 that does not start with
  //    the pool did not answer the question either (rrep.1b fold 1, review
  //    B1) — "no row of the root" only means "absent" once the listing is
  //    known to be the pool's, so refuse it with the same sentence.
  const targetPool = targetRoot.split('/')[0]
  const poolRead = await targetRunner(zfsTreeListArgs(targetPool))
  if (poolRead.exitCode !== 0)
    return { ok: false, message: `Could not list the datasets of pool '${targetPool}' on the target${REFUSING}` }
  let poolRows: string[]
  try {
    poolRows = parseTreeList(poolRead.stdout)
  }
  catch (err) {
    return parseRefusal(err)
  }
  if (poolRows[0] !== targetPool)
    return { ok: false, message: `Could not list the datasets of pool '${targetPool}' on the target${REFUSING}` }
  const targetTree = poolRows.filter(name => isAtOrUnder(name, targetRoot))

  let targetSnaps = new Map<string, string[]>()
  let targetProps = new Map<string, Record<string, string>>()
  if (targetTree.length > 0) {
    // 5. The target root's snapshots (the base search's target side).
    const tSnapsRead = await targetRunner(zfsTreeSnapshotsArgs(targetRoot))
    if (tSnapsRead.exitCode !== 0)
      return { ok: false, message: snapshotsUnreadable(targetRoot, true) }
    try {
      targetSnaps = parseTreeSnapshots(tSnapsRead.stdout)
    }
    catch (err) {
      return parseRefusal(err)
    }

    // 6. The target tree's `written` (R5g): has a replica been modified since
    //    its last received snapshot? A failure is UNREADABLE, never "0".
    //    repl.drift: `readonly` in the same command (the captured
    //    `dst-written.txt` shape) — a copy that is not read-only is `exposed`.
    const writtenRead = await targetRunner(zfsTreeGetArgs(targetRoot, ['written', 'readonly']))
    if (writtenRead.exitCode !== 0)
      return { ok: false, message: `Could not read the modification state under '${targetRoot}' on the target${REFUSING}` }
    try {
      targetProps = parseTreeProps(writtenRead.stdout)
    }
    catch (err) {
      return parseRefusal(err)
    }
  }

  return {
    ok: true,
    facts: {
      sourceRoot,
      targetRoot,
      exclude,
      localTarget: input.localTarget,
      sourceTree,
      sourceSnaps,
      sourceProps,
      targetTree,
      targetSnaps,
      targetProps,
    },
  }
}
