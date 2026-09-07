-- ── A-08 Wallet money-integrity write-RLS probe (0217 + 0224) ────────────────
-- Reusable proof that a non-manager (child) family member cannot MINT money or
-- TAMPER with the money audit trail. Run against the verify-pg.sh harness (which
-- seeds family A = the anchor). Provisions a child member of the anchor family
-- and asserts, under the `authenticated` role acting AS that child:
--   * INSERT into the wallet money-ledger tables is REJECTED         (0217, PLA-0580)
--   * UPDATE / DELETE of wallet_audit_logs affects 0 rows            (0224, PLA-0622)
--   * INSERT (append) into wallet_audit_logs is ALLOWED             (0224 keeps append)
-- and, as the anchor PARENT (manager), that a wallet_transactions INSERT succeeds
-- (positive control — the lockdown gates on role, it doesn't break managers).
--
--   bash docs/audit/verify-pg.sh up
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/wallet-write-rls-check.sql
--
-- Exit is non-zero (via RAISE EXCEPTION) if any invariant fails. This backs the
-- LB-010 exit criterion ("a non-manager INSERT to any wallet_* table is rejected").

\set FA '00000000-0000-4000-8000-0000000000f1'
\set PARENT '00000000-0000-4000-8000-000000000001'
\set KID '00000000-0000-4000-8000-0000000000c8'

-- Provision a child member of the anchor family (idempotent).
insert into auth.users (id, email) values (:'KID','kid-probe@example.com') on conflict do nothing;
insert into public.family_members (id, family_id, user_id, role, display_name, is_active)
  values ('a8c00000-0000-4000-8000-0000000000c8', :'FA', :'KID', 'child', 'Probe Kid', true)
  on conflict (id) do nothing;

-- Seed one audit row (as the DB owner / service context) for the tamper test.
insert into public.wallet_audit_logs (family_id, actor_user_id, action, entity_type, detail)
  values (:'FA', :'PARENT', 'wallet_activated', 'family_wallets', 'probe seed')
  on conflict do nothing;

-- The harness grants table privileges to `authenticated`; RLS is the real gate.
grant select, insert, update, delete on all tables in schema public to authenticated;

-- ── Invariant 1a: a child cannot MINT — a COMPLETE, valid $9,999.99 credit into
--     wallet_transactions must be RLS-rejected (only RLS can block a valid row,
--     so this is the rigorous money-mint proof, not a NOT-NULL artifact). ──────
do $$
declare blocked boolean := false; sqlst text;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c8', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  begin
    insert into public.wallet_transactions
      (family_id, type, status, direction, amount_cents, currency, metadata)
    values ('00000000-0000-4000-8000-0000000000f1','parent_top_up','completed','credit',
            999999,'usd','{}'::jsonb);
  exception when others then
    blocked := true; sqlst := sqlstate;  -- expect 42501 insufficient_privilege (RLS)
  end;
  if not blocked then
    raise exception 'A-08 FAIL: child MINTED a completed $9,999.99 credit into wallet_transactions';
  end if;
  raise notice 'A-08 OK: child mint of a complete valid credit REJECTED (sqlstate %)', sqlst;
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 1b: the sibling money-ledger tables also reject a child INSERT ──
do $$
declare
  ledger text[] := array['child_wallets','wallet_buckets','wallet_rules','family_wallets'];
  t text; blocked boolean;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c8', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  foreach t in array ledger loop
    blocked := false;
    begin
      execute format(
        'insert into public.%I (family_id) values (%L)', t, '00000000-0000-4000-8000-0000000000f1');
    exception when others then blocked := true;  -- RLS WITH CHECK or NOT NULL both prove the write did not land
    end;
    if not blocked then
      raise exception 'A-08 FAIL: child INSERT into % was NOT blocked (money-mint open)', t;
    end if;
  end loop;
  raise notice 'A-08 OK: child INSERT rejected on all % sibling wallet tables', array_length(ledger,1);
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 2: a child cannot TAMPER (UPDATE/DELETE) the money audit trail ──
do $$
declare affected int;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c8', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  update public.wallet_audit_logs set detail='TAMPERED'
    where family_id='00000000-0000-4000-8000-0000000000f1';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'A-08 FAIL: child UPDATEd % money-audit rows', affected; end if;

  delete from public.wallet_audit_logs
    where family_id='00000000-0000-4000-8000-0000000000f1';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'A-08 FAIL: child DELETEd % money-audit rows', affected; end if;

  raise notice 'A-08 OK: child UPDATE/DELETE of wallet_audit_logs affected 0 rows (append-only)';
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 3: a child CAN still append (INSERT) an audit row ──────────────
do $$
declare ok boolean := false;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c8', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  begin
    insert into public.wallet_audit_logs (family_id, actor_user_id, action, entity_type, detail)
      values ('00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000c8',
              'ai_coach_call','ai_wallet_coach','child append');
    ok := true;
  exception when others then ok := false; end;
  if not ok then raise exception 'A-08 FAIL: child could not APPEND an audit row (append-only broke a legit write)'; end if;
  raise notice 'A-08 OK: child append (INSERT) into wallet_audit_logs allowed';
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 4 (positive control): a manager CAN write the ledger ───────────
-- The lockdown gates on can_manage_family(), so the anchor PARENT must succeed.
do $$
declare ok boolean := false;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001', true);  -- anchor parent
  perform set_config('request.jwt.claim.role','authenticated', true);
  begin
    insert into public.wallet_audit_logs (family_id, actor_user_id, action, entity_type, detail)
      values ('00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-000000000001',
              'wallet_activated','family_wallets','manager control');
    ok := true;
  exception when others then ok := false; end;
  if not ok then raise exception 'A-08 FAIL: manager audit append was blocked (lockdown too strict)'; end if;
  raise notice 'A-08 OK: manager write allowed (positive control)';
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 5: the mint-lock survives a PERMISSIVE POLICY THAT DRIFTED IN ──
--
-- Everything above proves the migrations are right. This proves the lock holds
-- when the database is NOT what the migrations say — which is the situation a
-- production metadata audit reported: `wallet_transactions` carrying a
-- permissive INSERT policy alongside the manager-only one, of the shape that
-- lets any family member (a child included) submit a completed credit and
-- create spendable funds.
--
-- Permissive policies OR together, so on their own that finding is exactly as
-- bad as it sounds. What closes it is 0254's RESTRICTIVE guards: a restrictive
-- policy ANDs with the union of the permissive ones, so no permissive policy —
-- whatever it is called, whoever it is granted to — can grant past it.
--
-- That is a claim about Postgres semantics, and a claim about money deserves a
-- test rather than a reading. So this injects the drift and asserts the child
-- still cannot mint. Two shapes, the second deliberately the worst case that
-- could exist:
--   a) `to authenticated with check (is_family_member(family_id))` — the shape
--      the audit describes.
--   b) `to public with check (true)` — no role limit, no condition at all.
-- The guards in 0254 are `to authenticated`, so (b) also checks that a policy
-- reaching roles the guard does not name still cannot be used by a member.
do $$
declare blocked boolean; st text; landed int; shape text;
begin
  foreach shape in array array[
    'to authenticated with check (public.is_family_member(family_id))',
    'to public with check (true)'
  ] loop
    execute 'drop policy if exists wallet_transactions_drift_probe on public.wallet_transactions';
    execute format(
      'create policy wallet_transactions_drift_probe on public.wallet_transactions for insert %s', shape);

    blocked := false; st := null;
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c8', true);  -- the child
    perform set_config('request.jwt.claim.role','authenticated', true);
    begin
      insert into public.wallet_transactions
        (family_id, type, status, direction, amount_cents, currency, metadata)
      values ('00000000-0000-4000-8000-0000000000f1','parent_top_up','completed','credit',
              424242,'usd','{"probe":"drift"}'::jsonb);
    exception when others then blocked := true; st := SQLSTATE;
    end;
    perform set_config('role','postgres', true);

    select count(*) into landed from public.wallet_transactions where amount_cents = 424242;
    -- Clean up before asserting, so a failure does not leave the drift policy
    -- or a minted row behind for the next probe in the run.
    delete from public.wallet_transactions where amount_cents = 424242;
    execute 'drop policy if exists wallet_transactions_drift_probe on public.wallet_transactions';

    if not blocked or landed <> 0 then
      raise exception 'A-08 FAIL: a child MINTED money past the restrictive guard with a permissive policy % (blocked=%, rows=%)',
        shape, blocked, landed;
    end if;
    raise notice 'A-08 OK: child mint still blocked (%) with permissive policy %', st, shape;
  end loop;
