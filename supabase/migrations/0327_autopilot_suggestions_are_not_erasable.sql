-- Bubaly :: 0327 - the Autopilot queue: nothing erases it, and a resolution
--                  says who actually made it
--
-- `autopilot_suggestions` (0085_autopilot.sql) carries the same permissive
-- `FOR ALL TO authenticated USING (is_family_member(family_id))` as the tables
-- 0322, 0323, 0324 and 0325 narrowed, and it was recorded in the same census as
-- a table the application gates on `isManager` while RLS does not.
--
-- ── that record is wrong, and the reason is worth writing down ──────────────
--
-- The census said "no app path creates a row; only lib/autopilot/scan.ts, a
-- server pass, inserts", and concluded the table should be manager-only like
-- `guardian_suggestions`. `runAutopilotScan` is a server pass, but it is not a
-- server-ONLY pass. It has two callers:
--
--   app/api/cron/autopilot-scan/route.ts  -> createServiceClient()  (bypasses RLS)
--   app/api/autopilot/scan/route.ts       -> createServer()         (the CALLER's
--                                                                    own client)
--
-- and the second is reachable by any signed-in member of an entitled family:
-- its only gate is `resolveFeatureEntitlement(…, '/dashboard/autopilot')`,
-- which is plan-level, not role-level. `requireFeature` — the gate on the page
-- itself — is the same resolver and likewise carries no role check. The
-- Autopilot module runs that scan AUTOMATICALLY on open ("Auto-scan once when
-- the screen opens", components/modules/autopilot-module.tsx), and the scan
-- throws when an insert or a reconciliation update is refused:
--
--   throw new Error('Autopilot could not save the suggestion')          scan.ts
--   throw new Error('Autopilot could not save the policy suggestion')   policy-scan.ts
--   throw new Error('Autopilot could not archive stale suggestions')    history.ts
--
-- Resolution is the same story: `resolveAutopilotSuggestionAction`
-- (app/(app)/dashboard/autopilot/actions.ts) is gated by `requireFeature` and a
-- plan re-check, never by role, and `resolveSuggestion` updates the row on the
-- caller's client. So a manager-only INSERT or UPDATE guard here would 500 the
-- Autopilot page for every child in a Plus family, every time they opened it.
--
-- That is PROD-001's judgement applied a second time: the app and RLS agree
-- that any member may append to and resolve this queue, so there is no boundary
-- being walked around, and inventing one mid-audit would be a product decision
-- taken by the wrong person. What IS closed here is everything the application
-- never does.
--
-- ── 1. nothing in the product deletes a suggestion ─────────────────────────
--
-- Withdrawal is a status change, on purpose: `archiveStaleSuggestions` is
-- commented "Withdraw without erasing the evidence", and moves the row to
-- `status='snoozed'` with an `archived:` dedupe key so the offer can be made
-- again. Resolution stamps `executed` or `dismissed`. Acceptance stamps
-- `executed`. There is no `.delete()` on this table anywhere in app/ or lib/ —
-- only the seed files, which run as the migration role.
--
-- A child could nevertheless `delete from autopilot_suggestions` and erase the
-- record of what Bubaly proposed and what the household decided about it,
-- including the `status='dismissed'` rows that are the evidence a parent said
-- no. Measured as a child on a replayed database: DELETE 1. Closing DELETE
-- costs no flow at all, and it is the same instinct 0224 had about
-- `wallet_audit_logs`: a record whose subject can remove it records nothing.
--
-- ── 2. a resolution is signed by whoever made it ───────────────────────────
--
-- `resolved_by` had no binding, exactly as `audit_logs.actor_id` had none
-- before 0320 and `wallet_audit_logs.actor_user_id` has none before 0328. Every
-- writer in the codebase already passes its own id or nothing:
--
--   scan.ts / policy-scan.ts inserts        resolved_by: null
--   policy refresh, archive                 does not touch resolved_by
--   stamp() in lib/services/autopilot       resolved_by: scope.userId
--   acceptPolicySuggestionAction            resolved_by: ctx.user.id
--
-- so pinning it costs the honest callers nothing, and it stops a child
-- recording that a PARENT dismissed the suggestion the child dismissed —
-- /dashboard/autopilot and lib/home/completed.ts both render resolved rows back
-- to the family as the household's own decision history.
--
-- ── what is NOT closed, and must be read as a finding, not an omission ─────
--
-- A child may still INSERT a suggestion and UPDATE an existing one, because the
-- product lets them do both through /api/autopilot/scan and the resolve action.
-- That leaves AUTHZ-006's mechanism live at the application layer:
-- `acceptPolicySuggestionAction` (app/(app)/dashboard/trust/actions.ts) IS
-- manager-gated, and it reads the suggestion's own `payload` to decide which
-- `trust_policies` row to write — a table a child cannot write directly. A
-- hand-crafted `kind='policy'` row therefore chooses which tool the household's
-- AI is granted a standing allow for, and a parent clicking Accept applies it.
--
-- RLS cannot tell that row from the one `runPolicyScan` writes: both are
-- authored by the same member on the same client with the same columns. The fix
-- belongs where the trust is placed — either gate /api/autopilot/scan and the
-- resolve action on `isManager`, or have `acceptPolicySuggestionAction`
-- re-derive the proposal from `approval_requests` instead of believing the
-- stored payload. Both are product decisions and neither is this migration's to
-- take. It is recorded here so the next pass finds it stated rather than
-- inferred from the absence of a guard.
--
-- ── what does NOT change ────────────────────────────────────────────────────
-- Reads. /dashboard/autopilot, the AI proactive slice, the operating index and
-- the metric surfaces all read this table on the RLS-bound client as whoever is
-- signed in. SELECT is untouched.
--
-- `anon`'s writes go for 0290's reason: these guards are `TO authenticated` and
-- are simply absent for an anonymous request.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent.

do $$
begin
  if to_regclass('public.autopilot_suggestions') is null then
    return;
  end if;

  -- Nothing in app/ or lib/ deletes a suggestion; withdrawal is a status change.
  drop policy if exists autopilot_suggestions_no_client_delete_guard on public.autopilot_suggestions;
  create policy autopilot_suggestions_no_client_delete_guard on public.autopilot_suggestions
    as restrictive for delete to authenticated
    using (false);

  -- A resolution carries the id of whoever made it, or none at all (the scan's
  -- own inserts). This guard is about what a writer may LEAVE BEHIND, not about
  -- which rows they may reach — appending to and resolving this queue is open
  -- to every member by the product's own design, and narrowing the USING half
  -- would be the manager guard this migration explains it must not add. So the
  -- USING half restates the household check 0085's permissive policy already
  -- makes, which subtracts nothing; it is written out rather than left as
  -- `true` because docs/audit/blanket-policy-check.sql reads every policy's
  -- expression from the catalogue and cannot tell a harmless restrictive
  -- `true` from a permissive one that opens a table.
  drop policy if exists autopilot_suggestions_resolver_guard on public.autopilot_suggestions;
  create policy autopilot_suggestions_resolver_guard on public.autopilot_suggestions
    as restrictive for insert to authenticated
    with check (resolved_by is null or resolved_by = auth.uid());

  drop policy if exists autopilot_suggestions_resolver_update_guard on public.autopilot_suggestions;
  create policy autopilot_suggestions_resolver_update_guard on public.autopilot_suggestions
    as restrictive for update to authenticated
    using (public.is_family_member(family_id))
    with check (resolved_by is null or resolved_by = auth.uid());
end
$$;

revoke insert, update, delete, truncate on public.autopilot_suggestions from anon;

do $$
begin
  if to_regclass('public.autopilot_suggestions') is null then
    return;
  end if;

  if has_table_privilege('anon', 'public.autopilot_suggestions', 'INSERT') then
    raise exception '0327: anon still holds INSERT on autopilot_suggestions';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'autopilot_suggestions'
      and policyname = 'autopilot_suggestions_no_client_delete_guard'
      and permissive = 'RESTRICTIVE'
  ) then
    raise exception '0327: the delete guard on autopilot_suggestions was not created';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'autopilot_suggestions'
      and policyname = 'autopilot_suggestions_resolver_update_guard'
      and permissive = 'RESTRICTIVE'
  ) then
    raise exception '0327: the resolver pin on autopilot_suggestions was not created';
  end if;

  raise notice '0327 OK: Autopilot suggestions cannot be erased by a client and a resolution names its own author; append and resolve stay open, as the product intends.';
end
$$;
