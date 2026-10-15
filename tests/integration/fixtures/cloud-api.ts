import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { expect } from '@playwright/test'
import { apiContext } from './auth'
import { NODE_NAME, PVE_URL } from './target'

/**
 * PVE-authenticated API access for the cloud specs — the ticket dance and the
 * job-polling helpers cloud-remotes-ui / cloud-tasks-ui / cloud-review-fixes
 * share, extracted so the request shapes cannot drift apart (the single
 * source-of-truth rule; the two older cloud specs still carry their own copy).
 *
 * Every request goes through the PVE origin's `/anas` forward carrying the
 * PVEAuthCookie AND the CSRFPreventionToken from the same login — the same
 * door the UI itself uses (cr.25b; the pairing lives in ./auth's apiContext).
 */

export const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

/** Ticket + request context in one step — every test's setup door. */
export async function apiCtx(
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<APIRequestContext> {
  return apiContext(playwright)
}

/** Poll a 202 job through GET /v1/jobs/:id until it reaches a terminal state. */
export async function awaitJob(
  ctx: APIRequestContext,
  jobId: string,
  timeout = 90_000,
): Promise<{ status: string, error?: string, result?: any, [k: string]: any }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const res = await ctx.get(`${V1}/jobs/${jobId}`)
    expect(res.status()).toBe(200)
    const job = (await res.json()).job
    // `cancelled` (rclone.5) is as terminal as completed/failed.
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')
      return job
    if (Date.now() > deadline)
      throw new Error(`job ${jobId} still '${job.status}' after ${timeout}ms: ${job.error ?? job.progress ?? ''}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/**
 * cr.48 — one of the three slow READS (the cloud preview, the remote Test,
 * the catalog listing): POST, require the 202 with a `read.*` job, and wait
 * for it. The answer the door used to give is `job.result`.
 */
export async function readJob(
  ctx: APIRequestContext,
  url: string,
  data: unknown,
  timeout = 150_000,
): Promise<{ status: string, error?: any, result?: any, [k: string]: any }> {
  const res = await ctx.post(url, { data })
  expect(res.status(), await res.text()).toBe(202)
  const accepted = (await res.json()).job
  expect(String(accepted.operation)).toMatch(/^read\./)
  return awaitJob(ctx, accepted.id, timeout)
}

/** Submit a mutation, wait for its job, and require it to complete. */
export async function runJob(
  ctx: APIRequestContext,
  verb: 'post' | 'put' | 'delete',
  url: string,
  data?: unknown,
  opts: { headers?: Record<string, string>, timeout?: number } = {},
): Promise<void> {
  const res = await ctx[verb](url, {
    ...(data !== undefined ? { data } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
  })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id, opts.timeout)
  expect(job.status, job.error).toBe('completed')
}

/** One GET /v1/jobs/:id, verbatim — the caller asserts on the shape. */
export async function getJob(
  ctx: APIRequestContext,
  jobId: string,
): Promise<{ status: number, job?: any, body?: any }> {
  const res = await ctx.get(`${V1}/jobs/${jobId}`)
  const body = await res.json().catch(() => ({}))
  return { status: res.status(), job: body?.job, body }
}

/** Remote names the node's rclone store carries right now. */
export async function remoteNames(ctx: APIRequestContext): Promise<string[]> {
  const res = await ctx.get(`${V1}/cloud/remotes`)
  return res.ok() ? (await res.json()).data.remotes.map((r: { name: string }) => r.name) : []
}

/** Cloud sync task names the node's unit store carries right now. */
export async function taskNames(ctx: APIRequestContext): Promise<string[]> {
  const res = await ctx.get(`${V1}/cloud/tasks`)
  return res.ok() ? (await res.json()).data.map((t: { name: string }) => t.name) : []
}

/** One row of GET /v1/cloud/tasks, by name. */
export async function taskRowByName(
  ctx: APIRequestContext,
  name: string,
): Promise<{ lastRunResult: string, runningProgress?: string, [k: string]: any }> {
  const res = await ctx.get(`${V1}/cloud/tasks`)
  expect(res.status(), await res.text()).toBe(200)
  const rows = (await res.json()).data as Array<Record<string, any>>
  const row = rows.find(r => r.name === name)
  expect(row, `task ${name} present in GET /v1/cloud/tasks`).toBeTruthy()
  return row as unknown as { lastRunResult: string, runningProgress?: string, [k: string]: any }
}
