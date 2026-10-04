-- ── A card hold, a parent's spend or an investment approval does not deadlock
--    against a top-up for the same child (0491) ──────────────────────────────
--
-- `wallet_credit_child_ledger` and `wallet_transfer` (0205) lock the child
-- wallet FOR UPDATE, then the buckets. `wallet_reserve_card_auth` (0155),
-- `wallet_debit_spend_bucket` (0342) and `invest_decide_order` (0447) locked a
-- bucket FOR UPDATE first, and only then — through their ledger insert's
-- foreign key — took KEY SHARE on the wallet. Two orders, one cycle: under
-- pgbench on PostgreSQL 16, 73 of 78 reserve/credit transactions and 54 of 63
-- debit/credit transactions died `deadlock detected` (#771 comment
-- 5982113631). A reserve that dies is a declined card (`reserveCardAuth` fails
-- closed); a credit that dies is an allowance or a gift that did not land.
-- 0491 takes KEY SHARE on the wallet before the bucket in all three.
--
-- WHAT THIS ARRANGES, per function, on real connections (dblink):
--
--   1. a holder opens a transaction and takes the child wallet FOR UPDATE —
--      the first half of a credit;
--   2. the function under test is dispatched and runs until it parks on a lock
--      (the probe polls `pg_locks` until it sees it waiting);
--   3. the holder then runs the REAL `wallet_credit_child_ledger`, whose second
--      half locks the buckets, and commits.
--
-- With the bucket taken first, step 2 parks HOLDING the bucket, step 3 waits
-- for it, and the cycle is certain: one side dies `deadlock detected`. With
-- the wallet taken first, step 2 parks holding nothing, step 3 completes, and
-- step 2 proceeds. The interleaving is constructed, not hoped for, so the
-- result does not depend on load.
--
--   4. NEGATIVE CONTROL: the reserve is put back to its pre-0491 body (the
--      same body with the added lock removed), committed so the other
--      connections see it, raced the same way, and REQUIRED to deadlock. The
--      real definition is restored by a top-level statement that runs
--      unconditionally, and the restore verifies itself.
--   5. the order itself, read from the catalogue: in each of the three, the
--      wallet's KEY SHARE comes before the first bucket lock.
--
-- Everything the other connections must see is written by top-level
-- statements (committed); the stages record verdicts instead of raising, the
-- debris is removed, and only then does the verdict raise. Run it against a
-- throwaway database (docs/audit/verify-pg.sh); as with the other wallet race
-- probes, a hard kill between the control and its restore would leave the
-- pre-0491 reserve installed, and the restore assertion says so.

create extension if not exists dblink;

-- The same revoke wallet-concurrency-check.sql carries, for the same reason:
-- pg-bootstrap's default privileges hand the extension's functions to the
-- client roles, and this probe must not leave them that way.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    join pg_extension e on e.oid = d.refobjid
    where e.extname = 'dblink'
      and p.proowner = (select oid from pg_roles where rolname = current_user)
      and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- ── Committed seed ──────────────────────────────────────────────────────────
delete from public.invest_holdings     where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.invest_orders       where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.wallet_audit_logs   where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.wallet_transactions where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.wallet_buckets      where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.child_wallets       where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.family_members      where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.families            where id        = '00000000-0000-4000-8000-0000000491f0';
delete from public.invest_assets       where id        = '00000000-0000-4000-8000-0000000491e0';
delete from auth.users                 where id        = '00000000-0000-4000-8000-000000049101';

insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000049101', 'lock-order-parent@example.com');
insert into public.families (id, name, created_by)
values ('00000000-0000-4000-8000-0000000491f0', 'Lock Order House', '00000000-0000-4000-8000-000000049101');
-- `on_family_created` enrols the creator; the debit and the investment
-- approval check `can_manage_family`.
update public.family_members set role = 'parent', is_active = true
 where family_id = '00000000-0000-4000-8000-0000000491f0' and user_id = '00000000-0000-4000-8000-000000049101';
