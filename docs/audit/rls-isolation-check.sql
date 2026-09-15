-- ── A-03 Tenant-isolation RLS probe ─────────────────────────────────────────
-- Reusable cross-family isolation proof. Run against the verify-pg.sh harness
-- (which seeds family A = the anchor). This script provisions a second tenant
-- (family B / user B) and asserts, under the `authenticated` role acting AS user
-- B, that B can neither read nor write family A's rows, and that every
-- family-scoped table has RLS enabled.
--
--   bash docs/audit/verify-pg.sh up
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/rls-isolation-check.sql
--
-- Exit is non-zero (via RAISE EXCEPTION) if any invariant fails.

\set FA '00000000-0000-4000-8000-0000000000f1'
\set FB '00000000-0000-4000-8000-0000000000fb'
\set UB '00000000-0000-4000-8000-0000000000b2'

-- Provision tenant B (idempotent). The family trigger creates B's parent member.
insert into auth.users (id, email) values (:'UB','userb@example.com') on conflict do nothing;
do $$ begin if to_regclass('public.profiles') is not null then
  insert into public.profiles (id, full_name) values ('00000000-0000-4000-8000-0000000000b2','B Family') on conflict do nothing;
end if; end $$;
insert into public.families (id, name, created_by) values (:'FB','The B Family',:'UB') on conflict do nothing;
insert into public.calendar_events (family_id, title, starts_at) values (:'FB','B private event', now()) on conflict do nothing;

-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

-- ── Invariant 1: every family-scoped table has RLS enabled ──────────────────
do $$
declare n int;
begin
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
  join information_schema.columns col
    on col.table_schema='public' and col.table_name=c.relname and col.column_name='family_id'
  where ns.nspname='public' and c.relkind='r' and c.relrowsecurity = false;
  if n <> 0 then raise exception 'A-03 FAIL: % family-scoped table(s) have RLS DISABLED', n; end if;
  raise notice 'A-03 OK: all family-scoped tables have RLS enabled';
end $$;

-- ── Invariant 2: user B cannot READ family A ────────────────────────────────
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000f1';  -- placeholder, reset below
reset role;

-- A read probe over an EMPTY table returns 0 for the wrong reason. SEED_ALL
-- leaves `wallet_transactions` with no rows for the anchor family, so for the
-- highest-risk money table on the list this probe proved nothing at all — it
-- reported isolation it had never tested. One fixture row, written as the owner,
-- gives it something to fail on.
insert into public.wallet_transactions (family_id, type, direction, amount_cents, description)
select :'FA', 'adjustment'::wallet_txn_type, 'credit'::wallet_txn_direction, 4200, 'A-03 isolation fixture'
where not exists (
  select 1 from public.wallet_transactions
  where family_id = :'FA' and description = 'A-03 isolation fixture');

do $$
declare
  tbls text[] := array['family_members','calendar_events','wallet_transactions','notes',
                       'documents','grocery_items','family_recipes','chore_assignments',
                       'family_photos','family_messages'];
  t text; leaked int; baseline int;
