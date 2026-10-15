import { z } from 'zod'

/**
 * A command the daemon gave up on (cr.34, WAVE3-DESIGN §6.2): it outlived its
 * deadline AND the SIGKILL that followed, so it is stuck in the kernel
 * (uninterruptible sleep — a suspended pool, a dead hard NFS mount). It stays
 * listed until it finally exits or anasd restarts.
 *
 * It names the command the way the audit log does (cr.34r, §6.2 "redacted like
 * the audit log"): the short label and the executable, never the argv. A
 * job's own record (`jobId`) carries the object it acted on.
 */
export const AbandonedCommand = z.object({
  pid: z.number().int(),
  /** Short name: the executable's basename and subcommand (`zpool status`). */
  label: z.string(),
  /** Absolute path of the executable. */
  command: z.string(),
  /** Why the daemon was stopping it: its deadline passed, or its output went over the cap (cr.34r). */
  cause: z.enum(['deadline', 'maxBuffer']),
  /** Where it ran: a request, a job, or the daemon's own background work. */
  lane: z.enum(['request', 'job', 'background']),
  /** The job it belonged to, when it ran in one. */
  jobId: z.string().optional(),
  /** The deadline it outlived, in milliseconds. */
  budgetMs: z.number().int(),
  /** ISO time the daemon stopped waiting for it. */
  since: z.string(),
})
export type AbandonedCommand = z.infer<typeof AbandonedCommand>

/** GET /v1/health. `abandonedCommands` is additive (cr.34); an older daemon omits it. */
export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
  abandonedCommands: z.array(AbandonedCommand).optional(),
})
export type HealthResponse = z.infer<typeof HealthResponse>
