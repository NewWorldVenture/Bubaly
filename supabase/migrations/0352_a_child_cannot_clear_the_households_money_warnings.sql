-- Bubaly :: 0352 A child cannot clear the household's money warnings
-- ----------------------------------------------------------------------------
-- `public.money_timeline_insights` holds the Financial Copilot's generated
-- advisories and, per row, whether the family has acknowledged or DISMISSED
-- them. 0168 created it with `is_family_member` on all four commands —
-- membership, not role — and no later migration has touched it: 0267's money
-- write boundary narrowed only financial_accounts/transactions/budgets/bills/
-- savings_goals, and 0275's sweep works from two hardcoded arrays
-- (`wallet_tables`, `finance_tables`) that do not name this table.
--
-- The row is FAMILY-WIDE by construction: 0168 declares
-- `unique (family_id, dedupe_key)`, so there is exactly one status per family
-- per insight, and app/(app)/dashboard/money-timeline/page.tsx reads the whole
-- family's rows into one map that every member's page renders from. So a single
-- write decides what the WHOLE household sees. Replayed into a throwaway
-- Postgres with 0003's helpers and 0168's policy text verbatim, all of the
-- following were true:
--
--   * a member with role 'child' ran the exact upsert the Dismiss button sends
--     and flipped the `urgent` low_balance advisory ("Balance runs thin the week
--     of Mar 2") to 'dismissed'; the PARENT's read-back returned 'dismissed',
--     so the shortfall warning was gone from the parents' page too;
--   * a member with role 'guest' then DELETED the row outright, taking the
--     family's whole acknowledge/dismiss record for that advisory with it;
--   * a non-member was refused, which is how we know RLS was live for the two
--     above rather than switched off.
--
-- Nothing upstream stops that. The page's only guards are `requireUserContext`
-- and `requireAal2(ctx, 'money', …)`, and `needsStepUp` (lib/auth/mfa.ts) is
-- deliberately manager-only, so a child or guest is never even stepped up. And
-- `syncMoneyInsightsAction` omits `status` on purpose, so pressing Refresh does
-- not restore a dismissed advisory and the module has no dismissed-items view:
-- a parent has no in-app way to see or undo what was cleared.
--
-- WRITES ONLY. `select` keeps `is_family_member`, for 0267's reason stated in
-- its own header: a member reading the forecast is a documented product
-- decision, and "narrowing here would empty a page rather than lock a door".
-- What is closed here is the WRITE that speaks for the whole household.
--
-- Shape follows 0275 for the finance group, including the RESTRICTIVE guards.
-- Those are what actually holds the line while a stray permissive policy
-- exists, because Postgres ORs permissive policies but ANDs restrictive ones —
-- the lesson 0109 taught by narrowing four policies by name beside a `FOR ALL`
-- policy nobody dropped, and shipping a no-op that looked like a fix.
--
-- Idempotent and replay-safe: `drop policy if exists` before every
-- `create policy`, the intended select policy is re-asserted BEFORE anything is
-- dropped so no read is ever uncovered mid-transaction, then strays are swept
-- by SHAPE (not by a list of names somebody has to remember) and the end state
-- is asserted rather than assumed.
--
-- No money rows, balances, bills or advisory content are read or changed here.
-- Policies, plus revoking anon's write grant on this one table (0290's
-- treatment; the reason is at the revoke). Behaviour is proven against a real
-- Postgres by docs/audit/a-child-cannot-clear-the-households-money-warnings-
-- check.sql, which CI's database job runs after replaying every migration.

do $$
declare
  pol        record;
  swept      int := 0;
  remaining  int := 0;
  t          text := 'money_timeline_insights';
