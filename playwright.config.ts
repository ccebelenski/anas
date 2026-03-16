import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'html',
  projects: [
    {
      name: 'dev',
      testDir: './tests/dev',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3100',
        screenshot: 'on',
      },
    },
    {
      name: 'integration',
      testDir: './tests/integration',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://192.168.200.50:3000',
        ignoreHTTPSErrors: true,
        screenshot: 'only-on-failure',
        trace: 'on-first-retry',
      },
    },
  ],
})