insert into public.family_members (id, family_id, display_name, role, is_active)
values ('00000000-0000-4000-8000-0000000491a2', '00000000-0000-4000-8000-0000000491f0', 'Lock Order Child', 'child', true);
insert into public.child_wallets (id, family_id, member_id)
values ('00000000-0000-4000-8000-0000000491c0', '00000000-0000-4000-8000-0000000491f0', '00000000-0000-4000-8000-0000000491a2');
insert into public.wallet_buckets (family_id, child_wallet_id, kind, label)
select '00000000-0000-4000-8000-0000000491f0', '00000000-0000-4000-8000-0000000491c0', k::public.wallet_bucket_kind, initcap(k)
  from unnest(array['spend', 'save', 'give', 'invest']) k;
insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
select '00000000-0000-4000-8000-0000000491f0', '00000000-0000-4000-8000-0000000491c0', b.id, 'allowance', 'completed', 'credit', 10000, 'seed $100'
  from public.wallet_buckets b
 where b.child_wallet_id = '00000000-0000-4000-8000-0000000491c0';
insert into public.invest_assets (id, symbol, name, price_cents)
values ('00000000-0000-4000-8000-0000000491e0', 'LOCK0491', 'Lock order probe fund', 100);
-- One pending order per stage, filed earlier and committed, the way a child's
-- request reaches a parent's approval.
insert into public.invest_orders (id, family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, requested_by)
values ('00000000-0000-4000-8000-0000000491b1', '00000000-0000-4000-8000-0000000491f0', '00000000-0000-4000-8000-0000000491c0',
        '00000000-0000-4000-8000-0000000491e0', 'buy', 1, 100, 100, '00000000-0000-4000-8000-000000049101');

