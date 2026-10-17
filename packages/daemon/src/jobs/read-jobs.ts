import type { JobContext } from './queue.js'
import { assertRunNotCancelled, ChildCancel } from './child-cancel.js'

/**
 * Jobs that only READ (cr.48, operator ruling 2026-10-15).
 *
 * Three interactive reads — the cloud sync preview, the rclone remote Test and
 * the PBS catalog listing — can take minutes on a slow remote or a large
 * archive, so they run as jobs (202 + poll, the answer in `job.result`) with a
 * generous ceiling and a Cancel. They change nothing on the node, which two
 * places need to know:
 *
 *  - the cancel door (`POST /v1/jobs/:id/cancel`) stops one without the
 *    confirm a run's cancel asks for — a cancelled read has no consequence;
 *  - cr.28 (the queue refusing work without Sys.Modify) admits them on
 *    Sys.Audit, the read privilege (operator ruling 2026-10-17, EPICS cr.28).
 *
 * The marker is an OPERATION-NAME convention, not a submit flag: every
 * read-only job's operation starts with {@link READ_JOB_PREFIX}. The name is
 * on the wire `Job` (GET /v1/jobs, the audit line, the cancel route's
 * pre-flight) and in the submitter record, so a check that only has the
 * operation — the gateway included — can key on it, and the queue (whose
 * SubmitOptions another story is editing) needs no new field. A unit test
 * pins that no source outside this file spells the prefix, so a read-only job
 * can only be added here.
 */
export const READ_JOB_PREFIX = 'read.'

/** The read-only jobs, one constant each — the routes submit these names. */
export const READ_JOB_OPERATIONS = Object.freeze({
  /** POST /v1/cloud/tasks/preview — the rclone dry run. */
  cloudPreview: 'read.cloud.preview',
  /** POST /v1/cloud/remotes/test — the bounded `lsjson` probe. */
  cloudRemoteTest: 'read.cloud.remote.test',
  /** POST /v1/backup/restore/browse — one directory level of a PBS archive. */
  backupCatalog: 'read.backup.catalog',
} as const)

/** Is this job one that only reads? The ONE predicate (the cancel route; cr.28 next). */
export function isReadOnlyOperation(operation: string): boolean {
  return operation.startsWith(READ_JOB_PREFIX)
}

/**
 * The cancel seam a read job's body wires to its child(ren): the read ladder
 * (SIGTERM, then SIGKILL, to the child's process group — `stopReadChild`),
 * an `onSpawn` for every exec, and a `checkpoint` that ends the job
 * `cancelled` at the next boundary when a cancel was accepted between two
 * children. Construct it FIRST in the body: a running read job then always
 * has its hook, so the cancel route never refuses one as "not cancellable".
 */
export function readJobCancel(ctx: JobContext, label: string, subject: string, waitMs?: number): {
  onSpawn: ChildCancel['onSpawn']
  checkpoint: (next: string) => void
} {
  const cancel = new ChildCancel(
    ctx,
    label,
    { subject, consequence: 'Nothing is changed — it only reads.' },
    { ladder: 'read', ...(waitMs !== undefined ? { waitMs } : {}) },
  )
  return {
    onSpawn: cancel.onSpawn,
    checkpoint: next => assertRunNotCancelled(cancel, next),
  }
}
