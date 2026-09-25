import { z } from 'zod'

// --- Job lifecycle ---

/**
 * `cancelled` (rclone.5, ADDITIVE): a running job whose own cancel hook ran on
 * a confirmed `POST /v1/jobs/:id/cancel` — or whose body reported that the work
 * it watched was cancelled. Its `result` carries `{ status: 'cancelled',
 * reason: 'cancelled by <user> at <time>' }` and `error` stays null: a cancel is
 * what the operator asked for, not a failure.
 */
export const JobStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled'])
export type JobStatus = z.infer<typeof JobStatus>

/** Job summary returned in 202 Accepted responses */
export const JobRef = z.object({
  id: z.string().uuid(),
  status: JobStatus,
  operation: z.string(),
  createdAt: z.string().datetime(),
  createdBy: z.string(),
})
export type JobRef = z.infer<typeof JobRef>

/** 202 Accepted response envelope */
export const JobAccepted = z.object({
  job: JobRef,
})
export type JobAccepted = z.infer<typeof JobAccepted>

/** Full job detail (GET /v1/jobs/:id) */
export const Job = z.object({
  id: z.string().uuid(),
  status: JobStatus,
  operation: z.string(),
  progress: z.string().nullable(),
  createdAt: z.string().datetime(),
  createdBy: z.string(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  result: z.unknown().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .nullable(),
})
export type Job = z.infer<typeof Job>

/** GET /v1/jobs response */
export const JobList = z.object({
  data: z.array(Job),
})
export type JobList = z.infer<typeof JobList>

/** GET /v1/jobs/:id response */
export const JobDetail = z.object({
  job: Job,
})
export type JobDetail = z.infer<typeof JobDetail>
