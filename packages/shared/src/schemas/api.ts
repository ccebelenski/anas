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
  /**
   * 403 — cr.27 (WAVE2-DESIGN §5 row 11): PVE does not grant the user the
   * privilege the method needs on `/` (GET/HEAD Sys.Audit, else Sys.Modify).
   */
  'FORBIDDEN',
  // cr.3 (review C3): a mutation aimed at a system account — uid/gid outside
  // the share band [1000, 60000). Hard refusal, no confirm bypass.
  'SYSTEM_ACCOUNT',
  // Gateway-only: a peer node's gateway could not be reached (story 13.8).
  'NODE_UNREACHABLE',
  // cr.17: the codes the daemons and gateway have always emitted but the enum
  // never carried. None of these are renames — the UI keys on several
  // (10-api.js: CONFLICT / IN_USE / IDENTITY_MISMATCH; 65-replication.js and
  // 69-snapshots.js: CONFLICT / UNAVAILABLE), and the enum's job is to be the
  // complete list, not to relabel what ships.
  /** 409 — the resource's state refuses the operation (daemon-wide). */
  'CONFLICT',
  /** 503 — a required tool or store is not present on the node (daemon). */
  'UNAVAILABLE',
  /** 409 — something else still references the resource (daemon). */
  'IN_USE',
  /** 409 — the resource belongs to PVE (storage.cfg), not ANAS (daemon). */
  'PVE_MANAGED',
  /** 409 — a confirm-bounded target changed between confirm and act (daemon). */
  'IDENTITY_MISMATCH',
  /** 409 — the job exists but is past the point a cancel can reach (daemon). */
  'NOT_CANCELLABLE',
  /** 502 — an upstream (PBS, a peer) refused or failed the read (daemon). */
  'UPSTREAM_ERROR',
  /** Gateway: the forwarded-to node's ANAS is not installed. */
  'ANAS_NOT_INSTALLED',
  /** Gateway: the PVE cluster CA needed for peer TLS is unavailable. */
  'CLUSTER_CA_UNAVAILABLE',
  /** Gateway: the target node name resolved to nothing. */
  'NODE_UNRESOLVED',
  /** Gateway: a peer node's gateway did not answer in time. */
  'GATEWAY_TIMEOUT',
  /** Gateway: a forward came back to us (cycle guard). */
  'FORWARD_LOOP',
  /**
   * cr.26 (daemon, WAVE2-DESIGN §3 row 14): mutation with a non-JSON
   * `Content-Type`, or a body without one — the daemon accepts JSON only.
   */
  'UNSUPPORTED_MEDIA_TYPE',
  /**
   * 409 — cr.32 (WAVE3-DESIGN §3.2): the object is the same one, but its state
   * (or the set a destructive verb would sweep) is not the one the request
   * was computed from; nothing was done.
   */
  'STATE_CHANGED',
  /**
   * 409 — cr.32 (WAVE3-DESIGN §5.2): the confirm code was minted for this
   * object with different request options; the error names the fields and
   * carries a fresh code.
   */
  'CONFIRM_SCOPE_CHANGED',
  /**
   * cr.34 (daemon, WAVE3-DESIGN §6.2): a command did not finish within its
   * deadline — 503 on the request path (the sentence names the command and
   * the budget), and the code of a job that died of it.
   */
  'TIMEOUT',
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

// --- Authorization (cr.27, cr.28; docs/WAVE2-DESIGN.md A1, A3.1) ---

/**
 * The two privileges ANAS asks PVE about, on `/`: `Sys.Audit` to read,
 * `Sys.Modify` to change — what PVE asks for its own ZFS, LVM and directory
 * disk verbs. The gateway applies the method rule with them (cr.27); the
 * daemon's job queue applies them again at submit (cr.28, the backstop).
 */
export const PRIVILEGES = ['Sys.Audit', 'Sys.Modify'] as const
export const Privilege = z.enum(PRIVILEGES)
export type Privilege = z.infer<typeof Privilege>

/**
 * The `x-anas-privileges` header: what PVE granted the requester on `/`,
 * comma-separated exactly as the gateway joins them (`Sys.Audit,Sys.Modify`,
 * `Sys.Audit`, or the empty string for none). Strict on purpose — an unknown
 * name, a repeated one, or whitespace (two headers that Node joined with
 * `, `) is not a list this rule can read, so it fails validation and the
 * request is refused rather than guessed at (fail closed).
 */
export const PrivilegeList = z.string().transform((value, ctx): Privilege[] => {
  if (value === '')
    return []
  const out: Privilege[] = []
  for (const name of value.split(',')) {
    const parsed = Privilege.safeParse(name)
    if (!parsed.success || out.includes(parsed.data)) {
      ctx.addIssue({ code: 'custom', message: `'${value}' is not a privilege list (expected names from ${PRIVILEGES.join(', ')}, comma-separated, none repeated)` })
      return z.NEVER
    }
    out.push(parsed.data)
  }
  return out
})

/**
 * The 403 sentence, gateway and daemon alike (WAVE2-DESIGN §5 row 11): PVE's
 * own "Permission check failed (<path>, <priv>)" form.
 */
export function forbiddenMessage(user: string, privilege: Privilege): string {
  return `Permission check failed (/, ${privilege}): ${user} does not have it. `
    + 'ANAS asks the privilege PVE asks for its own disk and ZFS operations.'
}

// --- Request identity headers (anas → anasd) ---

/**
 * Who is asking, and (cr.28) what PVE grants them on `/`. The gateway sends
 * all four with every forwarded request; a root socket client that submits
 * work (the systemd task runners, the udev cache-event script) sends them
 * too, naming both privileges. `x-anas-privileges` is REQUIRED: a request
 * without it, or with one that is not a {@link PrivilegeList}, is refused
 * (fail closed) — there is no "absent means trusted".
 */
export const RequestHeaders = z.object({
  'x-anas-user': z.string(),
  'x-anas-user-uid': z.coerce.number().int(),
  'x-anas-request-id': z.string().uuid(),
  'x-anas-privileges': PrivilegeList,
})
export type RequestHeaders = z.infer<typeof RequestHeaders>

// --- Safety / confirmation ---

export const ConfirmHeader = z.object({
  'x-anas-confirm': z.string(),
})
export type ConfirmHeader = z.infer<typeof ConfirmHeader>
