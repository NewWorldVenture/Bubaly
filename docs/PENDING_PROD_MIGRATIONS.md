# Production release status and historical feature inventory

> **Status correction, 2026-10-03** (blocked-rows eligibility review;
> evidence in `docs/final-audit/blocked-rows-eligibility-20261003.md`).
> The connectivity paragraph below is historical. The `Supabase production
> migrations` workflow links again: run 84 on main `d25e39ea` (2026-10-02
> 12:11 UTC) passed `supabase link`, `supabase migration list --linked` and
> `node scripts/audit-production-migration-state.mjs --enforce-history`,
> reading **192 ledger rows, `0001`–`0176`**, 444 public tables, 1,002
> policies, `requiresBaselineReview: false`, and every money table "closed by
> restrictive guard". So the ledger no longer records only `0001`–`0003`,
> `0004` is recorded, and the replay-from-`0004` procedure in LB-016 §4.3 no
> longer applies (DEPLOY-003 is moot on that point). The blocker is `0177`
> (PROD-DB-0177): before the 2026-09-27 dispatch-only gate a push to main ran
> the apply step itself, and every such run (64, `35465574540`, 2026-09-19,
> and the ledger's `533554be` / `7e54596d` / `671c5f6a`) was cancelled inside
> `0177`'s single `DO` block by the 120 s statement timeout (`SQLSTATE 57014`)
> after its `families(created_by)` cleanup was skipped on
> `family_model_dirty_family_id_fkey`, so nothing from `0177` on is applied.
> No `workflow_dispatch` with `apply=true` has been run.
> "Apply ordered migrations" runs only on `workflow_dispatch` with
> `apply=true`; a push to main verifies and never applies. Run 84's own
> failure is the later schema-verification step, HTTP 401 from PostgREST on
> all 52 checks: PostgREST rejects the `SUPABASE_SERVICE_ROLE_KEY` the workflow
> holds, so that repository secret needs replacing; the owner's action.

**Current status (2026-09-05; main `01881fb279589d7a90acb8302817bb385fbe036d`).**
**This baseline is stale — see "Migrations added since this document's stated
baseline" at the end for the thirty-one migrations (`0255`-`0285`) that landed after
it, three of which gate features already deployed in the app.**
**Connectivity NO LONGER works, as of 2026-09-13.** The `Supabase production
migrations` workflow fails before it reads anything, at `supabase link`:

```
Authorization failed for the access token and project ref pair:
"Your account does not have the necessary privileges to access this endpoint."
```

Every apply and verify step after it is **skipped**, so no migration reaches
production and the audit below cannot refresh itself. This is a regression, not
the long-standing ledger gate: the 2026-09-07 run got *past* `link` and read the
real catalogue (441 tables, 978 policies). Something changed for
`SUPABASE_ACCESS_TOKEN` or `SUPABASE_PROJECT_REF` between those dates — the
token was rotated or revoked, or its account lost access to the project.

Fixing that alone is **not sufficient**: the baseline gate below still throws by
design until `0004` is recorded, and repairing the ledger is a credentialed
operator action (§4). Expect two steps, in that order.

The secret names are `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`,
`SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY`; never include their values
in this document, logs, or reports. Production's migration ledger records only
`0001-0003` despite existing schema. A missing ledger entry does **not** establish
that the corresponding schema or feature is absent.

## Wallet mint boundary — the finding, and what closes it

A production metadata audit reported that `public.wallet_transactions` still
carries a **permissive INSERT policy** alongside the intended manager-only one:
the shape that lets any family member — a child account included — submit a
`completed` `credit` and create spendable wallet funds. The audit returned
policy hashes rather than expressions, so the exact live condition is still
unverified, and nothing in it showed exploitation or money movement.

**The fix already exists in this repository: `0254_wallet_write_policy_drift.sql`.
It is unapplied, and applying it is the whole of the remedy.** Nothing new needs
writing.

Why 0254 is sufficient even though its `drop policy` list is a list of *known
names* — a stray policy under some other name would survive those drops:
permissive policies OR together, but 0254 also creates **restrictive** guards
(`wallet_transactions_manager_insert_guard` and siblings), and a restrictive
policy ANDs with the union of the permissive ones. No permissive policy can
grant past it, whatever it is called or whoever it is granted to.

That is a claim about Postgres semantics on a money path, so it is now tested
rather than reasoned about. `docs/audit/wallet-write-rls-check.sql` injects the
drift against the replayed schema and asserts a child still cannot mint, in two
shapes:

| Injected permissive INSERT policy | Result |
|---|---|
| `to authenticated with check (is_family_member(family_id))` — the audited shape | child mint **rejected**, 42501, 0 rows |
| `to public with check (true)` — no role limit, no condition | child mint **rejected**, 42501, 0 rows |

The guards are `to authenticated`, which would not AND with a `to public` policy
for an *anonymous* request — so the probe also asserts the grant layer closes
that path: `anon` holds no INSERT privilege on `wallet_transactions`, so the
question never reaches RLS.

Verified not to be vacuous: dropping `wallet_transactions_manager_insert_guard`
and re-running makes the probe fail with a child having **minted** the row
(`blocked=f, rows=1`). The probe runs in CI's Database job, which globs
`docs/audit/*-check.sql`.

**Still human-owned, and deliberately not done here:** applying 0254 to
production. Agents must not apply migrations to prod. Two things also remain
unverified from here — the exact live policy expression (the audit gave hashes),
and whether card issuing is reachable. Both need someone with production access.

The one-time, hash-pinned `0240-0254` atomic release is defined in
[PRODUCTION_FORWARD_RELEASE.md](PRODUCTION_FORWARD_RELEASE.md) and
[supabase-forward-release.yml](../.github/workflows/supabase-forward-release.yml).
**Preview run `33987762363` passed for `0240-0254`, but that release is HELD.**
Do not apply the previewed bundle: requester-privacy and core-execution findings
and the required traceability/review evidence remain unresolved. `0255`
(`0255_ai_runtime_lockdown.sql`) implements runtime INSERT lockdown,
conversation/message ownership and client-request deduplication. It is not the
broader raw request/context/plan/run/tool/event privacy closure; that gap requires
a separate reviewed follow-up and is not implemented by this migration.
`0256` (`0256_idempotency_keys.sql`) adds `idempotency_key` plus family-scoped
partial unique indexes to the six tables Bubaly writes, and `fingerprint` /
`source` / `receipt_document_id` to `transactions`; `0257`
(`0257_family_ai_settings.sql`) adds the per-family AI settings row, seeds it
from `handle_new_family()` and backfills existing families. Both are additive
and both default to today's behaviour — `0257`'s `behavior` default is
`execute` precisely so applying it changes no household's experience.

**⚠️ `0256` is now coupled to app code on a path every family uses.** It always
was on the assistant's side: `lib/services/calendar`, `.../reminders` and
`.../tasks` name `idempotency_key` in their inserts, so on unmigrated schema
PostgREST rejects the payload on the column name and Bubaly cannot add an event,
a reminder or a to-do. §7's calendar tranche routes the **module's own** Add
Event, Find a time and Edit through that same service
(`app/(app)/dashboard/calendar/actions.ts`), which is the point — one write path,
one duplicate guard — but it also means the blast radius of not applying `0256`
grows from "the AI's calendar tool" to "the family's Save button". Apply `0256`
before the deploy that ships that tranche. As with `0265` and `0268`, the column
is written unconditionally and deliberately so: a one-off tolerance for it would
be a code path that is dead the moment the migration lands.

The same now applies to the **chores board's Add**. `createChore` keys the chore
and its assignment as one unit, so a create carrying a submission id names
`idempotency_key` on the assignment insert. `assignChore` writes the column only
when a key was actually supplied — which is not a schema tolerance but the
difference between "no key" and "a null key": the assistant's standalone assign
tool passes none and stays unaffected. Note what `0256` buys on this path
specifically: the PROBE half (a retried Add finds the first assignment) works on
either schema, but the RACE half — two simultaneous taps, where the partial
unique index is what refuses the second assignment and triggers the rollback that
prevents an orphan chore — needs the index. Until `0256` is applied, two truly
simultaneous Adds can still leave a chore nobody is assigned to.

`0255` through `0268` are all outside the unchanged pinned bundle. Code
presence and prior test reports do not establish completed review or production
application.

The ten that landed after `0259`, for the record and in the order they must be
applied. **Read the deploy-coupling column before shipping code:** two of them add
columns the application writes unconditionally, so deploying that code first breaks
the feature until the migration lands.

| # | What it changes | Shape | Deploy coupling |
|---|---|---|---|
| `0260_trust_ledger_lockdown` | Drops the member INSERT policy on the trust audit ledger, narrows its read to `can_manage_family`, and gives `emergency_sessions` an `expires_at` (backfilled to `activated_at + 4h` for sessions still open) | Policies + one added column, both idempotent | Safe before apply — nothing writes the new column until it exists |
| `0261_home_briefs_kind_uniqueness` | Widens the saved-brief unique key to include `kind` | Index | Safe before apply |
| `0262_home_briefs_quarantine` | RESTRICTIVE deny-all on `home_briefs`: a saved snapshot mixes sources whose access cannot be revalidated when it is read back later. The store helpers refuse to save, load or claim, so no code path depends on it | One policy | Safe before apply — the store helpers already refuse |
| `0263_dead_letter_reconcile` | `create or replace` on `claim_ai_runs` so a dead-lettered run also settles its steps, its legacy status column and its request ledger. Every write bounded to rows the same statement just dead-lettered | One function | Safe before apply |
| `0264_ai_surface_role_privacy` | The role boundary the AI layer already enforced, in the database: `ai_plans`, `ai_plan_steps`, `ai_run_events` to the requester or a manager; `family_automation_rules` writes to managers; `family_facts` per role; `home_briefs` writes to the service role. Deliberately does NOT narrow the finance and document tables — named in its own header | Policies dropped and recreated by name | Safe before apply — the app layer is already stricter |
| `0265_family_facts_provenance` | `source`, `confidence` and `expires_at` on `family_facts`, with a backfill classifying existing rows by the `Learned by Bubaly` note prefix they carry today. Additive; changes no existing row's meaning | Three added columns, two check constraints, two indexes | **⚠️ Coupled with app code.** `rememberConfirmed` writes `source`, `confidence` and `expires_at` on `family_facts` unconditionally (`lib/services/memory/index.ts`), so on unmigrated schema PostgREST rejects the payload on the column name and **every memory write fails** — a person's own "remember that…" included. Apply before the deploy that ships it |
| `0266_document_vault_boundary` | Makes the Secure Vault real. `documents` SELECT/INSERT/UPDATE/DELETE and the three `documents` storage-bucket policies now consult `is_sensitive_document(is_secure, category)` and `can_manage_family`. **Closes a live leak**: before this, any member — including a child with a PIN login — could read every vault row (with its `storage_path`), fetch the bytes, move a file out of the vault, or delete it | Four table policies + three storage policies recreated, one new function, one index | Safe before apply, but the leak stays open until it lands. The client refuses the writes it can see; the database does not |
| `0267_money_write_boundary` | `financial_accounts`, `transactions`, `budgets`, `bills`, `savings_goals`: INSERT/UPDATE/DELETE move to `can_manage_family`; SELECT deliberately unchanged. **Also drops 0006's `"Members can manage <table>"` `FOR ALL` policy**, which 0109 left in place beside the four named ones — permissive policies are OR'd, so that one had been the effective rule all along and 0109's "repair" was decoration | Five policies dropped, twenty recreated, per table via the 0109 loop shape | Safe before apply, same caveat — a teen can still delete the household bank account until it lands |
| `0268_suggestion_expiry` | `expires_at` on `family_playbook_suggestions`, so a suggestion offered with a deadline keeps it through acceptance instead of becoming a permanent fact. Additive and nullable | One added column | **⚠️ Coupled with app code.** `rememberUnconfirmed` writes `expires_at` on `family_playbook_suggestions` unconditionally and `confirmFact` reads it back, so on unmigrated schema **every AI-sourced memory write fails** and nothing reaches the review inbox. Apply before the deploy that ships it |
| `0269_realtime_liveness_tranche` | Adds ten tables to `supabase_realtime` — `calendar_events`, `chore_assignments`, `family_conversations`, `family_messages`, `grocery_items`, `grocery_lists`, `marketplace_bids`, `notifications`, `todo_items`, `todo_lists` — and sets `replica identity full` on the five of them the client hard-deletes from (`calendar_events`, `chore_assignments`, `grocery_items`, `notifications`, `todo_items`). Without FULL, a DELETE's old tuple carries only the primary key, so the `family_id=eq.` filter every subscription uses can never match and deletes are dropped server-side — live INSERT/UPDATE and a silently stale list. **Grants no new read access**: the filter predicate is the SELECT policy predicate for nine of the ten, and for `notifications` the policy is *narrower* than the filter, which Realtime's per-subscriber RLS check enforces | Guarded `ALTER PUBLICATION ADD TABLE` (0250's array shape) + five `replica identity full`, both idempotent; nothing dropped | Safe in **either** order — the two halves are independently inert. `lib/realtime/published-tables.ts` gates the client, so shipping the code first just leaves today's behaviour (no channel opened) until the migration lands; applying the migration first publishes tables the old client already subscribed to. Neither half breaks the other |

`0265` and `0268` are the two that must land BEFORE their code. Both add a column the
memory service names in an insert payload, and PostgREST rejects an insert naming a
column the schema cache does not have — the value being null does not help, because it
is the name that fails. The failure is loud rather than silent (the write errors, it
does not quietly drop the field), which is the right direction, but it means the memory
feature is down for the window between deploy and apply. Neither is written
conditionally, and deliberately so: the same is already true of every other coupled
migration in this document, and a one-off tolerance for one column would be a code path
that is dead the moment the migration lands.

`0266` and `0267` are the first two migrations in this range that **take capability away from a role**. Both are proved behaviourally against a real Postgres as an `authenticated` session — `docs/audit/document-vault-boundary-check.sql` and `docs/audit/money-write-boundary-check.sql` — and both proofs fail without their migration. The money proof also asserts the *whole* policy set rather than only the policies it wrote, which is the check that caught the `FOR ALL` survivor; without it `0267` would have applied cleanly and changed nothing.

Each applies clean through the full local replay. `0262`, `0266` and `0267` are
the ones that take something away: saved-brief reads, the children's access to
sensitive documents, and the children's ability to write household money. All
three are deliberate, and the last two close gaps a family would not have
expected to exist. The rest are additive or tighten a policy that was wider
than the application layer already assumed. A separately
reviewed hash-pinned release, a new successful preview, the required matrix and
review evidence, and explicit parent authorization are required before any
production apply. No future release range is authorized by this inventory.

`0253` closes AI worker grant drift and `0254` closes wallet RLS drift in the
reviewed code. Their presence on main and passing code/CI checks do not establish
that those production controls have been applied or resolve the new findings.

Parent owns commits, pushes, production deployments, credentials, and goal
controls. Credential availability is a capability fact, not authorization for
an agent to change production. This document records status and dependencies;
the linked forward release runbook and workflow define the release procedure.

**Blueprint scope:** the current goal is the full 113-section `goal-objective.md`
(handoff SHA-256 `9d279dd1d614ffd6376492b6f8d3b3d44fa4e5dfe6516ea51e2100c91e2441c3`).
The full requirement-to-code/test traceability matrix required by sections 19,
30, and 113 was not completed. Matrix generation did not complete; the gate
before further feature implementation remains unresolved.
This file is a bounded release-status correction and historical feature
inventory, not that matrix or a claim that the expanded blueprint is complete.
Under sections 9, 96, 111, and 113, requirement PASS claims need the applicable
implementation, migration/RLS, automated-test, and executed staging/customer
journey evidence. This documentation change and the passed release preview do
not establish those results or production application.

## Production procedure and evidence

- **Release held:** do not apply the previewed `0240-0254` bundle. Before any
  apply, parent must have a corrected hash-pinned release reflected in the
  runbook and workflow, a new successful preview, review evidence addressing
  requester privacy and core execution, and the completed traceability matrix.
  Explicit parent authorization is still required. `0255` and its combined
  regression guards are code under PR reconciliation, not evidence of complete
  requester privacy or production application. Parent owns validation of the
  reconciled changes; the pinned bundle does not include `0255`. Preserve the
  corrected release's atomicity; this inventory is not an execution sequence.
- The original `supabase-production-migrations.yml` workflow deliberately
  blocks historical replay against the incomplete ledger. Its block must not
  be bypassed or treated as a missing-credentials failure.
- **Re-pinning the forward release is now a manifest change, not a code
  change.** `scripts/apply-production-forward-release.mjs` used to state the
  pinned range in three hardcoded literals as well as in
  `supabase/production-forward-release.json`; the manifest is now the only
  statement of it. Checksum verification, the project-ref check and the
  filename constraint are unchanged, and the range must additionally be
  contiguous and duplicate-free.
  This removes the code edit from a re-pin. It does **not** remove anything
  else the corrected release needs: `boundary` is a snapshot of production's
  live catalogue and `newTables` must be verified absent from production, so a
  corrected manifest still requires a credentialed read, a new successful
  preview, and the explicit parent authorization required above. An agent
  cannot produce or approve one.
- Do not use a blind `supabase db push`, `--include-all`, production resets,
  blanket migration repair/stamping, historical SQL bundle pastes, or replay
  of historic migrations or seeds to reconcile the ledger. Guards such as
  `IF NOT EXISTS` and local idempotency tests do not make replay safe against
  existing production schema, policies, or data.
- Code review, tests, PG16 harness results, and the successful preview are
  code/CI evidence. Production application requires a successful authorized
  apply run and the production verification evidence required by the runbook.
  Record the applied revision/hashes and run evidence before changing the
  status above; do not infer application from a merge, preview, or page refresh.
- Runtime dependencies such as `CRON_SECRET` still matter, but their names in
  this inventory do not establish that they are currently missing. Parent
  owns credential configuration; checks and reports must not expose values.

## Security controls requiring production evidence

Historical identifiers below explain the risks and their original fixes. They
are not instructions to replay those files or proof of current production
exposure. Consult the linked PLA/LB entries in `docs/PRODUCT_LAUNCH_AUDIT.md` for
recorded behavioral evidence, keeping its environment distinct from production.
Write/delete regression scenarios belong in isolated tests; production checks
must follow the approved forward release procedure.

| Reference | Risk addressed | Required control / useful security note |
|-----------|----------------|-----------------------------------------|
| `0217`, forward `0254` | **Wallet money-minting** (LB-010/PLA-0580): child/member writes could mint completed credits. | Manager-gated ledger writes; `0254` closes wallet RLS drift. Confirm production policies through the forward release verification. |
| `0224` | **Wallet audit trail tampering** (PLA-0622). | Members may SELECT/INSERT audit entries; client UPDATE/DELETE is denied. Service-role retention remains available. |
| `0219` | **Cross-tenant PII exposure** on `support_tickets` and `admin_users` (LB-011/PLA-0600). | Client roles default-deny; service-role access stays behind the super-admin application gate. |
| `0221` | **Marketplace bid-as-any-family IDOR** (LB-012/PLA-0610). | `authenticated` cannot execute `marketplace_place_bid_unchecked`; the checked wrapper remains the client entry point. Coupled marketplace authorization code is required. |
| `0222`, `0223` | **Forged chore decisions** (PLA-0612/0613). | Decision guards restrict approval/rejection to managers or trusted service paths; `submitProofAction` service-role routing is coupled code. |
| `0216` | **Family-media write isolation** (LB-009). | Family-folder write RLS is required. Reads remain public pending the signed-URL decision and stored-URL migration. |
| `0249` | **Family deletion failure** caused by `family_model_dirty_family_id_fkey`. | `mark_model_dirty()` skips vanished families during cascades. Confirm function state through approved verification; do not delete production families as a smoke test. |
| `0218`, `0220` | **Economy token / investing ledger minting** (PLA-0590/0600). | Manager-only ledger writes; member requests remain distinct from manager approval. |
| Forward `0253` | **AI worker grant drift**. | Include the grant closure and its verification in the atomic release. Preview success alone does not establish production protection. |

## Historical feature inventory (reference only)

Preserved entries describe feature dependencies and recorded development/test
results, not a reliable production pending-migration ledger. Throughout this
inventory, "PG16-verified", "idempotent", seed counts, and test counts refer to
the recorded test context unless separate production apply evidence is cited.
"Safe before apply" describes an application's fallback, not a security
clearance. Historical apply, seed, backfill, and environment notes are not
current production instructions; the procedure and pending status above govern.
Do not replay referenced seeds or infer empty production tables from this list.

| # | File | Adds | Feature it unblocks |
|---|------|------|---------------------|
| 0118 | `0118_rls_drift_repair.sql` | Historical RLS repair: re-enables RLS and restores family-scoped SELECT/INSERT/UPDATE/DELETE policies | Explains silently-empty pages caused by RLS drift. Do not replay this broad historical repair over existing production policies; use the approved forward release. |
| 0119 | `0119_family_credentials.sql` | `family_credentials` (Wi-Fi & passwords vault) | Family Vault `/dashboard/passwords` |
| 0120 | `0120_marketplace.sql` | `marketplace_listings`, `marketplace_offers` | Marketplace `/dashboard/marketplace` |
| 0121 | `0121_voice_commands.sql` | `voice_commands` history log | Voice Control `/dashboard/voice` recent-commands |
| 0122 | `0122_routine_templates.sql` | `routine_templates`, `routine_template_items` | Recurring-routine templates (calendar right rail) |
| 0123 | `0123_family_facts.sql` | `family_facts` durable-knowledge store | Family Knowledge Base `/dashboard/knowledge` (+ knowledge-graph fact nodes) |
| 0124 | `0124_journey_events.sql` | `journey_events` append-only telemetry | Experience Scorecard `/dashboard/journeys` |
| 0125 | `0125_family_operating_index.sql` | `family_operating_index` daily snapshots (composite + dimensions + suggestions) | Family Operating Index `/dashboard/family-operating-index` (the page renders live even before apply; the table only backs the day-over-day **trend**) |
| 0126 | `0126_family_playbook.sql` | `family_playbook_suggestions` | Family Playbook `/dashboard/playbook` |
| 0127 | `0127_agent_activity.sql` | `agent_activity` | Family Assistant / agents `/dashboard/agents` + Calm inbox |
| 0128 | `0128_family_connections.sql` | `family_connections` | Connections hub `/dashboard/connections` |
| 0129 | `0129_family_graph.sql` | `graph_entities`, `graph_edges` | Knowledge/Reasoning Graph `/dashboard/graph` + twin projector + graph-aware Chief of Staff |
| 0130 | `0130_family_decisions.sql` | `family_decisions`, `decision_options` | Decision Engine `/dashboard/decisions` |
| 0131 | `0131_prep_plans.sql` | `prep_plans`, `prep_plan_steps` | Prep Plans `/dashboard/prep-plans` + Life Readiness horizon rollup |
| 0132 | `0132_network_consent.sql` | `network_consent` | Intelligence Network consent `/dashboard/intelligence` |
| 0133 | `0133_onboarding_events.sql` | `onboarding_events` | Onboarding funnel `/dashboard/onboarding-funnel` (super-admin) |
| 0134 | `0134_model_dirty.sql` | `family_model_dirty` + `mark_model_dirty()` triggers | Event-driven twin/prep refresh (the `model-refresh` cron; also needs `CRON_SECRET`) |
| 0135 | `0135_network_aggregates.sql` | `network_contributions`, `network_aggregates` | Intelligence Network insights `/dashboard/intelligence` (the `network-aggregate` cron; also needs `CRON_SECRET`) |
| 01371 | `01371_child_login_throttle.sql` | `child_login_throttle` (per-username brute-force lockout) | Hardens **Kid Logins** (`/kid-login`) — child PIN sign-in is rate-limited/locked after repeated failures. If the table is absent, sign-in still works without this durable throttle; that fallback is not a security clearance. Production control status requires production evidence. |
| 01381 | `01381_onboarding_imports.sql` | `onboarding_imports` | Records the **value-first onboarding** first-brief moment (T1): the imported calendar's event/conflict/action/time-saved counts + brief summary. Seeds the TTFV metric (T10). Safe before apply: onboarding still works and imported events still land in `calendar_events`; only the durable import record is skipped (best-effort insert) until the table exists. |
| 01380 | `01380_demo_sessions.sql` | `demo_sessions` (shared "Bubaly Demo" account session + 5-min clock) | Powers the **one-click live demo** (pricing → "Demo Account"): tracks each running demo + its `expires_at` so the top-left countdown and auto-reset work. Self-scoped RLS (a visitor reads only their own session row; all writes go through the service role). **Historical numbering conflict:** this inventory lists `0138` for both demo sessions and onboarding imports; it is not a production execution ledger. Do not work around ledger discrepancies with manual historical SQL, renumbering, or stamping. Related feature dependency: `0161`. If the table is missing, `app-frame` treats the session as "not a demo". Recorded PG16 evidence: idempotent ×2; not production apply evidence. |
| 0139 | `0139_meal_ideas.sql` | `meal_ideas` (curated dinner catalog, reference data) | Powers the **3 dinner ideas** in the first-run briefing (T2). Reference data, readable by any signed-in user; populated by `seed_meal_ideas.sql` (500 rows). Safe before apply: the briefing simply shows no dinner ideas until the table exists + is seeded (best-effort read). |
| 0140 | `0140_home_briefs.sql` | `home_briefs` (daily home outcome snapshot) | Powers the **outcome-first home** (T3): when the home would otherwise be empty, it shows readiness + next-best steps + dinner ideas, and persists a daily snapshot (home-side TTFV signal). Family-scoped; seeded by `seed_home_briefs.sql` (500 days). Safe before apply: the outcome still renders live; only the durable snapshot upsert is skipped (best-effort) until the table exists. |
| 0141 | `0141_daily_insights.sql` | `daily_insights` (the one insight of the day) | Powers the **insight of the day** (T4): the home surfaces one ranked proactive insight above the fold; dismissing sticks and the next-best surfaces. Family-scoped; seeded by `seed_daily_insights.sql` (500 rows). Safe before apply: the home simply shows no insight hero (wrapped in try/catch) until the table exists. |
| 01420 | `01420_family_signals.sql` | `family_signals` (hard-signal family intelligence) | Powers **Family Intelligence / R10** (`/dashboard/family-signals`): the harder-to-copy behavioral signals (ignored reminders, stress windows, chore friction, routines that don't stick), transparent + editable (acknowledge/dismiss). Recomputed on demand + by the `model-refresh` cron. Family-scoped; seeded by `seed_family_signals.sql` (500 rows). Safe before apply: detection no-ops until the table exists (Refresh returns an error only inside the page). |
**Why four of the versions above have five digits.** `01371`, `01380`, `01381` and `01420` are not typos. Four migrations shared a version prefix with an earlier file, and `supabase db push` treats one version as one migration and applies it once — so a trailing digit was appended to make each unique. This table went on naming the ORIGINAL four-digit filenames long after that rename, so all four pointed at files that do not exist. Applying the directory would have worked and hidden it; applying by the filename this table gave you would have failed on every one. `tests/a-document-does-not-name-a-migration-that-is-not-there.test.ts` is the guard that keeps this table and `finalaudit.md` honest about it.

| 0147 | `0147_twin_simulations.sql` | `twin_simulations` (saved Digital Twin projections) | Powers **R8** — the full activity projection on `/dashboard/family-digital-twin` ("if Emma joins travel soccer…" across schedule/travel/cost/family-time/homework/meals/vacation). Projection is a pure no-write what-if; this stores SAVED scenarios. Family-scoped; seeded by `seed_twin_simulations.sql` (500 rows). Safe before apply: projecting still works; only Save/list is disabled until the table exists. |
| 0148 | `0148_moment_activations.sql` | `moment_activations` (Moments organizing-layer log) | Powers **R12** — the "Right now" life-moment band atop `/dashboard/moments` (Morning/School/Dinner/Weekend/Vacation/Birthday…), logging which moments surfaced + engage/dismiss. Family-scoped; seeded by `seed_moment_activations.sql` (500 rows). Safe before apply: the band is best-effort (wrapped in try/catch), so it just doesn't render until the table exists. |
| 0149 | `0149_reasoning_snapshots.sql` | `reasoning_snapshots` (unified Family Reasoning Engine log) | Powers **R7** — the one reasoning engine on `/dashboard/reasoning` (Family Reasoning) that answers the six questions every surface consumes (what matters most · forgotten · decide next · auto-complete · who needs help · what next) by composing the FOI orchestrator, graph insights (R2) and hard signals (R10). Stores one snapshot per day so the answers trend. Family-scoped; seeded by `seed_reasoning_snapshots.sql` (500 rows). Safe before apply: the page reasons live; only the daily snapshot upsert is skipped (best-effort try/catch) until the table exists. |
| 0150 | `0150_marketplace_matches.sql` | `marketplace_matches` (marketplace supply↔demand matches) | Powers the **Marketplace match intelligence** strip on `/dashboard/marketplace/browse`: connects open `wanted` requests to the supply already on the board (`sell`/`free`/`rent`/`borrow`), scored + reasoned, with Got-it / Dismiss (dismissals preserved). Family-scoped; seeded by `seed_marketplace_matches.sql` (500 rows, needs the marketplace itself seeded first). Safe before apply: the strip is best-effort (try/catch), so it just doesn't render until the table exists. |
| 0151 | `0151_marketplace_v2.sql` | `marketplace_stores`, `marketplace_follows`, `marketplace_saves`, `marketplace_collections`(+`_items`), `marketplace_orders`, `marketplace_reviews`; widens listing kinds with `swap`/`donate` | Powers **Marketplace V2** — the AI-first marketplace home at `/dashboard/marketplace` (hero, action grid, AI Picks, activity feed, Top Creators, Trust Score, Popular Collections, Safety) plus the Saved / Orders / Reviews / Collections / Creators / My Store pages. Family-scoped; seeded by `seed_marketplace_v2.sql` (~1,200 rows; needs `seed_marketplace.sql` first). Safe before apply: every V2 read is best-effort, so the home renders with empty rails and the module still works on the 0120 tables. |
| 0154 | `0154_marketplace_ownership.sql` | `marketplace_member_id()`; **per-member** RLS on listings/stores/saves/follows/offers/reviews/orders; `marketplace_accept_offer` / `marketplace_decline_offer` / `marketplace_set_listing_status` RPCs; offer→pending trigger; partial unique index `uq_marketplace_offers_open` | **Security hardening (audit SEC-1/SEC-2/REL-1/RACE-1).** Ties marketplace writes to the acting member (was family-scoped only), moves the offer hand-off + listing status changes into ownership-checked, atomic `SECURITY DEFINER` RPCs, and makes "I'm interested" idempotent. **⚠️ Coupled with app code** — the marketplace module now calls these RPCs and relies on the tightened policies; apply this together with the deploy that ships it, else owner accept/withdraw/complete will error. Idempotent; dedupes any pre-existing duplicate open offers before creating the unique index. PG16-verified: all 152 migrations apply, RLS/RPC/trigger/index behaviors confirmed, `seed_marketplace.sql` still seeds 500 with no dup open offers. |
| 0155 | `0155_wallet_auth_holds.sql` | `wallet_reserve_card_auth()` — atomic per-child sufficient-funds check + `processing` hold keyed by the Stripe authorization id | **Security (audit PAY-1).** Stops concurrent card authorizations from each approving against the same SPEND balance (overspend). **⚠️ Coupled with app code** — `lib/stripe/webhook.ts` calls this RPC on `issuing_authorization.request` and releases the hold on capture/reversal; apply with the deploy that ships it, else authorizations won't reserve. Idempotent; service-role only. PG16-verified: all 172 migrations apply, 2nd concurrent auth declined, capture reconciles the hold with no double-count. |

| 0156 | `0156_rate_limits.sql` | `rate_limits` table + `rate_limit_hit()` / `rate_limit_prune()` RPCs | **Security (audit AI-2).** Durable, cross-instance fixed-window rate limiting for public model-backed endpoints (`/api/ai/gift`), replacing the per-instance in-memory limiter that a serverless fleet could multiply. Safe before apply: `rateLimitDb` **fails open** (allows) until the RPC exists, and the in-memory limiter still caps each instance. Service-role only; idempotent. PG16-verified (4th hit in a 3/window bucket declined with retry_after). |
| 0157 | `0157_family_signals_budget_drift.sql` | Widens `family_signals.kind` CHECK with `budget_drift` | Adds the 5th **hard signal** (R10): a budget category over its cap this period (stronger when the prior period was over too), surfaced on `/dashboard/family-signals`. Additive/idempotent — just re-creates the CHECK. Safe before apply: detection skips writing `budget_drift` rows until the constraint allows the value (the other four kinds are unaffected). PG16-verified. |
| 0158 | `0158_concierge_plan_actions.sql` | `concierge_plan_actions` (concierge deeper write-back audit) | Powers the **AI Concierge deeper write-back**: an accepted plan materializes into real records across surfaces (calendar event · reminder · prep task) via `/dashboard/concierge`, each logged here so the flow is idempotent (never double-applies) + auditable. Family-scoped; seeded by `seed_concierge_plan_actions.sql` (500 rows). Safe before apply: the write-back buttons no-op the audit until the table exists (the underlying calendar/reminder writes still work). |
| 0159 | `0159_onboarding_progress.sql` | `onboarding_progress` (one durable row per account: onboarding lifecycle + marketing signal) | Powers the **onboarding lifecycle + marketing layer**: makes the previously-invisible "needs setup" cohort (accounts auto-provisioned by `ensureActiveFamily` that skipped the wizard) queryable, drives the `/dashboard/setup` re-onboarding surface + reset flow, and feeds marketing segments first-class columns (value_engaged / source / status / goals / completeness) instead of a JSON blob in `crm_contacts.notes`. Self-scoped RLS (a user reads/writes only their own row; cross-account aggregation is service-role). Lifecycle rows are generated only by real Auth activity; the former synthetic Auth seed is retired. Safe before apply: every write is best-effort and degrades silently (`recordOnboardingProgress` swallows a missing table), so onboarding + the setup page still work — the marketing signal just isn't persisted until applied. PG16-verified (idempotent ×2; cascade, CHECK, unique, trigger, RLS all confirmed). |
| 0160 | `0160_visitor_consent.sql` | `mkt_consent_events` (append-only, versioned, revocable visitor consent ledger) | **Privacy — visitor intelligence.** Adds the consent layer the tracker lacked: `/api/mkt/track` now records first-party analytics **only with consent** (denied/GPC visitors acknowledged but not profiled), and `/api/mkt/consent` writes granular decisions (necessary/analytics/personalization/marketing_email/marketing_sms). Latest decision per category wins; GPC honored; `necessary` always on. Service-role only (RLS enabled, no policies), keyed by `anonymous_id` + optional `crm_contacts` link. **⚠️ Coupled with app code** — apply with the deploy, else `/api/mkt/track` and `/api/mkt/consent` error on the missing table. Idempotent. PG16-verified: all 177 migrations apply, latest-per-category resolves, bad categories rejected by CHECK. |
| 0161 | `0161_demo_session_email_gate.sql` | Makes `demo_sessions.expires_at` nullable + adds `email` | Completes the **email-gated live demo**: the app opens behind a blurred email-capture pop-up and the 5-minute countdown doesn't start until the visitor submits it (`expires_at = null` means "provisioned, clock not started"), capturing the address in `email`. **Requires `01380_demo_sessions.sql` first** (it alters that table). Additive/idempotent (`drop not null` is a no-op when already nullable; `add column if not exists`). Safe before apply: without it the email gate can't defer the clock, but the demo account itself still exists. PG16-verified (idempotent ×2, applied on top of 0138). |
| 0162 | `0162_demo_email_uses.sql` | `demo_email_uses` (one durable row per email that has used a demo) | Enforces **one 5-minute demo per email**: when an email starts a demo it's stamped here with that demo's expiry; once expired, re-entering the same email routes to the `/demo/upgrade` plan-choice page instead of starting a new clock (paid plan → signup → billing). Service-role only (RLS enabled, no policies). Additive/idempotent. Safe before apply: the gate check is wrapped so a missing table simply doesn't gate (every email can still demo) until applied. PG16-verified (idempotent ×2; RLS on, expiry check confirmed). |
| 0163 | `0163_messages_audio_read_fix.sql` | Widens `family_messages.kind` CHECK (+`'audio'`) + `mark_conversation_read(uuid)` RPC | **Fixes two live Messages bugs.** (1) Voice notes NEVER saved: the recorder inserts `kind='audio'` but the 0014 CHECK didn't allow it — every voice message failed. (2) Read receipts wiped each other: mark-as-read *replaced* `read_by` with just the reader; the RPC appends instead (SECURITY INVOKER — family RLS still governs). Safe before apply: the client falls back to a correct per-row merge for receipts, but **voice notes stay broken until applied**. Additive/idempotent. PG16-verified (idempotent ×2; audio accepted, bogus kind rejected, RPC appends without clobber and is idempotent). |

| 0184 | `0184_marketplace_auction_authorization.sql` | Authenticated bid identity checks, removal of direct bid inserts, and atomic `marketplace_buy_now()` RPC | **Security and consistency repair for 0183.** Requires the bid member to belong to the authenticated family, keeps bid writes on the guarded RPC, and performs the Buy-It-Now listing claim plus order creation in one locked transaction. Apply with `0183` and the auction code. Additive/idempotent. |
| 0185 | `0185_marketplace_auction_close_transaction.sql` | Service-role-only `marketplace_close_auction()` RPC | **Consistency repair for expired auctions.** Locks and settles the listing, winner order, and bid statuses in one transaction so an order failure rolls the settlement back for retry. Apply with `0183`, `0184`, and the auction cron. Additive/idempotent. |
| 0187 | `0187_harden_marketplace_negotiations.sql` | Negotiation family separation, amount/message bounds, and below-ask round trigger | **Security and integrity hardening for 0186.** Prevents same-family self-deals, keeps negotiation values within a bounded range, rejects oversized notes, and ensures offer/counter/accept rounds stay below the listing ask. Apply after `0186` and the negotiation deploy. Additive/idempotent. |
| 0190 | `0190_marketplace_handoffs.sql` | `marketplace_handoffs` (pickup coordination, one per order) + family-scoped RLS + `updated_at` trigger | **New feature — closes the transaction loop with a Pickup & Hand-off Coordinator.** After a deal is struck (accepted offer / won auction / claimed listing → `marketplace_orders`), nothing coordinated the actual exchange — eBay leans on shipping labels, Craigslist on "text me". This adds it on **`/marketplace/orders`**: one side proposes a time + a **SAFE public meetup spot** (police safe-exchange zone, grocery entrance, library…), the other **confirms** (which drops it on the **family calendar** and mints a short **hand-off code**), and the exchange is **completed in person by entering the code** — so "completed" means the item actually changed hands, and the order advances to completed atomically with it. Pure engine `lib/marketplace/handoff.ts` (safe spots · meet-time slots · code gen/normalize/match · turn gating, **11 tests**). Family-scoped RLS via `is_family_member`; both buyer and seller members drive it from their side. Seeded by `seed_marketplace_handoffs.sql` (160 orders + 160 hand-offs across all four statuses + 40 backing calendar events ≈ 520 rows, in `SEED_ALL.sql`). Safe before apply: the Orders page reads best-effort and simply shows no pickup panel until the table exists. Additive/idempotent. Requires 0151. **PG16-verified** (idempotent ×2; 4 RLS policies + trigger; seed idempotent ×2 = 160/160/160/40 with 40 per status). |
| 0191 | `0191_marketplace_price_history.sql` | `marketplace_price_history` + an `AFTER UPDATE OF price_cents` trigger that logs the change and notifies watchers on a drop | **New feature — price-drop watch (eBay's "price reduced on an item you're watching").** Today the Saved (♥) heart is static: a buyer who hearts an item never hears when the seller cuts the price; Craigslist has nothing. This adds an append-only price-change log and a trigger that fires on **any** path that edits a listing's price (quick-post, module edit, seed, admin) — writing the history row and, when the price **drops** on a still-available listing, inserting a notification for **every family watching it** (♥). The item page shows a **"Price dropped X%"** badge, a **"Lowest ever"** flag, and an expandable **price history**. Pure engine `lib/marketplace/price-history.ts` (drop % · lowest-ever · recent-drop badge · history lines, **8 tests**). Family-scoped RLS via `is_family_member`; the trigger is `SECURITY DEFINER` so watcher notifications land regardless of who edits. Seeded by `seed_marketplace_price_history.sql` (130 listings + ~390 history rows + 65 watcher saves ≈ 585 rows, in `SEED_ALL.sql`). Safe before apply: the item page reads best-effort and shows no badge/history until the table exists. Additive/idempotent. Requires 0120 + 0151. **PG16-verified** (idempotent ×2; trigger logs every change + notifies exactly on drops [raise logged, not notified]; seed idempotent ×2 = 130/389/65, ladders end at current price, all latest changes are drops). |
| 0192 | `0192_marketplace_returns.sql` | Additive `marketplace_orders` columns (`due_reminder_sent_at`, `overdue_notified_at`, `returned_at`) + a partial due-date index | **New feature — rent/borrow returns + overdue tracking (a family lending library).** The marketplace already supports `rent`/`borrow` listings and orders carry `ends_on` (the return due date), but nothing closed that loop: no "due back Friday" nudge, no overdue flag when the ladder never comes home. This adds return-state intelligence: the Orders page shows a **due-soon / due-today / overdue / returned** badge per rent/borrow order, and the **`return-reminders` cron** (daily 08:00) sends each family one due-soon nudge and one overdue alert (deduped by the new stamps). Pure engine `lib/marketplace/returns.ts` (`returnStatus` · `daysUntilDue` · `returnLabel` · cron `needsDueReminder`/`needsOverdueAlert`, **8 tests**). Purely additive — no new table; existing return flow (the `returned` order status) is unchanged. Seeded by `seed_marketplace_returns.sql` (250 rent/borrow listings + 250 orders across all five return states, 50 each ≈ 500 rows, in `SEED_ALL.sql`). **Also needs `CRON_SECRET`** (return-reminders). Safe before apply: the badge/cron simply don't run until the columns exist (the Orders page still renders). Additive/idempotent. Requires 0151. **PG16-verified** (idempotent ×2; seed idempotent ×2 = 250/250 with an even 50-per-bucket spread). |
| 0193 | `0193_marketplace_reports.sql` | `marketplace_reports` (report a listing) + reporter-family-scoped RLS + anti-spam unique index | **New feature — Trust & Safety (report a listing).** Safety is exactly where Craigslist fails; paired with the safe-meetup hand-off (0190) this makes "safer than Craigslist" real. A member flags a listing (prohibited / scam / miscategorized / offensive / spam / duplicate / other) with optional details, routed to the **super-admin moderation queue at `/admin/marketplace/reports`** (open-first) where it's **actioned** (optionally withdrawing the listing) or **dismissed** with a note. Reporter-family reads/inserts via RLS; resolutions are written only by the super-admin via the service role (no public UPDATE policy). A partial unique index blocks a member from stacking open reports on one listing. Pure engine `lib/marketplace/reports.ts` (reason/status vocab · `canReport` · `summarizeReports`, **7 tests**); report dialog on the item page (non-owners); moderation controls (start-review / action+withdraw / dismiss). Seeded by `seed_marketplace_reports.sql` (500 reports across all 7 reasons × 4 statuses, one per listing, in `SEED_ALL.sql`). Safe before apply: the Report button/queue read best-effort and stay dormant until the table exists. Additive/idempotent. Requires 0120. **PG16-verified** (idempotent ×2; 2 RLS policies + trigger + anti-spam index; seed idempotent ×2 = 500 with even 125-per-status spread). |

| 0194 | 0194_marketplace_photos_bucket.sql | Public marketplace-photos Storage bucket with a 10 MB image allowlist and authenticated owner-scoped writes. Additive and idempotent; apply with the marketplace photo upload UI. |
| 0195 | `0195_dashboard_layout_upsert_constraint.sql` | Non-partial `UNIQUE NULLS NOT DISTINCT (family_id, user_id, device_context)` index on `dashboard_layouts` | **Fixes a live bug: "there is no unique or exclusion constraint matching the ON CONFLICT specification"** on every pin / dashboard-customize save. The 0089 unique indexes are **partial** (`WHERE scope=… AND deleted_at IS NULL`), which supabase-js's bare column-list `onConflict` cannot target. This adds a non-partial unique index (targetable by the column list) that serves both write paths — user layouts (`user_id` set) and the family default (`user_id` NULL, deduped via `NULLS NOT DISTINCT`); the two never collide. **⚠️ Coupled with app code** — `saveFamilyDefaultLayoutAction` now upserts on `family_id,user_id,device_context`; apply with the deploy. Deletes are hard (no soft-delete writer), so the non-partial index is safe; a defensive dedupe runs first. Additive/idempotent. Requires 0089. **PG16-verified** (reproduced the exact error against the partial index; after the fix both user + family upserts succeed and coexist; idempotent ×2). |
| 0197 | `0197_feedback_ideas.sql` | `feedback_ideas`, `feedback_votes`, `feedback_comments` (+ vote/comment counter triggers) and the public `feedback-attachments` Storage bucket | **Feedback / Idea Board `/feedback`** (the Gift icon in the home top bar). A platform-wide product-feedback board: any signed-in member posts an idea, upvotes (one vote per user per idea), and comments; statuses move through the roadmap (under_review → planned → in_progress → shipped). RLS: authenticated read on all three tables; insert-your-own on ideas/votes/comments; delete-your-own vote; **no public UPDATE** on ideas (status changes are super-admin service-role only). `vote_count` / `comment_count` are denormalized and kept exact by `SECURITY DEFINER` triggers. Additive/idempotent. Requires `families`, `set_updated_at`. **PG16-verified** (clean apply, idempotent ×2, counter triggers increment/decrement correctly). Seed: `supabase/SEED_ALL.sql` (500 ideas + votes + comments, marker `[seed:feedback]`). |
| 0200 | `0200_display_settings.sql` | `settings jsonb` column on `display_layouts` | **Kitchen Display `/display`** world-class upgrade. Adds a per-family display-preferences blob (clock 12/24h, seconds, °F/°C, background theme, ambient wash, burn-in protection) persisted alongside the tile layout on the same one-row-per-family table. Written by the existing family-scoped upsert (onConflict `family_id` — the UNIQUE from 0026); validated/rendered by `lib/display/ambient.ts` (pure + tested). Additive/idempotent (`ADD COLUMN IF NOT EXISTS`, default `'{}'`). Requires 0026. **PG16-verified** (idempotent ×2; settings upsert round-trips). No seed needed (the display is a live view over existing family data; settings default cleanly). |

| 0201 | `0201_blog_engagement.sql` | `blog_posts` hero-image columns + `blog_post_likes` (anonymous ♥, one per post+visitor) + `blog_subscribers` (email opt-ins with unsubscribe token) | **Blog engagement layer.** Backs the article ♥ button (`/api/blog/like`), the working subscribe forms (`/api/blog/subscribe`), and one-click unsubscribe (`/api/blog/unsubscribe`). Both new tables are service-role only (RLS on, no client policies — the rate-limited API routes are the single path). Safe before apply: hearts/subscribes fail gracefully; the blog still renders. Additive/idempotent. **PG16-verified** (idempotent ×2). |
| 0202 | `0202_blog_articles.sql` | Full content for **20 blog articles** (9 stubs fleshed out in place + 11 new) with topic-matched free-license Unsplash hero photos | **The blog, fully written.** Every cover-story stub becomes a complete, fun article; coverage is now 3–4 per category across all 6 categories; exactly one featured post. Idempotent upsert by slug (`ON CONFLICT DO UPDATE`), so re-running refreshes content harmlessly. Requires 0201 (image columns). **PG16-verified** (idempotent ×2; 20 posts, all with hero images, one featured). |
| 0203 | `0203_service_descriptions.sql` | `service_descriptions` (super-admin overrides for the "All Services" tooltips, keyed by nav route) | **Editable service tooltips.** The All Services picker now shows a hover tooltip explaining each service; copy defaults live in code (`lib/services/descriptions.ts`) and a super admin can override any of them at **`/admin/services`**. World-readable (tooltips render for members), writes service-role only (RLS denies clients). Safe before apply: tooltips fall back to the code defaults and the editor’s saves surface an error until the table exists. Additive/idempotent. **PG16-verified** (idempotent ×2; upsert + 400-char check + RLS read policy). |
| 0206 | `0206_feedback_github_tracker.sql` | `feedback_ideas.kind` (idea/bug) + GitHub issue link columns; `admin_notifications` (super-admin platform feed) | **Feedback → GitHub tracker + super-admin alerts.** `/feedback` now accepts **bugs** as well as ideas; each submission notifies the super admin (feed + email) and is mirrored to a GitHub issue tracker with two label-driven lists (`bug` / `enhancement`). A cron bot (`/api/cron/feedback-github-sync`) backfills + reconciles issue state back onto each idea and relays a digest. `admin_notifications` is service-role only (the super-admin-gated console reads it). **Owner keys (optional — the GitHub half is dark until set):** `GITHUB_TOKEN` (a fine-grained PAT with Issues: read+write) and `GITHUB_FEEDBACK_REPO` (`owner/repo`). Without them, submissions still notify the super admin — only the GitHub mirroring is skipped. Also relies on `CRON_SECRET` (bot) and `RESEND_API_KEY` (email). Safe before apply: submissions still insert; the notify/sync degrade best-effort until the table + keys exist. Additive/idempotent. **PG16-verified** (idempotent ×2; kind check + service-role RLS). |
| 0207 | `0207_admin_notification_kinds.sql` | Widens `admin_notifications.kind` to admit `support_ticket` + `marketplace_report` | **Super Admin Notification Center.** The admin-console bell is now the whole super-admin front door: besides feedback/GitHub, it surfaces **new support tickets** (contact form) and **marketplace Trust & Safety reports**, each written to `admin_notifications` (service-role) and deep-linked. Just a CHECK widening — safe before apply (the new-kind inserts are best-effort and simply no-op until it lands). Additive/idempotent. **PG16-verified** (idempotent ×2; new kinds accepted, bad rejected). Requires 0206. |
| 0209 | `0209_admin_growth_kinds.sql` | Widens `admin_notifications.kind` to admit `family_signup` + `subscription` | **Founder growth alerts.** The admin bell now also fires on a **new family completing onboarding** (`finalizeOnboardingAction`) and a **new paid conversion** — trial/free → paid+active, detected in the Stripe webhook via the pure `isNewPaidConversion` (fires once on the transition, never on renewals). Both best-effort/service-role. Just a CHECK widening — safe before apply. Additive/idempotent. **PG16-verified** (idempotent ×2). Requires 0206/0207. |
| 0213 | `0213_admin_churn_kind.sql` | Widens `admin_notifications.kind` to admit `subscription_churn` | **Founder churn alerts (the other half of the growth ledger).** The admin bell + digest now also fire when a **paying family cancels or downgrades to free** — was paid+active → now canceled/unpaid/expired or on the free plan, detected in the Stripe webhook via the pure `isChurn` (fires once on the loss, never on a tier change that stays paid, never on transient `past_due`). Best-effort/service-role. Just a CHECK widening — safe before apply (churn inserts no-op until it lands). Additive/idempotent. **PG16-verified** (idempotent ×2; churn kind accepted, bogus rejected). Requires 0206/0207/0209. |
| 0214 | `0214_family_contact_center.sql` | `family_contact_channels` (one per family: `@bubaly.com` local-part + dedicated Twilio number + AI-concierge config) + `family_inbox_messages` (unified inbox) | **Family Operations Center (Family+).** Every Family+ family gets ONE central contact identity — a `@bubaly.com` address and a dedicated phone number — and inbound calls/texts/emails all route into `family_inbox_messages`, where the AI concierge triages them (summary + intent, urgent → SMS the human fallback, otherwise a courteous auto-reply). Family-scoped RLS reads; all writes are privileged (provisioning + webhooks use the service role; the controls at `/dashboard/contact-center` are parent-gated). **Owner keys (dark until set):** `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` (already used by Guardian) buy + wire numbers; without them a number request is saved as `pending`. Inbound **email** to `@bubaly.com` additionally needs an inbound-email provider pointed at `/api/contact-center/*` (owner DNS/infra) — the address is assignable now; email routing lights up when that's connected. AI triage uses the existing provider and degrades to a deterministic classifier without it. Additive/idempotent. **PG16-verified** (idempotent ×2; CI-unique email local-part, provider-ref dedup, channel/status checks, 2 RLS policies). |


### Opportunity modules (0240–0248) — Top-50 everyday problems → Bubaly

All additive + idempotent, family-scoped RLS via `is_family_member`, `updated_at`
triggers, realtime publication. Each has a matching `npm run db:seed:<module>`
script that loads 250 rows per table for the target family (idempotent, tagged
`[seed:<module>]`). These are isolated-development fixture descriptions, not
production apply or seed instructions; the production release remains HELD.

| # | File | Adds | Feature it unblocks |
|---|------|------|---------------------|
| 0240 | `0240_closet_outfits.sql` | `wardrobe_items`, `outfits`, `outfit_logs` | Closet & Outfits `/dashboard/closet` (`db:seed:closet`) |
| 0241 | `0241_family_watchlist.sql` | `watchlist_titles`, `watchlist_votes`, `watch_sessions` | Family Watchlist `/dashboard/watchlist` (`db:seed:watchlist`) |
| 0242 | `0242_home_inventory.sql` | `home_locations`, `inventory_items`, `inventory_moves` | Home Inventory `/dashboard/inventory` (`db:seed:inventory`) |
| 0243 | `0243_sleep_coach.sql` | `sleep_logs`, `bedtime_routines`, `sleep_checkins` | Sleep Coach `/dashboard/sleep` (`db:seed:sleep`) |
| 0244 | `0244_declutter.sql` | `declutter_zones`, `declutter_missions`, `declutter_sessions` | Declutter Missions `/dashboard/declutter` (`db:seed:declutter`) |
| 0245 | `0245_move_planner.sql` | `moves`, `move_tasks`, `move_boxes` | Move Planner `/dashboard/moving` (`db:seed:moving`) |
| 0246 | `0246_home_projects.sql` | `home_projects`, `project_materials`, `project_quotes` (links `home_contractors`) | Home Projects `/dashboard/projects` (`db:seed:projects`) |
| 0247 | `0247_career_hub.sql` | `career_profiles`, `job_applications`, `resume_versions` | Career Hub `/dashboard/career` (`db:seed:career`) |
| 0248 | `0248_language_practice.sql` | `language_goals`, `language_sessions`, `vocab_cards` | Language Practice `/dashboard/language` (`db:seed:language`) |
| — | (no migration) | Hydration presets + count logging use the existing `habits` / `habit_logs` | Habits `/dashboard/habits` (`db:seed:hydration`) |

> **Data API grants.** These tables rely on the project's default privileges
> (tables created by `postgres` are granted to `anon` / `authenticated` /
> `service_role`), like every migration since 0002. The production project was
> created under that legacy default, so nothing extra is needed there. A project
> created after 2026-05-30, or a local stack without `[api] auto_expose_new_tables
> = true` in `supabase/config.toml`, revokes those defaults and would need explicit
> `GRANT`s — see the comment in `config.toml`.

### AI runtime core (0250–0251, forward 0252–0255) — the Family OS concierge spine

Additive + idempotent, verified on a Postgres 18 (PGlite) harness: the full
ordered migration set applies clean, 0250/0251 re-apply as a no-op, `claim_ai_runs`
never hands the same run to two callers, and a teen session is blocked from step
injection, run-event forgery and self-approval. Guard: `tests/ai-runtime-schema.test.ts`.

| # | File | Adds | Feature it unblocks |
|---|------|------|---------------------|
| 0250 | `0250_ai_runtime_core.sql` | `ai_requests`, `ai_request_context`, `ai_plans`, `ai_plan_steps`, `ai_run_events`, `ai_tool_calls`; extends `family_automation_runs` into the run + continuation queue (`state`, `run_type`, `request_id`/`plan_id`, lease + attempt columns, `idempotency_key`); extends `ai_conversations`/`ai_messages` (`state`, `structured_content`, `model`, `usage`, `request_id`, `sender_member_id`); `claim_ai_runs(int, int)` RPC (service-role only); realtime on `ai_run_events`, `ai_plan_steps`, `family_automation_runs` | The concierge run pipeline: request → plan → steps → executed run with a live timeline (`/dashboard/concierge`, run detail, "Working on" / "Completed by Bubaly"), the §30 duplicate guard, and per-family AI usage accounting |
| 0251 | `0251_ai_trust_hardening.sql` | `approval_requests` run/step linkage + `consequences`, `evidence`, `edited_payload`, `payload_kind`, `reviewed_by`, `review_note`, 48h `expires_at` default (+ backfill of pending rows); widened `trust_audit_logs.decision` CHECK; manager-only UPDATE/DELETE RLS on `approval_requests`, `family_automation_runs` and `parent_approvals`, plus a requester-only self-cancel policy | Approval cards with real consequences and an Edit flow, expiring approvals, and the write-side lockdown that stops a signed-in child approving their own request or marking a run `executed` |
| 0252 | `0252_ai_insert_authority.sql` | Pins what a member's INSERT may claim on `family_automation_runs` (queued, unlinked, unleased), `approval_requests` (pending, undecided, unexecuted), `parent_approvals` (pending, undecided) and `ai_requests` (own, queued, unaccounted) | A client INSERT can no longer manufacture executor authority (a ready run, a decided approval, a completed request). Guard: `tests/ai-insert-authority.test.ts` |
| 0253 | `0253_ai_worker_execute_lockdown.sql` | Revokes `claim_ai_runs(int, int)` from `public`, `anon` and `authenticated`; grants it to `service_role` only, and verifies | Only the server worker (`/api/cron/ai-runs`) can claim the global run queue. Guard: `tests/production-security-boundaries.test.ts` |
| 0254 | `0254_wallet_write_policy_drift.sql` | Drops the legacy permissive wallet write policies and adds restrictive manager guards on the five wallet tables | Closes the wallet RLS drift (LB-010/PLA-0580) so a child cannot mint completed credits. Guard: `tests/production-security-boundaries.test.ts` |
| 0255 | `0255_ai_runtime_lockdown.sql` | Runtime INSERT lockdown preserving main's pending-decision, accounting, active-member, current-step, lease-expiry and idempotency guards; approvals require a non-null active caller member and no request/run/step/payload linkage; adds `ai_requests.client_request_id` + unique `(family_id, client_request_id)`; makes `ai_conversations`/`ai_messages` owner-only | **HELD.** This is runtime write-lockdown with conversation/message ownership, not the previously planned broader requester-privacy fix. The raw request/context/plan/run/tool/event privacy gap requires a separate reviewed follow-up and is not implemented here. No production apply is authorized; the pinned release bundle remains unchanged and held. |
| 0256 | `0256_idempotency_keys.sql` | `idempotency_key` + partial unique `(family_id, idempotency_key)` on `calendar_events`, `family_reminders`, `todo_items`, `chore_assignments`, `meal_plans`, `grocery_items`; `fingerprint`, `source`, `receipt_document_id` (+ partial unique fingerprint) on `transactions` | §30/§45 duplicate protection stops being a probe the app hopes to win: a retried tool call cannot create a second event, reminder or to-do, and a receipt scanned twice cannot become two charges. Guards: `tests/0256-idempotency.test.ts`, `tests/duplicate-protection.test.ts` |
| 0257 | `0257_family_ai_settings.sql` | `family_ai_settings` (one row per family: `enabled`, `behavior`, `category_behavior`, `risk_overrides`, `child_channels`, `memory_enabled`, quiet hours), member-read/manager-write RLS, seeded by `handle_new_family()` and backfilled | §11/§12: Settings → Bubaly AI. A family dials autonomy per category and can raise a tool's risk tier; money and documents keep `medium` as a floor in code. Defaults reproduce today's behaviour exactly. Guards: `tests/0257-ai-settings-seed.test.ts`, `tests/ai-settings.test.ts` |
| 0258 | `0258_home_briefs_kind.sql` | `home_briefs.kind` ('daily'/'evening'), `handled` jsonb, `delivered_at`, and a unique `(family_id, as_of_date, kind)` | §49: the morning brief and the evening recap can coexist, "Bubaly handled" carries the runs that really completed, and a retried delivery cron tells the family once. Guards: `tests/0258-home-briefs.test.ts`, `tests/briefing-store.test.ts` |
| 0259 | `0259_routine_schedules.sql` | `family_automation_rules` gains `schedule_kind` (cron/relative), `schedule_expr`, `anchor_key`, `offset_days`, `at_hour`, `next_run_at`, `said`, `source_request_id`, a due index and shape CHECKs; new `routine_runs` (unique on `(rule_id, due_at)`, member-read, no client write) | §19/§58: "every Sunday plan our meals" and "two days before every trip" become rows `/api/cron/family-routines` fires exactly once per occurrence. A routine files an `ai_request` — the trust gate and `family_ai_settings` still decide what happens. Guards: `tests/0259-routine-schedules.test.ts`, `tests/cron-family-routines.test.ts`, `tests/routines-schedule.test.ts` |

**Read the RLS change before applying.** 0251 replaces the permissive `FOR ALL
is_family_member` policies on `family_automation_runs` (0022) and
`parent_approvals` (0088) with select/insert for members and update/delete for
managers. Every app writer was checked first and each decision path is already
manager-gated in code (the migration header lists them file by file), so no live
UI path changes behaviour — but a custom script that PATCHes either table with a
member's token will start failing and must move to the service client.

Post-apply checks:

```sql
select to_regclass('public.ai_requests'), to_regclass('public.ai_plan_steps'),
       to_regclass('public.ai_run_events'), to_regclass('public.ai_tool_calls');
select has_function_privilege('service_role', 'public.claim_ai_runs(integer,integer)', 'EXECUTE');
select polname, cmd from pg_policies
 where tablename in ('approval_requests','family_automation_runs','parent_approvals');
select count(*) from public.approval_requests where status = 'pending' and expires_at is null; -- 0
```

This historical inventory is not a replay plan. Do not use a full push or an
incomplete production ledger to infer that older migrations should run again.
Idempotency does not establish replay safety; the HELD status and parent-owned
reviewed forward-release procedure above govern production changes.

## ⚠️ Note for whoever maintains the migration folder

Several version prefixes are **duplicated** by parallel work streams. They are
preserved as historical filenames because renaming one after production has
recorded it can create migration drift. The complete known set is enforced by
`npm run db:audit:migrations` and includes: `0010`, `0026`, `0042`, `0043`,
`0073`, `0080`, `0089`, `0090`, `0095`, `0098`, `0105`, `0108`, `0109`,
`0110`, `0137`, `0138`, and `0142`. Supabase orders colliding files by their
full filename in the SQL-editor bundle, but a future migration must not reuse a
taken prefix. Next free number: **0226**. `npm run db:push` runs this guard
before contacting Supabase and fails if a new or changed collision appears.

## Environment variables (set alongside the migrations)

- **`CRON_SECRET`** — required to activate the Vercel crons, including
  `model-refresh` (event-driven twin + prep-plan refresh), `network-aggregate`
  (daily Intelligence Network aggregation — nothing publishes until ≥100 families
  opt in), **`close-auctions`** (every 5 min — closes expired marketplace
  auctions: winner → order + notify, reserve-not-met → withdrawn + notify), and
  **`return-reminders`** (daily 08:00 — due-soon nudges + overdue alerts for
  borrowed/rented marketplace items), and **`admin-digest`** (daily 12:30 UTC —
  emails super admins a growth-first rollup of the last 24h of `admin_notifications`;
  reuses `RESEND_API_KEY`, sends only on days with activity, dark without the key).
  Without it those endpoints return 401, auctions never auto-close, borrowers get
  no return reminders, and the daily digest never sends.
- **`CHILD_LOGIN_SECRET`** — required for **Kid Logins** (username + PIN, no email).
  It's mixed into the child's derived auth password so a 4-digit PIN can't be
  brute-forced offline. Without it, `/kid-login` and "create child login" report
  "not configured yet" and no child accounts can be created or signed in. Use a
  long random value; changing it later invalidates existing child passwords (a
  parent PIN reset re-derives them).
- Optional keys that light up already-built, key-gated paths: **VAPID/FCM** (push),
  **Maps/ETA** (leave-by travel buffer), **Giphy/Tenor** (Messages GIF picker),
  **Stripe Issuing** (real-time Wallet card balances).
- **`CONTACT_CENTER_INBOUND_SECRET`** — shared secret for the **Family Operations
  Center** inbound-email webhook (`/api/contact-center/email`). Point an inbound-email
  provider (SendGrid Inbound Parse, Cloudflare Email Routing → webhook, Mailgun…) for
  `@bubaly.com` at that route with `?key=<secret>` (or the `x-inbound-secret` header).
  Fail-closed: with the secret set, mismatches are rejected; without it set, the route
  rejects in production (never an open relay). SMS/voice for the dedicated number reuse
  the existing `TWILIO_*` pair (see Guardian).
- **`GITHUB_TOKEN` + `GITHUB_FEEDBACK_REPO`** (`owner/repo`) — mirror `/feedback`
  submissions (bugs + ideas) to a GitHub issue tracker with two label-driven lists
  (`bug` / `enhancement`), reconciled by the `feedback-github-sync` cron. Fine-grained
  PAT with Issues: read+write. Dark until set — submissions still notify the super
  admin without it (feed + email).
- **`MICROSOFT_SYNC_CLIENT_ID` / `MICROSOFT_SYNC_CLIENT_SECRET`** (+ optional
  `MICROSOFT_SYNC_TENANT`, `MICROSOFT_SYNC_REDIRECT_URI`, `MICROSOFT_SYNC_SCOPES`) — flip on **live
  Microsoft / Outlook two-way sync** (R9). The whole adapter + generic engine is built and tested
  offline; without these keys `isConfigured()` is false and `/api/sync/run` returns 503 for Microsoft
  (Google sync is unaffected). Same pattern as the existing `GOOGLE_SYNC_*` pair.

## Test data (optional, after migrations)

**One-paste option:** `supabase/SEED_ALL.sql` runs all 46 paste-ready seeds in
dependency order — one paste fills every user-facing surface with ≥500 rows for
the resolved family. Idempotent (re-run safe); validated on PG16. Requires the
migrations above to be applied first.

Per-feature **500-row seeds** live in `supabase/seed_*.sql` — paste-ready,
idempotent, resolve the family by email. Coverage now spans every user-facing
surface (see the Seed-coverage tracker in `todo.md`): core content, all 9 North
Star pillars, Messages/Chores/Meals/Documents/Location/Finance/Memories/Autopilot/
Vault, the Knowledge Graph, Decisions, Prep Plans, and the Onboarding funnel
(`seed_onboarding_events.sql`). Older paths also expose `db:seed:wallet-ledger`,
`db:seed:voice`, and the in-app **Copy SQL** screens (Marketplace, Knowledge Base).
| 0164 | `0164_family_trial_and_close.sql` | `families.trial_ends_at` + `closed_at` (5-day trial clock + soft account closure) | **Monetization model change.** New families get 5 days of full **Family Basic** then the app locks (`TrialPaywallGate`) until they buy Family Basic or Family+ — no permanent free tier. **Existing families are grandfathered** (structural: column added with NO default → existing rows NULL → never locked; then a `now()+5d` default applies to new rows only). `closed_at` powers soft account closure (nothing deleted, reopenable). **⚠️ Coupled with app code** — `(app)/layout.tsx` gate + `resolveFamilyPlanLevel` read these; apply with the deploy. (Renumbered from 0161 to avoid the `0161_demo_session_email_gate` collision.) Additive/idempotent. PG16-verified: existing family NULL, new family = 5 days, `closed_at` present, idempotent ×2. |
| 0174 | `0174_workload_snapshots.sql` | `workload_snapshots` (household workload balancing + analytics) | Renumbered forward from skipped `0166`; production capability probes confirmed the table was absent while `0168`–`0172` were live. Idempotent and seeded by `seed_workload.sql` (500 rows). |
| 0175 | `0175_independence_milestones.sql` | `independence_milestones` (child independence progression ladder) | Renumbered forward from skipped `0167`; production capability probes confirmed the table was absent. Idempotent and seeded by `seed_independence.sql` (500 rows). |
| 0176 | `0176_marketplace_circles.sql` | Community Marketplace circles, memberships, listing shares, RLS, and lifecycle RPCs | Renumbered forward from skipped `0173`; production capability probes confirmed the tables were absent. Idempotent and seeded by `seed_marketplace_circles.sql` (exactly 500 rows). |
| 0177 | `0177_remove_synthetic_auth_users.sql` | Removes only retired `onb[0-9]+@seed-onb.bubaly.test` and `person[0-9]+@seed.bubaly.test` Auth fixtures | **Production Auth repair (LB-001 / PLA-B001).** Direct `auth.users` inserts in retired seeds violated GoTrue invariants and caused the Admin Users endpoint to return HTTP 500. A plain delete failed in prod on a **non-cascading FK** (`23503`, `game_results.created_by`); the migration now first clears every row referencing the synthetic users through any single-column FK to `auth.users(id)`, then deletes the users one-by-one (a single stubborn reference can't abort the run) — real accounts are untouched. Aborts above 1,000 matches; idempotent. **PG16-verified** (reproduced the exact `game_results` FK block, then removed the synthetic user + its blocking rows while preserving the real user; re-run is a clean no-op). Apply before re-running `npm run db:audit:auth`. |
| 0179 | `0179_harden_rate_limit_rpc_grants.sql` | Restricts durable limiter RPC execution and scopes authenticated buckets to `auth.uid()` | **Security hardening.** Removes anonymous/public execution from `rate_limit_hit`, makes `rate_limit_prune` service-role only, and preserves authenticated server calls only for user-scoped keys. Apply with the route-key changes; idempotent. |
| 0180 | `0180_resend_webhook_dedup.sql` | `resend_webhook_events` durable Svix event ledger | **Webhook replay protection.** Stores signed Resend event IDs, keeps the ledger service-role only, and lets failed/stale processing retry without double-applying completed events. Apply with the webhook code; idempotent. |
| 0181 | `0181_guardian_callback_replay.sql` | `guardian_callback_events` durable Twilio callback ledger | **Guardian replay protection.** Claims bounded SMS, WhatsApp, voice, screening, and voicemail callback IDs before AI, notifications, or telephony side effects. Service-role only; stale crashed claims can be reclaimed; idempotent. |
| 0182 | `0182_stripe_webhook_claims.sql` | `stripe_webhook_events.processing_started_at` and `claim_token` claim fields plus index | **Stripe concurrency protection.** Prevents concurrent deliveries from both processing an active event; ownership tokens prevent stale workers from overwriting reclaimed claims, while failed and stale abandoned claims remain retryable. Additive and idempotent. |
| 0186 | `0186_marketplace_negotiations.sql` | `marketplace_negotiations` + `marketplace_negotiation_rounds` + `marketplace_negotiation_offer()` / `marketplace_negotiation_respond()` RPCs | **New feature — the eBay "Best Offer" gap: real back-and-forth negotiation.** Today a buyer can send ONE offer amount and the seller can only accept/decline it; this adds a proper two-sided thread — buyer opens, either party **counters**, and the seller (or buyer) **accepts / declines / withdraws**, with a strict turn model. Both RPCs are `SECURITY DEFINER` and lock the listing `FOR UPDATE`, verifying the caller is the buyer (in their family) or the listing owner (in theirs) — so two families racing can't both win the same item. **Accept is atomic**: it claims the listing, writes a confirmed `marketplace_orders` row at the agreed price, and closes every competing thread + open offer (same pattern as `marketplace_accept_offer`). Pure engine `lib/marketplace/negotiation.ts` (turn/actions/suggestions/human lines, **14 tests**). Surfaced on the item page's realtime **NegotiationPanel** (offer/counter/accept/decline/withdraw + thread timeline) and the **`/marketplace/negotiations`** inbox (Your move / Waiting / Settled) + nav entry. RLS: a thread is readable by the buyer's family OR the seller's; all writes go through the RPCs. Seeded by `seed_marketplace_negotiations.sql` (100 sale listings + 100 threads across every status + ~320 rounds + 20 orders ≈ 540 rows, in `SEED_ALL.sql`). Safe before apply: the panel + inbox read best-effort and show nothing until the tables exist. Additive/idempotent. Requires 0120 + 0151 + 0154. **PG16-verified** (idempotent ×2; full offer→counter→counter→accept flow + own-listing/turn/competing-thread/claimed/withdraw/decline guards; seed idempotent ×2 = 100/100/320/20). |
| 0183 | `0183_marketplace_auctions.sql` | Auction columns on `marketplace_listings` (sale_format/starting_bid/reserve/buy_now/current_bid/anti_snipe…) + `marketplace_bids` + `marketplace_place_bid()` RPC | **New feature — the eBay-beating gap: real proxy-bid auctions.** Turns the marketplace into a live auction house: eBay-style **max (proxy) bidding** — a bidder submits their ceiling and the system reveals only enough to lead, with tiered minimum increments, a hidden **reserve**, optional **Buy-It-Now**, and **anti-sniping** (a late bid extends the clock). Bidding runs through `marketplace_place_bid()` (`SECURITY DEFINER`, `SELECT … FOR UPDATE` row-lock → no race can double-lead or under-bid); the pure engine `lib/marketplace/auction.ts` (11 tests) mirrors the SQL increment/reserve/status math. Surfaced at **`/marketplace/auctions`** (live board, soonest-ending first) and the item page's realtime **AuctionPanel** (ticking countdown, proxy-bid + quick-bid ladder, Buy-It-Now, live bid history via Supabase Realtime). Expired auctions are closed by the **`close-auctions` cron** (winner → confirmed `marketplace_orders` + bids won/lost + notify; reserve-not-met → withdrawn + notify). Family-scoped RLS via `is_family_member` (bidders see their own + the owner's rows). Seeded by `seed_marketplace_auctions.sql` (60 auctions + ~456 bids ≈ 516 rows, in `SEED_ALL.sql`). Safe before apply: the auctions board + panel read best-effort and simply show nothing until the table exists. Additive/idempotent. **Also needs `CRON_SECRET`** (close-auctions). **PG16-verified** (idempotent ×2; proxy/reserve/anti-snipe RPC scenarios; seed idempotent ×2 = 60 lots / 456 bids). |
| 0172 | `0172_crm_lead_scores.sql` | `crm_lead_scores` (Transparent lead scores) | **Visitor-intelligence gap #14 — lead scoring with a transparent ledger.** Persists a per-contact 0–100 `score` + `band` (cold/warm/hot/qualified) + itemized `factors` jsonb. `lib/marketing/contact-score.ts` (pure, **7 tests**) turns signals into a score where every point is an attributable, named factor; `lib/marketing/contact-score-compute.ts` gathers the signals (mkt_visitors sessions/recency, conversion touchpoints, marketing/analytics consent, demo starts, progressive-profile completeness, lifecycle) and upserts. Surfaced at **`/admin/marketing/lead-scores`** (super-admin only) — ranked contacts, expandable "why" ledger, and a **Recompute** action (`recomputeAllContactScores`). Admin/service-role only (RLS on, no public policy); indexed by `score desc`. Seeded by `seed_crm_lead_scores.sql` (500 rows across all four bands, ledgers that sum to the score, in `SEED_ALL.sql`). Safe before apply: the page shows an empty state until the table exists. Additive/idempotent. **PG16-verified** (idempotent ×2; RLS + index; seed 500 idempotent ×2; ledger-sums-to-score check = 0 mismatches). |
| 0171 | `0171_crm_contact_profile.sql` | `crm_contact_profile` (Progressive-profiling store) | **Visitor-intelligence gap #13 — progressive-profiling capture.** One-question-at-a-time enrichment (role → priority → household → kids → interests) via `lib/marketing/progressive-profile.ts` (pure engine, **10 tests**) surfaced as a `ProfileNudge` card on `/dashboard/settings`. Answers upsert a structured per-contact profile (with `extra.skipped[]` so dismissed questions aren't re-asked); server actions resolve/create the user's `crm_contacts` lead (service-role, identity-verified) and feed segmentation/personalization. Owner-scoped RLS (`crm_contacts.owner_id = auth.uid()`); `updated_at` trigger. Seeded by `seed_crm_contact_profile.sql` (500 rows across varied completeness, in `SEED_ALL.sql`). Safe before apply: the card renders nothing until the table exists (best-effort hydrate). Additive/idempotent. **PG16-verified** (idempotent ×2; RLS policy + trigger; seed 500 idempotent ×2). |
| 0170 | `0170_contact_interactions.sql` | `contact_interactions` (Relationship CRM — per-contact touches) | **New feature — deepens industry-first #5 (household relationship CRM).** `/dashboard/contacts/[id]` (linked from every contact card): a per-person **relationship timeline** merging logged touches (visit/call/message/gift/favor/note — this table) with inbox `family_communications` and birthdays (`lib/contacts/timeline.ts`, **8 tests**), plus a **relationship-health** read: last touch vs. this relationship's natural cadence (median gap, needs ≥3 touches) → fresh / due / overdue with a plain-language reconnect nudge. Log/delete interactions via server actions; gifts carry dollar amounts. Family-scoped RLS via `is_family_member`. Seeded by `seed_contact_interactions.sql` (500 rows across ≤25 contacts — creates 8 starter contacts if none, in `SEED_ALL.sql`). Safe before apply: the timeline page renders comms + birthdays only (best-effort read) until the table exists. Additive/idempotent. **PG16-verified** (idempotent ×2; seed 500 idempotent ×2 across 8 contacts / 6 kinds; 4 RLS policies; `updated_at` trigger). |
| 0169 | `0169_paperwork_items.sql` | `paperwork_items` (Paperwork Inbox — AI form/paperwork triage) | **New feature — deepens industry-first #4 (AI handles forms & paperwork).** `/dashboard/paperwork` (linked from the Communications Hub): paste any slip/form/flyer and the deterministic triage brain (`lib/paperwork/triage.ts`, **9 tests**) classifies the kind (permission slip / school notice / medical form / sports / bill / event flyer), extracts the ACTION ITEMS a parent must do (sign/pay/rsvp/schedule/provide) with due dates + dollar amounts pulled from prose, and ranks urgency. Each action **materializes one-tap** into a real calendar event or family reminder — the materialization is stamped back onto the row (idempotent, auditable; all-actions-done auto-completes the item). Family-scoped RLS via `is_family_member`. Seeded by `seed_paperwork.sql` (500 rows across all 7 kinds × 4 statuses, in `SEED_ALL.sql`). Safe before apply: the page renders an empty inbox (best-effort read) until the table exists. Additive/idempotent. **PG16-verified** (idempotent ×2; seed 500 idempotent ×2; 4 RLS policies; `updated_at` trigger). |
| 0168 | `0168_money_timeline_insights.sql` | `money_timeline_insights` (Financial Copilot — schedule↔money insights) | **New feature — deepens industry-first #8 (schedule↔money↔life-event linkage).** `/dashboard/money-timeline` (the **Financial Copilot**, linked from the Finances hub) fuses bills + savings-goal target dates + recurring costs + calendar events + liquid balances into ONE forward, week-bucketed cash-flow timeline with a running projected balance, "heavy week" detection, and ranked plain-language insights (`lib/finance/timeline.ts`, 8 tests). The **timeline itself is computed live** — this table persists the copilot's generated insights so a family can **acknowledge/dismiss** them and the state survives a recompute (sync upserts content by a stable `dedupe_key`, never overwriting status). Family-scoped RLS via `is_family_member`. Seeded by `seed_money_timeline.sql` (500 rows across the 4 week-bearing kinds × 125 weeks, in `SEED_ALL.sql`). Safe before apply: the page renders live and the acknowledge/dismiss state simply doesn't persist until the table exists (page + actions wrapped best-effort). Additive/idempotent. **PG16-verified** (idempotent ×2; seed 500 idempotent ×2; 4 RLS policies; `updated_at` trigger; status-preserving upsert confirmed — a dismissed insight survives a content refresh). |
| 0173 | `0173_concierge_calls.sql` | `concierge_calls` (outbound AI calls — "Bubaly calls for you") | **New feature — closes roadmap gap #2 (outbound AI phone calls).** The OUTBOUND counterpart to AI Front Desk: the AI places calls ON BEHALF of the family (book/reschedule/cancel/confirm/inquire/follow-up) with an auto-generated call brief (opening · talking points · questions · success criteria · fallback), full lifecycle status, and outcome/transcript once placed. Telephony is **provider-gated** (`TWILIO_*`): without a key, requests queue and `/api/concierge-calls/place` flips them to `action_needed` with an honest note — the brief + UI are fully usable without a phone provider, and light up when one is added. Family-scoped RLS via `is_family_member`; linked from AI Front Desk (no global-nav change). Seeded by `seed_concierge_calls.sql` (500 rows across every task_kind/status). Safe before apply: the page/actions degrade cleanly until the table exists. Additive/idempotent. PG16-verified (idempotent ×2; 4 RLS policies; seed 500 idempotent ×2). |
| 0165 | `0165_family_app_store.sql` | `family_apps` (catalog) + `family_app_installs` (family-scoped RLS) | **Family App Store** (`/dashboard/app-store`) — the industry-first #10 gap: an open catalog of one-tap AI extensions families install into their workflows. Catalog readable by any signed-in user; installs family-scoped. Seed `seed_family_apps.sql` (500 apps across 12 categories) in `SEED_ALL.sql`. Additive/idempotent. Safe before apply: the page reads best-effort (empty catalog until seeded). PG16-verified (184 migrations apply, 500 rows, RLS on, idempotent re-seed). |
| 0215 | `0215_safety_write_rls_hardening.sql` | Manager-only WRITE RLS on `family_places` + `guardian_routing_rules` | **Defense-in-depth for the child-safety authz bugs (PLA-0470/0520).** These safety tables shipped with `is_family_member` FOR ALL, so RLS alone did not stop a signed-in child from deleting/disabling the geofences and call/message-screening rules protecting them — the app-level gate was the only barrier. Keeps SELECT open to all members (a child device must read geofences to detect arrivals) but restricts INSERT/UPDATE/DELETE to `can_manage_family()` (parent/adult). Service-role writes (AI learning) bypass RLS, unaffected; `member_locations` (self) + `chore_submissions` (child inserts) intentionally untouched. Additive/idempotent (`drop policy if exists` → create). **PG16-verified** (applies fail=0; live proof on `family_places`: child read OK, INSERT→RLS error, UPDATE/DELETE→0 rows, parent write OK, 0 survivors; guardian rules use the identical policy shape). Guard test `tests/safety-write-rls-hardening.test.ts` (5). |
| 0216 | `0216_family_media_bucket.sql` | `family-media` Storage bucket + family-folder write RLS on `storage.objects` | **Brings a live-only bucket into version control (LB-009/PLA-0461).** Photos, Create-Memory, Message attachments, and Reminder attachments all upload to `family-media`, but it was created out-of-band in the dashboard — so a fresh project / the PG16 harness had NO bucket and every upload failed. Idempotent bucket create (`on conflict do nothing`; 25 MB limit; **public=true** to preserve the `getPublicUrl` contract that the app + already-stored URLs depend on) + family-folder write RLS (insert/update/delete + authenticated select scoped to `is_family_member(foldername[1])`), mirroring the private `documents` bucket (0007). **PG16-verified** (applies + idempotent ×2; cross-family write PROVEN blocked — family A member allowed into A's folder, blocked from B's; authenticated select family-scoped). Safe before apply: prod already has the bucket, and `on conflict do nothing` never mutates it — the migration only adds/refreshes the write policies. **Residual (LB-009, owner):** reads stay public; a private+signed-URL switch needs a data-migration of stored public URLs. Guard `tests/a11-family-media-bucket.test.ts`. |
| 0217 | `0217_wallet_ledger_write_lockdown.sql` | Manager-only WRITE RLS on the wallet money tables | **CRITICAL money-integrity fix (PLA-0580 / LB-010).** `wallet_transactions` (and the wallet_* tables) shipped `is_family_member` FOR ALL, so a signed-in child could INSERT a `completed` `credit` via PostgREST and MINT spendable money. 0217 keeps SELECT open to members but restricts INSERT/UPDATE/DELETE to `can_manage_family()`; trusted writes (cron/webhooks/reserve RPC + chore auto-approve, now routed via service-role) bypass RLS. **Forward `0254` closes wallet RLS drift; production apply remains pending.** Recorded **PG16** evidence (child mint→RLS error, manager+service writes OK, idempotent ×2) is not proof of production policy state. Guard `tests/wallet-ledger-write-rls.test.ts`. |
| 0218 | `0218_economy_ledger_write_lockdown.sql` | Manager-only WRITE RLS on the family ECONOMY (token) ledger | **Money-integrity fix (PLA-0590), sibling of 0217.** `currency_transactions` (+ economy tables) shipped `is_family_member` FOR ALL, so a child could INSERT a token `credit` via PostgREST and mint currency redeemable for parent-defined rewards. 0218 restricts currency ledger + config + rewards writes to `can_manage_family()`; token debits go via the manager action or the service-role `loyalty_redeem_reward` RPC. **Exception**: `economy_redemptions` keeps member INSERT (a child requests a pending redemption); only approve/deny (UPDATE/DELETE) are manager-only. Historical relationship to `0217`, not a replay instruction. **PG16-verified** (child mint→RLS error, child redemption request→OK, manager award→OK, idempotent ×2). Guard `tests/economy-ledger-write-rls.test.ts`. |
| 0219 | `0219_admin_tables_service_role_rls_lockdown.sql` | Service-role-only RLS on `admin_users` + `support_tickets` | **P1 tenant-isolation fix (PLA-0600 / LB-011).** Migration 0010 created both tables with policies `using(true) with check(true)` and NO `to service_role`, so they defaulted to `TO public` — any signed-in user could read every family's support tickets (requester name/email + issue text) and the full admin roster (`admin_users`: emails/roles/permissions), and tamper with `admin_users`. 0219 recreates both `service_role_all` policies `to service_role` (client roles ⇒ default deny). The admin console uses the service-role client (BYPASSRLS) behind an `isSuperAdmin` gate, so nothing user-facing changes. **PG16-verified** (idempotent ×2; family-A member read 11→0 tickets, 12→0 admins, INSERT blocked; service-role still full access). Guard `tests/admin-tables-service-role-rls.test.ts`. Production policy state requires separate evidence through the approved release verification; this entry is not a historical replay instruction. |
| 0220 | `0220_invest_ledger_write_lockdown.sql` | Manager-only WRITE RLS on the KID INVESTING ledger | **Money-integrity fix (PLA-0600), 3rd of the ledger trilogy (0217 wallet / 0218 economy / 0220 invest).** `invest_holdings` shipped `is_family_member` FOR ALL, so a child could INSERT holdings and mint shares. 0220 restricts invest_holdings writes to `can_manage_family()` (the SECURITY DEFINER `invest_decide_order` RPC bypasses RLS, so approvals work). Exception: `invest_orders` keeps member INSERT (a child places a pending order); approve/cancel are manager-only. Historical relationship to `0217`/`0218`, not a replay instruction. **PG16-verified** (child holdings-mint→RLS error, child order placement→allowed, idempotent ×2). Guard `tests/invest-ledger-write-rls.test.ts`. |
| 0221 | `0221_revoke_place_bid_unchecked_from_authenticated.sql` | Revoke EXECUTE on `marketplace_place_bid_unchecked` from `authenticated` | **P2 marketplace-integrity IDOR (PLA-0610 / LB-012).** 0184 renamed the raw bid fn → `_unchecked` + added a checked `marketplace_place_bid` wrapper, but the rename carried 0183's `authenticated` grant and `revoke ... from public` didn't drop it — so any signed-in user could call `_unchecked` directly (SECURITY DEFINER) with a spoofed `p_bidder_member_id`/`p_bidder_family_id` and bid AS another family, bypassing the wrapper's `auth.uid()` checks. 0221 revokes it from `authenticated` (service_role + the definer wrapper only). **PG16-verified** (direct member call permitted pre-0221 → "permission denied" post; checked wrapper still works ×2). Guard `tests/marketplace-bid-unchecked-revoke.test.ts`. Production grants require separate evidence through the approved release verification; this entry is not a historical replay instruction. |
| 0224 | `0224_wallet_audit_log_append_only.sql` | Makes `wallet_audit_logs` append-only for clients (member SELECT+INSERT; no UPDATE/DELETE) | **A-08 money-audit integrity (PLA-0622).** `wallet_audit_logs` shipped `"Members manage" FOR ALL is_family_member` (0088) and was missed by the 0217 ledger lockdown, so a child could UPDATE/DELETE money-audit rows — rewriting/erasing the history a parent reviews (no money moves; the ledger is locked by 0217). Drops the FOR-ALL policy, keeps `is_family_member` SELECT + INSERT (all ~10 app appends still work), grants no UPDATE/DELETE to `authenticated` (service-role retention only). Additive/idempotent. **PG16-verified** (child SELECT+INSERT OK; child UPDATE/DELETE → 0 rows; service-role UPDATE/DELETE OK). Guard `tests/wallet-audit-log-append-only.test.ts`. |
| 0225 | `0225_pin_definer_search_path.sql` | Pins `set search_path = public` on the last 2 SECURITY DEFINER functions | **Definer-function hardening (linter compliance + defense-in-depth).** An audit of all 61 SECURITY DEFINER functions found 59 already pin search_path; only 0014's `sync_album_photo_count` + `update_conversation_last_message` did not (the Supabase `function_search_path_mutable` lint). Both are safe today (all table refs schema-qualified; only built-ins called), so this is defense-in-depth, not a live exploit — but it closes the class and a ratchet (`tests/definer-search-path-pinned.test.ts`) keeps any future definer function from omitting it. `create or replace` preserves the trigger bindings. Additive/idempotent. **PG16-verified** (both now `proconfig={search_path=public}`; the photo-count trigger still fires 0→1). |
| 0223 | `0223_chore_assignment_decision_guard.sql` | BEFORE INSERT/UPDATE trigger on `chore_assignments` restricting `approved`/`rejected` to managers/service-role | **A-07 integrity defense-in-depth (PLA-0613), sibling of 0222.** `chore_assignments` shipped `is_family_member` FOR ALL, so a child could `update ... set status='approved'` directly and forge the COMPLETION of their own chore (the status the dashboard reads as done/approved). Mints no money (reward is credited in `finalizeApproval` under 0217). The only decision-status writers already run as service-role/manager, so the trigger breaks no legitimate flow; members keep `todo`/`in_progress`/`submitted`/`done`. Additive/idempotent. **PG16-verified** (child approved+rejected → blocked; child in_progress → OK; manager + service-role approved → OK). Guard `tests/chore-assignment-decision-guard.test.ts`. |
| 0222 | `0222_chore_submission_decision_guard.sql` | BEFORE INSERT/UPDATE trigger on `chore_submissions` restricting decision statuses to managers/service-role | **A-07 integrity defense-in-depth (PLA-0612).** `chore_submissions` shipped `is_family_member` FOR ALL, so a child could `update chore_submissions set status='approved'` directly via PostgREST and forge an approval of their own proof (the app action was already role-gated in PLA-0450; this closes the direct-DB path). The trigger blocks any transition **into** a decision status (`approved`/`rejected`/`needs_improvement`/`parent_review`) unless the caller is the service role, an unauthenticated server/migration/seed context (`auth.uid() is null`), or a family manager; members keep submit (`pending`) + dispute (`disputed`). **Coupled with the app fix** in the same increment — `submitProofAction` now routes the AI-verdict / auto-approve / decision-status writes (and the `chore_ai_validations` insert, which was RLS-broken for every user) through the service role, so legitimate flows are unaffected. Additive/idempotent (`to_regclass`-guarded, `drop trigger if exists` → create). **PG16-verified** (child self-approve UPDATE+INSERT → blocked; child submit/dispute → OK; manager approve → OK; service-role auto-approve → OK; seed still applies fail=0). Guard `tests/chore-submission-decision-guard.test.ts`. |
| 0226 | `0226_blog_500_articles.sql` | 525 new `public.blog_posts` rows (public marketing blog content) | **Blog content expansion (PLA-0780).** Grows the public /blog from ~20 to 545 articles across 9 category tabs — each a unique topic with a full multi-section body, free-license Unsplash hero photo, #hashtags (incl #bubaly), SEO excerpt, and a bubaly.com back-reference. Generated deterministically by `scripts/generate-blog-posts.mjs`. Idempotent `ON CONFLICT (slug) DO UPDATE` (re-runnable; never dupes). Reads are public (0010 RLS: published=true world-readable). Safe before apply: the blog simply shows fewer posts until applied. **PG16-verified** (INSERT 0 525 + idempotent ×2; full bootstrap fail=0, 545 public rows across 9 categories). Guard `tests/blog-articles-contract.test.ts` (11). |
| 0227 | `0227_blog_post_saves.sql` | `blog_post_saves` (per-user article bookmarks) + own-rows-only RLS | **Sign-in-gated blog save (PLA-0780).** The blog heart is now an account feature: clicking requires sign-in and persists a per-user save. New table with RLS `user_id = auth.uid()` on select/insert/delete (`TO authenticated`); the aggregate save count on the heart is produced by the service role only (no cross-user exposure). Backs `/api/blog/save` (401 for signed-out POSTs) + the reworked `HeartButton` (routes signed-out readers to `/login?redirect=…`). Additive/idempotent. **PG16-verified** (table + 3 own-rows policies; RLS on; full bootstrap fail=0). Guard `tests/blog-save-auth-gate.test.ts` (4). |
| 0228 | `0228_marketing_public_aeo_and_content_registry.sql` | Public SELECT on published `marketing_aeo_questions` + register blogs in `marketing_content_items` | **Marketing closed loop (PLA-0790).** (1) Published AEO questions become world-readable (published only; drafts stay admin-only) so the public FAQ/Knowledge Center + blog FAQ blocks + FAQPage schema render the same answers the admin AEO console manages. (2) Registers every published, non-synthetic blog post as a content item (kind='blog', idempotent by metadata slug) so the whole blog is listed + wired in /admin/marketing/content. Additive/idempotent. **PG16-verified** (public sees 754 published, drafts hidden; 545 blogs registered; re-run 0 dupes). |
| 0229 | `0229_seed_marketing_aeo_seo.sql` | Seed 754 themed AEO questions (published) + 191 SEO keywords + 19 SEO pages | **Marketing AEO/SEO seed (PLA-0790).** On-brand, deterministic (scripts/generate-marketing-seed.mjs) content positioning Bubaly as "The AI Family Operating System": AEO Q&A across 24 topics × personas × patterns, head/long-tail/semantic keyword clusters, and per-route SEO records for every public page + blog category tab. Idempotent (seed-tag delete + ON CONFLICT). Feeds the public FAQ/Knowledge Center + every blog article. **PG16-verified** (754/191/19; idempotent x2). Safe before apply: public pages just show fewer answers until applied. |
| 0230 | `0230_blog_per_post_aeo_and_seo_public_read.sql` | Per-post blog AEO (auto) + public read on `marketing_seo_pages` | **Marketing engine, part 2 (PLA-0795).** (1) Every published blog post gets its own AEO questions (source_path=/blog/<slug>), derived in-DB from title+excerpt (1,090 rows; idempotent seed tag blog_aeo_v1); the admin publish action generates the same for new posts. (2) `marketing_seo_pages` active rows become public-readable so 7 marketing routes drive title/description from the admin SEO store (code fallback). **PG16-verified** (bootstrap fail=0; 1090 per-post AEO; policy present). Historical inventory note: 0229 was regenerated to 2,344 AEO / 1,603 keywords. These are recorded development counts, not production targets or authorization to re-run that historic seed. |
| 0234 | `0234_blog_500_more_articles.sql` | +503 new blog articles (batch 2) + self-wire into content registry & per-post AEO | **Blog batch 2 (PLA-0810).** 503 brand-new, distinct-topic articles (0 slug overlap with batch 1; ON CONFLICT DO NOTHING never overwrites). Stores NO hero URL — renders the bespoke `<BlogCover>` (free, unique, on-brand), consistent with the LoremFlickr-removal (0231). Self-wires: re-runs the content-registry + per-post-AEO INSERT…SELECT (idempotent) so the new posts appear in /admin/marketing/content + the AEO Knowledge Center. Additive/idempotent. **PG16-verified** (bootstrap fail=0; 1,048 published / 1,048 registered / 2,096 per-post AEO). |
| 0235 | `0235_blog_batch2_hero_photos.sql` | Real free (CC0) Lorem Picsum hero photo for every image-less (batch-2) article | **Batch-2 hero photos (PLA-0820).** Sets each NULL-hero published post's image to `picsum.photos/seed/<slug>/1600/900` (real, CC0, always-resolves, one distinct URL per post) so batch-2 no longer renders the identical generated cover. Same CC0 source batch-1 uses as fallback. Idempotent (only fills NULL heroes). **PG16-verified** (1,048 published / 0 null-hero / 1,048 distinct URLs). Not topic-curated (image sources are network-blocked in the build env) — upgradeable to matched photos via the batch-1 pattern when image access / an API key is available. |
| 0236 | `0236_seed_blog_seo_registry.sql` | Register all 1,048 blog articles in the SEO Page Registry (marketing_seo_pages) | **SEO Page Registry buildout (PLA-0830).** One registry row per published blog post (path=/blog/<slug>) with SEO title, bounded meta description, score, index policy, and metadata (category/cluster, keyword cluster from hashtags, canonical, search_intent, BlogPosting type). Registry grows 19 → 1,067 pages. The article generateMetadata resolves through the registry (admin edits override the rendered page). Idempotent (ON CONFLICT (path) DO UPDATE). **PG16-verified** (1,067 pages / 1,048 blogs / all keyworded; public RLS read OK). |
| 0237 | `0237_marketing_platform_spine.sql` | Canonical marketing page registry, durable regeneration queue, embeddings, provider observations, and media provenance | **Marketing engine spine.** Versioned canonical pages, durable edit queue, provider-health observations, vector storage, public published-only route families, and service-role Super Admin control-center actions. Canonical marketing routes depend on the corresponding schema; confirm production readiness through the approved forward release evidence. |
| 0238 | `0238_blog_image_provenance.sql` | Blog hero-image license, attribution, source URL/hash, trigger validation, and unique-source indexes | **Blog asset integrity.** Enforces HTTPS source URLs, approved free-use licenses, attribution, and source-level uniqueness for public blog hero images. Historical tooling reference: `marketing:backfill:image-provenance`; this inventory does not authorize a production backfill. |
| 0272 | `0272_rsvp_is_first_person.sql` | Replaces `event_rsvps`'s single FOR ALL policy with four per-verb policies; writes require `is_self_member(member_id) or can_manage_family(family_id)` | **An RSVP is a statement about a person, and only the app was enforcing that.** `0047` shipped `event_rsvps` with one `FOR ALL` policy gated on `is_family_member(family_id)` and no member predicate on either side, so any member — teen, child, guest — could INSERT an `accepted` row carrying a **parent's** `member_id`, or UPDATE/DELETE a sibling's reply. `event_rsvps_once UNIQUE (event_id, member_id)` makes the write an upsert, so a second answer **replaced** the first silently. Nothing in the product does this (the event modal writes only `selfMemberId`; `rsvpToEvent` takes `member_id` from `scope.memberId`), so app behaviour is unchanged — this moves the rule into RLS where it cannot be forgotten. Adds the SECURITY DEFINER helper `public.is_self_member(uuid)` (search_path pinned). SELECT stays open to all members (seeing who is coming is the point). The manager branch is required, not laxity: `performApproved` runs under the approving parent's client while writing the asker's `member_id`, so a self-only rule would break the approval replay. Additive/idempotent (`drop policy if exists` → create). **Verified on real Postgres** (PGlite, migration applied verbatim, acting under `set role authenticated`): teen answers for themselves ALLOW; teen answers for the parent DENY (RLS error); child answers for a sibling DENY; child answers for themselves ALLOW; parent answers for the child ALLOW; teen overwrites or deletes the parent's reply DENY (0 rows — a failing USING clause filters rather than raises); parent corrects their own reply ALLOW; child sees who is coming ALLOW. A mutant restating the `0047` bug fails two of those cases. `notes`/`goals` share the same shape and are deliberately untouched (a product decision, recorded in the gap ledger). Guard `tests/rsvp-first-person-rls.test.ts` (9). Not applied to production. |
| 0273 | `0273_approval_requests_pending_once.sql` | `approval_requests.dedupe_key` + partial unique index on `(family_id, dedupe_key) where status='pending' and dedupe_key is not null` | **A resent chat message filed TWO pending approvals for one intent.** `openApprovalRequest` is an unguarded INSERT and nothing on the table stopped a second identical row, so a flaky connection mid-answer, a double-tapped send, a reloaded tab or Bubaly's own retry put two identical cards in a parent's inbox; approving both writes the resource twice. This is where a gated family's duplicate actually comes from — the tool ledger's idempotency reservation cannot help, because `executeTool` returns `pending_approval` at step 3, **before** the reservation at step 4. The application now computes `dedupe_key` over (domain, capability, asker, full payload) and returns the existing pending row instead of filing a second; the index makes that correct under a race (23505 → return the winner). Both partial predicates are load-bearing: `status='pending'` so a family can ask again for something already approved, and `dedupe_key is not null` so every pre-0273 row (and any caller supplying no key) keeps exactly today's behaviour instead of colliding with every other keyless row in the family. Additive/idempotent. **Verified on real Postgres** (288 migrations apply fail=0; resend refused by the index; re-ask after approval allowed; another family with the same key allowed; two keyless rows coexist; probe fails with the index dropped). Guards `tests/approval-pending-once.test.ts` (11) + probe `docs/audit/approval-dedupe-check.sql`, which runs on every PR. Not applied to production. |

Marketing coverage and image-provenance backfills can change production data.
Do not run historical backfills or seeds merely because the ledger is incomplete
or a local verification passed. Any necessary production reconciliation belongs
to a separately scoped, parent-owned procedure; the current release scope and
verification are defined in `docs/PRODUCTION_FORWARD_RELEASE.md` and
`.github/workflows/supabase-forward-release.yml`. Preview run `33987762363`
passed; production application of the atomic `0240-0254` release remains pending.

## Migrations added since this document's stated baseline (2026-09-12)

The status line at the top of this file is dated **2026-09-05** against main
`01881fb2`. **64** migration files have landed since, `0255` through
`0321`, and none of them appear anywhere above. (This read "thirty-one, `0255`
through `0285`" until 2026-09-13, "seventy-one, `0255` through `0295`" until
2026-09-15, and "forty-five, `0255` through `0302`", "46, `0255` through `0303`"
and "49, `0255` through `0306`" until 2026-09-16; the range
keeps growing past the sentence. The count is the number
of files in that range, which is what `ls supabase/migrations` reports — the
earlier "seventy-one" did not match its own stated range.)

### `0318`-`0321`, arriving from the audit branch — all unapplied

- **`0318_guardian_safety_config_is_manager_only.sql`** closes **AUTHZ-005**.
  `guardian_contacts` (per-contact trust levels) and `guardian_member_profiles`
  (per-band routing modes) carried `FOR ALL TO authenticated USING
  (is_family_member(family_id))` from `01370`, so the rule deciding who may
  change a **child's call screening** asked only whether the caller was in the
  household. `app/(app)/guardian/actions.ts` gates on `isManager` and says in its
  own header that RLS does not — a PATCH to `/rest/v1/guardian_contacts` never
  passes through it. Writes now require `can_manage_family()`; reads unchanged.
- **`0319_social_access_delete_matches_grant.sql`** closes **AUTHZ-003**.
  `0034` gated INSERT and UPDATE on `social_access_permissions` behind admin but
  left DELETE at bare membership, and removing an override restores the higher
  default — so a member pinned to `read_only` could lift their own restriction
  back to `marketing_manager`, which carries publish and manage-settings on the
  family's connected accounts.
- **`0320_audit_logs_says_who_wrote_it.sql`** pins `actor_id = auth.uid()` on the
  household trail, which previously pinned only `family_id`.
- **`0321_family_erasure_indexes.sql`** — **do NOT apply as-is**; see its own
  section above. It adds erasure-path indexes and must go through
  `docs/audit/family-erasure-indexes-concurrently.sql` in production, because a
  migration runs in a transaction and `create index concurrently` cannot.

These were numbered `0296`-`0301` on the audit branch and collided six ways with
main's own `0296`-`0301`; the merge renumbered the three that survived. **Three
were dropped rather than renumbered, because main had already fixed the same
subjects and in two cases went further:** `family_credentials` (main's `0296`
closes the READ half too, which closes **O-02**), sensitive tables including
`child_logins` (main's `0297`), and `invites` (main's `0298`). A fourth,
covering `allowance_rules`, was written during the merge and dropped the same
way — main's `0306` already had it, with *restrictive* policies, which is the
stronger mechanism.

Nothing here authorizes applying any of them; this section exists so the gap is
visible rather than inferred from the absence of a row.

### `0322`-`0328`, the write-boundary sweep — all unapplied

Seven more, from the class census that measured **170 tables** carrying a
role-blind permissive `FOR ALL` write policy. Every one repairs a table where
the **application** enforces a manager-only rule and the **database** does not —
and a server action is not a boundary against a JWT holder, because children
have real logins and a request to `/rest/v1/<table>` never passes through
`app/`.

- **`0322_wallet_side_tables_are_manager_written.sql`** closes **AUTHZ-007**.
  `0088` created fourteen wallet tables in one `DO` loop with the same
  role-blind policy; nine were narrowed one at a time since, and these five were
  never reached — `babysitter_profiles`, `babysitter_payments`, `gift_links`,
  `gift_payments`, `compliance_disclosures`. The one that costs a real person
  money is `gift_payments`: the approval queue lists `status = 'pending'`, so a
  child flipping a gift to `completed` makes a grandparent's gift **leave the
  queue uncredited and unannounced**. It mints nothing — `wallet_approve_gift`
  is `SECURITY DEFINER` and checks the manager predicate.
- **`0323_safety_records_are_manager_written.sql`** closes **AUTHZ-006**, and
  this is the one to read. `0318` closed `guardian_contacts` and **it holds**.
  But `guardian_suggestions` did not, and `guardian_review_suggestion` (0198) is
  `SECURITY DEFINER`, correctly checks `can_manage_family`, and on approval
  copies **the suggestion's own fields** into `guardian_contacts`. A child
  rewrites the pending proposal — including the `title` the parent reads — the
  parent approves in the product's own UI, and a `suspected_spam` caller becomes
  `immediate_family`. The child never wrote the forbidden table; they wrote the
  row telling a privileged function what to write there. Also covers
  `family_emergency_contacts` and `family_emergency_plans`.
- **`0324_pay_ids_and_savings_goals_are_manager_written.sql`** closes
  **AUTHZ-010** and **AUTHZ-009**. `pay_handles` is the one that reaches
  **outside the family**: `/pay/<handle>` resolves with `createServiceClient()`
  — RLS off, correctly, since a public payment page cannot carry the visitor's
  session — reads `child_wallet_id` and redirects to that wallet's newest gift
  link. A child repointing it sends a grandparent following a Pay ID to a
  different child's gift link. `wallet_goals` is AUTHZ-006's shape in the money
  domain: `wallet_fund_goal` reads the goal's own `child_wallet_id` to decide
  whose Save bucket to debit, so a child's goal aimed at a sibling's wallet
  drains it on a parent's click.
- **`0325_dashboard_and_twin_writes_match_the_app.sql`** covers
  `family_digital_twin_profiles` (what Bubaly "knows" about a person, read by
  the AI surfaces) and `family_dashboard_settings` (which holds the very flags
  `canCustomizeDashboard()` consults, so writing it turns the rule off).
  `dashboard_layouts` gets a **scope-shaped** rule, not a blanket one — a member
  legitimately writes their own `scope='user'` row; only the family default is
  manager-only.
  **One accepted cost, stated rather than hidden:** the autopilot scan's
  digital-twin trait writes will no-op for a non-manager-triggered scan. They
  are explicitly best-effort in the code and the nightly cron redoes them on the
  service client.
- **`0326_chore_dispute_resolution_is_a_managers_call.sql`** is a **`BEFORE`
  trigger, not a policy**, following `0222`/`0295` — because raising a dispute
  has no role gate at all and its rollback paths delete the row on the same
  client, so INSERT and DELETE must stay open. Only movement into `'resolved'`
  and writes to the four resolution columns are guarded, **including clearing
  them**, because the approval path's failure branch clears the same fields.
- **`0327_autopilot_suggestions_are_not_erasable.sql`** is deliberately
  **narrow, and the reason is a correction**. This table was recorded as a
  defect and is not one: the autopilot scan runs on the **caller's own
  RLS-bound client** behind a gate that is **plan-level, not role-level**, and
  fires automatically on page open for any member — so a manager-only guard
  would return 500 from `/dashboard/autopilot` for every child in a Plus family.
  It therefore closes only what the app never does: DELETE refused for every
  client role, and `resolved_by` pinned to `auth.uid()` so a child cannot record
  that a *parent* dismissed a suggestion. **Its header states that the
  policy-suggestion deputy chain remains open** — RLS cannot distinguish a
  child's `kind='policy'` row from the one the scan writes, same member, same
  client, same columns. That fix is an application decision, not a migration.
- **`0328_wallet_audit_logs_say_who_wrote_them.sql`** applies `0320`'s treatment
  to the wallet trail, which never got it: a child could insert a wallet audit
  row naming a **parent** as `actor_user_id`. No UPDATE/DELETE policy exists, so
  the existing trail could be polluted but not erased.

`SELECT` is untouched on every table in this set, and each read path was named
before anything was restricted — the wallet pages, the family-emergency page
(which shows the meeting point to every member on purpose), the Guardian page,
and the home dashboard, which reads **both** layout scopes for the whole family
in one query. Each migration has a probe under `docs/audit/` carrying a
**negative control** that drops only the new guard and requires the escalation
to succeed again; all were proved red before green.

**Read this next line against production, not against the repository.** These
seven are files. Until they are applied, the Pay ID redirect, the savings goal
that drains a sibling, and the Guardian suggestion are **live**. The same
applies to the audit's own notes: where `finalaudit.md` says a path is
"defeated by `0322`", that is true of this tree and not yet of production.

The same caution as the rest of this document applies without exception: a
missing ledger entry does not establish that the schema is absent, and a local
verification is not production evidence. Production's ledger records only
`0001-0003`.

### `0329`-`0333`, the census's second tranche — all unapplied

Five more from the same class census, one subject each, none of them renumbering
anything. All five were **measured on a replayed database before a line of SQL
was written**, and each carries a probe under `docs/audit/` with a negative
control that drops only the new guard and requires the escalation to work again.

- **`0329_automation_runs_pin_what_a_member_may_queue.sql`** closes
  **AUTHZ-012**. `0251` split `0022`'s `FOR ALL` on `family_automation_runs`
  because, in its own words, "any member could set `status='executed'` on a run
  they never approved" — and narrowed **UPDATE and DELETE**. `0252` and `0255`
  then pinned what a member's INSERT may claim, but both pinned the **§10
  `state` column**; the original `status text NOT NULL DEFAULT 'pending'` from
  `0022` — which still carries **no CHECK** — was never pinned, and neither were
  `trigger_type`, `metadata`, `summary`, `approved_by` or `approved_at`. A
  child's insert therefore landed in the parent's "Pending approvals" list
  carrying the child's own `summary`, and the "Do it" button stamped whichever
  `approval_requests` row that row's **own metadata** named. The repair pins
  **who may INSERT** rather than another column, because `status`'s default is
  itself a queue value — an insert naming no status at all still lands in the
  list. Every writer was enumerated first, by bare table name across `app/`,
  `lib/`, `components/`, `hooks/`, `mobile/` and `scripts/`: **no application
  path inserts on a member's RLS-bound client**, so plan acceptance by a teen or
  child is unaffected. The blocker `0251` recorded for exactly this tightening —
  *"until that app change lands"* — landed in `7a33b9cb`.
- **`0330_playbook_suggestions_cannot_smuggle_a_sensitive_fact.sql`** closes
  **AUTHZ-013**, and it is the **confused-deputy pattern for the third time**.
  `family_playbook_suggestions` carries `0126`'s role-blind `is_family_member`
  on all four verbs, written through a `format()` loop and never narrowed.
  `0264` bars a non-manager from writing a `'medical'` or `'account'`
  `family_facts` row; `confirmFact` is manager-gated and copies the
  **suggestion's own** category, label, value and evidence into that table, so
  the parent's session carries the child's fact past the rule. Measured both
  ways in one rolled-back transaction: the direct insert is **refused (42501)**,
  the identical fact through the side table **lands**.
- **`0331_ai_score_is_not_the_childs_to_write.sql`** closes **AUTHZ-014**.
  `chore_assignments.ai_score` was added by `00430` and has not appeared in a
  migration since; the table's BEFORE trigger guards the decision `status`
  (`0223`) and the two award amounts (`0305`) and nothing else, so a child could
  set the score in the same statement that legitimately moves their own
  assignment to `done`. `approveSubmissionAction` falls back to
  `assignment.ai_score`, and for an `ai_cash` chore that scales the payout —
  written in the **parent's** session, which is how it satisfies `0305`. The
  repair extends the trigger rather than adding a policy, for the reason `0326`
  gives: raising the submission is the designed child action, only the number is
  not theirs.
- **`0332_a_child_does_not_choose_the_number_bubaly_dials.sql`** closes
  **AUTHZ-015**, deliberately **before** the exposure becomes real.
  `concierge_calls` has `0173`'s role-blind policies on all four verbs; all four
  server actions gate on `isManager`, and `tests/concierge-calls-authz.test.ts`
  pins that gate as the first executable statement in each. It does not land
  today only because `app/api/concierge-calls/place/route.ts` has no voice
  provider and parks every due row as `action_needed`. The day one is
  integrated, this is a child choosing the number a parent's click dials.
- **`0333_a_request_says_who_actually_filed_it.sql`** closes **AUTHZ-016**, and
  is **stated smaller than the brief that found it**. `parent_approvals` is
  otherwise well pinned — `0251` leaves the decision to managers, `0252` forces
  the row to be born pending and undecided — but `requested_by` was never
  pinned, so a child could file a request signed with the parent's uid, a
  sibling's, or nobody's. **Nothing in the product SELECTs that column**, so no
  screen shows a parent the wrong name; what is defective is the stored record,
  which is the AUDIT-002 class. Filing stays open to every member on purpose.
  The guard is **restrictive rather than a restatement** of
  `parent_approvals_insert`, because that policy belongs to `0252` and two
  source-level ratchets read it — recreating it here would leave them describing
  a policy that is no longer live.

**Verified together, on a database built from nothing:** `docs/audit/pg-bootstrap.sh`
applied **346 migrations, 0 failed**, and `docs/audit/run-probes.sh` then passed
**58 of 58** boundary probes against it — the five new ones included. That is
evidence about this tree. It is **not** evidence about production, which still
records only `0001-0003`.

### `0335`, `0336`, `0338` — and the two numbers deliberately left empty

A census measured **247 tables** still taking a write from any household member
(`docs/audit/role-blind-write-census.sh`, which is re-runnable rather than
quoted) and triaged **41** as suspect because a file that writes them also
carries an `isManager` gate. Five were then verified one at a time, and the
outcome matters more than the count:

- **`0335_a_location_says_who_was_actually_there.sql`** (AUTHZ-018).
  `member_locations` and `location_events` carry `00420`'s single role-blind
  policy each, while `updateMyLocation`'s own header says *"Strictly self-only
  — a member can only post their own location"*. Measured as a child: taking a
  parent off the family map with one UPDATE, filing an `arrived` event in the
  parent's name at chosen coordinates, and deleting the whole household's live
  positions in one call (500 rows on the seed family). Sized as a **falsified
  and erasable safety display, not a privilege escalation**, and the gap is
  **self-only vs role-blind — NOT manager-only**: `0215` had already hardened
  `family_places` and its header says *"self-location (member_locations) …
  intentionally NOT changed"*, so a manager gate here would have contradicted a
  deliberate decision and broken every child's own location post.
- **`0336_only_a_manager_adds_edits_or_bins_an_asset.sql`** (AUTHZ-019).
  `home_assets` carries `0004`'s role-blind four. `components/modules/home-module.tsx`
  states a manager rule **three times** — the Add button, the per-asset delete
  button, and `warranty_until` rendered `disabled={!manager}` with Save hidden —
  and **there is no server action for asset create, update or delete at all**,
  so the client writes straight through RLS and all three gates are decoration
  against anyone not using the UI.
- **`0338_a_care_entry_names_who_actually_logged_it.sql`** (AUTHZ-017), and it
  is **sharper than `0333`**, which is why the two are worth reading together.
  Four household ledgers — `care_log`, `behavior_logs`, `screen_time_entries`,
  `medication_doses` — each carry one `FOR ALL … is_family_member` policy
  pinning no column, so `logged_by` was the writer's choice. Unlike
  `parent_approvals.requested_by`, **this one is rendered**:
  `care-module.tsx:253` draws `by {memberName(e.logged_by)}` under every entry,
  and a child's entry of type `medication` reading *"Gave Grandma her tablets"*
  came back as **`by Dad`**. All four stay open to every member — logging is
  what the product is for — and only the name is pinned. NULL stays accepted on
  `care_log` because the module writes `selfMember?.id ?? null` and the renderer
  shows no name for a NULL rather than the wrong one.

**`0334` and `0337` are permanently unused, on purpose.** `wallet_cards` and
`family_decisions` were on the triage list and are **not defects**:
`addCardAction` carries no role gate at all, so the application never claimed
the rule the census inferred, and `family_decisions` has exactly one writer, a
client module with no manager rule anywhere. A gap in the numbering says *this
was looked at and refused*; a renumber would have said nothing. CENSUS-002 is
what happens when a name on a triage list is taken for a verdict.

**The boundary-proof suite is now re-runnable, and was not before.** 36 of the
60 probes committed everything they seeded, two of them under the same fixed
family id, so a **second** run of `run-probes.sh` against one database failed
with `child_logins_member_id_fkey` — a foreign-key error wearing the costume of
a broken boundary. CI never saw it because the Database job bootstraps a fresh
container every time. Fixed by de-duplicating the committing probes' ids and
wrapping the two whose seeds were not idempotent against themselves, and pinned
by `tests/boundary-probes-are-rerunnable.test.ts`. Proved from nothing: a fresh
bootstrap of **349 migrations, 0 failed**, then **61 of 61 probes, three runs in
a row**.

### Three of them gate features that are already merged and live in the app

These shipped today (PRs #513 and #515) and their UI is deployed. Until the
tables exist, each page renders but does nothing — which is the honest failure
mode, not a silent one, because every read fails closed and says so.

| Migration | What it creates | What stays inert without it |
|---|---|---|
| `0282_marketing_recurring_ads.sql` | `marketing_recurring_ads`, `marketing_recurring_ad_runs`; widens `marketing_social_posts.platform` from six platforms to the nine `lib/social/capabilities.ts` declares | Super Admin → Marketing → Social → Recurring, and the `/api/cron/marketing-social` run loop (it queries a table that is not there and returns a 500 the cron dispatcher logs) |
| `0283_assistant_links.sql` | `assistant_links`, `assistant_link_events`; a column-level GRANT that withholds `token_hash` from `authenticated` | `/dashboard/assistants`, and both `/api/assistant` and `/api/assistant/alexa` — every request answers 401 because no token can resolve |
| `0284_library_books_podcasts.sql` | `library_feeds`, `library_items`, `library_progress` | `/dashboard/library` — subscribing, streaming, saved items and per-person progress |

Two details in these three are worth a reviewer's eye before they are applied,
because both are unusual for this repository and neither is exercised by the
CI migration replay in the way production would exercise it:

- **`0283` uses a column-level GRANT**, not just RLS: `revoke select ... from
  authenticated, anon` followed by `grant select (<named columns>)`. RLS is
  row-level and cannot withhold a column, and `token_hash` must never be
  readable by a family member even though it is a hash. Confirm PostgREST
  behaves as expected against the live schema — a client selecting `*` on a
  table with a partial column grant is the case to check.
- **`0284`'s uniqueness index is expression-based**:
  `(family_id, coalesce(feed_id::text, 'manual'), guid)`, so that hand-added
  books (which have no `feed_id`) do not all collide on NULL. The feed refresh
  upserts against it by name. ~~worth confirming on the live schema~~ —
  **confirmed broken, and fixed by `0285`.** Postgres cannot infer an
  `ON CONFLICT` column list from an expression index, so every feed ingest
  failed with `42P10` at planning time. `0285` adds a stored generated column
  and moves the index onto it; apply `0285` with `0284` (see below).

### `0295` closes the last of three self-approval forgeries — unapplied

Authored 2026-09-13 during the Pass A audit (finding **F21**) and **not
applied**: applying it needs the same credentialed operator as the two steps at
the top of this document, in the same order.

`reward_redemptions` shipped in `0028` with a single policy —
`FOR ALL … USING is_family_member(family_id) WITH CHECK is_family_member(family_id)`
— and no trigger. Both of its write paths are **direct browser writes** that
choose `status` and `decided_by` client-side:

| Path | Write |
|---|---|
| `components/modules/chores-module.tsx` → `redeem()` | insert, `status` = 'approved' when the client believes the member is a manager |
| `components/modules/rewards-module.tsx` → `requestReward()` | insert, same choice |
| `components/modules/rewards-module.tsx` → `decide()` | update, `status` straight from the caller |

The choice was the client's. A child calling PostgREST directly could insert a
redemption already marked `approved` with `decided_by` pointing at themselves,
or update one sitting in the queue — self-granting a reward no parent agreed to.

This is the **third** of three decision surfaces in the chores and rewards
economy. `0222` closed the submission forge and `0223` the assignment-status
forge; this is their sibling and the only one still open. Like them it **mints
no money** — the points economy is separate from the wallet, which is
manager-only under `0217` — so it is an accountability forgery rather than a
financial one.

Guarded: `approved`, `rejected`, `fulfilled`. Left to the member: `requested`
and `pending` (asking) and `cancelled` (withdrawing your own ask, which needs no
parent). No legitimate flow breaks: the only code that sets a guarded status is
a manager's own click in the two modules above, and the service role.

**Proven before it was written down.** `docs/audit/reward-redemption-decision-check.sql`
runs as a real `authenticated` session under RLS and asserts both directions —
child insert-as-approved, approve-from-queue and mark-fulfilled all blocked;
child request and cancel allowed; parent approve and fulfil allowed. It was run
against a local PG16 with the trigger present (passes) and absent (fails on the
first case). CI replays it against the fully bootstrapped schema on every pull
request, because `run-probes.sh` globs rather than lists.

Until it is applied, the forgery is live in production.

### `0285` repairs five upserts that could never have run

Reproduced by replaying all 300 migrations into a Postgres 16 and issuing the
exact statement PostgREST emits: all five raised `42P10`, and a control upsert
against a plain index succeeded.

| Table | The `ON CONFLICT` target | Why no index could satisfy it | What was broken |
|---|---|---|---|
| `calendar_events` | `(feed_id, external_uid)` | `uniq_calendar_events_feed_uid` is **partial** | every ICS / Google feed sync |
| `marketing_automation_runs` | `(workflow_id, subject_key)` | `uniq_mkt_runs_workflow_subject` is **partial** | automation run de-duplication |
| `family_inbox_messages` | `(channel, provider_ref)` | `uq_inbox_provider_ref` is **partial** | contact-centre inbox de-duplication |
| `library_items` | `(family_id, feed_id, guid)` | `uq_library_item_guid` is an **expression** index | every podcast feed ingest |
| `subscriptions` | `(family_id)` | there was **no unique index on `family_id` at all** | every `customer.subscription.*` Stripe webhook |

A partial unique index is inferable only when the statement repeats the index
predicate, and PostgREST has no syntax to emit one — so a bare column list can
never target it. For the first three the predicate was redundant anyway (a
default unique index already treats NULLs as distinct), so `0285` replaces each
with an equivalent total index: **the set of rows that conflict does not
change**. Verified in replay — feed events still collapse to one row, manual
events with a NULL `feed_id` still stay independent.

**This is the second time.** `0195` (above) fixed exactly this failure on
`dashboard_layouts` and its row already spells the rule out. The knowledge was
in this document and enforced nowhere, so it recurred five times. It is now a
check: `scripts/check-conflict-targets.mjs` runs against the real catalog in the
CI Database job, after the replay, and `scripts/audit-supabase-queries.mjs`
reports the same finding from the migration files on every pull request.

Two notes for whoever applies it:

- **`subscriptions` is attempted, not forced.** One row per family is an
  invariant the app already relies on (`use-billing-subscription.ts` reads it
  with `.maybeSingle()`, which errors on a second row), but a migration must not
  delete rows from a billing table to make an index fit. If any family holds two
  subscription rows the index is skipped and the migration raises a **warning**
  naming the count — watch for it in the apply output. The application does not
  depend on the index either way: the webhook now updates-then-inserts.
- **`library_items` gains a column.** `feed_key text generated always as
  (coalesce(feed_id::text, 'manual')) stored`. It is derived, never written by
  the app, and PostgREST will not accept a value for it. Apply `0285` together
  with `0284`, since the app now names `feed_key` as its conflict target.

### The remaining twenty-seven

`0255`-`0281` are listed here by number only, deliberately: this document's
existing rows carry verification evidence, and writing rows without it would
make the inventory look more complete than it is.

```
0255 0256 0257 0258 0259 0260 0261 0262 0263 0264 0265 0266 0267 0268 0269
0270 0271 0272 0273 0274 0275 0276 0277 0278 0279 0280 0281
```

`0272`, `0273` and `0275` already have full entries in the historical inventory
above. The others do not, and the honest summary is that this document stopped
being a complete picture at `0254`.


### `0300` takes the paywall out of the browser — unapplied

Authored 2026-09-15. **Not applied**, and it needs the same credentialed
operator as every step above, in the same order.

`lib/server/entitlement.ts` decides what a family may use from three facts: the
maximum plan across `active`/`trialing` rows in `subscriptions`, and
`families.trial_ends_at` and `families.closed_at`. All three were writable from
the browser with the public anon key.

`subs_manage` was `FOR ALL … USING is_family_admin(family_id) WITH CHECK
is_family_admin(family_id)`, and Supabase grants every table in `public` to
`authenticated`, so the policy was the only thing in the way and it agreed.
`handle_new_family()` seeds each new family with a `free`/`trialing` row, so the
row to edit is already there:

| Statement, as an ordinary signed-in parent | Result |
|---|---|
| `update subscriptions set plan='plus_annual', status='active' where family_id=…` | 1 row — `planLevel` 2, `effectiveLevel` 2, `locked` false |
| `update families set trial_ends_at=null where id=…` | 1 row — NULL is the GRANDFATHERED case, never locked |
| `insert into families (name, created_by, trial_ends_at) values (…, null)` | created grandfathered; the column carried a 5-day default, not a refusal |
| `update families set closed_at=null where id=…` | 1 row |
| `update billing_customers set customer_ref='cus_…' where family_id=…` | 1 row — and `/api/billing/portal` hands that value to Stripe |

Family+ in full, for nothing, without Stripe being contacted. None of it needs a
server action, so nothing in `app/api/billing/*` could have stopped it:
PostgREST is a first-class client and RLS is the only boundary it answers to.

`0300` drops both `FOR ALL` policies, revokes client DML on `subscriptions` and
`billing_customers`, and narrows the `families` grant to the columns the product
actually writes — `name`, `address`, `timezone`, `cover_url`, `avatar_url`. A
table-level grant cannot be narrowed by revoking one column, so the grant is
dropped and re-issued. Reads are untouched: `subs_select` and `billing_select`
stay, so the billing page still shows the plan.

No legitimate write is lost. Every write to `subscriptions` in the product
already used `createServiceClient()`; `billing_customers` had two upserts on the
user-scoped client and the same commit moves them to the service client, in
routes that already resolve the family from `requireUserContext()` and take the
customer id from Stripe's own response. Closing and reopening an account stay a
parent's decision through `app/(app)/account/actions.ts`, which already uses the
service client.

**Measured, not argued.** `docs/audit/entitlement-write-boundary-check.sql` runs
as a real `authenticated` session under RLS. Five of its assertions fail against
the previous schema, naming each statement above; all pass after `0300`; and it
asserts the other direction too — a parent can still rename their family and
still read their own plan, so a revoke that broke the product would not read as
a pass. Each attempt is judged on the row count as well as the refusal, because
an UPDATE that RLS filters to no visible row changes nothing and raises nothing.
CI replays it against the fully bootstrapped schema on every pull request.

Until it is applied, a signed-in parent can give their own family Family+ for
nothing, in one request, in production.


### `0301` decides who may address and rewrite a notification — unapplied

Authored 2026-09-15. **Not applied**, same credentialed operator as everything
above, same order.

`notifications` is not an in-app list. The cron reads it with the service role
and turns each row into an email from Bubaly's own sender
(`lib/server/notification-emails.ts`) and a device push (`lib/server/push.ts`).
Its write policies were written for a list.

`notif_insert` checked only `is_family_member(family_id)`; `user_id` was a plain
FK to `auth.users` with no family constraint. The email cron selects on
`sent_at is null`, `user_id is not null` and `send_at <= now()` — **no family
filter** — so the `family_id` a row claims never reaches the delivery decision.
Measured as a CHILD of one family, with a control proving a non-member is
refused the same statement:

| Statement | Result |
|---|---|
| `insert into notifications (family_id, user_id, …) values (<my family>, <a user in ANOTHER family>, …)` | 1 row, matching the cron's selection exactly |
| `update notifications set title='Rent is CANCELLED this month', body='— Bubaly' where user_id is null` | 1 row — any member rewrites a notice the product generated |
| `update notifications set sent_at=null, pushed_at=null where user_id=<me>` | 1 row — the stamps are the only thing making delivery once-only |

`notif_update` had a `USING` clause and no `WITH CHECK`, so Postgres reused
`USING` as the new-row test, and its second branch is the family-wide row.

`0301` pins the recipient — `user_id` must be NULL or an **active member of the
row's own family**, which is exactly what `resolveRecipients` already builds —
and narrows the table's UPDATE grant to `is_read`, the only column the browser
writes (`components/modules/notifications-module.tsx`). `sent_at` and
`pushed_at` are stamped by the cron under the service role. Both rewrite and
re-delivery close together, without touching who may mark a notice read.

**Not closed, and stated rather than implied.** A member can still file a
notification with an arbitrary title and body for someone in their **own**
family, which the cron will email from Bubaly's sender. That cannot be decided
at the RLS layer: the legitimate paths look identical — the AI notify tool, the
trip-disruption report and the geofence alert all insert member-authored text
through the caller's own session. Closing it means routing every `notify()`
write through the service client, which touches the AI run executor, and that is
a change to make deliberately rather than as a rider.

**Measured, not argued.** `docs/audit/notification-authorship-check.sql` runs as
a real `authenticated` child session under RLS. Its three attack assertions fail
against the previous schema, naming each statement; all pass after `0301`; and
it asserts the other direction too — marking read, addressing an in-family
recipient, and filing the family-wide row all still work, so a revoke that broke
the product would not read as a pass. CI replays it on every pull request.


### `0302` keeps one live system policy per family, per name — unapplied

Authored 2026-09-15. **Not applied**, same credentialed operator as everything
above, same order.

`trust_policies` had exactly one unique index: the primary key on `id`.
`setConciergeAutopilotAction` is a check-then-insert over
`(family_id, name='Concierge autopilot')`, and it did not destructure the read
error. That is what made this self-worsening rather than merely racy. Measured
on a replayed database:

| Step | Result |
|---|---|
| insert two rows, same name, effects `allow` and `deny`, both priority 10 | accepted — no constraint objects |
| the single-row read the action performs | matches 2 rows, which PostgREST rejects |

With the error discarded, `existing?.id` is undefined and the action takes its
INSERT branch — adding a **third** row. Every later change to the dial adds
another. `components/concierge/autopilot-panel.tsx` read the same row the same
way, checked only the run feed's error, and rendered `dialLevel(undefined)`:
the default. A parent's control over whether Bubaly executes accepted plans on
its own silently stopped taking effect and stopped reporting its own state.

**What is not claimed.** Which duplicate governs is undefined by contract —
`lib/trust/engine.ts` sorts by `priority` alone and `loadTrustInputs` issued no
`ORDER BY` — but the order was **not observed to flip** in this harness (an
index scan served both reads), so no such claim is made. The ordering is fixed
anyway, because which policy governs should not depend on a query plan.

`0302` adds a partial unique index on `(family_id, name) where is_system and
enabled`, scoped to `is_system` so a family's own hand-written policies may
still share a name across domains. The repair **disables** superseded rows
rather than deleting them: `loadTrustInputs` filters `enabled = true`, so a
disabled row leaves the engine at once, and no household loses a row to make an
index fit. The survivor in each group is the most recently updated — the
parent's latest intent. A replay disables nothing.

The action now checks its read error and treats a racing `23505` as "someone
else created it, apply my level over it". The panel's read is narrowed to the
one live row the index permits, which is what stops the wrong level rendering;
its error is logged rather than swallowed, and it still falls back to the
default rather than saying "unknown", because saying so needs copy in eleven
languages and inventing those is worse than the gap it closes.

**Measured, not argued.** `docs/audit/system-policy-uniqueness-check.sql`
asserts the refusal, that a superseded row can still be kept alongside the live
one, that the engine sees exactly one, that the index does **not** reach a
family's own policies, and that the repair keeps the latest intent. Its first
assertion fails against the previous schema, naming the count. CI replays it on
every pull request.


### `0303` closes the document vault's second half — unapplied

`0266` closed the vault in two places. The ROW half works: a child cannot see a
sensitive document, so they cannot learn its `storage_path`. The BYTES half was
meant to hold the line anyway — its own comment says "a path learned before
today (or guessed) still does not open the file" — and it did not.

All three of its `storage.objects` policies guard with
`not exists (select 1 from public.documents d where d.storage_path = ...)`.
A policy expression is evaluated as the CALLING user, so that read of
`public.documents` is itself subject to `documents_select`, the very policy that
hides sensitive rows from a child. The child cannot see the row, the subquery
finds nothing, `not exists` is TRUE, and the guard admits exactly the object it
exists to refuse. The two halves are the same predicate pointed in opposite
directions: the stricter the row half gets, the wider this opens.

**Measured, not argued.** `docs/audit/document-bytes-boundary-check.sql` runs
against a replayed database with every migration applied, acting as a child of
the family, and judges on ROW COUNTS rather than on whether an error was raised
— an UPDATE or DELETE matching no visible row changes nothing and raises
nothing, so an exception-only assertion would pass while the bytes walked out.
Both controls pass first: the child cannot see the document row, and CAN see an
ordinary object, so the bucket is not simply shut. Against the current
production schema the child then **read**, **renamed** and **deleted** the
storage object for a sensitive document — one row each time. A family's passport
scan, downloadable and destroyable by someone who was never allowed to know it
existed.

`0303` asks the question with the row visible: a SECURITY DEFINER
`public.document_object_is_restricted(text)` reads `public.documents` as its
owner, so the lookup no longer depends on the caller being allowed to see what
it is looking up. It still answers about the CALLER — `can_manage_family`
resolves `auth.uid()` inside, which SECURITY DEFINER does not change — and it
returns a boolean and nothing else, so it cannot become a way to read the vault
it protects. The UPDATE policy gains the explicit `with check` its row-level
sibling already documents.

Until this is applied, production carries the breach as measured above.

### `0304` guards the fourth and fifth decision surfaces — unapplied

`0295` closed `reward_redemptions` and called itself "the last of the three
decision surfaces to be guarded" (after `0222`'s chore submissions and `0223`'s
chore assignments). It was not the last. Two tables carry the same shape — a
`status` defaulting to pending, a `decided_by`, a `decided_at`, and an INSERT
policy open to any family member — and neither was guarded:

    public.economy_redemptions   insert policy: is_family_member(family_id)
    public.invest_orders         insert policy: is_family_member(family_id)

Their siblings constrain the same insert to the undecided state
(`parent_approvals_insert` requires `status = 'pending'` and `decided_by is
null`; `approval_requests_insert` likewise). These two constrain nothing.

**Measured, not argued.** `docs/audit/economy-invest-decision-check.sql` runs
on a replayed database with every migration applied, acting as a child of the
family, and judges on row counts as well as refusals — an insert blocked by
nothing simply lands, and an exception-only assertion would report a boundary
that is not there. It asserts membership and non-management before measuring,
so a probe acting as a stranger cannot pass vacuously. Against the current
production schema the child inserted **an approved `economy_redemptions` row**
and **a filled `invest_orders` row**, one each, with `decided_by` naming a
parent who never saw them.

What it costs differs between the two, and the difference is worth stating:

* `economy_redemptions` — the debit lives in `economy_decide_redemption`, whose
  own comment is "Approval debits the ledger". A row inserted already-approved
  never goes through it, so the reward is recorded as granted and the tokens
  are never taken. The points economy is separate from the wallet (`0217` keeps
  that manager-only), so no money is minted — but a reward is taken for free.
* `invest_orders` — `invest_decide_order` is what moves the wallet and writes
  the holding, so a forged `filled` creates neither. It is an accountability
  forgery rather than a transfer.

In BOTH cases the forgery cannot be corrected through the product: each RPC
begins by refusing a row it did not find pending (`if v_redemption.status <>
'pending' then return 'already_decided'`, and the same line in
`invest_decide_order`), so a parent who notices can neither approve nor reject
it. The row is stuck in the state the child chose.

`0304` mirrors `0295` exactly — the trusted server and family managers pass, a
plain member setting a decision status is refused with `42501` — as a shared
`public.decision_status_guard()` taking its guarded statuses as a trigger
argument, so the three tables share one implementation. Asking (`requested`,
`pending`) stays open, which the probe asserts as a positive control alongside
a manager still being able to decide.

Until this is applied, production carries both forgeries as measured above.

### `0305` prices a chore the way it decides one — unapplied

`0223` guards the chore-assignment STATUS: a child cannot move their own
assignment into `approved` or `rejected`, and that holds. It says nothing about
the two columns that record what the approval was WORTH:

    chore_assignments.points_awarded
    chore_assignments.cash_awarded_cents

A child may legitimately tick their own chore `done` — a chore needing no
approval is theirs to close — and `done` is not a guarded status, so both
amounts could be written in that same statement.

**Measured, not argued.** `docs/audit/chore-award-amount-check.sql`, acting as
a child on a replayed database with every migration applied, with the positive
control passing first (ticking the chore `done` still works):

    update … set points_awarded = 9999                        -> 1 row
    update … set cash_awarded_cents = 500000                  -> 1 row
    update … set status='done', both amounts                  -> 1 row
    insert … carrying its own amounts                         -> 1 row
    displayed points total afterwards                         -> 19,998

The two columns differ in what they reach, and the difference is the point:

* `points_awarded` — the SPENDABLE balance counts only `approved` rows
  (`lib/rewards/points.ts` skips anything else) and a real approval overwrites
  the column server-side, so this mints nothing spendable. It inflates every
  DISPLAY that counts `done`: the kids page, the per-member standings in
  `lib/chores/dashboard.ts`, the 30-day figure on the profile, and the chore
  numbers fed to a model in `lib/ai/insights.ts`.
* `cash_awarded_cents` — read by a PAYOUT. `payChoreRewardAction` credits a
  child's wallet with `assignment.cash_awarded_cents ?? chore.cash_cents`. That
  action is manager-gated and idempotent per assignment, and the chores board
  hides its Pay button while the column is truthy
  (`canPay = … && !a.cash_awarded_cents`), so the ordinary click path does not
  currently pay a forged amount. **That is an accident of a condition written
  for idempotency, not a boundary.** A number a child wrote is trusted by a
  money path, and a server action is directly invocable; the day that display
  rule changes, the mitigation is gone.

`0305` extends `0223`'s own trigger in place rather than adding a second one, so
there is one guard on this table and one place to read what it allows: the
trusted server and family managers may set the amounts, a plain member may not.
Ticking a chore `done` without touching them passes exactly as before, which the
probe asserts as a positive control alongside a manager still being able to
approve and award.

Until this is applied, production carries the forgery as measured above.

### `0306` guards two money instructions the sweeps' lists missed — unapplied

`0254` added restrictive manager guards to the money tables and `0275` swept
the stray permissive policies off them "by shape rather than by name", because
"the previous three attempts each fixed the instance and left the class open".
Both enumerate the tables they cover, and a hardcoded list is the very thing
`0275`'s header warns about. Two tables that move real money are not on it.

**`allowance_rules`** has one policy — `Members manage allowance_rules FOR ALL …
is_family_member` — no role check, no restrictive guard. The nightly cron reads
it and calls `creditChildWallet(…, amountCents: rule.amount_cents)`. The row is
not a record of a payment; it is the reason one happens, on a schedule, with
nobody in the loop.

Measured, acting as a child with both controls passing: the child **created an
allowance rule of 100,000 cents a week pointing at their own wallet**, and
**raised an existing one**. The next cron run pays it. Nothing legitimate
breaks — both writers in the product (`saveAllowanceRuleAction`,
`toggleAllowanceRuleAction`) already refuse a non-manager in application code;
this only makes the database agree with the rule the application states, which
is what matters for anyone calling PostgREST directly.

**`invest_orders`** — `invest_decide_order` debits the wallet with the order's
stored `amount_cents` and credits its stored `shares`, checking neither against
the other nor against the asset. Measured: the child **priced their own order
below the asset** and **bought 1,000 shares for one cent**.

The invest guard is CONSISTENCY, not authorship, because authorship is not the
problem: `placeInvestOrderAction` legitimately inserts as the child and already
derives both numbers server-side (`price_cents: asset.price_cents`,
`amount = orderAmountCents(shares, asset.price_cents)`). Requiring the stored
economics to match the asset refuses the forged insert and lets the real one
through — asserted as a positive control, alongside a manager still being able
to set an allowance.

Until this is applied, production carries both as measured above.

### `0307` guards the chore's own price, which `0305` did not reach — unapplied

`0305` closed `chore_assignments.cash_awarded_cents`, the override a manager
writes at approval. The payout reads that column with a fallback:

```
app/(app)/wallet/actions.ts:206
  const amount = assignment.cash_awarded_cents ?? chore?.cash_cents ?? 0;
```

An ordinary chore carries no override, so the number a parent's Pay click
credits is `chores.cash_cents` — and `chores` has four permissive policies whose
entire condition is `is_family_member(family_id)`.

This is worse than the column `0305` fixed, not the same. There, the chores
board's `canPay = … && !a.cash_awarded_cents` happened to hide the Pay button
once the column was set, so the ordinary click path did not pay a forged amount.
Here the button's condition is
`manager && done && (a.chore?.cash_cents ?? 0) > 0 && !a.cash_awarded_cents`
(`components/modules/chores-module.tsx:554`) — exactly the state a child can
manufacture: create the chore, price it, assign it to yourself, tick it done.
The parent is then shown "Pay $5,000.00" on a chore their child wrote and
priced. No accident stands in the way this time; this is the happy path.

Measured, acting as a child with both positive controls passing: the child
**created a chore paying 500,000 cents**, **raised a manager's chore from 500 to
500,000**, set its cash range, and **re-priced it in points**. Five breaches,
`docs/audit/chore-price-check.sql`.

Cash is manager-only to set or change; points are guarded on CHANGE only, so a
member may still create a chore carrying points — that is the assistant path
(`lib/services/tasks/index.ts` inserts `points: input.points ?? 10` through the
calling user's client), and a guard on INSERT would have closed a working
feature rather than a hole. Points reach a balance only through an approval a
manager makes with the number in front of them, and `0305` already owns
`points_awarded`.

Shipped alongside it, and live independently of the ledger: `createChoreAction`
— whose own comment reads "Parent creates a chore" — carried no manager check,
unlike the two actions beside it in the same file. It now refuses a submission
that carries pricing from a non-manager.

Until this is applied, production carries the forgery as measured above.

### `0308` puts the reward catalogue back in a manager's hands — unapplied

`rewards` is written **straight from the browser**:
`components/modules/rewards-module.tsx` calls
`sb.from('rewards').insert/update/delete` with the viewer's own JWT, with no
server action in between. The only thing standing between a child and the
family's reward catalogue is `canManage = isManager(role)` deciding whether a
button renders (lines 146, 233, 251). A hidden button is not a boundary; the
table's policies are `is_family_member(family_id)` and nothing else.

Measured, acting as a child with the positive control passing: the child
**re-priced "New bike" from 5000 points to 5**, **added a reward costing
nothing**, **deleted a reward the parent had set up**, and **requested a
5000-point reward for 1 point**. Five breaches,
`docs/audit/reward-catalogue-price-check.sql`.

`requestRedemptionAction` copies `rewards.cost_points` into the redemption
server-side, so re-pricing the shelf re-prices the ticket a parent is asked to
approve — the queue shows a 5-point request for the bike. Restrictive manager
guards close that.

The second half is `reward_redemptions.cost_points`. That table has one policy
(`Members can manage … FOR ALL … is_family_member`) and `0295`'s trigger guards
the **decision** on it, not the amount — so a direct insert could name its own
price without touching the shelf at all, exactly as `invest_orders` could before
`0306`. As there, the guard is consistency rather than authorship: a child
legitimately requests a reward and the action already derives the cost
server-side, so requiring the ticket to carry the shelf's price refuses the
forged insert and leaves the real one untouched. A manager-only rule there would
stop a child asking for a reward at all.

`lib/rewards/points.ts` deducts `cost_points` at `approved` and `fulfilled`, so
both numbers are the spendable balance the whole chores economy settles in — the
ledger `0222`, `0223`, `0295` and `0305` exist to keep honest.

Until this is applied, production carries all five as measured above.

### `0309` puts the prescription back in a manager's hands — unapplied

`components/modules/medications-module.tsx` declares `canEdit = isManager(role)`
and then writes `medications` and `medication_schedules` **straight from the
browser** with the viewer's own JWT (lines 205, 216, 223, 236, 251). There is no
server action in between; `canEdit` only decides whether a button renders (284,
368, 399, 419).

Its neighbours in the same area *are* enforced — `medical_profiles`,
`health_providers` and `insurance_policies` each carry three manager-checked
write policies. The three medication tables carry none.

What these columns reach is not a display. `lib/server/notifications.ts` reads
`medications.{name,dosage,member_id,is_active}` and
`medication_schedules.{time_of_day,days_of_week,starts_on,ends_on}` to raise the
family's "dose due today" reminder, so these rows decide **what a parent is told
to administer and when** — and `is_active = false` drops the medication from
that read entirely, so nobody is told at all.
`app/api/ai/health/coach/route.ts` feeds `dosage` and `instructions` to a model
as fact.

Measured, acting as a child with both controls passing: the child **changed
their own prescribed dosage from 10 mg to 40 mg**, **rewrote the instructions**,
**deactivated the medication so the reminder stops**, **moved the dosing
schedule to 23:59 one day a week**, and **deleted a schedule and a medication
outright**. Eight breaches,
`docs/audit/medication-record-boundary-check.sql`.

`medication_doses` — the "I took it" tick — is deliberately left writable by any
member, and the probe asserts that as a positive control: the module leaves dose
logging ungated for everyone (lines 166-172), exactly as a child may tick their
own chore done.

Until this is applied, production carries all six as measured above.

### `0310` enforces four more UI-only manager gates — unapplied

`0308` and `0309` each closed one instance of a shape found by sweeping every
`'use client'` component that writes a table and cross-checking the table's
policies against the gate the component claims. This closes the rest of that
set. Each module declares `canEdit = isManager(role)` and then writes its table
**straight from the browser** with the viewer's own JWT:

| module | table | where the gate is |
| --- | --- | --- |
| `rides-module.tsx` | `rides` | add/edit/delete/mark-completed, all inside `canEdit` (247) |
| `renewals-module.tsx` | `renewals` | add/edit/delete/mark-renewed (210) |
| `signups-module.tsx` | `opportunities` | add/edit/delete/mark-registered (235) |
| `trips-module.tsx` | `trips` | add/edit/delete (223) |
| | `trip_items` | add (255), remove (277) |

None carried a manager-checked or restrictive write policy. Measured, acting as
a child with both controls passing: the child **rescheduled and cancelled a
ride**, **deleted a renewal reminder**, **registered the family for a signup**,
**changed the family trip's destination and dates**, and **rewrote, added and
deleted trip items**. Nine breaches,
`docs/audit/ui-only-manager-gate-check.sql`.

These reach no money, payout, prescription or credential — which is why they are
one migration behind `0307`-`0309` rather than folded in with them. What they
reach is a family coordinating: a cancelled ride nobody drives to, a renewal
reminder that never fires again.

**`trip_items` is not a straight manager table.** Its done-tick, `toggleItem` at
line 267, sits *outside* `canEdit`: any member may check a packing item off, and
a blanket guard would have closed that. So INSERT and DELETE are manager-only and
UPDATE is guarded **by column** — `is_done` is anyone's, the item's content is a
manager's. The probe asserts the tick as a positive control for exactly this
reason.

Nothing legitimate breaks: the modules already refuse a non-manager everything
guarded here, so this only makes the database agree with the rule the application
states — which is what matters for anyone calling PostgREST directly.

Until this is applied, production carries all nine as measured above.

### `0311` keeps a row's references inside its own family — unapplied

Every family-scoped INSERT policy in this schema checks the row's **own**
`family_id` and nothing else, and the foreign keys beside them name `parent(id)`
alone, because that is the parent's primary key. So a member may write a row
carrying *their* `family_id` and a reference into *somebody else's* family, and
both the policy and the constraint are satisfied.

The repo already knows the class — `lib/services/tasks/index.ts` guards one
instance by hand:

> "Confirm the chore belongs to this family before writing an assignment that
> would otherwise carry a foreign family's chore_id under our family_id."

Application code is not a boundary for anyone calling PostgREST. Measured,
acting as a manager of family A who is not a member of family B, all three
landed: a chore assignment under A **pointing at B's chore**, one **assigned to
B's member**, and an allowance rule under A **pointing at B's child wallet**.
Five breaches counting the re-point and the integrity check,
`docs/audit/cross-family-reference-check.sql`.

**Reads were never the hole**, and the probe asserts that in both directions: A
still cannot `SELECT` B's chore, with or without the guard. What this reaches is
the code that *acts* on the reference.

#### The half that is live on merge

The nightly cron credits `rule.child_wallet_id`. `creditChildWallet` resolves
buckets by `(family_id, child_wallet_id)`, so a foreign wallet matches none and
the credit fails "not fully provisioned" — it does **not** pay another family.
The damage was what the route did with that failure:

```ts
if (!res.ok) { …rollback…; throw new Error(`Allowance credit failed: ${res.error}`); }
```

The outer catch turned that into a 500. Because the rollback restores
`next_run_on`, the same rule was due again the next night and threw at the same
point — and the rules are read `.order('id')`, so every rule after it was never
reached. **One row stopped allowances for every family after it, permanently**,
with nothing in the response naming the cause. Reaching that state is ordinary:
any wallet missing a bucket does it, no cross-family reference required.

The route now counts the failure, logs it, leaves the rule retryable and returns
502 — the contract the repo's other four batch crons already follow, and which
`tests/cron-batch-failure-status.test.ts` already pinned for them. The money one
simply was not on its list.

The **schedule-claim** error in the same loop (`if (scheduleError) throw
scheduleError;`) was the other half of the identical defect and was missed by the
first pass of this fix. A scan of all 24 cron routes for a `throw` inside a
per-item loop found it — `wallet-allowance` was the only route in the repo with
one, and it had two. Nothing is written when the claim fails, so that rule stays
due and retries on its own; it now takes the same isolated path instead of ending
the run. `if (subscriptionsError) throw subscriptionsError;` is deliberately left
alone: it sits *before* the loop, and if plan gating cannot be read then every
rule would be mis-gated, so failing the run is correct there. `wallet-allowance` is now on it, and
`tests/allowance-cron-isolates-one-bad-rule.test.ts` asserts the behaviour
itself: the rule ordered *after* the failing one is paid. That test was
calibrated against the old route — three of its four cases fail there.

`tests/cron-wallet-allowance-persistence.test.ts` asserted the `throw` as its
proxy for "the failure is not swallowed". The assertion was retargeted rather
than deleted: the failure must still be recorded and surfaced, it just must not
end the run.

#### Scope

Deliberately narrow — the three references measured above, guarded by trigger.
A composite foreign key would need a `(family_id, id)` unique constraint on every
parent table and a rewrite of **454** constraints; that is a schema project for
when the ledger is healthy, not a boundary fix. The shared
`public.reference_shares_family()` helper takes the column and parent table as
trigger arguments, so the next reference costs one line — which is what `0275`'s
header asks for, "by shape rather than by name".

Each wired reference is **validated where it is wired**, because the failure mode
of a mis-wired one is quiet in exactly the place it matters. The helper
early-returns for the trusted server, so a parent table with no `family_id`
column installs happily during a migration replay — which runs with no JWT, so
`auth.uid()` is null and the guard never reaches its query — and then raises
`42703` on **every authenticated write** to that table in production. Measured
both ways: as `postgres` the mis-wired insert succeeds silently, as an
authenticated user it fails `42703`. The wiring loop now asserts that the child
has `family_id` and the named column and that the parent has `family_id`, so the
mistake fails during replay, where CI catches it.

Until this is applied, production carries the cross-family writes as measured
above. The allowance-run outage is fixed in the route and takes effect on merge.

### The manual allowance run could pay twice — fixed in the app, live on merge

`tests/allowance-cron-idempotency.test.ts` locks the nightly cron's schedule
claim so it *"can't regress to a blind (double-crediting) update"*. The manual
**Run due allowances** button — `runDueAllowancesAction` in
`app/(app)/wallet/actions.ts` — is the sibling path that test does not cover, and
it was exactly that blind update:

```ts
.update({ next_run_on: next, last_run_on: today })
.eq('id', rule.id).eq('family_id', familyId).select('id').single()
```

No `.lte('next_run_on', today)` predicate, so the update always matched. Both
paths select due rules the same way, so two overlapping runs — a double-click, or
a click racing the cron, whose own claim *is* predicated — both read the rule as
due, both advanced it, and **both credited the child's wallet**.

The claim now carries the predicate and reads with `.maybeSingle()`, and a rule
that matched no row is skipped rather than treated as an error — the cron's
pattern exactly. `tests/manual-allowance-run-claims-like-the-cron.test.ts`
asserts it and was calibrated against the old code, where three of its four cases
fail.

`tests/wallet-allowance-persistence.test.ts` pinned the old statement verbatim,
including `.single()`. Its intent — the advance is checked before the credit and
rolled back if the credit fails — is kept and strengthened rather than deleted:
it is now a claim.

This needs no migration and takes effect on merge.

### `0312` makes the sensitive-document rule match what people type — unapplied

`documents.category` is a **free-text folder name** the person types
(`components/modules/documents-module.tsx` sets
`category: form.category.trim() || 'general'`), and that upload path never sets
`is_secure`. So for anything filed through Documents, the category *is* the
whole boundary.

`0266`'s classifier tested **exact membership** of a seventeen-word list.
Measured on a replayed database against the folder names a parent actually
types:

| filed as | sensitive? |
| --- | --- |
| `medical` | yes |
| **`Medical Records`** | **no** |
| **`Tax Returns`** | **no** |
| **`Bank Statements`** | **no** |
| **`Passports & IDs`** | **no** |
| **`Wills & Estate`** | **no** |
| **`Health Insurance`** | **no** |

The last two show it was a matching bug rather than a vocabulary gap: every word
in them was already on the list. A plural or a second word was enough to turn
the guard off.

This reaches further than one predicate. `documents_select/insert/update/delete`
(`0266`) and `document_object_is_restricted` (`0303`, the storage-bytes guard)
all decide through this function — so a passport scan filed under "Passports &
IDs" was readable by every child in the family, **bytes included**, which is
exactly what `0303` was written to stop.

Measured consequence, acting as a child with both controls passing: **12
assertions failed** under the old rule, including *"a child can read 11
documents filed under sensitive folder names"*. Zero after `0312`.
`docs/audit/document-category-classifier-check.sql`.

**The change.** Match per **word** rather than on the whole string: lowercase,
split on non-alphanumerics, test each word against the list, also trying it with
one trailing `s` removed. Stripping the `s` is what lets "Wills" reach "will";
doing it on *words* rather than substrings is what keeps "Kids Art", "Videos"
and "Ideas" ordinary — a substring match on the bare `id` would have hidden all
three from the family that filed them. A short phrase list carries what no
single word does, and the vocabulary gains the terms a family vault obviously
holds.

Over-classification is the safe direction and is chosen deliberately: a gym
membership filed under "Health Club" becoming adults-only is a smaller harm than
a child reading a diagnosis.

It remains a list, and a list is what let this through. What changed is that it
now matches the language people write in.

**A test that was guarding a ghost.** `tests/document-vault-boundary.test.ts`
held the SQL and TypeScript copies in parity by reading
`supabase/migrations/0266_…sql` *by name*. The moment a newer migration
redefined the function, it would have compared TypeScript against a definition
the database had already replaced. It now resolves the newest migration that
defines the classifier, and asserts the phrase list too.

Until this is applied, production carries the classifier gap as measured above.

### `0313` keeps the meal-plan grocery RPC inside one family — unapplied

`public.grocery_from_meal_plan(p_family_id, p_from, p_to, p_list_id)` from
`0005` is `SECURITY DEFINER` and granted `execute` to `authenticated`. It
checked `is_family_member(p_family_id)` on the way in and then trusted
everything else it was handed.

**The join.** `join public.meals m on m.id = mp.meal_id` — the `where` scoped
the *plan*, nothing scoped the *meal*. `0311` established that a member may
write a row carrying their own `family_id` beside a reference into another
family, so a `meal_plans` row planted under family A pointing at family B's
meal made the RPC copy B's ingredient names onto A's own grocery list, where A
can read them. Measured on a replayed database, acting as a parent of A who is
not a member of B and who provably cannot `select` B's meals:

```
control: A member of B?                     f
control: rows A can SELECT from B's meals:  0
meal_plan under A pointing at B's meal:     1 row
items A can now READ on their own list:     2 -> PRIVATE-kosher-brisket,
                                                 PRIVATE-insulin-syringes
```

Ingredient lists carry religious practice, allergies and medical supplies.

`0311`'s own header said of this class: *"Reads still hold — A cannot SELECT
B's chore, so this is not a read leak. What it reaches is the code that ACTS on
the reference."* This function is that code, and acting on the reference made
it a read leak after all. A `SECURITY DEFINER` routine is where a plantable
reference stops being harmless, because it is the one place RLS is not looking.

**The list.** `p_list_id` was used as given, so rows landed on another family's
list (measured: rows carrying A's `family_id` sitting on B's list). B cannot
see them — `grocery_items` RLS is family-scoped — so this is corruption rather
than an injection B would read.

`0313` fixes both levels: the function validates every id it is handed, and
`meal_plans.meal_id → meals` and `grocery_items.list_id → grocery_lists` join
`0311`'s validated trigger loop, which `0311` said would cost one line each.

Held by `docs/audit/meal-plan-grocery-boundary-check.sql`: four assertions
failed before, none after, with both controls — A's own meal plan still fills
A's own list, and A can still add to it — passing in both directions.

Until this is applied, production carries both holes as measured above.

### `0314` makes circle join codes typeable — unapplied

`marketplace_create_circle` builds the 8-character code a family shares with
the neighbours they lend things to, and says what it is for:

```sql
-- 8-char human-friendly code (no 0/O/1/I), retried on the rare collision.
v_code := upper(substr(translate(
  encode(gen_random_bytes(8), 'base64'), '0O1Il+/=', 'ABCDEFGH'), 1, 8));
```

`translate` runs **before** `upper`, and the from-set names only the uppercase
`O` and `I`. base64 emits lowercase letters too, so a lowercase `o` or `i`
passes through untouched and `upper()` turns it back into exactly the character
the line exists to remove.

Measured over 20,000 generated codes:

```
codes containing 0 or 1 : 0        (the digits really are excluded)
codes containing O or I : 4,568    -- 22.8%

OWSBVEFD   YYEQDIBA   THOLKTVA   TNEIEAWB
```

The asymmetry is what makes it a dead end rather than a coin flip: because a
stored code can never contain a digit `0` or `1`, a parent who reads
`OWSBVEFD` off a screen and types a zero gets *"no circle with that code"*
every time, with nothing telling them they are one character away.

`0314` fixes both halves. The generator's from-set now names both cases of
every ambiguous letter — the alphabet becomes
`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, verified over 50,000 codes with zero `0`,
`1`, `O` or `I`. And the lookup reads a typed `0` as `O` and a typed `1` as
`I`, which is unconditionally safe *because* no stored code contains those
digits — so the 22.8% of codes already issued stay joinable rather than being
rotated out from under the families who wrote them down.

`lib/marketplace/community.ts` carries the browser-side copy of the same
normalisation and was updated to match; the two are pinned to each other in
`tests/marketplace-community.test.ts`, which reads the rule out of this
migration by name rather than restating it.

Held by `docs/audit/circle-join-code-check.sql`: three assertions failed
before, none after, with the controls — an unknown code is still rejected, and
a member of one family still cannot join on behalf of another — passing in
both directions.

Until this is applied, production keeps minting codes that one family in four
cannot read aloud.

### `0315` sells one item once — unapplied

`marketplace_accept_offer` is `SECURITY DEFINER` and checked two things: that
the caller owns the listing, and that the **offer** is still open.

```sql
if v_offer.status <> 'open' then raise exception 'Offer is no longer open'; end if;
```

It never checked the **listing**. The guard was on the piece of paper, not on
the thing being sold.

Nothing stops a second offer against a claimed listing — `marketplace_offers_insert`
requires only family membership and that the offer is made in the member's own
name — and a backup offer is a reasonable thing for a family to make. Accepting
one, though, sold the item twice. Measured on a replayed database with **no
concurrency at all**, acting as the listing's own owner:

```
accepted buyer one -> listing=claimed, orders=1
buyer two could place an offer on a CLAIMED listing: t
accepted buyer two -> listing=claimed, orders=2
                      (Buyer one @40, Buyer two @45)
```

Two confirmed orders for one balance bike, two families each told it is theirs,
and `claimed_by` silently rewritten from the first buyer to the second while the
first keeps a confirmed order. `marketplace_orders` carries no unique index on
`listing_id`, so the schema does not catch it either.

`0315` puts the precondition **in the UPDATE** that claims the listing rather
than in an `if` above it. An `if` would fix only the sequential case; carrying
the condition in the write makes the row lock do the work, so two genuinely
concurrent accepts serialise and the second matches zero rows. Same shape as
the allowance rule the cron re-credited and the social target that published
twice: the write that is supposed to be the claim has to be the thing that is
exclusive.

Offers are deliberately left alone — a family may still register interest in
something already claimed; what changes is that accepting it cannot sell the
item a second time. That is asserted as a control, so the fix is not quietly
widened.

Held by `docs/audit/listing-claimed-once-check.sql`: two assertions failed
before, none after, with three controls — the first sale still works, a backup
offer is still accepted, and a different available listing still sells — passing
in both directions.

Until this is applied, production can sell one item to two families.

### `0316` pays a chore once — unapplied

`payChoreRewardAction` states the invariant in its own comment:

```ts
// Already paid? (one wallet credit per assignment)
const { data: existing } = await supabase.from('wallet_transactions').select('id')
  .eq('family_id', familyId).eq('related_type', 'chore_assignments').eq('related_id', assignment.id).limit(1);
if ((existing ?? []).length > 0) return { ok: false, error: '…already paid' };
```

and then enforced it with a SELECT followed by an INSERT. Nothing in the schema
backed it — `wallet_transactions` carried no unique index on those columns at
all. Two "Pay" clicks arriving together both read zero rows and both credited
the child's wallet. Real money, minted twice.

**The obvious key is wrong twice over**, and both were found by reading the
writers rather than the guard:

1. `related_type = 'allowance_rules'` is **recurring** — a rule credits every
   week carrying the same `related_id`. A unique index on
   `(family_id, related_type, related_id)` would break allowances on the second
   payment.
2. `creditChildWallet` writes **one row per bucket** for a single credit, all
   sharing `related_id`. Measured, for a 4,000¢ payout under the default
   40/40/10/10 split:

   ```
   parts: {"spend":1600,"save":1600,"give":400,"invest":400}
   ledger rows written: 4
   ```

   So even scoped to `chore_assignments`, a three-column index would reject the
   **first** payout, not the second.

`0316` therefore creates a partial unique index on
`(family_id, related_id, bucket_id)` where `related_type = 'chore_assignments'`.
The rows of one payout go in as a single multi-row INSERT, so a second payout
collides on its first bucket and the whole statement is refused — there is no
half-credited wallet. The migration counts pre-existing violations first and
raises with the count rather than repairing a money ledger on its own; on a
replay from zero there are none.

`creditChildWallet` now returns `duplicate: true` for a `23505`, and
`payChoreRewardAction` reports it with the same "already paid" message its own
read uses, so the loser of the race sees that rather than a constraint name.

Held by `docs/audit/chore-paid-once-check.sql`: two assertions failed before,
none after, with four controls passing in both directions — the first
multi-bucket payout still lands, a different assignment still pays, **a weekly
allowance still credits the same rule repeatedly**, and `spend_request` debits
carrying no `related_id` are untouched. The middle two are the ones that would
have caught the wrong index.

Until this is applied, production can pay one chore twice.

### `0317` makes the listing state machine decide from a locked row — unapplied

`marketplace_set_listing_status` is the seller's state machine: withdraw,
complete, relist, mark pending. It read the listing with **no lock** and wrote
with **no predicate**, so the transition was judged against a row another
transaction may already have changed.

Of the twenty-two `SECURITY DEFINER` functions in this schema that read a row
and then update it, this was the **only** one with neither mechanism — every
other one takes `for update`, predicates its write, or both. `marketplace_buy_now`,
its immediate neighbour, does all three.

**Measured with two real concurrent sessions.** The transition that exposes it
is one the state machine forbids (`pending` is legal only from `available`):

```
before:  seller: (no error — the forbidden transition was accepted)
         listing=pending  claimed_by=<buyer>  confirmed_orders=1

after:   seller: ERROR: Cannot move listing from claimed to pending
         listing=claimed  claimed_by=<buyer>  confirmed_orders=1
```

The seller read `available`, decided `available → pending` was legal against
that stale value, then blocked on the buyer's row lock and wrote anyway. The
listing goes back on the market as `pending` while carrying a confirmed order
and the buyer's `claimed_by` — a second buyer can be pointed at an item that is
already sold.

**What this is not:** `claimed → withdrawn` is legal from both the stale and the
fresh read, so a seller withdrawing a just-claimed listing is not this defect —
it is the product working as designed, and the probe asserts it still does. Only
a transition the state machine rejects from the true status shows the stale read.
The first scenario tried here was that one, and it demonstrated nothing; it is
recorded because the distinction is the whole point.

Held by `docs/audit/listing-status-machine-check.sql`, which reads the mechanism
out of `pg_get_functiondef` rather than a file (so it cannot pass against a
definition a later migration replaced) and **re-runs the sweep that found this
one**, so the next function to drop both mechanisms is caught at replay rather
than by a buyer. Three assertions failed before, none after, with four controls
— the two legal transitions, the forbidden one, and the non-owner — passing in
both directions.

Until this is applied, production can put a sold item back on the market.

## Security-relevant migrations awaiting production

Added after this document's inventory stopped being complete, and listed here
because their value is zero until they are applied:

- **`0406_social_tokens_service_role_only.sql`** (renumbered from `0300`, which
  `main` took for the entitlement fix above; from `0318`, which `main` took for
  the guardian safety config; and from `0361`, which `main`'s #579 took for the
  vote-owner pin — the ten below moved with it each time) — drops the four
  `can_manage_family` policies `0297` added to `public.social_account_tokens`.
  `0034` created that table with no policy and a comment saying never to add
  one; `0297` added them on the stated premise that "every policy was
  is_family_member", when there were none. Until `0406` is applied, any family
  manager can `select` the OAuth token rows through PostgREST. The columns hold
  ciphertext and no code writes the table yet, which bounds the exposure; it
  does not remove it. Verified locally against a full replay (313 migrations
  applied, 0 failed) and by `docs/audit/sensitive-role-boundary-check.sql`,
  which was amended in the same change — it previously asserted the opened
  state as a requirement. Audit C3-S5-01.

- **`0407_no_truncate_for_the_public_roles.sql`** — revokes `truncate` on every
  table in `public` from `anon` and `authenticated`, and sets the matching
  default privilege so a future table does not arrive with it. `truncate` is not
  filtered by row-level security: a policy that correctly limits which rows a
  member may `delete` says nothing about a `truncate`, which empties the table
  for every family at once. No application path uses it. Its assertion lives in
  `docs/audit/no-truncate-for-public-roles-check.sql` rather than a Vitest file
  because `tests/migrations-are-additive.test.ts` forbids the bare word in a
  migration outside a privilege list, which is exactly the rule that makes this
  one safe to read. Audit C1-S5-04.

- **`0408_household_secrets_are_not_child_readable.sql`** — replaces the single
  `"Members manage household_info"` policy (`for all using
  is_family_member(family_id)`) with four that add
  `and (not is_sensitive or can_manage_family(family_id))` on select, insert,
  update-using, update-with-check and delete. The binder carries alarm codes and
  wifi keys behind an `is_sensitive` flag, and `components/modules/binder-module.tsx`
  masks such a value behind an eye toggle — but the row reached the browser in
  full, so the mask hid a value the client already held. Measured before the fix:
  a child read `hunter2-alarm-4417` in the clear. The `with check` half matters
  independently: without it a child clears the flag, reads the value and sets it
  back. `docs/audit/household-binder-boundary-check.sql` asserts both, and that a
  parent still sees the whole binder. Audit C1-S6-06.

- **`0409_marketplace_parties_are_not_editable.sql`** — makes `family_id`,
  `listing_id` and the party columns of `marketplace_orders` /
  `marketplace_offers` immutable after insert, via a `BEFORE UPDATE` trigger that
  fires only when `row_security_active()`, and tightens the two `with check`
  clauses `0154` left as a bare family test. `0154` tied every marketplace UPDATE
  to the row owner in its `using` clause only, so the ownership rule governed the
  row you started from and not the row you produced: measured, the **buyer** on a
  completed order could set `seller_member` to themselves, and the count that
  `marketplace/item/[id]/page.tsx:87` and `marketplace/creators/[id]/page.tsx:58`
  display as a seller's completed-sales record moved with it. Tightening
  `with check` to match `using` is **not** sufficient and was tried first — the
  predicate is symmetric, and RLS cannot see the old row. Nothing legitimate
  loses access: every write to either table in the tree either updates `status`
  alone or runs as `SECURITY DEFINER` / the service role.
  `docs/audit/marketplace-ownership-update-check.sql` asserts both refusals and
  both permitted writes. Audit C1-S6-08.

- **`0410_a_review_belongs_to_whoever_wrote_it.sql`** — scopes the
  `marketplace_reviews` / `marketplace_saves` / `marketplace_follows` UPDATE
  policies to the row's owner, and makes the columns around the authorship
  column immutable. `0154` pinned `reviewer_member` (resp. `member_id`) on INSERT
  so a trust score could not be forged, and left an UPDATE policy of
  `is_family_member(family_id)` on both clauses — not scoped to the author at
  all. Measured: the member a review was *about* rewrote its rating, and `rating`
  is aggregated by `reviewee_member` on four screens. Nothing in the tree updates
  any of the three tables, so no behaviour is lost; the policies are scoped
  rather than dropped because "edit your own review" is what they evidently meant
  to say. Also replaces `0409`'s table-branching trigger function with
  `columns_are_immutable()`, which takes its column list from the trigger
  definition and raises on a column that does not exist rather than silently
  guarding nothing. `docs/audit/marketplace-review-authorship-check.sql` asserts
  all of it, including that typo guard. Audit C1-S6-09.

- **`0411_deleting_a_review_is_rewriting_it.sql`** — scopes the DELETE policies
  on `marketplace_reviews` / `marketplace_offers` / `marketplace_saves` /
  `marketplace_follows`, which `0154` left family-wide. `0410` stopped a member
  rewriting another member's review; deleting it achieves the same thing, and on
  offers it is worse in kind — any member could remove a competing offer on a
  listing they have nothing to do with. Offers go to the two parties their UPDATE
  policy already names; saves and follows to the owner, which is a no-op for the
  two toggle actions that are the only deletes in the tree; reviews to the author
  **or** a family manager who is not the reviewee, so a parent can still moderate
  an abusive review without any adult being able to erase one about themselves.
  `docs/audit/marketplace-delete-authorship-check.sql` asserts both the refusals
  and the four things that must still work. Audit C1-S6-10.

- ~~`0324_a_social_restriction_is_not_self_service.sql`~~ — **DROPPED on the merge that brought `main`'s 0318–0343 in (Audit C1-S9-89):** `0319_social_access_delete_matches_grant.sql` on `main` creates the identical DELETE policy, scoped `to authenticated`; renumbered after it, this one would have re-created the policy without that scope. The finding below stands and is fixed by `0319`. *Original entry, kept for the record:* gives
  `social_access_permissions_delete` the predicate its INSERT and UPDATE policies
  already carry. `social_role_for()` falls back to a default derived from the
  family role when no explicit row exists, so a row restricting someone *below*
  that default could be deleted by the person it restricted, who then fell back
  **up**: measured, an `adult` set to `read_only` deleted their own restriction
  and became `marketing_manager`, gaining `publish_posts`, `manage_settings` and
  `connect_accounts` on the family's connected social accounts. Nothing in the
  tree deletes from this table — `grantAccessAction` upserts behind
  `requireSocialPermission`, and revocation is a `status` change the UPDATE
  policy guards — so no behaviour is lost.
  `docs/audit/social-access-self-service-check.sql` asserts the refusal, the
  fallback that would have followed it, and that a family admin can still revoke.
  Audit C1-S6-11.

- ~~`0325_where_a_child_went_is_not_theirs_to_rewrite.sql`~~ — **DROPPED on the merge (Audit C1-S9-89):** superseded by `0335_a_location_says_who_was_actually_there.sql` on `main`, which refuses every attack this entry lists (and `docs/audit/location-trail-boundary-check.sql` still asserts them against it). Stacking both broke `0335`'s own negative control. The one check this entry added and `0335` does not — that a location row's member belongs to the row's family — is recorded as OPEN (LOW) in `finalaudit.md`. *Original entry, kept for the record:* replaces the two
  `FOR ALL … is_family_member(family_id)` policies `00420` shipped on
  `location_events` and `member_locations`. `0215` hardened the geofences
  (`family_places`) against exactly this threat and said so in its header, but it
  protected the INPUT to the geofence system and left the OUTPUT — the
  arrival/departure timeline a parent reads — untouched; `location_events` is not
  mentioned in `0215` at all. It also recorded `member_locations` as
  "self-location", which `is_family_member` never made it. Measured as a
  signed-in child against a replayed schema: the child DELETEd their own 02:00
  "left home" event, moved a **sibling's** live pin, switched a **sibling's**
  sharing off, re-pointed their own location row at another member, and filed an
  event in a sibling's name. `00420`'s claim that "location sharing is strictly
  opt-in (`member_locations.is_sharing`)" is only true after this migration. The
  fix reuses `public.is_self_member()`, which `0272` added for the identical
  shape on `event_rsvps`. No UPDATE or DELETE path is granted on
  `location_events` — nothing in the tree uses one, and this document already
  records what an unwired policy is worth (`call_logs`).
  `docs/audit/location-trail-boundary-check.sql` asserts all six refusals plus
  the four paths that must keep working: the member's own upsert,
  `setLocationSharing(false)`, `deletePlace()`'s `ON DELETE SET NULL` against a
  table with no UPDATE policy, and the family-delete cascade. Audit C1-S8-02.

- **`0414_a_health_record_is_written_by_a_parent.sql`** — restrictive manager
  guards on `immunizations` and `health_visits`, the two health tables `0309`
  did not reach. `0309` gated the medication tables, named the class ("a class
  fixed where somebody remembered and left open where nobody did") and listed
  the neighbours it had checked — `medical_profiles`, `health_providers`,
  `insurance_policies` — but not these two, which kept `0068`/`0069`'s
  `FOR ALL … is_family_member`. They render on `/dashboard/medical` directly
  beneath `MedicalRecordsModule`, so one page carried two boundaries; the
  free-text `medical_profiles.immunizations` blob was manager-only while the
  structured ledger `0069` wrote to replace it was not. Measured as a signed-in
  child: rewrote a sibling's mental-health visit `outcome`, deleted that visit,
  back-dated a sibling's MMR and cleared `next_due_date`, deleted the
  vaccination record. Neither module carried a role check either, so this was
  not even a hidden button — the fix ships the UI half
  (`canEdit = isManager(role)`) with the migration.
  Reading stays family-wide (M23 owns per-member read scoping) and
  `medication_doses` stays open exactly as `0309` left it; the probe asserts
  both as positive controls, plus `0309`'s own boundary and a manager's full
  create/edit/delete. `docs/audit/health-record-boundary-check.sql`.
  Audit C1-S8-03.

- **`0415_a_paperwork_stamp_does_not_rewrite_its_siblings.sql`** — adds
  `public.paperwork_stamp_action(uuid, int, text, text)`, a `SECURITY INVOKER`
  function that stamps ONE element of `paperwork_items.actions` and refuses one
  already stamped. `materializePaperworkActionAction` promised in its own doc
  comment that "tapping twice never double-creates" and kept it with a
  read-modify-write over the whole array, so two overlapping taps each erased
  the other's stamp and the next tap created a second calendar event or
  reminder. Not a rare interleaving: the module renders one button per action
  and disables only the busy one, and its single `busyKey` re-enables the first
  button when the second tap starts. `status` is recomputed from the row rather
  than from the caller's copy, so a sibling stamp that lands in between counts
  toward `done`. The function changes no authorization — the probe asserts a
  child of the family may still stamp and a stranger may not.
  `docs/audit/paperwork-stamp-concurrency-check.sql` reproduces the OLD
  semantics beside the new function and fails if they stop reproducing the
  defect. Audit C1-S8-05.

- **`0416_a_private_journal_is_private.sql`** — self-scoped RLS on
  `journal_entries`, and manager-gated writes on `family_insurance_policies`.
  `0087` gave the journal `is_private boolean NOT NULL DEFAULT true` and a single
  `FOR ALL … is_family_member` policy; `is_private` is referenced nowhere in
  `app/`, `components/` or `lib/`, so the module's `.eq('member_id', memberId)`
  was a query filter rather than a boundary. Measured as a signed-in child: read
  a sibling's entry, rewrote it, deleted it, and wrote one in the sibling's
  name. SELECT is now self **or** a family manager when `is_private` is false —
  the owner-or-manager rule `main`'s `0364` landed first for this table and
  `docs/audit/private-journal-check.sql` pins (a sibling never reads another
  member's entry; a parent reads only one its owner marked not private). **A
  private entry is not a parent's window**, and the probe asserts that refusal.
  `family_insurance_policies` (policy numbers, premiums, agent phones, document
  paths) was `FOR ALL … is_family_member` while its twin `insurance_policies`
  had manager-gated writes all along — the third instance of that twin-table
  pattern after `0309` and `0414`. Reading stays family-wide on both, matching
  `insurance_policies`. `insurance-module.tsx` had no role check of any kind, so
  the UI half ships with this migration.
  `docs/audit/journal-and-policy-boundary-check.sql` asserts six refusals, that
  a member keeps full control of their OWN journal, that every member still
  reads the policies, that a parent keeps the pen on them, and that a parent
  still cannot read a child's journal. Audit C1-S8-07.

- ~~`0329_a_record_about_you_is_not_yours_to_rewrite.sql`~~ — **DROPPED on the merge (Audit C1-S9-89), a POLICY DISAGREEMENT for the owner:** it made `behavior_logs` writes manager-only, matching the screen (`behavior-module.tsx` shows Log/Delete only to managers); `main`'s `0338_a_care_entry_names_who_actually_logged_it.sql` and its probe require that a child CAN log behaviour in their own name. Both cannot hold. `0338` is in the tree; this one and `docs/audit/observation-log-boundary-check.sql` are recoverable from the branch history. See `finalaudit.md`. *Original entry, kept for the record:* two tables whose
  own column comments separate the subject from the author, and two DIFFERENT
  fixes, because the reason they differ is in each table's header.
  `behavior_logs` (`member_id … -- the child`, `logged_by`) is "per-child
  behavior observations … Powers parenting insights" with `concern` notes and a
  signed `points` column; measured as a child, it erased a concern logged about
  them and inserted `points = 99` in their own favour. Manager-gated writes via
  restrictive guards, `0254`'s mechanism and `0309`'s shape.
  `care_log` is NOT the manager class and gating it that way would break the
  feature — `0032` says the log exists "so the whole family can see who last
  checked in", so family-wide reads and inserts are the intent. It gets the
  `0410`/`0411` treatment instead: UPDATE and DELETE belong to the author or a
  manager, and `member_id`/`logged_by` are immutable through the shared
  `columns_are_immutable()` trigger, so not even a parent may rewrite who
  recorded what (measured: one could).
  READS stay family-wide on both — whether a child should see the concerns
  logged about them is a product decision, and the probe asserts both logs stay
  readable so changing it has to be deliberate. Both modules' controls ship with
  the migration. `docs/audit/observation-log-boundary-check.sql`. Audit C1-S8-09.

- **`0418_a_public_bucket_serves_what_you_put_in_it.sql`** — pins
  `allowed_mime_types` on the public `family-media` bucket. Three of the four
  public buckets have pinned theirs since creation (`00890`, `0194`, `0197`);
  `0216` set `public = true` and a size limit and no type list, on the bucket
  that takes the widest range of uploads (six browser paths, no server-side
  path), so an `image/svg+xml` or `text/html` upload became a page served from
  the project's own Supabase domain with no session. This is NOT `F-E03` again:
  that one is deferred as `LB-009` because signed URLs need a data migration of
  every stored URL, and an allowlist needs none — the expensive fix was covering
  a cheap one.
  **THIS CHANGES UPLOAD BEHAVIOUR IN PRODUCTION**, so the permitted list is
  stated here in full and is read off the six modules' own `accept` attributes:
  `image/jpeg|png|webp|gif|avif|heic|heif`, `video/mp4|quicktime|webm`,
  `application/pdf`, `application/msword`, the two OOXML word/spreadsheet types,
  `application/vnd.ms-excel`, `text/plain`. HEIC/HEIF are included although no
  `accept` names them, because `image/*` is what the picker says and an iPhone
  photo arrives as HEIC. Nothing the product offers is refused, and
  `tests/a-public-bucket-allows-only-what-the-ui-offers.test.ts` fails if a file
  picker ever gains a type the bucket would refuse.
  It does NOT make the bucket private and does NOT touch stored objects.
  Unlike `0216`'s `on conflict do nothing`, it UPDATEs — the production bucket
  already exists, so an insert would no-op.
  `docs/audit/public-bucket-mime-check.sql` asserts the general rule: every
  public bucket pins a list, and none allows a type a browser executes.
  Audit C1-S8-10.

### `0339` makes a calendar event name who actually made it — unapplied

`01050_calendar_events_rls_repair.sql` is the whole of this table's policy set,
and every verb of it is the same sentence — `public.is_family_member(family_id)`
— which is role-blind **and** identity-blind. So a child member may INSERT an
event carrying a parent's uid in `created_by`, and, because UPDATE is the same
sentence, may afterwards rewrite an existing row's author to anyone, or to NULL.

It reaches a screen. `app/(app)/dashboard/workload/page.tsx` is the only select
list in the tree that names this column, and `lib/workload/balance.ts` scores
each organized event as 12 minutes of "invisible labour" — so the forgery moves
a real number attributing real effort to the wrong parent.

**Why this is not `created_by = auth.uid()`**, which three earlier drafts
carrying the numbers `0339`/`0340`/`0342` all used and were rejected for:
`lib/services/approvals/index.ts` `scopeForApprovedWork` deliberately runs
approved work as the **ASKER** while the database session stays the approving
parent's, so a bare identity pin breaks the approval-replay path it claims to
protect. This migration instead copies the shape **already shipped and
test-pinned** by `0272_rsvp_is_first_person.sql` on `event_rsvps`, a table the
same replay writes:

```
created_by is null or created_by = auth.uid() or can_manage_family(family_id)
```

as a **RESTRICTIVE** INSERT policy, so `01050` keeps owning its own policies and
no future permissive INSERT can grant past this one. The NULL branch is required,
not tolerated: the ICS paste import and the subscribed-feed sync both write rows
with no `created_by` key at all on an RLS-applying client, and two of the audit's
own probes insert without it.

**The UPDATE half is a trigger, not a policy, and its `pg_trigger_depth() = 1`
guard is load-bearing.** No calendar writer sends `created_by` on UPDATE, so a
checking policy would refuse a member legitimately editing someone else's event;
a preserving trigger costs those paths nothing. But an *unconditional* preserve
also reverts the column's own `ON DELETE SET NULL` referential action, which
Postgres performs as an ordinary UPDATE. Measured both ways: in autocommit that
**commits a dangling reference with no error at all**, and inside a transaction
it raises a foreign key violation. The depth guard lets the constraint through at
depth 2 while still freezing application UPDATEs at depth 1 — including
`INSERT … ON CONFLICT DO UPDATE`, which an INSERT `WITH CHECK` never sees and
which `.upsert()` emits.

**Verified on a database built from nothing:** `docs/audit/verify-pg.sh up`
applied **350 migrations, 0 failed**, and `docs/audit/run-probes.sh` then passed
**62 of 62** boundary probes against it, the new
`a-calendar-event-names-who-made-it-check.sql` included. That probe carries a
negative control that puts **both** halves of the defect back inside its own
transaction and fails itself if the forgery does not land or if `ON DELETE SET
NULL` still fires — so it is a boundary rather than decoration. That is evidence
about this tree. It is **not** evidence about production, which still records
only `0001-0003`.

**Known residue, recorded rather than implied.** `0339` closes INSERT and freezes
the author; it does **not** close DELETE, and the manager branch is unconstrained
by the roster, so a manager may still name an `auth.users` id outside the family
— `0272`'s `member_id` shape prevents that for free and this column's
`auth.users` reference cannot. Both are in the migration's own header.

Until this is applied, any household member can sign a calendar event with
another member's name, and rewrite or erase the author of one already there.

### `0340` makes an erasure actually erase — unapplied

`0338` froze the attribution columns on four household ledgers with a BEFORE
UPDATE trigger that **preserves** rather than refuses — correct, because the app
never sends those columns on UPDATE and a checking policy would block a member
legitimately editing somebody else's entry. It preserves **unconditionally**,
and that is the defect.

Five of those columns are `ON DELETE SET NULL`, read from `pg_constraint`
(`confdeltype = 'n'`) with the **referenced** table included — the first version
of that query omitted it and misread `care_log.logged_by` as pointing at
`auth.users` when it points at `family_members`:

| table | column | references |
|---|---|---|
| `behavior_logs` | `logged_by` | `auth.users` |
| `care_log` | `created_by` | `auth.users` |
| `care_log` | `logged_by` | `family_members` |
| `medication_doses` | `logged_by` | `auth.users` |
| `screen_time_entries` | `logged_by` | `auth.users` |

Postgres performs a referential action as an ordinary UPDATE against the
referencing row, so the trigger fires on it and puts the deleted id straight
back.

**Two symptoms, and production gets the silent one.** Measured holding schema,
constraint and trigger fixed and varying nothing but the transaction mode: in
**autocommit** the revert is silent and a dangling reference is **committed**; in
a **transaction** the foreign key check fires and the delete is **refused**.
`admin.auth.admin.deleteUser` issues one DELETE in its own transaction, so a real
erasure takes the first row — the account goes, the name stays, and nothing
reports it. The visible error is what a *probe* sees, because every probe here
rolls back. Recording only the error would have described the instrument.

`pg_trigger_depth() = 1` is an application UPDATE; a referential action arrives
at depth 2. Guarding the preserve on depth 1 keeps every freeze `0338` shipped —
its own probe still passes — while letting the constraint do the job it declares.

This also closes **AUTHZ-022**: `logged_by` was assigned unconditionally while
`created_by` had a presence test, so the function raised `42703` on any table
lacking `logged_by` while its own `comment on function` called itself shared and
general. `logged_by` now gets the same test. That changes nothing on the four
tables `0338` attaches it to — but NOT for the reason the first draft gave. "All four carry both columns" is **false**, measured: all four carry `logged_by`, and only `care_log` carries `created_by`. So `created_by`'s presence test is **load-bearing on three of the four today**, which is why `0338` worked at all, while `logged_by`'s is defensive. It is the
comment that was wrong, and a function whose comment lies is how AUTHZ-022
happened. Both repairs are one line on the same function, so they are one
migration rather than two replacing it in sequence.

**Verified on a database built from nothing:** 350 migrations applied / 0 failed,
`0340` applied on top, then **63 of 63** boundary probes passed. The identical
autocommit erasure that left a dangling reference before the repair clears the
column after it, and an application rewrite of both columns is still refused.
`docs/audit/an-erasure-actually-erases-check.sql` holds it, and was **shown to
fail before being trusted**: exit **3** against the unguarded function, exit
**0** against the repaired one.

**Scope.** `0338` is itself unapplied, so this is a repair before shipping rather
than after, and no shipped product path reaches the defect today — the three
`admin.auth.admin.deleteUser` call sites are rollbacks on a just-created child
user. What is exposed is deletion from the Supabase dashboard or admin API, and
any future account-deletion or GDPR-erasure feature.

**The one a future edit is most likely to undo:** dropping the depth condition
makes the preserve unconditional again and silently reopens this. The migration
and the probe both re-assert it, and both also re-ask whether any trigger issues
a nested UPDATE against these four tables — because that, not the guard itself,
is what would make `depth = 1` stop covering every application write.

Until this is applied *together with* `0338`, erasing an account leaves that
person's name on household ledger rows the care timeline still renders.

### `0341` makes two approvals for one kid both land — unapplied

`0341_two_approvals_for_one_kid_both_land.sql` (CONC-001).
`applyCompletionRewards` in `lib/chores/server.ts` read `kid_progress`, added
the XP in TypeScript, and wrote the total back by id — a read-modify-write with
**neither a lock nor a predicate**:

```
const progress = await ensureProgress(supabase, opts.familyId, opts.memberId);
const xp = progress.xp + gainedXp;                      // <- READ
await supabase.from('kid_progress')
  .update({ xp, level, current_streak: streak, longest_streak: longest, last_activity: today })
  .eq('id', progress.id).eq('family_id', opts.familyId);  // <- blind WRITE
```

Two chores approved for one child at the same moment — two parents, one parent
with two tabs, or the auto-approve path landing while a parent presses Approve —
both read `xp=100` and both write `120`. One award is silently lost and the
child is told 120 twice. `level`, `current_streak` and `longest_streak` come off
the **same stale read** and go out in the same statement, so all four are lost
together; that is why this moves all four and not just the XP. A fix that made
only the XP relative would leave the level decided from a total the row no
longer holds, and a wrong level looks deliberate.

**This is not the idempotency contract.** The engine's docstring says
idempotency is the caller's ("call once per approval") and that stays true — it
is about one approval submitted twice. This is two **different** approvals
arriving together, which no caller-side rule can prevent and which are both
supposed to count. The contract is unchanged by this migration.

**Measured, with two real concurrent sessions**, two medium chores (20 XP each)
approved with two seconds of deliberate overlap, against a replay of 352
migrations:

```
-- a child on 100 XP --
  BLIND  shape — read, then UPDATE by id (the defect)
    xp=120  level=2  current_streak=2  longest_streak=2
  LOCKED shape — kid_progress_apply_completion (0341)
    xp=140  level=2  current_streak=2  longest_streak=2

-- a child on 270 XP, where the lost award is also a lost level-up --
  BLIND  shape — read, then UPDATE by id (the defect)
    xp=290  level=2  current_streak=2  longest_streak=2
  LOCKED shape — kid_progress_apply_completion (0341)
    xp=310  level=3  current_streak=2  longest_streak=2
```

Same two sessions, same seconds, same row. The second pair is why "it is only
XP" is not a fair summary: at 270 the lost award is the level the child was
shown they had reached. Preserved as
`docs/audit/two-approvals-for-one-kid-both-land-race.sh` — a race, so
deliberately outside the `*-check.sql` set `run-probes.sh` globs, the same
posture as `docs/audit/allowance-double-pay-race.sh`.

**What closes it** is the shape `0317_listing_status_decides_from_a_locked_row`
used for the listing state machine and `0208_atomic_wallet_goal_funding` uses
for goal funding: `kid_progress_apply_completion` reads the row `for update`, so
the values the arithmetic is done from are the values that will be written, and
the award becomes **relative to the locked row** rather than absolute against a
snapshot taken before it. `kid_progress_level_for_xp` mirrors `levelForXp`
because the level has to be recomputed inside that lock.

**The rollback is half the fix, and was the same defect pointing the other
way.** The engine restores the progress row when the badge work after the award
fails, and it did that by writing the pre-award values back **absolutely** — so
a concurrent approval that landed in between was erased by the rollback of an
unrelated one. `kid_progress_revert_completion` subtracts under the same lock
and restores the streak columns **only while the row still carries what that
award wrote**, reporting `streak_restored: false` rather than clobbering a
streak another approval has since decided.

**It is not a new authorization boundary.** `kid_progress` carries `00430_chore_missions`'s
single role-blind policy (`is_family_member(family_id)` FOR ALL), so any family
member could already write this row directly; `SECURITY DEFINER` bypasses RLS,
so the functions **restate** that policy rather than inventing one. Tightening
it to managers is a separate decision with its own call sites (auto-approve runs
as the service role, parent approval as the approving manager). What they do add
is the cross-family guard the table never had — `kid_progress` is not one of
`0311_family_scoped_references`'s guarded references, so nothing stopped a row
naming this family beside another family's member.

**Verified on a database built from nothing:** **352 migrations applied, 0
failed**, and `0341` re-applies onto that schema unchanged (every statement is
`create or replace`). `docs/audit/two-approvals-for-one-kid-both-land-check.sql`
holds the boundary in CI — 16 assertions including the blind shape performed on
the same row as its own negative control, the `for update` read out of
`pg_get_functiondef` rather than out of a file (so it cannot pass against a
definition a later migration replaced), and a reader control proving that check
can still say no. It was **shown to fail before being trusted**: exit **3**
against a mutated expectation, exit **0** as written.

In the application, `tests/two-approvals-for-one-kid-both-land.test.ts` drives
the real `applyCompletionRewards` against a stub that HOLDS the first approval
open and asserts mid-flight that both approvals reached the database and neither
had written — so the interleaving is a fact the test establishes rather than a
coincidence it waits for. Reverting the fix turns it red at `expected 120 to be
140`.

Until this is applied, the two RPCs do not exist, so **`applyCompletionRewards`
throws `Could not save chore progress` on every approval** — this migration and
the application change ship together, which is the one ordering constraint on
this row.

### `0342` stops a child spending the same dollar twice — unapplied

`0342_a_child_cannot_spend_the_same_dollar_twice.sql` (Q-01, CONC-002).
`debitSpendBucket` in `lib/wallet/server.ts` was the **last money path in this
product that wrote the ledger from TypeScript**, and it did it as a read, a
decision and then a write — two PostgREST round trips with nothing held in
between:

```
const { bucketId, available } = await bucketBalanceCents(supabase, …);  // <- READ
if (!params.requiresApproval && amount > available) return …;           // <- DECIDE
await supabase.from('wallet_transactions').insert({ … });               // <- WRITE
```

Two $8 spends arriving together against $10 — one parent with two tabs, two
parents in the same minute, a double-submitted form — both read `available =
1000`, both passed the check, and both posted a `completed` debit. The ledger
ends at **-$6.00 and stays there**, because the wallet ledger is immutable: a
correction is a new credit, never an edit.

Nothing stood behind that check, and each half was read off the replayed
database rather than assumed: the only partial unique index on
`wallet_transactions` is `0316`'s `uq_wallet_txn_chore_payout`, scoped `where
related_type = 'chore_assignments'`; the only non-internal trigger is
`trg_wallet_transactions_updated_at`; and the only relevant CHECK is
`amount_cents >= 0`, which puts the sign in `direction` — so a negative balance
is perfectly representable.

The **paging** half of that read was already repaired (`bucketBalanceCents` goes
through `readAll`), and that is a different property. Paging makes a read
complete; it does not make it a decision. `readAll` issues N requests in N
snapshots, and by the time the insert is sent the number is a memory.

**What closes it** is `0155_wallet_auth_holds`'s shape, which has held the card
path since PAY-1 rather than anything new: `wallet_debit_spend_bucket` takes
`FOR UPDATE` on the child's `spend` bucket — one row, the natural per-child
mutex — as the first statement after its guards, totals the ledger **inside**
that lock, refuses, and writes the debit and its `wallet_audit_logs` row in the
same transaction. This was the one money mutation in the database that did not
already do that; `wallet_credit_child_ledger`, `wallet_transfer`,
`wallet_approve_gift`, `wallet_decide_spend`, `wallet_decide_allowance`,
`wallet_fund_goal` and `wallet_reserve_card_auth` all take their lock first.

It totals `('completed', 'processing')`, exactly as `0155` does, which closes a
second defect on the same path: `bucketBalanceCents` counts `completed` only, so
a **live card hold was invisible to an in-app spend** and a child could tap
their card at a shop for $8 and have an $8 in-app spend approved against the
same $10 in the same second. `requires_parent_approval` is deliberately **not**
counted and a held request is deliberately **not** refused on balance — a held
debit moves nothing and `wallet_decide_spend` re-sums under this same lock
before it ever posts, so counting it would let a request a parent has not yet
seen block one they are about to decline.

**Authorization restates the table's own policy rather than inventing one.**
`SECURITY DEFINER` skips RLS, so the function has to say what RLS said:
`wallet_transactions` carries `wallet_transactions_mng_insert` and the
restrictive `wallet_transactions_manager_insert_guard`, both `with check
(can_manage_family(family_id))`, and `can_manage_family` is role-aware
(`role in ('parent','adult') and is_active`) — the same set as `isManager`. So
the opening guard is `wallet_decide_spend`'s own line, character for character.
**Named rather than quietly decided:** a CHILD filing a spend request is refused
here, and is refused by that policy today for the same reason, even though
`requestSpendAction` is written as though a child can ask. Letting a non-manager
create a held ledger row is a product decision with its own approval and is not
this migration's to make; what changes is that the refusal now arrives as
`forbidden` instead of a raw policy error.

**Verified on the audit database** (352 migrations replayed): applied cleanly —
`CREATE FUNCTION / COMMENT / REVOKE / GRANT` and the verification block's
`0342 OK` notice — and **re-applies unchanged**, every statement being `create or
replace` plus idempotent grants. Live grants afterwards are
`{postgres=X/postgres,authenticated=X/postgres}`: `authenticated` only, matching
every `0205`/`0208` money RPC, and deliberately **not** `service_role` (the one
caller is a cookie-bound server action; the webhook keeps
`wallet_reserve_card_auth` and `debitCardSpend`).

`docs/audit/a-child-cannot-spend-the-same-dollar-twice-check.sql` holds it, and
was **shown to fail before being trusted**: exit **0** as written, exit **3**
against a mutated definition with the `for update` removed and the total
narrowed to `completed` ("an $8 in-app spend was approved while an $8 card hold
already reserved the money"). Its negative control replays the pre-`0342`
read-then-insert shape on its own $10 bucket, through the same RLS the old path
went through — snapshot taken, another spend lands, write issued from the
snapshot — and **requires** the overdraft to land and the bucket to end at
**-600 cents**, failing loudly if it does not. It is a single-connection probe
and says so in its own header: it demonstrates that the decision and the write
are one statement over the current ledger, not that the lock serializes. The
two-connection race for the card path is `docs/audit/wallet-concurrency-check.sql`,
and a spend-path twin of it belongs beside this one.

**Ships with its application change.** `debitSpendBucket` now calls the RPC
instead of reading and inserting, and the `wallet_audit_logs` write moved out of
TypeScript into the function so money cannot move without a trail. Until this is
applied the RPC does not exist, so every spend returns "Could not post that
wallet debit." — this migration and `lib/wallet/server.ts` go together, which is
the one ordering constraint on this row. The external signature and return shape
of `debitSpendBucket` are unchanged, including the exact "Only $X available in
Spend." sentence, so `app/(app)/wallet/actions.ts` is untouched.

### `0343` makes "only a parent hands out an assistant key" true in the database — unapplied

`0343_only_a_parent_mints_or_revokes_an_assistant_key.sql` (SRV-001 lead `m9`).
An assistant key is a standing bearer grant over the household: whoever holds
one can have `POST /api/assistant` read the family's calendar, tasks and
shopping list aloud and, with the `capture` scope, write events, notes,
groceries and to-dos back. The app says only a parent may hand one out —
`canManage` in `app/(app)/dashboard/assistants/actions.ts` is `isAdmin(role)` —
and `0283`'s own header says the same in words. `0283`'s policies said
something else: they were written against `can_manage_family()`, which is
`role in ('parent','adult')` (`0003`), rather than `is_family_admin()`, which
is the parent-only predicate two definitions further down. And because both of
the action's writes go through the service-role client, which is `BYPASSRLS`,
the parent-only rule was a TypeScript `if` on the app's own path while
`/rest/v1/assistant_links` stayed open to any member's JWT under the weaker
predicate.

So an **adult** — the one role on which the two predicates disagree — could,
with their own browser client: mint a live key whose secret only they knew,
stamped as the parent's; widen the parent's read-only kitchen speaker to one
that writes; revoke a parent's key and then un-revoke it; or delete it, which
cascades `assistant_link_events` and erases the "every use is recorded" trail
the page promises. A child was already refused.

**What closes it** is three `RESTRICTIVE` policies (insert, update, delete) on
`is_family_admin(family_id)` — `0254`'s mechanism, as reaffirmed by `0306`,
`0310`, `0322` and `0325` — so no permissive policy, present or added later,
can grant past them. `SELECT` is deliberately untouched: members are meant to
see that a speaker is connected. The migration ends with a block that raises if
the three guards are not in force, rather than "applying" against a table
still open to an adult.

**Nothing legitimate breaks, and that was checked rather than assumed.** The
only writers of `assistant_links` in the application are the two in
`assistants/actions.ts` and the `last_used_at` touch in
`lib/assistant/service.ts`, and all three run on the service-role client
(`app/api/assistant/route.ts` builds its client with `createServiceClient()`),
which bypasses RLS.

**Evidence.** `tests/only-a-parent-mints-or-revokes-an-assistant-key.test.ts`
replays every `create`/`drop policy` and `grant`/`revoke` on the table across
the whole corpus and evaluates each request the way Postgres does — grant,
then any permissive, then every restrictive — with the predicates parsed from
the migration that defines them. It was **shown to fail before being trusted**:
with the migration absent it is red (6 of 9), with it present green.

**Two things this entry does not close, named so they are not assumed closed.**
`0343` ships no `docs/audit/*-check.sql` probe yet, unlike `0340`-`0342`, so a
production pre-flight cannot tell whether it ran; one is being written. And
`resolveAssistantLink` (`lib/assistant/service.ts:54-60`) matches on the token
alone — a key keeps working if the parent who minted it later leaves the family.
Whether a key belongs to the person or to the household is a product question,
and it is recorded here rather than decided.

### `0349` keeps one saved copy of a provider recipe per family — unapplied

`0349_one_saved_copy_of_a_provider_recipe_per_family.sql` (SRV-001 lead
`m31`). "Save to vault" in `app/(app)/dashboard/recipes/discover/actions.ts`
de-duplicates by probing `(family_id, source_provider, source_recipe_id)`
before it inserts. `0054` indexed that triple but never made it unique, so the
probe is a best-effort look: two members tapping Save on the same TheMealDB
recipe in the same second, or one member on a phone and a laptop, both probe
empty and both insert, and the vault carries two identical cards from then on.
A check in a server action is a check a second concurrent request steps
straight over; only the database can close that window.

**What closes it** is a partial unique index on the triple, `where
source_recipe_id is not null and source_provider is not null and
source_provider <> 'bubaly_ai'`. Partial on purpose:
`app/api/recipes/transform/route.ts` writes several rows sharing `(family_id,
'bubaly_ai', <vault recipe id>)`, one per AI variant of the same recipe, and a
blanket index would refuse the second variant. Hand-typed recipes carry no
source and are outside it too. On a database that already holds a duplicate
pair the migration names the rows and stops, because collapsing them is a data
decision: a stale copy may already be a meal-vote option or sit in a meal-plan
slot.

**Ships with its application half, and each half stands alone.** The action now
reports a failed vault probe instead of reading it as "not saved yet", and saves
under a category the vault accepts (`m31`). Until 0349 is applied, the race
above can still produce a second card.

**Evidence.**
`docs/audit/a-family-vault-holds-one-saved-copy-of-a-provider-recipe-check.sql`
runs its negative control first (a member's first save, a save with the recipe
id flipped, and a second member saving a different recipe all land), then
requires the second save of the same recipe, the second member's save of it,
and an UPDATE that repoints a saved row onto it to be refused by
`uq_family_recipes_source` by name. Without the migration it is red on the
race assertion ("BOTH saves landed"); with the write grant revoked it is red on
the control; with the right index under another name it is red on attribution.

### `0352` stops a child clearing the household's money warnings — unapplied

`0352_a_child_cannot_clear_the_households_money_warnings.sql` (SRV-001 lead
`m26`). `money_timeline_insights` holds the Financial Copilot's advisories and,
per row, whether the family has acknowledged or dismissed each one. `0168` gave
all four commands to `is_family_member` (membership, not role), and nothing
since has narrowed it: `0267` and `0275` list the finance tables by name, and
this one is not on either list. The row is family-wide by construction
(`unique (family_id, dedupe_key)`), so one write decides what the whole
household sees. Replayed on a throwaway Postgres, a member with role `child`
sent the exact upsert the Dismiss button sends and cleared the `urgent`
low-balance advisory from the parents' page too, and a `guest` deleted the row
outright. The page does not step a child up (`needsStepUp` is manager-only), and
the module has no view of what was dismissed, so a parent could not see or undo
it.

**What closes it** is `insert`/`update`/`delete` re-created on
`can_manage_family(family_id)`, plus the three `RESTRICTIVE` manager guards
`0275` gives the finance group, a sweep of stray permissive write policies by
their shape, and an end-state assertion that raises. `select` stays on
`is_family_member`, for `0267`'s stated reason: a member reading the forecast is
a product decision. `anon` loses its write grant on this one table (`0290`'s
treatment).

**Ships with its application half, and each half stands alone.** The actions in
`app/(app)/dashboard/money-timeline/actions.ts` refuse a non-manager with a
sentence rather than a bare policy error, validate the client's payload against
`0168`'s own checks, and report a refused write instead of revalidating as if it
had landed (`m27`). The module shows a child the forecast without the Dismiss
buttons. Until 0352 is applied, `/rest/v1` still lets a child write.

**Evidence.** Two probes, both run by CI's database job after replaying every
migration. `docs/audit/a-child-cannot-clear-the-households-money-warnings-check.sql`
fails with 11 named breaches on the `0168` state and passes after 0352 (applied
twice). `docs/audit/only-a-parent-or-an-adult-clears-the-households-money-warnings-check.sql`
runs its negative control first (a parent and an adult making the same writes
must land) and went red on that control when the write grant was revoked with
0352 in place.

### `0360` takes a head-out reminder off the calendar with its departure plan — unapplied

`0360_a_head_out_reminder_goes_with_its_departure_plan.sql` (SRV-001 lead
`m41`). Smart Departure writes a "🚗 Head out for …" calendar event for each
plan and links it from the plan (`departure_plans.reminder_event_id`); the link
runs plan → event only. `00981` made `departure_plans.event_id` `ON DELETE
CASCADE`, so deleting the event a plan was for — the calendar's Delete button,
the bulk delete, the assistant's delete tool — deletes the plan and leaves its
reminder on every member's calendar, where the daily notifications run turns it
into a push and an email for a trip that no longer exists. With the plan gone,
nothing in Trip Intel can move or remove it.

**What closes it** is an `AFTER DELETE FOR EACH ROW` trigger on
`departure_plans` that deletes the plan's reminder, fenced by `family_id =
old.family_id`. It is `SECURITY INVOKER`: on the cascade path it fires as the
member who deleted the event (measured on the replayed schema), so
`calendar_events` RLS still decides what it may delete. Neither foreign key
changes: deleting a reminder by hand still leaves its plan, which a refresh
repairs.

**Ships on its own.** The application does not call anything 0360 creates.
The app-side halves of the same audit — a save that validates the plan's limits
before writing the reminder and takes a just-written reminder back if the plan
is refused (`m39`), and a Remove that fails closed on a failed read or a
refused reminder delete (`m40`), both in `app/(app)/dashboard/trip-intel/actions.ts`
— are live on merge. Until 0360 is applied, deleting the event a plan was for
still strands its reminder.

**Evidence.** `docs/audit/a-head-out-reminder-goes-with-its-departure-plan-check.sql`
deletes the event as a signed-in member and requires the plan and its reminder
gone, a same-titled hand-typed event untouched, the Remove button's order still
working, and the family fence holding for an owner-level delete. It was **shown
to fail before being trusted**: without 0360 it is red (the reminder stays), and
with 0360's family term removed it is red (the other household's event is
deleted); its own negative controls repeat both inside the transaction.
`tests/a-head-out-reminder-never-outlives-its-departure-plan.test.ts` covers
the application halves against a fake that enforces 00981's CHECKs and both
foreign-key actions.

**Not closed, named so they are not assumed closed.** Reminders already
stranded in production are not swept — telling one from an event a person typed
with the same title would be a guess. Notifications already created for one are
not removed (`notifications.related_id` has no foreign key). And the save in
`m39` is compensated, not atomic: if the request dies between writing the
reminder and writing the plan, or the compensating delete also fails (logged,
and the family is told), the reminder stays. Making it atomic means moving both
writes into one database function that every save depends on, which cannot ship
while production cannot take migrations.

### `0381` makes "two parents" mean two parents in the database too — unapplied

`0381_two_parents_means_two_parents_in_the_database_too.sql` (SRV-001 leads
`m7+m8`). Settings → Trust & Permissions offers "Just one parent or adult",
"Two parents" and "Every parent and adult", and the whole point of the second
and third is that ONE person cannot authorise the thing alone. That rule lived
in TypeScript only — `thresholdOf` / `decide` / `editAndApprove` in
`lib/services/approvals/index.ts`. The surviving UPDATE policy for a manager on
`approval_requests`, 0251's `approval_requests_decide`, names no column, so any
signed-in adult could `PATCH /rest/v1/approval_requests?id=eq.<id>
{"status":"approved"}` with the browser session and the database said yes: the
request closed, the second parent could never vote, and `trust_audit_logs` got
no decision row because `auditDecision` only runs inside `decide()`.

**What closes it**: `approval_votes_satisfy(family, model, required, approvals)`
mirrors `lib/approvals/threshold.ts` in SQL; a BEFORE UPDATE trigger,
`approval_requests_decision_is_earned`, refuses a move into `approved` or
`modified` unless the row's own `approvals` satisfy its `approval_model` and
`required_approvals`, refuses a vote signed as someone else, and refuses
removing another decider's vote; `approval_requests_rule_is_immutable` refuses
changing the model, the threshold or the requester on a pending row. Both
functions are `revoke all … from public, anon, authenticated` and run only from
their triggers. Replay-safe (`drop trigger if exists` before `create`).

**Ships on its own.** The application half is live on merge: the approval card
shows what an earlier approver changed (`approval.alreadyChangedByAnApprover`),
the concierge panel's Approve and Dismiss route an approval-backed run through
`decide()` — one decision surface instead of two — and a finished plan is
stamped `state = 'completed'` with `completed_at`, so it counts in the family's
week. Until 0381 is applied, a single adult with the browser session can still
close a two-parent request over `/rest/v1`.

**Evidence.** `docs/audit/two-parents-means-two-parents-check.sql` — its
negative control runs first (the same adult's vote on a `single` request, and
their second vote on a `two_parents` request, both LAND), then one adult's flip
of a two-parent request to `approved`, a vote signed as the other parent, and a
rewrite of the model on a pending row must each be refused by 0381's named
trigger. Mutation-tested three ways on private clones of a HEAD template with
the migration applied: as written (exit 0), the guard loosened (red on a
refusal), a decoy refusing every write with the guard intact (red on the
control). `tests/one-adult-cannot-approve-what-the-family-said-needs-two.test.ts`
covers the service half and the panel's routing.

**Recorded rather than closed.** (1) A `rejected` decision is not final in the
database: on a `single` row another manager may remove the rejecting vote and
add their own — before 0381 any manager could flip anything, so this is not a
regression, but it is not closed. (2) `lib/ai/runs/executor.ts` still runs the
raw `edited_payload` of `plan_steps` rows with `skipTrust`; the comments now say
so, and a manager can still PATCH that column on a pending row. (3)
`executeQueuedRunAction` routes through `decide()` only when the run's own
`metadata.approval_id` is set, and `family_automation_runs_update` (0251) is
bare `can_manage_family` with no column pin — an adult can PATCH the metadata to
drop `approval_id` and then tap "Do it", materialising the plan with no vote
while the two-parent approval stays pending. The rows it creates are ones an
adult can already write directly, so the severity is low; recorded under
SRV-001 as an open lead for a follow-up migration that pins the column.

### `0382` makes a password alone unable to delete the family's budget — unapplied

`0382_a_password_alone_does_not_delete_the_familys_budget.sql` (SRV-001 leads
`m10+m11`; `O-03` from the database side). Two-step sign-in is an opt-in control
a family turns on so that a stolen password cannot reach the money. Nine money
pages send an `aal1` manager to `/auth/step-up`, and that was the whole
enforcement: no policy anywhere read the JWT's `aal` claim, and the money
tables' write policies (0275, superseding 0267) are `can_manage_family`, a
ROLE, which a parent on a password-only session satisfies completely. Someone
who has the password and not the authenticator holds a valid `aal1` session,
and the anon key plus that session's JWT reach PostgREST directly — `DELETE
/rest/v1/budgets?id=eq.<id>` — with no page rendered and no server action run.
The same hole was open through the browser on `/dashboard/billing`, where
`deleteBill` / `markBillPaid` / `deleteAccount` wrote straight to PostgREST.

**What closes it**: `session_cleared_step_up()` mirrors `needsStepUp`
(`lib/auth/mfa.ts`) exactly — true when the session is `aal2`, OR when the user
has no verified TOTP factor enrolled, so a family that never set up an
authenticator sees no change — and a RESTRICTIVE insert, update and delete
guard per money table uses it: `budgets`, `savings_goals`, `bills`, the tables
written only from the step-up-guarded money area (`transactions` and
`financial_accounts` are left out for the reasons in the header). Restrictive,
so it ANDs with whatever permissive policy drift has left and cannot be
satisfied by adding a broad policy beside it. Replay-safe.

**Ships on its own.** The application half is live on merge: every money
action in `app/(app)/dashboard/billing/actions.ts` requires `aal2` where the
money pages already did, the billing page itself sends an `aal1` manager to
step-up with a return path (`returnPathWith`), and the twelve client call sites
route a refusal through `reportRefusal` (`lib/auth/step-up-client.ts`), which
sends the family to the step-up page instead of showing a bare error
(`actions.moneyNeedsYourCodeAgain`). Until 0382 is applied, a password-only
session can still reach the money tables over `/rest/v1`.

**Evidence.** `docs/audit/a-password-alone-does-not-delete-the-familys-budget-check.sql`
— control first (an `aal2` manager, and a manager with no factor enrolled, both
write), then an `aal1` manager with a verified factor is refused a delete and an
insert on `budgets` and an update on `savings_goals` and `bills`, and the
function's grants are read back. Mutation-tested three ways on private clones
of a HEAD template with the migration applied (as written 0, guard loosened
red on a refusal, decoy red on the control).
`tests/a-password-alone-does-not-empty-the-family-finances.test.ts` and
`tests/require-aal2.test.ts` cover the action and page halves.

### `0383` makes an archived page take its public answers with it — unapplied

`0383_an_archived_page_takes_its_public_answers_with_it.sql` (SRV-001 leads
`m1` and `m2+m3`). Generated FAQ answers do not live in the page row: they are
rows in `marketing_aeo_questions`, world-readable on one predicate (0228's
`status = 'published'`) with no join back to their source page. So when a page
left the public set — archived, deleted, renamed, or a blog post unpublished —
its own route went dark but its answers kept rendering: on /faq's Knowledge
Center tab and in its FAQPage structured data, in every still-live article of
the same category, and with a body that ends "Read the full guide at
/blog/<slug>" for a URL that now answers 404. Nothing self-healed it: 0237's
regeneration trigger is switched off for exactly this case, and the hand-retry
paths select the page `.is('deleted_at', null)`.

**What closes it**: four AFTER … FOR EACH ROW triggers on `marketing_pages` and
`blog_posts`, bound to two SECURITY DEFINER functions with a pinned
`search_path` (`retire_marketing_aeo_on_page_hidden`,
`retire_marketing_aeo_on_post_unpublished`; EXECUTE revoked from public, anon
and authenticated), that move the page's PUBLISHED answers to `answered` — the
status `runQuestions` itself writes for an unpublished page — inside the same
transaction as the take-down, so there is no window. Only published rows move;
an `opportunity` or `drafting` row an admin is mid-way through keeps its
status, and the editorial text survives for a later re-publish. **This
migration rewrites rows on apply**: answers already orphaned by pages that are
archived, deleted or unpublished today are moved to `answered` first, and
re-pointed or blanked `blog_aeo_v1` rows are handled by the same backfill (its
first cut refused to apply over exactly that drifted data; the probe below
re-applies it over both shapes).

**Ships on its own.** The application half is live on merge: the take-down
actions (`archivePlatformPage`, `updatePlatformPage`, `archiveContentAction`,
`unpublishBlogPostAction`, the legacy bridge's three paths) retire the answers
themselves, so the fast path is closed before the migration; a brand rule can be
corrected after it is saved and a retry re-queues the job it was clicked on
(`m2+m3`). Until 0383 is applied, a take-down that bypasses the actions — the
cron worker, `scripts/backfill-*.mjs`, the SQL editor — still leaves the answers
public.

**Evidence.** `docs/audit/an-archived-page-takes-its-public-answers-with-it-check.sql`
(control first: the super admin and service role can still write every column
the take-downs write; then archive, delete, rename and unpublish each retire
exactly their page's published answers and no sibling's; no role may EXECUTE
the trigger functions) and
`docs/audit/a-renamed-page-leaves-no-public-answer-behind-check.sql` (a rename
of a live page retires the old path's answers and no sibling's, and step 3
re-applies 0383 over re-pointed and blanked rows). Both mutation-tested three
ways on private clones of a HEAD template with the migration applied.
`tests/an-archived-page-takes-its-public-answers-with-it.test.ts` covers the
actions and guards the CI wiring that executes the probes.

### `0384` stores the urgent fallback number the only way it can be used — unapplied

`0384_the_urgent_fallback_number_is_stored_the_only_way_it_can_be_used.sql`
(SRV-001 leads `m13+m14`). `family_contact_channels.forward_to_phone` is the
number the family says to call or text when something at their Contact Center
line is urgent. 0214 created it with the comment "optional human fallback
(E.164)" and no constraint, and the write path stored whatever was typed —
while every consumer requires E.164 and none can say so: `sendSmsWithReceipt`
refuses anything else as `invalid_message` (the urgent text never left the
server, and the receipt's error is rendered on no screen), and `twimlDial`
interpolates the value into a `<Dial>` element, so a stored `&` or `<` made the
TwiML unparseable and the caller heard an application error. The field's own
placeholder was "+1 555 123 4567" — with spaces — so typing exactly what the UI
taught produced a fallback number that never once worked.

**What closes it**: the column gets the CHECK its comment already claimed
(`forward_to_phone is null or forward_to_phone ~ '^\+[1-9][0-9]{7,14}$'`),
added only if absent. **This migration rewrites rows before it constrains
them**: every value that is not already E.164 is copied to a new
`forward_to_phone_legacy` column, then normalized the way
`lib/contact-center/phone.ts` does it — a `+`-prefixed number with spaces,
dots, dashes or parentheses becomes its digits behind the `+`; anything else
becomes NULL. No country code is guessed: a bare ten digits is not read as +1,
because an Italian or Mexican mobile typed the local way would become a valid
American number and the urgent text would be delivered to a stranger. Nothing a
parent typed is destroyed; the legacy column keeps it, and the app never reads
that column. Replay-safe: `add column if not exists`, the UPDATE matches only
rows still outside the pattern, the CHECK is added inside a `pg_constraint`
guard.

**Ships on its own.** The application half is live on merge: the server
action normalizes through `normalizeFallbackPhone` and refuses with a sentence
that says the form the number needs (`actions.enterTheFallbackNumberIn`); the
one-number-per-family provisioning path no longer leaves a second billed number
behind. There is no client INSERT or UPDATE policy on this table (0214 grants
SELECT only) and every write goes through the service role, so this is defence
in depth for the next write path rather than a boundary a client can route
around today.

**Evidence.** `docs/audit/the-urgent-fallback-number-is-stored-the-only-way-it-can-be-used-check.sql`
— control first (the service role stores an E.164 number and a NULL, both
land), then a spaced, a letter-bearing and a `<`-bearing value must each be
refused by the named constraint, and a legacy row planted before the migration
is shown normalized with its original kept. Mutation-tested three ways on
private clones of a HEAD template with the migration applied (as written 0,
constraint dropped red on a refusal, decoy red on the control).
`tests/the-urgent-fallback-number-a-parent-types-still-reaches-their-phone.test.ts`
covers the normalizer and the action, `tests/one-family-keeps-one-number-and-nothing-is-left-billing.test.ts`
the provisioning path.

### `0385` gives family_facts the member rule the service already applied — unapplied

`0385_a_member_only_rewrites_their_own_memory.sql` (SRV-001 lead `m21`). 0264
narrowed `family_facts` UPDATE and DELETE by CATEGORY only — `medical` and
`account` to managers — so on the seven ordinary categories any member of the
household could rewrite or delete any row, including the household-level facts
(`member_id` null, the Add form's default "The family") a parent entered for
everyone. The service (`lib/services/memory/index.ts`) has carried the member
rule since the knowledge module shipped, but `knowledge-base-module.tsx` and
`life-events-module.tsx` read `family_facts` from the browser on the caller's
own RLS-bound client, so the same client could issue the UPDATE directly; and
`rememberConfirmed` probed by (family_id, ilike label, member_id) and UPDATEd
whatever it found — re-typing "Emergency contact" into Add replaced the parent's
number, no id needed.

**What closes it**: `family_facts_update` and `family_facts_delete` are
re-created with `mayChangeFact`'s rule — `can_manage_family(family_id) OR
is_self_member(member_id) OR created_by = auth.uid()` — on top of 0264's
category clause; SELECT and INSERT untouched. `drop policy if exists` before
`create policy`, so a replay is clean.

**Ships on its own.** The application half is live on merge (`m21`):
`mayChangeFact` is applied on the create path as well as the pencil,
`rememberConfirmed`'s label probe refuses a row the caller may not write, and
Add applies the sensitive-category rule. Until 0385 is applied, a member with
the browser client can still rewrite a parent's household fact over `/rest/v1`.

**Evidence.** `docs/audit/a-member-only-rewrites-their-own-memory-check.sql` —
its negative control runs first (the same teen rewrites HER OWN ordinary memory
with the very statement the refusals use, and it must land), then the teen's
UPDATE, `created_by` claim, `member_id` re-point and DELETE of the household's
and her sibling's memories must each be refused, with SELECT shown still open
to the household. Mutation-tested three ways on private clones: as written
(exit 0), the policy loosened to 0264's shape (red on a refusal), a decoy
refusing every write with the guard intact (red on the control).
`tests/the-add-form-is-not-a-way-around-the-memory-edit-gate.test.ts` covers the
service half and reads this file's text for the rule it mirrors.

**Not closed, named so it is not assumed closed.** Ownership keys on
`created_by`, which is set on INSERT only: a manager who corrects a fact a teen
filed does not take it over, so the teen can still rewrite the corrected value
(recorded under SRV-001 as a residual). And INSERT stays open on the ordinary
categories with no uniqueness on (family_id, member_id, label), so a second
"Emergency contact" row can be filed beside the parent's over `/rest/v1`; the
app's Add path refuses it, RLS does not.

### `0386` lets a family subscribe to a calendar URL once — unapplied

`0386_a_family_subscribes_to_a_calendar_url_once.sql` (SRV-001 lead `m36`).
0045 created `calendar_feeds` with `url text not null` and no uniqueness on it.
`addCalendarFeed` inserted the row, committed it, then tried the first sync;
when that sync failed (a school calendar behind a login, a timeout, a file over
1 MiB) the row stayed and the panel kept the URL in the form, so the next press
inserted a second row for the same URL, and the next a third. Once the URL
answered, each row imported the same events under its own `feed_id` —
`uq_calendar_events_feed_uid` (0285) is keyed on (feed_id, external_uid) — so
every school event sat on the family calendar two or three times.

**What closes it**: `create unique index if not exists
uq_calendar_feeds_family_url on calendar_feeds (family_id, url)`, the shape
`weekend_feeds` (0072) and `library_feeds` (0284) already carry. Before building
it the migration looks for a family that already holds two rows for one URL and
stops, naming each row with its status and event count, rather than letting
Postgres's terse error say nothing: collapsing them is a data decision, because
every duplicate owns its own imported events (`calendar_events.feed_id … on
delete cascade`, 0045) and a member may have edited the copy that would go.

**Ships on its own.** The application half is live on merge (`m36`):
`addCalendarFeed` looks for the family's row for the URL first and re-syncs it,
refuses a normalized URL over 2048 characters before it reaches the index,
removes a row it created whose first sync failed (and says so when it cannot),
and catches 23505 from the index by re-reading and syncing the winner's row.
Until 0386 is applied, two members adding the same calendar in the same moment
can still both insert.

**Evidence.** `docs/audit/a-family-subscribes-to-a-calendar-url-once-check.sql`
— its negative control runs first (the same member inserts a URL their family
does not hold, and updates their own feed's URL to another the family does not
hold; both must land), then the second insert of a URL the family holds, and an
UPDATE that would make two rows share one, must each be refused with 23505 by
`uq_calendar_feeds_family_url` and by nothing else.
`tests/a-calendar-that-failed-to-add-is-not-a-subscription.test.ts` covers the
action: a failed first sync leaves no row and is retried against one
subscription, an already-subscribed URL is re-synced rather than added, the
loser of a same-moment race syncs the winner's row, a failed lookup adds
nothing, and an over-long link is refused before anything is saved.

### `0387` puts the publish lock and a trip's document link in the database — unapplied

`0387_a_child_cannot_lift_the_publish_lock_or_link_a_document_they_cannot_read.sql`
(AUTHZ-011). Three guards, one migration:

- **`social_settings`**: three RESTRICTIVE policies (insert, update, delete) on
  `social_has_permission(family_id, 'manage_settings')`, the same rule
  `updateSettingsAction` applies. Until it is applied, any member can turn off
  `require_approval` (the family's stop on publishing) or delete the row over
  `/rest/v1`. SELECT stays open because `needsPublishApproval` reads it on the
  publisher's own client.
- **`vacation_documents.document_id`**: a SECURITY INVOKER BEFORE trigger. A
  trip may link a document only if the caller can read it (through
  `documents_select`) and it belongs to the trip's household. The Trip →
  Documents form never writes the column and is unaffected.
- **`documents.family_id`**: a SECURITY DEFINER BEFORE UPDATE OF `family_id`
  trigger that refuses to move a document to another household while a trip
  links it. EXECUTE is revoked from public, anon and authenticated.

**Data it changes on apply.** Any `vacation_documents.document_id` that already
points at another household's document is set to NULL, and a NOTICE reports how
many. A pointer at a sensitive document of the row's own household is left
alone: `created_by` is supplied by the client, so a link a child planted cannot
be told apart from one a parent made.

**Ships on its own.** No application code changes with it. It ends with a DO
block that raises unless all five guards are in force as described.

**Evidence.**
`docs/audit/a-child-cannot-lift-the-publish-lock-or-link-a-document-they-cannot-read-check.sql`
tests each guard behind its own negative control. It passes on a full replay.
It fails on a replay with the guards dropped, and it fails with only the
documents trigger dropped. `tests/a-child-cannot-lift-the-publish-lock-or-link-a-document-they-cannot-read.test.ts`
replays the migration corpus and evaluates the policies and triggers.

**Not closed, named so they are not assumed closed.** An upsert
(`INSERT … ON CONFLICT DO UPDATE`) into `vacation_documents` that re-sends an
unchanged sensitive pointer is checked as an INSERT and refused for a caller who
cannot read the document. No writer upserts this table. `vacation_flights` and
`vacation_tickets` carry the same `document_id` column with the same FK, and
this migration does not guard them. Nothing in `app/`, `lib/` or `components/`
writes either column or follows it today.

### `0389` makes a decision, once made, stay made — unapplied

`0389_a_decision_once_made_stays_made.sql` (SRV-001, the residual the m7+m8
re-review recorded: "a rejection is not final in the database"). 0381 put the
approval model into the database — a vote is the voter's own, a move INTO
approved/modified needs the yeses the row's model asks for, the rule columns
are frozen — and, deliberately, gated nothing after the decision. That left the
other direction open: `approval_requests_decide` (0251) is `can_manage_family`
on USING and WITH CHECK with no status predicate and no column pin, so on a row
a parent has DECLINED any manager can, with the browser session and one PATCH
over `/rest/v1`, re-open it (`{"status":"pending","approvals":[]}` — rule A
permits taking votes away, rule B does not run), or on a `single` /
`first_available` / `sequential` row approve it outright with their own yes,
or on a `two_parent` row where the other parent approved swap their own "no"
for a "yes" and flip. The same door works approved → rejected, expired →
pending and cancelled → pending. The application never leaves a decided status
(`openForDecision` refuses with "This request was already decided."; every
status writer predicates on `status = 'pending'`).

**What closes it**: one BEFORE UPDATE trigger, `approval_requests_decision_is_final`
(function `approval_decision_is_final`, SECURITY INVOKER, EXECUTE revoked from
public, anon and authenticated), for callers subject to row-level security:
rule D — once `status` is anything but `pending`, `status`, `approvals`,
`edited_payload`, `decided_by` and `decided_at` cannot change; rule E — `payload`,
the ask the votes are votes on, cannot change for the life of the row. What the
application still writes to a decided row (`executed_at` / `execution_result`
from `stampExecution` on both paths and the private-purchase result stamp;
`consequences`, `request_id`, `payload_kind` attached after filing) is untouched.
errcode 42501. 0251's policy and 0381's three rules are left exactly as written.
Replay-safe (`create or replace`, `drop trigger if exists` before `create`).

**Ships on its own.** The application half is live on merge: the run executor
now derives what it runs through the same `effectiveArgsOf` the approval card
and `decide()` use (`approvedArgsFor` in `lib/ai/runs/executor.ts`), so a value
written to `edited_payload` directly cannot reach a tool from that side either.
Until 0389 is applied, a manager with the browser session can still re-open or
flip a decided request over `/rest/v1`.

**Evidence.** `docs/audit/two-parents-means-two-parents-check.sql`, extended:
the re-open of a declined two-parent row, the declined `single` → approved flip
in one PATCH (passes 0381's A and B; only 0389 refuses), the un-expire, the
approved → rejected reversal, the post-decision edit and the payload rewrite on
a pending row are each refused by the named trigger; the execution stamp on a
DECLINED row and the existing stamps LAND; the negative control drops ONLY
`approval_requests_decision_is_final` (0381's triggers still in force) and
requires the flip and the re-open to land. `tests/a-decision-once-made-stays-made.test.ts`
reads the migration for the exact rule and the probe for its cases.

### `0390` keeps a queued run's gate where the server put it — unapplied

`0390_a_queued_run_keeps_the_gate_it_was_born_with.sql` (SRV-001, the residual
"an adult can PATCH `family_automation_runs.metadata` to drop `approval_id`").
When an accepted concierge plan lands on the family's "ask first" dial, the
action files an approval and a `family_automation_runs` row whose
`metadata.approval_id` records that a vote stands between the line and the
calendar. The "Do it" button read that key and branched on it — present →
`decide()`, absent → materialise the plan directly. `family_automation_runs_update`
(0251) is `can_manage_family` with no column pin and the table's one trigger is
`set_updated_at`, so an adult could PATCH the key away and tap "Do it": the plan
was materialised with no vote while the two-parent approval stayed pending. The
lead was WIDER than recorded: 0255/0329 also let a manager INSERT a fresh run
row with no approval at all, so a pin on UPDATE alone could never be the fix.

**What closes it** is in the ACTION, live on merge: `executeQueuedRunAction`
and `dismissQueuedRunAction` resolve the governing approval from
`approval_requests` by the plan it names (`payload->>'plan_id'`, which 0389
freezes) and never from the run's metadata; a run that claims an approval
Bubaly cannot find, or whose approval is already decided, does nothing and
says so (three sentences, seven locales). **What this migration does** is keep
the cache honest for the rows the server wrote: rule F — for RLS-subject
callers, once `metadata->>'approval_id'` or `metadata->>'plan_id'` is non-null
it cannot be removed or changed; every other key stays writable. No user
session updates `metadata` today, so it refuses no live path. Deliberately not
attempted: refusing `status = 'executed'` while a pending approval names the
plan, because the approve path closes the run on the deciding parent's own
session after the flip and a second pending approval for the same plan would
make that honest close fail. errcode 42501. Replay-safe.

**Evidence.** `docs/audit/automation-runs-pin-what-a-member-may-queue-check.sql`,
extended: a manager dropping `approval_id` or pointing it elsewhere is refused
by the named trigger; the same manager adding an unrelated key LANDS; the
negative control drops ONLY this trigger and requires the scrub to succeed.
`tests/scrubbing-a-runs-metadata-does-not-skip-the-vote.test.ts` drives the
action against a run whose metadata was scrubbed and against a row born without
an approval, and asserts nothing is materialised until the vote passes.

### `0391` gives the document vault's step-up a counterpart in the database — unapplied

`0391_a_password_alone_does_not_open_the_familys_vault.sql` (O-03, the
document half). Eight document pages ask a parent who enrolled two-step
verification for their code (`requireAal2(ctx, 'documents', …)`), and until
now that page guard was the whole enforcement: every policy on the tables
behind them is a membership or role check, so the same parent's password-only
(aal1) session could read every stored password, alarm code and tax
document, and change or delete them, over `/rest/v1`.

**What closes it**: reusing 0382's `session_cleared_step_up()` (no new
helper), RESTRICTIVE insert, update and delete guards on `family_credentials`,
`household_info`, `tax_documents` and `paperwork_items`, and a RESTRICTIVE
select guard on the first three (the step-up on passwords, binder and tax is a
read gate — the point is not to SEE the secret). Every guard is
`session_cleared_step_up() or not can_manage_family(family_id)`, the rule the
page applies: only a parent or adult is ever asked for a code, so a child or
teen who enrolled an authenticator for their own account is left to the
table's own policies rather than locked out of pages that never offer them a
code. The update guard carries the clause on both halves. Replay-safe.

**Ships on its own.** The application half is live on merge: the paperwork
server actions now ask for the code before touching a row (`paperworkScope`,
mirroring the money actions), send a refused family to the step-up page, and
confirm that a status change and the "marked as handled" stamp actually
landed (a filtered update no longer reports success, and a created calendar
event whose stamp did not land says so instead of inviting a duplicate).

**Deliberately NOT covered**: `public.documents` and the `documents` storage
bucket, the table the finding is named after. `/dashboard/home` writes and
deletes documents rows with no step-up, and a dozen surfaces outside the vault
(the home dashboard's expiring passports, household search, the chat
assistant, which signs file URLs) read sensitive rows on a password-only
session, so a guard would either break them silently or lie ("nothing
expiring"). Closing it needs three owner decisions, recorded in finalaudit's
O-03 row: whether enrolled managers are asked for the code at sign-in; what
the home page may do to vaulted documents; and how to guard stored files
with no documents row.

**Evidence.** `docs/audit/a-password-alone-does-not-open-the-familys-vault-check.sql`:
a control that the only thing refusing is the assurance clause; an enrolled
parent at aal1 reads nothing from the three secret tables and every write on
the four is refused; the same parent at aal2, and a never-enrolled family,
read and write; an ENROLLED CHILD at aal1 keeps exactly what the base
policies allow; the catalogue holds exactly fifteen guards, each carrying the
role clause, and none on documents; and a negative control that drops the
guard (or its role half) and requires the refused read to land. The two
existing credential probes now exclude these guards by what they are
(restrictive and calling the helper), not by name.


### `0419` retires the assistant keys of a parent who leaves the family — unapplied

`0419_a_departed_parent_keeps_no_assistant_key.sql` (SRV-001 l12). An
assistant key (`assistant_links`) is a standing bearer grant over the
household: Siri or Alexa, holding its secret, has `/api/assistant` read the
family's calendar, open tasks and lists aloud and, with the `capture` scope,
file events, notes, groceries and to-dos. Only a parent can mint one (0343),
and the key carries that parent's user_id. Removing a member only sets
`family_members.is_active = false`, and demoting one only changes `role`;
neither touched the key, and the resolver matched on the token hash and
`revoked_at` alone. So a co-parent removed from the household kept a working
key until someone found it on `/dashboard/assistants` (which does not say whose
key each one is) and pressed Revoke.

**What closes it**: an AFTER UPDATE (`is_active`, `role`, `user_id`,
`family_id`) OR DELETE trigger on `family_members`. Whenever the old
(family, user) pair no longer has an active parent row, it stamps
`revoked_at` on that pair's live keys in that family. SECURITY DEFINER with a
pinned search_path, because an adult may remove a parent (0211) but is refused
writes on `assistant_links` by 0343; EXECUTE revoked from the API roles. A
one-time backfill retires the keys already orphaned the same way; it touches
only `revoked_at`, and only on keys whose owner is not an active parent of the
key's family. Replay-safe.

**Ships on its own.** The application half is live on merge:
`resolveAssistantLink` resolves a key only while its owner is an active parent
of its family, and a failed membership read refuses. So production is closed
before this is applied; the migration retires the keys rather than only
refusing them.

**Evidence.** `docs/audit/a-departed-parent-keeps-no-assistant-key-check.sql`:
a parent removed by another parent (with that parent's own JWT), a parent
demoted, and a parent's row deleted each lose their live key; the remover's
own key, the removed parent's key in another household, an already-retired
key's stamp, a child's removal and an unchanged re-save are untouched; the
catalogue carries the trigger for UPDATE and DELETE and a definer function
the API roles cannot execute; and a negative control that drops only the
trigger leaves the removed parent's key live. Measured red with the migration
absent and with a trigger function that does nothing.

### `0420` lets only a released app be installed — unapplied

`0420_only_a_released_app_installs.sql` (SRV-001 l8). `family_apps.status` is
published, beta, coming_soon or retired, and the App Store page drew no
Install button for a coming-soon app — that was the whole rule. 0165's install
policies are `is_family_member(family_id)` and nothing else, so any member,
a child included, could install an unreleased app through the action or over
`/rest/v1`, and the card then showed "Unavailable" with nothing to press.

**What closes it**: two RESTRICTIVE policies on `family_app_installs`, for
INSERT (WITH CHECK) and UPDATE (USING and WITH CHECK), requiring the row's app
to be published or beta, `to authenticated, anon`. DELETE is deliberately left open, so an
install whose app later moved back to coming-soon can always be removed.
Existing rows are untouched. Replay-safe.

**Ships on its own.** The application half is live on merge: `installAppAction`
reads the app's status (strictly — a failed read refuses) and refuses anything
but published or beta with a sentence in seven locales, and an installed app
keeps its Remove control whatever its status now says. In production the
catalogue is empty (no migration seeds `family_apps`) and `/dashboard/app-store`
is linked from nowhere, so this is a boundary set before it is needed.

**Evidence.** `docs/audit/only-a-released-app-installs-check.sql`: a member
installs a published and a beta app; a coming-soon and a retired app are
refused with 42501 and nothing is written; an install cannot be re-pointed at
an unreleased app; an install whose app went back to coming-soon can still be
removed; exactly two restrictive guards and none on delete; negative control:
with the guards dropped the coming-soon install lands. Measured red without
the migration (five named failures).
### `0426`–`0443`, PR #548's block — all unapplied, and four numbers deliberately left empty

PR #548 numbered this block `0318`–`0338`, then `0361`–`0382`, and each time
`main` landed the same numbers first (its own `0318`–`0360`, then #579's
`0344`–`0380` and #581's `0381`–`0387`). It now sits at `0426`–`0443`, in the
range assigned to the PR, in its original order. Fourteen files:

| # | Subject |
|---|---|
| `0426_a_policy_should_say_what_it_checks` | Blanket family-member policies restated with the predicate they check — skipped wherever `main` has already replaced the blanket policy |
| `0428_a_reward_costs_what_the_parent_set` | An economy redemption names a reward and is charged that reward's price; `economy_decide_redemption` (0196) replaced in place |
| `0429_a_family_cannot_write_its_own_entitlement` | `subscriptions` and `billing_customers` are not the family's to write |
| `0430_a_health_record_is_not_a_siblings_to_rewrite` | Nine health tables |
| `0432_a_guardian_number_belongs_to_one_family` | A unique index on the Guardian phone number |
| `0433_the_terms_of_a_deal_are_fixed_when_it_is_struck` | Marketplace offer/order terms fixed once struck |
| `0434_a_prescription_is_a_parents_to_write` | Medications |
| `0435_a_childs_own_record_is_not_theirs_to_rewrite` | `grades` and `screen_time_limits` |
| `0438_a_diagnosis_is_not_the_familys_to_browse` | `medical_profiles` reads, and `family_allergies()` for the household's allergies |
| `0439_a_reward_is_paid_for_with_points_that_exist` | A reward-balance trigger on `reward_redemptions` |
| `0440_a_device_is_buzzed_once_per_notification` | `push_deliveries` |
| `0441_an_email_event_is_counted_once` | `apply_resend_campaign_counter()` |
| `0442_a_childs_milestones_are_a_parents_to_mark` | `independence_milestones` |
| `0443_a_family_gets_one_default_list` | `ensure_default_grocery_list()` / `ensure_default_todo_list()` (DATA-007) |

**Deploy coupling, where it was checked.** `0438` is **coupled with app code**:
`addFromMealPlan` (`lib/services/groceries`) and the meal service
(`lib/services/meals`) read allergies through `family_allergies()` with no
missing-function fallback, so on a schema without `0438` both fail closed
("Could not read …") — apply it before, or with, the deploy that ships this
code. `0441` and `0443` are safe before apply: their callers take `PGRST202` as
"not migrated yet" and use the path that ran before. The other files' deploy
order is not asserted here.

**`0427`, `0431`, `0436` and `0437` are deliberately empty.** Each was this
PR's fix for a subject `main` had since closed, and each, laid after `main`'s,
replaced or widened `main`'s rule. They are recorded rather than renumbered, as
`0334` and `0337` are:

| Empty | Was | Duplicates | Shown by |
|---|---|---|---|
| `0427` | a driving score | `main`'s `0365` | `driving-score-write-boundary-check.sql`: with it, a teen erases the trip they logged |
| `0431` | safety check-ins | `main`'s `0379` | `locator-write-boundary-check.sql` step 6: with it, a child files a check-in naming no member (and a parent can no longer file one for a child) |
| `0436` | behaviour-note authorship | `main`'s `0377` | `access-record-write-boundary-check.sql`: with it, a child rewrites a note they logged |
| `0437` | journals | `main`'s `0364` | `private-journal-check.sql` (main's): 2 failures with it |

**Evidence.** A private PG16 database replayed from empty: 412 migrations
applied, 0 failed; `docs/audit/run-probes.sh` twice on it, 137 of 137 passed,
none skipped. Each empty number's file was then put back on a copy of that
database and the probe named above went red.
## Ported from the audit branch — `0447`–`0458`, all unapplied

These twelve were written on `claude/logged-in-pages-supabase-7q6vtf`, whose
own numbering (`0318`–`0336`) collided with migrations main had already applied
to its ledger. They are re-applied here one fix at a time, each against main as
it stands, and numbered after main's highest (`0443`, #583; #583 keeps `0444`
and `0445` for itself). Every one was checked for an equivalent already on main
first; where main already covered part of a finding the migration was reduced
to the remainder, and each entry says so under **On main**. Five were not
carried at all, because main already carries the same rule:

- The branch's circle fix (the port's `0446`, `marketplace_create_circle`'s
  search_path reaching `extensions`) is main's `0444`, which arrived with #609
  while #586 was open and installs the identical function. The port's file is
  removed; the analysis below is kept under that heading because it is still
  the explanation of what `0444` fixes.

- The branch's `0329` (SEC-017: gift links, gift payments, Pay-IDs and savings
  goals were member-writable) — main's `0350` and `0378` had already rebuilt
  every write policy on those four tables as a manager write. Its probe,
  `docs/audit/money-decision-rows-check.sql`, is carried and passes against
  main's policies; it also holds the general rule that no money function reads
  a row a non-manager can rewrite.
- The branch's OAuth token store fix (the port's `0393`) is main's `0406`
  (`social_account_tokens` service-role only); `docs/audit/sensitive-role-boundary-check.sql`
  holds it, with the port's service-role leg kept.
- The branch's vault step-up (the port's `0395`) is main's `0391`, which guards
  the same three secret tables and `paperwork_items`, and asks only a manager
  for the code, as the app does; `docs/audit/a-password-alone-does-not-open-the-familys-vault-check.sql`
  holds it.
- The branch's profile visibility fix (the port's `0404`, PRIV-002) is main's
  `0426`, which installs the identical `profiles_select_self`;
  `docs/audit/profile-visibility-ends-with-membership-check.sql` and
  `tests/profile-visibility.test.ts` now hold `0426`.

**None of these is applied to production**, for the same reason as everything
from `0318` on (see the top of this file). With main merged in after #583, all
thirteen replay cleanly on the harness from nothing (441 migrations, none
failing) and all 173 probes pass there, `plpgsql-bodies-resolve-check.sql`
included.

**Deploy ordering.** The application on main is correct before and after each
of these, so none gates a deploy:

| Migration | Needs code? | Before it is applied |
|---|---|---|
| `0447` investment approval | no | approving an order raises 42804 (as today) |
| `0448` single-choice poll | no | a forged extra vote is accepted |
| `0449` family timezone | no | the app refuses a bad zone; the table does not |
| `0450` feedback bucket private | yes, in this change; reads both forms | screenshots readable by URL |
| `0451` chore disputes | no | a sibling can file a dispute in another child's name |
| `0452` proxy-bid ceiling | yes, in this change; reads both schemas | rivals can read a leader's ceiling |
| `0453` Guardian call history | no | a member can write a call record |
| `0454` onboarding claim | the action's own check ships with it | the action refuses; the RPC does not |
| `0455` concierge backfill | no | runs decided earlier stay on Needs-you |
| `0456` service-only functions | no | two server functions are callable with the anon key |
| `0457` auction close | no | no auction closes (as today) |
| `0458` member login link | no | a manager can write a stranger's login onto a member row |

### The port's `0446`, now main's `0444` — a sharing circle could never be created

*Not carried: main's `0444` installs the identical function. The analysis stands.*

`marketplace_create_circle` is `security definer` and pinned
`set search_path = public`. Pinning is the correct instinct for a definer
function — an inherited search_path lets a caller shadow an unqualified object
and have the definer execute it with elevated rights. But **Supabase installs
pgcrypto into the `extensions` schema, not `public`**, so this pin excluded the
one function the body calls:

```
NOTICE:  marketplace_create_circle -> FAILS:
         function gen_random_bytes(integer) does not exist (42883)
```

Measured directly on the schema:

```
set search_path = public;              select gen_random_bytes(8);  -- ERROR 42883
set search_path = public, extensions;  select gen_random_bytes(8);  -- \x9f4c...
```

**This is not a recent regression.** `0176_marketplace_circles.sql:133` declared
the same bare pin when the function was born, so **no family has ever created a
sharing circle** — the feature has been dead since it shipped. `0314` then fixed
a genuine ambiguous-character bug in the code generator (`translate` runs before
`upper`, so a lowercase `o`/`i` was uppercased back into the character the line
existed to remove) inside a generator that never reached the point of generating.

The fix pins `public, extensions`, matching the working precedent already in the
tree: `0238`'s `sync_blog_image_provenance` pins the same pair and calls
`digest()` happily. **Adding `extensions` does not loosen the pin** — the schema
holds extension functions, is not writable by `authenticated`, and so cannot be
used to shadow anything in `public`. `marketplace_join_circle` and
`marketplace_leave_circle` keep their bare `public` pin, because they call
nothing from `extensions` and a search_path should name what the body needs and
no more.

**What this is not:** `invites.token` (`0002_tables.sql:71`) also calls
`gen_random_bytes`, but as a COLUMN DEFAULT. A default's function references
resolve to OIDs when the column is declared, so the search_path in force at
insert time is irrelevant and that call site is sound. Function bodies resolve
at call time; that is the whole difference, and it is why a grep for the call
finds two sites and only one of them is broken.

Held by `tests/definer-search-path-pinned.test.ts`, which already asserted that
every definer function *pins* a search_path — a rule this function passed while
being broken. It now also asserts that a pinned search_path **reaches what the
body calls**, resolving each function's effective (last `create or replace`)
definition so it judges the database as it stands rather than flagging `0176`
forever. Reverting `0444` turns it red.

Verified end to end against a local stack with all 318 migrations applied:

```
NOTICE:  created circle 016a65fc-5db8-4909-856b-12c489407a81 with code JRQAKE2C
```

Until this is applied, production's marketplace circles cannot be created at all.

### `0447` — a parent could reject an investment order and never approve one

`invest_decide_order` has two outcomes and only one of them has ever worked.
Measured as a manager against a funded wallet and a pending buy:

```
invest_decide_order(APPROVE) FAILS: column "direction" is of type
                             wallet_txn_direction but expression is of type text (42804)
invest_decide_order(REJECT)  -> {"ok": true, "status": "rejected"}
```

The ledger insert on the approval path writes `direction` from a CASE:

```
case when v_order.side = 'buy' then 'debit' else 'credit' end,
```

A bare string literal is of type `unknown` and Postgres coerces it to the target
enum — which is why `'adjustment'` and `'completed'` on the two lines directly
above it are fine. **A CASE over two such literals is not `unknown`**: it
resolves to `text`, and there is no implicit cast from `text` to an enum:

```
insert into t(direction) values ('debit');                          -- OK
insert into t(direction) values (case when true then 'debit'
                                      else 'credit' end);           -- 42804
```

So `type` and `status` on adjacent lines of the same INSERT are correct and
`direction` is not, which is the whole reason it survived review: the line reads
exactly like its neighbours.

**The asymmetry is why nobody noticed.** Rejection returns before that INSERT, so
it works — a parent can decline a child's investment for ever and the feature
looks alive. Only approval throws, and it has thrown since `0196` created the
function. The definition was never replaced, so no child has ever had a buy or
sell order filled.

`0447` adds the cast and changes nothing else; the rest is `0196`'s text
verbatim, so it reviews as a one-line diff.

Held by two probes. `docs/audit/invest-order-fill-check.sql` exercises BOTH
branches — `buy` takes 'debit', `sell` takes 'credit', and a fix casting only one
would leave half the feature broken while a buy-only probe called it green — and
asserts on the ledger balance and the shares on the books rather than on the
returned `{"ok": true}`, which is a claim rather than an outcome.
`docs/audit/plpgsql-bodies-resolve-check.sql` is the general one: it resolves
every plpgsql body in `public` (70 functions, trigger bodies checked against each
relation that fires them) against the live catalogue. That is what found this,
and it is what would have found the circle bug (`0444`) — a plpgsql function binds its SQL at CALL
time, so a body can be catastrophically wrong and still install, deploy and pass
CI cleanly.

Until this is applied, no investment order can be filled in production.

### `0448` — a single-choice poll would take every choice

`family_polls.kind` is `single` or `multi`, and `voting-module.tsx` enforces the
difference in the browser:

```
if (poll.kind === 'single' && mine.size > 0) {
  // Clear the prior selection first; if this fails, do NOT insert or the
  // single-choice poll ends up with two votes for this member.
```

The comment is exactly right about the consequence. It was also the only thing
enforcing it: `family_poll_votes` carries `UNIQUE (option_id, member_id)` — one
vote per OPTION, correct for a `multi` poll and no rule at all for a `single`
one — and the table is client-reachable.

**Measured, as a child of the family:**

```
SINGLE-choice poll: one member cast 3 votes across 3 options
```

`voterCount` and the result bars read straight from these rows, so the poll
reports a result the family never gave.

**A trigger, not an index**, because the rule depends on `family_polls.kind` in
another table and a unique index cannot reach across one. That also changes how
pre-existing rows are handled, deliberately: `0316` had to REFUSE to apply while
duplicates existed, because a unique index cannot be created over rows that
violate it. A trigger governs new writes only, so `0448` installs regardless,
leaves existing rows untouched, and REPORTS what is already in the data as a
notice — silently deleting a family's recorded votes is not a migration's
business either.

It takes `for update` on the poll row, because a trigger that only SELECTs
before it INSERTs is `0317`'s defect again: two simultaneous votes each read "no
existing vote" and both land. It fires on UPDATE as well as INSERT, because
without that arm a member votes once legally and then re-points a second row at
the same poll — a path the probe confirms is real.

Held by `docs/audit/poll-single-choice-check.sql`, whose six controls are
load-bearing in both directions: a guard that simply forbade a second vote would
break MULTI polls, and one keyed on `poll_id` alone would stop a second MEMBER
voting.

Until this is applied, a single-choice poll can be stuffed in production.

### `0449` — a family timezone had no constraint, and a typo meant Greenwich

`families.timezone` decides which local day a routine belongs to, what "today"
means, and the day bounds the medication reminder uses.
`components/modules/family-module.tsx` states the failure above the field:
`Intl` throws on an unknown zone, every call site catches and degrades to UTC by
design, so a typo saved silently and left the family on Greenwich time while the
form said "Family profile updated".

Both application paths refuse a bad zone now. `families` carried **no constraint
of any kind**, and `families_update` is reachable by any manager's JWT.

**The guard had to accept exactly what `Intl` accepts**, and getting that wrong
was the real risk here. A guard checking `pg_timezone_names` alone would be
STRICTER than the application and would reject `CST` and `PST`, which the form
offers — closing the product rather than the hole. Postgres keeps IANA names and
legacy abbreviations in two catalogues and `Intl` accepts both:

```
zone              names  abbrevs  union   Intl
CST               f      t        yes     accepted
PST               f      t        yes     accepted
EST               t      t        yes     accepted
US/Central        t      f        yes     accepted
America/Chicago   t      f        yes     accepted
Etc/GMT+5         t      f        yes     accepted
UTC / GMT         t      t        yes     accepted
Amercia/Chicago   f      f        NO      REJECTED
```

The union agrees with `Intl` on every case measured, so the union is the rule.
`CST` being accepted is not an oversight — it is a fixed offset with no DST, so a
family in Chicago choosing it is an hour out for half the year, but `Intl`
accepts it and the form offers it. Which zones to OFFER is a product question;
it is not a reason for the table to disagree with the app.

**A trigger, not a CHECK**: a CHECK may only call IMMUTABLE functions, and
reading `pg_timezone_names` is not immutable — the zone database changes with the
server's tzdata. Declaring a function IMMUTABLE when it is not survives until a
`pg_dump`/restore revalidates every CHECK against a differently-versioned
catalogue.

Held by `docs/audit/family-timezone-exists-check.sql`, whose controls are the
point: five accepted zones plus `CST` and `PST` are exactly what a names-only
guard would wrongly reject. With the trigger dropped it reports 4 failures.

Until this is applied, a direct write can still put a family on Greenwich time.

### `0450` — a feedback screenshot was readable by the whole internet

`supabase/migrations/0450_a_feedback_screenshot_is_not_world_readable.sql`

**On main.** Reduced to the bucket flag. Main's `0369` (a public bucket is not a public listing) had already dropped the unscoped read policy described below and installed "Users read their own feedback-attachments" — the owner's folder, for `authenticated`. What it kept was `public = true`, and the public path is the whole remaining hole, so `0450` flips the flag and re-drops the old policy idempotently. The `owner OR is_super_admin()` policy described below is **not** installed: the admin console reads through the service role, so a JWT-level admin read would be access nothing uses. **Deploy order:** none. The code below reads either a stored public URL or a bare path, and signs through the service role, which works on a public bucket too.

`feedback-attachments` was `public = true` **and** carried an unscoped read
policy:

```
objects | Feedback attachments are publicly readable | SELECT | (bucket_id = 'feedback-attachments')
```

So every object was readable twice over — by the public path, which does not
consult `storage.objects` RLS at all, and by the authenticated path, whose
policy asked only which bucket the object was in. Writes were already scoped
correctly (`auth.uid()::text = (storage.foldername(name))[1]`); reads were not
scoped at all.

These are screenshots taken at the moment something in the product went wrong,
which is to say screenshots of a real family's calendar, children's names,
balances or documents. Object names are UUID-based so they are not enumerable,
and that was the only thing limiting this. An unguessable name is not an access
control, and a URL leaks the ordinary ways.

Measured against the running stack — the same object, the same path, no
credentials of any kind:

```
upload as the service role              -> HTTP 200
unauthenticated GET, bucket public      -> HTTP 200, 67 bytes
unauthenticated GET, bucket private     -> HTTP 400, "Bucket not found"
unauthenticated GET of a signed URL     -> HTTP 200, 67 bytes
```

**Why this one could be closed when `family-media` (SEC-001) still cannot.**
Exactly one surface renders these objects: `components/admin/feedback-admin.tsx`,
behind the super-admin gate, reading through the service role. The public Idea
Board selected `image_url` and never drew it. So there was no fleet of
`getPublicUrl` consumers to migrate — only one page to teach to sign, which it
now does with a 10-minute signed URL.

**Code that ships with it** (in this change, and required for the
migration to be safe):

- `lib/storage/feedback-attachment-signing.ts` — signs each distinct object once
  per page render.
- `app/(app)/admin/feedback/page.tsx` — resolves before rendering.
- `app/(app)/feedback/page.tsx` — stops selecting `image_url` altogether.
- `app/(app)/feedback/feedback-attachment-upload.tsx` — records the storage
  **path**; `getPublicUrl` on a private bucket returns a string that resolves to
  nothing, and storing one would record a value that looks usable and is not.
- `lib/storage/feedback-attachments.ts` — `feedbackAttachmentPath` reads either
  form, so rows written before this migration are **not rewritten** and keep
  working.

The policy that replaces the blanket one is `owner OR is_super_admin()`. The
reasoning needed checking first: the Idea Board is deliberately cross-user
(`feedback_ideas_select` is `auth.uid() IS NOT NULL` — see AUTHZ-006), so a
reader-scoped policy *would* have broken the product if the board drew these
images. It does not.

Held by `docs/audit/feedback-attachment-is-not-world-readable-check.sql`, whose
controls are the point: the uploader must still read their own attachment, or
the fix has taken it away from them. Flipping the bucket back turns it red on
the flag; restoring the blanket policy turns it red twice, on the policy and on
another signed-in user actually reading the row.
`docs/audit/bucket-visibility-is-declared-check.sql` reported `DECLARATION
STALE` the moment the flag changed — which is what it was written to do — and
its declared list now names three buckets, not four.

Until this is applied, every feedback screenshot ever uploaded is readable by
anyone who obtains its URL.

### `0451` — a chore proof named whose chore it was, and anyone could name it

`supabase/migrations/0451_a_chore_proof_belongs_to_whose_chore_it_is.sql`

**On main.** Reduced to `chore_disputes`. Main's `0375` (chore proof is the submitter's) had already rebuilt every permissive policy on `chore_submissions` on the same own-or-manager rule, so the submissions half below is closed there and not restated. `chore_disputes` was untouched on main and still answered only `is_family_member`. The probe asserts both tables: its submissions legs hold `0375`, its dispute legs hold `0451`.

`chore_submissions` and `chore_disputes` were each governed by one policy:

```
chore_submissions | chore_submissions_all | ALL | is_family_member(family_id)
chore_disputes    | chore_disputes_all    | ALL | is_family_member(family_id)
```

`is_family_member` answers "is this user in the family" and says nothing about
**which member the row names**. So any member could insert a submission against
another child's chore assignment, or open a dispute the row attributed to that
child.

The app layer had the same gap, and it is fixed alongside this migration:
`submitProofAction` and `disputeSubmissionAction` loaded their row filtered on
`family_id` only and then wrote `member_id: assignment.member_id` — the
assignee, not whoever sent the form. A sibling could complete a child's chore
for them, file a failing photo against it and have the parent's queue reject it
in their name, or raise a dispute the event log said that child had raised.

**The rule is the row's own member OR a manager**, not managers-only.
Submitting proof of your own chore *is* the child's half of the product — the
kids page exists for it — and a parent submitting on a child's behalf is a real
case that is kept. Same shape `0335` gives `member_locations`.

Restrictive, so it ANDs with the family policy already there; INSERT and UPDATE
both carry it, because without the UPDATE half a member could insert a correctly
attributed row and then re-point it.

`0222` already stops a member moving a submission INTO a manager-decision
status, and deliberately lets members submit (pending) and dispute (disputed).
This narrows **whose** submissions and disputes they may create; it does not
touch that.

Held by `docs/audit/chore-proof-ownership-check.sql`. Measured against the
pre-migration schema:

```
BREACH: a sibling submitted proof against another child's chore (rows: 1)
BREACH: a sibling re-attributed an existing submission (rows: 1)
```

and the control that matters more — making the rule managers-only instead
reports **"CONTROL FAILED: the assignee was refused their own submission — the
fix took the kids page away"**.

**Code that ships with it** (in this change): the assignee-or-manager
check in both actions, the dispute event log corrected to name the actual actor
rather than the assignee, and the same rule added to two more actions the new
`tests/a-family-action-says-whose-row-it-is.test.ts` found —
`requestAllowanceAction` (any member could raise an allowance request against
any child's wallet) and `requestRedemptionAction` (any member could spend
another child's tokens, since `memberId` was caller-supplied and only checked to
be in the family).

Until this is applied, a direct PostgREST call with a child's session can still
submit and dispute in a sibling's name, even though the product path cannot.

### `0452` — a proxy bid's ceiling was readable by the people bidding against it

`supabase/migrations/0452_a_proxy_bid_ceiling_is_secret.sql`

**On main — deploy order: none, and that is deliberate.** The application reads the reserve facts through `lib/marketplace/reserve-view.ts`, which asks for the two new columns and, only when Postgres says one of those columns does not exist (42703), reads `reserve_cents` instead and derives the same two facts with `reserveMet()`. So the app is correct on a database this has not reached (production today) and on one it has. Held by `tests/a-reserve-read-works-before-and-after-0452.test.ts`.

> **Deploy-coupled, in both directions.** The code on this branch selects
> `has_reserve` and `reserve_met`, which exist only after 0452; code from before
> this branch selects `reserve_cents`, which 0452 refuses. Apply 0452 **with**
> the deploy that carries this code — not before it, not after it. Deploying
> the code first breaks the auction board and the item page (`42703 column does
> not exist`); applying the migration first breaks them the other way (`42501
> permission denied`). Every other surface is unaffected.

`marketplace_place_bid` runs a proxy auction, and 0183's own column comments
call two values secret:

```
reserve_cents      bigint,                      -- hidden floor
highest_max_cents  bigint not null default 0,   -- current leader's hidden proxy max
```

Nothing hid them. `marketplace_listings` granted table-level SELECT to
`authenticated`, and the circle read policy lets every family in a sharing
circle read every listing shared there — so every rival bidder could read both.
`marketplace_bids_select` let the seller's family read each bidder's `max_cents`.

Measured over PostgREST with three real accounts in one circle:

```
Alice bids "up to $500"          -> leading, price $10.00
Bob selects highest_max_cents    -> 50000   (reserve_cents -> 20000)
seller selects max_cents         -> [50000]
Bob bids exactly 50000           -> leading: false, current_cents: 50000
```

Alice still wins — at her **entire** maximum. The engine's "does not beat the
standing proxy" branch prices a challenger at `least(highest_max_cents, p_max +
increment)`, so bidding the leader's ceiling exactly sets the price to it. That
is shill bidding with perfect information; the seller had it by default. A blind
$300 bid would have left the price at $300.50.

**The fix is column privileges.** Table-level SELECT is revoked from `anon` and
`authenticated` and re-granted on every column except the secrets; the column
list is computed inside the migration. The bid engine is SECURITY DEFINER and
keeps full access; INSERT and UPDATE grants are untouched (a seller still sets a
reserve); the service role keeps everything. Realtime's `apply_rls` filters each
column through `has_column_privilege`, so the live bid feed stops carrying
`max_cents` as well. The UI's two needs — is there a reserve, has it been met —
become stored generated columns mirroring `reserveMet()`.

**A trap this sets, stated so it is not discovered in production:** a column
grant does not extend to columns added later. Any future migration that adds a
column to `marketplace_listings` or `marketplace_bids` must `grant select
(<column>) … to anon, authenticated`, or every client read naming that column
fails with `42501`. The migration's self-check and the probe both assert the
selectable set is exactly "every column minus the secrets", so the omission
fails CI rather than a user.

Held by `docs/audit/proxy-bid-ceiling-is-secret-check.sql`. Against the
pre-migration grants it reports four findings, including
`BREACH: a rival read the leader's proxy ceiling (50000)` and
`BREACH: the seller read the bidders' maxima (50000)`; withholding `reserve_met`
as well reports `CONTROL FAILED: … the fix took the reserve badge away`; and
adding a column without its grant reports
`REGRESSION: ordinary columns are not selectable`.

**Code that ships with it** (in this change): the item page, the auction
panel and the auction board read `has_reserve` / `reserve_met` instead of the
figure — the board had been serialising `reserve_cents` into every viewer's page
props; `components/modules/marketplace-module.tsx` names its columns instead of
`select('*')`, which would now fail; `AuctionView` in
`lib/marketplace/auction.ts` is the client's type, with no `reserveCents`.

Until this is applied, any member of a sharing circle can read the ceiling of
every auction shared there, and any seller can read every bidder's maximum.

### `0453` — Guardian's screening decisions were anyone's (closes AUTHZ-005)

`supabase/migrations/0453_guardian_screening_is_the_parents_decision.sql`

**On main.** Reduced to `guardian_communications`. Main's `0318` and `0345` had already rebuilt the write policies on `guardian_contacts`, `guardian_member_profiles` and `guardian_suggestions` as manager writes, which closes the six breaches below. They left `guardian_communications` with a permissive INSERT for any member ("Service can insert guardian_communications" checks only `is_family_member`), so a child could still write a call or text record into the history the learning run reads. `0453` guards that table's INSERT, UPDATE and DELETE and nothing else.

Not deploy-coupled: no application code changed with it, and every product
writer of these tables was already parent-only or the service role.

Guardian screens a family's calls and texts. `guardian_routing_rules` was
already manager-only, but the tables that actually decide who rings through
were `FOR ALL is_family_member`: `guardian_contacts` (each caller's trust
level), `guardian_member_profiles` (each member's handling per trust level, and
whether screening is on at all) and `guardian_suggestions` (proposals a parent
approves — `guardian_review_suggestion` applies whatever `proposed_*` the row
holds at that moment). AUTHZ-005 recorded this from the policy source and asked
for a reproduction before a repair. Reproduced as a child on the local stack:

```
BREACH: a child rewrote a pending suggestion before a parent approved it
BREACH: a child raised a blocked caller to immediate_family
BREACH: a child added a trusted contact
BREACH: a child deleted a blocked caller's record
BREACH: a child deleted a parent's manager-only routing rule by deleting the contact it names (cascade)
BREACH: a child fabricated a call record, which the learning run reads
BREACH: a child switched off their own call screening
```

The cascade is the one the policy source could not show:
`guardian_routing_rules.condition_contact_id` is `ON DELETE CASCADE`, so a
member who could delete a contact could delete the manager-only rule attached
to it without touching the rules table.

**The fix**: RESTRICTIVE manager-only insert/update/delete guards on
`guardian_contacts`, `guardian_member_profiles`, `guardian_suggestions` and
`guardian_communications`, in 0217's shape, plus `revoke insert, update, delete
… from anon`. SELECT untouched — a child still sees the family's contacts.
Every product writer was already parent-gated (`upsertContactAction`,
`updateContactTrustAction`, `deleteContactAction`, `upsertMemberProfileAction`,
`updateContextAction`, `assignGuardianPhoneAction`,
`generateGuardianSuggestionsAction`) or the service role (the provider webhooks,
the learning cron).

Held by `docs/audit/guardian-authority-check.sql`: seven findings against the
pre-migration policies, clean after; making contacts manager-only to READ as
well reports `CONTROL FAILED: the child cannot see the family's contacts`.

Until this is applied, a child can undo any screening decision a parent made
about their own calls.

### `0454` — a stranger could onboard into your family as its parent

`supabase/migrations/0454_onboarding_resumes_only_your_own_family.sql`

**Severity: critical.** **Safe in either order** relative to a deploy: the
code on this branch refuses the takeover by itself, and this migration refuses
it by itself. Apply it anyway — it also closes the removed-creator variant the
code check does not.

`onboarding_claim_family` lets an interrupted wizard land on the family it
already started, by resuming from `onboarding_progress.family_id`. That row is
the user's own to write (`user_id = auth.uid()`), and nothing constrained its
`family_id`. The onboarding action then upserts the caller into whatever family
the claim returns **as a parent, with the service role**. Reproduced with real
sessions:

```
fresh account, no family
upserts its own onboarding_progress: family_id = <victim family>   -> allowed
onboarding_claim_family -> {"family_id": <victim>, "created": false}
parent membership upsert                                             -> ok
in its own session: role in the victim family                        -> parent
the victim family's password vault                                   -> [{"label":"Home wifi","secret":"the-real-wifi-password"}]
```

The prerequisite is the family's id. Every family sharing a marketplace circle
with it can read that from `marketplace_circle_members`; every past member
already knows it.

`prepareCalendarFamily` has always refused this (`'Family owner changed'`).
The main onboarding action did not. Three layers now:

1. **The action** (in this change) reads `families.created_by` for a
   resumed claim and refuses it unless it is the caller, *before* writing the
   membership. This protects production from the moment the code deploys.
2. **The function** resumes only a family the caller created and that has no
   other login member. The second condition also stops a creator removed from
   their own family re-onboarding back in as a parent — which the code check
   alone would allow, since they did create it. A progress row that fails the
   check is replaced by the new family rather than coalesced behind it.
3. **The row**: clients lose INSERT on `onboarding_progress` and UPDATE on its
   `family_id` (and `id`, `user_id`, `created_at`); every writer of `family_id`
   is the service role. `prepareCalendarFamily`'s own update of `source` and
   `status` keeps its columns.

Held by `docs/audit/onboarding-claim-ownership-check.sql`: five findings
against the pre-0331 function and grants (the takeover, the removed creator,
both row writes, a progress row left naming the victim); two when only the
function is fixed; and revoking the calendar path's columns as well reports
`CONTROL FAILED: the calendar setup path lost the columns it updates`.

As with 0452, a column grant does not extend to columns added later: a future
migration adding a column to `onboarding_progress` that clients must update
needs its own `grant update (<col>)`.

### `0455` — decided concierge runs stayed on "Needs your decision"

`supabase/migrations/0455_decided_concierge_runs_leave_needs_you.sql`

**Data only. Apply with, or after, the deploy that carries DATA-018's code.**
No schema change and no deploy coupling in either direction. Runs the old code
decides after 0455 runs would still be stuck, and re-running its `UPDATE` by
hand is safe and idempotent.

A concierge run queued for approval is written with `status = 'pending'` and
`state = 'awaiting_approval'`. Approving or dismissing it wrote `status` only,
so `state` never moved. The Needs-you page lists runs by `state`, and
`displayRunState` prefers `state` whenever it isn't the default. So every run
a parent ever decided this way is still listed as waiting on them. On the local
database, as a parent, after one dismissal and one approval:

```
Waiting for approval: Dinner [status=dismissed, state=awaiting_approval]
Dinner planned              [status=executed,  state=awaiting_approval]
```

The concierge actions now write both columns, claim the run before applying
it, and hand it back to the queue if applying fails. 0455 moves the rows
decided before that, using the mapping the code already defines
(`LEGACY_RUN_STATUS_TO_STATE`: executed → completed, dismissed → cancelled). It
touches only the contradictory pair: a status that says decided and a state that
says awaiting approval. No writer produces that pair on purpose. It ends with a
self-check that raises if any such row remains.

Verified locally: two stuck rows moved (`dismissed → cancelled`,
`executed → completed`), a genuinely pending control untouched, and a
second application exits 0.

### `0456` — two server-only functions were callable with the anon key

`supabase/migrations/0456_service_only_functions_are_service_only.sql`

**Severity: high. Safe in either order** relative to a deploy: both app callers
already use the service client.

`wallet_reserve_card_auth` (0155) places a `processing` debit hold on a child's
spend bucket. `marketplace_place_bid_unchecked` (0184) is the raw bid engine
behind the checked `marketplace_place_bid` wrapper. Neither checks its caller,
because both were meant for the server only. Their migrations revoked EXECUTE
from `public`, which is how vanilla Postgres is locked down. On Supabase, the
default privileges grant EXECUTE on every new function **directly** to `anon` and
`authenticated`, and a revoke from `public` leaves those grants in place. 0221
found this for `authenticated` on the bid function and revoked that one role;
`anon` kept it.

Measured on the local Supabase stack with **only the public anon key**:

```
wallet_reserve_card_auth(<family>, <child wallet>, 2000, …)  -> true   spendable 2000 -> 0
marketplace_place_bid_unchecked(<listing>, <another family's member>, <that family>, 5000000)
                                                            -> {"ok":true,"leading":true}
```

After 0456: both refused with `42501` for anon and for a signed-in member. The
Issuing webhook's service-role hold still works (2000 → 1500), and a member
bidding as themselves through the checked wrapper still works.

**After applying, consider auditing production for forged holds and bids:**
`wallet_transactions` rows with `type = 'card_spend', status = 'processing'`
whose `stripe_ref` matches no Stripe Issuing authorization, and
`marketplace_bids` whose bidder family never had a member place them. The
function records no caller, so neither can be told apart from genuine rows
from the database alone.

### `0457` — no auction could ever close

`supabase/migrations/0457_an_auction_can_close.sql`

**Severity: high (a feature that has never worked). Safe in either order.**

`marketplace_close_auction` (0185) began with
`if current_user <> 'service_role' then raise exception 'forbidden'`. Inside a
SECURITY DEFINER function `current_user` is the owner, so this refused every
call, including the settlement cron's. Called exactly as
`app/api/cron/close-auctions` calls it, through the service client, it answered
`{"code":"P0001","message":"forbidden"}`. The cron logs "settlement failed;
leaving it retryable" and moves on, so every ended auction has stayed
`available`: no winner claimed, no order, no notification, and new bids are
refused as `ended`.

0457 re-creates the function from its live definition with only that line
changed. It now tests `auth.role()`, which reads the request's JWT, the same
test the chore and reward guards use. It also revokes the client roles.
Verified locally: the cron's call now claims the listing for the highest bidder
and creates a confirmed order, and `anon` gets `42501`.

**Operational note:** the first settlement run after 0457 closes *every*
auction that ended while the function was dead, up to the cron's batch size per
run, and notifies each winner and seller, possibly about auctions that ended
long ago. Review the backlog before applying if that would surprise families:
`select count(*) from marketplace_listings where sale_format = 'auction' and
status = 'available' and auction_ends_at < now();`. Also check whether any of
those auctions' leading bids came through the SEC-024 hole (0456) before
letting the backlog settle.

### `0458` — any account could link a stranger's login into its own family

`supabase/migrations/0458_only_the_server_links_a_login_to_a_member.sql`

**Severity: high. Safe in either order** relative to a deploy: nothing in the app
writes `family_members.user_id` from the browser.

`fm_insert` and `fm_update` let a family's parent or adult write every column
of their own family's member rows, `user_id` included, and every account is the
parent of the family it made. Writing another user's id onto a member row made
that user a co-member, and `profiles_select_self` shows co-members' profiles to
each other. The feedback board shows every idea's `author_id` and every vote's
`user_id` to any signed-in account, so the ids were there to take.

Measured on the local database as a signed-in parent, before 0458:

```
insert a member row carrying another user's id         -> succeeded
update an existing member row to another user's id     -> succeeded
select from profiles where id = <that user>            -> email, full name, date of birth, phone
update a co-parent's row to user_id = null             -> succeeded
```

0458 adds a SECURITY INVOKER trigger that refuses a change to `user_id` when
the statement runs as `authenticated` or `anon`. The server (service role) and
the database's own definer functions (`accept_invite`, `handle_new_family`,
`ensure_family_for_user`) run as other roles and are unaffected. After 0458
all four are refused with `42501`. Adding, editing and removing members, a new
family's creator becoming its parent, and the service role linking a child
login all still work. `docs/audit/member-login-link-check.sql` proves both
halves (58/58 on the local stack and on the exact CI image, and the migration
re-applies cleanly onto an existing schema).

**After applying, consider checking production for links planted before it:**
member rows whose `user_id` has no matching accepted invitation, is not the
family's `created_by`, and is not a child login the server created. The row
records no writer, so the database alone cannot tell a planted link from a
real one; the check narrows the list for a person to review.

## `0459` — a family's photos were readable by anyone holding the link (SEC-001)

`supabase/migrations/0459_family_media_is_read_by_the_family.sql`

**Severity: critical (private family media on the open internet). Deploy order:
apply after a release in which every reader signs, which production already
serves** (`0c62fb4c`, "Every family photo is read through the viewer's own
signature", merged 2026-09-26 and live since; every production revision since
has carried it). On a database serving an older build, photos would show as
broken images, not leak.

`family-media` holds Photos, Create-Memory, Message attachments, Reminder
images, Closet and Inventory. `0216` created it `public = true`, so the public
path served every object to any request with no session, and 0216's
member-scoped SELECT policy governed only the authenticated API. The object's
URL was its only credential, and it outlived the row and the member's removal.

0459 changes only the flag. 0216's "Family members can read their media" policy
then decides every read: every reader signs through `signFamilyMediaRefs` with
the viewer's own session, which Storage refuses unless the viewer belongs to
the family in the path's first segment. Stored rows are not rewritten; the
readers accept a stored public URL or a bare path.

Measured on the local stack (real Storage API over HTTP), one photo uploaded by
a member of family A:

```
anonymous GET of its public URL, bucket public   -> 200, the photo's bytes
anonymous GET of its public URL, bucket private  -> 400 "Bucket not found"
family A member: createSignedUrl, then GET       -> 200, the photo's bytes
family B parent: createSignedUrl / download      -> refused ("Object not found")
anonymous:       createSignedUrl                 -> refused
```

`docs/audit/family-media-answers-to-the-family-check.sql` holds the policy half
(red on the flag before 0459, green after; a member of another family and an
anonymous caller read nothing, the uploader and another member of the family
read the photo); `docs/audit/bucket-visibility-is-declared-check.sql` no longer
declares `family-media` internet-readable.

**After applying:** open a photo, a message attachment and a reminder image as
a member (they render through signed URLs) and fetch one stored
`/storage/v1/object/public/family-media/…` URL with no session (it answers 400).

## `0462` — a family that could not see a listing could still buy it (DB-RPC-M01)

`supabase/migrations/0462_a_listing_is_acted_on_only_by_who_can_see_it.sql`

**Severity: high (another family's listing taken off the market). Deploy
order: any; no application change is needed.** Every caller already maps the
refusal (`not_found` → "that listing no longer exists").

A marketplace listing is visible to its own family and to the families in a
circle it is shared into. The three SECURITY DEFINER functions that act on a
listing never asked that, and the offers INSERT policy checked only the row's
own family. Measured on the local stack as a parent of a family in no circle
the listing was shared with, who could SELECT neither listing, given its id:

```
marketplace_place_bid(auction, …)        -> {"ok": true, "leading": true}
marketplace_negotiation_offer(sale, …)   -> {"ok": true, …}
marketplace_buy_now(auction, …)          -> {"ok": true, "order_id": …}   listing 'claimed'
insert into marketplace_offers (…)       -> INSERT 1                      listing 'pending'
```

0462 adds `marketplace_listing_visible_to(listing, family)`, which checks it in
the three functions. It puts `0311`'s same-family reference guard on
`marketplace_offers`, because an offer is the in-family flow. It also adds a
restrictive visibility insert policy on questions, saves and collection items.
`docs/audit/a-listing-is-acted-on-only-by-who-can-see-it-check.sql` shows 15
findings before and 0 after, with controls that a circle member still bids,
negotiates, asks, saves and buys, and the seller's own family still files an
offer.

**After applying:** as a member of a circle, open a shared auction and place a
bid, which should succeed. Then check production for orders, negotiations,
bids and offers whose family could not see the listing when the row was
written. The rows record no visibility at write time, so this narrows the list
for a person to review rather than proving anything.

## `0463` — a member could rewrite another member's read receipts and reactions (DB-RPC-M02)

`supabase/migrations/0463_a_read_receipt_is_the_readers_own.sql`

**Severity: medium (chat integrity inside a family). Deploy order: any.** The
product's writers already change only the caller's own entry.

`0367` left `read_by`, `reactions` and `is_pinned` on `family_messages` open to
every member, because other members legitimately change them, and never said
whose entry. Measured as a child: one update removed Dad's read receipt and his
reaction from Mom's message. 0463 adds a trigger on INSERT and on any UPDATE of
either column that lets only the caller's own id enter or leave `read_by` or
any emoji's list, and keeps `reactions` an object of arrays. `is_pinned` and the
service role are unaffected. `docs/audit/a-read-receipt-is-the-readers-own-check.sql`
shows 6 findings before and 0 after, with controls that the reader still marks
read, reacts, unreacts and pins.

**After applying:** open a conversation as one member and react to a message.
The unread badge clears and the reaction shows for the other members.

## `0464` — an invited guest could rewrite the household (ROLE-M03)

`supabase/migrations/0464_a_guest_views_the_household.sql`

**Severity: high (an extended-family invite could delete the family's calendar,
chores, documents and more). Deploy order: any.** A guest who tries to write now
gets "You don't have permission …" (42501) instead of a change.

The invite form, `/family/permissions` and the trust engine all describe the
`guest` role as view-only, but nothing enforced it. Measured on the local stack
as an active guest: C R U D on `calendar_events`, `chores`, `documents`,
`grocery_items`, `meals`, `notes` and `reminders`, and C R on
`chore_assignments`. 0464 adds a BEFORE INSERT/UPDATE/DELETE guard trigger on
those eight tables that refuses a caller whose role in the row's family is
`guest`. Reads, the service role and every other role are unaffected.
`docs/audit/a-guest-views-the-household-check.sql` requires a guest's measured
access to equal the page's guest row: 8 findings before, 0 after.

**Related to ROLE-SCOPE-001 (the owner's call on what a guest and a caregiver may see).** 0464 implements only the piece every description agrees on, that a guest does not write. Skip it if the owner decides guests should write.

**After applying:** as a guest, open the calendar and try to add an event. It
should be refused with the permission message. As a parent, add and delete one,
which should succeed.

## `0477` — two AI requests at the cap could both run (F19)

`supabase/migrations/0477_ai_requests_admission_is_atomic.sql`

**Severity: medium (a Free family's monthly AI allowance could be exceeded by
parallel requests). Deploy order: migration first, or together.** Application
code that reaches production before this migration **fails safe**: on a capped
plan the missing function makes the request refuse as not recorded (the model
does not run). On every plan, work filed unmetered (below) loses its record or
fails until 0477 is applied.

The allowance counted a family's `ai_requests` rows for the month, and every
metered route checked that count before filing its own row, so requests sent
together at 9 of 10 all passed the check. Measured on the local stack with 9
rows seeded: 8 parallel requests left 17 rows, 16 left 25. 0477 adds
`public.admit_ai_request(...)` (SECURITY DEFINER, `search_path` pinned,
`service_role` only): it takes a per-family transaction advisory lock, counts
the month exactly as the app's meter does, and inserts the row only under the
allowance, returning `admitted`, `refused` or `existing` (a retry key already
filed). The same experiments then leave exactly 10 rows (1 admitted, 7 or 15
refused). Design, evidence and rollback: `docs/audit/f19-atomic-admission.md`.

It also adds `ai_requests.metered boolean not null default true` (a constant
default, so no table rewrite). Work the family did not ask for is filed with
`metered = false`: chore-proof validation, system-scope intake (inbound
contact center) and scheduled routines. Both meters count only metered rows,
so that work no longer uses up a Free family's 10 requests (#892 review
5970498462). Every existing row stays metered.

Code deployed before this migration: the app's meter filters on `metered`, so
on a capped plan the gate refuses with "could not check this month's usage"
(it refused as "not recorded" before). An exempt request is not filed at all in
that window: 0477's `DEFAULT true` would turn such a row metered, and nothing could
tell it apart afterwards (#892 review 5971047090).
On **every** plan, unlimited ones included:
- Exempt work behind `withAiRequest` (chore-proof checks, paperwork
  transcription, the contact-center concierge) runs unrecorded.
- A system-scope intake (inbound contact-center routing) or a scheduled routine
  reports failure until 0477 is applied — the routine does not run.

A member's own request on an unlimited plan files as before (it names no new
column).

**0477 also withdraws INSERT on `ai_requests` from `authenticated` and `anon`**
(#892 review 4174949251). 0255's member policy let a signed-in member file
concierge rows directly through the Data API. Those rows counted toward the
allowance outside the admission lock and with no model call, and the member
could mark them `metered = false`. The application now files every request on
the ledger (service) client.

**Deploy together.** If they cannot ship together:
- **Migration first:** the previous code files an unlimited-plan concierge
  request through the member's session, and that insert is now refused
  ("could not file the request") until the code ships.
- **Code first:** exempt work goes unrecorded and system intake fails, as
  described above.

Prefer the window that matters least to the families on the plans involved.

**Rollback:** `drop function if exists public.admit_ai_request(uuid, integer, text, text, uuid, uuid, uuid, text, text, text, smallint, text, timestamptz); alter table public.ai_requests drop column if exists metered;`
together with reverting the application change. With only the database rolled
back, capped plans refuse until the code is reverted.

**After applying:** on a Free family with 9 requests this month, send two
assistant messages at the same moment from two tabs. One is answered; the
other shows the monthly allowance message. Paid families are unaffected. Then
submit a chore proof as a child of that family: it is still checked, and the
family's count (Settings, AI usage) does not change.
