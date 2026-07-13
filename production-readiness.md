# Production Readiness

## Automated gates

- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` are required
  in CI. The current baseline is 292 unit-test files, 2,530 tests, and 233 built
  routes.
- `npm run test:e2e` covers 52 browser checks: public route rendering, responsive
  overflow, dark/light automated accessibility, anonymous protection, and an
  isolated authenticated login -> onboarding -> first task journey.
- The authenticated CI job boots local Supabase, applies migrations and seeds,
  verifies both Auth APIs, and tears down its disposable account data.
- `supabase/seed_marketplace_circles.sql` is idempotent and creates exactly 500
  realistic circle, membership, listing, and share records. It is included by
  `supabase/SEED_ALL.sql` and protected by contract tests.

## Current production gates

1. Apply `0177_remove_synthetic_auth_users.sql` first. A retired seed directly
   inserted 500 incomplete GoTrue records under `@seed-onb.bubaly.test`, causing
   `/auth/v1/admin/users` to return HTTP 500. The migration removes only the two
   reserved synthetic patterns, aborts above 1,000 matches, and is idempotent.
   Run `npm run db:audit:auth` afterward to prove both Auth endpoints are healthy.
2. Apply `0174_workload_snapshots.sql`, `0175_independence_milestones.sql`, and
   `0176_marketplace_circles.sql`. `npm run db:audit:schema` is the authoritative
   capability check.
3. Verify production environment keys from `.env.example`, especially
   `CRON_SECRET`, sync OAuth credentials, Stripe webhook secrets, Twilio keys,
   `GUARDIAN_INTERNAL_SECRET`, VAPID, monitoring, and email-domain settings.
4. Register and verify the Stripe billing and money webhooks, then verify exact
   Google and Microsoft OAuth callback URLs.
5. Run manual keyboard, screen-reader, 200% zoom, reduced-motion, and key purchase
   journey checks before launch. Automated axe checks are a guard, not a complete
   accessibility certification.

## Degradation guarantees

Key-gated features show explicit not-configured states instead of fabricated data.
Reads for additive feature tables degrade to empty states only where the owning
surface explicitly classifies a missing-table error. Security-sensitive routes,
webhooks, and internal actions fail closed when required secrets are absent.
