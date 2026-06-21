import { defineConfig, devices } from '@playwright/test';

// E2E smoke tests live in tests/e2e/*.spec.ts. Unit tests (vitest) use
// tests/**/*.test.ts, so the two suites never collide.
const PORT = 3000;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
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
  // Build + start the app once for the whole run. Dummy Supabase env keeps
  // static generation from crashing; public pages fail closed to safe defaults.
  webServer: {
    command: 'npm run build && npm run start',
    url: baseURL,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'dummy-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'dummy-service-role-key',
      NEXT_PUBLIC_APP_URL: baseURL,
    },
  },
});
