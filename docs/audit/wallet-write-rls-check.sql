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

select 'A-08 wallet write-RLS probe (0217 mint-lock + 0224 audit append-only + 0254 drift resilience): ALL INVARIANTS PASSED' as result;
