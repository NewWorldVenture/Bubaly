# Market Domination Strategy — parallel work queue

This file exists so that several agents (Claude, Codex, anyone else) can work the
2026 strategy at the same time without colliding, and without needing the
conversation any of the earlier work happened in.

Everything here is derived from `docs/MARKET_DOMINATION_AUDIT.md`, which is the
authority: it verified all 60 strategy items against the code, item by item,
with an adversarial pass over every "this already exists" claim. Each section
below carries the audit's own gap, build plan, file list and acceptance test.
When this file and the audit disagree, the audit wins.

---

## 1. How to claim a section

**The branch name is the claim, and it is atomic.** Before starting section
`S-07`:

```bash
git fetch origin
git checkout -b claude/strategy-S-07 origin/claude/roadmap-implementation-ld8bon
git push -u origin claude/strategy-S-07          # this is the claim
```

If that push is rejected because the branch already exists, someone has the
section. Pick another. Do not race it, and do not push to a branch you did not
create.

Branch off `claude/roadmap-implementation-ld8bon`, not `main` — that branch is
the integration point for this whole effort and already carries the sections
listed as landed below. Open your PR against it, not against `main`.

One section per branch. A section is sized to be a single reviewable PR.

## 2. What "done" means

A section is done when all of these hold:

- `npx tsc --noEmit` is clean.
- `node scripts/i18n-gate.mjs` passes and `node scripts/i18n-scan.mjs --list app components` reports **0**.
- `npx vitest run <your test files> tests/i18n-server-boundary.test.ts` passes, and no existing test was weakened, skipped or deleted.
- `npx eslint <your changed files>` is clean.
- Your PR is open against `claude/roadmap-implementation-ld8bon` and its CI is green.

Run the fast checks before you push. A push that turns CI red costs everyone a
cycle.

## 3. Rules that are not negotiable

These come from the repository owner and from the strategy's own "what I would
NOT do" list. A section that breaks one of them will be sent back.

**Never add a migration.** Not to `supabase/migrations`, not anywhere. Several
sections want schema and cannot have it: build everything that does not need it,
say in your PR exactly which DDL you would need, and leave a `TODO` in the code
naming it. The pending asks are in §6 of this file. Only the repository owner
adds migrations, and only the owner applies them to production.

**Never touch the shared app sidebar.** `components/app/app-shell.tsx`
(`SidebarBody`), `components/app/free-tier-sidebar.tsx`,
`components/app/nav-shared.tsx`, and the nav exports in
`lib/constants/navigation.ts` (`PRIMARY_NAV`, `APP_NAV_GROUPS`, `CURATED_*`,
`SIDEBAR_FOOTER_NAV`, `NAV_CATALOG_*`, `DEFAULT_SIDEBAR_NAV_KEYS`) must come out
of your diff byte-identical. New in-app routes are reached by links from related
pages and cards. `MARKETING_NAV` is the one exception and belongs to the
public-site sections only.

