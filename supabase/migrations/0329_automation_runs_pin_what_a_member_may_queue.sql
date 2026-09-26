-- Bubaly :: 0329 - family_automation_runs: the split covered the verb and left
--                  the legacy column reachable on INSERT (AUTHZ-012)
--
-- `0251_ai_trust_hardening.sql` says, in its own header, why this table was
-- split: "0022 gave this table one FOR ALL policy on is_family_member, so any
-- member could set status='executed' on a run they never approved". The split
-- narrowed UPDATE and DELETE to `can_manage_family`. It did not narrow INSERT,
-- and the column it was written about is still reachable there.
--
-- `0252` then pinned what a member's INSERT may CLAIM, and `0255` pinned it
-- harder — `created_by = auth.uid()`, `state = 'queued'`, and request_id /
-- plan_id / current_step_id / requested_by_member_id / lease_owner /
-- lease_expires_at / idempotency_key all NULL. Both pinned the §10 `state`
-- column 0250 added, which carries a CHECK. Neither pinned the ORIGINAL
-- `status` column from 0022_family_os.sql (~line 135):
--
--   status text NOT NULL DEFAULT 'pending'   -- no CHECK, to this day
--
-- nor `trigger_type`, nor `metadata`, nor `summary`, nor `approved_by` /
-- `approved_at`. Measured on a replayed database with all 341 migrations
-- applied, acting as a CHILD of the family:
--
--   insert into family_automation_runs
--     (family_id, created_by, state, status, trigger_type, summary, metadata,
--      approved_by, approved_at)
--   values (<my family>, auth.uid(), 'queued', 'pending', 'plan_accepted',
--           '<my own words>',
--           '{"plan_id":"…","approval_id":"…"}'::jsonb, <the parent's uid>, now())
--                                                             -> INSERT 0 1
--
-- ── what that row is for ────────────────────────────────────────────────────
-- `components/concierge/autopilot-panel.tsx` reads this table with
-- `.eq('trigger_type','plan_accepted')` and then renders `r.summary` beside a
-- "Do it" button for every row whose `status === 'pending'`. The button calls
-- `executeQueuedRunAction` (app/(app)/dashboard/concierge/actions.ts ~L185),
-- which takes `meta.plan_id` and `meta.approval_id` FROM THAT ROW'S OWN
-- METADATA and stamps the named `approval_requests` row
--
--   status = 'approved', decided_by = <the parent's member id>,
--   decided_at = now(), executed_at = now(), execution_result = <summary>
--
-- — a write `approval_requests_decide` (0251 ~L128) restricts to
-- `can_manage_family`, and which therefore succeeds only because it is running
-- inside the parent's session. `dismissQueuedRunAction` (~L238) is the mirror
-- and stamps 'rejected'. Any pending approval in the family — a sibling's spend
-- request, an AI action waiting on a parent — can be marked decided, in a
-- parent's name, by a child who never touched it.
--
-- Sized honestly: DECISION-RECORD FORGERY AND QUEUE SUPPRESSION, NOT REMOTE
-- EXECUTION. `lib/services/approvals.decide()` is what turns an approval into
-- work and is not on this path. `executeQueuedRunAction` does materialise
-- `meta.plan_id` from `concierge_plans` into calendar_events and
-- family_reminders with `created_by` = the parent (materializeConciergePlan,
-- lib/services/approvals/index.ts ~L473), and `concierge_plans` is role-blind
-- (0091 ~L65) — so the child also chooses what those records say.
--
-- Two smaller surfaces close with it:
--   * /dashboard/family-automation and /dashboard/autonomous-family-management
--     both read `.eq('status','pending')` into a "Pending approvals" list with a
--     manager Approve button (`resolveAutomationRun`, lib/family/actions.ts
--     ~L217), and `.in('status', ['approved','executed','skipped'])` into the
--     "recently run" feed — a history of work Bubaly never did.
--   * `lib/metric/completed-plans.ts` counts a row as a recorded completed plan
--     on `status.eq.executed` when `state` is still 'queued', so the panel's
--     "N things handled for you this week" counts the child's rows.
--
-- ── what a member may legitimately INSERT, enumerated from the code ─────────
-- Every writer of this table was read, by the bare table name across app/, lib/,
-- components/, hooks/, mobile/ and scripts/, not only `.from('…')`:
--
--   INSERT  app/(app)/dashboard/concierge/actions.ts planAcceptedAction L153 +
--           L166 — both `createServiceClient()`, i.e. the SERVICE ROLE, which
--           bypasses RLS. Its own comment says so: "Written by the server: 0252
--           only lets a member file their own unplanned queued run, and this row
--           records work Bubaly already did."
--   INSERT  lib/ai/runs/store.ts createRun L442 — writes through
--           `ledgerClient()` (L49), which returns `createServiceClient()` for
--           every scope that is not `actorKind === 'system'` (and a system scope
--           already holds the service client). That file's header states the
--           rule: "a member's client would be refused by RLS."
--   UPDATE  concierge execute/dismiss (L215, L250), lib/family/actions.ts
--           resolveAutomationRun (L227), lib/services/approvals/index.ts (L563,
--           L578) — all on the caller's own client and all opening with
--           `if (!isManager(ctx.active.role)) return …`; 0251 already requires
--           `can_manage_family` for UPDATE.
--   DELETE  lib/ai/runs/intake.ts adoptPlannedRun L522, on the ledger (service)
--           client.
--   READS   the autopilot panel, /display, /home, /dashboard/needs-you, the two
--           automation pages, the briefing and the metric loaders.
--
-- So the set of legacy `status` values a member may legitimately INSERT is
-- EMPTY, and so is the set of `trigger_type` values: NO application path inserts
-- into this table on a member's RLS-bound client at all. 0251 already named this
-- as the intended end state — "the map's end state is for planAcceptedAction to
-- insert with createServiceClient(). Until that app change lands, tightening
-- INSERT to can_manage_family would make plan acceptance fail for teen/caregiver
-- members" — and that app change HAS landed (commit 7a33b9cb). The stated
-- blocker is gone.
--
-- ── why a role boundary and not another column pin ──────────────────────────
-- Because `status`'s own DEFAULT is a queue value. `NOT NULL DEFAULT 'pending'`
-- means a member INSERT that names no status at all still lands in the parent's
-- "Pending approvals" list carrying the member's `summary`. There is no shape of
-- member insert that is inert unless a value is INVENTED for a column with no
-- CHECK and six readers, and inventing one is how the next reader gets it wrong.
-- Pinning `status` therefore collapses into pinning WHO may insert — which is
-- what 0251 wanted, what the three consuming actions already enforce in code,
-- and what covers `metadata`, `summary`, `result`, `rule_id`, `approved_by` and
-- `approved_at` in one statement instead of one reader at a time.
--
-- ── this is NOT the autopilot_suggestions mistake ───────────────────────────
-- A manager-only guard is wrong where the feature belongs to the member —
-- 0326 used a trigger for exactly that reason, and a manager-only guard on
-- `autopilot_suggestions` would have returned 500 for every child in a Plus
-- family. It does not apply here: plan acceptance by a teen or a child still
-- works after this migration, because `planAcceptedAction` writes the row with
-- the SERVICE client and never consults RLS. Nothing a non-manager does in the
-- product inserts one of these rows.
--
-- ── what does NOT change ────────────────────────────────────────────────────
-- READS. `family_automation_runs_select` stays `is_family_member(family_id)`:
-- the autopilot panel, /display, /home, /dashboard/needs-you and both automation
-- pages render for whoever is signed in, and narrowing SELECT would empty them
-- for a teen — a product decision, not this migration's business.
-- UPDATE and DELETE are untouched; 0251 owns them.
-- 0255's permissive `family_automation_runs_insert` is left exactly as written,
-- every condition intact. A RESTRICTIVE policy ANDs with the union of the
-- permissive ones, so this narrows without re-stating — and, for the reason
-- 0254/0306/0310/0322 all give, no future permissive `FOR ALL` written out of
-- habit can grant past it. That habit is precisely how this table got here.
--
-- ── and the grant layer, for the reason 0290 and 0322 give ──────────────────
-- This guard is `TO authenticated`, and a restrictive policy only ANDs with a
-- request made AS a role it names; for an ANONYMOUS request it is simply absent.
-- Supabase's default privileges hand `anon` arwdDxt on every table in `public`,
-- and on a replayed database `anon` does hold INSERT/UPDATE/DELETE/TRUNCATE
-- here. Not exploitable as it stands — no permissive policy names `anon`, so
-- RLS refuses for want of one — and this does not claim otherwise. What it
-- restores is the defence in depth, so that one future policy written `TO
-- public` cannot open a path no restrictive guard would catch. SELECT is
-- deliberately left alone, exactly as 0290 and 0322 left it.
--
-- What is still an APPLICATION change, and is not made here:
-- `executeQueuedRunAction` and `dismissQueuedRunAction` trust `meta.approval_id`
-- and `meta.plan_id` from the run row without checking that the named approval
-- belongs to that run. After this migration only a manager or the server can
-- author that metadata, so the escalation is closed; the misplaced trust is not.
-- The durable fix is to read the approval by `approval_requests.run_id` (0251
-- added the column) or to verify `approval.run_id = run.id` before stamping.
-- That is a code change and is recorded, not attempted here.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent: the policy is dropped and recreated by name; the revokes are
-- no-ops once applied.

-- ── only a manager may author a row in the approval queue ───────────────────
drop policy if exists family_automation_runs_manager_insert_guard on public.family_automation_runs;
create policy family_automation_runs_manager_insert_guard on public.family_automation_runs
  as restrictive for insert to authenticated
  with check (public.can_manage_family(family_id));

comment on policy family_automation_runs_manager_insert_guard on public.family_automation_runs is
  'AUTHZ-012. 0251 narrowed UPDATE/DELETE to can_manage_family and left INSERT open; 0252 and 0255 pinned the 0250 `state` column and not the 0022 `status` one, whose NOT NULL DEFAULT ''pending'' puts any member-written row straight into the parent''s approval queue with the member''s own summary and metadata. No application path inserts here on a member client — planAcceptedAction and lib/ai/runs/store.ts createRun both write with the service role — so the legitimate member-insert set is empty and this restrictive guard costs no live path. Reads, UPDATE and DELETE are untouched.';

-- ── close the anon grant a `to authenticated` guard cannot reach ────────────
revoke insert, update, delete, truncate on public.family_automation_runs from anon;

do $$
declare
  n int;
begin
  -- A migration that silently created nothing is worse than one that failed:
  -- the probe would be asserting a boundary that only looks present.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'family_automation_runs'
      and policyname = 'family_automation_runs_manager_insert_guard'
      and permissive = 'RESTRICTIVE'
      and cmd = 'INSERT'
  ) then
    raise exception '0329: the restrictive manager INSERT guard was not created on family_automation_runs';
  end if;

  if has_table_privilege('anon', 'public.family_automation_runs', 'INSERT') then
    raise exception '0329: anon still holds INSERT on family_automation_runs';
  end if;

  -- 0255 owns the permissive member-insert pin and must survive intact: this
  -- file narrows, it does not replace. If that policy has gone, the conditions
  -- this guard ANDs with have gone too.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'family_automation_runs'
     and policyname = 'family_automation_runs_insert' and permissive = 'PERMISSIVE';
  if n <> 1 then
    raise exception '0329: 0255''s permissive family_automation_runs_insert policy is missing (found %)', n;
  end if;

  -- Reads stay where 0251 put them.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'family_automation_runs'
      and policyname = 'family_automation_runs_select' and cmd = 'SELECT'
  ) then
    raise exception '0329: family_automation_runs_select is missing — this migration must not have touched reads';
  end if;

  raise notice '0329 OK: a run in the approval queue is authored by a manager or by the server; reads, UPDATE and DELETE are unchanged.';
end
$$;

-- Production verification (after the reviewed forward release applies it):
--   select policyname, permissive, cmd from pg_policies
--    where tablename = 'family_automation_runs';
--   select has_table_privilege('anon','public.family_automation_runs','INSERT');  -- f
--   As a child session: insert into family_automation_runs (family_id, created_by,
--     state, status, trigger_type, summary) values (…, 'queued', 'pending',
--     'plan_accepted', 'x');                                    -- 42501
