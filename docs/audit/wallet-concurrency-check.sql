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
-- STRUCTURE MATTERS HERE. Everything the two racing sessions must SEE is written
-- by plain top-level statements, so psql commits each one. Inside a `do $$ … $$`
-- block it would not be: that block is a single transaction, what it writes stays
-- uncommitted, and another session cannot see it — the seed rows, the helper
-- function and the neutered body below all depend on this. The first draft of
-- this probe seeded inside the block and hung forever on its own uncommitted rows.
--
-- dblink is what opens the other sessions. Where it is unavailable the probe
-- SKIPS with a notice rather than failing — a check that cannot run is not a
-- check that found a problem, and conflating the two teaches people to ignore
-- red.
--
-- ── WHY THE RACE IS ARRANGED RATHER THAN HOPED FOR ──────────────────────────
--
-- The previous version fired both authorizations with `dblink_send_query` and
-- HOPED they overlapped, gating on whether their clock spans happened to
-- intersect and SKIPPING when they did not. Its own comment recorded ten
-- instrumented runs that overlapped every time and concluded the gate "is
-- expected to be silent".
--
-- It is not silent. Measured on one machine, three ways:
--
--   * run on its own, 8 of 8 runs overlapped — which is what those ten runs saw;
--   * run inside the full 64-probe suite, it did NOT overlap:
--         a = [02:26:27.695127, 02:26:27.700092]
--         b = [02:26:27.700856, 02:26:27.714366]
--     b started 0.76ms after a FINISHED;
--   * run 20 times against six competing workers, 4 of 20 did not overlap.
--
-- So the old probe was not broken, which is worse: it was LOAD-SENSITIVE. It
-- reported the property on an idle machine and reported nothing at all on a busy
-- one, and both looked identical from outside, because one approval and $8 held
-- is exactly what a purely sequential pair produces. Ten runs measured that
-- machine at that moment, not the wallet. The cause is plain once seen:
-- `dblink_send_query` returns immediately, but DISPATCHING the second call costs
-- about as long as the RPC takes to run, so under load the first authorization
-- is over before the second is sent.
--
-- An advisory-lock starting gate was tried first: park both sides on a shared
-- lock, poll until both are parked, release. It is a real improvement on
-- dispatch latency and it is still not enough — 2 of 20 runs under the same load
-- failed with both sides provably parked and their spans still 23ms apart. The
-- lock is granted to both at once; being granted a lock is not being SCHEDULED,
-- and a starved backend can sit between `pg_advisory_lock_shared` and its next
-- statement for as long as the kernel likes. Wall-clock overlap cannot be
-- constructed on a box that will not run you.
--
-- So this version stops trying to make the two sessions overlap in time and
-- makes them CONTEND instead, which is the property actually under test:
--
--   1. a third session opens a transaction and takes `FOR UPDATE` on the spend
--      bucket row — the exact row `wallet_reserve_card_auth` locks;
--   2. both authorizations are dispatched; each runs until it reaches that same
--      `FOR UPDATE` and BLOCKS there, inside the RPC;
--   3. the probe polls `pg_locks` until it can see BOTH of them waiting;
--   4. the third session commits, and they are released into the contention.
--
-- Step 3 is the assertion that matters, and it is evidence rather than timing:
-- two backends parked on one row is what "concurrent" means here, and no amount
-- of CPU starvation can fake it or hide it — a descheduled backend still holds
-- its place in the lock queue. Clock stamps are still collected, but they are
-- now a consequence rather than the proof.
--
-- ONE RESIDUAL RISK, stated rather than left for someone to find. The negative
-- control must COMMIT its neutered body for the racing connections to see it,
-- so between that statement and the restore a few lines later there is a window
-- in which this database's wallet RPC does not lock. Nothing inside the probe
-- can raise in that window — the race records its verdict instead of throwing,
-- which is why it is written that way — but a hard kill (a CI timeout, a ^C)
-- would leave the unlocked body installed. The restore therefore VERIFIES
-- itself, and if you ever see this probe's restore assertion fire, re-apply the
-- migration that defines `wallet_reserve_card_auth` before trusting the
-- database. Run it against a throwaway instance, which is what
-- docs/audit/verify-pg.sh bootstraps.
--
-- Step 3 is also a DIRECT test of the guard. If someone removes the `FOR UPDATE`
-- from the RPC, the two sessions do not block, no waiters ever appear, and this
-- probe says so — where the old one would have gone on passing, since removing
-- the lock does not stop a sequential pair from producing one approval.

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

-- Instrumentation wrapper. Top-level and committed, so the racing sessions can
-- see it. A FUNCTION rather than a bare `select …, clock_timestamp(), rpc(…)`
-- because the evaluation order of a SELECT's target list is not guaranteed, and
-- a clock stamped after the call it is supposed to be timing measures nothing.
create or replace function public.a15_timed_auth(
  p_family uuid, p_wallet uuid, p_amount bigint, p_auth_id text, p_description text
) returns text
language plpgsql
as $fn$
declare
  v_start timestamptz;
  v_ok    boolean;
