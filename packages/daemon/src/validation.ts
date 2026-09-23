import type { ZodError } from 'zod'

/**
 * Render the FIRST Zod issue of a failed parse for a 400 message, NAMING THE
 * FIELD: the issue's path (joined with `.`) and its message, as
 * `credentials.password — Invalid input: expected string, received undefined`.
 * A top-level issue (an empty path — the body itself is the wrong shape)
 * carries the message alone; the dash goes with the path. The route owns the
 * label ("Invalid create mount request"); this owns the field naming, so a
 * 400 says which field is wrong, not only that the shape is.
 */
export function zodIssue(error: ZodError): string {
  const issue = error.issues[0]
  if (!issue)
    return 'an invalid value'
  const path = issue.path.join('.')
  return path ? `${path} — ${issue.message}` : issue.message
}