end $$;

-- ── Invariant 6: `anon` cannot reach the money ledger at all ────────────────
-- The guards above are `to authenticated`, so a permissive policy `to public`
-- would not be ANDed with them for an anonymous request. The grant layer is
-- what closes that: anon holds no INSERT privilege, so the question never
-- reaches RLS. Asserted rather than assumed, because it is the one path the
-- restrictive guards do not cover.
do $$
declare has_priv boolean;
begin
  select has_table_privilege('anon','public.wallet_transactions','INSERT') into has_priv;
  if has_priv then
    raise exception 'A-08 FAIL: anon holds INSERT on wallet_transactions — the restrictive guards are `to authenticated` and would not apply';
  end if;
  raise notice 'A-08 OK: anon holds no INSERT privilege on wallet_transactions';
end $$;

-- ── Invariant 7: no stray permissive WRITE policy is left to report ─────────
--
-- Invariant 5 proves a stray policy cannot mint. This one proves there is no
-- stray policy, which is a different and — by this point — equally expensive
-- problem. The production metadata audit reads pg_policy and reports what it
-- finds; while a permissive INSERT policy sits on wallet_transactions it will
-- keep reporting one, every reviewer has to re-derive invariant 5 from
-- scratch, and the release stops. That happened three times before 0275.
--
-- 0217, 0254 and 0267 each dropped policies by hardcoded NAME, so a policy
-- nobody had named survived all three. 0275 sweeps by shape. This asserts the
-- result, so the sweep cannot quietly regress the next time someone adds a
-- policy to a money table.
do $$
declare
  offender record;
  n int := 0;
  -- Spelled out rather than pattern-matched on the name. The same two groups as
  -- 0275, in the same order: a `like 'wallet%'` shortcut would silently put a
  -- future table in the wrong group and check it against the wrong policy names.
  wallet_tables  text[] := array['family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules'];
  finance_tables text[] := array['financial_accounts','transactions','budgets','bills','savings_goals'];