begin
  v_start := clock_timestamp();
  v_ok := public.wallet_reserve_card_auth(p_family, p_wallet, p_amount, p_auth_id, p_description);
  return v_start::text || '~' || v_ok::text || '~' || clock_timestamp()::text;
end
$fn$;

-- Where the verdict of each stage is recorded. A table rather than a variable
-- because the stages are separate top-level transactions: the negative control
-- has to be COMMITTED for the racing sessions to see it, so it cannot be rolled
-- back the way an in-process control would be, and its restore must run even
-- when its assertions fail. The stages therefore record rather than raise, a
-- top-level statement restores unconditionally, and the last stage does the
-- raising once the real function is safely back.
-- TEMP on purpose. These are the parent session's own scratch state — only the
-- helper function and the neutered body have to be visible to the two racing
-- connections — and a run that dies partway through must not leave tables
-- sitting in `public` for the next probe to trip over.
drop table if exists a15_verdict;
create temp table a15_verdict (stage text primary key, approved int, waiters int, held bigint, note text);

-- The real definition, saved verbatim before the negative control overwrites it.
drop table if exists a15_saved_fn;
create temp table a15_saved_fn as
select pg_get_functiondef(p.oid) as def, p.prosrc as body
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'wallet_reserve_card_auth';

-- ── The race, as a reusable procedure ────────────────────────────────────────
-- Used twice: once against the real RPC, once against the neutered one. Both
-- stages must run the SAME race, or the negative control proves nothing about
-- this probe.
create or replace procedure public.a15_race(p_stage text, p_expect_waiters boolean)
language plpgsql
as $proc$
declare
  v_family uuid := '00000000-0000-4000-8000-0000000000f1';
  v_wallet uuid := 'd0000000-0000-4000-8000-0000000000c9';
  v_conn   text;
  raw_a text; raw_b text;
  approved_a boolean; approved_b boolean;
  start_a timestamptz; end_a timestamptz;
  start_b timestamptz; end_b timestamptz;
  waiters int := 0; seen int := 0;
  waited_ms int := 0;
  v_held bigint;
begin
  v_conn := 'dbname=' || current_database()
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
    || ' port=' || current_setting('port')
    || ' user=' || current_user;

  -- The holder: a third session sitting on the very row the RPC locks.
  perform dblink_connect('a15_hold', v_conn || ' application_name=a15_holder');
  perform dblink_exec('a15_hold', 'begin');
  -- `dblink_exec` refuses a statement that returns rows, and `for update` on a
  -- select does return them, so the holder takes its lock through `dblink`.
  perform * from dblink('a15_hold', format(
    'select id from public.wallet_buckets where family_id = %L and child_wallet_id = %L and kind = ''spend'' for update',
    v_family, v_wallet)) as t(id uuid);

  -- The two racers. `application_name` is how the poll below identifies them
  -- without guessing at backend pids.
  perform dblink_connect('a15_a', v_conn || ' application_name=a15_racer');
  perform dblink_connect('a15_b', v_conn || ' application_name=a15_racer');

  perform dblink_send_query('a15_a', format(
    'select public.a15_timed_auth(%L,%L,800,%L,%L)', v_family, v_wallet, p_stage || '_a', 'Store A'));
  perform dblink_send_query('a15_b', format(
    'select public.a15_timed_auth(%L,%L,800,%L,%L)', v_family, v_wallet, p_stage || '_b', 'Store B'));

  -- Wait until both racers are provably parked on the held row. This is the
  -- concurrency evidence; `seen` keeps the high-water mark because once the
  -- holder commits the waiters vanish, and a poll that happens to look after
  -- that must not erase what it saw earlier.
  while waited_ms < 15000 loop
    select count(*) into waiters
      from pg_locks l join pg_stat_activity sa on sa.pid = l.pid
     where sa.application_name = 'a15_racer' and not l.granted;
    if waiters > seen then seen := waiters; end if;
    exit when seen >= 2;
    perform pg_sleep(0.002);
    waited_ms := waited_ms + 2;
  end loop;

  -- Release them into the contention.
  perform dblink_exec('a15_hold', 'commit');
  perform dblink_disconnect('a15_hold');

  select v into raw_a from dblink_get_result('a15_a') as t(v text);
  select v into raw_b from dblink_get_result('a15_b') as t(v text);
  start_a := split_part(raw_a, '~', 1)::timestamptz;
  approved_a := split_part(raw_a, '~', 2)::boolean;
  end_a := split_part(raw_a, '~', 3)::timestamptz;
  start_b := split_part(raw_b, '~', 1)::timestamptz;
  approved_b := split_part(raw_b, '~', 2)::boolean;
  end_b := split_part(raw_b, '~', 3)::timestamptz;

  perform * from dblink_get_result('a15_a') as t(v text);
  perform * from dblink_get_result('a15_b') as t(v text);
  perform dblink_disconnect('a15_a');
  perform dblink_disconnect('a15_b');

  -- Measured HERE, while the ledger still holds only what this race put in it.
  -- Reading it from the verdict block instead would total both stages: the
  -- negative control deliberately overdraws the same wallet a few statements
  -- later, and the first version of this probe duly reported $16.00 against the
  -- real RPC and failed itself.
  select coalesce(sum(amount_cents), 0) into v_held
    from public.wallet_transactions
   where child_wallet_id = v_wallet and direction = 'debit'
     and status in ('pending', 'processing', 'requires_parent_approval');

  insert into a15_verdict (stage, approved, waiters, held, note)
  values (p_stage,
          (case when approved_a then 1 else 0 end) + (case when approved_b then 1 else 0 end),
          seen, v_held,
          format('a=[%s,%s] b=[%s,%s] gate=%sms held=$%s', start_a, end_a, start_b, end_b, waited_ms, (v_held/100.0)));
