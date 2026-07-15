# Test Evidence

Audit date: 2026-07-15

## Latest Live Evidence Snapshot - Authentication and Supabase

- `npm.cmd run db:audit:auth`: public Auth health passed; Auth Admin users returned HTTP 500 with request ID
  `019f6612-b504-764d-ba45-1f0f81e7d090`.
- `npm.cmd run db:audit:schema`: all 11 required schema probes passed.
- `supabase status`: unavailable because the Docker Desktop Linux engine is not running.
- Cross-tenant authenticated RLS probes and remote migration-ledger reconciliation remain unverified.

## Latest Audit Update - Notification email failure contract

- `npm.cmd run test -- tests/notification-email-boundary.test.ts tests/cron-notification-failure-status.test.ts tests/cron-auth.test.ts tests/database-error-boundaries.test.ts`: 4 files, 9 tests passed.
- `npm.cmd run test`: 415 files, 3,073 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- `git diff --check`: passed.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: 227 numbered SQL files; next available version `0212`; passed.
- `npm.cmd run build`: passed after clearing a stale generated `.next` artifact; 250 routes generated. Next.js emitted existing non-blocking cache and Edge-runtime warnings.
- `deliverNotificationEmails` now returns `sent`, `failed`, and `skipped`, checks Supabase read/update errors, and leaves failed sends retryable; the notification cron includes email failures in its 502 status.
- Publication verified at commit `a704a41f`; local and `origin/main` are aligned.

## Latest Audit Update - Notification cron failure status

- `npm.cmd run test -- tests/cron-notification-failure-status.test.ts tests/cron-batch-failure-status.test.ts tests/cron-provider-sync.test.ts tests/cron-auth.test.ts tests/database-error-boundaries.test.ts`: 5 files, 13 tests passed.
- `npm.cmd run test`: 414 files, 3,071 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- `git diff --check`: passed.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: 227 numbered SQL files; next available version `0212`; passed.
- `npm.cmd run build`: passed; 250 routes generated.
- `/api/cron/notifications` and `/api/cron/push-scan` now return sanitized HTTP 502 when notification generation, push dispatch, or push delivery fails.
- Publication verified at commit `92eb434a`; local and `origin/main` are aligned.
- Remaining gap: `deliverNotificationEmails` currently returns only a sent count, so email-provider failure detail needs a separate helper contract audit.

## Latest Audit Update - Batch cron failure status

- `npm.cmd run test -- tests/cron-batch-failure-status.test.ts tests/cron-provider-sync.test.ts tests/cron-auth.test.ts tests/database-error-boundaries.test.ts`: 4 files, 11 tests passed.
- `npm.cmd run test`: 413 files, 3,069 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- `git diff --check`: passed.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: 227 numbered SQL files; next available version `0212`; passed.
- `npm.cmd run build`: passed; 250 routes generated.
- Calendar-feed, Autopilot, model-refresh, and auction-settlement crons now return sanitized HTTP 502 when batch work fails instead of reporting unconditional success.
- Source publication: `f8226011`; merged remote head verified at `59c422ac` after integrating a concurrent Admin notification update.

## Latest Audit Update - Provider sync cron failure status

- `npm.cmd run test -- tests/cron-provider-sync.test.ts tests/cron-auth.test.ts tests/database-error-boundaries.test.ts`: 3 files, 7 tests passed.
- `npm.cmd run test`: 412 files, 3,065 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- `git diff --check`: passed.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: 227 numbered SQL files; next available version `0212`; passed.
- `npm.cmd run build`: passed; 250 routes generated.
- `/api/cron/provider-sync` now returns sanitized HTTP 502 and `ok: false` when any account sync fails; successful runs remain HTTP 200.
- Publication verified at commit `24e0b64d`; local and `origin/main` are aligned.

## Latest Audit Update - Legacy connection adapters fail closed

- `npm.cmd run test -- tests/connections-adapter.test.ts tests/connections-providers.test.ts tests/connections-ui-boundary.test.ts`: 3 files, 25 tests passed.
- `npm.cmd run test`: 411 files, 3,063 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- `git diff --check`: passed.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: 227 numbered SQL files; next available version `0212`; passed.
- `npm.cmd run build`: passed; 250 routes generated.
- Planned Google Calendar and Gmail adapters no longer become runnable merely because OAuth keys are present; credentialed calls return explicit unavailable errors until real provider I/O exists.
- Publication verified at commit `0ae5cdb0`; local and `origin/main` are aligned.

## Latest Audit Update - Admin digest failure visibility

- `npm.cmd run test -- tests/admin-digest.test.ts tests/cron-auth.test.ts tests/admin-notification-boundary.test.ts`: 3 files, 20 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- `git diff --check`: passed.
- The digest route now returns a sanitized 502 when the `admin_notifications` feed cannot be read.
- Delivery summaries distinguish sent, skipped, and failed recipients; disabled Resend is no longer counted as sent, and partial failures return 502.
- Full suite: 411 files, 3,061 tests passed.
- `npm.cmd run build`: passed; 250 routes generated.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: 227 numbered SQL files; next available version `0212`; passed.
- Publication verified: local and `origin/main` both point to `f3e72542802bd07a7632b80b68e0f4e444b7a5fd`.
- Latest live probes: schema audit passed all 11 checks; Auth Admin users returned HTTP 500 with request ID
  `019f65f5-6fc8-7530-9c7e-5e8688441c29`; `supabase status` could not connect to the Docker Desktop Linux engine.

## Latest Audit Update - Connections false-success prevention

- `npm.cmd run test -- tests/connections-providers.test.ts tests/connections-adapter.test.ts tests/connections-ui-boundary.test.ts`: 3 files, 23 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- `git diff --check`: passed.
- `/dashboard/connections` now sends Google, Microsoft, and Apple users to their actual OAuth/sync setup pages.
- Gmail, banking, grocery, and smart-home directory entries no longer persist a label-only Connected record; they visibly report that live setup is unavailable.
- Full suite: 410 files, 3,048 tests passed.
- `npm.cmd run build`: passed; 250 routes generated.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: 227 numbered SQL files; next available version `0212`; passed.
- Publication verified in the same audit window; the current remote head also includes the later Admin digest repair.

## Latest Audit Update - Admin notification failure visibility

- `npm.cmd run test -- tests/admin-notification-boundary.test.ts tests/admin-notifications.test.ts`: 2 files, 12 tests passed.
- `npm.cmd run typecheck`: passed.
- `git diff --check`: passed.
- `npm.cmd run test`: 409 files, 3,045 tests passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: 227 numbered SQL files; next available version `0212`; passed.
- `npm.cmd run build`: passed; 250 routes generated.
- `npm.cmd run db:audit:schema`: passed all 11 required live schema checks.
- `npm.cmd run db:audit:auth`: public health passed; Auth Admin users returned HTTP 500 with request ID
  `019f65f5-6fc8-7530-9c7e-5e8688441c29`.
- `supabase status`: unavailable because the Docker Desktop Linux engine is not running.
- `recordAdminNotification` now checks and logs Supabase's returned insert error while preserving its intentional best-effort contract.
- The Admin Notifications history and bell now display sanitized `role=alert` failures and only refresh after a successful mark-read action.
- Live Super Admin permission, failure-injection, alert-routing, and browser workflow evidence remain pending.

## Latest Audit Update - Family membership RLS tenant boundary