begin
  for offender in
    select c.relname as tbl, p.polname as pol,
           case p.polcmd when 'a' then 'INSERT' when 'w' then 'UPDATE'
                         when 'd' then 'DELETE' when '*' then 'ALL' end as cmd
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relname = any (wallet_tables || finance_tables)
      and p.polpermissive
      and p.polcmd in ('a','w','d','*')
      and p.polname not in (
        case when c.relname = any (wallet_tables) then c.relname || '_mng_insert' else c.relname || '_insert' end,
        case when c.relname = any (wallet_tables) then c.relname || '_mng_update' else c.relname || '_update' end,
        case when c.relname = any (wallet_tables) then c.relname || '_mng_delete' else c.relname || '_delete' end)
  loop
    n := n + 1;
    raise warning 'A-08 stray permissive % policy: %.%', offender.cmd, offender.tbl, offender.pol;
  end loop;

  if n <> 0 then
    raise exception 'A-08 FAIL: % stray permissive write policy(ies) on the money tables — 0275 has not been applied, or something re-added one', n;
  end if;
  raise notice 'A-08 OK: no stray permissive write policy on any money table';
end $$;

-- ── Invariant 8: the sweep actually sweeps ──────────────────────────────────
--
-- Invariant 7 asserts the end state, but in a freshly replayed database there
-- was never any drift to remove — so on its own it proves the migration set is
-- self-consistent, not that 0275 does its job. Production is the case that
-- matters, and CI cannot reproduce production's drift.
--
-- So: inject the drift, then re-run THE REAL MIGRATION FILE (via \ir, not a
-- copy pasted in here — a copy would drift from the original and start proving
-- the wrong thing) and assert the stray is gone and the intended policies
-- survived. 0275 is idempotent by construction, which is what makes this safe
-- to do against an already-migrated database.
--
-- Two shapes again, matching invariant 5: the one the production audit
-- describes, and the worst case that could exist.
do $$
begin
  drop policy if exists wallet_transactions_sweep_probe_a on public.wallet_transactions;
  drop policy if exists wallet_transactions_sweep_probe_b on public.wallet_transactions;
  create policy wallet_transactions_sweep_probe_a on public.wallet_transactions
    for insert to authenticated with check (public.is_family_member(family_id));
  create policy wallet_transactions_sweep_probe_b on public.wallet_transactions
    for all to public using (true) with check (true);

  if (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.relname = 'wallet_transactions'
        and p.polname in ('wallet_transactions_sweep_probe_a','wallet_transactions_sweep_probe_b')) <> 2 then
    raise exception 'A-08 FAIL: could not inject the drift the sweep is meant to remove';
  end if;
  raise notice 'A-08: injected 2 stray permissive write policies on wallet_transactions';
