import type { FastifyInstance } from 'fastify'
import { JobStatus } from '@anas/shared'
import type { JobQueue } from '../jobs/queue.js'

export async function jobRoutes(
  server: FastifyInstance,
  opts: { jobQueue: JobQueue },
) {
  const { jobQueue } = opts

  /** GET /v1/jobs — list jobs, optionally filtered by ?status= */
  server.get<{
    Querystring: { status?: string }
  }>('/jobs', async (request, reply) => {
    const { status } = request.query

    if (status) {
      const parsed = JobStatus.safeParse(status)
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: `Invalid status filter: must be one of ${JobStatus.options.join(', ')}`,
          },
        })
      }
      return { data: jobQueue.list(parsed.data) }
    }

    return { data: jobQueue.list() }
  })

  /** GET /v1/jobs/:id — job detail */
  server.get<{
    Params: { id: string }
  }>('/jobs/:id', async (request, reply) => {
    const job = jobQueue.get(request.params.id)

    if (!job) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `Job '${request.params.id}' not found`,
        },
      })
    }

    return { job }
  })
}