- `npm.cmd run test -- tests/tenant-isolation-rls.test.ts tests/migration-version-safety.test.ts tests/admin-auth-boundary.test.ts tests/account-action-error-boundaries.test.ts`: 4 files, 9 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run db:audit:migrations`: 227 numbered SQL files; next available version `0212`; passed.
- `git diff --check`: passed.
- Found and repaired migration drift where `0118` allowed any member to update their own membership row,
  including role, active state, and family ID. Migration `0211` restores manager-only `USING` and `WITH CHECK`.
- Remote application, authenticated two-tenant RLS probes, and Auth Admin health remain open.
- Latest live probes: schema audit passed all 11 checks; Auth Admin users still returned HTTP 500 with
  request ID `019f65cf-7a30-7a5b-b7d0-0ae58eb1dcde`; local `supabase status` could not connect to the Docker Desktop Linux engine.

## Latest Audit Update - Guardian emergency escalation replay and phone mapping

- `npm.cmd run test -- tests/guardian-escalation-replay.test.ts tests/guardian-callback-security.test.ts`: 2 files, 11 tests passed.
- `npm.cmd run typecheck`: passed.
- `git diff --check`: passed.
- `/api/guardian/escalate` now validates bounded internal input, claims `guardian_callback_events` before SMS/calls,
  resolves parent phones through `family_members.user_id` to `profiles.id`, and leaves recoverable database failures
  in the callback ledger's `error` state for stale-claim retry.
- Live Twilio delivery, privacy/role behavior, RLS, and provider failure smoke tests remain open.
- Latest broad validation: 407 files, 3,035 tests; lint, dependency audit, migration audit, typecheck, and
  clean 250-route production build passed. Schema audit passed all 11 probes; Auth Admin still returned HTTP 500
  with request ID `019f65c5-4a08-7c92-9949-7caaff74a0d0`; local Docker/Supabase status could not connect to the
  Docker Desktop Linux engine.

## Latest Audit Update - Onboarding replay integrity

- `npm.cmd run test -- tests/onboarding-failure-safety.test.ts tests/onboarding-idempotency.test.ts tests/migration-version-safety.test.ts`: 3 files, 8 tests passed.
- `npm.cmd run test`: 406 files, 3,033 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; Next.js deprecation notice remains.
- `npm.cmd audit --omit=dev --audit-level=moderate`: 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: 226 numbered SQL files; next available version `0211`; passed.
- `npm.cmd run build`: passed; 250 static routes generated.
- Onboarding finalization now derives authenticated deterministic keys and reconciles members, invites,
  imported events, and import markers through database-enforced conflict targets. Replayed invite rows
  reuse their token without sending a duplicate email. First-family creation is serialized per user by
  the `onboarding_claim_family` RPC and a transactional advisory lock.
- Live application of migration `0210`, authenticated E2E, and cross-tenant RLS verification remain open.

## Latest Audit Update - Atomic wallet goal funding

- `npm.cmd exec vitest run tests/wallet-goal-persistence.test.ts tests/wallet-atomic-persistence.test.ts`:
  2 files, 5 tests passed.
- `npm.cmd run typecheck`, `npm.cmd run lint`, and `npm.cmd run db:audit:migrations`: passed. The migration
  audit reports 224 numbered SQL files with next version `0209`.
- `npm.cmd exec vitest run`: 405 files, 3,030 tests passed. Clean `npm.cmd run build` generated all 250
  static pages; dependency audit reported 0 vulnerabilities.
- `npm.cmd run db:audit:schema`: all 11 required live schema checks passed. The 600-record production seed
  invariant passed.
- Goal funding now performs the Save-bucket balance check, immutable debit, goal progress update, and audit
  insert inside one manager-checked row-locking RPC.

## Latest Audit Update - Wallet allowance failure recovery

- `npm.cmd exec vitest run tests/wallet-allowance-persistence.test.ts tests/wallet-atomic-persistence.test.ts tests/server-action-error-boundaries.test.ts`:
  3 files, 7 tests passed.
- `npm.cmd exec vitest run`: 403 files, 3,024 tests passed.
- `npm.cmd run typecheck`, `npm.cmd run lint`, and clean `npm.cmd run build`: passed; 250 static pages generated.
- Dependency audit: 0 vulnerabilities. No migration changed in the manual allowance increment; the current
  migration audit now reports 224 numbered SQL files with next version `0209`.
- Due allowance reads and schedule advances now check database results. A failed wallet credit restores the
  prior schedule so the allowance remains due, and `ranCount`/`paidCents` include only successful credits.

## Latest Audit Update - Wallet allowance cron recovery

- `npm.cmd exec vitest run tests/cron-wallet-allowance-persistence.test.ts tests/wallet-allowance-persistence.test.ts`:
  focused persistence contract passed.
- The cron now checks the schedule write before crediting, restores `next_run_on` and `last_run_on` when
  crediting fails, and returns a failed cron response instead of silently advancing an unpaid rule.

## Latest Audit Update - Chore state transition persistence

- `npm.cmd exec vitest run tests/chore-state-transition-persistence.test.ts tests/chore-proof-persistence.test.ts tests/chore-reward-persistence.test.ts`:
  3 files, 14 tests passed.
- `npm.cmd exec vitest run`: 394 files, 2,978 tests passed.
- `npm.cmd run typecheck`, `npm.cmd run lint`, and clean `npm.cmd run build`: passed; 250 static pages generated.
- Dependency audit: 0 vulnerabilities. No migration changed in this increment; the published migration audit
  remains 221 numbered SQL files with next version `0206`.
- Chore submission status transitions now require updated rows, failed follow-up writes restore prior state,
  dispute rows are removed when later transitions fail, auto-approval falls back to parent review, and failed
  assignment creation removes the newly created chore.

## Latest Audit Update - AI chat conversation ownership

- `npm.cmd exec vitest run tests/ai-chat-ownership.test.ts tests/database-error-boundaries.test.ts`:
  2 files, 3 tests passed.
- `npm.cmd exec vitest run`: 393 files, 2,974 tests passed.
- `npm.cmd run typecheck`, `npm.cmd run lint`, and clean `npm.cmd run build`: passed; 250 static pages generated.
- The client-provided conversation UUID is now re-read with both `family_id` and `user_id` ownership filters;
  ownership read failures return a stable temporary-unavailable response and mismatches stop before history
  or message access.

## Latest Audit Update - AI meal planner persistence boundaries

- `npm.cmd exec vitest run tests/ai-meal-plan-persistence.test.ts tests/database-error-boundaries.test.ts`:
  2 files, 4 tests passed.
- `npm.cmd exec vitest run`: 392 files, 2,972 tests passed.
- `npm.cmd run typecheck` and `npm.cmd run lint`: passed; only the existing Next.js deprecation notice remains.
- Dependency audit: 0 vulnerabilities. Migration filename audit: 221 numbered SQL files, next version
  `0206`, with the known historical duplicate prefixes unchanged. Live schema audit: 11 of 11 probes passed
  in the prior published verification and no schema changed in this increment.
- The meal planner now checks candidate/pantry reads, preserves existing targeted slots for restoration,
  cleans up generated meals on resolution failure, and checks replacement/delete/insert results before
  returning `written: true`.

## Latest Audit Update - Vacation AI persistence boundaries

- `npm.cmd exec vitest run tests/vacation-ai-persistence-boundaries.test.ts tests/database-error-boundaries.test.ts`:
  2 files, 5 tests passed.
- `npm.cmd exec vitest run`: 390 files, 2,964 tests passed.
- `npm.cmd run typecheck` and `npm.cmd run lint`: passed; only the existing Next.js deprecation notice remains.
- Dependency audit: 0 vulnerabilities. Migration filename audit: 221 numbered SQL files, next version
  `0206`, with the known historical duplicate prefixes unchanged. Live schema audit: 11 of 11 probes passed.
- Clean `npm.cmd run build`: passed; 250 static pages generated. Public Playwright/axe/overflow E2E:
  51 passed, 1 intentional authenticated skip out of 52 tests.
- Local `supabase db lint --local` remains unavailable because no local Postgres container is running;
  the command failed closed with `LegacyDbConnectError` before evaluating the migration.
- Vacation AI context reads now fail closed; recommendation writes and every generated-plan write are
  checked, with tracked inserts compensated on failure. Existing concierge conversations are scoped to
  the active family and vacation, and both chat messages require successful persistence before success.

## Latest Audit Update - Atomic Wallet money and approval persistence

- `npm.cmd exec vitest run tests/wallet-atomic-persistence.test.ts tests/server-action-error-boundaries.test.ts tests/wallet-transfer.test.ts tests/wallet-money-action-boundaries.test.ts`:
  4 files, 10 tests passed.
- `npm.cmd exec vitest run`: 389 files, 2,960 tests passed.
- `npm.cmd run typecheck` and `npm.cmd run lint`: passed; only the existing Next.js deprecation notice remains.
- Dependency audit: 0 vulnerabilities. Migration filename audit: 221 numbered SQL files, next version
  `0206`, with the known historical duplicate prefixes unchanged. Live schema audit: 11 of 11 probes passed.
- Clean `npm.cmd run build`: passed; 250 static pages generated. Public Playwright/axe/overflow E2E:
  51 passed, 1 intentional authenticated skip out of 52 tests.
- Local `supabase db lint --local` remains unavailable because no local Postgres container is running;
  the command failed closed with `LegacyDbConnectError` before evaluating the migration.
- Wallet transfers, gift approvals, spend approvals, and allowance decisions now use typed RPC wrappers;
  the database locks the relevant wallet/approval rows and commits ledger, state, and audit writes together.

## Latest Audit Update - Atomic loyalty persistence boundaries

- `npm.cmd exec vitest run tests/loyalty-atomic-persistence.test.ts tests/marketing-loyalty-action-boundaries.test.ts tests/marketing-loyalty.test.ts`:
  3 files, 11 tests passed.
- `npm.cmd exec vitest run`: 388 files, 2,958 tests passed.
- `npm.cmd run typecheck` and `npm.cmd run lint`: passed; only the existing Next.js deprecation notice remains.
- Dependency audit: 0 vulnerabilities. Migration filename audit: 220 numbered SQL files, next version
  `0205`, with the known historical duplicate prefixes unchanged. Live schema audit: 11 of 11 probes passed.
- Clean `npm.cmd run build`: passed; 250 static pages generated. Public Playwright/axe/overflow E2E:
  51 passed, 1 intentional authenticated skip out of 52 tests.
- Loyalty award, redeem, and cancellation paths now delegate all balance, ledger, redemption, and finite
  stock mutations to service-role-only row-locking RPCs; cancellation restores finite stock atomically.

## Latest Audit Update - Social account, workspace, media, and access mutation boundaries

- `npm.cmd exec vitest run tests/social-action-persistence.test.ts tests/social-publish-persistence.test.ts tests/social-roles.test.ts`:
  3 files, 18 tests passed.
- `npm.cmd exec vitest run`: 386 files, 2,945 tests passed.
- `npm.cmd run typecheck` and `npm.cmd run lint`: passed; only the existing Next.js deprecation notice remains.
- Dependency audit: 0 vulnerabilities. Migration filename audit: 219 numbered SQL files, next version
  `0204`, with the known historical duplicate prefixes unchanged. Live schema audit: 11 of 11 probes passed.
- Clean `npm.cmd run build`: passed; 250 static pages generated. Public Playwright/axe/overflow E2E:
  51 passed, 1 intentional authenticated skip out of 52 tests.
- Account disconnect, inbox resolution, media creation, settings saves, and access grants now check
  durable mutation results. Access grants require `manage_access`, an active family member, and a valid
  social role; media URLs and text inputs are bounded and restricted to HTTP(S).

## Latest Audit Update - Social publishing persistence boundaries

- `npm.cmd exec vitest run tests/social-publish-persistence.test.ts tests/social-content.test.ts tests/social-capabilities.test.ts`:
  3 files, 32 tests passed.
- `npm.cmd exec vitest run`: 384 files, 2,938 tests passed.
- `npm.cmd run typecheck` and `npm.cmd run lint`: passed; only the existing Next.js deprecation notice remains.
- Dependency audit: 0 vulnerabilities. Migration filename audit: 219 numbered SQL files, next version
  `0204`, with the known historical duplicate prefixes unchanged. Live schema audit: 11 of 11 probes passed.
- Clean `npm.cmd run build`: passed; 250 static pages generated. Public Playwright/axe/overflow E2E:
  51 passed, 1 intentional authenticated skip out of 52 tests.
- Social publishing now checks target/account reads, variant and schedule writes, job/target/result/post
  state transitions, cleans incomplete pre-publish drafts, and keeps provider exception details server-side.
  Usage-event writes remain explicitly best-effort because they are operational telemetry, not publish state.

## Latest Audit Update - Child login throttle and provisioning persistence boundaries

- `npm.cmd exec vitest run tests/child-login-persistence.test.ts tests/child-login-action-security.test.ts`:
  2 files, 4 tests passed.
- `npm.cmd exec vitest run`: 383 files, 2,932 tests passed.
- `npm.cmd run typecheck` and `npm.cmd run lint`: passed; only the existing Next.js deprecation notice remains.
- Dependency audit: 0 vulnerabilities. Migration filename audit: 219 numbered SQL files, next version
  `0204`, with the known historical duplicate prefixes unchanged. Live schema audit: 11 of 11 probes passed.
- Clean `npm.cmd run build`: passed; 250 static pages generated. Public Playwright/axe/overflow E2E:
  51 passed, 1 intentional authenticated skip out of 52 tests.
- Failed-attempt throttle writes now fail closed when durable persistence fails, and child-login provisioning
  compensates Auth, member mapping, and child-login rows when active-family preference persistence fails.

## Latest Audit Update - Chore proof submission persistence boundaries

- `npm.cmd exec vitest run tests/chore-proof-persistence.test.ts`: 1 file, 4 tests passed.
- `npm.cmd exec vitest run`: 382 files, 2,929 tests passed.
- `npm.cmd run typecheck` and `npm.cmd run lint`: passed; only the existing Next.js deprecation notice remains.
- Dependency audit: 0 vulnerabilities. Migration filename audit: 219 numbered SQL files, next version
  `0204`, with the known historical duplicate prefixes unchanged. Live schema audit: 11 of 11 probes passed.
- Clean `npm.cmd run build`: passed; 250 static pages generated. Public Playwright/axe/overflow E2E:
  51 passed, 1 intentional authenticated skip out of 52 tests.
- Chore proof paths now use server UUIDs, storage errors are stable, and failed submission, validator,
  AI-validation, or assignment persistence cleans up both the submission row and uploaded media.

## Latest Audit Update - Chore reward persistence boundaries

- `npm.cmd exec vitest run tests/chore-reward-persistence.test.ts`: 1 file, 6 tests passed.
- `npm.cmd exec vitest run`: 381 files, 2,925 tests passed.
- `npm.cmd run typecheck` and `npm.cmd run lint`: passed; only the existing Next.js deprecation notice remains.
- Dependency audit: 0 vulnerabilities. Migration filename audit: 219 numbered SQL files, next version
  `0204`, with the known historical duplicate prefixes unchanged. Live schema audit: 11 of 11 probes passed.
- Clean `npm.cmd run build`: passed; 250 static pages generated. Public Playwright/axe/overflow E2E:
  51 passed, 1 intentional authenticated skip out of 52 tests.
- Chore XP and badge writes now fail closed, use family-scoped checks and idempotent badge upserts, restore
  prior progress after downstream failure, and roll approved assignments back when rewards cannot apply.

## Latest Audit Update - Family Autopilot persistence boundaries

- `npm.cmd exec vitest run tests/autopilot-persistence-boundaries.test.ts`: 1 file, 4 tests passed.
- `npm.cmd exec vitest run`: 380 files, 2,919 tests passed.
- `npm.cmd run typecheck` and `npm.cmd run lint`: passed; only the existing Next.js deprecation notice remains.
- Dependency audit: 0 vulnerabilities. Migration filename audit: 219 numbered SQL files, next version
  `0204`, with the known historical duplicate prefixes unchanged. Live schema audit: 11 of 11 probes passed.
- Clean `npm.cmd run build`: passed; 250 static pages generated. Public Playwright/axe/overflow E2E:
  51 passed, 1 intentional authenticated skip out of 52 tests.
- Autopilot now fails closed when required family reads fail, checks stale-suggestion deletion and list
  provisioning, and cleans up auto-created reminders or grocery rows if suggestion persistence fails.

## Latest Audit Update - Family media persistence boundaries

- `npm.cmd exec vitest run tests/family-media-persistence.test.ts`: 1 file, 5 tests passed.
- `npm.cmd exec vitest run`: 379 files, 2,915 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js deprecation notice remains.
- Dependency audit: 0 vulnerabilities. Migration filename audit: 219 numbered SQL files, next version
  `0204`, with the known historical duplicate prefixes unchanged. Live schema audit: 11 of 11 probes passed.
- Clean `npm.cmd run build`: passed; 250 static pages generated. Public Playwright/axe/overflow E2E:
  51 passed, 1 intentional authenticated skip out of 52 tests.
- Family-media uploads now prefer collision-resistant UUID paths, check metadata inserts before reporting
  success, remove uploaded objects when metadata persistence fails, and use stable upload errors.

## Latest Audit Update - AI assistant tool persistence boundaries

- `npm.cmd exec vitest run tests/assistant-persistence-boundaries.test.ts tests/assistant-complete-reminder.test.ts tests/assistant-add-reminder.test.ts tests/assistant-tool-error-contract.test.ts`: 4 files, 11 tests passed.
- `npm.cmd exec vitest run`: 377 files, 2,901 tests passed.
- `npm.cmd run typecheck`: passed.
- Assistant list reads now fail closed on Supabase errors. Multi-step chore and recurring-reminder actions
  roll back their first write when the dependent persistence step fails.

## Latest Audit Update - Google sync item persistence boundaries

- `npm.cmd exec vitest run tests/sync-google-item-persistence.test.ts`: 1 file, 3 tests passed.
- `npm.cmd exec vitest run`: 376 files, 2,897 tests passed.
- `npm.cmd run typecheck`: passed.
- Clean `npm.cmd run build`: passed; 249 static pages generated. Known webpack cache and Supabase
  Edge Runtime warnings remain documented.
- Public Playwright/axe/overflow E2E: 51 passed, 1 intentional authenticated skip out of 52 tests.
- Google Calendar and Tasks pulls and pushes now fail closed when local rows, mappings, conflicts, deletes,
  updates, creations, or cursors are not persisted before sync counts are incremented.

## Latest Audit Update - Generic sync item persistence boundaries

- `npm.cmd exec vitest run tests/sync-generic-item-persistence.test.ts`: 1 file, 3 tests passed.
- `npm.cmd exec vitest run`: 374 files, 2,885 tests passed.
- `npm.cmd run typecheck`: passed.
- Generic provider calendar/task pulls and pushes now fail closed when local rows, mappings, conflicts,
  deletes, updates, creations, or cursors are not persisted before counts are incremented.

## Latest Audit Update - Sync job lifecycle persistence boundaries

- `npm.cmd exec vitest run tests/sync-job-persistence-boundaries.test.ts`: 1 file, 3 tests passed.
- `npm.cmd exec vitest run`: 373 files, 2,882 tests passed.
- `npm.cmd run typecheck`: passed.
- Provider-agnostic and Google sync now require job/run creation and successful run, job, connection,
  and account finalization; generic-provider token refresh also checks encrypted persistence.

## Latest Audit Update - Sync account and token persistence boundaries

- `npm.cmd exec vitest run tests/sync-account-persistence-boundaries.test.ts`: 1 file, 3 tests passed.
- `npm.cmd exec vitest run`: 372 files, 2,879 tests passed.
- `npm.cmd run typecheck`: passed.
- Sync account creation now checks account, token, and connection writes; reconnects fail closed when
  the existing refresh-token read fails, and token refresh only succeeds after encrypted persistence.

## Latest Audit Update - Payment and webhook persistence boundaries

- `npm.cmd exec vitest run tests/webhook-persistence-boundaries.test.ts tests/stripe-webhook-replay-contract.test.ts tests/resend-webhook-replay-contract.test.ts`: 3 files, 8 tests passed.
- `npm.cmd exec vitest run`: 371 files, 2,876 tests passed.
- `npm.cmd run typecheck`: passed.
- Stripe subscription, billing-customer, checkout, and event-ledger writes now fail closed and return
  retryable responses when persistence is lost. Resend campaign counters, suppressions, and final event
  ledger transitions now do the same. Referral conversion reads and writes are also checked.

## Latest Audit Update - Core marketing, referrals, and lead-score boundaries

- `npm.cmd exec vitest run tests/marketing-core-referral-boundaries.test.ts tests/marketing-action-error-boundaries.test.ts tests/marketing-affiliates.test.ts`: 3 files, 10 tests passed.
- `npm.cmd exec vitest run`: 370 files, 2,873 tests passed.
- `npm.cmd run typecheck`: passed.
- Shared marketing admin updates now require affected target rows, SEO/AEO inserts and settings upserts
  require returned records, referral configuration failures are sanitized, and public referral writes no
  longer return raw database messages.
- Lead-score recomputation now fails closed on contact reads/upserts and records a sanitized admin audit event.

## Latest Audit Update - Experiments, exit-intent, and survey boundaries

- `npm.cmd exec vitest run tests/marketing-experiment-exit-survey-boundaries.test.ts`: 1 file, 3 tests passed.
- `npm.cmd exec vitest run`: 369 files, 2,870 tests passed.
- `npm.cmd run typecheck`, `npm.cmd run lint`, dependency audit, migration audit, and live schema probes passed.
- Clean `npm.cmd run build`: 235 routes generated. Public Playwright/axe/overflow E2E: 51 passed,
  1 intentional authenticated test skipped out of 52.
- A/B experiments now request inserted rows, validate winner keys against configured variants, and
  require active target rows. Exit-intent inserts/updates/deletes and survey status/deletion controls
  now check errors and affected rows before audit logging or cache revalidation.

## Latest Audit Update - Reputation, video, and review action boundaries

- `npm.cmd exec vitest run tests/marketing-reputation-video-review-boundaries.test.ts`: 1 file, 3 tests passed.
- `npm.cmd exec vitest run`: 368 files, 2,867 tests passed.
- `npm.cmd run typecheck`, `npm.cmd run lint`, dependency audit, migration audit, and live schema probes passed.
- Clean `npm.cmd run build`: 235 routes generated. Public Playwright/axe/overflow E2E: 51 passed,
  1 intentional authenticated test skipped out of 52.
- Testimonials, case studies, marketing videos, review moderation/replies, and reputation settings now
  check Supabase errors and affected rows before audit logging or revalidation. Missing video assets fail
  as a validated no-op, while asset-read errors fail closed.

## Latest Audit Update - Marketing delivery and personalization boundaries

- `npm.cmd exec vitest run tests/marketing-delivery-action-boundaries.test.ts`: 1 file, 2 tests passed.
- `npm.cmd exec vitest run`: 367 files, 2,857 tests passed.
- `npm.cmd run typecheck`, `npm.cmd run lint`, dependency audit, migration audit, and live schema probes passed.
- Clean `npm.cmd run build`: 235 routes generated. Public Playwright/axe/overflow E2E: 51 passed,
  1 intentional authenticated test skipped out of 52.
- Push campaigns now claim only draft/failed rows before delivery, fail and mark campaigns when
  prerequisite reads or delivery throw, and check final sent-state persistence. Personalization rule
  inserts, updates, and deletes now check errors and affected rows before audit logging or revalidation.

## Latest Audit Update - Loyalty administration action boundaries

- `npm.cmd exec vitest run tests/marketing-loyalty-action-boundaries.test.ts`: 1 file, 2 tests passed.
- `npm.cmd exec vitest run`: 366 files, 2,855 tests passed.
- `npm.cmd run typecheck`, `npm.cmd run lint`, dependency audit, migration audit, and live schema probes passed.
- Clean `npm.cmd run build`: 235 routes generated. Public Playwright/axe/overflow E2E: 51 passed,
  1 intentional authenticated test skipped out of 52.
- Loyalty settings, reward writes, fulfillment, and cancellation now check Supabase errors and target
  rows before audit logging or revalidation. Redemption transitions are guarded by pending status,
  failed reads close the action, and points-engine exceptions use the sanitized marketing boundary.

## Latest Audit Update - Marketing asset and content publication boundaries

- `npm.cmd exec vitest run tests/marketing-assets-content-boundaries.test.ts`: 1 file, 2 tests passed.
- `npm.cmd exec vitest run`: 364 files, 2,829 tests passed.
- `npm.cmd run typecheck`, `npm.cmd run lint`, dependency audit, migration audit, and live schema probes passed.
- Clean `npm.cmd run build`: 235 routes generated. Public Playwright/axe/overflow E2E: 51 passed,
  1 intentional authenticated test skipped out of 52.
- Marketing asset uploads now fail closed on storage/database errors, roll back failed rows, validate
  server-derived storage paths on deletion, and check target rows. Content edits and blog publishing
  now check required reads, upserts, updates, and unpublishing before audit logging or revalidation.

## Latest Audit Update - Competitive, CRM, and Proposals action boundaries

- `npm.cmd exec vitest run tests/marketing-competitive-crm-proposals-boundaries.test.ts`: 1 file, 3 tests passed.
- `npm.cmd exec vitest run`: 364 files, 2,829 tests passed.
- Competitive Intelligence, CRM, and Proposals inserts, updates, and deletes now check Supabase errors
  and affected rows before audit logging or revalidation. Unexpected failures use the shared sanitized
  marketing action boundary.

## Latest Audit Update - Admin read-path integrity

- `npm.cmd exec vitest run tests/admin-read-boundaries.test.ts`: 1 file, 3 tests passed.
- `npm.cmd exec vitest run`: 364 files, 2,829 tests passed.
- Marketplace Reports and both Support Ticket admin views now check required Supabase reads and render
  a retryable error state instead of treating a failed query as an empty queue.

## Latest Audit Update - Tier & Marketplace moderation action boundaries

- `npm.cmd exec vitest run tests/admin-tier-report-action-boundaries.test.ts`: 1 file, 4 tests passed.
- `npm.cmd exec vitest run`: 364 files, 2,829 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run build`: passed; 235 pages generated. Known warnings remain for the Supabase Edge
  Runtime import and webpack cache serialization of large strings.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e -- --reporter=line`: 51 passed, 1 intentional
  authenticated test skipped out of 52.
- `npm.cmd run db:audit:migrations`: passed; 215 numbered SQL files, 17 explicit historical duplicate
  prefixes, next available version `0200`.
- `npm.cmd run db:audit:schema`: passed all 11 required live schema checks.
- Tier settings now fail closed on failed reads/upserts and reject invalid feature/tier values. Marketplace
  report moderation checks reads, target rows, withdrawal writes, and stale status transitions before
  reporting success; safety withdrawal precedes report resolution.

## Latest Audit Update - Support Ticket action boundaries

- `npm.cmd exec vitest run tests/support-ticket-action-boundaries.test.ts`: 1 file, 2 tests passed.
- `npm.cmd exec vitest run`: 360 files, 2,817 tests passed.
- Support Ticket status transitions and creation now validate inputs, check target/write results,
  return stable failures, and surface unsuccessful mutations in the admin client. Ticket numbers no
  longer depend on a concurrent count-plus-one calculation.

## Latest Audit Update - Admin Management action boundaries

- `npm.cmd test -- --run tests/admin-management-action-boundaries.test.ts`: 1 file, 2 tests passed.
- `npm.cmd exec vitest run`: 360 files, 2,817 tests passed.
- Admin deactivate, activate, revoke, and invite mutations now validate inputs, check every database
  result and target row, sanitize failures, and surface unsuccessful mutations in the client.

## Latest Audit Update - AI assistant action boundaries

- `npm.cmd test -- --run tests/ai-action-boundaries.test.ts tests/db-errors.test.ts`: 2 files, 15 tests passed.
- `npm.cmd exec vitest run`: 360 files, 2,817 tests passed.
- AI tool exceptions and Super Admin AI configuration failures now return stable messages with server-side
  diagnostics. AI chat fails closed on conversation initialization and family-context reads, checks message
  persistence before reporting completion, and exposes persistence status in the final stream event.

## Latest Audit Update - Wallet and Stripe Money action boundaries

- `npm.cmd test -- --run tests/wallet-money-action-boundaries.test.ts tests/db-errors.test.ts`: 2 files, 14 tests passed.
- Wallet hub and Stripe Money actions now log unexpected database/provider details server-side and return
  stable user-facing failures. Required account, card, wallet, and member reads fail closed before money
  mutations, while audit inserts remain observable best-effort after successful external effects.

## Latest Audit Update - Marketplace and Feedback action boundaries

- `npm.cmd test -- --run tests/migration-version-safety.test.ts tests/guardian-action-error-boundaries.test.ts tests/marketplace-feedback-action-boundaries.test.ts`: 3 files, 9 tests passed.
- `npm.cmd exec vitest run`: 358 files, 2,813 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run build`: passed; 235 pages generated. Known warnings remain for the Supabase Edge
  Runtime import and webpack cache serialization of large strings.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e -- --reporter=line`: 51 passed, 1 intentional
  authenticated test skipped out of 52.
- `npm.cmd run db:audit:migrations`: passed; 215 numbered SQL files, 17 explicit historical duplicate
  prefixes, next available version `0200`.
- `npm.cmd run db:audit:schema`: passed all 11 required live schema checks.
- `npm.cmd run db:audit:auth`: public Auth health passed; Admin users returned HTTP 500, latest error
  ID `019f617e-363b-77ea-9e8a-db390083d810`.
- Marketplace and Feedback actions now log unexpected database failures server-side and return stable
  messages; required reads fail closed before mutations, including saved searches, offers, orders, votes,
  and hand-offs. Expected duplicate and domain outcomes remain explicit.
- Marketplace hand-off completion now locks the order and hand-off in one authenticated RPC, validates the
  normalized code inside the transaction, and commits both completion states together.

## Latest Audit Update - Atomic Guardian suggestion review

- `npm.cmd test -- --run tests/guardian-action-error-boundaries.test.ts tests/migration-version-safety.test.ts`: 2 files, 5 tests passed.
- `npm.cmd exec vitest run`: 354 files, 2,787 tests passed after the Guardian safety repair.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: passed; 213 numbered SQL files, 17 explicit historical duplicate
  prefixes, next available version `0198`.
- `npm.cmd run db:audit:schema`: passed all 11 required live schema checks.
- Guardian suggestion review now applies proposed trust/routing changes, review state, and audit in
  one manager-authorized transaction; remaining Guardian action reads and writes are checked or sanitized.

## Latest Audit Update - Atomic economy and simulated-investing decisions

- `npm.cmd test -- --run tests/economy-invest-action-boundaries.test.ts tests/migration-version-safety.test.ts`: 2 files, 5 tests passed.
- `npm.cmd exec vitest run`: 354 files, 2,787 tests passed after the Guardian safety repair.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: passed; 212 numbered SQL files, 17 explicit historical duplicate
  prefixes, next available version `0197`.
- `npm.cmd run db:audit:schema`: passed all 11 required live schema checks.
- `npm.cmd run db:audit:auth`: public Auth health passed; Admin users still returned HTTP 500,
  latest error ID `019f60e4-438a-70e7-b98a-9810d7906575`.
- Economy redemptions and simulated-investment fills now use authenticated, row-locking RPCs for
  atomic ledger/order/holding/stock/audit updates; action-layer reads and direct writes are checked.

## Latest Audit Update - Account and device-security action boundaries

- `npm.cmd test -- --run tests/account-action-error-boundaries.test.ts`: 1 file, 2 tests passed.
- `npm.cmd exec vitest run`: 353 files, 2,785 tests passed after the atomic ledger-decision repair.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: passed; 211 numbered SQL files, 17 explicit historical duplicate
  prefixes, next available version `0196`.
- `npm.cmd run db:audit:schema`: passed all 11 required live schema checks.
- Account closure/reopen, family switching, dashboard preferences, profile synchronization, and App
  Lock now check required Supabase reads and writes and return sanitized action failures.

## Latest Audit Update - Privileged marketing mutation boundaries

- `npm.cmd exec vitest run tests/marketing-action-error-boundaries.test.ts tests/marketing-affiliates.test.ts tests/marketing-surveys.test.ts tests/db-errors.test.ts`: 4 files, 29 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd exec vitest run`: 352 files, 2,783 tests passed after the account/security repair.
- `npm.cmd run build`: passed; 235 pages generated. Known warnings remain for the Supabase Edge
  Runtime import and webpack cache serialization of large strings.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e -- --reporter=line`: 51 passed, 1 intentional
  authenticated test skipped out of 52.
- All audited marketing service-role writes now check Supabase errors before audit logging,
  revalidation, or redirects; raw survey database errors are sanitized.

## Latest Audit Update - Onboarding provisioning failure safety

- `npm.cmd exec vitest run tests/onboarding-failure-safety.test.ts tests/onboarding-profile.test.ts tests/db-errors.test.ts`: 3 files, 27 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 235 pages generated. Known warnings remain for the Supabase Edge
  Runtime import and webpack cache serialization of large strings.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e -- --reporter=line`: 51 passed, 1 intentional
  authenticated test skipped out of 52.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: passed; 211 numbered SQL files, 17 explicit historical duplicate
  prefixes, next available version `0196`.
