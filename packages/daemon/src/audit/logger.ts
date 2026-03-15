import type { FastifyBaseLogger } from 'fastify'

export interface AuditEntry {
  user: string
  uid: number
  operation: string
  params?: Record<string, unknown>
  requestId?: string
}

export interface AuditResult {
  status: 'completed' | 'failed'
  durationMs: number
  error?: string
}

/**
 * Audit logger for mutating operations.
 *
 * Logs structured JSON via Fastify's pino logger. Since anasd runs
 * under systemd, all stdout is captured by journald — queryable via
 * `journalctl -u anasd -o json`.
 *
 * Every mutation logs twice: once when submitted, once when finished.
 */
export class AuditLogger {
  private log: FastifyBaseLogger

  constructor(logger: FastifyBaseLogger) {
    this.log = logger.child({ audit: true })
  }

  /** Log when a mutation is submitted. */
  submitted(entry: AuditEntry): void {
    this.log.info(
      {
        event: 'job.submitted',
        user: entry.user,
        uid: entry.uid,
        operation: entry.operation,
        params: entry.params,
        requestId: entry.requestId,
      },
      `audit: ${entry.user} submitted ${entry.operation}`,
    )
  }

  /** Log when a mutation completes or fails. */
  finished(entry: AuditEntry, result: AuditResult): void {
    const level = result.status === 'completed' ? 'info' : 'error'
    this.log[level](
      {
        event: `job.${result.status}`,
        user: entry.user,
        uid: entry.uid,
        operation: entry.operation,
        params: entry.params,
        requestId: entry.requestId,
        durationMs: result.durationMs,
        ...(result.error ? { error: result.error } : {}),
      },
      `audit: ${entry.operation} ${result.status} (${result.durationMs}ms)`,
    )
  }
}
