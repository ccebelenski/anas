/**
 * Embedded display mode (story 13.2).
 *
 * When ANAS is embedded inside the PVE UI via `?embedded=1`, its own chrome
 * (sidebar, header) is hidden and views render content-only, filling the frame.
 *
 * The flag is read once at app start (see plugins/embedded.ts) and stored in
 * `useState`, so it persists across all in-app navigation regardless of whether
 * a given route carries the query param.
 */
export function useEmbedded() {
  return useState<boolean>('anas:embedded', () => false)
}