- `npm.cmd run db:audit:schema`: passed all 11 required live schema checks.
- `npm.cmd run db:audit:auth`: public auth health passed; Admin users returned HTTP 500,
  error ID `019f60ca-de39-7f6a-aa26-6c69ebc03519`.
- Required onboarding writes now return sanitized failures instead of logging and continuing; the
  retry marker is written before family creation/resume and completion remains idempotent.

## Latest Audit Update - Server-action error boundaries and signal fail-closed behavior

- `npm.cmd exec vitest run`: 350 files, 2,779 tests passed after rebasing the onboarding repair onto
  the latest `main`.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run db:audit:migrations`: passed; 211 numbered SQL files, 17 explicit historical duplicate
  prefixes, next available version `0196`.
- `npm.cmd run db:audit:schema`: passed all 11 required live schema checks.
- Server-action contracts now reject raw unclassified error messages, and signal detection checks all
  six source reads plus existing-signal reads and upserts before returning success.
- The same contracts cover super-admin mutations, marketplace report moderation, Trust Engine decisions,
  and wallet ledger actions; expected balance/conflict messages remain intentionally user-facing.

## Latest Audit Update - Migration history guard

- `npm.cmd run db:audit:migrations`: passed; 211 numbered SQL files, 17 explicit historical duplicate
  prefixes, next available version `0196`.
- `npm.cmd exec vitest run`: 346 files, 2,735 tests passed after rebasing onto remote `main`.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run build`: passed; 235 pages generated.
- `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e -- --reporter=line`: 51 passed, 1 intentional
  authenticated test skipped out of 52.
