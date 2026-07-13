# Production Readiness

## Verified green (locally, every push)
- `npx tsc --noEmit` · `npx eslint` · `npx vitest run` (**2400+ tests, 275 files**) ·
  `npx next build` (full production build).
- Migrations: every new migration PG16-validated ×2 (idempotent) on a throwaway cluster.
- Seeds: idempotent ×2, 500 rows/feature, tagged for safe re-runs; **never run against prod
  automatically** (paste-to-SQL-editor by a human).

## Human-owned gate (the launch checklist)
1. **Apply pending migrations** in order — `docs/PENDING_PROD_MIGRATIONS.md` (0118 first;
   one-paste bundle available; note the 0138 duplicate-number caveat for CLI users).
2. **Env keys** (names in `.env.example`): `CRON_SECRET` (activates 14 crons in vercel.json),
   `SYNC_TOKEN_KEY` + `GOOGLE_SYNC_*` + `MICROSOFT_SYNC_*` (calendar two-way sync),
   `STRIPE_MONEY_WEBHOOK_SECRET` + Issuing enablement + feature flags (wallet cards),
   `TWILIO_*` (front desk + outbound concierge calls), `GUARDIAN_INTERNAL_SECRET`,
   optional `GIPHY_API_KEY`, VAPID keys (push), maps/ETA key (leave-by buffers).
3. **Stripe**: register the second webhook at `/api/webhooks/money`; verify billing webhook.
4. **OAuth consoles**: register exact callback URLs for Google/Microsoft sync clients.
5. Monitoring/analytics keys per `.env.example`; verify email domain + templates.

## Degradation guarantees
Every key-gated feature ships "honest-dark": missing keys render explicit "not configured"
states (never fake data, never crashes). Missing tables degrade to empty states via
missing-table error classification in the data hooks.
