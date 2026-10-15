import { defineConfig, devices } from '@playwright/test'

/**
 * Wave-3 node pass probes (docs/LIVE-PROOF-0.4.4-wave3.md). Not part of the
 * integration suite: each probe needs throwaway state the record's row sets up
 * (pool, disks) and is run by hand:
 *
 *   W3_POOL=w3n3 npx playwright test -c docs/probes/wave3-node/playwright.config.ts n3-cleanup-rechallenge
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  projects: [
    {
      name: 'w3probe',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 2560, height: 1080 },
        ignoreHTTPSErrors: true,
        screenshot: 'only-on-failure',
      },
    },
  ],
})