- `npm.cmd run db:audit:schema`: passed all 11 required live schema checks.
- `npm.cmd run db:audit:auth`: public health passed; Admin users still returned HTTP 500,
  error ID `019f609e-85b7-7499-b91d-8c7dcce8354e`.

## Audit Update - Marketplace photo storage lifecycle

- Added `lib/storage/marketplace-photos.ts` to parse only same-project, UUID-owned marketplace
  bucket URLs and perform storage cleanup through the authenticated client.
- Marketplace quick-post and listing edit flows now clean uploaded objects after failed inserts,
  canceled drafts, resets, replacements, and listing deletion.
- `npm.cmd exec vitest run`: 347 files, 2,739 tests passed.
- `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd run build`, and dependency audit passed.
- Public Playwright/axe/overflow E2E: 51 passed, 1 intentional authenticated skip.

## Passing Checks

| Command | Result |
|---|---|
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run lint` | PASS; Next.js reports the known `next lint` deprecation notice |
| `npm.cmd exec vitest run` | PASS: 346 files, 2,732 tests |
| `npm.cmd run build` | PASS: Next.js 15.5.19, 235 generated pages |
| `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e -- --reporter=line` | PASS: 51 of 52 tests; 1 intentional auth skip |
| `npm.cmd test -- tests/marketplace-circles-rls.test.ts tests/seed-data-safety-contract.test.ts tests/seed-tls-safety-contract.test.ts` | PASS: 3 files, 5 tests |
| `npm.cmd test -- tests/production-readiness-seed.test.ts tests/seed-data-safety-contract.test.ts` | PASS: 2 files, 4 tests |
| `npm.cmd test -- tests/ai-chat-request.test.ts tests/marketing-consent-safety.test.ts` | PASS: 2 files, 4 tests |
| `npm.cmd test -- tests/ai-rate-limit.test.ts tests/ai-voice.test.ts` | PASS: 2 files, 22 tests |
| `npm.cmd test -- tests/sync-feed-contract.test.ts` | PASS: 1 file, 2 tests |
| `npm.cmd test -- tests/seed-credentials-safety.test.ts ...` | PASS: all seed credential/TLS/safety contracts |
| `git diff --check` | PASS |
| `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e` | PASS: 51, skipped 1 |
| `npm.cmd audit --omit=dev --audit-level=moderate` | PASS: 0 vulnerabilities after the scoped PostCSS override |
| `npm.cmd run db:audit:migrations` | PASS: 17 known historical duplicate prefixes are explicit; next available version `0196` |

## Audit Update - 2026-07-13 (post-rebase seller cockpit baseline)

- `npm.cmd exec vitest run`: 339 files and 2,701 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 235 pages generated, including dynamic `/marketplace/selling`.
- `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e -- --reporter=line`: 51 passed, 1 intentional authenticated test skipped.
- This snapshot was rerun after rebasing the child-login hardening onto the current `origin/main`, which includes the marketplace Seller Cockpit.

## Audit Update - 2026-07-13 (durable limiter failure boundary)

- `npm.cmd exec vitest run`: 340 files and 2,705 tests passed.
- `npm.cmd exec vitest run tests/rate-limit-db.test.ts tests/ai-rate-limit.test.ts tests/public-side-effect-rate-limit.test.ts tests/child-login-action-security.test.ts`: 4 files, 10 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 235 pages generated.
- `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e -- --reporter=line`: 51 passed, 1 intentional authenticated test skipped.
- The durable limiter now fails closed on RPC errors, empty or malformed responses, and invalid retry values; explicit availability-first behavior requires `failOpen: true`.
- `npm.cmd run db:audit:schema`: passed all 11 required live schema checks.
- `npm.cmd run db:audit:auth`: public Auth health passed; Admin users still returned HTTP 500
  (`019f5dbf-8c64-7fc2-ae04-75197364e067`).

## Audit Update - 2026-07-13 (post-rebase marketplace reports and Price Coach baseline)

- `npm.cmd exec vitest run`: 342 files and 2,721 tests passed.
- `npm.cmd exec vitest run tests/rate-limit-db.test.ts`: 1 file, 4 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 235 pages generated, including `/admin/marketplace/reports`.
- `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e -- --reporter=line`: 51 passed, 1 intentional authenticated test skipped.
- This validation ran after rebasing onto the current `origin/main`, which includes marketplace trust/reporting,
  Price Coach, migration `0193`, and their seed/test coverage.

## Audit Update - 2026-07-13 (local limiter resource boundary)

- `npm.cmd exec vitest run`: 343 files and 2,724 tests passed.
- `npm.cmd exec vitest run tests/rate-limit.test.ts tests/rate-limit-db.test.ts tests/ai-rate-limit.test.ts tests/public-side-effect-rate-limit.test.ts`: 4 files, 12 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 235 pages generated.
- `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e -- --reporter=line`: 51 passed, 1 intentional authenticated test skipped.
- Local limiter buckets now have bounded capacity, expired-bucket pruning, normalized parameters, and validated IP-derived keys.
- `npm.cmd run db:audit:schema`: passed all 11 required live schema checks.
- `npm.cmd run db:audit:auth`: public Auth health passed; Admin users still returned HTTP 500
  (`019f5de7-9b16-78cc-9e87-d74ac923eb08`).

## Audit Update - 2026-07-13 (dependency advisory remediation)

- Added a package-manager override for Next.js's nested PostCSS dependency, pinning it to patched `8.5.10`.
- `npm.cmd install --package-lock-only --ignore-scripts`: passed; lockfile reconciled.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- Full Vitest, typecheck, lint, production build, and public Playwright/axe/overflow E2E all passed after the override.

## Audit Update - 2026-07-13 (seed write failure boundaries)

- All six legacy service-role seed scripts now throw on insert failures instead of continuing after a
  partial write. The medical cleanup path also throws on unexpected delete failures.
- `node --check` passed for every `scripts/seed*.mjs` file.
- `npm.cmd exec vitest run tests/seed-failure-safety.test.ts tests/seed-scope-safety.test.ts tests/seed-credentials-safety.test.ts tests/seed-tls-safety-contract.test.ts`:
  4 files, 5 tests passed.
- Full Vitest: 344 files, 2,725 tests passed. Typecheck, lint, build (235 pages), and public E2E (51
  passed, 1 intentional authenticated skip) passed. npm audit remains at 0 vulnerabilities.
- Live schema audit passed all 11 required checks. Auth Admin still returns HTTP 500, latest error ID
  `019f5de7-9b16-78cc-9e87-d74ac923eb08`.

## Audit Update - 2026-07-13 (CI gate enforcement)

- GitHub Actions now runs `npm audit --omit=dev --audit-level=moderate` in the quality job.
- The isolated Supabase E2E job now runs `npm run db:audit:auth` and `npm run db:audit:schema` before
  browser tests.
- `npm.cmd exec vitest run tests/production-readiness-workflow.test.ts`: 1 file, 2 tests passed.
- Full local Vitest: 345 files, 2,727 tests passed. Typecheck, lint, npm audit (0 vulnerabilities),
  and production build (235 pages) passed.

## Audit Update - 2026-07-13 (post-rebase marketplace deals)

- Rebased onto remote `main` commit `4a0fa966`, adding the marketplace Deals feed and related Price Coach
  coverage.
- Full Vitest: 345 files, 2,729 tests passed. Typecheck, lint, npm audit (0 vulnerabilities), and build
  (235 pages) passed.
- Public Playwright/axe/overflow E2E: 51 passed, 1 intentional authenticated skip.

## Browser Coverage

- Public routes rendered successfully: home, pricing, features, how-it-works, security, FAQ, AI,
  mobile, blog, contact, login, and signup.
- Accessibility checked in dark and light modes using axe, with no serious or critical violations.
- Horizontal overflow checked at 320, 390, 768, and 1024 pixels with no failures.
- Anonymous dashboard access redirected to login.
- Authenticated first-value journey was intentionally skipped because `E2E_AUTHENTICATED` was not set.

## Audit Update - 2026-07-13 (authenticated context failure boundary)

- `npm.cmd exec vitest run tests/auth-context-error-contract.test.ts tests/database-error-boundaries.test.ts tests/public-error-contract.test.ts tests/assistant-tool-error-contract.test.ts`: 4 files, 4 tests passed.
- `npm.cmd exec vitest run`: 336 files and 2,689 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 235 pages generated.
- `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e -- --reporter=line`: 51 passed, 1 intentional authenticated test skipped.
- `getUserContext()` now distinguishes failed Supabase reads from a genuinely empty family and will not
  enter automatic service-role provisioning after a membership, family, or preference query error.

## Audit Update - 2026-07-13 (public server-action side effects)

- `npm.cmd exec vitest run tests/public-server-action-safety.test.ts tests/public-side-effect-rate-limit.test.ts tests/marketing-consent-safety.test.ts`: 3 files, 5 tests passed.
- `npm.cmd exec vitest run`: 337 files and 2,691 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 235 pages generated.
- `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e -- --reporter=line`: 51 passed, 1 intentional authenticated test skipped.
- Public review, survey, and gift actions now use the shared durable IP limiter and ignore hostile
  non-string payload fields instead of calling string methods on untrusted values.

## Audit Update - 2026-07-13 (child sign-in abuse boundary)

- `npm.cmd exec vitest run tests/child-login-action-security.test.ts tests/child-login.test.ts tests/child-throttle.test.ts`: 3 files, 19 tests passed.
- `npm.cmd exec vitest run`: 338 files and 2,692 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 235 pages generated.
- `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e -- --reporter=line`: 51 passed, 1 intentional authenticated test skipped.
- Child username/PIN sign-in now applies a durable IP-wide limit before database lookups, validates
  runtime payload types, and fails closed when throttle or child-login lookup reads fail.

## Database Evidence

- Live schema audit: earlier required probes passed; `marketplace_circles` returned HTTP 500 / `42P17`
  before the new migration.
- Current schema audit: 11 required live table/ledger checks pass, including
  `stripe_webhook_events.claim_columns`.
- Live Auth audit: public health passed; Admin users returned HTTP 500.
- Local Supabase migration/RLS tests: not run because Docker Desktop's Linux engine was unavailable.
- No destructive production database or storage operation was run.
- Historical credential comparison confirmed the removed source credential matched the current local
  service key; Supabase key management returned HTTP 403 and rotation was not possible here.

## Known Gaps

- Authenticated browser journey and RLS attack tests require an isolated Supabase instance.
- Production migration application and post-migration live probes remain pending.
- Visual regression, large-dataset performance, webhook replay, and third-party provider failure tests
  remain documented in `testing-plan.md` and the production ledger.

## Audit Update - 2026-07-13 (public side-effect limits)

- `npm.cmd test`: 306 files and 2,556 tests passed.
- `npm.cmd test -- tests/public-side-effect-rate-limit.test.ts tests/ai-rate-limit.test.ts`: 2 files,
  5 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 233 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.

## Audit Update - 2026-07-13 (marketplace returns seed safety)

- `npm.cmd exec vitest run tests/seed-data-safety-contract.test.ts tests/production-readiness-seed.test.ts tests/marketplace-handoff.test.ts tests/marketplace-returns.test.ts`: 4 files, 26 tests passed.
- `npm.cmd exec vitest run`: 335 files and 2,688 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 235 pages generated.
- `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- The returns fixture is now additive and conflict-safe, requires the anchored account and two
  existing active members, and fails closed when migration `0192` or `returned_at` is unavailable.