**Never claim Bubaly did something unless a row says so.** A "handled", a
"sent", a "booked", a "called" must be read from persisted state — a run, a
ledger row, a provider confirmation. No inert buttons. No optimistic copy. If
the provider has not confirmed, the UI says what is actually true ("queued for a
call"), and a test pins that vocabulary.

**A failed read fails closed.** Every Supabase read that errors must
`console.error('[namespace] … read failed', error)` and render a retryable error
state. Never a reassuring empty state, never a zero — "nothing" and "the
database did not answer" are different facts and the UI must not conflate them.

**Every user-visible string is a catalogue key.** Server components use
`await getTranslations()` from `@/lib/i18n/server`; client components use
`useTranslations()` from `@/components/i18n/locale-provider`. A server-rendered
module may not call `useTranslations()`; a client module may not import
`lib/i18n/server` (`tests/i18n-server-boundary.test.ts` enforces both). Add the
English to `lib/i18n/messages/en-US.json` with keys sorted, then all six base
catalogues (de, es, fr, it, nl, pt) via `node scripts/i18n-apply.mjs <patch.tsv>`
— TSV columns `english\tde\tes\tfr\tit\tnl\tpt`. Register: German *Sie*, French
*vous*, Portuguese formal; Spanish *tú*, Italian *tu*, Dutch *je*. Proper nouns
(Bubaly, Cozi, FamilyWall, Skylight, iPad, Google, Apple, Microsoft, "Kitchen
Mode") stay invariant, and every `{placeholder}` must survive translation.
Module-level data arrays keep an English `label` plus a `labelKey`.

**Writes go through the service layer.** `lib/services/<domain>/index.ts`, taking
a `ServiceScope` and returning a `ServiceResult`. Anything the assistant
proposes is approval-gated through the existing `runAction` / `gateAiAction` /
`approval_requests` spine. Do not bypass trust gating.

**Tests are part of the change, not a follow-up.** Prefer pure functions tested
directly; use `tests/helpers/in-memory-supabase.ts` (`createInMemorySupabase`)
where a read boundary needs proving. `tests/reasoning-context-read-boundary.test.ts`
is the pattern to copy.

**No model names** in commit messages, PR titles or bodies, or code comments.

## 4. Shared files, and how to avoid fighting over them

Most sections are disjoint. These files are not, and several sections must each
add a line to them. **Make the smallest additive change** — one import, one array
entry, one key block — and never reformat or reorder the file. A union merge is
then trivial; a reflow is not.

| Shared file | What sections add | Merge rule |
|---|---|---|
| `lib/i18n/messages/*.json` (7) | new keys | union; keep keys sorted; never edit another section's value |
| `lib/ai/tools/registry.ts` | one import, one spread in the registration loop | keep both sides |
| `lib/ai/planner/templates/index.ts` | one import, one map entry | keep both sides |
| `lib/ai/context/intents.ts` | one `IntentKey`, one `INTENT_KEYS` entry, one `INTENT_SLICES` entry | keep both sides — and if you add a **slice**, add it to `chief_of_staff` too, which loads every slice by definition |
| `lib/intent/detect.ts` | one classifier branch | keep both sides |
| `lib/briefing/build.ts` | one slice on `BriefInput` / `Brief` | additive only; do not restructure the builder |
| `lib/home/today.ts` | one field on the completed/today shapes | additive only |
| `components/modules/trust-module.tsx`, `app/(app)/dashboard/trust/page.tsx` | one mount line for your own component file | put your UI in its own file; one line here |
| `app/(app)/home/page.tsx` | one card or one prop | additive only |
| `lib/services/notifications/index.ts` | one option on `notify()` | additive only |

If you find a genuine conflict in behaviour rather than in text — two sections
changing the same logic in incompatible ways — stop and say so in your PR rather
than picking one.

## 5. Status

### Landed on `claude/roadmap-implementation-ld8bon`

| Item | What |
|---|---|
| M4 | Daily Brief leads with decisions; viewer-role gate; morning delivery |
| M5 | `/dashboard/needs-you`, uncapped, plus three new decision sources |
| M8 | Schedule intelligence: prep, leave-by, driver, vehicle, dinner, care |
| M7 | Autopilot learns narrow tag-scoped policies from repeated approvals |
| M1 | Chief of Staff: `replanRun` wired into the executor, generic template |
| M6 + M35 | Handled ledger shows tool and reason; family run-history page |
| M26 (part) | Call queue claims nothing the row does not persist; `compareQuotes` |
| M36 (part) | TOTP, AAL2 step-up, Privacy Center export |
| M11 | Family CFO: plan-aware forecast, affordability scenario |
| M13 + M14 | Inventory and moving as assistant tools; `plan_move` template |
| M21 | Every notification is actionable; the quiet half folds into "Also today" |
| M24 | Trust Center Activity tab: tool-call ledger, dials, what was read and withheld |
| W1–W8 (part) | Public site stage 1: outcome-first homepage, `MARKETING_NAV`, footer, the Bubaly-Handled proof band, the hero-outcomes rail, and the first-brief / decisions / kitchen-mode / switching / social-proof bands |

Also on the branch: `docs/MARKET_DOMINATION_AUDIT.md`, and a build change that
moves the type-check out of the `next build` worker (it shared a heap with
webpack and was dying at 4,471 MB against a 4,096 MB cap; standalone it peaks at
1,082 MB — CI now builds first, then type-checks, which is what keeps
`.next/types` route coverage).

### Available now

Every section in §7 is available unless a branch `claude/strategy-<ID>` already
exists on the remote. Twenty sections, sized so that each is one reviewable PR.

One caveat before you claim: **S-19 and S-20 build on public-site stage 1**,
which has landed. Its shared libraries — `lib/marketing/hero-outcomes.ts`,
`trust-copy.ts`, `handled-sample.ts`, `reputation-server.ts`, and the handled
fields on `stats.ts` / `format.ts` — already exist; use them rather than
inventing parallel ones, and do not rewrite the homepage or the bands.

The **M36 deletion-request flow** is the one part of that item left and needs
the `account_deletion_requests` migration in §6; everything else in M36 (TOTP,
AAL2 step-up, the Privacy Center export) has landed.

### Blocked until the owner approves a migration

The parts of M2, M20, M9, M3, M6 (undo), M10 (budget), M16, M21 (priority
column), M23 (RLS), M24 (access log), M26 (service tables), M27, M32, M33 (RPC),
M36 (deletion requests), and the north-star metric snapshots. Each section below
says which of its parts are in scope without a migration; the DDL is in §6.

## 6. Migration asks — owner approval required, none has been added

These are consolidated so that related columns arrive together rather than one
migration per feature. Nothing in this list may be created by an agent.

- M2 + M20 + M9 (ONE migration): family_inbox_messages add request_id uuid → ai_requests, handled_at timestamptz, paperwork_item_id uuid → paperwork_items, member_id uuid, linked_type text, linked_id uuid, sub_intent text; extend channel CHECK with 'share','scan','paste','form'. RLS unchanged.
- M3: graph_entities/graph_edges add source text default 'projection', confidence smallint, observed_at timestamptz; extend kind CHECK with 'asset','obligation','preference','provider'; add calendar_events/bills/paperwork_items/family_facts to the 0134 mark_model_dirty trigger list. No RLS change.
- M6: ai_plan_steps add undone_at timestamptz, undone_by uuid; ai_run_events event_type add 'undone'; ai_tool_calls created_refs jsonb ONLY for multi-row writes (resource_table/resource_id already exist). Service-role writes only.
- M35: CREATE OR REPLACE claim_ai_runs (0263 dead-letter path) to mark orphaned ai_tool_calls rows 'unknown' when a run is dead-lettered. No schema/RLS change.
- M10: grocery_lists add budget_cents int, grocery_items add estimated_price_cents int (nullable). RLS unchanged. (Calendar-awareness, substitutions, handoff can ship first without it.)
- M21: notifications add priority text not null default 'now' CHECK in ('now','digest') + index (user_id/family scope, priority, is_read). No RLS change.
- M24: new table ai_context_access_log(request_id, family_id, slice, table_name, row_count, sensitive bool, created_at) with manager-read RLS, insert from the context builder (service/invoker). Activity tab can ship first without it.
- M36: new table account_deletion_requests(family_id, requested_by, requested_at, execute_after, status) manager-only RLS; plus Supabase project setting: enable MFA/TOTP (no schema).
- M12: home_assets add replaced_by_asset_id uuid → home_assets, retired_on date; optional inventory_items.asset_id uuid → home_assets. Existing RLS covers.
- M15 (CONFIRMED REQUIRED — 0070 has no status column): vacation_flights and vacation_lodging add disruption_status text (CHECK on_time/delayed/cancelled) and delay_minutes int.
- M16: new tables care_circles, care_circle_members (scopes text[], can_write), care_handoffs + is_circle_member(circle_id, scope) helper + scoped SELECT policies on calendar_events, todos, documents, rides, care_log.
- M32: new table savings_ledger(id, family_id, source CHECK subscription_cancelled|warranty_claim|grocery_swap|duplicate_avoided|bill_negotiated|other, amount_cents, cadence one_time|monthly, evidence_table, evidence_id, note, recorded_by, created_at) + is_family_member RLS + index (family_id, created_at); add to the 0275 money-write sweep.
- M18(c) optional: new table display_devices(family_id, code_hash, label, last_seen_at, revoked_at) + RLS + SECURITY DEFINER redeem RPC. Ask/handled tiles and /display/setup need no migration.
- M26: new tables service_providers, service_requests (status queue→quoting→booked→done, linked maintenance_task/trip/care), service_quotes with is_family_member RLS and a circle-share policy modelled on 0176.
- M27: new tables partner_api_keys(family_id, partner_name, key_hash, key_prefix, scopes text[], created_by, last_used_at, revoked_at) and partner_events(family_id, key_id, idempotency_key, kind, payload jsonb, status, result_ref) with unique(family_id, idempotency_key); manager read/revoke RLS, service-role hash lookup.
- M23: new RLS on documents/notes/journal_entries honouring member_id (owner or can_manage_family) + SQL helper has_active_delegation(family_id, domain) consulted by sensitive-table read policies. No new tables.
- M33: new SECURITY INVOKER function public.search_household(family_id, q, limit) (search_path pinned) UNIONing pg_trgm similarity over documents, inventory_items, trips/vacations, bills, home_warranties/renewals, decisions, calendar_events, notes, family_facts + GIN trigram indexes on their title/name columns. No new tables; underlying RLS applies.
- W2 + W7 + W3 (ONE migration): CREATE OR REPLACE public.public_stats() adding ai_handled_30d bigint and avg_first_brief_minutes numeric (SECURITY DEFINER, anon-executable, excludes the demo family).
- X1 + X2 + X4 + X6 + X9 + X11 (ONE migration): new table family_metric_weeks(family_id, week_start date, time_saved_minutes int, handled_actions int, auto_captured_pct numeric, signal_precision numeric, value_ratio numeric, weekly_active bool, created_at) unique(family_id, week_start), family-scoped SELECT RLS, service-role writes from the weekly-digest cron.
- X8 + X9: ALTER TABLE family_members ADD COLUMN last_active_at timestamptz + index (family_id, last_active_at desc); service-role updates only, throttled from requireUserContext.
- X2 optional follow-up: created_via text on calendar_events/todo_items/bills/family_reminders so manual captures are stamped explicitly.

## 7. The sections

Each one is a single PR against `claude/roadmap-implementation-ld8bon`. The spec
is the audit's build plan; the file list is where the work goes; the acceptance
line is what a reviewer will check.

### S-01 · M2 + M20 — one household inbox, and inbound mail that reaches the planner

> M2 + M20 (no-migration halves) — one household inbox queue, "Handle it" through the intake, inbound messages routed to the planner, share target, receipt/reservation triage, front desk pointed at the inbox

- This is the NO-MIGRATION slice. Anything in the audit's Build line that needs new columns/tables/RPCs is OUT (list it in notes as exact DDL and set needs_migration=true if you had to leave something out). Do not write to supabase/migrations.
- Verify every column you write against the CREATE TABLE in supabase/migrations before using it; never assume a column exists.
- Every Supabase read: on error, console.error('[<namespace>] <what> read failed', error) and fail closed (return an error state the UI renders as 'Could not load … Retry'); never render a reassuring empty state on error.
- Server actions/route handlers: use requireUserContext / the existing service layer (lib/services/<domain>, ServiceScope) — never bypass trust gating for writes the AI proposes; a proposal is approval-gated through the existing runAction/gateAiAction/approval_requests spine.
- Do not touch the shared sidebar (memory.md rule). New in-app routes are reached by links from related pages/cards, never by adding them to PRIMARY_NAV/APP_NAV_GROUPS/CURATED_*.
- Other implementers are working in parallel on the Daily Brief (lib/briefing/build.ts, briefing-module), Needs You (lib/home/needs-*), Handled ledger (lib/ai/runs), notifications (lib/services/notifications), trust module Activity tab, meals loop, metrics core, and the public homepage/nav/footer/pricing/security pages. Keep your edits to the files your item names; if you must touch one of those shared files, make the smallest additive change.

BUILD (no migration — family_inbox_messages has NO request_id/handled_at/link columns and its channel CHECK is email|sms|voice, so: 'handled' is expressed with the existing ai_handled boolean (+ status 'archived'), the created request id cannot be stamped on the row (set needs_migration=true and list the DDL), and non-telephony sources are NOT inserted into family_inbox_messages — they are merged at read time):
1. Unified queue: pure lib/inbox/unify.ts merging family_inbox_messages + paperwork_items (open) + family_communications into one ranked list (urgency: ai_intent urgent > appointment/deadline soon > unread > recency) with a stable { kind, id, title, snippet, occurredAt, source, handled } shape; app/(app)/dashboard/inbox/page.tsx server-reads all three (each fails closed, partial notice) and renders the queue above the existing Communications Hub log. Tests for ranking and the read boundary.
2. 'Handle it' per row: server action piping subject+body through the existing intake (submitRequest, intent 'capture', trust-gated; approval spine unchanged) and marking the row ai_handled=true only after submitRequest returns a persisted request; show 'Handled' from that flag and link to the run when the intake result includes it (in-memory for this response only — say so in a comment, no fake persistence).
3. Inbound routing (M20): after recordInboundMessage in lib/contact-center/server.ts, hand appointment/delivery/personal messages to submitRequest under systemScopeForFamily (verify the helper) so they enter the planner with trust gating; mark ai_handled when the request is persisted. Inbound email attachments/links: run lib/paperwork/triage and insert paperwork_items (existing columns) when triage recognises a form/bill/receipt/reservation.
4. lib/paperwork/triage.ts: add kinds 'receipt' and 'reservation' (verify the paperwork_items kind CHECK — if it does not admit them, map to the closest admitted kind and keep the finer kind in an existing text field; note it).
5. Share target: public/manifest (or app/manifest.ts — verify) gains share_target { action:'/capture', method:'GET', params:{title,text,url} }; /capture pre-fills from those query params. Add the e2e-safe unit test for the manifest shape.
6. Front desk: app/(app)/dashboard/front-desk (route kept, sidebar untouched) reads family_inbox_messages voice rows and family_contact_channels settings instead of the disconnected call_logs/front_desk_settings; keep the old tables readable for history but stop writing them.
--- AUDIT M2 — Universal Household Inbox — status partial ---
- Reachable: /dashboard/inbox (Communications Hub, requireFeature), /dashboard/contact-center (requirePlanLevel(2)), /capture, /dashboard/scan, /dashboard/paperwork, /dashboard/voice — five separate surfaces, no single inbox
- Persisted: family_communications, family_inbox_messages, paperwork_items, calendar_events/todo_items/grocery_items/notes (capture), concierge writes via runAction
- Tested: tests/capture-save.test.ts, tests/paperwork-triage.test.ts, tests/contact-center.test.ts, tests/ai-voice.test.ts, tests/voice-command-router.test.ts, tests/documents-import-actions.test.ts
- Mock risk: Communications Hub is a manual log (user types the message) — it looks like an inbox but nothing flows into it automatically; contact-center inbound requires CONTACT_CENTER_INBOUND_SECRET + provider wiring and a Family+ plan; scan requires an AI provider for /api/ai/flyer
- Gap: No single household inbox: email/SMS/voice land in family_inbox_messages (Contact Center, Family+ only), pasted text in family_communications, camera scans go straight to calendar, paperwork to paperwork_items, and there is no share-target. Inbound email/SMS are classified and auto-replied but never become bills, receipts, reservations, forms, events or tasks — recordInboundMessage is storage-only. No triage queue that unifies sources with 'turn into…' actions, and no bill/receipt/reservation extraction for inbound mail.
- Build (L, migration: yes): Make /dashboard/inbox the one queue: server page reads family_inbox_messages + paperwork_items + family_communications (+ scan/voice captures stamped as inbox rows) into one ranked list; add a 'Handle it' action per row that pipes the body through the existing intake (submitRequest with intent 'capture') or /api/ai/import, gated by trust, and stamps the message with the created request id; add a PWA share_target pointing at /capture so shared email/screenshots enter the same queue; extend paperwork triage kinds with 'receipt' and 'reservation'.
  - Migration: family_inbox_messages needs request_id uuid (FK ai_requests) + handled_at timestamptz, and the channel check constraint must admit 'share','scan','paste' so non-telephony sources can live in the same table; RLS unchanged (family-scoped select already exists in 0214).
- Evidence: `app/(app)/dashboard/inbox/page.tsx:1-10` /dashboard/inbox is the 'Communications Hub' (InboxModule), plan-gated by requireFeature; `components/modules/inbox-module.tsx:74,428,628,730` reads/writes family_communications (manual log of calls/emails/messages); :397 /api/ai/assist; :704 /api/ai/import for pasted text; `app/api/ai/import/route.ts:16-24` Magic Import maps extracted items to create_calendar_event/create_chore/create_reminder/add_grocery_item/create_meal_plan_entry via runAction, trust-gated; `lib/contact-center/server.ts:130-160` recordInboundMessage upserts email/sms/voice into family_inbox_messages with classify/summarize; storage only, no domain records created; `app/api/contact-center/email/route.ts:96-113` inbound email webhook -> runConcierge -> recordInboundMessage -> auto-reply; grep for todo_items/calendar_events/submitRequest in lib/contact-center and app/api/contact-center returns nothing; `app/(app)/capture/page.tsx` /capture text capture; lib/capture/save.ts:73-116 saves notes/calendar_events/todo_items/grocery_items; undoCapture at :119-126; `components/modules/scan-module.tsx:52,83` camera scan posts to /api/ai/flyer; app/api/ai/flyer/route.ts:79 inserts calendar_events; `lib/paperwork/triage.ts:1-13` deterministic triage of forms/permission slips/bills; app/(app)/dashboard/paperwork/actions.ts:28,80 writes paperwork_items and calendar_events

--- AUDIT M20 — Family Phone + Email Front Desk — status partial ---
- Reachable: /dashboard/contact-center (requirePlanLevel(2), parent-only writes); webhooks /api/contact-center/{email,sms,voice} gated by CONTACT_CENTER_INBOUND_SECRET / Twilio signature; /dashboard/front-desk (requireFeature) is a separate manual surface
- Persisted: family_contact_channels, family_inbox_messages (upsert on channel+provider_ref), Twilio provisioning; front_desk_settings/call_logs only via manual client inserts
- Tested: tests/contact-center.test.ts, tests/guardian-callback-security.test.ts (Twilio signature/replay pattern), tests/guardian-authz.test.ts
- Mock risk: Without Twilio config provisionFamilyNumber flips to 'pending' and the page shows a request state — a number never arrives; the Front Desk page looks like telephony but its call log is hand-entered; classification is regex-based unless an AI provider is configured
- Gap: The optional household identity (claimable @bubaly.com address, provisioned Twilio number, inbound email/SMS/voice filed into family_inbox_messages with classification, urgent escalation and auto-reply) is real, plan-gated and tested. Missing: 'routes them into Bubaly' — inbound messages never become events/tasks/approvals/runs; no inbound forms channel; the older /dashboard/front-desk (front_desk_settings/call_logs) is a disconnected manual duplicate of the Contact Center.
- Build (L, migration: yes): After recordInboundMessage, hand appointment/delivery/personal messages to the planner via submitRequest (intent 'capture', system scope for the family, approval gating from trust) and stamp the message with the request id so the inbox row links to the run; accept inbound email attachments/links as paperwork by calling lib/paperwork/triage and inserting paperwork_items; point /dashboard/front-desk at family_inbox_messages voice rows and family_contact_channels settings so one surface remains (route kept, sidebar untouched).
  - Migration: family_inbox_messages: add request_id uuid references ai_requests, paperwork_item_id uuid references paperwork_items, and extend channel check to include 'form'; same migration as M2's link columns — ship once.
- Evidence: `supabase/migrations/0214_family_contact_center.sql:16,36,73-77` family_contact_channels (email_local, phone_number, provisioning_status, ai_concierge_enabled, forward_to_phone) and family_inbox_messages with family-scoped RLS; `lib/contact-center/server.ts:19-33,55-66,82-118,130-160` channel get-or-create, routing by number/email local-part, Twilio number provisioning (pending when unconfigured), recordInboundMessage/recordOutboundMessage; `lib/contact-center/routing.ts:9-13,30-45` deterministic intents urgent/appointment/delivery/sales/spam/personal and route escalate/auto_reply/file; `app/api/contact-center/email/route.ts:29-33,74-113` secret-gated inbound email webhook: resolve family, run concierge, file message, urgent SMS to forward_to_phone, auto-reply email; voice/route.ts:1-4 Twilio voice with transcription into inbox; sms/route.ts; `app/(app)/dashboard/contact-center/page.tsx:15-20` /dashboard/contact-center requires plan level 2 (Family+); actions.ts:16-24 parent-only management, :27-61 assign @bubaly.com local and provision number; `grep todo_items|calendar_events|reminders|paperwork_items|submitRequest lib/contact-center app/api/contact-center` no hits — inbound messages are filed and classified but never routed into planner/needs/records; `app/(app)/dashboard/front-desk/page.tsx` /dashboard/front-desk (AI Front Desk) renders FrontDeskModule; components/modules/front-desk-module.tsx:85,100,582,711 reads call_logs/front_desk_settings and inserts call_logs manually — no API route writes call_logs (grep app/api: none); `supabase/migrations/0092_front_desk.sql:1-40` front_desk_settings + call_logs — an earlier, disconnected front-desk surface

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `lib/inbox/unify.ts`
- `app/(app)/dashboard/inbox/page.tsx`
- `app/(app)/dashboard/inbox/actions.ts`
- `components/modules/inbox-module.tsx`
- `lib/contact-center/server.ts`
- `lib/paperwork/triage.ts`
- `app/(app)/capture/page.tsx`
- `public/manifest.webmanifest`
- `components/modules/front-desk-module.tsx`
- `app/(app)/dashboard/front-desk/page.tsx`

**Tests to add**: `tests/inbox-unify.test.ts`, `tests/inbox-queue-read-boundary.test.ts`, `tests/contact-center-routing-to-planner.test.ts`, `tests/paperwork-triage-kinds.test.ts`, `tests/manifest-share-target.test.ts`

**Done when**: /dashboard/inbox shows one ranked queue from three persisted sources with fail-closed reads; Handle it enters the intake and Handled reflects ai_handled; inbound appointment/delivery/personal messages reach the planner; receipts/reservations triage; share target lands in /capture; front desk reads the inbox tables; i18n gate clean.

### S-02 · M3 — the family graph projects events, assets, obligations and preferences

> M3 Family graph projector extension (no-migration) — events, assets, obligations and preferences projected with provenance in attributes; one graph

- This is the NO-MIGRATION slice. Anything in the audit's Build line that needs new columns/tables/RPCs is OUT (list it in notes as exact DDL and set needs_migration=true if you had to leave something out). Do not write to supabase/migrations.
- Verify every column you write against the CREATE TABLE in supabase/migrations before using it; never assume a column exists.
- Every Supabase read: on error, console.error('[<namespace>] <what> read failed', error) and fail closed (return an error state the UI renders as 'Could not load … Retry'); never render a reassuring empty state on error.
- Server actions/route handlers: use requireUserContext / the existing service layer (lib/services/<domain>, ServiceScope) — never bypass trust gating for writes the AI proposes; a proposal is approval-gated through the existing runAction/gateAiAction/approval_requests spine.
- Do not touch the shared sidebar (memory.md rule). New in-app routes are reached by links from related pages/cards, never by adding them to PRIMARY_NAV/APP_NAV_GROUPS/CURATED_*.
- Other implementers are working in parallel on the Daily Brief (lib/briefing/build.ts, briefing-module), Needs You (lib/home/needs-*), Handled ledger (lib/ai/runs), notifications (lib/services/notifications), trust module Activity tab, meals loop, metrics core, and the public homepage/nav/footer/pricing/security pages. Keep your edits to the files your item names; if you must touch one of those shared files, make the smallest additive change.

BUILD (no migration — graph_entities.kind CHECK admits person/activity/place/org/event/item/pet/topic/other; there are no source/confidence/observed_at columns, so provenance goes into attributes jsonb; the dirty-trigger table list cannot change):
1. lib/twin/project.ts (pure) + lib/twin/project-server.ts: project calendar_events (next 60 days) as kind 'event'; inventory items and vehicles and home_assets/home_warranties/home projects as kind 'item' with attributes.subkind 'asset'|'warranty'|'project'; bills, paperwork_items open actions and renewals as kind 'other' with attributes.subkind 'obligation' (due date, amount); family_facts category=preference as kind 'topic' with attributes.subkind 'preference' carrying family_facts.source + confidence. Every projected row gets attributes.provenance = { source:'projection', observed_at, ref_table }. Edges: event→person (attendees), asset→home/place, warranty→asset, project→asset, obligation→person (owner), preference→person. Keep upserts idempotent on (family_id, ref_table, ref_id); prune rows for refs that disappeared (existing behaviour).
2. One graph: redirect lib/family/actions.ts family_knowledge_nodes/edges writes to graph_entities/graph_edges (kind mapping + provenance { source:'manual' }); keep reading legacy rows only if something still renders them (verify) — otherwise leave the legacy tables untouched.
3. Extend tests/twin-project.test.ts / twin-projection.test.ts for each new kind and the provenance shape; add a read-boundary test for the new project-server reads (fail closed per table).
4. Because the 0134 trigger cannot be extended without a migration, ensure the model-refresh cron backstop still re-projects these sources (verify the cron interval) and note the DDL for adding calendar_events/bills/paperwork_items/family_facts to the trigger list.
--- AUDIT M3 — Family Intelligence Graph — status partial ---
- Reachable: /dashboard/graph (requireUserContext, no plan gate); /dashboard/family-knowledge-graph redirects; graph data also feeds /dashboard/concierge, /dashboard/briefing, /dashboard/decisions, /dashboard/prep-plans via loadFamilyContext
- Persisted: graph_entities, graph_edges, family_model_dirty (trigger), family_facts (with source/confidence), legacy family_knowledge_nodes/edges
- Tested: tests/graph-reason.test.ts, tests/twin-project.test.ts, tests/twin-projection.test.ts, tests/reasoning-context.test.ts, tests/reasoning-context-read-boundary.test.ts, tests/family-facts.test.ts, tests/memory-write-path.test.ts
- Mock risk: graph_entities.ref_table/ref_id is the only provenance — no source/confidence/observed_at on nodes or edges; an empty graph renders as 'no entities' and the page still loads; the manual GraphModule insert path bypasses projection so hand-made nodes have no provenance
- Gap: Canonical graph covers people, pets, vehicles, classes, teams, routines, places, accounts and providers with ref_table/ref_id links, auto-refreshed on dirty. Missing for the strategy: events, items/assets, obligations (bills, paperwork actions, renewals) and preferences are not projected (preferences live in family_facts, obligations in domain tables); graph rows carry no source/confidence/observed_at provenance (only family_facts does, per 0265); the legacy family_knowledge_nodes graph (0022) is still written by lib/family/actions.ts, so there are two graphs.
- Build (L, migration: yes): Extend the pure projector with calendar_events (upcoming 60d), inventory items/vehicles as assets, obligations from bills/paperwork_items/renewals, and preferences from family_facts (category=preference, carrying source+confidence into attributes); add provenance columns to graph rows and stamp them in project-server; redirect lib/family/actions.ts knowledge-node writes to graph_entities so there is one graph; keep the existing dirty-trigger refresh.
  - Migration: graph_entities and graph_edges need source text (default 'projection'), confidence smallint, observed_at timestamptz; extend kind check with 'asset','obligation','preference','provider'; add calendar_events/bills/paperwork_items/family_facts to the 0134 dirty-trigger table list. No RLS change.
- Evidence: `supabase/migrations/0129_family_graph.sql:19-54` graph_entities (kind in person/activity/place/org/event/item/pet/topic/other, ref_table/ref_id, attributes jsonb) and graph_edges (relation, weight, unique per family/source/target/relation), RLS family-member; `lib/twin/project.ts:1-33` pure projector from members, pets, vehicles, classes, teams, routines, places, accounts, providers — no calendar events, items, documents, obligations or preferences; `lib/twin/project-server.ts:17-25,51,70` reads nine domain tables and upserts graph_entities/graph_edges idempotently on (family_id, ref_table, ref_id); `lib/reasoning/auto-refresh.ts:11-24` re-projects in background when family_model_dirty is set by the 0134 trigger; model-refresh cron is the backstop; `supabase/migrations/0134_model_dirty.sql:13-61` family_model_dirty table + mark_model_dirty trigger on source tables; `lib/reasoning/context.ts:41-45,112-114,152-168,185` loadFamilyContext reads graph_entities/graph_edges, computes orphans/stats, schedules auto refresh; `app/(app)/dashboard/graph/page.tsx:12-45` /dashboard/graph renders contextSummary + GraphModule; family-knowledge-graph/page.tsx:1-8 redirects here; `components/modules/graph-module.tsx:54,58,305,346` client reads/inserts graph_entities and graph_edges directly (manual node/edge creation)

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `lib/twin/project.ts`
- `lib/twin/project-server.ts`
- `lib/family/actions.ts`
- `lib/reasoning/context.ts`

**Tests to add**: `tests/twin-project.test.ts`, `tests/twin-projection.test.ts`, `tests/twin-project-read-boundary.test.ts`

**Done when**: Events, assets, obligations and preferences appear in graph_entities with provenance in attributes and correct edges; manual knowledge-node writes land in the canonical graph; projection stays idempotent; tests cover each kind; tsc clean.

### S-03 · M10 — the meal → pantry → grocery loop closes

> M10 (no-migration parts) — calendar-aware meal planning, substitutions, retailer handoff, Bought→pantry, add-this-week's-plan

Read audit item M10. Verified: lib/grocery/retailers.ts passes tests but is dead code; the planner only writes meal_plans when write=true; groceries.addFromMealPlan is referenced only from lib/ai/tools/meals.ts and planner templates — components/modules/meals-module.tsx has no add-from-plan action; no calendar awareness, no substitutions, no purchase handoff. BUILD (no schema; budget columns are a migration — leave a TODO): (1) NEW pure lib/meals/week-context.ts scoring busy nights from calendar_events and feeding a quick-meal hint into the planner prompt (lib/meals/planner.ts, app/api/ai/meals/plan/route.ts); (2) NEW pure lib/meals/substitutions.ts (allergy/dislike from medical_profiles.allergies + family_facts, pantry-preferred swaps, each with a reason) applied to planGroceryNeeds output; (3) wire lib/grocery/retailers.ts into components/modules/shopping-module.tsx as retailer chips + 'copy list' (links built from unchecked items; no affiliate/commission signal anywhere — comment it); (4) a 'Bought' flow in shopping-module that increments pantry via pantryAdjust and optionally records the purchase through the finances service only when an amount is given; (5) an 'Add this week's plan to the list' action in meals-module.tsx calling groceries.addFromMealPlan through app/(app)/dashboard/grocery/actions.ts. Tests per the audit: tests/meals-week-context.test.ts, tests/meals-substitutions.test.ts, tests/shopping-handoff-write-boundary.test.ts (Bought → pantryAdjust +qty; purchase recorded only with amount; retailer links from unchecked items).

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `app/api/ai/meals/plan/route.ts`
- `lib/meals/planner.ts`
- `lib/services/groceries/index.ts`
- `components/modules/shopping-module.tsx`
- `components/modules/meals-module.tsx`
- `app/(app)/dashboard/grocery/actions.ts`
- `lib/grocery/retailers.ts`

**Tests to add**: `tests/meals-week-context.test.ts`, `tests/meals-substitutions.test.ts`, `tests/shopping-handoff-write-boundary.test.ts`, `tests/service-groceries.test.ts (existing stays green)`, `tests/meal-planner.test.ts (existing stays green)`

**Done when**: Busy nights change the plan prompt; substitutions carry reasons and respect allergies; retailer chips are built from unchecked items with no paid bias; Bought increments the pantry and records a purchase only with an amount; the meals module can push this week's plan to the list; existing meal/grocery tests green.

### S-04 · M12 — the home twin gets manuals and one asset detail view

> M12 Home twin (no-migration half) — manuals on the asset card and one asset detail view with warranty, manual, service history, open maintenance and related project

- This is the NO-MIGRATION slice. Anything in the audit's Build line that needs new columns/tables/RPCs is OUT (list it in notes as exact DDL and set needs_migration=true if you had to leave something out). Do not write to supabase/migrations.
- Verify every column you write against the CREATE TABLE in supabase/migrations before using it; never assume a column exists.
- Every Supabase read: on error, console.error('[<namespace>] <what> read failed', error) and fail closed (return an error state the UI renders as 'Could not load … Retry'); never render a reassuring empty state on error.
- Server actions/route handlers: use requireUserContext / the existing service layer (lib/services/<domain>, ServiceScope) — never bypass trust gating for writes the AI proposes; a proposal is approval-gated through the existing runAction/gateAiAction/approval_requests spine.
- Do not touch the shared sidebar (memory.md rule). New in-app routes are reached by links from related pages/cards, never by adding them to PRIMARY_NAV/APP_NAV_GROUPS/CURATED_*.
- Other implementers are working in parallel on the Daily Brief (lib/briefing/build.ts, briefing-module), Needs You (lib/home/needs-*), Handled ledger (lib/ai/runs), notifications (lib/services/notifications), trust module Activity tab, meals loop, metrics core, and the public homepage/nav/footer/pricing/security pages. Keep your edits to the files your item names; if you must touch one of those shared files, make the smallest additive change.

BUILD (no migration; the lineage columns and inventory link are OUT; the twin-graph projection of assets is owned by item D9 — do NOT edit lib/twin/*):
1. Manuals: allow documents.category 'manual' (verify the documents category CHECK/enum in migrations — if 'manual' is not admitted, use the existing closest category plus a tag/metadata field that exists, and say so in notes) and let the asset card in components/modules/home-module.tsx attach/list warranty + manual documents for the asset via the documents service (signed URLs, TTL as today).
2. Asset detail: app/(app)/dashboard/home/assets/[id]/page.tsx (server component, requireUserContext, family-scoped read, notFound on missing) composing: the asset, its warranty (home_warranties), manual/warranty documents, home_service_records history, open maintenance_tasks for the asset, and related home project(s). Each read fails closed with the error pattern above. Link to it from the asset card. Reuse lib/services/home reads; add read functions there if missing rather than querying from the page.
3. A 'Replace this asset' action is OUT (needs replaced_by_asset_id); instead add a 'Retire' note action ONLY if home_assets has a status-like column that admits it (verify) — otherwise skip and note.
--- AUDIT M12 — Home Digital Twin: Assets, warranties, manuals, maintenance, inventory, projects and replacement history — status partial ---
- Reachable: /dashboard/home hub + /home/warranties, /home/maintenance, /home/service, /home/pros, /home/diagnose via navigation.ts:146 (minLevel 1, requirePlanLevel(1)); /dashboard/projects via navigation.ts:150 + requireFeature (feature-catalog.ts:72 'basic'); /dashboard/inventory via navigation.ts:147 (feature-catalog.ts:68 'basic').
- Persisted: homes, home_assets, home_warranties, home_contractors, home_service_records, maintenance_tasks, documents(asset_id), home_projects, project_materials, project_quotes, inventory_items/home_locations/inventory_moves (separate).
- Tested: tests/home-maintenance.test.ts (warranty/life/cadence math), tests/home-actions-write-boundary.test.ts (warranty/contractor/service write failures), tests/home-management.test.ts, tests/projects-planner.test.ts, tests/projects-module-write-boundary.test.ts, tests/inventory-finder.test.ts, tests/twin-project.test.ts (graph projection, no home nodes).
- Mock risk: Each piece is a real module, but there is no 'twin' view that joins them: replacement history is only inferable from lifeRemaining + service records; 'manuals' would have to be uploaded as a 'warranty' document; the Digital Twin page (family-digital-twin) contains no home data, so a reviewer could mistake the twin page for a home twin.
- Gap: Missing: manuals (no document category/field), replacement history/lineage (no replaced_by/retired_on, no 'replaced' event), asset↔inventory link, home assets/warranties/projects in the twin graph (lib/twin/project.ts), and a single asset detail view that shows warranty + manual + service history + open maintenance + related project.
- Build (M, migration: yes): (1) Manuals without migration: allow documents.category 'manual' on the asset card in home-module and list warranty+manual docs per asset; (2) replacement lineage: add home_assets.replaced_by_asset_id + retired_on and a 'Replace this asset' action in home/actions.ts that creates the new asset, links the old one, copies location and logs a home_service_records row of kind 'replacement'; (3) add home assets, warranties and projects to the twin projection (lib/twin/project.ts + project-server.ts) with edges asset→home, warranty→asset, project→asset; (4) optional inventory_items.asset_id to link big-ticket inventory to an asset.
  - Migration: ALTER home_assets ADD replaced_by_asset_id uuid REFERENCES home_assets, retired_on date; optionally inventory_items.asset_id uuid. Existing RLS on home_assets covers new columns; owner approval required.
- Evidence: `supabase/migrations/0002_tables.sql:301-316` home_assets (name, category, location, brand, model, purchased_on, warranty_until) and maintenance_tasks (asset_id, recurrence, interval_days, due_at) lines 318-335.; `supabase/migrations/0036_home_maintenance.sql:41-46,78-92` home_assets gains installed_on, expected_life_years, last_serviced_on; home_warranties table (provider, warranty_type, coverage, expires_on, cost, claim_phone); also homes, home_contractors, home_service_records.; `lib/home/maintenance.ts:22-83` warrantyStatus, assetAgeYears, lifeRemaining (TYPICAL_LIFESPAN_YEARS), DEFAULT_CADENCES per asset category — the forecasting backbone.; `app/(app)/dashboard/home/actions.ts:27-171` saveWarrantyAction, saveContractorAction, saveServiceRecordAction (updates home_assets.last_serviced_on line 119), scheduleRecommendedTasksAction inserts maintenance_tasks from cadences (line 135-171).; `lib/home/queries.ts:22-72` getAssets/getWarranties/getContractors/getServiceRecords fail closed; getHomeOverview joins assets, warranties, open maintenance_tasks.; `components/modules/home-module.tsx:355-358` Warranty document upload inserts documents with asset_id and category 'warranty' (documents.asset_id from 0007). No 'manual' category or manual URL anywhere (grep manual in lib/home/components/home/migrations → only device integration enum).; `supabase/migrations/0246_home_projects.sql` home_projects, project_materials, project_quotes; lib/projects/planner.ts (scope templates, compareQuotes, budgetHealth) used by components/modules/projects-module.tsx (reads home_contractors too).; `supabase/migrations/0242_home_inventory.sql:25-53` inventory_items has no asset_id — inventory and home_assets are unlinked silos.

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `components/modules/home-module.tsx`
- `app/(app)/dashboard/home/assets/[id]/page.tsx`
- `lib/services/home/index.ts`
- `lib/home/asset-detail.ts`
- `app/(app)/dashboard/home/actions.ts`

**Tests to add**: `tests/home-asset-detail.test.ts`, `tests/home-asset-detail-read-boundary.test.ts`

**Done when**: An asset card can attach and list manual + warranty documents; /dashboard/home/assets/[id] shows warranty, documents, service history, open maintenance and related project from persisted rows, failing closed on read errors; tests cover the composer and the read boundary; i18n gate clean.

### S-05 · M15 — travel: pet-aware prep and a disruption re-flow

> M15 Travel agent (no-migration half) — pet-aware trip prep and a disruption re-flow helper with a "Report a disruption" action

- This is the NO-MIGRATION slice. Anything in the audit's Build line that needs new columns/tables/RPCs is OUT (list it in notes as exact DDL and set needs_migration=true if you had to leave something out). Do not write to supabase/migrations.
- Verify every column you write against the CREATE TABLE in supabase/migrations before using it; never assume a column exists.
- Every Supabase read: on error, console.error('[<namespace>] <what> read failed', error) and fail closed (return an error state the UI renders as 'Could not load … Retry'); never render a reassuring empty state on error.
- Server actions/route handlers: use requireUserContext / the existing service layer (lib/services/<domain>, ServiceScope) — never bypass trust gating for writes the AI proposes; a proposal is approval-gated through the existing runAction/gateAiAction/approval_requests spine.
- Do not touch the shared sidebar (memory.md rule). New in-app routes are reached by links from related pages/cards, never by adding them to PRIMARY_NAV/APP_NAV_GROUPS/CURATED_*.
- Other implementers are working in parallel on the Daily Brief (lib/briefing/build.ts, briefing-module), Needs You (lib/home/needs-*), Handled ledger (lib/ai/runs), notifications (lib/services/notifications), trust module Activity tab, meals loop, metrics core, and the public homepage/nav/footer/pricing/security pages. Keep your edits to the files your item names; if you must touch one of those shared files, make the smallest additive change.

BUILD (no migration — vacation_flights/vacation_lodging have no status column, so the disruption itself is not persisted as a status; do not add columns; the household-budget/timeline tie-in is owned by the CFO item — leave loadMoneyTimeline alone):
1. Pet prep: the prepare-vacation template (lib/ai/planner/templates/prepare-vacation.ts or wherever 'prepare-vacation' lives) and its service read the family's pets (pets table via lib/services) and emit one sitter/boarding task per pet with the pet's name and care notes; add a 'Trip disrupted' follow-up step description to the template.
2. Disruption re-flow: pure lib/vacations/disruption.ts replanDisruption(input: {kind:'flight'|'lodging', id, delayMinutes|cancelled}, itinerary, reservations) → {shiftedItems, toRebook, summary} using lib/vacations/conflicts.ts rules; tests for delay, cancellation, overnight roll-over and no-op.
3. Action: on app/(app)/dashboard/vacations/[id]/travel (verify the actual route), a 'Report a disruption' form (flight or lodging, delayed N minutes or cancelled) calling a server action that runs the helper, persists the shifted vacation_itinerary_items (existing columns only), appends a note itinerary item/record if the schema has a notes-like place (verify), and notify()s the family (lib/services/notifications) with the summary. No 'rebooked' claim anywhere — the UI says what was shifted and what still needs rebooking by a person.
4. Expose the helper as an AI tool trips.replanDisruption (read-only planning output; the write path stays the server action) registered in lib/ai/tools with the existing dotted-name pattern.
--- AUDIT M15 — Family Travel Agent: Budget/calendar-aware travel, reservations, packing, home/pet prep and disruption replanning — status partial ---
- Reachable: /dashboard/vacations (+ [id]/budget, packing, travel, lodging, itinerary, documents, ai-assistant) via navigation.ts:158 and requireFeature('/dashboard/vacations'); /dashboard/trips via navigation.ts:157 (feature-catalog.ts:96 'basic'); /dashboard/trip-intel via navigation.ts:86 (feature-catalog.ts:34); concierge intent plan_trip/prepare_vacation (lib/intent/detect.ts, templates/index.ts).
- Persisted: vacations + 26 vacation_* tables (0070), trips/trip_items, trip_plans/departure_plans (0098), calendar_events (sync), family_reminders, todos via workflow; AI conversations in vacation_ai_conversations/messages.
- Tested: tests/vacations.test.ts (dates, budget, weather, packing), tests/trips-planner.test.ts, tests/trip-departure.test.ts, tests/service-trips.test.ts, tests/api-vacations-ai-output.test.ts, tests/vacation-ai-persistence-boundaries.test.ts, tests/vacations-detail-write-boundary.test.ts, tests/trip-weather-packing-boundary.test.ts, tests/planner-templates.test.ts (prepare_vacation).
- Mock risk: 'Budget-aware' is trip-internal (planned vs spent per trip) and never consults household budgets or the cash-flow forecast; pet/home prep is a single generic todo line rather than per-pet tasks; no reservation booking or monitoring integration, so 'reservations' are manually entered rows.
- Gap: Disruption replanning is absent (no flight/lodging delay or cancellation handling, no itinerary re-flow, no notification); trip budget not tied to household budget/forecast; pet prep not driven by the pets table; two overlapping travel modules (trips vs vacations).
- Build (M, migration: yes): (1) Add trips.replanDisruption service + tool: given a vacation_flights/vacation_lodging row marked delayed/cancelled (new status value), shift affected vacation_itinerary_items via lib/vacations/conflicts.ts rules, flag reservations to rebook, and notify() the family; expose an 'Report a disruption' action on [id]/travel; (2) make prepare-vacation read pets (lib/services/family or pets table) and create one sitter/boarding task per pet; (3) feed remaining vacation_budgets into loadMoneyTimeline (shared with M11) and show 'household impact' on the budget page; (4) add a 'Trip disrupted' follow-up in the prepare-vacation template.
  - Migration: Only if vacation_flights/vacation_lodging lack a status/delay column — verify in 0070 before adding `disruption_status text` + `delay_minutes int`; itinerary shifts reuse existing columns.
- Evidence: `supabase/migrations/0070_vacations.sql` 27 vacation_* tables incl. vacation_budgets, vacation_expenses, vacation_reservations, vacation_lodging, vacation_flights, vacation_transportation, vacation_packing_lists/items, vacation_documents, vacation_itinerary_days/items, vacation_weather_snapshots, vacation_members (role adult/child/grandparent/caregiver line 57).; `lib/vacations/budget.ts:26-62` summarizeBudget/overruns per category — trip-local budget only; no read of household budgets/transactions anywhere in lib/vacations or app/(app)/dashboard/vacations (grep from('budgets') empty).; `lib/services/trips/index.ts:775-800` commitmentConflicts checks calendar events, school events, sports practices, homework and unpaid bills that fall inside the trip window — calendar- and bill-aware.; `lib/services/trips/index.ts:312-419` buildPlan writes vacation_activities, itinerary days/items and upserts vacation_budgets; createPackingList (line 511-544) writes packing lists/items using lib/vacations/packing.ts suggestPacking.; `lib/ai/planner/templates/prepare-vacation.ts:52-96` Prepare-vacation workflow: getTrip, commitmentConflicts, documentsRisk, computeReadiness, home.listOpenMaintenance (line 58), buildPlan, packing lists, calendar sync, home-away checklist 'trash out, mail held, pets covered, thermostat set' (line 72), reminders, verify step, T-2 follow-up.; `lib/vacations/readiness.ts:42` computeReadiness: weighted 0-100 score over bookings, packing, documents, emergency contacts, budget, itinerary coverage.; `lib/trips/departure.ts:64-167` Departure planning with traffic factor and weather delay; app/(app)/dashboard/trip-intel/actions.ts:191 refreshDeparturePlanAction recomputes leave-by (departure_plans, migration 0098) — the only disruption-style replanning, and it is for local event departures, not travel.; `components/vacations` grep disrupt|replan|resched across lib/vacations, lib/trips, components/vacations finds only status labels (vacations-list.tsx, vacations-reports.tsx); no flight-delay/cancellation replanning logic exists.

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `lib/vacations/disruption.ts`
- `lib/vacations/conflicts.ts`
- `lib/ai/planner/templates/prepare-vacation.ts`
- `lib/services/trips/index.ts`
- `lib/ai/tools/*`
- `app/(app)/dashboard/vacations/[id]/travel/*`
- `app/(app)/dashboard/vacations/[id]/actions.ts`

**Tests to add**: `tests/vacation-disruption.test.ts`, `tests/prepare-vacation-pets.test.ts`

**Done when**: prepare-vacation emits one task per pet from the pets table; replanDisruption is pure and tested; the Report a disruption action persists itinerary shifts and notifies without claiming a rebooking; tool registered; i18n gate clean.

### S-06 · M9 — the school and sports front desk

> M9 School & Sports front desk (no-migration half) — pure classifier, approval-gated proposals, desk card in the school module

- This is the NO-MIGRATION slice. Anything in the audit's Build line that needs new columns/tables/RPCs is OUT (list it in notes as exact DDL and set needs_migration=true if you had to leave something out). Do not write to supabase/migrations.
- Verify every column you write against the CREATE TABLE in supabase/migrations before using it; never assume a column exists.
- Every Supabase read: on error, console.error('[<namespace>] <what> read failed', error) and fail closed (return an error state the UI renders as 'Could not load … Retry'); never render a reassuring empty state on error.
- Server actions/route handlers: use requireUserContext / the existing service layer (lib/services/<domain>, ServiceScope) — never bypass trust gating for writes the AI proposes; a proposal is approval-gated through the existing runAction/gateAiAction/approval_requests spine.
- Do not touch the shared sidebar (memory.md rule). New in-app routes are reached by links from related pages/cards, never by adding them to PRIMARY_NAV/APP_NAV_GROUPS/CURATED_*.
- Other implementers are working in parallel on the Daily Brief (lib/briefing/build.ts, briefing-module), Needs You (lib/home/needs-*), Handled ledger (lib/ai/runs), notifications (lib/services/notifications), trust module Activity tab, meals loop, metrics core, and the public homepage/nav/footer/pricing/security pages. Keep your edits to the files your item names; if you must touch one of those shared files, make the smallest additive change.

BUILD (no migration — family_inbox_messages has only channel/direction/from_addr/to_addr/subject/body/ai_summary/ai_intent/ai_handled/status/provider_ref/occurred_at; there is NO member_id/linked_*/sub_intent/metadata column, so classification is derived at read time and 'applied' is expressed with the existing ai_handled boolean + status='archived'):
1. Pure classifier lib/front-desk/school-sports.ts classify(message, members, teams, classes) → { domain:'school'|'sports'|null, subKind:'form'|'fee'|'gear'|'transport'|'schedule_change'|null, child?: {member_id, name}, date?: ISO, amount_cents?, confidence } — deterministic (keywords, currency/date extraction, child-name matching against family_members and team/class rosters), exhaustive tests including false-positive guards (a grocery receipt is not a fee).
2. Wire it into lib/contact-center/routing.ts so ai_intent can be 'school' or 'sports' (ai_intent is free text — verify no CHECK constrains it) and into the inbox AI import path (app/api/ai/import) so pasted school/sports text yields the same proposals.
3. Proposals: for a classified message, a server action proposes through the existing runAction/gateAiAction pipeline (approval-gated, never auto-executed): school_events/sports_events via lib/services/school|sports, a reminder for a form deadline, an opportunities row for a fee (see components/modules/signups-module.tsx), grocery items for gear, a rides entry for transport. Each proposal that is approved and executed marks the message ai_handled=true (persisted) — the UI shows 'Handled' ONLY from that boolean.
4. 'School & Sports desk' card in components/modules/school-module.tsx (and a matching line in sports if cheap) listing unhandled inbox messages classified school/sports with the sub-kind chip and a one-tap 'Propose' that opens the approval; read fails closed.
--- AUDIT M9 — School + Sports Front Desk: ingest communications and coordinate schedules, forms, fees, gear, transport and changes — status partial ---
- Reachable: /dashboard/school, /dashboard/sports, /dashboard/signups, /dashboard/inbox, /dashboard/front-desk, /dashboard/contact-center (all requireFeature); webhooks /api/contact-center/{email,sms,voice} require CONTACT_CENTER_INBOUND_SECRET + an external inbound provider
- Persisted: family_inbox_messages, family_contact_channels, family_communications, family_contacts, school_events, school_classes, homework_assignments, grades, teams, sports_events, opportunities, call_logs, front_desk_settings
- Tested: tests/contact-center.test.ts, tests/service-school-sports.test.ts, tests/school-timetable.test.ts, tests/opportunities-deadlines.test.ts, tests/family-school-read-boundary.test.ts, tests/family-sports-read-boundary.test.ts
- Mock risk: 'AI Front Desk' is phone screening; inbox 'AI Import' is a manual paste that yields generic actions; automatic email ingestion only works when a provider is wired to the webhook, and even then the message is filed with a generic intent and never turned into a school/sports action.
- Gap: No school/sports-aware pipeline: inbound messages are not classified as school/sports nor decomposed into forms-to-sign, fees due, gear lists, transport/carpool needs or schedule changes; no link from a message to a child/team/event; no coordination (change -> calendar update + reminder + ride). Forms and gear have no entity at all (grep permission slip/gear/equipment in school/sports modules: 0 hits).
- Build (L, migration: yes): Add a pure school/sports classifier (intent + sub-kind form/fee/gear/transport/schedule_change + extracted date/amount/child) used by both the inbound webhook and the inbox AI import; when it fires, run the existing runAction/gateAiAction pipeline to propose school_events/sports_events (via services), a reminder for the form deadline, an opportunities row for the fee, grocery items for gear, and a rides entry for transport, all approval-gated; show a 'School & Sports desk' card in the school module listing pending linked messages with one-tap apply.
  - Migration: Add nullable member_id, linked_type, linked_id (and sub_intent text) to family_inbox_messages so a message can be tied to a child/team/event and its applied action; RLS unchanged (family-scoped). Owner approval required.
- Evidence: `app/api/contact-center/email/route.ts:45-120` Inbound email webhook (secret-gated) resolves family by @bubaly.com local-part, files into family_inbox_messages via recordInboundMessage, runs concierge classification, auto-replies; SMS/voice siblings at app/api/contact-center/{sms,voice}; `lib/contact-center/server.ts:126-155` recordInboundMessage upserts family_inbox_messages with ai_intent/ai_summary, dedupes on channel+provider_ref; `lib/contact-center/routing.ts:9-45` Intents are urgent/appointment/delivery/sales/spam/personal only — no school, sports, form, fee, gear or transport intent; `components/modules/inbox-module.tsx:30-41,74,686-704` Communications Hub over family_communications (0090) with school/sports channels and category labels; AI Import modal posts pasted text to /api/ai/import; `app/api/ai/import/route.ts:17-23` Magic import can only propose create_calendar_event, create_chore, create_reminder, add_grocery_item, create_meal_plan_entry — no forms, fees, gear, transport; `components/modules/school-module.tsx:28,118-128` School hub reads school_events (types general/holiday/field_trip/parent_meeting/exam/concert/sport/graduation/assignment/announcement), school_classes, grades; manual forms only; `lib/services/school/index.ts:44-133 and lib/services/sports/index.ts:1-50` Read services for school events, homework, A/B timetable, teams and recurring practices used by planner/brief; `components/modules/signups-module.tsx:30-56` Registrations over opportunities table with cost, deadline, status registered/waitlisted — the only fee/deadline tracking

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `lib/front-desk/school-sports.ts`
- `lib/contact-center/routing.ts`
- `app/api/ai/import/route.ts`
- `components/modules/school-module.tsx`
- `app/(app)/dashboard/school/actions.ts`
- `lib/services/school/index.ts`
- `lib/services/sports/index.ts`

**Tests to add**: `tests/school-sports-classifier.test.ts`, `tests/school-sports-desk.test.ts`

**Done when**: Classifier is pure, tested and wired into inbound routing and import; proposals go through the approval spine; the desk card lists real unhandled messages and Handled is read from ai_handled; i18n gate clean.

### S-07 · M18 + M37 + W6 — the display, its setup, and the hardware story

> M18(a,b) + M37 + W6 (no-migration) — display: ask + handled tiles, wake lock, first-run setup card, /display/setup self-check, certified-devices marketing page and compare lib

- This is the NO-MIGRATION slice. Anything in the audit's Build line that needs new columns/tables/RPCs is OUT (list it in notes as exact DDL and set needs_migration=true if you had to leave something out). Do not write to supabase/migrations.
- Verify every column you write against the CREATE TABLE in supabase/migrations before using it; never assume a column exists.
- Every Supabase read: on error, console.error('[<namespace>] <what> read failed', error) and fail closed (return an error state the UI renders as 'Could not load … Retry'); never render a reassuring empty state on error.
- Server actions/route handlers: use requireUserContext / the existing service layer (lib/services/<domain>, ServiceScope) — never bypass trust gating for writes the AI proposes; a proposal is approval-gated through the existing runAction/gateAiAction/approval_requests spine.
- Do not touch the shared sidebar (memory.md rule). New in-app routes are reached by links from related pages/cards, never by adding them to PRIMARY_NAV/APP_NAV_GROUPS/CURATED_*.
- Other implementers are working in parallel on the Daily Brief (lib/briefing/build.ts, briefing-module), Needs You (lib/home/needs-*), Handled ledger (lib/ai/runs), notifications (lib/services/notifications), trust module Activity tab, meals loop, metrics core, and the public homepage/nav/footer/pricing/security pages. Keep your edits to the files your item names; if you must touch one of those shared files, make the smallest additive change.

BUILD (no migration — device pairing/display_devices is OUT):
1. components/display: add tile keys 'ask' (mounts components/concierge/ask-bubaly with the existing useSpeechRecognition mic; submissions go through the same POST /api/ai/requests, so trust gating is unchanged) and 'handled_today' (fed from lib/briefing handled — completed runs only, count + last three items; read fails closed). Register them in lib/display/tiles.ts (keep DEFAULT_TILES order stable unless a test allows otherwise) and the layout editor.
2. Screen Wake Lock: lib/display/wake-lock.ts (navigator.wakeLock.request('screen') with visibilitychange re-acquire, feature-detect, never throws) used by display-grid.tsx; status surfaced in the first-run card.
3. First-run card on /display: dismissible 'Set up this tablet' (Add to Home Screen, iPad Guided Access / Android screen pinning, fullscreen, wake lock status, refresh cadence) persisted in display_layouts.settings via the existing normalizeSettings path (verify the settings jsonb column exists).
4. app/(app)/display/setup/page.tsx: the in-app checklist with a 'Test this display' self-check (fullscreen API, wake lock, online, lib/display/recover) — results shown live, nothing claimed that was not checked. Linked from the display header.
5. Marketing: lib/marketing/certified-devices.ts (typed catalog: tiers recommended/compatible, models, min OS/browser, stand notes, setup steps — English label + labelKey) and lib/marketing/display-compare.ts (pure: what a family needs to buy/do with Bubaly vs a dedicated display product, NO competitor prices, no superlatives); app/(marketing)/display/page.tsx 'A shared family screen on the tablet you already own' rendering both, badged 'Illustrative sample' wherever a mock is shown, with a link to /display/setup for signed-in users. Register the route in PUBLIC_ROUTES/middleware/sitemap/route-contract tests as the other public pages are. Do NOT edit the marketing header/footer/nav/homepage/mobile page or DeviceShowcase — the site tranche links to this page.
6. docs/PHYSICAL_DEVICE_TEST_PLAN.md: add a wall-display script (install, fullscreen, wake lock, rotate, 24h soak).
--- AUDIT M18 — Kitchen / Wall Mode — tablet/browser command center — status exists ---
- Reachable: Sidebar 'Kitchen Display' → /display (navigation.ts:166, minLevel 1); requireFeature('/display') → feature catalog 'kitchen' default tier 'basic' (feature-catalog.ts:105, plans.ts:113); super-admin bypass. Also a valid service-launcher href for tiles.
- Persisted: Reads: family_members, calendar_events, chore_assignments, chores, meal_plans, meals, grocery_items, reminders, notes, family_recipes, family_photos. Writes: display_layouts (tiles, settings, updated_by) via client upsert under family RLS (0026 + 0200). Timers: localStorage only.
- Tested: tests/display-render.test.ts, tests/display-tiles.test.ts, tests/display-ambient.test.ts, tests/display-server-safety.test.ts, tests/display-recover.test.ts, tests/display-imagery.test.ts, tests/display-name-firstname.test.ts. No Playwright spec touches /display (grep '/display' tests/e2e → none).
- Mock risk: By design every widget read is best-effort: a failing query is console.error'd and the tile renders empty/'—' (page.tsx:87-90, emptyDisplay fallback at 231-237), so a broken RLS or missing table looks like an empty family rather than an error. Requires a normal signed-in user session on the tablet — there is no kiosk pairing/device login, so a logged-out tablet just redirects to sign-in.
- Gap: The wall itself is real and hardened, but it is a read-mostly board: no Ask Bubaly / voice on the display (grep voice|ask|assistant in components/display → none), no kiosk pairing or device-scoped session (a full parent login lives on the counter), timers are per-device localStorage, no 'handled today' / brief / approvals widgets from the Phase 5-7 runtime, and zero e2e coverage of /display.
- Build (M, migration: yes): Keep the existing shell; add (a) an 'ask' widget key that mounts components/concierge/ask-bubaly with the existing useSpeechRecognition mic and a 'handled today' widget fed from lib/briefing handled(), (b) a /display/setup guide route (install PWA, fullscreen, keep-awake, orientation) linked from the display header, (c) optional kiosk pairing: a display_devices table (family_id, hashed pairing code, label, last_seen_at, revoked_at) + a pairing page that mints a short code from a signed-in phone and a cookie-scoped read-only session for the tablet. (a)+(b) need no migration; (c) does.
  - Migration: Only the optional kiosk pairing (display_devices + RLS + a SECURITY DEFINER RPC to redeem a code) needs a migration; the ask/handled widgets and the setup guide ship without one.
- Evidence: `app/(app)/display/page.tsx:20-256` Server page 'Kitchen Display' (force-dynamic). loadDisplay() reads family_members, calendar_events (today/14d/month), chore_assignments, meal_plans, grocery_items, reminders, notes, family_recipes, family_photos and display_layouts (lines 54-80); requireFeature('/display') gate with reconnect screen on transient failure (214-225); AutoRefresh every 120s and client-only DisplayShellClient (244-256).; `components/display/display-grid.tsx:499-503,541-547,573-575` Fullscreen toggle, kiosk one-viewport fit, and layout save = supabase.from('display_layouts').upsert({family_id, tiles, settings, updated_by}, {onConflict:'family_id'}). 14 built-in widgets + a 'service' launcher tile for any app route.; `lib/display/tiles.ts:20-24,84-108` Pure tile model; resolveTiles() validates untrusted stored jsonb; SERVICE_WIDGET href allow-list.; `lib/display/ambient.ts:1-6` Pure day-part theming, now/next, countdown, settings normalization used by the wall.; `supabase/migrations/0026_display_layouts.sql:8-35` display_layouts table (one row per family, tiles jsonb) with is_family_member RLS on all four verbs.; `supabase/migrations/0200_display_settings.sql:15-16` settings jsonb column on display_layouts (clock24, tempUnit, theme, ambient, screensaver).; `components/display/kitchen-timers.tsx:6,29,37` Kitchen timers persist only in localStorage (per device, not shared across displays).; `app/(app)/display/error.tsx:3-11` Kiosk error boundary with stale-bundle hard-reload escalation (lib/display/recover.ts).

--- AUDIT M37 — Hardware Partnerships — certified tablets/displays/stands program + in-app device setup — status missing ---
- Reachable: Nothing for a certified-devices program: no marketing route, no in-app 'set up a display/tablet' path (no /display/setup, no onboarding step; grep -rln kiosk|pairing lib app components hits only display internals). /dashboard/devices reaches smart-home inventory only.
- Persisted: None for displays. smart_devices (home inventory) and push_devices (push tokens) exist but model different things.
- Tested: None. tests/home-management.test.ts covers smart-home helpers only; no e2e for /display on tablets.
- Mock risk: 'Smart Home' in the sidebar and 'Kitchen Display Mode: iPad/Android tablet/Smart display' on pricing could be read as a hardware program; both are unrelated to certifying or setting up displays.
- Gap: No certified-devices list, no compatibility matrix (tablet models, browsers, stands, keep-awake behaviour), no public program page, no in-app 'Set up this display' guide, no display device registration/pairing, no device test script for the wall in the QA plan.
- Build (M, migration: no): Ship the program as content + a guided setup path, no schema: (1) app/(marketing)/display/page.tsx — 'Works with any tablet' certified-devices page (tiers: recommended/compatible, models, stand links, setup steps) driven by a typed catalog in lib/marketing/certified-devices.ts; (2) app/(app)/display/setup/page.tsx — in-app device setup checklist (install PWA, fullscreen, auto-lock off, orientation, refresh cadence) with a 'Test this display' self-check using existing lib/display/recover + fullscreen APIs; (3) add a wall-display script (D3/D5) to docs/PHYSICAL_DEVICE_TEST_PLAN.md. Pairing/device registration is deferred to M18(c). Marketing site and per-page links are free under the standing sidebar rule.
- Evidence: `app/(app)/dashboard/devices/page.tsx:1-10` 'Smart Home' page → DevicesModule behind requireFeature('/dashboard/devices').; `components/modules/devices-module.tsx:18,29-31,44-45` A manual inventory of smart_devices (insert/update/delete) — lights, locks, thermostats; nothing about displays or tablets.; `lib/home/devices.ts:4-11` DEVICE_TYPES light/lock/thermostat/camera/sensor/plug/hub/speaker/doorbell/vacuum/other; integrations homekit/google/alexa/smartthings/matter/manual — no 'display'/'tablet' type, no certification concept.; `supabase/migrations/0081_home_management.sql` smart_devices table origin (home management).; `tests/home-management.test.ts:115-128` Only summarize/groupByRoom/integrationLabel are tested.; `supabase/migrations/0035_push_devices.sql:1-8` push_devices = per-user push registrations (web/ios/android tokens), not display devices.; `docs/PHYSICAL_DEVICE_TEST_PLAN.md:1-30` Manual QA plan for mobile web (iPhone/iPad/Android); grep -i 'display|kiosk' finds no wall-display or tablet-kiosk script.; `app/manifest.ts:14-17` Only hardware-facing accommodation: orientation 'any' because the /display kiosk targets landscape tablets.

--- AUDIT W6 — Hardware: shared display mode exceptional and easy on existing tablets, marketed as such — status partial ---
- Reachable: In-app: /display via APP_NAV_GROUPS (navigation.ts:166), family dashboard quick link, All Services (feature-catalog 'kitchen'); Family Basic+ only. Public: no dedicated page; one pricing bullet + highlight card.
- Persisted: display_layouts (tiles jsonb, settings jsonb) + 12 family tables read per render.
- Tested: tests/display-render.test.ts, display-tiles, display-ambient, display-recover, display-imagery, display-server-safety, display-name-firstname. No e2e for /display; no test for any marketing mention.
- Mock risk: None on the product side (real data, persisted layout). Marketing risk: 'Smart display' in the pricing bullet implies a device category that has no setup path; DeviceShowcase's unused 'Smart Display' type could be mistaken for a shipped surface.
- Gap: The display is real, persisted and unit-tested, but 'easy on existing tablets' is unaddressed (no wake lock, no first-run setup checklist, no pairing) and it is essentially unmarketed: no /display marketing page, no comparison with Skylight/Hearth beyond a one-line 'replacement' mention (pricing-content.tsx:329-330), no mention on /features, /how-it-works or /mobile.
- Build (M, migration: no): (a) Product ease, minimal: add a Screen Wake Lock helper (navigator.wakeLock with visibilitychange re-acquire) used by display-grid.tsx, and a dismissible 'Set up this tablet' first-run card on /display (Add to Home Screen, iPad Guided Access / Android screen pinning, fullscreen, wake lock status) stored in display_layouts.settings via the existing normalizeSettings path. (b) Marketing: app/(marketing)/display/page.tsx 'Turn the tablet you already own into the family display' with setup steps, a Skylight/Hearth comparison (hardware price vs $0 + Family Basic) sourced from a pure lib/marketing/display-compare.ts, render the unused 'Smart Display' card in DeviceShowcase linking to it, and add it to the footer Product group + /mobile page. Device-code pairing is deferred (needs a new table).
- Evidence: `app/(app)/display/page.tsx:21-22,37-38,214` Kitchen Display route, force-dynamic, gated by requireFeature; 'Family Basic feature… layout persisted per-family in display_layouts'.; `app/(app)/display/page.tsx:58-81` Reads family_members, calendar_events, chore_assignments, meal_plans, grocery_items, reminders, notes, family_recipes, display_layouts, family_photos — best-effort per widget.; `lib/constants/plans.ts:113` '/display': 1 — Family Basic plan gate.; `lib/constants/navigation.ts:166` '/display' Kitchen Display in APP_NAV_GROUPS (minLevel 1); also components/dashboard/family-dashboard.tsx:185 quick link and feature-catalog.ts:105.; `components/display/display-grid.tsx:494-502,592` Fullscreen toggle via requestFullscreen; idle photo frame (photo-frame.tsx:5,33).; `components/display/auto-refresh.tsx:10-16` Kiosk auto-refresh + hard reload on stale bundle (lib/display/recover.ts).; `lib/display/ambient.ts:57-94,188-222` Ambient themes, display settings, kitchen timer presets, hints — persisted via display_layouts.settings (0200).; `supabase/migrations/0026_display_layouts.sql` display_layouts table; 0200_display_settings.sql adds settings.

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `components/display/*`
- `lib/display/tiles.ts`
- `lib/display/wake-lock.ts`
- `app/(app)/display/setup/page.tsx`
- `app/(app)/display/page.tsx`
- `lib/marketing/certified-devices.ts`
- `lib/marketing/display-compare.ts`
- `app/(marketing)/display/page.tsx`
- `docs/PHYSICAL_DEVICE_TEST_PLAN.md`

**Tests to add**: `tests/display-ask-handled-tiles.test.ts`, `tests/display-wake-lock.test.ts`, `tests/display-setup-page.test.ts`, `tests/marketing-display-page.test.ts`, `tests/certified-devices.test.ts`

**Done when**: Ask and Handled-today tiles render from real runtime paths; wake lock helper is feature-detected and tested; first-run card persists its dismissal in display_layouts.settings; /display/setup self-check reports only what it measured; /display marketing page exists with no competitor prices; public-route/sitemap tests pass; i18n gate clean.

### S-08 · M23 + M28 — access and sharing, and the cross-household grandparent

> M23 + M28 (no-migration halves) — Access & Sharing panel with time-limited delegation presets; cross-household grandparent digest; role-aware landing; extended-family invite presets

Read audit items M23 and M28. Verified: grants/delegations gate AI and privileged ACTIONS through evaluateTrust, but there is no surface presenting time-limited sharing; a grandparent invited into two families sees one at a time; guest/caregiver land on /home; no invite presets. BUILD: (1) 'Access & Sharing' section on /dashboard/trust: presets built on trust_delegations via the existing createDelegationAction (e.g. 'Babysitter tonight', 'Grandparent this week' — time-limited, domain-scoped) and a per-member 'what they can see / do' summary derived from ROLE_DEFAULTS + grants + active delegations (read-only, honest: say 'actions', not 'data', where RLS is not member-scoped); (2) /dashboard/grandparent-portal iterates ctx.memberships and renders a merged digest via buildGrandparentDigest per family (RLS-bound client per family; fail closed per family with a per-family error card); (3) default guest-role users to the portal on landing (defaultDashboard in the app context / plan helper — NOT a sidebar change); (4) invite presets 'Invite a grandparent / caregiver' in the family invite flow that pre-select role + a delegation on accept (through existing invite + delegation actions). NO new RLS/tables (leave TODOs naming M23's RLS migration and M16's care circles). Tests: tests/trust-sharing-presets.test.ts (preset → delegation payload: domain, expiry, subject), tests/grandparent-multi-household.test.ts (two memberships → two digests merged, one failing family renders an error card not an empty digest), extend tests/grandparent-portal-read-boundary.test.ts.

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `components/modules/trust-module.tsx`
- `app/(app)/dashboard/trust/actions.ts`
- `app/(app)/dashboard/grandparent-portal/page.tsx`
- `lib/grandparent/digest.ts`
- `lib/supabase/auth.ts`
- `components/family/invite-form.tsx`

**Tests to add**: `tests/trust-sharing-presets.test.ts`, `tests/grandparent-multi-household.test.ts`, `tests/grandparent-portal-read-boundary.test.ts (extend)`

**Done when**: Presets create real trust_delegations rows through the existing action; the per-member summary never claims data scoping that RLS does not enforce; a multi-membership grandparent sees all families' digests; a failing family fails closed per card; guests land on the portal without any sidebar change; existing tests green.

### S-09 · M33 — household search with evidence

> M33 Household search (no-migration) — RLS-scoped multi-table search service, ranking, AI tool, command-bar records, /dashboard/search with evidence

- This is the NO-MIGRATION slice. Anything in the audit's Build line that needs new columns/tables/RPCs is OUT (list it in notes as exact DDL and set needs_migration=true if you had to leave something out). Do not write to supabase/migrations.
- Verify every column you write against the CREATE TABLE in supabase/migrations before using it; never assume a column exists.
- Every Supabase read: on error, console.error('[<namespace>] <what> read failed', error) and fail closed (return an error state the UI renders as 'Could not load … Retry'); never render a reassuring empty state on error.
- Server actions/route handlers: use requireUserContext / the existing service layer (lib/services/<domain>, ServiceScope) — never bypass trust gating for writes the AI proposes; a proposal is approval-gated through the existing runAction/gateAiAction/approval_requests spine.
- Do not touch the shared sidebar (memory.md rule). New in-app routes are reached by links from related pages/cards, never by adding them to PRIMARY_NAV/APP_NAV_GROUPS/CURATED_*.
- Other implementers are working in parallel on the Daily Brief (lib/briefing/build.ts, briefing-module), Needs You (lib/home/needs-*), Handled ledger (lib/ai/runs), notifications (lib/services/notifications), trust module Activity tab, meals loop, metrics core, and the public homepage/nav/footer/pricing/security pages. Keep your edits to the files your item names; if you must touch one of those shared files, make the smallest additive change.

BUILD (no migration — the search_household RPC and trigram indexes are OUT; this version fans out PostgREST ilike queries under the caller's RLS and ranks in code; it will be swapped for the RPC later, so keep the service signature stable):
1. lib/services/search/index.ts searchHousehold(scope, q, limit) → ServiceResult<SearchHit[]> running parallel family-scoped ilike queries (title/name/notes columns — verify each table's columns) over documents, inventory_items, trips/vacations, bills, home_warranties + renewals, decisions, calendar_events, notes, family_facts; each table read that fails is reported per-table (hits include a `partial: [{table, error}]` list) — never silently dropped. Pure ranking lib/search/rank.ts (exact > prefix > substring; recency boost; kind weights) with tests. Hits carry evidence: source table, occurred/updated date, deep link (existing routes only).
2. Read-only AI tool search.household in lib/ai/tools (dotted-name pattern, retrieve capability, respects the context policy for child/guest roles — no money hits for non-managers).
3. lib/command-bar/route.ts: a 'record' result kind rendered in components/app/command-bar.tsx (title, kind chip, date) when q ≥ 3 chars, debounced via a server action; nav/capture/intent results keep their order and tests/command-bar-route.test.ts stays green.
4. app/(app)/dashboard/search/page.tsx?q=… (not in the sidebar; reached from the command bar 'See all results'): results grouped by kind with evidence line and a 'Some sources could not be searched: …' notice when partial.
--- AUDIT M33 — Best-in-Class Household Search: search household history, documents, items, trips, bills, warranties and decisions with evidence — status partial ---
- Reachable: Cmd-K bar (components/app/command-bar.tsx) app-wide; per-module search boxes on /dashboard/documents, /dashboard/knowledge, /dashboard/memories
- Persisted: Per-module family-scoped selects (documents, family_facts, family_memories) filtered client/server in memory; no search index, no RPC
- Tested: tests/command-bar-route.test.ts, tests/memory-search.test.ts, tests/family-facts.test.ts (filterFacts)
- Mock risk: The command bar reads as a household search box but only matches nav labels and routes text to capture/assistant; typing 'furnace warranty' yields 'Ask the assistant', not a record.
- Gap: No unified household search over documents, inventory items, trips, bills, warranties/renewals, decisions, events and facts; no ranking, no evidence (source, date, link) in results; no search index or RPC; only isolated per-module filters.
- Build (L, migration: yes): Add a SECURITY INVOKER SQL function search_household(family_id, q, limit) that UNIONs pg_trgm similarity + ilike over documents, inventory items, trips, bills, renewals/warranties, decisions, calendar_events, notes and family_facts, returning (kind, id, title, snippet, occurred_at, rank); wrap it in lib/services/search with ServiceScope (RLS-enforced), expose a read-only AI tool search.household, add a 'record' result kind to lib/command-bar/route.ts rendered in the bar, and a /dashboard/search results page with evidence (source table, date, deep link).
  - Migration: New function public.search_household (security invoker, search_path pinned) plus GIN trigram indexes on title/name columns of the searched tables; no new tables, RLS of underlying tables applies. Owner approval required.
- Evidence: `lib/command-bar/route.ts:1-13,53-100` Cmd-K bar ranks results across navigate (fuzzy nav labels), capture (task/note/event/shopping), intent (reasoning engines) and 'Ask the assistant' fallback — it never queries household data; `components/app/command-bar.tsx:7,146` Placeholder 'Search, add a task, or ask'; non-matches POST to /api/ai/requests; no search RPC or table query; `lib/files/overview.ts:33-34 and components/modules/documents-module.tsx:195-311` Documents search is a client-side title/category filter over already-loaded rows; `lib/services/memory/index.ts:399-421 and lib/family/memory-search.ts` Facts and memories are filtered in memory after a family-scoped select (filterFacts / memoryMatches); `supabase/migrations/0001_extensions_enums.sql:5` pg_trgm extension enabled but no trigram/tsvector index or search function over household tables (grep tsvector|to_tsquery|websearch_to_tsquery|embedding|vector( in migrations/lib/app: only marketing platform + i18n strings); `find app/api -path '*search*'` Only app/api/recipes/search (external recipe provider) and app/api/gif/search — no household search endpoint; `tests/command-bar-route.test.ts, tests/memory-search.test.ts, tests/definer-search-path-pinned.test.ts` Tests cover command routing and in-memory memory filtering; no cross-entity search behaviour

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `lib/services/search/index.ts`
- `lib/search/rank.ts`
- `lib/ai/tools/*`
- `lib/command-bar/route.ts`
- `components/app/command-bar.tsx`
- `app/(app)/dashboard/search/page.tsx`
- `app/(app)/dashboard/search/actions.ts`

**Tests to add**: `tests/search-rank.test.ts`, `tests/search-service.test.ts`, `tests/search-service-read-boundary.test.ts`, `tests/command-bar-route.test.ts`

**Done when**: searchHousehold returns ranked hits with evidence across ≥9 tables under RLS and reports per-table failures; tool registered read-only with role policy; command bar shows record hits without disturbing existing kinds; /dashboard/search renders groups + partial notice; i18n gate clean.

### S-10 · M25 + M34 — launchable outcomes and life-event intelligence

> M25 + M34 — launchable outcome templates and life-event intelligence (detect, orchestrate, concierge intent)

M25 GAP: three disconnected engines — static outcome links (lib/outcomes/launcher.ts, components/modules/outcomes-launcher.tsx each step is a plain <Link>), six life-event checklists (lib/life-events/templates.ts), nine planner workflows (lib/ai/planner/templates/index.ts:106-116,135-152; prepare-vacation.ts is the only strategy template). Missing templates: Tournament Day, School Morning, Back-to-School (only a school_start checklist), Holiday, Emergency Prep; the Outcomes page cannot start a run; life-event launches are not ledgered in ai_requests. M25 BUILD: add WorkflowTemplates tournament_day, school_morning, back_to_school, holiday, emergency_prep and moving under lib/ai/planner/templates (composed ONLY from existing registered tools: calendar/tasks/reminders/groceries/documents/notifications), register their intents in lib/ai/context/intents.ts + INTENT_SLICES and lib/ai/planner/prompts.ts, map each OUTCOME in lib/outcomes/launcher.ts to a template intent, and give components/modules/outcomes-launcher.tsx a 'Have Bubaly do it' button that POSTs to /api/ai/requests with the intent hint (so the launch lands in ai_requests/ai_plans and shows on Home 'Working on'); add holiday + emergency_prep life-event checklists for families without AI. M34 GAP: only 6 life-event templates (missing camp, aging_parent, renovation, holidays); no detection from household data; launched plans are self-contained checklists (nothing lands on calendar/tasks/reminders or hands off to Move Planner/Home Projects/Vacations); no concierge intent. M34 BUILD: (1) extend lib/life-events/templates.ts with camp, aging_parent, renovation, holidays (reuse SEASONAL_CHECKLIST ideas from lib/home/maintenance.ts and lib/celebrations dates); (2) PURE lib/life-events/detect.ts: from school_classes/timetable dates, recently created pets, home_projects in planning, family_facts (e.g. parent care), holiday windows → ranked suggested transitions with a reason; render as 'Coming up' in components/modules/life-events-module.tsx and as a proactive slice entry in lib/ai/context/slices/proactive.ts; (3) on launch (app/(app)/dashboard/life-event-actions.ts) create linked artefacts through existing services: todos via lib/services/tasks for buy/plan/notify items, reminders for dated items, and hand off to Move Planner (moves) / Home Projects (home_projects) / Vacations for moving/renovation/vacation keys, storing the link reference in life_event_plan_items.note (no schema change); (4) intent 'life_event' → lib/ai/planner/templates/life-event.ts so 'we're getting a puppy' launches a plan. EVIDENCE: lib/outcomes/launcher.ts:8-10,40-49,62-129; components/modules/outcomes-launcher.tsx:91-104; lib/life-events/templates.ts:34-122,142-163; app/(app)/dashboard/life-event-actions.ts:19-53; components/modules/life-events-module.tsx:51-62.

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `lib/ai/planner/templates/index.ts`
- `lib/ai/context/intents.ts`
- `lib/ai/planner/prompts.ts`
- `lib/outcomes/launcher.ts`
- `components/modules/outcomes-launcher.tsx`
- `lib/life-events/templates.ts`
- `app/(app)/dashboard/life-event-actions.ts`
- `components/modules/life-events-module.tsx`
- `lib/intent/detect.ts`
- `lib/ai/context/slices/proactive.ts`
- `lib/planning/prep-server.ts`

**Tests to add**: `tests/planner-templates.test.ts (extend: each new skeleton's tools exist, inputs validate, no cycles)`, `tests/outcomes-launcher.test.ts (extend: every outcome maps to a template intent)`, `tests/outcomes-launch-request.test.ts`, `tests/life-events-templates.test.ts (extend: ten templates incl. holiday/emergency_prep/camp/aging_parent/renovation/holidays with unique keys)`, `tests/life-events-detect.test.ts`, `tests/life-event-actions-boundary.test.ts`

**Done when**: Every new template validates against the registered tool catalogue with no cycles; every outcome maps to an intent; the launch button submits an ai_requests row with the intent hint (fake supabase); detect proposes school_start within 45 days of a term start, new_pet for a pet added this week, renovation for a planning-stage project; launching a life event creates todos/reminders through services and hands moving off to a moves row, and a failed write rolls the plan back rather than leaving half; existing template/outcome/life-event tests stay green.

### S-11 · M19 — voice on every Ask surface, and on the phone

> M19 Voice Everywhere — one MicButton on every Ask surface, bearer auth on voice routes, Expo recording

GAP: voice lives in two silos — /dashboard/voice (components/modules/voice-module.tsx via lib/hooks/use-speech-recognition.ts + lib/voice/command-router.ts) and the assistant chat mic (components/modules/assistant-module.tsx via lib/hooks/use-voice.ts: MediaRecorder → /api/ai/voice/transcribe, TTS via /speak). No mic on the home Ask bar (components/home/ask-bar.tsx), the command bar (components/app/command-bar.tsx), concierge Ask Bubaly (components/concierge/ask-bubaly.tsx) or the kitchen display; the voice API routes are cookie-only so mobile bearer callers get 401; the Expo app cannot record. BUILD: (1) extract the assistant's mic flow into a PURE state machine lib/voice/mic-flow.ts (idle→recording→transcribing→submit; fallback to Web Speech when transcribe returns 503 / no key) and a shared client component components/voice/mic-button.tsx (uses use-voice + use-speech-recognition; SSR-safe; accessible name; 44px target); mount it in ask-bar.tsx, command-bar.tsx, ask-bubaly.tsx and assistant-module.tsx (replacing its inline mic), and as an 'ask' tile in components/display/display-grid.tsx that renders without a mic in SSR. (2) make app/api/ai/voice/transcribe/route.ts and app/api/ai/voice/speak/route.ts accept the same bearer JWT auth as /api/ai (see lib/supabase/bearer.ts and how app/api/ai resolves the caller) while keeping cookie auth; anonymous → 401; no key → 503. (3) Expo: add expo-av recording in mobile/app/(tabs)/assistant.tsx posting to the transcribe route with the bearer token via mobile/src/lib/api.ts; run `cd mobile && npx tsc --noEmit`. No migration. EVIDENCE: app/(app)/dashboard/voice/page.tsx:1-10; components/modules/voice-module.tsx:9,55-58,87-105; lib/voice/command-router.ts:1-6,65-80; lib/hooks/use-speech-recognition.ts:3-6; lib/hooks/use-voice.ts:24-31.

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `components/modules/assistant-module.tsx`
- `components/home/ask-bar.tsx`
- `components/app/command-bar.tsx`
- `components/concierge/ask-bubaly.tsx`
- `components/display/display-grid.tsx`
- `app/api/ai/voice/transcribe/route.ts`
- `app/api/ai/voice/speak/route.ts`
- `mobile/app/(tabs)/assistant.tsx`
- `mobile/src/lib/api.ts`

**Tests to add**: `tests/voice-mic-flow.test.ts`, `tests/ai-voice-routes-auth.test.ts`, `tests/display-render.test.ts (extend: ask tile renders without a mic in SSR)`

**Done when**: Pure state machine tested incl. 503 fallback; transcribe/speak accept a bearer JWT, reject anonymous, return 503 without a key; the ask tile renders in SSR without a mic; web tsc and mobile tsc both clean; the existing assistant/voice tests stay green.

### S-12 · M17 — the purchase advisor

> M17 Household Purchase Advisor — 'Before you buy' grounded in owned items, preferences and budget

GAP: nothing checks owned items, compatibility (brand/model/serial exist on inventory_items and home_assets but are unused), preferences (family_facts) or budget before recommending; 'AI shopping tips' / 'AI gift ideas' (lib/ai/insights.ts:261-270,333-341) are generic LLM text. BUILD: (1) PURE lib/purchases/advisor.ts: input = candidate item {text, url?, priceCents?} + inventory_items + home_assets + wardrobe_items + wishlist_items + budgets/spent + family_facts; output = owned duplicates (via lib/inventory/finder searchItems), compatibility hints from brand/model of related assets, matching preference facts, and an affordability verdict via lib/twin/simulate simulateDecision('spend'); (2) server action app/(app)/dashboard/wishlists/actions.ts adviseBeforeBuying assembling the rows family-scoped (fail closed) and optionally calling the AI insights route with a new 'purchase_advisor' kind for market suggestions that are GROUNDED in the deterministic result (the deterministic verdict is shown even with no AI); (3) 'Before you buy' panel components/wishlists/before-you-buy.tsx on each wishlist item in components/modules/wishlists-module.tsx; (4) a 'should we buy X?' intent in lib/ai/context/intents.ts routing to the advisor. No recommendation may be paid/biased; say so in a code comment where market suggestions are produced. EVIDENCE: lib/ai/insights.ts:261-270,333-341; supabase/migrations/0043_wishlists.sql:13-29; lib/services/finances/index.ts:741-781; lib/twin/simulate.ts:182.

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `components/modules/wishlists-module.tsx`
- `lib/ai/insights.ts`
- `lib/ai/context/intents.ts`
- `lib/twin/simulate.ts`

**Tests to add**: `tests/purchase-advisor.test.ts`, `tests/wishlists-actions-boundary.test.ts`

**Done when**: Flags an owned duplicate by name/model; returns 'tight' when the category budget is nearly spent; surfaces matching preference facts; the action is family-scoped and fails visibly on read errors; the panel renders the deterministic verdict without an AI key.

### S-13 · M22 — one view of what Bubaly believes, with a reset

> M22 Household Memory Controls — one 'what Bubaly believes' view incl. routines and twin traits with reset

GAP: memory controls are split across /dashboard/knowledge (family_facts), Settings > Bubaly AI memory panel (components/settings/ai-memory.tsx: clear learned facts, memory_enabled), /dashboard/playbook (suggestions) and the calendar routines panel; the autopilot digital-twin traits in family_digital_twin_profiles.metadata cannot be inspected or reset by the family. BUILD: extend components/settings/ai-memory.tsx with a 'Routines & traits' section listing detected routine_templates (delete via the existing delete action) and each member's twin traits from family_digital_twin_profiles.metadata with a 'Reset' action (app/(app)/dashboard/settings/ai-actions.ts: managers only; deletes/clears only that member's own family-scoped profile row); link the panel from the Knowledge page header (components/modules/knowledge-base-module.tsx) so the four surfaces are one click apart; extend lib/services/memory listMemories to include routine/trait summaries. Reads fail closed. EVIDENCE: lib/services/memory/index.ts:1-45,130,399,452,543,599,673; lib/ai/tools/memory.ts:66-200; app/(app)/dashboard/knowledge/actions.ts:47-106; components/settings/ai-memory.tsx:86,126,134,161; app/(app)/dashboard/playbook/playbook-actions.ts:44-167.

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `components/settings/ai-memory.tsx`
- `app/(app)/dashboard/settings/ai-actions.ts`
- `components/modules/knowledge-base-module.tsx`
- `lib/services/memory/index.ts`

**Tests to add**: `tests/ai-memory-traits-write-boundary.test.ts`, `tests/service-memory.test.ts (extend: listMemories includes routine/trait summaries)`

**Done when**: Reset deletes only the member's own family-scoped profile and is manager-only; listMemories includes routine/trait summaries; the Knowledge page links to the Settings memory panel; existing memory tests stay green.

### S-14 · M29 + M30 — contacts import, remembered onboarding, one thing to do now

> M29 + M30 (no-migration) — contacts import with a review/entity-resolution step; onboarding facts remembered; 'Do one thing now'

Read audit items M29 and M30. Verified: the migrate wizard imports only events/tasks/grocery/notes from ICS/CSV and its 'Nothing left behind' card overstates; onboarding answers are never written to family_facts; the done screen has no real-workflow handoff. BUILD: (1) extend lib/migrate/parse.ts with a vCard (.vcf) and contacts-CSV parser → family_contacts rows (name, phones, emails, notes; dedupe by normalised email/phone) and a pure resolveImportedItems() that proposes member assignment (name tokens vs family_members display names) and duplicate matches against existing rows (events by title+start, contacts by email/phone); (2) add a 'Review' step to components/migrate/migrate-wizard.tsx between upload and commit showing proposed member/category per item with overrides; commit through app/(app)/dashboard/migrate/actions.ts (family-scoped; audit_logs as today); fix the overstated card copy to name what is imported; (3) after finalizeOnboardingAction succeeds (app/onboarding/actions.ts), call lib/services/memory rememberFact for each structured answer (child ages, household size, goals, region, dinner cadence) with source 'onboarding' and asked_for=true so they are confirmed facts, honouring memory_enabled; (4) a 'Do one thing now' card on the onboarding done step and on /home for first-session users (activation milestone not yet reached) that launches an outcome via buildOutcomePlan seeded from the family's snapshot and links into the first step. Tests: tests/migrate-contacts-parse.test.ts (vCard/CSV → contacts; dedupe), tests/migrate-resolve.test.ts (member assignment + duplicate matching), tests/onboarding-remember-facts.test.ts (answers → rememberFact with source onboarding; skipped when memory disabled), extend tests/onboarding-flow.test.ts.

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `lib/migrate/parse.ts`
- `components/migrate/migrate-wizard.tsx`
- `app/(app)/dashboard/migrate/actions.ts`
- `app/(app)/dashboard/migrate/page.tsx`
- `app/onboarding/actions.ts`
- `components/onboarding/onboarding-wizard.tsx`
- `app/(app)/home/page.tsx`
- `lib/outcomes/launcher.ts`

**Tests to add**: `tests/migrate-contacts-parse.test.ts`, `tests/migrate-resolve.test.ts`, `tests/onboarding-remember-facts.test.ts`, `tests/onboarding-flow.test.ts (extend)`, `tests/migrate-parse.test.ts (existing stays green)`

**Done when**: Contacts import round-trips vCard and CSV with dedupe; the review step assigns members and flags duplicates before commit; onboarding answers become confirmed family_facts with source 'onboarding' unless memory is disabled; first-session users get a real outcome launcher; copy no longer claims 'nothing left behind' beyond what is imported; existing migrate/onboarding tests green.

### S-15 · The metrics core — one handled/time-saved accounting, X3, X5, X7, X10, X12

> Metrics core (no-migration): one handled/time-saved accounting with error-aware reads; X3, X5, X7, X10, X12 defined and shown; X1's mock pattern fixed

Read audit items X1, X3, X4, X5, X7, X10, X12 and the critic's cross-cutting notes on 'HANDLED / TIME-SAVED ACCOUNTING' and 'ERROR-AWARE COUNT HELPER'. Verified: lib/metric/time-saved-server.ts:8-11 safeCount returns 0 on ANY read error and the banner hides at 0 (mock pattern); three inconsistent 'handled this week' definitions (autopilot panel, brief counts.handled, time-saved); no definitions for rework rate, decision compression, graph completeness, conversion-after-value or referral coefficient. BUILD (no schema): (1) NEW lib/metric/count.ts: countOrNull(query) returning number | null (null on error, logged with console.error('[metric] … read failed')), and replace safeCount in time-saved-server.ts and the cnt() helper in app/(app)/dashboard/intelligence/page.tsx so surfaces distinguish 'nothing' from 'unavailable' (render an honest 'unavailable' state, never 0); (2) ONE countHandledThisWeek(supabase, familyId, now) in lib/metric/time-saved-server.ts that adds family_automation_runs in state completed/partially_completed (any trigger) to the existing counts, and make components/concierge/autopilot-panel.tsx (AutopilotPanel) and lib/briefing/build.ts counts.handled consume it; make loadTimeSaved the single time-saved definition and relabel the first-brief number as 'estimated planning time' (an estimate, labelled); (3) pure metric functions with tests: summarizeRework(runs, plansByRequest, events) in lib/ai/activity.ts (X3: completed runs with exactly one ai_plans version and zero step_retried/replanned events ÷ terminal runs); decisionCompression({rawSignals, humanDecisions}) in lib/reasoning/engine.ts (X5: ratio + label, null when no signals) with server counts over the last 7 days of family_signals, autopilot_suggestions, family_ai_recommendations vs approval_requests decided; graphCompleteness(snapshot) in lib/twin/project.ts (X7: expected slots per member/household → 0–100 + missing[] with hrefs; never a gate, optional prompts only); conversionAfterValue(activations, subs) in lib/billing/conversion.ts (X10: Family+ conversion among families that reached first_outcome_viewed; subscription.created_at after the milestone; median days); referralCoefficient({households, referralRows, inviteRows}) in lib/referrals/core.ts (X12); (4) SHOW: admin/reports (service role; fail closed) tiles for X3, X5, X10, X12 and a per-family X7 score on the graph page (/dashboard/graph) with the missing[] list; do not persist weekly series (family_metric_weeks is a migration — leave TODOs). Tests: tests/metric-count.test.ts (null on error + log), tests/handled-this-week.test.ts (one definition; runs counted once), tests/ai-activity-rework.test.ts, tests/reasoning-decision-compression.test.ts, tests/twin-graph-completeness.test.ts, tests/billing-conversion-after-value.test.ts, tests/referrals-coefficient.test.ts, extend tests/time-saved.test.ts.

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `lib/metric/time-saved-server.ts`
- `app/(app)/dashboard/intelligence/page.tsx`
- `components/concierge/autopilot-panel.tsx`
- `lib/briefing/build.ts`
- `lib/ai/activity.ts`
- `lib/reasoning/engine.ts`
- `lib/twin/project.ts`
- `lib/referrals/core.ts`
- `app/(app)/admin/reports/page.tsx`
- `app/(app)/dashboard/graph/page.tsx`
- `components/modules/graph-module.tsx`

**Tests to add**: `tests/metric-count.test.ts`, `tests/handled-this-week.test.ts`, `tests/ai-activity-rework.test.ts`, `tests/reasoning-decision-compression.test.ts`, `tests/twin-graph-completeness.test.ts`, `tests/billing-conversion-after-value.test.ts`, `tests/referrals-coefficient.test.ts`, `tests/time-saved.test.ts (extend)`

**Done when**: No metric surface renders 0 for a failed read (null → 'unavailable'); one handled-this-week definition used by the autopilot panel, the brief and time-saved; five pure metrics defined and unit-tested and shown on admin/reports (service role, fail closed) and X7 on the graph page; time-saved labelled as an estimate; existing briefing/time-saved/activity tests green.

### S-16 · M38 — privacy-safe household benchmarks

> M38 Privacy-safe household benchmarks — banded metrics, admin report, public /resources/benchmarks page, weekly "families like yours" line

- This is the NO-MIGRATION slice. Anything in the audit's Build line that needs new columns/tables/RPCs is OUT (list it in notes as exact DDL and set needs_migration=true if you had to leave something out). Do not write to supabase/migrations.
- Verify every column you write against the CREATE TABLE in supabase/migrations before using it; never assume a column exists.
- Every Supabase read: on error, console.error('[<namespace>] <what> read failed', error) and fail closed (return an error state the UI renders as 'Could not load … Retry'); never render a reassuring empty state on error.
- Server actions/route handlers: use requireUserContext / the existing service layer (lib/services/<domain>, ServiceScope) — never bypass trust gating for writes the AI proposes; a proposal is approval-gated through the existing runAction/gateAiAction/approval_requests spine.
- Do not touch the shared sidebar (memory.md rule). New in-app routes are reached by links from related pages/cards, never by adding them to PRIMARY_NAV/APP_NAV_GROUPS/CURATED_*.
- Other implementers are working in parallel on the Daily Brief (lib/briefing/build.ts, briefing-module), Needs You (lib/home/needs-*), Handled ledger (lib/ai/runs), notifications (lib/services/notifications), trust module Activity tab, meals loop, metrics core, and the public homepage/nav/footer/pricing/security pages. Keep your edits to the files your item names; if you must touch one of those shared files, make the smallest additive change.

BUILD (all four points are no-migration):
1. lib/network/aggregate-server.ts (+ contribution/insights helpers): add banded metrics chores_per_child, bedtime_band, weekly_spend_band, reminders_per_week to contributionFeatures/featuresToContribution, reusing the existing banding approach (coarse bands only, never raw values). Extend the consent-preview banding in lib/network/contribution.ts so the family sees exactly what is contributed. Add tests for banding edge cases and for the cron/server path (CONTRIBUTE then AGGREGATE) with tests/helpers/in-memory-supabase.ts.
2. Admin 'Household Benchmarks' report: a page under app/(app)/admin/ (follow the existing admin page pattern and admin gate) that reads network_aggregates with the service role and renders metric × cohort tables with n and the k-anonymity floor visible; an export button that downloads CSV via a route handler under the same admin gate (no client-side download of secrets).
3. Public page app/(marketing)/resources/benchmarks/page.tsx: server component rendering ONLY aggregates already k-anonymized (reuse aggregatesToInsights with no cohort filter); publication is controlled by a marketing_settings flag if that table exists (verify in migrations; if it does not exist, gate on an env flag BENCHMARKS_PUBLIC=1 and say so in notes) — when unpublished, the route returns notFound(). Every number rendered carries the cohort size and the sentence 'Aggregated from consenting families; no family is identifiable' (translated). Register the route wherever public routes are enumerated (PUBLIC_ROUTES / middleware allowlist / sitemap / route-contract tests — run tests/marketing-public-route-contract.test.ts and tests/marketing-sitemap-closed-loop.test.ts). Do NOT edit the marketing header/footer/nav — the site tranche owns them; link the page from the intelligence module instead.
4. One 'Families like yours …' line in the weekly digest for families whose network_consent has benchmarks enabled: find the weekly digest builder (grep 'weekly' under lib/ and app/api/cron); add a pure helper lib/network/compare-line.ts (family value vs cohort aggregate → one sentence, or null when below floor/without consent) and call it from the digest with a one-line addition. If the only weekly surface is lib/briefing, add the helper and a single call — no restructuring of build.ts.
--- AUDIT M38 — Privacy-Safe Household Benchmarks — status partial ---
- Reachable: /dashboard/intelligence via navigation.ts:79; cron /api/cron/network-aggregate (vercel.json:68).
- Persisted: network_consent (read/write by family), network_contributions and network_aggregates (written by cron with service role; RLS-gated reads), sources family_members/meal_plans/teams/school_classes.
- Tested: tests/network-aggregate.test.ts, tests/network-contribution.test.ts, tests/network-insights.test.ts (pure cores); cron route not tested.
- Mock risk: With the 100-family launch gate (AGG_DEFAULTS.globalMinFamilies) and only two banded metrics, network_aggregates is empty in practice and the Intelligence page shows no insights — the pipeline is real but currently yields nothing visible; and nothing turns aggregates into research or content.
- Gap: Missing: (1) the research/content half — no admin benchmark report, no public /resources or blog page rendering published aggregates, no export for content marketing; (2) metric breadth — only dinner_habit and activities are contributed; no chores-per-kid, screen-time, bedtime, spending bands; (3) the cron/server path has no test; (4) no in-product 'how you compare' card outside the intelligence page (e.g. in the weekly briefing).
- Build (M, migration: no): Add 3–4 banded metrics to contributionFeatures/featuresToContribution (chores per child, bedtime band, weekly spend band, reminders per week) with tests; build an admin 'Household Benchmarks' report page (service role) over network_aggregates and a public marketing page /resources/benchmarks that renders only rows already k-anonymized (reusing aggregatesToInsights, no cohort filter), with an admin toggle for publication in marketing_settings; surface a single 'families like yours' line in the weekly briefing when the family has consent enabled.
- Evidence: `lib/network/insights.ts:16-40` Consent scopes timing/benchmarks/recommendations; K_ANONYMITY_FLOOR = 20; visibleInsights suppresses below floor and when not opted in.; `lib/network/aggregate.ts:1-45` cohortKey = kids age-bands × household-size band (no geography); AGG_DEFAULTS minCohort 20, globalMinFamilies 100, Laplace noiseScale 1.5.; `lib/network/aggregate-server.ts:1-36` Cron core: CONTRIBUTE (per consenting family coarse features → network_contributions; opted-out deleted) then AGGREGATE (k-anon + DP + gate → network_aggregates). Only two metrics: dinner_habit and activities (:31).; `lib/network/contribution.ts:1-45` Informed-consent preview banding ages/counts.; `supabase/migrations/0132_network_consent.sql:12-40` network_consent (enabled default false, scopes jsonb) with family-scoped RLS.; `supabase/migrations/0135_network_aggregates.sql:17-65` network_contributions (family-owned, select/delete only) and network_aggregates (service-written; select policy requires a consent row with the matching scope true).; `app/(app)/dashboard/intelligence/page.tsx:26-58` Reads family_members/meal_plans/teams/school_classes for the contribution preview and network_aggregates for the family's cohort; renders IntelligenceModule.; `components/modules/intelligence-module.tsx:35-53` Reads and upserts network_consent (master toggle + scopes).

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `lib/network/aggregate-server.ts`
- `lib/network/aggregate.ts`
- `lib/network/contribution.ts`
- `lib/network/insights.ts`
- `lib/network/compare-line.ts`
- `app/(app)/admin/benchmarks/page.tsx`
- `app/(marketing)/resources/benchmarks/page.tsx`
- `components/modules/intelligence-module.tsx`

**Tests to add**: `tests/network-benchmark-bands.test.ts`, `tests/network-aggregate-server.test.ts`, `tests/benchmarks-public-page.test.ts`, `tests/network-compare-line.test.ts`

**Done when**: Four new banded metrics flow contribute→aggregate under k-anonymity with tests; admin report and CSV export exist behind the admin gate; /resources/benchmarks renders only k-anonymized rows and 404s when unpublished; a consenting family gets one honest comparison line in the weekly digest; route-contract/sitemap tests pass; i18n gate clean.

### S-17 · M39 — the referral flywheel

> M39 Referral flywheel — ref capture at signup, Stripe-confirmed reward, in-product prompts, referral email

- This is the NO-MIGRATION slice. Anything in the audit's Build line that needs new columns/tables/RPCs is OUT (list it in notes as exact DDL and set needs_migration=true if you had to leave something out). Do not write to supabase/migrations.
- Verify every column you write against the CREATE TABLE in supabase/migrations before using it; never assume a column exists.
- Every Supabase read: on error, console.error('[<namespace>] <what> read failed', error) and fail closed (return an error state the UI renders as 'Could not load … Retry'); never render a reassuring empty state on error.
- Server actions/route handlers: use requireUserContext / the existing service layer (lib/services/<domain>, ServiceScope) — never bypass trust gating for writes the AI proposes; a proposal is approval-gated through the existing runAction/gateAiAction/approval_requests spine.
- Do not touch the shared sidebar (memory.md rule). New in-app routes are reached by links from related pages/cards, never by adding them to PRIMARY_NAV/APP_NAV_GROUPS/CURATED_*.
- Other implementers are working in parallel on the Daily Brief (lib/briefing/build.ts, briefing-module), Needs You (lib/home/needs-*), Handled ledger (lib/ai/runs), notifications (lib/services/notifications), trust module Activity tab, meals loop, metrics core, and the public homepage/nav/footer/pricing/security pages. Keep your edits to the files your item names; if you must touch one of those shared files, make the smallest additive change.

BUILD (no migration — referrals.status already admits 'rewarded', see supabase/migrations/*referral*):
1. Capture: the signup page/form reads ?ref= (normalizeCode), stores it in auth signUp options.data.referral_code AND a short-lived httpOnly cookie (30 days) set by a small route or server action; finalizeOnboardingAction reads cookie-or-metadata and calls applyReferralCode(source 'signup_link') exactly once per family (idempotent — applyReferralCode already enforces one referral per referred family; handle its 'already referred' result quietly).
2. Reward: lib/referrals/server.ts gains rewardReferral(referralId) — after markReferralConverted in app/api/webhooks/stripe/route.ts, credit BOTH families' Stripe customers via customer balance (lib/stripe; negative balance = credit; amounts from the referral row's reward cents) and only after Stripe confirms BOTH credits set status 'rewarded' with the Stripe balance-transaction ids stored in an existing text/jsonb column if one exists (verify the referrals columns; if none, keep them in the notes column or set needs_migration for reward_ref). Must be idempotent (webhook retries): a referral already 'rewarded' is a no-op; a family without a Stripe customer id logs and leaves status 'converted'. Never mark 'rewarded' before Stripe confirms.
3. Product ties + prompts: after a successful member invite in the settings module, show a small 'Know another family? Give $X, get $X' CTA linking to /referrals (uses DEFAULT_REFERRAL_CONFIG, never hardcoded amounts); a dismissible home card (persist dismissal in user preferences if a per-user settings path exists, else localStorage) shown once the family has ≥1 invited member — read the count server-side.
4. Referral email from components/referrals/referral-panel.tsx: an 'Email an invite' form posting to a server action that sends via the existing email pipeline used by InviteEmail (same From, same transport); rate-limit to 10/day per family in memory of the existing throttle pattern (lib/auth/child-throttle.ts style) and record nothing that does not exist as a column.
--- AUDIT M39 — Family Referral Flywheel — status partial ---
- Reachable: /referrals via navigation.ts:194 (share link + manual code entry); admin referral config via marketing settings.
- Persisted: referral_codes, referrals (0039), marketing_settings (config); conversion status via Stripe webhook.
- Tested: tests/referrals.test.ts (core), tests/marketing-core-referral-boundaries.test.ts, tests/admin-referrals-read-boundary.test.ts; no test of signup capture or reward application (neither exists).
- Mock risk: The loop is broken at both ends: the ?ref= param is dropped at signup so a referred family only counts if they later type the code on /referrals; and 'converted' never becomes a credit, so the promised '$10 credit' is displayed but never granted. Referral counts on the page are real rows but reflect manual entry only.
- Gap: Missing: (1) capture of /signup?ref= (cookie or auth metadata) and auto-apply in finalizeOnboardingAction; (2) reward fulfilment — apply referrer/referred credit (Stripe customer balance or coupon) on conversion and set status 'rewarded'; (3) product-value ties: inviting a spouse/grandparent/caregiver (invites) and inviting another household should both surface the referral link and count; (4) in-product prompts (post-invite success, home card, briefing) linking to /referrals; (5) email invite from the referral panel.
- Build (M, migration: no): Read `ref` in the signup form, persist it in auth signUp options.data (referral_code) and a short-lived cookie, then in finalizeOnboardingAction call applyReferralCode with source 'signup_link'. In the Stripe webhook, after markReferralConverted, credit both families via Stripe customer balance (lib/stripe) and update status to 'rewarded' with a new `rewardReferral()` in lib/referrals/server.ts. Add a referral CTA to the invite-success state in settings-module and a home card when the family has ≥1 member invited. Reuse InviteEmail pattern for a referral email in the panel.
- Evidence: `lib/referrals/core.ts:13-60` DEFAULT_REFERRAL_CONFIG ($10 credit both sides), generateReferralCode, normalizeCode, referralLink → /signup?ref=CODE, summarizeReferrals.; `lib/referrals/server.ts:41-67` getOrCreateReferralCode upserts referral_codes with the service role.; `lib/referrals/server.ts:94-131` applyReferralCode: validates code, one referral per referred family, inserts referrals with status 'signed_up' and reward cents.; `lib/referrals/server.ts:134-147` markReferralConverted flips signed_up → converted; nothing writes 'rewarded' or applies any credit.; `app/api/webhooks/stripe/route.ts:62-66` Stripe webhook calls markReferralConverted on active/trialing; grep for coupon/promotion_code/customer_balance in lib/stripe, lib/billing, app/api/stripe finds nothing — reward never reaches billing.; `app/(app)/referrals/page.tsx:14-60` Refer a Family page: code, config, list, summary tiles (Invited/Signed up/Upgraded); app/(app)/referrals/actions.ts:7 applyReferralCodeAction for manual code entry.; `components/referrals/referral-panel.tsx:34-79` Copy link and navigator.share only; no email invites.; `lib/constants/navigation.ts:194` '/referrals' (Refer a Family) in nav; grep for '/referrals' links in components/dashboard/home finds none elsewhere.

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `app/(auth)/signup/page.tsx`
- `app/(auth)/signup/*.tsx`
- `app/(app)/onboarding/actions.ts`
- `lib/referrals/server.ts`
- `lib/referrals/core.ts`
- `app/api/webhooks/stripe/route.ts`
- `lib/stripe/*.ts`
- `components/referrals/referral-panel.tsx`
- `app/(app)/referrals/actions.ts`
- `components/modules/settings-module.tsx`
- `app/(app)/home/page.tsx`

**Tests to add**: `tests/referral-signup-capture.test.ts`, `tests/referral-reward.test.ts`, `tests/referral-email.test.ts`

**Done when**: /signup?ref=CODE ends with a referrals row source signup_link after onboarding; Stripe webhook conversion credits both customers and flips to rewarded only on confirmation, idempotently; invite-success CTA, home card and referral email exist and are translated; tests cover capture, reward idempotency and email throttling.

### S-18 · M26 — quote comparison over the service layer

> M26 honesty fix + compare-quotes helper — the call queue never says "calling" without a provider; quotes compare from persisted project_quotes

- This is the NO-MIGRATION slice. Anything in the audit's Build line that needs new columns/tables/RPCs is OUT (list it in notes as exact DDL and set needs_migration=true if you had to leave something out). Do not write to supabase/migrations.
- Verify every column you write against the CREATE TABLE in supabase/migrations before using it; never assume a column exists.
- Every Supabase read: on error, console.error('[<namespace>] <what> read failed', error) and fail closed (return an error state the UI renders as 'Could not load … Retry'); never render a reassuring empty state on error.
- Server actions/route handlers: use requireUserContext / the existing service layer (lib/services/<domain>, ServiceScope) — never bypass trust gating for writes the AI proposes; a proposal is approval-gated through the existing runAction/gateAiAction/approval_requests spine.
- Do not touch the shared sidebar (memory.md rule). New in-app routes are reached by links from related pages/cards, never by adding them to PRIMARY_NAV/APP_NAV_GROUPS/CURATED_*.
- Other implementers are working in parallel on the Daily Brief (lib/briefing/build.ts, briefing-module), Needs You (lib/home/needs-*), Handled ledger (lib/ai/runs), notifications (lib/services/notifications), trust module Activity tab, meals loop, metrics core, and the public homepage/nav/footer/pricing/security pages. Keep your edits to the files your item names; if you must touch one of those shared files, make the smallest additive change.

BUILD (no migration — the service_providers/service_requests/service_quotes tables are OUT):
1. Honesty: audit the concierge calls queue (grep concierge_calls under lib/, app/, components/) and the find_vendor template. Wherever the UI or a run step reports 'calling', 'called', 'Bubaly is calling…' or similar without a telephony provider having confirmed anything, change the state vocabulary and copy to what is persisted: 'Queued for a call' / 'Waiting for a person to call' / 'No phone provider connected — a parent places this call' (translated). A row may show 'Called' only when a provider confirmation (call sid/outcome) is persisted on the row; verify which columns exist. Add a test that pins the vocabulary: no user-visible 'calling'/'called' string is reachable while the provider outcome column is null.
2. Compare: pure lib/services/providers/compare.ts compareQuotes(quotes) → ranked with reasons (price, availability, warranty/notes present; ties explained) over the existing project_quotes shape; a read-only AI tool services.compareQuotes registered in lib/ai/tools (dotted-name pattern; reads project_quotes through lib/services/home under ServiceScope); render the ranked comparison in the home-projects quote view if a component already lists quotes (smallest additive change).
--- AUDIT M26 — Marketplace / Service Layer — providers, AI-scoped requests, compare, manage — status partial ---
- Reachable: /marketplace (+ browse/deals/auctions/selling/orders/…) from the sidebar; /dashboard/projects for quotes; /dashboard/concierge-calls; find_vendor via the concierge classifier.
- Persisted: marketplace_* tables (20+ migrations) with owner-gated RPCs; home_contractors, home_service_records, maintenance_tasks; home_projects + project_quotes (0246); concierge_calls (0173).
- Tested: tests/marketplace-*.test.ts (~50 files incl. authz, order lifecycle, negotiation security), tests/planner-templates.test.ts (find_vendor), tests/concierge-calls-brief.test.ts, tests/concierge-calls-authz.test.ts, tests/home-management.test.ts.
- Mock risk: The 'AI calls a provider' surface is a queue whose placement step never dials (place/route.ts:60-62); find_vendor deliberately never names an external provider; 'quotes' are typed in by the parent. The marketplace is real but is family/circle goods trading, not a service-provider layer.
- Gap: No provider directory or service categories (home/care/travel/shopping), no service_requests object the AI can scope from a request, no multi-provider quote solicitation/comparison, no booking-workflow state machine, no partner-facing supply side. Existing pieces cover only the family's own contractor book, manual quotes on home projects, a non-dialing call queue, and a goods marketplace.
- Build (XL, migration: yes): Add a thin service layer on top of what exists: migration for service_providers (family-scoped + optional circle-shared, category, contact, source), service_requests (scoped brief, category, status queue→quoting→booked→done, linked maintenance_task/trip/care) and service_quotes (reusing the project_quotes shape); a lib/services/providers domain service + tools services.scopeRequest / services.requestQuotes / services.compareQuotes / services.book registered in lib/ai/tools; extend find_vendor into a 'book_service' WorkflowTemplate whose outreach step enqueues concierge_calls or a templated email via notify(); UI at /dashboard/service-requests reusing the projects quote-compare component.
  - Migration: New tables service_providers, service_requests, service_quotes with is_family_member RLS and a circle-share policy modelled on 0176; requires owner approval.
- Evidence: `app/(app)/marketplace/page.tsx:85-104` Marketplace home reads marketplace_listings, marketplace_offers, marketplace_matches, marketplace_saves, marketplace_stores, marketplace_follows, marketplace_reviews.; `lib/marketplace/listings.ts:14-20` Listing kinds are sell/rent/borrow/free/wanted/swap — goods only, no service kind.; `lib/marketplace/community.ts:1-7` Cross-family reach is opt-in circles via invite code (migration 0176) — not a provider directory.; `supabase/migrations/0120_marketplace.sql` Plus 0150-0199 (matches, v2, saved searches, questions, ownership RPCs, circles, auctions, negotiations, handoffs, price history, returns, reports) — a full peer-to-peer goods marketplace.; `tests/marketplace-authz.test.ts:1-12` Owner-gated SECURITY DEFINER RPC invariants pinned to migrations; ~50 marketplace-* tests in tests/ (listings, auctions, negotiation, order-lifecycle, handoff, returns, read boundaries).; `lib/ai/planner/templates/find-vendor.ts:1-7,19-31` Workflow D 'Find someone to fix it' is deterministic and explicit: 'Bubaly has no external provider search' — it checks home_contractors/service history and hands the booking to a parent as a task.; `lib/services/home/index.ts:137,269-272` Contractor book (home_contractors), home_service_records, maintenance_tasks — the family's own vendors, no marketplace of providers.; `supabase/migrations/0246_home_projects.sql:7-10,62-67` project_quotes: contractor quotes to compare (linked to home_contractors).

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `components/modules/concierge-calls-module.tsx`
- `lib/concierge-calls/*`
- `lib/ai/planner/templates/find-vendor.ts`
- `lib/services/providers/compare.ts`
- `lib/ai/tools/*`
- `components/modules/home-projects-module.tsx`

**Tests to add**: `tests/concierge-calls-honesty.test.ts`, `tests/compare-quotes.test.ts`

**Done when**: No surface says Bubaly is calling or called unless a provider outcome is persisted (test pins it); compareQuotes is pure and tested; the tool is registered read-only; i18n gate clean.

### S-19 · Public site: the Trust Center and the claims it can back

> Public site stage 2 — Trust Center (/security), the verified/in-place/provider/planned trust ledger, /ai honesty edits, /features cards, /mobile and /faq Kitchen Mode

Build these parts of the site spec, which is committed alongside this file as the `site_spec` block below.

TRUST CENTER
Route stays /security (PUBLIC_ROUTES, middleware, sitemap, AEO coverage and route-contract tests untouched). Nav and footer label become 'Trust Center'. generateMetadata fallback description → security.honestDescription (no 'SOC 2 compliance', no 'HIPAA adherence', no 'Bank-level'); title → security.trustCenterMetaTitle.

STRUCTURE:
A. Hero: pill trustCenter.eyebrow 'Trust Center'; h1 trustCenter.title 'What Bubaly may do, what it asks, and what we can prove'; body trustCenter.body. Retire security.enterpriseGradeSecurity, security.builtWithSameStandards usage (keys may stay in the catalogue but are no longer rendered).
B. section id="ai-trust" — 'How the assistant is allowed to act' (trustCenter.aiTitle) with six statements true of the shipped product: ai1 routine work runs on its own within Settings → Bubaly AI (the dial: Recommend / Prepare / Execute per area; DEFAULT_AI_SETTINGS.behavior is 'execute' — say 'you can turn any area down to Recommend', never 'the default is cautious'); ai2 the always-asks list rendered from HIGH_STAKES_AI_DOMAINS through trustDomains.<domain> keys (medical, dental, vision, mental_health, finances, banking, insurance, passports, driving, documents, emergency) so the page cannot drift from lib/trust/engine.ts; ai3 every run keeps a step timeline and partly finished work is reported as partly finished (ai_run_events, mergeCompletedByBubaly in lib/home/today.ts); ai4 quiet hours and the per-family trust ledger; ai5 model calls log task/model/tokens/latency only, never family text; ai6 family data is never used to train models. Optional role table from ROLE_DEFAULTS (trustCenter.role* keys, automationTrusted → trustCenter.automationTrusted / automationNeedsParent). Link trustCenter.manageLink → /dashboard/trust.
C. 'Verified, inherited, or still planned' ledger — lib/marketing/trust-ledger.ts exports `TRUST_LEDGER: { key: string; labelKey: string; status: 'verified' | 'in_place' | 'provider' | 'planned'; evidence?: string[] }[]` and LAST_REVIEWED = '2026-09-07'; rendered by components/marketing/trust-ledger.tsx with four status pills and help text (trustCenter.statusVerified/Help, statusInPlace/Help, statusProvider/Help, statusPlanned/Help), each row with id="ledger-<key>". Initial rows: rls (verified; evidence ['tests/rls-isolation-sweep.test.ts','tests/tenant-isolation-rls.test.ts','tests/sql-security-contract.test.ts']); trust_ledger_append_only (verified; ['tests/0260-trust-ledger-lockdown.test.ts']); high_stakes_asks (verified; ['tests/assistant-trust-wrapper.test.ts','tests/tool-risk.test.ts'] — implementer confirms these assert require_approval for a HIGH_STAKES domain; if not, status in_place); approvals_expire (verified; ['tests/approval-expiry.test.ts']); csp (verified; ['tests/csp-header.test.ts','tests/e2e/csp.spec.ts']); audit_log (in_place); export_delete (in_place); no_training (in_place); tls (provider); at_rest (provider); soc2_providers (provider); soc2_bubaly (planned); pen_test (planned); bug_bounty (planned); status_page (planned); data_region (planned). HIPAA is not a row and appears nowhere; health copy uses trustCenter.healthNote.
D. 'Security at every layer' architecture section stays, trimmed: remove 'Certificate pinning', 'HSM key management', 'Automatic key rotation', 'Column-level encryption for PII', the sentence 'Each layer is independently audited…' (line 222); keep TLS, RLS, RBAC, backups (provider PITR). PILLARS: 'Bank-Level Security' → security.encryptedInTransitAndAtRest; 'Transparent & Accountable' desc drops 'public audits' → security.clearPoliciesPublishedLog.
E. COMPLIANCE_BADGES block (lines 64–80, rendered at 271) and the checkmark list with '99.99% uptime SLA' (line 297) are DELETED, replaced by <TrustLedger/>. DATA_RESIDENCY chooser and the 'SOC 2, ISO 27001, and ISO 27018 certifications' paragraph (line 311) are replaced by the planned row data_region plus one sentence security.dataRegionToday ('Today all family data is hosted in one region on infrastructure that holds SOC 2 and ISO 27001 reports; choosing a region is planned.'). INCIDENT_TIMELINE stays, labelled security.policyNotCertification. SECURITY_FAQ answers rewritten: encryption (no HSM/column-level), vulnerabilities (responsible disclosure at security@bubaly.com; 'independent testing is planned' — no 'regular penetration tests', no 'bug bounty programs'), storage region (matches data_region row), uptime (no '99.99%', no status.bubaly.com — 'a public status page is planned'). Commitments 'Regular penetration tests, security audits' → 'planned independent testing'.

HONESTY GUARD: tests/marketing-trust-ledger.test.ts — every row status ∈ the four; every 'verified' row lists ≥1 evidence path that exists on disk under tests/; rows soc2_bubaly, pen_test, bug_bounty, status_page, data_region are never 'verified' unless evidence includes an https URL; TRUST_LEDGER contains no key matching /hipaa/i; app/(marketing)/security/page.tsx contains id="ai-trust" and '<TrustLedger' and no longer contains 'Audited annually', '99.99%', 'public audits', 'HSM', 'Certificate pinning', 'Column-level', 'independently audited', 'status.bubaly.com', 'COMPLIANCE_BADGES', 'HIPAA', 'SOC 2 Type II', 'ISO 27018', 'Bank-Level'; en-US values for security.* keys still rendered by the page contain none of those phrases either (the test resolves every t('security.…') key used by the page against en-US.json).

AI PROOF (the '/ai page' paragraph only)
keep AiActionDemo, add the same 'Illustrative sample' badge (handledProof.sampleBadge) beside aiShowcase.tryAsking, drop the 'Model-agnostic' chip (line 109) and the phrase 'model-agnostically' from the page description; add a link block ai.howBubalyDecides → /security#ai-trust.

DISPLAY STORY (items 2, 4, 5 — the /features card, the /mobile section and the /faq entry)
Message: 'A shared family screen on the tablet you already own' — Bubaly's answer to Hearth/Skylight is software on hardware families already have. Say 'no new hardware to buy'; never quote a competitor's price; never claim certified hardware, PIN lock, voice control or burn-in protection (none verified in components/display).

Facts the copy may use (all in code): /display (app/(app)/display/page.tsx) is a Family Basic route (ROUTE_PLAN_LEVEL['/display'] = 1); lib/display/tiles.ts has DEFAULT_TILES (featured photo, schedule, timers, weather, meals, chores, grocery, calendar, members) plus service-launcher tiles and five sizes, with per-family layouts; components/display has kitchen timers, a photo frame, weather and auto-refresh; the marketing layout registers the PWA service worker (RegisterSW) so 'Add to Home Screen' runs it full-screen on iPad/Android tablets; toggleFullscreen exists in components/display/display-grid.tsx.

Where it appears: (1) homepage section 6 KitchenModeBand — CSS-only tablet mock composed from DEFAULT_TILES widget ids (no raster asset; 100% width on phones, max 520px desktop), four bullets, tier line, CTA 'Set up Kitchen Mode' → /display, caption 'Example display'. (2) /features gets FeatureCard id="kitchen-mode" (featureCards.kitchenMode / kitchenModeBody, scroll-mt-24, row prop set so the new third row gets a height class) so /features#kitchen-mode is a valid deep link. (3) /pricing SWITCH_HIGHLIGHTS keeps a Kitchen Mode tile (tier Family Basic). (4) /mobile gets one section 'Tablets: Kitchen Mode' (mobile.kitchenModeTitle/Body) linking /features#kitchen-mode. (5) /faq 'mobile-notifications' section gains faq.kitchenModeQ / faq.kitchenModeA. (6) Footer Product group gains 'Kitchen Mode' → /features#kitchen-mode. Later (not this pass): supported-tablet list and a certified-hardware programme, per the strategy's 'later certify hardware'.

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `app/(marketing)/security/page.tsx`
- `lib/marketing/trust-ledger.ts`
- `components/marketing/trust-ledger.tsx`
- `app/(marketing)/ai/page.tsx`
- `components/marketing/reference-showcases.tsx`
- `app/(marketing)/features/page.tsx`
- `app/(marketing)/mobile/page.tsx`
- `app/(marketing)/faq/page.tsx`
- `tests/marketing-claims-contract.test.ts`

**Tests to add**: `tests/marketing-trust-ledger.test.ts`, `tests/marketing-claims-contract.test.ts`, `tests/marketing-static-aeo-coverage.test.ts`, `tests/marketing-public-route-contract.test.ts`, `tests/marketing-faq-nav-and-tabs.test.ts`

**Done when**: The /security page contains id="ai-trust" and <TrustLedger and none of the forbidden phrases, in the source AND in the resolved en-US values of every security.* key it renders; every 'verified' ledger row cites a test file that exists; the always-asks list is rendered from HIGH_STAKES_AI_DOMAINS so the page cannot drift from lib/trust/engine.ts; /ai carries the sample badge, no 'Model-agnostic' chip and a link to /security#ai-trust; /features#kitchen-mode and /features#switching are valid anchors; AEO coverage, route-contract, sitemap and FAQ tests stay green; no new public route.

### S-20 · Public site: what the price buys, in numbers the app can produce

> Public site stage 3 — pricing value block, per-day framing, outcome-first tier copy, case-study cards, demo seed of completed runs

Build these parts of the site spec:

PRICING
Skeleton kept: hero + Monthly/Yearly toggle (coarse:min-h-11 beside setPeriod — tests/mobile-pricing-toggle-touch-target.test.ts; /^monthly$/ /^yearly$/ buttons — tests/e2e/public.spec.ts), three PlanCards, HowTrialWorks, admin feature matrix, TestAccountCard (id="demo" anchor added to its wrapper), TrustStrip with familiesNote.

1. NEW components/marketing/pricing-value-block.tsx (client-safe: useTranslations from components/i18n/locale-provider, imports only components/marketing/primitives and lib/marketing/value.ts; receives handled stats and sample numbers as props from the server page). Mounted directly above the plan cards. Part A 'Work that stops landing on you': eyebrow pricingValue.eyebrow, title pricingValue.title, body, then a tier × row matrix with rows pricingValue.colYouDecide / colPrepares / colHandles and cells pricingValue.trial* / basic* / plus* (Family+ 'handles' names the routines a family approves once — meals→list every Sunday, forms→calendar, bill and renewal sweeps). On phones (<md) the matrix renders as three stacked tier cards each containing the three rows — no horizontal table (tests/e2e/overflow.spec.ts, mobile.spec.ts).

2. Part B — three sources, three cards, NEVER mixed in one sentence or one number (lib/marketing/value.ts is the only place the rules live):
   REAL — pricingValue.realTitle 'Across Bubaly families so far' with handledNote(handledCompleted) and handledProof.aggregate30d; the card is omitted entirely unless shouldShowRealHandled(stats) (handledCompleted ≥ HANDLED_PUBLIC_MIN). No time-saved aggregate is published (task #41 defines the north-star metric first).
   ILLUSTRATIVE — pricingValue.sampleTitle 'A sample week, by the app's own math': the same sampleBriefNumbers() as the homepage; shows pricingValue.minutesHandedBack '{minutes} minutes handed back this week' from buildFirstBrief's timeSavedMinutes (weights are literally lib/onboarding/first-brief.ts: recurring×5, conflicts×15, week events×2, cap 40), badge handledProof.sampleBadge, note pricingValue.estimateNote 'Estimated. Bubaly counts recurring items it set up, clashes it caught and events it prepared; it is not a stopwatch.'
   YOURS — pricingValue.yourNumbersTitle 'Your own numbers, not ours' / yourNumbersBody (home_briefs.handled and time_saved_minutes exist per family — 0140/0258).

3. Per-day framing (from lib/marketing/value.ts): perDayCents(cents, period) = period === 'yearly' ? ceil(cents/365) : ceil(cents/30) → Basic 28¢ / Plus 69¢ on yearly, Basic 34¢ / Plus 84¢ on monthly (ceil never understates). Rendered as pricingValue.perDay '≈ {amount} a day' UNDER the existing monthly price in PlanCard, never instead of it, and only for paid tiers; the billed-annually priceSub stays. No nanny/assistant hourly comparisons, no competitor prices.

4. TIER_POSITIONING → catalogue keys (pricingValue.positioningTrial / positioningBasic / positioningPlus). Family+ line becomes 'Fewer decisions land on you: Bubaly prepares the week and runs the routines you approve.' Family Basic keeps the factual replacement line (Cozi Gold, FamilyWall Premium, OurHome, FamCal, Skylight). PlanCard `goal` lines → pricingValue.basicGoal / plusGoal. PLANS taglines in lib/constants/plans.ts stay (admin displays).

5. SWITCH_HIGHLIGHTS shrinks from 8 to the six hero outcomes (titles/descs from heroOutcomes.* keys, same HiTier badges; Kitchen Mode keeps a tile under 'home' or as the 7th — implementer's choice, but every string keyed). The 'Smart Imports callout' block is replaced by <SwitchingBand compact /> content passed as props (pricing-content.tsx is a client component; render the compact band in app/(marketing)/pricing/page.tsx (server) and pass it as a `switching` ReactNode prop, or lift the copy through useTranslations — do NOT import lib/i18n/server from the client file, tests/i18n-server-boundary.test.ts).

6. app/(marketing)/pricing/page.tsx (already force-dynamic) passes getPublicStats() handled fields and getPublishedCaseStudies() into PricingContent; case-study cards (max 2) render beside the value block with the same verified_at gate as the homepage.

7. Add pricingValue.cancelAnytime 'Cancel or downgrade anytime — your data stays.' under the Family+ price. Feature matrix and FREE/BASIC/PLUS_FEATURES arrays are out of scope except the strings that change (then lifted to keys).

SOCIAL PROOF
Only what the database can back, used exactly as stored:
1. Registered families: public_stats().families → familiesNote(n) (exact under 1k, rounded-down '+' above, 'Built for modern family life' at zero) — kept on pricing TrustStrip and added to homepage sections 2 and 8.
2. Handled work: public_handled_stats() (Tier 1) and public_stats().tasks_completed, both hidden below HANDLED_PUBLIC_MIN.
3. Testimonials: public.testimonials (0059: author_name, author_role, company, quote, rating, is_published, sort_order), curated in app/(app)/admin/marketing/reputation. New lib/marketing/reputation-server.ts ('server-only'; createServiceClient; `.eq('is_published', true).order('sort_order')`, then publishedOnly() and clampRating() from lib/marketing/reputation.ts; limit 6; unstable_cache 1h; [] on error). Rendered with socialProof.sharedWithPermission and stars only when rating is set.
4. Case studies: public.case_studies (title, slug, customer_name, summary, result_metric, is_published). Migration 0276 also runs `ALTER TABLE public.case_studies ADD COLUMN IF NOT EXISTS verified_at timestamptz;`; the admin reputation page gains a 'Verified outcome' checkbox (adminMarketingReputation.verifiedOutcome) whose action writes verified_at = now() or null, plus a help line (adminMarketingReputation.resultMetricHelp: 'Enter the family's own words; the Verified badge only appears after you tick Verified'). Public cards show result_metric under socialProof.customerWords; socialProof.verifiedBadge renders only when verified_at is set. No /stories route this pass (would need the marketing route SEO/AEO contract); cards are not links.
5. Referral loop: /referrals and lib/referrals exist in-app; the band ends with socialProof.referTitle/Body (no public code entry).
6. Time-saved: per-family only (home_briefs.time_saved_minutes, labelled estimate, in-app). A public 'household time-saved' number waits for task #41; publicly only the badged sample brief appears.

Guard: components/marketing/social-proof-band.tsx returns null when both arrays are empty (early `if (!testimonials.length && !caseStudies.length) return null`); tests/marketing-social-proof.test.ts asserts reputation-server.ts starts with 'server-only', filters on is_published and calls publishedOnly and clampRating; the band source contains that early return, guards the verified badge on `verified_at`, and contains no literal person names (Jessica M./David T./Amanda R. rule extended); the admin action writes verified_at.

SWITCHING (the /pricing half only)
Message: 'Bring your family's life with you — nothing needs retyping.' Everything named ships today:
1. One-file imports — lib/migrate/competitors.ts (Cozi, FamilyWall, Google Calendar, Apple Calendar, OurHome with per-app export steps and `transfers`), components/migrate/migrate-wizard.tsx (.ics/.csv parsed in the browser by lib/migrate/parse.ts, preview counts per target, commit via app/(app)/dashboard/migrate/actions.ts, recent imports from audit_logs). Privacy line straight from the migrate page: 'Files are parsed in your browser; only the results are saved to your family.'
2. Snap the paperwork — Smart Imports (app/api/ai/flyer, /dashboard/scan): flyer photo / PDF / screenshot → events, tasks, reminders; badged illustrative wherever an example is shown.
3. Keep your calendars — two-way sync adapters for Google, Apple and Microsoft (lib/sync/providers) so the rest of the family need not move on day one.
Plus the first-session wow: the onboarding 'value' step (lib/onboarding/flow.ts) accepts a pasted .ics or the sample week and shows the first brief (homepage section 4).

NOT claimed: 'zero setup' (setup is minutes), duplicate merging / 'AI entity resolution' (lib/migrate/parse.ts does not demonstrably merge), inbound email forwarding as a family-facing ingestion path (workSteps.addOrForward on /how-it-works must be verified against a real inbox flow before the switching band repeats it — the band omits it), importing photos, documents or chore history. Say 'your old app stays untouched' (imports are read-only on the source).

Where: homepage section 7 SwitchingBand (three columns + 3-step strip + privacy line, CTA switching.cta 'Start free, then switch' → /signup); /pricing replaces the 'Smart Imports callout' with the compact band (rendered server-side in pricing/page.tsx and passed as a prop); /features adds FeatureCard id="switching" (featureCards.switching / switchingBody) so /features#switching is a valid anchor; footer 'Get started' group gains 'Switch to Bubaly' → /dashboard/migrate. Per-competitor long-form lives in the admin-published /compare/[slug] and /alternatives/[slug] pages (lib/marketing/public-pages.tsx); the band links to them only when an admin has published the slug (not hardcoded).

**Files this section owns.** Anything outside this list is somebody else's; if you must touch it, keep the change to one additive line and say so in your PR.

- `lib/marketing/value.ts`
- `components/marketing/pricing-value-block.tsx`
- `app/(marketing)/pricing/pricing-content.tsx`
- `app/(marketing)/pricing/page.tsx`
- `lib/demo/seed.ts`
- `components/billing/upgrade-modal.tsx`

**Tests to add**: `tests/marketing-value.test.ts`, `tests/marketing-handled-honesty.test.ts`, `tests/mobile-pricing-toggle-touch-target.test.ts`, `tests/marketing-claims-contract.test.ts`

**Done when**: Per-day amounts are derived with ceil from lib/constants/plans.ts (28c/69c yearly, 34c/84c monthly) and appear UNDER the monthly price for paid tiers only; the REAL card is omitted below HANDLED_PUBLIC_MIN and never renders a 0; the ILLUSTRATIVE card carries the sample badge and the estimate note; the matrix stacks on phones with no horizontal scroll; the Monthly/Yearly toggle and its touch targets are byte-identical; the demo family gets persisted completed runs with step events; no competitor price anywhere.
