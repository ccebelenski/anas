import type { FrameLocator, Page } from '@playwright/test'

/**
 * Navigate and wait for Vue hydration before interacting.
 *
 * Server-rendered DOM is visible before Vue attaches event listeners; a
 * click that lands in that window hits dead handlers and silently does
 * nothing. The app stamps `html[data-hydrated]` on app:mounted
 * (plugins/hydrated.client.ts) as the deterministic ready signal.
 */
export async function gotoHydrated(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 15_000 })
}

/** Same hydration wait for an embedded ANAS view inside an iframe. */
export async function waitForFrameHydrated(frame: FrameLocator): Promise<void> {
  await frame.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 20_000 })
}
