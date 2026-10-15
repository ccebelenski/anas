import { defineConfig, devices } from '@playwright/test'

/**
 * Wave-2 node pass browser proofs (cr.48 read jobs, the §8 row 4 privilege
 * panel, cr.29/29b/29c identity dialogs). Not part of the integration suite:
 * each proof relies on fixtures the wave-2 setup scripts made (remotes w2ok /
 * w2bh, repos pbsgt / w2bh, user anas-none@pve) and is run by hand:
 *
 *   npx playwright test -c docs/probes/wave2-node/playwright.config.ts w2-readjobs
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: '../../../.w2tmp/w2-playwright-results',
  projects: [
    {
      name: 'w2probe',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 2560, height: 1080 },
        ignoreHTTPSErrors: true,
        screenshot: 'only-on-failure',
      },
    },
  ],
})
