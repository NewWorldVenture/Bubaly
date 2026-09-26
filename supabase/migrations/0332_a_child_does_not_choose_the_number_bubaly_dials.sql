-- Bubaly :: 0332 - a child does not choose the number Bubaly dials
--
-- `concierge_calls` (0173_concierge_calls.sql) is the OUTBOUND half of the
-- concierge: one row per requested phone call — who to ring, on what number, to
-- what end, and the AI-written `brief` whoever places it reads from. 0173 gave
-- it four policies and nothing has narrowed it since:
--
--   concierge_calls_select  FOR SELECT  USING            is_family_member(family_id)
--   concierge_calls_insert  FOR INSERT  WITH CHECK       is_family_member(family_id)
--   concierge_calls_update  FOR UPDATE  USING/WITH CHECK is_family_member(family_id)
--   concierge_calls_delete  FOR DELETE  USING            is_family_member(family_id)
--
-- `is_family_member` answers "is this user in the household" and ignores role.
--
-- The application has never agreed with that. All four mutations in
-- app/(app)/dashboard/concierge-calls/actions.ts open with the same line —
-- requestCallAction, cancelCallAction, requeueCallAction, logCallOutcomeAction,
-- four for four:
--
--   if (!isManager(ctx.active.role)) return { ok: false, error: … };
--
-- and tests/concierge-calls-authz.test.ts pins that the gate is the first
-- executable statement after the context resolves in every one of them.
-- requestCallAction states the reason in its own comment, and that comment is
-- the finding:
--
--   "An outbound AI call places real-world bookings/cancellations on the
--    family's behalf and can incur telephony cost — a manager-only action. RLS
--    is only family-scoped (any member), so the server action is the
--    authorization gate."
--
-- A server action is not an authorization gate. Children hold real logins and
-- real JWTs, every Supabase project ships PostgREST reachable, and a request to
-- /rest/v1/concierge_calls never passes through app/ at all. This is the same
-- sentence 0318 wrote about the Guardian tables and 0322 about the wallet
-- side-tables, and it is the same repair.
--
-- Measured on a replayed database with all 343 migrations applied, acting as a
-- CHILD of the family:
--
--   insert concierge_calls (callee_phone '+1555…', goal …, status 'queued')  -> INSERT 1
--   update concierge_calls set callee_phone=…, goal=…, status='queued'       -> UPDATE 1
--   update concierge_calls set status='completed', outcome=…                 -> UPDATE 1
--   delete from concierge_calls where id = <a parent's own request>          -> DELETE 1
--
-- ── it does not dial today, and that is exactly why it closes today ─────────
-- app/api/concierge-calls/place/route.ts has no voice provider, and its HONESTY
-- BOUNDARY comment is load-bearing: nothing there may write `status='calling'`,
-- every due queued row is parked as 'action_needed' with NO_PROVIDER_OUTCOME,
-- and tests/concierge-calls-honesty.test.ts pins both halves. So no child's row
-- reaches a telephone right now, and this migration does not pretend otherwise.
--
-- What the row reaches TODAY is a parent. The queue on /dashboard/concierge-calls
-- is what a manager cancels, re-queues, or logs an outcome against, and a child
-- can already put a `callee_name`, a `callee_phone`, a `goal` and a fabricated
-- `brief` in front of that decision — or quietly rewrite a parent's own request
-- between the moment it was written and the moment it is acted on, since
-- `requeueCallAction` re-queues by id whatever the row now says. The day a
-- provider is integrated, that same row becomes the number a parent's click
-- dials. The boundary belongs in front of the dialler, not behind it.
--
-- ── why a blanket manager guard rather than a status/requested_by pin ───────
-- 0326 guarded `chore_disputes` with a BEFORE trigger on the decision columns
-- instead of a blanket policy, because a member RAISING a dispute is the
-- feature and a blanket guard would have taken the appeal away from the child
-- it exists for. That test was applied here and the answer is the other way:
-- there is no member-facing "a member requests, a manager approves" flow on
-- this table to preserve. Every writer was read first —
--
--   app/(app)/dashboard/concierge-calls/actions.ts  4 writers, every one gated
--                                                   on isManager(ctx.active.role)
--   app/api/concierge-calls/place/route.ts          createServiceClient()
--   components/modules/concierge-calls-module.tsx   'use client', but its only
--                                                   direct supabase-js use is a
--                                                   SELECT refresh on realtime;
--                                                   every write it makes goes
--                                                   through those server actions
--   supabase/seed_concierge_calls.sql               psql, superuser
--
-- — and the cron is the writer a careless guard would have broken. It is not
-- broken: `createServiceClient()` authenticates as `service_role`, which carries
-- BYPASSRLS, so no policy on this table applies to the park write. The seed runs
-- as the superuser and is likewise unaffected. Since every RLS-bound writer is
-- already manager-only, pinning `status`/`requested_by` would guard less than
-- the application does while leaving a child able to author the callee name,
-- the number and the brief. The guard matches the app: managers write, the
-- family reads.
--
-- ── what does NOT change ────────────────────────────────────────────────────
-- Reads. app/(app)/dashboard/concierge-calls/page.tsx says it deliberately —
-- "Any family member can see the queue" — and the module subscribes to realtime
-- over the same rows for every member. `concierge_calls_select` is untouched.
-- Only writes move.
--
-- ── RESTRICTIVE, for 0254's reason, reaffirmed by 0306, 0310 and 0322 ───────
-- A restrictive policy ANDs with the UNION of the permissive ones, so a future
-- `FOR ALL USING (is_family_member(...))` added out of habit cannot grant past
-- it. That habit is precisely what put this table here; replacing 0173's four
-- policies instead would leave the next one free to undo the repair.
--
-- ── and the grant layer, for the reason 0290 and 0322 closed it ─────────────
-- These guards are `TO authenticated`, and a restrictive policy only ANDs with
-- a request made AS a role it names; for an ANONYMOUS request it is simply
-- absent. Supabase's default privileges hand `anon` arwdDxt on every table in
-- `public` from the moment it is created. Not exploitable as it stands — 0173's
-- permissive policies carry no TO clause, so an anon request evaluates
-- `is_family_member(family_id)` with a null `auth.uid()` and is refused for want
-- of a permissive grant — and this does not claim otherwise. What the revoke
-- restores is the defence in depth 0290 argued for, so that one future policy
-- written `TO public` cannot open a path no restrictive guard would catch.
-- SELECT is deliberately left alone, exactly as 0290 and 0322 left it.
--
-- Proven by docs/audit/a-child-does-not-choose-the-number-bubaly-dials-check.sql,
-- which carries the negative control: it drops ONLY these three guards, leaves
-- 0173's four policies exactly as they were, and requires the child's escalation
-- to succeed again.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent: policies are dropped and recreated by name; the revokes are
-- no-ops when already applied.

