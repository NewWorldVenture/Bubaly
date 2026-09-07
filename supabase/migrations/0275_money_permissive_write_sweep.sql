-- Bubaly :: 0275 Remove stray permissive WRITE policies on the money tables
-- ----------------------------------------------------------------------------
-- This closes, by shape rather than by name, the finding that keeps coming back:
--
--   "wallet_transactions still has a permissive INSERT policy alongside the
--    intended manager-only policy ... allowing any family member, potentially
--    including a child account, to submit a completed credit and create
--    spendable wallet funds."
--
-- Two separate things are true about that finding, and conflating them is why
-- it has been reported three times:
--
--   1. The MONEY IS NOT ACTUALLY MINTABLE. 0254 added RESTRICTIVE manager
--      guards, and a restrictive policy ANDs with the union of the permissive
--      ones — so no permissive policy, whatever it is called and whoever it is
--      granted to, can grant past it. That is not a reading of the docs: it is
--      proved behaviourally in docs/audit/wallet-write-rls-check.sql, which
--      injects the exact drifted policy (and a `to public with check (true)`
--      worst case) and asserts a child session still cannot mint.
--
--   2. THE STRAY POLICY IS STILL THERE. Every migration that has touched this
--      boundary — 0217, 0254, 0267 — drops policies BY NAME. A permissive write
--      policy whose name is not in the hardcoded list survives all of them. So
--      each metadata audit correctly reports a permissive INSERT policy on a
--      money table, each reviewer has to re-derive the restrictive-guard
--      argument from scratch, and automated safety checks stop the release.
--
-- Fixing (2) is what makes the finding stop. This migration enumerates
-- pg_policy at apply time and drops EVERY permissive INSERT/UPDATE/DELETE/ALL
-- policy on the money tables that is not one of the intended ones. It cannot
-- miss a name it was never told about, which is the whole point — the previous
-- three attempts each fixed the instance and left the class open.
--
-- WRITES ONLY. `select` is deliberately untouched, on both groups:
--   * Wallet tables keep `<t>_select` (is_family_member) so a child can see
--     their own balance and history — 0217's explicit decision.
--   * Finance tables keep `<t>_select` (is_family_member) for the reasons
--     0267's header sets out at length: narrowing reads there is a product
--     change that would empty "My Wallet" for every non-manager, not a leak
--     being closed, and it deserves its own proof.
-- A FOR ALL policy grants writes, so it is in scope for the sweep; the intended
-- select policy is re-asserted BEFORE anything is dropped, so no read is ever
-- left without a policy even for the duration of this transaction.
--
-- Trusted server writes (allowance cron, Stripe/Issuing webhooks, the reserve
-- hold RPC, chore auto-approve) use the service role and BYPASS RLS entirely,
-- so none of them are affected.
--
-- No money rows, balances, buckets, account settings or external payments are
-- read or changed. Policies only.
--
-- Idempotent: re-asserts the intended policies by name, sweeps by shape, then
-- asserts the end state and fails loudly if a stray survived.

do $$
declare
  t          text;
  pol        record;
  swept      int := 0;
  remaining  int := 0;
  -- 0217/0254's wallet ledger group, and 0267's household finance group. They
  -- differ only in what the intended write policies are called.
  wallet_tables  text[] := array['family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules'];
  finance_tables text[] := array['financial_accounts','transactions','budgets','bills','savings_goals'];