end $$;

\ir ../../supabase/migrations/0275_money_permissive_write_sweep.sql

do $$
declare strays int; intended int;
begin
  select count(*) into strays
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname = 'wallet_transactions'
    and p.polname in ('wallet_transactions_sweep_probe_a','wallet_transactions_sweep_probe_b');

  -- Belt and braces: if the sweep did not remove them, this probe must not
  -- leave a `to public using (true)` policy behind on a money table.
  drop policy if exists wallet_transactions_sweep_probe_a on public.wallet_transactions;
  drop policy if exists wallet_transactions_sweep_probe_b on public.wallet_transactions;

  if strays <> 0 then
    raise exception 'A-08 FAIL: 0275 left % injected stray policy(ies) on wallet_transactions', strays;
  end if;

  -- The sweep must not have taken the intended policies or the guards with it.
  select count(*) into intended
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname = 'wallet_transactions'
    and p.polname in ('wallet_transactions_select',
                      'wallet_transactions_mng_insert','wallet_transactions_mng_update','wallet_transactions_mng_delete',
                      'wallet_transactions_manager_insert_guard','wallet_transactions_manager_update_guard',
                      'wallet_transactions_manager_delete_guard');
  if intended <> 7 then
    raise exception 'A-08 FAIL: after the sweep only %/7 intended wallet_transactions policies remain', intended;
  end if;

  raise notice 'A-08 OK: 0275 removed both injected strays and kept all 7 intended policies';
end $$;

-- ── Invariant 9: the guards are real, not merely counted ────────────────────
--
-- This asserts, in CI, the same three conditions docs/audit/money-policy-diagnostic.sql
-- reports to an operator. It exists because that diagnostic is named
-- *-diagnostic.sql rather than *-check.sql, so run-probes.sh does not glob it —
-- and its first version shipped with a bug that would have reported a FALSE
-- ALL-CLEAR, with nothing in CI able to catch it. Encoding the logic here means
-- the shape the operator query relies on is exercised against a real Postgres on
-- every PR.
--
-- Three conditions, because counting restrictive policies proves none of them:
--   * RLS ENABLED. Three immaculate restrictive policies on a table with row
--     security switched off are inert, and the table is wide open.
--   * The guard REQUIRES MANAGER ROLE. A restrictive policy with a permissive
--     rule takes nothing away.
--   * All THREE COMMANDS covered. Three insert guards and no delete guard is
--     not a backstop; distinct polcmd, not a count of policies.
--
-- Tables absent from this database are skipped rather than failed: 0275 itself
-- skips a finance table that does not exist or carries no family_id.
do $$
declare
  t         text;
  rls       boolean;
  commands  int;
  offenders text[] := '{}';
begin
  foreach t in array array[
    'family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules',
    'financial_accounts','transactions','budgets','bills','savings_goals']
  loop
    if to_regclass('public.' || t) is null then continue; end if;

    select c.relrowsecurity into rls from pg_class c where c.oid = to_regclass('public.' || t);
    if not coalesce(rls, false) then
      offenders := offenders || (t || ' (RLS DISABLED - its policies are inert)');
      continue;
    end if;

    select count(distinct p.polcmd) into commands
    from pg_policy p
    where p.polrelid = to_regclass('public.' || t)
      and not p.polpermissive
      and p.polcmd in ('a','w','d')
      and coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
          coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%can_manage_family%';

    if commands <> 3 then
      offenders := offenders || (t || ' (' || commands || '/3 manager-gated restrictive write guards)');
    end if;
  end loop;

  if array_length(offenders, 1) is not null then
    raise exception 'A-08 FAIL: money tables without a real write backstop: %', array_to_string(offenders, ', ');
  end if;
  raise notice 'A-08 OK: every money table has RLS on and three manager-gated restrictive write guards';
end $$;

select 'A-08 wallet write-RLS probe (0217 mint-lock + 0224 audit append-only + 0254 drift resilience + 0275 stray sweep): ALL INVARIANTS PASSED' as result;
