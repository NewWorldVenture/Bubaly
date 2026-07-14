# Production Deployment Checklist

## Before Deployment

- [ ] Review `todo.md`, `PRODUCTION_READINESS_REPORT.md`, and `SUPABASE_AUDIT.md`.
- [ ] Confirm the intended branch and commit; do not deploy with unrelated worktree changes.
- [ ] Run typecheck, lint, unit tests, build, and public E2E checks.
- [ ] Run `npm audit --omit=dev --audit-level=moderate` and require 0 vulnerabilities.

## Database and Supabase

- [ ] Back up the target database and confirm a tested restore path.
- [ ] Run `npm run db:audit:migrations`, then apply migrations in order through `0199_marketplace_handoff_completion.sql`.
- [ ] Run `npm run db:audit:schema` and `npm run db:audit:auth`.
- [ ] Run isolated RLS allow/deny tests for family boundaries and marketplace circles.
- [ ] Confirm all storage buckets, object policies, RPC grants, trigger functions, and realtime tables.
- [ ] Inspect and resolve the current Auth Admin `Database error finding users` before launch.
- [ ] Exercise onboarding with a forced failure in an isolated environment; confirm the required write
      returns a sanitized failure and the retry resumes the `wizard/in_progress` run without duplicate
      family provisioning.
- [ ] Exercise an isolated marketing-admin mutation failure; confirm the UI receives a stable failure
      and no success audit/revalidation/redirect is emitted after the Supabase write fails.
- [ ] Exercise account closure/reopen, family switching, dashboard preference, profile, and App Lock
      failures in isolation; confirm required reads and writes fail closed with sanitized messages.
- [ ] Exercise concurrent economy-redemption and simulated-investment approvals after applying `0196`;
      confirm only one approval can debit/consume the same balance and each result has matching state.
- [ ] Exercise Guardian suggestion approval/dismissal after applying `0198`; confirm only managers can
      review, proposed changes and review state commit together, and concurrent reviews are idempotent.
- [ ] Exercise Marketplace hand-off completion after applying `0199`; confirm the code check and both
      hand-off/order status transitions commit together and concurrent completions are idempotent.

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
- [ ] If `0178` through `0199` causes unexpected behavior, stop feature exposure and use the tested migration rollback
  procedure; do not manually delete production data.
- [ ] Restore database only through the approved backup/recovery process.
- [ ] Re-run smoke tests and record the incident and recovery evidence.
## Audit Update - 2026-07-13

- [x] Legacy service-role seed scripts require a confirmed non-production seed scope.
- [ ] Rotate the exposed Supabase service-role key and review audit logs before any production use.
- [ ] Apply pending migrations and rerun live schema, Auth, and isolated RLS checks.
