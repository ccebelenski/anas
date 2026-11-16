/** The word a failed read is reported with: the error's errno code, or its message when it has no code. */
export function errorWord(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err))
}
