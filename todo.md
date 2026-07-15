# FamilyOS — Roadmap Build TODO

## Production Readiness Audit Control Plane

- Audit started: 2026-07-15 08:04:04 -04:00
- Last updated: 2026-07-15 10:45:00 -04:00
- Repository: NewWorldVenture/FamilyOS
- Branch: `codex/world-class-production`
- Commit: `03442ccf` (published main; source repair `03442ccf`)
- Environment: Windows workspace; Next.js 15; Supabase project configuration present locally
- Supabase project: configured through `.env.local` (secrets intentionally omitted)
- Auditor: Codex production-readiness audit
- Overall status: `[!]` NO-GO pending live Supabase, account, browser, backup, and deployment evidence
- Critical blockers remaining: Auth Admin HTTP 500; remote migration ledger and credential rotation are unverified
- High-priority issues remaining: authenticated E2E; third-party callback smoke tests; full route/workflow audit
- Medium-priority issues remaining: accessibility, mobile, performance, observability, and backup evidence
- Low-priority issues remaining: final polish findings from the continuing audit

### Audit rules

- Every finding receives a permanent issue ID and remains in this ledger after resolution.
- An item is completed only after the repair is tested, documented, committed, and pushed.
- Production data is never mutated destructively; destructive tests require an isolated environment.
- The companion evidence files are `docs/AUDIT_PROGRESS.md`, `docs/SERVICE_TEST_MATRIX.md`, `docs/SUPABASE_WIRING_MATRIX.md`, `docs/LAUNCH_BLOCKERS.md`, `docs/PRODUCT_LAUNCH_AUDIT.md`, and `docs/progress/`.

### Active audit issue

#### TODO-0299 - Admin audit views hid incomplete history after read failures

- Status: `[~]` In progress
- Severity: P1
- Category: Reliability / observability / admin
- Feature: Super Admin audit and audit-log history
- Route: `/admin/audit`, `/admin/audit-logs`
- File or files: `app/(app)/admin/audit/page.tsx`, `app/(app)/admin/audit-logs/page.tsx`, `tests/admin-audit-read-boundary.test.ts`
- Database objects: `audit_logs`, `families`, `profiles`
- Affected roles: Super Admin
- Scenario: an audit-log, family, or actor-profile read fails
- Launch impact: an operator can mistake incomplete history for a complete audit trail
- Root cause: both audit pages discarded Supabase read errors
- Resolution: preserve read errors, log the boundary, and render a refreshable error state before filtering or displaying history
- Tests performed: `tests/admin-audit-read-boundary.test.ts`, `tests/admin-read-boundaries.test.ts`, and `tests/admin-auth-boundary.test.ts` (7 tests); full 422-file/3,086-test suite; typecheck; lint; dependency audit; production build; diff check
- Evidence: focused contracts cover log, family, actor-profile, complete-history, and visible error-state paths
- Remaining dependencies: publish docs and run isolated audit-read failure/browser drills

#### TODO-0298 - Admin reports hid analytics read failures as zero metrics

- Status: `[~]` In progress
- Severity: P1
- Category: Reliability / observability / admin
- Feature: Super Admin reports and analytics
- Route: `/admin/reports`
- File or files: `app/(app)/admin/reports/page.tsx`, `tests/admin-reports-read-boundary.test.ts`
- Database objects: `families`, `profiles`, `subscriptions`, `documents`, `audit_logs`
- Affected roles: Super Admin
- Scenario: a count, trend, subscription, document, or audit-log query fails
- Launch impact: the reports page can otherwise present zero families, users, revenue, activity, or storage as real metrics
- Root cause: eight Supabase result errors were discarded during destructuring
- Resolution: preserve each result error, log the read boundary, and render a refreshable error state before computing metrics
- Tests performed: `tests/admin-reports-read-boundary.test.ts`, `tests/admin-content-read-boundary.test.ts`, and `tests/admin-read-boundaries.test.ts` (5 tests); full 421-file/3,084-test suite; typecheck; lint; dependency audit; production build; diff check
- Evidence: focused contract covers count and activity failures and the visible error state
- Remaining dependencies: publish docs and run isolated analytics read-failure/browser drills

#### TODO-0297 - Admin content page hid Supabase read failures as empty content

- Status: `[~]` In progress
- Severity: P1
- Category: Reliability / private storage / admin
- Feature: Super Admin content management
- Route: `/admin/content`
- File or files: `app/(app)/admin/content/page.tsx`, `tests/admin-content-read-boundary.test.ts`
- Database objects: `documents`, `families`, `profiles`, private `documents` Storage bucket
- Affected roles: Super Admin
- Scenario: documents, family labels, or uploader profiles fail to load
- Launch impact: a storage/database outage can look like an empty content library
- Root cause: all three Supabase read errors were discarded and replaced with empty arrays
- Resolution: aggregate the read errors, log the boundary, and render a refreshable error state before building content metrics
- Tests performed: `tests/admin-content-read-boundary.test.ts`, `tests/admin-users-read-boundary.test.ts`, and `tests/admin-read-boundaries.test.ts` (5 tests); full 420-file/3,083-test suite; typecheck; lint; dependency audit; production build; diff check
- Evidence: focused contract covers all three reads and the visible error state
- Remaining dependencies: publish docs and run an isolated content-read failure/browser drill

#### TODO-0296 - Admin users hid super-admin allowlist read failures

- Status: `[~]` In progress
- Severity: P1
- Category: Reliability / privileged access / admin
- Feature: Super Admin users and access management
- Route: `/admin/users`
- File or files: `app/(app)/admin/users/page.tsx`, `tests/admin-users-read-boundary.test.ts`
- Database objects: `super_admins`
- Affected roles: Super Admin
- Scenario: the `super_admins` query fails while the page renders the database-backed allowlist as empty
- Launch impact: an operator could misread an access-control outage as an empty admin list
- Root cause: the page omitted `superAdminsRes` from its existing Supabase `loadErrors` aggregation
- Resolution: include `super_admins` in the visible error path so the page reports degraded data instead of presenting an empty allowlist as authoritative
- Tests performed: `tests/admin-users-read-boundary.test.ts`, `tests/admin-auth-boundary.test.ts`, and `tests/admin-read-boundaries.test.ts` (6 tests); full 419-file/3,082-test suite; typecheck; lint; dependency audit; production build; diff check
- Evidence: focused contract confirms the `super_admins` result is reported with the other page reads
- Remaining dependencies: publish docs and run a live read-failure/browser drill

#### TODO-0295 - Admin family creation relied on an optional trigger for owner access

- Status: `[~]` In progress
- Severity: P1
- Category: Reliability / tenant provisioning / admin
- Feature: Super Admin user and family management
- Route: `/admin/users`
- File or files: `app/(app)/admin/actions.ts`, `tests/admin-family-create-boundary.test.ts`
- Database objects: `families`, `family_members`, `subscriptions`
- Affected roles: Super Admin; account owners receiving an operator-created family
- Scenario: a family insert succeeds while the owner membership or trial subscription trigger is missing or fails
- Launch impact: the owner can be unable to see the new family while the admin console reports success
- Root cause: the action inserted only the family and assumed `handle_new_family` completed required state
- Resolution: explicitly upsert the parent membership, ensure a trial subscription, surface owner lookup errors, and clean up the new family on required-write failure
- Tests performed: `tests/admin-family-create-boundary.test.ts`, `tests/admin-document-delete-boundary.test.ts`, and `tests/admin-auth-boundary.test.ts` (6 tests); full 418-file/3,081-test suite; typecheck; lint; dependency audit; production build; diff check
- Evidence: focused contract covers trigger-independent membership/subscription reconciliation and rollback
- Remaining dependencies: publish docs, run trigger-disabled family creation/rollback drill, and verify owner visibility in a live browser

#### TODO-0294 - Admin document deletion could orphan private storage objects

- Status: `[~]` In progress
- Severity: P1
- Category: Reliability / private storage / admin
- Feature: Super Admin content management
- Route: `/admin/content`
- File or files: `app/(app)/admin/actions.ts`, `components/admin/document-row-actions.tsx`, `tests/admin-document-delete-boundary.test.ts`
- Database objects: `documents`, private `documents` Storage bucket
- Affected roles: Super Admin; families whose private files are managed by an operator
- Scenario: storage removal fails or the database row is missing during a delete request
- Launch impact: an operator could see a success toast while leaving a private object orphaned, or audit a delete that did not remove a row
- Root cause: the action ignored storage errors, trusted a client path, and did not confirm a returned database row
- Resolution: load the canonical path from the database, stop on storage failure, fail on missing rows, and require a returned row before auditing success
- Tests performed: `tests/admin-document-delete-boundary.test.ts`, `tests/admin-auth-boundary.test.ts`, and `tests/admin-management-action-boundaries.test.ts` (6 tests); full 417-file/3,079-test suite; typecheck; lint; dependency audit; production build; diff check
- Evidence: focused boundary verifies error ordering, canonical path use, missing-row handling, and confirmed delete result
- Remaining dependencies: publish docs, run an isolated storage failure/retry drill, and verify Super Admin browser behavior

#### TODO-0293 - Concurrent protected requests could create duplicate first families

- Status: `[~]` In progress
- Severity: P1
- Category: Reliability / data integrity / authentication
- Feature: First-family provisioning
- Route: `requireUserContext` / `ensureActiveFamily`
- File or files: `lib/server/ensure-family.ts`, `supabase/migrations/0212_atomic_family_provisioning.sql`, `tests/ensure-family-concurrency.test.ts`
- Database objects: `families`, `family_members`, `subscriptions`, `user_preferences`
- Affected roles: newly authenticated account owner
- Scenario: multiple tabs, refreshes, or parallel protected server components provision a first family concurrently
- Launch impact: one account could receive multiple household spaces and split later family data
- Root cause: the membership check and first-family writes were separate service-role statements without a per-user lock
- Required remediation: use a service-only transaction-scoped advisory lock around the membership check and initial family writes
- Resolution: added `ensure_family_for_user` in migration `0212`; `ensureActiveFamily` calls the locked RPC first and retains a compatibility path for rolling deployments
- Tests performed: `tests/ensure-family-concurrency.test.ts` and `tests/onboarding-idempotency.test.ts` (5 tests); typecheck; migration audit; diff check
- Evidence: migration audit reports 228 numbered SQL files and next version `0213`; local concurrency contract is green
- Remaining dependencies: apply `0212`, run an isolated two-request first-login drill, and confirm one active family plus one active-family preference

#### TODO-0282 â€” Onboarding replay can duplicate household records

#### TODO-0282 — Onboarding replay can duplicate household records

- Status: `[~]` In progress
- Severity: P1
- Category: Reliability / data integrity / onboarding
- Feature: Guided onboarding finalization
- Route: `/onboarding`
- File or files: `app/onboarding/actions.ts`, `lib/onboarding/idempotency.ts`, `supabase/migrations/0210_onboarding_idempotency.sql`
- Database objects: `family_members`, `invites`, `calendar_events`, `onboarding_imports`
- Affected roles: New account owner; family administrators
- Affected accounts: Any account whose finalization request is retried after a partial required write or during a duplicate submit
- Description: Finalization resumed an in-progress wizard but used blind inserts for managed members, invitations, imported calendar events, and the import marker. A retry could create duplicate household data and duplicate invite delivery.
- User impact: Repeated submissions could show duplicate people/events and send repeated join emails.
- Security or privacy impact: Duplicate invitations increase unintended notification exposure; family scope remains server-side but integrity is compromised.
- Root cause: No stable submission/item key or database uniqueness boundary existed for the multi-table finalization pipeline.
- Required remediation: Derive a stable server-side key from the authenticated user and normalized wizard payload; add nullable unique idempotency columns; upsert keyed rows; send an invite email only when the invite row is newly created.
- Dependencies: Migration `0210_onboarding_idempotency.sql` must be applied before the repaired action is deployed.
- Implementation notes: Keep legacy rows valid with nullable keys; use deterministic item keys so partial retries reconcile already-written rows.
- Test plan: Static regression test must assert key derivation, keyed upserts, conflict targets, and no blind finalization inserts; focused tests and full suite must pass.
- Tests performed: `tests/onboarding-failure-safety.test.ts`, `tests/onboarding-idempotency.test.ts`, and `tests/migration-version-safety.test.ts` (8 tests); full Vitest (406 files, 3,033 tests); typecheck; lint; dependency audit; production build; migration audit; diff check.
- Evidence: `onboardingRunKey` and `onboardingItemKey` are stable/different by user, row, and kind; finalization uses keyed upserts and the family claim uses a per-user advisory lock; migration audit reports 226 numbered SQL files and next version `0211`.
- Resolution: Added `lib/onboarding/idempotency.ts`, migration `0210_onboarding_idempotency.sql`, generated type fields, keyed member/invite/calendar/import upserts, duplicate-email suppression for replayed invites, and typed `onboarding_claim_family` first-family serialization.
- Verified by: Codex local validation; commit `0d9cb4d5`; remote migration application remains required for launch closure.
- Date completed: 2026-07-15 (code repair verified locally; issue remains open for deployment evidence)

#### TODO-0283 - Guardian emergency escalation could replay calls and miss parent phone mapping

- Status: `[~]` In progress
- Severity: P1
- Category: Security / notification reliability / Guardian
- Feature: Emergency escalation
- Route: `/api/guardian/escalate`
- File or files: `app/api/guardian/escalate/route.ts`, `lib/guardian/escalation.ts`, `lib/guardian/callbacks.ts`, `tests/guardian-escalation-replay.test.ts`
- Database objects: `guardian_callback_events`, `guardian_escalations`, `family_members`, `profiles`
- Affected roles: family parents/managers; Guardian system
- Scenario: repeated internal escalation or a critical event that needs parent SMS/call delivery
- Launch impact: duplicate SMS/calls or no parent notification
- Root cause: no durable claim before telephony and the phone lookup used membership IDs instead of `family_members.user_id` profile IDs
- Required remediation: validate the bounded payload, derive a deterministic event key, claim the service-only callback ledger before side effects, resolve phones through `user_id`, and preserve retryable callback errors
- Supabase impact: reuses migration `0181_guardian_callback_replay.sql`; no new migration
- Tests performed: `tests/guardian-escalation-replay.test.ts`, `tests/guardian-callback-security.test.ts` (11 tests); typecheck; diff check
- Resolution: strict Zod schema, communication-aware event identity, durable claim/error/processed lifecycle, and correct parent profile mapping
- Verified by: Codex local validation; publication commit recorded in `docs/PRODUCT_LAUNCH_AUDIT.md`
- Remaining dependencies: live Twilio callback, provider failure/retry, role/privacy, and RLS smoke tests

#### TODO-0284 - Family membership RLS allowed self-promotion and family reassignment

- Status: `[~]` In progress
- Severity: P0
- Category: Security / tenant isolation / RLS
- Feature: Family membership and role administration
- Route: `/family/members`, `/family/permissions`, authenticated Supabase writes
- File or files: `supabase/migrations/0118_rls_drift_repair.sql`, `supabase/migrations/0211_family_members_update_rls.sql`, `tests/tenant-isolation-rls.test.ts`
- Database objects: `family_members`, `is_family_member`, `can_manage_family`
- Affected roles: any authenticated family member; parent/manager administrators
- Scenario: a non-manager sends a direct `family_members` UPDATE changing their role, active state, or family ID
- Launch impact: a member could promote themselves or mutate tenant membership, invalidating all downstream RLS assumptions
- Root cause: migration `0118` reintroduced `using (can_manage_family(...) or user_id = auth.uid())` without a manager-only check constraint for updates
- Required remediation: reassert manager-only `USING` and `WITH CHECK` policies in the next migration; keep self-profile and child-login updates behind authenticated server-side service-role flows
- Supabase impact: migration `0211_family_members_update_rls.sql` changes policy only; no data mutation
- Tests performed: `tests/tenant-isolation-rls.test.ts`, `tests/migration-version-safety.test.ts`, `tests/admin-auth-boundary.test.ts`, `tests/account-action-error-boundaries.test.ts` (9 tests); typecheck; migration audit; diff check
- Resolution: added migration `0211` and static contract coverage proving the self-update exception is absent and ordinary account actions have no direct membership update path
- Verified by: Codex local validation; remote migration application and two-tenant role/RLS probes remain required
- Remaining dependencies: apply `0211`, run authenticated member/manager cross-tenant allow/deny tests, and verify profile/child-login workflows in isolation

#### TODO-0285 - Admin notification failures were silent to operators

- Status: `[~]` In progress
- Severity: P1
- Category: Reliability / observability / admin operations
- Feature: Super Admin Notification Center
- Route: `/admin/notifications`, global admin notification bell
- File or files: `lib/admin/notify.ts`, `app/(app)/admin/notifications-actions.ts`, `components/admin/admin-notifications-list.tsx`, `components/admin/admin-notification-bell.tsx`, `tests/admin-notification-boundary.test.ts`
- Database objects: `admin_notifications`
- Affected roles: Super Admin and the server-side feedback/support/marketplace/onboarding/Stripe producers
- Scenario: an admin notification insert or mark-read update returns a Supabase error
- Launch impact: important operational alerts could disappear without diagnostics, or an operator could believe a read mutation succeeded when it did not
- Root cause: notification insert awaited the query but ignored its returned `error`; client handlers refreshed unconditionally without inspecting the action result
- Required remediation: log returned Supabase insert errors while retaining best-effort producer behavior, and surface sanitized mutation failures without refreshing stale UI as if the action succeeded
- Supabase impact: no schema change; uses existing service-role-only `admin_notifications` table
- Tests performed: `tests/admin-notification-boundary.test.ts`, `tests/admin-notifications.test.ts` (12 tests); typecheck; diff check
- Resolution: checked and logged insert errors; added visible `role=alert` error states to history and bell mark-read flows; refresh occurs only after a successful server action
- Verified by: Codex local validation; 409-file/3,045-test suite, lint, typecheck, audit, migration audit, diff check, schema probes, and 250-route production build pass
- Remaining dependencies: live Super Admin authorization, failure injection, alert routing, and operator/browser workflow verification

#### TODO-0286 - Connections hub reported label-only integrations as live

- Status: `[~]` In progress
- Severity: P1
- Category: Integrations / user trust / data integrity
- Feature: Family Connections hub
- Route: `/dashboard/connections`
- File or files: `components/modules/connections-module.tsx`, `lib/connections/providers.ts`, `tests/connections-providers.test.ts`, `tests/connections-ui-boundary.test.ts`
- Database objects: `family_connections`, `sync_accounts`, `sync_tokens`
- Affected roles: authenticated family members
- Scenario: a member clicked Connect for a provider without an OAuth or sync implementation
- Launch impact: the UI wrote a `family_connections` row and showed Connected even though no credentials, sync account, or data flow existed
- Root cause: the module treated a typed account label as a successful integration and never routed through the real provider setup surface
- Required remediation: route only implemented Google, Microsoft, and Apple providers through their secure sync setup pages; show unsupported providers as unavailable instead of persisting false success
- Supabase impact: no schema change; prevents new false-positive `family_connections` rows and preserves real family-scoped disconnect behavior
- Tests performed: `tests/connections-providers.test.ts`, `tests/connections-adapter.test.ts`, and `tests/connections-ui-boundary.test.ts` (23 tests); typecheck; lint; diff check
- Resolution: added explicit live sync-provider metadata, routed implemented providers to `/dashboard/sync/accounts/*`, removed label-only upsert/modal behavior, and made unsupported providers visibly unavailable
- Verified by: Codex local validation; 410-file/3,048-test suite, lint, typecheck, dependency audit, migration audit, diff check, and 250-route production build pass
- Remaining dependencies: implement and expose Gmail, banking, grocery, and smart-home provider flows before advertising them as connectable

#### TODO-0287 - Admin digest cron hid feed and delivery failures

- Status: `[~]` In progress
- Severity: P1
- Category: Notifications / cron / observability
- Feature: Daily Super Admin digest
- Route: `/api/cron/admin-digest`
- File or files: `app/api/cron/admin-digest/route.ts`, `lib/admin/digest.ts`, `tests/admin-digest.test.ts`
- Database objects: `admin_notifications`, `super_admins`
- Affected roles: Super Admin recipients and operations owners
- Scenario: the notification feed query fails, Resend is disabled, or one recipient delivery fails
- Launch impact: a cron run could report a quiet day when the feed was unavailable, count skipped emails as sent, or return success after partial delivery failure
- Root cause: the route ignored the Supabase query error and reduced `sendEmail` results to a boolean success count
- Required remediation: fail closed on feed errors and return explicit sent/skipped/failed counts with a non-2xx status on recipient failure
- Supabase impact: no schema change; read failures now remain visible to cron monitoring
- Tests performed: `tests/admin-digest.test.ts`, `tests/cron-auth.test.ts`, and `tests/admin-notification-boundary.test.ts` (20 tests); typecheck; lint; diff check
- Resolution: added feed-error handling, delivery summarization, skipped-provider accounting, and 502 responses for partial delivery failures
- Verified by: Codex local validation; 411-file/3,061-test suite, lint, typecheck, dependency audit, migration audit, diff check, and 250-route production build pass
- Remaining dependencies: live cron invocation, Resend sandbox delivery, alert routing, and remote deployment verification

## Current Coverage Matrices

These matrices are intentionally conservative: `Verified` means the specific boundary has local
test evidence and is not a claim that the entire service is launch-complete. The detailed companion
matrices remain authoritative and are updated with each increment.

### Route and feature matrix

| Route family | Feature | Audience | Auth/role boundary | Supabase objects | Current status | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `/login`, `/signup`, middleware | Authentication and redirects | anonymous, authenticated | session and route guards | `auth.users`, profiles, family membership | In progress | `tests/admin-auth-boundary.test.ts`, `tests/tenant-isolation-rls.test.ts`; live Auth Admin/RLS open |
| `/onboarding`, `/join` | Family provisioning and invitations | new owner, invited user | authenticated owner/manager | families, family_members, invites, onboarding_progress | In progress | `tests/onboarding-failure-safety.test.ts`, `tests/onboarding-idempotency.test.ts` |
| `/dashboard/*` | Family operating surfaces | family roles | active-family context | family-scoped domain tables | In progress | route inventory and feature tests; page-by-page traversal open |
| `/wallet/*`, `/dashboard/payments` | Money movement | parent/guardian/child | manager RPCs and entitlements | wallet ledger, goals, allowances, subscriptions | In progress | atomic wallet tests; remote migrations and live concurrency open |
| `/admin/*` | Site administration | Super Admin/support | explicit privileged server guards | admin/content/marketing tables | In progress | 38 service-role action guard scan; live role matrix open |
| `/api/webhooks/*`, `/api/cron/*` | Integrations and jobs | providers/system | signature/cron secrets | webhook ledgers and integration tables | In progress | provider contract tests; live callback and retry smoke open |

### Supabase table matrix

| Table group | Purpose | Application usage | RLS reviewed | CRUD/RLS test status | Index review | Status |
| --- | --- | --- | --- | --- | --- | --- |
| families and family_members | household tenant boundary | dashboard/onboarding/auth | source reviewed | live cross-tenant denial pending | family/user indexes present | In progress |
| invites and onboarding_progress | invite lifecycle and onboarding state | `/join`, `/onboarding`, admin analytics | source reviewed | replay contract local; live role tests pending | email/family and user unique indexes present | In progress |
| calendar_events and onboarding_imports | imported household schedule | onboarding/calendar | source reviewed | keyed replay local; live RLS pending | family/time plus onboarding keys | In progress |
| wallet, billing, marketplace | financial and commerce state | wallet/billing/marketplace | RPC/RLS repairs present | local contracts; live concurrency pending | atomic RPC indexes reviewed | In progress |
| files, media, provider sync | private assets and integrations | uploads/sync | source reviewed | storage and provider live tests pending | bucket/path review pending | In progress |

### Supabase function matrix

| Function class | Called by | Authorization | Input validation | Return/error status | Tests |
| --- | --- | --- | --- | --- | --- |
| manager-checked wallet RPCs | wallet server actions | `can_manage_family` and row locks | server payload schemas | structured outcomes | focused atomic tests; live deployment pending |
| onboarding keyed writes | onboarding server action | authenticated service-role server path | Zod + deterministic keys | sanitized action failures | 8 focused tests; live migration pending |
| provider/webhook claim RPCs | callbacks and cron | signature/secret plus service-only grants | bounded payloads | retry-safe contracts | focused tests; provider sandbox pending |

### Storage matrix

| Bucket class | Purpose | Visibility | Policy/file validation | Cross-user test | Status |
| --- | --- | --- | --- | --- | --- |
| family media/documents | household uploads | private/signed where applicable | family policy and bounded upload paths | live isolated test pending | In progress |
| marketplace/media | listing and social media | policy-dependent | ownership checks and cleanup | live isolated test pending | In progress |

### Account and role matrix

| Account/role | Tenant scope | Login/navigation | CRUD | Isolation/entitlements | Mobile | Status |
| --- | --- | --- | --- | --- | --- | --- |
| anonymous | none/public | public routes and login redirect | public-only | public data only | baseline E2E | Partial |
| parent/owner | one active family | authenticated dashboard | manager workflows | live RLS probe pending | baseline only | In progress |
| adult/guardian/member | invited family | role-filtered navigation | scoped workflows | live cross-role probe pending | baseline only | In progress |
| child/teen | assigned family member | child surfaces/PIN | limited submit/read | live escalation probe pending | baseline only | In progress |
| Super Admin/support | cross-family operational | `/admin/*` | privileged admin actions | guard scan local; live role test pending | baseline only | In progress |

### Integration matrix

| Integration | Environment | Authentication | Webhook/callback | Failure/retry/idempotency | Production status |
| --- | --- | --- | --- | --- | --- |
| Supabase Auth/DB/Storage | local config + live project | session/service role | Auth callbacks | local contracts; live ledger/RLS pending | Blocked |
| Stripe | configured by env | signed webhooks | billing and money endpoints | focused claim tests; sandbox pending | In progress |
| Google/Microsoft sync | optional env | OAuth state + encrypted tokens | callback routes | focused OAuth tests; provider sandbox pending | In progress |
| Resend/Twilio/push | optional env | provider signatures/secrets | webhooks/callbacks | bounded/idempotent contracts; live rotation pending | In progress |

**Goal:** Ship every roadmap feature below at **100% fully developed** and **100% wired to
Supabase** (real family-scoped tables + RLS, no mock data). This file is the single source of
truth for the build — work top to bottom, keep it in sync, and don't mark a feature `DONE`
until every box under it is checked.

Companion docs: `docs/FRICTION_BACKLOG.md` (what to fix next) and
`docs/EXPERIENCE_SCORECARD.md` (journey health).

**Definition of "done" per feature (the checklist each one must pass):**
- [ ] **Schema** — additive, idempotent migration with family-scoped RLS via `public.is_family_member`, validated on PG16.
- [ ] **Types** — hand-maintained rows added to `lib/database.types.ts` (`T<Row,Insert,Update>`).
- [ ] **Server lib** — pure/tested logic + Supabase reads/writes (no mock data anywhere in the path).
- [ ] **UI module** — production component, optimistic where sensible, undo/confirm on destructive.
- [ ] **Route** — `app/(app)/dashboard/<feature>/page.tsx` using `requireUserContext()`.
- [ ] **Nav** — entry in `lib/constants/navigation.ts` + Navigation Choices catalog.
- [ ] **Verified** — `tsc`, `eslint`, `vitest`, `next build` all green.

> **SEED CONVENTION (2026-07-14):** `supabase/SEED_ALL.sql` is **FROZEN** — do not
> append to it. Each feature's seed goes in its own standalone `supabase/seed_<feature>.sql`
> file, **≤ 1000 lines**, as a self-contained idempotent DO-block (resolve the anchored
> family by email, delete own marker rows, re-insert). The five most recent seed sets are
> bundled in `supabase/seed_recent_updates.sql`.

Legend: ☐ open · ◐ partial (scaffolding exists) · ☑ done

---

## ☑ SERVICE CATALOG TOOLTIPS — hover blurbs, super-admin editable (SHIPPED 2026-07-14)

The **"All Services"** picker now shows a **hover/focus tooltip** describing what each of the ~115
services offers. Copy defaults are versioned in code (`lib/services/descriptions.ts` — a crisp
one-liner for every catalog service, coverage enforced by test) and a **super admin can override any
of them at `/admin/services`** (grouped, searchable editor with live dirty-state, per-row Save/Reset,
"Custom" badges). 100% Supabase-wired: **`0203_service_descriptions.sql`** stores overrides keyed by
nav route (world-readable RLS, service-role writes); saves go through a super-admin-guarded server
action; empty/unchanged values delete the row so it falls back to the default (lean table, trivial
reset). Tooltips render **instantly** from the bundled defaults and lazily overlay overrides fetched
once from public **`/api/services/descriptions`** (module-memoized). The tooltip is a single
fixed-position portal card so it never clips inside the modal's scroll container; keyboard-accessible.
`ServiceCatalog` added to the admin nav. Pure helpers tested (9); 2900 tests + `next build` green;
migration PG16-verified idempotent ×2. ⚠️ apply `0203` to prod (see `docs/PENDING_PROD_MIGRATIONS.md`).

---

## ☑ BLOG OVERHAUL — world-class articles + engagement (SHIPPED 2026-07-14)

Every `/blog` cover-story stub is now a **complete, fun, fully-written article** — 20 posts
total (9 stubs fleshed out in place + 11 new), 3–4 per category across all 6 categories, each
with a **topic-matched free-license Unsplash hero photo** (every URL verified live AND visually
confirmed via a rendered contact sheet before assignment). Engagement is real and 100%
Supabase-wired: **♥ likes** (anonymous per-visitor via the durable `bubaly_vid` id, optimistic
UI with a pop animation, one-per-post enforced by a DB unique constraint) and **email
subscriptions** (sidebar card + footer inline + end-of-article CTA; honeypot + IP rate limit +
strict normalization; unsubscribe token + one-click `/api/blog/unsubscribe` closes the consent
loop). Migrations **`0201_blog_engagement.sql`** (hero-image columns + `blog_post_likes` +
`blog_subscribers`, service-role-only RLS) + **`0202_blog_articles.sql`** (idempotent content
upsert by slug) — both PG16-verified idempotent ×2. Routes `/api/blog/like|subscribe|unsubscribe`
follow the house pattern (service client, `enforceRequestRateLimit`, bounded JSON). Pages
redesigned around real photography (`next/image` + `images.unsplash.com` remote pattern, OG
images per article, credit lines, dead Load-More/subscribe stubs removed). Pure rules in
`lib/blog/engagement.ts` (**9 tests**); 2779 tests + `next build` (228 pages) green.
⚠️ apply `0201` + `0202` to prod (see `docs/PENDING_PROD_MIGRATIONS.md`).

---

## 🔒 SECURITY AUDIT — status & remaining items (2026-07-10) — READ FIRST

A dedicated adversarial audit ran over Marketplace, Payments/Stripe, Auth/OAuth, and AI/concierge.
**All identified items are now fixed** (Marketplace authz + PAY-1/PAY-2 in round 1; AUTH-1, PAY-3,
AI-1, PAY-4/5, AI-2 in round 2 — this session). The only remaining action is human-owned: **apply the
coupled migrations `0154`/`0155`/`0156` to prod with the deploy.** **Do not** re-audit from scratch.

**✅ Fixed & merged**
- **Marketplace object-level authz** (SEC-1/SEC-2/REL-1/REL-3/RACE-1/RACE-2, A11Y, img) — PR #281 →
  migration **`0154_marketplace_ownership.sql`** (per-member RLS + ownership-checked RPCs + offer
  hold trigger + unique open-offer index). Item-detail offer inbox #283.
- **PAY-1 — card-authorization overspend** (concurrent auths approved against the same balance).
  Fixed: atomic `wallet_reserve_card_auth` RPC (per-child lock + sufficient-funds check + `processing`
  hold keyed by auth id) → migration **`0155_wallet_auth_holds.sql`**; holds released on capture /
  reversal in `lib/stripe/webhook.ts`. PG16-verified (2nd concurrent auth declined; capture reconciles).
- **PAY-2 — dropped financial events**: money webhook recorded events *before* handling then 200'd on
  error, so a failed capture was never retried. Now `recordEvent` is replay-safe (processing→processed;
  errored/unfinished events reprocessable) and the route returns 500 on handler error so Stripe retries.

**⚠️ Coupled prod migrations — apply with the deployed code** (see `docs/PENDING_PROD_MIGRATIONS.md`):
`0154_marketplace_ownership.sql`, `0155_wallet_auth_holds.sql`, **and `0156_rate_limits.sql`**. Until
applied: marketplace owner accept/withdraw/complete error, card auth holds don't reserve, and the
guarded rate-limited operations fail closed with a short retry response rather than bypassing the durable limit.

**✅ Fixed & merged — round 2 (2026-07-10, this session)** — all remaining audit items closed:
- **AUTH-1 (High)** ✅ — Google Calendar OAuth is now CSRF-safe: `auth/route.ts` issues a random,
  single-use, opaque `state` in an **httpOnly cookie**; `callback/route.ts` verifies `state` against
  the cookie (constant-time) and derives the connected user from the **session** (`getUser()`), never
  from `state`. Closes the calendar-link hijack. (`app/api/google/calendar/auth|callback/route.ts`.)
- **PAY-3 (Med)** ✅ — `app/api/billing/checkout/route.ts` now gates on `isAdmin(ctx.active.role)`
  (only a parent can start a subscription), matching change-plan/cancel.
- **AI-1 (Med)** ✅ — the scam classifier (`lib/guardian/scam-ai.ts`) is prompt-injection-hardened:
  instructions live in the **system** role; untrusted transcript + family context are wrapped in a
  **random-nonce fence** the model is told to treat strictly as data (injection attempts = a scam
  signal, never commands); output is **strictly validated** against known enums so the model can never
  emit an off-list recommendation/scamType/confidence — it only informs the pipeline. `ai-screen.ts`
  got the same defense-in-depth rule. Test `tests/guardian-scam-ai.test.ts` (6) proves the validator.
- **PAY-4 (Low)** ✅ — `/api/webhooks/stripe` (subscription webhook) now dedups by Stripe event id via
  the replay-safe `recordEvent`/`markEventProcessed`/`markEventError` store (reused from PAY-2), and
  returns 500 on handler error so Stripe retries instead of silently dropping. (`markReferralConverted`
  was already idempotent — only acts on `status = 'signed_up'`.)
- **PAY-5 (Low)** ✅ — billing success/return URLs now build from the trusted `NEXT_PUBLIC_APP_URL`
  first, not the caller-controlled `Origin` header (checkout, change-plan, portal).
- **AI-2 (Low)** ✅ — durable, cross-instance rate limiting: **`0156_rate_limits.sql`**
  (`rate_limits` + `rate_limit_hit()` RPC) + `lib/server/rate-limit-db.ts` (fail-closed by default), wired into
  `/api/ai/gift` alongside the per-instance in-memory gate. PG16-verified.
- Verified: tsc · eslint · **vitest (56 existing + 6 new)** · `next build` (218 pages); `0156`
  applied twice on PG16 (idempotent) and exercised.

- Full report + evidence: see session notes. No cross-tenant (cross-family) breach was found; RLS
  isolates families. External AI `fetch`es all target fixed provider hosts (no SSRF).

**Release posture:** card-spend/Issuing safe to ship once `0155` is applied; **AUTH-1 is fixed**, so
Google Calendar linking is safe to expose. Apply `0154`/`0155`/`0156` with the deploy.

---

## 👤 VISITOR INTELLIGENCE / LEAD CAPTURE — coverage matrix (2026-07-11)

Audited the "privacy-first visitor intelligence + lead capture" brief against the codebase. **Most of
it already exists**; the one central gap (consent) is now closed. Honest status below — **not** a
17-phase greenfield build. Pick up the ☐ items directly; don't rebuild the ☑ ones.

| Capability | Status | Where |
|---|---|---|
| Anonymous visitor spine (CDP) | ☑ exists | `mkt_visitors` (0058) + `/api/mkt/track` |
| Session + attribution (source/medium/campaign/landing) | ☑ exists | `mkt_sessions`, `mkt_touchpoints` (0058) |
| Multi-touch + conversion attribution | ☑ exists | `mkt_touchpoints.kind` |
| CRM / marketing contacts | ☑ exists | `crm_contacts`, `crm_deals`, marketing_* |
| Lead capture forms + submissions | ☑ exists | `marketing_forms`, `marketing_form_submissions`, `/api/forms/submit` |
| Segments / suppressions | ☑ exists | `marketing_segments`, `marketing_suppressions` |
| Exit-intent | ☑ exists | `marketing_exit_intent`, `components/marketing/exit-intent.tsx`, `/api/exit-intent/*` |
| Personalization rules | ☑ exists | `marketing_personalization_rules`, `lib/marketing/personalization.ts` |
| A/B experiments | ☑ exists | `ab_experiments`, `ab_events`, `lib/marketing/ab.ts`, `/api/ab/track` |
| Admin marketing intelligence page | ☑ **NEW** | `/admin/marketing/intelligence` + a dedicated **`/admin/marketing/visitor-intelligence`** funnel dashboard (visitors → identified → profiled → scored → hot/qualified) with consent posture + lead-band distribution; `lib/marketing/visitor-funnel.ts` (6 tests) |
| **Granular consent (necessary/analytics/personalization/marketing) + GPC + revocation** | ☑ **NEW** | `mkt_consent_events` (0160), `lib/marketing/consent.ts`, `/api/mkt/consent` |
| **Consent-gated tracking** | ☑ **NEW** | `/api/mkt/track` gates on analytics consent |
| Identity linking (anon → contact) | ☑ **NEW** | `lib/marketing/identity.ts` — on signup/login stitches `mkt_visitors.contact_id` → `crm_contacts` (dedup by email, non-downgrading), carries consent forward (`mkt_consent_events.contact_id`), forks on shared-device 2nd user (rotates anon id). Hooked from login/signup forms + `auth/callback`. 6 tests (`identity-stitch.test.ts`) |
| Progressive profiling UI | ☑ **NEW** | `crm_contact_profile` (0171) + `lib/marketing/progressive-profile.ts` (one-question-at-a-time engine, 10 tests) + `ProfileNudge` card on `/dashboard/settings`; saves role/priority/household/kids/interests, remembers skips |
| Consent banner / preference-center UI | ☑ **NEW** | `components/marketing/consent-manager.tsx` — banner (Accept all / Reject / Manage) + granular preference center wired to `/api/mkt/consent`; anon-id + GPC + local cache in `lib/marketing/visitor.ts`; fires the analytics touch to `/api/mkt/track`; re-openable from the footer |
| **Client visitor spine (anon-id + first-party touch)** | ☑ **NEW** | `lib/marketing/visitor.ts` — durable `bubaly_vid` cookie/localStorage; GPC detect; one consent-gated `/api/mkt/track` touch per session (was: endpoints had no client caller) |
| Lead scoring | ☑ **NEW** | `crm_lead_scores` (0172) + `lib/marketing/contact-score.ts` (0–100 score + itemized ledger, 7 tests) + `contact-score-compute.ts` (gathers sessions/recency/conversions/demo/consent/profile/lifecycle); admin `/admin/marketing/lead-scores` — ranked, expandable "why" ledger, Recompute |
| Abandoned-journey recovery | ☑ **NEW** | beyond checkout: `/api/cron/journey-recovery` sweeps stalled onboarding (`onboarding_abandoned`) + non-converting demo leads (`demo_abandoned`) and fires the follow-up workflow; `lib/marketing/journey-recovery.ts` (windowed selection, 8 tests) + 2 new automation triggers/copy |

**☐ Next (privacy-safe, priority order)**
- ☑ **DONE (2026-07-12)** — Client **consent banner + preference center** (`consent-manager.tsx` +
  `visitor.ts`) calling `/api/mkt/consent`, feeding the resolved analytics flag + GPC to
  `/api/mkt/track`. Marketing never pre-checked; GPC honored silently; 6 tests (`consent-ui.test.ts`).
- ☑ **DONE (2026-07-12)** — Identity stitch on signup/login (`lib/marketing/identity.ts`): sets
  `mkt_visitors.contact_id`, carries consent forward (`mkt_consent_events.contact_id`), dedupes the
  contact by email (non-downgrading), and **forks** (rotates the anon id) rather than merge a second
  person on a shared device. Hooked from the login/signup forms + `auth/callback` (covers password /
  OAuth / magic-link / email-confirm). 6 tests.
- ☑ **DONE (2026-07-12)** — Progressive-profiling capture, one field at a time (`crm_contact_profile`
  0171 + `progressive-profile.ts` engine + `ProfileNudge` on `/dashboard/settings`). ⚠️ apply `0171`.
- ☑ **DONE (2026-07-12)** — Dedicated **`/admin/marketing/visitor-intelligence`** funnel dashboard
  (acquisition funnel + consent posture + lead-score bands), `visitor-funnel.ts` engine (6 tests).
  **The visitor-intelligence / lead-capture lane is now fully ☑.**

**Privacy invariants (already enforced — keep them):** no fingerprinting; no PII from anonymous
visitors; `necessary` always on + non-revocable; `analytics` = first-party legitimate interest (on
until denied/GPC); `personalization`+`marketing_*` strict opt-in; consent is append-only, timestamped,
versioned, revocable (`mkt_consent_events`). **⚠️ Apply `0160_visitor_consent.sql` to prod with the deploy.**

**☑ NEW (2026-07-11) — Demo email gate + upgrade exit (lead capture on the demo):** the one-click
**Test Account** demo now opens behind a **blurred email-capture pop-up**; the 5-minute clock only
starts once the visitor enters an email (stamped on `demo_sessions.email` — an identified-lead
signal). When the clock runs out the app blurs again behind an **upgrade pop-up** (Free 5-day /
Family Basic / Family+ → routes into signup). Files: `components/demo/demo-experience.tsx`,
`app/(marketing)/demo/actions.ts` (`startDemoClockAction`, `choosePlanAfterDemoAction`),
`lib/demo/session.ts` (deferred clock + abandoned-session reaping). **⚠️ Apply
`0161_demo_session_email_gate.sql` to prod with the deploy** (nullable `expires_at` + `email`).
Follow-up (◐): stitch the captured demo email into `crm_contacts` / `mkt_visitors` for real lead flow.

**☑ NEW (2026-07-11) — Demo is now ONE shared "Bubaly Demo" account (supersedes the throwaway-user
model above).** Owner directive: *"a Single Demo User, no other Demo Users, called Bubaly Demo; use
all the seed data for this single account."* Implemented (commits `f942a28`, `4139d89`, `e9dbebc`,
`dc02676` on `main`):
- **Single account, not per-visitor users.** `lib/demo/session.ts` rewritten: `ensureDemoAccount()`
  get-or-creates exactly **one** auth user `demo@demo.bubaly.app` (`full_name`/family name = **"Bubaly
  Demo"**), found by the stable family name so it's **reused, never duplicated**. Family+ subscription +
  owning member + active-family pref set on first run only. **No new migration** — reuses the existing
  `demo_sessions` schema (`0138` + `0161`).
- **Fresh every login.** `resetDemoData()` wipes the seed-scoped tables (`SEED_TABLES`, children-first)
  and re-seeds via `seedDemoFamily()` on each `startDemoAction`, so every visitor lands on a pristine,
  fully-seeded demo (self-heals the shared account).
- **Seed expanded to ~200 rows.** `lib/demo/seed.ts` now populates every Family+ surface (calendar 24 ·
  transactions 24 · bills 12 · reminders 14 · pantry 20 · goals 10 · documents 10 · maintenance 8 ·
  family_facts 12 · budgets/accounts · meals+plans+votes · groceries · chores · polls · marketplace
  listings+saves+reviews · autopilot/approvals/agent activity). Column choices mirror the PG16-validated
  `seed_demo_account.sql`; every insert best-effort (schema-drift safe). *(Previously the one-click demo
  seeded only ~30 rows → empty Home. Fixed.)*
- **No teardown.** `endDemoSession()` no longer deletes anything — it only clears the `demo_sessions`
  row (`expires_at`/`email` → null) so the next visitor gets a fresh email gate; the cron
  (`/api/cron/demo-cleanup` → `cleanupExpiredDemoSessions`) does the same for expired clocks. Sign-in
  rotates a random password per login with a one-shot retry (`rotateDemoPassword`) to absorb a
  concurrent-login race — **no stored secret**.
- **Email gate + 5-min countdown + upgrade pop-up (#292) unchanged.** Trade-off (by design): concurrent
  visitors share the one account's live data between re-seeds; the old per-tester isolation is gone.
- **Pricing card** (`app/(marketing)/pricing/pricing-content.tsx`): renamed **"Test Account" →
  "Demo Account"**, dropped the inaccurate **"No email"** copy → *"No card needed — logs you straight
  into full Family+."*, and **floated the card to the LEFT of the hero title** (single 3-col grid
  `[card | hero+toggle | spacer]`, card vertically centered; stacks on mobile).
- **Docs:** `docs/demo-mode.md` rewritten to describe the single-account model.
- ⚠️ **Left-over cleanup (owner, optional):** old ephemeral `demo-<token>@demo.bubaly.app` auth users
  from the previous model may still linger in Supabase Auth — harmless, bulk-deletable.
- ⚠️ **Coordination note for other bots:** a parallel session has an **unmerged branch** reworking the
  pricing hero layout (`pricing-content.tsx`). If it lands it will likely conflict with `dc02676` on
  that file — reconcile carefully (keep the "Demo Account" copy + card-left-of-hero layout).

**☑ NEW (2026-07-11) — Demo DEEP DIVE: seed expanded to ~350 rows + two silent-empty surfaces fixed
(`claude/demo-deepdive`).** Turned over every rock in the Bubaly demo. Findings + fixes:
- **BUG (fixed): Tasks + Groceries surfaces were silently EMPTY.** `todo_items`/`grocery_items` require
  a parent list (`list_id NOT NULL`) that the seed never created, so every best-effort insert failed
  silently → two empty modules for every demo visitor. Now seed a parent `todo_lists` / `grocery_lists`
  first and stamp `list_id`; `todo_lists.created_by` correctly targets `family_members.id` (not
  `auth.users`) via the owning member.
- **Coverage went from ~30 → ~52 tables (~350 rows).** Added health (medications · appointments ·
  health_visits · immunizations), kids/school (homework · classes · teams · wishlist · screen_time ·
  journal), home (pets · vehicles · home_warranties), trips (vacations · trips), relationship_dates,
  notes, reminder_lists, and family economy (currency + rewards). Every table/column verified against
  `lib/database.types.ts`; enums validated on PG16 so no more silent drift.
- `SEED_TABLES` (`lib/demo/session.ts`) rewritten in strict child-before-parent delete order so the
  per-login reset wipes the new tables cleanly (items before lists, rewards before currency).
- Now a demo visitor can exercise **the whole platform**, not a third of it. tsc clean.

**☑ NEW (2026-07-11) — Payment is now ONE TAP from the demo (account creation + payment super easy).**
The demo→upgrade→signup→billing path used to **drop the plan the visitor already chose**: picking
"Family+" in the end-of-demo pop-up sent them to `/dashboard/billing?view=manage` where they had to
re-find and click the plan. Now the choice is carried the whole way and checkout opens automatically:
- `choosePlanAfterDemoAction` builds `redirect=/dashboard/billing?view=manage&checkout=<plan>` (was
  just `view=manage`), so the plan survives signup (works across email · phone · Google · Apple — the
  signup form + `/auth/callback` both honor `next`/`redirect` verbatim).
- `BillingModule` reads `?checkout=basic|plus`: once the auto-provisioned family + subscription load and
  the family is still on Free, it fires `changePlan(<tier>_monthly)` **once** (admin-only) → Stripe
  Checkout opens straight away. New accounts get a family auto-provisioned by `requireUserContext`, so
  the order signup→billing→Stripe just works. Falls back to a highlighted, scrolled-to plan card if
  auto-checkout can't run (non-admin / already subscribed). tsc + eslint clean.

**☑ NEW (2026-07-11) — Demo deep-dive pass 2: five more surfaces that read live tables but had no seed.**
Found by cross-referencing every module's `.from()` reads against the seed. Added (columns verified
against migrations + `database.types.ts`; FK targets checked so nothing silently fails):
- **chore_assignments** — chores are now *assigned to kids* with a status spread (todo→approved), so the
  Chores board shows who's doing what (was: chores existed but looked unclaimed). `chores` insert made
  capturing to get ids.
- **savings_goals** — 5 goals so Finances → **Savings** tab isn't empty (distinct from the Goals module).
- **routine_templates** (+ **routine_template_items**) — Morning & Bedtime routines with 4 steps each, so
  the Routines panel renders a real day.
- **family_memories** (6) + **family_milestones** (4) — the grandparent-portal / planning memory surfaces.
- `SEED_TABLES` extended in child-before-parent order (chore_assignments before chores,
  routine_template_items before routine_templates). tsc + eslint clean.

---

## 📺 KITCHEN DISPLAY V2 — ECHO-SHOW-GRADE (Amazon look & feel) — DONE (2026-07-14)

Owner ask: take `/display` industry-leading — Amazon look and feel, seed data built in, better than
Skylight/Hearth. Built on top of the v1 ambient shell (below):

- **Kitchen Timers widget** (`components/display/kitchen-timers.tsx`) — the feature wall-calendar
  competitors lack: multiple concurrent countdowns from one-tap presets (eggs/pasta/rice/pizza/tea/
  homework…) or custom minutes, Web-Audio chime + flashing card on done, progress fill, localStorage
  persistence keyed on absolute end-times (survives the 120s auto-refresh and full reloads). In the
  default tile layout.
- **Photo-ambient background** (Echo Show signature): `settings.background = 'photos'` renders a slow
  45s-crossfade of `family_photos` (recipe photos as fallback) behind a readability scrim, replacing the
  gradient wash. Selectable in the settings panel (Ambient/Photos).
- **Idle photo frame** (`photo-frame.tsx`): after `settings.idleMinutes` (Off/2/5/10, default 5) with no
  interaction the screen fades to a full-bleed family-photo slideshow with the big clock + "Next: …"
  line; any touch/mouse/key wakes it. Gradient stand-in when the family has no photos yet.
- **Echo-style hints ticker** (`hints-ticker.tsx` + pure `buildHints` in the engine): a rotating bottom
  pill — "📅 Next: Piano · in 25 min", "🍽️ Dinner tonight: Chicken Tacos", "🛒 12 items on the grocery
  list", "🎂 Sarah's birthday Jul 20" — crossfading every 8s, evergreen tips when there's nothing due.
- **Engine** additions (+8 tests → 31): `TIMER_PRESETS`, `formatDuration`, `buildHints`, settings keys
  `background`/`idleMinutes` (normalized, validated). No new migration — the 0200 `settings` blob holds
  the new keys.
- **Seed** `[seed:display]` in `SEED_ALL.sql` — **NOW-RELATIVE** (current_date-based) so the display is
  alive whenever it's run: 6 curated events today (dentist 10am, piano 1pm, soccer 4:30…) + 200 upcoming,
  60 chores + assignments (12 due today), today's 4-meal plan + 14 dinner nights, 60 realistic groceries,
  40 reminders, 6 pinned fridge notes, 10 photo recipes (drives the hero), 24 family photos (drives the
  photo bg + frame) ≈ 502 rows. PG16-verified ×2 (idempotent), counts asserted.
- **Verified** tsc 0 · eslint 0 · vitest 2858 green · `next build` green (`/display` 16.6 kB).

> **+ Responsive, size-dynamic tiles SHIPPED (2026-07-14).** Fixed the reported **weather-tile cutoff**
> and made every tile **render dynamically to its selected size**. New pure helpers in
> `lib/display/tiles.ts` (`tileRowSpan` · `isCompactTile` · `tileListLimit`, tested) map each size to its
> vertical room. `WeatherTile` now takes a `size`: a compact (1-row) tile shows just place + temp +
> condition (which is all that fits — the forecast strip was the piece clipping), while md/lg/hero add
> the multi-day forecast (5 days at lg/hero). Every list widget (schedule/chores/grocery/reminders/
> notes/upcoming) shows a size-scaled number of rows via `tileListLimit`. Structurally, each tile is now
> a flex-column whose body **flexes to fill and scrolls (hidden scrollbar) as a safety net**, so nothing
> is ever hard-clipped regardless of size or data. +4 tests; 2996 green; tsc·eslint·build clean.

## 📺 KITCHEN DISPLAY — WORLD-CLASS BUILD-OUT — DONE (2026-07-14)

Owner ask: fully build out the Amazon/Echo-Show-style Kitchen Display (`/display`) — make it world-class.

- **Migration** `0200_display_settings.sql` (PG16-verified, idempotent ×2): adds `settings jsonb` to
  `display_layouts` so per-family display prefs (12/24h clock, seconds, °F/°C, background theme, ambient
  wash, burn-in protection) persist next to the tile layout. Written by the existing family-scoped upsert.
- **Pure engine** `lib/display/ambient.ts` (+24 tests): day-part detection, day-part greeting, time-of-day
  ambient themes (auto + midnight/aurora/sunset/forest), `nowAndNext` event resolution, `countdownLabel`,
  12/24h clock formatter, temperature formatting (C-in and °F-native), settings normalization.
- **UI** — reworked the display into an always-on kitchen screen: ambient time-of-day background wash +
  glow, header chrome (day-part greeting with family name, big live clock, live weather chip, Fullscreen +
  Edit + Exit), a **Now & Next** strip (what's happening now / up next, big + glanceable with countdowns),
  a **rotating featured-recipe hero**, glass tiles with white high-contrast type for across-the-room
  reading (schedule "NOW" pill, weather 3-day strip, bigger member avatars), **burn-in-protection drift**
  for always-on panels, and an in-place **display settings** panel. New: `components/display/ambient-clock.tsx`,
  `components/display/display-weather.tsx` (shared geolocation weather: header chip + tile, remembers
  location); rewrote `components/display/display-grid.tsx` → `DisplayShell`; `app/(app)/display/page.tsx`
  now fetches up to 6 recipes for the rotating hero and passes settings. Weather is °F-native (open-meteo);
  the °C toggle converts.
- **Verified** tsc 0 · eslint 0 · vitest 2826 green · `next build` green (`/display` 13.7 kB). Migration doc
  row added (0200); next free number → **0203** (0201/0202 = blog engagement + articles).

## 💡 FEEDBACK / IDEA BOARD — DONE (2026-07-14)

> **+ Super Admin console SHIPPED (2026-07-14).** The board can now be RECEIVED and ACTED ON from the
> admin: **`/admin/feedback`** (nav: "Feedback & Ideas") lists every submitted idea (all statuses incl.
> declined) with a summary strip (needs-review / active / shipped / total votes), status + category +
> search filters, and per-idea actions — move it through the roadmap (**status + public note** in one
> save), **pin/unpin**, **reply as the Bubaly team** (`is_team` comment), and **delete** spam. All via
> super-admin-guarded server actions on the service role (no public UPDATE/DELETE on ideas) that
> **revalidate the public `/feedback` board instantly**. Pure `lib/feedback/admin.ts`
> (`feedbackAdminSummary` + `filterIdeasForAdmin`, **6 tests**); tsc·eslint·2906 tests·build green. No
> new migration (reuses 0197).

> **+ Founder growth alerts SHIPPED (2026-07-14).** The admin bell now also fires on the two events a
> founder most wants: a **new family completing onboarding** (`finalizeOnboardingAction` → `family_signup`,
> only for freshly-created families) and a **new paid conversion** (Stripe webhook → `subscription`,
> detected by the pure tested `isNewPaidConversion` — fires once on trial/free → paid+active, never on
> renewals). Both best-effort/service-role. Migration **`0209_admin_growth_kinds.sql`** widens the kind
> CHECK (PG16 ×2). `lib/billing/conversion.ts` (**8 tests**); 3018 tests + build green. ⚠️ apply `0209`.

> **+ Super Admin Notification Center SHIPPED (2026-07-14).** The admin-console **bell** is now the whole
> super-admin front door, not just a static invite count: it surfaces `admin_notifications` across every
> `/admin/*` page — new feedback + bugs, GitHub sync relays, **new support tickets** (contact form), and
> **marketplace Trust & Safety reports** — with an unread badge, a deep-linked dropdown, mark-all-read,
> and pending family invites folded in as a synthetic top item. New event sources write via a shared
> `lib/admin/notify.ts` (`recordAdminNotification`, service-role, best-effort). Migration
> **`0207_admin_notification_kinds.sql`** widens the kind CHECK (PG16 ×2). Pure `lib/admin/notifications.ts`
> (kind meta · unreadCount · badgeText, **4 tests**); 3011 tests + build green. ⚠️ apply `0207`. (Also
> fixed the stale "next free number" note in `docs/PENDING_PROD_MIGRATIONS.md` → 0208 and documented the
> GitHub env keys.)

> **+ Bugs + GitHub tracker + super-admin alerts SHIPPED (2026-07-14).** `/feedback` now takes **bug
> reports** as well as ideas (an Idea/Bug toggle that retunes the form copy). Every submission (a)
> **notifies the super admin** — an `admin_notifications` platform feed on `/admin/feedback` **plus email**
> to all super-admin emails — and (b) is **mirrored to a GitHub issue tracker** with two label-driven
> lists (`bug` vs `enhancement`), the issue link stored back on the row. A **bot** cron
> (`/api/cron/feedback-github-sync`, hourly) reads **both lists**, backfills any unsynced ideas, reflects
> each issue's open/closed + workflow labels back onto the idea's status (closed→shipped, not-planned→
> declined, "in progress"/"planned" labels→status), and **relays a digest** to the super admin. Admin
> console gains a live **Activity relay** feed (mark-read), a **Sync GitHub now** button, an Idea/Bug
> filter, and a per-idea GitHub issue link. Migration **`0206_feedback_github_tracker.sql`**
> (`feedback_ideas.kind` + github_* columns; `admin_notifications`, service-role RLS; PG16 ×2). Pure
> `lib/feedback/github-map.ts` (**11 tests**) + key-gated `lib/integrations/github.ts` client + best-effort
> `lib/feedback/notify.ts` / `github-sync.ts`. 100% Supabase-wired; the GitHub half is **key-gated**
> (`GITHUB_TOKEN` + `GITHUB_FEEDBACK_REPO`) and ships dark — submissions still notify the super admin
> without it. 3006 tests + build green; tsc·eslint clean. ⚠️ apply `0206` + set the GitHub keys (see
> `docs/PENDING_PROD_MIGRATIONS.md`).

Owner ask: build a **new `/feedback` page** opened by the **Gift icon** in the home top bar, mirroring the
"Let's make life easier—together" idea-board design 100%, fully Supabase-wired and production-ready.

- **Schema** `0197_feedback_ideas.sql` (PG16-verified, idempotent ×2): `feedback_ideas` + `feedback_votes`
  (one vote/user/idea) + `feedback_comments`, `SECURITY DEFINER` counter triggers keep `vote_count` /
  `comment_count` exact. Platform-wide board (not family-scoped): authenticated read; insert-your-own;
  delete-your-own vote; **no public UPDATE on ideas** — status is super-admin (service-role) only. Public
  `feedback-attachments` Storage bucket (own-folder writes) for the drag/drop/browse image field.
- **Types** added to `lib/database.types.ts`. **Pure engine** `lib/feedback/board.ts` (status/category/impact
  metadata, roadmap pipeline, `normalizeIdea`, `sortIdeas` top/trending/new, `toggleVote`, tallies) + **17 tests**.
- **Route** `app/(app)/feedback/page.tsx` (`requireUserContext`) — hero + winding-path motif, 3 mini-steps,
  inline **Share-your-idea** form card (title/problem/idea/category/impact/audience/attachment), **Popular ideas**
  upvote list with sort + status/category filters, expandable **comments**, super-admin roadmap-status control,
  right rail (How it works + Status legend with live tallies), footer band. Server actions:
  `submitIdeaAction` / `toggleVoteAction` / `addCommentAction` / `setIdeaStatusAction`.
- **Nav** Gift icon in `components/app/app-shell.tsx` top bar now links `/feedback`.
- **Seed** `SEED_ALL.sql` — **500** ideas + votes + comments (marker `[seed:feedback]`), decayed popularity,
  all statuses, anchored-user votes + team replies. PG16-verified, idempotent.
- **Verified** tsc 0 · eslint 0 · vitest 2794 green · `next build` green (`/feedback` 8.61 kB). Migration
  doc row added (0197); next free number → **0198**.

## 🚀 INDUSTRY-FIRST CAPABILITIES — gap matrix vs. the codebase (owner directive, 2026-07-12)

Owner shared 10 "features no competitor offers" and asked: capture them, gap-audit each against the
project, and build what's missing (Supabase-wired, 500-row seed, world-class, AI-driven, mobile-first).
Audited the routes — **9 of 10 already have a real surface**; depth varies. **The one true greenfield
gap is #10 (Family App Store).** Build order below; keep each slice small + verified (PG16 seed + tsc/
eslint/vitest/next build), ship to `main`.

| # | Industry-first capability | Status | Where it lives / gap |
|---|---|---|---|
| 1 | AI **completes** life administration (not just reminds) | ◐ partial | `/dashboard/agents`, `/dashboard/concierge`, `/dashboard/decisions`, `/dashboard/prep-plans`, `agent_activity`. Autonomous *execution* (vs. surfacing) is the deepen target. |
| 2 | **One phone # + one family email** managed by AI | ☑ exists | `/dashboard/front-desk`, `app/api/concierge-calls`, guardian inbound SMS/voice/WhatsApp (Twilio-verified), `/dashboard/inbox`. |
| 3 | AI **negotiates** appointments / bookings / schedule changes | ◐ partial | Concierge surface exists; true agentic negotiation loop is the deepen target (needs the outbound-call/agent tooling). |
| 4 | AI handles **forms / paperwork / insurance / school packets / registrations** | ☑ **DONE** (2026-07-12) | **Paperwork Inbox** `/dashboard/paperwork` (`0169_paperwork_items`, RLS): capture → **triage** (`lib/paperwork/triage.ts`, pure, 9 tests: kind/dates/amount/actions/urgency) → **one-tap materialize** each action into a real `calendar_events` / `family_reminders` row (idempotent, auditable) → status lifecycle. Mobile-first module + composer; wired into front-desk + inbox; seed `seed_paperwork.sql` (500). **NEW: AI draft-reply** — `draftPaperworkReplyAction` (key-gated via `isAIConfigured`, grounded only in captured text, honest fallback) drafts a ready-to-send reply the parent can copy/edit ("AI fills it out for you"), stored on `meta.draft_reply`. |
| 5 | Unified **household CRM** for every relationship (schools, doctors, contractors, clubs) | ◐ partial | `/dashboard/connections` (`family_connections`), `family_contacts`, `/dashboard/relationship`. Not yet a first-class relationship-CRM with per-entity timelines. |
| 6 | **Verified buy/sell/borrow/rent marketplace** in family workflows | ☑ **DONE** | `/marketplace` — hardened + world-class this session (photos, item detail, storefronts, trust, offers, RLS ownership). |
| 7 | **AI family chief of staff** coordinating specialized AI agents | ☑ exists | `/dashboard/agents`, chief-of-staff via `/dashboard/graph` + reasoning, `agent_activity` orchestration. |
| 8 | **Household financial copilot** integrated with scheduling + life events | ◐ partial | Wallet/Finances (`/dashboard/billing?view=manage`), `app/api/ai/wallet`, `life_event_plans`. Tighter schedule↔money↔life-event linkage is the deepen target. |
| 9 | **Predictive family planning** — identify problems before they occur | ☑ exists | `/dashboard/family-signals`, `daily_insights`, `/dashboard/family-digital-twin`, `/dashboard/prep-plans`. |
| 10 | Open **"Family App Store"** for AI-powered extensions | ☑ **DONE** (2026-07-12) | `/dashboard/app-store` — catalog (`family_apps`) + `family_app_installs` (RLS), `lib/appstore/catalog.ts` (+8 tests), install/uninstall/toggle actions, mobile-first grid + "Recommended for your family" rail + Installed section. Migration `0165`, seed `seed_family_apps.sql` (500 apps, 12 categories) in `SEED_ALL.sql`. PG16-verified. **Nav:** not added to the global sidebar (standing rule — owner to add `/dashboard/app-store` if desired). |

**▶ #10 Family App Store — build spec (start here, next session):**
- **Schema** (new migration, additive/idempotent, family-scoped RLS via `is_family_member`):
  `family_apps` (catalog: slug, name, tagline, description, category, icon/emoji, publisher, capabilities[],
  is_official, status) + `family_app_installs` (family_id, app_id, installed_by, enabled, config jsonb, Stamps).
  Catalog readable by any signed-in user; installs family-scoped.
- **Types** in `lib/database.types.ts`; **pure lib** `lib/appstore/*` (catalog filter/rank, install-state) + tests.
- **Route** `/dashboard/app-store` (browse catalog, categories, install/uninstall, "installed" tab) — mobile-first,
  AI-driven (each app declares AI capabilities; feature a "recommended for your family" rail off signals).
  Server actions `installApp`/`uninstallApp`/`toggleApp`. Wire installed apps into a launcher/nav rail.
- **Seed** `seed_family_apps.sql` — **500** catalog entries across categories (calendar, meals, chores, school,
  sports, health, finance, travel, safety, AI-agents…), each with real metadata so the store renders at volume;
  add to `SEED_ALL.sql`. PG16-verify.
- Verify gate + ship. Then loop back to deepen the ◐ partials (execution loop for #1/#3, paperwork inbox #4,
  relationship-CRM timelines #5, schedule↔money linkage #8).

---

## ★ NORTH STAR — The Family Operating Layer (category-defining, 2026-07-05)

> **Thesis:** today's products (ours included, so far) are **systems of record** — they
> store calendars, lists, notes. Bubaly's category-defining move is to become a **system of
> execution**: an AI-native operating layer that actively helps families *get things done* and
> **measurably reduces time spent on family administration**. The defining metric is NOT daily
> active users — it's **hours of coordination/decision effort removed**. Don't compete
> feature-for-feature; define the category others chase.

---

## ★★ STRATEGIC ALIGNMENT — MOATS OVER FEATURES (owner directive, 2026-07-07) — READ FIRST

> **Owner directive (verbatim intent):** *"I would not pursue more features next. I would pursue
> platform moats. Anyone can copy features in 6–18 months; it's much harder to copy the underlying
> intelligence and infrastructure that makes those features work."*
>
> **This section now governs the roadmap.** The competitive review confirms it: Bubaly's public
> feature matrix already **out-covers Cozi / FamilyWall / OurHome** on nearly every row — more
> features is NOT the gap. The gap is the **moat underneath** and making the highest-value surfaces
> *findable and coordinated*. **Freeze net-new feature modules.** New work must deepen one of the five
> ownable layers below or it doesn't ship.

**The five layers to OWN (this is the scoring rubric for any proposed work):**
1. **Own the data model** — the Family Knowledge Graph (the brain).
2. **Own the intelligence layer** — the Family Reasoning Engine.
3. **Own the experience** — intent-based, AI-first journeys ("one assistant coordinates the rest").
4. **Own the ecosystem** — orchestrate the services families already use (don't duplicate them).
5. **Own the category** — measure success in **reduced mental load / time saved**, not app time.

### ▣ Honest audit — what's BUILT vs. the real GAP (as of 2026-07-07)

| Strategy layer | Built (this is real) | The moat gap that must close |
|---|---|---|
| **1. Knowledge Graph** | `0129` `graph_entities`/`graph_edges`, `lib/graph/reason.ts` (16 tests), twin projector, `/dashboard/graph`. | **The graph is a standalone page, not the brain.** Only **4 files** touch `lib/graph` (the graph page/module, the projector, one agent helper). FOI, Concierge, Briefing, Playbook, Calm, Decisions, Prep-Plans, Outcomes, Moments all still read **isolated tables**. The graph must become the substrate every capability reasons over. |
| **2. Reasoning Engine** | FOI + orchestrator questions, agents roster, decisions, prep-plans, autopilot — good *engines*, individually tested. | **No single reasoning engine.** ~8 engines each answer part of "what matters / what's likely forgotten / highest-impact / auto-completable / who needs help / what next" from their own inputs. Consolidate into ONE `lib/reasoning/*` core that reads the graph + snapshot and every surface consumes. |
| **3. Experience (one assistant)** | 26 AI/reasoning routes: assistant, agents, concierge, command-center, calm, graph, decisions, prep-plans, intelligence, outcomes, operating-index, moments, briefing, autopilot, front-desk, inbox, readiness, next-best-actions, weekly-briefing, family-ai-assistant, family-digital-twin, family-memory, knowledge, family-knowledge-graph, playbook… | **This is the biggest misalignment.** The strategy is *"users interact with ONE assistant; it coordinates the rest."* We shipped 26 separate destinations — with **duplicates** (two knowledge-graphs, two assistants, two memory pages). Consolidate into **one Chief-of-Staff front door**; demote the rest to internal capabilities it calls. |
| **4. Ecosystem** | `0128` connections hub, 11-provider registry, Connect/Disconnect CRUD, `/dashboard/connections`. | Hub + model are ready but **no live OAuth/token exchange or two-way sync** — it's a directory, not an orchestrator. Needs provider keys (owner) + per-provider sync adapters (agent). |
| **5. Category metric** | FOI measures household *functioning*; journey/onboarding telemetry exists. | **The North-Star metric isn't in the product.** No surfaced "time saved / decisions handled for you / mental load reduced." Only marketing copy says it. Instrument + surface it. |
| **Family Intelligence** | Playbook learns favorite meals/grocery staples/favorites/traditions/travel. | Strategy wants the *harder* signals: **which reminders get ignored, when the family is most stressed, which chores create conflict, which routines actually work, communication style.** Expand the learning surface (transparent + editable). |
| **Moments** | `lib/moments/*` engines + `/dashboard/moments`. | Moments is **one page among 70 modules**, not the organizing principle. Strategy: *"organize by moments, not modules"* (Morning · School · Dinner · Vacation · Birthday · Moving · Holiday · New Baby · Graduation · Emergency · Weekend). Elevate to a first-class organizing layer. |
| **Chief of Staff** | Autopilot (≥90%-conf auto-exec), Calm digest, agents. | ✅ **CLOSED (2026-07-12, `f03500f`)** — Home now IS the assembled front door: greeting → AskBar → FrontDoorHero with **one-tap Approve/Decline in place** (canonical `decideApprovalAction`: multi-approver, audit-logged, auto-executes approved payloads; manager-only, optimistic) and "done for you" merging autopilot auto-executions (undoable) **with specialist-agent completions** (`mergeHandled`, pure + tested) → time-saved metric → time-of-day focus. |

### ▶ THE REALIGNMENT BACKLOG (do these INSTEAD of new features — priority order)

**◆ LIVE STATUS ROLL-UP (updated 2026-07-09) — 22 of 22 backlog items shipped. R9's buildable-now slice (the adapter contract) is done; live Microsoft/Apple sync flips on when the owner provisions provider OAuth keys (B3).**

| # | Item | Phase | Status | Migration | Seed |
|---|------|-------|--------|-----------|------|
| R1 | `lib/reasoning/context.ts` — one graph-backed context loader | P1 | ✅ Shipped | — | `seed_reasoning_context.sql` |
| R2 | Re-point existing engines at the graph | P1 | ✅ Shipped | — | — |
| R3 | Auto-maintain the graph on-dirty | P1 | ✅ Shipped | `0134` | `seed_model_dirty.sql` |
| R4 | Consolidate 26 surfaces → one Chief-of-Staff home | P2 | ✅ Shipped | — | — |
| R5 | The proactive front door | P2 | ✅ Shipped | — | `seed_front_door.sql` |
| R6 | Intent-based entry (Home AskBar) | P2 | ✅ Shipped | — | — |
| R7 | **Unify the reasoning engine (one core, six Qs)** | P3 | ✅ **Shipped 07-08** | `0149` | `seed_reasoning_snapshots.sql` |
| R8 | Deepen twin simulation (full activity projection) | P3 | ✅ Shipped 07-08 | `0147` | `seed_twin_simulations.sql` |
| R9 | Per-provider sync adapters (OAuth two-way) | P4 | ✅ **Contract shipped 07-09** (live sync key-gated, B3) | — | `seed_sync_microsoft.sql` |
| R10 | Family Intelligence — the hard signals | X-cut | ✅ Shipped | `0142` | `seed_family_signals.sql` |
| R11 | The category metric — "time saved / mental load" | X-cut | ✅ Shipped | — | `seed_time_saved.sql` |
| R12 | Moments as an organizing layer | X-cut | ✅ Shipped 07-08 | `0148` | `seed_moment_activations.sql` |
| T1 | Value-first onboarding re-sequence | P1 | ✅ Shipped | `0138` | (import-driven) |
| T2 | First-run "instant briefing" builder | P1 | ✅ Shipped | `0139` | `seed_meal_ideas.sql` |
| T3 | New-family home = outcome, never empty | P1 | ✅ Shipped | `0140` | `seed_home_briefs.sql` |
| T4 | Insight-of-the-day | P1 | ✅ Shipped | `0141` | `seed_daily_insights.sql` |
| T5 | Partner-tone pass | P1 | ✅ Shipped | — | `seed_notifications.sql` |
| T6 | AI-facilitated group decisions | P2 | ✅ Shipped | `0142*` | `seed_group_decisions_one_family.sql` |
| T7 | "Why this?" everywhere | P2 | ✅ Shipped | `0143` | `seed_ai_feedback_one_family.sql` |
| T8 | Premium-consistency sweep (Experience Scorecard) | P2 | ✅ Shipped | `0144` | `seed_experience_audits_one_family.sql` |
| T9 | "What Bubaly has learned" + life-event templates | P3 | ✅ Shipped | `0145` | `seed_life_events_one_family.sql` |
| T10 | TTFV metric (signup→first outcome) | Instr. | ✅ Shipped | `0146` | `seed_activation_events.sql` |

> **All 22 backlog items are now built.** R9's engineering slice — the provider-agnostic adapter
> contract, the generic two-way engine, the Google + Microsoft adapters, the registry, and the
> `/api/sync/run` wiring — shipped 07-09. What remains is **owner-only**, not code: provisioning the
> per-provider OAuth client keys/secrets (see §B / decision B3) flips live Microsoft (and, once its
> adapter drops in, Apple/CalDAV) sync on. All migrations `0138–0149` are ⚠️ **pending apply to prod**
> — see `docs/PENDING_PROD_MIGRATIONS.md`.

**P1 — Make the Knowledge Graph the brain (Phase 1; 6–12mo moat).**
- [x] **R1. `lib/reasoning/context.ts`** ✅ — one graph-backed context loader every AI surface calls.
  `loadFamilyContext(supabase, familyId)` → graph (entities + edges) + live household snapshot +
  operating index, assembled by a pure, DB-free core (`assembleFamilyContext` + `entityForRow` row→node
  join, `relatedTo`, `impactFrom`, `contextSummary`; **10 tests**). Shared `loadFamilyGraph` now backs
  the Agents/Chief-of-Staff page (replacing its inline graph load) and a new reasoning-summary strip on
  `/dashboard/graph`. Seed `seed_reasoning_context.sql` (500 entities + members, ~520 edges, hub +
  chain + orphans, ref-linked mirrors). Next: **R2** re-points the other engines at this loader.
- [x] **R2. Re-point existing engines at the graph** ✅ — FOI, Concierge, Briefing, Playbook, Calm,
  Decisions, Prep-Plans, Outcomes read graph relationships (Emma→Soccer→Field→Weather→Dinner) instead
  of isolated `.from()` calls. No new tables; rewire reads. Shipped one engine at a time behind tests.
  **Started:** pure `lib/reasoning/insights.ts::reasoningInsights(ctx)` (hub / ripple = graph × snapshot /
  coverage; **4 tests**) built on R1's `FamilyContext`, and **Calm re-pointed** — the one prioritized
  inbox now folds a `graph` source (relationship insights) alongside agents/autopilot/FOI/approvals/
  reminders. Seed `seed_reasoning_insights.sql` (named hub + 500 entities + ~540 edges + orphans).
  **+ Agents / Chief of Staff re-pointed** onto the SAME shared engine (`loadFamilyContext` +
  `reasoningInsights`), retiring the bespoke `lib/agents/graph-insight.ts` (dedup) and gaining the
  graph×snapshot ripple insight. Two engines now share one relationship-reasoning core.
  **+ Daily Briefing re-pointed** — the morning briefing renders a graph-backed "Relationships"
  section (`components/reasoning/relationship-insights.tsx`, server-computed via `reasoningInsights`,
  passed into `BriefingModule` like `recap`). **+ Concierge + Outcomes re-pointed** — both server
  pages render the shared `RelationshipInsights` card above their module via one `loadFamilyContext`
  call. **+ Decisions + Prep-Plans + Playbook re-pointed** (same shared card). **+ FOI re-pointed** via
  `graphReasoningInsights(graph, band)` — a lean second entry point that reuses FOI's already-computed
  band (no double `buildSnapshot`); `reasoningInsights(ctx)` and it share one rule set. **DONE: all 9
  surfaces** reason over the graph through one core (Calm · Chief of Staff · Briefing · Concierge ·
  Outcomes · Decisions · Prep-Plans · Playbook · FOI). Next: **R3** (auto-maintain the graph on-dirty).
  **+ Fragility / bus-factor insight ✅ SHIPPED (2026-07-14).** New pure graph capability
  `soleDependencies(index)` in `lib/graph/reason.ts` — detects when ONE person is the *only* connector
  to a set of things (distinct from a hub, which is coordination LOAD; this is FRAGILITY / no backup).
  Wired as a 4th `reasoningInsight` kind (`fragility`, `ShieldAlert` icon), escalating to `action`
  severity when the week is stretched/overloaded: *"Mom is the only backup for 4 things — if she's
  unavailable these have no backup."* The mental-load north-star made concrete. Added at the
  graph/insights layer, so it lit up **all 9 surfaces** with zero per-surface changes. **+7 tests**
  (soleDependencies bus-factor + fragility insight + threshold/severity); 2770 tests green; tsc·eslint.
- [x] **R3. Auto-maintain the graph** ✅ — the `family_model_dirty` trigger (`0134`) flags changes;
  the graph now re-projects itself with no manual "Rebuild". Two layers: (1) the `model-refresh` cron
  already re-projects dirty families twice daily (backstop); (2) **new on-read auto-refresh** — every
  graph read (`loadFamilyGraph`, now used by all 9 R2 surfaces) checks the dirty flag and, if dirty past
  a cooldown, re-projects the twin in the BACKGROUND via Next `after()` (post-response, no page
  slowdown) then clears the flag. Pure throttle `shouldAutoRefreshGraph` (dirty AND cooled-down; 4
  tests); server `lib/reasoning/auto-refresh.ts` (fire-and-forget dynamic import keeps `context.ts`
  test-pure). Seed `seed_model_dirty.sql` (500 `family_places` → fires the trigger → materialize on next
  read). tsc/eslint/**2065 tests**/build green.

**P2 — One assistant / AI Operating Layer (Phase 2; 6–12mo, category-defining).**
- [x] **R4. Consolidate the 26 surfaces into ONE Chief-of-Staff home** ✅ — a single assistant that
  *coordinates* the specialist engines (agents/FOI/concierge/prep-plans/calm) behind one interface.
  The others become tabs/capabilities it routes to, not top-level nav. **De-duplicate first**
  (merge graph+family-knowledge-graph, assistant+family-ai-assistant, knowledge+family-memory).
  **De-dup DONE:** `family-ai-assistant` → `assistant` (literal dupe); `family-knowledge-graph` →
  `graph` (second view of the same graph tables); `family-memory` → `memories` (its family_memories
  journal + milestones already surface on grandparent-portal/planning, so non-lossy). All removed from
  nav / feature-catalog / service-categories. `knowledge` (family_facts) intentionally kept — it's
  facts, a genuinely distinct surface, not a memory dup (the roadmap's "knowledge+family-memory"
  grouping was imprecise). **Front door + intent entry** delivered separately (R5 + R6). Remaining R4:
  demoting specialist reasoning surfaces from top-level nav is **owner-settled** (§A: default rail
  stays curated; specialists live in All Services + Navigation Choices) — no further change.
- [x] **R5. The proactive front door** ✅ — the Home hero now leads with "I already handled N
  things — M need your OK." Pure `lib/home/front-door.ts::buildFrontDoor` (7 tests) folds recent
  **auto-executed** autopilot actions (reversible → link to Autopilot to undo) + **pending**
  approval_requests (most-urgent first → link to the inbox) into one proactive summary;
  `components/home/front-door-hero.tsx` renders it above the Focus strip. Transparent (every item
  named + linked) and reversible. Best-effort loads (hidden hero on a drifted DB). Seed
  `seed_front_door.sql` (300 auto-executed + 250 pending = 550 records). tsc/eslint/**2072 tests**/build.
- [x] **R6. Intent-based entry** ✅ — a prominent NL **AskBar** at the top of Home routes through the
  same pure `routeCommand` the ⌘K bar uses: a recognized goal jumps straight to its reasoning engine,
  a page name navigates, anything else hands to the assistant. Extended `detectIntent` with the two
  missing goals from the brief — **`check_availability`** ("who's free Saturday" → Calendar) and
  **`plan_event`** ("plan Emma's party" → Prep Plans) — with tests. `components/home/ask-bar.tsx`
  (+ suggestion chips). Intent entry is now the primary, visible way in on the default landing.
  Pure/tested; no new data surface. tsc/eslint/**2074 tests**/build.

**P3 — Digital Twin / Reasoning Engine depth (Phase 3; 12–18mo differentiation).**
- [x] **R7. Unify the reasoning engine** ✅ SHIPPED (2026-07-08). One core in `lib/reasoning/engine.ts`
  (`answerFamilyQuestions`, pure + deterministic, 8 tests) answers the six questions every surface
  consumes — **what matters most · what's likely forgotten · what to decide next · what Bubaly can
  just handle · who needs help · what's next** — by *composing* the existing engines: the FOI
  orchestrator, the graph reasoning insights (R2), the hard signals (R10), and ranked next-actions.
  Server `lib/reasoning/engine-server.ts` (`loadReasoningReport` / `loadAndSnapshotReasoning`)
  assembles them from live family data best-effort (any failing source → calm) and persists one
  snapshot per day to **`reasoning_snapshots`** (`0149`, family-scoped RLS). Surface
  `/dashboard/reasoning` (nav: Family Reasoning) renders the six answers + all-clear state. Seed
  `seed_reasoning_snapshots.sql` (500 days, calm/attention mix; in `SEED_ALL.sql`). Verified:
  tsc · **vitest (8 reasoning)** · migration + seed validated on PG16 (500 rows, both idempotent).
  ⚠️ apply `0149` to prod (see `docs/PENDING_PROD_MIGRATIONS.md`).
- [x] **R8. Deepen twin simulation** ✅ SHIPPED (2026-07-08). Pure `projectActivity` added to
  `lib/twin/simulate.ts` (7 tests) — the full "if Emma joins travel soccer, what has to move?"
  projection across **schedule · travel · cost · family time · homework · meals · vacation**, each a
  scored dimension with an overall verdict + weekly-hours. Additive (existing commitment/spend
  simulator untouched; 10 tests still green). Server `projectActivityAction` assembles the real
  household (member events + budgets w/ period spend + `vacations` windows) and runs it — a safe
  no-write what-if; `saveSimulationAction`/`deleteSimulationAction` persist kept scenarios to
  **`twin_simulations`** (`0147`, family-scoped RLS). UI `components/twin/activity-projection.tsx`
  mounted on `/dashboard/family-digital-twin` (form → per-dimension ripple → Save; saved-scenario
  list). Seed `seed_twin_simulations.sql` (500 rows, verdict spread; in `SEED_ALL.sql`). Verified:
  tsc · eslint · **vitest (17 twin)** · `next build`; migration + seed validated on PG16 (500 rows,
  idempotent). *(Reads the family's real linked model — events/budgets/vacations; deeper graph-entity
  wiring can layer on later.)*

**P4 — Ecosystem orchestration (Phase 4; 18–24mo network effects).**
- [x] **R9. Per-provider sync adapters** ✅ SHIPPED (2026-07-09). Two complementary layers landed
  (parallel work streams), both key-gated per B3 — no engineering left, only owner OAuth keys:
  - **Sync-engine contract (the real two-way engine).** `lib/sync/adapter.ts` (`SyncProviderAdapter` +
    normalized event/task/calendar types + `SyncApiError`) abstracts OAuth + the calendar/task API + the
    pure mappers so ONE engine drives any provider. `lib/sync/engine/generic.ts` (`runProviderSync`) is
    that engine — the proven Google pull/push/conflict/mapping loop, now driven purely through the
    contract. `providers/google-adapter.ts` conforms the battle-tested Google client (zero behavior
    change); `providers/microsoft.ts` is a real **Microsoft Graph** adapter (Outlook Calendar + To Do,
    OAuth v2.0, fully-tested pure Graph mappers, key-gated on `MICROSOFT_SYNC_*`). `lib/sync/registry.ts`
    + shared `lib/sync/hash.ts` (every adapter yields the SAME digest — proven by test). Wired via
    `POST /api/sync/run`. Seed `seed_sync_microsoft.sql` (connected Outlook account + 500 synced events +
    mappings; in `SEED_ALL.sql`). 17 adapter tests + 13 google-map (no regression); tsc · eslint · build;
    seed PG16-validated + idempotent. No migration — `microsoft` was already in the `sync_provider` enum
    (0018).
  - **Connections-hub contract (the higher-level directory→sync abstraction).** `lib/connections/adapter.ts`
    (`SyncAdapter`, normalized `NormalizedEvent`/`NormalizedMessage`, `AdapterContext`, pure `planSync`
    decision core: blocks on `needs_setup`/`not_connected`/`unsupported`, full→incremental once a cursor
    exists). Reference adapters `lib/connections/adapters/` — `google-calendar` + `gmail` — inert until
    `GOOGLE_OAUTH_*` keys land. Registry `adapterFor`/`syncableProviderIds`. 12 tests; tsc · eslint · build.
  - **Apple iCloud (CalDAV) adapter ✅ SHIPPED (2026-07-14).** The third provider, proving the contract
    holds even for a NON-OAuth provider. `lib/sync/providers/apple.ts` implements the full
    `SyncProviderAdapter` over iCloud CalDAV (RFC 4791): the Apple ID + app-specific password is packed
    into the opaque engine token; `exchangeCode` validates it via a `current-user-principal` PROPFIND;
    calendar sync uses CalDAV `sync-collection` (its sync-token IS the engine's cursor → incremental with
    zero engine changes); events map through the already-tested `lib/sync/ics.ts` VEVENT parser/generator.
    Reminders (VTODO) return a null default list, which the generic engine treats as "no task sync" —
    calendar-only and honest, VTODO flagged as the one follow-up. Registered in `registry.ts`; key-gated
    on `APPLE_SYNC_ENABLED` (owner opt-in for the credential-entry surface). **23 new pure tests**
    (credential pack/unpack, CalDAV PROPFIND/sync-collection parsers, ICS round-trips, contract
    conformance) + shared adapter suite updated — 88 sync tests green; tsc · eslint clean. No migration
    (`apple` already in the `sync_provider` enum, 0018).
  - **Remaining (owner-only):** provision provider OAuth keys → live Microsoft/Gmail/Calendar sync;
    for Apple, set `APPLE_SYNC_ENABLED=true` + build the app-specific-password credential-entry page
    (the adapter + engine are ready; only that opt-in UI + `/api/sync/apple/callback` remain).

**Cross-cutting moat work (start now, threads through all phases):**
- [x] **R10. Family Intelligence — the hard signals.** ✅ SHIPPED (2026-07-07). Four pure detectors in
  `lib/intelligence/hard-signals.ts` (11 tests): **ignored-reminder** (same reminder overdue-without-
  done ≥3×, grouped by normalized title), **stress windows** (events×4 + clashes×12 + overdue×6 bucketed
  by day-type × part-of-day → the peak crunch window), **chore friction** (rejections×2 + disputes×3 +
  hand-offs, per chore), **routine adherence** (expected weekday occurrences vs actual completions →
  flags routines under 60%). Service core `hard-signals-server.ts` (`runSignalDetection`) maps live
  rows (family_reminders/calendar_events/chore_assignments/routine_templates) to the engines and upserts
  into **`family_signals`** (`0142`, family-scoped RLS) — **preserving dismissals**. Transparent +
  editable surface at **`/dashboard/family-signals`** (evidence chips + Acknowledge/Dismiss/Restore +
  Refresh) + nav entry. Runs on demand AND in the **model-refresh cron** (always-learning, non-fatal).
  Seed `seed_family_signals.sql` (500 rows, status spread; in `SEED_ALL.sql`).
  Verified: tsc · eslint · **vitest (11)** · `next build`; migration + seed validated on PG16 (500 rows,
  idempotent). Feeds the Playbook/reasoning layer (family_signals is now a readable substrate).
  - [x] **5th detector — budget drift ✅ SHIPPED (2026-07-10).** `detectBudgetDrift` (pure, +5 tests)
    flags a budget **category over its cap this period**, scored by overspend ratio and boosted when the
    **prior period was over too** (a real drift pattern, not FOI's single number). Reuses FOI's
    period-window math; `runSignalDetection` now also loads `budgets` + this-year expense `transactions`.
    Migration **`0157_family_signals_budget_drift.sql`** widens the `kind` check with `budget_drift`
    (additive/idempotent, PG16-validated); the Family Intelligence surface renders it (Wallet icon,
    spent/cap/"2 periods" evidence chips). Seed extended to 5 kinds (100 budget_drift rows). Verified:
    tsc · eslint · **vitest (16 hard-signals)** · `next build`. ⚠️ apply `0157` to prod.
- [x] **R11. The category metric — surface "time saved / mental load."** ✅ Pure
  `lib/metric/time-saved.ts::computeTimeSaved` (4 tests) turns this week's system-handled actions —
  autopilot auto-executions (5 min), assistant-handled items (4 min), reminders delivered (2 min) —
  into a real "≈ N hours saved this week · M things handled for you" figure with a transparent
  breakdown. Server loader `time-saved-server.ts` (best-effort 7-day counts); `TimeSavedBanner`
  rendered on **Home** (under the front door) and atop the **Experience Scorecard**. Seed
  `seed_time_saved.sql` (250 autopilot + 150 agent + 150 reminders = 550 → ~35.8h). The thesis metric
  is now IN the product, not just marketing copy. tsc/eslint/**2078 tests**/build.
- [x] **R12. Moments as an organizing layer** ✅ SHIPPED (2026-07-08). Pure `lib/moments/organizer.ts`
  (`activeMoments`, 9 tests) defines the 10 canonical life moments (Morning · School · Dinner · Homework
  · Bedtime · Weekend · Vacation · Birthday · Holiday · Emergency), each orchestrating the handful of
  capabilities it needs, and decides which are LIVE now from the clock + family signals (upcoming
  birthday/trip/holiday, homework due tomorrow) — episodic-near outranks the daily rhythm; Emergency
  always reachable. `/dashboard/moments` now OPENS with a "Right now" organizing band (server-computed,
  deep-linked capability chips, dismiss-for-the-day) above the existing event-prep view — organize by
  moment, not by hunting 70 modules. Durable **`moment_activations`** (`0148`, family-scoped RLS) logs
  surfaced/engaged/dismissed per day (engagement signal for the reasoning layer); `dismissMomentAction`/
  `engageMomentAction`. Seed `seed_moment_activations.sql` (500 rows, every moment × ~50 days, status
  spread; in `SEED_ALL.sql`). Verified: tsc · eslint · **vitest (9)** · `next build`; migration + seed
  validated on PG16 (500 rows, idempotent). Additive — the event-prep MomentsView is untouched.

### ⛔ What to STOP
- **No net-new feature modules.** The matrix is saturated; more rows don't move the moat and add
  surface area to maintain. Every new PR should cite which of R1–R12 (or a moat layer) it advances.
- **Stop adding standalone AI pages** — new AI capability goes *through* the one assistant, not as a
  27th destination.
- Marketing/nav polish (findability of Shopping, AI Inbox, Smart Imports, Kitchen Mode, etc.) is fine
  and cheap, but it is **positioning, not moat** — don't confuse it with the work above.

---

## ★★★ TIME-TO-FIRST-VALUE — the 24-hour transformation (owner directive, 2026-07-07) — READ FIRST

> **Owner directive (verbatim intent):** *"The next level is to make Bubaly feel indispensable within
> the first 24 hours… invert the experience: deliver obvious value immediately, then let the platform
> learn over time. Help Bubaly build an understanding of the household from information users already
> have, then immediately solve a real problem. The biggest bet: **reduce time to first meaningful
> value.**"* Directly serves the mission — **Less Managing Life. More Living It.**

> **How this section relates to the MOATS directive above:** that section is about what to *own* (the
> graph, the reasoning engine, the one assistant). This section is about *when the user first feels it*
> — the **first-run funnel**. They are complementary: the moat is the engine; TTFV is the ignition.
> The honest finding of this audit is that Bubaly has **already built the destinations** (outcome
> dashboards, operating index, next-best-actions, chief-of-staff pieces) but still makes users
> **configure a household before any of it lights up**. Closing that gap is mostly *wiring existing
> capabilities into the first session*, not building new features — which is exactly aligned with
> "moats/UX over new modules."

### ▣ Honest audit — what's BUILT vs. the TTFV gap (grounded in the code, 2026-07-07)

| Owner's area | Built today (real) | The gap that blocks day-one value |
|---|---|---|
| **1. Unforgettable first session** | ICS calendar import **exists** (`app/api/calendar/sync/route.ts` hand-rolled RFC-5545 parser + `api/cron/calendar-feeds`); conflict detection (`/dashboard/conflicts`); dinner suggestions (meals engines); outcomes/next-best-actions engines. | **None of it runs during onboarding.** The 6-step wizard (`profile→family→about→members→pin→done`, `lib/onboarding/flow.ts`) is **configuration-first** and `done` delivers a "Welcome" screen, **not a built timeline / conflicts / dinner ideas / action list**. The import is buried in settings. **This is the #1 gap.** |
| **2. Outcomes over dashboards** | `AiHomeDashboard` is the **default** home; `/dashboard/outcomes`, `/family-operating-index`, `/readiness`, `/weekly-briefing`, `/next-best-actions` all exist and are outcome-framed. | Mostly **DONE** — but the outcome framing ("Your week is 92% prepared") isn't the onboarding payoff, and empty/new-family states show scaffolding, not an outcome. Ensure a brand-new family sees an outcome, not an empty widget. |
| **3. One daily "wow"** | Calm digest, agents, autopilot, moments engines produce insights. | No **single, ranked, proactive "insight of the day"** surfaced above everything else. Today it's *many* small items (the thesis's anti-pattern). Need one hero insight/day (traffic+weather, grocery savings, unacknowledged homework). |
| **4. Collaborative AI** | `/dashboard/voting` + `/dashboard/decisions` + `family_polls` + decision engine (options/scoring) exist. | Voting/decisions are **standalone pages**, not an AI-facilitated group flow ("meal voting with budget+dietary constraints", "vacation planning balancing availability"). The AI doesn't yet *drive the group to agreement*. Wire the reasoning engine into the voting/decision surfaces. |
| **5. Switching costs (accumulated context)** | Playbook (favorite meals/staples/traditions), knowledge graph, digital twin, routines, long-term FOI history. | The accumulated context isn't **surfaced back as felt value** ("Bubaly knows your family now"). Add life-event templates + a visible "what Bubaly has learned" surface so the moat is *felt*, and make it editable (ties to R10). |
| **6. Onboarding as guided transformation** | Wizard is clean, 6 steps, a11y-announced, draft-persisted. | It guides through **settings**, not **outcomes**. Each step should end in visible value ("Let's make tomorrow easier" → shows tomorrow's timeline). Re-sequence: value FIRST (import → show), household-building SECOND/deferred. |
| **7. Trust & transparency** | Informed-consent preview (network), `/dashboard/trust`, autopilot approvals, undo patterns. | Not **consistent across every AI action**. Every recommend/automate should carry *why + inputs used + adjust/undo* inline. Standardize a "why this?" affordance on AI outputs (partly R5). |
| **8. Premium feeling** | a11y pass (skip-link/WCAG), `MiniEmpty` empty states, toasts, optimistic updates in many modules. | Inconsistent: not every module has helpful empty states / error recovery / motion. Needs a **consistency sweep** (perf budget, predictable transitions, empty+error states everywhere) — measurable, not vibes. |
| **9. Compounding value** | Connections hub + graph make cross-domain links *possible*; twin links calendar↔meals↔budget. | The cross-service wins (Calendar+Weather→travel, Shopping+Budget→savings, Health+Calendar→med timing) aren't **shipped as visible insights**. This IS moat-work **R2** (re-point engines at the graph) surfaced as day-one wins. |
| **10. Partner tone** | Copy is warm in places; Calm digest is reassuring. | Notification/label voice is still **count-based** in modules ("17 notifications") rather than **partner-framed** ("You're in good shape — 3 quick approvals finish tomorrow"). Tone pass across surfaced counts/badges. |

**Verdict:** ~6 of 10 areas are *substantially built as destinations*; the value is trapped behind a
config-first first-run. **Highest-leverage change = make the first session deliver a concrete outcome
before asking the user to build anything.**

### ▶ THE TTFV BACKLOG (priority order — most is *wiring existing engines into the first run*)

**MEASUREMENT (2026-07-12): Onboarding time-to-value audit ✅ (backlog #9).** `lib/onboarding/ttv-audit.ts`
(pure `analyzeOnboarding` — step funnel, completion + activation rates, TTV median/p90, **% reaching value
≤ 90s**, and where incomplete runs stall; **11 tests**) rendered at **`/admin/onboarding`** (super-admin, in
`ADMIN_NAV`): TTV stat tiles, an on/below-target callout, the step-completion funnel with per-step drop-off,
and a "where runs stall" chart — so the first-run funnel is measurable and the friction is visible to trim.
Reads the existing `onboarding_progress` table; no migration/seed (read-only audit over auth-linked
operational data). tsc/eslint/build green.

**P0 — The "magic first session" (the single biggest conversion/retention bet).**
- [x] **T1. Value-first onboarding re-sequence.** ✅ SHIPPED (2026-07-07). New flow order
  `profile → family → value → about → members → pin → done` — the `value` step comes right after the
  two required inputs, and everything after it is optional/deferrable. In the value step the user
  **pastes their calendar (.ics)** or **tries a sample family week**; we parse it purely
  (`lib/onboarding/ics.ts`, 7 tests) and compute an instant **first brief** — today's timeline ·
  clashes · action list · time-saved (`lib/onboarding/first-brief.ts`, 9 tests) — shown BEFORE any
  configuration. Server: `previewCalendarImportAction` (parse+brief, **no DB write**);
  `finalizeOnboardingAction` persists the imported events into `calendar_events` and records the
  first-value moment in **`onboarding_imports`** (`0138`, family-scoped RLS, PG16-validated) — the
  seed of the TTFV metric (T10). Flow engine extended + retested (imported events kept OUT of
  sessionStorage for quota safety). Seed `seed_onboarding_imports.sql` (500 rows, all 4 sources,
  idempotent; wired into `SEED_ALL.sql`). Verified: tsc · eslint · **vitest (73 onboarding)** ·
  `next build`. *(OAuth "Connect your calendar" stays owner-gated per R9/B3 — paste + sample deliver
  the value moment with zero external keys.)*
- [x] **T2. First-run "instant briefing" builder.** ✅ SHIPPED (2026-07-07). `lib/onboarding/first-brief.ts`
  produces today's timeline · likely conflicts · prioritized action list · **time-saved opportunities**
  · **3 dinner ideas**. Dinner ideas come from a curated, family-agnostic catalog **`meal_ideas`**
  (`0139`, reference data, PG16-validated) via the pure, deterministic `lib/onboarding/dinner-ideas.ts`
  (`pickDinnerIdeas` — quick meals on busy days, involved on weekends, rotates daily; 6 tests). The
  brief is now **rendered as the celebration/done screen** (`finalizeOnboardingAction` computes it
  server-side — with dinner ideas — and returns it; `DonePanel` shows headline · time-saved · today ·
  clashes · dinner ideas instead of the old generic "Welcome"), and also inline in the value step.
  Seed `seed_meal_ideas.sql` (500 dishes × cuisine × effort, idempotent; in `SEED_ALL.sql`, now 26).
  Verified: tsc · eslint · **vitest (80 onboarding)** · `next build`. *(Deferred: rendering the brief
  on the AiHome empty state is T3; dinner ideas draw from the curated catalog, not yet the family's own
  learned tastes — that's a Playbook/R10 follow-up.)*
- [x] **T3. New-family home = outcome, never empty.** ✅ SHIPPED (2026-07-07). When `AiHomeDashboard`
  would otherwise show the bland "You're all caught up / Capture something" empty card (nothing needs
  you + nothing today), it now renders an **outcome hero**: a week-readiness % + progress bar, the
  next best **getting-started steps** (Fill your week · Plan dinners · Invite family · Grocery list ·
  Chores — each marked done from the family's real state, unfinished first), and **3 dinner ideas**.
  Pure engine `lib/home/home-brief.ts` (`buildHomeBrief`, 6 tests) reuses the T1/T2 first-brief engine
  so home + first-run tell the same story. Persists a daily snapshot to **`home_briefs`** (`0140`,
  family-scoped RLS, one row/family/day — the "never empty" substrate + home-side TTFV signal),
  idempotent upsert on read (mirrors the FOI pattern). Seed `seed_home_briefs.sql` (500 daily
  snapshots, readiness trend, idempotent; in `SEED_ALL.sql`, now 27). Verified: tsc · eslint ·
  **vitest (home + onboarding)** · `next build`. *(One ranked hero "insight of the day" is the
  separate T4; this ships the outcome + steps + dinners.)*

**P1 — One daily "wow" + partner tone.**
- [x] **T4. Insight-of-the-day.** ✅ SHIPPED (2026-07-07). The home surfaces exactly ONE ranked,
  proactive insight above the fold (right under the Ask bar) instead of a pile of notifications. Pure
  ranker `lib/home/insight-of-day.ts` (`buildInsightCandidates` + `rankInsights`/`topInsight`, 9 tests)
  scores candidates by impact and picks the best; supports **leave-earlier (traffic+weather)**,
  **unacknowledged homework due tomorrow**, **grocery/meal savings**, plus conflicts · approvals ·
  overdue reminders · renewals · documents · autopilot. Wired into `AiHomeDashboard` from live signals
  (added homework-due-tomorrow + planned-dinner queries) and persisted to **`daily_insights`** (`0141`,
  family-scoped RLS, one row/family/day/kind). Dismissible via `InsightHero` + `dismissInsightAction`
  (the ✕ marks the row dismissed and the **next-best** insight surfaces). Seed `seed_daily_insights.sql`
  (500 rows, every kind × ~56 days, status spread; in `SEED_ALL.sql`, now 28). Verified: tsc · eslint ·
  **vitest (insight + home + onboarding)** · `next build`. *(The traffic+weather source for the
  leave-earlier insight is owner-gated on a Maps/weather key per B3 — the ranker + seed exercise the
  kind; it goes live when the key lands.)*
- [x] **T5. Partner-tone pass.** ✅ SHIPPED (2026-07-07). Centralized phrasing helper
  `lib/tone/partner-phrasing.ts` (18 tests) turns raw counts into partner voice: `notificationsLine`
  ("You're all caught up" → "3 quick things to glance at" → a full-inbox triage offer), `bellLabel`
  (spoken-friendly aria), `partnerStatus` (one "where you stand" line — "You're in good shape — 3 quick
  approvals and tomorrow's set"; surfaces the single most pressing signal), `badgeCount` (capped). Wired
  into the **notification bell** (aria + title + badge) and the **Notifications page** header (live
  partner line from the unread count) — deliberately left `ai-home-dashboard` to the in-flight T-work to
  avoid a collision. Seed `seed_notifications.sql` (500 rows, all 10 types, ~40 unread; in `SEED_ALL.sql`,
  PG16-validated + idempotent). Verified: tsc · eslint · vitest · `next build`. (Area 10.)

**P2 — Collaboration, transparency, premium consistency.**
- [x] **T6. AI-facilitated group decisions.** ✅ Group Voting (`/voting`) now facilitates consensus:
  every poll carries a **category** (meal/vacation/shopping/activity), an optional **budget cap**, and
  **required tags** (e.g. dietary needs); each option carries real **cost / travel / tags**. Pure
  `lib/voting/consensus.ts` (`facilitateConsensus`, **14 tests**) blends the democratic signal (votes)
  with the shared Decision Engine's objective fit (cost/travel + hard budget/dietary vetoes), then
  surfaces a **recommendation**, a **consensus level**, and explicit **vote-vs-fit conflicts** ("the
  favorite is over budget", "votes lean X but Y fits better"). Reasoning context is real: the module
  pulls the family's **budgets** and funds the cap via `budgetCapForCategory` when a poll omits one.
  Migration `0142_poll_facilitation.sql` (additive, idempotent, PG16-validated — no new tables so 0078
  RLS already governs it) + types. Seed `seed_group_decisions_one_family.sql` (100 polls / 400 options /
  ~800 votes = ~1,300 rows) biases favorites over budget so conflicts fire. tsc/eslint/**1990 tests**/build. (Area 4.)
- [x] **T7. "Why this?" everywhere.** ✅ Reusable `components/ai/why-this.tsx` — one consistent inline
  disclosure showing **reason + inputs used** (factors) + confidence + **Helpful/Not-helpful** feedback.
  Pure `lib/ai/explanation.ts` (`explainAutopilot`/`explainInsight`/`explainAgentActivity`/`explainConsensus`,
  **9 tests**) shapes each engine's output into a consistent `Explanation`. Consumed by **insight-of-day**
  (InsightHero), **autopilot** (SuggestionRow), **agents** (recent activity) and **voting** (T6 consensus).
  Feedback persists via `recordAiFeedbackAction` → **`ai_feedback`** (`0143`, append-only, family-scoped
  RLS, PG16-validated) — the learning loop a future model-refresh can weigh. Seed
  `seed_ai_feedback_one_family.sql` (600 rows across all 6 surfaces × 5 signals). tsc/eslint/**1999 tests**/build. (Area 7.)
- [x] **T8. Premium-consistency sweep.** ✅ Made **measurable**: a Supabase-backed Experience Scorecard
  grades every surface (module/journey) on the six premium dimensions (empty state, error recovery,
  transitions, performance, accessibility, consistency), tracked over time. Pure
  `lib/experience/scorecard.ts` (`scoreAudit`/`gradeFor`/`rollUpScorecard`, **13 tests**) — weighted
  composite → letter grade, worst-first ordering, per-dimension averages, trend vs previous audit,
  "needs work" (<70) flags. Table `experience_audits` (`0144`, family-scoped RLS, one audit/surface/day,
  PG16-validated) + types. Live `/dashboard/experience` module (realtime). `docs/EXPERIENCE_SCORECARD.md`
  extended to document the live system (closes the doc's own "make it measurable" gap). Seed
  `seed_experience_audits_one_family.sql` (540 rows / 30 surfaces × 18 dates) with an upward trend +
  4 surfaces below the bar. tsc/eslint/**2012 tests**/build. *(Route not added to global nav per the
  standing rule — reachable at `/dashboard/experience`; add a nav entry on request.)* (Area 8.)
  (Area 8.)

**P3 — Felt switching cost (compounding context).**
- [x] **T9. "What Bubaly has learned" surface + life-event templates.** ✅ New `/dashboard/life-events`
  ("Life & Milestones") with two halves: (1) **What Bubaly has learned** — accumulated preferences/
  routines/traditions (reuses `family_facts`), fully editable inline (add/edit/pin/delete); (2)
  **Life-event playbooks** — 6 one-tap templates (New Baby, Moving, School Start, Vacation, New Pet,
  New Job) that materialize a real **dated checklist** via pure `lib/life-events/templates.ts`
  (`buildPlanItems`, **10 tests**). Launch is atomic (`launchLifeEventAction`: plan + items, rolls back
  orphans). Plans/items in `life_event_plans` + `life_event_plan_items` (`0145`, family-scoped RLS,
  PG16-validated) + types; realtime module with progress bars, checkable items, complete/archive. Seed
  `seed_life_events_one_family.sql` (44 plans / ~493 items / 30 learned facts). tsc/eslint/**2022 tests**/build.
  *(Route not in global nav per the standing rule — reachable at `/dashboard/life-events`.)* (Areas 5 + 6.)

**Instrumentation (proves the bet):**
- [x] **T10. TTFV metric.** ✅ Instrumented **time-from-signup-to-first-outcome-viewed** (median + p90)
  and **session-1 activation rates** (calendar imported / first briefing / first outcome). New
  `activation_events` table (`0146`, mirrors onboarding-telemetry RLS: insert-own, select-own,
  service-role aggregates) + pure `lib/analytics/activation.ts` (`summarizeActivation`, `sessionIndexFromMs`,
  `percentile`, **8 tests**). Wired live: `<ActivationBeacon>` on **Outcomes** (first_outcome_viewed) and
  **Briefing** (first_brief_viewed), and a server record on **calendar-feed add** (calendar_imported),
  all deduped to "first value". Surfaced on `/dashboard/onboarding-funnel` **next to the step funnel**
  (TTFV median/p90, activation rate, session-1 tiles, per-milestone reach). Seed `seed_activation_events.sql`
  (~820 rows / 220 cohorts). tsc/eslint/**2030 tests**/build.

**Alignment note:** T1–T3 + T8 are pure UX/wiring of existing capabilities (no new modules — consistent
with the freeze). T4/T6/T9 route *through* the reasoning engine/graph (advance R2/R4/R5/R10/R12), not
new standalone destinations. T10 is the missing half of the category metric (R11).

---

## ⚑ OPEN ITEMS & DECISIONS — single source of truth (2026-07-06)

> ### ▣ EVERYTHING STILL OPEN — consolidated (as of 2026-07-06, evening)
>
> The agent-doable **code** backlog is essentially drained; what genuinely
> remains is **owner / external** action. Shipped this session on top of the
> merged reasoning + moat layer: onboarding→marketing wiring + **child logins
> without email** (#235), role-tailored **nav gating** (#236), marketing header
> text size (#237), role-based **Focus-strip density** (#238), **Kid-Logins nudge**
> on the onboarding Done screen (#239), and screen-reader **progress bars** —
> onboarding (#240) + **app-wide** (#241).
>
> **OPEN — owner / external (NOT code; the agent cannot execute these):**
> 1. **Apply pending prod migrations** — `supabase db push` (incl. `0105_child_logins`
>    + `0118`→`0135`, or paste `supabase/APPLY_PENDING_0118-0135.sql`). **THE blocker:**
>    child logins, the whole reasoning layer (FOI, playbook, agents, graph, decisions,
>    prep plans), and network consent silently no-op in prod until applied.
> 2. **Set prod env vars** — `CHILD_LOGIN_SECRET` (child username+PIN sign-in) and
>    `CRON_SECRET` (`model-refresh` + `network-aggregate` crons).
> 3. **Provider keys** — each lights up an already-built path: **VAPID/FCM** (push) ·
>    **Maps/ETA** (Friction #6 travel buffer) · **GIF provider** (Messages/photos picker) ·
>    **Stripe Issuing** (real Wallet card balances) · **CI Supabase login** (authed e2e).
> 4. **Activate the `onboarding_completed` marketing workflow** so onboarding fires it.
> 5. **Intelligence Network launch gate** — insights only surface at **≥100** consenting families.
>
> **OPEN — agent-doable follow-ups (small, no blocker; do when directed):**
> - [x] **Role density/tone, broader rollout ✅ (2026-07-10)** — the role-tailored greeting
>   (`roleGreeting`, tone-matched per role: parents formal · adults casual · kids a warm emoji line)
>   now leads the **personal dashboard** too, not just Home — extending the Friction #8 treatment
>   (Home focus strip density/`focusMax`/headline + greeting) to a second primary surface. Reuses the
>   pure `lib/ui/role-surface.ts` (already 10 tests); tsc · eslint · build.
> - [x] **Instrument real journey medians ✅ (2026-07-10, code side)** — the ubiquitous **QuickAdd**
>   flow (`components/family/quick-add.tsx`, used across every module) now emits `journey_events` via
>   `useJourney('quick_add')` (start on open · complete on save · abandon on cancel), so the
>   already-live per-family medians at `/dashboard/journeys` (pure `summarizeJourneys`, real data — no
>   estimates) now cover the app-wide add flow alongside capture / add-memory / voice / next-actions.
>   **Residual (owner/infra, not agent-doable here):** the Playwright "taps to complete" CI harness +
>   a cross-family service-role aggregate — both need a running app + auth this sandbox lacks.
> - **Friction #6 travel buffer** — code-ready; needs the Maps/ETA key (owner item 3 above).
> - [x] **Twin projector — care providers ✅ (2026-07-10).** The cross-domain projector now links
>   **health providers** (doctors / dentists / specialists) from `health_providers` as `org` nodes the
>   member "sees" (`Emma → Dr. Lee (Pediatrics)`), so the graph + reasoning layer can reason over health
>   relationships. Pure `projectTwin` extension (+1 test; family-level + dangling providers make a node
>   but no edge); `runTwinProjection` loads the extra table. No migration (reuses `graph_entities/edges`).
>   tsc · eslint · **vitest (17 twin-project)** · build. *(Smart-home entities still deferred — no
>   device domain has landed yet.)*
> - **GIF picker** (Messages/photos) — code path exists; needs the provider key (owner item 3).
> - [x] **Backend production hardening (2026-07-07, reasoning/network lane)** ✅ — Intelligence
>   Network aggregation hardened (write-side granular-consent `filterMetricsByScopes`, atomic
>   upsert-then-prune republish, **per-family try/catch isolation** in the nightly cron); prod audits
>   all clean (11/11 crons `CRON_SECRET`-guarded; `vercel.json` ↔ cron routes match 1:1); Knowledge
>   Graph path-finder `<Select>` a11y labels. **Cron N+1 scalability fixes:** `model-refresh`
>   skip-decision batched to **1 query** (was 2/family) via the dirty table's `refreshed_at`;
>   `network-aggregate` contribute phase batched to **4 queries** (was 4/family) via `.in(family_ids)`
>   — both now scale past thousands of families without hitting the 60s cron limit. Privacy-invariant
>   regression test added (noised count never leaks true cohort size). tsc/eslint/**1916 tests**/build green.
> - [x] **Social share cards (OpenGraph / Twitter)** ✅ (#245) — `app/opengraph-image.tsx` +
>   `app/twitter-image.tsx` render a brand-gradient 1200×630 card (Bubaly wordmark + tagline)
>   via `next/og`, shared from `lib/og/social-image.tsx`. Fully self-contained (wordmark
>   inlined from disk, no network fetch). Fixes the previously-blank `summary_large_image`
>   preview on iMessage/Slack/X/Facebook. Build-verified (both routes generate).
> - [x] **JSON-LD + canonical SEO (2026-07-07)** ✅ (#246) — (a) JSON-LD structured data
>   (`components/marketing/structured-data.tsx`: Organization + WebSite + SoftwareApplication on
>   the homepage, FAQPage on `/faq`) for Google/Bing rich results — honest data only; (b)
>   self-referential canonical URLs (`alternates.canonical: './'` in the root layout resolves
>   per-route — verified home→`/`, `/pricing`→`/pricing`, `/faq`→`/faq`), preventing duplicate
>   indexing of www/non-www/trailing-slash/preview-domain variants. Build- and server-verified.
> - [x] **HSTS security header (2026-07-07)** ✅ (#247) — `Strict-Transport-Security:
>   max-age=63072000; includeSubDomains` added to the global header block in `next.config.mjs`
>   (no `preload` — avoids the irreversible preload-list commitment). Rounds out the existing
>   X-Frame-Options / nosniff / Referrer-Policy / Permissions-Policy set.
> - [x] **Skip-to-content link, WCAG 2.4.1 (2026-07-07)** ✅ (#248) — `components/a11y/skip-link.tsx`
>   (sr-only until focused) rendered first in the marketing layout AND app shell; each `<main>` given
>   `id="main-content"`. Keyboard/SR users can bypass the nav on every page. Build-verified.

### A. Decisions only the owner can make
- [x] **Intelligence Network aggregation** ✅ — decisions signed off + pipeline **built**
  (`0135_network_aggregates.sql`, `lib/network/aggregate.ts` +9 tests, `network-aggregate` cron,
  real insights on `/dashboard/intelligence`). Approved defaults: K=20, low DP noise (Laplace 1.5),
  cohort = kids-band × household-size, **no** geography, launch gate **≥100 families**.
  Seed `seed_network_aggregates.sql`. (`docs/INTELLIGENCE_NETWORK_DESIGN.md` now marked SIGNED OFF + BUILT.)
- [x] **Global nav entries added this session** ✅ CONFIRMED (owner 2026-07-06): keep the left
  navigation as-is and keep all four — Reasoning Graph, Decision Engine, Prep Plans, Intelligence
  Network (all `minLevel: 0`). They live in **All Services + the Navigation Choices catalog** (users
  pin/add them); **deliberately NOT promoted into the default `PRIMARY_NAV` rail** — the default rail
  stays curated. No further change.

### B. Operational — prod go-live (owner action, not code)
- [ ] **Apply migrations 0125→0135 to prod** (`supabase db push`, or paste `supabase/APPLY_PENDING_0118-0135.sql`).
  THE blocker — everything reads these; silently no-ops until applied.
- [ ] **Set `CRON_SECRET` in prod** → activates the `model-refresh` + `network-aggregate` crons.
- [ ] Keys that light up already-built paths: **VAPID/FCM** (push) · **Maps/ETA** (travel buffer) ·
  **GIF provider** (Messages picker) · **Stripe Issuing** (Wallet card balances).

### C. Genuinely-open product items (agent-doable)
- [x] **FOI financial dimension** ✅ — already wired: `countOverspentBudgets` (real budgets vs
  this-period expenses) + real accounts-below-zero in `lib/operating-index/server.ts`. (Stale entry — verified done.)
- [x] **Onboarding pre-family telemetry** ✅ — `0133_onboarding_events.sql` + `lib/analytics/onboarding.ts`
  (11 tests) + `onboarding-track.ts` wired into the wizard + super-admin `/dashboard/onboarding-funnel`
  + `seed_onboarding_events.sql` (550 events). Validated on PG16.
- [x] **AI Concierge write-back** ✅ — already wired: create plans, update status
  (planning/completed/cancelled), delete, and convert a plan → real `calendar_events`. (Stale entry — verified done.)
- [x] **Twin auto-refresh trigger** ✅ — `0134_model_dirty.sql`: `family_model_dirty` flag +
  SECURITY DEFINER trigger on every cross-domain source table; `needsRefresh()` (dirty wins, else TTL,
  3 tests); the `model-refresh` cron prioritizes dirty families + clears the flag. Now event-driven.
- [ ] **Messages GIF picker** — blocked on the provider key. *(external key — not agent-doable)*
- [x] **Kid-login brute-force hardening** ✅ (2026-07-07) — the no-email child sign-in (username +
  4-digit PIN) had NO throttle, so a guessable username + 10k PINs was brute-forceable. Added a durable
  per-username lockout: pure `lib/auth/child-throttle.ts` (10 tests: window/lockout/escalation/reset)
  + `0137_child_login_throttle.sql` (service-role-only table, RLS deny-all; PG16-validated) wired into
  `childSignInAction` (locks after 5 fails/15 min, escalating; cleared on success) and cleared on a
  parent PIN reset. Degrades safely before the migration is applied (still works, just un-throttled).
  Doc: `CHILD_LOGIN_SECRET` + `0137` added to `PENDING_PROD_MIGRATIONS.md`.
  *(Phone-number deep-dive deferred: the parallel session is actively rewriting `phone-auth`/OTP on
  main — building there now would collide. Revisit once that settles.)*

> **Section C status: closed except the GIF picker (needs an external provider key).** All four
> agent-doable items are done — 2 built this session (onboarding telemetry, twin trigger), 2 were
> already wired (FOI financial, Concierge write-back).

### D. ★ Moat layer shipped this session (all validated: 1838 tests / tsc / eslint / build)
- [x] **Knowledge Graph** — `0129`, `lib/graph/reason.ts` (16 tests, impact propagation), `/dashboard/graph`, `seed_graph.sql`.
- [x] **Twin cross-domain projector** — `lib/twin/project.ts` (8 tests) + `projectTwinAction` (pillar #2's linked model).
- [x] **Decision Engine** — `0130`, `lib/decisions/engine.ts` (9 tests), `/dashboard/decisions`, `seed_decisions.sql`.
- [x] **Chief of Staff ↔ graph** — `lib/agents/graph-insight.ts` (6 tests): hubs + ripple into briefings.
- [x] **Prep Plans (autonomous planning)** — `0131`, `lib/planning/prep.ts` (10 tests), `/dashboard/prep-plans`, `seed_prep_plans.sql`.
- [x] **Life Readiness (horizon rollup)** — `lib/readiness/assess.ts` (11 tests), embedded on `/dashboard/readiness`.
- [x] **Intent-Based UX** — `lib/intent/detect.ts` + command-bar integration (18 tests).
- [x] **Auto-refresh cron** — `lib/planning/refresh.ts` (8 tests) + `app/api/cron/model-refresh` + `vercel.json`.
- [x] **Intelligence Network (full)** — `0132` consent + k-anonymity (`lib/network/insights.ts`, 9 tests)
  + informed-consent preview (`lib/network/contribution.ts`, 6 tests) + `0135` **aggregation pipeline**
  (`lib/network/aggregate.ts`, 9 tests; `network-aggregate` cron; real insights on `/dashboard/intelligence`).

### E. Full 500-record seed coverage
- [x] Every user-facing surface has a validated, idempotent 500-row seed (see the Seed-coverage tracker below).

---

**The nine pillars (build order is top-down from the reasoning core):**

1. **AI Operating Layer** — a *platform layer* (not per-feature AI) that continuously reasons
   across the whole household and answers: *What's most likely to go wrong tomorrow? What can be
   completed automatically today? Who's overloaded this week? What should the family decide next?
   What information is missing before an important event?* The AI is an **orchestrator**, not a
   collection of assistants.
2. **Household Digital Twin** ✅ SHIPPED — one continuously-updated model linking people,
   relationships, calendars, home, vehicles, pets, schools, finances, etc. **Both halves now built:**
   (a) **decision simulation** (`lib/twin/simulate.ts`, `/dashboard/family-digital-twin`) — "if we
   accept this tournament, what has to move?"; and (b) the **cross-domain linked model** — the
   Knowledge Graph (see below): a wired **twin projector** (`lib/twin/project.ts` + `projectTwinAction`)
   reads the family's real members/pets/vehicles/schools/teams/routines/places/accounts and
   materializes them as typed graph entities + edges, kept in sync on demand. Remaining scope:
   auto-refresh on data change (currently a one-tap "Rebuild from data") + doctors/smart-home once
   those domains land.

★ **Knowledge Graph — the reasoning substrate** ✅ SHIPPED (moat build) — migration `0129`
   (`graph_entities` + `graph_edges`, typed nodes + directed weighted edges, family RLS), pure
   engine `lib/graph/reason.ts` (16 tests: index/neighbours/`findPath`/`reachable`/`propagateImpact`
   impact blast-radius/`hubs`/`orphans`/`describePath`), `/dashboard/graph` ("Reasoning Graph")
   with path-finder, connection view, impact ripple bars, hubs, add-entity/link, and **Rebuild from
   data** (twin projector). 500-row `seed_graph.sql`. This is what lets the AI *reason across*
   relationships (Emma→Soccer→Field→Weather→Dinner) instead of retrieving isolated rows.
3. **Family Intelligence Layer / Playbook** — every interaction improves understanding; build a
   family playbook (favorite meals, birthday/holiday traditions, travel styles, homework habits,
   shopping patterns, communication styles). Family stays in control (visible + editable — the
   Knowledge Base `family_facts` is the seed of this).
4. **Outcomes, not features** — organize around goals (**Run Today · Feed the Family · Plan a Trip
   · Prepare for School · Manage Money · Keep Everyone Healthy · Celebrate Together · Prepare for
   the Unexpected**); the AI picks the underlying capabilities automatically.
5. **Family Command Center** — a concise morning operational briefing (today's priorities,
   conflicts, weather impacts, budget alerts, deliveries, health reminders, school updates, AI
   recs) and an evening summary of what changed + tomorrow prepped. *(Scaffolds exist:
   `/dashboard/command-center`, `/dashboard/briefing` — unify + make the briefing generative.)*
6. **Specialized AI agents behind one interface** ✅ SHIPPED — Chief of Staff · Scheduler · Meal
   Planner · Budget Coach · Household Manager · School Coordinator · Health Guide · Travel Planner ·
   Memory Keeper · Communications Assistant. User sees one assistant; agents collaborate internally.
   - Pure `lib/agents/roster.ts` (**11 tests**): 10-agent roster; `runAgent`/`chiefOfStaff`/
     `runAllAgents` turn a real `AgentContext` into per-agent briefings (status + deep-linked items);
     Chief of Staff synthesizes the top items across specialists.
   - Migration `0127_agent_activity.sql` — durable, family-scoped RLS log of what each agent
     surfaces/does (kind/severity/status, done/dismissible). PG16-validated (RLS, constraints, trigger).
   - `/dashboard/agents` (`components/modules/agents-module.tsx`): server reads a real snapshot →
     live briefings; roster grid w/ status dots; per-agent items + recent activity (Done/Dismiss
     writes back). Nav: Suggested → Family Assistant (`Bot`, free). 100% Supabase.
   - Seed `supabase/seed_pillar6_agents.sql` — 500 activity records across all 10 agents (idempotent).
   - Verified: tsc · eslint · **1723 vitest** · build.
7. **Family Operating Index (FOI)** — measure how well the household is *functioning* (not to
   judge): planning confidence, schedule stability, financial preparedness, household readiness,
   communication responsiveness, routine completion, goal progress. Surface **practical
   suggestions**, not vanity scores. **← FIRST SLICE, building now.**
8. **Design for Calm** ✅ SHIPPED — fewer notifications, ONE prioritized inbox, an AI daily digest,
   gentle escalation only when necessary. Reduces mental load; does not maximize engagement.
   - Pure `lib/calm/inbox.ts` (**7 tests**): `buildCalmInbox(items)` folds every signal source
     (agents · autopilot · Operating Index · approvals · reminders) into ONE de-duplicated, ranked
     list — `needsYou` (action only, capped), `today` (attention, capped), and a `quieted` count for
     the rest; `calmDigest` writes the gentle one-liner; `noiseReduced` = notifications spared.
   - `/dashboard/calm` (`components/modules/calm-module.tsx`): server reads the real sources → the
     calm inbox; a digest header, "Needs you" + "For today" sections, and everything else
     deliberately collapsed. **No migration** (pure aggregation of shipped tables). 100% Supabase.
   - Nav: Suggested → Calm (`Leaf`, free). Verified: tsc · eslint · **1730 vitest** · build.
9. **Family API** ✅ SHIPPED (hub) — the orchestration hub that *connects* external services
   (calendars, email, banking, grocery/delivery, smart home) rather than replacing them.
   - Pure `lib/connections/providers.ts` (**8 tests**): the provider registry (11 providers × 5
     categories) + `mergeConnections(rows)` folding the catalog with a family's saved connections
     (live-wins-over-disconnected), `groupByCategory`, `connectedCount`.
   - Migration `0128_family_connections.sql` — durable, family-scoped RLS connection records
     (provider/category/status/account_label/last_synced_at; `unique(family_id,provider,external_account_id)`).
     PG16-validated. **No tokens stored here** — those belong in a secret store.
   - `/dashboard/connections` (`components/modules/connections-module.tsx`): grouped provider hub,
     Connect (upsert a real connection) / Disconnect, live status, realtime. 100% Supabase.
   - Nav: Suggested → Connections (`Network`, free). Seed `supabase/seed_pillar9_connections.sql`
     (500 records, all providers × statuses, idempotent).
   - **Gated for later (needs provider keys):** the actual OAuth/token exchange + live two-way data
     sync per provider. The hub, model, and CRUD are production-ready now; enabling a provider = wiring
     its OAuth against these records. Verified: tsc · eslint · **1738 vitest** · build.

### ▶ Slice 1 ✅ SHIPPED: Family Operating Index — the measurable core of the Operating Layer
- [x] **Schema** `0125_family_operating_index.sql` — append-only daily snapshots (composite +
  per-dimension jsonb + suggestions), family-scoped RLS (select/insert/update), one row/family/day
  (`unique(family_id, as_of_date)`). PG16-validated: idempotent re-run, upsert-in-place, RLS + 3 policies.
- [x] **Engine** `lib/operating-index/score.ts` (pure, **12 tests**) — `computeOperatingIndex(snapshot,
  now)` → 7 dimension scores (0–100) + weighted composite + band (thriving/steady/stretched/overloaded)
  + ranked practical suggestions (each deep-linked) + `mostLoaded()` overload detection. Deterministic,
  DOM-free. Calm/empty household reads as *thriving*, never zero.
- [x] **Server** `lib/operating-index/server.ts` — builds the snapshot from real tables (calendar,
  reminders, chore_assignments, documents, maintenance, bills, approvals, votes/polls, goals + reuses
  `detectConflicts`), computes, **upserts today's snapshot idempotently**, returns current + prior
  composite for the trend arrow. **✅ FULLY WIRED (2026-07-05):** every input now reads live data —
  `overspentBudgets` (budgets vs this-period expenses, pure/tested `lib/operating-index/inputs.ts`, 7
  tests), `negativeBalances` (financial_accounts < 0, excl. credit), `lowInventory` (pantry ≤
  low_threshold), `eventsMissingInfo` (upcoming events needing a location), `unreadThreads`
  (conversations not read by all active members). No stubs remain. tsc/eslint/vitest/build green.
- [x] **Route** `/dashboard/family-operating-index` — composite ring dial + band, trend vs. yesterday,
  "Do these next" ranked suggestions (deep-linked), per-dimension bars w/ honest one-line summaries,
  "who's overloaded" line. 100% Supabase.
- [x] **Nav** entry (Operating Index, `Gauge`, minLevel 0 → free + auto in Navigation Choices catalog).
- [x] **Verified** tsc · eslint · **1661 vitest** · `next build`; migration validated on PG16.

### ▶ Slice 2 ✅ SHIPPED: "Since yesterday" evening recap (pillar #5, off the FOI snapshot)
- [x] **`lib/operating-index/summary.ts`** (pure, **8 tests**) — `summarizeChange(current, prior)`
  diffs two FOI snapshots → headline + composite delta + improved/declined dimensions (≥5-pt moves)
  + resolved/emerged suggestions (by id). Calm end-of-day tone; leads with cleared items; silent on
  a flat day. First-reading path handled.
- [x] **Server** now reads the prior **full** snapshot (dimensions + suggestions) and returns
  `change: ChangeSummary` alongside the index.
- [x] **"Since yesterday" card** on `/dashboard/family-operating-index` (headline + cleared/new/±dim
  chips). Reuses the state vector — zero contended files touched. tsc/eslint/**1669 tests**/build.

### ▶ Pillar #4 ✅ SHIPPED: Outcomes-not-features launcher
- [x] **Engine** `lib/outcomes/launcher.ts` (pure, **10 tests**) — the eight outcomes (Run Today ·
  Feed the Family · Plan a Trip · Prepare for School · Manage Money · Keep Everyone Healthy ·
  Celebrate Together · Prepare for the Unexpected); `buildOutcomePlan(id, ctx)` assembles each
  outcome's capability steps (deep-linked) and auto-badges the urgent ones from a real
  `OutcomeContext` (events today, overdue tasks, birthdays soon, open grocery items);
  `outcomeUrgencyCount` for the card badge. DOM-free.
- [x] **Route** `/dashboard/outcomes` — server reads the real family snapshot (count queries +
  birthday compute), builds badged plans, hands them to `components/modules/outcomes-launcher.tsx`
  (goal-first picker → the exact capabilities to get it done, with live badges). 100% Supabase, no
  new migration (reads existing tables).
- [x] **Nav** entry (Suggested → Outcomes, `Wand2`, minLevel 0 → free + in Navigation Choices catalog).
- [x] **Verified** tsc · eslint · **1709 vitest** · `next build`.

**Next slices (build order):** #1 wire the five orchestrator questions ("what's likely to go wrong
tomorrow / who's overloaded / what to decide next / what info is missing") off the same snapshot ·
#2 turn the snapshot into the Digital Twin's state vector for simulation · adopt `summarizeChange`
inside the existing Command Center / Daily Briefing surfaces (ui lane — coordinate vs. parallel session).

*(Why FOI first: it's the one pillar with no existing surface, it forces the reasoning core to
read across the entire household — the seed of pillar #1 — and it makes the north-star metric
[reduced admin effort] measurable from day one. Later slices reuse its snapshot as the twin's
state vector and the Command Center's evening "what changed" source.)*

---

## ☐ OPEN WORK TRACKER (single source of truth for what's left — keep in sync)

### 🌱 Test-data / seed coverage (as of 2026-07-05)
**37 seed files** exist under `supabase/` — most domains have a 500+-record `*_one_family.sql`
(scoped to The Kramer Family `92298eb2…`, idempotent): calendar · tasks · chores · meals(+extras) ·
finances · finance-hub · memories · messages · wallet(+ledger) · voice · location · family · family-safety ·
files · planning · food · home · roles(#8) · pillars 1–6 & 9. **NEW `seed_operating_index_one_family.sql`**
(≈613 records) lights up the FOI (#7) end-to-end — every wired input fires (overspent budgets, a
spendable account < 0, low pantry, expiring docs, overdue maintenance/reminders, off-track goals,
missing-location events, colliding events for conflicts). Run it, then open
`/dashboard/family-operating-index`.
- [x] **Remaining seed gaps closed ✅ (2026-07-10).** The two genuine gaps are now seeded at 500:
  **FOI snapshot history** — `seed_operating_index_history.sql` (500 daily `family_operating_index`
  snapshots, gentle wave + band spread) so the FOI **trend line** + day-over-day recap render (was
  "first reading" until history existed); and **`meal_votes`** — `seed_meal_votes.sql` (500 votes +
  ~1,000 options, open/closed spread) for the comms dimension + `/dashboard/voting` volume. Both
  idempotent, PG16-validated, in `SEED_ALL.sql` (now 45). *(Already covered at 500: `autopilot_suggestions`
  + `approval_requests` via `seed_autopilot.sql`; `family_polls` via `seed_group_decisions_one_family.sql`.)*
- ☑ **NEW `seed_group_decisions_one_family.sql`** (≈1,300 rows: 100 polls / 400 options / ~800 votes)
  fully exercises T6 AI-facilitated group decisions — categories, budgets, dietary tags, and biased
  votes so the consensus engine's recommendations AND vote-vs-fit conflicts render (also gives
  `family_polls`/options/votes real volume). Run it, open `/dashboard/voting`.
- ☑ **NEW `seed_ai_feedback_one_family.sql`** (600 rows) exercises T7 "Why this?" feedback log —
  all 6 surfaces (insight/autopilot/agent/voting/decision/briefing) × 5 signals, over the last ~60 days.
- ☑ **NEW `seed_experience_audits_one_family.sql`** (540 rows) exercises T8 Experience Scorecard —
  30 surfaces × 18 dates over ~68 days, upward trend, accessibility weakest, 4 surfaces below the bar.
- ☑ **NEW `seed_life_events_one_family.sql`** (567 rows) exercises T9 Life & Milestones — 44 plans
  (active/completed/archived) × ~493 dated checklist items + 30 learned facts. Run it, open `/dashboard/life-events`.
- ☑ **NEW `seed_activation_events.sql`** (~820 rows / 220 cohorts) exercises T10 TTFV — signup→first-value
  funnel with a realistic TTFV distribution + session-1 spread. Cross-family telemetry; open `/dashboard/onboarding-funnel`.

### A. Operating Layer slices still to build (agent-doable, build top-down)
- [x] **Slice 1 — Family Operating Index** (engine + page + 0125). PR #227. ✅
- [x] **Slice 2 — "Since yesterday" evening recap** (pillar #5, off the FOI snapshot). PR #228. ✅
- [x] **Slice 3 — Orchestrator questions** (pillar #1) ✅: the five daily questions —
  *what's most likely to go wrong tomorrow · what can auto-complete today · who's
  overloaded this week · what should we decide next · what info is missing before an
  important event.* Pure `lib/operating-index/orchestrator.ts` (**10 tests**) over the
  FOI snapshot + a tomorrow slice; reads open ≥90-confidence `autopilot_suggestions`
  for Q2 (read-only reuse, no engine edit); "Your family chief of staff" section on the
  FOI page. tsc/eslint/**1679 tests**/build.
- [x] **Slice 4 — Command Center adopts the recap** (pillar #5) ✅: shared server-safe
  `components/operating-index/change-recap.tsx` renders the "since yesterday" narrative from a
  `ChangeSummary`; the FOI page and `/dashboard/command-center` both reuse it (DRY), and it's also
  surfaced in the `/dashboard/briefing` **Evening** tab (via an optional `recap` prop). Seed
  `seed_operating_index_all_families.sql` writes yesterday+today snapshots across ALL families so
  the recap renders a real narrative everywhere (composite move + cleared/new + dimension shifts).
  tsc/eslint/1699 tests/build; migration 0125 + seed validated on PG16 (idempotent).
- [x] **Slice 5 — Household Digital Twin: decision simulation** (pillar #2) ✅: pure
  `lib/twin/simulate.ts` (**10 tests**) `simulateDecision(decision, ctx)` — safe "what-if" that
  runs against real data but writes nothing. Two scenarios: **add a commitment** ("if we accept this
  tournament, what has to move?" → overlaps as blockers, tight turnarounds, heavy-week load) and
  **a big spend** ("can we add two nights and stay in budget?" → real budget-vs-transactions
  headroom). Server action `simulateDecisionAction` (family-scoped reads) + client `DecisionSimulator`
  on `/dashboard/family-digital-twin`. tsc/eslint/**1679 tests**/build. *(Full linked state-vector
  reuse of the FOI snapshot = follow-up; this slice ships the category-defining simulation first.)*
- [x] **Slice 6 — Family Playbook** (pillar #3) ✅: Bubaly learns durable preferences/traditions
  from real usage and proposes them; the family confirms → real `family_facts` rows.
  Migration `0126_family_playbook.sql` (`family_playbook_suggestions`: category/label/value/
  evidence/confidence/signature/status suggested→accepted/dismissed/`fact_id`, `unique(family_id,
  signature)`, family-scoped RLS). Pure `lib/playbook/learn.ts` (**10 tests**) `learnPlaybook(signals)`
  → deduped/ranked/capped suggestions from meal/grocery/favorite/tradition signals. Server actions
  `refreshPlaybookAction` (mines meal_plans+meals, grocery_items, family_favorites, yearly
  calendar_events → upsert, `ignoreDuplicates` so dismissed/accepted never resurface) /
  `acceptSuggestionAction` (writes family_facts) / `dismissSuggestionAction`. `/dashboard/playbook`
  (`components/modules/playbook-module.tsx`: review cards w/ confidence + evidence, Save/Dismiss,
  realtime) + nav (Family AI OS, `Wand2`, free). Seed `seed_playbook_all_families.sql` across ALL
  families. tsc/eslint/**1699 tests**/build; migration+seed validated on PG16 (idempotent).
- [x] **Slice 7 — Outcomes launcher** (pillar #4) ✅: goal launcher at `/dashboard/outcomes`
  ("Run Today / Feed the Family / Plan a Trip / …") auto-selecting capabilities. Seed `seed_pillar4_outcomes.sql`.
- [x] **Slice 8 — Specialized agents behind one interface** (pillar #6) ✅: `lib/agents/roster.ts`
  (10-agent roster + Chief of Staff, 11 tests), `agent_activity` (`0127`), `/dashboard/agents`.
  **Now graph-aware** — the Chief of Staff reasons over relationships (`lib/agents/graph-insight.ts`).
  Seed `seed_pillar6_agents.sql`.
- [x] **Slice 9 — Design for Calm** (pillar #8) ✅: `lib/calm/inbox.ts` (one prioritized inbox +
  digest, 7 tests), `/dashboard/calm`. Seed `seed_pillar8_calm.sql`.
- [x] **Slice 10 — Family API** (pillar #9) ✅ (hub, functionally key-gated): `0128_family_connections.sql`,
  `lib/connections/providers.ts` (8 tests), `/dashboard/connections`, Connect/Disconnect CRUD.
  Seed `seed_pillar9_connections.sql`. **Remainder: OAuth token exchange + live sync needs provider keys.**

### B. Smaller follow-ups (agent-doable)
- [x] FOI financial dimension: real **budget-overspend** (budgets vs expenses) + **negative
  ledger balance** detection ✅ — all 5 previously-hardcoded inputs now read live data via pure
  `lib/operating-index/inputs.ts` (`countOverspentBudgets`, 7 tests); `negativeBalances` excludes
  credit cards; `lowInventory`/`eventsMissingInfo`/`unreadThreads` wired too. FOI is 100% Supabase-wired.
- [x] Onboarding: anonymous **pre-family telemetry** ✅ — shipped as `0133_onboarding_events.sql` +
  `lib/analytics/onboarding.ts` + `onboarding-track.ts` (wired into the wizard) + super-admin
  `/dashboard/onboarding-funnel` (+ the **T10 TTFV / activation** panel: `0146_activation_events.sql`,
  `lib/analytics/activation.ts`). (Was a stale duplicate of Section C — verified done.)
- [x] AI Concierge: **write-back of accepted recommendations** ✅ — the module creates/updates/deletes
  `concierge_plans` and converts a plan → real `calendar_events`. (Stale duplicate of Section C — verified done.)

### C. Human-owned / blocked (NOT agent-doable — surfaced, not buildable here)
- [ ] **Apply pending prod migrations 0125→0132** (`supabase db push`, or paste each in the
  Supabase SQL editor). **Highest leverage** — the whole reasoning layer (FOI, playbook, agents,
  connections, knowledge graph, decisions, prep plans, network consent) reads these; they silently
  no-op in prod until applied (this is why the seed hit the missing `habits` table).
  *Agent cannot execute — no prod DB creds/CLI in sandbox (verified).*
- [ ] **Set `CRON_SECRET` in prod** → activates the `model-refresh` cron (twin + prep-plan auto-refresh).
- [ ] **VAPID/FCM keys** → lights up the push path (already built).
- [ ] **Maps/ETA key** (Friction #6 travel buffer) · **GIF provider key** (Messages picker) ·
  **Stripe Issuing** (real-time Wallet card balances) · **CI Supabase login** (authed e2e).

---

## Roadmap features (from the product roadmap)

### 1. Marketplace — "Buy, sell, rent, borrow within the platform"  ☑ DONE

> **▶▶ World-class buildout (2026-07-13) — 8 vertical slices shipped this session, full lifecycle
> beyond eBay/Craigslist.** Each is migration (where needed) + pure engine + tests + realtime/SSR UI +
> ≥500-row seed (where stateful) + docs, PG16-validated, pushed to `main`. Lifecycle now:
> **discover → price-check → watch/price-track → bid/offer → agree → hand off → return → review**, with
> a seller cockpit + a safety/moderation layer. The slices (details in the checklist items below):
> 1. **Live Auctions** (`0183`, +`0184`/`0185` hardening) — proxy bidding, reserve, Buy-It-Now,
>    anti-snipe, `close-auctions` cron.
> 2. **Make an Offer** (`0186`, +`0187` hardening) — Best-Offer negotiation, atomic accept.
> 3. **Pickup & Hand-off** (`0190`) — safe-meetup scheduling, family calendar, in-person code.
> 4. **Price History + Drop Watch** (`0191`) — trigger-driven change log + watcher alerts.
> 5. **Returns + Overdue** (`0192`) — rent/borrow due reminders + `return-reminders` cron.
> 6. **Seller Cockpit** (`/selling`, no migration) — ranked "what needs you" view.
> 7. **Trust & Safety** (`0193`) — report a listing + super-admin moderation queue.
> 8. **Price Coach** (no migration) — comp-band "is this a fair price?" for buyers.
> **Prod:** apply `0183`–`0193` + set `CRON_SECRET` (see `docs/PENDING_PROD_MIGRATIONS.md`); all safe
> pre-apply (best-effort reads, dormant until tables exist). Test coverage: 77 marketplace unit tests.

- [x] Migration `0120_marketplace.sql`: `marketplace_listings` (kind sell/rent/borrow/free/wanted, price_cents, rent_period, category, condition, status, claimed_by), `marketplace_offers` (interest/claim/offer), family-scoped RLS. Validated: all 120 migrations apply on PG16, idempotent re-run clean, RLS+trigger+FK verified.
- [x] Types for both tables in `lib/database.types.ts`.
- [x] `lib/marketplace/listings.ts` — labels, money math, filter/rank, offer/claim state machine (pure). Tests `tests/marketplace-listings.test.ts` (10 tests).
- [x] `components/modules/marketplace-module.tsx` — browse+filter, post/edit, interest/claim, owner offer review (accept→hand-off, decline), withdraw/complete. 100% Supabase via `useRealtimeQuery`.
- [x] Route `/dashboard/marketplace` + admin-only `/dashboard/marketplace/seed` (500-record test seed screen).
- [x] Nav entry (Family & Home group, `Store` icon).
- [x] Verified: tsc, eslint, vitest (1562), build.
#### ▶ Marketplace V2 — the AI-first marketplace (owner design, 2026-07-09) — FULL INCORPORATION CHECKLIST

> **Owner directive:** incorporate the provided design as the `bubaly.com` marketplace page.
> "The world's easiest AI-first marketplace — buy, sell, rent, borrow, lend & more, all in one
> trusted community." Keep the **bubaly global header**; the section rail's **Home** returns to the
> bubaly landing; **no marketplace-specific Messages** — the Messages entry routes to the ONE bubaly
> Messages surface. 100% Supabase-wired, 100% production ready.

**Schema + engines (shipped ✅):**
- [x] Migration **`0151_marketplace_v2.sql`** — `marketplace_stores` (one storefront/member) ·
  `marketplace_follows` · `marketplace_saves` (♥) · `marketplace_collections`+`_items` ·
  `marketplace_orders` (requested→confirmed→active→returned→completed/cancelled) ·
  `marketplace_reviews` (two-sided, 1–5★, one per side per order) · listing kinds widened with
  **`swap` + `donate`**. All family-scoped RLS; validated idempotent on PG16.
- [x] Types for all 7 tables in `lib/database.types.ts`; `swap`/`donate` in `lib/marketplace/listings.ts`.
- [x] Pure **`lib/marketplace/trust.ts`** — `computeTrustScore` (volume-scaled ratings + completed
  exchanges + activity − disputes; new members start at 50 "Building"), `ratingSummary`.
- [x] Pure **`lib/marketplace/discover.ts`** — `aiPicks` (badges: AI Match · Hot Rental · Great Deal ·
  Borrow Nearby · Trending · New Today, variety-first), `activityFeed` ("Sarah rented a dress · 2 min
  ago"), `rankCreators`. **14 tests** across both engines.
- [x] Server actions: `toggleSaveAction` · `toggleFollowAction` · `upsertStoreAction` ·
  `setOrderStatusAction` (legal-transition-enforced) · `leaveReviewAction` (completed orders only,
  both parties, one review per side).
- [x] Accepting an offer now records a **`marketplace_orders`** row (best-effort) — offers→orders→
  reviews→trust is one connected loop.

**Surfaces (shipped ✅):**
- [x] **`/dashboard/marketplace`** — the V2 home inside the bubaly global frame: hero ("AI-first
  marketplace" + trust chips + featured cards) · 8-tile action grid (Sell/Rent/Lend/Borrow/Request/
  Donate/Swap/Create Store) · **AI Picks for You** (badged, ♥-save) · AI Buyer Assistant + Request &
  Get Matched (live match count) + Verified-Trusted-Safe row · Browse by Category · Popular
  Collections · right rail: **AI Marketplace Assistant** (prompt chips → the ONE bubaly assistant) ·
  Recent Activity · Top Creators (Follow) · **Your Trust Score** · Safety First.
- [x] **Single left rail (fix, 2026-07-09):** the Marketplace rail now REPLACES the global bubaly
  sidebar *body* on `/dashboard/marketplace*` (swapped inside the same AppShell `<aside>`), so the
  Bubaly logo + global top header stay and there's ONE rail — not the global nav + a second rail.
  "Your Trust Score" moved to the bottom of the rail (client-computed via `SidebarTrustScore`),
  matching the design; the page's right rail is now Assistant · Nearby Activity · Top Creators ·
  Safety First. `next build` green (9 routes).
- [x] Marketplace **section rail** (`components/marketplace/marketplace-nav.tsx`): Marketplace ·
  **Home → `/dashboard`** (bubaly landing) · AI Assistant · Browse · Requests · Rentals · Borrow &
  Lend · Buy & Sell · Donate · Swap · Collections · Creators · My Store · My Listings ·
  **Messages → `/dashboard/messages`** (global bubaly Messages — no marketplace inbox) · Orders ·
  Reviews · Saved · **Verifications → `/dashboard/trust`** · Post an Item.
- [x] **`/browse`** — the full board (existing realtime module) + match strip; rail-driven via
  `?kind=` `?cat=` `?q=` `?post=1&kind=` (deep-linked post modal).
- [x] **`/saved`** · **`/orders`** (lifecycle controls + leave-review) · **`/reviews`** (received/given
  + your rating) · **`/collections`** (grid + detail) · **`/creators`** (ranked storefronts + Follow) ·
  **`/store`** (storefront editor + follower/rating/listing stats + My Listings).
- [x] Seed **`seed_marketplace_v2.sql`** (~1,200 rows: stores, follows, 6 collections + 150 items,
  300 saves, 300 orders across the status spread, ~500 two-sided reviews; in `SEED_ALL.sql`, now 42).
  PG16-validated ×2 (idempotent). Verified: tsc · eslint · **vitest (34 marketplace)** · `next build`
  (all 9 routes).
- [x] ⚠️ apply **`0151`** to prod (see `docs/PENDING_PROD_MIGRATIONS.md`). Safe before apply: every
  V2 read is best-effort — the home renders with empty rails and the 0120 board still works.

- [x] **Marketplace top-level URL move ✅ SHIPPED (2026-07-09, #275).** The whole surface moved from
  `/dashboard/marketplace*` to top-level **`/marketplace*`** (home, `/browse`, `/collections`,
  `/creators`, `/store`, `/orders`, `/reviews`, `/saved`, `/seed`) under `app/(app)/marketplace/`.

- [x] **Listing photos ✅ SHIPPED (2026-07-09, #277).** Cards + post/edit now render `photo_url`:
  listing cards show the image as a header (`object-cover`) with a gradient + kind-icon placeholder
  fallback; the post/edit form has a **Photo URL** field with a live preview. Seed
  `seed_marketplace.sql` gives all 500 listings a photo (`picsum.photos`). PG16-verified · tsc ·
  eslint · `next build`. *(Still open: a Supabase Storage **upload** path — bucket + policies — so
  owners can attach a file instead of pasting a URL; owner decision on storage.)*

- [x] **Listing detail page ✅ SHIPPED (2026-07-09, #278).** Clicking a listing now opens a real
  detail page — **`/marketplace/item/[id]`** (`app/(app)/marketplace/item/[id]/page.tsx`),
  server-rendered, family-scoped via RLS. Hero photo (with placeholder), title/price/category/
  condition/location/description + live status, a **seller trust card** (`computeTrustScore` from the
  seller's real reviews received + completed orders + listings posted → score, band, star rating, top
  factor; links to the seller's storefront when present), and this listing's reviews. Actions: **Save
  (♥)** + an **Interest/Claim** CTA via the new guarded server action **`makeOfferAction`** (rejects
  own-listing / closed / duplicate open offers; flips an `available` listing to `pending`) driving the
  optimistic **`InterestButton`** client component. Listing cards now **deep-link** to it from the
  browse module (photo + title) and the marketplace home hero + AI picks (were browse-search links).
  Verified: tsc 0 · eslint 0 · `next build` 0 (`/marketplace/item/[id]` registered) · Vercel preview
  deployed green.

**Remaining to reach the full design vision (open):**
- [x] **Listing photo uploads ✅ SHIPPED (2026-07-14).** Real file upload, not paste-a-URL.
  Migration **`0194_marketplace_photos_bucket.sql`** — idempotent public **`marketplace-photos`**
  Storage bucket (10 MB, image mimes) + 4 RLS policies (public read; insert/update/delete scoped to
  the uploader's own `{user_id}/` folder), mirroring the proven avatars pattern (`0089`).
  New **`components/marketplace/photo-upload.tsx`** — pick/drop an image → uploads to
  `{userId}/{ts}-{rand}.{ext}` → public URL becomes `photo_url`; client-side mime + 10 MB validation,
  **Remove** deletes the owned object (no storage leak on abandoned drafts), paste-URL fallback kept.
  Wired into **both** composers (full `marketplace-module` form + the Post-in-60s `quick-post` draft).
  Verified: tsc 0 · eslint 0 · vitest (quick-post 9 + listings 10). ⚠️ apply `0194` to prod (idempotent).
- [x] **Real LLM marketplace assistant ✅ SHIPPED.** `components/marketplace/market-assistant.tsx`
  (rendered on `/marketplace`) drives `askMarketAssistantAction` — a **two-tier** conversational flow
  grounded in the family's live listings+offers snapshot: a deterministic engine (`answerMarketQuestion`,
  works with **no key**, always returns real in-app links) with an **LLM tier layered on top** when
  `isAIConfigured()`. Graceful degrade, no second chat surface — one assistant. (LLM tier lights up when
  the owner provisions the LLM key per B3; the grounded engine ships value today.)
- [x] **"Post in under 60 seconds with AI" ✅ SHIPPED.** `components/marketplace/quick-post.tsx`
  (rendered on `/marketplace`) — one sentence → the deterministic `draftListing` engine fills
  kind/category/condition/price/pickup/title/description (all editable), a price suggestion computed
  from the family's own comparables, a live 60s stopwatch, and now a real photo upload (above). Inserts
  straight into `marketplace_listings`. Instant, no key required. 9 tests.
- [ ] **Secure payments** — real checkout/escrow is Stripe-gated (B3/owner); today amounts are
  recorded on orders and settled off-platform (family context makes this acceptable pre-keys).
- [ ] **Geo "near me" distances** — needs the Maps key (B3); location is stored free-text today.
- [ ] **Cross-family network marketplace** — the design's "community" reach beyond one household
  rides on the Intelligence-Network consent rails (`network_consent`) — a strategy decision (§A).

- [x] **Match intelligence (next level) ✅ SHIPPED (2026-07-09).** The board is now proactive:
  it connects open **`wanted`** requests to the supply already posted (`sell`/`free`/`rent`/`borrow`)
  — *"You're looking for a bike; Mom listed a balance bike for free."* Pure `lib/marketplace/matches.ts`
  (`computeMatches`/`scoreMatch`/`titleTerms`, **10 tests**) scores each wanted↔supply pair by shared
  category + title-term overlap + a free bonus, never matches a member to their own supply, caps per
  wanted. Server `matches-server.ts` (`loadAndSnapshotMatches`) computes from live listings + persists
  to **`marketplace_matches`** (`0150`, family-scoped RLS, one row per wanted/supply) **preserving
  dismissals**. A "Matches on the board" strip (`components/marketplace/matches-strip.tsx`) sits atop
  the board (now `/dashboard/marketplace/browse` under V2) with Got-it / Dismiss (`setMatchStatusAction`). Seed
  `seed_marketplace_matches.sql` (500 rows, status spread; in `SEED_ALL.sql`). Verified: tsc · eslint ·
  **vitest (10 match + 10 listings)** · `next build`; migration + seed validated on PG16 (500 rows,
  idempotent). ⚠️ apply `0150` to prod (see `docs/PENDING_PROD_MIGRATIONS.md`).

- [x] **Saved Searches & Alerts ✅ SHIPPED (2026-07-09).** "Alert me when someone lists X." A member
  saves a standing search (keyword + optional kind / category / price ceiling); **`/marketplace/alerts`**
  matches it against the live board and badges what's **NEW** since they last looked (`last_seen_at`
  cursor). Pure `lib/marketplace/saved-search.ts` (`listingMatchesSearch`/`matchesForSearch`/
  `countNewSince`/`describeSearch`, **12 tests**) — AND-combined criteria, all-terms keyword match over
  title+description, price ceiling on priced kinds only, excludes the viewer's own supply. Table
  **`marketplace_saved_searches`** (`0152`, family-scoped RLS, PG16-validated) + types; server actions
  (`createSavedSearchAction`/`deleteSavedSearchAction`/`markSearchSeenAction`); client `AlertComposer` +
  `AlertActions`; nav entry (Alerts, `BellRing`, additive). Pull-based (no notification hook → zero
  collision with the board). Seed `seed_marketplace_saved_searches.sql` (500 alerts, varied criteria,
  idempotent). Verified: tsc · eslint · **vitest (12)** · `next build` (`/marketplace/alerts`).
  ⚠️ apply `0152` to prod.

- [x] **Marketplace Pulse ✅ SHIPPED (2026-07-09).** A read-only intelligence view at
  **`/marketplace/insights`** — supply by kind, **where demand outruns supply** (open `wanted` vs
  available per category), **price benchmarks** (median/avg per category), and **what's hot** (saves ×2
  + offers ×3). Pure `lib/marketplace/insights.ts` (`marketplaceInsights`, **6 tests**); reads existing
  listings/saves/offers (NO new schema — the existing marketplace seeds populate it). Nav entry (Pulse,
  `Activity`, additive). Verified: tsc · eslint · **vitest (6)** · `next build` (`/marketplace/insights`).

- [x] **Listing Q&A ✅ SHIPPED (2026-07-09).** "Ask a question" on any listing — public within the
  family. Inline thread on the item detail page (`ListingQuestions`: buyers ask, the owner answers
  inline, realtime) + a seller **Questions inbox** at `/marketplace/questions` (Needs-your-answer / Your
  questions / Answered). Table **`marketplace_questions`** (`0153`, family-scoped RLS, PG16-validated) +
  types; pure `lib/marketplace/questions.ts` (`categorizeQuestions`/`unansweredCount`/`isAnswered`,
  **5 tests**). Nav entry (Questions, `MessageSquare`; one surgical mount on the detail page). Seed
  `seed_marketplace_questions.sql` (~400 Q&A, ~half answered by the owner). Verified: tsc · eslint ·
  **vitest (5)** · `next build`. ⚠️ apply `0153` to prod.

- [x] **Following feed ✅ SHIPPED (2026-07-09).** Seller-based discovery to complement keyword Alerts:
  **`/marketplace/following`** shows the latest browsable listings from the creators/stores you follow,
  newest first, each with store attribution + a "NEW this week" flag. Pure `lib/marketplace/following.ts`
  (`buildFollowingFeed`/`newFromFollowingCount`, **5 tests**); reads existing `marketplace_follows` /
  `marketplace_stores` / listings (NO new schema). Nav entry (Following, `UserCheck`, additive).
  Verified: tsc · eslint · **vitest (5)** · `next build` (`/marketplace/following`).

- [x] **Curated demo dataset ✅ SHIPPED (2026-07-09).** **`seed_demo_account.sql`** — ~200 curated,
  tagged, idempotent rows across calendar / finances / bills / reminders / goals / documents /
  maintenance / pantry / knowledge / meals+polls / marketplace for the primary demo family (The Patel
  Family, 1111…), **schema-drift safe** (each table guarded so an unmigrated table is skipped, not
  fatal) and additive (tagged `Demo · ` / `[demo]`, never disturbs seed_prod). PG16-validated (populates
  present tables, skips absent, idempotent). *(NOTE: superseded as the demo's data source by the
  single-account rework at the top of this file — the one-click demo now seeds via `lib/demo/seed.ts` /
  `resetDemoData()`, not this SQL file, which still targets the persistent Patel family. The demo UI is
  the parallel session's `components/demo/demo-experience.tsx` + `lib/demo/config.ts` +
  `useApp().demoExpiresAt`; the standalone `demo-timer.tsx` was removed in #292.)*

- [x] **Live Auctions — real proxy bidding ✅ SHIPPED (2026-07-13). The eBay-beating gap.** Turns the
  marketplace into a live auction house — the signature eBay behavior Craigslist has never had and our
  fixed-price board lacked. Full vertical slice, realtime, atomic, 100% Supabase:
  - Migration **`0183_marketplace_auctions.sql`** — auction columns on `marketplace_listings`
    (`sale_format` fixed|auction · `auction_starts_at`/`ends_at` · `starting_bid_cents` · `reserve_cents`
    · `buy_now_cents` · `current_bid_cents` · `bid_count` · `highest_bidder_*` · `highest_max_cents` ·
    `anti_snipe_minutes` · `auction_closed_at`) + new **`marketplace_bids`** (proxy `max_cents` vs
    visible `amount_cents` · status active/outbid/won/lost/retracted · is_auto). RLS: a bidder sees their
    own bids + the owner sees all. **`marketplace_place_bid()`** RPC (`SECURITY DEFINER`,
    `SELECT … FOR UPDATE` row-lock) implements **eBay-style max/proxy bidding**: tiered min increments,
    hidden reserve, own-listing/too-low/ended guards, and **anti-sniping** (a late bid extends the clock).
    PG16-verified idempotent ×2 + proxy/reserve/anti-snipe scenarios (Bob 8000 leads at 5000; Cara 6000
    → Bob auto-covers 6100; Cara 12000 → leads 8100; reserve 9000 unmet; anti-snipe extended=true).
  - Pure engine **`lib/marketplace/auction.ts`** (`bidIncrementCents`/`minNextBidCents`/`reserveMet`/
    `auctionStatus`/`timeLeft`/`resolveAuctionOutcome`/`quickBidLadder`, **11 tests**) mirrors the SQL
    increment/reserve/status math. Types added to `lib/database.types.ts` (listings triple + `marketplace_bids`
    + the RPC in the typed Functions registry).
  - Server actions `placeBidAction`/`buyNowAction` (`app/(app)/marketplace/auctions/actions.ts`) — bid via
    the RPC (human-mapped reason codes); Buy-It-Now atomically flips the listing to claimed + writes a
    confirmed `marketplace_orders` row.
  - Realtime **`AuctionPanel`** on the item page (ticking countdown · current bid · reserve state ·
    proxy-bid input + quick-bid ladder · Buy-It-Now · live bid history via a `marketplace_bids` Realtime
    channel). Live board **`/marketplace/auctions`** (stat tiles · soonest-ending-first grid · countdowns
    · reserve/Buy-Now flags) + nav entry (Live Auctions, `Gavel`, additive).
  - **`close-auctions` cron** (`app/api/cron/close-auctions/route.ts`, CRON_SECRET, `*/5 * * * *` in
    `vercel.json`): closes expired auctions — winner (reserve met) → confirmed order + bids won/lost +
    notify winner & seller; reserve-not-met → withdrawn + notify. Atomic close (only if still available;
    guards a concurrent Buy-It-Now).
  - Seed **`seed_marketplace_auctions.sql`** (60 auctions + ~456 bids ≈ 516 rows; throwaway "Auction
    Bidders" family so bids are valid cross-family; live/ending-soon/scheduled spread, 20 with reserve,
    15 with Buy-Now, 8 zero-bid lots for the empty state; in `SEED_ALL.sql`). PG16-validated ×2 (60 lots
    / 456 bids, idempotent). Verified: tsc · eslint · **vitest (11 auction)** · `next build`.
  - ⚠️ apply **`0183`** + set **`CRON_SECRET`** in prod (see `docs/PENDING_PROD_MIGRATIONS.md`). Safe
    before apply: the board + panel read best-effort and show nothing until the table exists.

- [x] **Make an Offer — Best Offer negotiation ✅ SHIPPED (2026-07-13). The eBay "Best Offer" gap.**
  Today a buyer could send ONE offer and the seller could only accept/decline — no counters, no
  thread (Craigslist has none of this). Now it's a real two-sided negotiation. Full slice, realtime,
  atomic, 100% Supabase:
  - Migration **`0186_marketplace_negotiations.sql`** — `marketplace_negotiations` (one thread per
    listing+buyer) + `marketplace_negotiation_rounds` (the offer/counter/… history) + two
    `SECURITY DEFINER` RPCs that lock the listing `FOR UPDATE`: **`marketplace_negotiation_offer`**
    (buyer opens or counters) and **`marketplace_negotiation_respond`** (either party counters / accepts /
    declines / withdraws, strict turn model). **Accept is atomic** — claims the listing, writes a
    confirmed `marketplace_orders` row at the agreed price, and closes every competing thread + open
    offer. RLS: readable by the buyer's OR seller's family; writes only via the RPCs. PG16-verified
    idempotent ×2 + full offer→counter→counter→accept flow with own-listing / turn / competing-thread /
    claimed / buyer-only-withdraw / seller-only-decline guards all enforced.
  - Pure engine **`lib/marketplace/negotiation.ts`** (`whoseTurn`/`availableActions`/`validateOfferAmount`/
    `suggested*`/`savingsPercent`/`statusLine`/`roundLine`, **14 tests**). Types added to
    `lib/database.types.ts` (both tables + both RPCs in the typed Functions registry).
  - Server actions `makeOfferAction`/`respondToOfferAction`; realtime **NegotiationPanel** on the item
    page (buyer "make an offer" + counter; seller inbox with counter/accept/decline; live thread
    timeline via a `marketplace_negotiation_rounds` Realtime channel) for fixed-price sale listings.
    Inbox page **`/marketplace/negotiations`** (Your move / Waiting / Settled) + nav entry (Offers,
    `Handshake`, additive).
  - Seed **`seed_marketplace_negotiations.sql`** (100 sale listings + 100 threads across every status
    + ~320 rounds + 20 orders ≈ 540 rows; throwaway "Offer Makers" buyer family; in `SEED_ALL.sql`).
    PG16-validated ×2 (status distribution + last-round-kind integrity confirmed). Verified: tsc ·
    eslint · **vitest (14 negotiation + 11 auction)** · `next build` (`/marketplace/negotiations`).
  - ⚠️ apply **`0186`** to prod (see `docs/PENDING_PROD_MIGRATIONS.md`). Safe before apply: the panel +
    inbox read best-effort and show nothing until the tables exist.

- [x] **Pickup & Hand-off Coordinator ✅ SHIPPED (2026-07-13). Closes the transaction loop.** After a
  deal is struck (accepted offer / won auction / claimed listing → order), nothing coordinated the
  actual exchange — eBay leans on shipping labels, Craigslist on "text me". Now `/marketplace/orders`
  walks it through:
  - Migration **`0190_marketplace_handoffs.sql`** — `marketplace_handoffs` (one per order: proposer +
    role · meet_at · safe-spot label/kind · status proposed/confirmed/completed/cancelled · confirm_code
    · calendar_event link). Family-scoped RLS (4 policies via `is_family_member`), 3 indexes,
    `set_updated_at` trigger, `on delete cascade` from both order and listing. PG16-verified idempotent ×2.
  - Pure engine **`lib/marketplace/handoff.ts`** (curated SAFE meetup spots [police safe-exchange zone,
    grocery entrance, library…] · sensible meet-time slots · hand-off code gen/normalize/match ·
    turn/action gating, **11 tests**). Types added to `lib/database.types.ts`.
  - Server actions `proposeHandoffAction`/`confirmHandoffAction`/`cancelHandoffAction`/
    `completeHandoffAction`: one side proposes time + safe spot; the OTHER **confirms** (drops it on the
    **family calendar** + mints a short **hand-off code**); the exchange **completes in person by entering
    the code**, which advances the order to `completed` atomically. **HandoffPanel** on the Orders page
    (propose form with time chips + safe-spot picker; confirmed card with calendar note + code + complete
    input) — both buyer & seller members drive it from their side. Safety copy nudges to public spots.
  - Seed **`seed_marketplace_handoffs.sql`** (160 orders + 160 hand-offs across all four statuses + 40
    backing calendar events ≈ 520 rows; second family member as buyer; in `SEED_ALL.sql`). PG16-validated
    ×2 (40 per status). Verified: tsc · eslint · **vitest (11 handoff + 14 negotiation + 11 auction)** ·
    `next build`.
  - ⚠️ apply **`0190`** to prod (see `docs/PENDING_PROD_MIGRATIONS.md`). Safe before apply: the Orders
    page reads best-effort and shows no pickup panel until the table exists.

- [x] **Price History + Drop Watch ✅ SHIPPED (2026-07-13). eBay's "price reduced on an item you're
  watching".** The Saved (♥) heart was static — a buyer who hearts an item never heard when the seller
  cut the price. Now:
  - Migration **`0191_marketplace_price_history.sql`** — `marketplace_price_history` (append-only
    old→new log) + an **`AFTER UPDATE OF price_cents` trigger** (`SECURITY DEFINER`) that fires on ANY
    edit path (quick-post, module edit, seed, admin): logs the change, and on a **drop** to a still-live
    listing inserts a notification for **every family watching it** (♥ via `marketplace_saves`).
    Family-scoped RLS. PG16-verified idempotent ×2 + trigger behavior (logs every change; notifies
    exactly on drops — a raise is logged but not notified; message formats `$100.00 → $75.00`).
  - Pure engine **`lib/marketplace/price-history.ts`** (drop % · total drop · lowest-ever + `isAtLowest`
    · recent-drop window · `priceDropBadge` · history lines, **8 tests**). Type added to
    `lib/database.types.ts`.
  - Item page now shows a **"↓ Price dropped X%"** badge + **"Lowest ever"** flag next to the price and
    an expandable **Price history** list (drops in red).
  - Seed **`seed_marketplace_price_history.sql`** (130 fixed-price listings + declining 2–4 step ladders
    ≈ 390 history rows + 65 watcher saves ≈ 585 rows; throwaway "Price Watchers" family; in
    `SEED_ALL.sql`). PG16-validated ×2 (ladders end at current price, all latest changes are drops).
    Verified: tsc · eslint · **vitest (8 price + 11 handoff + 14 negotiation + 11 auction)** · `next build`.
  - ⚠️ apply **`0191`** to prod (see `docs/PENDING_PROD_MIGRATIONS.md`). Safe before apply: the item page
    reads best-effort and shows no badge/history until the table exists.

- [x] **Rent/Borrow Returns + Overdue tracking ✅ SHIPPED (2026-07-13). A family lending library.** The
  marketplace supports `rent`/`borrow` listings and orders carry `ends_on`, but nothing closed the loop —
  no "due back Friday" nudge, no overdue flag. Now:
  - Migration **`0192_marketplace_returns.sql`** — additive `marketplace_orders` columns
    (`due_reminder_sent_at`, `overdue_notified_at`, `returned_at`) + a partial due-date index for the
    cron. No new table. PG16-verified idempotent ×2.
  - Pure engine **`lib/marketplace/returns.ts`** (`returnStatus` upcoming/due_soon/due_today/overdue/
    returned · `daysUntilDue` · `returnLabel` with tones · cron `needsDueReminder`/`needsOverdueAlert`,
    **8 tests**). Columns added to `lib/database.types.ts`.
  - **`return-reminders` cron** (`app/api/cron/return-reminders/route.ts`, `hasCronAuthorization`, daily
    08:00 in `vercel.json`): one due-soon nudge + one overdue alert per order, deduped by the stamps.
  - Orders page now shows a **due / overdue / returned badge** on each rent/borrow order (existing
    `returned` order-control transition unchanged).
  - Seed **`seed_marketplace_returns.sql`** (250 rent/borrow listings + 250 orders across all five
    return states, 50 each ≈ 500 rows; borrower = 2nd family member; in `SEED_ALL.sql`). PG16-validated
    ×2 (even 50-per-bucket spread). Verified: tsc · eslint · **vitest (8 returns + 8 price + 11 handoff +
    14 negotiation + 11 auction)** · `next build`.
  - ⚠️ apply **`0192`** + ensure **`CRON_SECRET`** in prod (see `docs/PENDING_PROD_MIGRATIONS.md`). Safe
    before apply: the badge/cron no-op until the columns exist (the Orders page still renders).

- [x] **Seller Cockpit — "Selling" ✅ SHIPPED (2026-07-13). eBay's Seller Hub.** One command center for
  everything you're selling, **ranked by what needs you** — the capstone that surfaces the depth built
  this session. **No migration / no new seed** (reads existing signals; the marketplace seeds already
  populate them). `/marketplace/selling`:
  - Pure engine **`lib/marketplace/selling.ts`** (`attentionItems` → tone-coded chips · `attentionScore`
    ranking [overdue ≫ questions ≫ offers-to-reply ≫ pickups ≫ ending-soon ≫ interest] · `needsAttention`
    · `sellerTotals` roll-up, **9 tests**).
  - Page aggregates per listing (batched, keyed by listing_id): **watchers** (saves), **open offers +
    negotiations** (with a distinct "needs your reply" count for threads where `last_actor='buyer'`),
    **unanswered questions**, **auction bids + ending-soon**, **pickups to confirm** (proposed handoffs),
    and **overdue returns** — then ranks the board and shows stat tiles (active · needs-attention ·
    watchers · offers · questions). Each row deep-links to the item. Nav entry (Selling, `LayoutDashboard`).
  - Family-scoped + member-scoped (your listings only) via RLS. Verified: tsc · eslint · **vitest (9
    selling + 8 returns + 8 price + 11 handoff + 14 negotiation + 11 auction)** · `next build`
    (`/marketplace/selling`). No prod migration needed — works the moment the underlying tables exist.

- [x] **Trust & Safety — report a listing ✅ SHIPPED (2026-07-13). Safer than Craigslist.** Members can
  flag a listing; the platform super-admin moderates. Pairs with the safe-meetup hand-off to make safety
  a real differentiator:
  - Migration **`0193_marketplace_reports.sql`** — `marketplace_reports` (reason prohibited/scam/
    miscategorized/offensive/spam/duplicate/other · details · status open/reviewing/actioned/dismissed ·
    resolution + reviewer stamp). Reporter-family RLS for read/insert; resolutions are **service-role
    only** (no public UPDATE). Partial unique index blocks stacking open reports. `set_updated_at`
    trigger. PG16-verified idempotent ×2.
  - Pure engine **`lib/marketplace/reports.ts`** (reason/status vocab · `canReport` [not your own] ·
    `summarizeReports` queue roll-up, **7 tests**). Type added to `lib/database.types.ts`.
  - `reportListingAction` (family-scoped, dedupe-aware) + **ReportButton** dialog on the item page
    (non-owners only). Super-admin queue **`/admin/marketplace/reports`** (open-first, stat tiles) with
    **ReportModeration** controls: start-review · action (optionally withdrawing the listing) · dismiss
    with a note — gated by the `/admin` layout + `isSuperAdmin`, service-role writes.
  - Seed **`seed_marketplace_reports.sql`** (500 reports across all 7 reasons × 4 statuses, one per
    listing; throwaway "Safety Reporters" family; in `SEED_ALL.sql`). PG16-validated ×2 (125 per status).
    Verified: tsc · eslint · **vitest (7 reports + …68 marketplace total)** · `next build`
    (`/admin/marketplace/reports`, `/marketplace/item/[id]`).
  - ⚠️ apply **`0193`** to prod (see `docs/PENDING_PROD_MIGRATIONS.md`). Safe before apply: the Report
    button + queue read best-effort and stay dormant until the table exists.

- [x] **Price Coach — "is this a fair price?" ✅ SHIPPED (2026-07-13).** Answers the buyer's core
  question from real comparable listings — no LLM key, **no migration** (reads existing listings as
  comps). Closes the todo pricing gap ("is this a fair price?"):
  - Pure engine **`lib/marketplace/price-coach.ts`** (`percentile` · `priceBand` [p25/median/p75,
    condition-normalized to a 'good' baseline then re-adjusted, needs ≥3 comps] · `assessPrice`
    great/good/fair/above-market · `dealLabel` · `bandSummary`, **9 tests**). Sibling to quick-post's
    single-point `suggestPriceCents` — this returns the whole band + a verdict.
  - Item page (fixed-price sale, non-owner) shows a **deal badge** next to the price ("Great price" /
    "Good price" / "Fair price" / "Above similar items") + a **"Similar items: $X–$Y · based on
    comparable listings"** line, from reachable same-category `sell` comps (RLS/circles). Owners and
    auctions don't show it. Verified: tsc · eslint · **vitest (9 coach + …77 marketplace total)** ·
    `next build`. No prod migration — lights up on existing marketplace data.

- [x] **Deals feed — `/marketplace/deals` ✅ SHIPPED (2026-07-13).** Turns the Price Coach from a
  per-item check into a **discovery surface**: reachable available `sell` listings priced at/below their
  category's comp band, ranked by how far under the median they sit. **No migration** (reuses the
  price-coach engine + existing listings). Added `discountVsMedianPercent` + `isDeal` (at/below median
  only) to `lib/marketplace/price-coach.ts` (**+2 tests → 11**). Grid with a **"N% under"** flame badge,
  the verdict, and the "Similar: $X–$Y" range; nav entry (Deals, `Tag`). Verified: tsc · eslint ·
  **vitest (11 coach)** · `next build` (`/marketplace/deals`).

- [x] **All Services → Pin any/ALL services to the sidebar ✅ SHIPPED (2026-07-13).** Owner request +
  bug fix. Two parts:
  - **Bug fix (the visible error toast):** `dashboard_layouts` pin/customize saves threw *"there is no
    unique or exclusion constraint matching the ON CONFLICT specification"* — the 0089 unique indexes are
    **partial** (`WHERE scope=… AND deleted_at IS NULL`), which supabase-js's bare column-list `onConflict`
    can't target. **`0195_dashboard_layout_upsert_constraint.sql`** adds a non-partial
    `UNIQUE NULLS NOT DISTINCT (family_id, user_id, device_context)` index (serves user layouts +
    the family default, which coexist); `saveFamilyDefaultLayoutAction` now upserts on that key.
    PG16-verified (reproduced the exact error, then both upserts succeed + coexist; idempotent ×2).
  - **Feature:** the ⭐ in **All Services** now pins a service to the **sidebar rail itself**
    (`user_preferences.notification_prefs.sidebarNav`, 100% Supabase via `saveSidebarNavAction`), not the
    Home Quick-Access tiles — so pins actually appear in the rail. Keyed by **href**, so **every** in-plan
    service is pinnable (fixes "only a few have the star"), and a **"Pin all in my plan" / "Unpin all"**
    header bulk-pins the member's whole tier. New `ALL_SERVICES_CATALOG` (all tiers, superset of the
    free-only `NAV_CATALOG`) resolves higher-tier pins; the rail **payment-tier-gates** at render
    (`featureAccessByTier`) so a pinned above-plan module shows locked, never a dead link.
    `MAX_SIDEBAR_NAV` raised 20→200; pure `addNavKeys`/`removeNavKeys` helpers (**+5 tests**). Live sync
    across the desktop rail + mobile drawer via the `SIDEBAR_NAV_EVENT` broadcast + localStorage cache.
    Verified: tsc · eslint · **vitest (18 nav-customize)** · `next build`.
  - ⚠️ apply **`0195`** to prod (see `docs/PENDING_PROD_MIGRATIONS.md`) — coupled with this deploy.

### 2. Wallet — "Full family financial OS"  ◐ (already wired)
Has `wallet_cards/passes/rewards` (0113), `/wallet` route, `lib/wallet/*`. Audit confirmed the
surfaces read/write Supabase (10+ `.from()` calls, realtime). Remaining honest gaps:
- [ ] Spending cards / real-time balance (`money-cards-view.tsx`, `child-detail-view.tsx`) say "coming soon" — needs Stripe Issuing (legit future infra; keep honest until it lands).

### 3. Allowance — "AI allowance coaching"  ☑ DONE
Has `allowance_rules`, `lib/wallet/allowance.ts`, `lib/wallet/coach.ts`; surfaced under `/wallet`.
- [x] Confirmed: allowance schedule posts to the immutable ledger (cron `/api/cron/wallet-allowance` →
  `creditChildWallet`, split-allocated, advances `next_run_on`) and the AI coach reads real ledger balances.
- [x] **Parent control added:** `runDueAllowancesAction()` — a "Run due now" banner on `/wallet/allowance`
  (manager-only, Basic-gated, Trust-gated) pays every due rule, idempotent with the cron (no double-pay).
  Pure `dueAllowances(rules, today)` helper (+2 tests) drives the count/total. Was cron-only before.

### 4. AI Concierge — "Become category defining"  ◐ (already wired)
`/dashboard/concierge`, `lib/concierge/digest.ts`; module has 6 `.from()` + realtime. No mock data.
- [x] **Deeper write-back of accepted recommendations ✅ SHIPPED (2026-07-10).** An accepted concierge
  plan now materializes across MORE surfaces than the calendar — **calendar event · reminder · prep
  task** — via `applyConciergePlanAction`, each logged to **`concierge_plan_actions`** (`0158`,
  family-scoped RLS) so the flow is **idempotent** (never double-applies) + auditable. Pure
  `lib/concierge/apply.ts` (`planWriteBacks`/`reminderLeadAt`/`writeBackTitle`, 7 tests); client
  `PlanWriteBacks` "Make it happen" buttons in the plan detail (replaces the calendar-only button).
  Seed `seed_concierge_plan_actions.sql` (500 rows, balanced across the 3 kinds; in `SEED_ALL.sql`).
  Verified: tsc · eslint · **vitest (7)** · `next build`; migration + seed PG16-validated (idempotent).
  ⚠️ apply `0158` to prod.
- [x] **Onboarding deep dive — lifecycle + marketing-signal layer ✅ SHIPPED (2026-07-11).** Deep
  audit of onboarding for new accounts AND accounts needing reset. Found five gaps and closed them:
  (1) the funnel analytics (`lib/analytics/onboarding.ts`) was **missing the `value` step** the wizard
  added — fixed; (2) the `onboardingComplete` flag was **write-only dead data** read nowhere;
  (3) the huge **auto-provisioned cohort** (users `ensureActiveFamily` gives a space to, skipping the
  wizard — no questionnaire/goals/**no marketing profile**) was **invisible** with no path to finish;
  (4) **value-step engagement** (imported? events? time saved — the strongest activation signal) never
  reached marketing; (5) no durable, **segmentable** per-account onboarding record. New
  **`onboarding_progress`** table (`0159`, one row per account, self-scoped RLS) is the queryable
  lifecycle + marketing signal; pure **`lib/onboarding/completeness.ts`** (9 tests) scores completeness
  + flags the needs-setup / needs-reset cohorts; `ensureActiveFamily` now stamps the auto-provision
  cohort, both finalize actions record progress + feed **value engagement / completeness** to the CRM
  contact + `onboarding_completed` automation; new **`/dashboard/setup`** re-onboarding surface (live
  score + what's-left + questionnaire against the EXISTING family — never creates a second one) +
  **`resetOnboardingAction`**. Lifecycle rows now come only from real Auth users;
  the former synthetic-account seed was retired because direct `auth.users`
  inserts violated GoTrue invariants. Verified: tsc · **vitest (20: 9 completeness
  + 11 funnel)**; migration PG16-validated (idempotent ×2; cascade, CHECK, unique,
  trigger, RLS confirmed). ⚠️ apply `0159` to prod.

### 5. Family Memory — "Build persistent family knowledge graph"  ☑ DONE
`/dashboard/family-memory` + `/dashboard/family-knowledge-graph`, `lib/memories/*`.
- [x] Persistent store shipped — **Family Knowledge Base**: migration `0123_family_facts.sql` (family-scoped RLS; sizes/allergies/contacts/preferences/accounts, member-tagged or family-level, pinnable), pure `lib/memory/facts.ts` (8 tests: filter/search/group), `components/modules/knowledge-base-module.tsx` at `/dashboard/knowledge` (search + member/category filters, add/edit/pin/copy/delete). Nav: Family AI OS, `Brain` icon. Validated on PG16; verified tsc/eslint/1637 tests/build. *(The `/dashboard/family-knowledge-graph` visualization can now read this store.)*
- [x] **Learning layer shipped** — the **Family Playbook** (North Star slice 6, see above) mines real household usage into suggested facts the family confirms into this same `family_facts` store. `/dashboard/playbook` + `0126_family_playbook.sql`.

### 6. Voice Control — "Full conversational interface"  ☑ DONE
- [x] `lib/voice/command-router.ts` — wake-word stripping + intent routing → capture kind, reusing `suggestKind`/`parseEvent`. Tests `tests/voice-command-router.test.ts` (12 cases).
- [x] Migration `0121_voice_commands.sql` — family-scoped RLS history log. Validated on PG16 (RLS, 4 policies, check constraint, idempotent).
- [x] `components/modules/voice-module.tsx` — Voice Command Center: `useSpeechRecognition` mic + editable transcript + live routing preview → `saveCapture` (real rows) → logs `voice_commands` → toast w/ Undo. Recent-commands history (realtime) with one-tap re-run + delete. Graceful type-only fallback when Web Speech unsupported.
- [x] Route `/dashboard/voice` + nav (Family AI OS, `Mic` icon; auto-included in NAV_CATALOG / Navigation Choices).
- [x] **Test seed** `supabase/seed_voice_one_family.sql` + `db:seed:voice` — 500 `voice_commands` for the
  target family (task/note/event/shopping + failed/dismissed, ~90 days). Deterministic-UUID idempotency
  (no tag column). Validated on PG16 (500 rows, idempotent re-run). So `/dashboard/voice` history renders full.
- [x] Verified: tsc, eslint, vitest, build.

### 7. Phone Concierge — "AI receptionist for families"  ◐ (already wired)
`/dashboard/front-desk`; module has 8 `.from()` + realtime. Wired.
- [x] **OUTBOUND counterpart — "Bubaly calls FOR you" (closes opportunity-table gap #2: AI makes phone calls on behalf of families).** Full vertical slice, mobile-first, realtime, 100% Supabase:
  - Schema `0173_concierge_calls.sql` — `concierge_calls` (task_kind · callee · goal · details/brief jsonb · full lifecycle status · outcome/transcript/duration/attempts/provider_ref). Family-scoped RLS (4 policies via `is_family_member`), 3 indexes, `set_updated_at`. PG16-verified idempotent ×2.
  - Engine `lib/concierge-calls/brief.ts` — pure `buildCallBrief()` → opening · key points · per-task-kind questions · success criteria · fallback (never throws). **7 tests pass.** Types/labels/tones exported.
  - Types added to `lib/database.types.ts`; server actions `requestCallAction`/`cancelCallAction`/`requeueCallAction` (validated, audited); page `/dashboard/concierge-calls`; module `concierge-calls-module.tsx` (composer + stat tiles + status pills + expandable AI plan + outcomes).
  - Telephony **provider-gated** (`TWILIO_*`): `/api/concierge-calls/place` (CRON_SECRET) places queued calls when a provider is configured, else honestly flips to `action_needed` — usable end-to-end without a phone provider, lights up when one is added.
  - Seed `seed_concierge_calls.sql` (**500 rows**, every task_kind × status, briefs on every row) + added to `SEED_ALL.sql`. Idempotent ×2 on PG16.
  - Linked from **AI Front Desk** (inbound ↔ outbound), no global-nav change (standing rule). Verified tsc/eslint/vitest.

### 8. Email Concierge — "AI inbox management"  ◐ (already wired)
`/dashboard/inbox` Communications Hub; module has 10 `.from()` + realtime. Wired.

### 9. Predictive Planning — "Recommend next best actions"  ◐ (wired via Moments)
`lib/opportunities/deadlines.ts` + Moments engine surface next-best-actions on Home. Wired.
- [x] Dedicated "Next Best Actions" feed page — `lib/opportunities/next-actions.ts` (pure, 7 tests: bucketing overdue→someday, priority tie-break, human reasons) + `components/modules/next-actions-module.tsx` merging real events + open tasks + open opportunities into one ranked worklist at `/dashboard/next-best-actions` (nav: Suggested, `Target` icon). Inline task-complete. No migration (reads existing tables). Verified tsc/eslint/1629 tests/build.

### 10. AI Automation — "Multi-step autonomous workflows"  ◐ (already wired)
`/dashboard/family-automation`, `/dashboard/autopilot`, `lib/autopilot/engine.ts`. Wired.
- [x] #4 Fold ≥90%-confidence moment-prep steps into the Autopilot engine (reversible auto-exec) — `momentPrepSuggestions(snapshot)` in `lib/autopilot/engine.ts` reuses the shared `buildMomentPrep` to emit, for imminent (≤2d) moments, the two SAFE reversible steps at auto-tier: a **leave-by reminder** (conf 92 → reuses the existing `create_reminder` executor) and a **snacks/supplies grocery list** (conf 91 → new reversible `add_groceries` executor in `scan.ts` that inserts grocery_items). Weather/packing/photo stay as on-screen suggestions. 5 new engine tests (36 total). Verified tsc/eslint/1649 tests/build.

### 11. Home Management — "Maintenance and inventory automation"  ◐ (already wired)
`/dashboard/home`, `lib/home/maintenance.ts`, `lib/home/devices.ts`; module has 10 `.from()`. Wired.

### 12. Vehicle Management — "AI maintenance scheduling"  ◐ (already wired)
`vehicles` + `vehicle_registrations/inspections` (0037), `/dashboard/auto/vehicles`, `lib/auto/*`. Wired.

### 13. Family Operating System — "Own this positioning"  (meta)
- [x] Cross-feature cohesion (nav/customization): audited `NAV_CATALOG` (only `minLevel 0` items are customizable in Settings → Navigation Choices). This session's Knowledge Base + Next Best Actions were already free (0); per user decision, **Marketplace + Voice Control lowered to `minLevel 0`** so all four new features are free-tier and selectable in Navigation Choices (the pages were never plan-gated anyway).

---

## ★ "Largest opportunities" table audit (owner screenshot, 2026-07-12)
Compared all 10 opportunities against the codebase. **8 already shipped** (life-admin autopilot ·
knowledge graph · digital twin · verified marketplace · connected services · proactive agents ·
approvals · unified identity — plus AI-drafted replies via inbox `generateReply`). **Gap #2
(outbound AI phone calls)** is now BUILT this session — see roadmap #7 OUTBOUND counterpart above.
- [ ] **Remaining gap #10 — Open developer platform / third-party app ecosystem** (public API, OAuth
  app registration, webhooks-out, marketplace of integrations). This is a **strategic + human-owned**
  decision (API surface, partner program, security review) rather than a single agent-buildable slice —
  surfaced here, not silently built. All the internal engines it would expose are already Supabase-wired.

## ★ "Missing Competitor Features" matrix (owner screenshot, 2026-07-12) — full 28-row audit
Compared every row against the codebase (Cozi/Skylight/FamilyWall/TimeTree/Hearth/Maple/Ohai/
Family Assistant/OurHome benchmark). Verdicts grounded in actual routes/libs, not the table's guesses —
several "No" rows were already built here.

**Already built (table said Partial/No — verified in code):**
| # | Feature | Where it lives |
|---|---|---|
| 1 | Natural-language family planning | ⌘K command bar + `lib/capture` parser + Voice + assistant (create events/reminders/items from one sentence) |
| 2 | Automatic conflict detection | `/dashboard/conflicts` + conflict surfacing in Home/insights |
| 5 | Smart recurring routines | `lib/routines` + habits engine (streaks, adaptive) |
| 6 | School calendar sync | `/dashboard/family-school` + `lib/school` + `lib/sync` providers |
| 7 | Sports league integration | `/dashboard/family-sports` + `lib/sync` (provider adapters) |
| 8 | **Photo-to-calendar** (table said No) | `/dashboard/scan` + `/api/ai/flyer` — AI extracts events from a photographed flyer |
| 9 | Recipe import | `lib/recipes` + `/api/ai/import` |
| 10 | Shared family timeline | Activity feed + memory timeline + social-feed |
| 11 | Widgets | Capacitor + `lib/native` (mobile shell); per-role Home tiles |
| 12 | Large-screen family dashboard | `/dashboard/command-center` (TV/tablet Command Center) |
| 14 | Location arrival/departure automation | `/dashboard/locator` + `lib/location` (geofence triggers) |
| 15 | Smart shopping suggestions | grocery/pantry predictive suggestions (`lib/grocery`, `lib/pantry`) |
| 17 | Travel-time optimization | leave-by engine (`lib/opportunities/deadlines`); ETA API key = open item #6 |
| 18 | Multi-family collaboration | grandparent portal + family-access roles/permissions |
| 20 | Achievements & gamification | goals + streaks + rewards + economy (family-wide milestones live in goals/memory) |
| 21 | Apple/Google deep integration | `lib/google.ts` + `lib/sync/providers/*` + connections hub |
| 22 | Voice-first assistant | `/dashboard/voice` (full conversational, executes actions) |
| 23 | Personalized AI per member | per-member AI profiles/tone (`lib/tone`, agents) + role-aware surfaces |
| 24 | **Household operating metrics** (table said No) | `/dashboard/family-operating-index` (FOI weekly health score) |
| 25 | AI weekly family briefing | `/dashboard/weekly-briefing` + `home_briefs` (0140s) daily brief |
| 26 | **Automatic memory capture** (table said No) | `/dashboard/family-memory` + knowledge graph + on-this-day |
| 27 | **Household digital twin** (table said No) | `/dashboard/family-digital-twin` + `lib/twin` simulation |

**Genuine gaps → BUILT THIS SESSION (2026-07-12):**
- [x] **#3+#4 Household workload balancing + family workload analytics** (Hearth) — `/dashboard/workload`:
  pure engine `lib/workload/balance.ts` (per-member load from chore assignments (est_minutes) + todos +
  events, fairness index, overload flags, human-reason rebalance suggestions), one-tap "Move it" applies the
  reassignment; `workload_snapshots` table (0166) for week-over-week analytics; 500-row seed; linked from Chores.
- [x] **#16 Calendar heat maps** (TimeTree) — `lib/calendar/heatmap.ts` (pure busyness engine over the
  recurrence-expanded events, 0–4 levels, overload detection + advice) + Busyness card in Calendar. No new
  table — rides the already-seeded 500 events.
- [x] **#19 Child independence progression** (Hearth) — `/dashboard/independence`: age-banded milestone
  ladder across 6 domains (chores/money/safety/self-care/school/social), `independence_milestones` (0167),
  pure engine `lib/independence/progression.ts` (suggest-by-age, level compute), accept/achieve actions,
  per-child progress; 500-row seed; linked from Chores + Behavior.

**Remaining gaps (logged, not silently built):**
- [x] **#13 Offline mode — v1 (read-side) SHIPPED** (FamilyWall's headline behavior: "local caching
  with automatic synchronization when connectivity returns"). `lib/offline/cache.ts` (localStorage,
  per-family+table+query keys, 7-day TTL, 200-row cap, quota-safe, 4 tests) wired into
  `useRealtimeQuery` (every realtime module): instant paint from last-known rows, quiet offline
  (no error banner), auto-refetch on the `online` event; global `OfflineBanner` in the app shell
  (offline amber / "back online — syncing" flash); **cache wiped on sign-out** (privacy).
  - [ ] v2 (owner decision still): write-behind queue for offline MUTATIONS + conflict resolution —
    genuinely infrastructural, per-module opt-in.
- [ ] **#28 Family operating system API** — same as opportunity-table #10 (open developer platform):
  strategic + human-owned (public API surface, OAuth app registration, partner security review).

## Other open features (carried from the Friction Backlog / Scorecard)
- [x] #2 Universal ⌘K natural-language command bar — DONE. `lib/command-bar/route.ts` (pure, 8 tests) +
  `components/app/command-bar.tsx` (global palette in app-shell, ⌘K / "/" open, navigate/capture/assistant,
  reuses the Voice/capture parser). See the "⌘K + 💸" handoff block.
- [ ] #6 ETA-based travel buffer for leave-by (needs a maps/ETA API key).
- [x] #9 Admin-mobile table overflow — DONE. Audited every `<table>` under `app/(app)/admin` (27 total):
  14 already wrapped, **13 wrapped** in `overflow-x-auto` + `min-w-[720px]` (admins, users, audit-logs,
  audit, content, security, subscriptions, support-tickets, sync). Class-only; tsc/eslint/build green.
- [x] #7 Time-of-day Home Mission Control — DONE. `lib/home/time-of-day.ts` (pure, 6 tests: dayPhase /
  phaseGreeting / phaseBlurb / focusForPhase) + `components/home/time-of-day-focus.tsx` "Focus now" strip
  at the top of `/home` (morning: schedule/weather/school · night: tomorrow/get-ready/reflect). Additive —
  did not refactor the contended grid. Server-time based (no per-user tz yet).
- [x] #8 Role-tailored surfaces — **slices 1–4 shipped** (2026-07-10): (1) pure `lib/ui/role-surface.ts` (10 tests) —
  `roleSurface(role)` → { density, tone, canManage, focusMax } + `roleGreeting`/`focusHeadline` — applied
  to the Home "Focus now" strip (role-tailored heading + trimmed focus set for kids/guests). (2) **Nav
  management-affordance gating**: `NavItem.manage` + pure `isNavItemVisibleToRole` (4 tests) hide
  manager-only destinations (e.g. Kid Logins) from kids/teens/guests across the primary rail, All
  Services, and mobile tabs (super-admins still see them) — the page guards already redirect those roles,
  so the links were dead-ends. (3) **Density rollout**: pure `focusChipClasses(role)` (3 tests) maps
  `roleSurface().density` → chip sizing, wired into the Home "Focus now" strip — kids ('playful') get
  bigger, rounder, more-tappable chips; adults ('comfortable') keep compact ones; teens/guests ('cozy')
  sit between. Finally consumes the `density` field. (4) **Broader rollout**: the role-tailored
  `roleGreeting` now also leads the **personal dashboard** (parents formal · adults casual · kids a warm
  emoji line), extending the treatment beyond Home to a second primary surface. tsc/eslint/build green.
  **Slice 5 — APP-WIDE density (2026-07-12):** density was per-chip only; now it scales the *whole app*.
  `<RoleDensity/>` (mounted in AppShell) stamps `data-density` on `<html>` from the member's role, and
  a globals.css block scales the root font size (Tailwind rem cascades → text + padding + gaps together):
  parents 100% · teens/guests 104% · kids 110%. Added `resolveDensity` + `DENSITY_FONT_PCT`/labels to
  `lib/ui/role-surface.ts` (+7 tests) and a **Settings → Display comfort** control (`display-comfort.tsx`,
  Auto/Standard/Cozy/Relaxed override, localStorage, instant apply). No migration — client pref + CSS.
- [x] #10 Recurring-routine templates — **DONE**. Migration `0122_routine_templates.sql`
  (`routine_templates` + `routine_template_items`, weekday bitmask, family-scoped RLS) +
  pure `lib/routines/detect.ts` (13 tests: `detectRoutines` finds title+weekday+time repeating
  ≥3 weeks; `materializeRoutine` expands a template → concrete `calendar_events`) +
  `components/modules/routines-panel.tsx` in the calendar right rail (detect → "Save as routine",
  create/edit with weekday toggles + ordered steps, "Apply to this week" with one-tap Undo, delete).
  100% Supabase/realtime. tsc/eslint/**1612 tests**/build green.
- [x] Onboarding → first value (audited + first win): the **PIN step was mandatory** (Continue disabled until a 4-digit PIN matched), forcing every new user through 2 extra fields + validation before reaching the app — even though `completeProfileOnboardingAction` already treats an absent PIN as valid. Made it **"Skip for now"** (defers PIN to Settings → App Lock). Onboarding is now 1 required field (name) → skip → done. *(Onboarding telemetry doesn't fit `journey_events`: no family_id exists until completion — would need an anonymous/pre-family analytics path.)*

## ★ Seed coverage — 500-record test data per feature (2026-07-05)

> **Goal:** every feature testable at volume (≥500 rows). The DB has **354 base tables**;
> most are join/config/derived tables that don't need bulk data. What matters is that every
> **user-facing surface** has a validated, idempotent, paste-ready 500-row seed. All seeds
> below resolve the family by email, are re-runnable (delete-by-sentinel / ON CONFLICT), and
> were validated on a throwaway PG16 (500 rows each, stable across re-runs).

**✅ DONE — secondary user-facing tables now seeded at 500 rows** (all validated on PG16,
idempotent, stable across re-runs):
- [x] Messages — `family_messages` (all kinds) → `seed_messages.sql`
- [x] Chores — `chores` + `chore_assignments` (full status lifecycle) → `seed_chores.sql`
- [x] Meals — `meals` + `family_recipes` + `meal_plans` → `seed_meals.sql`
- [x] Documents — `documents` (categories + expiry + secure) → `seed_documents.sql`
- [x] Location / Safety — `family_places` + `member_locations` + `location_events` → `seed_location.sql`
- [x] Finance hub — `financial_accounts` + `transactions` + `bills` → `seed_finance.sql`
- [x] Memories / trips — `family_memories` + `trip_memories` → `seed_memories.sql`
- [x] Autopilot — `autopilot_suggestions` + `approval_requests` → `seed_autopilot.sql`
- [x] Family Vault — `family_credentials` (all 9 categories, migration 0119 applied + validated) → `seed_vault.sql`

**☑ One-paste master runner:** `supabase/SEED_ALL.sql` runs all 46 seeds in dependency order
(one paste → every surface at ≥500 rows). Idempotent; validated on PG16.

**☑ Validated 500-row seeds (paste-ready in `supabase/`):**

| Feature / surface | Table(s) seeded | File |
|---|---|---|
| Messages | `family_messages` | `seed_messages.sql` |
| Chores | `chores`, `chore_assignments` | `seed_chores.sql` |
| Meals | `meals`, `family_recipes`, `meal_plans` | `seed_meals.sql` |
| Documents | `documents` | `seed_documents.sql` |
| Location / Safety | `family_places`, `member_locations`, `location_events` | `seed_location.sql` |
| Finance hub | `financial_accounts`, `transactions`, `bills` | `seed_finance.sql` |
| Memories / trips | `family_memories`, `trip_memories` | `seed_memories.sql` |
| Autopilot | `autopilot_suggestions`, `approval_requests` | `seed_autopilot.sql` |
| Family Vault | `family_credentials` | `seed_vault.sql` |
| Knowledge Graph / Twin | `graph_entities`, `graph_edges` | `seed_graph.sql` |
| Decision Engine | `family_decisions`, `decision_options` | `seed_decisions.sql` |
| Prep Plans | `prep_plans`, `prep_plan_steps` | `seed_prep_plans.sql` |
| Onboarding funnel | `onboarding_events` | `seed_onboarding_events.sql` |
| Onboarding lifecycle + marketing signal | `onboarding_progress` (real Auth lifecycle rows only) | Production telemetry; no synthetic Auth seed |
| Intelligence Network aggregates | `network_aggregates` (+opts family in) | `seed_network_aggregates.sql` |
| Calendar, To-Dos, Groceries, Notes, Photos, Journal, Habits | `calendar_events`, `todo_items`, `grocery_items`, `notes`, `family_photos`, `journal_entries`, `habits` | `seed_core_content.sql` |
| #1 AI Orchestrator | `family_events`, `family_polls` | `seed_pillar1_orchestrator.sql` |
| #2 Household Twin | `budgets`, `calendar_events`, `family_routines`, `school_classes`, `teams` | `seed_pillar2_twin.sql` |
| #3 Playbook | `family_playbook_suggestions` | `seed_pillar3_playbook.sql` |
| #4 Outcomes launcher | `calendar_events`, `grocery_items`/`grocery_lists`, `todo_items`/`todo_lists` | `seed_pillar4_outcomes.sql` |
| #5/#7 Command Center + Family Operating Index | `family_operating_index` | `seed_pillar5_command_center.sql` |
| #6 Agent roster | `agent_activity` | `seed_pillar6_agents.sql` |
| #8 Design for Calm | `reminders` (due <24h) | `seed_pillar8_calm.sql` |
| #9 Connections / Family API | `family_connections` | `seed_pillar9_connections.sql` |
| Marketplace | `marketplace_listings`, `marketplace_offers` | `lib/marketplace/seed-sql.ts` → `/dashboard/marketplace/seed` |
| Voice Control | `voice_commands` | `seed_voice_one_family.sql` |
| Wallet / Allowance | child ledger | `seed_wallet_ledger_one_family.sql` |

> **Honest note:** seeding + validating *all* 354 tables in one pass isn't feasible — most are
> internal (junction, settings, audit, materialized). The list above covers every table behind a
> real screen. Each remaining item is a 15-min job using the exact pattern in `seed_core_content.sql`.

---

## Dead / stubbed UI to finish or hide
- [ ] **Messages → GIF picker** (FUTURE FOLLOW-UP — needs an external provider key). Stub:
  `components/modules/messages-module.tsx` (~line 876) — the "GIF" button toasts "coming soon".
  **Implementation plan** (code-complete + key-gated, mirror the Family-API pattern):
  1. Pick a provider — **Giphy** or **Tenor** (both have free tiers + search endpoints).
  2. Add the key to env: `GIPHY_API_KEY` (server) — proxy GIF search through a route
     (`app/api/gif/search/route.ts`) so the key never ships to the client.
  3. Build a `GifPicker` popover (query input → grid of results → pick → send as a `family_messages`
     row with `kind: 'image'` + the GIF url, reusing the existing image-message render path).
  4. Graceful fallback: if the key is absent, keep the button disabled with a "not configured" tooltip
     (don't toast "coming soon"). Same honest gating as Connections/OAuth.
  *Blocked only on the key; everything else is agent-buildable when you're ready to green-light a provider.*
- [x] Messages → Voice messages — DONE. `MediaRecorder` in `messages-module.tsx` records a clip → uploads through the existing `sendFile` path (kind `audio`, 25 MB cap + rollback) → renders an inline `<audio controls>` player. Live timer + cancel/discard; graceful "not supported" fallback. 100% Supabase (family-media storage + family_messages row).
- [x] Family page → "Wi-Fi & Passwords" — shipped as the Family Vault: `family_credentials` table + `/dashboard/passwords` (CRUD, mask/reveal/copy, RLS). *(parallel session)*

## Polish / consistency
- [x] Size guard consistency for `documents-module.tsx` + `trip-memories-module.tsx` — both are single-file uploads (no progress bar to add; Supabase JS `upload()` has no progress event). The 25 MB guard already existed in `lib/storage/documents.ts`; exported `DOCUMENT_MAX_BYTES`/`DOCUMENT_MAX_MB`, added **fail-fast pre-checks at file-pick time** in both, and fixed the Documents dropzone's misleading "up to 50 MB" copy → the real 25 MB.
- [x] Journey telemetry pipeline — migration `0124_journey_events.sql` (append-only, family-scoped RLS), pure `lib/analytics/journey.ts` (7 tests: median/summarize/format), client `useJourney(key)` hook (fire-and-forget started/step/completed, errors swallowed), instrumented the **Capture** journey (quick-capture: start on open, complete on save), and a super-admin `/dashboard/journeys` page showing real per-journey completion rate + median time/steps. Instrument more flows by calling `useJourney('key')`. *(Cross-family aggregate medians would need a service-role read.)*

## Standing rules (see /memory.md)
- Do **not** modify the global left navigation for all accounts without explicit instruction. Per-user Navigation Choices customization is fine. (The Marketplace nav entry above was an explicit roadmap build.)

---

## Build log (append as features land)
- **2026-07-08 — One-click demo ("Test Account").** Pricing-page button → a throwaway
  Family+ demo, no signup: `lib/demo/session.ts` provisions a fresh auth user + Family+
  family (plan 'plus') seeded via `lib/demo/seed.ts`, `demo_sessions` (0138) tracks a
  5-min expiry, `startDemoAction`/`endDemoAction` sign in/out, `DemoTimer` countdown
  banner, `/api/cron/demo-cleanup` (+ on-exit + on-expiry) fully deletes the family +
  user so it resets for the next visitor. Pure `lib/demo/config.ts` (4 tests). Each
  click = its own ephemeral family (collision-free). Owner: apply 0138. tsc/eslint/2082/build.
- **2026-07-06 (eve) — onboarding + role-tailoring + a11y run (7 PRs).** #235 onboarding→marketing
  wiring (`crm_contacts` upsert + `onboarding_completed`) & **child logins without email**
  (`0105_child_logins`, synthetic auth user, username+PIN, `/kid-login` + `/dashboard/family-access`).
  #236 role **nav gating** (`NavItem.manage` + `isNavItemVisibleToRole`). #237 marketing header text size.
  #238 role **Focus-strip density** (`focusChipClasses`). #239 **Kid-Logins nudge** on onboarding Done
  (`kidsNeedingLogin`). #240 onboarding progress-bar a11y. #241 **app-wide progress-bar a11y**
  (`lib/ui/a11y.ts::progressBarA11y`, 10 bars). All: tsc/eslint/**1905 tests**/build green.
- **Marketplace** shipped (migration 0120, lib+tests, module, route, nav). Commit `213718d`.
- **Marketplace test seed**: `lib/marketplace/seed-sql.ts` (500 listings + ~290 offers,
  all kinds/statuses, idempotent full-reseed per family) + admin-only screen at
  `/dashboard/marketplace/seed` (Copy SQL button, iPad-friendly). Validated on PG16:
  500 rows, every pending listing has offers, re-run stays 500.
- **Voice Control** shipped (migration 0121, `lib/voice/command-router.ts`+12 tests, `voice-module.tsx`, `/dashboard/voice`, nav). Web Speech → route → real capture rows + `voice_commands` history. Verified: tsc/eslint/1578 tests/build. **+ 500-row `voice_commands` seed** (`seed_voice_one_family.sql` / `db:seed:voice`, PG16-validated).
- **Universal ⌘K command bar** (Friction #2) shipped: `lib/command-bar/route.ts` (pure, 8 tests) + `components/app/command-bar.tsx` (global palette in app-shell; ⌘K / "/" open; navigate/capture/assistant; reuses the Voice/capture parser). 1588 tests / tsc / eslint / build green.
- **Allowance** (roadmap #3) completed: parent-run `runDueAllowancesAction()` + "Run due now" banner on `/wallet/allowance` (idempotent with the cron, Trust+tier gated) + pure `dueAllowances` helper (2 tests). Wallet also gained CSV **statement export** + a 500-row child-ledger seed (`seed_wallet_ledger_one_family.sql`).
- **Time-of-day Home Mission Control** (Friction #7) shipped: `lib/home/time-of-day.ts` (pure, 6 tests) + `components/home/time-of-day-focus.tsx` "Focus now" strip at the top of `/home`, phase-adaptive (morning: schedule/weather/school · night: tomorrow/get-ready/reflect). Additive; 1599 tests / tsc / eslint / build green.
- **Recurring-routine templates** (Friction #10) shipped: migration `0122`, `lib/routines/detect.ts`
  (13 tests), `RoutinesPanel` in the calendar rail (detect → save → apply-to-week w/ Undo). Commit on
  `main` via merge of `claude/routine-templates`. 1612 tests / tsc / eslint / build green.
- **Next up:** all 12 roadmap features built + wired + seeded. Remaining agent-doable Friction Backlog:
  **#8 role-tailored surfaces** (density/language per `family_members.role`; `ui`) · **#4 Autopilot
  self-completion of ≥90%-confidence moment-prep** (`engine`, touches shared `lib/autopilot/*`) · the
  **onboarding time-to-value < 90s** audit. Blocked/human-owned: #6 ETA travel buffer (maps API key),
  Stripe Issuing cards, applying pending prod migrations (0118/0120/0121…) in the Supabase SQL editor,
  per-platform OAuth keys, CI Supabase login for authed e2e. **Recommended next:** #10 recurring-routine
  templates (high value, self-contained `engine` lane) or #8 role-tailored surfaces.

## 🎨 SITE-WIDE UI/UX AUDIT — every dashboard page, graded (2026-07-12, this session)
Method: signal scan of every page + its rendered components (loading/error/empty states,
header, stat tiles, AI layer, realtime, mobile classes, interactivity) + manual review of the
bottom cohort. Tiers: **★★★ world-class** (rich module, full states, stats/AI/realtime,
mobile-first) · **★★ solid production** (wired + stated + clean; missing one premium layer,
usually by design) · **★ upgrade** (thin for its traffic — rebuilt this session) · **↪ redirect**.

| Page | Tier | Notes |
|---|---|---|
| `/dashboard/activity` | ★★ | Server-merged cross-surface feed; wired, clean. Realtime not needed (snapshot feed) |
| `/dashboard/agents` | ★★ | 5/9 signals, 297 LoC UI |
| `/dashboard/announcements` | ★★ | 7/9 signals, 183 LoC UI |
| `/dashboard/app-store` | ★★ | 6/9 signals, 197 LoC UI |
| `/dashboard/assistant` | ★★ | 7/9 signals, 711 LoC UI |
| `/dashboard/auto` | ★★ | 7/9 signals, 258 LoC UI |
| `/dashboard/autonomous-family-management` | ★★ | 6/9 signals, 347 LoC UI |
| `/dashboard/autopay` | ★★ | 6/9 signals, 182 LoC UI |
| `/dashboard/autopilot` | ★★★ | 8/9 signals, 272 LoC UI |
| `/dashboard/behavior` | ★★★ | 8/9 signals, 263 LoC UI |
| `/dashboard/billing` | ★★★ | 8/9 signals, 2237 LoC UI |
| `/dashboard/bills` | ★★ | 6/9 signals, 182 LoC UI |
| `/dashboard/binder` | ★★ | 6/9 signals, 127 LoC UI |
| `/dashboard/briefing` | ★★★ | 8/9 signals, 979 LoC UI |
| `/dashboard/budgets` | ★★ | 7/9 signals, 126 LoC UI |
| `/dashboard/calendar` | ★★★ | 8/9 signals, 905 LoC UI |
| `/dashboard/calm` | ★★ | Calm inbox; engine-driven minimal by design |
| `/dashboard/care` | ★★★ | 8/9 signals, 305 LoC UI |
| `/dashboard/celebrations` | ★★ | 7/9 signals, 156 LoC UI |
| `/dashboard/chores` | ★★★ | 8/9 signals, 787 LoC UI |
| `/dashboard/command-center` | ★★ | TV/large-screen dashboard; wired |
| `/dashboard/concierge-calls` | ★★★ | 8/9 signals, 305 LoC UI |
| `/dashboard/concierge` | ★★★ | 8/9 signals, 644 LoC UI |
| `/dashboard/conflicts` | ★★ | 6/9 signals, 274 LoC UI |
| `/dashboard/connections` | ★★ | 7/9 signals, 167 LoC UI |
| `/dashboard/contacts` | ★★★ | 8/9 signals, 538 LoC UI |
| `/dashboard/decisions` | ★★ | 7/9 signals, 398 LoC UI |
| `/dashboard/dental` | ★★★ | 8/9 signals, 726 LoC UI |
| `/dashboard/devices` | ★★ | 7/9 signals, 139 LoC UI |
| `/dashboard/dining` | ★ | UPGRADE: read-only, zero interactivity, dining_out has NO seed |
| `/dashboard/documents` | ★★★ | 8/9 signals, 678 LoC UI |
| `/dashboard/due` | ★★ | 6/9 signals, 182 LoC UI |
| `/dashboard/expenses` | ★★★ | 8/9 signals, 250 LoC UI |
| `/dashboard/experience` | ★★ | 6/9 signals, 229 LoC UI |
| `/dashboard/family-access` | ★★ | 4/9 signals, 187 LoC UI |
| `/dashboard/family-ai-assistant` | ↪ | Redirects to Assistant (de-dup, by design) |
| `/dashboard/family-automation` | ★★ | 7/9 signals, 468 LoC UI |
| `/dashboard/family-cfo` | ★★ | 4/9 signals, 230 LoC UI |
| `/dashboard/family-coo` | ★★ | 7/9 signals, 480 LoC UI |
| `/dashboard/family-digital-twin` | ★★★ | 8/9 signals, 799 LoC UI |
| `/dashboard/family-emergency` | ★★ | 7/9 signals, 460 LoC UI |
| `/dashboard/family-health` | ★★ | 4/9 signals, 218 LoC UI |
| `/dashboard/family-knowledge-graph` | ↪ | Redirects to Graph (de-dup, by design) |
| `/dashboard/family-memory` | ↪ | Redirects to Memories (R4 de-dup, by design) |
| `/dashboard/family-operating-index` | ★★ | 4/9 signals, 366 LoC UI |
| `/dashboard/family-operations` | ★★ | 4/9 signals, 216 LoC UI |
| `/dashboard/family-school` | ★★ | 4/9 signals, 216 LoC UI |
| `/dashboard/family-signals` | ★★ | Signal cards + ack/dismiss; engine-driven |
| `/dashboard/family-sports` | ★★ | 4/9 signals, 220 LoC UI |
| `/dashboard/family-stress` | ★★ | 7/9 signals, 379 LoC UI |
| `/dashboard/family-tree` | ★★ | 7/9 signals, 422 LoC UI |
| `/dashboard/family` | ★★ | 7/9 signals, 597 LoC UI |
| `/dashboard/favorites` | ★★ | 7/9 signals, 150 LoC UI |
| `/dashboard/focus` | ★★ | 6/9 signals, 165 LoC UI |
| `/dashboard/food` | ★★ | 5/9 signals, 218 LoC UI |
| `/dashboard/front-desk` | ★★★ | 9/9 signals, 769 LoC UI |
| `/dashboard/goals` | ★★★ | 8/9 signals, 246 LoC UI |
| `/dashboard/grandparent-portal` | ★★ | Digest-engine server page; warm + wired |
| `/dashboard/graph` | ★★ | 7/9 signals, 413 LoC UI |
| `/dashboard/grocery` | ★★ | 7/9 signals, 475 LoC UI |
| `/dashboard/habits` | ★★ | 7/9 signals, 405 LoC UI |
| `/dashboard/health` | ★★★ | 8/9 signals, 906 LoC UI |
| `/dashboard/home` | ★★★ | 8/9 signals, 566 LoC UI |
| `/dashboard/homework` | ★★ | 7/9 signals, 281 LoC UI |
| `/dashboard/inbox` | ★★★ | 9/9 signals, 802 LoC UI |
| `/dashboard/independence` | ★★ | 5/9 signals, 251 LoC UI |
| `/dashboard/insurance` | ★★★ | 8/9 signals, 352 LoC UI |
| `/dashboard/intelligence` | ★★ | 6/9 signals, 224 LoC UI |
| `/dashboard/journal` | ★★ | 7/9 signals, 257 LoC UI |
| `/dashboard/journeys` | ★★ | 4/9 signals, 214 LoC UI |
| `/dashboard/kitchen` | ★★ | 7/9 signals, 612 LoC UI |
| `/dashboard/knowledge` | ★★ | 6/9 signals, 249 LoC UI |
| `/dashboard/life-events` | ★★★ | 8/9 signals, 319 LoC UI |
| `/dashboard/locator` | ★★ | 7/9 signals, 533 LoC UI |
| `/dashboard/meals` | ★★★ | 8/9 signals, 821 LoC UI |
| `/dashboard/medical` | ★★★ | 8/9 signals, 913 LoC UI |
| `/dashboard/medications` | ★★ | 7/9 signals, 521 LoC UI |
| `/dashboard/memories` | ★★ | 6/9 signals, 451 LoC UI |
| `/dashboard/messages` | ★★ | 7/9 signals, 1397 LoC UI |
| `/dashboard/migrate` | ★★ | 6/9 signals, 318 LoC UI |
| `/dashboard/moments` | ★★★ | 8/9 signals, 437 LoC UI |
| `/dashboard/money-timeline` | ★★ | Timeline module; wired |
| `/dashboard/more` | ★★ | Deliberate simple links hub (mockup screen 11); premium enough for its job |
| `/dashboard/next-best-actions` | ★★ | 7/9 signals, 196 LoC UI |
| `/dashboard/notes` | ★★★ | 8/9 signals, 513 LoC UI |
| `/dashboard/notifications` | ★★ | 7/9 signals, 270 LoC UI |
| `/dashboard/nutrition` | ★★ | 7/9 signals, 161 LoC UI |
| `/dashboard/onboarding-funnel` | ★★ | 4/9 signals, 253 LoC UI |
| `/dashboard/outcomes` | ★★ | Outcome launcher picker; engine-driven, purposeful |
| `/dashboard/pantry` | ★★★ | 9/9 signals, 318 LoC UI |
| `/dashboard/paperwork` | ★★ | 4/9 signals, 305 LoC UI |
| `/dashboard/passwords` | ★★ | 7/9 signals, 323 LoC UI |
| `/dashboard/payments` | ★★ | 6/9 signals, 100 LoC UI |
| `/dashboard/pets` | ★★★ | 8/9 signals, 419 LoC UI |
| `/dashboard/photos` | ★★★ | 8/9 signals, 615 LoC UI |
| `/dashboard/planning` | ★★ | Server planning surface; wired |
| `/dashboard/playbook` | ★★★ | 9/9 signals, 264 LoC UI |
| `/dashboard/prep-plans` | ★★ | 7/9 signals, 223 LoC UI |
| `/dashboard/profile` | ★ | UPGRADE: thin links menu on a high-traffic surface — no personal stats/identity |
| `/dashboard/readiness` | ★★ | 4/9 signals, 253 LoC UI |
| `/dashboard/reasoning` | ★★ | Unified reasoning view; engine-driven |
| `/dashboard/recipes` | ★★★ | 9/9 signals, 739 LoC UI |
| `/dashboard/relationship` | ★★★ | 8/9 signals, 603 LoC UI |
| `/dashboard/reminders` | ★★★ | 9/9 signals, 897 LoC UI |
| `/dashboard/renewals` | ★★ | 7/9 signals, 295 LoC UI |
| `/dashboard/rewards` | ★★★ | 8/9 signals, 343 LoC UI |
| `/dashboard/rides` | ★★ | 7/9 signals, 327 LoC UI |
| `/dashboard/savings` | ★★ | 7/9 signals, 148 LoC UI |
| `/dashboard/scan` | ★★ | 6/9 signals, 203 LoC UI |
| `/dashboard/school` | ★★★ | 9/9 signals, 653 LoC UI |
| `/dashboard/screen-time` | ★★★ | 8/9 signals, 244 LoC UI |
| `/dashboard/security` | ★ | UPGRADE: bare CRUD event list — no stat tiles, no severity summary, no AI |
| `/dashboard/settings` | ★★ | 6/9 signals, 464 LoC UI |
| `/dashboard/setup` | ★★ | 7/9 signals, 378 LoC UI |
| `/dashboard/signups` | ★★★ | 8/9 signals, 320 LoC UI |
| `/dashboard/social-feed` | ★★ | 7/9 signals, 448 LoC UI |
| `/dashboard/social` | ★★ | 7/9 signals, 333 LoC UI |
| `/dashboard/sports` | ★★★ | 9/9 signals, 468 LoC UI |
| `/dashboard/subscriptions` | ★★★ | 8/9 signals, 176 LoC UI |
| `/dashboard/sync` | ★★ | 5/9 signals, 218 LoC UI |
| `/dashboard/tax-vault` | ★★ | 6/9 signals, 165 LoC UI |
| `/dashboard/timetable` | ★★ | 7/9 signals, 261 LoC UI |
| `/dashboard/todos` | ★★★ | 8/9 signals, 677 LoC UI |
| `/dashboard/trip-intel` | ★★ | 6/9 signals, 739 LoC UI |
| `/dashboard/trip-memories` | ★★ | 7/9 signals, 192 LoC UI |
| `/dashboard/trips` | ★★ | 7/9 signals, 425 LoC UI |
| `/dashboard/trust` | ★★ | 7/9 signals, 848 LoC UI |
| `/dashboard/utilities` | ★★★ | 8/9 signals, 211 LoC UI |
| `/dashboard/vacations` | ★★★ | 8/9 signals, 204 LoC UI |
| `/dashboard/voice` | ★★ | 6/9 signals, 254 LoC UI |
| `/dashboard/voting` | ★★ | 6/9 signals, 354 LoC UI |
| `/dashboard/weather` | ★★ | 7/9 signals, 335 LoC UI |
| `/dashboard/weekend` | ★★★ | 8/9 signals, 271 LoC UI |
| `/dashboard/weekly-briefing` | ★★ | 7/9 signals, 443 LoC UI |
| `/dashboard/wishlists` | ★★★ | 8/9 signals, 256 LoC UI |
| `/dashboard/workload` | ★★ | 5/9 signals, 289 LoC UI |

**Tally:** 43 world-class · 87 solid-production · 3 upgraded this session · 3 redirects.

**Upgrades built this session (all with 500-seed where a table backs them):**
- [x] **Profile** → premium identity surface: avatar hero, personal stats (points, chores done,
  streak, upcoming events), theme toggle + quick links preserved.
- [x] **Security** → stat tiles (open/critical/7-day), severity timeline styling, AI-style rollup
  headline from `summarizeSecurity`; CRUD preserved.
- [x] **Dining Out** → interactive: favorite toggle + log-a-visit (server actions), stat tiles,
  `seed_dining_out.sql` (500 rows: restaurants + visits).

### 🎨 Audit second pass — ★★/★ upgrade sweep (2026-07-12, same session)
Owner directive: upgrade every ★/★★ page. Every low-scoring page was manually re-reviewed:
- [x] **Payments** (`/dashboard/payments`) — UPGRADED: "this month" stat tiles (in/out/net/count,
  computed from the unfiltered set so search doesn't wobble them) + per-month subtotals on the
  history headers. Realtime + filters preserved.
- [x] **Family Intelligence** (`/dashboard/family-signals`) — UPGRADED: at-a-glance strip
  (active patterns · avg confidence · most-common kind · handled count) above the signal cards.
- **Re-graded ★★→★★★ on manual review** (the signal scan under-scored engine-driven server pages —
  each verified fully Supabase-wired with real states/design): `outcomes` (live urgency counts +
  reasoning insights), `reasoning` (6-question live engine + daily snapshot), `calm`
  (5-table inbox; minimal ON PURPOSE — its design brief is "does not maximize engagement", so no
  tiles were added), `grandparent-portal` (digest engine, photos/milestones/celebrations),
  `family-*` shell pages (share the premium StatTile/SectionCard/ScoreRing primitives in
  `components/family/shell.tsx`), `activity` (7-table merged feed), `dining`/`profile`/`security`
  (rebuilt earlier this session).
- **Left ★★ by design** (verified, do NOT chrome-inject): `more` (menu mockup), binder/devices/
  focus/tax-vault (grouping/reveal/status-cycling already present), finance re-export routes.

### 🪨 Full stone-turn pass (2026-07-12, late) — build + links + auth + scoping
- `next build` production build: **PASS** (exit 0, all 136+ routes compile).
- Dead-link sweep (172 distinct internal hrefs): 2 dead → fixed (`/dashboard/routines` →
  `/dashboard/calendar` in moments/prep engines; `/dashboard/shopping` → `/dashboard/grocery`).
- **API auth audit (95 routes): 4 real security fixes.** (1–2) `guardian/screen` +
  `guardian/status/voicemail` Twilio callbacks accepted unsigned requests (inbound trio validated,
  these didn't) → now validate `x-twilio-signature` in production, full-URL-with-query form.
  (3) `guardian/escalate` **failed open** when `GUARDIAN_INTERNAL_SECRET` unset — could blast
  emergency SMS/calls to every parent → fails closed (secret or CRON_SECRET required; no internal
  callers broken — verified none exist yet). (4) `guardian/escalate/twiml` was an open
  text-to-TwiML reflector → Twilio-signature-gated. Plus `mkt/track` (service-role public ingest)
  had NO rate limit while every sibling tracker did → 60/min/IP.
- Family-scoping audit (all client `.from().select()` chains): 11 flagged, all verified safe
  (child-record lookups by parent id, RLS backstop). No fixes needed.
- Stub sweep: no console.log leftovers; remaining TODO(keys) are documented key-gated integration
  points (Google/Gmail adapters), by convention.

### 🔗 Open-item #3 build-out — provider calendar two-way sync (2026-07-12, latest)
Everything up to the OAuth keys is now COMPLETE — adding keys lights it up with zero code changes:
- [x] **Provider-generic OAuth routes** `/api/sync/[provider]/auth|callback|disconnect` — registry-
  driven (R9), so **Microsoft connects end-to-end today** (its adapter pointed at a callback that
  didn't exist) and future adapters need zero route work. State bound to the live session; tokens
  AES-256-GCM via `connectAccount`; fails closed without `SYNC_TOKEN_KEY`; disconnect revokes at the
  provider (best-effort) + 303 redirect. Google's original static routes untouched.
- [x] **Scheduled background sync** `/api/cron/provider-sync` (CRON_SECRET, every 4h in vercel.json):
  oldest-synced accounts first, bounded batch of 25, per-account audit rows — manual "Sync now"
  becomes real continuous two-way sync.
- [x] **UI** — Microsoft Connect button (was missing); generic `ProviderControls` (Sync now via
  provider-agnostic `/api/sync/run` + Disconnect) for any adapter provider; **honest key-gating**:
  when keys are missing the Connect button is replaced by an amber "fully built, waiting on
  MICROSOFT_SYNC_CLIENT_ID/SECRET" notice (registry `isProviderConfigured`).
- [x] **Env-doc bug fixed**: `.env.example` documented `MICROSOFT_CLIENT_ID/SECRET/TENANT_ID` +
  `/api/microsoft/callback` — variables NOTHING reads and a route that doesn't exist. Now documents
  the real `MICROSOFT_SYNC_*` vars + exact callback path; `*_SYNC_REDIRECT_URI` env override
  honored on both OAuth legs (proxy/custom-domain safe).
- Verified: 71 sync tests + full suite 2400 green; tsc/eslint clean; production build passes.
- **Owner keys to flip it live**: `SYNC_TOKEN_KEY`, `GOOGLE_SYNC_CLIENT_ID/SECRET`,
  `MICROSOFT_SYNC_CLIENT_ID/SECRET` (+ register the exact callback URIs), `CRON_SECRET`.
  Apple stays honestly CalDAV/ICS-guided; Alexa stays ICS one-way (documented in capabilities).

### 💳 Open-item #5 build-out — Stripe Issuing cards + real-time balances (2026-07-12, latest)
Deep audit verdict: the pipeline was already MUCH deeper than the table said — real-time
authorization gate (atomic reserve against the child's Spend bucket), capture/release handlers,
idempotent webhook route, capability resolver, and a 3-mode honest Cards UI all shipped. Genuine
stones found + fixed this pass:
- [x] **Auth-decision unit tests were MISSING** (code claimed "unit-tested separately" — no test
  existed): `tests/stripe-issuing-auth.test.ts` (7 tests — approve within balance, decline on
  inactive/frozen/blocked-category/insufficient, exact-balance edge, status-outranks-balance,
  unknown-merchant-category safety; plus the precheck's short-circuit parity).
- [x] **PAN reveal was promised but not built** (issuing.ts header: "parents reveal full details
  via an ephemeral Stripe.js session" — nothing existed): `prepareCardRevealAction` +
  `createCardRevealAction` (manager-gated, family-scoped, capability-gated, audited to
  wallet_audit_logs) + `CardRevealModal` (Stripe.js v9 Issuing display Elements — nonce →
  ephemeral key → number/expiry/CVC render in Stripe-hosted iframes; the PAN never touches our
  servers) + a Reveal button on every card row.
- [x] **Stale "Coming soon · real-time balance check"** on the child virtual card → now links to
  /wallet/cards with honest live-gate copy (the Spend balance shown IS what authorizations check).
- [x] **`STRIPE_MONEY_WEBHOOK_SECRET` was undocumented** in .env.example (the money webhook reads
  it; falls back to STRIPE_WEBHOOK_SECRET) → documented with the /api/webhooks/money endpoint note.
- Verified: 2411 tests green (7 new), tsc/eslint clean. Wallet balances already realtime
  (useRealtimeQuery on accounts/txns/cards).
- **Owner to flip live**: enable Issuing on the platform account, switch the
  stripe_issuing_enabled / stripe_connect_enabled feature flags, point a second webhook at
  /api/webhooks/money (secret above). Everything else is done.

### 📋 Master autonomous-build prompt — execution record (2026-07-13)
Owner supplied the full-platform "MASTER AUTONOMOUS BUILD PROMPT". Most phases were already
executed across this session's lanes with evidence (Phases 1–2: 136-page audit + competitor
matrices; Phase 3: mobile-first throughout; Phase 5: AI layers incl. the parallel lane's AI-Assist
batches + paperwork draft-reply (verified on main); Phase 6: Supabase wiring + RLS model (0118
universal enable + family policies); Phase 12: security passes; Phase 13/19: build/tsc/eslint/
vitest enforced per push). This pass closed the prompt's outstanding requirements:
- [x] **Documentation ledger created (10 files, grounded, generated from the repo where possible):**
  `route-inventory.md` (348 page routes w/ access class), `database-map.md` (418 tables w/ the
  correct 0118 universal-RLS model), `feature-inventory.md` (133 features → direct table deps),
  `architecture.md`, `security-review.md` (consolidated fixes + residual risks),
  `production-readiness.md` (green-locally vs human-owned launch gate), `testing-plan.md`
  (coverage + the 3 honest gaps: E2E, RLS-as-CI, visual regression), `user-journeys.md`,
  `audit.md` (pointer ledger), `change-log.md` (65 session commits).
- [x] **Final-validation anti-pattern sweep re-run on the merged tree**: clean — no TODO/FIXME
  beyond documented TODO(keys) adapter markers, no "not implemented"/mock/fake in prod paths,
  no console.log leftovers, no committed secrets (the one `sk_live_` hit is an input placeholder).
- [x] **Fixed a CI-blocking type error a parallel lane introduced**: `vitest.config.ts` carried an
  `oxc` key that isn't in this Vitest version's types — every `tsc --noEmit` failed. Removed
  (inert: the test glob is .ts-only); 2508 tests still green.
- Honest deferrals per the prompt's own priority rules: E2E suite (needs CI Supabase login —
  open item #24), RLS CI matrix, visual regression — scoped in `testing-plan.md`.

### ✅ Open-item #2 (Chief-of-Staff proactive front door) — VERIFIED COMPLETE (2026-07-13)
The opportunities-table screenshot was stale: this is fully built as **R5** and shipping on Home.
Verified end-to-end, not rebuilt:
- Engine `lib/home/front-door.ts` (`buildFrontDoor` + `mergeHandled`) assembles autopilot
  auto-executed actions + specialist-agent completed actions ("Done for you") and pending
  approvals ("Waiting on you") into one warm greeting. **11 tests pass.**
- `FrontDoorHero` renders on `/home`; `pending-approvals.tsx` calls the REAL
  `decideApprovalAction` (manager-gated + re-enforced server-side) — one-tap Approve/Decline in
  place; "Done for you" links to Autopilot for review/undo.
- Small connective add this pass: a "See everything in Calm →" link from the hero to the deeper
  quiet inbox (`/dashboard/calm`), so the home assembly leads onward to the full surface.
Net: every 4–5 star agent-buildable item on the owner's open-items table is now built. Remaining
items are human-owned (keys/OAuth/Issuing/CI Supabase login) or large greenfield strategic bets
(open developer platform), all logged.
- Honest deferrals per the prompt's own priority rules: E2E suite (needs CI Supabase login -
  open item #24), RLS CI matrix, visual regression - scoped in `testing-plan.md`.

---

## 2026-07-13 Autonomous Audit Session

This section is an additive execution ledger for the current repository-wide audit. Existing
roadmap entries and user worktree changes are preserved.

### Audit Metadata

- Audit started: 2026-07-13T08:42:01-04:00
- Repository: FamilyOS
- Branch: `codex/world-class-production`
- Commit at audit start: `3fd3ab9` (`remove unsafe synthetic auth seeds`)
- Environment: Windows workspace, Next.js 15, Node/npm project
- Supabase project: configured through environment; live credentials intentionally not recorded
- Auditor: Codex
- Overall status: CONDITIONAL GO pending validation and external-environment checks
- Critical blockers remaining: unknown until full validation completes
- High-priority issues remaining: unknown until full validation completes
- Medium-priority issues remaining: unknown until full validation completes
- Low-priority issues remaining: unknown until full validation completes

### Initial Worktree Safety Record

- [x] Existing `todo.md` found and extended rather than replaced.
- [x] Existing user changes preserved: `supabase/SEED_ALL.sql`, `supabase/seed_network_aggregates.sql`,
  and untracked `tests/seed-data-safety-contract.test.ts`.
- [x] No production data, users, storage objects, migrations, or secrets were modified by audit setup.

### Inventory Snapshot

- 348 `page.tsx` route files.
- 196 Supabase migration files and 313 SQL files under `supabase`.
- 305 test files after the audit's regression contracts.
- 2,054 repository files returned by the initial source inventory (excluding node_modules, dist, and build).
- Detailed route, database, feature, architecture, security, testing, and journey inventories already
  exist in the root documentation and will be reconciled with this session's command evidence.

### Open Audit Items

- [~] Run typecheck, lint, unit tests, production build, dependency audit, and static searches.
- [ ] Verify route/API/feature coverage against the current tree.
- [ ] Review Supabase migrations, RLS/policy coverage, storage declarations, RPCs, triggers, and client usage.
- [ ] Repair safe defects found by the current validation pass.
- [ ] Produce the required uppercase production reports and deployment checklist.
- [ ] Perform live Supabase, authenticated browser, RLS attack, and deployment checks where credentials/services
  are available; document any unavailable checks as blockers.

### TODO-0178 - Marketplace circles RLS recursion

- Status: [x] Completed in code; live migration application and post-migration probe pending.
- Severity: P1
- Category: Database authorization / reliability
- Feature: Cross-family marketplace circles
- Route: `/marketplace`
- File or files: `supabase/migrations/0176_marketplace_circles.sql`, `supabase/migrations/0178_marketplace_circles_rls_recursion.sql`
- Database objects: `marketplace_circles`, `marketplace_circle_members`, `marketplace_listing_shares`, related RLS policies
- Affected roles: Authenticated family members using circles
- Description: Production REST access to `marketplace_circles` returned PostgreSQL `42P17` because the
  `marketplace_circle_members` SELECT policy queried the same table directly. Related policies also
  depended on that recursive path.
- User impact: Circle discovery and any related listing feed could fail with HTTP 500.
- Security or privacy impact: The failure blocked access rather than broadening access, but the policy
  design was not safely verifiable until recursion was removed.
- Root cause: Direct membership-table subqueries inside RLS policies on the membership table and related tables.
- Required remediation: Apply migration `0178_marketplace_circles_rls_recursion.sql`, then rerun the schema
  probe and authenticated cross-family allow/deny tests in an isolated Supabase environment.
- Implementation notes: Added stable SECURITY DEFINER helpers with pinned `search_path`; preserved active
  family membership checks; tightened share delete to the owning family/listing.
- Test plan: Contract test plus local Supabase migration/RLS tests; live non-destructive REST probe after deploy.
- Tests performed: `tests/marketplace-circles-rls.test.ts` added; typecheck, lint, unit suite, and build rerun after patch.
- Evidence before fix: `marketplace_circles` REST probe returned HTTP 500, code `42P17`, message
  `infinite recursion detected in policy for relation "marketplace_circle_members"`.
- Resolution: Additive migration and regression contract are present. Production resolution is not claimed
  until the migration is applied and the live probe returns successfully.
- Follow-up evidence: `npm.cmd run db:audit:schema` passed, and anonymous REST probes for
  `marketplace_circles`, `marketplace_circle_members`, and `marketplace_listing_shares` each returned
  HTTP 200 on 2026-07-13. Authenticated cross-family allow/deny testing and migration-history
  verification still require an authorized isolated environment.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0195 - Notification and test-push routes lacked request budgets

- Status: [x] Completed in code and covered by the shared limiter regression tests.
- Severity: P1
- Category: Notification delivery abuse resistance / external side effects
- Feature: Family notification refresh and push testing
- Routes: `/api/notifications/generate`, `/api/push/test`
- File or files: the two route handlers, `lib/server/request-rate-limit.ts`,
  `tests/ai-rate-limit.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`, `notifications`, `push_devices`
- Description: Authenticated notification refresh could generate and dispatch up to 200 pending rows
  repeatedly, while test push could fan out to every registered device without request limits.
- User impact: Runaway clients could spam devices, repeat provider calls, and create avoidable database work.
- Root cause: The routes relied on authentication but predated the shared side-effect limiter.
- Resolution: Added family-scoped 10-request-per-minute notification refresh limits and user-scoped
  5-request-per-minute test-push limits, with `Retry-After` responses before fan-out.
- Tests performed: Shared limiter regression passed; full suite, typecheck, lint, build, and public E2E remain
  release gates. Durable enforcement depends on migration `0156` in production.
- Verified by: Codex
- Date completed: 2026-07-13

### Audit Closeout Evidence (2026-07-13)

- [x] Typecheck: `npm.cmd run typecheck` passed.
- [x] Lint: `npm.cmd run lint` passed with only the known Next.js `next lint` deprecation notice.
- [x] Unit tests: `npm.cmd test` passed, 305 files and 2,554 tests.
- [x] Credential-safety regression: all seed scripts load access only from environment; no literal
  `sb_secret_*` credential remains in runtime/source SQL.
- [x] Production build: `npm.cmd run build` passed; 233 static pages generated.
- [x] Public E2E: 51 passed, 1 intentional authenticated-test skip.
- [x] Public accessibility: dark/light axe checks passed with no serious/critical violations.
- [x] Public responsive overflow: 320/390/768/1024 width checks passed.
- [x] Seed TLS safety and marketplace RLS contract tests passed.
- [x] Required reports created: `PRODUCTION_READINESS_REPORT.md`, `SUPABASE_AUDIT.md`,
  `TEST_EVIDENCE.md`, and `PRODUCTION_DEPLOYMENT_CHECKLIST.md`.
- [x] Live marketplace table probes passed: required schema audit plus all three related REST endpoints
  returned HTTP 200; authenticated cross-family RLS attack tests remain pending.
- [!] Live Auth Admin probe remains blocked by Supabase HTTP 500.
- [!] Local migration/RLS validation remains blocked until Docker Desktop is available.
- [x] Dependency audit passes with 0 vulnerabilities after the scoped nested PostCSS override.

- [x] Added `supabase/seed_production_readiness.sql`, an idempotent 600-record independence-ladder
  dataset with a contract test and no destructive/Auth writes.

### TODO-0183 - Supabase service credential exposed in seed history

- Status: [!] Repository repair complete; external key rotation blocked by Supabase permissions.
- Severity: P0
- Category: Credential exposure / incident response
- Feature: Seed tooling
- File or files: Historical `scripts/seed-notifs.mjs` and related seed bootstraps; current fix is
  `scripts/seed-client.mjs` plus `tests/seed-credentials-safety.test.ts`.
- Description: A historical seed script embedded a live `sb_secret_*` credential. A local comparison
  confirmed that credential matched the currently configured `SUPABASE_SERVICE_ROLE_KEY`.
- Security impact: Anyone with repository history could potentially use the service credential to bypass
  RLS and access or modify Supabase data.
- Resolution in code: Removed embedded Supabase URLs and credentials from all seed scripts. Scripts now
  require `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the environment.
  Added a regression test that rejects literal clients, project URLs, and secret-key patterns.
- Required external remediation: A Supabase project owner must revoke/rotate the exposed key, review
  audit logs for its use, update deployment/local environment variables, and invalidate any old copies.
- Evidence: `npx supabase projects api-keys --project-ref ltcxlbipiihclxwioyqj` returned HTTP 403 due to
  insufficient project privileges; rotation was not performed by this agent.
- Launch impact: NO-GO until key rotation and log review are complete.

### TODO-0179 - Supabase Auth Admin users probe returns 500

- Status: [!] Blocked on external Supabase service diagnosis.
- Severity: P1
- Category: Authentication / operations
- Feature: Admin user inventory
- Route: `/admin/users`
- File or files: `scripts/audit-supabase-auth.mjs`, `app/(app)/admin/users/page.tsx`
- Database objects: Supabase Auth `auth.users` / GoTrue Admin API
- Affected roles: Super administrators
- Description: The configured live project reports HTTP 500 `Database error finding users` for
  `GET /auth/v1/admin/users?page=1&per_page=1` with the service-role key.
- User impact: Admin user listing and the Auth audit cannot be verified against the live project.
- Root cause: Not determinable from repository code; the response includes a Supabase error id and no SQL detail.
- Required remediation: Supabase owner should inspect GoTrue/Postgres logs for the returned error id,
  verify `auth.users` health, and rerun the probe after repair.
- Tests performed: Public Auth health probe passed; Admin users probe failed with HTTP 500.
- Evidence: `019f5b84-d42e-7354-9db9-89b9460d2921` from the live probe at audit time.

### TODO-0180 - Production Supabase migration state is incomplete

- Status: [!] Blocked pending deployment authorization and migration application.
- Severity: P1
- Category: Deployment / database
- Feature: Latest schema and RLS
- Description: The repository contains additive repairs through `0185`, while the configured live schema
  probe still fails on the required `0182` object. The repository cannot safely claim
  that production has every migration applied without running the migration deployment process.
- Required remediation: Apply pending migrations through `0185` in the intended deployment environment,
  run the schema/auth probes, then run isolated RLS allow/deny tests. No destructive production operation
  was performed by this audit.

### TODO-0181 - Dependency audit reports unresolved PostCSS advisory

- Status: [x] Completed with a scoped dependency override.
- Severity: P2
- Category: Dependency security
- Feature: Build dependency chain
- Description: Next.js 15.5.19 pins a vulnerable nested PostCSS 8.4.31 package, while npm's suggested
  downgrade to Next 9.3.3 is an unacceptable breaking change.
- Resolution: Added a scoped `package.json` override and lockfile entry for nested PostCSS `8.5.10`;
  the supported Next.js 15 runtime remains unchanged.
- Tests performed: npm lockfile reconciliation, `npm audit --omit=dev --audit-level=moderate`, full
  Vitest, typecheck, lint, production build, and public Playwright/axe E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0182 - Seed scripts disabled TLS verification

- Status: [x] Completed and covered by regression test.
- Severity: P2
- Category: Security / developer tooling
- Feature: Remote seed scripts
- File or files: `scripts/seed*.mjs`
- Description: Six seed scripts set `NODE_TLS_REJECT_UNAUTHORIZED=0`, disabling certificate
  verification for every outbound request in the process.
- User impact: A remote seed run could expose Supabase credentials to a man-in-the-middle.
- Resolution: Removed the process-wide TLS bypass from all seed scripts; normal Node certificate
  validation now applies. Added `tests/seed-tls-safety-contract.test.ts`.
- Tests performed: Targeted contract test, typecheck, lint, and full suite after the repair.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0184 - Legacy seed scripts used fixed household scope and unsafe fallbacks

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Production data safety / seed tooling
- Feature: Legacy JavaScript seed scripts
- File or files: `scripts/seed*.mjs`, `scripts/seed-client.mjs`,
  `tests/seed-credentials-safety.test.ts`, `tests/seed-scope-safety.test.ts`, `.env.example`
- Description: Multiple service-role seed scripts embedded a fixed family ID, creator ID, and
  member-ID fallbacks. A script could therefore be pointed at a different Supabase project and
  still attempt to mutate the wrong household or silently attach records to a fallback member.
- User impact: An operator mistake could write synthetic or sensitive fixture data into an unintended
  family, and the medical seed script also performs family-scoped cleanup before inserting fixtures.
- Security or privacy impact: The service-role key bypasses RLS, so URL-only targeting was insufficient
  protection against cross-household mutation.
- Root cause: Seed scope was encoded in source rather than confirmed at invocation time; missing
  members fell back to stale UUIDs in older scripts.
- Resolution: All six legacy seed scripts now require `requireSeedScope()`. The shared guard requires
  `SEED_ENVIRONMENT` to be local/test/preview/staging, validates `SEED_FAMILY_ID` and
  `SEED_CREATED_BY_USER_ID`, requires an exact `SEED_CONFIRM_FAMILY_ID` match, and rejects production.
  Member lookups now fail closed instead of falling back to fixed IDs.
- Tests performed: `node --check` for every `scripts/seed*.mjs`; focused Vitest suite passed with
  2 files and 3 tests; typecheck and lint passed. Static scan found no former fixed family/user IDs.
- Evidence: `tests/seed-credentials-safety.test.ts` requires the scope guard and rejects the legacy
  identifiers; `tests/seed-scope-safety.test.ts` proves production and mismatched confirmations fail.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0185 - Inactive public gift links disclosed household names

- Status: [x] Completed in code and covered by regression test.
- Severity: P1
- Category: Privacy / public capability links
- Feature: Public gift links
- Route: `/gift/[token]`
- File or files: `app/gift/[token]/page.tsx`, `tests/public-gift-privacy-contract.test.ts`
- Database objects: `gift_links`, `child_wallets`, `family_members`, `families`
- Description: The public gift page used the service-role client to resolve child and family names
  before checking whether the gift link was active. A revoked or expired token could therefore
  disclose identifying household information even though pledges were blocked.
- User impact: Someone holding an old or revoked gift URL could still see the associated child and
  family name.
- Security or privacy impact: Public capability revocation was incomplete; inactive links retained
  an information-disclosure path.
- Root cause: The `active` decision was made after identifying lookups instead of guarding them.
- Resolution: The page now computes `active` immediately after loading the link and performs all
  child/family lookups only when the link is active. Inactive and invalid links render generic names
  and the existing inactive-link message.
- Tests performed: `npm.cmd test -- tests/public-gift-privacy-contract.test.ts` passed; typecheck and
  lint passed. The contract proves all identifying lookups are behind the active-link guard.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0186 - Guardian screening callbacks accepted stale turn values

- Status: [x] Completed in code and covered by regression test.
- Severity: P1
- Category: Reliability / replay resistance / AI cost control
- Feature: Guardian AI call screening
- Route: `/api/guardian/screen`
- File or files: `app/api/guardian/screen/route.ts`, `lib/guardian/screening-turn.ts`,
  `tests/guardian-screening-turn.test.ts`
- Database objects: `guardian_screening_sessions`, `guardian_communications`, `notifications`
- Description: A validly signed Twilio callback was accepted based only on the session's active
  status. Replayed, stale, skipped, or over-limit `turn` values could rerun screening work and
  duplicate state changes or family notifications.
- User impact: A caller session could produce repeated AI responses, duplicate notifications, or
  inconsistent conversation history when Twilio retried or callbacks arrived out of order.
- Security impact: Twilio signature validation authenticates the provider but does not itself provide
  application-level replay or ordering protection.
- Root cause: The callback did not enforce the persisted session turn as the next bounded turn.
- Resolution: Added `isNextScreeningTurn` and reject any turn other than `current + 1`, including
  malformed values and turns beyond the five-turn limit, before AI work and additional service-role
  reads. Existing Twilio signature validation remains in place.
- Tests performed: Focused guardian and gift regression tests passed; typecheck and lint passed.
- Evidence: `tests/guardian-screening-turn.test.ts` covers initial/sequential acceptance, stale and
  skipped rejection, maximum-turn rejection, and malformed input rejection.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0187 - Public A/B events accepted fabricated variants

- Status: [x] Completed in code and covered by regression test.
- Severity: P2
- Category: Analytics integrity / public write validation
- Feature: A/B experiment event ingestion
- Route: `/api/ab/track`
- File or files: `app/api/ab/track/route.ts`, `lib/marketing/ab.ts`, `tests/marketing-ab.test.ts`
- Database objects: `ab_experiments`, `ab_events`
- Description: The public event endpoint verified that an experiment was running but trusted the
  submitted `variant` string. A caller could create fabricated variant rows and conversion metrics
  that polluted admin experiment results.
- User impact: Experiment dashboards could show inaccurate exposure, conversion, and significance data.
- Security impact: The service-role ingestion path accepted untrusted identifiers without validating
  them against the experiment definition.
- Root cause: The endpoint selected only experiment status and never inspected configured `variants`.
- Resolution: The endpoint now selects the experiment variants, accepts only configured variant keys,
  and rejects oversized experiment, variant, or visitor identifiers before inserting events.
- Tests performed: `npm.cmd test -- tests/marketing-ab.test.ts` passed with 9 tests; typecheck and lint
  passed. The pure helper covers valid, fabricated, malformed, and missing variant definitions.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0188 - Public consent endpoint lacked abuse bounds

- Status: [x] Completed in code and covered by regression test.
- Severity: P2
- Category: Public API abuse resistance / data retention
- Feature: Visitor consent management
- Route: `/api/mkt/consent`
- File or files: `app/api/mkt/consent/route.ts`, `lib/marketing/consent.ts`,
  `tests/marketing-consent-safety.test.ts`
- Database objects: `mkt_consent_events`
- Description: The unauthenticated consent POST appended immutable rows without a rate limit and
  iterated an unbounded caller-supplied object. The GET path also had no request limit.
- User impact: Automated callers could generate unnecessary consent rows and database work without
  affecting a legitimate visitor's consent state.
- Security or privacy impact: The service-role write path lacked the same public-ingestion controls
  used by other analytics endpoints.
- Root cause: Consent was treated as a low-volume browser-only path and did not use the shared limiter
  or a strict payload contract.
- Resolution: Added IP-based fixed-window limits (30 POST and 60 GET requests per minute), `Retry-After`
  responses, and strict validation for a finite map of known boolean categories only.
- Tests performed: Focused consent/A-B tests passed with 10 tests; typecheck and lint passed.
- Evidence: `tests/marketing-consent-safety.test.ts` rejects unknown categories, non-boolean values,
  oversized maps, and null payloads.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0189 - Agentic AI chat lacked request budget and input bounds

- Status: [x] Completed in code and covered by regression test.
- Severity: P1
- Category: AI cost control / public application abuse resistance
- Feature: Agentic AI chat
- Route: `/api/ai/chat`
- File or files: `app/api/ai/chat/route.ts`, `lib/ai/chat-request.ts`, `tests/ai-chat-request.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`, `ai_conversations`, `ai_messages`
- Description: The authenticated agentic chat route could invoke streaming and fallback model runs with
  no per-user request budget and accepted unbounded message/conversation input before tool execution.
- User impact: A compromised or runaway session could consume disproportionate AI capacity and request
  processing resources.
- Security impact: The model-backed, tool-capable path had weaker abuse controls than adjacent AI routes.
- Root cause: The route relied on authentication and RLS but had no request limiter or shared input contract.
- Resolution: Added a 20-request-per-user-per-minute in-memory limit plus the durable `rate_limit_hit` guard,
  valid UUID validation, trimmed non-empty messages, and an 8,000-character maximum before model work.
- Tests performed: `npm.cmd test -- tests/ai-chat-request.test.ts` passed with 3 tests; typecheck and lint
  passed. Durable enforcement remains dependent on migration `0156` being applied in production.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0190 - Authenticated voice AI routes lacked request budgets

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: AI cost control / provider abuse resistance
- Feature: Voice transcription and speech synthesis
- Routes: `/api/ai/voice/transcribe`, `/api/ai/voice/speak`
- File or files: `app/api/ai/voice/transcribe/route.ts`, `app/api/ai/voice/speak/route.ts`,
  `lib/server/ai-rate-limit.ts`, `tests/ai-rate-limit.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`
- Description: Authenticated voice routes validated payloads but could make unlimited paid OpenAI
  transcription or speech requests per user.
- User impact: A runaway or compromised session could exhaust AI provider capacity or incur unexpected cost.
- Root cause: Voice routes predated the shared durable AI limiter used by the gift assistant and agentic chat.
- Resolution: Added a shared local plus durable limiter: 10 transcription requests and 30 speech requests
  per user per minute, with `Retry-After` responses before provider keys or calls are used.
- Tests performed: `npm.cmd test -- tests/ai-rate-limit.test.ts tests/ai-voice.test.ts` passed with 22 tests;
  typecheck and lint passed. Durable enforcement remains dependent on migration `0156` in production.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0191 - Generic AI insights endpoint lacked request budget

- Status: [x] Completed in code and covered by the shared limiter regression tests.
- Severity: P1
- Category: AI cost control / family data-read abuse resistance
- Feature: Family-scoped AI insights
- Route: `/api/ai/insights`
- File or files: `app/api/ai/insights/route.ts`, `lib/server/ai-rate-limit.ts`,
  `tests/ai-rate-limit.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`
- Description: The broad insights route could repeatedly read multi-module family context and invoke
  a paid model without a per-user request budget.
- User impact: A runaway dashboard or compromised session could consume provider capacity and perform
  unnecessary family-data reads.
- Root cause: The route was authenticated and RLS-scoped but did not use the shared AI limiter.
- Resolution: Added a distinct 20-request-per-user-per-minute local plus durable guard before context
  queries and model execution, with `Retry-After` on rejection.
- Tests performed: Shared limiter tests passed with 3 cases; full suite, typecheck, lint, build, and
  public E2E remain the release gates. Durable enforcement depends on migration `0156` in production.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0192 - Public calendar feed lacked abuse bounds

- Status: [x] Completed in code and covered by regression test.
- Severity: P1
- Category: Public capability access / service-role read abuse resistance
- Feature: Anonymous iCalendar subscriptions
- Route: `/api/sync/feeds/[token]`
- File or files: `app/api/sync/feeds/[token]/route.ts`, `lib/sync/feed-request.ts`,
  `tests/sync-feed-contract.test.ts`
- Database objects: `sync_calendars`, `sync_calendar_events`, `rate_limits`, `rate_limit_hit`
- Description: A valid capability URL intentionally grants calendar access, but the endpoint had no
  request budget and accepted unbounded token strings before a service-role query returning up to 2,000 rows.
- User impact: A leaked feed URL or automated poller could create avoidable database load.
- Security impact: The capability read path had weaker abuse resistance than other public service-role routes.
- Root cause: The route treated the token as sufficient authorization without a bounded input or rate guard.
- Resolution: Added URL-safe token validation (16-200 characters) and 60 requests per IP per minute using
  local plus durable limits, with `Retry-After` responses. Anonymous calendar clients remain supported.
- Tests performed: `npm.cmd test -- tests/sync-feed-contract.test.ts` passed with 2 tests; full suite,
  typecheck, lint, build, and public E2E remain the release gates. Durable enforcement depends on `0156`.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0193 - Billing side-effect routes lacked request budgets

- Status: [x] Completed in code and covered by the shared limiter regression tests.
- Severity: P1
- Category: Billing provider abuse resistance / duplicate side effects
- Feature: Subscription checkout and self-serve billing
- Routes: `/api/billing/checkout`, `/api/billing/change-plan`, `/api/billing/cancel`, `/api/billing/portal`
- File or files: the four billing route handlers, `lib/server/request-rate-limit.ts`,
  `lib/server/ai-rate-limit.ts`, `tests/ai-rate-limit.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`, `billing_customers`, `subscriptions`, `checkout_sessions`
- Description: Parent-only billing routes had authorization but no per-family request budget before Stripe
  customer, checkout-session, subscription-update, or portal-session calls.
- User impact: Double-clicks, runaway clients, or compromised parent sessions could create avoidable
  provider calls and duplicate checkout sessions.
- Root cause: Rate limiting existed only in selected public and AI routes, not billing side effects.
- Resolution: Added a generic local plus durable limiter keyed by family at 10 requests per route per minute,
  after input/role checks and before Stripe work, with `Retry-After` responses.
- Tests performed: Shared limiter regression passed; full suite, typecheck, lint, build, and public E2E remain
  release gates. Durable enforcement depends on migration `0156` in production.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0194 - Calendar sync routes lacked request budgets

- Status: [x] Completed in code and covered by the shared limiter regression tests.
- Severity: P1
- Category: External integration abuse resistance / duplicate provider work
- Feature: Google and provider-agnostic calendar synchronization
- Routes: `/api/sync/run`, `/api/sync/google/sync`, `/api/google/calendar/sync`
- File or files: the three sync route handlers, `lib/server/request-rate-limit.ts`,
  `tests/ai-rate-limit.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`, `sync_accounts`, `calendar_events`
- Description: Authenticated sync entry points could refresh tokens and call external calendar providers
  repeatedly without a per-family/user request budget.
- User impact: Repeated clicks or a runaway client could cause duplicate imports, provider throttling, or
  unnecessary external API work.
- Root cause: Authentication and account scoping existed, but sync routes predated the shared side-effect guard.
- Resolution: Added provider-specific 10-request-per-family/user-per-minute limits before sync engines,
  token refreshes, or Google imports, with `Retry-After` responses.
- Tests performed: Shared limiter regression passed; full suite, typecheck, lint, build, and public E2E remain
  release gates. Durable enforcement depends on migration `0156` in production.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0196 - Public service-role ingestion used instance-local request limits

- Status: [x] Completed in code and covered by `tests/public-side-effect-rate-limit.test.ts`.
- Severity: P1
- Category: Public ingestion abuse resistance / distributed side effects
- Feature: Contact, marketing forms, attribution, and conversion tracking
- Routes: `/api/contact`, `/api/forms/submit`, `/api/exit-intent/track`, `/api/lp/track`,
  `/api/mkt/track`, `/api/ab/track`
- File or files: the six route handlers, `lib/server/request-rate-limit.ts`,
  `tests/public-side-effect-rate-limit.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`, `support_tickets`, `marketing_form_submissions`,
  `mkt_visitors`, `mkt_sessions`, `mkt_touchpoints`, `ab_events`
- Description: Public service-role endpoints had per-instance memory limits, allowing a distributed
  client to bypass budgets across application instances before database writes or metric RPCs.
- User impact: Abuse could create duplicate support/marketing records, trigger automation repeatedly,
  and inflate attribution or conversion metrics.
- Root cause: These older ingestion paths predated the shared cross-instance limiter.
- Resolution: Replaced local-only guards with shared local-plus-durable family-independent IP buckets,
  reused one service client per request, and added `Retry-After` responses.
- Tests performed: Contract and limiter tests passed; full suite, typecheck, lint, build, and public E2E
  passed. Durable enforcement depends on migration `0156` in production.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0197 - Model-backed and external-provider routes lacked durable request budgets

- Status: [x] Completed in code and covered by `tests/ai-route-rate-limit-contract.test.ts`.
- Severity: P1
- Category: AI/provider abuse resistance / distributed external side effects
- Feature: Family AI tools, recipe AI, trip/weather research, and weekend discovery
- Routes: model-backed routes under `/api/ai`, plus `/api/vacations/ai`, `/api/recipes/suggest`,
  `/api/recipes/transform`, `/api/vacations/weather`, `/api/weekend/discover`
- File or files: affected route handlers, `lib/server/ai-rate-limit.ts`,
  `lib/server/request-rate-limit.ts`, `tests/ai-route-rate-limit-contract.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`, AI audit/cache tables, family-scoped feature tables
- Description: Several authenticated routes could invoke model or external provider work with only
  instance-local or no request budget, allowing repeated provider calls across app instances.
- User impact: Runaway clients could consume model/provider capacity, duplicate AI-generated writes,
  and increase latency or cost.
- Root cause: Older provider routes predated the shared durable limiter; some had only plan/day caps.
- Resolution: Added per-user shared local-plus-durable limits before provider calls or broad context
  reads, preserving existing plan/day caps and returning `Retry-After` on rejection.
- Tests performed: AI route contract, limiter tests, full suite, typecheck, lint, build, and public E2E
  passed. Durable enforcement depends on migration `0156` in production.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0198 - Provider inventory found unbudgeted marketing, behavior, and GIF routes

- Status: [x] Completed in code and covered by `tests/ai-route-rate-limit-contract.test.ts`.
- Severity: P1
- Category: AI/provider abuse resistance / prompt and external API cost control
- Feature: Marketing AI assistant, behavior coaching, and Messages GIF search
- Routes: `/api/admin/marketing/ai`, `/api/behavior/insight`, `/api/gif/search`
- File or files: the three route handlers, `lib/server/ai-rate-limit.ts`,
  `lib/server/request-rate-limit.ts`, `tests/ai-route-rate-limit-contract.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`, marketing and family-scoped source tables
- Description: A provider inventory found model-backed and external-proxy routes that had no shared
  request budget before expensive context reads or third-party calls.
- User impact: Repeated requests could consume model/Giphy quota, increase cost, and add avoidable
  latency for other users.
- Root cause: These routes were implemented outside the earlier `/api/ai` and public-ingestion audits.
- Resolution: Added durable per-actor request limits, `Retry-After` responses, and a 4,000-character
  marketing prompt bound; expanded the route contract to prevent regression.
- Tests performed: Focused contract/limiter tests, full suite, typecheck, lint, build, and public E2E
  passed. Durable enforcement depends on migration `0156` in production.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0199 - Durable rate-limit RPCs were publicly executable

- Status: [x] Completed in code; production enforcement requires migration `0179` to be applied.
- Severity: P1
- Category: Supabase RPC privilege / distributed rate-limit integrity
- Feature: Shared request limits for AI, billing, notification, sync, and public ingestion routes
- Routes: all callers of `rate_limit_hit`, plus the maintenance path for `rate_limit_prune`
- File or files: `supabase/migrations/0156_rate_limits.sql`,
  `supabase/migrations/0179_harden_rate_limit_rpc_grants.sql`, authenticated billing and notification
  routes, `tests/rate-limit-rpc-security.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`, `rate_limit_prune`
- Description: The original SECURITY DEFINER grants allowed anonymous/public direct execution of the
  limiter RPC, and the prune function inherited a public execute privilege.
- User impact: A caller could consume arbitrary limiter buckets or clear shared counters, weakening
  distributed request budgets and enabling repeated provider or side-effect work.
- Root cause: Migration `0156` granted `anon` and did not revoke PostgreSQL's default PUBLIC execute.
- Resolution: Added forward migration `0179` to revoke anonymous/public access, bind authenticated keys
  to `auth.uid()`, restrict pruning to `service_role`, and update authenticated route keys accordingly.
- Tests performed: RPC security contract, limiter tests, full suite, typecheck, lint, build, public E2E,
  and schema audit passed. Auth Admin probe remains a separate Supabase-owned failure.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0200 - Resend webhook accepted replayed signed deliveries

- Status: [x] Completed in code; production enforcement requires migration `0180` to be applied.
- Severity: P1
- Category: Webhook authenticity / replay protection / marketing data integrity
- Feature: Resend email engagement webhooks and marketing automations
- Route: `/api/webhooks/resend`
- File or files: `app/api/webhooks/resend/route.ts`,
  `supabase/migrations/0180_resend_webhook_dedup.sql`, `lib/database.types.ts`,
  `tests/resend-webhook-replay-contract.test.ts`
- Database objects: `resend_webhook_events`, `marketing_email_campaigns`, `marketing_suppressions`
- Description: Signed Resend/Svix deliveries were authenticated but had no timestamp freshness check
  or durable event-ID deduplication, so valid replays could increment counters and re-fire work.
- User impact: Marketing analytics could be inflated and engagement automations could be retriggered;
  old captured webhook payloads remained useful beyond the provider retry window.
- Root cause: Signature verification checked only the HMAC and did not persist the Svix delivery ID.
- Resolution: Added a five-minute timestamp window, 256 KB payload bound, service-role-only event ledger,
  duplicate short-circuit, and retryable processing state.
- Tests performed: Replay contract, full suite, typecheck, lint, build, and public E2E passed. Auth Admin
  probe remains a separate Supabase-owned failure.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0201 - Public unsubscribe endpoint lacked abuse and output hardening

- Status: [x] Completed in code and covered by the existing unsubscribe/public-ingestion contracts.
- Severity: P1
- Category: Public service-role endpoint / secret configuration / reflected output
- Feature: Email unsubscribe and RFC 8058 one-click unsubscribe
- Route: `/api/marketing/unsubscribe`
- File or files: `app/api/marketing/unsubscribe/route.ts`, `lib/marketing/unsubscribe.ts`,
  `tests/marketing-unsubscribe.test.ts`, `tests/public-side-effect-rate-limit.test.ts`
- Database objects: `marketing_suppressions`, `rate_limits`, `rate_limit_hit`
- Description: The public endpoint could receive unlimited HMAC verification attempts, reflected the
  supplied address into HTML without escaping, and used a predictable development secret if production
  signing configuration was absent.
- User impact: Attackers could spend service resources on verification requests, and a future caller
  could introduce reflected markup through the response; misconfigured production links were forgeable.
- Root cause: The endpoint predated the shared public-ingestion budget and secret fail-closed policy.
- Resolution: Added a shared IP limiter, bounded token/email validation, HTML escaping, and production
  fail-closed secret selection while preserving development convenience.
- Tests performed: Unsubscribe/public limiter tests, full suite, typecheck, lint, build, and public E2E
  passed. Auth Admin probe remains a separate Supabase-owned failure.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0202 - Signed Guardian callbacks could replay side effects before unique inserts

- Status: [x] Completed in code; live schema probe confirms migration `0181` is present; isolated RLS
  allow/deny testing remains pending.
- Severity: P1
- Category: Twilio webhook replay protection / AI and notification idempotency
- Feature: Guardian SMS, WhatsApp, inbound voice, screening, and voicemail callbacks
- File or files: `lib/guardian/callbacks.ts`, `app/api/guardian/inbound/sms/route.ts`,
  `app/api/guardian/inbound/whatsapp/route.ts`, `app/api/guardian/inbound/voice/route.ts`,
  `app/api/guardian/screen/route.ts`, `app/api/guardian/status/voicemail/route.ts`,
  `supabase/migrations/0181_guardian_callback_replay.sql`,
  `tests/guardian-callback-security.test.ts`
- Database objects: `guardian_callback_events`
- Description: Twilio signatures authenticated callbacks, but duplicate requests could execute the
  Guardian decision pipeline, AI screening, notification writes, or outbound work before a unique
  communication insert rejected the replay.
- User impact: Provider retries or captured signed requests could duplicate AI/provider spend, alerts,
  and call handling.
- Resolution: Added bounded body/field checks and an atomic service-only callback claim ledger. Duplicate
  callbacks short-circuit; stale claims can be reclaimed after ten minutes if a worker crashes.
- Tests performed: Guardian callback contract, screening-turn contract, full suite, typecheck, lint,
  build, and public E2E passed. Live schema probe confirms the replay ledger is present; isolated RLS
  allow/deny testing remains pending.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0203 - Stripe event replay ledger allowed concurrent active claims

- Status: [x] Completed in code; production enforcement requires migration `0182` to be applied.
- Severity: P1
- Category: Stripe webhook concurrency / billing and money idempotency
- Feature: Stripe billing and Bubaly Money webhook processing
- File or files: `lib/stripe/webhook.ts`, `app/api/webhooks/stripe/route.ts`,
  `app/api/webhooks/money/route.ts`, `supabase/migrations/0182_stripe_webhook_claims.sql`,
  `tests/stripe-webhook-replay-contract.test.ts`
- Database objects: `stripe_webhook_events`
- Description: A unique Stripe event row prevented duplicate records, but concurrent deliveries that
  observed `processing` were both treated as fresh and could run the same downstream side effects.
- User impact: Billing state, referral crediting, automation, and money-event handlers could be invoked
  more than once during concurrent provider retries.
- Resolution: Added conditional active/stale claim handling, explicit non-duplicate storage failures,
  per-worker ownership tokens, payload/configuration bounds, and a ten-minute abandoned-claim recovery
  timestamp. Completion/error updates are restricted to the worker that owns the claim.
- Tests performed: Stripe replay contract, migration contract, issuing authorization tests, full suite,
  typecheck, lint, build, and public E2E passed. Live migration application remains pending.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0204 - Provider sync OAuth state was not browser-bound

- Status: [x] Completed and verified in code; no migration required.
- Severity: P1
- Category: OAuth CSRF / external account linking
- Feature: Google and generic provider sync account connection
- File or files: `app/api/sync/google/auth/route.ts`, `app/api/sync/google/callback/route.ts`,
  `app/api/sync/[provider]/auth/route.ts`, `app/api/sync/[provider]/callback/route.ts`,
  `lib/sync/oauth-state.ts`, `tests/sync-oauth-csrf.test.ts`
- Database objects: None; callback identity comes from the authenticated session.
- Description: Sync OAuth state encoded user and family identifiers in a base64 query parameter but was
  not tied to the browser that initiated the flow. A forged callback could attempt to attach an external
  account during a victim's signed-in session.
- User impact: External calendar or task accounts could be linked without the user initiating that OAuth
  flow.
- Resolution: Added random provider-scoped httpOnly state cookies, constant-time state comparison,
  session-derived identity, ten-minute expiry, and state-cookie cleanup on every callback exit path.
- Tests performed: 3 focused sync files / 32 tests, full suite (312 files / 2,579 tests), typecheck,
  lint, build, and public E2E passed.
- Evidence: `lib/sync/oauth-state.ts` and the four sync OAuth routes; no `JSON.stringify({ userId:`
  state remains in the provider-sync flows.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0205 - Calendar feed URLs allowed SSRF and unbounded response reads

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Server-side request forgery / external feed ingestion / resource bounds
- Feature: Legacy calendar import and scheduled calendar-feed sync
- File or files: `lib/server/public-calendar-fetch.ts`, `lib/server/calendar-feeds.ts`,
  `app/api/calendar/sync/route.ts`, `tests/public-calendar-fetch.test.ts`
- Database objects: None; stored feed URLs remain user data but are validated at every fetch boundary.
- Description: Calendar ingestion fetched user-controlled HTTP(S) and webcal URLs directly, allowing
  loopback, private-network, link-local, metadata, or unsafe redirect targets; response bodies were also
  read without a bounded size.
- User impact: A malicious feed URL could probe internal services or consume excessive server memory.
- Root cause: URL normalization handled scheme conversion but did not enforce public network reachability,
  redirect safety, or response-size limits.
- Resolution: Added public DNS/IP validation for IPv4 and IPv6, blocked unsafe hostnames and credentials,
  manual redirect revalidation with a three-hop cap, a 1 MiB calendar response limit, a 16 KiB import-body
  limit, and generic error responses. Both direct imports and scheduled stored-feed syncs use the helper.
- Tests performed: Focused calendar-fetch tests, full suite, typecheck, lint, build, and public E2E passed.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0206 - Push registration accepted unbounded and mismatched device data

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Authenticated device registration / request bounds / notification integrity
- Feature: Web Push, APNs, and FCM device registration
- File or files: `app/api/push/subscribe/route.ts`, `app/api/push/unsubscribe/route.ts`,
  `lib/server/push-request.ts`, `tests/push-request.test.ts`
- Database objects: `push_devices` (existing schema and RLS preserved)
- Description: Authenticated push registration accepted arbitrary endpoint, token, cryptographic-key,
  and user-agent strings without a request-size boundary or strict platform/provider contract. Removal
  accepted the same unbounded key shape.
- User impact: A compromised session could create noisy or oversized device rows and repeatedly trigger
  registration/removal database work.
- Root cause: The routes trusted the browser payload and relied on database errors instead of a shared
  input contract and request budget.
- Resolution: Added a 16 KiB body cap, strict HTTPS endpoint and native token validation, APNs/FCM/web
  matching, bounded key/user-agent fields, generic persistence errors, and per-user local plus durable
  rate limits before writes.
- Tests performed: Push request contract, typecheck, lint, full suite, build, and public E2E passed.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0207 - Marketplace auctions exposed an unsafe bid path and non-atomic Buy-It-Now

- Status: [x] Completed in code; production enforcement requires migration `0184` to be applied.
- Severity: P1
- Category: Marketplace authorization / transaction integrity
- Feature: Proxy bidding and Buy-It-Now
- File or files: `supabase/migrations/0184_marketplace_auction_authorization.sql`,
  `app/(app)/marketplace/auctions/actions.ts`, `lib/database.types.ts`,
  `tests/marketplace-auction-security.test.ts`
- Database objects: `marketplace_bids`, `marketplace_listings`, `marketplace_orders`,
  `marketplace_place_bid`, `marketplace_buy_now`
- Description: Migration `0183` left an authenticated insert policy on `marketplace_bids` and accepted
  caller-supplied member/family IDs in the SECURITY DEFINER bid RPC. Buy-It-Now claimed the listing in one
  statement and inserted the order in a second operation.
- User impact: A signed-in caller could bypass auction rules through direct table writes or forge the RPC
  identity, and an order failure could leave a listing claimed without a corresponding order.
- Root cause: The first auction slice trusted client-side routing and split the purchase state transition
  from order creation.
- Resolution: Added an authenticated member/family wrapper, revoked authenticated bid inserts, bounded bid
  amounts, and added a locked `marketplace_buy_now` RPC that claims the listing, closes bids, and creates
  the order in one transaction. Actions now use the RPC and return provider-safe errors.
- Tests performed: Auction engine/security contracts, full suite, typecheck, lint, build, and public E2E passed.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0208 - Expired auction close could strand a claimed listing without an order

- Status: [x] Completed in code; production enforcement requires migration `0185` to be applied.
- Severity: P1
- Category: Marketplace transaction integrity / retry safety
- Feature: Expired auction settlement
- File or files: `supabase/migrations/0185_marketplace_auction_close_transaction.sql`,
  `app/api/cron/close-auctions/route.ts`, `lib/database.types.ts`,
  `tests/marketplace-auction-security.test.ts`
- Database objects: `marketplace_listings`, `marketplace_orders`, `marketplace_bids`,
  `marketplace_close_auction`
- Description: The cron changed an expired listing to `claimed` before inserting the winner order.
  An order failure left the listing closed without a durable transaction record, and later retries
  could not repair it.
- User impact: A successful auction could disappear from active listings while the winner had no order
  to coordinate pickup or completion.
- Root cause: Listing state and order creation were separate service-role writes.
- Resolution: Added a locked service-role settlement RPC that commits listing, order, and bid updates
  together. The cron now retries failed RPCs and sends notifications only after settlement succeeds.
- Tests performed: Auction security contract, full suite, typecheck, lint, build, and public E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0209 - Generic provider sync accepted unbounded request bodies

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Authenticated request bounds / provider integration
- Feature: Generic provider sync
- File or files: `app/api/sync/run/route.ts`, `lib/server/bounded-request-body.ts`,
  `tests/sync-request-body.test.ts`
- Description: The generic sync endpoint called `req.json()` directly and cast the submitted provider
  value, allowing an authenticated caller to send an arbitrarily large body before adapter lookup.
- User impact: A compromised session could consume request-body memory and trigger unnecessary auth,
  adapter, and database work with malformed provider input.
- Root cause: The route lacked a shared streaming body boundary and runtime shape validation.
- Resolution: Added a 4 KiB streaming body cap, malformed-JSON handling, and bounded string validation;
  unsupported providers now fail before service-role work.
- Tests performed: Sync request-boundary contract, sync adapter tests, OAuth CSRF tests, typecheck,
  lint, full suite, build, and public E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0210 - Production-readiness seed could target an arbitrary family

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Production data safety / seed scope
- Feature: Production-readiness fixture pack
- File or files: `supabase/seed_production_readiness.sql`,
  `tests/production-readiness-seed.test.ts`
- Description: When the anchored account was absent, the 600-record seed selected the first family
  by creation time and wrote fixtures there.
- User impact: Running the seed against a valid database without the expected account could contaminate
  an unrelated household with realistic-looking independence records.
- Root cause: The fallback favored convenience over an explicit target boundary.
- Resolution: The seed now raises an exception unless `newworldventurellc@gmail.com` resolves to a family.
  The deterministic 600-row upsert and non-destructive behavior remain intact.
- Tests performed: Production-readiness seed, seed safety, credential safety, full suite, typecheck,
  lint, build, and public E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0211 - Master seed could execute legacy sections after an anchor miss

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Production data safety / master seed scope
- Feature: One-paste `SEED_ALL.sql` workflow
- File or files: `supabase/SEED_ALL.sql`, `tests/master-seed-scope.test.ts`
- Description: The master seed embedded many legacy sections that independently fell back to the oldest
  family when the designated account was absent.
- User impact: A one-paste service-role seed run could write realistic fixtures to an unrelated household.
- Root cause: The master entrypoint had no preflight target assertion before executing its sections.
- Resolution: Added an anchored-account preflight before `seed_core_content.sql`; missing targets abort the
  entire master workflow before any section can write. The existing idempotent seed packs remain intact.
- Tests performed: Master seed scope, production-readiness seed, seed safety, full suite, typecheck, lint,
  build, and public E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0212 - Financial and public ingestion routes parsed unbounded JSON bodies

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Request bounds / service-role ingestion / billing
- Feature: Billing, public forms, marketing trackers, and internal email callbacks
- File or files: `lib/server/bounded-request-body.ts`, audited API routes,
  `tests/request-body-boundaries.test.ts`
- Description: Several routes called `req.json()` before validating a small enum or bounded field,
  allowing a caller to make the runtime buffer an arbitrarily large JSON payload.
- User impact: A public or authenticated caller could consume request memory and trigger unnecessary
  service-role, database, email, or Stripe work with oversized input.
- Root cause: Field-level validation did not establish a transport-level body boundary.
- Resolution: Added a shared streaming JSON reader and explicit limits for billing, contact, forms,
  public analytics/marketing ingestion, and internal email routes.
- Tests performed: Request-boundary contracts, full suite, typecheck, lint, build, and public E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0213 - Scheduled callbacks authorized the literal Bearer undefined

- Status: [x] Completed in code; no migration required.
- Severity: P0
- Category: Scheduled job authorization / secret configuration
- Feature: Cron jobs, concierge placement, and internal welcome email
- File or files: `lib/server/cron-auth.ts`, all `app/api/cron/**/route.ts` files,
  `app/api/concierge-calls/place/route.ts`, `app/api/email/welcome/route.ts`,
  `tests/cron-auth.test.ts`
- Description: Comparing a request header with ``Bearer ${process.env.CRON_SECRET}`` made a missing
  secret equal the attacker-supplied string `Bearer undefined`.
- User impact: A misconfigured deployment could expose service-role scheduled jobs and provider actions
  without a real secret.
- Root cause: Secret presence was not checked before string comparison, and the pattern was duplicated.
- Resolution: Centralized fail-closed cron and internal-secret guards; every scheduled route now rejects
  missing secrets before any service-role work.
- Tests performed: Cron authorization contracts, full suite, typecheck, lint, build, and public E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0214 - Marketplace negotiation writes lacked complete database integrity bounds

- Status: [x] Completed in code; migration pending in production.
- Severity: P1
- Category: Marketplace integrity / multi-tenant authorization / bounded input
- Feature: Marketplace Best Offer negotiations
- File or files: `supabase/migrations/0187_harden_marketplace_negotiations.sql`,
  `supabase/seed_marketplace_negotiations.sql`, `supabase/SEED_ALL.sql`,
  `app/(app)/marketplace/negotiations/actions.ts`, `tests/marketplace-negotiation-security.test.ts`
- Description: The negotiation RPC boundary did not independently prevent same-family self-deals,
  oversized notes, extreme amounts, or offer/counter/accept rounds at or above the listing ask. The
  negotiation seed could also silently select the first family when the anchored account was absent.
- User impact: Direct RPC or service-role callers could create invalid negotiation data or cause the
  deterministic fixture pack to write into an unintended household.
- Root cause: Application validation and caller-family checks were not backed by complete database
  constraints and the consolidated seed retained a legacy family fallback.
- Resolution: Added idempotent database constraints and a round trigger, bounded action/panel notes,
  and made both negotiation seed paths require the explicitly anchored account.
- Tests performed: Focused negotiation/seed contracts, full suite, typecheck, lint, build, and public E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0215 - Provider-backed routes parsed JSON bodies without transport bounds

- Status: [x] Completed in code; no migration required.
- Severity: P1; P0 for the internal guardian escalation path because it can fan out alerts.
- Category: Request bounds / AI spend / provider and notification side effects
- Feature: AI, recipes, vacations, social generation, consent, marketing admin, and Guardian
- File or files: `lib/server/bounded-request-body.ts`, audited `app/api` routes,
  `tests/provider-request-body-boundaries.test.ts`
- Description: Provider-backed and side-effecting routes validated individual fields only after
  `req.json()` had already allowed the runtime to buffer an arbitrary request body.
- User impact: An authenticated or internal caller could consume request memory or amplify paid model,
  network, SMS, or outbound-call work with oversized JSON input.
- Root cause: The shared bounded reader was applied to the first audited set of public and billing
  routes, but the remaining provider routes retained direct JSON parsing.
- Resolution: Added streaming byte limits to every JSON-accepting `app/api` route, with 256 KiB provider
  bounds, 16 KiB control bounds, an 8 MiB flyer-upload bound, and a contract test preventing regressions.
- Tests performed: Focused request-boundary contracts, full suite, typecheck, lint, build, and public E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0216 - Weekend Planner feed fetch bypassed SSRF and response bounds

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: SSRF / server-side network access / response memory bounds
- Feature: Weekend Planner family RSS and ICS feeds
- File or files: `app/api/weekend/discover/route.ts`, `lib/server/public-calendar-fetch.ts`,
  `tests/weekend-feed-security.test.ts`, `tests/public-calendar-fetch.test.ts`
- Description: Family-curated feed URLs were fetched directly with automatic redirects and
  `response.text()`, bypassing the existing public-host validation and response-size limit.
- User impact: A family member who could save a feed URL could cause server-side requests to private
  network targets or make the route buffer an unexpectedly large feed.
- Root cause: Weekend discovery predated the shared public calendar fetch boundary and duplicated a
  simpler timeout-only fetch helper.
- Resolution: Reused the SSRF-safe calendar fetcher for every family feed, preserving feed parsing while
  enforcing public DNS targets, redirect validation, a 15-second timeout, and a 1 MiB response cap.
- Tests performed: Focused SSRF/feed contracts, full suite, typecheck, lint, build, and public E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0217 - Signed and provider raw-body routes buffered before bounds

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Request bounds / webhook integrity / provider ingress
- Feature: Stripe, Resend, money, push, and calendar webhook-style request bodies
- File or files: `lib/server/bounded-request-body.ts`, `app/api/webhooks/stripe/route.ts`,
  `app/api/webhooks/money/route.ts`, `app/api/webhooks/resend/route.ts`,
  `app/api/push/subscribe/route.ts`, `app/api/push/unsubscribe/route.ts`,
  `app/api/calendar/sync/route.ts`, `tests/raw-body-boundaries.test.ts`
- Description: Several raw-body endpoints checked `Content-Length` and then buffered the entire body
  with `req.text()` before enforcing the limit, allowing chunked oversized requests to consume memory.
- User impact: A provider or authenticated caller could send an oversized chunked payload before the
  endpoint rejected it, increasing memory pressure and delaying signature or database work.
- Root cause: Raw-body routes had local post-read checks instead of using the shared streaming reader.
- Resolution: Replaced those reads with `readBoundedRequestText`, which checks declared lengths, consumes
  at most the configured byte budget, cancels oversized streams, and preserves exact signed payload text.
- Tests performed: Raw-body boundary contract, full suite, typecheck, lint, build, and public E2E.
- Evidence: `tests/raw-body-boundaries.test.ts` covers exact text preservation, chunked oversized rejection,
  and static route coverage.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0218 - Multipart and form-encoded provider bodies still need streaming bounds

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Request bounds / provider ingress
- Feature: Twilio Guardian callbacks and voice transcription upload
- File or files: `app/api/guardian/status/voicemail/route.ts`, `app/api/guardian/screen/route.ts`,
  `app/api/guardian/inbound/whatsapp/route.ts`, `app/api/guardian/inbound/voice/route.ts`,
  `app/api/guardian/inbound/sms/route.ts`, `app/api/guardian/escalate/twiml/route.ts`,
  `app/api/ai/voice/transcribe/route.ts`
- Description: These routes relied on platform `formData()` parsing, which could buffer provider or
  uploaded multipart/form-encoded bodies before application validation.
- Resolution: Added `readBoundedRequestBytes` and `readBoundedRequestFormData`; Twilio routes cap total
  bodies at 64 KiB and voice transcription caps the multipart request at 26 MiB before reconstructing a
  bounded request for platform parsing. Existing 4 KiB Twilio field, 25 MiB audio-file, MIME, signature,
  and callback-claim checks remain in force.
- Tests performed: Bounded URL-encoded and multipart parser contracts, Guardian callback contracts, full
  suite, typecheck, lint, build, and public E2E.
- Evidence: `tests/raw-body-boundaries.test.ts` verifies decoded Twilio fields, audio file preservation,
  and static route coverage with no direct `req.formData()` calls.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0219 - Social Feed unfurl followed redirects and buffered full HTML

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: SSRF / server-side fetch / response memory bounds
- Feature: Social Feed paste-a-link unfurling
- Route: `/dashboard/social-feed`
- File or files: `app/(app)/dashboard/social-feed/actions.ts`,
  `lib/server/public-calendar-fetch.ts`, `tests/social-feed-fetch-security.test.ts`
- Description: The server action accepted a family member's URL, validated only basic hostname syntax,
  followed redirects automatically, and called `res.text()` before slicing the HTML.
- User impact: A crafted public URL could redirect server-side requests toward private or metadata targets
  and could make the action buffer an unexpectedly large response.
- Root cause: Social Feed used a local fetch path instead of the shared DNS, redirect, timeout, and response
  boundary used by calendar ingestion.
- Resolution: Added a generic bounded public-text fetcher and routed Social Feed unfurling through it with
  a 600 KiB cap, manual redirect revalidation, public DNS checks, and bounded HTML parsing.
- Tests performed: Social Feed redirect/response-boundary contracts, full suite, typecheck, lint, build,
  and public E2E.
- Evidence: `tests/social-feed-fetch-security.test.ts` rejects private redirects and oversized streamed
  HTML and statically verifies the action no longer uses automatic redirects or post-read slicing.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0220 - Provider error responses were buffered without bounds

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Provider response memory bounds / failure handling
- Feature: OpenAI, Twilio, email, marketing, voice, flyer, Google Graph, and Microsoft Graph integrations
- File or files: `lib/server/bounded-response-body.ts`, `lib/ai/provider.ts`, `lib/guardian/twilio.ts`,
  `lib/server/email.ts`, `lib/marketing/send.ts`, `app/api/ai/flyer/route.ts`,
  `app/api/ai/voice/transcribe/route.ts`, `app/api/ai/voice/speak/route.ts`,
  `lib/sync/providers/google.ts`, `lib/sync/providers/microsoft.ts`,
  `tests/response-body-boundaries.test.ts`
- Description: Audited provider failure paths called `response.text()` and then sliced or logged the
  result, allowing an oversized third-party error body to be buffered before application limits ran.
- User impact: Provider failures could increase server memory use and obscure the concise diagnostics
  needed for safe retry or error classification.
- Root cause: External response reads had no shared streaming boundary; existing post-read slices did not
  prevent allocation of the full response.
- Resolution: Added `readBoundedResponseText`; audited provider error paths cap response text at 64 KiB,
  while Google and Microsoft Graph text responses cap at 2 MiB before JSON parsing. Intentionally streamed
  success responses remain unchanged.
- Tests performed: Focused response-boundary, AI error, voice, and sync adapter tests; full Vitest suite;
  typecheck; lint; production build; public Playwright/axe E2E.
- Evidence: `tests/response-body-boundaries.test.ts` preserves exact text, cancels oversized streams, and
  statically verifies the audited paths use the helper without direct unbounded text reads.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0221 - Provider JSON responses were parsed without byte bounds

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Provider response memory bounds / malformed provider data
- Feature: AI, OAuth, calendar, weather, routing, weekend discovery, Guardian, recipes, flyer, and GIF integrations
- File or files: `lib/server/bounded-response-body.ts`, `lib/ai/provider.ts`, `lib/weather/open-meteo.ts`,
  `lib/trips/routing.ts`, `app/api/weekend/discover/route.ts`, `lib/vacations/weather-fetch.ts`,
  `lib/guardian/twilio.ts`, `lib/sync/providers/google.ts`, `lib/sync/providers/microsoft.ts`,
  `lib/recipes/providers/themealdb.ts`, `lib/guardian/scam-ai.ts`, `lib/guardian/ai-screen.ts`,
  `app/api/ai/flyer/route.ts`, `app/api/ai/voice/transcribe/route.ts`, `lib/google.ts`,
  `app/api/gif/search/route.ts`, `tests/response-body-boundaries.test.ts`
- Description: Audited external integrations called `response.json()` directly, allowing third-party
  JSON bodies to be fully buffered before application parsing or validation.
- User impact: An unexpectedly large or malformed provider response could consume excess memory or cause
  an integration failure outside its intended error boundary.
- Root cause: The prior response hardening covered text/error paths and Graph text reads but did not cover
  successful JSON responses or OAuth payloads.
- Resolution: Added `readBoundedResponseJson`, which uses the streaming byte reader before JSON parsing.
  OAuth/token responses cap at 64 KiB and validate required access tokens; provider payloads use bounded
  limits from 256 KiB to 2 MiB. OpenAI SSE remains intentionally streamed incrementally.
- Tests performed: Response-boundary, AI, sync, weather, weekend, recipe, and routing focused tests; full
  Vitest suite; typecheck; lint; production build; public Playwright/axe E2E.
- Evidence: `tests/response-body-boundaries.test.ts` verifies compact JSON, invalid JSON, oversized stream
  cancellation, and static absence of direct audited `res.json()` reads.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0222 - Fixed-provider fetches could hang without deadlines

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: External dependency reliability / request cancellation
- Feature: AI, OAuth, sync, messaging, push, weather, routing, flyer, transcription, speech, and GIF integrations
- File or files: `lib/server/external-fetch.ts`, `lib/client-fetch.ts`, `lib/ai/provider.ts`, `lib/google.ts`,
  `lib/guardian/ai-screen.ts`, `lib/guardian/scam-ai.ts`, `lib/guardian/twilio.ts`,
  `lib/marketing/send.ts`, `lib/server/email.ts`, `lib/server/push.ts`,
  `lib/sync/providers/google.ts`, `lib/sync/providers/microsoft.ts`, `lib/vacations/weather-fetch.ts`,
  `lib/weather/open-meteo.ts`, `lib/trips/routing.ts`, `app/api/ai/flyer/route.ts`,
  `app/api/ai/voice/speak/route.ts`, `app/api/ai/voice/transcribe/route.ts`,
  `app/api/gif/search/route.ts`, `tests/external-fetch-boundaries.test.ts`
- Description: Several fixed-provider calls had no finite deadline, allowing a slow or stalled third-party
  connection to occupy a route, job, or browser request indefinitely.
- User impact: AI, sync, messaging, push, weather, or routing workflows could remain pending instead of
  returning a recoverable failure to the user or worker.
- Root cause: Provider calls used raw `fetch()` or relied on platform defaults without a shared timeout
  contract.
- Resolution: Added `fetchExternal` for server-side provider calls and `fetchWithTimeout` for browser-side
  public APIs. Deadlines range from 10 seconds for GIF search to 60 seconds for model/audio generation;
  existing public-calendar/social manual redirect and timeout validation remains unchanged.
- Tests performed: Timeout-boundary contracts, focused provider tests, full Vitest suite, typecheck, lint,
  production build, and public Playwright/axe E2E.
- Evidence: `tests/external-fetch-boundaries.test.ts` verifies timeout signals and statically prevents raw
  fetch calls in the audited fixed-provider files.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0223 - SECURITY DEFINER trigger functions lacked a pinned search_path

- Status: [x] Completed in code; migration pending in live environments.
- Severity: P1
- Category: Supabase function security / privilege boundary
- Feature: Family photo album counters and conversation last-message triggers
- File or files: `supabase/migrations/0014_core_platform.sql`,
  `supabase/migrations/0188_harden_trigger_function_security.sql`,
  `tests/sql-security-contract.test.ts`
- Database objects: `public.sync_album_photo_count()`, `public.update_conversation_last_message()`
- Description: Two legacy `SECURITY DEFINER` trigger functions ran without `SET search_path`, and their
  default execution privileges were not explicitly revoked from client roles.
- User impact: If invoked outside their trigger context, an attacker could potentially influence object
  resolution or call the definer functions directly through the exposed public function surface.
- Root cause: Migration `0014` predates the repository's current definer-function hardening standard.
- Resolution: Forward migration `0188` replaces both functions with `SET search_path = public` and revokes
  execution from `PUBLIC`, `anon`, and `authenticated`; trigger ownership and behavior are preserved.
- Tests performed: SQL security contracts, production migration contracts, full Vitest suite, typecheck,
  lint, production build, and public Playwright/axe E2E.
- Evidence: `tests/sql-security-contract.test.ts` verifies both pinned search paths, client privilege
  revocations, and additive transaction boundaries.
- Live status: Not applied by this agent; production schema audit must rerun after migrations through
  `0189` are deployed.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0224 - Stripe webhook claim columns drifted from the application contract

- Status: [x] Completed in code; reconciliation migration pending in live environments.
- Severity: P1
- Category: Supabase schema drift / webhook idempotency
- Feature: Stripe money webhook replay protection
- File or files: `scripts/audit-supabase-schema.mjs`,
  `supabase/migrations/0182_stripe_webhook_claims.sql`,
  `supabase/migrations/0189_reconcile_stripe_webhook_claims.sql`,
  `lib/stripe/webhook.ts`, `tests/production-migration-contract.test.ts`
- Description: The live `stripe_webhook_events` table was reachable, but the claim columns used by the
  application were unavailable. This prevents the webhook from safely recording active ownership.
- Root cause: An environment can retain migration history for `0182` while its additive ALTER TABLE did
  not complete, leaving the live schema behind the application and source migration contract.
- Resolution: Added forward migration `0189` with idempotent column/index reconciliation and changed the
  schema audit to verify both `processing_started_at` and `claim_token` together.
- Tests performed: Production migration contracts, full Vitest suite, typecheck, lint, production build,
  and public Playwright/axe E2E.
- Live status: The 2026-07-13 schema audit now finds both claim columns; migration-history verification
  and authenticated webhook/RLS testing still require an authorized isolated environment.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0225 - Public metric routes exposed database error details

- Status: [x] Completed in code; no migration required.
- Severity: P2
- Category: Public API error disclosure
- Feature: A/B, landing-page, and exit-intent metric ingestion
- File or files: `app/api/ab/track/route.ts`, `app/api/lp/track/route.ts`,
  `app/api/exit-intent/track/route.ts`, `tests/public-error-contract.test.ts`
- Description: Anonymous metric endpoints returned raw Supabase error messages on write failures.
- Resolution: Client responses now use stable generic messages while the server logs the underlying error
  for diagnosis; successful and duplicate metric behavior is unchanged.
- Tests performed: Public error contract, full Vitest suite, typecheck, lint, production build, and public
  Playwright/axe E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0226 - API routes exposed raw database error details

- Status: [x] Completed in code; no migration required.
- Severity: P2
- Category: API error disclosure
- Feature: Calendar, meal, vacation, concierge, and scheduled database writes
- File or files: affected `app/api` route handlers, `tests/database-error-boundaries.test.ts`
- Description: Several authenticated and cron handlers returned raw Supabase error messages in HTTP 500
  responses, exposing schema/provider details to callers or scheduled-service clients.
- Resolution: Replaced those responses with stable operation-specific messages and server-side diagnostics;
  error status and existing authorization behavior are unchanged.
- Tests performed: Database-error boundary contract, full Vitest suite, typecheck, lint, production build,
  and public Playwright/axe E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0227 - Marketplace hand-off seed was destructive and could choose arbitrary families

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Seed safety / tenant isolation
- Feature: Marketplace pickup and hand-off coordinator
- File or files: `supabase/seed_marketplace_handoffs.sql`, `supabase/SEED_ALL.sql`,
  `tests/seed-data-safety-contract.test.ts`
- Description: The new hand-off seed deleted tagged rows on rerun, selected the first family when the
  anchored account was absent, and created a stand-in family member when the fixture family was incomplete.
- Resolution: Replaced cleanup with deterministic conflict-safe IDs and `ON CONFLICT DO NOTHING`; the
  seed now fails closed unless the anchored account and two existing active members resolve.
- Tests performed: Seed safety, production-readiness seed, marketplace hand-off contracts, full Vitest
  suite, typecheck, lint, production build, and public Playwright/axe E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0228 - Remaining API and assistant paths exposed raw provider or database errors

- Status: [x] Completed in code; no migration required.
- Severity: P2
- Category: API error disclosure / model safety
- Feature: AI routes, Weekend Planner, marketing email, cron responses, and assistant tools
- File or files: affected `app/api` route handlers, `lib/assistant/tools.ts`,
  `tests/database-error-boundaries.test.ts`, `tests/assistant-tool-error-contract.test.ts`
- Description: Several authenticated AI and provider paths returned raw exception text, while assistant
  tools passed raw Supabase messages into the model's tool context.
- Resolution: Client and model-visible failures now use stable generic or classified safe messages;
  server logs retain the original exception for diagnosis.
- Tests performed: Focused error-boundary contracts, full Vitest suite, typecheck, lint, production build,
  and public Playwright/axe E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0229 - Marketplace returns seed was destructive and created synthetic members

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Seed safety / tenant isolation
- Feature: Marketplace rent/borrow returns fixture pack
- File or files: `supabase/seed_marketplace_returns.sql`, `supabase/SEED_ALL.sql`,
  `tests/seed-data-safety-contract.test.ts`
- Description: The returns seed used random IDs, deleted tagged listings and orders on rerun, selected
  a fallback family, and created a stand-in member when the fixture family was incomplete.
- Resolution: The seed now requires the anchored account and two existing active members, fails closed
  when migration `0192` or `returned_at` is missing, and uses deterministic conflict-safe inserts with
  no deletes or synthetic users.
- Tests performed: Returns/seed safety contracts, full Vitest suite, typecheck, lint, production build,
  and public Playwright/axe E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0230 - Context read failures could trigger automatic family provisioning

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Authentication / data integrity / failure handling
- Feature: Authenticated context resolution and automatic family setup
- File or files: `lib/supabase/auth.ts`, `tests/auth-context-error-contract.test.ts`
- Description: `getUserContext()` ignored errors from family membership, family, and preference reads.
  A transient database failure therefore looked like an account with no family and could enter the
  service-role auto-provisioning path.
- Resolution: Context reads now fail closed with a generic temporary-unavailable error while logging
  the diagnostic server-side. Automatic provisioning is reached only after a successful empty-membership
  result.
- Tests performed: Auth context contract, full Vitest suite, typecheck, lint, production build, and
  public Playwright/axe E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0231 - Public review, survey, and gift actions lacked abuse and payload bounds

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Public service-role side effects / abuse resistance
- Feature: Public reviews, surveys, and gift pledges
- File or files: `app/reviews/new/actions.ts`, `app/s/[slug]/actions.ts`, `app/gift/actions.ts`,
  `tests/public-server-action-safety.test.ts`
- Description: Unauthenticated server actions wrote through the service-role client without the shared
  durable IP limiter and trusted TypeScript-only string fields, allowing abusive write volume and runtime
  exceptions from hostile payload shapes.
- Resolution: Added durable IP limits before public writes and normalized strings/numbers only when their
  runtime types are valid, with bounded lengths preserved for stored fields.
- Tests performed: Public server-action contracts, public side-effect limiter contracts, full Vitest suite,
  typecheck, lint, production build, and public Playwright/axe E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0232 - Child username/PIN sign-in lacked an IP-wide guard and failed open on lookup errors

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Authentication / brute-force resistance / failure handling
- Feature: Public child username and PIN sign-in
- File or files: `app/(auth)/actions.ts`, `tests/child-login-action-security.test.ts`
- Description: The custom per-username throttle did not limit an attacker rotating across usernames,
  and throttle or child-login lookup errors were treated like empty results. Runtime payloads could also
  throw before the generic sign-in response.
- Resolution: Added a durable IP-wide limit before lookups, normalized untrusted username/PIN values,
  and fail closed with a generic temporary-unavailable response when either lookup fails.
- Tests performed: Child-login action/security contracts, child-login and throttle unit tests, full Vitest
  suite, typecheck, lint, production build, and public Playwright/axe E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0233 - Durable rate-limit RPC failures could bypass abuse controls

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Abuse resistance / failure handling
- Feature: Shared durable request limiter
- File or files: `lib/server/rate-limit-db.ts`, `tests/rate-limit-db.test.ts`
- Description: RPC errors, empty responses, malformed rows, and invalid retry values were treated as
  allowed requests, allowing database degradation to remove cross-instance request budgets.
- Resolution: The limiter now validates numeric inputs and the RPC response shape, fails closed with a
  short retry window by default, and exposes an explicit `failOpen` option only for a caller that accepts
  the availability tradeoff.
- Tests performed: Durable limiter regression suite, focused rate-limit contracts, typecheck, full Vitest,
  lint, production build, and public Playwright/axe E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0234 - Local rate-limit buckets could grow from untrusted proxy values

- Status: [x] Completed in code; no migration required.
- Severity: P1
- Category: Abuse resistance / resource exhaustion
- Feature: In-memory request limiter and client-IP keying
- File or files: `lib/server/rate-limit.ts`, `tests/rate-limit.test.ts`
- Description: The local bucket map had no capacity bound, and raw forwarded-header values could be
  arbitrarily long or malformed before entering local and durable limiter keys.
- Resolution: Proxy values are now accepted only when they are valid IPv4/IPv6 addresses, limiter
  parameters are normalized, expired buckets are pruned, and the in-memory map evicts the oldest key
  at a fixed maximum capacity.
- Tests performed: Local and durable limiter suites, full Vitest, typecheck, lint, production build,
  and public Playwright/axe E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0235 - Legacy seed writes could continue after insert failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Production data safety / seed tooling
- Feature: Service-role seed execution
- File or files: `scripts/seed*.mjs`, `tests/seed-failure-safety.test.ts`
- Description: Several legacy seed scripts logged Supabase insert failures and continued, which could
  leave a partially seeded environment while the command appeared to finish.
- Resolution: Insert and unexpected family-scoped cleanup failures now throw, causing a non-zero command
  result and preventing later seed sections from running against incomplete data.
- Tests performed: `node --check` for every seed script, focused seed safety contracts, full Vitest,
  typecheck, lint, production build, and public E2E.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0236 - Migration folder contained undocumented historical version collisions

- Status: [x] Completed in code; historical collisions remain intentionally preserved.
- Severity: P2
- Category: Deployment safety / migration history
- Feature: Supabase migration application
- File or files: `scripts/audit-migration-versions.mjs`, `package.json`, `.github/workflows/ci.yml`,
  `tests/migration-version-safety.test.ts`, `docs/PENDING_PROD_MIGRATIONS.md`
- Description: The migration folder contains 17 duplicate numeric prefixes from parallel work
  streams, while the production handoff documented only three. Renaming historical files without
  comparing the remote migration ledger could make an already-applied migration appear pending.
- Resolution: Added a deterministic audit with an explicit allowlist for the known historical set.
  `db:push` and CI now fail before contacting Supabase if a new collision is introduced or a known
  collision changes. The historical files were not renamed because production migration history is
  not currently accessible from this checkout.
- Tests performed: Migration-version regression tests, direct audit CLI, full Vitest, typecheck,
  lint, dependency audit, production build, and public Playwright/axe E2E.
- Evidence: `npm run db:audit:migrations` passed with next available version `0195`; remote migration
  ledger could not be queried because this checkout is not linked to a Supabase project.
- Resolution note: A future owner-approved migration-history reconciliation may renumber or squash
  these legacy files after comparing `supabase_migrations.schema_migrations` in every environment.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0237 - Marketplace photo uploads could become orphaned storage objects

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Storage lifecycle / production data safety
- Feature: Marketplace listing photo uploads
- File or files: `components/marketplace/photo-upload.tsx`, `components/marketplace/quick-post.tsx`,
  `components/modules/marketplace-module.tsx`, `lib/storage/marketplace-photos.ts`,
  `tests/marketplace-photo-storage.test.ts`
- Description: A successful upload could remain in the public `marketplace-photos` bucket when the
  listing insert failed, a draft was canceled/reset, a replacement was made, or a listing was deleted.
  The database row and storage object could therefore diverge and abandoned media could accumulate.
- Resolution: Added strict project-bucket/UUID-path parsing, shared cleanup helpers, and explicit
  rollback hooks for failed saves, modal cancellation, quick-post reset, replacement, and listing
  deletion. External pasted URLs are never treated as storage deletion targets.
- Tests performed: Marketplace storage path and lifecycle contracts, full Vitest, typecheck, lint,
  dependency audit, production build, live schema probes, and public Playwright/axe/overflow E2E.
- Evidence: Focused storage tests pass; the storage policy remains the final cross-user authorization
  boundary for all deletes.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0238 - Server actions exposed raw database/provider errors and signal reads failed open

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Error boundaries / data integrity
- Feature: AI actions, family actions, and Family Intelligence refresh
- File or files: `lib/supabase/errors.ts`, `lib/ai/actions.ts`, `lib/family/actions.ts`,
  `app/(app)/dashboard/family-signals/actions.ts`, `lib/intelligence/hard-signals-server.ts`,
  `tests/db-errors.test.ts`, `tests/server-action-error-boundaries.test.ts`
- Description: Several authenticated server actions returned raw Supabase messages to the browser or
  model. Family Intelligence also checked only the reminders query, so failures in its other source
  reads could produce signals from incomplete data and report success.
- Resolution: Added a server-action sanitizer that preserves actionable permission/conflict/network
  guidance while replacing unclassified details with stable fallbacks and logging diagnostics only on
  the server. All six signal source reads, the existing-signal read, and signal upsert now fail closed;
  the AI meal action also stops when its prerequisite meal insert fails.
- Tests performed: Error-boundary contracts, full Vitest, typecheck, lint, dependency audit, migration
  filename audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0250 - Support Ticket mutations ignored failures and used count-derived ticket numbers

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Admin reliability / data integrity / error handling
- Feature: Super Admin Support Tickets status controls and ticket creation
- File or files: `app/(app)/admin/support-tickets/actions.ts`, `components/admin/ticket-row-actions.tsx`,
  `tests/support-ticket-action-boundaries.test.ts`
- Description: Support Ticket transitions and creation ignored Supabase failures, returned no result to
  the caller, accepted unvalidated creation fields, and derived ticket numbers from count plus one,
  which could collide when administrators created tickets concurrently.
- Resolution: Support Ticket actions now validate privileged access and creation fields, check every
  required write and returned target row, sanitize unexpected failures, surface failures in the client,
  and generate collision-resistant ticket numbers.
- Tests performed: Focused Support Ticket boundary test, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/support-ticket-action-boundaries.test.ts` verifies guards, target/write checks,
  validation, collision-resistant numbering, and client feedback.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0251 - Tier and marketplace moderation mutations ignored required Supabase results

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Admin reliability / safety moderation / data integrity
- Feature: Tier & Features settings and Marketplace Reports moderation
- File or files: `app/(app)/admin/tier-features/actions.ts`, `lib/server/feature-tiers.ts`,
  `app/(app)/admin/marketplace/reports/actions.ts`, `tests/admin-tier-report-action-boundaries.test.ts`
- Description: Tier settings ignored failed reads/upserts and accepted unknown keys, while report
  moderation ignored required reads and listing-withdrawal failures and could resolve stale reports.
- Resolution: Tier mutations now fail closed on read/write errors and validate catalog keys and tiers.
  Report moderation checks all required results, rejects stale status transitions, and performs requested
  safety withdrawal before marking the report resolved.
- Tests performed: Focused boundary tests, full Vitest, typecheck, lint, dependency audit, migration audit,
  live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/admin-tier-report-action-boundaries.test.ts` verifies privileged guards, read/write
  checks, allowlists, target-row checks, withdrawal ordering, and stale-transition handling.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0252 - Admin queues treated failed Supabase reads as empty data

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Admin observability / safety queue integrity
- Feature: Marketplace Reports and Support Ticket admin read paths
- File or files: `app/(app)/admin/marketplace/reports/page.tsx`,
  `app/(app)/admin/support-tickets/page.tsx`, `app/(app)/admin/support/page.tsx`,
  `tests/admin-read-boundaries.test.ts`
- Description: Required service-role reads were destructured without checking errors, so a database
  outage rendered “No reports” or “No tickets” and hid operational work.
- Resolution: Required reads and report enrichment queries now log diagnostics server-side and render a
  stable retryable error state. Empty states are only used after successful reads.
- Tests performed: Focused read-boundary tests, full Vitest, typecheck, lint, dependency audit, migration
  audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/admin-read-boundaries.test.ts` verifies report enrichment and both ticket views reject
  silent empty-state fallbacks.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0253 - Competitive, CRM, and Proposal marketing writes ignored Supabase failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Marketing admin reliability / data integrity
- Feature: Competitive Intelligence, CRM, and Proposals
- File or files: `app/(app)/admin/marketing/competitive/actions.ts`,
  `app/(app)/admin/marketing/crm/actions.ts`, `app/(app)/admin/marketing/proposals/actions.ts`,
  `tests/marketing-competitive-crm-proposals-boundaries.test.ts`
- Description: Several privileged marketing inserts, updates, and deletes ignored Supabase errors and
  could log/revalidate as if a mutation succeeded, including mutations against missing target rows.
- Resolution: Every write now checks its error and affected row, and unexpected failures use the shared
  sanitized marketing action boundary before audit logging or revalidation.
- Tests performed: Focused marketing boundary tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/marketing-competitive-crm-proposals-boundaries.test.ts` guards sanitized failures,
  insert checks, and update/delete target checks across all three clusters.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0245 - Marketplace and Feedback actions exposed raw or unchecked failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Error boundaries / data integrity / user-facing reliability
- Feature: Marketplace saved listings, follows, offers, orders, hand-offs, circles, reports, alerts, and Feedback
- File or files: `app/(app)/marketplace/actions.ts`, `app/(app)/marketplace/alerts/actions.ts`,
  `app/(app)/marketplace/community/actions.ts`, `app/(app)/marketplace/report/actions.ts`,
  `app/(app)/marketplace/handoff/actions.ts`, `app/(app)/marketplace/negotiations/actions.ts`,
  `app/(app)/feedback/actions.ts`, `tests/marketplace-feedback-action-boundaries.test.ts`
- Description: Several high-traffic server actions returned raw Supabase messages and treated failed
  existence reads as empty results before performing dependent writes.
- Resolution: Added server-side diagnostic logging and sanitized action failures, checked required reads
  before mutation, and preserved explicit duplicate/conflict and domain messages for normal user guidance.
- Tests performed: Focused boundary and migration tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0240 - Onboarding finalize could report success after required writes failed

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Onboarding reliability / data integrity / error handling
- Feature: Guided onboarding and family provisioning
- File or files: `app/onboarding/actions.ts`, `lib/validation.ts`,
  `tests/onboarding-failure-safety.test.ts`
- Database objects: `families`, `family_members`, `subscriptions`, `user_preferences`,
  `family_onboarding`, `invites`, `calendar_events`, `onboarding_imports`, `onboarding_progress`
- Description: The finalize action logged failures from required service-role writes and continued,
  then returned success. A user could therefore land in a partially provisioned family with missing
  membership details, entitlements, invitations, imported calendar data, or completion state. Its old
  membership idempotency guard could also skip repair on a retry after a family row already existed.
- Resolution: Required provisioning writes now fail closed with server-side diagnostics and sanitized
  user-facing errors. Onboarding progress is marked `wizard/in_progress` before family creation or
  resume, allowing a later submission to continue an incomplete run while preserving completed or
  invite-accepted memberships. Runtime payload schemas now bound calendar text and validate profile,
  managed-member, and invite actions. Create-family, profile, reset, and standalone details/member/invite
  actions now check their required writes as well.
- Product decision: Welcome email and CRM/automation side effects remain best-effort because they do not
  determine whether the user's account or family state is complete.
- Tests performed: focused onboarding/error-boundary suites, full Vitest, typecheck, lint, dependency
  audit, migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/onboarding-failure-safety.test.ts` proves bounded runtime payloads and guards against
  required finalize paths reverting to log-and-continue behavior.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0241 - Privileged marketing mutations could report success after failed writes

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Admin reliability / data integrity / error handling
- Feature: Marketing administration, affiliates, payouts, and surveys
- File or files: `lib/marketing/admin.ts`, `app/(app)/admin/marketing/actions.ts`,
  `app/(app)/admin/marketing/affiliates/actions.ts`, `app/(app)/admin/marketing/surveys/actions.ts`,
  `tests/marketing-action-error-boundaries.test.ts`
- Database objects: `marketing_segments`, `marketing_campaigns`, `marketing_email_campaigns`,
  `marketing_content_items`, `marketing_seo_keywords`, `marketing_aeo_questions`,
  `marketing_sms_campaigns`, `marketing_social_posts`, `marketing_ad_campaigns`,
  `marketing_automation_workflows`, `marketing_funnels`, `marketing_landing_pages`,
  `marketing_forms`, `marketing_settings`, `affiliates`, `affiliate_referrals`, `surveys`
- Description: Many service-role marketing actions ignored mutation errors, wrote an audit record,
  revalidated the page, or redirected as if the operation succeeded. Affiliate payout and survey
  controls had the same failure mode, and survey creation exposed the raw database message.
- Resolution: Added one server-side diagnostic and sanitized failure helper. Every audited insert,
  update, delete, and upsert now checks the Supabase response before auditing, revalidation, or redirect.
  Auth guard failures now use stable user-facing messages instead of raw internal wording.
- Tests performed: focused marketing action contracts, affiliate/survey unit tests, database error
  sanitizer tests, typecheck, lint, full Vitest, production build, and public E2E.
- Evidence: `tests/marketing-action-error-boundaries.test.ts` covers all audited mutation branches and
  rejects raw database-error throws and log-and-continue patterns.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0239 - Admin, Trust Engine, and wallet actions exposed raw failure details

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Error boundaries / privileged operations
- Feature: Super Admin, Trust Engine, marketplace moderation, and Family Wallet actions
- File or files: `app/(app)/admin/actions.ts`, `app/(app)/admin/marketplace/reports/actions.ts`,
  `app/(app)/dashboard/trust/actions.ts`, `app/(app)/wallet/actions.ts`, `lib/wallet/server.ts`,
  `lib/supabase/errors.ts`, `tests/server-action-error-boundaries.test.ts`
- Description: Privileged server actions and wallet money-movement helpers returned raw Supabase or
  provider messages to callers, exposing implementation details and producing inconsistent failure
  handling across high-impact financial and administrative workflows.
- Resolution: Added server-side diagnostic logging plus sanitized action failures across the audited
  admin, moderation, Trust Engine, and wallet paths. Expected balance, policy, and duplicate-handle
  messages remain intentional; unexpected database/provider details now become stable fallbacks.
- Tests performed: Server-action boundary contracts, full Vitest, typecheck, lint, dependency audit,
  migration filename audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0242 - Account and device-security actions exposed raw or unchecked failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Account reliability / error handling / data integrity
- Feature: Account closure, family switching, dashboard preferences, profile updates, and App Lock
- File or files: `app/(app)/account/actions.ts`, `app/(app)/actions.ts`,
  `app/(app)/settings/app-lock-actions.ts`, `lib/server/profiles.ts`,
  `tests/account-action-error-boundaries.test.ts`
- Description: Several account actions returned raw Supabase messages. Family switching ignored its
  preference upsert result, App Lock could overwrite preferences after a failed read, and profile
  updates ignored family display-name synchronization failures.
- Resolution: Account and device-security mutations now log diagnostics server-side, return sanitized
  user-facing failures, check membership and preference reads, and fail closed on every required write.
- Tests performed: Focused account boundary tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/account-action-error-boundaries.test.ts` rejects raw database-message returns and
  proves the previously unchecked preference/profile paths have explicit failure branches.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0243 - Economy and simulated-investing approvals could leave partial ledger state

- Status: [x] Completed in code and covered by regression tests.
- Severity: P0
- Category: Financial data integrity / concurrency / error handling
- Feature: Family Economy redemptions and educational simulated investing
- File or files: `supabase/migrations/0196_atomic_economy_and_invest_decisions.sql`,
  `app/(app)/economy/actions.ts`, `app/(app)/wallet/invest/actions.ts`,
  `lib/database.types.ts`, `tests/economy-invest-action-boundaries.test.ts`
- Database objects: `currency_transactions`, `economy_redemptions`, `economy_rewards`,
  `wallet_transactions`, `invest_orders`, `invest_holdings`, `wallet_audit_logs`
- Description: Approval actions wrote a token/cash ledger entry and then performed separate status,
  holding, stock, and audit writes. A failure or concurrent approval could leave unmatched state or
  overspend a balance; several surrounding reads and direct writes also ignored Supabase errors.
- Resolution: Added authenticated, manager-checked, row-locking RPCs that commit each approval as one
  transaction. Action adapters now map stable domain outcomes, sanitize provider failures, and check
  every remaining required read/write.
- Tests performed: Focused atomic-boundary and migration tests, full Vitest, typecheck, lint,
  dependency audit, migration audit, live schema probes, production build, and public E2E.
- Evidence: `tests/economy-invest-action-boundaries.test.ts` verifies the RPC grants/revocations,
  row-lock contracts, atomic status transitions, and action-layer failure boundaries.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0244 - Guardian suggestion review could partially apply AI safety changes

- Status: [x] Completed in code and covered by regression tests.
- Severity: P0
- Category: Child safety / authorization / data integrity / error handling
- Feature: Guardian AI suggestions, contact trust, routing rules, and review audit
- File or files: `supabase/migrations/0198_guardian_suggestion_review_transaction.sql`,
  `app/(app)/guardian/actions.ts`, `lib/database.types.ts`,
  `tests/guardian-action-error-boundaries.test.ts`
- Database objects: `guardian_suggestions`, `guardian_contacts`, `guardian_routing_rules`,
  `guardian_audit_log`
- Description: Reviewing a suggestion updated the review row and then applied proposed trust/routing
  changes through separate unchecked writes. Other Guardian actions exposed raw database messages and
  ignored a phone-assignment read failure.
- Resolution: Added a manager-authorized, row-locked review RPC that commits proposed changes, review
  metadata, and the audit entry together. Guardian actions now sanitize database failures, check the
  phone-assignment read, and surface audit-write diagnostics without claiming they are required state.
- Tests performed: Focused Guardian boundary and migration tests, full Vitest, typecheck, lint,
  dependency audit, migration audit, live schema probes, production build, and public E2E.
- Evidence: `tests/guardian-action-error-boundaries.test.ts` verifies RPC authorization grants,
  revocation, locking, atomic state transitions, and action-layer error boundaries.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0246 - Marketplace hand-off completion could diverge from order state

- Status: [x] Completed in code and covered by regression tests.
- Severity: P0
- Category: Marketplace integrity / concurrency / error handling
- Feature: Marketplace pickup and hand-off completion
- File or files: `supabase/migrations/0199_marketplace_handoff_completion.sql`,
  `app/(app)/marketplace/handoff/actions.ts`, `lib/database.types.ts`,
  `tests/marketplace-feedback-action-boundaries.test.ts`
- Database objects: `marketplace_handoffs`, `marketplace_orders`
- Description: Completing a pickup updated the hand-off first and then best-effort advanced the order,
  allowing a failure or concurrent completion to leave the two records inconsistent.
- Resolution: Added an authenticated, family-authorized, row-locking RPC that normalizes and verifies the
  confirmation code and commits both status transitions in one transaction. The action maps stable domain
  outcomes and no longer performs a second unchecked order write.
- Tests performed: Focused Marketplace/migration tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0247 - Wallet and Stripe Money actions exposed raw financial failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Financial reliability / error handling / data integrity
- Feature: Wallet hub, Stripe Treasury, card issuing, and card reveal
- File or files: `app/(app)/wallet/hub-actions.ts`, `app/(app)/money/actions.ts`,
  `tests/wallet-money-action-boundaries.test.ts`
- Description: Wallet and Stripe actions returned raw database/provider messages and several required
  account, card, wallet, and member reads were ignored before financial mutations. Audit-write failures
  also risked turning a successful external operation into a client-visible failure that could be retried.
- Resolution: Financial actions now log diagnostics server-side, return stable failures, fail closed on
  prerequisite reads, and treat post-effect audit writes as observable best-effort.
- Tests performed: Focused wallet/money and database-error tests, full Vitest, typecheck, lint,
  dependency audit, migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/wallet-money-action-boundaries.test.ts` rejects raw action failures and verifies
  required-read checks plus best-effort audit logging.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0248 - AI assistant could expose tool failures and report unsaved turns as complete

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: AI safety / data integrity / error handling
- Feature: AI assistant tool loop, chat persistence, and Super Admin AI settings
- File or files: `lib/ai/provider.ts`, `app/api/ai/chat/route.ts`, `app/(app)/admin/ai/actions.ts`,
  `tests/ai-action-boundaries.test.ts`, `tests/assistant-tool-loop.test.ts`
- Description: Exceptions thrown by assistant tools were returned verbatim to the model and persisted
  in tool results. AI chat ignored conversation/context read failures and message-write failures, so it
  could act on incomplete family state or report a completed turn that was not saved.
- Resolution: Tool and admin failures now use stable messages with server-side diagnostics. AI chat fails
  closed on required initialization/context reads, checks the core message insert, and reports persistence
  status in its completion event; non-core title metadata failures remain logged independently.
- Tests performed: Focused AI boundary, tool-loop, and database-error tests, full Vitest, typecheck, lint,
  dependency audit, migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/ai-action-boundaries.test.ts` verifies sanitized tool/admin failures, fail-closed context
  reads, and checked persistence; the tool-loop test verifies thrown tool errors remain non-fatal and sanitized.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0249 - Admin Management mutations ignored privileged access failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Admin security / access integrity / error handling
- Feature: Admin Management deactivate, activate, revoke, and invite controls
- File or files: `app/(app)/admin/admins/actions.ts`, `components/admin/admin-row-actions.tsx`,
  `tests/admin-management-action-boundaries.test.ts`
- Description: Privileged admin-access mutations ignored database errors and missing target rows, while
  the client closed the control as if the operation succeeded. Invitations also accepted unvalidated
  email and role values.
- Resolution: Admin actions now re-check Super Admin access, validate email/role input, check all writes
  and target rows, sanitize unexpected failures, and return explicit results. The client surfaces errors
  and only closes the menu after a confirmed success.
- Tests performed: Focused Admin Management boundary test, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/admin-management-action-boundaries.test.ts` verifies privileged guards, result checks,
  invitation validation, and client failure feedback.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0254 - Marketing asset and content writes ignored required results

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Marketing admin reliability / storage lifecycle / data integrity
- Feature: Marketing Assets and Content publication
- File or files: `app/(app)/admin/marketing/assets/actions.ts`,
  `app/(app)/admin/marketing/content/actions.ts`, `tests/marketing-assets-content-boundaries.test.ts`
- Description: Asset storage and database failures could be treated as no-ops, client-provided storage
  paths were used for deletion, and content reads, blog upserts, and publish-state updates could fail
  without preventing audit logging or revalidation.
- Resolution: Asset and content actions now check required reads, storage operations, inserts, updates,
  and target rows; failed asset-row writes roll back the uploaded object, and deletion uses the stored
  path. Unexpected failures use the shared sanitized marketing boundary.
- Tests performed: Focused asset/content boundary tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/marketing-assets-content-boundaries.test.ts` guards storage rollback, server-derived
  deletion paths, target checks, content reads, blog upserts, and publish-state checks.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0255 - Loyalty administration writes ignored required results

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Marketing admin reliability / points integrity / error handling
- Feature: Loyalty settings, rewards, and redemption controls
- File or files: `app/(app)/admin/marketing/loyalty/actions.ts`,
  `tests/marketing-loyalty-action-boundaries.test.ts`
- Description: Loyalty settings and reward writes ignored Supabase failures, redemption transitions did
  not require an affected pending row, failed redemption reads could be treated as missing data, and
  points-engine exceptions could cross the Super Admin action boundary unsanitized.
- Resolution: Settings, reward, fulfillment, and cancellation writes now check errors and target rows;
  redemption transitions are status-guarded, failed reads close the action, and points-engine failures
  use the shared sanitized marketing boundary before audit logging or revalidation.
- Tests performed: Focused loyalty boundary tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/marketing-loyalty-action-boundaries.test.ts` guards settings/reward result checks,
  pending redemption transitions, sanitized points failures, and failed-read handling.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0256 - Marketing delivery and personalization writes ignored required results

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Marketing delivery reliability / concurrency / error handling
- Feature: Push campaigns and personalization rules
- File or files: `app/(app)/admin/marketing/push/actions.ts`,
  `app/(app)/admin/marketing/personalization/actions.ts`,
  `tests/marketing-delivery-action-boundaries.test.ts`
- Description: Push campaigns could be double-sent by concurrent administrators, remain stuck in
  `sending` after prerequisite failures, and silently treat failed reads or final writes as success.
  Personalization mutations also ignored failed writes and missing targets.
- Resolution: Push campaigns now use a status-guarded claim, fail and recover pre-delivery errors,
  check device/profile/suppression reads and final persistence, and validate soft deletion. Personalization
  inserts, updates, and deletes now check errors and affected rows through the sanitized boundary.
- Tests performed: Focused delivery boundary tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/marketing-delivery-action-boundaries.test.ts` guards campaign claiming, failure
  recovery, prerequisite checks, final persistence, and personalization target checks.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0257 - Reputation, video, and review writes ignored required results

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Marketing content reliability / publication integrity / error handling
- Feature: Testimonials, case studies, marketing videos, reviews, and reputation settings
- File or files: `app/(app)/admin/marketing/reputation/actions.ts`,
  `app/(app)/admin/marketing/video/actions.ts`, `app/(app)/admin/marketing/reviews/actions.ts`,
  `tests/marketing-reputation-video-review-boundaries.test.ts`
- Description: Public-facing content and review controls could report success after failed writes,
  missing targets, failed reputation singleton upserts, or failed video asset reads.
- Resolution: All inserts, updates, deletes, publication changes, review replies, asset reads, and
  singleton settings writes now check Supabase results and affected rows through the sanitized marketing
  action boundary. Missing video assets remain validated input no-ops.
- Tests performed: Focused reputation/video/review boundary tests, full Vitest, typecheck, lint,
  dependency audit, migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/marketing-reputation-video-review-boundaries.test.ts` guards publication, target-row,
  asset-read, review, and settings result checks.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0258 - Experiment, exit-intent, and survey writes ignored required results

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Marketing experimentation / content delivery / error handling
- Feature: A/B Experiments, Exit Intent, and Surveys
- File or files: `app/(app)/admin/marketing/experiments/actions.ts`,
  `app/(app)/admin/marketing/exit-intent/actions.ts`, `app/(app)/admin/marketing/surveys/actions.ts`,
  `tests/marketing-experiment-exit-survey-boundaries.test.ts`
- Description: Experiment inserts and control writes ignored returned rows, exposed raw database errors,
  and accepted arbitrary winner keys. Exit-intent and survey controls could revalidate after failed or
  missing-target updates.
- Resolution: Experiment writes now use sanitized failures and target checks, winner selection validates
  configured variants, and exit-intent/survey writes check errors and affected rows before audit logging
  or revalidation.
- Tests performed: Focused experiment/exit-intent/survey boundary tests, full Vitest, typecheck, lint,
  dependency audit, migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/marketing-experiment-exit-survey-boundaries.test.ts` guards experiment target/winner
  validation, exit-intent insert/target checks, and survey mutation result checks.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0259 - Core marketing, referral, and lead-score writes ignored required results

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Marketing admin reliability / referral integrity / error handling
- Feature: Shared marketing controls, referrals, and lead scores
- File or files: `app/(app)/admin/marketing/actions.ts`,
  `app/(app)/admin/marketing/referrals/actions.ts`, `app/(app)/admin/marketing/lead-scores/actions.ts`,
  `lib/referrals/server.ts`, `lib/marketing/contact-score-compute.ts`,
  `tests/marketing-core-referral-boundaries.test.ts`
- Description: Shared marketing updates could audit and revalidate after missing-target writes, SEO/AEO
  inserts and settings upserts ignored returned rows, referral configuration ignored persistence errors,
  public referral writes returned raw database messages, and lead-score recomputation ignored read/upsert failures.
- Resolution: Marketing writes now require affected/returned rows, referral configuration and public referral
  failures use stable messages, and lead-score reads/upserts fail closed through an audited admin boundary.
- Tests performed: Focused core/referral boundary tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/marketing-core-referral-boundaries.test.ts` guards returned-row checks, referral error
  sanitization, lead-score failure handling, and admin audit wiring.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0260 - Payment and webhook persistence failures were acknowledged as success

- Status: [x] Completed in code and covered by regression tests.
- Severity: P0
- Category: Payments / webhook reliability / data integrity
- Feature: Stripe, Resend, and referral conversion webhooks
- File or files: `app/api/webhooks/stripe/route.ts`, `lib/stripe/webhook.ts`,
  `app/api/webhooks/resend/route.ts`, `lib/referrals/server.ts`,
  `tests/webhook-persistence-boundaries.test.ts`
- Description: Stripe subscription, checkout, and final event-ledger writes could fail without causing a
  retryable response. Resend campaign counters, suppressions, and final event state had the same risk,
  and referral conversion could report success after a lost update.
- Resolution: Critical webhook and referral writes now check errors and returned rows, fail closed, and
  return retryable responses where the provider should redeliver the event.
- Tests performed: Focused webhook replay/persistence tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/webhook-persistence-boundaries.test.ts` guards Stripe finalization, Resend counters/
  suppressions, and referral conversion result checks.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0261 - Sync account lifecycle writes ignored required results

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Integrations / encrypted credential lifecycle / data integrity
- Feature: Connected sync accounts and token refresh
- File or files: `lib/sync/accounts.ts`, `tests/sync-account-persistence-boundaries.test.ts`
- Description: Reconnects could overwrite a refresh token after a failed prerequisite read, connection
  upserts were unchecked, and token refresh returned a new access token even when encrypted persistence failed.
- Resolution: Account, token, and connection writes now require successful returned rows; prerequisite reads
  and refresh persistence fail closed with stable server-side errors.
- Tests performed: Focused sync-account boundary tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/sync-account-persistence-boundaries.test.ts` guards refresh-token read handling,
  connection persistence, and refresh-write checks.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0262 - Sync job lifecycle could report success without durable status

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Integrations / synchronization reliability / data integrity
- Feature: Provider-agnostic and Google sync job lifecycle
- File or files: `lib/sync/engine/generic.ts`, `lib/sync/engine/google.ts`,
  `tests/sync-job-persistence-boundaries.test.ts`
- Description: Sync job/run creation and completion updates were optional and unchecked, so provider work
  could return counts while the durable job state remained missing or running. Generic token refresh also
  ignored its persistence result.
- Resolution: Both engines now fail closed on job/run creation and require successful run, job, connection,
  and account finalization; generic token refresh requires encrypted persistence before returning.
- Tests performed: Focused sync-job boundary tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/sync-job-persistence-boundaries.test.ts` guards creation, finalization, and generic
  refresh-write contracts across both engines.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0263 - Generic sync item writes could increment counts after persistence failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Integrations / synchronization reliability / data integrity
- Feature: Provider-agnostic calendar and task pull/push reconciliation
- File or files: `lib/sync/persistence.ts`, `lib/sync/engine/generic.ts`,
  `tests/sync-generic-item-persistence.test.ts`
- Description: Generic sync treated failed mapping/local-row reads as absent state and incremented
  imported/exported/conflict counts after unchecked creation, update, deletion, mapping, conflict, or cursor writes.
- Resolution: A shared `requireSyncWrite` guard now fails closed for all generic pull/push state transitions,
  and count increments occur only after local and mapping persistence succeeds.
- Tests performed: Focused generic-item boundary tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/sync-generic-item-persistence.test.ts` guards pull/push mappings, local transitions,
  conflict rows, cursor persistence, and the shared fail-closed helper.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0264 - Google sync item writes could increment counts after persistence failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Integrations / synchronization reliability / data integrity
- Feature: Google Calendar and Tasks pull/push reconciliation
- File or files: `lib/sync/engine/google.ts`, `tests/sync-google-item-persistence.test.ts`
- Description: Google sync treated failed mapping/local-row reads as absent state and advanced
  imported/exported/conflict counts after unchecked creation, update, deletion, mapping, conflict, or cursor writes.
- Resolution: Google Calendar/Tasks reconciliation now uses the shared `requireSyncWrite` guard for every
  local/mapping state transition and increments counts only after persistence succeeds.
- Tests performed: Focused Google-item boundary tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/sync-google-item-persistence.test.ts` guards Google pull/push mappings, local transitions,
  conflict rows, cursor persistence, and shared guard usage.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0265 - AI assistant tools could report success after partial persistence failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: AI assistant / synchronization reliability / data integrity
- Feature: AI assistant family action and read tools
- File or files: `lib/assistant/tools.ts`, `tests/assistant-persistence-boundaries.test.ts`
- Description: Assistant list reads treated Supabase failures as empty state, chore assignment writes were
  ignored after chore creation, and recurring reminder completion could leave a completed source without its next occurrence.
- Resolution: Assistant list and lookup reads now fail closed. Failed chore assignments roll back the new chore,
  and failed recurring-reminder creation restores the source reminder to active before returning an error.
- Tests performed: Focused assistant persistence/error-boundary tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/assistant-persistence-boundaries.test.ts` simulates list-read failures, assignment failure with
  parent rollback, recurring-reminder failure with source rollback, and pending-decision read failure.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0266 - Family media uploads could orphan storage objects after metadata failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Storage / data integrity / error handling
- Feature: Family Photos and Create Memory uploads
- File or files: `components/memories/create-memory.tsx`, `components/modules/photos-module.tsx`,
  `components/marketplace/photo-upload.tsx`, `tests/family-media-persistence.test.ts`
- Description: Successful storage uploads could be left orphaned when the `family_photos` insert failed;
  PhotosModule counted uploads without checking the row write, and upload toasts exposed raw storage errors.
- Resolution: Family media metadata writes are checked before success counts; failed row writes remove the
  object, storage errors use stable messages, favorite updates are surfaced, and upload paths prefer UUIDs.
- Tests performed: Focused family-media contract tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/family-media-persistence.test.ts` guards UUID paths, failed-insert cleanup, checked
  upload counts, stable marketplace errors, and Favorites update handling.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0267 - Autopilot could act on incomplete reads or strand auto-actions before suggestion persistence

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: AI automation / data integrity / error handling
- Feature: Family Autopilot scan and cron execution
- File or files: `lib/autopilot/scan.ts`, `tests/autopilot-persistence-boundaries.test.ts`
- Description: Required family reads treated Supabase errors as empty state, stale-suggestion deletion and
  shopping-list provisioning were unchecked, and auto-created reminders or groceries could survive a failed
  `autopilot_suggestions` insert without an undoable record.
- Resolution: Required reads fail closed; list/deletion writes are checked; auto-side effects are captured
  and compensated when suggestion persistence fails; Digital Twin enhancement writes log rejected results.
- Tests performed: Focused Autopilot persistence-boundary tests, full Vitest, typecheck, lint, dependency
  audit, migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/autopilot-persistence-boundaries.test.ts` verifies no writes occur after a required read
  failure and guards side-effect cleanup contracts.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0268 - Chore rewards could report approval after partial gamification persistence failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family missions / data integrity / error handling
- Feature: Chore approval, XP progress, and badge awards
- File or files: `lib/chores/server.ts`, `app/(app)/missions/actions.ts`,
  `tests/chore-reward-persistence.test.ts`
- Description: Progress updates, approved-history reads, and member badge writes were unchecked; a reward
  failure could leave XP partial or an assignment approved without its gamification state.
- Resolution: Required reads/writes now fail closed, badge awards use idempotent upserts, progress is restored
  after downstream failure, and the approval finalizer restores the original assignment reward/status fields.
- Tests performed: Focused chore reward persistence tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/chore-reward-persistence.test.ts` covers lookup/write/history/badge failures, rollback,
  idempotent badge results, and approval rollback wiring.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0269 - Chore proof uploads could orphan media after submission or AI persistence failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family missions / storage / data integrity / error handling
- Feature: Chore proof upload and AI validation workflow
- File or files: `app/(app)/missions/actions.ts`, `tests/chore-proof-persistence.test.ts`
- Description: Proof uploads used collision-prone paths, exposed raw storage errors, and could leave media
  behind when the submission, validator, AI-validation, or assignment write failed.
- Resolution: Server UUID paths and stable errors are used; cleanup removes uploaded media on every pre-review
  failure and deletes the submission row when validation or assignment persistence cannot complete.
- Tests performed: Focused chore proof persistence tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/chore-proof-persistence.test.ts` guards UUID paths, stable errors, and cleanup contracts
  for upload, submission, validator, validation-row, and assignment failures.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0270 - Child login throttle/provisioning writes could leave authentication state partial

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Authentication / brute-force resistance / data integrity
- Feature: Child username/PIN sign-in and parent child-login provisioning
- File or files: `app/(auth)/actions.ts`, `app/(app)/family/child-login-actions.ts`, `tests/child-login-persistence.test.ts`
- Description: Failed-attempt throttle upserts were ignored, allowing a write outage to remove the durable brute-force defense; child provisioning ignored active-family preference persistence after creating Auth/member/mapping state.
- Resolution: Counter-write failures now fail closed with a temporary-unavailable response; preference failure rolls back mapping, member link, and Auth user.
- Tests performed: Focused child-login persistence/security tests, full Vitest, typecheck, lint, dependency audit, migration audit, live schema probes, production build, public Playwright/axe/overflow E2E.
- Evidence: `tests/child-login-persistence.test.ts` guards throttle error handling, both failure paths, and provisioning compensation.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0271 - Social publishing could report success after partial persistence failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Social publishing / external side effects / data integrity
- Feature: Social Content Studio publish and schedule workflows
- File or files: `lib/social/publish.ts`, `lib/social/connectors.ts`, `app/(app)/dashboard/social/actions.ts`, `tests/social-publish-persistence.test.ts`
- Description: Required social target, variant, schedule, job, target-outcome, result, and post-state writes were ignored; setup failures could leave orphan posts, and provider exceptions could expose raw details.
- Resolution: Required reads/writes now fail closed, incomplete pre-publish posts are cleaned up, publish results are persisted before final target state, uncertain post-publish state is preserved for review, and provider exceptions use stable client messages.
- Tests performed: Focused social publishing tests, full Vitest, typecheck, lint, dependency audit, migration audit, live schema probes, production build, public Playwright/axe/overflow E2E.
- Evidence: `tests/social-publish-persistence.test.ts` guards target setup, job/read transitions, result ordering, schedule cleanup, safe action errors, and connector redaction.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0272 - Social ancillary mutations could report success after ignored writes or over-broad access checks

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Social access control / data integrity / input validation
- Feature: Social account, inbox, media-library, settings, and access-management actions
- File or files: `app/(app)/dashboard/social/actions.ts`, `tests/social-action-persistence.test.ts`
- Description: Disconnect, resolve, media, settings, and role-grant writes ignored returned errors; role grants used `manage_settings`, accepted arbitrary users/roles, and media URLs/text had no server-side bounds.
- Resolution: Required mutations now check returned rows and errors, form actions fail with stable messages, role grants require `manage_access` plus an active current-family member and valid role, and media input is bounded with HTTP(S)-only URLs.
- Tests performed: Focused social action/publish/role tests, full Vitest, typecheck, lint, dependency audit, migration audit, live schema probes, production build, public Playwright/axe/overflow E2E.
- Evidence: `tests/social-action-persistence.test.ts` guards mutation checks, input validation, and the manage-access/current-family boundary.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0273 - Loyalty awards and redemptions could become inconsistent under concurrency

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Loyalty / data integrity / concurrency / Supabase RPC security
- Feature: Loyalty points, reward redemption, finite stock, and cancellation refunds
- File or files: `supabase/migrations/0204_atomic_loyalty_transactions.sql`, `lib/loyalty/server.ts`,
  `app/(app)/admin/marketing/loyalty/actions.ts`, `tests/loyalty-atomic-persistence.test.ts`
- Description: Points debits, redemption creation, and finite-stock decrements were separate writes;
  cancellation also marked a redemption cancelled before attempting a best-effort refund.
- Resolution: Service-role-only row-locking RPCs now commit account, ledger, redemption, and stock changes
  atomically. The server and admin action consume structured RPC outcomes, and cancellation refunds points
  and restores finite stock in the same transaction.
- Tests performed: Focused loyalty persistence tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/loyalty-atomic-persistence.test.ts` guards RPC routing, row locks, service-role grants,
  stock restoration, and the absence of direct best-effort ledger writes.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0274 - Wallet money actions could leave ledger and approval state partial

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family Wallet / financial data integrity / concurrency / Supabase RPC security
- Feature: Wallet transfers, gift approvals, spend approvals, and allowance approvals
- File or files: `supabase/migrations/0205_atomic_wallet_money_actions.sql`, `lib/wallet/server.ts`,
  `app/(app)/wallet/actions.ts`, `tests/wallet-atomic-persistence.test.ts`
- Description: Transfers debited and credited in separate writes, gift approvals credited before gift
  state was updated, and parent approvals updated their ledger and approval/audit rows independently.
- Resolution: Authenticated manager-checked RPCs now lock the affected wallet, bucket, gift, approval, and
  transaction rows; server-side split allocation preserves every cent, and ledger/state/audit writes
  commit atomically. Typed wrappers map domain failures to stable action messages.
- Tests performed: Focused Wallet persistence tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/wallet-atomic-persistence.test.ts` guards row locks, authenticated grants, split-credit
  helper use, typed RPC routing, and removal of direct partial state transitions.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0275 - Vacation AI could report success after partial persistence failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Vacation AI / data integrity / authorization
- Feature: AI vacation builder, recommendations, and concierge conversations
- File or files: `app/api/vacations/ai/route.ts`, `tests/vacation-ai-persistence-boundaries.test.ts`
- Description: Trip context reads, recommendation replacement writes, generated itinerary/activity/budget/
  packing writes, and chat message writes ignored returned database errors. Existing conversation IDs were
  also accepted without confirming they belonged to the active family and vacation.
- Resolution: Context and mutation errors now fail closed with stable responses; generated rows are tracked
  and compensated on failure, existing budgets are restored when needed, and conversation ownership is
  checked before messages are persisted.
- Tests performed: Focused Vacation AI and database-boundary tests, full Vitest, typecheck, lint, dependency
  audit, migration audit, live schema probes, production build, seed invariants, and public Playwright/axe/
  overflow E2E.
- Evidence: `tests/vacation-ai-persistence-boundaries.test.ts` guards fail-closed reads, checked writes,
  rollback tracking, and family/vacation conversation scoping.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0276 - AI meal planning could replace slots after a partial save

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: AI meal planning / data integrity / recovery
- Feature: One-click AI meal planner with meal and pantry context
- File or files: `app/api/ai/meals/plan/route.ts`, `tests/ai-meal-plan-persistence.test.ts`
- Description: Candidate and pantry read errors were ignored, targeted slots were deleted without checking,
  newly mirrored meals could remain orphaned, and a failed or incomplete plan insert could still leave the
  planner reporting a successful write.
- Resolution: Context reads and replacement mutations now fail closed. Existing targeted slots are captured
  and restored on failure, generated meal rows are removed when they cannot be used, and the success response
  requires every model assignment to be persisted.
- Tests performed: Focused AI meal planner and database-boundary tests, full Vitest, typecheck, lint, and
  dependency audit.
- Evidence: `tests/ai-meal-plan-persistence.test.ts` guards read failures, generated-meal cleanup, slot
  restoration, and checked replacement writes.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0277 - AI chat accepted unverified conversation ownership

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family AI / authorization / privacy
- Feature: Streaming family assistant conversations
- File or files: `app/api/ai/chat/route.ts`, `tests/ai-chat-ownership.test.ts`
- Description: The client generated the conversation UUID and the endpoint used it after an ignore-duplicate
  upsert without explicitly confirming that the existing conversation belonged to the active family and user.
- Resolution: Every conversation ID is re-read through active `family_id` and `user_id` ownership filters before
  history is loaded or messages are persisted. Read failures and missing ownership now stop with stable responses.
- Tests performed: Focused AI chat ownership and database-boundary tests, full Vitest, typecheck, lint, and clean
  production build.
- Evidence: `tests/ai-chat-ownership.test.ts` guards the ownership filters and the no-history/no-message path
  when ownership validation fails.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0278 - Chore state transitions could silently diverge

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family Missions / data integrity / rewards
- Feature: Chore proof review, approval, rejection, dispute, and creation flows
- File or files: `app/(app)/missions/actions.ts`, `tests/chore-state-transition-persistence.test.ts`
- Description: Submission, assignment, dispute, and assignment-creation writes were not consistently checked;
  auto-approval and parent approval could leave related rows out of sync after a later write failed.
- Resolution: Checked transition helpers now require updated rows, restore prior submission/assignment state on
  failure, send failed auto-approval to parent review, clean up dispute rows on failed transitions, and remove
  newly created chores when assignment creation fails.
- Tests performed: Focused chore state/proof/reward tests, full Vitest, typecheck, lint, dependency audit, and
  clean production build.
- Evidence: `tests/chore-state-transition-persistence.test.ts` guards transition checks, rollback paths, dispute
  cleanup, and chore creation compensation.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0279 - Failed allowance credits could be marked as paid

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family Wallet / financial data integrity / recovery
- Feature: Manual due-allowance execution
- File or files: `app/(app)/wallet/actions.ts`, `tests/wallet-allowance-persistence.test.ts`
- Description: The manual allowance runner ignored rule-read and schedule-write failures, and advanced
  `next_run_on` even when the child-wallet credit failed, potentially skipping an allowance permanently.
- Resolution: Rule reads and schedule advances now fail closed. Each schedule advance is rolled back if its
  wallet credit fails, and the action reports only successfully credited rules and cents.
- Tests performed: Focused wallet allowance/atomic/error-boundary tests, full Vitest, typecheck, lint, dependency
  audit, and clean production build.
- Evidence: `tests/wallet-allowance-persistence.test.ts` guards checked reads, schedule updates, rollback, and
  success counters.
- Verified by: Codex
- Date completed: 2026-07-15

### TODO-0280 - Allowance cron ignored schedule and credit failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family Wallet / financial data integrity / scheduled automation
- Feature: Cron-driven due allowances
- File or files: `app/api/cron/wallet-allowance/route.ts`, `tests/cron-wallet-allowance-persistence.test.ts`
- Description: The cron ignored its schedule update result and could advance a rule after a failed wallet
  credit, making retries unsafe and hiding persistence failures from monitoring.
- Resolution: The cron now checks the schedule claim before crediting, restores the prior schedule after a
  failed credit, counts only successful credits, and fails visibly when the run cannot persist safely.
- Tests performed: Focused cron allowance persistence contract, full Vitest, typecheck, lint, dependency audit,
  and clean production build.
- Evidence: `tests/cron-wallet-allowance-persistence.test.ts` guards schedule-before-credit ordering, rollback,
  checked failures, and success-only counters.
- Verified by: Codex
- Date completed: 2026-07-15

### TODO-0281 - Goal funding could debit without updating goal progress

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family Wallet / financial data integrity / concurrency / Supabase RPC security
- Feature: Savings goal funding from a child's Save bucket
- File or files: `supabase/migrations/0208_atomic_wallet_goal_funding.sql`, `lib/wallet/server.ts`,
  `app/(app)/wallet/actions.ts`, `tests/wallet-goal-persistence.test.ts`
- Description: The action calculated a Save balance, inserted an immutable debit, and then ignored the goal
  update result. Concurrent funding could also race on the same Save balance.
- Resolution: A manager-checked row-locking RPC now rechecks the Save balance, inserts the debit, updates goal
  progress/status, and writes the audit event in one transaction. The server action uses the typed RPC wrapper.
- Tests performed: Focused goal/atomic wallet persistence contracts, full Vitest, typecheck, lint, dependency
  audit, migration audit, and clean production build.
- Evidence: `tests/wallet-goal-persistence.test.ts` guards authorization, row locks, atomic write ordering,
  and removal of direct best-effort money writes from the action.
- Verified by: Codex
- Date completed: 2026-07-15

### TODO-0288 - Legacy connection adapters reported planned sync as runnable

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family Connections / third-party integrations / sync correctness
- Feature: Legacy Google Calendar and Gmail adapter registry
- File or files: `lib/connections/adapter.ts`, `lib/connections/adapters/google-calendar.ts`,
  `lib/connections/adapters/gmail.ts`, `lib/connections/adapters/index.ts`, `tests/connections-adapter.test.ts`
- Description: OAuth key presence and a saved connection made planned adapters appear runnable even though
  their provider methods returned empty success without real API I/O.
- Resolution: Added explicit implementation readiness, blocked planned adapters in `planSync`, returned
  unavailable errors from credentialed methods, and filtered `syncableProviderIds()` to implemented adapters.
- Tests performed: 25 focused Connections tests; full 411-file/3,063-test suite; typecheck; lint; dependency
  audit; migration audit; diff check; and clean 250-route production build.
- Evidence: `tests/connections-adapter.test.ts` covers planned-adapter blocking and credentialed failure paths.
- Verified by: Codex
- Commit: `0ae5cdb0`
- Date completed: 2026-07-15
- Remaining dependencies: implement and expose Gmail, banking, grocery, and smart-home provider flows with
  real OAuth, token, retry, callback, and sandbox evidence before advertising them as live integrations.

### TODO-0289 - Provider sync cron returned success after account failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Notifications / cron / provider synchronization / observability
- Feature: Scheduled provider synchronization
- File or files: `app/api/cron/provider-sync/route.ts`, `tests/cron-provider-sync.test.ts`
- Description: The cron counted failed account runs but returned HTTP 200 and `ok: true`, which could hide
  provider outages from scheduler monitoring and delay recovery.
- Resolution: Final response status and `ok` now derive from the failure count; any account failure returns
  sanitized HTTP 502 while retaining per-account diagnostic counts and details.
- Tests performed: 7 focused cron/error-boundary tests; full 412-file/3,065-test suite; typecheck; lint;
  dependency audit; migration audit; diff check; and clean 250-route production build.
- Evidence: `tests/cron-provider-sync.test.ts` guards non-2xx failure status and raw-error sanitization.
- Verified by: Codex
- Commit: `24e0b64d`
- Date completed: 2026-07-15
- Remaining dependencies: authenticated provider failure/retry drill, alert routing, and remote cron deployment verification.

### TODO-0290 - Batch crons hid partial failures behind success responses

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Scheduled automation / reliability / observability
- Feature: Calendar-feed, Autopilot, model-refresh, and auction-settlement crons
- File or files: `app/api/cron/calendar-feeds/route.ts`, `app/api/cron/autopilot-scan/route.ts`,
  `app/api/cron/model-refresh/route.ts`, `app/api/cron/close-auctions/route.ts`,
  `tests/cron-batch-failure-status.test.ts`
- Description: Several batch routes returned success after per-item failures, and auction RPC failures were
  not included in the response summary.
- Resolution: Failure counters now drive `ok` and HTTP status; partial failures return sanitized HTTP 502 and
  auction settlement failures are counted for retry/monitoring visibility.
- Tests performed: 11 focused cron/error-boundary tests; full 413-file/3,069-test suite; typecheck; lint;
  dependency audit; migration audit; diff check; and clean 250-route production build.
- Evidence: `tests/cron-batch-failure-status.test.ts` guards all four route contracts.
- Verified by: Codex
- Commit: `f8226011` (published in merge `59c422ac`)
- Date completed: 2026-07-15
- Remaining dependencies: isolated live failure drills, retry behavior, alert routing, and remote deployment verification.

### TODO-0291 - Notification delivery crons hid push and generation failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Notifications / push delivery / cron observability
- Feature: Daily notification and frequent push-scan jobs
- File or files: `app/api/cron/notifications/route.ts`, `app/api/cron/push-scan/route.ts`,
  `tests/cron-notification-failure-status.test.ts`
- Description: Per-family notification generation errors and push delivery failures were logged but did not
  change the cron response status, allowing a push outage to look healthy.
- Resolution: Generation, dispatch, and push-result failures now roll into a sanitized failure count; non-zero
  failures return `ok: false` with HTTP 502.
- Tests performed: 13 focused cron/error-boundary tests; full 414-file/3,071-test suite; typecheck; lint;
  dependency audit; migration audit; diff check; and clean 250-route production build.
- Evidence: `tests/cron-notification-failure-status.test.ts` guards both notification routes.
- Verified by: Codex
- Commit: `92eb434a`
- Date completed: 2026-07-15
- Remaining dependencies: run live push/email failure drills and verify alert routing/deployment.

### TODO-0292 - Notification email delivery hid provider and persistence failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Notifications / email delivery / Supabase persistence / cron observability
- Feature: Per-recipient notification email digests
- File or files: `lib/server/notification-emails.ts`, `app/api/cron/notifications/route.ts`,
  `tests/notification-email-boundary.test.ts`, `tests/cron-notification-failure-status.test.ts`
- Description: The helper ignored Supabase read/update errors and returned only a sent count, so provider
  failures and unresolved `sent_at` writes were invisible to the notification cron.
- Resolution: Added a sent/failed/skipped result, checked pending/prefs/recipient/resolve boundaries, left
  failed sends retryable, and included email failures in the cron's HTTP 502 status.
- Tests performed: 9 focused notification/error-boundary tests; full 415-file/3,073-test suite; typecheck;
  lint; dependency audit; migration audit; diff check; and clean 250-route production build.
- Evidence: `tests/notification-email-boundary.test.ts` guards helper results and route consumption.
- Verified by: Codex
- Commit: `a704a41f`
- Date completed: 2026-07-15
- Remaining dependencies: live Resend failure/duplicate/retry drills, alert routing, and remote cron deployment verification.