## Audit Update - 2026-07-13 (provider response bounds)

- `npm.cmd exec vitest run tests/response-body-boundaries.test.ts tests/ai-error.test.ts tests/ai-voice.test.ts tests/sync-adapter.test.ts`:
  4 files, 39 tests passed.
- `npm.cmd exec vitest run`: 327 files and 2,645 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.

## Audit Update - 2026-07-13 (remaining API and assistant error boundaries)

- `npm.cmd exec vitest run tests/database-error-boundaries.test.ts tests/public-error-contract.test.ts tests/assistant-tool-error-contract.test.ts tests/ai-error.test.ts`: 4 files, 12 tests passed.
- `npm.cmd exec vitest run`: 334 files and 2,679 tests passed.
- `npm.cmd run typecheck`: PASS.
- `npm.cmd run lint`: PASS with the known Next.js `next lint` deprecation notice.
- `npm.cmd run build`: PASS with 234 generated pages.
- `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e -- --reporter=line`: 51 of 52 tests passed; 1 intentional authenticated skip.
- Remaining AI, provider, cron, Weekend Planner, marketing-email, and assistant-tool failures now use
  safe client/model-visible messages while retaining server-side diagnostics.
- OpenAI, Twilio, email, marketing, voice, and flyer provider error reads now use a 64 KiB streaming
  response cap. Google and Microsoft Graph text responses use a 2 MiB cap before JSON parsing.
