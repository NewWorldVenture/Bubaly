-- ── A-15: two simultaneous card authorizations cannot both approve ───────────
--
-- `wallet-overspend-check.sql` runs a fixed SEQUENTIAL sequence and notes, in
-- passing, that a counted hold is what makes "concurrent auths serialize under
-- its FOR UPDATE lock". That is a statement about the mechanism, not a test of
-- it: nothing there ever runs two authorizations at once, so the property most
-- worth knowing about money — that a child cannot spend the same dollar twice
-- by tapping twice — was asserted rather than demonstrated.
--
-- This races them for real, on two separate connections, and asserts exactly
-- one is approved.
--
-- STRUCTURE MATTERS HERE. The seed is written by plain top-level statements so
-- psql commits each one. Inside a `do $$ … $$` block it would not be: that block
-- is a single transaction, the rows it writes stay uncommitted, and a dblink
-- session taking `FOR UPDATE` on them blocks on that transaction forever. The
-- first draft of this probe did exactly that and hung.
--
-- dblink is what opens the second session. Where it is unavailable the probe
-- SKIPS with a notice rather than failing — a check that cannot run is not a
-- check that found a problem, and conflating the two teaches people to ignore
-- red.

create extension if not exists dblink;

-- Committed seed: a fresh $10 wallet, isolated from the sequential probe's.
delete from public.wallet_transactions where child_wallet_id = 'd0000000-0000-4000-8000-0000000000c9';
delete from public.wallet_buckets      where child_wallet_id = 'd0000000-0000-4000-8000-0000000000c9';
delete from public.child_wallets       where id              = 'd0000000-0000-4000-8000-0000000000c9';
delete from public.family_members      where id              = 'e0000000-0000-4000-8000-0000000000c9';

insert into public.family_members (id, family_id, display_name, role)
values ('e0000000-0000-4000-8000-0000000000c9', '00000000-0000-4000-8000-0000000000f1', 'Race Child', 'child');

insert into public.child_wallets (id, family_id, member_id)
values ('d0000000-0000-4000-8000-0000000000c9', '00000000-0000-4000-8000-0000000000f1', 'e0000000-0000-4000-8000-0000000000c9');

insert into public.wallet_buckets (family_id, child_wallet_id, kind, label)
values ('00000000-0000-4000-8000-0000000000f1', 'd0000000-0000-4000-8000-0000000000c9', 'spend', 'Spend');

insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
select '00000000-0000-4000-8000-0000000000f1', 'd0000000-0000-4000-8000-0000000000c9', b.id,
       'allowance', 'completed', 'credit', 1000, 'seed $10'
from public.wallet_buckets b
where b.child_wallet_id = 'd0000000-0000-4000-8000-0000000000c9';

do $$
declare
  v_family uuid := '00000000-0000-4000-8000-0000000000f1';
  v_wallet uuid := 'd0000000-0000-4000-8000-0000000000c9';
  v_conn   text;
  raw_a    text;
  raw_b    text;
  approved_a boolean;
  approved_b boolean;
  start_a timestamptz; end_a timestamptz;
  start_b timestamptz; end_b timestamptz;
  n_approved int;
  held bigint;
