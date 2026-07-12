import { defineConfig, devices } from '@playwright/test';

// E2E smoke tests live in tests/e2e/*.spec.ts. Unit tests (vitest) use
// tests/**/*.test.ts, so the two suites never collide.
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3107);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // The npm script builds first, then Playwright owns this single server
  // process. A flat lifecycle lets the runner reliably stop Next on Windows.
  webServer: process.env.PLAYWRIGHT_EXTERNAL_SERVER === '1' ? undefined : {
    command: `node node_modules/next/dist/bin/next start -p ${PORT}`,
    url: baseURL,
    timeout: 420_000,
    reuseExistingServer: false,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'dummy-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'dummy-service-role-key',
      NEXT_PUBLIC_APP_URL: baseURL,
    },
  },
});
