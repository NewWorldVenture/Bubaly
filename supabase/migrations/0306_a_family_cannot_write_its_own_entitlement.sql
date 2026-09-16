-- Bubaly :: 0306 - a family cannot write the row that decides what it paid for
-- ----------------------------------------------------------------------------
-- A PARALLEL SESSION REACHED THIS SAME FINDING and landed
-- `0300_entitlement_is_not_client_writable.sql` on main while this was in
-- flight — the second time the two sessions have converged on one defect, after
-- invites (their 0298, this branch's 0305). Their migration runs FIRST, and the
-- two are complementary rather than duplicative, so both stay:
--
--   * On `subscriptions` and `billing_customers` they agree, and agree with
--     what the code already assumed: revoke the client's write grants. Running
--     both is a no-op the second time. What this file adds on top is the
--     RESTRICTIVE insert/update/delete guards and the sweep by SHAPE for stray
--     permissive write policies, so a future migration re-granting one by name
--     is caught rather than silently effective.
--
--   * On `families` they differ, and THEIR approach is the stronger one:
--     0300 revokes `update` wholesale and re-grants it column by column, so
--     `trial_ends_at` and `closed_at` are refused at the PRIVILEGE layer and
--     never reach a policy or a trigger at all. This file's
--     `family_entitlement_is_not_self_written` trigger is therefore now
--     defence in depth rather than the boundary. It is kept deliberately: a
--     later migration that re-grants `update` on `families` broadly — which is
--     exactly the kind of thing that happens — would silently undo 0300's
--     column list, and the trigger does not care about grants.
-- ----------------------------------------------------------------------------
-- `subscriptions` IS the paywall. `lib/server/plan.ts` reads it with the
-- SERVICE-ROLE client, deliberately, and says so in its own header: "Reading the
-- family's own plan is a trusted, server-side gating concern, so we use the
-- SERVICE-ROLE client to bypass RLS entirely and read the real plan."
--
-- The real plan was the customer's to write. 0004's `subs_manage`, re-asserted
-- verbatim by 0118, grants ALL to `is_family_admin(family_id)` — the parent
-- being charged. `billing_manage` does the same for `billing_customers`. And
-- `families_update` is `can_manage_family(id)` with no column restriction,
-- while that same trusted read takes `trial_ends_at` and `closed_at` from it.
--
-- Measured on a database replayed from these migrations, as a real
-- `authenticated` parent session under RLS:
--
--   update subscriptions set plan='family_plus', status='active' ..... UPDATE 1
--     stored plan afterwards ......................................... family_plus
--   update families set trial_ends_at = now() + '3650 days' .......... UPDATE 1
--   insert billing_customers (customer_ref='cus_<another family>') ... INSERT 1
--     stored customer_ref afterwards ................................. cus_VICTIM
--
-- Three separate consequences, in ascending order of severity:
--
--   1. THE PAID PRODUCT, FOR FREE. `planLevel(s.plan)` over active/trialing
--      rows is the entitlement. One UPDATE and the family is on Family+.
--
--   2. THE TRIAL NEVER ENDS — and the sharpest form is not extending it, it is
--      `trial_ends_at = null`. `computeEntitlement` reads NULL as GRANDFATHERED
--      ("only families created after 0161 carry a trial_ends_at, so existing
--      free families are never locked"), so one word converts "trial expired,
--      locked, must buy Family Basic" into permanently unlocked. Clearing
--      `closed_at` likewise reopens a family that was closed.
--
--   3. ANOTHER FAMILY'S STRIPE ACCOUNT. `/api/billing/portal` reads
--      `billing_customers.customer_ref` and hands it to
--      `stripe.billingPortal.sessions.create({ customer })` with no check that
--      the ref belongs to the caller — reasonably, because until now the only
--      writer was supposed to be the code that had just created the customer.
--      A parent who writes another family's `cus_…` into their own row opens
--      the Stripe billing portal ON THAT CUSTOMER: their invoices, their card,
--      their cancellation. That is cross-tenant, and it is not about money the
--      attacker saves.
--
-- Same shape as every boundary this sweep has closed: a rule stated where a
-- user can see it (here, `isAdmin` in four route handlers) and absent from the
-- layer that enforces it. A child is a real Supabase auth user and a parent
-- certainly is, so the browser reaches PostgREST with the anon key directly;
-- the route handler is not the boundary, the policy is.
--
-- THE FIX IS A REVOKE, NOT A NARROWER PREDICATE, because there is no narrower
-- predicate to write: NO legitimate session-client write to either table exists
-- anywhere in the repo. Every writer is already the service role —
--   app/api/webhooks/stripe/route.ts        (createServiceClient)
--   app/api/billing/{change-plan,cancel}    (createServiceClient for the sync)
--   app/(app)/admin/actions.ts              (createServiceClient throughout)
--   app/(app)/account/actions.ts            (close/reopen, createServiceClient)
--   lib/server/ensure-family.ts             (admin client)
--   handle_new_family                       (SECURITY DEFINER, owner BYPASSRLS)
-- — and the two that were not, the `billing_customers` upserts in
-- billing/checkout and billing/change-plan, move to `createServiceClient()` in
-- the same commit as this migration. The database was simply behind the code.
--
-- READS are left alone on `subscriptions`: `lib/server/entitlement.ts` reads it
-- with the session client for any member, to show the family's plan. Reads on
-- `billing_customers` narrow to managers — every reader in the repo is already
-- `isAdmin`-gated or service-role, and `lib/ai/context/policy.ts` has always
-- excluded the table by name as "billing identity".

-- ── subscriptions and billing_customers: writes are the server's alone ──────
do $$
declare
  tbl       text;
  readpred  text;
  pol       record;
  swept     int := 0;
  remaining int;
begin
  foreach tbl in array array['subscriptions','billing_customers'] loop
    if to_regclass('public.' || tbl) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', tbl);

    -- The read each table actually needs, restated so the sweep below cannot
    -- take it with it.
    readpred := case tbl
      when 'subscriptions' then 'public.is_family_member(family_id)'
      else 'public.can_manage_family(family_id)'
    end;
    execute format('drop policy if exists %I on public.%I', tbl || '_read', tbl);
    execute format(
      'create policy %I on public.%I for select to authenticated using (%s)',
      tbl || '_read', tbl, readpred);

    -- RESTRICTIVE, so a permissive policy re-added by a later migration cannot
    -- reopen the write on its own: restrictive policies are ANDed (the 0254
    -- idiom). Scoped to insert/update/delete only — SELECT above is untouched.
    execute format('drop policy if exists %I on public.%I', tbl || '_no_client_insert', tbl);
    execute format(
      'create policy %I on public.%I as restrictive for insert to authenticated with check (false)',
      tbl || '_no_client_insert', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_no_client_update', tbl);
    execute format(
      'create policy %I on public.%I as restrictive for update to authenticated using (false) with check (false)',
      tbl || '_no_client_update', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_no_client_delete', tbl);
    execute format(
      'create policy %I on public.%I as restrictive for delete to authenticated using (false)',
      tbl || '_no_client_delete', tbl);

    -- Sweep stray PERMISSIVE write policies BY SHAPE, not by name. Narrowing by
    -- name is how 0217 left six wallet tables behind for 0309 to find.
    for pol in
      select p.polname from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = tbl
        and p.polpermissive and p.polcmd in ('a','w','d','*')
    loop
      execute format('drop policy if exists %I on public.%I', pol.polname, tbl);
      swept := swept + 1;
      raise notice '0306: dropped stray permissive write policy %.%', tbl, pol.polname;
    end loop;

    select count(*) into remaining
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = tbl
      and p.polpermissive and p.polcmd in ('a','w','d','*');
    if remaining <> 0 then
      raise exception '0306 FAILED: % permissive write policy(ies) still on % after the sweep', remaining, tbl;
    end if;

    -- Belt as well as braces: with no table grant, RLS never gets asked. The
    -- service role is untouched — it is granted separately and bypasses RLS.
    execute format('revoke insert, update, delete on public.%I from authenticated', tbl);
    execute format('revoke insert, update, delete on public.%I from anon', tbl);
  end loop;

  raise notice '0306 OK: % stray write policy(ies) swept; the entitlement row is the server''s to write', swept;
end $$;

-- ── families: the two columns that are entitlement, not profile ─────────────
-- `families` cannot simply be revoked — a manager legitimately renames the
-- family, sets its timezone, address, avatar and family_code. The restriction
-- is BY COLUMN, in the idiom 0317 used for chore_assignments: a trigger that
-- refuses an untrusted writer touching the two columns `plan.ts` treats as
-- authority, and leaves the rest of the row alone.
create or replace function public.family_entitlement_is_not_self_written()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  -- The trusted server (service role, or a migration/seed with no authenticated
  -- session) keeps its reach: closeAccountAction and reopenAccountAction both
  -- already use createServiceClient, and handle_new_family sets the trial at
  -- insert under SECURITY DEFINER.
  if current_user = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null then
    return new;
  end if;

  -- `is distinct from` rather than `<>` on purpose: NULL is the most valuable
  -- value an attacker can write to trial_ends_at, because computeEntitlement
  -- reads it as "grandfathered, never locked".
  if new.trial_ends_at is distinct from old.trial_ends_at then
    raise exception 'a family cannot set its own trial end date'
      using errcode = '42501';
  end if;
  if new.closed_at is distinct from old.closed_at then
    raise exception 'a family cannot open or close its own account directly'
      using errcode = '42501';
  end if;

  return new;
end; $fn$;

drop trigger if exists trg_family_entitlement_is_not_self_written on public.families;
create trigger trg_family_entitlement_is_not_self_written
  before update on public.families
  for each row execute function public.family_entitlement_is_not_self_written();

revoke all on function public.family_entitlement_is_not_self_written() from public;