-- Acting as the parent, for the two functions that check their caller. Top
-- level so the racing connection can see it.
create or replace function public.lock0491_as_parent(p_call text) returns text
language plpgsql
as $fn$
declare v_out text;
begin
  perform set_config('request.jwt.claim.sub',  '00000000-0000-4000-8000-000000049101', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000049101","role":"authenticated"}', true);
  execute 'select (' || p_call || ')::text' into v_out;
  return v_out;
end
$fn$;

drop table if exists lock0491_verdict;
create temp table lock0491_verdict (stage text primary key, deadlocked boolean, parked boolean, racer text, credit text);

drop table if exists lock0491_saved;
create temp table lock0491_saved as
select pg_get_functiondef(p.oid) as def, p.prosrc as body
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'wallet_reserve_card_auth';

-- ── The arranged race ───────────────────────────────────────────────────────
create or replace procedure public.lock0491_race(p_stage text, p_call text)
language plpgsql
as $proc$
declare
  v_family constant uuid := '00000000-0000-4000-8000-0000000491f0';
  v_wallet constant uuid := '00000000-0000-4000-8000-0000000491c0';
  v_conn   text;
  v_parked boolean := false;
  v_waited int := 0;
  v_credit text;
  v_racer  text;
  v_credit_err text;
  v_racer_err text;
begin
  v_conn := 'dbname=' || current_database()
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
    || ' port=' || current_setting('port')
    || ' user=' || current_user;

  -- 1. The holder: the first half of a credit.
  perform dblink_connect('lock0491_hold', v_conn || ' application_name=lock0491_holder');
  perform dblink_exec('lock0491_hold', 'set lock_timeout = ''15s''');
  perform dblink_exec('lock0491_hold', 'begin');
  perform * from dblink('lock0491_hold', format(
    'select id from public.child_wallets where id = %L for update', v_wallet)) as t(id uuid);

  -- 2. The function under test, until it parks.
  perform dblink_connect('lock0491_racer', v_conn || ' application_name=lock0491_racer');
  perform dblink_exec('lock0491_racer', 'set lock_timeout = ''15s''');
  perform dblink_send_query('lock0491_racer', 'select (' || p_call || ')::text');
  while v_waited < 10000 loop
    select exists (
      select 1 from pg_locks l join pg_stat_activity sa on sa.pid = l.pid
       where sa.application_name = 'lock0491_racer' and not l.granted
    ) into v_parked;
    exit when v_parked;
    perform pg_sleep(0.005);
    v_waited := v_waited + 5;
  end loop;

  -- 3. The second half of the credit: the real function, then commit.
  select r into v_credit from dblink('lock0491_hold', format(
    'select public.wallet_credit_child_ledger(%L, %L, 400, %L, %L, null)::text',
    v_family, v_wallet, 'allowance', 'lock order probe ' || p_stage), false) as t(r text);
  v_credit_err := dblink_error_message('lock0491_hold');
  if v_credit is null then
    perform dblink_exec('lock0491_hold', 'rollback', false);
  else
    perform dblink_exec('lock0491_hold', 'commit', false);
  end if;

  select r into v_racer from dblink_get_result('lock0491_racer', false) as t(r text);
  v_racer_err := dblink_error_message('lock0491_racer');
  perform * from dblink_get_result('lock0491_racer', false) as t(r text);

  perform dblink_disconnect('lock0491_hold');
  perform dblink_disconnect('lock0491_racer');

  insert into lock0491_verdict (stage, deadlocked, parked, racer, credit)
  values (p_stage,
          coalesce(v_credit_err, '') ~ 'deadlock detected' or coalesce(v_racer_err, '') ~ 'deadlock detected',
          v_parked,
          coalesce(v_racer, 'failed: ' || v_racer_err),
          coalesce(v_credit, 'failed: ' || v_credit_err))
  -- The control stage may already hold its reason for not running.
  on conflict (stage) do nothing;
exception when others then
  begin perform dblink_exec('lock0491_hold', 'rollback', false); exception when others then null; end;
  begin perform dblink_disconnect('lock0491_hold');   exception when others then null; end;
  begin perform dblink_disconnect('lock0491_racer');  exception when others then null; end;
  insert into lock0491_verdict (stage, deadlocked, parked, racer, credit)
  values (p_stage, null, null, 'raised: ' || sqlerrm, null)
  on conflict (stage) do update set deadlocked = null, racer = 'raised: ' || sqlerrm;
end
$proc$;

-- ── Stages: each of the three, as they are ──────────────────────────────────
call public.lock0491_race('reserve', $c$public.wallet_reserve_card_auth('00000000-0000-4000-8000-0000000491f0', '00000000-0000-4000-8000-0000000491c0', 100, 'lock0491-auth-real', 'Lock order probe')$c$);
call public.lock0491_race('debit', $c$public.lock0491_as_parent($q$public.wallet_debit_spend_bucket('00000000-0000-4000-8000-0000000491f0'::uuid, '00000000-0000-4000-8000-0000000491c0'::uuid, 100::bigint, 'withdrawal'::public.wallet_txn_type, 'Lock order probe', '00000000-0000-4000-8000-000000049101'::uuid)$q$)$c$);
call public.lock0491_race('invest', $c$public.lock0491_as_parent($q$public.invest_decide_order('00000000-0000-4000-8000-0000000491b1'::uuid, true)$q$)$c$);

-- ── Stage 4: the negative control ───────────────────────────────────────────
-- The pre-0491 reserve is today's body without the wallet lock. If the text
-- below is not in the body, the control would race an unchanged function and
-- prove nothing, so that is recorded and fails the verdict.
do $ctl$
declare
  v_body text := (select body from lock0491_saved);
  v_lock constant text := E'  perform 1 from public.child_wallets\n   where id = p_child_wallet and family_id = p_family\n   for key share;\n';
begin
  if position(v_lock in v_body) = 0 then
    insert into lock0491_verdict (stage, deadlocked, parked, racer, credit)
    values ('control', null, null, 'the wallet lock 0491 adds was not found in the reserve body', null);
    return;
  end if;
  execute format(
    'create or replace function public.wallet_reserve_card_auth(p_family uuid, p_child_wallet uuid, p_amount bigint, p_auth_id text, p_description text) '
    || 'returns boolean language plpgsql security definer set search_path = public as %L',
    replace(v_body, v_lock, ''));
end
$ctl$;
call public.lock0491_race('control', $c$public.wallet_reserve_card_auth('00000000-0000-4000-8000-0000000491f0', '00000000-0000-4000-8000-0000000491c0', 100, 'lock0491-auth-control', 'Lock order probe')$c$);

-- The restore: unconditional, top level, and verified.
do $restore$
begin
  execute (select def from lock0491_saved);
end
$restore$;
do $verify$
begin
  if (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'wallet_reserve_card_auth')
     is distinct from (select body from lock0491_saved) then
    raise exception 'lock order probe: the real wallet_reserve_card_auth was NOT restored — re-apply 0491 before trusting this database';
  end if;
end
$verify$;

-- ── Stage 5: the order, from the catalogue ──────────────────────────────────
insert into lock0491_verdict (stage, deadlocked, parked, racer, credit)
select 'order:' || p.proname, null, null,
       case
         when position('for key share' in p.prosrc) = 0 then 'no wallet key share'
         when position('from public.child_wallets' in p.prosrc) > position('from public.wallet_buckets' in p.prosrc)
           then 'the bucket comes before the wallet'
         when position('for key share' in p.prosrc) > position('from public.wallet_buckets' in p.prosrc)
           then 'the key share comes after the bucket'
         else 'ok'
       end, null
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('wallet_reserve_card_auth', 'wallet_debit_spend_bucket', 'invest_decide_order');

-- ── Leave nothing behind, then the verdict ──────────────────────────────────
drop procedure if exists public.lock0491_race(text, text);
drop function  if exists public.lock0491_as_parent(text);
delete from public.invest_holdings     where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.invest_orders       where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.wallet_audit_logs   where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.wallet_transactions where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.wallet_buckets      where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.child_wallets       where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.family_members      where family_id = '00000000-0000-4000-8000-0000000491f0';
delete from public.families            where id        = '00000000-0000-4000-8000-0000000491f0';
delete from public.invest_assets       where id        = '00000000-0000-4000-8000-0000000491e0';
delete from auth.users                 where id        = '00000000-0000-4000-8000-000000049101';

do $verdict$
declare
  failures text[] := '{}';
  r record;
begin
  for r in select * from lock0491_verdict where stage in ('reserve', 'debit', 'invest') order by stage loop
    if r.deadlocked is null then
      failures := array_append(failures, format('%s: the race did not run (%s)', r.stage, r.racer));
    elsif not r.parked then
      failures := array_append(failures, format('%s: never parked behind the held wallet, so the race proves nothing', r.stage));
    elsif r.deadlocked then
      failures := array_append(failures, format('%s deadlocked against a top-up: racer %s; credit %s', r.stage, r.racer, r.credit));
    elsif r.racer like 'failed:%' or r.credit like 'failed:%' then
      failures := array_append(failures, format('%s: a side failed without a deadlock: racer %s; credit %s', r.stage, r.racer, r.credit));
    end if;
  end loop;
  if (select count(*) from lock0491_verdict where stage in ('reserve', 'debit', 'invest')) <> 3 then
    failures := array_append(failures, 'not every function was raced');
  end if;

  select * into r from lock0491_verdict where stage = 'control';
  if r is null or r.deadlocked is null then
    failures := array_append(failures, format('negative control did not run: %s', coalesce(r.racer, 'no row')));
  elsif not r.deadlocked then
    failures := array_append(failures, format('negative control: the pre-0491 reserve did NOT deadlock (parked=%s, racer %s, credit %s) — this probe cannot see the bug it guards', r.parked, r.racer, r.credit));
  end if;

  for r in select * from lock0491_verdict where stage like 'order:%' order by stage loop
    if r.racer <> 'ok' then failures := array_append(failures, format('%s: %s', r.stage, r.racer)); end if;
  end loop;
  if (select count(*) from lock0491_verdict where stage like 'order:%') <> 3 then
    failures := array_append(failures, 'not every function''s lock order was read');
  end if;

  if array_length(failures, 1) > 0 then
    raise exception E'0491 lock order probe failed:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice '0491 lock order probe: reserve, debit and investment approval each parked behind a held wallet and let a top-up through with no deadlock; the pre-0491 reserve deadlocked (negative control); the wallet comes before the bucket in all three — PASSED';
end
$verdict$;
