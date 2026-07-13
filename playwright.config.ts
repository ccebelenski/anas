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
        baseURL: 'https://192.168.200.50:3000',
        ignoreHTTPSErrors: true,
        screenshot: 'only-on-failure',
        trace: 'on-first-retry',
      },
    },
  ],
  // Auto-start dev server for the 'dev' project
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3100',
    reuseExistingServer: true,
    timeout: 30000,
    env: {
      ANASD_SOCKET: '/tmp/anasd.sock',
      ANAS_AUTH_PROVIDER: 'dev',
    },
  },
})