- `tests/response-body-boundaries.test.ts` covers exact text preservation, oversized streamed response
  cancellation, and static coverage for every audited provider path.

## Audit Update - 2026-07-13 (provider JSON response bounds)

- `npm.cmd exec vitest run tests/response-body-boundaries.test.ts tests/ai-error.test.ts tests/ai-voice.test.ts tests/sync-adapter.test.ts tests/weather.test.ts tests/weekend-feed-security.test.ts tests/recipe-normalize.test.ts tests/trip-departure.test.ts`:
  8 files, 76 tests passed.
- `npm.cmd exec vitest run`: 327 files and 2,648 tests passed.
- Provider JSON responses now use bounded streaming reads before parsing; OAuth token payloads reject
  successful responses that omit an access token.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.

## Audit Update - 2026-07-13 (external provider timeouts)

- `npm.cmd exec vitest run tests/external-fetch-boundaries.test.ts tests/response-body-boundaries.test.ts tests/assistant-tool-loop.test.ts tests/ai-error.test.ts tests/ai-voice.test.ts tests/sync-adapter.test.ts tests/weather.test.ts tests/weekend-feed-security.test.ts tests/recipe-normalize.test.ts tests/trip-departure.test.ts`:
  10 files, 83 tests passed.
- `npm.cmd exec vitest run`: 328 files and 2,652 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- Fixed-provider server calls now have explicit finite deadlines; browser weather and routing calls use
  cancellable 15-second deadlines. The public-calendar/social URL boundary remains separately validated.

## Audit Update - 2026-07-13 (SECURITY DEFINER trigger hardening)

- `npm.cmd exec vitest run tests/sql-security-contract.test.ts tests/production-migration-contract.test.ts tests/rate-limit-rpc-security.test.ts tests/marketplace-auction-security.test.ts tests/marketplace-negotiation-security.test.ts`:
  5 files, 19 tests passed.
- `npm.cmd exec vitest run`: 329 files and 2,655 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- Migration `0188_harden_trigger_function_security.sql` pins both repaired trigger functions to the
  `public` search path and revokes direct client execution privileges.
- The response contract covers exact text and JSON parsing, invalid JSON, oversized stream cancellation,
  and static coverage for every audited provider JSON path.

## Audit Update - 2026-07-13 (Stripe claim-column reconciliation)

- `npm.cmd exec vitest run tests/production-migration-contract.test.ts tests/stripe-webhook-replay-contract.test.ts`:
  2 files, 15 tests passed.
- `npm.cmd exec vitest run`: 329 files and 2,656 tests passed.
- `node --check scripts/audit-supabase-schema.mjs`: passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- `npm.cmd run db:audit:schema`: 10 live checks passed; both Stripe claim columns remain missing until `0189` is deployed.
- `npm.cmd run db:audit:auth`: public auth health passed; Supabase Auth Admin user listing still returns HTTP 500.
- Migration `0189_reconcile_stripe_webhook_claims.sql` re-applies both claim columns and the processing
  index idempotently; the live schema audit now verifies `processing_started_at` and `claim_token`.

