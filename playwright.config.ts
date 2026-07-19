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
    // Sandboxes ship a full Chromium at a fixed path but not Playwright's pinned
    // headless-shell build; set PW_CHROMIUM_PATH=/opt/pw-browsers/chromium to run
    // there. No-op in CI, which installs its own browsers via `playwright install`.
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Mobile device matrix (emulated — real viewport/DPR/UA/touch). Runs the
    // viewport-relevant specs (mobile invariants + horizontal-overflow + public
    // route loads) under small-phone, modern-phone, Android, and tablet profiles.
    // We pin `browserName: 'chromium'` so the matrix runs in Chromium-only
    // environments (this sandbox + CI) instead of requiring the WebKit binary; the
    // device descriptor still supplies the real mobile viewport/DPR/UA/touch.
    // Chromium-emulated ≠ real iOS Safari — physical/WebKit checks stay in
    // PHYSICAL_DEVICE_TEST_PLAN. (Set PW_WEBKIT=1 in an env with WebKit installed
    // to run the iPhone/iPad projects on their native engine.)
    ...(process.env.PW_WEBKIT === '1'
      ? [
          { name: 'iphone-se', testMatch: /(mobile|overflow|public)\.spec\.ts/, use: { ...devices['iPhone SE'] } },
          { name: 'iphone', testMatch: /(mobile|overflow|public)\.spec\.ts/, use: { ...devices['iPhone 14 Pro'] } },
          { name: 'ipad', testMatch: /(mobile|overflow|public)\.spec\.ts/, use: { ...devices['iPad (gen 7)'] } },
          // Landscape variants (M-036): rotation is where overflow bugs hide.
          { name: 'iphone-landscape', testMatch: /(mobile|overflow)\.spec\.ts/, use: { ...devices['iPhone 14 Pro landscape'] } },
          { name: 'ipad-landscape', testMatch: /(mobile|overflow)\.spec\.ts/, use: { ...devices['iPad (gen 7) landscape'] } },
        ]
      : [
          { name: 'iphone-se', testMatch: /(mobile|overflow|public)\.spec\.ts/, use: { ...devices['iPhone SE'], browserName: 'chromium' as const } },
          { name: 'iphone', testMatch: /(mobile|overflow|public)\.spec\.ts/, use: { ...devices['iPhone 14 Pro'], browserName: 'chromium' as const } },
          { name: 'ipad', testMatch: /(mobile|overflow|public)\.spec\.ts/, use: { ...devices['iPad (gen 7)'], browserName: 'chromium' as const } },
          // Landscape variants (M-036): rotation is where overflow bugs hide.
          { name: 'iphone-landscape', testMatch: /(mobile|overflow)\.spec\.ts/, use: { ...devices['iPhone 14 Pro landscape'], browserName: 'chromium' as const } },
          { name: 'ipad-landscape', testMatch: /(mobile|overflow)\.spec\.ts/, use: { ...devices['iPad (gen 7) landscape'], browserName: 'chromium' as const } },
        ]),
    { name: 'pixel', testMatch: /(mobile|overflow|public)\.spec\.ts/, use: { ...devices['Pixel 7'] } },
    // Dark-mode variant (M-036): theme CSS can shift layout/overflow; run the
    // mobile invariants once under prefers-color-scheme: dark.
    { name: 'pixel-dark', testMatch: /(mobile|overflow)\.spec\.ts/, use: { ...devices['Pixel 7'], colorScheme: 'dark' as const } },
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