do $$
begin
  if to_regclass('public.concierge_calls') is null then
    return;
  end if;

  -- INSERT: a call REQUEST is authored by a manager (requestCallAction).
  drop policy if exists concierge_calls_manager_insert_guard on public.concierge_calls;
  create policy concierge_calls_manager_insert_guard on public.concierge_calls
    as restrictive for insert to authenticated
    with check (public.can_manage_family(family_id));

  -- UPDATE carries BOTH halves. Without WITH CHECK a manager could move a row
  -- into another family; without USING a non-manager could still match rows to
  -- attempt the update (cancelCallAction and requeueCallAction both address a
  -- row by id alone).
  drop policy if exists concierge_calls_manager_update_guard on public.concierge_calls;
  create policy concierge_calls_manager_update_guard on public.concierge_calls
    as restrictive for update to authenticated
    using (public.can_manage_family(family_id))
    with check (public.can_manage_family(family_id));

  -- DELETE: no server action deletes a call today — cancelCallAction moves the
  -- row to 'cancelled' so the record survives. A child removing a parent's
  -- request outright is therefore a write no application path performs.
  drop policy if exists concierge_calls_manager_delete_guard on public.concierge_calls;
  create policy concierge_calls_manager_delete_guard on public.concierge_calls
    as restrictive for delete to authenticated
    using (public.can_manage_family(family_id));
end
$$;

comment on policy concierge_calls_manager_insert_guard on public.concierge_calls is
  'An outbound concierge call places real-world bookings on the family''s behalf and can incur telephony cost. All four writers in app/(app)/dashboard/concierge-calls/actions.ts already gate on isManager; this makes that gate a boundary rather than a UI convention. Reads stay family-wide (concierge_calls_select) because the queue is meant to be visible to everyone. The cron in app/api/concierge-calls/place/route.ts writes as service_role (BYPASSRLS) and is unaffected.';

-- ── close the anon grant a `to authenticated` guard cannot reach ────────────
revoke insert, update, delete, truncate on public.concierge_calls from anon;

do $$
declare
  missing text[];
  open_privs text[];
begin
  if to_regclass('public.concierge_calls') is null then
    raise exception '0332: public.concierge_calls is absent — 0173 did not apply';
  end if;

  -- A migration that silently created nothing is worse than one that failed:
  -- the probe would be asserting a boundary that only looks present.
  select array_agg(p order by p) into missing
  from unnest(array[
    'concierge_calls_manager_insert_guard',
    'concierge_calls_manager_update_guard',
    'concierge_calls_manager_delete_guard'
  ]) as p
  where not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'concierge_calls'
      and policyname = p and permissive = 'RESTRICTIVE'
  );
  if missing is not null then
    raise exception '0332: restrictive manager guard missing on concierge_calls: %', missing;
  end if;

  select array_agg(p order by p) into open_privs
  from unnest(array['INSERT','UPDATE','DELETE']) as p
  where has_table_privilege('anon', 'public.concierge_calls', p);
  if open_privs is not null then
    raise exception '0332: anon still holds % on concierge_calls', open_privs;
  end if;

  -- The queue must stay readable by the whole family; narrowing SELECT here
  -- would empty /dashboard/concierge-calls for a teen and is a product
  -- decision, not this migration's business.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'concierge_calls'
      and policyname = 'concierge_calls_select'
  ) then
    raise exception '0332: concierge_calls_select is gone — the family queue would be unreadable';
  end if;

  raise notice '0332 OK: concierge_calls is manager-written and family-readable; anon holds no write on it.';
end
$$;
