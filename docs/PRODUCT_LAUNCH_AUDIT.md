# Product Launch Audit Ledger

This is the issue-level evidence ledger for launch. Each entry includes the required service, route,
role, scenario, severity, launch impact, root cause, resolution, Supabase impact, tests, validation,
commit, status, and remaining dependency. New findings must be added before or with their repair.

## Resolved Issues

### PLA-0785 - Trip detail writes (packing toggle/remove, dismiss recommendation) silently no-op'd on failure (A-13)

- Timestamp: 2026-07-17 20:35 UTC
- Service: Vacations / travel / concierge (A-13) — trip detail tabs (Packing, Overview)
- Route: `/dashboard/vacations/[id]/packing` (`components/vacations/trip-packing.tsx`), `/dashboard/vacations/[id]/overview` (`components/vacations/trip-overview.tsx`)
- Affected files: `components/vacations/trip-packing.tsx`, `components/vacations/trip-overview.tsx`, `tests/vacations-detail-write-boundary.test.ts` (new)
- Role: all family roles with the Vacations feature
- Scenario: a packing-item check/uncheck, a packing-item delete, or an AI-recommendation dismiss fails for a real reason (RLS denial, offline, constraint)
- Severity: P2 (silent write failure / optimistic UI lies about persisted state)
- Launch impact: three user-initiated writes fired `await …update/delete(...)` and **dropped the Supabase `error`**. `toggle` (packing `packed`) and `remove` (packing item) and `dismissReco` (mark an AI recommendation dismissed) all no-op'd silently on failure — the checkbox reverts / the "deleted" item reappears / the dismissed recommendation returns on the next load, with no error shown. Their sibling writes in the same files (`add`, budget `savePlanned`) already capture `{ error }` and toast it, so this was an inconsistency
- Root cause: `await createClient().from(...).update/delete(...)` dropped the PostgREST `error` at the three sites
- Resolution: all three now `const { error } = await …; if (error) toastError(error.message);` matching the sibling pattern. The background readiness-score auto-insert in the overview effect (non-user-initiated telemetry) was intentionally left as-is
- Supabase impact: none — writes unchanged; genuine failures now surface via toast
- Tests run: `tests/vacations-detail-write-boundary.test.ts` (3 — each of the 3 writes captures+toasts the error); `eslint` clean on touched files; full-project `tsc --noEmit` clean (exit 0, `--max-old-space-size=6144`)
- Validation evidence: guard extracts each function body and asserts the `const { error } = await` capture + `if (error) toastError(error.message)` guard
- Commit: (this increment)
- Status: Resolved in code and pushed to `main` (A-13 increment by agent-02, reclaimed unit); A-13 client read + write boundary surface now covers modules, vacations views, and trip detail tabs
- Remaining dependencies: live CRUD walkthrough; ≥500-row A-13 seed (A-02)

### PLA-0799 - Marketplace storefront 404'd + offer inbox emptied on a transient read (A-14 §3e slice)

- Timestamp: 2026-07-17 23:39 UTC
- Service: Marketplace (A-14) — creator storefront + negotiations/offer inbox (cross-cutting §3e; A-14 ownership stays `agent-01`)
- Route: `/marketplace/creators/[id]` (`app/(app)/marketplace/creators/[id]/page.tsx`), `/marketplace/negotiations` (`app/(app)/marketplace/negotiations/page.tsx`)
- Affected files: both pages + `tests/marketplace-storefront-negotiations-read-boundary.test.ts` (new)
- Database objects: `marketplace_stores` (primary), `marketplace_negotiations` (primary)
- Role: all marketplace participants
- Scenario: the primary store / negotiations read fails transiently while the row(s) exist
- Severity: P3 (storefront = SEO/discovery 404; offers = money-relevant false-empty)
- Launch impact: (1) the storefront's `store` read dropped `error`, so `if (!store) notFound()` **404'd a real, active creator storefront on a DB blip** (permanent-gone signal). (2) the negotiations inbox's read dropped `error`, so a failed read rendered "No offers going yet" — a user with **live money negotiations** (counter/accept/decline threads) would believe they have none
- Root cause: both primary reads swallowed the Supabase `error`, conflating "genuinely absent" with "read failed"
- Resolution: the storefront now `throw`s on a real `store` read error (retryable 5xx) and reserves `notFound()` for a truly missing store (matches the PLA-0793 marketing-page pattern); the negotiations inbox captures `negError` and early-returns a retryable `<ErrorState>` (keeping the PageHeader) before deriving the offer sections. Enrichment reads (reviews/listings/members) stay degraded
- Supabase impact: none — read error-handling only
- Tests run: new `tests/marketplace-storefront-negotiations-read-boundary.test.ts` (2 — storefront throws before `notFound()`; negotiations ErrorState precedes the "No offers going yet" empty state); `tsc --noEmit` clean; `eslint` clean on both pages
- Validation evidence: guards assert the ordered `throw`/`ErrorState` before the absence branches
- Remaining dependencies: none agent-doable
- Commit: (this increment)
- Status: RESOLVED in code, pushed to `main` (A-14 §3e sub-slice by agent-05; A-14 ownership stays with agent-01)

### PLA-0798 - Marketplace reviews: a failed read made a member's reputation/rating vanish (A-14 §3e slice)

- Timestamp: 2026-07-17 23:35 UTC
- Service: Marketplace / trust (A-14) — reviews/reputation page (cross-cutting §3e; A-14 ownership stays `agent-01`)
- Route: `/marketplace/reviews` (`app/(app)/marketplace/reviews/page.tsx`)
- Affected files: `app/(app)/marketplace/reviews/page.tsx`, `tests/marketplace-reviews-read-boundary.test.ts` (new)
- Database objects: `marketplace_reviews` (primary), `family_members` (name lookup)
- Role: all marketplace participants
- Scenario: the `marketplace_reviews` read fails transiently while reviews exist
- Severity: P3 (reputation display; no money mutation)
- Launch impact: the read destructured only `{ data: reviews }`, so a failed read rendered received/given as `[]` → "Your rating: No reviews received yet", "Received: None yet", "Given: None yet". A member's marketplace reputation (their star rating + review history) appears to vanish on a transient read failure — misleading on a trust surface where reputation gates exchanges
- Root cause: the source-of-truth reviews read dropped its Supabase `error`, conflating "no reviews" with "read failed"
- Resolution: capture `{ data: reviews, error: reviewsError }` and early-return a retryable `<ErrorState>` (keeping the PageHeader) before deriving `received`/`given`/`summary`. The secondary `family_members` name lookup stays degraded (falls back to "Someone")
- Supabase impact: none — read error-handling only
- Tests run: new `tests/marketplace-reviews-read-boundary.test.ts` (2 — captures `reviewsError`; ErrorState early-return precedes the reputation derivation); `tsc --noEmit` clean; `eslint` clean (page uses an aliased read, so it was never in the silent-read ratchet baseline)
- Validation evidence: guards assert the error capture and the ordered ErrorState-before-derivation
- Remaining dependencies: none agent-doable
- Commit: (this increment)
- Status: RESOLVED in code, pushed to `main` (A-14 §3e sub-slice by agent-05; A-14 ownership stays with agent-01)

### PLA-0797 - Focus Mode told a family "Nothing on your plate — enjoy the calm" when the day's read failed (A-05)

- Timestamp: 2026-07-17 23:31 UTC
- Service: Home / dashboard command surfaces (A-05) — Focus Mode
- Route: `/focus` (`components/modules/focus-module.tsx`)
- Affected files: `components/modules/focus-module.tsx`, `tests/focus-mode-read-boundary.test.ts` (new)
- Database objects: `calendar_events`, `chore_assignments`, `todo_items` (reads)
- Role: all family roles
- Scenario: the Promise.all that loads today's events/chores/todos fails transiently while data exists
- Severity: P3 (convenience surface; a reassuring-but-wrong empty)
- Launch impact: the three reads destructured only `{ data }`, so a failed read left `items = []` and rendered the "Nothing on your plate — No events or open tasks for today. Enjoy the calm." state. A family relying on Focus Mode to surface today's must-dos would be told their day is clear when the load actually failed — they could miss a real event or task
- Root cause: the primary reads dropped their Supabase `error`, conflating "clear day" with "load failed"
- Resolution: capture `error` on the primary `events` + `todos` reads; on a real error set a `loadError` flag and render an honest, retryable "Couldn’t load your day — this isn’t an empty day, try again" state (reusing the existing Refresh→`load()`), before the "Nothing on your plate" branch. The `member`/`chores` reads stay secondary/degraded. A genuinely empty day still shows the calm empty state
- Supabase impact: none — read error-handling only
- Tests run: new `tests/focus-mode-read-boundary.test.ts` (2 — captures `evErr`/`tdErr` + early error return; the error branch precedes the empty/finished branch); `tsc --noEmit` clean; `eslint` clean
- Validation evidence: guards assert the error capture on the primary reads and the ordered error-before-empty branching
- Remaining dependencies: none agent-doable
- Commit: (this increment)
- Status: RESOLVED in code, pushed to `main` (A-05 increment by agent-05)

### PLA-0796 - Feedback board comment thread rendered a failed read as an empty discussion (A-17 §3e slice)

- Timestamp: 2026-07-17 23:25 UTC
- Service: Admin / marketing / content (A-17) — public feedback board comment thread (cross-cutting §3e; A-17 ownership stays `agent-04`)
- Route: `/feedback` (`app/(app)/feedback/feedback-board.tsx`, `CommentThread`)
- Affected files: `app/(app)/feedback/feedback-board.tsx`, `tests/feedback-comments-read-boundary.test.ts` (new), `tests/silent-empty-read-ratchet.test.ts` (baseline prune)
- Database objects: `feedback_comments` (read)
- Role: all signed-in users (feedback discussion)
- Scenario: expanding an idea lazy-loads its comments and the `feedback_comments` read fails transiently
- Severity: P3 (discussion surface; no data-write/loss)
- Launch impact: `load()` used `try/finally` (no `catch`) and dropped the read `error`, so a failed read set `comments = data ?? [] = []` and rendered a silent empty discussion. Worse, the `comments === null && !loading` reload guard meant that once it was set to `[]` it **never retried** — the thread was stuck falsely empty until remount
- Root cause: the read dropped its Supabase `error`, and the null-reload guard made the false-empty sticky
- Resolution: capture `{ data, error: readErr }`; on error set a `loadError` flag and `setComments([])` (so the reload guard doesn't loop) and render "Couldn’t load the discussion. Retry" — Retry clears the flag and sets `comments` back to `null` to re-trigger the load. Success path clears `loadError`
- Supabase impact: none — read error-handling only
- Tests run: new `tests/feedback-comments-read-boundary.test.ts` (2 — error captured + not rendered as empty; retry re-nulls comments without an infinite loop); `tsc --noEmit` clean; `eslint` clean; ratchet baseline pruned (`feedback-board` removed)
- Validation evidence: guards assert the `readErr` capture, the `[]`-not-loop behavior, and the retry wiring
- Remaining dependencies: none agent-doable
- Commit: (this increment)
- Status: RESOLVED in code, pushed to `main` (A-17 §3e sub-slice by agent-05; A-17 ownership stays with agent-04)

### PLA-0795 - Family Missions showed a parent "All caught up! 🎉" when the approval queue read failed (A-07 §3e slice)

- Timestamp: 2026-07-17 23:21 UTC
- Service: Chores / missions / rewards (A-07) — Family Missions approval queue (cross-cutting §3e sweep item; A-07 ownership stays `agent-01`)
- Route: `/missions` (`app/(app)/missions/page.tsx`)
- Affected files: `app/(app)/missions/page.tsx`, `tests/missions-review-queue-read-boundary.test.ts` (new)
- Database objects: `chore_submissions` (primary), plus `chores`/`family_members`/`chore_ai_validations`/`chore_disputes` (enrichment)
- Role: parents / managers (the review queue is parent-facing)
- Scenario: the primary `chore_submissions` read fails for a real reason (transient outage, RLS edge) while submissions exist and await review
- Severity: P2 (parent-facing safety-relevant false-empty)
- Launch impact: the primary read destructured only `{ data: submissions }` and rendered `subs = submissions ?? []`, so a failed read collapsed the whole page to the reassuring **"All caught up! 🎉"** empty state (and 0/0/0 stat cards). This queue is a parent's source of truth for pending kid proofs, **disputes**, and **AI safety flags** — a false-empty could hide a safety-flagged submission, so a parent believes there's nothing to review when the read actually failed
- Root cause: the source-of-truth queue read dropped its Supabase `error`, conflating "nothing to review" with "read failed"
- Resolution: capture `{ data: submissions, error: submissionsError }` and early-return a retryable `<ErrorState>` (keeping the page header for context) when the primary read fails, before deriving the queue/empty-state. Enrichment reads (chores/members/validations/disputes) stay gracefully degraded
- Supabase impact: none — reads unchanged; the failure is now visible
- Tests run: new `tests/missions-review-queue-read-boundary.test.ts` (2 — captures `submissionsError`; the ErrorState early-return precedes the "All caught up!" empty-state JSX); `tsc --noEmit` clean; `eslint` clean on the page. (Note: `missions/page.tsx` stays in the silent-read ratchet baseline — it still matches the shape via the benign per-file `createSignedUrl` storage call on line 52, which is not a false-empty)
- Validation evidence: guards assert the error capture and the ordered ErrorState-before-empty-state
- Remaining dependencies: none agent-doable
- Commit: (this increment)
- Status: RESOLVED in code, pushed to `main` (A-07 §3e sub-slice by agent-05; A-07 unit ownership stays with agent-01)

### PLA-0794 - Family Hub's ErrorState was dead code: a failed families read rendered a degraded "Not set" hub (A-05)

- Timestamp: 2026-07-17 23:16 UTC
- Service: Home / dashboard command surfaces (A-05) — Family Hub
- Route: `/family` (`components/modules/family-module.tsx`)
- Affected files: `components/modules/family-module.tsx`, `tests/family-hub-read-boundary.test.ts` (new)
- Database objects: `families` (primary), plus `subscriptions`/`calendar_events`/`family_albums`/counts (secondary)
- Role: all family roles
- Scenario: the primary `families` read fails for a real reason (transient outage, RLS/permission edge) while the family exists
- Severity: P2 (primary-content silent failure — the family appears nameless/addressless; the built-in error UI never fires)
- Launch impact: `load()` wrapped its reads in `try/catch` and rendered `<ErrorState onRetry>` only on a caught throw — but **Supabase query errors don't throw**, they resolve as `{ data: null, error }`. So a failed `families` read fell straight through to `setFamily(fam.data ?? null)` → `family = null`, and the hub rendered a reassuring-but-wrong "Your Family / Address: Not set / code —" instead of an error. The `ErrorState` + retry was effectively **dead code for the most common failure mode**. (No data-loss: the edit modal is correctly gated on `editOpen && family`, so an errored read can't present a blank editable form — verified + regression-locked)
- Root cause: the error-handling assumed Supabase reads throw; query errors bypass `catch`, and the primary read's `error` field was never inspected
- Resolution: after the `Promise.all`, check `fam.error` (the primary read) and `setLoadError(...)` + `return`, so the existing retryable `ErrorState` fires on a genuine failure. Secondary reads (subscription, counts, albums) stay gracefully degraded. A genuinely absent family row (null data, no error) still renders the normal empty/degraded hub
- Supabase impact: none — reads unchanged; the dormant error path now actually triggers
- Tests run: new `tests/family-hub-read-boundary.test.ts` (3 — the `fam.error` gate precedes the `setFamily` fallthrough; the `ErrorState` retry path exists; the edit modal stays gated on a non-null family); `tsc --noEmit` clean; `eslint` clean on the module
- Validation evidence: guards assert the ordered `if (fam.error)` before `setFamily`, the ErrorState wiring, and the `editOpen && family &&` blank-overwrite lock
- Remaining dependencies: none agent-doable
- Commit: (this increment)
- Status: RESOLVED in code, pushed to `main` (A-05 increment by agent-05)

### PLA-0793 - Public marketing landing page + form 404'd on a transient read error (A-17 §3e slice)

