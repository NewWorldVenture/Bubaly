# Product Launch Audit Ledger

This is the issue-level evidence ledger for launch. Each entry includes the required service, route,
role, scenario, severity, launch impact, root cause, resolution, Supabase impact, tests, validation,
commit, status, and remaining dependency. New findings must be added before or with their repair.

## Resolved Issues

### PLA-0480 - A-06 calendar verified: wiring, tenant isolation, collaborative authz, and SSRF-safe ICS import

- Timestamp: 2026-07-16 22:02 UTC
- Service: Calendar / planning (A-06)
- Route: `/dashboard/calendar`, `POST /api/calendar/sync` (ICS import), `GET /api/sync/feeds/[token]` (ICS export)
- Affected files: `tests/calendar-sync-ssrf-guard.test.ts` (new); audited `supabase/migrations/0105_calendar_events_rls_repair.sql`, `lib/server/public-calendar-fetch.ts`, `app/api/calendar/sync/route.ts`, `app/api/sync/feeds/[token]/route.ts`
- Role: any family member (calendar is collaborative); external ICS subscribers (capability token)
- Scenario: confirm calendar CRUD is Supabase-wired + tenant-isolated, the authz model is intentional, and the ICS import cannot be used for SSRF
- Severity: (verification — no defect found; positive SSRF-defense confirmation)
- Launch impact: (1) `calendar_events` has explicit per-op RLS (select/insert/update/delete) all `is_family_member(family_id)` — collaborative family-calendar model is intentional (kids add their own events), and cross-family isolation is already proven live (PLA-0415). (2) The ICS **import** fetches a user-supplied URL — SSRF vector — but goes through `fetchPublicCalendarText`, which rejects loopback/private/link-local/metadata hosts, blocks redirects into private networks, and caps body size (tested in `public-calendar-fetch.test.ts`); the sync route uses it with no raw `fetch()`. (3) The ICS **export** (`/api/sync/feeds/[token]`) is outbound-only, scoped by an unguessable capability token to `feed_enabled` rows
- Root cause: n/a (verification + regression guard)
- Resolution: added `tests/calendar-sync-ssrf-guard.test.ts` pinning the sync route to the guarded fetcher (asserts import + use + no raw `fetch()`), so a refactor cannot silently reintroduce SSRF. Pure engines (recurrence/scheduling/feeds/heatmap) already have dedicated tests
- Supabase impact: none (read/verify only)
- Tests run: `tests/calendar-sync-ssrf-guard.test.ts` (3 passing); eslint clean
- Validation evidence: 3/3 green; sync route imports+uses `fetchPublicCalendarText`, zero raw fetch()
- Commit: (this increment)
- Status: A-06 wiring/isolation/SSRF Verified + guarded; unit remains In-progress (recurrence UX flows, provider two-way sync = A-18, live E2E)
- Remaining dependencies: live Google/Apple provider sync (A-18); authenticated E2E of recurring-event edit/delete

### PLA-0470 - A-12 SECURITY: a child could disable/delete their own Guardian safety rules

- Timestamp: 2026-07-16 21:42 UTC
- Service: Guardian / family safety (A-12)
- Route: `/guardian/*` (server actions in `app/(app)/guardian/actions.ts`)
- Affected files: `app/(app)/guardian/actions.ts`, `tests/guardian-authz.test.ts` (new)
- Role: **child / teen** (any non-manager family member with a login)
- Scenario: a child invokes `toggleRuleAction`/`deleteRuleAction` (or contact/trust/phone/profile edits) to turn off the call/message screening that protects them
- Severity: **HIGH** (child-safety authorization bypass)
- Launch impact: every guardian mutation action (`upsertContactAction`, `deleteContactAction`, `updateContactTrustAction`, `upsertMemberProfileAction`, `updateContextAction`, `assignGuardianPhoneAction`, `createRuleAction`, `toggleRuleAction`, `deleteRuleAction`, `generateGuardianSuggestionsAction`, `acknowledgeEscalationAction`) only called `requireUserContext()` + family scope — no role check (the `actor: 'parent'` field is a hardcoded audit label, not authz). RLS on `guardian_routing_rules` is `is_family_member(family_id)` FOR ALL (migration 0137), and children get real Supabase sessions, so a child could disable or delete the safety rules screening their own calls/messages, or tamper with guardian contacts/trust/phone assignments.
- Root cause: missing server-side authorization; parent-only intent was enforced only by hiding the UI.
- Resolution: added `if (!isManager(ctx.active.role)) return guardianForbidden();` (manager = parent/adult) immediately after context resolution in all 11 mutation actions, before any write. `reviewSuggestionAction` was already gated server-side (returns `forbidden`). Same class of bug as PLA-0450 (chores).
- Supabase impact: none (app-layer authz). Follow-up recommended: restrict guardian-table WRITE RLS to managers (`can_manage_family`) as defense-in-depth.
- Tests run: `tests/guardian-authz.test.ts` (4, new — asserts the gate follows every captured context); existing guardian suite (10 files / 62 tests) still passes; tsc + eslint clean.
- Validation evidence: static guard reports 0 offending actions; 11 gates present.
- Commit: (this increment)
- Status: RESOLVED and pushed to `main`
- Remaining dependencies: manager-scoped RLS on guardian tables; live harness test that a child role cannot toggle a rule once role-scoped RLS exists.

### PLA-0461 - `family-media` storage bucket is undefined in migrations and served via public URLs (A-11) — OPEN, owner-gated

