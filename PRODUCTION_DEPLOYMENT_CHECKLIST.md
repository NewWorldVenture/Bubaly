# Production Deployment Checklist

## Before Deployment

- [ ] Review `todo.md`, `PRODUCTION_READINESS_REPORT.md`, and `SUPABASE_AUDIT.md`.
- [ ] Confirm the intended branch and commit; do not deploy with unrelated worktree changes.
- [ ] Run typecheck, lint, unit tests, build, and public E2E checks.
- [ ] Review `npm audit` output and record the PostCSS advisory decision.

## Database and Supabase

- [ ] Back up the target database and confirm a tested restore path.
- [ ] Apply migrations in order through `0178_marketplace_circles_rls_recursion.sql`.
- [ ] Run `npm run db:audit:schema` and `npm run db:audit:auth`.
- [ ] Run isolated RLS allow/deny tests for family boundaries and marketplace circles.
- [ ] Confirm all storage buckets, object policies, RPC grants, trigger functions, and realtime tables.
- [ ] Inspect and resolve the current Auth Admin `Database error finding users` before launch.

## Environment and Integrations

- [ ] Populate every applicable variable documented in `.env.example`.
- [ ] Keep service-role, Stripe, AI, Resend, Twilio, OAuth, sync, and push secrets server-only.
- [ ] Confirm `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SITE_URL` match the production domain.
- [ ] Confirm Supabase Auth redirect URLs and OAuth callback URLs.
- [ ] Confirm Stripe live/test mode, price IDs, webhook secrets, and money webhook endpoint.
- [ ] Confirm Resend sender/domain and webhook endpoint.
- [ ] Confirm Vercel `CRON_SECRET` and cron schedules.
- [ ] Confirm sync token encryption key and provider redirect URIs.

## Smoke Tests After Deployment

- [ ] Anonymous public routes load over HTTPS.
- [ ] Anonymous protected-route redirect reaches login.
- [ ] Email/password login, sign-out, session refresh, and password recovery work.
- [ ] Family creation and family-scoped CRUD persist after refresh.
- [ ] Marketplace circle create/join/leave and shared-listing allow/deny cases pass.
- [ ] Admin user list and role restrictions work.
- [ ] Stripe checkout/webhooks and email/unsubscribe flows work in the intended mode.
- [ ] Monitoring captures client/server/auth/database/webhook errors without secrets.

## Rollback

- [ ] Keep the previous application deployment available for rollback.
- [ ] If `0178` causes unexpected behavior, stop feature exposure and use the tested migration rollback
  procedure; do not manually delete production data.
- [ ] Restore database only through the approved backup/recovery process.
- [ ] Re-run smoke tests and record the incident and recovery evidence.