exception when others then
  -- Never leak a holder transaction or a half-open connection into the next
  -- stage; record the failure instead of raising, so the restore still runs.
  begin perform dblink_disconnect('a15_hold'); exception when others then null; end;
  begin perform dblink_disconnect('a15_a');    exception when others then null; end;
  begin perform dblink_disconnect('a15_b');    exception when others then null; end;
  insert into a15_verdict (stage, approved, waiters, held, note)
  values (p_stage, -1, -1, -1, 'raised: ' || sqlerrm)
  on conflict (stage) do update set approved = -1, waiters = -1, held = -1, note = 'raised: ' || sqlerrm;
end
$proc$;

-- ── Stage 1: the real RPC ────────────────────────────────────────────────────
call public.a15_race('a15_real', true);

-- ── Stage 2: the negative control ────────────────────────────────────────────
-- The guard is the `for update` on the spend bucket. This replaces the body with
-- the read-then-insert it is there to prevent, and requires the overdraft to
-- ACTUALLY HAPPEN. A probe whose subject can be broken without it noticing is
-- decoration, and this repo has found enough of those to insist.
--
-- The `pg_sleep` between the read and the insert is not what makes the naive
-- version wrong — it is wrong at any window width. It makes the interleave
-- DETERMINISTIC, so the control asserts rather than hopes, which is the whole
-- complaint against the version of this probe being replaced.
--
-- This has to be committed for the racing sessions to see it, so it cannot be
-- rolled back. The restore below is a separate top-level statement that runs
-- unconditionally, and `a15_race` records its verdict instead of raising so that
-- nothing can jump over it.
create or replace function public.wallet_reserve_card_auth(
  p_family uuid, p_child_wallet uuid, p_amount bigint, p_auth_id text, p_description text
) returns boolean
language plpgsql security definer set search_path = public
as $neutered$
declare
  v_bucket uuid; v_spendable bigint;
begin
  if p_amount is null or p_amount <= 0 then return true; end if;
  -- THE GUARD, REMOVED: no `for update`.
  select id into v_bucket from public.wallet_buckets
   where family_id = p_family and child_wallet_id = p_child_wallet and kind = 'spend';
  if v_bucket is null then return false; end if;
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into v_spendable from public.wallet_transactions
   where family_id = p_family and bucket_id = v_bucket and status in ('completed', 'processing');
  perform pg_sleep(0.05);   -- widen the window so the interleave is certain
  if p_amount > v_spendable then return false; end if;
  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, stripe_ref, metadata)
  values (p_family, p_child_wallet, v_bucket, 'card_spend', 'processing', 'debit', p_amount,
          'Card hold', p_auth_id, jsonb_build_object('source', 'issuing', 'kind', 'hold'));
  return true;
end
$neutered$;

-- Reset the ledger so the control races against the same $10 the real stage did.
delete from public.wallet_transactions
 where child_wallet_id = 'd0000000-0000-4000-8000-0000000000c9' and direction = 'debit';

call public.a15_race('a15_neutered', false);

