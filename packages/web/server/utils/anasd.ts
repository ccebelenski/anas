import type { ApiError } from '@anas/shared'
import type { H3Event } from 'h3'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'

const SOCKET_PATH = process.env.ANASD_SOCKET ?? '/run/anas/anasd.sock'

interface AnasdRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  /** Pass the H3 event to propagate auth headers to anasd */
  event: H3Event
  /** Optional confirmation code for dangerous operations */
  confirmCode?: string
}

interface AnasdResponse<T = unknown> {
  status: number
  headers: Record<string, string | string[] | undefined>
  data: T
}

/**
 * Low-level HTTP client for anasd over Unix socket.
 *
 * Propagates user identity via X-Anas-* headers and forwards
 * the confirmation code header when present.
 */
export function anasdRequest<T = unknown>(
  opts: AnasdRequestOptions,
): Promise<AnasdResponse<T>> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'accept': 'application/json',
      'x-anas-request-id': randomUUID(),
    }

    // Propagate user identity from the session (set by auth middleware)
    const user = opts.event.context.user as
      | { name: string, uid: number }
      | undefined
    if (user) {
      headers['x-anas-user'] = user.name
      headers['x-anas-user-uid'] = String(user.uid)
    }

    // Confirmation code for dangerous operations
    if (opts.confirmCode) {
      headers['x-anas-confirm'] = opts.confirmCode
    }

    let bodyStr: string | undefined
    if (opts.body !== undefined) {
      bodyStr = JSON.stringify(opts.body)
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(bodyStr))
    }

    const req = httpRequest(
      {
        socketPath: SOCKET_PATH,
        method: opts.method,
        path: opts.path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let data: T
          try {
            data = JSON.parse(raw) as T
          }
          catch {
            data = raw as T
          }
          resolve({
            status: res.statusCode ?? 500,
            headers: res.headers as Record<string, string | string[] | undefined>,
            data,
          })
        })
      },
    )

    req.on('error', (err) => {
      reject(
        createError({
          statusCode: 502,
          statusMessage: 'Bad Gateway',
          message: `anasd unavailable: ${err.message}`,
        }),
      )
    })

    if (bodyStr) {
      req.write(bodyStr)
    }
    req.end()
  })
}

// --- Convenience helpers ---

/** GET a resource from anasd. Throws H3 errors on failure. */
export async function anasdGet<T = unknown>(
  event: H3Event,
  path: string,
): Promise<T> {
  const res = await anasdRequest<T>({ method: 'GET', path, event })
  if (res.status >= 400) {
    throwAnasdError(res)
  }
  return res.data
}

/** POST a mutation to anasd. Returns the 202 job response or throws. */
export async function anasdPost<T = unknown>(
  event: H3Event,
  path: string,
  body?: unknown,
): Promise<AnasdResponse<T>> {
  const res = await anasdRequest<T>({ method: 'POST', path, body, event })
  if (res.status >= 400) {
    throwAnasdError(res)
  }
  return res
}

/** PUT a mutation to anasd. Returns the 202 job response or throws. */
export async function anasdPut<T = unknown>(
  event: H3Event,
  path: string,
  body?: unknown,
): Promise<AnasdResponse<T>> {
  const res = await anasdRequest<T>({ method: 'PUT', path, body, event })
  if (res.status >= 400) {
    throwAnasdError(res)
  }
  return res
}

/** DELETE a resource via anasd. Handles confirmation flow. */
export async function anasdDelete<T = unknown>(
  event: H3Event,
  path: string,
  confirmCode?: string,
): Promise<AnasdResponse<T>> {
  const res = await anasdRequest<T>({
    method: 'DELETE',
    path,
    event,
    confirmCode,
  })
  if (res.status >= 400) {
    throwAnasdError(res)
  }
  return res
}

/** Convert an anasd error response into an H3 error, preserving status and body. */
function throwAnasdError(res: AnasdResponse): never {
  const body = res.data as ApiError | undefined
  const message = body?.error?.message ?? 'anasd request failed'

  throw createError({
    statusCode: res.status,
    statusMessage: message,
    data: body,
    // Forward confirmation headers so Nuxt API routes can relay them
    ...(res.headers['x-anas-confirm-code']
      ? {
          headers: {
            'x-anas-confirm-code': String(res.headers['x-anas-confirm-code']),
            ...(res.headers['x-anas-confirm-expires']
              ? {
                  'x-anas-confirm-expires': String(
                    res.headers['x-anas-confirm-expires'],
                  ),
                }
              : {}),
          },
        }
      : {}),
  })
}
