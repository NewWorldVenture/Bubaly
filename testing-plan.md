# Testing Plan

## Current automated coverage

- **Vitest:** 292 files / 2,530 tests covering pure engines, auth decisions,
  sync/conflict/crypto, calendar logic, workload, independence, reasoning,
  marketplace, onboarding, offline behavior, and contract checks. Run with
  `npm test`.
- **Browser E2E:** 52 Playwright tests. The always-on suite covers 12 public
  routes, four responsive widths, anonymous route protection, and serious or
  critical WCAG findings in dark and light themes. CI also enables the isolated
  authenticated journey described below. Run with `npm run test:e2e`.
- **Authenticated first-value journey:** CI boots local Supabase, creates a
  disposable confirmed user, signs in through the real UI, completes onboarding,
  saves a task through Quick Capture and RLS, verifies the row with the service
  client, and deletes the temporary family and auth user.
- **Type/lint/build:** `npm run typecheck`, `npm run lint`, and `npm run build`.
- **Supabase:** `npm run db:audit:schema` checks required production tables;
  `npm run db:audit:auth` checks public Auth health and the Admin Users endpoint.
  CI starts a clean local Supabase stack, applying migrations and seed data before
  the authenticated browser test.

## Guardrails

- Authenticated E2E is disabled unless `E2E_AUTHENTICATED=1` and all disposable
  account credentials are present.
- The test refuses a non-loopback Supabase host unless
  `E2E_ALLOW_REMOTE_SUPABASE=1` is explicitly supplied for a controlled run.
- The Admin Auth audit never prints credentials or user records.
- Axe automation catches only machine-detectable failures; manual keyboard,
  screen-reader, zoom, and cognitive-accessibility review remains required.

## Next investments

1. Add owner/member/non-member/anonymous RLS behavior tests for every table family.
2. Add deterministic visual regression for core public and authenticated pages in
   light/dark and mobile/desktop modes.
3. Add authenticated multi-member invitation, child login, billing, and account
   recovery journeys using isolated local accounts.