- Timestamp: 2026-07-17 23:11 UTC
- Service: Admin / marketing / content (A-17) — public marketing landing pages + forms (cross-cutting §3e sweep item; authz for A-17 remains `agent-04`'s)
- Route: `/lp/[slug]` (`app/(marketing)/lp/[slug]/page.tsx`), `/f/[id]` (`app/(marketing)/f/[id]/page.tsx`)
- Affected files: `app/(marketing)/lp/[slug]/page.tsx`, `app/(marketing)/f/[id]/page.tsx`, `tests/marketing-public-read-boundary.test.ts` (new), `tests/silent-empty-read-ratchet.test.ts` (baseline prune)
- Database objects: `marketing_landing_pages`, `marketing_forms` (service-role reads — no client RLS on public marketing content)
- Role: anonymous public visitors (+ crawlers)
- Scenario: the service-role read for a published landing page / active form fails transiently (outage, pool exhaustion) while the row genuinely exists
- Severity: P2 (SEO + conversion — a permanent-gone 404 for a real, live page)
- Launch impact: both loaders (`getPage` / `getForm`) destructured only `{ data }` and returned `null` on failure, and the pages do `if (!page) notFound()` — so a **transient DB error rendered a 404** for a real, published landing page or active form. A 404 is a permanent-gone signal: search engines de-index the page and paid-traffic visitors hit a dead end, all from a momentary read blip. `notFound()` should mean "this row does not exist", never "the read failed"
- Root cause: the loaders swallowed the Supabase `error`, collapsing "genuinely missing" and "read failed" into the same `null`, which the caller maps to `notFound()` (404)
- Resolution: both loaders now capture `{ data, error }` and `throw` on a real error (Next renders a retryable 5xx via the error boundary — no de-index), reserving `notFound()` for a truly missing/unpublished row. `generateMetadata` shares the same loader, so its transient-error path is corrected too
- Supabase impact: none — reads unchanged; error now distinguished from absence
- Tests run: new `tests/marketing-public-read-boundary.test.ts` (2 — each loader captures error + throws before the null-return, notFound reserved for a missing row); `tsc --noEmit` clean; `eslint` clean on both files; ratchet baseline pruned (both marketing files removed)
- Validation evidence: guards assert the `if (error) throw` precedes `return data;` and that `notFound()` remains for the genuinely-missing case
- Remaining dependencies: none agent-doable. Note: `app/(app)/feedback/feedback-board.tsx` (comment lazy-load) is left in the ratchet baseline — its `comments === null` reload guard makes a naive keep-prior an infinite-reload risk; deferred as a low-value cosmetic item
- Commit: (this increment)
- Status: RESOLVED in code, pushed to `main` (A-17 §3e sub-slice by agent-05; A-17 unit ownership/authz stays with agent-04)

### PLA-0792 - Weather + AI Assistant modules clobbered visible state to empty on a failed read (A-05)

- Timestamp: 2026-07-17 23:06 UTC
- Service: Home / dashboard command surfaces (A-05) — Weather module + AI Assistant module
- Route: `/dashboard/weather` (`components/modules/weather-module.tsx`), AI Assistant surface (`components/modules/assistant-module.tsx`)
- Affected files: `components/modules/weather-module.tsx`, `components/modules/assistant-module.tsx`, `tests/dashboard-modules-keep-prior-read.test.ts` (new), `tests/silent-empty-read-ratchet.test.ts` (baseline prune)
- Database objects: `weather_locations` (read), `ai_conversations` (read), `ai_messages` (read)
- Role: all family roles
- Scenario: a client read fails transiently while the tables exist and have data
- Severity: P3 (convenience surfaces, no data-write/loss — a false-empty flash only)
- Launch impact: three reads dropped `error` and overwrote visible state with empty on failure — `weather.loadSaved` set `saved = data ?? []` (the family's saved cities vanish on a transient refresh error), `assistant.loadConversations` set `conversations = data ?? []` (the AI history sidebar empties), and `assistant.loadConversation` treated a failed `ai_messages` read the same as an empty conversation and rendered a fresh **greeting**, hiding the thread's real history
- Root cause: the reads dropped their Supabase `error` and clobbered state to empty, conflating "load failed" with "no data"
- Resolution: each read now captures `error` and keeps prior state on failure — `loadSaved` returns `[]` without calling `setSaved` (visible cities preserved); `loadConversations` returns early (sidebar preserved); `loadConversation` bails before `setConvId`/greeting so a failed read leaves the current thread intact and retryable instead of showing a misleading blank conversation. Matches the §3e keep-prior guidance for non-primary convenience reads
- Supabase impact: none — read error-handling only
- Tests run: new `tests/dashboard-modules-keep-prior-read.test.ts` (3 — each guard asserts the `error` capture precedes the state-clobber); `tsc --noEmit` clean; `eslint` clean on both modules; ratchet baseline pruned (`weather-module` + `assistant-module` removed)
- Validation evidence: guards assert the ordered `if (error) return` before each `setState` clobber
- Remaining dependencies: none agent-doable. **A-05 §3e false-empty client-read slice is now fully closed** (journeys, onboarding-funnel, settings-module, weather-module, assistant-module all handled; `independence`/`paperwork`/`money-timeline` are intentional migration-gated degradations; `app-context` is the benign keep-prior pattern)
- Commit: (this increment)
- Status: RESOLVED in code, pushed to `main` (A-05 increment by agent-05)

### PLA-0791 - Settings profile: a failed profile read let a Save silently wipe the user's phone + avatar (A-05)

- Timestamp: 2026-07-17 23:01 UTC
- Service: Home / dashboard command surfaces (A-05) — Settings › Your profile
- Route: `/settings` (`components/modules/settings-module.tsx`)
- Affected files: `components/modules/settings-module.tsx`, `tests/settings-profile-read-boundary.test.ts` (new), `tests/silent-empty-read-ratchet.test.ts` (baseline prune)
- Database objects: `profiles` (read `full_name, phone, avatar_url`; write via `updateMyProfileAction` → `saveUserProfile`)
- Role: every signed-in user (their own profile)
- Scenario: the one-time `profiles` prefill read fails for a real reason (transient outage, RLS/permission edge) while the row exists, then the user edits their name and clicks Save
- Severity: **P2 (silent read failure → destructive write / real data loss)**
- Launch impact: the prefill read destructured only `{ data }` and, on failure, fell back to `phone: ''` / `avatarUrl: ''` while still calling `setProfileLoaded(true)` — presenting a blank-but-editable form. `saveUserProfile` writes `phone: normalizePhone(input.phone)` **unconditionally** and `avatar_url` whenever provided, so a Save after a transient read failure **silently overwrote the user's real phone number with empty and nulled their avatar**. The dropped read error turned into permanent data loss on the next save
- Root cause: the profile prefill read dropped its Supabase `error` and marked the form loaded/editable regardless, so blanks were presented as the user's saved values
- Resolution: capture `{ data, error }`; on `error` set `profileError`, keep `profileLoaded=false` (inputs + Save already gate on it, so no blank overwrite), and render a retryable `role="alert"` banner ("Editing is disabled so your saved phone and photo aren’t overwritten with blanks" + Try again → bumps a `profileReloadKey` that re-runs the effect). Added a defense-in-depth `if (!profileLoaded) return;` guard at the top of `saveProfile`. A genuinely missing/empty profile still loads normally with the `selfMember` name fallback
- Supabase impact: none — read error-handling only; no schema/migration/write-path change (the unconditional write is now safe because the form can no longer present blanks as truth)
- Tests run: new `tests/settings-profile-read-boundary.test.ts` (5 — error captured; load bails before `setProfileLoaded(true)` + flags error; save guards on `profileLoaded`; retryable alert; documents the unconditional-phone-write that makes the guard load-bearing); `tsc --noEmit` clean; `eslint` clean on the module; ratchet baseline pruned (`settings-module` removed)
- Validation evidence: guards assert the `error` capture, the ordered error-bail-before-loaded, the save guard, and the retry wiring
- Remaining dependencies: none agent-doable
- Commit: (this increment)
- Status: RESOLVED in code, pushed to `main` (A-05 increment by agent-05)

### PLA-0790 - Super-admin analytics surfaces rendered a failed telemetry read as "no activity" (A-05)

- Timestamp: 2026-07-17 22:56 UTC
- Service: Home / dashboard command surfaces (A-05) — super-admin product analytics
- Route: `/dashboard/journeys` (Journey Analytics), `/dashboard/onboarding-funnel` (Onboarding Funnel + Time-to-First-Value)
- Affected files: `app/(app)/dashboard/journeys/page.tsx`, `app/(app)/dashboard/onboarding-funnel/page.tsx`, `components/family/shell.tsx` (new `MiniError`), `tests/dashboard-analytics-read-boundary.test.ts` (new)
- Role: super-admin only (both pages `notFound()` for non-admins)
- Scenario: a telemetry read (`journey_events`, `onboarding_events`, or `activation_events`) fails for a real reason (transient outage, RLS/permission edge) while the table exists and has data
- Severity: P3 (internal analytics integrity — misleads product decisions, no user-data exposure)
- Launch impact: both SSR pages destructured only `{ data }` and rendered `data ?? []`, so a failed read collapsed to a "No journey events yet" / "No onboarding activity yet" / "No activation events yet" empty state. An operator reading these dashboards (which explicitly call out the "biggest drop step" and "highest-leverage step to simplify") would conclude onboarding traffic is zero when the query actually errored — a silent false-empty on the numbers product changes are steered by
- Root cause: the source-of-truth telemetry reads dropped their Supabase `error`; the empty-vs-error states were conflated into one `MiniEmpty`
- Resolution: added a server-safe `MiniError` primitive to `components/family/shell.tsx` (role="alert" danger card, no client handler — SSR retries by page reload), distinct from `MiniEmpty`. `journeys` now captures `{ data, error }` and renders `MiniError` before the empty-rows branch; `onboarding-funnel` captures `error: funnelError` + `error: actError` and gates each section (funnel, TTFV) on its own error before the respective empty branch. A genuinely empty dataset still shows the honest `MiniEmpty`
- Supabase impact: none — reads unchanged; genuine failures now surface instead of masquerading as no-data
- Tests run: new `tests/dashboard-analytics-read-boundary.test.ts` (3 — MiniError is server-safe + role=alert; journeys error branch precedes empty branch; onboarding-funnel gates both funnel + activation reads); `eslint` clean on all 4 touched files; `tsc --noEmit` clean (exit 0)
- Validation evidence: guard asserts the `error` destructures and the ordered error→empty branching in both pages, plus that `MiniError` carries no `onClick` (server-component safe)
- Remaining dependencies: none agent-doable; the try/catch degrade-safe A-05 pages (`independence`, `paperwork`, `money-timeline`) intentionally swallow reads on tables behind un-applied migrations 0175/0169/0168 and are left as-is (documented decision, not a defect)
- Commit: (this increment)
- Status: RESOLVED in code, pushed to `main` (A-05 increment by agent-05)

### PLA-0784 - Vacations list + calendar rendered a failed read as "No trips yet" / an empty month (A-13)

- Timestamp: 2026-07-17 20:20 UTC
- Service: Vacations / travel / concierge (A-13) — Vacations list + calendar
- Route: `/dashboard/vacations` (`components/vacations/vacations-list.tsx`), `/dashboard/vacations/calendar` (`components/vacations/vacations-calendar.tsx`)
- Affected files: `components/vacations/vacations-list.tsx`, `components/vacations/vacations-calendar.tsx`, `tests/vacations-views-read-boundary.test.ts` (new)
- Role: all family roles with the Vacations feature
- Scenario: the `vacations` read (each view's primary source-of-truth) fails for a real reason (RLS denial, transient outage) while online and the table exists
- Severity: P2 (silent read failure / misleading empty state on primary content)
- Launch impact: both components read `vacations` via `useRealtimeQuery` but **destructured only `{ data }`, dropping the hook's `error`**. On a genuine failure the list rendered the reassuring-but-wrong **"No trips yet"** empty state (a family's planned trips appear deleted) and the calendar rendered an **empty month** — and its **`.ics` export silently produced an empty calendar file**. Unlike an aggregate/enhancement read, `vacations` is the primary content of both views, so it must fail visibly
- Root cause: `const { data: trips, loading } = useRealtimeQuery(...)` (list) and `const { data: trips } = useRealtimeQuery(...)` (calendar) dropped `error`/`refresh`
- Resolution: both now capture `error, refresh`; the list renders `<ErrorState onRetry={refresh}>` **before** the "No trips yet" empty-state branch, and the calendar early-returns a retryable `ErrorState` (preserving the page heading) instead of an empty grid/export. The hook still degrades missing-table/offline to a quiet empty list. Secondary list reads (`vacation_members`, `vacation_travel_scores`) remain enhancement data and stay degraded
- Supabase impact: none — reads unchanged; genuine failures now visible + retryable
- Tests run: `tests/vacations-views-read-boundary.test.ts` (4 — both views destructure error+refresh; list ErrorState precedes the empty state; calendar gates on error); `eslint` clean on touched files; full-project `tsc --noEmit` clean (exit 0, `--max-old-space-size=6144`)
- Validation evidence: guard asserts the `error, refresh` destructures and the ordered ErrorState/empty-state gate in the list plus the `if (error)` gate in the calendar
- Commit: (this increment)
- Status: Resolved in code and pushed to `main` (A-13 increment by agent-02, reclaimed unit); A-13 client read-boundary surface now covers modules + vacations views
- Remaining dependencies: live CRUD walkthrough; ≥500-row A-13 seed (A-02)

### PLA-0782 - Family Economy showed every child a 0 coin balance when a ledger read failed

- Timestamp: 2026-07-17 21:09 UTC
- Service: Family Economy / kids currency (agent-`fable-opus` lane)
- Route: `/economy`
- Affected files: `app/(app)/economy/page.tsx`, `tests/economy-read-boundary.test.ts`
- Database objects: `family_currencies`, `family_members`, `currency_transactions` (ledger), `economy_rewards`, `economy_redemptions`
- Role: parents (manage) + children (view their own balances/rewards)
- Scenario: any of the five economy reads fails (RLS edge, transient, connection) while the tables exist.
- Severity: **P1** (kids-money surface — a reassuring-but-wrong 0 balance where a child's earned coins appear to vanish, or a parent thinks a child can't afford a reward).
- Launch impact: the five-way `Promise.all` destructured `{ data }` and dropped every `error`. Each child's balance is derived from the immutable `currency_transactions` ledger; a dropped `txns` error left the ledger empty, so `balanceFrom([])` computed **every child's balance as 0** — plus an empty currency/rewards/redemptions economy. A child would see their earned coins gone; a parent would misjudge affordability.
- Root cause: the five source-of-truth economy reads dropped their `error`.
- Resolution: capture `currenciesRes`/`membersRes`/`txnsRes`/`rewardsRes`/`redemptionsRes`, collect `[…].find((e) => e && !isMissingTableError(e))`, and on a real error `console.error('[economy] family economy read failed', …)` + `return <ErrorState message="Could not load your family economy from Supabase. Refresh and try again." />` before deriving balances. A genuinely missing table (unapplied migration) is still tolerated as empty. Matches the Command-Center/CFO fail-closed pattern.
- Supabase impact: none (read error-handling only; no schema/migration change).
- Tests run: new `tests/economy-read-boundary.test.ts` (3 assertions — five-error collection with missing-table filter, log+ErrorState, ledger derived only after the guard); full `npx vitest run` **578 files / 3583 tests green**; `tsc --noEmit` clean (only the known optional `@axe-core/playwright` e2e noise); eslint clean on changed files.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`.
- Remaining dependencies: none agent-doable for this page; the P0/P1 live blockers (LB-001..015) remain owner/live-infra.

### PLA-0783 - Trips module rendered a failed checklist read as an empty 0%-progress checklist (A-13)

- Timestamp: 2026-07-17 19:55 UTC
- Service: Vacations / travel / concierge (A-13) — Trips module
- Route: `/dashboard/trips` (`components/modules/trips-module.tsx`)
- Affected files: `components/modules/trips-module.tsx`, `tests/trips-module-read-boundary.test.ts` (new)
- Role: all family roles with the Trips feature
- Scenario: the `trips` list loads but the `trip_items` read (the per-trip packing/todo checklist) fails for a real reason (RLS denial, transient outage) while online and the table exists
- Severity: P2 (silent read failure / misleading empty state)
- Launch impact: the module ran two `useRealtimeQuery` reads — `trips` (gated with an `ErrorState`) and `trip_items`. The **items read discarded its `error`**, so a genuine failure rendered the trip detail view as an empty checklist showing **0% progress / no items** with no error banner and no retry — the user believes their packing/todo list was wiped, when it was only a failed read. `trip_items` is core per-trip content (drives `selectedItems`, `checklistProgress`, `progressByKind`), not an enhancement aggregate, so it must fail visibly
- Root cause: `const { data: items } = useRealtimeQuery<TripItem>(...)` dropped the hook's `error`/`refresh`; only the `trips` read was gated
- Resolution: capture `error: itemsError, refresh: refreshItems` from the items read (and `refresh: refreshTrips` from trips), then gate the whole view on `const loadError = error || itemsError` with a retryable `ErrorState` (`onRetry` re-runs both). Matches the sibling `trip-memories-module` combined-refresh pattern. Writes were already error-checked via `describeDbError`; the hook still degrades missing-table/offline to a quiet empty list
- Supabase impact: none — reads unchanged; genuine failures now visible + retryable
- Tests run: `tests/trips-module-read-boundary.test.ts` (2 — both reads destructure error+refresh; view gates on `error || itemsError` with a two-read retry); `eslint` clean on touched files; full-project `tsc --noEmit` clean (exit 0, run with `--max-old-space-size=6144` — the default-heap run was OOM-killed under concurrent-agent load in this env, not a type error)
- Validation evidence: guard asserts the two destructures and the `loadError`/`onRetry` gate exist; the fix mirrors the already-compiling `trip-memories` combined-refresh idiom
- Commit: (this increment)
- Status: Resolved in code and pushed to `main` (A-13 increment by agent-02, reclaimed from STALE agent-04); A-13 unit remains In-progress (concierge/trip-intel client sweep + live CRUD/seed still open)
- Remaining dependencies: finish the concierge-calls / trip-intel client read paths; live CRUD walkthrough; ≥500-row A-13 seed (A-02)

### PLA-0781 - Grandparent Portal rendered an empty portal when the member roster read failed

- Timestamp: 2026-07-17 20:40 UTC
- Service: Dashboard / Grandparent Portal (agent-`fable-opus` lane)
- Route: `/dashboard/grandparent-portal`
- Affected files: `app/(app)/dashboard/grandparent-portal/page.tsx`, `tests/grandparent-portal-read-boundary.test.ts`
- Database objects: `family_members` (roster spine); `families`, `family_photos`, `family_milestones`, `family_announcements`, `family_dates` (best-effort)
- Role: grandparents / extended family viewing the simplified portal
- Scenario: the `family_members` roster read fails (RLS edge, transient, connection) while the table exists.
- Severity: **P2** (reassuring-but-wrong empty state — a grandparent sees an empty portal; the family grid, author-name resolution, and birthday celebrations all collapse).
- Launch impact: the six-way `Promise.all` destructured `{ data: members }` and dropped the roster's `error`. The roster is the spine — the family grid, milestone/announcement author names (`memberById`), and birthday-derived celebrations all build off it. A silent failure rendered an empty portal for a grandparent.
- Root cause: the source-of-truth roster read dropped its `error`.
- Resolution: capture `membersRes`, and on `membersRes.error` `console.error('[dashboard/grandparent-portal] member roster read failed', …)` + `return <ErrorState message="Could not load your family portal from Supabase. Refresh and try again." />` before deriving `members`. The family name and photo/milestone/announcement/date enrichment reads stay best-effort (each degrades to a hidden section). Matches the Family-Digital-Twin roster-spine pattern.
- Supabase impact: none (read error-handling only; no schema/migration change).
- Tests run: new `tests/grandparent-portal-read-boundary.test.ts` (3 assertions — roster result captured, log+ErrorState, derive-after-guard ordering); full `npx vitest run` **577 files / 3580 tests green**; `tsc --noEmit` clean (only the known optional `@axe-core/playwright` e2e noise); eslint clean on changed files.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`.
- Remaining dependencies: none agent-doable for this page; the P0/P1 live blockers (LB-001..015) remain owner/live-infra.

### PLA-0780 - Null display_name white-screen crash class lurking in ~20 UI sites (same root as the Kitchen Display loop)

- Timestamp: 2026-07-17 20:29 UTC
- Service: Cross-cutting (home, kids, Family COO, and the school/sports/messages/documents/locator/passwords/family modules)
- Route: `/home`, `/kids`, `/dashboard/family-coo`, and any page rendering the affected client modules
- Affected files: `lib/utils/format.ts` (new `firstName` helper), `app/(app)/kids/page.tsx`, `app/(app)/home/page.tsx`, `app/(app)/dashboard/family-coo/page.tsx`, `components/dashboard/family-dashboard.tsx`, `components/modules/family-module.tsx`, `components/modules/school-module.tsx`, `components/modules/sports-module.tsx`, `components/modules/messages-module.tsx`, `components/modules/documents-module.tsx`, `components/modules/locator-module.tsx`, `components/modules/passwords-module.tsx`, `tests/display-name-firstname.test.ts`
- Database objects: `family_members.display_name` (nullable `text` per `0002_tables.sql:14`; `0212_atomic_family_provisioning.sql` provisions with `p_display_name default null`)
- Role: any family with at least one member whose `display_name` is null
- Scenario: a member row has a null `display_name` (allowed by the schema and by atomic provisioning), then a page renders a `member.display_name.split(' ')[0]` first-name label.
- Severity: **P1** (a single null-name member white-screens core SSR pages — exactly the crash class that root-caused the `/display` "Reconnecting…" loop in `e92fd897`, but still present app-wide).
- Launch impact: `family_members.display_name` is nullable in the DB but typed `string`, so 23 raw `.display_name.split(' ')[0]` sites assumed non-null. In server components (`/home`, `/kids`, `/dashboard/family-coo`, `family-dashboard`) a null name throws `TypeError: Cannot read properties of null (reading 'split')` during SSR render → white screen (the error boundary can't catch an SSR throw, so it retries forever). In client modules it throws during client render. The display fix (`e92fd897`) patched only `display-grid.tsx`; the same latent bug remained in ~20 other UI sites.
- Root cause: nullable column typed as non-null + a raw `.split()` at every first-name label site; no shared null-safe helper.
- Resolution: added a null-safe `firstName(name: string | null | undefined)` to `lib/utils/format.ts` (mirrors the existing `initials()` and the display-grid helper: `(name ?? '').trim().split(/\s+/)[0] || 'Member'`), and routed all 21 UI `.tsx` sites through it. The two API `.ts` routes already guard with `if (m?.display_name)` and are left as-is.
- Supabase impact: none (render-safety only; no schema change). Note the schema still permits null `display_name` — a future migration could add a default/backfill, tracked separately.
- Tests run: new `tests/display-name-firstname.test.ts` (5 assertions — `firstName` null/blank/normal behavior + a source guard that greps `app/`+`components/` `.tsx` for the raw `display_name.split` anti-pattern and asserts zero); full `npx vitest run` **576 files / 3577 tests green**; `tsc --noEmit` clean (only the known optional `@axe-core/playwright` e2e noise); eslint clean on changed files (pre-existing exhaustive-deps warnings unrelated).
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`.
- Remaining dependencies: optional migration to backfill/default `display_name` NOT NULL (defense in depth); the P0/P1 live blockers (LB-001..015) remain owner/live-infra.

### PLA-0779 - Trust & Permissions rendered every security control as "none" when a read failed

- Timestamp: 2026-07-17 20:21 UTC
- Service: Dashboard / Trust & Permissions (agent-`fable-opus` lane)
- Route: `/dashboard/trust`
- Affected files: `app/(app)/dashboard/trust/page.tsx`, `tests/trust-read-boundary.test.ts`
- Database objects: `family_members`, `trust_policies`, `permission_grants`, `trust_delegations`, `approval_requests`, `emergency_sessions` (security state); `trust_audit_logs` (log view, best-effort)
- Role: authenticated family members; management gated to managers via `canManage`
- Scenario: any of the six security-state reads fails (RLS edge, transient, connection) while the tables exist.
- Severity: **P1** (security-state surface — a reassuring-but-wrong "none" can make a child look unrestricted, drop a pending approval, or hide an active emergency-access session).
- Launch impact: the seven-way `Promise.all` destructured `{ data }` and dropped every `error`. A silent failure rendered **no trust policies, no permission grants, no active delegations, no pending approvals, and no active emergency sessions** — a security picture where a restricted child appears unrestricted, a pending approval request vanishes, and an elevated emergency-access session is invisible to the family managing it.
- Root cause: the six source-of-truth security reads dropped their `error`.
- Resolution: capture `membersRes`/`policiesRes`/`grantsRes`/`delegationsRes`/`approvalsRes`/`emergenciesRes`, collect `[…].find((e) => e && !isMissingTableError(e))`, and on a real error `console.error('[dashboard/trust] trust read failed', …)` + `return <ErrorState message="Could not load your family trust & permissions from Supabase. Refresh and try again." />` before building `TrustData`. The `trust_audit_logs` display stays best-effort (a historical log view, consistent with audit-log leniency elsewhere). Missing table still tolerated as empty. Matches the established fail-closed pattern.
- Supabase impact: none (read error-handling only; no schema/migration change).
- Tests run: new `tests/trust-read-boundary.test.ts` (4 assertions — six-error collection with missing-table filter, log+ErrorState, audit-log stays best-effort, derive-after-guard ordering); full `npx vitest run` **575 files / 3574 tests green**; `tsc --noEmit` clean (only the known optional `@axe-core/playwright` e2e noise); eslint clean on changed files.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`.
- Remaining dependencies: none agent-doable for this page; the P0/P1 live blockers (LB-001..015) remain owner/live-infra.

### PLA-0778 - Family Emergency Hub showed "No emergency contacts on file" when a crisis read failed

- Timestamp: 2026-07-17 20:17 UTC
- Service: Dashboard / Family Emergency Hub (agent-`fable-opus` lane)
- Route: `/dashboard/family-emergency`
- Affected files: `app/(app)/dashboard/family-emergency/page.tsx`, `tests/family-emergency-read-boundary.test.ts`
- Database objects: `family_members`, `family_emergency_contacts`, `family_emergency_plans`, `medical_profiles` (manager-gated)
- Role: authenticated family members; medical summary + add/delete gated to managers
- Scenario: any of the four reads fails (RLS edge, transient, connection) while the tables exist.
- Severity: **P1** (crisis surface — a reassuring-but-wrong empty state can leave a caregiver with no emergency contact or hide blood type/allergies/ICE from a first responder).
- Launch impact: the four-way `Promise.all` destructured `{ data }` and dropped every `error`. The page is billed as "everything a caregiver needs in a crisis," yet a silent failure rendered **"No emergency contacts on file"** (a caregiver mid-crisis can't reach the parent), **"No emergency plans yet"**, and **"No medical profiles recorded"** (hiding blood type, allergies, and the ICE contact from a first responder) — confidently-wrong empty states at the worst possible moment.
- Root cause: the four source-of-truth reads dropped their `error`. (The manager-gated `medical_profiles` branch also returned `Promise.resolve({ data: [] })` with no `error` field.)
- Resolution: capture `membersRes`/`contactsRes`/`plansRes`/`profilesRes`; make the non-manager `medical_profiles` branch error-shaped (`{ data: [], error: null }`); collect `[…].find((e) => e && !isMissingTableError(e))`, and on a real error `console.error('[dashboard/family-emergency] emergency read failed', …)` + `return <ErrorState message="Could not load your family emergency hub from Supabase. Refresh and try again." />` before rendering. Missing table still tolerated as empty. Matches the established fail-closed pattern.
- Supabase impact: none (read error-handling only; no schema/migration change).
- Tests run: new `tests/family-emergency-read-boundary.test.ts` (4 assertions — four-error collection with missing-table filter, log+ErrorState, error-shaped non-manager branch, derive-after-guard ordering); full `npx vitest run` **574 files / 3570 tests green**; `tsc --noEmit` clean (only the known optional `@axe-core/playwright` e2e noise); eslint clean on changed files.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`.
- Remaining dependencies: none agent-doable for this page; the P0/P1 live blockers (LB-001..015) remain owner/live-infra.

### PLA-0777 - Family Health showed "No allergies or conditions recorded" when a medical read failed

- Timestamp: 2026-07-17 20:13 UTC
- Service: Dashboard / Family Health Coordinator (agent-`fable-opus` lane)
- Route: `/dashboard/family-health`
- Affected files: `app/(app)/dashboard/family-health/page.tsx`, `tests/family-health-read-boundary.test.ts`
- Database objects: `family_members`, `appointments`, `medications`, `medical_profiles` (manager-gated), `health_providers`
- Role: authenticated family members; the allergy/condition watch is manager-only
- Scenario: any of the five health reads fails (RLS edge, transient, connection) while the tables exist.
- Severity: **P1** (safety-critical medical summary — a reassuring-but-wrong empty state can hide a life-threatening allergy or an active medication from a caregiver).
- Launch impact: the five-way `Promise.all` destructured `{ data }` and dropped every `error`. A silent failure rendered **"No allergies or conditions recorded"** (when a child has a documented life-threatening allergy), **"No active medications"**, and **"No upcoming appointments"** — a confidently-wrong medical summary a caregiver could rely on at exactly the wrong moment.
- Root cause: the five source-of-truth health reads dropped their `error`. (The manager-gated `medical_profiles` branch also returned `Promise.resolve({ data: [] })` with no `error` field, so the guard's error access had to be made well-defined.)
- Resolution: capture `membersRes`/`apptsRes`/`medsRes`/`profilesRes`/`providersRes`; make the non-manager `medical_profiles` branch error-shaped (`{ data: [], error: null }`); collect `[…].find((e) => e && !isMissingTableError(e))`, and on a real error `console.error('[dashboard/family-health] health read failed', …)` + `return <ErrorState message="Could not load your family health summary from Supabase. Refresh and try again." />` before rendering any summary. Missing table still tolerated as empty. Matches the Command-Center/Readiness/Kitchen/Twin/Memories/CFO fail-closed pattern.
- Supabase impact: none (read error-handling only; no schema/migration change).
- Tests run: new `tests/family-health-read-boundary.test.ts` (4 assertions — five-error collection with missing-table filter, log+ErrorState, error-shaped non-manager branch, derive-after-guard ordering); full `npx vitest run` **573 files / 3566 tests green**; `tsc --noEmit` clean (only the known optional `@axe-core/playwright` e2e noise); eslint clean on changed files.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`.
- Remaining dependencies: none agent-doable for this page; the P0/P1 live blockers (LB-001..015) remain owner/live-infra.

### PLA-0776 - Family CFO rendered a reassuring-but-wrong $0 financial picture when a money read failed

- Timestamp: 2026-07-17 20:09 UTC
- Service: Dashboard / Family CFO (agent-`fable-opus` lane)
- Route: `/dashboard/family-cfo`
- Affected files: `app/(app)/dashboard/family-cfo/page.tsx`, `tests/family-cfo-read-boundary.test.ts`
- Database objects: `financial_accounts`, `bills`, `savings_goals`, `transactions`, `budgets`
- Role: authenticated family members (manager/finance view) using the Family CFO
- Scenario: any of the five financial reads fails (RLS edge, transient, connection) while the tables exist.
- Severity: **P1** (money surface — a reassuring-but-wrong financial status can cause a missed bill payment).
- Launch impact: the five-way `Promise.all` destructured `{ data }` and dropped every `error`. The page header literally promises "**every figure is live**," yet a silent failure rendered **Net position $0, "Due in 30 days $0", $0 spent this month, and no savings goals / no upcoming bills** — a confidently-wrong financial picture a family could act on (assume nothing is due and miss a payment, or think savings/accounts vanished).
- Root cause: the five source-of-truth financial reads dropped their `error`.
- Resolution: capture `accountsRes`/`billsRes`/`goalsRes`/`spendRes`/`budgetsRes`, collect `[…].find((e) => e && !isMissingTableError(e))`, and on a real error `console.error('[dashboard/family-cfo] finance read failed', …)` + `return <ErrorState message="Could not load your family finances from Supabase. Refresh and try again." />` before computing any figure. A genuinely missing table (unapplied migration) is still tolerated as empty so a partial env degrades. Matches the Command-Center/Readiness/Kitchen/Twin/Memories fail-closed pattern.
- Supabase impact: none (read error-handling only; no schema/migration change).
- Tests run: new `tests/family-cfo-read-boundary.test.ts` (3 assertions — five-error collection with missing-table filter, log+ErrorState, derive-after-guard ordering); full `npx vitest run` **572 files / 3562 tests green**; `tsc --noEmit` clean (only the known optional `@axe-core/playwright` e2e noise); eslint clean on changed files.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`.
- Remaining dependencies: none agent-doable for this page; the P0/P1 live blockers (LB-001..015) remain owner/live-infra.

### PLA-0775 - Memories showed an empty "memory lane" when the album/photo reads failed

- Timestamp: 2026-07-17 20:05 UTC
- Service: Dashboard / Memories (agent-`fable-opus` lane)
- Route: `/dashboard/memories`
- Affected files: `app/(app)/dashboard/memories/page.tsx`, `tests/memories-read-boundary.test.ts`
- Database objects: `family_albums`, `family_photos` (content spine); `family_members`, `calendar_events`, and the `family_photos`/`family_albums`/`family_memories` count queries (best-effort)
- Role: authenticated family members using Memories
- Scenario: the `family_albums` or `family_photos` read fails (RLS edge, transient, connection) while the tables exist.
- Severity: **P2** (reassuring-but-wrong empty state — a family with hundreds of photos sees an empty memory lane; core content surface but not a money/safety decision).
- Launch impact: the eight-way `Promise.all` destructured `{ data: albumsRaw }` / `{ data: photosRaw }` and dropped their `error`. Albums + photos are the content spine — highlights, timeline, photo/video/album tabs, and "on this day" all derive from them. A silent failure rendered **"Your family memory lane is empty — add a favorite photo…"** for a populated family, a confidently-wrong empty state that also invites duplicate re-uploads.
- Root cause: the two source-of-truth content reads dropped their `error`.
- Resolution: capture `albumsRes` / `photosRes`, collect `[albumsRes.error, photosRes.error].find((e) => e && !isMissingTableError(e))`, and on a real error `console.error('[dashboard/memories] memories read failed', …)` + `return <ErrorState message="Could not load your memories from Supabase. Refresh and try again." />` before deriving `albums`/`photos`. A genuinely missing table (unapplied migration) is still tolerated as empty; the stat counts and members/upcoming enrichment reads stay best-effort. Matches the Command-Center/Readiness/Kitchen/Twin fail-closed pattern.
- Supabase impact: none (read error-handling only; no schema/migration change).
- Tests run: new `tests/memories-read-boundary.test.ts` (3 assertions — album+photo result capture with missing-table filter, log+ErrorState, derive-after-guard ordering); full `npx vitest run` **571 files / 3559 tests green**; `tsc --noEmit` clean (only the known optional `@axe-core/playwright` e2e noise); eslint clean on changed files.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`.
- Remaining dependencies: none agent-doable for this page; the P0/P1 live blockers (LB-001..015) remain owner/live-infra.

### PLA-0774 - Family Digital Twin collapsed to "No family members yet" when the roster read failed

- Timestamp: 2026-07-17 20:02 UTC
- Service: Dashboard / Family Digital Twin (agent-`fable-opus` lane)
- Route: `/dashboard/family-digital-twin`
- Affected files: `app/(app)/dashboard/family-digital-twin/page.tsx`, `tests/family-digital-twin-read-boundary.test.ts`
- Database objects: `family_members` (source-of-truth spine); `family_digital_twin_profiles`, `family_routines`, `school_classes`, `teams`, `goals`, `budgets`, `twin_simulations` (per-member enrichment, best-effort)
- Role: authenticated family members using the Digital Twin
- Scenario: the `family_members` roster read fails (RLS edge, transient, connection) while the table exists.
- Severity: **P2** (reassuring-but-wrong empty state — a populated family sees "no members" and loses the whole feature; lower launch weight than a status/money surface).
- Launch impact: the seven-way `Promise.all` destructured `{ data: members }` and dropped the roster's `error`. The roster is the spine of the page — every member card, the `DecisionSimulator`, and the `ActivityProjection` hang off `members ?? []`. A silent roster failure rendered **"No family members yet"** and hid the entire feature for a family that actually has members — a confidently-wrong empty state.
- Root cause: the source-of-truth roster read dropped its `error`.
- Resolution: capture `membersRes` from the `Promise.all`, and on `membersRes.error` `console.error('[dashboard/family-digital-twin] member read failed', …)` + `return <ErrorState message="Could not load your family from Supabase. Refresh and try again." />` before deriving `members`. The per-member enrichment reads (profiles/routines/classes/teams/goals/budgets/twin_simulations) intentionally stay best-effort — each legitimately degrades to an empty section. Matches the Command-Center/Readiness/Kitchen fail-closed pattern.
- Supabase impact: none (read error-handling only; no schema/migration change).
- Tests run: new `tests/family-digital-twin-read-boundary.test.ts` (3 assertions — roster result captured, log+ErrorState on failure, members derived only after the guard); full `npx vitest run` **570 files / 3556 tests green**; `tsc --noEmit` clean (only the known optional `@axe-core/playwright` e2e noise); eslint clean on changed files.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`.
- Remaining dependencies: none agent-doable for this page; the P0/P1 live blockers (LB-001..015) remain owner/live-infra.

### PLA-0773 - Smart Kitchen rendered a false-empty kitchen from partially-failed source-of-truth reads

- Timestamp: 2026-07-17 19:55 UTC
- Service: Dashboard / Smart Kitchen (agent-`fable-opus` lane)
- Route: `/dashboard/kitchen`
- Affected files: `app/(app)/dashboard/kitchen/page.tsx`, `tests/kitchen-read-boundary.test.ts`
- Database objects: `meal_plans`, `pantry_items`, `family_recipes`, `grocery_items` (core); `leftover_inventory`, `meal_nutrition` (optional/best-effort)
- Role: authenticated family members using the Smart Kitchen
- Scenario: any of the four source-of-truth reads (this week's meal plan, pantry, recipes, open grocery) fails to read (RLS edge, transient, connection) while the table itself exists.
- Severity: **P1** (same reassuring-but-wrong class as PLA-0770 readiness / TODO-0404 Command Center — a false household status).
- Launch impact: the six-way `Promise.all` destructured `planRes`/`pantryRes`/`recipesRes`/`groceryRes` but never inspected their `error`. A transient failure on any core read fell through to `?? []`, so the page rendered **"no meals planned", an empty pantry, zero recipes, and an empty grocery count** — and fed those empties into the Food Score, showing a confidently-wrong kitchen the family would act on (e.g. re-buying pantry staples that are actually stocked). The newer optional tables (`leftover_inventory`, `meal_nutrition`) were already correctly best-effort via `isMissingTableError`.
- Root cause: the four core reads dropped their `error`.
- Resolution: after the `Promise.all`, collect `[planRes.error, pantryRes.error, recipesRes.error, groceryRes.error].find((e) => e && !isMissingTableError(e))`, and on any real error `console.error('[dashboard/kitchen] kitchen read failed', coreError)` + `return <ErrorState message="Could not load your kitchen from Supabase. Refresh and try again." />` before building `KitchenData`. A genuinely missing core table (unapplied migration) is still tolerated as empty via `isMissingTableError`, so a partially-migrated env degrades rather than hard-fails; leftovers/nutrition stay best-effort. Matches the established Command-Center/Readiness fail-closed pattern.
- Supabase impact: none (read error-handling only; no schema/migration change).
- Tests run: new `tests/kitchen-read-boundary.test.ts` (3 assertions — core-error collection with missing-table filter, log+ErrorState, optional reads stay best-effort); full `npx vitest run` **569 files / 3553 tests green**; `tsc --noEmit` clean (only the known optional `@axe-core/playwright` e2e noise); eslint clean on changed files.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`.
- Remaining dependencies: none agent-doable for the Kitchen page; the P0/P1 live blockers (LB-001..014) remain owner/live-infra.
### PLA-0772 - A-12 REVIEW (product/safety decision): the Guardian emergency-keyword override rings through an explicitly BLOCKED caller

- Timestamp: 2026-07-17 19:45 UTC
- Service: Guardian / safety / contacts (A-12)
- Route: `lib/guardian/runDecisionPipeline` Step 7 (`lib/guardian/pipeline.ts:225-230`)
- Affected files: none (documented review item — **not unilaterally changed**, this is a genuine safety judgment call)
- Role: any caller to a child's guardian-screened line
- Scenario: a parent has **blocked** a caller (trust level `blocked`, or a routing rule with `action_routing_mode='blocked'`), and that caller's initial transcript contains an emergency keyword
- Severity: **MEDIUM** (product/safety decision — potential explicit-block bypass)
- Finding: after Step 6 resolves `routingMode` (rule → profile → default, which may be `blocked`), Step 7 does `if (shouldEscalate) routingMode = 'immediate_ring'` **unconditionally**, where `shouldEscalate` is a regex match on `/\b(911|emergency|help me|heart attack|stroke|fire|crash|accident|hospital|police|hurt|dying)\b/i` over the initial transcript. So a caller the parent **explicitly blocked** who merely says "emergency" / "help me" / "accident" is routed to `immediate_ring` — ringing the child's phone. Those keywords are trivial for a determined/blocked harasser or scammer to include.
- The tension: "never miss a real emergency" (escalate even from an unknown number) vs. "respect a parent's explicit block" (a blocked contact should stay blocked). The current code chooses emergency-beats-everything, including an explicit block.
- Recommended resolution (owner decision, NOT applied): make the emergency override NOT apply when the caller is explicitly `blocked` (trust level or rule) — i.e. gate Step 7 with `&& trust !== 'blocked' && routingMode !== 'blocked'`, or route a blocked "emergency" caller to `ai_handle_first` (screen + notify the parent) rather than ringing the child directly. Emergency escalation for non-blocked callers stays as-is.
- Supabase impact: none.
- Tests run: n/a (no change made). The adjacent `evaluateRules` engine now has coverage (`tests/guardian-rules.test.ts`, PLA-0771).
- Commit: (this increment — documentation only)
- Status: OPEN — product/safety decision for the A-12 owner. Surfaced during the guardian test-coverage sweep.
- Remaining dependencies: owner decision on emergency-vs-block precedence; then a one-line gate + a pipeline test.

### PLA-0770 - Family Readiness score computed a reassuring-but-wrong number from partially-failed reads (+ Kitchen Display crash verified fixed)

- Timestamp: 2026-07-17 19:42 UTC
- Service: Dashboard / family readiness (agent-`fable-opus` lane)
- Route: `/dashboard/readiness`
- Affected files: `app/(app)/dashboard/readiness/page.tsx`, `tests/readiness-read-boundary.test.ts`
- Database objects: `chore_assignments`, `reminders`, `meal_plans`, `calendar_events`, `grocery_items`, `family_members`
- Role: authenticated family members with the Readiness feature
- Scenario: any of the six source-of-truth counts that feed the headline readiness score fails to read (RLS edge, transient, unapplied migration).
- Severity: **P1** (same class as PLA/TODO-0404 Command Center — a reassuring-but-wrong household status).
- Launch impact: the primary `Promise.all` destructured only `{ count }`/`{ data }` and discarded every `error`; a failed read became `undefined → ?? 0`, so e.g. a dropped overdue-chores read rendered as **zero overdue → an "all caught up" great-band score** the family would trust. The forward *horizon* block is deliberately best-effort (documented `cnt()` helper) and is correctly left as-is.
- Root cause: the score's six primary reads dropped their `error`.
- Resolution: capture each primary read result, collect `[…].find(Boolean)`, and on any error `console.error('[dashboard/readiness] readiness score read failed', …)` + `return <ErrorState message="Could not load your family readiness from Supabase. Refresh and try again." />` before computing the score. Matches the established Command-Center/Briefing fail-closed pattern exactly.
- Supabase impact: none (read error-handling only; no schema/migration change).
- Tests run: new `tests/readiness-read-boundary.test.ts` (3 assertions — primary-error collection, log+ErrorState, horizon stays best-effort); full `npx vitest run` **566 files / 3536 tests green**; `tsc --noEmit` clean (only the known optional `@axe-core/playwright` e2e noise); eslint clean on changed files.
- **Kitchen Display crash (side finding, verified):** the production `/display` white-screen the owner reported across builds `006d860`/`1912186`(`19121862`) was root-caused + fixed by another agent in `e92fd897` (a **null `family_members.display_name` → `.split()` throw during SSR render** — nullable column typed as `string`), guarded by an SSR `renderToStaticMarkup` harness (`tests/display-render.test.ts`). Verified on this checkout: all 27 display tests (render harness + recover + tiles) green; `.split()` sites use the null-safe `firstName()` helper; `page.tsx` coerces `display_name ?? 'Member'` at source; `Avatar` uses null-safe `initials()`. The owner's last screenshots (build `19121862`, Jul 14) **predate** `e92fd897` (Jul 16) — a refresh on current `main` resolves it. My earlier display commits (client-only shell `bf9fd32d`, serialization firewall `9dcc4d62`, tile normalization `9ed24172`, hard-reload escalation `87478162`) are defense-in-depth around that root cause.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`.
- Remaining dependencies: none agent-doable for readiness; the P0/P1 live blockers (LB-001..014) remain owner/live-infra.

### PLA-0761 - A-10 food-table family-scoped RLS pinned to migrations with a CI-speed static guard (complements the live PLA-0627 proof)

- Timestamp: 2026-07-17 19:12 UTC
- Service: Meals / Groceries / Food (A-10)
- Route: cross-cutting — `meals`, `meal_plans`, `grocery_lists`, `grocery_items`, `family_recipes`, `pantry_items`, `dining_out`, `nutrition_logs`, `family_favorites`
- Affected files: `tests/a10-food-rls.test.ts` (new static guard)
- Role: any member of family B attempting to reach family A's food data
- Scenario: guard that every A-10 table's tenant-scoping is present in its defining migration, at unit-test speed, so a future migration can't drop a policy without the PG16 harness catching it
- Severity: (regression guard on a CRITICAL invariant — no defect found)
- Launch impact: agent-03 already PROVED A-10 cross-family isolation LIVE on PG16 (PLA-0627: family-B READ=0 across grocery_lists/items + meal_plans + meals + nutrition_logs + dining_out, INSERT rejected by WITH CHECK, UPDATE/DELETE=0, own writes ok). The live probe is the source of truth but does not run in every CI pass; this adds a fast static tripwire so a dropped/renamed policy on any A-10 table fails a normal `vitest` run, not just the harness
- Root cause: n/a (regression guard, additive to agent-03's live proof)
- Resolution: traced each A-10 table's RLS to its migration and pinned it — `meals`/`meal_plans`/`grocery_lists`/`grocery_items` via the `0004_rls.sql` family loop (`is_family_member(family_id)`, grocery pair re-asserted in `0025`); `family_recipes` via `0014_core_platform.sql` (inline `family_id in (select … where user_id = auth.uid())`); `pantry_items` via `0080_food_household.sql`; `dining_out` via `0104_dining_out.sql`; `nutrition_logs` + `family_favorites` via the `0115_meals_hub.sql` format loop. `tests/a10-food-rls.test.ts` asserts each table's RLS-enable + family-scoped predicate on all four ops
- Supabase impact: none (read-only; no schema change)
- Tests run: `tests/a10-food-rls.test.ts` (6), `tsc --noEmit` clean, eslint clean
- Validation evidence: guard asserts each table is targeted by its migration's RLS block with an `is_family_member(family_id)` (or the inline `auth.uid()` family predicate) on select/insert/update/delete
- Commit: (this increment)
- Status: additive regression guard landed; A-10 remains owned by `agent-03` (agent-doable scope complete per PLA-0626/0627). No ownership change
- Remaining dependencies: none for this guard; A-10's remaining items are owner/live-prod, tracked on agent-03's board row

### PLA-0771 - A-12: a malformed parent-entered Guardian caller-pattern regex crashed the whole call-routing engine

- Timestamp: 2026-07-17 19:35 UTC
- Service: Guardian / safety / contacts (A-12)
- Route: `lib/guardian/rules.ts` `evaluateRules` (runs on every screened inbound call/message via the guardian pipeline)
- Affected files: `lib/guardian/rules.ts`, `tests/guardian-rules.test.ts` (new)
- Role: any family (a parent authors a Guardian routing rule with a caller pattern)
- Scenario: a parent creates a rule whose `condition_caller_pattern` is not a valid regex (e.g. `(` or `[unclosed`), then a call/message arrives and the engine evaluates rules
- Severity: **MEDIUM** reliability / child-safety (a single bad rule breaks screening for the whole family)
- Launch impact: `matchesRule` compiled the parent-entered pattern with `new RegExp(pattern, 'i')` **unguarded**. A malformed pattern throws `SyntaxError`, which propagates out of `evaluateRules` and crashes the entire guardian routing evaluation — so *every* incoming call/message for that family fails to route correctly (either the screening endpoint 500s, or routing falls through in an unintended way), from one typo in one rule. The pattern is free-text a parent types, so this is readily triggerable.
- Root cause: untrusted user input (a regex) compiled without a try/catch; the rules engine had no test coverage, so the edge case was never exercised.
- Resolution: wrapped the `new RegExp(...)` in try/catch — an uncompilable pattern now simply cannot match (the rule is skipped) and evaluation continues to the next rule, instead of throwing. Added `tests/guardian-rules.test.ts` (8 cases) locking the engine's safety-critical behavior: priority ordering, overnight time windows across midnight, day/context/trust/pattern matching, AND-composition of conditions, inactive-rule skipping, fall-through, and the malformed-regex robustness case.
- Supabase impact: none (pure engine fix).
- Tests run: `tests/guardian-rules.test.ts` — 8/8 (the robustness case FAILED pre-fix with `SyntaxError` thrown, passes post-fix); full suite **3541** green; tsc 0; eslint 0.
- Validation evidence: TDD — the new test reproduced the crash against the current code (`expected [Function] to not throw … 'SyntaxError: Invalid regular expression' was thrown`), then passed after the guard. Found via a test-coverage sweep of untested pure logic in my lanes.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`
- Remaining dependencies: none. (Nice-to-have: validate the regex at rule-save time in the guardian UI/action so the parent gets immediate feedback — the engine is now crash-safe regardless.)

### PLA-0627 - A-10: cross-family RLS isolation PROVEN LIVE on PG16 (closes agent-02's last open item)

- Timestamp: 2026-07-17 19:10 UTC
- Service: Meals / groceries / food (A-10 — reclaimed)
- Route: `storage`-less DB RLS across the A-10 family tables
- Affected files: none (live verification via `docs/audit/verify-pg.sh`); evidence recorded here + `docs/SUPABASE_WIRING_MATRIX.md`/board
- Role: authenticated member of family A acting on family B's A-10 data
- Severity: **verification (isolation proof)** — the open A-10 residual agent-02 flagged ("live cross-family RLS on A-10 tables")
- Launch impact: A-10 tables use `is_family_member(family_id)` RLS; proving it actually isolates tenants live (not just "RLS enabled") is required for launch confidence. Brought up the throwaway PG16 harness (all migrations, migration_fail=0), created a second family (B) with one row per A-10 table, then — **as the family-A anchor member under RLS, with Supabase-mirrored `grant insert/update/delete to authenticated` so RLS is the real gate** — verified:
  - **READ**: `grocery_lists`, `grocery_items`, `meal_plans`, `meals`, `nutrition_logs`, `dining_out` → **0** family-B rows visible; own family-A data readable (1 row).
  - **INSERT** into family B → **`ERROR: new row violates row-level security policy`** (WITH CHECK).
  - **UPDATE** family B → **`UPDATE 0`**; **DELETE** family B → **`DELETE 0`** (USING filters them out).
  - **own-family INSERT** (sanity) → **`INSERT 0 1`** success. Family B data intact afterward; no A-injected row leaked in.
- Root cause: n/a (isolation holds).
- Resolution: verified live; no code change. Combined with PLA-0626 (grocery client fix) + agent-02's read/write boundaries (0418/0433/0435/0451) + seed ≥500, the A-10 **agent-doable** surface is now complete.
- Supabase impact: none (read-only proof on a throwaway DB; harness torn down).
- Tests run: PG16 harness live matrix above (read 0/6 cross-family + own visible; INSERT rejected; UPDATE/DELETE 0; own INSERT ok).
- Commit: (documentation)
- Status: RESOLVED — A-10 cross-family isolation proven live. A-10 agent-doable scope COMPLETE; only owner/live-prod verification remains (same class as every other unit).
- Remaining dependencies: none agent-doable for A-10.

### PLA-0626 - A-10 (reclaimed): Grocery module created a DUPLICATE list + dropped a failed insert on a transient read error

- Timestamp: 2026-07-17 19:00 UTC
- Service: Meals / groceries / food (A-10 — **reclaimed from `agent-02`, STALE ~21.5h**)
- Route: `/dashboard/grocery` (`components/modules/grocery-module.tsx`)
- Affected files: `components/modules/grocery-module.tsx`, `tests/silent-empty-read-ratchet.test.ts` (baseline −1)
- Role: every user
- Scenario: a transient failure of the "find the family's active grocery list" read on mount
- Severity: **MEDIUM functional** (data duplication + silent failure)
- Launch impact: the mount effect read the active grocery list with `const { data } = await …limit(1)`, then `if (data?.[0]) use it; else INSERT a new list`. On a transient read error `data` is null → it fell into the `else` and **created a duplicate "Groceries" list** (same class as the messages Family-Chat bug PLA-0624). The follow-up insert also dropped its `{error}` (`const { data: created } = …`), so a failed create silently left the module with no list and no message.
- Root cause: read `{error}` dropped → a failed existence check read as "nothing exists" → spurious create; insert `{error}` dropped → silent create failure.
- Resolution: capture `error` on the existence read and `toastError(describeDbError(error)) + return` (no duplicate; next mount retries); capture the insert's `error` and surface it too. This was the A-10 entry in the PLA-0625 silent-read baseline — removed from the ratchet baseline now that it's fixed.
- Supabase impact: none (client error-handling).
- Tests run: `tsc --noEmit` clean (only the known e2e-axe noise); ratchet 3/3 (baseline now 18); A-10 food/meal/grocery suites 70/70 green.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed. A-10 client silent-read burned down by 1 (18 baseline sites remain across other units).
- Remaining dependencies: A-10's open item (live cross-family RLS on A-10 tables) is owner/live-infra, inherited from agent-02.

### PLA-0625 - CROSS-CUTTING (FINDING): client reads that drop `{error}` — systemic silent-empty risk, triage list for owning agents

- Timestamp: 2026-07-17 18:00 UTC
- Service: cross-cutting (client components across many units)
- Route: any client module that reads Supabase in the browser
- Affected files: 19 `.tsx` files (listed below) — **NOT all bugs**, a triage surface
- Role: every user (a transient client read failure)
- Severity: **FINDING** (variable per site: MEDIUM false-empty · LOW keep-prior · negligible acceptable-degrade)
- Launch impact: PLA-0624 fixed a confirmed false-empty bug in `messages-module` (a failed read `data ?? []` → empty inbox that lies about state). A codebase scan shows the same *shape* — `const { data } = await supabase…` destructuring only `data`, dropping `error` — in 19 more client files. These fall into three buckets that each owner must triage:
  - **false-empty (fix — same class as messages):** the read result is rendered as `data ?? []`/`setX(data)`, so a failed load shows an empty list. Candidates: `components/modules/{assistant,billing,grocery,settings,weather,concierge-calls}-module.tsx`, `components/concierge/plan-write-backs.tsx`, `app/(app)/dashboard/{billing,concierge-calls,independence,journeys,money-timeline,onboarding-funnel,paperwork}/page.tsx`, `app/(app)/{missions/page.tsx,feedback/feedback-board.tsx}`.
  - **keep-prior (benign):** guarded by `if (data)` so a failed refresh keeps prior state (no false-empty) — e.g. `components/app/app-context.tsx`, `components/modules/concierge-calls-module.tsx`. Surfacing a toast would be nicer but it does not lie about state.
  - **acceptable-degrade (SSR/marketing):** `app/(marketing)/{lp/[slug],f/[id]}/page.tsx` render server-side; empty-on-error is a tolerable public-page degrade.
- Root cause: the browser Supabase client returns `{ data, error }`; dropping `error` + `?? []` converts a load failure into a false "you have nothing" state. The robust idiom already exists in the codebase — `useRealtimeQuery`/`useModuleData` return `{ error }` → `<ErrorState onRetry/>` (see `files-hub-module`, `documents-module`); the offenders hand-rolled their reads instead.
- Resolution: **documented for per-owner triage — NOT unilaterally fixed** (these span A-05/A-08/A-09/A-10/A-13/A-15/A-17 modules under other agents' claims; editing them here would collide). The A-11 instance (`messages-module`) is fixed (PLA-0624). Recommended fix per false-empty site: capture `error`, `toastError(describeDbError(error))` (or `<ErrorState onRetry>`), and keep prior state instead of `?? []`. Best long-term: migrate hand-rolled reads onto `useRealtimeQuery`. A §3d coordination note points each owner at their file(s).
- Supabase impact: none (client error-handling).
- Tests run: scan only (`grep` shape match); `messages-module` fix validated under PLA-0624.
- Commit: (documentation + coordination note)
- Status: OPEN (finding) — A-11 site fixed; 18 remaining sites owned by their respective agents to triage. **Now RATCHETED**: `tests/silent-empty-read-ratchet.test.ts` fails CI if any NEW file introduces the shape (baseline frozen at these 19), regression-locks the messages fix, and forces BASELINE to shrink as owners fix theirs (delete the test when it reaches []).
- Addendum (A-16, fixed): a sibling FORM of the same class — `const { count: c } = await …; setCount(c ?? 0)` (count read, not `data`) — was found in `components/app/notification-bell.tsx` (the global unread badge). A failed count read silently **cleared the badge to 0** (user thinks they have no notifications). Fixed: capture `error` and keep the prior badge on failure (a realtime change / next mount retries). This form is not caught by the `const { data }` ratchet; the reminders/notifications modules + admin bell were checked and are clean.
- Remaining dependencies: each owning agent classifies + fixes their site(s).

### PLA-0623 - A-08/A-03: money amount-validation + child-PIN brute-force surfaces VERIFIED clean

- Timestamp: 2026-07-17 17:55 UTC
- Service: Wallet / Bubaly Money (A-08) + Auth (A-03)
- Route: money mutation actions (`wallet`/`economy`/`invest`) + `childSignInAction` (`/kid-login`)
- Affected files: none (verification only)
- Role: child / teen (attempting money manipulation or PIN guessing)
- Severity: (verification of two abuse surfaces — no defect found)
- Launch impact: two abuse vectors audited by reading the code paths end to end:
  - **Client-supplied money amounts** — every money mutation validates server-side: `addFunds`/`setAllowance`/`createGoal`/`fundGoal` do `Math.trunc` + reject `!Number.isFinite || <= 0`; funding actions are `isManager`-gated. The two **child-callable** paths are safe by construction: `requestRedemptionAction` takes **no** client amount (the reward cost is read server-side + stock-checked), and `placeInvestOrderAction` validates `shares` (`Number.isFinite` after the ×10⁴ truncation catches overflow→Infinity, `> 0`), prices the order with the **server's** `asset.price_cents` (never a client price), and balance/holding-checks it. No negative/overflow/price-spoof vector.
  - **Child PIN brute-force** — `childSignInAction` layers: per-IP rate limit (30/window), input-format validation, and a durable per-username throttle (`child_login_throttle`, service-role-written) evaluated **before** the password check **and even for unknown usernames** (no enumeration oracle); generic "username or PIN isn't right" errors; PIN mixed with `CHILD_LOGIN_SECRET` (offline brute-force needs the secret); throttle cleared on success. Policy `maxFails=5` per 15-min window → escalating 15-min lockout, so a 4-digit PIN (10⁴ combos) can't be exhausted (~5 tries/15 min ⇒ 20+ days minimum, before escalation). Covered by `tests/child-throttle.test.ts` + `tests/child-login-action-security.test.ts`.
- Root cause: n/a (verification).
- Resolution: n/a — both surfaces are correctly built; documented as audited.
- Supabase impact: none.
- Tests run: existing `child-throttle` + `child-login-action-security` suites remain green; no new code.
- Validation evidence: code-path reading of every money mutation's amount handling + the full `childSignInAction` throttle/rate-limit/error-message flow and the `DEFAULT_POLICY` constants.
- Commit: (this increment)
- Status: RESOLVED (verified — no defect).
- Remaining dependencies: live E2E brute-force / concurrency exercise remains part of the owner-gated auth E2E (LB-005).

### PLA-0624 - A-11: Messages module silently showed an EMPTY inbox on a failed load (client read errors dropped)

- Timestamp: 2026-07-17 17:45 UTC
- Service: Messages / files / documents (A-11)
- Route: `/dashboard/messages` (`components/modules/messages-module.tsx`)
- Affected files: `components/modules/messages-module.tsx`
- Role: **every user** (any authenticated family member)
- Scenario: a transient failure of a client-side read (network blip, expired session, RLS/PostgREST hiccup) while loading the Messages page
- Severity: **MEDIUM functional/UX** — a messaging surface that lies about its state
- Launch impact: the module's WRITE paths correctly surfaced errors (`toastError(describeDbError(...))`), but its three READ paths destructured only `{ data }` and dropped `error`, then did `data ?? []`:
  - `loadConversations` → a failed load rendered an **empty conversation list** (user believes they have no conversations/messages)
  - `loadMessages` → a failed load **blanked the open thread** ("no messages")
  - `loadSummaries` → a failed load **wiped every preview + unread badge to zero**
  Plus the "ensure Family Chat exists" check treated a failed existence query (`data` null) as "no chat" and would attempt to create a **duplicate** Family Chat on a transient error.
- Root cause: client reads swallowed the PostgREST `{error}` and fell back to an empty array — the exact silent-failure class this audit eliminates, here on the primary A-11 surface (my earlier sweep covered server libs/actions; this was a client component).
- Resolution: all three reads now capture `error` and `toastError(describeDbError(error))` + bail (keeping any prior on-screen state instead of wiping it to empty); the Family-Chat existence check `return`s on error so it never creates a duplicate from a failed probe. Reuses the module's existing `useToast()` error toast — consistent with its write paths.
- Supabase impact: none (client error-handling only).
- Tests run: `tsc --noEmit` clean (only the known `@axe-core/playwright` e2e-dep noise); `tests/messages-overview.test.ts` + `tests/a11-messages-rls.test.ts` 9/9 green (pure helpers + RLS unaffected). Documents module verified already error-surfacing (fetcher hook → `<ErrorState>`), no change needed.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`. A-11's primary UI now fails visibly on read errors.
- Remaining dependencies: none.

### PLA-0621 - A-11: all 6 Storage buckets RLS-boundary VERIFIED (sensitive = private, no cross-tenant write) + guarded

- Timestamp: 2026-07-17 17:32 UTC
- Service: Messages / files / documents / storage (A-11)
- Route: `storage.objects` RLS across every bucket (`avatars`, `chore-proof`, `documents`, `family-media`, `feedback-attachments`, `marketplace-photos`)
- Affected files: `tests/storage-bucket-rls-boundary.test.ts` (new, 4 cases)
- Role: authenticated member of family A attempting to read/write family B's objects
- Severity: **verification (no defect) + regression guard against a catastrophic PII-leak class**
- Launch impact: extended the boundary lens (PLA-0611/0615) to Supabase Storage. Enumerated all 6 buckets and their `storage.objects` policies:
  - **`documents`** (passports/IDs/insurance) — `public=false` (PRIVATE); SELECT/INSERT/UPDATE/DELETE all folder-scoped to `is_family_member((storage.foldername(name))[1]::uuid)`. ✓
  - **`chore-proof`** (photos of children) — `public=false` (PRIVATE); family-scoped read/insert/delete (no UPDATE needed for write-once proof). ✓
  - **`family-media`** — family-scoped writes (my mig 0216); read is public (already tracked as **LB-009**). ✓ (writes)
  - **`avatars`, `marketplace-photos`, `feedback-attachments`** — public-read by design (profile pics / listings / admin feedback screenshots); writes scoped to the uploader's own `auth.uid()` folder. ✓
  - **No cross-tenant write path** (every write checks the folder segment against membership/ownership) and **no sensitive bucket wrongly public** — the two PII-bearing buckets are both private + family-scoped.
- Root cause: n/a (clean); the risk is a future migration silently flipping `documents`/`chore-proof` to public or dropping the folder-scope check → instant cross-tenant PII leak.
- Resolution: added `tests/storage-bucket-rls-boundary.test.ts`, which reads the migration SQL and asserts (1) the sensitive buckets are created `public=false` and are never (re)created or `UPDATE`d to `public=true`; (2) every family-scoped bucket gates writes on `is_family_member` of the folder; (3) the sensitive buckets have a family-scoped SELECT and NOT an unconditional public SELECT. Self-maintaining against future drift.
- Supabase impact: none (verification + guard).
- Tests run: `tests/storage-bucket-rls-boundary.test.ts` 4/4 green.
- Commit: (this increment)
- Status: RESOLVED — A-11 storage tenant-isolation proven and guarded. (Residual: LB-009 family-media public→signed URLs remains an owner/product decision, unchanged.)
- Remaining dependencies: none new.

### PLA-0622 - A-08: a child could rewrite/erase the money AUDIT TRAIL (wallet_audit_logs missed by the 0217 ledger lockdown)

- Timestamp: 2026-07-17 17:36 UTC
- Service: Wallet / Bubaly Money (A-08)
- Route: DB `wallet_audit_logs` (direct PostgREST)
- Affected files: `supabase/migrations/0224_wallet_audit_log_append_only.sql` (new), `tests/wallet-audit-log-append-only.test.ts` (new)
- Role: **child / teen** (any non-manager family member with a login)
- Scenario: a child `update`/`delete public.wallet_audit_logs` directly via PostgREST (anon key ships in the client bundle)
- Severity: **MEDIUM** integrity (money-audit-trail tamper — undermines parent oversight/forensics). No money moves: the ledger itself (`wallet_transactions`) is locked to managers/service-role by 0217.
- Launch impact: `wallet_audit_logs` (money audit trail — wallet activation, transfers, approvals, AI-coach calls, invest decisions) shipped (0088) with the systemic `"Members manage" FOR ALL is_family_member` policy and was **not** among the tables the 0217 wallet lockdown covered (`family_wallets`/`child_wallets`/`wallet_buckets`/`wallet_transactions`/`wallet_rules`). So a signed-in child could UPDATE or DELETE audit rows directly — rewriting or erasing the money history a parent relies on to review activity (e.g. deleting the record of an action they weren't supposed to take).
- Root cause: an append-only audit table left under the family-member FOR-ALL write policy; the ledger-lockdown migration scoped only the balance-bearing tables, not the audit log beside them.
- Resolution: migration 0224 makes the log **append-only for clients** — drops the FOR-ALL policy, keeps `is_family_member` SELECT + INSERT (every existing append, from manager/child/RPC sessions, keeps working), and grants **no** UPDATE/DELETE policy to `authenticated`, so only the service role (BYPASSRLS retention/tooling) can alter or prune it. Chosen over a service-role-only-write refactor because ~10 app sites append via the acting user's session and there is no legitimate UPDATE/DELETE of an audit row anywhere in the code — so append-only closes the tamper vector with zero app changes and zero regression risk.
- Supabase impact: new migration `0224` (additive, idempotent, `to_regclass`-guarded). Must be applied to prod (human-owned) — added to `docs/PENDING_PROD_MIGRATIONS.md`.
- Tests run: `tests/wallet-audit-log-append-only.test.ts` (5, new); full suite green; tsc 0; migration audit next=0225.
- Validation evidence: PG16 harness, production-accurate grants. Matrix proven: child SELECT → ALLOWED; child INSERT (append) → ALLOWED; child UPDATE (rewrite) → **0 rows (blocked)**; child DELETE (erase) → **0 rows (blocked)**; service-role UPDATE/DELETE → ALLOWED; seed still applies fail=0.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`; migration `0224` pending prod apply (human-owned)
- Remaining dependencies: apply `0224` to prod. Residual (low): member INSERT stays open (an appended row is attributed via `actor_user_id` and moves no money); a future hardening could route all ~10 app appends through the service role and make the log service-role-write-only, matching the chore/guardian audit-trail fixes (PLA-0616/0617).

### PLA-0618 - A-16: cron route ↔ vercel.json schedule 1:1 registration VERIFIED + guarded

- Timestamp: 2026-07-17 17:10 UTC
- Service: Notifications / reminders / cron (A-16)
- Route: `vercel.json` `crons` ↔ `app/api/cron/**`
- Affected files: `tests/cron-schedule-registration.test.ts` (new, 5 cases)
- Role: n/a (deploy/scheduling correctness)
- Severity: **verification (no defect) + regression guard** — complements PLA-0615 (which proved each cron route is auth-gated); this proves each is actually scheduled
- Launch impact: a cron route is only half a job — the other half is its `vercel.json` schedule entry. Drift fails SILENTLY in prod: a route with no schedule never fires (dead reminder/digest/allowance run), and a schedule with no route 404s every tick. Verified the two are in **exact 1:1 correspondence**: 19 routes ↔ 19 schedules, zero unscheduled routes, zero orphaned schedules, all expressions well-formed 5-field cron, no duplicate paths. So every A-16 scheduled job (notifications, push-scan, wallet-allowance, chore/return reminders, digests, etc.) is genuinely wired to fire in prod.
- Root cause: n/a (clean); the risk is future drift.
- Resolution: added `tests/cron-schedule-registration.test.ts` — parses `vercel.json` crons, globs `app/api/cron`, and asserts perfect 1:1 (no dead jobs / no 404 ticks) + well-formed expressions + no duplicates. Self-maintaining, so a future cron route added without a schedule (or a schedule left orphaned) now fails CI.
- Supabase impact: none.
- Tests run: `tests/cron-schedule-registration.test.ts` 5/5 green.
- Commit: (this increment)
- Status: RESOLVED — A-16 cron scheduling proven complete and guarded against drift.
- Remaining dependencies: none. (Prod firing still requires `CRON_SECRET` set in the deployment env — owner-owned config, already tracked.)

### PLA-0619 - A-03: service-role (BYPASSRLS) read/write scope VERIFIED across the whole app tree — no request-supplied-id IDOR

- Timestamp: 2026-07-17 16:20 UTC
- Service: Tenant isolation / authorization (A-03), cross-cutting
- Route: every `createServiceClient()` call site under `app/**` (~90 files)
- Affected files: none (verification only — complements the live isolation proof PLA-0415)
- Role: any signed-in family member attempting to reach another family's data
- Severity: (verification of a CRITICAL isolation invariant — no defect found)
- Launch impact: `createServiceClient()` bypasses RLS, so any service-role query that scopes family data by a **request-supplied** id (formData/params) without verifying it against the caller would be a cross-family IDOR. Enumerated every service-client usage under `app/**` and triaged each by how it derives its scope:
  - **Non-admin app actions/pages** — every family-data access scopes by the authenticated context: `ctx.active.familyId` (money, wallet, marketplace orders/reports, account, contact-center, feedback, missions), an explicit `member.family_id === ctx.active.familyId` membership check before acting (child-login create/reset-PIN — a request `memberId` is rejected if it isn't in the caller's family), the caller's own `owner_id`/`user_id` (settings progressive-profile `crm_contacts`), or a global singleton (`stripe_settings`, plan config). No request-supplied family/member id is ever used to scope a service query without a membership check.
  - **`app/(app)/admin/**` console** — every flagged file is the super-admin console, which reads cross-tenant data by design behind the `(app)/admin` layout gate + per-action `isSuperAdmin`/`requireMarketingAdmin` re-checks (A-17, PLA-0530). Not IDORs.
  - Privileged mutations additionally carry role gates (`isManager`/`isAdmin`/`isSuperAdmin`).
- Root cause: n/a (verification + method note).
- Resolution: n/a. Static triage of all ~90 `createServiceClient()` sites; the highest-risk money/wallet/marketplace/child-login/contact-center/feedback actions read in full. Pairs with the live cross-family isolation proof (PLA-0415: read/write/RPC all blocked cross-tenant on PG16).
- Supabase impact: none.
- Tests run: n/a (no code change); the existing isolation guards (`tests/rls-isolation-sweep.test.ts`, admin-authz guards) remain green.
- Validation evidence: enumeration output + per-file scope classification (authenticated-context vs. request-input); non-admin service reads all scope to `ctx.active.familyId` / own-user / singletons; admin reads all super-admin gated.
- Commit: (this increment)
- Status: RESOLVED (verified — no defect). Live per-request IDOR fuzzing across all routes remains part of the owner-gated E2E pass (LB-005).
- Remaining dependencies: none for the static boundary; live authenticated E2E is LB-005.

### PLA-0617 - A-12: Guardian child-safety AUDIT TRAIL was silently RLS-broken (audit writes ran under the user session)

- Timestamp: 2026-07-17 16:04 UTC
- Service: Guardian / safety / contacts (A-12)
- Route: `/guardian`, `/guardian/contacts`, `/guardian/settings` (server actions in `app/(app)/guardian/actions.ts`)
- Affected files: `app/(app)/guardian/actions.ts`, `tests/guardian-audit-log-service-role.test.ts` (new)
- Role: **every** role (the audit write failed regardless of who acted — these actions are manager-gated, so the actor is always a parent/adult)
- Scenario: a parent creates/updates a Guardian contact, changes a contact's trust level, assigns/clears a guardian phone, or creates a routing rule → the action appends to `guardian_audit_log`
- Severity: **P2 functional / compliance** (silent data loss on a child-safety audit trail; no security exposure). Found via the same SELECT-only-table sweep that surfaced PLA-0616 (`chore_approval_events`) and PLA-0612 (`chore_ai_validations`).
- Launch impact: `guardian_audit_log` has only a `Family member can view guardian_audit_log` SELECT policy and **no authenticated INSERT policy** (service-role-write by design). All four audit inserts ran through `withGuardianTables(createServer())` — the acting parent's RLS session — and the error was swallowed (`console.error` only). So every Guardian audit event was silently RLS-denied and the child-safety **audit trail never recorded** in production (who changed a contact's trust, when a guardian phone was assigned, who created a screening rule — all lost).
- Root cause: an append-only, service-role-by-design audit table written through the acting user's RLS session; the missing authenticated write policy is intentional, so the client was the defect.
- Resolution: added a `logGuardianAudit` helper that writes via `withGuardianTables(createServiceClient())` (best-effort) and routed all four audit sites through it; imported `createServiceClient`. The Guardian tables need the `withGuardianTables` type augmentation because `guardian_audit_log` isn't in the generated `Database` types.
- Supabase impact: none (no migration — app-layer client fix; takes effect on deploy).
- Tests run: `tests/guardian-audit-log-service-role.test.ts` (3, new); existing `tests/guardian-authz.test.ts` (4) still green; full suite green; tsc 0; eslint 0.
- Validation evidence: PG16 harness, production-accurate grants. Proven: `guardian_audit_log` has a single SELECT policy; a **manager (parent)** authenticated INSERT → `new row violates row-level security policy`; a service-role INSERT passes. Confirms the old user-session writes silently failed and the service-role fix lands the row.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`
- Remaining dependencies: none. (Method note: 3rd and final hit from the SELECT-only-table write-client sweep; the full sweep of ~42 RLS-enabled, write-policy-less tables otherwise confirmed every other such table is written correctly via a service-role/admin client — cron routes, Stripe/Resend webhooks, and admin-console actions all verified.)

### PLA-0615 - A-03/A-16: public-route authorization boundary VERIFIED + drifted cron guard hardened

- Timestamp: 2026-07-17 15:50 UTC
- Service: Auth/tenant middleware boundary (A-03) + scheduled callbacks (A-16)
- Route: middleware `PUBLIC` allowlist ↔ all 113 `app/api/**` routes; guardian telephony webhooks
- Affected files: `tests/cron-auth.test.ts` (route list now globbed from disk), `tests/public-webhook-signature-boundary.test.ts` (new, 4 cases)
- Role: unauthenticated attacker (routes reachable with NO session via the PUBLIC allowlist)
- Severity: **verification (no live hole) + P2 test-drift fix** — complements the PLA-0611 middleware fix (that was *under*-exposure of `/api/health`; this checks the inverse, *over*-exposure)
- Launch impact: prompted by the PLA-0611 finding that the hand-maintained `PUBLIC` allowlist had a gap, I audited the inverse risk — a privileged route wrongly *reachable* without auth (the matcher is `startsWith(prefix + '/')`, so a public prefix exposes everything beneath it). Enumerated every route under each public `/api/*` prefix:
  - **19 cron routes** — all call `hasCronAuthorization` and return 401; the helper is fail-closed (`!!secret &&`, so an unset `CRON_SECRET` can't become a valid `Bearer undefined`). ✓
  - **`concierge-calls/place`** (outbound-call cost) — `hasCronAuthorization` + 401. ✓
  - **`guardian/*`** telephony — inbound voice/sms/whatsapp/screen/status/twiml verify the **Twilio HMAC-SHA1 signature** (`validateTwilioSignature`, fail-closed: `!TWILIO_AUTH_TOKEN → return false`, `timingSafeEqual`); `escalate` (SMS/call blast) is fail-closed on `GUARDIAN_INTERNAL_SECRET`/`CRON_SECRET`. ✓
  - **`email/welcome`** — `hasInternalSecret` + 401. ✓
  - marketing/telemetry/token routes (contact, blog, ab, mkt, lp, forms, exit-intent, services/descriptions, ai/gift, sync/feeds/[token]) — genuinely public / token-scoped / rate-limited by design; webhooks/* provider-signed; marketing/unsubscribe signed. ✓
  - **No over-exposure found** — every publicly-reachable privileged route self-authenticates.
- Root cause (the one concrete defect): the systemic regression guard `tests/cron-auth.test.ts` pinned a **hardcoded** cron-route list that had **drifted** — it listed 17 of the 19 routes, silently omitting `feedback-github-sync` and `return-reminders`. Both currently carry the gate, but a future removal of their gate would have passed CI unnoticed.
- Resolution: (1) `cron-auth.test.ts` now enumerates cron routes with `readdirSync('app/api/cron')` (self-maintaining — any future cron route is covered automatically), plus a `≥19` non-empty sanity assert and a per-route `401` (acts-on-the-check, not just imports) assert. (2) New `tests/public-webhook-signature-boundary.test.ts` globs `app/api/guardian/**` and asserts every provider-facing route verifies the Twilio signature + rejects, the escalate trigger is fail-closed, and `validateTwilioSignature` itself rejects when the auth token is unset.
- Supabase impact: none (test + verification only).
- Tests run: `tests/cron-auth.test.ts` 4/4 (now covers all 19 cron routes) + `tests/public-webhook-signature-boundary.test.ts` 4/4 — green.
- Commit: (this increment)
- Status: RESOLVED — public API boundary proven clean; the cron-auth guard can no longer silently drift.
- Remaining dependencies: none.

### PLA-0614 - /api/health now probes the Supabase AUTH service (GoTrue) — surfaces the LB-001 failure mode (A-20)

- Timestamp: 2026-07-17 14:30 UTC
- Service: Observability / deploy health (A-20) — extends PLA-0611
- Route: `GET /api/health` (adds an `auth` check to the body)
- Affected files: `lib/health/probe.ts` (+`probeAuth`, factored a shared bounded `probe()`), `lib/health/status.ts` (+`auth` in `checks`, degraded semantics), `app/api/health/route.ts` (parallel db+auth probes), `tests/health-endpoint.test.ts` (13→19 cases)
- Role: n/a (infra — uptime monitor / on-call)
- Severity: P2 (observability) — directly relevant to the **P0 LB-001** ("Supabase Auth Admin users health check returns HTTP 500")
- Launch impact: PLA-0611's health check probed PostgREST (data) only, so it could not distinguish "auth down" from "all healthy" — exactly the LB-001 condition (auth 500 while the DB is fine) was invisible. Now `/api/health` runs a bounded GoTrue `/auth/v1/health` probe in parallel and reports it as a distinct `checks.auth` result, giving on-call a direct signal for the LB-001 shape.
- Root cause: health check covered data connectivity but not the auth service.
- Resolution: added `probeAuth` (mirrors the RLS-independent `probeDatabase`, hits GoTrue's own `/auth/v1/health`, 3s abort, fails closed). Reworked the status fold to a **three-state** model with deliberate HTTP mapping: env-missing or **PostgREST** down → `error`/**503** (page + drop from rotation); **auth-only** outage → `degraded`/**200** (NOT 503) — GoTrue is a shared upstream, so 503-ing every instance on an auth blip would yank the whole fleet and escalate an auth-only outage into a total outage; 200+`degraded` keeps anonymous/cached traffic served while the body still flags the problem for alerting; all green → `ok`/200.
- Supabase impact: read-only, no schema change; hits the auth service's public health route (no table/RLS dependency).
- Tests run: `tests/health-endpoint.test.ts` **19/19 green** — incl. degraded-not-503 fold, `probeAuth` hits `/auth/v1/health` with the anon apikey, GoTrue 5xx→unhealthy (the LB-001 shape), abort→fail-closed. Build gate below.
- Commit: (this increment)
- Status: RESOLVED — auth readiness now observable. Does NOT resolve LB-001 itself (that is the actual auth-500, owner/Supabase-operator-owned) — it makes the failure mode *detectable* from an unauthenticated probe.
- Remaining dependencies: LB-001 root cause is owner-gated (Supabase project/operator).

### PLA-0616 - A-07: chore approval AUDIT TRAIL was silently RLS-broken (logChoreEvent wrote under the user session)

- Timestamp: 2026-07-17 14:30 UTC
- Service: Chores / Missions / rewards (A-07)
- Route: `/missions`, `/kids` (server actions `submitProofAction`, `approveSubmissionAction`, `rejectSubmissionAction`, `disputeSubmissionAction` → `logChoreEvent`)
- Affected files: `lib/chores/server.ts`, `app/(app)/missions/actions.ts`, `tests/chore-approval-events-service-role.test.ts` (new)
- Role: **every** role (the audit write failed regardless of who acted)
- Scenario: any chore lifecycle event (submit / ai_validate / approve / reject / dispute) attempts to append to `chore_approval_events`
- Severity: **P2 functional** (silent data loss — no security exposure; found via the same SELECT-only-table sweep that surfaced PLA-0612's `chore_ai_validations`)
- Launch impact: `chore_approval_events` ships (0043) with a SELECT-only policy for family members and **no authenticated INSERT policy** ("written by the service-role engine"). But `logChoreEvent` took the caller's Supabase client and every caller passed a **user session** (a child on submit/dispute, a manager on approve/reject). So every event insert **except** the auto-approve path (which happened to run under the service role after PLA-0612) was silently RLS-denied — the write is best-effort (try/catch + console.error), so it failed invisibly and the chore **approval history / audit trail never recorded** in production.
- Root cause: an append-only, service-role-by-design audit table written through the acting user's RLS session; the missing authenticated write policy is intentional, so the client was the defect.
- Resolution: `logChoreEvent` now derives `createServiceClient()` internally and no longer accepts a session argument; all five callers updated to drop the client. Every lifecycle event now records regardless of who triggered it.
- Supabase impact: none (no migration — app-layer client fix; takes effect on deploy).
- Tests run: `tests/chore-approval-events-service-role.test.ts` (3, new); full suite green; tsc 0; eslint 0.
- Validation evidence: PG16 harness, production-accurate grants. Proven: authenticated INSERT into `chore_approval_events` as **child** → `new row violates row-level security policy`; as **manager** → same denial (no authenticated write policy exists); service-role INSERT passes RLS. Confirms the old user-session writes silently failed and the service-role fix lands the row.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`
- Remaining dependencies: none. (Method note: this is the 2nd hit from sweeping RLS-enabled, write-policy-less tables for app writes issued via the user session; the sweep otherwise found the remaining SELECT-only tables are written correctly via service-role/admin clients.)

### PLA-0613 - A-07: a child could forge chore COMPLETION via a direct chore_assignments status write (sibling of PLA-0612)

- Timestamp: 2026-07-17 14:20 UTC
- Service: Chores / Missions / rewards (A-07)
- Route: DB `chore_assignments` (direct PostgREST); no server action exposes this
- Affected files: `supabase/migrations/0223_chore_assignment_decision_guard.sql` (new), `tests/chore-assignment-decision-guard.test.ts` (new)
- Role: **child / teen** (any non-manager family member with a login)
- Scenario: a child `update chore_assignments set status='approved'` directly via PostgREST (anon key ships in the client bundle)
- Severity: **MEDIUM** integrity/accountability (mints no money — the reward is credited imperatively in `finalizeApproval` under the manager-only wallet RLS 0217, never by this status)
- Launch impact: `chore_assignments` shipped `is_family_member` FOR ALL, and the assignment status is what the dashboard reads as done/approved (`lib/chores/dashboard.ts` `COMPLETED_STATUSES = ['approved','done']`). So a child could mark their own chore **approved/complete** without a parent — gaming the family accountability loop. Direct sibling of the `chore_submissions` forge closed in PLA-0612/0222.
- Root cause: family-scoped write RLS with no role distinction; the only decision-status writers (`finalizeApproval → 'approved'`, `rejectSubmissionAction → 'rejected'`) already run as service-role/manager, but nothing stopped a member writing the same value directly.
- Resolution: migration 0223 adds a `before insert or update` trigger on `chore_assignments` that blocks a transition into `approved`/`rejected` unless the caller is service-role, an unauthenticated server/migration/seed context (`auth.uid() is null`), or a family manager (`can_manage_family`). Members keep `todo`/`in_progress`/`submitted`/`done` — `done` intentionally left member-writable (it mints nothing and may back a legitimate no-proof "mark done").
- Supabase impact: new migration `0223` (additive, idempotent, `to_regclass`-guarded). Must be applied to prod (human-owned).
- Tests run: `tests/chore-assignment-decision-guard.test.ts` (4, new); full suite green; tsc 0; migration audit next=0224.
- Validation evidence: PG16 harness, production-accurate grants. Matrix proven: child `approved` → BLOCKED; child `rejected` → BLOCKED; child `in_progress` → ALLOWED; manager `approved` → ALLOWED; service-role `approved` → ALLOWED; seed still applies fail=0.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`; migration `0223` pending prod apply (human-owned)
- Remaining dependencies: apply `0223` to prod. With PLA-0612 + PLA-0613, the A-07 chore integrity surface (submission + assignment decision statuses) is closed at both the app and DB layers.

### PLA-0612 - A-07: kid chore-proof submission was RLS-broken for everyone + a child could forge an approval (two findings, one root cause)

- Timestamp: 2026-07-17 14:12 UTC
- Service: Chores / Missions / rewards (A-07)
- Route: `/missions`, `/kids` (server action `submitProofAction`; DB `chore_submissions`)
- Affected files: `app/(app)/missions/actions.ts`, `supabase/migrations/0222_chore_submission_decision_guard.sql` (new), `tests/chore-submission-decision-guard.test.ts` (new), `tests/chore-state-transition-persistence.test.ts`, `tests/wallet-ledger-write-rls.test.ts`
- Role: **child / teen** (any non-manager family member with a login), and — for finding 1 — *every* role
- Scenario: (1) any kid submits chore proof → the flow inserts into `chore_ai_validations`; (2) a child `update chore_submissions set status='approved'` directly via PostgREST (anon key ships in the client bundle)
- Severity: **P1 functional (finding 1: submission broken in prod)** + **MEDIUM integrity (finding 2: forged approval)**. Note the money path is already decoupled (0217), so finding 2 mints no money — it forges only the workflow/audit status.
- Launch impact:
  - **Finding 1 (broken submit):** `chore_ai_validations` has RLS enabled with a SELECT-only policy (0043 comment: "written by the service-role engine"), but `submitProofAction` inserted into it using the **child** RLS session. Proven live on the PG16 harness: that INSERT fails `new row violates row-level security policy`, so `submitProofAction` returned "Could not save the proof review." — kid chore-proof submission was broken for **every** user (no authenticated role has INSERT on that table).
  - **Finding 2 (forge approval):** `chore_submissions` shipped with a single `is_family_member` FOR ALL policy, so a child could flip their own submission to `approved`/`rejected` directly, bypassing the manager-gated `approveSubmissionAction` (PLA-0450 closed the app action; this closes the direct-DB path). Proven live: a non-manager UPDATE to `status='approved'` succeeded pre-0222.
- Root cause: server-authoritative writes (AI verdict, auto-approve payout, decision-status transitions) were issued under the child's RLS session instead of the service role — the same "child session used as the authority for a server decision" pattern as the 0217 wallet fix.
- Resolution:
  - App: `submitProofAction` now derives `const service = createServiceClient()` and routes the `chore_ai_validations` INSERT and every decision-status write (`approved`/`parent_review`/`rejected`/`needs_improvement`, plus the pending rollback) through it. The submission INSERT (`pending`) and dispute (`disputed`) stay on the child session (the only writes a member is legitimately the authority for). This fixes finding 1 outright.
  - DB (migration 0222): a `before insert or update` trigger on `chore_submissions` blocks any transition **into** a decision status unless the caller is the service role, an unauthenticated server/migration/seed context (`auth.uid() is null`), or a family manager (`can_manage_family`). Defense-in-depth for finding 2.
- Supabase impact: new migration `0222` (additive, idempotent, `to_regclass`-guarded). Must be applied to prod (human-owned) — see `docs/PENDING_PROD_MIGRATIONS.md`. The app fix (finding 1) needs no migration and takes effect on deploy.
- Tests run: `tests/chore-submission-decision-guard.test.ts` (5, new); updated `chore-state-transition-persistence` + `wallet-ledger-write-rls` for the service-role routing; full suite **3456 passed**; tsc 0; eslint 0; migration audit next=0223.
- Validation evidence: PG16 harness, production-accurate grants (`grant all ... to authenticated`/`service_role`, mirroring Supabase so RLS/triggers are the gate). Matrix proven: child self-approve UPDATE → BLOCKED; child self-approve INSERT → BLOCKED; child submit (`pending`) → ALLOWED; child dispute (`disputed`) → ALLOWED; manager approve → ALLOWED; service-role auto-approve → ALLOWED. Pre-fix: child `chore_ai_validations` INSERT → RLS-denied; child self-approve UPDATE → succeeded.
- Commit: (this increment)
- Status: RESOLVED in-repo and pushed to `main`; migration `0222` pending prod apply (human-owned)
- Remaining dependencies: apply `0222` to prod; consider the same decision-status guard on `chore_assignments` (a child can still forge `chore_assignments.status='approved'`, which also mints no money — lower priority, noted for A-07 follow-up).

### PLA-0611 - OBSERVABILITY GAP CLOSED: no liveness/readiness endpoint for monitors or deploy smoke (A-20)

- Timestamp: 2026-07-17 13:50 UTC
- Service: Observability / deploy health (A-20)
- Route: **NEW** `GET /api/health` (public, unauthenticated)
- Affected files: `app/api/health/route.ts` (new), `lib/health/status.ts` (new), `lib/health/probe.ts` (new), `tests/health-endpoint.test.ts` (new, 13 cases); **follow-up:** `instrumentation.ts` (boot env guard wired into Next's `register()`), `tests/instrumentation-boot-guard.test.ts` (new, 3 cases); **live-smoke fix:** `middleware.ts` (+`/api/health` to PUBLIC), `tests/middleware-public-api-boundary.test.ts` (regression guard)
- Live-smoke finding (caught by running `next start` + curling the route, which unit tests could not): the middleware `PUBLIC` allowlist did NOT include `/api/health`, so the endpoint **307-redirected to `/login`** — unreachable for its entire purpose (uptime monitors / LB health checks cannot authenticate). Fixed by adding `/api/health` to `PUBLIC` (the route is read-only and secret-free, so public exposure is by design) + a regression test. This is exactly why a live probe matters beyond unit tests.
- **Live-smoke CONFIRMED post-fix** (production `next start`, fresh build with the middleware fix compiled into `.next/server/middleware.js`): `GET /api/health` → **HTTP 503** with body `{"status":"error","checks":{"env":{"ok":false,"missing":["NEXT_PUBLIC_SUPABASE_URL","NEXT_PUBLIC_SUPABASE_ANON_KEY","SUPABASE_SERVICE_ROLE_KEY"]},"database":{"ok":false,"error":"supabase env not configured"}}}`. This proves the full chain end-to-end at runtime: middleware now PASSES the route through (no login redirect), the env guard correctly fails closed at 503 in an unconfigured environment, and the body leaks only var NAMES — no secret values. In a properly-provisioned prod env (all three vars set + PostgREST reachable) the same code path returns 200 `{status:"ok"}`.
- **Three-way middleware auth boundary CONFIRMED live** (same session): PUBLIC `/login` → **200**; PROTECTED `/wallet` → **307 → `/login?redirect=%2Fwallet`** (auth guard holds); HEALTH `/api/health` → **503** (passes middleware). The homepage `/` timed out with NO server-side error/crash logged — the expected SSR-data-fetch stall when Supabase is unreachable in this no-env sandbox, not a defect. **Boot env guard also CONFIRMED live**: the server startup log emitted exactly `[boot] MISSING REQUIRED ENV: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY — … (see GET /api/health)` at boot, proving `instrumentation.register()` fires as designed. Full vitest suite on this HEAD: **549 files / 3455 tests green, 0 failed** (exit 0).
- Role: n/a (infra — uptime monitor / load balancer / CI deploy smoke)
- Scenario: an operator or a monitor needs a single stable URL to answer "is this deployment up AND can it reach Supabase?" without a login. A-20 logged this as an open observability gap ("no /api/health, no boot env guard").
- Severity: P2 (production-readiness / operability — not a correctness defect, but a launch-ops requirement: LB-001 references a bespoke auth health check; there was no general readiness endpoint)
- Launch impact: before this, there was no unauthenticated way to distinguish "process alive" from "process alive but Supabase unreachable / a required env var missing" — so a misconfigured deploy (blank `SUPABASE_SERVICE_ROLE_KEY`, unreachable DB) would serve traffic and fail opaquely deep in request handlers instead of failing a health check. No LB/uptime probe target existed.
- Root cause: no health/readiness route in the app.
- Resolution: added `GET /api/health`. It reports (a) required-env presence — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — as a boot env guard, and (b) a bounded (3s abort), **RLS-independent** Supabase connectivity probe against the PostgREST `/rest/v1/` root. Returns **200 `{status:"ok"}`** only when env is complete AND the DB is reachable, else **503 `{status:"error"}`**. Security: the body reports only booleans / latency / the NAMES of any missing env vars — **never a secret value** — so it is safe to expose without auth. Decision logic is factored into pure helpers (`lib/health/status.ts`) so it is unit-tested without a live network; the single impure probe (`lib/health/probe.ts`) fails closed (never throws) on timeout/reject.
- Supabase impact: read-only, no schema change. The probe hits the PostgREST root (the OpenAPI doc), so it depends on no table, seed, or RLS policy.
- Tests run: `tests/health-endpoint.test.ts` — **13/13 green** (env-presence incl. blank-as-missing; status/HTTP folding; probe: no-network-when-unconfigured, 2xx-ok+latency, apikey-against-/rest/v1/ root, 5xx-unhealthy, abort→fail-closed). `tsc --noEmit` clean (only the known `@axe-core/playwright` optional-e2e-dep noise). Production `npm run build` — route present in table.
- Commit: (this increment)
- Status: RESOLVED — `/api/health` shipped and tested. **Follow-up shipped:** the boot env guard now also runs at actual server startup via `instrumentation.ts` `register()` (Node runtime only) — a missing/blank Supabase core var emits ONE greppable `[boot] MISSING REQUIRED ENV: …` line at boot instead of surfacing only on the first request. Log-only (never throws), so it cannot take down a deploy. Reuses `checkRequiredEnv` for a single source of truth with the readiness route. `tsc` clean; 3 boot-guard tests green (logs+names missing / silent when complete / no-op in edge runtime). Residual (owner): wire `/api/health` as the platform's uptime-monitor / LB health-check target (Vercel/monitor config = infra, not code).
- Remaining dependencies: none in-repo; operator points their monitor at `/api/health`.

### PLA-0610 - PRIVACY REVIEW (product decision): family-wide PII is readable by every member incl. children

- Timestamp: 2026-07-17 12:55 UTC
- Service: Vault / Health / Documents (A-11 / A-12)
- Route: reads of `family_credentials`, `health_visits` (+ health_*), `documents`, `driver_licenses`, `family_insurance_policies`
- Affected files: RLS in 0119 (credentials), 0068 (health_visits), 0109 (documents), etc. — no code change
- Role: **child / teen** — any family member
- Scenario: a child reads a parent's stored passwords, medical visits/diagnoses, driver licenses, insurance, or documents
- Severity: MEDIUM (privacy) — **explicitly a PRODUCT DECISION, not a unilateral fix**
- Launch impact: these tables use `is_family_member(family_id)` for SELECT with **no per-record visibility / owner / min-role column**, so every member (incl. young children) can read every other member's sensitive PII. Family-wide sharing is a *legitimate* design for a family-care app (parents coordinate a household record, shared WiFi password, etc.), which is why this is flagged for a decision rather than changed. But a flat "everyone sees everything" model is risky for adult credentials, medical history, and government IDs.
- Root cause: no visibility model on family PII tables.
- Resolution: **DEFERRED to the product owner.** Recommended pattern (backward-compatible): add a `visibility` enum (`family` | `managers` | `owner`) defaulting to `family` (preserves today's behavior — zero breakage), expose a per-record toggle in the UI, and scope SELECT to `owner OR managers OR (visibility='family')`. Ship as an additive migration once the default policy per table is chosen (e.g. credentials/IDs → `managers`, health → `family` for care coordination).
- Supabase impact: would be an additive column + RLS migration per decision.
- Tests run: n/a (finding). Confirmed policy shapes: `family_credentials_select` = is_family_member (0119); `health_visits` = "Members manage" FOR ALL is_family_member (0068); `documents` family-scoped (0109).
- Commit: (documentation)
- Status: OPEN — awaiting a product decision on the family-PII visibility model. Supersedes/aggregates PLA-0591 (credentials).
- Remaining dependencies: decide default visibility per table → additive column + RLS + UI toggle.

### PLA-0601 - A-01 shared-CI RED fixed: vitest JSX runtime under the wrong key crashed every SSR component test

- Timestamp: 2026-07-17 01:00 UTC
- Service: Build/test gate (A-01) — vitest configuration
- Route: n/a (test infra)
- Affected files: `vitest.config.ts`
- Role: all agents (the whole shared suite)
- Scenario: any test that server-renders a real component tree (`renderToStaticMarkup`) — surfaced by `tests/display-render.test.ts`
- Severity: P1 (shared-CI blocker — the A-01 "vitest green" DoD gate was failing for every unit)
- Launch impact: `tests/display-render.test.ts` was RED on `main` (9 cases, `ReferenceError: React is not defined` during SSR), the only full-suite failure, blocking the "relevant vitest passes" gate for all agents. Root cause: `vitest.config.ts` set the JSX automatic runtime under the **`oxc`** key, but this repo runs **vitest 2.1.9 / vite 5**, which transforms with **esbuild** — so the `oxc` key is a no-op and esbuild fell back to the **classic** JSX runtime, compiling `<Cmp/>` to `React.createElement`. Components that (correctly, per the app's automatic runtime) do NOT `import React` therefore threw "React is not defined" the moment they were server-rendered in a test. It only surfaced in `display-render` because that is the sole test that SSR-renders a real `.tsx` tree; pure-function tests never hit it. Not a component bug (the app build is green) and not a test-author bug — a config-key mismatch
- Root cause: JSX-runtime option placed under `oxc` (vitest 3+/rolldown only) instead of `esbuild` (the active transformer for vitest 2/vite 5)
- Resolution: added `esbuild: { jsx: 'automatic', jsxImportSource: 'react' }` to `vitest.config.ts` (kept the `oxc` key for forward-compat). This aligns the test JSX transform with the app's automatic runtime — a global, non-conflicting config fix touching no agent's component or test
- Supabase impact: none
- Tests run: `tests/display-render.test.ts` 9/9 (was 0/9); **full suite 545 files / 3,431 tests — all green, zero regressions**; eslint clean on the config
- Validation evidence: before = "Tests 9 failed"; after = "Tests 9 passed" + "Test Files 545 passed / Tests 3431 passed"
- Commit: (this increment)
- Status: Resolved — shared-CI green restored; A-01 gate unblocked for all agents. Supersedes the §3c board flag (now resolved)
- Remaining dependencies: none

### PLA-0600 - A-08 kid-investing: a child could MINT investment holdings via a direct invest_holdings insert (+ money-ledger sweep complete)

- Timestamp: 2026-07-17 12:20 UTC
- Service: Kid Investing (A-08 — third family ledger after wallet + economy)
- Route: direct PostgREST `INSERT`/`UPDATE` on `public.invest_holdings`
- Affected files: `supabase/migrations/0220_invest_ledger_write_lockdown.sql` (new), `tests/invest-ledger-write-rls.test.ts` (new)
- Role: **child / teen** — any authenticated family member
- Scenario: a signed-in child inserts an `invest_holdings` row for themselves, minting shares (portfolio value) without a parent-approved order
- Severity: **HIGH** (asset integrity; educational-investing portfolio value)
- Launch impact: the invest tables (`invest_holdings, invest_orders`) shipped (0097) with the same `"Members manage" … FOR ALL … is_family_member` policy as the wallet/economy bugs. `invest_holdings` is meant to be written only by the SECURITY DEFINER `invest_decide_order` RPC (a parent approves a pending order), but RLS let any member write it directly — a child could mint shares. Confirmed exploitable live.
- Root cause: write RLS on the invest ledger equalled read RLS (any family member).
- Resolution: migration **0220** restricts `invest_holdings` writes to `can_manage_family()` (the SECURITY DEFINER RPC bypasses RLS, so parent-approved orders still execute). **Exception**: `invest_orders` keeps INSERT open to members because a child legitimately places a *pending* buy/sell order (`placeInvestOrderAction`); only UPDATE/DELETE (approve/cancel) are manager-only.
- Supabase impact: RLS-only; additive + idempotent.
- Tests run: PG16 harness — child `invest_holdings` INSERT → RLS error; **child `invest_orders` placement → allowed** (RLS passed; only a NOT-NULL test-data column failed); idempotent ×2. Guard `tests/invest-ledger-write-rls.test.ts` (4); migration audit clean (next 0220).
- Validation evidence: harness transcript (holdings mint blocked, 0 survivors; order placement passed RLS).
- Commit: (this increment)
- Status: Fixed + pushed. **Prod exploitable until 0219 applied** (folded into pending-migrations; sibling of LB-010).
- **Money-ledger sweep COMPLETE:** all three family ledgers with the `is_family_member FOR ALL` write vuln are now locked to managers — wallet (0217/PLA-0580 CRITICAL), economy (0218/PLA-0590 HIGH), investing (0220/PLA-0600 HIGH). The other tables using the same 0070/0071/0072/0073/0081/0085/0101 FOR-ALL loop (vacations, weekend planner/feeds, habits, home management, autopilot, social feed) are **collaborative family data** where member writes are intended (like the calendar) — reviewed, not sensitive, left as-is.
- Remaining dependencies: apply 0220 to prod.

### PLA-0591 - A-11 PRIVACY (needs product decision): the family credential vault is readable by every member, incl. children

- Timestamp: 2026-07-17 12:05 UTC
- Service: Family Vault / credentials (A-11)
- Route: `family_credentials` reads (vault UI)
- Affected files: `supabase/migrations/0119_family_credentials.sql` (RLS), no code change yet
- Role: **child / teen** — any family member
- Scenario: a child reads the family credential vault (stored passwords / account logins / PII)
- Severity: MEDIUM (privacy) — **needs a product decision, not a unilateral fix**
- Launch impact: `family_credentials_select` is `is_family_member(family_id)` and the table has **no per-credential visibility / owner / sensitivity column**, so EVERY stored credential (which may include parents' bank/email/utility logins) is readable by EVERY family member including young children. This may be intended for a shared vault (e.g. the WiFi password), but a single flat "all members see everything" model is risky for sensitive adult credentials.
- Root cause: no visibility model on the vault.
- Resolution: **DEFERRED to a product decision** (do not silently restrict — some entries are meant to be shared). Recommended: add a `visibility` (family | managers | owner) or `min_role` column defaulting to managers-only, and scope the SELECT/UPDATE policies accordingly (owner/managers always; others only when visibility=family). Logged so it is not lost.
- Supabase impact: would be an RLS + column migration once the model is decided.
- Tests run: n/a (finding).
- Validation evidence: 0119 policy is `is_family_member` for select with no visibility column.
- Commit: (documentation)
- Status: OPEN — product decision required (owner-scoped vs. shared vault). Tracked for A-11 owner.
- Remaining dependencies: decide the visibility model; then a migration + UI control.

### PLA-0590 - A-08 economy: a child could MINT family currency via a direct currency_transactions insert

- Timestamp: 2026-07-17 12:05 UTC
- Service: Family Economy / tokens (A-08, sibling of the wallet ledger)
- Route: direct PostgREST `INSERT` on `public.currency_transactions`
- Affected files: `supabase/migrations/0218_economy_ledger_write_lockdown.sql` (new), `tests/economy-ledger-write-rls.test.ts` (new)
- Role: **child / teen** — any authenticated family member
- Scenario: a signed-in child inserts a `credit` into `currency_transactions`, minting tokens, then redeems them for parent-defined rewards
- Severity: **HIGH** (integrity of the reward economy; tokens redeem for screen time / treats / cash-outs — but not real money, unlike the wallet)
- Launch impact: the economy tables (`family_currencies, currency_transactions, economy_rewards, economy_redemptions`) shipped (0096) with the same `"Members manage" … FOR ALL … is_family_member` policy as the wallet bug (PLA-0580). Balance = Σ(credits−debits), so a child could mint unlimited tokens. Confirmed exploitable (same class as the wallet ledger).
- Root cause: write RLS on the economy ledger equalled read RLS (any family member).
- Resolution: migration **0220** restricts writes on the currency ledger + config + rewards to `can_manage_family()` (token AWARD is the manager-gated `awardTokensAction`; the token DEBIT goes through `decideRedemptionAction` (manager) or the `loyalty_redeem_reward` SECURITY DEFINER / service-role RPC). **Exception**: `economy_redemptions` keeps INSERT open to members because a child legitimately creates a *pending* redemption request (`requestRedemptionAction`); only its UPDATE/DELETE (approve/deny/fulfil) are manager-only.
- Supabase impact: RLS-only; additive + idempotent.
- Tests run: PG16 harness — child currency mint → RLS error; **child redemption request → OK** (exception preserved); manager award → OK; idempotent ×2. Guard `tests/economy-ledger-write-rls.test.ts` (4); `economy-ledger.test.ts` still green; migration audit clean (next 0219).
- Validation evidence: harness transcript (mint blocked, redemption request allowed, 0 survivors).
- Commit: (this increment)
- Status: Fixed in code + pushed. **Prod exploitable until 0218 applied** (folded into the pending-migrations list; sibling of LB-010).
- Remaining dependencies: apply 0220 to prod.

### PLA-0581 - A-11: the "Secure Vault" is a label-only bucket with no protection beyond standard family RLS — OPEN (product decision)

- Timestamp: 2026-07-17 00:25 UTC
- Service: Files / documents — "Secure Vault" (A-11)
- Route: `/dashboard/files/vault` (`FilesHubModule view="vault"`)
- Affected files: `components/modules/files-hub-module.tsx`, `app/(app)/dashboard/files/vault/page.tsx`, `documents` RLS (migration 0109)
- Role: any family member with the documents feature — including a **teen/child** login
- Scenario: a family moves a sensitive document (SSN, medical, legal, passport) into the "Secure Vault," reasonably believing it is more protected than "Shared Files"
- Severity: **P2** (misleading-security / trust — not a cross-family leak; family isolation holds)
- Launch impact: the "Secure Vault" is presented with a **Lock icon**, a "Secure" badge, and the copy "this file is added to the Secure Vault," strongly implying extra protection. In reality `is_secure` is just a **boolean column + a filtered view**: there is **no PIN, no re-auth, no role gate, and no encryption**. The vault page only calls `requireFeature('/dashboard/documents')` (a tier gate), and the `documents` RLS is uniformly `is_family_member(family_id)` for every op (PLA-0442) — so **any family member, including a child with a login, can open every "Secure Vault" file exactly like a shared file**. The lock iconography overpromises within-family confidentiality the product does not deliver
- Root cause: "Secure Vault" was built as a UI category (`is_secure` flag + view filter), never wired to any additional access control; the documents RLS makes no distinction between secure and shared rows
- Recommended resolution (product decision — flagged, not unilaterally changed, because whether a child *should* see vault docs is a genuine product choice, and any real gate is a prod-migration + behavior change):
  1. **Make it real** — gate `is_secure` documents behind manager access (RLS: `using (is_family_member(family_id) and (not is_secure or can_manage_family(family_id)))`) and/or a re-auth/PIN, so the Lock means something (mirrors the A-07/A-08/A-12 "children shouldn't have this access" fixes the other agents shipped); or
  2. **Be honest** — relabel to "Private Files"/"Personal" and drop the Lock/"Secure" framing so it doesn't imply protection it lacks
- Supabase impact: option 1 requires a new prod storage/RLS migration (human-owned)
- Tests run: static analysis — vault page has only `requireFeature`; module has no `isManager`/PIN/`can_manage` gate; documents RLS (0109) is uniform `is_family_member` across secure + shared
- Validation evidence: `app/(app)/dashboard/files/vault/page.tsx` → `requireFeature('/dashboard/documents')` only; `files-hub-module.tsx` toggles `is_secure` with no gate; `0109_documents_favorite.sql` policies use `is_family_member(family_id)` for all ops with no `is_secure` branch
- Commit: (documentation only — no code change; fix is a product decision)
- Status: **OPEN** — P2 trust finding flagged to owner (agent-03, A-11); not a formal launch blocker (no cross-tenant leak), but the "Secure Vault" naming should not ship as a security feature until option 1 or 2 is chosen
- Remaining dependencies: owner decision (real gate vs. honest relabel); if option 1, a prod RLS migration + a decision on whether children lose access to existing vault docs

### PLA-0580 - A-08 CRITICAL: any family member (incl. a child) could MINT money via a direct wallet_transactions insert

- Timestamp: 2026-07-17 11:45 UTC
- Service: Wallet / Bubaly Money ledger (A-08)
- Route: direct PostgREST `INSERT` on `public.wallet_transactions` (bypasses the app entirely)
- Affected files: `supabase/migrations/0217_wallet_ledger_write_lockdown.sql` (new), `app/(app)/missions/actions.ts` (auto-approve → service role), `tests/wallet-ledger-write-rls.test.ts` (new)
- Role: **child / teen** — any authenticated family member
- Scenario: a signed-in child POSTs `{family_id, direction:'credit', status:'completed', amount_cents:999999}` to `/rest/v1/wallet_transactions`
- Severity: **CRITICAL** (money integrity + privilege escalation — unlimited spendable funds)
- Launch impact: the wallet money tables (`family_wallets, child_wallets, wallet_buckets, wallet_transactions, wallet_rules`) shipped (migration 0088) with a single `"Members manage" … FOR ALL … USING/ WITH CHECK is_family_member(family_id)` policy. Spendable balance = Σ(completed credits − debits), so a child inserting a `completed` `credit` mints real money a Bubaly Issuing card would honour. Children have real Supabase sessions and the anon key is in the client bundle, so the manager-gated app actions were the ONLY barrier — RLS did not stop a direct write. **Proven live on the harness**: a child INSERT of a $9,999.99 completed credit succeeded (`INSERT 0 1`).
- Root cause: write RLS on the immutable financial ledger equaled read RLS (any family member).
- Resolution: migration **0217** keeps SELECT open to all members (a child views their own balance) but restricts INSERT/UPDATE/DELETE to `can_manage_family()` (parent/adult). Trusted server writes run with the service role and bypass RLS: allowance cron + Stripe/Issuing webhooks + the reserve-hold RPC were already service-role; the **chore auto-approve reward** was the one legitimate child-session write, so `submitProofAction` now routes `finalizeApproval` through `createServiceClient()` (the manual approve stays on the manager session).
- Supabase impact: RLS-only; no data/columns. **Additive + idempotent.**
- Tests run: PG16 harness — after 0217: child INSERT → "new row violates row-level security policy"; child SELECT → OK; manager INSERT → OK; service_role INSERT → OK; migration idempotent ×2. Regression: chore+wallet suites (6 files / 42 tests) green; `tsc` 0; eslint clean; new guard `tests/wallet-ledger-write-rls.test.ts` (4).
- Validation evidence: harness transcript (mint blocked, 0 survivors, manager+service writes succeed).
- Commit: (this increment)
- Status: Fixed in code + pushed to `main`. **⚠️ PROD REMAINS EXPLOITABLE UNTIL 0217 IS APPLIED** — see LB-010 (P0, human-owned).
- Remaining dependencies: apply 0217 to prod ASAP; consider moving ALL ledger writes to service-role-only as a follow-up.

### PLA-0551 - A-11 messages sub-surface verified tenant-isolated (tables + mark-read RPC), guarded

- Timestamp: 2026-07-17 00:15 UTC
- Service: Messages / Communications (A-11)
- Route: `/dashboard/messages` (Family Communications), `mark_conversation_read` RPC
- Affected files: `tests/a11-messages-rls.test.ts` (new static guard)
- Role: any member of family B attempting to reach family A's conversations/messages
- Scenario: confirm family messages are tenant-isolated at the DB layer and that the read-stamp RPC cannot bypass that isolation
- Severity: (verification of a CRITICAL invariant on the A-11 messages surface — no defect found)
- Launch impact: family conversations carry private messaging + attachments; isolation must hold at the DB layer and the RPC must not escalate. Verified + guarded so neither regresses
- Root cause: n/a (verification)
- Resolution: confirmed the messages contracts are sound —
  (1) `family_conversations` + `family_messages` (migration 0014): RLS enabled, `FOR ALL` scoped to `family_id in (select family_id from family_members where user_id = auth.uid())` — a member of family B cannot read or write family A's conversations/messages (collaborative within a family by design, isolated across families);
  (2) `mark_conversation_read` (migration 0163): declared **`security invoker`** (not definer) with a pinned `search_path = public` and only ever stamps the caller's own uid (`array_append(read_by, auth.uid())`), so it runs under the caller's family-scoped RLS and cannot mark-read another family's messages;
  (3) module write path already error-checked + storage orphan-safe (verified in PLA-0442/0461 context). Added `tests/a11-messages-rls.test.ts` pinning the table policies + the RPC's security-invoker contract
- Supabase impact: none (read-only verification); no schema change
- Tests run: `tests/a11-messages-rls.test.ts` (3 — conversations RLS, messages RLS, RPC security-invoker), plus my A-11 suite; the only red in the full run is the pre-existing `tests/display-render.test.ts` (agent-04 A-05, `React is not defined`), which is out of scope and unaffected by this change
- Validation evidence: guard asserts both tables' `family_id in (…family_members…auth.uid())` policy and that `mark_conversation_read` contains `security invoker` + `set search_path = public` and NOT `security definer`
- Commit: (this increment)
- Status: A-11 messages tenant-isolation Verified + guarded; A-11 unit remains In-progress (LB-009 public-read decision, live storage cross-family probe, ≥500 doc/message seed)
- Remaining dependencies: LB-009 owner decision; extend the A-03 live probe to `family_messages` + a storage object read

### PLA-0550 - A-12 defense-in-depth: manager-only WRITE RLS on family_places + guardian_routing_rules (migration 0215)

- Timestamp: 2026-07-17 00:20 UTC
- Service: Guardian / location safety (A-12)
- Route: n/a (RLS) — backs `/guardian/*` and `/dashboard/locator`
- Affected files: `supabase/migrations/0215_safety_write_rls_hardening.sql` (new), `tests/safety-write-rls-hardening.test.ts` (new)
- Role: child / teen (non-manager) attempting a direct write
- Scenario: even if an app-level gate is ever missed, a signed-in child hits the table directly via PostgREST
- Severity: (defense-in-depth for PLA-0470/0520 — hardens the DB layer under the app fixes)
- Launch impact: `family_places` (geofences → arrival/departure alerts) and `guardian_routing_rules` (call/message screening) shipped with `is_family_member` FOR ALL, so RLS alone did not stop a child write — the app gates (PLA-0470/0520) were the only barrier. 0215 keeps SELECT open to all members (a child's device must read geofences to detect arrivals) but restricts INSERT/UPDATE/DELETE to `can_manage_family()` (parent/adult). Service-role writes (AI learning) bypass RLS and are unaffected. member_locations (self-owned) and child chore_submissions are intentionally left alone.
- Root cause: original policies were `is_family_member` FOR ALL (write == read).
- Resolution: split into `*_select` (is_family_member) + `*_insert/_update/_delete` (can_manage_family). Additive + idempotent (`drop policy if exists` then create).
- Supabase impact: RLS-only; no data/columns. Migration is human-owned to apply to prod (agents cannot).
- Tests run: PG16 harness — 0215 applies clean (migration_fail=0); **proven live on family_places**: a child member reads 9 places but INSERT is rejected ("new row violates row-level security policy") and UPDATE/DELETE affect 0 rows, while a parent INSERT succeeds and no HACK/PWNED row survives. `guardian_routing_rules` uses the identical verified policy shape in the same migration. Static guard `tests/safety-write-rls-hardening.test.ts` (5) pins the policy shape; tsc/eslint clean.
- Validation evidence: harness output child insert→RLS error, update/delete→0 rows, parent insert→1 row, survivors=0.
- Commit: (this increment)
- Status: RESOLVED in code + pushed to `main`; **prod application is human-owned** (add to the pending-prod-migrations set).
- Remaining dependencies: apply 0215 to prod; optional column-aware restriction of chore_submissions status transitions.

### PLA-0520 - A-12/A-05 SECURITY: a child could delete/disable family geofences (location safety alerts)

- Timestamp: 2026-07-16 23:10 UTC
- Service: Location / geofences (locator) — safety (A-12; file under A-05 `dashboard/`)
- Route: `/dashboard/locator` (server actions `savePlace`, `deletePlace`, `setGeofenceEnabled`)
- Affected files: `app/(app)/dashboard/locator/actions.ts`, `tests/locator-places-authz.test.ts` (new)
- Role: **child / teen** (any non-manager family member with a login)
- Scenario: a child edits/deletes a shared `family_places` geofence, or toggles its geofence off
- Severity: **HIGH** (child-safety: silences arrival/departure alerts)
- Launch impact: `family_places` geofences drive "arrived at / left <place>" alerts to the family. Their RLS is `is_family_member(family_id)` FOR ALL (migration 0042), and the actions only called `requireUserContext()` — no role gate — so a child could delete the "School" geofence or disable its alerts, stopping the notifications watching them. Third instance of the cross-cutting authz pattern (see COORDINATION §3a; cf. PLA-0450 chores, PLA-0470 guardian).
- Root cause: missing server-side authorization on shared-config mutations.
- Resolution: gated `savePlace`/`deletePlace`/`setGeofenceEnabled` on `isManager(c.active.role)` before touching `family_places`. Deliberately left `updateMyLocation` and `setLocationSharing` self-service (a member posts their OWN location / controls their OWN sharing — not escalation).
- Supabase impact: none (app-layer authz). Follow-up: manager-scoped WRITE RLS on `family_places` as defense-in-depth.
- Tests run: `tests/locator-places-authz.test.ts` (5, new — asserts the 3 shared mutations gate AND the 2 self-only ones do not); tsc + eslint clean.
- Validation evidence: 5/5 green; gate precedes every `from('family_places')` write; self-only actions unchanged.
- Commit: `4a644cce`
- Status: RESOLVED and pushed to `main`
- Remaining dependencies: manager-scoped RLS on `family_places`; coordinate with A-05 owner (locator lives under `dashboard/`).

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
- Commit: `46556214` — migration `0216_family_media_bucket.sql` ships the reproducibility + write-isolation fix (step 1). PG16-validated: applies + idempotent (×2); cross-family write PROVEN blocked (family A member allowed into A's folder, blocked from B's); authenticated SELECT family-scoped. Guard test `tests/a11-family-media-bucket.test.ts`
- Status: **PARTIALLY RESOLVED** — bucket is now defined in version control with family-folder write RLS (fresh envs / the PG16 harness now work; cross-family writes blocked). **Read-privacy remains OPEN** under LB-009: the bucket is still `public` and consumers use `getPublicUrl`, so object URLs remain unauthenticated. The private+signed-URL switch is deferred because existing `family_photos`/`family_messages` rows store public URLs — flipping to private without a URL data-migration would break every stored link (owner decision)
- Remaining dependencies: owner decision on public→signed-URL + a data-migration of stored public URLs; human application of `0216` to prod (per PENDING_PROD_MIGRATIONS)

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


### PLA-0490 - Kitchen Display kiosk crashed on nullable strings → endless "Reconnecting…" loop

- Timestamp: 2026-07-16 22:25 UTC
- Service: A-05 Home / dashboard command surfaces (Kitchen Display kiosk)
- Route: `/display` (bubaly.com/display)
- Affected files: `lib/display/imagery.ts`, `components/display/display-grid.tsx`, `app/(app)/display/page.tsx`, `tests/display-render.test.ts`
- Role: any signed-in family member on the always-on kitchen screen
- Scenario: a family with a planned meal whose `meal_type` is null (nullable in `meal_plans`), or any member/recipe/event carrying a null string, opens `/display`
- Severity: P1 (launch blocker — a paid Family Basic surface was 100% down for the affected family, user-reported 3×)
- Launch impact: the kiosk never rendered; the client error boundary caught the throw and auto-retried every 15s forever (the "Reconnecting in Ns" screen)
- Root cause: React error boundaries CANNOT catch a throw during SSR, so a single `null.toLowerCase()` / `null.split()` in the client component's server render deterministically crashed the whole page on every retry. `mealImage()` did `mealType.toLowerCase()` unguarded (the prod-reachable culprit — `meal_type` is nullable); `display-grid` did `member.display_name.split(' ')[0]` (latent — column is NOT NULL, defense-in-depth).
- Resolution: `mealImage` → `(mealType ?? '').toLowerCase()`; `firstName()` helper for display_name; `display_name ?? 'Member'` coerced at the data source. Render is now provably total.
- Supabase impact: none (read-only render hardening; no schema/migration change). Follow-up data-integrity option: `family_recipes`/`meal_plans` nullable-string review.
- Tests run: new SSR reproduction harness `tests/display-render.test.ts` (9 cases via `renderToStaticMarkup`: normal · malformed dates · empty · null string fields · missing-member assignees · every widget + service tiles across all sizes · untrusted tiles jsonb · photos + all settings shapes · large+unicode) — the null-meal_type case reproduced the exact prod throw before the fix; tsc/eslint/build green
- Validation evidence: `tests/display-render.test.ts` (9/9), production build green, Vercel preview DEPLOYED
- Commit: `39e47f37` (+ prior `e92fd897`)
- Status: Resolved in code and pushed to `main`; deployed to Vercel
- Remaining dependencies: cross-cutting `.display_name.split(...)` / `.toLowerCase()` on nullable fields exists in ~20 other modules (school, sports, documents, messages, home, kids, family, briefing…) — broadcast to unit owners as a crash class (see COORDINATION §3b)

### PLA-0500 - Child could place outbound AI concierge calls (§3a authz gap)

- Timestamp: 2026-07-16 22:36 UTC
- Service: A-13 Vacations / travel / concierge
- Route: `/dashboard/concierge-calls` (server actions in `actions.ts`)
- Affected files: `app/(app)/dashboard/concierge-calls/actions.ts`, `tests/concierge-calls-authz.test.ts`
- Role: any signed-in family member, including a **child** (children have real Supabase logins)
- Scenario: the AI Concierge Calls feature places REAL outbound phone calls that book / reschedule / cancel / confirm appointments with real businesses on the family's behalf (and can incur telephony cost). `requestCallAction`, `cancelCallAction`, and `requeueCallAction` only called `requireUserContext()`; RLS on `concierge_calls` is family-scoped `is_family_member(family_id)` FOR ALL ops (migration 0173), so any member — including a child — could invoke the server action directly (the UI hiding the button is not authorization) and have the AI dial out on the family's behalf, cancel a family member's booking, or re-trigger a call.
- Severity: P1 (child-safety + real-world side effect + cost; same class as PLA-0450 chore self-approve and PLA-0470 guardian self-disable)
- Launch impact: unauthorized real-world actions and spend attributable to a child account
- Root cause: §3a cross-cutting pattern — state-changing family-scoped server action with `requireUserContext()` + family scoping but NO role gate; `cancelCallAction`/`requeueCallAction` did not even capture `ctx`.
- Resolution: import `isManager`; gate `requestCallAction`, `cancelCallAction`, and `requeueCallAction` on `isManager(ctx.active.role)` immediately after resolving context (parent/adult only). `applyConciergePlanAction` (manual "Make it happen" collaborative write into family calendar/tasks) left open by design; the autonomous concierge path (`executeQueuedRunAction`/`dismissQueuedRunAction`/`setConciergeAutopilotAction`) was already manager-gated.
- Supabase impact: none (server-action authorization; no schema/migration change). RLS unchanged (family-scoped, collaborative-by-design for reads).
- Tests run: new `tests/concierge-calls-authz.test.ts` (5 static guards: imports isManager · every captured-context action gated on the first executable line · no ungated `await requireUserContext();` · ≥3 guarded mutations · manager = parent/adult only) — 5/5 pass; tsc/eslint clean on touched files
- Validation evidence: `tests/concierge-calls-authz.test.ts` (5/5), `tsc --noEmit` exit 0, eslint clean
- Commit: pending (this push)
- Status: Resolved in code
- Remaining dependencies: A-13 unit not yet DONE — remaining: cross-family RLS proof on the PG16 harness for vacations/trips/concierge tables, live CRUD walkthrough, seed ≥500 rows for A-13 tables, trip-intel delete-action per-action judgment (`deleteTripPlanAction`/`deleteDeparturePlanAction` currently open to all members — collaborative planning, likely OK)

### PLA-0510 - A-15 AI assistants/chat/voice: auth + tenant + tool-authz VERIFIED, trust-gate locked

- Timestamp: 2026-07-16 23:04 UTC
- Service: A-15 AI assistants / chat / voice
- Route: `app/api/ai/*` (~30 routes), `lib/ai/*`, `lib/assistant/*`
- Affected files: `tests/assistant-trust-wrapper.test.ts` (new regression lock); verification only elsewhere
- Role: all family roles, incl. children (real logins) who can chat with the assistant
- Scenario: full read of the AI surface for auth, tenant isolation, cost/DoS controls, genuine wiring, and the §3a "child drives a privileged action" class — this time via the tool-executing chat assistant.
- Severity: n/a (no defect found; hardening lock added)
- Findings (VERIFIED):
  - Auth: every route resolves `requireUserContext()` except `POST /api/ai/gift`, which is **intentionally public** (unauthenticated gift-link giver) and correctly protected — per-IP in-memory + durable Postgres rate limit (5/min), bounded request body, token-scoped read, never writes.
  - Tenant isolation: data reads are family-scoped (`.eq('family_id', …)`) and backed by RLS; `wallet/child/[childId]` verifies the child wallet belongs to the caller's family before use.
  - Cost/DoS: consistent tier gate (`walletTier`/`aiCoachLevel`) + per-user rate limit + per-day metering + bounded request/response bodies across the AI routes.
  - Genuine wiring: `lib/ai/provider.ts` calls the real OpenAI API (`/v1/chat/completions`) via `fetchExternal`, with streaming, tool-calling, vision, bounded responses, and honest error classification (unconfigured/quota/auth/rate_limit/model/network). No mock/stub; unconfigured state fails honest (503/clear message).
  - Money routes (`ai/wallet`, `ai/wallet/child`, `ai/invest`) are READ-ONLY coaching/education (only write a `wallet_audit_logs` row) — no financial mutation.
  - **Tool authz (the key §3a surface):** the chat assistant executes real family tools, but `lib/assistant/trust-wrapper.ts` routes every WRITE tool through the family Trust & Permissions Engine (`evaluateTrust`) with the caller's role: `deny` → no write; `require_approval` → parent-approval request, no write; `allow` → execute. Read tools pass through. A child cannot drive a privileged write through the model.
- Resolution: no code change required. Added `tests/assistant-trust-wrapper.test.ts` (5 tests) to LOCK the invariant: deny blocks the write, require_approval defers (no write), allow executes with original args, read tools bypass trust, and every mapped write-tool name still exists in `tools.ts` (guards against a rename bypass).
- Supabase impact: none.
- Tests run: `tests/assistant-trust-wrapper.test.ts` 5/5; tsc/eslint clean on touched files.
- Validation evidence: 5/5 test pass; `tsc --noEmit` exit 0; eslint exit 0.
- Commit: pending (this push)
- Status: Verified; regression lock added
- Remaining dependencies (A-15 not yet DONE): live E2E with a real OPENAI_API_KEY (streaming + a real tool round + approval path); `admin/ai` settings-route authz (super-admin scope); voice transcribe/speak provider wiring + size limits review; prompt-injection review of tool arguments end-to-end.

### PLA-0520 - A-18 third-party sync: fail-closed + OAuth CSRF + token-crypto VERIFIED, VTODO lock added

- Timestamp: 2026-07-16 23:06 UTC
- Service: A-18 Third-party integrations (calendar/reminder sync)
- Route: `app/api/sync/*`, `lib/sync/*`, `lib/connections/*`
- Affected files: `tests/sync-apple-vtodo-failclosed.test.ts` (new); verification only elsewhere
- Role: authenticated family member connecting an external calendar account
- Scenario: audited the sync platform for the board's standing concern — "Apple VTODO / Gmail stubs must fail closed" — plus OAuth CSRF and token-at-rest security.
- Severity: n/a (no defect found; coverage-gap lock added)
- Findings (VERIFIED):
  - FAIL CLOSED end-to-end: `app/api/sync/run` returns **503** when `adapter.isConfigured()` is false; the registry filters unconfigured adapters out of the connectable surface; Apple/Microsoft providers are key-gated dark (`APPLE_SYNC_ENABLED`, `MICROSOFT_SYNC_CLIENT_ID/SECRET`) so no network call fires until an owner provisions.
  - Apple iCloud Reminders (VTODO) is an unfinished follow-up and fails closed honestly: `insertTask`/`patchTask`/`deleteTask` throw `SyncApiError(501)`, `defaultTaskListId()` returns null (engine disables task sync), `listTasks()` returns `[]` — no stub ever reports a fake success. (Calendar sync via CalDAV is fully implemented.)
  - OAuth CSRF: 32-byte CSPRNG state, provider-scoped `httpOnly` cookie, `timingSafeEqual` comparison; the callback validates `verifySyncOAuthState(returned, cookie)` BEFORE exchanging the code and clears the state cookie (single-use) on every exit. Refuses to store tokens without `SYNC_TOKEN_KEY` (`error=no_encryption_key`).
  - Token-at-rest: `lib/sync/crypto.ts` uses AES-256-GCM with a per-encryption random IV + auth tag; plaintext never lands in a column; tamper is detected (decrypt throws).
  - Genuine wiring: Google (REST + delta), Apple (CalDAV sync-collection), Microsoft (Graph + delta) adapters make real provider calls via `fetchExternal`; the pure mappers/parsers are unit-tested offline. No mocks in the shipped path.
- Resolution: no code change required. Added `tests/sync-apple-vtodo-failclosed.test.ts` (5 tests) to close the one coverage gap — the VTODO write path must throw 501 and the read path must advertise "no task sync". OAuth-CSRF and crypto-tamper were already locked (`tests/sync-oauth-csrf.test.ts`, `tests/sync-crypto.test.ts`).
- Supabase impact: none.
- Tests run: `tests/sync-apple-vtodo-failclosed.test.ts` 5/5; `sync-oauth-csrf` + `sync-crypto` + `sync-apple` 33/33; tsc/eslint clean.
- Validation evidence: 5/5 + 33/33 pass; `tsc --noEmit` clean; eslint exit 0.
- Commit: pending (this push)
- Status: Verified; regression lock added
- Remaining dependencies (A-18 not yet DONE): live OAuth round-trip with real provider keys (Google/Microsoft) in a staging env; token-refresh expiry path under real 401; conflict-resolution + dedupe correctness under a real two-way sync; feed-token (`app/api/sync/feeds/[token]`) rate-limit/abuse review.

### PLA-0530 - A-17 admin/marketing/social: platform-admin authz VERIFIED (every action re-gates), guard added

- Timestamp: 2026-07-16 23:12 UTC
- Service: A-17 Admin / marketing / social / content
- Route: `app/(app)/admin/**` (~28 action files, ~130+ server actions)
- Affected files: `tests/admin-authz-gate.test.ts` (new); verification only elsewhere
- Role: platform super-admin surface (oversees every family — users, families, billing, Stripe keys, bans, password resets, CRM, marketing, tiers)
- Scenario: verified the §3a "layout gates the render but the server action is directly invocable" class against the highest-blast-radius surface in the app — the site-admin console.
- Severity: n/a (no defect found; regression guard added)
- Findings (VERIFIED):
  - The `/admin` layout gates the whole segment: unauthenticated → `/login`, non-super-admin → `/dashboard`.
  - **Every admin server action re-verifies independently** (defense-in-depth, not layout-reliant) and fails closed:
    - `app/(app)/admin/actions.ts` (16 actions incl. create-user, create-family, set-super-admin, save-Stripe-settings, ban-user, password-reset) → local `assertSuperAdmin()` (`isSuperAdmin()` → early return) at the top of each.
    - `admin/marketing/**` (78 actions across 19 files) → `requireMarketingAdmin()` which is explicitly documented as "the layout gates /admin but actions must re-verify independently", does `getUser()` + `isSuperAdmin()`, and THROWS before returning the privileged client.
    - `admins`, `feedback`, `support-tickets`, `marketplace/reports`, `tier-features` → a local `guard()` wrapper calling `isSuperAdmin()`.
    - `services` (`resetServiceDescriptionAction`→`saveServiceDescriptionAction`) and `support-tickets` (`resolve/close/reopen`→`updateTicket`) gate transitively through a shared helper.
  - Whole-tree invariant confirmed: **0** admin action files touch the service-role client without also referencing a super-admin gate.
- Resolution: no code change required. Added `tests/admin-authz-gate.test.ts` (4 tests): every admin actions file using the privileged client must reference a super-admin gate; the layout gates the segment + redirects; `requireMarketingAdmin` enforces `isSuperAdmin` and throws. Guards against a new admin action file shipping without a gate.
- Supabase impact: none.
- Tests run: `tests/admin-authz-gate.test.ts` 4/4; tsc/eslint clean.
- Validation evidence: 4/4 pass; `tsc --noEmit` clean; eslint exit 0.
- Commit: pending (this push)
- Status: Verified; regression guard added
- Remaining dependencies (A-17 not yet DONE): admin API route handlers (`app/api/admin/**` if any) authz sweep; marketing PUBLIC surfaces (landing pages / forms / lead capture) input-validation + rate-limit review; social-post outbound integration wiring; live super-admin E2E.

### PLA-0540 - A-20 build/deploy gate GREEN; observability maturity gaps noted

- Timestamp: 2026-07-16 23:26 UTC
- Service: A-20 E2E / perf / observability / backups / deploy
- Route: whole-app production build + observability config
- Affected files: none (verification); temp build logs removed, not committed
- Role: deploy/ops
- Scenario: exercised the single most important launch gate — a clean `next build` — and swept the observability surface.
- Severity: n/a for the build (green); the observability items are launch-maturity dependencies, not code defects.
- Findings:
  - **Production build GREEN**: `npm run build` compiles all ~250 routes with `EXIT=0` (full route manifest emitted, middleware 91.3 kB, shared JS 103 kB). All agents' changes currently on `main` compile. (Note: this harness's piped/background invocations of the build spuriously fail with empty output — the build only succeeds/reports correctly when run foreground with output redirected to a file; the code itself is clean. `tsc --noEmit` and eslint are also green.)
  - Observability maturity gaps (dependencies for launch, owner decisions — NOT code bugs):
    - No centralized error monitoring (Sentry/Datadog): errors go to `console.error` → Vercel logs only; no aggregation/alerting. Only `lib/reasoning/context.ts` references capture-style handling.
    - No general platform health/readiness endpoint (only `app/api/ai/health` + `app/api/guardian/status`).
    - No centralized boot-time env-var validation; instead per-feature fail-honest (e.g. `SYNC_TOKEN_KEY` throws, `OPENAI_API_KEY` → honest 503) — acceptable but not a single startup guard.
- Resolution: no code change. Recorded the build-gate result and the observability dependencies for the launch-readiness report.
- Supabase impact: none.
- Tests run: production build (EXIT=0); tsc/eslint green; full vitest suite green earlier (1 timeout flake, passes isolated).
- Validation evidence: `npm run build` EXIT=0 with complete route manifest.
- Commit: pending (this push)
- Status: Build gate verified GREEN; observability items logged as dependencies
- Remaining dependencies (A-20 not yet DONE): wire centralized error monitoring (Sentry DSN — owner) ; add `/api/health` readiness probe; Playwright E2E smoke on the critical flows (login → dashboard → wallet → checkout) in staging; perf budget check on the heaviest routes; backup/restore runbook verification.

### PLA-0550 - A-19 mobile/responsive/a11y: primitives VERIFIED sound, Modal contract locked

- Timestamp: 2026-07-16 23:38 UTC
- Service: A-19 Mobile / responsive / a11y / browser
- Route: shared UI primitives + app-wide component layer
- Affected files: `tests/modal-a11y-contract.test.ts` (new); verification only elsewhere
- Role: all users (keyboard / screen-reader / mobile)
- Scenario: static a11y + responsive sweep of the shared primitives that determine the app's accessibility ceiling.
- Severity: n/a (no defect found; regression lock added)
- Findings (VERIFIED):
  - Root `app/layout.tsx` exports a proper `viewport` (themeColor, `initialScale: 1`, `viewportFit: 'cover'` for safe-area handling).
  - **0** raw `<img>` tags without `alt` across `app/` + `components/`; UI controls carry `aria-label` (e.g. avatar-picker, modal close).
  - The shared **Modal** (used app-wide) is a complete WAI-ARIA dialog: `role="dialog"` + `aria-modal` + `aria-labelledby`/`aria-describedby` (stable `useId`), focus moved in on open, **focus trap** (Tab/Shift-Tab wrap), **Escape** to close, focus **restored to the trigger** on close, background scroll-lock, labelled icon-only close button.
  - The Modal is also **mobile-responsive**: bottom-sheet on mobile (`items-end`) → centered dialog on desktop (`sm:items-center`), `env(safe-area-inset-bottom)` padding so the action row clears the home indicator, `max-h-[85dvh]` + `overflow-y-auto` sized to the dynamic viewport.
  - The app is mobile-first broadly: 362 files use `sm:`/`md:`/`lg:` responsive utilities; a brand-contrast contract test already guards text/solid-color reuse.
- Resolution: no code change. Added `tests/modal-a11y-contract.test.ts` (5 tests) locking the dialog a11y contract + the mobile bottom-sheet/safe-area/dvh layout against regression.
- Supabase impact: none.
- Tests run: `tests/modal-a11y-contract.test.ts` 5/5; existing `a11y.test.ts` + `brand-contrast-contract.test.ts` green; tsc/eslint clean.
- Validation evidence: 5/5 pass; eslint exit 0.
- Commit: pending (this push)
- Status: Verified; regression lock added
- Remaining dependencies (A-19 not yet DONE): LIVE browser a11y pass (axe/Playwright) on the top flows — needs the app running with real creds; keyboard-only walkthrough of forms/menus/toasts; screen-reader spot-check; visual responsive check at 320/768/1280 widths; reduced-motion honoring.

### PLA-0560 - A-19/A-20 LIVE E2E executed: public routes render + axe WCAG AA + responsive, 50/51 green

- Timestamp: 2026-07-17 00:06 UTC
- Service: A-19 (mobile/responsive/a11y) + A-20 (E2E/deploy)
- Route: all 12 public routes (`/`, `/pricing`, `/features`, `/how-it-works`, `/security`, `/faq`, `/ai`, `/mobile`, `/blog`, `/contact`, `/login`, `/signup`) + `/dashboard` auth redirect
- Affected files: none (executed the existing `tests/e2e/*.spec.ts` against a live Next server; no code change)
- Role: anonymous visitor (public surface)
- Scenario: FIRST live-browser verification this session — stood up `next start` (dummy Supabase env, per `scripts/run-e2e.mjs`) and drove real Chromium via Playwright. (This sandbox ships Chromium build 1194; the pinned @playwright/test 1.47 wants 1228 — ran through a throwaway local config pointing `executablePath` at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; the committed `playwright.config.ts` is unchanged for CI.)
- Severity: n/a (verification; no defect)
- Results (LIVE):
  - **public.spec.ts — 14/15**: all 12 public routes return <400 with a visible heading; `/pricing` billing toggle present; **`/dashboard` redirects an anonymous user to `/login`** (auth boundary proven live). The 1 miss is `page.goto('/')` waiting on the `load` event (default) timing out at 30s because the homepage requests external Unsplash/Supabase assets the sandbox network can't reach — the SAME route passes in 1.5s with `domcontentloaded`, so it is a sandbox-network artifact, not an app defect.
  - **accessibility.spec.ts — 24/24**: axe with WCAG 2.0/2.1/2.2 A+AA tags, reduced-motion, across all 12 routes in BOTH dark and light mode → **zero critical/serious violations**.
  - **overflow.spec.ts — 12/12**: no horizontal overflow (≤1px) on any public route at 320 / 390 / 768 / 1024 px widths.
  - Net: **50/51 live assertions pass**; the single failure is the documented sandbox-network `load`-event artifact.
- Supabase impact: none (dummy creds; server logged expected `ENOTFOUND example.supabase.co` on feature-tier reads, which is the point — public routes render without a DB).
- Tests run: `public.spec.ts` (14/15), `accessibility.spec.ts` (24/24), `overflow.spec.ts` (12/12) via `PLAYWRIGHT_SKIP_BUILD=1 npm run test:e2e` against the production build.
- Validation evidence: live Playwright/axe run output (above).
- Commit: pending (this push; doc only)
- Status: LIVE-verified for the public surface; a genuine DoD advance for A-19/A-20 (public routes)
- Remaining dependencies: authed E2E (login→dashboard→wallet→Stripe checkout) + authed-route axe/overflow still need a real Supabase test login (the spec files already note "extend PUBLIC_ROUTES → authed routes once CI has a Supabase login"); the homepage `load`-event check needs egress to Unsplash/Supabase (works in real deploy).

### PLA-0570 - A-13 cross-family RLS isolation PROVEN LIVE on the PG16 harness

- Timestamp: 2026-07-17 00:20 UTC
- Service: A-13 Vacations / travel / concierge
- Route: `public.vacations`, `public.concierge_calls` (RLS)
- Affected files: none (live DB verification via `docs/audit/verify-pg.sh`)
- Role: authenticated member of family A attempting to reach family B's rows
- Scenario: brought up the throwaway PG16 harness (all 216 migrations applied, migration_fail=0; SEED_ALL loaded), created a second tenant "family B" with its own vacation + concierge call as service-role, then ran every op AS family A's authenticated member under RLS.
- Severity: n/a (verification; isolation holds)
- Results (LIVE, run as family-A member under `set role authenticated` + anchor JWT):
  - READ: own vacations = 12 (visible); family B's vacation by id = **0**; unfiltered `select * from vacations` = **12** (own only — RLS silently scopes); family B's concierge call = **0**.
  - UPDATE family B's vacation → **0 rows** affected (RLS `USING` blocks; B's title still "B Secret Trip").
  - DELETE family B's concierge call → **0 rows** (still present).
  - INSERT a vacation carrying family B's `family_id` → **"new row violates row-level security policy for table vacations"** (WITH CHECK blocks; 0 rows injected).
  - Post-checks confirmed family B's data completely untouched.
- Supabase impact: none (throwaway local DB; no prod change). Faithful to prod: `authenticated` was granted table DML (as Supabase does) so the test exercised RLS, not a table-permission wall.
- Tests run: `verify-pg.sh up` (216 migrations, migration_fail=0) + scripted cross-family READ/UPDATE/DELETE/INSERT probe.
- Validation evidence: probe output above (READ 0 cross-tenant, UPDATE/DELETE 0 rows, INSERT RLS-rejected).
- Commit: pending (this push; doc only)
- Status: A-13 tenant isolation LIVE-PROVEN (complements the global PLA-0415 proof with unit-specific evidence). Corroborates that the `0070_vacations` loop policy + `0173_concierge_calls` per-op policies enforce the boundary in a real Postgres.
- Note: SEED_ALL emitted 2 non-blocking marketplace hand-off/returns seed errors (A-14; require two seeded members for the anchor family) — flagged for A-14's owner, unrelated to A-13.

### PLA-0580 - A-15 + A-18 cross-family RLS isolation PROVEN LIVE (incl. sync_tokens deny-all)

- Timestamp: 2026-07-17 00:32 UTC
- Service: A-15 (AI assistants) + A-18 (third-party sync)
- Route: `public.ai_conversations/ai_messages/ai_feedback`, `public.sync_*` (RLS)
- Affected files: none (live DB verification via `docs/audit/verify-pg.sh`)
- Role: authenticated member of family A reaching for family B's rows / the token store
- Scenario: same PG16 harness (216 migrations, migration_fail=0), a second tenant "family B" with its own AI conversation + message, then every op run AS family A's member under RLS.
- Severity: n/a (verification; isolation holds)
- Results (LIVE):
  - **Breadth (schema):** every family-scoped `ai_*` / `sync_*` table has RLS policies referencing family membership (`ai_conversations/ai_messages/ai_feedback` = 4 policies each; the 22 `sync_*` family tables = family-scoped), EXCEPT `sync_tokens`, whose single policy is `USING(false) WITH CHECK(false)` for ALL — a deliberate **deny-all to every client role**; only `service_role` (BYPASSRLS) can read/write the encrypted OAuth tokens. (`sync_providers` is a global registry with no `family_id`, correctly unscoped.)
  - **A-15 ai_messages (data):** as family A's member — read family B's message by id = **0**; unfiltered `select` returned only family A's own 8 seeded rows (family B's not among them); INSERT carrying family B's `family_id` → **"new row violates row-level security policy for table ai_messages"** (0 injected).
  - **A-18 sync_tokens (data):** as family A's member — `select count(*)` over the WHOLE table = **0** (deny-all: an authenticated user cannot see ANY token, even their own family's); INSERT a token → **"new row violates row-level security policy for table sync_tokens"** (0 injected). The encrypted-token store is unreachable from any client path — the strongest possible isolation for the secret store, matching PLA-0520's AES-256-GCM-at-rest finding.
- Supabase impact: none (throwaway local DB). `authenticated` was granted table DML (as prod) so the probe exercised RLS, not a grant wall.
- Tests run: `verify-pg.sh up` + policy-coverage query across all `ai_*`/`sync_*` tables + live READ/INSERT probe as family A.
- Validation evidence: probe output (cross-tenant reads 0; sync_tokens whole-table read 0; both INSERTs RLS-rejected).
- Commit: pending (this push; doc only)
- Status: A-15 + A-18 tenant isolation LIVE-PROVEN (complements PLA-0510/PLA-0520 static findings + the global PLA-0415).

### PLA-0600 - admin_users + support_tickets world-readable (RLS mis-scoped TO public) — FIXED in 0218

- Timestamp: 2026-07-17 00:52 UTC
- Service: A-17 Admin / support (cross-cutting tenant isolation, A-03)
- Route: `public.support_tickets`, `public.admin_users` (RLS)
- Affected files: `supabase/migrations/0219_admin_tables_service_role_rls_lockdown.sql` (new), `tests/admin-tables-service-role-rls.test.ts` (new), `tests/migration-version-safety.test.ts` (bump), `docs/PENDING_PROD_MIGRATIONS.md`, `docs/LAUNCH_BLOCKERS.md` (LB-011)
- Role: any signed-in user (`authenticated` via PostgREST)
- Discovery: the comprehensive PG16 tenant-isolation schema audit (every `family_id` table: RLS on? policy family-scoped?) surfaced tables with RLS on but policies not tied to family membership; classifying them found two with a `TO public USING(true)` policy.
- Scenario: migration 0010 created `support_tickets` and `admin_users` with the comment "RLS: only service-role (admin console) reads/writes" but wrote `create policy "service_role_all" ... using (true) with check (true)` with **no `to service_role`** → the policy defaults to `TO public`, so the `authenticated` role matches an always-true qual. Any signed-in user could `supabase.from('support_tickets').select('*')` → every family's tickets (requester name/email + issue body = cross-tenant PII), and `admin_users` → the full admin roster (emails, `admin_role`, `permissions`, `status`); `with check(true)` also allowed INSERT/UPDATE/DELETE of `admin_users` rows.
- Severity: P1 (cross-tenant PII disclosure + admin-roster exposure + admin_users tampering; not P0 — `admin_users` is not consulted in the request-path authz, which uses `super_admins`/`is_super_admin()`).
- Root cause: RLS policy missing its `TO service_role` role qualifier (same class as the 0215/0217 write-lockdowns; here it's a READ exposure).
- Resolution: migration **0220** drops + recreates both `service_role_all` policies `TO service_role` (client roles get no policy ⇒ default deny). The admin console reads/writes these only via `createServiceClient()` (service_role, BYPASSRLS) behind an `isSuperAdmin` gate, so no app behaviour changes. `meal_ideas` (global content catalog, no `family_id`) reviewed and intentionally public — not a leak.
- Supabase impact: **prod exploitable until 0218 is applied** (human-owned, LB-011). Agents do not apply prod migrations.
- Tests run: applied 0218 to PG16 (idempotent ×2); as family-A member support_tickets 11→**0**, admin_users 12→**0**, member INSERT into admin_users **blocked**, service-role still reads all 11 (console unaffected). `tests/admin-tables-service-role-rls.test.ts` (5) + migration-version bump → 8/8; tsc/eslint clean.
- Validation evidence: before/after harness probe (above); guard tests green.
- Commit: pending (this push)
- Status: Fixed in code (migration 0219 + guard); **prod apply pending (LB-011)**
- Remaining dependencies: apply 0220 to prod; re-run the isolation probe there.
- Remaining dependencies: apply 0219 to prod; re-run the isolation probe there.

### PLA-0610 - marketplace_place_bid_unchecked callable by authenticated → bid-as-any-family IDOR — FIXED in 0221

- Timestamp: 2026-07-17 01:10 UTC
- Service: A-14 Marketplace / auctions (found by agent-04 during the SECURITY DEFINER sweep; A-14 is agent-01's unit — flagged)
- Route: `public.marketplace_place_bid_unchecked(uuid,uuid,uuid,bigint)` RPC
- Affected files: `supabase/migrations/0220_revoke_place_bid_unchecked_from_authenticated.sql` (new), `tests/marketplace-bid-unchecked-revoke.test.ts` (new), `tests/migration-version-safety.test.ts` (bump), `docs/PENDING_PROD_MIGRATIONS.md`, `docs/LAUNCH_BLOCKERS.md` (LB-012)
- Role: any signed-in user (`authenticated`)
- Discovery: swept all 57 SECURITY DEFINER functions for ones taking a family/member id arg, executable by `authenticated`, whose body doesn't tie the arg to `auth.uid()`. Money/loyalty variants were service-role-only (safe); `marketplace_negotiation_offer` validates via `marketplace_member_id()` (safe); one was genuinely exposed.
- Scenario: 0184 hardened auction bidding — it RENAMED the raw `marketplace_place_bid` → `_unchecked` and added a CHECKED wrapper `marketplace_place_bid` that verifies `auth.uid()` owns `p_bidder_member_id`/`p_bidder_family_id` before delegating. It did `revoke all ... _unchecked ... from public` + `grant ... to service_role`. But a RENAME preserves the ACL, so the `authenticated` grant from 0183's original `grant execute ... to authenticated, service_role` rode onto `_unchecked`, and `revoke ... from public` does not drop a separate role grant. So `_unchecked` stayed executable by `authenticated`: a signed-in user could call it directly (SECURITY DEFINER = RLS bypass), passing ANY `p_bidder_member_id`/`p_bidder_family_id`, and place an auction bid attributed to another family — skipping every check in the wrapper.
- Severity: P2 (marketplace-integrity IDOR — bid/identity spoofing in auctions; not direct money loss, but can grief/manipulate auctions and attribute bids to other families).
- Root cause: function RENAME carried a role grant that the subsequent `revoke ... from public` did not remove (missing `revoke ... from authenticated`).
- Resolution: migration **0221** `revoke execute ... from authenticated` (+ re-assert public revoke, keep service_role). The checked `marketplace_place_bid` wrapper is SECURITY DEFINER — it calls `_unchecked` as the function owner, not the caller — so revoking the caller's grant does not affect the legitimate bid path; the app only ever calls the checked wrapper.
- Supabase impact: **prod exploitable until 0220 is applied** (human-owned, LB-012).
- Tests run: PG16 before/after — as a family-A member the direct `_unchecked` call was permitted pre-0221 and returned "permission denied" post-0221, while the checked wrapper still executes (returns its own `unauthorized` validation, not a permission error); idempotent ×2. `tests/marketplace-bid-unchecked-revoke.test.ts` (3) + migration-version bump; tsc/eslint clean.
- Validation evidence: harness before/after (above); guard tests green.
- Commit: pending (this push)
- Status: Fixed in code (0220 + guard); **prod apply pending (LB-012)**; **flagged to agent-01 (A-14 owner)** — PLA-0460 concluded bid/buy were "revoked from public", which was true but missed the surviving `authenticated` grant on the renamed `_unchecked`.
- Remaining dependencies: apply 0221 to prod; agent-01 to confirm no other renamed-RPC ACL carryover in A-14.

### PLA-0620 - SECURITY DEFINER function surface fully audited (57 funcs) — 1 bug (0221), rest CLEAN

- Timestamp: 2026-07-17 01:40 UTC
- Service: A-03 tenant isolation / A-14 marketplace / A-08 wallet (cross-cutting RLS-bypass surface)
- Route: all `public.*` SECURITY DEFINER functions (PG16 harness)
- Affected files: none (verification; the one fix shipped separately as 0221/PLA-0610)
- Role: `authenticated` / `public` callers of RLS-bypassing RPCs
- Scenario: complete audit of every SECURITY DEFINER function (they run as owner and bypass RLS) for: mutable search_path, caller reachability, and whether they validate `auth.uid()` / tie caller-supplied ids to the caller.
- Severity: n/a (audit; the single defect found was fixed in 0221)
- Results (all 57 SECURITY DEFINER functions):
  - **search_path: 57/57 SET** (`SET search_path TO 'public'`) — no search-path-injection surface.
  - **Trigger functions (8)** (`feedback_bump_*`, `handle_new_user/family`, `mark_model_dirty`, `marketplace_log_price_change`, `marketplace_offer_flip_pending`, `sync_log_change`): return `trigger`, invoked only by triggers — not directly exploitable despite the `authenticated` EXECUTE grant.
  - **Helper/read funcs** (`is_family_member`, `is_family_admin`, `can_manage_family`, `family_role`, `social_role_for`, `social_has_permission`, `marketplace_member_id`, `is_marketplace_circle_*`): compute the CALLER's own relationship to a given family/circle via `auth.uid()` — passing another family's id only reports the caller's (non-)membership. No leak.
  - **`public_stats`**: returns 3 global aggregate counts (families / active members / completed chores) — no PII, no per-family breakdown. Intentional.
  - **Action RPCs** (`wallet_decide_spend/allowance`, `wallet_approve_gift`, `wallet_fund_goal`, `wallet_transfer`, `economy_decide_redemption`, `invest_decide_order`, `guardian_review_suggestion`, `marketplace_buy_now/accept_offer/decline_offer/set_listing_status/negotiation_offer/negotiation_respond/create_circle/join_circle/leave_circle`): every one gates on `auth.uid()` — wallet fns additionally enforce `p_actor_id = auth.uid()` + `can_manage_family(p_family_id)`; economy/invest/guardian DERIVE the family from the record then `can_manage_family()`; marketplace fns tie the family/member param to the caller via `is_family_member(p_family)` / `marketplace_member_id()` / ownership. Caller cannot spoof family, member, or actor.
  - **service-role-only funcs** (`wallet_credit_child_ledger`, `wallet_reserve_card_auth`, `loyalty_award_points/redeem_reward/cancel_redemption`, `marketplace_close_auction`, `marketplace_place_bid_unchecked` [after 0221], internal helpers): not granted to `authenticated` — reachable only from server code via service-role, which validates first.
  - **The one defect**: `marketplace_place_bid_unchecked` was executable by `authenticated` (rename ACL carryover) → fixed in 0221 (PLA-0610/LB-012).
- Supabase impact: none (audit). No prod migration from this entry (the 0221 fix is tracked separately).
- Tests run: PG16 harness (216 migs) + full pg_proc audit (execute-privilege × search_path × body-auth-check) + per-function body review of every action RPC.
- Validation evidence: audit query output + per-function reads (this session).
- Commit: pending (this push; doc only)
- Status: SECURITY DEFINER surface VERIFIED clean (1 fixed defect). Broadcasting the two root-cause classes below.

### PLA-0630 - Storage buckets + storage.objects RLS audited; harness shim fixed to enforce it

- Timestamp: 2026-07-17 14:10 UTC
- Service: A-11 storage (files/documents/media) — cross-cutting isolation
- Route: `storage.buckets`, `storage.objects` policies
- Affected files: `docs/audit/verify-pg.sh` (shim: enable RLS + grant on storage.objects)
- Role: authenticated members uploading/reading family files
- Scenario: audited every storage bucket's visibility + the `storage.objects` RLS policies, then made the PG16 shim actually enforce them (it created `storage.objects` without RLS, so storage isolation was previously untestable).
- Severity: n/a for the policies (correct); see the prod-config verification item below (LB-013).
- Findings:
  - **Buckets**: `documents`, `chore-proof`, `marketing-assets` = **private** (family-scoped). `avatars`, `marketplace-photos`, `feedback-attachments` = **public** (intentional — avatars, listing photos, feedback images are meant to be shown). `family-media` = **public** = the already-tracked LB-009 (photos + message/reminder attachments served via unauthenticated URLs).
  - **Policies**: private-bucket read/write is scoped by `is_family_member((storage.foldername(name))[1]::uuid)` (folder[1] = family_id) — a member can only touch their own family's folder. Public-bucket writes are `auth.uid()::text = foldername[1]` (own folder). Design is correct.
  - **Live proof (PG16, after the shim fix)**: as a family-A member on the `documents` bucket (driver licenses / insurance / medical) — reads own doc = 1, reads family B's = **0**, unfiltered read = own only; upload into family B's folder → **"new row violates row-level security policy"**.
  - **Harness gap fixed**: Supabase enables RLS on `storage.objects` + grants DML to `authenticated` at project creation (NOT via a migration), so the app's storage policies rely on that platform default. The `verify-pg.sh` shim created `storage.objects` WITHOUT RLS, leaving every storage policy inert — storage isolation was unverifiable. Added `alter table storage.objects enable row level security` + the client-role grants to the shim; re-bootstrap is clean (migration_fail=0) and isolation now provable.
- Supabase impact: no schema change (harness-only). **Prod-config verification required (LB-013)**: because RLS-on-`storage.objects` is a Supabase platform default (not in migrations), a human must CONFIRM it is enabled in prod — if it were ever off, `documents`/`chore-proof`/private `family-media` objects (incl. driver licenses, insurance, medical) would be fully exposed.
- Tests run: PG16 clean bootstrap (216 migs, migration_fail=0) + storage.objects RLS on + live cross-family documents probe.
- Validation evidence: probe output above.
- Commit: pending (this push)
- Status: policies VERIFIED correct + now harness-provable; prod-config check flagged (LB-013); `family-media` public-read remains LB-009.

### PLA-0640 - Anonymous (pre-login) grant surface audited — CLEAN

- Timestamp: 2026-07-17 14:20 UTC
- Service: A-03 tenant isolation (pre-auth reach)
- Route: `GRANT ... TO anon` across migrations
- Affected files: none (verification)
- Role: `anon` (unauthenticated)
- Scenario: anything granted to `anon` is reachable WITHOUT login, so a sensitive grant there is a pre-auth leak. (The PG16 shim over-grants `anon` for bootstrap convenience, so this was audited from the migrations, which are the source of truth for real grants.)
- Severity: n/a (clean)
- Findings: explicit `anon` grants are only — `blog_posts` SELECT (public blog), `public_stats()` EXECUTE (3 global aggregate counts), `service_descriptions` SELECT (public service catalog copy). All intentional public marketing surfaces; none exposes family data. `rate_limit_hit()` was granted to anon in 0156 but **revoked from anon** in 0179 (`revoke execute ... from public, anon`), and `rate_limit_prune()` revoked from anon+authenticated — a prior hardening that holds. No family-scoped table or privileged RPC is granted to `anon`.
- Supabase impact: none. Real prod `anon` reach = the 3 public surfaces + RLS-gated tables where anon has an explicit grant (there are none for family data).
- Tests run: migration grant grep + cross-check against 0179 revokes.
- Commit: pending (this push)
- Status: Verified clean — no sensitive pre-auth grant.

### PLA-0650 - API route auth coverage swept (113 routes) — CLEAN

- Timestamp: 2026-07-17 14:30 UTC
- Service: cross-cutting (all `app/api/**` route handlers)
- Route: every `app/api/**/route.ts` (113 handlers)
- Affected files: none (verification)
- Role: all callers
- Scenario: swept every API route for a missing authentication/verification gate (an unauthenticated sensitive endpoint is a direct bypass of the whole app-layer authz model).
- Severity: n/a (clean)
- Findings: 108/113 matched a standard gate on the first pass; the 5 flagged were all correctly protected by a helper the initial grep didn't name:
  - `admin/marketing/email/send` + `admin/marketing/ai` → `requireMarketingAdmin()` (super-admin; the AI route also `enforceAIRateLimit`).
  - `cron/demo-cleanup` → `hasCronAuthorization(req)` → 401 (Vercel Cron secret).
  - `guardian/escalate/twiml` → `validateTwilioSignature` in production (401 otherwise), called in BOTH GET and POST — not an open text-to-TwiML reflector.
  - `health` → intentionally public liveness/readiness; returns only booleans / latency / the NAMES of missing env vars (never a secret value), bounded 3s DB probe, `no-store`.
  - The public-by-design `ai/gift` route (PLA-0510) remains IP-rate-limited + token-scoped + read-only.
- Supabase impact: none.
- Tests run: enumerate `app/api/**/route.ts` × auth-helper grep + per-file read of every candidate.
- Commit: pending (this push)
- Status: Verified clean — no unauthenticated sensitive endpoint; every route authenticates (user-context / super-admin / cron-secret / Twilio-signature) or is intentionally public with no sensitive data.

### PLA-0670 - SSRF sweep of outbound fetches; harden web-push endpoint against internal hosts

- Timestamp: 2026-07-17 14:40 UTC
- Service: A-16 notifications/push (found in the cross-cutting SSRF sweep; A-16 is agent-03's — flagged)
- Route: `app/api/push/subscribe`, `lib/server/push-request.ts`, `lib/server/push.ts`
- Affected files: `lib/server/push-request.ts` (+ `tests/push-endpoint-ssrf.test.ts`)
- Role: any signed-in user (registers a push device)
- Scenario: swept every server-side outbound `fetch`. `fetchExternal` is a timeout wrapper, NOT an SSRF guard — its model is FIXED-provider hosts (OpenAI/Twilio/FCM/GitHub/open-meteo/Graph), all developer-controlled URLs; `themealdb`/`weather` interpolate user input only into the query string of a fixed host; user-supplied URLs (ICS import) go through the separate `fetchPublicCalendarText` guard (PLA-0480). The one user/DB-controlled URL reaching a server fetch is the **web-push endpoint**: `push_devices.endpoint` is registered by the client and later fetched by the `web-push` library (`push.ts`).
- Severity: P3 (authenticated blind SSRF, defense-in-depth) — `parseHttpsEndpoint` already required `https:` + no credentials (blocking the classic `http://169.254.169.254` metadata vector), the fetch is POST-only with an encrypted body, and the response is never returned to the caller; but the host was unvalidated, so a user could register `https://10.0.0.1/…` etc. and make the server issue a blind request inward.
- Resolution: added `isPrivateOrReservedHost()` and reject any endpoint whose host is a private/reserved IP literal (RFC1918, 127/8, 169.254/16 incl. metadata, 0/8, 100.64/10 CGNAT, IPv6 ::1 / fc00::/7 / fe80::/10) or a local name (`localhost`, `*.local`, `*.internal`). Real push endpoints use public DNS hostnames, so legitimate registration is unaffected (existing `push-request` tests still pass; `updates.example.test` accepted). Residual: DNS-rebinding to a private IP would need resolve-time blocking at send — noted, out of scope for this pass.
- Supabase impact: none.
- Tests run: `tests/push-endpoint-ssrf.test.ts` (4) + existing `push-request` (4) green; tsc/eslint clean.
- Validation evidence: guard unit-checked across 11 hosts (public allowed, private/reserved/local blocked); registration of a private-IP endpoint now rejected.
- Commit: pending (this push)
- Status: Hardened. **Flagged agent-03 (A-16 owner).** `fetchExternal` fixed-host model + ICS guard confirm the rest of the SSRF surface is clean.

### PLA-0680 - Allowance cron could double-pay under concurrent runs — atomic claim added

- Timestamp: 2026-07-17 15:00 UTC
- Service: A-08 wallet / A-16 cron (found in the cron idempotency review; both agent-01/agent-03 units — flagged)
- Route: `app/api/cron/wallet-allowance` (`GET`)
- Affected files: `app/api/cron/wallet-allowance/route.ts`, `tests/allowance-cron-idempotency.test.ts`
- Role: scheduler (Vercel Cron) — no user reachability (CRON_SECRET-gated)
- Scenario: the allowance automation selects due `allowance_rules` (`next_run_on <= today`), then per rule advances `next_run_on` and credits the child wallet. The schedule "claim" was a BLIND update (`where id = rule.id and family_id = …`) — it matched a row unconditionally. If two invocations overlap (Vercel cron re-fire, a manual trigger alongside the schedule, or a run exceeding `maxDuration=60s` so the next fires while the first is mid-loop), BOTH read the rule as due, BOTH "claim" (the blind update succeeds for both), and BOTH call `creditChildWallet` → the child's allowance is paid twice for one period.
- Severity: P2 (money-integrity — duplicate credit; requires overlapping cron execution, no user path).
- Root cause: TOCTOU — the claim update lacked a predicate on the current schedule, so it wasn't exclusive.
- Resolution: make the claim atomic — add `.lte('next_run_on', today)` to the update and read the result with `.maybeSingle()`; if it matched no row (`if (!claimed) continue`), another overlapping run already advanced the schedule, so skip the credit. Now only one of two concurrent runs credits a given period. Rollback-on-credit-failure (restore the prior schedule) is unchanged.
- Supabase impact: none (no schema change; a conditional UPDATE). No migration.
- Tests run: PG16 proof — seeded a due rule, ran the conditional claim twice: CLAIM1 matched **1** row (advanced), CLAIM2 matched **0** (loser skips); the old blind update matched 1 in both. `tests/allowance-cron-idempotency.test.ts` (3) locks the predicate + skip; tsc/eslint clean.
- Validation evidence: harness claim1=1/claim2=0 (above); guard tests green.
- Commit: pending (this push)
- Status: Fixed. **Flagged agent-01 (A-08) + agent-03 (A-16).** Other crons reviewed: all CRON_SECRET-gated; notification/reminder crons are send-dedup (not money), lower risk — noted for their owners.

### PLA-0690 - Cron + webhook idempotency/replay review — 1 fix (allowance), rest verified

- Timestamp: 2026-07-17 15:10 UTC
- Service: A-16 cron / A-09 webhooks (cross-cutting)
- Route: `app/api/cron/**` (19 routes), `app/api/webhooks/**`
- Affected files: none beyond PLA-0680 (allowance); this entry records the review
- Role: scheduler / external webhook senders
- Scenario: reviewed every scheduled and webhook endpoint for authentication + idempotency (a re-fire / retry / replay must not double-process, especially money).
- Severity: n/a (the one defect, allowance double-pay, is PLA-0680)
- Findings:
  - **Auth**: all 19 cron routes gate on `hasCronAuthorization` (CRON_SECRET) → 401. Webhooks verify signatures (Stripe — agent-01 PLA-0409; Resend — Svix HMAC-SHA256 with a 5-min timestamp window + `timingSafeEqual`, fails closed without the secret) or CSRF state (OAuth callbacks).
  - **Money crons**:
    - `wallet-allowance` — FIXED (PLA-0680): the schedule claim was a blind update → double-pay under overlap; now an atomic `.lte('next_run_on', today)` claim with skip-on-miss.
    - `close-auctions` — SAFE: delegates to `marketplace_close_auction` (SECURITY DEFINER, `service_role`-only) which `SELECT … FOR UPDATE` the listing, **re-checks `status = 'available'` after locking** (returns `not_due`), and guards the settlement UPDATE with `where status = 'available'` — two overlapping runs cannot double-settle.
  - **Webhook idempotency**: `resend` dedups by event id (prior-event check + a UNIQUE-constraint claim → `{ duplicate: true }` on `23505`), so a replayed/concurrent delivery is a no-op. Exemplary.
  - **Other state crons** (`automations`, `autopilot-scan`, `journey-recovery`, `checkout-abandoned`, reminder crons): send notifications / run family automations via the trust engine + `family_automation_runs`; double-processing there is a message-dedup concern (not money) — noted for A-16 owner to confirm per-run dedup.
- Supabase impact: none (review; the allowance fix is a conditional UPDATE, no schema change).
- Tests run: per-route auth grep + reads of the two money crons + their RPCs + the resend verifier; the allowance atomic claim proven on PG16 (PLA-0680).
- Commit: pending (doc only)
- Status: Verified — cron/webhook auth + money-cron idempotency sound after the allowance fix. Flagged A-16 owner for the notification-cron dedup follow-up.

### PLA-0700 - Money-ledger data-integrity invariants VERIFIED on the harness

- Timestamp: 2026-07-17 15:20 UTC
- Service: A-08 wallet / economy / invest (data integrity)
- Route: `wallet_transactions`, `currency_transactions`, `invest_holdings`
- Affected files: none (verification)
- Role: n/a (structural invariants)
- Scenario: verified the money ledgers cannot represent impossible money — negative amounts, negative balances (overspend), or negative holdings — and that the constraints are DB-enforced (not just app-enforced), on the PG16 harness against the seeded data.
- Severity: n/a (clean; the one data-integrity defect this thread found — allowance double-pay — is PLA-0680)
- Findings (all hold):
  - **DB CHECK constraints (proven to bite):** `wallet_transactions` `CHECK (amount_cents >= 0)`; `currency_transactions` `CHECK (amount > 0)`; `invest_holdings` `CHECK (shares >= 0)` + `CHECK (avg_cost_cents >= 0)`. Attempting to INSERT a negative wallet amount or negative invest shares — even as the superuser (bypassing RLS) — is rejected with "violates check constraint", so no code path (RLS, RPC, or direct) can write impossible money.
  - **No negative balances (no overspend) in the seeded ledgers:** per-`(child_wallet, bucket)` completed-txn balances = 0 negatives; per-`(family, member)` economy balances = 0 negatives.
  - **Amounts are unsigned + direction-encoded:** `amount_cents >= 0` with a `direction` (credit/debit) column — no mixed-sign ambiguity; reversal is modeled explicitly via `reverses_id`.
  - **Write-time enforcement:** overspend is prevented by the reserve RPC's `FOR UPDATE` balance check (agent-01 PLA-0440), and non-manager credit-minting is blocked by the write-lockdown migrations 0217 (wallet) / 0218 (economy) / 0220 (invest) — "child mint → RLS error" (agent-01/03).
- Supabase impact: none.
- Tests run: PG16 constraint introspection + violation attempts (negative amount + negative shares both rejected) + balance-conservation aggregates across all three ledgers.
- Commit: pending (doc only)
- Status: Verified — the money ledgers are structurally sound (non-negative, conservation-safe, DB-enforced). Combined with PLA-0680 (allowance atomic claim) the money-cron + ledger surface is integrity-clean.

### PLA-0710 - Mass-assignment / input-validation sweep of the mutation surface — CLEAN

- Timestamp: 2026-07-17 15:30 UTC
- Service: cross-cutting (server actions + API mutations)
- Route: every `.insert/.update/.upsert({ ...x })` spread write (19 sites)
- Affected files: none (verification)
- Role: any authenticated user
- Scenario: a write that spreads a raw request body into a DB insert (`insert({ ...body })`) lets a user set fields they shouldn't (`family_id`, `created_by`, `role`, `status`, `id`) — mass assignment. Swept every spread-write for that.
- Severity: n/a (clean)
- Findings:
  - **Every spread object is a curated whitelist, not the raw body.** Automated check: for each `.insert/.update({ ...v })`, `v` is never assigned directly from `body`/`input`/`parsed`/`json`/`data` — 0 hits. Objects are built field-by-field from FormData pickers (`str(fd,'x')`, `num(fd,'x')`) or explicitly-validated inputs.
  - **Trusted fields are overridden after the spread:** family-scoped writes do `insert({ ...row, family_id: ctx.active.familyId, created_by: ctx.user.id })`, so an injected `family_id`/`created_by` in `row` can't win; updates additionally filter `.eq('family_id', …)`.
  - **Enum + numeric validation is consistent:** e.g. `trust/actions.ts` validates `capability`/`effect`/`subjectKind`/`approvalModel` against allowlists and clamps `required_approvals` → [1,5], `priority` → [0,1000]; money amounts are bounded by DB CHECKs (PLA-0700); request bodies are size-bounded (`readBoundedRequestJson`).
  - Admin-marketing spread-writes (`crm_contacts`, `case_studies`, …) are super-admin-only (`requireMarketingAdmin`) and set `created_by: actorId`.
- Supabase impact: none.
- Tests run: pattern sweep of all spread-writes + trace of each spread var's construction (auto/trust/locator confirmed field-picked) + automated raw-body-assignment check (0 hits).
- Commit: pending (doc only)
- Status: Verified clean — no mass-assignment; input validation (enum allowlists, numeric clamps, bounded bodies, trusted-field override) is consistent across the mutation surface.

### PLA-0720 - Seed-coverage census: wallet subsystem unseeded via SEED_ALL (flagship feature demos empty)

- Timestamp: 2026-07-17 15:40 UTC
- Service: A-08 wallet + A-02 seed baseline
- Route: `SEED_ALL.sql` coverage of the wallet/finance tables
- Affected files: none (finding; flagged to A-02/A-08)
- Role: any demo / fresh-environment family
- Scenario: censused per-table row counts for the anchor family after `SEED_ALL` on the PG16 harness, to find features that render EMPTY in a fresh env and to check the "≥500 rows per unit" DoD.
- Severity: P2 (launch/demo quality — flagship feature shows empty; A-08 unit DoD not met via the standard seed path)
- Findings:
  - **Total: 71,154 family-scoped rows for the anchor** — the overall ≥500 baseline is massively exceeded. Most "empty" tables are runtime-accrual by nature (logs, audits, `*_events`, sessions, webhooks, stripe_*, social_*, invites, push_devices) and are correctly empty in seed.
  - **But the WALLET subsystem is entirely unseeded via `SEED_ALL`:** `wallet_transactions`, `wallet_buckets`, `wallet_cards`, `wallet_rules`, `wallet_rewards`, `family_wallets`, `savings_goals`, `goals`, `rewards`, `reward_redemptions` = **0 rows for every family** (only `child_wallets` = 1). `SEED_ALL` has **0** `wallet_transactions`/`wallet_buckets` inserts. A demo family opening the Wallet sees an empty wallet — no buckets, no ledger, no goals.
  - **Root cause = the orphan-seed pattern (same class as A-13):** the wallet-model seeds exist as STANDALONE files never wired into `SEED_ALL` — `seed_wallet_ledger_one_family.sql`, `seed_wallet_one_family.sql`, `seed_finances_one_family.sql` (in_SEED_ALL = 0). `seed_finance.sql` IS in SEED_ALL but seeds the OLDER finance model, not the `wallet_*` tables. The orphan files are also **thin** (~6/2/27 tuples), so even wired in they wouldn't meet the ≥500-row DoD for A-08's tables. Five fragmented money-seed files (`seed_finance`, `seed_finance_hub_one_family`, `seed_finances_one_family`, `seed_wallet_one_family`, `seed_wallet_ledger_one_family`) indicate seed churn in this area.
- Supabase impact: prod demo/fresh-env wallets render empty if prod seeding runs only `SEED_ALL`.
- Resolution (owner — A-02/A-08, not done here): consolidate the wallet seed into `SEED_ALL` (or the harness runner) and expand to a realistic set (buckets per child, a conserving ledger, goals/rewards) reaching the ≥500-row unit DoD. Not fixed here — `SEED_ALL` is A-02's monolithic pipeline and the money-seed files need de-duplication first; unilaterally wiring a thin orphan in would collide and still miss DoD.
- Tests run: PG16 census (per-family_id table counts) + orphan-seed grep + SEED_ALL wallet-insert count (0).
- Commit: pending (doc only)
- Status: FLAGGED to A-02 (seed) + A-08 (wallet). Related: A-13 seed thinness (PLA-0500 remaining dep) is the same orphan-seed class.

### PLA-0700-CORRECTION - conservation claim was over an empty wallet ledger

- Timestamp: 2026-07-17 15:40 UTC
- Correcting PLA-0700: its "no negative bucket balances / no overspend in the seeded ledger" result for `wallet_transactions` was **VACUOUS** — `wallet_transactions` is unseeded (0 rows, see PLA-0720), so the balance aggregate summed an empty set. This is retracted to avoid overclaiming.
- **Still valid from PLA-0700** (data-independent): the DB CHECK constraints were proven to BITE — inserting a negative `wallet_transactions.amount_cents` and negative `invest_holdings.shares` were both rejected with "violates check constraint" even as superuser. So negative money remains structurally impossible on every code path; only the empirical "seed has no negative balances" sub-claim was vacuous. `currency_transactions` conservation (economy) did run over seeded rows (non-vacuous). Live overspend prevention remains covered by the reserve-RPC FOR UPDATE proof (agent-01 PLA-0440).

### PLA-0730 - Systemic SEED_ALL coverage gap: core day-to-day family features demo empty

- Timestamp: 2026-07-17 15:50 UTC
- Service: A-02 seed baseline (cross-cutting; affects A-05/07/08/10/12 demo quality)
- Route: `SEED_ALL.sql` coverage
- Affected files: none (finding; LB-014 for A-02)
- Role: any demo / fresh-environment family
- Scenario: extended the PLA-0720 census — checked whether the high-visibility empty feature tables are seeded in `SEED_ALL` and/or have an orphan standalone seed.
- Severity: P2 (launch/demo quality — several flagship day-to-day features render empty)
- Findings — two classes, both `SEED_ALL_inserts = 0`:
  - **Genuinely unseeded (no seed anywhere — 0 in SEED_ALL, 0 orphan files):** `school_events`, `sports_events`, `medical_profiles`, `medication_schedules`, `routine_templates`, `grades`, `home_assets`. These demo completely empty (School, Sports, Health/Meds, Routines, Grades, Home sections).
  - **Orphaned (a standalone seed exists but isn't wired into SEED_ALL):** the wallet subsystem (PLA-0720), `savings_goals`/`goals` (2 files), `family_reminders` (4 files), `maintenance_tasks` (2), `rewards` (1), `nutrition_logs` (1). Data exists; the pipeline just doesn't load it.
  - Context: the anchor family still has 71,154 rows (PLA-0720) — SEED_ALL richly seeds the "pillar"/content tables but misses many core day-to-day surfaces. This is the orphan-seed class seen in A-13 (vacations) generalized across the app.
- Supabase impact: prod demo/fresh-env families see empty School/Sports/Health/Routines/Wallet/Reminders/Home if prod runs only `SEED_ALL`.
- Resolution (owner — A-02): (1) wire the existing orphan seeds into `SEED_ALL` (or the runner) after de-duplicating the fragmented money-seed files; (2) author seeds for the genuinely-unseeded features; (3) target the per-unit ≥500-row DoD. Not done here — `SEED_ALL` is A-02's monolithic pipeline and this is a baseline-wide effort, collision-prone to touch mid-audit.
- Tests run: per-feature `SEED_ALL` insert-count + orphan-seed-file count on the checkout.
- Commit: pending (doc only)
- Status: FLAGGED to A-02 as LB-014. Directly addresses the directive's "validate empty states" + "≥500 relational records" gates for the affected units.

### PLA-0740 - Wallet ledger seed repointed to a reproducible family (was pinned to a prod UUID) — VERIFIED 500 rows conserving

- Timestamp: 2026-07-17 16:00 UTC
- Service: A-02 seed / A-08 wallet
- Route: `supabase/seed_wallet_ledger_one_family.sql`
- Affected files: `supabase/seed_wallet_ledger_one_family.sql`
- Role: demo / fresh-environment family
- Scenario: root-caused WHY the wallet seed is orphaned (PLA-0720/LB-014) and made it reproducible.
- Severity: fix for the LB-014 wallet slice
- Findings + fix:
  - Root cause: the seed hardcoded `v_fam := '92298eb2-1a9e-4bdc-9361-677b6c01b499'` — the REAL prod family id of newworldventurellc@gmail.com. That family does not exist in the SEED_ALL baseline / the PG16 harness / any fresh env, so applying the seed **FK-failed** (`family_wallets_family_id_fkey`). That is why it was never wired into SEED_ALL — it only worked against prod.
  - Fix: resolve `v_fam` at runtime — the seed account's family (`families.created_by = v_uid`), else the first family with a non-manager (child/teen) member, else any family; skip cleanly if none. Also de-hardcoded the trailing VERIFY query. No literal family UUID remains.
  - **Verified on a clean PG16 harness (no manual repoint):** applies with no errors, idempotent ×2, seeds **500 `wallet_transactions`** for the resolved family across 4 buckets, and the **completed-ledger conserves — 0 negative bucket balances** (this also retires the vacuous PLA-0700 wallet-conservation check: now proven on real 500-row data).
- Supabase impact: none (standalone seed; not wired into SEED_ALL here).
- Tests run: clean-bootstrap harness apply (500 rows, conserving, idempotent).
- Commit: this push.
- Status: wallet seed is now REPRODUCIBLE + verified. **Remaining for LB-014 (A-02):** wire it (and the other orphan seeds) into the SEED_ALL / harness pipeline, and author seeds for the genuinely-unseeded features (school/sports/medical/routines/grades/home). This fix de-risks the wallet slice — it's ready to wire.

### PLA-0750 - Systemic root cause of the orphan seeds: ~20 `*_one_family.sql` all pinned to one prod family UUID

- Timestamp: 2026-07-17 16:20 UTC
- Service: A-02 seed baseline (LB-014 orphan-seed slice)
- Route: `supabase/seed_*_one_family.sql`
- Affected files: `seed_chores_one_family.sql` fixed (+ `seed_wallet_ledger_one_family.sql` in PLA-0740); ~18 remaining flagged for A-02
- Scenario: after fixing the wallet seed (PLA-0740), checked whether the same hardcoded-prod-UUID root cause explains the whole orphan-seed set.
- Severity: root-cause for LB-014's orphan slice
- Findings:
  - **~20 rich `*_one_family.sql` seeds ALL hardcode the same literal family id `92298eb2-1a9e-4bdc-9361-677b6c01b499`** — the real prod family of `newworldventurellc@gmail.com`. That family isn't in the SEED_ALL baseline / harness / any fresh env, so every one of them FK-fails off-prod. This single root cause is why the whole set is orphaned (chores, meals, finances, memories, location, tasks, messages, family, safety, life-events, roles, voice, files, group-decisions, operating-index, ai-feedback, experience-audits, meals-extras, finance-hub, …). Together they seed hundreds of rows across most day-to-day features.
  - **Fixed + PG16-verified (2 of ~20):** `seed_wallet_ledger_one_family` (500 conserving txns, PLA-0740) and `seed_chores_one_family` (30 chores + 500 assignments) now resolve the family reproducibly and apply cleanly + idempotently on a fresh harness.
  - **Recipe for the remaining ~18 (A-02):** in each DO block — (1) change `v_fam uuid := '92298eb2…';` → `v_fam uuid;`; (2) right after `begin`, resolve `select id into v_uid … v_email` then `v_fam` via `families.created_by = v_uid` → first family with a non-manager member → any family, with a `raise notice … return` if none; (3) delete any pre-`v_fam`-resolution `if not exists(family where id = v_fam) … raise` guard (now subsumed by the fallback chain); (4) de-hardcode the trailing VERIFY query's `family_id = '92298…'` filter (use the seed's `metadata`/`instructions` tag). Apply each on `verify-pg.sh` to confirm row counts before wiring into the pipeline.
- Supabase impact: none (standalone seeds; still need pipeline wiring — LB-014).
- Tests run: grep census (all 20 hardcode the UUID) + harness apply of the 2 fixed seeds.
- Commit: this push.
- Status: root cause identified + 2 seeds fixed/verified + recipe provided. Remaining ~18 repoints + pipeline wiring = A-02 (LB-014).

### PLA-0755 - Orphan one-family seeds: 4 more repointed + verified (6 of ~20 now reproducible)

- Timestamp: 2026-07-17 16:30 UTC · Service: A-02 seed (LB-014)
- Applied the PLA-0750 recipe (uniform variant: resolve `v_fam` in the DECLARE via a `coalesce(email-family, first-child-family, any-family)` subquery, so the pre-existing family-exists guard just validates it — no code-move/guard-removal) to `seed_tasks`, `seed_files`, `seed_ai_feedback`, `seed_experience_audits`.
- PG16-verified on a clean bootstrap: all 4 apply with no errors + idempotent ×2; `ai_feedback` seeds **600** rows and `experience_audits` **540** (both exceed the ≥500 DoD); `tasks`/`files` apply clean.
- **6 of ~20 orphan `*_one_family.sql` seeds now reproducible + verified** (wallet, chores, tasks, files, ai_feedback, experience_audits). Remaining ~14 (incl. high-inline-ref ones: operating_index, finances, memories, meals, location, life_events, group_decisions) follow the same recipe — A-02 to finish + wire into the pipeline (LB-014). The uniform coalesce-in-DECLARE variant is the safest bulk approach (no guard handling needed).
- Commit: this push.

### PLA-0760 - Orphan one-family seeds: batch-repointed 13 more (19 of 21 now reproducible); 2 pre-existing enum bugs found

- Timestamp: 2026-07-17 16:40 UTC · Service: A-02 seed (LB-014)
- Applied the uniform coalesce-in-DECLARE reproducibility fix to the remaining pinned seeds and verified each on a clean PG16 harness (apply + idempotent; auto-reverted any that errored).
- **13 more fixed + verified:** family, family_safety, finances, group_decisions, life_events, location, meals_extras, meals, memories, messages, roles, voice, wallet_one. Sample real row counts: meals `meal_plans`=**1022**, memories=**540**, voice_commands=**500**, life_event_plans=44. All idempotent.
- **Total: 19 of 21 orphan `*_one_family.sql` seeds now reproducible + verified** (this batch + PLA-0740/0750/0755).
- **2 NOT fixed — pre-existing enum-cast bugs (independent of the repoint), flagged to A-02:** `seed_finance_hub_one_family.sql:63` — `column "status" is of type bill_status but expression is of type text`; `seed_operating_index_one_family.sql:148` — `column "category" is of type event_category but expression is of type text`. These seeds fail to apply anywhere (need `::bill_status` / `::event_category` casts) — reverted my repoint on them so they don't mask the real bug.
- Supabase impact: none (standalone seeds; still need pipeline wiring — LB-014).
- Tests run: batch apply on the harness (17 clean, 2 reverted on pre-existing enum bugs) + row-count spot checks + idempotent re-apply.
- Commit: this push. Status: LB-014 orphan slice ~90% de-risked (19/21 reproducible + verified); remaining for A-02 = fix the 2 enum-cast seeds, then wire all into the SEED_ALL/harness pipeline.