begin
  if to_regclass('public.' || t) is null then
    raise notice '0352: public.% is not present; nothing to narrow', t;
    return;
  end if;

  execute format('alter table public.%I enable row level security', t);

  -- Reads stay open to the household (0267's decision, restated above). Assert
  -- it first so the sweep below can never leave SELECT without a policy.
  drop policy if exists money_timeline_insights_select on public.money_timeline_insights;
  create policy money_timeline_insights_select on public.money_timeline_insights
    for select using (public.is_family_member(family_id));

  -- The writes become the managers'. Same names 0168 used, so this narrows the
  -- existing policies in place rather than leaving a wider twin behind.
  drop policy if exists money_timeline_insights_insert on public.money_timeline_insights;
  create policy money_timeline_insights_insert on public.money_timeline_insights
    for insert with check (public.can_manage_family(family_id));

  drop policy if exists money_timeline_insights_update on public.money_timeline_insights;
  create policy money_timeline_insights_update on public.money_timeline_insights
    for update using (public.can_manage_family(family_id))
    with check (public.can_manage_family(family_id));

  drop policy if exists money_timeline_insights_delete on public.money_timeline_insights;
  create policy money_timeline_insights_delete on public.money_timeline_insights
    for delete using (public.can_manage_family(family_id));

  -- The backstop. A future permissive policy on this table — a `FOR ALL`
  -- convenience grant, a re-run of an old migration — cannot reopen the write
  -- for a signed-in member, because a restrictive policy ANDs with whatever the
  -- permissive union allows. (For an ANONYMOUS request these guards do not
  -- apply at all; the grant revoke below is what holds that side.)
  drop policy if exists money_timeline_insights_manager_insert_guard on public.money_timeline_insights;
  create policy money_timeline_insights_manager_insert_guard on public.money_timeline_insights
    as restrictive for insert to authenticated
    with check (public.can_manage_family(family_id));

  drop policy if exists money_timeline_insights_manager_update_guard on public.money_timeline_insights;
  create policy money_timeline_insights_manager_update_guard on public.money_timeline_insights
    as restrictive for update to authenticated
    using (public.can_manage_family(family_id))
    with check (public.can_manage_family(family_id));

  drop policy if exists money_timeline_insights_manager_delete_guard on public.money_timeline_insights;
  create policy money_timeline_insights_manager_delete_guard on public.money_timeline_insights
    as restrictive for delete to authenticated
    using (public.can_manage_family(family_id));

  -- The guards are `to authenticated`, and a restrictive policy only ANDs with
  -- requests made AS a role it names, so for `anon` they are simply absent.
  -- Supabase's default privileges give anon INSERT/UPDATE/DELETE on every new
  -- table in `public`, so a single stray permissive policy written `TO public`
  -- would let an anonymous request write here with no guard to catch it. Close
  -- the grant, as 0290 did for the wallet tables. Nothing writes this table
  -- anonymously: the only writer is the server action, on the signed-in
  -- member's client; the seeds run as the owner. Reads are left as they are —
  -- no permissive SELECT policy admits anon, and reads are not this change.
  execute format('revoke insert, update, delete, truncate on public.%I from anon', t);

  -- Sweep stray PERMISSIVE write policies by shape. polcmd: 'a' insert,
  -- 'w' update, 'd' delete, '*' all. 'r' (select) is not listed — reads are out
  -- of scope. `p.polpermissive` is true only for PERMISSIVE policies, so the
  -- three restrictive guards just created can never be selected here; dropping
  -- that predicate would make this migration remove its own backstop.
  for pol in
    select p.polname
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = t
      and p.polpermissive
      and p.polcmd in ('a','w','d','*')
      and p.polname not in (
        t || '_insert', t || '_update', t || '_delete'
      )
  loop
    execute format('drop policy if exists %I on public.%I', pol.polname, t);
    swept := swept + 1;
    raise notice '0352: dropped stray permissive write policy %.%', t, pol.polname;
  end loop;

  -- The end state, asserted rather than assumed: a migration that silently did
  -- nothing looks identical to one that worked.
  select count(*) into remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = t
    and p.polpermissive
    and p.polcmd in ('a','w','d','*')
    and p.polname not in (
      t || '_insert', t || '_update', t || '_delete'
    );
  if remaining > 0 then
    raise exception '0352: % stray permissive write policies survived on public.%', remaining, t;
  end if;

  -- And the guards are actually there, restrictive, on all three write commands.
  select count(*) into remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = t
    and not p.polpermissive
    and p.polname in (
      t || '_manager_insert_guard',
      t || '_manager_update_guard',
      t || '_manager_delete_guard'
    );
  if remaining <> 3 then
    raise exception '0352: expected 3 restrictive manager guards on public.%, found %', t, remaining;
  end if;

  -- And the anonymous side, which those guards cannot reach.
  if has_table_privilege('anon', 'public.' || t, 'INSERT')
     or has_table_privilege('anon', 'public.' || t, 'UPDATE')
     or has_table_privilege('anon', 'public.' || t, 'DELETE') then
    raise exception '0352: anon still holds a write privilege on public.%', t;
  end if;

  raise notice '0352: public.% writes are manager-only (% stray policies swept)', t, swept;
end $$;