begin
  -- FIRST, as the owner: every table on the list must actually hold family-A
  -- rows. Without this the loop below is satisfied by an empty table, and the
  -- probe passes hardest exactly where the data is missing — a green light that
  -- means "nothing to read", not "reading is blocked".
  foreach t in array tbls loop
    execute format('select count(*) from public.%I where family_id = %L', t, '00000000-0000-4000-8000-0000000000f1') into baseline;
    if baseline = 0 then
      raise exception 'A-03 FAIL: family A has no rows in %, so this probe cannot prove B is blocked from reading it', t;
    end if;
  end loop;

  -- THEN, as user B: none of those rows may be visible.
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  foreach t in array tbls loop
    execute format('select count(*) from public.%I where family_id = %L', t, '00000000-0000-4000-8000-0000000000f1') into leaked;
    if leaked <> 0 then raise exception 'A-03 FAIL: user B read % rows from family A table %', leaked, t; end if;
  end loop;
  raise notice 'A-03 OK: user B read 0 rows across % NON-EMPTY family-A tables', array_length(tbls,1);
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 3: user B cannot WRITE family A (WITH CHECK / USING) ───────────
do $$
declare blocked boolean := false; affected int;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  begin
    insert into public.calendar_events (family_id, title, starts_at)
    values ('00000000-0000-4000-8000-0000000000f1','HACK by B', now());
  exception when insufficient_privilege or others then blocked := true; end;
  if not blocked then raise exception 'A-03 FAIL: user B INSERTed into family A'; end if;

  update public.calendar_events set title='PWNED' where family_id='00000000-0000-4000-8000-0000000000f1';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'A-03 FAIL: user B UPDATEd % family-A rows', affected; end if;

  delete from public.notes where family_id='00000000-0000-4000-8000-0000000000f1';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'A-03 FAIL: user B DELETEd % family-A rows', affected; end if;

  raise notice 'A-03 OK: user B write attempts on family A all blocked (insert/update/delete)';
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 4: SECURITY DEFINER RPCs reject cross-family callers ───────────
-- SECURITY DEFINER runs as owner and bypasses RLS, so each family-taking RPC must
-- gate on public.is_family_member(p_family). Prove a representative mutation RPC
-- rejects user B acting on family A.
-- NO blanket `grant execute on all functions ... to authenticated` here.
--
-- One used to stand on this line so the call below could run as `authenticated`.
-- It was never needed — CREATE FUNCTION grants EXECUTE to PUBLIC, so
-- `authenticated` can already call this RPC (verified on a pristine 305-migration
-- replay: has_function_privilege('authenticated', …) = true with no probe run).
--
-- What it DID do was undo the deliberate revokes in 0204/0253/0288, handing
-- `authenticated` EXECUTE on claim_ai_runs and the four loyalty RPCs — the exact
-- cross-tenant hole F-006 closed. Probes glob alphabetically, so
-- privileged-rpc-grants-check (p) ran BEFORE this file (r) and passed, and every
-- run after that saw a poisoned database. A probe suite whose answer depends on
-- what ran before it is not evidence, so the grant is gone.
do $$
declare rejected boolean := false;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  begin
    perform public.marketplace_create_circle('00000000-0000-4000-8000-0000000000f1','Hostile Circle');
  exception when others then
    rejected := (sqlerrm ilike '%not a member%');
  end;
  if not rejected then raise exception 'A-03 FAIL: marketplace_create_circle accepted a cross-family caller'; end if;
  raise notice 'A-03 OK: SECURITY DEFINER RPC rejected a cross-family caller';
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 5: provisioning RPCs reject cross-USER callers ────────────────
-- ensure_family_for_user / onboarding_claim_family provision or claim a family
-- for p_user_id; they must reject any caller whose auth.uid() != p_user_id
-- (except service_role), or one user could seize another's family.
-- A caller can be turned away two ways, and BOTH are a pass:
--   * the function runs and raises its own 'not authorized', or
--   * Postgres refuses the call outright — 42501, because EXECUTE is revoked
--     from `authenticated` and from PUBLIC, which is the stronger boundary.
-- Matching only the first is what let this invariant look meaningful while the
-- blanket grant that used to sit above was quietly restoring EXECUTE: remove the
-- grant and the real answer is 42501. What must never happen is the call
-- SUCCEEDING, so that is what this now distinguishes.
do $$
declare a boolean := false; b boolean := false;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  begin perform public.ensure_family_for_user('00000000-0000-4000-8000-000000000001','Stolen');
  exception when others then a := (sqlerrm ilike '%not authorized%' or sqlstate = '42501'); end;
  begin perform public.onboarding_claim_family('00000000-0000-4000-8000-000000000001','Stolen','UTC');
  exception when others then b := (sqlerrm ilike '%not authorized%' or sqlstate = '42501'); end;
  if not (a and b) then raise exception 'A-03 FAIL: a provisioning RPC accepted a cross-user caller (ensure=%, claim=%)', a, b; end if;
  raise notice 'A-03 OK: provisioning RPCs reject cross-user callers (in-function check or 42501)';
  perform set_config('role','postgres', true);
end $$;

select 'A-03 tenant-isolation probe: ALL INVARIANTS PASSED' as result;