- Timestamp: 2026-07-16 21:30 UTC
- Service: Files / media storage (A-11) + Photos (A-05), Memories, Messages attachments, Reminder attachments
- Route: `/dashboard/photos`, `/dashboard/memories`, `/dashboard/messages`, `/dashboard/files/*`, reminder attachments
- Affected files (consumers): `components/modules/photos-module.tsx`, `components/memories/create-memory.tsx`, `components/modules/messages-module.tsx`, `components/modules/reminders-module.tsx`, `lib/storage/family-media.ts`; **no migration defines the bucket**
- Role: any user uploading media; any unauthenticated party with an object URL
- Scenario: (1) a fresh Supabase project / the PG16 harness has no `family-media` bucket; (2) media is served via `getPublicUrl`
- Severity: **P1** (reproducibility + privacy) — filed as blocker **LB-009**
- Launch impact:
  1. **Reproducibility / wiring gap** — four features upload to the `family-media` bucket, but unlike every other bucket (`documents` 0007, `chore-proof` 0043, `avatars` 0089, `marketplace-photos` 0194, `marketing-assets` 0060, feedback 0197) it is **created in no migration**. It exists in production only because it was created manually in the Supabase dashboard. On any fresh environment (a new project, the launch-audit PG16 harness, a rebuild) Photos, Create-Memory, Messages attachments, and Reminder attachments all **fail to upload** — and the bucket's `public` flag + RLS live only in the dashboard, outside version control.
  2. **Privacy** — every consumer resolves attachments with `getPublicUrl`, i.e. the bucket is public-read. Object paths are `${familyId}/…/${Date.now()}.${ext}` (semi-guessable). So family photos (including children's), private message image/audio/file attachments, and memories are **readable by anyone with the URL, bypassing family RLS on reads**. `documents` (the private, signed-URL bucket) is the correct contrasting model.
- Root cause: the bucket + its policies were provisioned out-of-band (dashboard) instead of in a migration; consumers were built against a public bucket
- Recommended resolution (owner-gated — a prod storage migration is human-owned per the coordination rules, and the public→private switch is a cross-module security/UX decision):
  1. Add a migration that idempotently creates `family-media` (`insert … on conflict do nothing`, `file_size_limit = 26214400`) with **family-folder write RLS** on `storage.objects` mirroring the `documents` bucket (`is_family_member(((storage.foldername(name))[1])::uuid)` for insert/update/delete), so fresh environments and the harness work and cross-family writes are blocked — without altering the existing prod bucket.
  2. Decide read visibility: to close the privacy gap, make the bucket private + add a family-folder SELECT policy and switch the four consumers from `getPublicUrl` to `createSignedUrl` (the pattern `documents-module` already uses). This is the cross-module change requiring owner sign-off.
- Supabase impact: requires a new prod storage migration (human-owned) + a potential public→private flip
- Tests run: static analysis — confirmed zero migrations define `family-media`; confirmed all four consumers use `getPublicUrl`; contrasted against the correctly-defined `documents` bucket (0007, family-folder RLS) verified in PLA-0442
- Validation evidence: `grep -rn family-media supabase/migrations` → no bucket insert/policy; consumers at photos-module:105, create-memory:103, messages-module:365, reminders-module:624 all call `getPublicUrl`
- Commit: (documentation only — no code change; fix is owner-gated)
- Status: **OPEN** — documented as launch blocker LB-009; flagged to owner (agent-03, A-11)
- Remaining dependencies: owner decision on public vs. signed-URL; a human-applied prod storage migration; add `family-media` to the seed/harness once defined

### PLA-0460 - A-14 marketplace ownership/trust RPCs verified caller-gated (guarded)

- Timestamp: 2026-07-16 21:31 UTC
- Service: Marketplace / offers / auctions (A-14)
- Route: SECURITY DEFINER RPCs `marketplace_accept_offer` / `decline_offer` / `set_listing_status` / `place_bid` / `buy_now`
- Affected files: `tests/marketplace-authz.test.ts` (new guard); audited `supabase/migrations/0154_marketplace_ownership.sql`, `0184_marketplace_auction_authorization.sql`
- Role: any family member acting on another family's / member's listing
- Scenario: confirm ownership and money-moving RPCs cannot be driven by a non-owner or a spoofed member/family
- Severity: (verification of CRITICAL trust invariants — no defect found)
- Launch impact: marketplace moves ownership and money between families; these RPCs are the trust boundary. Verified: `accept_offer`/`decline_offer` reject anyone but the listing's owning member (`marketplace_member_id(listing.family_id)` + `member_id` match -> "Only the listing owner"); `set_listing_status` is owner-checked; `place_bid`/`buy_now` require the acting member to belong to `auth.uid()` and match the claimed family (else `unauthorized`), take a `FOR UPDATE` lock on the listing, and `buy_now` rejects buying your own listing (`own_listing`); both are revoked from `public`
- Root cause: n/a (verification + regression guard)
- Resolution: added `tests/marketplace-authz.test.ts` pinning each ownership/authorization check to its migration so a refactor cannot silently drop them. Complements the A-03 live proof that `marketplace_create_circle` rejects cross-family callers
- Supabase impact: none (read/verify only)
- Tests run: `tests/marketplace-authz.test.ts` (6 passing); eslint clean
- Validation evidence: 6/6 green asserting owner-check strings + auth.uid() member binding + own_listing/for-update guards
- Commit: (this increment)
- Status: A-14 core ownership/trust Verified + guarded; unit remains In-progress (order/dispute/handoff flows, live RLS, media/storage, buyer/seller matrix)
- Remaining dependencies: live harness proof of cross-family accept/bid rejection; disputes + returns flows

### PLA-0451 - Recipes module dropped every Supabase write error — "Marked as made" toasted on failure, delete closed the viewer on failure (A-10)

- Timestamp: 2026-07-16 21:29 UTC
- Service: Meals / Groceries / Food (A-10) — Recipes module
- Route: `/dashboard/meals` recipes tab / recipe viewer (`components/modules/recipes-module.tsx`)
- Affected files: `components/modules/recipes-module.tsx`, `tests/recipes-module-write-boundary.test.ts` (new)
- Role: all family roles with the Food feature
- Scenario: a recipe favorite toggle, "mark made today", or delete write fails for a real reason (RLS denial, offline, constraint) while the UI reports success
- Severity: P2 (silent write failure / UI lies about persisted state)
- Launch impact: three writes fired with `await supabase…` and no `error` capture. `toggleFavorite` silently no-op'd the star; **`markMade` toasted "Marked as made today!" and `deleteRecipe` closed the recipe viewer as if the row were gone** — both while the write may have failed, so the user believes state persisted when it did not (times-made never incremented; the "deleted" recipe reappears on next load)
- Root cause: `const { error }` was never destructured at the three write sites; the sibling `addItemsToList` / `addToGrocery` / modal-save paths in the same file already guard correctly, so this was an inconsistency, not a missing pattern
- Resolution: all three now `const { error } = await …; if (error) return toastError(describeDbError(error));` **before** any success toast / viewer close, matching the rest of the module. `markMade`'s success toast and `deleteRecipe`'s `setViewing(null)` are now strictly after the error guard
- Supabase impact: none — writes unchanged; genuine failures now surface via toast and the optimistic UI transition is withheld on failure
- Tests run: `tests/recipes-module-write-boundary.test.ts` (5 — each of the 3 writes captures+toasts error; markMade success and deleteRecipe close are ordered after the guard); `tsc --noEmit` clean; `eslint` clean on touched files
- Validation evidence: guard test extracts each function body and asserts `const { error } = await` + `if (error) return toastError(describeDbError(error))`, and that the success/close calls land after the guard offset
- Commit: (this increment)
- Status: Resolved in code and pushed to `main` (A-10 increment by agent-02); A-10 unit remains In-progress (CRUD/AI write sweep continuing, live cross-family RLS + ≥500-row seed still open)
- Remaining dependencies: live cross-family RLS proof on meals/recipes/grocery/pantry; confirm ≥500-row relational seed for the A-10 tables

### PLA-0442 - A-11 documents pipeline verified tenant-isolated across DB + Storage (guarded)

- Timestamp: 2026-07-16 21:28 UTC
- Service: Files / documents / storage (A-11)
- Route: `/dashboard/documents`, `/dashboard/binder`, `/dashboard/files/{cloud,shared,vault}`
- Affected files: `tests/a11-documents-storage-rls.test.ts` (new static guard)
- Role: any member of family B attempting to reach family A's documents (metadata or bytes)
- Scenario: confirm both layers of the documents pipeline — the `documents` DB table and the private `documents` Storage bucket — are family-scoped, and that the client handles errors + never orphans a stored file
- Severity: (verification of a CRITICAL invariant on the A-11 surface — no defect found)
- Launch impact: documents carry a family's most sensitive records; isolation must hold at both the metadata and the object-storage layer. Verified and guarded so neither can silently regress
- Root cause: n/a (verification)
- Resolution: verified the full pipeline is sound —
  (1) **DB table** `documents` (migration 0109): RLS enabled, all four ops scoped to `is_family_member(family_id)`;
  (2) **Storage bucket** `documents` (migration 0007): all four `storage.objects` policies scoped to `bucket_id = 'documents' AND is_family_member(((storage.foldername(name))[1])::uuid)` — the first path segment is the family id, so family B cannot read/write family A's objects;
  (3) **Storage helper** `lib/storage/documents.ts`: enforces the 25 MB limit, uses `buildFamilyPath` (family-folder), and returns `{ error }` from upload / signed-URL / remove;
  (4) **Client modules** (`documents-module`, `files-hub-module`, `binder-module`): `useRealtimeQuery` with `error`→`<ErrorState onRetry>`, every write error-checked via `describeDbError`, and — critically — a failed DB insert after an upload calls `removeFamilyDocument(path)` so no orphaned storage object is left behind. Added `tests/a11-documents-storage-rls.test.ts` pinning both RLS layers
- Supabase impact: none (read-only verification); no schema change
- Tests run: `tests/a11-documents-storage-rls.test.ts` (2 — DB table + storage bucket), full suite 3,348 tests, eslint clean, typecheck clean
- Validation evidence: the guard asserts the `documents` table's four family-scoped policies and the four family-folder storage policies with the `foldername()[1]` isolation predicate
- Commit: (this increment)
- Status: A-11 documents/storage tenant-isolation + error-handling + orphan-safety Verified + guarded; A-11 unit remains In-progress (messages/vault-specific surfaces, live cross-family storage probe, and ≥500-row doc seed still open)
- Remaining dependencies: extend the A-03 live probe to a storage cross-family object read; audit the messages sub-surface; live upload/download/delete smoke

### PLA-0441 - A-16 notification/reminder tables verified RLS tenant-scoped (guarded)

- Timestamp: 2026-07-16 21:23 UTC
- Service: Notifications / reminders tenant isolation (A-16)
- Route: cross-cutting — `notifications`, `family_reminders`, `reminder_lists`, `push_devices`
- Affected files: `tests/a16-notifications-rls.test.ts` (new static guard)
- Role: any member of family B attempting to reach family A's notifications/reminders/devices
- Scenario: confirm the A-16 data tables are tenant-scoped (no cross-family read/write) and guard that scoping against future drift
- Severity: (verification of a CRITICAL invariant on the A-16 tables — no defect found)
- Launch impact: notifications and reminders carry sensitive per-family activity; their RLS scoping is a launch-security invariant. This complements agent-01's global A-03 harness proof (PLA-0415: 353/353 tables RLS-enabled, family B reads 0 rows of family A, cross-family writes blocked) with an A-16-specific static guard so the scoping on these exact tables cannot silently regress
- Root cause: n/a (verification)
- Resolution: confirmed each A-16 table's migration-defined RLS policy is tenant-scoped — `notifications` (recipient `user_id = auth.uid()` OR `is_family_member(family_id)` for family broadcasts; writes `with check is_family_member`/`can_manage_family`), `family_reminders` (`family_id in (select family_id from family_members where user_id = auth.uid())`), `reminder_lists` (active `family_members` membership on `reminder_lists.family_id`), `push_devices` (per-owner `user_id = auth.uid()` on all four ops), and that migration 0118 force-enables RLS on every public base table via a loop. Added `tests/a16-notifications-rls.test.ts` pinning these policies to their migrations
- Supabase impact: none (read-only verification); no schema change
- Tests run: `tests/a16-notifications-rls.test.ts` (4 — one per table), full suite 3,338 tests, eslint clean, typecheck clean
- Validation evidence: the guard asserts each table's RLS-enable mechanism and its family/user-scoped policy text; the live cross-family proof remains agent-01's A-03 PG16 probe (`docs/audit/rls-isolation-check.sql`)
- Commit: (this increment)
- Status: A-16 tenant-isolation sub-invariant Verified + guarded; A-16 unit remains In-progress (live delivery/schedule/retry matrix, and extending the live probe's per-table read-check to notifications/family_reminders, still open)
- Remaining dependencies: add notifications/family_reminders to the A-03 live read-probe's table list (coordinate with A-03 owner); live cron delivery verification

### PLA-0450 - A-07 SECURITY: a child could approve their own chore submission and mint a wallet reward

- Timestamp: 2026-07-16 21:26 UTC
- Service: Chores / Missions / rewards (A-07)
- Route: `/missions` (server actions `approveSubmissionAction`, `rejectSubmissionAction`)
- Affected files: `app/(app)/missions/actions.ts`, `tests/chore-approval-authz.test.ts` (new)
- Role: **child / teen** (any non-manager family member with a login)
- Scenario: a child submits a chore, then invokes `approveSubmissionAction` with their own `submission_id`
- Severity: **HIGH** (privilege escalation → self-authorized payout / money integrity)
- Launch impact: `approveSubmissionAction` (and `rejectSubmissionAction`) only called `requireUserContext()` + scoped by `family_id`; they did **not** check the caller's role. RLS on `chore_submissions` is `is_family_member(family_id)` for ALL ops, and children get real Supabase auth sessions (`child-login-actions.ts`), so a child could flip their own submission to `approved`, which runs `finalizeApproval → applyCompletionRewards` and credits their wallet — i.e. approve-your-own-chore and pay yourself. They could likewise reject/redo others' work.
- Root cause: missing server-side authorization; the "Parent approves" contract was enforced only by hiding the button in the UI (client-side), not on the server.
- Resolution: added `if (!isManager(ctx.active.role)) return;` at the top of both `approveSubmissionAction` and `rejectSubmissionAction` (manager = parent/adult), before any state change. Documented as the authorization boundary (RLS can't distinguish roles here). Auto-approval via `submitProofAction` is unaffected — it is gated by parent-configured `canAutoApprove`, not a child action.
- Supabase impact: none (app-layer authz). Follow-up recommended: tighten `chore_submissions`/`chore_assignments` UPDATE RLS to managers for status changes as defense-in-depth.
- Tests run: `tests/chore-approval-authz.test.ts` (4, new — locks the gate in); existing `chore-reward-persistence` / `chore-state-transition-persistence` / `chores-logic` / `chores-dashboard` (42) still pass; tsc + eslint clean.
- Validation evidence: static guard asserts the `isManager` gate precedes `finalizeApproval`; roles helper confirms manager = parent/adult only.
- Commit: (this increment)
- Status: RESOLVED and pushed to `main`
- Remaining dependencies: consider RLS-level restriction of chore status writes to managers; add a live harness test that a child role cannot approve once role-scoped RLS exists.

### PLA-0440 - A-08 wallet money-safety verified: overspend prevention + hold idempotency (PAY-1) proven live

- Timestamp: 2026-07-16 21:18 UTC
- Service: Wallet / Bubaly Money (A-08)
- Route: card authorization path (`wallet_reserve_card_auth` RPC, called by the Issuing webhook)
- Affected files: `docs/audit/wallet-overspend-check.sql` (new self-contained probe), `tests/wallet-overspend-probe.test.ts` (new guard); audited `supabase/migrations/0155_wallet_auth_holds.sql`, `lib/wallet/ledger.ts`, `lib/wallet/server.ts`
- Role: any child spending on an Issuing card; concurrent authorizations
- Scenario: prove a child cannot spend beyond their SPEND balance even under concurrent/re-delivered authorizations
- Severity: (verification of a CRITICAL money invariant — no defect found)
- Launch impact: the atomic hold is the guarantee that Bubaly Money cannot overspend a child's balance; now has an independent reproducible proof beyond the existing PAY-1 work
- Root cause: n/a (verification + regression guard)
- Resolution: confirmed `wallet_reserve_card_auth` takes `SELECT … FOR UPDATE` on the child's SPEND bucket (serializes concurrent auths), computes spendable as completed+processing (so a prior hold reduces it), declines on insufficient funds, is idempotent per `stripe_ref`, and is `service_role`-only (`revoke all from public`). Proved live on the harness: fund $10 → auth $8 approves, second $8 declines (only $2 left), replay of auth_1 approves without a second hold, exact $2 approves, next $1 declines; exactly 2 holds ($8+$2), $0 remaining. Also confirmed the pure ledger `allocate()` conserves every cent (exhaustively tested 0–1234 in `wallet-ledger.test.ts`) and reversals net to zero
- Supabase impact: read/verify only; probe cleans up its own test member/wallet/holds (no residue)
- Tests run: `docs/audit/wallet-overspend-check.sql` → "ALL INVARIANTS PASSED"; `tests/wallet-overspend-probe.test.ts` (4 passing); eslint clean
- Validation evidence: probe NOTICE "A-08 OK: overspend prevented, holds counted, idempotent per auth id"; live sequence t/f/t/t/f with 2 holds and $0 remaining
- Commit: (this increment)
- Status: A-08 core money-safety Verified; unit remains In-progress (allowance runs, goal funding, transfers, parent-approval holds, wallet RLS role matrix, live Stripe Issuing)
- Remaining dependencies: run both probes in CI against ephemeral PG; role-level (child vs parent) approval-boundary proof

### PLA-0434 - Push dispatch silently dropped every push on a read failure and risked duplicate pushes (A-16)

- Timestamp: 2026-07-16 21:16 UTC
- Service: Notifications delivery — web-push dispatch (A-16)
- Route: `app/api/cron/notifications`, `app/api/cron/push-scan`, `app/api/notifications/generate` → `lib/server/push.ts` (`dispatchPendingPushes`)
- Affected files: `lib/server/push.ts`, `tests/push-dispatch-read-boundary.test.ts`
- Role: every member with a registered push device
- Scenario: the pending-push read, the whole-family member fan-out read, or the `pushed_at` stamp write fails (RLS, drifted table, outage)
- Severity: P2
- Launch impact: `dispatchPendingPushes` discarded the pending-push read error and returned `{ notifications: 0 }` — indistinguishable from an empty queue — so a broken `notifications` read silently dropped **every** push with no signal. The whole-family fan-out `family_members` read dropped its error (a broken read silently skipped whole-family pushes), and the `pushed_at` stamp write was unchecked (a lost stamp re-pushes the same notification every cron run = duplicate-push spam)
- Root cause: `const { data } = await …` / bare `await …update(...)` dropped the PostgREST `error` at all three sites
- Resolution: the pending-push read now **fails closed** — logs `[push] pending-push read failed` and throws, which the caller (cron / on-demand, both already try/catch-and-count push dispatch failures) surfaces instead of hiding; the fan-out member read logs `[push] family_members read failed for fan-out` and degrades (skips that family only); the `pushed_at` stamp logs `[push] pushed_at stamp failed` on error so the duplicate-push path is diagnosable
- Supabase impact: none; reads/writes unchanged, only their failures surfaced/observable
- Tests run: `tests/push-dispatch-read-boundary.test.ts` (throws on read error; returns empty result on a genuinely empty queue), full suite 523 files / 3,334 tests, eslint clean, typecheck clean
- Validation evidence: boundary test drives a fake client erroring the pending read and asserts `dispatchPendingPushes` rejects with "Pending-push read failed"; empty-queue path resolves to a zeroed result
- Commit: (this increment)
- Status: Resolved in code and pushed to `main` (A-16 increment by agent-03); A-16 unit remains In-progress (delivery/schedule/retry/live-cron matrix still open)
- Remaining dependencies: live push delivery + duplicate-suppression verification; route `[push]`/`[notifications]` signals into monitoring (A-20 / LB-008 adjacent)
### PLA-0435 - Nutrition Tracker + Family Favorites rendered read failures as silent empty lists (A-10)

- Timestamp: 2026-07-16 21:16 UTC
- Service: Meals / Groceries / Food (A-10) — Nutrition Tracker and Family Favorites views
- Route: `/dashboard/nutrition` (`components/meals/nutrition-view.tsx`), Family Favorites (`components/meals/favorites-view.tsx`)
- Affected files: `components/meals/nutrition-view.tsx`, `components/meals/favorites-view.tsx`, `tests/meals-views-read-boundary.test.ts` (new)
- Role: all family roles with the Food feature
- Scenario: the `nutrition_logs` or `family_favorites` read fails for a real reason (RLS denial, transient outage) while online and the table exists
- Severity: P2 (silent read failure / misleading empty state)
- Launch impact: both views called `useRealtimeQuery` but destructured only `{ data, loading }`, discarding the hook's `error`. The hook already degrades missing-table (pending migration) and offline to a quiet empty list, but a GENUINE error sets `error` — which these views ignored, so a real failure rendered an empty tracker / empty favorites list with no error UI and no retry
- Root cause: the two views dropped the `error`/`refresh` from the shared realtime-query hook
- Resolution: both now destructure `error, refresh` and `return <ErrorState message=… onRetry={refresh} />` on a real error, matching the sibling Meals/Grocery/Pantry modules; writes were already toasting `describeDbError`
- Supabase impact: none — reads unchanged; genuine failures now visible + retryable
- Tests run: `tests/meals-views-read-boundary.test.ts` (both views destructure error+refresh and render a retryable ErrorState); `tsc --noEmit` clean; `eslint` clean; full `vitest` 3,336 green
- Validation evidence: guard test asserts the `error, refresh` destructure and the `if (error) return <ErrorState … onRetry={refresh}` branch exist in both views
- Commit: (this increment)
- Status: Resolved in code and pushed to `main`
- Remaining dependencies: A-10 grocery/pantry modules already fail-visible (verified this pass); remaining for A-10 launch-complete: CRUD/AI action write-boundary sweep, live cross-family RLS proof on meals/recipes/grocery/pantry tables, and the ≥500-row relational seed confirmation


### PLA-0433 - Meals module secondary reads swallowed failures into silent empty lists (A-10)

- Timestamp: 2026-07-16 21:12 UTC
- Service: Meals / Groceries / Food (A-10) — the Meal Planning module's client reads
- Route: `/dashboard/meals` (`components/modules/meals-module.tsx`)
- Affected files: `components/modules/meals-module.tsx`, `tests/meals-module-read-boundary.test.ts` (new)
- Role: all family roles (any member with the Meals feature)
- Scenario: the "add from your meals" library read (`meals`) or the weekly dinner-vote panel reads (`meal_votes`/`meal_vote_options`/`meal_vote_ballots`) fail via RLS/outage
- Severity: P3 (secondary/enhancement client reads — degrade is acceptable, silence is not)
- Launch impact: `reloadLibrary` did `.then(({ data }) => setLibrary(data ?? []))` and `loadVote` used `options ?? []`/`ballots ?? []`, dropping the error — so a failing library read left the meal-picker mysteriously empty and a failing vote read hid an active "what's for dinner" vote, both with zero signal in logs
- Root cause: the two secondary reads destructured only `data` and never inspected the PostgREST `error`
- Resolution: both reads now capture `error` and `console.error('[meals] library/vote read failed', …)` before degrading; the primary `meal_plans` read was already fail-visible via `useRealtimeQuery` → `<ErrorState onRetry>` (unchanged), and all writes already `toastError(describeDbError(...))`
- Supabase impact: none — reads unchanged; failures now observable
- Tests run: `tests/meals-module-read-boundary.test.ts` (static guards that both reads log and the old silent `.then(({ data }) => setLibrary(data ?? []))` is gone); `tsc --noEmit` clean; `eslint` clean on the touched file; full `vitest` suite (below)
- Validation evidence: guard test asserts the two `console.error('[meals] … read failed'` calls exist and the silent pattern is absent
- Commit: (this increment)
- Status: Resolved in code and pushed to `main`
- Remaining dependencies: A-10 still In-progress — grocery/pantry/nutrition module client reads, CRUD/AI action coverage, live cross-family RLS proof, and the ≥500-row relational seed check remain

### PLA-0432 - Notification generation engine silently skipped whole categories on a read failure (A-16)

- Timestamp: 2026-07-16 21:05 UTC
- Service: Notifications / reminders engine (A-16) — the "who needs to know" generator that feeds the notifications cron and the in-app refresh
- Route: `app/api/cron/notifications`, `app/api/notifications/generate` → `lib/server/notifications.ts` (`generateFamilyNotifications`)
- Affected files: `lib/server/notifications.ts`, `tests/notifications-generation-read-boundary.test.ts`
- Role: every family member who relies on reminders/notifications
- Scenario: any of the 13 parallel source reads (calendar, chores, reminders, documents, renewals, opportunities, medications, med schedules/doses, approvals, etc.) or the dedup reads fail (RLS, drifted table, outage)
- Severity: P2
- Launch impact: `generateFamilyNotifications` destructured `{ data }` from ~13 parallel source reads and both dedup reads, dropping every `error`. A silently-broken table (e.g. `medications` or `reminders`) would stop that entire notification category **forever** with no operational signal; worse, a failed dedup read left the `seen` set empty so every candidate re-inserted as a **duplicate notification** (spam)
- Root cause: `const { data } = await …` across the source `Promise.all` and the two dedup reads discarded the PostgREST `error`
- Resolution: degrade-but-log (partial delivery beats all-or-nothing for a notification engine) — the source reads now log `[notifications] generation source read failed { familyId, table }` per failing table while still generating the categories that succeeded, and both dedup reads log `[notifications] dedup read failed` so the duplicate-spam path is diagnosable. The final `notifications` insert already threw on error (unchanged). The upstream cron already counts per-family generation failures and returns 502
- Supabase impact: none; reads unchanged, only their failures observable
- Tests run: `tests/notifications-generation-read-boundary.test.ts` (a failed source read logs by table name and does not throw; clean run logs nothing), full suite 518 files / 3,309 tests, eslint clean, typecheck clean
- Validation evidence: boundary test drives a fake client erroring `reminders` + `medications` and asserts both `generation source read failed` logs fire with the table names, and the function returns without throwing
- Commit: (this increment)
- Status: Resolved in code and pushed to `main` (A-16 increment by agent-03); A-16 unit remains In-progress (schedules/retries/dedup/delivery/observability matrix still open)
- Remaining dependencies: live cron delivery + dedup verification; route the `[notifications]` signals into monitoring (A-20 / LB-008 adjacent)

### PLA-0431 - A-09 revenue invariant: guard webhook plan slugs against planLevel() drift

- Timestamp: 2026-07-16 21:04 UTC
- Service: Billing / entitlement (A-09)
- Route: `POST /api/webhooks/stripe` → `subscriptions.plan` → entitlement gating
- Affected files: `app/api/webhooks/stripe/route.ts` (audited), `lib/constants/plans.ts` (audited), `tests/billing-entitlement-consistency.test.ts` (new)
- Role: any paying family
- Scenario: the Stripe subscription webhook maps a price id → plan slug and persists it; `planLevel()` later resolves that slug to an entitlement level (0/1/2)
- Severity: (guards a CRITICAL revenue invariant — no defect found today; the risk is future drift)
- Launch impact: verified the webhook writes exactly `plus / plus_annual / basic / basic_annual`, and `planLevel()` maps every one to a PAID level (plus→2, basic→1), with legacy `family/family_annual`→1 and unknown/free→0. If a future price→slug were added without updating `planLevel()`, a paying family would silently resolve to Free — now caught by CI
- Root cause: n/a (verification + regression guard); the two files had no test tying them together
- Resolution: added `tests/billing-entitlement-consistency.test.ts` which parses the webhook's price→plan ladder and asserts every slug it emits satisfies `planLevel() >= 1`, that plus/basic levels are exact, that unknown/null/undefined are Free, and that the webhook throws on an unknown price rather than writing a Free slug
- Supabase impact: none; read/verify only. Also confirmed the webhook is signature-verified (`constructEvent`), replay-safe (`recordEvent`/`markEventProcessed`/`markEventError`), returns 500 to force Stripe retry on handler failure, and self-heals the `checkout_sessions` row on completion
- Tests run: `tests/billing-entitlement-consistency.test.ts` (5 passing); eslint clean
- Validation evidence: 5/5 green; slugs parsed from source = `plus, plus_annual, basic, basic_annual`, all `planLevel >= 1`
- Commit: (this increment)
- Status: Resolved and pushed to `main`; A-09 remains In-progress (live Stripe signature/replay/refund smoke, portal RBAC, and cancel/downgrade flows still open)
- Remaining dependencies: live webhook idempotency + refund smoke against Stripe test mode
### PLA-0418 - Food & Nutrition hub swallowed every read failure → healthy-looking empty page (A-10)

- Timestamp: 2026-07-16 21:05 UTC
- Service: Meals / Groceries / Food (A-10) — the Food & Nutrition overview hub
- Route: `/dashboard/food`
- Affected files: `app/(app)/dashboard/food/page.tsx`, `lib/meals/degrade-read.ts` (new), `tests/food-page-read-boundary.test.ts` (new)
- Role: all family roles (any member with the Food feature)
- Scenario: any of the hub's 8 fan-out reads (meal_plans, family_recipes ×2, grocery_items, pantry_items, family_food_scores, dining_out, meals) fails via RLS denial, a not-yet-migrated table, or a transient outage
- Severity: P1 (silent read failure / misleading empty state — undiagnosable in prod)
- Launch impact: the page's `safe()` wrapper did `try { …data ?? null } catch { return null }` — it caught only THROWN exceptions, never the resolved PostgREST `error` field, and logged nothing on either path. A real failure therefore rendered a healthy-looking-but-empty hub (empty cards, "0 recipes", "0 items") with zero signal in logs, so a partial Food-service outage or an un-applied migration would be invisible on launch
- Root cause: the local `safe()` degrade wrapper dropped the `{ error }` field and had a silent `catch`
- Resolution: extracted `makeDegradeRead(namespace)` (`lib/meals/degrade-read.ts`) — awaits the query, and on the resolved `error` field OR a throw logs `console.error('[food] <label> read failed|threw', …)` then degrades to `{ data: null, count: null }`. The hub is an aggregate overview, so degrade-per-card is correct — but every failure is now observable. All 8 reads pass a source label so a log names exactly which table failed
- Supabase impact: none — the reads/queries are unchanged; only their failures are now surfaced to logs (observability)
- Tests run: `tests/food-page-read-boundary.test.ts` (6: success passthrough, logs+degrades on error field, logs+degrades on throw, namespacing, + static wiring guards that the silent wrapper is gone and every call is labeled); `tsc --noEmit` clean; `eslint` clean on touched files; full `vitest` suite (below)
- Validation evidence: runtime test drives a query resolving `{ data:null, error:{message:'relation "dining_out" does not exist'} }` and asserts `console.error` fired with `[food] dining_out read failed` and the result degraded to `{ data:null, count:null }`; a rejected promise asserts the `…read threw` path
- Commit: (this increment)
- Status: Resolved in code and pushed to `main`
- Remaining dependencies: A-10 not yet launch-complete — the sibling routes `/dashboard/{meals,grocery,pantry,nutrition}` are thin server shells that delegate to client views (`components/meals/*`); their client-read error handling + the A-10 live-RLS/role/seed gates are the remaining audit steps under this unit

### PLA-0417 - Concierge automation approve/dismiss reported success while the run stayed pending

- Timestamp: 2026-07-16 20:53 UTC
- Service: AI Concierge autonomous-execution loop (queued-run approval) + Trust approval execution
- Route: `/dashboard/concierge` (approve/dismiss queued run), `/dashboard/trust` (approval execution stamp)
- Affected files: `app/(app)/dashboard/concierge/actions.ts`, `app/(app)/dashboard/trust/actions.ts`, `tests/concierge-run-write-boundary.test.ts`
- Role: parents/guardians (managers)
- Scenario: a manager approves or dismisses a queued automation run, or a fully-approved trust request auto-executes, and the status/stamp write fails (RLS, constraint, outage)
- Severity: P1 (silent state-change / consistency)
- Launch impact: `executeQueuedRunAction` and `dismissQueuedRunAction` discarded the `family_automation_runs` status-update result and returned `{ ok: true }`, so the run stayed "pending" in the UI while the manager was told it was executed/dismissed — and `materializePlan` pushed a write-back onto `applied` even when its `calendar_events`/`family_reminders` insert failed, falsely claiming a calendar event or reminder was created (and, because the write-back was recorded as applied, skipping it on the idempotent re-run so it was never actually created). The Trust execution-result stamp was likewise unchecked, so a fully-executed action could look un-executed and be re-run
- Root cause: the run status updates, the write-back inserts inside `materializePlan`, and the trust execution stamp all dropped the PostgREST `error`
- Resolution: `executeQueuedRunAction`/`dismissQueuedRunAction` now capture the run status-update error and return `{ ok: false, error: describeActionError(...) }` (retry is safe — `materializePlan` is idempotent via `concierge_plan_actions`); `materializePlan` now `continue`s (does not mark applied) when a calendar/reminder insert fails and logs it, and logs the `concierge_plan_actions` idempotency-log write failure; the secondary `approval_requests` stamps and the Trust execution-result stamp now `console.error` on failure. Best-effort audit-log/throttle/insights writes (`trust_audit_logs`, `wallet_audit_logs`, `child_login_throttle`, `demo_email_uses`, `audit_logs`, `money_timeline_insights`) were reviewed and left intentionally silent
- Supabase impact: none; writes unchanged, only their failures surfaced/observable and `applied` made honest
- Tests run: `tests/concierge-run-write-boundary.test.ts` (dismiss returns ok:false on write error, ok:true on success), full suite 516 files / 3,297 tests, eslint clean, typecheck clean
- Validation evidence: boundary test drives a mocked failing update and asserts `dismissQueuedRunAction` returns `{ ok: false }`; success path returns `{ ok: true }`
- Commit: (this increment)
- Status: Resolved in code and pushed to `main`; live per-role verification remains a standing dependency
- Remaining dependencies: this closes the primary-data bare-write triage in `app/**/actions.ts` — the remaining unchecked writes are all intentionally best-effort audit/throttle/derived-insight side-effects

### PLA-0416 - CRM seed produced ZERO rows (invalid lead_status broke the whole block)

- Timestamp: 2026-07-16 20:56 UTC
- Service: Seed pack integrity / CRM (A-02, A-17)
- Route: n/a (seed data)
- Affected files: `supabase/SEED_ALL.sql`, `supabase/seed_crm_lead_scores.sql`, `supabase/seed_crm_contact_profile.sql`
- Role: any test profile relying on CRM lead/contact data
- Scenario: running `SEED_ALL` (or either standalone CRM seed) against a fresh DB
- Severity: P2 (seed-pack defect — the mandate requires a clean 500+ row pack; the affected surface had no test data at all)
- Launch impact: `crm_contacts` seeded **0** rows because every insert used `lead_status = 'lead'`, which violates `crm_contacts_lead_status_check IN ('new','working','qualified','unqualified','customer')` (migration 0056). The check violation aborted the whole seed block, so CRM lead-scores and contact-profile surfaces had no data to test against
- Root cause: seed used a `lead_status` value that was never in the constraint's allow-list (confusion with `lifecycle_stage`, where `'lead'` IS valid)
- Resolution: changed the `lead_status` literal from `'lead'` to `'new'` in all three files (`lifecycle_stage` left as `'lead'`, which is valid)
- Supabase impact: seed-only; no schema/migration change
- Tests run: harness re-run of both CRM seeds — 0 → **1000** `crm_contacts` rows (500 lead-scores + 500 contact-profile), all `lead_status='new'`, zero errors
- Validation evidence: `select count(*) from crm_contacts` 0 → 1000; `select lead_status,count(*)` → `new|1000`
- Commit: (this increment)
- Status: Resolved and pushed to `main`
- Remaining dependencies: none; re-run full `SEED_ALL` end-to-end to confirm no other block still aborts

### PLA-0415 - A-03 tenant isolation verified end-to-end on the PG16 harness (read + write, full-table RLS sweep)

- Timestamp: 2026-07-16 20:50 UTC
- Service: Platform / Auth / tenant isolation (A-03)
- Route: cross-cutting (all family-scoped data)
- Affected files: `docs/audit/rls-isolation-check.sql` (new reusable probe), `docs/audit/verify-pg.sh` (new shared harness), `tests/rls-isolation-sweep.test.ts` (new static guard)
- Role: any authenticated member of family B attempting to reach family A
- Scenario: prove one tenant cannot read or write another tenant's rows, and that no family-scoped table ships with RLS disabled
- Severity: (verification of a CRITICAL invariant — no defect found)
- Launch impact: tenant isolation is the top launch-security invariant; now has reproducible evidence, not just per-migration static assertions
- Root cause: n/a (verification)
- Resolution: brought up a fresh PG16 with all 230 migrations + `SEED_ALL`; provisioned a second tenant (family B / user B); under the `authenticated` role acting as user B proved: (1) **353/353** family-scoped tables have RLS ENABLED (zero disabled); (2) user B reads **0** rows across 10 top-risk family-A tables (`family_members, calendar_events, wallet_transactions, notes, documents, grocery_items, family_recipes, chore_assignments, family_photos, family_messages`) while seeing its own data; (3) user B's INSERT into family A is blocked by the RLS `WITH CHECK` policy ("new row violates row-level security policy"), and UPDATE/DELETE affect 0 rows — family A's data left intact (no PWNED/HACK rows)
- Supabase impact: none (read-only verification); no schema change
- Tests run: live probe `docs/audit/rls-isolation-check.sql` → "ALL INVARIANTS PASSED"; static guard `tests/rls-isolation-sweep.test.ts` (4 passing); eslint clean
- Validation evidence: probe NOTICEs — "all family-scoped tables have RLS enabled" / "user B read 0 rows across 10 family-A tables" / "user B write attempts on family A all blocked"
- Commit: (this increment)
- Status: A-03 read/write tenant-isolation sub-invariant Verified; A-03 unit remains In-progress (session edges, every-role matrix, live Auth Admin, OAuth callbacks still open)
- Remaining dependencies: run the probe in CI against an ephemeral PG; extend to role-level (child vs parent) and to RPC SECURITY DEFINER surfaces

### PLA-0414 - Kitchen Display (`/display`) crashed into the app error boundary

- Timestamp: 2026-07-16 20:20 UTC
- Service: Display / Home command surfaces (A-05)
- Route: `/display`
- Affected files: `app/(app)/display/page.tsx`
- Role: any signed-in member on Family Basic+ (kiosk/tablet)
- Scenario: production showed "This page hit a snag" (ref 3415111988) instead of the kitchen display
- Severity: P1 (a marketed Family-Basic surface was down)
- Launch impact: paid feature unusable; now fault-tolerant
- Root cause: the always-on kiosk had no isolation around its ~13 parallel reads + transforms; any single failing read/transform could bubble to the route-group error boundary
- Resolution: wrapped all loading in a resilient `loadDisplay()` with an always-renderable empty-state fallback; labeled per-query error logging; hardened birthday parsing (YYYY-MM-DD / ISO / bare MM-DD, Invalid-Date guarded); NaN-guarded month days; array-validated saved tiles; `requireFeature()` kept outside the loader so redirect/notFound control flow still propagates
- Supabase impact: none; reads unchanged
- Tests run: PG16 harness — all 13 display queries run under RLS as the authenticated anchor member and return seeded rows (events 115/day, chores 311, recipes 510, photos 524); tsc/eslint clean; 31 ambient tests; `next build` green (`ƒ /display`)
- Validation evidence: RLS query result table; build output
- Commit: `77b87dc`
- Status: Resolved and pushed to `main`
- Remaining dependencies: optionally wrap client `DisplayShell` in a local error boundary so a hydration hiccup degrades one tile, not the page

### PLA-0413 - Referrals list hid read failures as empty; Guardian routing-rule read failures were invisible

- Timestamp: 2026-07-16 20:38 UTC
- Service: Referrals (family-facing) + Guardian call/message screening pipeline
- Route: `/referrals`; inbound Guardian voice/SMS webhook pipeline (`lib/guardian/pipeline.ts`)
- Affected files: `lib/referrals/server.ts`, `lib/guardian/pipeline.ts`, `tests/module-queries-read-boundary.test.ts`
- Role: any family (referrals); any inbound caller/sender (Guardian)
- Scenario: the `referrals` read fails while the Referrals page loads; the `guardian_routing_rules` read fails while an inbound call/message is screened
- Severity: P2
- Launch impact: (1) `listReferralsForFamily` discarded the read `error` and returned `[]`, so a failed read showed "no referrals yet" when the list was merely unreadable (misleading-empty class). (2) `loadRules` in the Guardian pipeline discarded its read `error` and returned `[]`, silently falling back to profile defaults — so a broken `guardian_routing_rules` table would skip custom blocks/overrides and change how calls are routed with zero operational signal
- Root cause: both dropped `error` from the destructure
- Resolution: **Referrals fails closed** (log + throw "Could not load your referrals from Supabase. Refresh and try again.") — it is a dedicated source-of-truth page with no try/catch. **Guardian degrades but logs** (`console.error('[guardian/pipeline] guardian_routing_rules read failed', …)`) rather than throwing, because it runs in the inbound webhook path where a hard failure would break screening entirely; degrading to profile defaults is the safe fallback, but the failure is now observable
- Supabase impact: none; reads unchanged, only their failures surfaced/observable
- Tests run: `tests/module-queries-read-boundary.test.ts` (now 8 — adds referrals throw-on-error + rows-on-success), full suite 515 files / 3,295 tests, eslint clean, typecheck clean
- Validation evidence: boundary test drives a failing client and asserts `listReferralsForFamily` rejects with the fail-closed message; success path returns rows
- Commit: (this increment)
- Status: Resolved in code and pushed to `main`; live verification remains a standing dependency
- Remaining dependencies: `lib/capture/save.ts` id-extraction and `lib/marketing/personalization-server.ts` were reviewed and left as-is (the former reads back a already-checked insert; the latter is optional marketing enhancement where degrade-to-empty is correct)

### PLA-0412 - Social Command Center lists rendered a misleading empty state on read failure

- Timestamp: 2026-07-16 20:33 UTC
- Service: Social Command Center (family-facing) — accounts, feed, posts, media library, calendar, inbox, analytics, overview
- Route: `/dashboard/social/*` (posts, scheduled, published, failed, feed, media-library, content-studio, post detail, overview)
- Affected files: `lib/social/queries.ts`, `tests/module-queries-read-boundary.test.ts`
- Role: any family member with social access
- Scenario: a social read fails (RLS denial, drifted table, outage) while a Social page loads
- Severity: P1 (continuation of the PLA-0411 misleading-empty-state class)
- Launch impact: all ~10 read helpers in `lib/social/queries.ts` discarded the PostgREST `error` and returned `data ?? []` / zero counts, so a failed read rendered a confident empty state — "no posts / no accounts / all metrics zero" — when the data was merely unreadable; the module's own header comment promises it is "fully Supabase-backed — no fabricated rows," which a silent empty read violates
- Root cause: `const { data } = await …; return data ?? []` and `count ?? 0` dropped `error` across the list getters (`getAccounts`, `getFeed`, `getPosts`, `getMediaLibrary`, `getCalendarItems`), the multi-read getters (`getPost`, `getInbox`), and the aggregates (`getAnalytics`, `getSocialOverview`)
- Resolution: added `orThrow`/`throwIfError` helpers; every read now fails closed on error — log via `console.error('[social/queries] read failed', …)` and throw "Could not load your social data from Supabase. Refresh and try again." — while `getPost` still tolerates a genuine not-found (null post, no error). All consumers are dedicated Social pages with no try/catch, so the page surfaces a visible error instead of a fake-empty UI
- Supabase impact: none; reads unchanged, only their failures now fail closed and are observable
- Tests run: `tests/module-queries-read-boundary.test.ts` (now 6 — auto/home/social getters throw on error, return rows on success), full suite 515 files / 3,293 tests, eslint clean, typecheck clean
- Validation evidence: boundary test drives a mocked failing client and asserts `getAccounts` rejects with the fail-closed message; `getPosts` returns rows on success
- Commit: (this increment)
- Status: Resolved in code and pushed to `main`; live per-role RLS verification remains a standing dependency
- Remaining dependencies: authenticated per-role read verification (LB-005 adjacent); this completes the `lib/*/queries.ts` fail-closed triage (auto, home, social — the only three record-query libs)

### PLA-0411 - Auto and Home record lists rendered a misleading empty state on read failure

- Timestamp: 2026-07-16 20:29 UTC
- Service: Auto/Vehicles and Home/Household record lists
- Route: `/dashboard/auto/*` (vehicles, licenses, registration, insurance, rentals, service, accident, overview), `/dashboard/home/*` (warranties, pros, service, maintenance, diagnose)
- Affected files: `lib/auto/queries.ts`, `lib/home/queries.ts`, `tests/module-queries-read-boundary.test.ts`
- Role: any family member viewing their vehicle or household records
- Scenario: a record list read fails (RLS denial, drifted table, outage) while a dedicated Auto/Home page loads
- Severity: P1
- Launch impact: the shared read helpers (`fam<T>()` in Auto; the four getters + `getHomeOverview` in Home) discarded the PostgREST `error` and returned `data ?? []`, so a failed read rendered a confident empty state — "you have no vehicles / no warranties" — when the records were merely unreadable, risking the user re-entering data or believing records were lost (the read-side analog of the PLA-0409/0410 write defect)
- Root cause: `const { data } = await q; return data ?? []` dropped `error`; every consumer is a dedicated page with no try/catch, so the empty array flowed straight to the list UI
- Resolution: both libs now fail closed on read error — log via `console.error('[auto|home/queries] read failed', { table, familyId, error })` and throw a clear "Could not load your … records from Supabase. Refresh and try again." so the page surfaces a visible failure instead of a fake-empty list; verified every getter's consumers are dedicated pages (no cross-module aggregation), and the reasoning/operating-index aggregators that read these tables independently already `.catch`-degrade, so no aggregation surface regresses
- Supabase impact: none; reads unchanged, only their failures now fail closed and are observable
- Tests run: `tests/module-queries-read-boundary.test.ts` (auto getVehicles + home getWarranties throw on error, getVehicles/getAssets return rows on success), full suite 515 files / 3,291 tests, eslint clean, typecheck clean
- Validation evidence: boundary test drives a mocked failing client and asserts the getters reject with the fail-closed message; success path returns the rows
- Commit: (this increment)
- Status: Resolved in code and pushed to `main`; live per-role RLS verification of the surfaced error remains a standing dependency
- Remaining dependencies: authenticated per-role read verification (LB-005 adjacent); other module record-list libs to be triaged next with the same fail-closed pattern

### PLA-0410 - Auto, Paperwork, and Contacts CRUD reported success while silently losing user data

- Timestamp: 2026-07-16 20:23 UTC
- Service: Auto/Vehicles, Paperwork Inbox, Contacts (Relationship Timeline), Family Locator
- Route: `/dashboard/auto/*`, `/dashboard/paperwork`, `/dashboard/contacts/[id]`, `/dashboard/locator`
- Affected files: `app/(app)/dashboard/auto/actions.ts`, `app/(app)/dashboard/paperwork/actions.ts`, `app/(app)/dashboard/contacts/[id]/actions.ts`, `app/(app)/dashboard/locator/actions.ts`, `tests/module-actions-write-boundary.test.ts`
- Role: any family member who can edit these records
- Scenario: an insert/update/delete fails (RLS denial, constraint, outage) while the user saves/deletes a vehicle, license, registration, inspection, policy, rental, auto-service record, paperwork item, or contact interaction
- Severity: P1 (continuation of the PLA-0409 silent-data-loss class)
- Launch impact: the same defect PLA-0409 fixed in Home was present across three more modules — `void`-returning form actions discarded the PostgREST write result, then called `revalidatePath` and returned normally, so a failed write reported success while the record was silently lost. Auto alone had 14 unchecked writes (7 entity types × save+delete); Paperwork's `addPaperworkAction`/`setPaperworkStatusAction` and the one-tap materialization; Contacts' `logInteractionAction`/`deleteInteractionAction`. Locator's two flagged sites were secondary side-effects (arrival-event log, family place-alert) whose primary write already checked its error
- Root cause: `await supabase.from(...).insert/update/delete(...)` results were never inspected; a PostgREST failure returns `{ error }` without throwing
- Resolution: added a throwing `saveRow` helper in Auto (mirrors the existing `softDelete` cast) and made `softDelete` throw; every Auto/Paperwork/Contacts primary write now captures `{ error }` and throws `describeActionError(...)`; the Paperwork materialization inserts throw and the stamp-back logs; best-effort side-effects (Auto odometer refresh, Paperwork draft persist, Locator event/notification inserts) now `console.error` on failure instead of silently dropping
- Supabase impact: none; writes unchanged, only their failures are now surfaced/observable
- Tests run: `tests/module-actions-write-boundary.test.ts` (7 — auto save/delete throw + success, paperwork add/status throw, contacts log/delete throw), full suite 514 files / 3,287 tests, eslint clean, typecheck clean
- Validation evidence: boundary tests drive a mocked failing client and assert each action rejects; the auto success path resolves
- Commit: (this increment)
- Status: Resolved in code and pushed to `main`; live per-role RLS verification of the surfaced errors remains a standing dependency
- Remaining dependencies: authenticated per-role write verification (LB-005 adjacent); the remaining best-effort audit-log/throttle bare writes are intentionally silent and were left as-is

### PLA-0409 - Home module CRUD reported success while silently losing warranties, contractors, and service records

- Timestamp: 2026-07-16 20:15 UTC
- Service: Home / Household management (Warranties, Pros/Contractors, Service Records)
- Route: `/dashboard/home/warranties`, `/dashboard/home/pros`, `/dashboard/home/service`
- Affected files: `app/(app)/dashboard/home/actions.ts`, `tests/home-actions-write-boundary.test.ts`
- Role: any family member who can edit household records
- Scenario: a warranty/contractor/service-record insert, update, or soft-delete fails (RLS denial, constraint violation, outage) while the user submits the form
- Severity: P1
- Launch impact: six `void`-returning form actions (`saveWarrantyAction`, `deleteWarrantyAction`, `saveContractorAction`, `deleteContractorAction`, `saveServiceRecordAction`, `deleteServiceRecordAction`) discarded the write result entirely, then called `revalidatePath` and returned normally — so on any write failure the modal closed and the page refreshed as if the save succeeded, while the record was never persisted (silent data loss the user believes succeeded); the same file's newer `scheduleRecommendedTasksAction` already checked its error, so the module was internally inconsistent
- Root cause: `await supabase.from(...).insert/update(...)` results were never destructured or inspected; a PostgREST failure returns `{ error }` without throwing
- Resolution: capture `{ error }` on every write and `throw new Error(describeActionError(error, '…'))` on failure — the established idiom already used in `social`/`kitchen`/`trip-intel` actions — so the client transition rejects, the modal stays open, and the failure is surfaced instead of faked; the best-effort `home_assets.last_serviced_on` refresh (record already saved) now logs its error rather than throwing
- Supabase impact: none; writes unchanged, only their failures are now surfaced/observable
- Tests run: `tests/home-actions-write-boundary.test.ts` (insert failure throws, success resolves, delete failure throws), full suite 513 files / 3,280 tests, eslint clean, typecheck clean
- Validation evidence: boundary test drives a mocked failing client and asserts `saveWarrantyAction`/`deleteWarrantyAction` reject while a successful client resolves
- Commit: (this increment)
- Status: Resolved in code and pushed to `main`; live RLS/role verification of the surfaced errors remains a standing dependency
- Remaining dependencies: authenticated per-role write verification once test credentials are available (LB-005 adjacent); other bare-write modules flagged in the audit backlog below

### PLA-0408 - Daily reasoning snapshot silently dropped write failures, breaking "since yesterday" trends

- Timestamp: 2026-07-16 20:10 UTC
- Service: AI reasoning history (`loadAndSnapshotReasoning`) — persists the daily snapshot that powers "since yesterday" reasoning deltas
- Route: `lib/reasoning/engine-server.ts`
- Affected files: `lib/reasoning/engine-server.ts`, `tests/reasoning-engine-read-boundary.test.ts`
- Role: any family; every surface that shows day-over-day reasoning trends
- Scenario: the `reasoning_snapshots` upsert fails (drifted table, RLS denial, outage) while persisting today's snapshot
- Severity: P2
- Launch impact: the upsert was awaited inside a `try/catch`, but a PostgREST write failure returns `{ error }` without throwing — so the `catch` never fired, the result was discarded, and a broken `reasoning_snapshots` table would silently drop every daily snapshot, leaving "since yesterday" trend comparisons permanently empty with no operational signal
- Root cause: the upsert result was not destructured or inspected; only thrown exceptions were guarded
- Resolution: inspect the returned `{ error }` and log via `console.error('[reasoning-engine] reasoning_snapshots upsert failed', { familyId, error })` (and log a genuine throw) while preserving the best-effort "return the report regardless" behavior — consistent with PLA-0406/0407
- Supabase impact: none; the write itself is unchanged, only its failure is now observable
- Tests run: `tests/reasoning-engine-read-boundary.test.ts` (now 4 — read + write boundaries, failure logs + success silence), full suite 512 files / 3,277 tests, eslint clean
- Validation evidence: boundary test asserts the `reasoning_snapshots upsert failed` log fires on error and the report is still returned; success path asserts the log does not fire
- Commit: (this increment)
- Status: Resolved in code and pushed to `main`; production log-based alerting on the `[reasoning-engine]` signals remains a standing observability dependency
- Remaining dependencies: route these signals into monitoring once provisioned (A-20 / LB-008 adjacent)

### PLA-0407 - Family reasoning report swallowed a family_signals read failure as "all clear"

- Timestamp: 2026-07-16 20:07 UTC
- Service: AI reasoning report (`loadReasoningReport`) consumed by every six-question reasoning surface (Briefing, Calm, Decisions, Outcomes, Agents, dashboard reasoning strips)
- Route: `lib/reasoning/engine-server.ts`
- Affected files: `lib/reasoning/engine-server.ts`, `tests/reasoning-engine-read-boundary.test.ts`
- Role: any family; every surface that renders the reasoning report
- Scenario: the `family_signals` read fails (RLS denial, drifted table, outage) while the report is assembled
- Severity: P2
- Launch impact: the R10 hard-signals read used `const { data } = …` inside a `try/catch`, but a PostgREST failure returns `{ data: null, error }` without throwing — so the `catch` never fired, the error was discarded, and the report silently degraded to zero signals, reporting "all clear" on the behavioral-signals dimension even when the signals table was broken
- Root cause: the destructure dropped `error`, and the `try/catch` only guarded against thrown exceptions, not returned PostgREST errors
- Resolution: capture `error` and log via `console.error('[reasoning-engine] family_signals read failed', { familyId, error })` while preserving the intentional degrade-to-calm behavior; also log if the read genuinely throws — consistent with the PLA-0406 shared-loader treatment
- Supabase impact: none; read-only diagnostics only
- Tests run: `tests/reasoning-engine-read-boundary.test.ts` (logs + produces a 6-answer report on failure; silent on success), `tests/reasoning-engine.test.ts`, full suite 512 files / 3,275 tests, eslint clean
- Validation evidence: boundary test asserts the `[reasoning-engine] family_signals read failed` log fires and the report still returns all six answers; success path asserts the log does not fire
- Commit: (this increment)
- Status: Resolved in code and pushed to `main`; production log-based alerting on the `[reasoning-engine]` / `[reasoning-context]` signals remains a standing observability dependency
- Remaining dependencies: route these signals into monitoring once provisioned (A-20 / LB-008 adjacent)

### PLA-0406 - Shared reasoning-context graph loader swallowed read failures with zero telemetry

- Timestamp: 2026-07-16 20:00 UTC
- Service: AI reasoning substrate (Knowledge Graph → every AI surface: FOI, Concierge, Briefing, Playbook, Calm, Decisions, Prep-Plans, Agents)
- Route: `lib/reasoning/context.ts` (`loadFamilyGraph`), consumed by all graph-backed dashboard/AI routes
- Affected files: `lib/reasoning/context.ts`, `tests/reasoning-context-read-boundary.test.ts`
- Role: any family; every authenticated AI surface that calls `loadFamilyContext`
- Scenario: `graph_entities` / `graph_edges` read fails (drifted table, RLS denial, outage) while an AI surface loads the family reasoning context
- Severity: P2
- Launch impact: graceful degradation to an empty graph is intentional (the graph is a reasoning *enhancement*, not a source of truth, so it must never crash a surface), but the read error was swallowed with `?? []` and no log — a persistently broken graph table would silently make every AI surface reason over 0 entities forever with no operational signal
- Root cause: `loadFamilyGraph` mapped `ents.data ?? []` / `edges.data ?? []` and discarded `ents.error` / `edges.error` entirely
- Resolution: log each read failure via the established `console.error('[reasoning-context] … read failed', { familyId, error })` convention (86-site pattern in `lib/`) while preserving the intentional empty-graph degradation — resilience unchanged, observability restored
- Supabase impact: none; read-only diagnostics only
- Tests run: `tests/reasoning-context-read-boundary.test.ts` (degrades-without-throwing + logs on failure, silent on success), `tests/reasoning-context.test.ts`, full suite 511 files / 3,273 tests, eslint clean, typecheck clean
- Validation evidence: boundary test asserts an empty graph is returned (no throw) and both `[reasoning-context]` failure logs fire; success path asserts rows map and nothing is logged
- Commit: (this increment)
- Status: Resolved in code and pushed to `main`; live drifted-table alerting wiring remains a standing observability dependency
- Remaining dependencies: route the `[reasoning-context]` signal into production log-based alerting once monitoring is provisioned (A-20 / LB-008 adjacent)

### PLA-0405 - Control-byte corruption in the audit ledger and the Google sync content hash

- Timestamp: 2026-07-16 19:50 UTC
- Service: Launch-audit control plane + Calendar/Tasks sync (change detection)
- Route: `docs/PRODUCT_LAUNCH_AUDIT.md`, `TEST_EVIDENCE.md`, `todo.md`, `lib/sync/providers/google.ts`
- Affected files: `docs/PRODUCT_LAUNCH_AUDIT.md`, `TEST_EVIDENCE.md`, `todo.md`, `lib/sync/providers/google.ts`, `lib/sync/providers/google-adapter.ts`
- Role: all (control plane) / any family with Google Calendar or Tasks sync enabled
- Scenario: full test gate run + Google↔Microsoft provider-neutral change-detection hashing
- Severity: P1
- Launch impact: the audit ledger was binary-corrupted (unreadable, control-plane guard red); Google's duplicated content hash had drifted from the shared implementation, so cross-provider change detection could diverge and re-sync or miss updates
- Root cause: stray control bytes (NUL + `0x01`–`0x1f`) were written into several tracked files by an interrupted/concurrent writer; a raw `0x01` byte inside `parts.join('…')` in Google's duplicated hash masqueraded as `join('')` and had silently replaced the intended shared `join('\x01')` separator; the historical `PLA-0281` anchor entry had also been rotated out of the ledger
- Resolution: stripped all stray control bytes from the four files (repo-wide scan now clean); restored the genuine `PLA-0281` entry (commit `7a20e160`) from git; deduplicated Google's change-detection hash to re-export the single shared `lib/sync/hash` implementation so Google and Microsoft can never drift again, and removed the now-dead `createHash` import
- Supabase impact: none directly; correctness of Calendar/Tasks two-way sync change detection restored (hashes are compared only to themselves, so no historical data migration needed)
- Tests run: `tests/launch-audit-docs.test.ts` (control plane, green), `tests/sync-adapter.test.ts` provider-neutral parity (green), `tests/sync-crypto.test.ts`, full suite 510 files / 3,270 tests, eslint, and a repo-wide control-byte scan (0 findings)
- Validation evidence: `git ls-files` control-byte scan returns empty; `google/microsoft hash the same normalized event identically` passes; full green suite
- Commit: (this increment)
- Status: Resolved in code and pushed to `main`; live Google/Microsoft sync smoke remains a standing dependency
- Remaining dependencies: authenticated live two-way sync verification once provider credentials are available (LB-006)

### PLA-0404 - Command Center hid family and Operating Index read failures as a healthy readiness score

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/command-center`.
- Finding: member, event, chore, meal-plan, document, or Operating Index reads could fail while the Command Center calculated a readiness score from partial data.
- Repair: the route now preserves all five primary read errors and catches Operating Index load failures, returning a retryable page failure before computing score or issues.
- Evidence: focused Command Center boundary suite (1 assertion), full 510 test files/3,270 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `306aeb17`.
- Remaining launch gate: validate authenticated family RLS, Operating Index availability, and deployed retry behavior; shared reasoning-context and broader dashboard gates remain open.

### PLA-0403 - Dashboard Briefing hid Operating Index snapshot read failures as an empty recap

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/briefing`.
- Finding: a failed `family_operating_index` read silently removed the persisted “since yesterday” recap while the rest of the briefing rendered normally.
- Repair: the route now preserves the snapshot read error, logs it, and returns a retryable page failure before rendering the briefing.
- Evidence: focused Briefing boundary suite (1 assertion), full 509 test files/3,269 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `c56b870e`.
- Remaining launch gate: validate authenticated family RLS, Operating Index availability, and deployed retry behavior; shared reasoning-context and broader dashboard gates remain open.

### PLA-0402 - Dashboard Activity hid source and chore-enrichment read failures as an incomplete feed

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/activity`.
- Finding: family members, announcements, events, approved chores, photos, notes, groceries, or chore-title enrichment could fail while the activity feed rendered from partial or empty data.
- Repair: the route now preserves every primary source error and the secondary chore-title error, logging and returning a retryable page failure before building feed items.
- Evidence: focused Activity page boundary suite (1 assertion), full 508 test files/3,268 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `463c5b60`.
- Remaining launch gate: validate authenticated family RLS, activity source availability, and deployed retry behavior; broader dashboard and deployment gates remain open.

### PLA-0401 - Dashboard Home hid preference read failures as the wrong dashboard

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard` without an explicit `view` query.
- Finding: a failed `user_preferences` read silently selected the AI dashboard, hiding the user's saved default view state.
- Repair: the default dashboard route now preserves the preference error and returns a retryable page failure; explicit `?view=family` and `?view=personal` routes remain independent.
- Evidence: focused Dashboard Home boundary suite (1 assertion), full 507 test files/3,267 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `49a5ec33`; published to `main` and verified by remote marker readback.
- Remaining launch gate: validate authenticated preference RLS, saved-view persistence, explicit view routing, and deployed retry behavior; broader dashboard and deployment gates remain open.

### PLA-0400 - Family Operations and Reports hid shared-signal read failures as healthy summaries

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/family-operations` and `/family/reports`.
- Finding: shared signal reads could fail while household completion, stress, bills, and task summaries rendered from an exception or zero-valued fallback.
- Repair: both routes now consume the status-preserving signal result and return retryable page failures before rendering summary metrics.
- Evidence: focused Family Summary boundary suite (1 assertion), full 506 test files/3,266 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `dd3c2929`.
- Remaining launch gate: validate authenticated family RLS, summary source availability, and deployed retry behavior; broader dashboard and deployment gates remain open.

### PLA-0399 - Family Stress hid signal, member, and logged-input read failures as a healthy forecast

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/family-stress`.
- Finding: signal, active-member, or logged-stress-input reads could fail while the forecast, member selector, and “No signals” state rendered as healthy.
- Repair: the route now preserves all required Supabase errors and returns a retryable page failure before exposing the forecast or logging controls.
- Evidence: focused Family Stress boundary suite (1 assertion), full 505 test files/3,265 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `c4c3cb5f`.
- Remaining launch gate: validate authenticated family RLS, member ownership, stress-input writes, and deployed retry behavior; broader dashboard and deployment gates remain open.

### PLA-0398 - Family Automation hid rules and run-feed read failures as healthy defaults

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/family-automation`.
- Finding: automation-rule, pending-run, or recent-run reads could fail while metrics, approval controls, and CRUD controls rendered healthy or empty states.
- Repair: the route now preserves all required Supabase errors and returns a retryable page failure before rendering rules, approval actions, or activity metrics.
- Evidence: focused Family Automation boundary suite (1 assertion), full 504 test files/3,264 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `4a01fc5e`.
- Remaining launch gate: validate authenticated family RLS, manager approval behavior, mutation recovery, and deployed retry behavior; broader dashboard and deployment gates remain open.

### PLA-0397 - Contact Timeline hid contact, interaction, and communication read failures as missing history

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/contacts/[id]`.
- Finding: contact lookup failures could look like a missing contact, while interaction and communication failures rendered an empty timeline.
- Repair: the route now preserves all three Supabase errors and returns a retryable page failure before building relationship health or timeline views.
- Evidence: focused Contact Timeline boundary suite (1 assertion), full 503 test files/3,263 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `ae763b67`.
- Remaining launch gate: validate authenticated family RLS, contact ownership, communication availability, and deployed retry behavior; broader dashboard and deployment gates remain open.

### PLA-0396 - Autonomous Family Management hid signal and automation read failures as healthy defaults

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/autonomous-family-management`.
- Finding: family signal, recommendation, automation-rule, and automation-run reads could fail while monitoring, approval, and risk controls rendered zero or empty states.
- Repair: the shared signal collector now preserves required query errors, and the route returns a retryable page failure before deriving metrics, recommendations, or approval controls.
- Evidence: focused Autonomous Family Management boundary suite (1 assertion), full 502 test files/3,262 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `f04895cd`.
- Remaining launch gate: validate authenticated family RLS, signal and automation availability, approval behavior, and deployed retry behavior; broader dashboard and deployment gates remain open.

### PLA-0395 - Family Assistant hid context and count failures as zero signals

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/agents`.
- Finding: calendar, meal, member, activity, and ten count reads could fail while agent briefings rendered zero operational signals.
- Repair: all required context and count results now retain their errors and the route returns a retryable page failure before deriving briefings.
- Evidence: focused Family Assistant boundary suite (1 assertion), full 501 test files/3,261 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `d43b15c4`.
- Remaining launch gate: validate authenticated family RLS, agent context availability, reasoning behavior, and deployed retry behavior; broader dashboard and deployment gates remain open.

### PLA-0394 - Family Intelligence hid signal read failures as an empty intelligence screen

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/family-signals`.
- Finding: the family-signal query could fail while the route rendered no active or hidden intelligence signals.
- Repair: the Supabase error is checked before deriving active/hidden signal views; failures return a retryable page state.
- Evidence: focused Family Intelligence boundary suite (1 assertion), full 500 test files/3,260 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `384acfbd`.
- Remaining launch gate: validate authenticated family RLS, signal availability, and deployed retry behavior; broader dashboard and deployment gates remain open.

### PLA-0393 - Deals hid listing read failures as no standout deals

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/marketplace/deals`.
- Finding: the deal-feed listing query could fail while price-coach logic rendered “No standout deals right now.”
- Repair: the Supabase error is checked before building comparable price bands or rendering the empty state; failures return a retryable page state.
- Evidence: focused Deals boundary suite (1 assertion), full 499 test files/3,259 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `071bfd7c`.
- Remaining launch gate: validate authenticated marketplace reachability, listing availability, price-coach data, and deployed retry behavior; broader payment and deployment gates remain open.

### PLA-0392 - Selling hid listing and seller-signal read failures as zero activity

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/marketplace/selling`.
- Finding: the listing query and six seller-signal queries could fail while the seller cockpit rendered zero listings, offers, questions, or handoffs.
- Repair: all required listing and signal results are checked before deriving attention rankings or rendering the empty seller state; failures return a retryable page state.
- Evidence: focused Selling boundary suite (1 assertion), full 498 test files/3,258 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `db158e01`.
- Remaining launch gate: validate authenticated seller RLS, signal-table availability, buyer/seller workflows, and deployed retry behavior; broader payment and deployment gates remain open.

### PLA-0391 - Live Auctions hid listing read failures as an empty marketplace

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/marketplace/auctions`.
- Finding: the marketplace listing query could fail while the route rendered “No live auctions right now” and zero operational stats.
- Repair: the Supabase error is checked before deriving auction stats or rendering the empty state; failures return a retryable page state.
- Evidence: focused Live Auctions boundary suite (1 assertion), full 497 test files/3,257 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `f86dd8a2`.
- Remaining launch gate: validate authenticated family reachability, marketplace RLS, listing availability, and deployed retry behavior; broader payment and deployment gates remain open.

### PLA-0390 - Referrals hid settings and activity read failures as defaults or no activity

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/marketing/referrals` and shared referral config reads.
- Finding: referral settings errors fell back to defaults and referral-row errors rendered no activity, leaving the admin dashboard actionable with incomplete state.
- Repair: added a status-preserving config read helper and require both config and referral reads to succeed before metrics, settings, or activity render.
- Evidence: focused Referrals boundary suite (1 assertion), full 496 test files/3,256 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `2b06e789`.
- Remaining launch gate: validate live Super Admin authorization, referral settings/activity availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0389 - New Campaign hid segment read failures as an unfiltered audience selector

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/marketing/campaigns/new`.
- Finding: the `marketing_segments` query could fail while campaign creation rendered a “No segment” fallback and allowed an unfiltered campaign.
- Repair: the Supabase error is checked before rendering the campaign form; failures return a retryable page state instead of silently removing audience targeting.
- Evidence: focused New Campaign boundary suite (1 assertion), full 495 test files/3,255 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `d600ad7c`.
- Remaining launch gate: validate live Super Admin authorization, segment availability, and deployed retry behavior; Auth Admin and broader launch blockers remain ope�����$z{-���jםV�6��vV@��FW7G2'V��FW7G2�v��WB�&VB�&�V�F'��FW7B�G6�2f�7W6VBFW7G2��gV��CS�f��R�2�sr�FW7B7V�FS�G�V6�V6��Ɩ�C�FWV�FV�7�VF�C�&�GV7F���'V��C�F�fb6�V6���fƖFF���Wf�FV�6S�f�����6�vFR76VBv�F�&�GV7F���FWV�FV�7�gV��W&&�ƗF�W2�B#SvV�W&FVB&�WFW0��7FGW3�&W6��fVB��6�FS�ƗfRv��WB�$�2�&��R�6��7W'&V�7���B'&�w6W"Wf�FV�6R&V����V���&V�����rFWV�FV�6�W3�W�V7WFR��vW"��V�&W"v��WB���fW7B�v�gB�&'�6�GFW"�6���B�v��WB�&V6��6�ƖF�����BFV��B֗6��F���G&���2v��7BFW���VB7W&6P�222��3#�7G&�R7V'67&�F���vV&�����v��&VB&��"&��Ɩ�r7FFRf��W&W0���F��W7F��##b�r�RC��W&�6��Wu���&���6W'f�6S�7G&�R7V'67&�F���vV&����7��6�&�旦F����Bw&�wF��W'G0��&�WFS����vV&����2�7G&�V��ffV7FVBf��W3����vV&����2�7G&�R�&�WFR�G6�FW7G2�vV&�����W'6�7FV�6R�&�V�F&�W2�FW7B�G6��&��S����rf֖ǒ�B7WW"F֖��W&F� ��66V�&���&��Ɩ�r�7W7F��W"�B&��"�7V'67&�F���&VG2&�F�vWF�W"�'WB��ǒF�R&��Ɩ�r�7W7F��W"W'&�"v26�V6�VB&Vf�&R7V'67&�F���W'6�7FV�6R�B6��fW'6����6�W&�6��&�6����6WfW&�G�����V�6���7C�7G&�RWfV�G26�V�Bw&�FR7V'67&�F���7FFRv�F��V�G'W7FVBG&�6�F���&6VƖ�R�"f��F�G&�vvW"67W&FRw&�wF��W'G0��&��B6W6S�&��%7V'67&�F���W'&�&v2F�66&FVC���V�BWF��F���f��W&W2vW&R6��V�Fǒ7v���vV@��&W6��WF����&�F�&WV�&VB7FFR&VG2��rf��6��6VBF�&�Vv�F�R&W&�6W76&�RvV&����W'&�"F����V�BWF��F���f��W&W2&R��vvV@��7W&6R��7C���66�V�6��vS�W��7F��rWfV�B6����f��Ɨ�F����Bf֖ǒ�66�VB7V'67&�F���W'6�7FV�6R&V������6P��FW7G2'V��FW7G2�vV&�����W'6�7FV�6R�&�V�F&�W2�FW7B�G6�FW7G2�7G&�R�w&�wF���W'G2�6��G&7B�FW7B�G6��BFW7G2�7G&�R�vV&�����&W���6��G&7B�FW7B�G6�f�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF���76W3�gV��vFR�BƗfR7G&�RWf�FV�6R&V����V���7FGW3�&W6��fVB��6�FS�ƗfR&W����FV��FV�7��B&�f�FW"Wf�FV�6R&V����V���&V�����rFWV�FV�6�W3�W�V7WFR����FW7G'V7F�fR7V'67&�F���ƖfV7�6�R�&W���&WG'���Bw&�wF���W'BG&���2��7G&�RFW7B��FP�222��3#"����v�6R7&��6��VB7&VF�G2v�V�7V'67&�F���vF��r&VBf��V@���F��W7F��##b�r�RC�B�W&�6��Wu���&���6W'f�6S�66�VGV�VBv��WB���v�6RWF��F�����&�WFS����7&���v��WB����v�6V��ffV7FVBf��W3����7&���v��WB����v�6R�&�WFR�G6�FW7G2�7&���v��WB����v�6R�W'6�7FV�6R�FW7B�G6��&��S�f֖ǒ��vW"�&V�B�6���B&V6��V�B��B66�VGV�VB7&��v�&�W ��66V�&���f��VB7V'67&�F���2&VB&�GV6VB�V�G�����6��B�f֖ǒVƖv�&�ƗG�6�V�B&RG&VFVB2g&VR�B7&VF�G26��V@��6WfW&�G�����V�6���7C�66�VGV�VB���v�6W26�V�BF�6V"v�F��WB&WG'�&�Rf��W&R6�v����&��B6W6S�F�R7V'67&�F������vF��rW'&�"v2F�66&FV@��&W6��WF����7V'67&�F���&VBW'&�'2��rf��F�R7&��F�&�Vv��G2SW'&�"F��66�VGV�R6����B7&VF�B&���&6�&V���6�V6�V@��7W&6R��7C���66�V�6��vS����v�6R�B7V'67&�F���f֖ǒ66�W2&V���V�6��vV@��FW7G2'V��FW7G2�7&���v��WB����v�6R�W'6�7FV�6R�FW7B�G6�FW7G2�7&���WF��FW7B�G6��f�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF���76W3�gV��vFR�BƗfR7&���$�2Wf�FV�6R&V����V���7FGW3�&W6��fVB��6�FS�ƗfR66�VGV�VBW�V7WF���&V���2�V���&V�����rFWV�FV�6�W3�W�V7WFR�6��FVB�WFvR�GWƖ6FR�'V���B�VFvW"�$�2G&���0�222��3#2�F�vW7B7&��2��Bf֖ǒ�BFVƗfW'�f��W&W22�W&�6V�G0���F��W7F��##b�r�RC���W&�6��Wu���&���6W'f�6S�6��&R&V֖�FW"�BvVV�ǒF�vW7B66�VGV�VBV���v�&�f��w0��&�WFW3����7&���6��&R�&V֖�FW'6����7&���vVV�ǒ�F�vW7F��ffV7FVBf��W3����7&���6��&R�&V֖�FW'2�&�WFR�G6����7&���vVV�ǒ�F�vW7B�&�WFR�G6�FW7G2�F�vW7B�7&���&VB�&�V�F'��FW7B�G6��&��S�f֖ǒ�V�&W"�f֖ǒF֖���B66�VGV�VB7&��v�&�W ��66V�&���f֖ǒ�WF�F֖��fVGW&R&VG2f��VB'WBF�R7&��76V�&�VBV�G�FF�"&V6��V�G3�f��VBV���FVƗfW'�F�B��B6��vRF�R&W7��6R7FGW0��6WfW&�G�����V�6���7C�&V֖�FW'2�BF�vW7G26�V�B&R֗76VBv���R�W&F���26r�&V�Fǒ7V66W76gV��W&��6V�B'V���&��B6W6S�7W&6R&W7V�BW'&�'2vW&RF�66&FVB�BV���6V�Bf��W&W2vW&R��B6�V�FV@��&W6��WF����&WV�&VB&VG2��rf��v�F�S�W"�f֖ǒ&VBf��W&W2&R6�V�FVB��B'F��V���FVƗfW'�&WGW&�2S"v�F�6V�B�f��VB6�V�G0��7W&6R��7C���66�V�6��vS�W��7F��rf֖ǒ�66�VBVW&�W2&V���V�6��vV@��FW7G2'V��FW7G2�F�vW7B�7&���&VB�&�V�F'��FW7B�G6�FW7G2�7&���WF��FW7B�G6�bf�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF���76W3�gV��vFR�BƗfR66�VGV�W"�&W6V�BWf�FV�6R&V����V���7FGW3�&W6��fVB��6�FS�ƗfRFVƗfW'�Wf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�W�V7WFR66�VGV�W"�&�f�FW"�WFvR�&WG'��&V6��V�B��BGWƖ6FR�'V�G&���0�222��3#��v��WB�V"FV�WF���&VƖVB��G��֖2�B���ǒF&vWF��p���F��W7F��##b�r�RS��W&�6��Wu���&���6W'f�6S�v��WB�V"FW7G'V7F�fR7F���0��&�WFS�FV�WFUv��WE&�t7F�����ffV7FVBf��W3�����v��WB��V"�7F���2�G6�FW7G2�v��WB����W��7F����&�V�F&�W2�FW7B�G6��&��S�f֖ǒ��vW"�"WF�V�F�6FVB��W6V���B�V�&W"��f����rv��WBFV�WF�����66V�&���G��֖2F&�R��R�B�B���ǒFV�WFR&VƖVB��$�2��7FVB�bW�Ɩ6�Fǒ6��7G&����rF�R7F�fRf֖ǐ��6WfW&�G�����V�6���7C��Ɩ7�G&�gB6�V�BW&֗B7&�72�f֖ǒFV�WF����bv��WBFF��&��B6W6S�F�R7F���W6VBg&�҆��WB�F&�R��B�֗GFVBf֖Ǖ��Fg&��F�RFV�WFR&VF�6FP��&W6��WF����W�Ɩ6�B7W�'FVB�F&�R'&�6�W2��r��6�VFRf֖Ǖ��B�7G��7F�fR�f֖ǔ�F�$�2&V���2FVfV�6R��FWF���7W&6R��7C���66�V�6��vS�7G&V�wF�V�2W��7F��rf֖ǒ�66�VBv��WBF&�W2�B$�2�Ɩ6�W0��FW7G2'V��FW7G2�v��WB����W��7F����&�V�F&�W2�FW7B�G6�FW7G2�FV��B֗6��F����&�2�FW7B�G6�FW7G2�&��R�7W&f6R�FW7B�G6�FW7G2�&��R�FV�6�G��FW7B�G6�#"f�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF����BgV����6�vFR73�ƗfR7&�72�f֖ǒ�$�2�6��7W'&V�7�Wf�FV�6R&V���2�V���7FGW3�&W6��fVB��6�FS�ƗfRv��WBWF��&��F���Wf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�W�V7WFRWF�V�F�6FVBGv��f֖ǒv��WBFV�WF����B&��R�6��7W'&V�7�G&���0��222��3#����&�&F��r&�f�6�����r6���v�VFvVB��6���WFR7FFRw&�FW0���F��W7F��##b�r�RS��W&�6��Wu���&���6W'f�6S�&�f��R��&�&F��r�B6��F�&�ƗG�f�'7B�f֖ǒ&�f�6�����p��&�WFS�6���WFU&�f��T��&�&F��t7F����V�7W&T7F�fTf֖ǖ��B&�FV7FVB�vR��&�&F��rf��&6���ffV7FVBf��W3����&�&F��r�7F���2�G6�Ɩ"�6W'fW"�V�7W&R�f֖ǒ�G6�FW7G2���&�&F��r�f��W&R�6fWG��FW7B�G6��&��S��Wr66�V�B�v�W"�W��7F��r�V�F��f֖ǒW6W"�f֖ǒ��vW"��Bf�'7B���v��&�f�6�����rv�&�W ��66V�&����V�&W'6���&VfW&V�6R&VG2�"7V'67&�F����7F�fR�f֖ǒw&�FW2f��VBv���R��&�&F��r&WGW&�VB7V66W72��"6���"WFFRF�V6�VBWfW'�f֖ǒ�V�&W'6����6WfW&�G�����V�6���7C���&�&F��r6�V�B6���WFRv�F��WBfƖBFV��B�7V'67&�F���7FFR�"�WFFR��F�W"f֖Ǟ(	�2T�FF��&��B6W6S�6V6��F'�7W&6R&W7V�BW'&�'2vW&R�v��&VB�BF�R�V�&W"6���"WFFR�6�VBf֖ǒ66�P��&W6��WF����&WV�&VB&VG2�Bw&�FW2��rf��6��6VB�6��F�&�ƗG�&�f�6�����r&W�'G2f�6R��7V'67&�F����7F�fR�f֖ǒf��W&W2��B6���"WFFW2F&vWBF�R&W6��fVBf֖ǒ��ǐ��7W&6R��7C���66�V�6��vS�&�FV7G2W��7F��rf֖Ǖ��V�&W'2�W6W%�&VfW&V�6W2�7V'67&�F���2�f֖ƖW2&�V�F&�W0��FW7G2'V��FW7G2���&�&F��r�f��W&R�6fWG��FW7B�G6�FW7G2���&�&F��r֖FV��FV�7��FW7B�G6�FW7G2�V�7W&R�f֖ǒ�6��7W'&V�7��FW7B�G6�FW7G2�WF��6��FW�B֖�FVw&�G��FW7B�G6�f�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF����BgV����6�vFR73�ƗfR��&�&F��r�F�W"���f�FR��B7&�72�FV��B$�2Wf�FV�6R&V���2�V���7FGW3�&W6��fVB��6�FS�ƗfR��&�&F��r�FW����V�BWf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�ǒ�BfW&�g�֖w&F���2#�#"�F�V�W�V7WFRf�'7B���v�����f�FR�F�W"��BGv��FV��BG&���0��222��3#r���6���WFRf֖ǒ6��FW�B6�V�B&R֗66�76�f�VB2��&�&F��p���F��W7F��##b�r�RC�S�W&�6��Wu���&���6W'f�6S�WF�V�F�6FVBW6W"6��FW�B�FV��B�V�&W'6��&W6��WF�����Bf�'7B�f֖ǒ&�f�6�����p��&�WFS�Ɩ"�7W&6R�WF��G6�&�FV7FVBvW2��B��&�&F��rf��&6���ffV7FVBf��W3�Ɩ"�7W&6R�WF��G6�FW7G2�WF��6��FW�B֖�FVw&�G��FW7B�G6��&��S�WF�V�F�6FVBW6W"v�F��V�&W'6��2�f֖ǒ��vW"��Bf�'7B���v��&�f�6�����rv�&�W ��66V�&����7F�fR�V�&W'6��6�V�B��B&R����VBF��G2f֖ǒ&�r�'WB6��FW�B&W6��WF���&WGW&�VBF�R��&�&F��r7FFP��6WfW&�G�����V�6���7C�'F��FV��B�6��FW�B&VB6�V�B7&VFR6V6��Bf֖ǒ�"֗7&�WFRF�RW6W"��7FVB�bf�Ɩ�r6fVǐ��&��B6W6S�֗76��rf֖ǒ����2vW&R6��V�Fǒf��FW&VB&Vf�&RF�R�VVG4f֖ǖ'&�6���&W6��WF������6���WFRf֖ǒ����2�B�V�&W'6�����w2��r&WGW&�&WG'�&�R6��FW�B�V�f��&�Rf��W&P��7W&6R��7C���66�V�6��vS�&�FV7G2W��7F��rf֖Ǖ��V�&W'2�f֖ƖW2�W6W%�&VfW&V�6W2&VG2�B&�f�6�����r6��0��FW7G2'V��FW7G2�WF��6��FW�B֖�FVw&�G��FW7B�G6�FW7G2�F֖��WF��&�V�F'��FW7B�G6�FW7G2�FV��B֗6��F����&�2�FW7B�G6�FW7G2�V�7W&R�f֖ǒ�6��7W'&V�7��FW7B�G6��f�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF����BgV����6�vFR73�ƗfRWF�F֖��$�2�&��R�'&�w6W"Wf�FV�6R&V���2�V���7FGW3�&W6��fVB��6�FS�ƗfRFV��B֗6��F���Wf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�ǒ#�#"�BW�V7WFRWF�V�F�6FVBGv��FV��B�Bf�'7B���v��G&���0��222��3#b�66�VGV�VB��FVw&F���26���v�VFvVB6V6��F'�W'6�7FV�6Rf��W&W0���F��W7F��##b�r�RC�C"�W&�6��Wu���&���6W'f�6S�wV&F���V&���r��WGv�&�vw&VvF����V7F���2�&�f�FW"7��2��B6�V�F"fVVB7��0��&�WFS����7&���wV&F����V&���v����7&����WGv�&��vw&VvFV����7&���6��6R�V7F���6����7&���&�f�FW"�7��6����7&���6�V�F"�fVVG6��ffV7FVBf��W3����7&���wV&F����V&���r�&�WFR�G6����7&����WGv�&��vw&VvFR�&�WFR�G6�Ɩ"��WGv�&��vw&VvFR�6W'fW"�G6����7&���6��6R�V7F���2�&�WFR�G6����7&���&�f�FW"�7��2�&�WFR�G6�Ɩ"�6W'fW"�6�V�F"�fVVG2�G6�FW7G2�7&���&V6�fW'��&�V�F&�W2�FW7B�G6��&��S�f֖ǒ�V�&W"��WGv�&��6��6V�F��r��W6V���B�V7F���'F�6��B�6���V7FVB�&�f�FW"W6W"�6�V�F"7V'67&�&W"��B66�VGV�VB7&��v�&�W ��66V�&���6V6��F'�&VG2�"w&�FW2f��VBgFW"&��'�&F6�&VG2v���RF�R��"&WGW&�VB7V66W72�"V&Ɨ6�VB��6���WFR7FFP��6WfW&�G�����V�6���7C��V&���r�vw&VvFR&�f7��V7F�����F�f�6F���2�7��2�'6W'f&�ƗG���"6�V�F"7FFR6�V�B&R��6���WFRv�F��WB&WG'�6�v����&��B6W6S�7W&6R&W7V�BW'&�'2vW&RF�66&FVB��6�V�W�6�W&6RVW&�W2�6��G&�'WF���'V���r���F�f�6F���2�VF�B��w2�WfV�BW6W'G2��BfVVB7FGW2w&�FW0��&W6��WF����&WV�&VB&VG2�Bw&�FW2&R6�V6�VC�7&��W'&�'2&R6��F��VB�B&WGW&�S"����6���WFR66�VGV�VBv�&��fVVB7��2f��2v�V�WfV�B�"7FGW2W'6�7FV�6Rf��0��7W&6R��7C���66�V�6��vS�W��7F��r6��6V�B�vw&VvFR��&�WG�6R�7��2��B6�V�F"66�W2&V���V�6��vV@��FW7G2'V��FW7G2�7&���&V6�fW'��&�V�F&�W2�FW7B�G6�FW7G2�7&���&F6��f��W&R�7FGW2�FW7B�G6�FW7G2�7&���&�f�FW"�7��2�FW7B�G6�FW7G2�7&���WF��FW7B�G6�FW7G2��&�WG�6R�V7F����6V7W&�G��FW7B�G6�rf�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF����BgV����6�vFR73�ƗfR66�VGV�W"�&�f�FW"�&�f7��$�2Wf�FV�6R&V���2�V���7FGW3�&W6��fVB��6�FS�ƗfR66�VGV�VB��FVw&F���Wf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�W�V7WFR66�VGV�W"�&�f�FW"�WFvR�&WG'��GWƖ6FR�'V��6��6V�B�&�f7���BƗfR7W&6RG&���0��222��3#R�&WGW&��B��FV�&Vg&W6�7&��26���v�VFvVBW'6�7FV�6Rf��W&W0���F��W7F��##b�r�RC�3R�W&�6��Wu���&���6W'f�6S��&�WG�6R&WGW&�&V֖�FW'2�B��W6V���B��FV�&Vg&W6���&�WFS����7&���&WGW&��&V֖�FW'6����7&�����FV��&Vg&W6���ffV7FVBf��W3����7&���&WGW&��&V֖�FW'2�&�WFR�G6����7&�����FV��&Vg&W6��&�WFR�G6�FW7G2�7&���&WGW&��&V֖�FW'2�&�V�F'��FW7B�G6��&��S�f֖ǒ�V�&W'2v�F��r��&WGW&�2���W6V���B�V�&W'2&Vǖ��r����FV�&��V7F���2��B66�VGV�VB7&��v�&�W'0��66V�&���6V6��F'�Ɨ7F��r���F�f�6F�����&FW"�7F��F�'G��7FFR��"F�'G��f�rf��W&W2vW&R�v��&VBgFW"&��'�&VG27V66VVFV@��6WfW&�G�����V�6���7C�&V֖�FW'26�V�B&WVB�"F�6V"��B��FV�&Vg&W6�6�V�B&W�'B7V66W72v���R7F�Rv�&�&V���VBVWVV@��&��B6W6S�7W&6R&W7V�BW'&�'2g&��6V6��F'�&VG2�Bw&�FW2vW&RF�66&FV@��&W6��WF����&WV�&VB&VG2�Bw&�FW2&R6�V6�VC�f��VB&V֖�FW"�FV�2�BF�'G��7FFRW'6�7FV�6R��r&�GV6R&WG'�&�R����7V66W72&W7��6W0��7W&6R��7C���66�V�6��vS�W��7F��r�&�WG�6R�B��FV��F�'G�66�W2&V���V�6��vV@��FW7G2'V��FW7G2�7&���&WGW&��&V֖�FW'2�&�V�F'��FW7B�G6�FW7G2�7&���&F6��f��W&R�7FGW2�FW7B�G6�FW7G2�7&���WF��FW7B�G6�f�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF����BgV����6�vFR73�ƗfR66�VGV�W"�&�f�FW"�$�2Wf�FV�6R&V���2�V���7FGW3�&W6��fVB��6�FS�ƗfR66�VGV�VBFVƗfW'�Wf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�W�V7WFR66�VGV�W"�GWƖ6FR�'V��&�f�FW"�WFvR�&WG'���BƗfR7W&6RG&���0��222��3#B���W&�W�&V6�fW'�6���v�VFvVBf��VB&�F���V�B7vVW0���F��W7F��##b�r�RC�3�W&�6��Wu���&���6W'f�6S�&�F��VB��&�&F��r�BFV����VB&V6�fW'�7&����&�WFS����7&�����W&�W��&V6�fW'���ffV7FVBf��W3����7&�����W&�W��&V6�fW'��&�WFR�G6�FW7G2���W&�W��&V6�fW'��7&���&�V�F'��FW7B�G6��&��S�&�F��VBW6W"�FV���VB��&�WF��r�W&F�"��B66�VGV�VB7&��v�&�W ��66V�&�����&�&F��r�5$��&�f��R��"WF��F���f��W&W2vW&R��vvVB'WBF�RV�G���B7F���&WGW&�VB7V66W72v�F�'F��6�V�G0��6WfW&�G�����V�6���7C�f����r�Wv�&�f��w26�V�B&R6��V�Fǒ6��VBv�F��WB��W&F����&WG'�6�v����&��B6W6S�7vVW�&�f��R�WF��F���f��W&W2vW&R��B6�V�FVB��F�R&W7��6R7FGW0��&W6��WF����&WV�&VB&VG2��rf��F�R7vVW�W"�&V6�&Bf��W&W2��7&V�V�Bf��VF��BF�RV�G���B&WGW&�2S"v�V���v�&�f��0��7W&6R��7C���66�V�6��vS�W��7F��r��&�&F��r�&�f��R�5$�66�W2&V���V�6��vV@��FW7G2'V��FW7G2���W&�W��&V6�fW'��7&���&�V�F'��FW7B�G6�FW7G2�7&���WF��FW7B�G6�bf�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF����BF�RgV����6�vFR73�ƗfR66�VGV�W"�&�f�FW"Wf�FV�6R&V���2�V���7FGW3�&W6��fVB��6�FS�ƗfRWF��F���Wf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�W�V7WFR66�VGV�W"�&�f�FW"�WFvR�&WG'��GWƖ6FR�'V���B&V6��V�BG&���0
---

### PLA-0281 - Goal funding could debit without updating goal progress

- Timestamp: 2026-07-15 07:49 America/New_York
- Service: Family Wallet savings goals
- Route: `/wallet/goals`
- Affected files: `supabase/migrations/0208_atomic_wallet_goal_funding.sql`, `lib/wallet/server.ts`, `lib/database.types.ts`, `app/(app)/wallet/actions.ts`, `tests/wallet-goal-persistence.test.ts`
- Role: parent/guardian manager
- Scenario: Save-bucket balance is checked, debit is inserted, and goal update/audit fails or races
- Severity: P1
- Launch impact: money can leave the Save bucket without matching goal progress
- Root cause: separate best-effort client writes and non-locking balance read
- Resolution: manager-checked row-locking RPC atomically rechecks balance, debits ledger, updates goal/status, and writes audit
- Supabase impact: new `wallet_fund_goal` function and migration `0208`; typed wrapper replaces direct writes
- Tests run: focused goal/atomic contracts, 403-file/3,024-test suite, typecheck, lint, audit, schema probes, seed invariant, clean build
- Validation evidence: `tests/wallet-goal-persistence.test.ts`, `npm.cmd run db:audit:schema`, 250-route build
- Commit: `7a20e160`
- Status: Resolved in code and pushed to `main`; remote migration application remains a dependency
- Remaining dependencies: reconcile/apply migration remotely, then run authenticated wallet concurrency smoke