## Audit Update - 2026-07-13 (public metric error boundaries)

- `npm.cmd exec vitest run tests/public-error-contract.test.ts tests/production-migration-contract.test.ts`:
  2 files, 12 tests passed.
- `npm.cmd exec vitest run`: 330 files and 2,657 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- Public metric endpoints now return stable generic failure messages while retaining server-side diagnostics.

## Audit Update - 2026-07-13 (API database-error boundaries)

- `npm.cmd exec vitest run tests/database-error-boundaries.test.ts tests/public-error-contract.test.ts`:
  2 files, 2 tests passed.
- `npm.cmd exec vitest run`: 331 files and 2,658 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- Audited authenticated and cron routes now return operation-specific generic database failures while
  preserving server-side diagnostics.

## Audit Update - 2026-07-13 (marketplace hand-off seed repair and integration)

- `npm.cmd exec vitest run tests/seed-data-safety-contract.test.ts tests/production-readiness-seed.test.ts tests/marketplace-handoff.test.ts`:
  3 files, 17 tests passed.
- `npm.cmd exec vitest run`: 333 files and 2,678 tests passed.
- `npm.cmd run typecheck`: PASS.
- `npm.cmd run lint`: PASS with the known Next.js `next lint` deprecation notice.
- `npm.cmd run build`: PASS with 234 generated pages.
- `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e -- --reporter=line`: 51 of 52 tests passed; 1 intentional authenticated skip.
- The hand-off feature remains covered after rebasing onto the concurrent marketplace commit; its seed
  is now anchored, deterministic, additive, and free of deletes or stand-in member creation.

## Audit Update - 2026-07-13 (atomic expired auction settlement)

- `npm.cmd exec vitest run tests/marketplace-auction.test.ts tests/marketplace-auction-security.test.ts tests/production-migration-contract.test.ts`: 3 files, 24 tests passed.
- `npm.cmd exec vitest run`: 316 files, 2,601 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.

## Audit Update - 2026-07-13 (raw webhook and upload body bounds)

- `npm.cmd exec vitest run tests/raw-body-boundaries.test.ts tests/request-body-boundaries.test.ts`:
  2 files, 7 tests passed.
- `npm.cmd test`: 325 files and 2,636 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- Stripe, Resend, and money webhooks, push subscription routes, and calendar sync now use a shared
  streaming reader that rejects oversized chunked bodies before complete buffering.
- Signed webhook bodies remain exact raw text for provider signature verification.
- Twilio form-encoded callbacks and voice transcription multipart uploads now use dedicated bounded
  form-data handling before platform parsing.

## Audit Update - 2026-07-13 (bounded form-data ingress)

- `npm.cmd exec vitest run tests/raw-body-boundaries.test.ts tests/guardian-callback-security.test.ts tests/ai-voice.test.ts`:
  3 files, 34 tests passed.
- `npm.cmd test`: 325 files and 2,639 tests passed.
- Twilio URL-encoded callback fields and multipart audio files are parsed only after a bounded byte read.
- Twilio callback requests are capped at 64 KiB; transcription requests are capped at 26 MiB while the
  existing 25 MiB audio-file limit remains enforced.
- No direct `req.formData()` calls remain in the audited Guardian or voice-transcription routes.

## Audit Update - 2026-07-13 (Social Feed unfurl SSRF and response bounds)

- `npm.cmd exec vitest run tests/social-feed-fetch-security.test.ts tests/public-calendar-fetch.test.ts tests/weekend-feed-security.test.ts`:
  3 files, 8 tests passed.
- `npm.cmd test`: 326 files and 2,642 tests passed.
- Social Feed URL unfurling now uses public DNS validation, manual redirect revalidation, a 600 KiB
  streamed response cap, and bounded HTML parsing.
- Redirects to loopback/private addresses and oversized streamed HTML are covered by regression tests.
- Added `marketplace_close_auction()` in migration `0185` and moved the close-auctions cron to the
  service-role RPC. Listing, order, and bid settlement now commit together; failed order creation
  leaves the listing retryable.
- Added the auction security contract covering service-role execution and the cron/RPC boundary.
- Production still requires migrations `0184` and `0185` to be applied before auction enforcement is
  complete.

## Audit Update - 2026-07-13 (generic provider-sync request boundary)

- `npm.cmd exec vitest run tests/sync-request-body.test.ts tests/sync-adapter.test.ts tests/sync-oauth-csrf.test.ts`: 3 files, 23 tests passed.
- `npm.cmd exec vitest run`: 317 files, 2,604 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- Generic `/api/sync/run` requests now use a streaming 4 KiB body bound, JSON validation, and bounded
  provider strings before adapter lookup or service-role work. No migration is required.

## Audit Update - 2026-07-13 (production-readiness seed scope)

- `npm.cmd exec vitest run tests/production-readiness-seed.test.ts tests/seed-data-safety-contract.test.ts tests/seed-credentials-safety.test.ts`: 3 files, 6 tests passed.
- The 600-record idempotent seed now fails closed when `newworldventurellc@gmail.com` cannot resolve
  to a family; it cannot silently select the first available household.
- `npm.cmd exec vitest run`: 317 files, 2,605 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- Public service-role ingestion contract now covers contact, forms, exit-intent, landing-page,
  visitor-intelligence, and A/B routes using the shared durable request guard.

## Audit Update - 2026-07-13 (master seed scope preflight)

- `npm.cmd exec vitest run tests/master-seed-scope.test.ts tests/production-readiness-seed.test.ts tests/seed-data-safety-contract.test.ts`: 3 files, 7 tests passed.
- `npm.cmd exec vitest run`: 318 files, 2,607 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- `supabase/SEED_ALL.sql` now checks the anchored account before its first section, so a missing target
  aborts the full one-paste workflow before any service-role seed write.

## Audit Update - 2026-07-13 (request and scheduled-callback boundaries)

- `npm.cmd exec vitest run tests/cron-auth.test.ts tests/request-body-boundaries.test.ts tests/sync-request-body.test.ts`: 3 files, 10 tests passed.
- `npm.cmd exec vitest run`: 320 files, 2,614 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- Billing, contact, marketing-form, public tracker, and internal email JSON bodies now use explicit
  streaming byte bounds before parsing.
- All 16 cron routes plus concierge placement use a shared fail-closed secret guard; missing
  `CRON_SECRET` and `INTERNAL_SECRET` values cannot authorize a request.

## Audit Update - 2026-07-13 (marketplace negotiation integrity)

- `npm.cmd exec vitest run tests/marketplace-negotiation-security.test.ts tests/marketplace-negotiation.test.ts tests/seed-data-safety-contract.test.ts tests/master-seed-scope.test.ts`: 4 files, 20 tests passed.
- `npm.cmd exec vitest run`: 322 files, 2,630 tests passed.
- Negotiation migration `0187` adds database-enforced family separation, amount/message bounds, and
  below-ask round validation. The standalone and consolidated negotiation seeds now fail closed when
  `newworldventurellc@gmail.com` cannot resolve to an anchored family.

## Audit Update - 2026-07-13 (provider request boundaries)

- `npm.cmd exec vitest run tests/provider-request-body-boundaries.test.ts tests/request-body-boundaries.test.ts`: 2 files, 5 tests passed.
- `npm.cmd exec vitest run`: 323 files, 2,632 tests passed.
- Every `app/api` route that accepts JSON now uses the shared streaming bounded reader; the contract
  sweep found no direct `req.json()` or `request.json()` calls. Provider-backed bodies are capped at
  256 KiB, small control bodies at 16 KiB, and flyer uploads at 8 MiB.

## Audit Update - 2026-07-13 (Weekend Planner feed SSRF boundary)

- `npm.cmd exec vitest run tests/weekend-feed-security.test.ts tests/public-calendar-fetch.test.ts tests/provider-request-body-boundaries.test.ts`: 3 files, 6 tests passed.
- `npm.cmd exec vitest run`: 324 files, 2,633 tests passed.
- Family-curated RSS/ICS feeds now use `fetchPublicCalendarText`, which rejects private or metadata
  targets, validates redirects, applies a 15-second timeout, and caps response bodies at 1 MiB.

## Audit Update - 2026-07-13 (model/provider request budgets)

- `npm.cmd test`: 307 files and 2,557 tests passed.
- `npm.cmd test -- tests/ai-route-rate-limit-contract.test.ts tests/ai-rate-limit.test.ts tests/public-side-effect-rate-limit.test.ts`:
  3 files, 6 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 233 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- The audited model-backed and external-provider routes now use shared durable per-user request
  budgets before paid provider calls or broad context reads. Durable enforcement depends on migration
  `0156` being applied in the target environment.

## Audit Update - 2026-07-13 (provider inventory follow-up)

- `npm.cmd test`: 307 files and 2,557 tests passed.
- `npm.cmd test -- tests/ai-route-rate-limit-contract.test.ts tests/ai-rate-limit.test.ts`: 2 files,
  4 tests passed.
- The route contract now covers marketing-admin AI, behavior coaching, and the authenticated Giphy
  proxy in addition to the prior model/provider inventory.
- Marketing AI request text is trimmed and capped at 4,000 characters before prompt construction.

## Audit Update - 2026-07-13 (durable limiter RPC privileges)

- `npm.cmd test`: 308 files and 2,558 tests passed.
- `npm.cmd test -- tests/rate-limit-rpc-security.test.ts tests/ai-rate-limit.test.ts tests/public-side-effect-rate-limit.test.ts`:
  3 files, 6 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 233 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- `npm.cmd run db:audit:schema`: all 8 required tables passed.
- Migration `0179_harden_rate_limit_rpc_grants.sql` revokes anonymous/public limiter RPC access,
  binds authenticated keys to `auth.uid()`, and restricts pruning to `service_role`.