-- ── Restore, unconditionally, before anything is allowed to raise ────────────
do $$
declare v_def text; v_body text;
begin
  select def, body into v_def, v_body from a15_saved_fn;
  if v_def is null then
    raise exception 'A-15 FAIL: the real wallet_reserve_card_auth was not saved and CANNOT be restored';
  end if;
  execute v_def;

  -- PROVE the restore landed rather than trusting that it did. Everything below
  -- this point is allowed to fail the probe, and failing it while the money RPC
  -- is still the neutered read-then-insert would leave a database whose wallet
  -- does not lock — quiet, and exactly the wrong way round.
  --
  -- It compares the body to the SAVED one byte for byte, and the first version
  -- of this assertion did not: it tested `prosrc ilike '%for update%'`, which
  -- the neutered body SATISFIES, because that body carries the line
  -- `-- THE GUARD, REMOVED: no \`for update\`` a few lines up. An assertion
  -- about a guard, defeated by a comment describing the guard's absence. This
  -- repo has now made the scan-the-comments mistake in a source-shape test, in a
  -- document guard, and here — so the rule is not "strip comments", it is:
  -- do not pattern-match a body when you can compare it to the one you saved.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'wallet_reserve_card_auth'
       and p.prosrc = v_body
  ) then
    raise exception 'A-15 FAIL: wallet_reserve_card_auth was NOT restored to the body this probe saved — the database may still hold the unlocked body it installed. Re-apply supabase/migrations/0155_wallet_auth_holds.sql before trusting this database.';
  end if;
end $$;

-- ── The verdict ──────────────────────────────────────────────────────────────
do $$
declare
  r_real record;
  r_neut record;
begin
  select * into r_real from a15_verdict where stage = 'a15_real';
  select * into r_neut from a15_verdict where stage = 'a15_neutered';

  if r_real is null then
    raise exception 'A-15 FAIL: the real-RPC stage recorded no verdict at all';
  end if;
  if r_real.approved = -1 then
    raise exception 'A-15 FAIL: the real-RPC race raised — %', r_real.note;
  end if;

  -- The concurrency evidence. Two backends parked on one row is what makes this
  -- a race; without it the stage below is just a sequential pair.
  if r_real.waiters < 2 then
    if r_real.approved = 2 then
      raise exception 'A-15 FAIL: both $8 authorizations approved against $10 AND neither ever waited on the bucket row — the FOR UPDATE is gone (%)', r_real.note;
    end if;
    raise notice 'A-15 SKIP: only % of 2 sessions were observed waiting on the spend bucket in 15s; concurrency was NOT exercised (%)',
      r_real.waiters, r_real.note;
    perform set_config('a15.skipped', 'both sessions never contended for the bucket row', false);
    return;
  end if;

  if r_real.approved <> 1 then
    raise exception 'A-15 FAIL: % of 2 simultaneous $8 authorizations approved against $10 (%)',
      r_real.approved, r_real.note;
  end if;

  if r_real.held <> 800 then
    raise exception 'A-15 FAIL: $% held after the race, expected $8.00', (r_real.held / 100.0);
  end if;

  -- The negative control. Without the lock the same race must overdraw; if it
  -- does not, this probe is not testing the lock and its green line is worthless.
  if r_neut is null or r_neut.approved = -1 then
    raise exception 'A-15 FAIL: the negative control did not complete (%) — the probe is unproven',
      coalesce(r_neut.note, 'no verdict');
  end if;
  -- $16.00 held against a $10.00 balance is the overdraft itself: the number
  -- Q-01 recorded as a real -$6.00, reproduced here on demand.
  if r_neut.held <> 1600 then
    raise exception 'A-15 FAIL: with the FOR UPDATE removed only $% was held, expected the $16.00 overdraft (%)',
      (r_neut.held / 100.0), r_neut.note;
  end if;
  if r_neut.approved <> 2 then
    raise exception 'A-15 FAIL: with the FOR UPDATE removed only % of 2 authorizations approved — the overdraft did not reproduce, so this probe is decoration, not a boundary (%)',
      r_neut.approved, r_neut.note;
  end if;

  perform set_config('a15.skipped', '', false);
  raise notice 'A-15 OK: 1 of 2 CONTENDING $8 authorizations approved against $10, $8.00 held (%); negative control overdrew to 2 of 2 with the lock removed (%)',
    r_real.note, r_neut.note;
end $$;

drop procedure if exists public.a15_race(text, boolean);
drop function if exists public.a15_timed_auth(uuid, uuid, bigint, text, text);
drop table if exists a15_verdict;
drop table if exists a15_saved_fn;

-- Leave the ledger as the real stage left it.
delete from public.wallet_transactions
 where stripe_ref in ('a15_neutered_a', 'a15_neutered_b');

-- The summary line reads the block's own verdict rather than asserting one.
-- Before this, a SKIP still printed "ALL INVARIANTS PASSED" — a green line that
-- proves nothing is the very thing the skip exists to prevent, so leaving it
-- would have made the skip self-defeating.
select case coalesce(current_setting('a15.skipped', true), '')
         when '' then 'A-15 wallet concurrency probe: ALL INVARIANTS PASSED'
         else 'A-15 wallet concurrency probe: SKIPPED — '
              || current_setting('a15.skipped', true)
              || '; the concurrency invariant was NOT exercised'
       end as result;
