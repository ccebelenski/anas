import { z } from 'zod'

// --- API response envelopes ---

/** Wraps any successful GET response */
export function dataResponse<T extends z.ZodTypeAny>(schema: T) {
  return z.object({
    data: schema,
  })
}

/** Standard error codes */
export const ErrorCode = z.enum([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'PROTECTED_RESOURCE',
  'CONFIRMATION_REQUIRED',
  'INTERNAL_ERROR',
  'UNAUTHORIZED',
  // Gateway-only: a peer node's gateway could not be reached (story 13.8).
  'NODE_UNREACHABLE',
])
export type ErrorCode = z.infer<typeof ErrorCode>

/** Error response body (4xx/5xx) */
export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    /** Present only for CONFIRMATION_REQUIRED */
    warnings: z.array(z.string()).optional(),
  }),
})
export type ApiError = z.infer<typeof ApiError>

// --- Request identity headers (anas → anasd) ---

export const RequestHeaders = z.object({
  'x-anas-user': z.string(),
  'x-anas-user-uid': z.coerce.number().int(),
  'x-anas-request-id': z.string().uuid(),
})
export type RequestHeaders = z.infer<typeof RequestHeaders>

// --- Safety / confirmation ---

export const ConfirmHeader = z.object({
  'x-anas-confirm': z.string(),
})
export type ConfirmHeader = z.infer<typeof ConfirmHeader>
