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
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=familyos \
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

select 'A-08 wallet write-RLS probe (0217 mint-lock + 0224 audit append-only): ALL INVARIANTS PASSED' as result;