begin
  -- ── Wallet ledger group ───────────────────────────────────────────────────
  foreach t in array wallet_tables loop
    if to_regclass('public.' || t) is null then
      raise exception 'Required wallet table missing: %', t;
    end if;
    execute format('alter table public.%I enable row level security', t);

    -- Re-assert the intended shape first, so the sweep below can never leave a
    -- command uncovered. Same definitions as 0217/0254; recreating is a no-op
    -- where they already match.
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_mng_insert on public.%1$I', t);
    execute format('create policy %1$s_mng_insert on public.%1$I for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_mng_update on public.%1$I', t);
    execute format('create policy %1$s_mng_update on public.%1$I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_mng_delete on public.%1$I', t);
    execute format('create policy %1$s_mng_delete on public.%1$I for delete to authenticated using (public.can_manage_family(family_id))', t);

    -- The restrictive guards from 0254. These are what actually hold the line
    -- while a stray policy exists, so re-assert them rather than assume.
    execute format('drop policy if exists %1$s_manager_insert_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_insert_guard on public.%1$I as restrictive for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_manager_update_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_update_guard on public.%1$I as restrictive for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_manager_delete_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_delete_guard on public.%1$I as restrictive for delete to authenticated using (public.can_manage_family(family_id))', t);

    -- The sweep. polcmd: 'a' insert, 'w' update, 'd' delete, '*' all.
    -- polpermissive is true for PERMISSIVE, so the restrictive guards above are
    -- never candidates. 'r' (select) is not listed: reads are out of scope.
    for pol in
      select p.polname
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = t
        and p.polpermissive
        and p.polcmd in ('a','w','d','*')
        and p.polname not in (t || '_mng_insert', t || '_mng_update', t || '_mng_delete')
    loop
      execute format('drop policy if exists %I on public.%I', pol.polname, t);
      swept := swept + 1;
      raise notice '0275: dropped stray permissive write policy %.% ', t, pol.polname;
    end loop;
  end loop;

  -- ── Household finance group ───────────────────────────────────────────────
  foreach t in array finance_tables loop
    -- 0267 guards on the column rather than the table, and these tables are
    -- older than some deployments; skip quietly rather than fail a release.
    if to_regclass('public.' || t) is null then continue; end if;
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'family_id'
    ) then continue; end if;

    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.can_manage_family(family_id))', t);

    -- 0267 narrowed these by name and left no restrictive backstop, so the same
    -- drift that hit the wallet group would reopen the household's money the
    -- same way. Give this group the guard the wallet group has had since 0254.
    execute format('drop policy if exists %1$s_manager_insert_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_insert_guard on public.%1$I as restrictive for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_manager_update_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_update_guard on public.%1$I as restrictive for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_manager_delete_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_delete_guard on public.%1$I as restrictive for delete to authenticated using (public.can_manage_family(family_id))', t);

    for pol in
      select p.polname
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = t
        and p.polpermissive
        and p.polcmd in ('a','w','d','*')
        and p.polname not in (t || '_insert', t || '_update', t || '_delete')
    loop
      execute format('drop policy if exists %I on public.%I', pol.polname, t);
      swept := swept + 1;
      raise notice '0275: dropped stray permissive write policy %.% ', t, pol.polname;
    end loop;
  end loop;

  -- ── The end state, asserted rather than assumed ───────────────────────────
  -- A migration that silently did nothing looks identical to one that worked.
  -- Checked per group rather than against the union of both naming schemes: a
  -- wallet table is allowed `_mng_insert` and a finance table `_insert`, and
  -- accepting either everywhere would let a stray named for the wrong group
  -- read as intended.
  select count(*) into remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (wallet_tables || finance_tables)
    and p.polpermissive
    and p.polcmd in ('a','w','d','*')
    and p.polname not in (
      case when c.relname = any (wallet_tables) then c.relname || '_mng_insert' else c.relname || '_insert' end,
      case when c.relname = any (wallet_tables) then c.relname || '_mng_update' else c.relname || '_update' end,
      case when c.relname = any (wallet_tables) then c.relname || '_mng_delete' else c.relname || '_delete' end
    );

  if remaining <> 0 then
    raise exception '0275 FAILED: % permissive write policy(ies) still on the money tables after the sweep', remaining;
  end if;

  raise notice '0275 OK: swept % stray permissive write policy(ies); none remain on the money tables', swept;
end $$;