## Audit Update - 2026-07-13 (Resend webhook replay protection)

- `npm.cmd test`: 309 files and 2,559 tests passed.
- `npm.cmd test -- tests/resend-webhook-replay-contract.test.ts tests/marketing-unsubscribe.test.ts`:
  2 files, 6 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 233 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- Resend/Svix webhook processing now rejects stale signatures and oversized payloads, and deduplicates
  signed event IDs through migration `0180_resend_webhook_dedup.sql`.

## Audit Update - 2026-07-13 (schema audit coverage)

- `npm.cmd test`: 309 files and 2,560 tests passed.
- `npm.cmd test -- tests/production-migration-contract.test.ts tests/resend-webhook-replay-contract.test.ts`:
  2 files, 9 tests passed.
- `npm.cmd run db:audit:schema`: 8 existing required tables passed; the new
  `resend_webhook_events` probe correctly reports missing until migration `0180` is applied.

## Audit Update - 2026-07-13 (unsubscribe boundary)

- `npm.cmd test`: 309 files and 2,561 tests passed.
- `npm.cmd test -- tests/marketing-unsubscribe.test.ts tests/public-side-effect-rate-limit.test.ts`:
  2 files, 8 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 233 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- The unsubscribe route now has a shared IP budget, bounded HMAC input, escaped HTML output, and
  production fail-closed secret handling.

## Audit Update - 2026-07-13 (Guardian callback replay protection)

- `npm.cmd test`: 310 files and 2,571 tests passed.
- `npm.cmd test -- tests/guardian-callback-security.test.ts tests/guardian-screening-turn.test.ts`:
  2 files, 10 tests passed.
- `npm.cmd run typecheck`: passed.
- Signed SMS, WhatsApp, voice, screening, and voicemail callbacks now claim bounded provider event IDs
  before AI, notification, or telephony side effects through migration `0181_guardian_callback_replay.sql`.
- Live schema audit correctly reports `guardian_callback_events` missing until migration `0181` is applied.
## Audit Update - 2026-07-13

- `node --check scripts/seed*.mjs`: passed for all six legacy seed scripts plus the shared client.
- `npm.cmd test -- tests/seed-credentials-safety.test.ts tests/seed-scope-safety.test.ts`: 2 files,
  3 tests passed.
- `npm.cmd test`: 305 files and 2,554 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- Static scope scan: no legacy fixed family, creator, or member UUIDs remain in `scripts/seed*.mjs`.
- `npm.cmd run db:audit:schema`: 8 required live tables available.
- Live anonymous REST probes for `marketplace_circles`, `marketplace_circle_members`, and
  `marketplace_listing_shares`: HTTP 200 for each. This is not a substitute for authenticated
  cross-family RLS attack tests.
- `npm.cmd test -- tests/public-gift-privacy-contract.test.ts`: 1 file, 1 test passed.
- Public gift privacy regression: inactive links no longer trigger child/family identifying lookups.
- `npm.cmd test -- tests/guardian-screening-turn.test.ts tests/public-gift-privacy-contract.test.ts`:
  2 files, 2 tests passed.
- Guardian callback ordering regression covers stale, skipped, malformed, and over-limit turns.
- `npm.cmd test -- tests/marketing-ab.test.ts`: 1 file, 9 tests passed.
- A/B ingestion regression covers configured versus fabricated/malformed variants.
- `npm.cmd test -- tests/marketing-consent-safety.test.ts tests/marketing-ab.test.ts`: 2 files,
  10 tests passed.
- Consent ingestion regression covers unknown, non-boolean, oversized, and null payloads.
- `npm.cmd test -- tests/ai-chat-request.test.ts`: 1 file, 3 tests passed.
- Agentic chat input regression covers malformed UUIDs, blank messages, trimming, and the 8,000-character bound.
- Voice AI regression covers local/durable limiter behavior before paid transcription and speech calls.
- Calendar feed regression covers URL-safe token bounds before service-role reads.

## Audit Update - 2026-07-13 (Stripe webhook claim serialization)

- `npm.cmd test`: 311 files and 2,576 tests passed.
- `npm.cmd test -- tests/stripe-webhook-replay-contract.test.ts tests/production-migration-contract.test.ts`:
  2 files, 14 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- Stripe billing and money webhooks now bound payloads, fail closed on missing configuration or event
  ledger storage, and serialize active claims through migration `0182_stripe_webhook_claims.sql`; claim
  ownership tokens prevent older workers from overwriting a reclaimed event.
- Live schema audit reports the expected missing `processing_started_at` column until migration `0182`
  is applied.

## Audit Update - 2026-07-13 (sync OAuth CSRF protection)

- `npm.cmd test -- tests/sync-oauth-csrf.test.ts tests/sync-adapter.test.ts tests/connections-adapter.test.ts`:
  3 files, 32 tests passed.
- `npm.cmd test`: 312 files and 2,579 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 233 routes generated.
- `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e`: 51 passed, 1 intentional auth test skipped.
- Google and generic provider-sync OAuth flows now use opaque provider-scoped state cookies, constant-time
  comparison, session-derived identity, and callback cleanup. No new migration is required.
- Live schema audit: migrations `0180` and `0181` are now present; `0182` remains pending. Auth Admin
  users probe still returns HTTP 500.

## Audit Update - 2026-07-13 (calendar fetch SSRF and response bounds)

- `npm.cmd exec vitest run tests/public-calendar-fetch.test.ts tests/calendar-feeds.test.ts`: 2 files,
  14 tests passed.
- `npm.cmd test`: 313 files and 2,583 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 233 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- Calendar URL fetches now reject private/loopback/link-local/metadata DNS targets and unsafe redirects,
  cap response bodies at 1 MiB, and return generic provider-safe errors. Import request bodies are capped
  at 16 KiB and malformed JSON returns HTTP 400.

## Audit Update - 2026-07-13 (push registration boundary)

- `npm.cmd exec vitest run tests/push-request.test.ts`: 1 file, 4 tests passed.
- Push subscription registration now enforces a 16 KiB JSON bound, strict HTTPS web endpoints, native
  APNs/FCM token validation, platform/provider matching, bounded fields, and generic database errors.
- Registration and removal use per-user local plus durable request budgets before Supabase writes.
- No migration was added; the existing `push_devices` table and all current web/native payloads remain
  supported.

## Audit Update - 2026-07-13 (marketplace auction authorization and atomic purchase)

- `npm.cmd exec vitest run tests/marketplace-auction.test.ts tests/marketplace-auction-security.test.ts`:
  2 files, 13 tests passed.
- `npm.cmd test`: 316 files and 2,600 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- Auction bidding now has an authenticated member/family check and no direct authenticated table-insert
  path. Buy-It-Now uses the atomic `marketplace_buy_now` RPC.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
## Latest Local Evidence - Atomic First-Family Provisioning

- `npm.cmd exec vitest run tests/ensure-family-concurrency.test.ts tests/onboarding-idempotency.test.ts`: 2 files, 5 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run db:audit:migrations`: passed; 228 numbered SQL files, next version `0213`.
- `git diff --check`: passed.
- Migration `0212_atomic_family_provisioning.sql` adds a service-only `ensure_family_for_user` RPC with a per-user advisory transaction lock. `ensureActiveFamily` calls it first and retains a compatibility fallback for rolling deployment.
- After integrating the concurrent feedback-board changes from `origin/main`, the merged suite passed at 416 files and 3,077 tests; typecheck and migration audit passed.
- Publication verified on `origin/main` at merge commit `cdaf1ce3` (source repair commit `e0674b15`).
- This is local contract evidence only. Remote migration application, authenticated two-request first-login verification, Auth Admin health, and cross-family RLS probes remain open.

## Latest Local Evidence - Admin Document Deletion

- `npm.cmd exec vitest run tests/admin-document-delete-boundary.test.ts tests/admin-auth-boundary.test.ts tests/admin-management-action-boundaries.test.ts`: 3 files, 6 tests passed.
- `npm.cmd test`: 417 files, 3,079 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run build`: passed and generated 250 routes; existing non-blocking cache and Edge-runtime warnings remain.
- `git diff --check`: passed.
- `adminDeleteDocumentAction` now resolves `storage_path` from the database, returns a sanitized failure when storage removal fails, and confirms the database delete result before reporting success.
- Source commit: `34a24ddd`; docs and source are published on `origin/main` at `a0b6900e`.

## Latest Local Evidence - Admin Family Creation

- `npm.cmd exec vitest run tests/admin-family-create-boundary.test.ts tests/admin-document-delete-boundary.test.ts tests/admin-auth-boundary.test.ts`: 3 files, 6 tests passed.
- `npm.cmd test`: 418 files, 3,081 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run build`: passed and generated 250 routes; existing non-blocking cache and Edge-runtime warnings remain.
- `git diff --check`: passed.
- `adminCreateFamilyAction` now checks owner lookup errors, explicitly upserts the parent membership, ensures a trial subscription when needed, and deletes the newly-created family if a required reconciliation write fails.
- Source commit: `46a227b1`; docs and source are published on `origin/main` at `b7cd416a`.

## Latest Local Evidence - Admin Allowlist Read Failure

- `npm.cmd exec vitest run tests/admin-users-read-boundary.test.ts tests/admin-auth-boundary.test.ts tests/admin-read-boundaries.test.ts`: 3 files, 6 tests passed.
- `npm.cmd test`: 419 files, 3,082 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- `npm.cmd audit --omit=dev --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm.cmd run build`: passed and generated 250 routes; existing non-blocking cache and Edge-runtime warnings remain.
- `git diff --check`: passed.
- The `/admin/users` page now includes `super_admins` in the visible Supabase load-error aggregation.
- Source commit: `c8ec95b1`; docs and source are published on `origin/main` at `dc4f5bd1`.