begin
  if to_regprocedure('public.dblink(text,text)') is null then
    raise notice 'A-15 SKIP: dblink unavailable, concurrency not exercised here';
    perform set_config('a15.skipped', 'dblink unavailable', false);
    return;
  end if;

  v_conn := 'dbname=' || current_database()
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
    || ' port=' || current_setting('port')
    || ' user=' || current_user;

  -- ASYNC on purpose. Two plain dblink() calls would run one after the other,
  -- each in its own committed transaction — that proves a hold is counted across
  -- transactions, which is worth knowing but is NOT the same as proving two
  -- OVERLAPPING transactions serialize. Sending both before collecting either
  -- puts them genuinely in flight together, which is the thing FOR UPDATE is
  -- there for.
  perform dblink_connect('a15_a', v_conn);
  perform dblink_connect('a15_b', v_conn);

  -- Each side reports the clock on BOTH sides of its own call, so the probe can
  -- prove it actually raced rather than assume it. See the overlap gate below.
  perform dblink_send_query('a15_a',
    format('select clock_timestamp()::text||''~''||public.wallet_reserve_card_auth(%L,%L,800,%L,%L)::text||''~''||clock_timestamp()::text',
           v_family, v_wallet, 'a15_race_a', 'Store A'));
  perform dblink_send_query('a15_b',
    format('select clock_timestamp()::text||''~''||public.wallet_reserve_card_auth(%L,%L,800,%L,%L)::text||''~''||clock_timestamp()::text',
           v_family, v_wallet, 'a15_race_b', 'Store B'));

  select v into raw_a from dblink_get_result('a15_a') as t(v text);
  select v into raw_b from dblink_get_result('a15_b') as t(v text);

  start_a := split_part(raw_a, '~', 1)::timestamptz;
  approved_a := split_part(raw_a, '~', 2)::boolean;
  end_a := split_part(raw_a, '~', 3)::timestamptz;
  start_b := split_part(raw_b, '~', 1)::timestamptz;
  approved_b := split_part(raw_b, '~', 2)::boolean;
  end_b := split_part(raw_b, '~', 3)::timestamptz;

  -- Drain the trailing empty result each async connection returns, then close.
  perform * from dblink_get_result('a15_a') as t(v text);
  perform * from dblink_get_result('a15_b') as t(v text);
  perform dblink_disconnect('a15_a');
  perform dblink_disconnect('a15_b');

  -- THE OVERLAP GATE, and the reason it is a SKIP rather than an assertion.
  --
  -- `dblink_send_query` puts both queries in flight, but nothing GUARANTEES
  -- they overlap: on a loaded or single-core box A can finish before B is
  -- scheduled. When that happens this probe still passes — one approval, $8
  -- held — while having demonstrated nothing about concurrency, because it
  -- never ran two overlapping transactions. That is a VACUOUS pass, and a
  -- green line that proves nothing is worse than a missing one: it is the
  -- decoration this audit keeps finding elsewhere.
  --
  -- Measured here across 10 instrumented runs: the two sessions started within
  -- ~0.1ms of each other and overlapped EVERY time, and the winner alternated
  -- (A won 5, B won 5), which is what a real race looks like. So this gate is
  -- expected to be silent. It exists for the environment where it is not.
  --
  -- It SKIPS rather than FAILS on purpose. Not overlapping is a property of the
  -- machine, not of the wallet, and failing a money boundary because a runner
  -- was busy teaches exactly the habit AUDIT-004 was written against: that a
  -- red boundary probe is something you re-run until it goes away.
  if not (start_a < end_b and start_b < end_a) then
    raise notice 'A-15 SKIP: the two sessions did not overlap (a=[%,%], b=[%,%]); concurrency was NOT exercised',
      start_a, end_a, start_b, end_b;
    perform set_config('a15.skipped', 'sessions did not overlap', false);
    return;  -- both connections are already closed above.
  end if;

  perform set_config('a15.skipped', '', false);
  n_approved := (case when approved_a then 1 else 0 end) + (case when approved_b then 1 else 0 end);
  if n_approved <> 1 then
    raise exception 'A-15 FAIL: % of 2 simultaneous $8 authorizations approved against $10 (a=%, b=%)',
      n_approved, approved_a, approved_b;
  end if;

  -- And the money actually held is one approval's worth, not two.
  select coalesce(sum(amount_cents), 0) into held
  from public.wallet_transactions
  where child_wallet_id = v_wallet and direction = 'debit'
    and status in ('pending', 'processing', 'requires_parent_approval');

  if held <> 800 then
    raise exception 'A-15 FAIL: $% held after the race, expected $8.00', (held / 100.0);
  end if;

  raise notice 'A-15 OK: 1 of 2 OVERLAPPING $8 authorizations approved against $10; $8.00 held (a=[%,%], b=[%,%])',
    start_a, end_a, start_b, end_b;
end $$;

-- The summary line reads the block's own verdict rather than asserting one.
-- Before this, a SKIP still printed "ALL INVARIANTS PASSED" — which is the
-- green-line-that-proves-nothing the overlap gate above exists to prevent, so
-- leaving it would have made the gate self-defeating.
select case coalesce(current_setting('a15.skipped', true), '')
         when '' then 'A-15 wallet concurrency probe: ALL INVARIANTS PASSED'
         else 'A-15 wallet concurrency probe: SKIPPED — '
              || current_setting('a15.skipped', true)
              || '; the concurrency invariant was NOT exercised'
       end as result;
