-- ── A child cannot spend the same dollar twice (Q-01, 0342) ─────────────────
--
-- `debitSpendBucket` (lib/wallet/server.ts) was the last money path in this
-- product that wrote the ledger from TypeScript, and it did it as a read, a
-- decision, and then a write — three steps, two round trips, nothing held:
--
--   const { bucketId, available } = await bucketBalanceCents(supabase, …);
--   if (!params.requiresApproval && amount > available) return …;
--   await supabase.from('wallet_transactions').insert({ … });
--
-- Two $8 spends against $10 arriving together both read 1000, both passed, and
-- both posted. The ledger is immutable, so the -$6.00 stays.
--
-- `0342_a_child_cannot_spend_the_same_dollar_twice.sql` moves the whole thing
-- into `wallet_debit_spend_bucket`, on 0155's shape: lock the child's spend
-- bucket FOR UPDATE, total the ledger inside that lock, refuse, write.
--
-- This file is in TWO PARTS, and they prove different things.
--
--   PART 1 — THE RACE. Two real connections, two simultaneous $8 spends
--     against one $10 wallet, released together from a starting gate. Exactly
--     one may be approved. This is the invariant the migration exists for, and
--     it cannot be demonstrated on one connection.
--
--   PART 2 — THE SHAPE. One connection, thirteen groups: the refusal carries
--     the cents that are left, a live card hold counts against an in-app spend,
--     a held request stays inert, `forbidden` holds for a stranger a child and
--     another family, the key is idempotent only when it is complete, the audit
--     row is inside the transaction. All of it inside one transaction, rolled
--     back.
--
-- Part 2 is unchanged and still ends in `rollback`. Part 1 CANNOT, and the rest
-- of this header is about why, because the shape of a cross-session probe is
-- the thing people get wrong.
--
-- ── WHY PART 1 IS NOT IN A TRANSACTION ──────────────────────────────────────
--
-- Everything the two racing sessions must SEE is written by plain top-level
-- statements, so psql commits each one. Inside a `do $$ … $$` block it would
-- not be: that block is a single transaction, what it writes stays uncommitted,
-- and another backend cannot see it. Worse than invisible — a second session
-- taking `FOR UPDATE` on an uncommitted row BLOCKS on the writer's xid, and the
-- writer is the session waiting for it. That is a hang, not a failure, and
-- `docs/audit/wallet-concurrency-check.sql` records the same trap costing a
-- draft of the card-auth probe. The seed rows, the gate helper and the negative
-- control's body below all depend on being committed.
--
-- ── WHY THERE IS A STARTING GATE, AND WHY `dblink_send_query` IS NOT ONE ────
--
-- `dblink_send_query` returns immediately, so two of them LOOK simultaneous.
-- They are not. Dispatching the second call costs about as long as the RPC
-- takes to run, and A-15 measured exactly this on this machine: under load its
-- two authorizations did not overlap at all —
--     a = [02:26:27.695127, 02:26:27.700092]
--     b = [02:26:27.700856, 02:26:27.714366]
-- b starting 0.76ms after a FINISHED. A probe that fires and hopes is
-- load-sensitive: it reports the property on an idle box and reports nothing at
-- all on a busy one, and both look identical from outside, because one approval
-- and $8 debited is exactly what a purely SEQUENTIAL pair produces too.
--
-- So the two sides are held at a gate and released together:
--
--   1. the parent takes a session-level EXCLUSIVE advisory lock on key 916;
--   2. each racer calls `public.q01_gated_spend`, whose first act is
--      `pg_advisory_lock_shared(916)` — so it parks, before it has done
--      anything;
--   3. the parent POLLS `pg_locks` until it can see exactly TWO ungranted
--      advisory waiters on that key, with a bounded timeout;
--   4. the parent releases the exclusive lock, and both shared waiters are
--      granted in the same instant.
--
-- Step 3 is evidence rather than timing: two backends parked on one key is what
-- "simultaneous" means here, and no amount of CPU starvation can fake it — a
-- descheduled backend still holds its place in the lock queue.
--
-- The gate is a FUNCTION, not a bare `select clock_timestamp(), rpc(…),
-- clock_timestamp()`, because the evaluation order of a SELECT's target list is
-- not guaranteed and a clock stamped after the call it is supposed to be timing
-- measures nothing.
--
-- Having a gate changes what non-overlap MEANS. Where A-15 had to treat it as a
-- property of the machine and skip, here both sides were provably released at
-- the same instant, so spans that do not intersect are a BUG IN THIS PROBE and
-- are FAILED, not skipped. A green line that proves nothing is worse than a red
-- one.
--
-- ── THE NEGATIVE CONTROL, AND THE ONE THING IT CANNOT BE ────────────────────
--
-- A probe whose subject can be broken without it noticing is decoration, and
-- this repo has found enough of those to insist. So the control replaces
-- `wallet_debit_spend_bucket`'s body with the pre-0342 read-then-insert —
-- `bucketBalanceCents`' `completed`-only sum, no `FOR UPDATE`, a `pg_sleep`
-- standing in for the round trip the old TypeScript spent between its read and
-- its write — runs THE SAME RACE through THE SAME GATE, and REQUIRES the
-- overdraft to land: two approvals, -$6.00. If it does not reproduce, this file
-- raises and says the probe is decoration rather than a boundary.
--
-- That control CANNOT be rolled back, and the reason is the same MVCC fact as
-- the seed: a `create or replace function` inside an open transaction is
-- invisible to every other backend, so the two racing connections would keep
-- calling the REAL function and the control would "fail to reproduce" the
-- defect for a reason that has nothing to do with the defect. A control that
-- silently tests the wrong function is worse than no control. It is therefore
-- COMMITTED, and the window it opens is closed three ways:
--
--   * `q01_race` RECORDS its verdict instead of raising, so nothing can jump
--     over the restore;
--   * the restore is an unconditional top-level statement that runs before any
--     assertion is allowed to fire, and it VERIFIES itself — `prosrc` compared
--     byte for byte against the definition saved at the start, never a
--     `like '%for update%'` scan, which the neutered body would SATISFY on the
--     strength of the comment saying the guard was removed;
--   * the saved definition lives in a COMMITTED table, `public.q01_saved_fn`,
--     not a temp one. A hard kill (a CI timeout, a ^C) in the window therefore
--     leaves the real definition recoverable on disk, and the next run of this
--     probe restores from it and drops it before doing anything else. A-15 kept
--     its copy in a TEMP table, which dies with the session that needed it.
--
-- If you ever see this probe's restore assertion fire, re-apply
-- supabase/migrations/0342_a_child_cannot_spend_the_same_dollar_twice.sql
-- before trusting this database. Run all of this against a throwaway instance,
-- which is what docs/audit/verify-pg.sh bootstraps.
--
--   bash docs/audit/verify-pg.sh up
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 \
--       -f docs/audit/a-child-cannot-spend-the-same-dollar-twice-check.sql

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — THE RACE
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists dblink;

-- ── One run at a time on a shared database ──────────────────────────────────
-- Observed, not anticipated: two runs of this probe overlapped on the shared
-- audit instance and one died with `tuple concurrently updated`, because both
-- were issuing `create or replace function` against the same `pg_proc` row —
-- the negative control's install, and the restore after it. Nothing was left
-- broken (the loser died before it had replaced anything, and the winner
-- restored as usual), but a probe that reports a Postgres internal instead of a
-- verdict is a probe nobody can read. Runs therefore queue on one advisory key,
-- and a run that cannot get in after 60s SAYS SO rather than racing. The lock
-- is session-level, so a killed run releases it by disconnecting.
do $solo$
declare
  waited_ms int := 0;
begin
  while not pg_try_advisory_lock(342) loop
    if waited_ms >= 60000 then
      raise exception 'q01: another run of this probe has held the single-run lock (advisory key 342) on this database for 60s. Two runs at once replace wallet_debit_spend_bucket''s body in the same instant and Postgres refuses one of them with "tuple concurrently updated". Wait for the other run to finish, or use a throwaway instance — docs/audit/verify-pg.sh up.';
    end if;
    perform pg_sleep(0.05);
    waited_ms := waited_ms + 50;
  end loop;
end
$solo$;

-- ── Self-heal, first, before anything else ──────────────────────────────────
-- If a previous run was killed between installing the negative control's body
-- and restoring the real one, the real definition is still sitting here. Put it
-- back before this run saves anything, or this run would "save" the neutered
-- body and dutifully restore the defect.
do $heal$
declare
  v_def text;
begin
  if to_regclass('public.q01_saved_fn') is null then
    return;
  end if;
  select def into v_def from public.q01_saved_fn limit 1;
  if v_def is null then
    raise exception 'q01: public.q01_saved_fn exists but is empty — a previous run was killed and the real wallet_debit_spend_bucket cannot be recovered from it. Re-apply supabase/migrations/0342_a_child_cannot_spend_the_same_dollar_twice.sql.';
  end if;
  execute v_def;
  drop table public.q01_saved_fn;
  raise notice 'q01: a previous run of this probe was interrupted; wallet_debit_spend_bucket has been restored from its saved definition';
end
$heal$;

-- ── Refuse to race a function that is already the defect ────────────────────
-- Read out of the catalogue, not out of the migration file. If someone else's
-- in-flight experiment has left this database's spend RPC de-locked, saving and
-- "restoring" it would launder their mutation into a green line.
do $precheck$
declare
  v_src text;
begin
  select prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wallet_debit_spend_bucket';
  if v_src is null then
    raise exception 'q01: public.wallet_debit_spend_bucket does not exist — apply supabase/migrations/0342_a_child_cannot_spend_the_same_dollar_twice.sql first';
  end if;
  if v_src not like '%for update%' then
    raise exception 'q01: wallet_debit_spend_bucket is installed WITHOUT its FOR UPDATE. This probe will not race, save and restore a definition that is already the defect — re-apply supabase/migrations/0342_a_child_cannot_spend_the_same_dollar_twice.sql.';
  end if;
end
$precheck$;

-- ── Committed seed: one family, two children, $10 each ──────────────────────
-- Two wallets, not one: the real race gets its own ledger and the negative
-- control gets its own, so neither stage's totals can be read as the other's.
-- A-15's first draft measured after both stages and reported the control's
-- overdraft against the real RPC.
delete from public.wallet_audit_logs   where family_id = '00000000-0000-4000-8000-0000000d3430';
delete from public.wallet_transactions where family_id = '00000000-0000-4000-8000-0000000d3430';
delete from public.wallet_buckets      where family_id = '00000000-0000-4000-8000-0000000d3430';
delete from public.child_wallets       where family_id = '00000000-0000-4000-8000-0000000d3430';
delete from public.family_members      where family_id = '00000000-0000-4000-8000-0000000d3430';
delete from public.families            where id        = '00000000-0000-4000-8000-0000000d3430';
delete from auth.users                 where id        = '00000000-0000-4000-8000-0000000d3431';

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-0000000d3431', 'q01-race-parent@example.com');

insert into public.families (id, name, created_by)
values ('00000000-0000-4000-8000-0000000d3430', 'Race House', '00000000-0000-4000-8000-0000000d3431');

-- `on_family_created` makes the creator a member; the RPC's guard is
-- `can_manage_family`, which is `role in ('parent','adult') and is_active`.
update public.family_members
   set role = 'parent', is_active = true
 where family_id = '00000000-0000-4000-8000-0000000d3430'
   and user_id   = '00000000-0000-4000-8000-0000000d3431';

insert into public.family_members (id, family_id, display_name, role, is_active)
values ('00000000-0000-4000-8000-0000000d3433', '00000000-0000-4000-8000-0000000d3430', 'Race Child',    'child', true),
       ('00000000-0000-4000-8000-0000000d3435', '00000000-0000-4000-8000-0000000d3430', 'Control Child', 'child', true);

insert into public.child_wallets (id, family_id, member_id)
values ('00000000-0000-4000-8000-0000000d3434', '00000000-0000-4000-8000-0000000d3430', '00000000-0000-4000-8000-0000000d3433'),
       ('00000000-0000-4000-8000-0000000d3436', '00000000-0000-4000-8000-0000000d3430', '00000000-0000-4000-8000-0000000d3435');

insert into public.wallet_buckets (family_id, child_wallet_id, kind, label)
values ('00000000-0000-4000-8000-0000000d3430', '00000000-0000-4000-8000-0000000d3434', 'spend', 'Spend'),
       ('00000000-0000-4000-8000-0000000d3430', '00000000-0000-4000-8000-0000000d3436', 'spend', 'Spend');

-- $10 in each, committed the way an allowance run leaves it.
insert into public.wallet_transactions
  (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
select '00000000-0000-4000-8000-0000000d3430', b.child_wallet_id, b.id,
       'allowance', 'completed', 'credit', 1000, 'seed $10'
  from public.wallet_buckets b
 where b.family_id = '00000000-0000-4000-8000-0000000d3430' and b.kind = 'spend';

-- ── The gate helper ─────────────────────────────────────────────────────────
-- Top-level and committed, so the racing connections can see it. Order inside
-- matters and is the whole point:
--
--   the JWT claims are stamped BEFORE the gate, so the measured span contains
--   the RPC and nothing else; then the shared lock, where the racer parks until
--   the parent lets go; then a clock; then the call; then a clock.
create or replace function public.q01_gated_spend(
  p_key bigint,
  p_family uuid,
  p_wallet uuid,
  p_amount bigint,
  p_actor uuid,
  p_description text
) returns jsonb
language plpgsql
as $fn$
declare
  v_start timestamptz;
  v_end   timestamptz;
  v_result jsonb;
begin
  -- Act as the manager the RPC's guard expects: `auth.uid()` is
  -- `request.jwt.claim.sub`, and the role is the one the app's PostgREST
  -- session runs under.
  perform set_config('request.jwt.claim.sub',  p_actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('role', 'authenticated', true);

  -- THE GATE. Parks here, holding nothing, until the parent releases key p_key.
  perform pg_advisory_lock_shared(p_key);

  v_start  := clock_timestamp();
  v_result := public.wallet_debit_spend_bucket(
                p_family, p_wallet, p_amount, 'card_spend', p_description, p_actor);
  v_end    := clock_timestamp();

  perform pg_advisory_unlock_shared(p_key);

  -- jsonb rather than a `~`-joined string: the result carries a uuid, a status
  -- and a cents figure that the verdict block has to read back, and a delimiter
  -- inside one of them would be a silent misparse.
  return jsonb_build_object('start', v_start, 'end', v_end, 'result', v_result);
end
$fn$;

-- Where each stage records what happened. TEMP on purpose: this is the parent
-- session's own scratch state — only the helper, the seed and the control's
-- body have to be visible to the racers — and a run that dies partway through
-- must not leave tables in `public` for the next probe to trip over.
drop table if exists q01_verdict;
create temp table q01_verdict (
  stage    text primary key,
  waiters  int,
  approved int,
  balance  bigint,
  debited  bigint,
  raw_a    jsonb,
  raw_b    jsonb,
  note     text
);

-- ── The race, as a reusable procedure ───────────────────────────────────────
-- Called twice: once against the real RPC, once against the neutered one. The
-- SAME race both times, or the negative control proves nothing about this probe.
--
-- It RECORDS rather than raises. The control's body has to be committed for the
-- racers to see it, so an exception escaping from here would skip the restore
-- and leave this database's spend RPC de-locked — quiet, and exactly the wrong
-- way round.
create or replace procedure public.q01_race(
  p_stage text, p_wallet uuid, p_amount bigint, p_key bigint
)
language plpgsql
as $proc$
declare
  v_family constant uuid := '00000000-0000-4000-8000-0000000d3430';
  v_actor  constant uuid := '00000000-0000-4000-8000-0000000d3431';
  v_conn    text;
  v_bucket  uuid;
  raw_a jsonb; raw_b jsonb;
  start_a timestamptz; end_a timestamptz;
  start_b timestamptz; end_b timestamptz;
  approved int;
  waiters int := 0;
  seen    int := 0;
  waited_ms int := 0;
  contending int := 0;
  seen_contending int := 0;
  held_ms int := 0;
  v_row_held boolean := false;
  v_balance bigint;
  v_debited bigint;
  v_gate_held boolean := false;
begin
  select id into v_bucket from public.wallet_buckets
   where family_id = v_family and child_wallet_id = p_wallet and kind = 'spend';

  v_conn := 'dbname=' || current_database()
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
    || ' port=' || current_setting('port')
    || ' user=' || current_user;

  -- A THIRD SESSION HOLDS THE ROW THE RPC LOCKS. This is what makes the race a
  -- race; the advisory gate below only makes them START together. See the header.
  -- `dblink_exec` refuses a statement that returns rows, and `for update` on a
  -- select does, so the holder takes its lock through `dblink`.
  perform dblink_connect('q01_hold', v_conn || ' application_name=q01_holder');
  perform dblink_exec('q01_hold', 'begin');
  perform * from dblink('q01_hold', format(
    'select id from public.wallet_buckets where id = %L for update', v_bucket)) as t(id uuid);
  v_row_held := true;

  -- The parent's exclusive hold on the gate. Session-level, so it outlives the
  -- statement that takes it and is still held while the racers pile up behind it.
  perform pg_advisory_lock(p_key);
  v_gate_held := true;

  perform dblink_connect('q01_a', v_conn || ' application_name=q01_racer_a');
  perform dblink_connect('q01_b', v_conn || ' application_name=q01_racer_b');

  perform dblink_send_query('q01_a', format(
    'select public.q01_gated_spend(%s,%L,%L,%s,%L,%L)',
    p_key, v_family, p_wallet, p_amount, v_actor, 'Store A'));
  perform dblink_send_query('q01_b', format(
    'select public.q01_gated_spend(%s,%L,%L,%s,%L,%L)',
    p_key, v_family, p_wallet, p_amount, v_actor, 'Store B'));

  -- Wait until BOTH are provably parked at the gate. This is the concurrency
  -- evidence, and `seen` keeps the high-water mark because the waiters vanish
  -- the instant the gate opens.
  --
  -- `pg_advisory_lock(bigint)` files its key as classid = key >> 32,
  -- objid = key & 0xffffffff, objsubid = 1. The parent's own exclusive lock is
  -- GRANTED, so `not granted` counts only the two racers.
  while waited_ms < 15000 loop
    select count(*) into waiters
      from pg_locks l
     where l.locktype = 'advisory'
       and l.classid  = (p_key >> 32)::oid
       and l.objid    = (p_key & 4294967295)::oid
       and l.objsubid = 1
       and not l.granted
       and l.database = (select oid from pg_database where datname = current_database());
    if waiters > seen then seen := waiters; end if;
    exit when seen >= 2;
    perform pg_sleep(0.002);
    waited_ms := waited_ms + 2;
  end loop;

  -- OPEN THE GATE. Both shared waiters are granted in the same instant.
  perform pg_advisory_unlock(p_key);
  v_gate_held := false;

  -- …AND THEN WAIT FOR REAL CONTENTION. Released together is not the same as
  -- running together: being GRANTED a lock is not being SCHEDULED, and a starved
  -- backend can sit between `pg_advisory_lock_shared` and its next statement for
  -- as long as the kernel likes. Measured: this probe failed 1 run in 10 under
  -- six competing workers, with both racers provably parked and their spans still
  -- disjoint. So the assertion is moved off the clock entirely — each racer now
  -- runs until it blocks on the bucket row the holder is sitting on, and THAT is
  -- counted. Two backends queued on one row is what "concurrent" means here, and
  -- CPU starvation can neither fake it nor hide it.
  while held_ms < 15000 loop
    select count(distinct l.pid) into contending
      from pg_locks l join pg_stat_activity sa on sa.pid = l.pid
     where sa.application_name like 'q01_racer%' and not l.granted;
    if contending > seen_contending then seen_contending := contending; end if;
    exit when seen_contending >= 2;
    perform pg_sleep(0.002);
    held_ms := held_ms + 2;
  end loop;

  -- Release them into the contention.
  perform dblink_exec('q01_hold', 'commit');
  perform dblink_disconnect('q01_hold');
  v_row_held := false;

  select v into raw_a from dblink_get_result('q01_a') as t(v jsonb);
  select v into raw_b from dblink_get_result('q01_b') as t(v jsonb);
  perform * from dblink_get_result('q01_a') as t(v jsonb);
  perform * from dblink_get_result('q01_b') as t(v jsonb);
  perform dblink_disconnect('q01_a');
  perform dblink_disconnect('q01_b');

  start_a := (raw_a->>'start')::timestamptz; end_a := (raw_a->>'end')::timestamptz;
  start_b := (raw_b->>'start')::timestamptz; end_b := (raw_b->>'end')::timestamptz;

  approved := (case when coalesce((raw_a#>>'{result,ok}')::boolean, false) then 1 else 0 end)
            + (case when coalesce((raw_b#>>'{result,ok}')::boolean, false) then 1 else 0 end);

  -- Measured here, against THIS stage's own bucket, while it holds only what
  -- this race put in it.
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into v_balance
    from public.wallet_transactions
   where bucket_id = v_bucket and status in ('completed', 'processing');
  select coalesce(sum(amount_cents), 0)
    into v_debited
    from public.wallet_transactions
   where bucket_id = v_bucket and direction = 'debit' and status in ('completed', 'processing');

  insert into q01_verdict (stage, waiters, approved, balance, debited, raw_a, raw_b, note)
  values (p_stage, seen, approved, v_balance, v_debited, raw_a, raw_b,
          format('a=[%s,%s] b=[%s,%s] gate_wait=%sms contended=%s balance=$%s debited=$%s',
                 start_a, end_a, start_b, end_b, waited_ms, seen_contending,
                 (v_balance/100.0), (v_debited/100.0)))
  on conflict (stage) do update set
    waiters = excluded.waiters, approved = excluded.approved, balance = excluded.balance,
    debited = excluded.debited, raw_a = excluded.raw_a, raw_b = excluded.raw_b, note = excluded.note;
exception when others then
  -- Never leave the gate shut or a connection half-open for the next stage, and
  -- never raise: the restore has to run.
  if v_gate_held then begin perform pg_advisory_unlock(p_key); exception when others then null; end; end if;
  if v_row_held then begin perform dblink_disconnect('q01_hold'); exception when others then null; end; end if;
  begin perform dblink_disconnect('q01_a'); exception when others then null; end;
  begin perform dblink_disconnect('q01_b'); exception when others then null; end;
  insert into q01_verdict (stage, waiters, approved, balance, debited, raw_a, raw_b, note)
  values (p_stage, -1, -1, -1, -1, null, null, 'raised: ' || sqlerrm)
  on conflict (stage) do update set
    waiters = -1, approved = -1, balance = -1, debited = -1, note = 'raised: ' || sqlerrm;
end
$proc$;

-- ── Stage 1: the real RPC ───────────────────────────────────────────────────
call public.q01_race('real', '00000000-0000-4000-8000-0000000d3434', 800, 916);

-- ── Stage 2: the negative control ───────────────────────────────────────────
-- Save the real definition FIRST, in a committed table, so a hard kill in the
-- window below leaves it recoverable (see the header).
drop table if exists public.q01_saved_fn;
create table public.q01_saved_fn as
select pg_get_functiondef(p.oid) as def, p.prosrc as body, now() as saved_at
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'wallet_debit_spend_bucket';

-- The pre-0342 read-then-insert, restored into the real function so the racers
-- reach it through the same gate, the same helper and the same call. The guards
-- are kept verbatim — only the LOCK and the ledger it totals are taken away, so
-- what the control measures is the lock and nothing else.
--
-- The `pg_sleep` is not what makes this wrong; it is wrong at any window width.
-- It stands in for the PostgREST round trip the old TypeScript spent between
-- `bucketBalanceCents` and `.insert()`, and it makes the interleave
-- DETERMINISTIC, so the control asserts rather than hopes.
create or replace function public.wallet_debit_spend_bucket(
  p_family_id uuid,
  p_child_wallet_id uuid,
  p_amount bigint,
  p_type public.wallet_txn_type,
  p_description text,
  p_actor_id uuid,
  p_requires_approval boolean default false,
  p_approved_by uuid default null,
  p_related_type text default null,
  p_related_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $naive$
declare
  v_bucket    uuid;
  v_available bigint;
  v_txn       uuid;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  if auth.uid() is null
     or p_actor_id is distinct from auth.uid()
     or not public.can_manage_family(p_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  perform 1 from public.child_wallets
   where id = p_child_wallet_id and family_id = p_family_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'wallet_not_found');
  end if;

  -- THE GUARD, REMOVED: read without `for update`, so neither caller queues
  -- behind the other.
  select id into v_bucket
    from public.wallet_buckets
   where family_id = p_family_id and child_wallet_id = p_child_wallet_id and kind = 'spend';
  if v_bucket is null then
    return jsonb_build_object('ok', false, 'reason', 'spend_bucket_missing');
  end if;

  -- bucketBalanceCents' sum: `completed` only, outside any lock.
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into v_available
    from public.wallet_transactions
   where family_id = p_family_id and bucket_id = v_bucket and status = 'completed';

  perform pg_sleep(0.05);   -- the round trip between the read and the write

  if p_amount > v_available then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_funds', 'available', v_available);
  end if;

  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents,
     description, related_type, related_id, created_by, approved_by, metadata)
  values
    (p_family_id, p_child_wallet_id, v_bucket, p_type, 'completed', 'debit', p_amount,
     coalesce(nullif(trim(coalesce(p_description, '')), ''), 'Spend'),
     p_related_type, p_related_id, p_actor_id, coalesce(p_approved_by, p_actor_id),
     coalesce(p_metadata, '{}'::jsonb))
  returning id into v_txn;

  return jsonb_build_object(
    'ok', true, 'transaction_id', v_txn, 'status', 'completed',
    'available', v_available, 'idempotent', false);
end
$naive$;

call public.q01_race('control', '00000000-0000-4000-8000-0000000d3436', 800, 916);

-- ── Restore, unconditionally, before anything is allowed to raise ───────────
do $restore$
declare
  v_def text;
  v_body text;
begin
  select def, body into v_def, v_body from public.q01_saved_fn limit 1;
  if v_def is null then
    raise exception 'q01 FAIL: the real wallet_debit_spend_bucket was not saved and CANNOT be restored. Re-apply supabase/migrations/0342_a_child_cannot_spend_the_same_dollar_twice.sql NOW.';
  end if;
  execute v_def;

  -- Compared to the SAVED body byte for byte, never `like '%for update%'` — the
  -- neutered body SATISFIES that test, on the strength of the comment above its
  -- unlocked select saying the guard was removed. An assertion about a guard,
  -- defeated by a comment describing the guard's absence.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'wallet_debit_spend_bucket'
       and p.prosrc = v_body
  ) then
    raise exception 'q01 FAIL: wallet_debit_spend_bucket was NOT restored to the body this probe saved — this database may still hold the unlocked read-then-insert. Re-apply supabase/migrations/0342_a_child_cannot_spend_the_same_dollar_twice.sql before trusting it.';
  end if;
end
$restore$;

drop table if exists public.q01_saved_fn;

-- ── Leave nothing behind, BEFORE the verdict is allowed to raise ────────────
-- Order matters. The first draft put the teardown AFTER the verdict, so the
-- run that proved this probe can fail — a de-locked RPC, `2 of 2 approved` —
-- also left `public.q01_race`, `public.q01_gated_spend` and a seeded family
-- sitting in the database, because `ON_ERROR_STOP` stops at the raise. A probe
-- that only tidies up when it passes leaves its worst runs as debris. The
-- verdict reads nothing but the temp table below, so everything else goes
-- first and the exception is thrown over a clean database.
drop procedure if exists public.q01_race(text, uuid, bigint, bigint);
drop function  if exists public.q01_gated_spend(bigint, uuid, uuid, bigint, uuid, text);

delete from public.wallet_audit_logs   where family_id = '00000000-0000-4000-8000-0000000d3430';
delete from public.wallet_transactions where family_id = '00000000-0000-4000-8000-0000000d3430';
delete from public.wallet_buckets      where family_id = '00000000-0000-4000-8000-0000000d3430';
delete from public.child_wallets       where family_id = '00000000-0000-4000-8000-0000000d3430';
delete from public.family_members      where family_id = '00000000-0000-4000-8000-0000000d3430';
delete from public.families            where id        = '00000000-0000-4000-8000-0000000d3430';
delete from auth.users                 where id        = '00000000-0000-4000-8000-0000000d3431';

-- The gate key, and the single-run lock, released together.
select pg_advisory_unlock_all();

-- ── The verdict ─────────────────────────────────────────────────────────────
do $verdict$
declare
  r_real record;
  r_ctl  record;
  ok_a boolean; ok_b boolean;
  refused jsonb;
begin
  select * into r_real from q01_verdict where stage = 'real';
  select * into r_ctl  from q01_verdict where stage = 'control';

  if r_real is null then
    raise exception 'q01 FAIL: the real-RPC race recorded no verdict at all';
  end if;
  if r_real.approved = -1 then
    raise exception 'q01 FAIL: the real-RPC race raised — %', r_real.note;
  end if;

  -- 1. THE GATE. Both sides provably parked, or this is not a race and nothing
  --    below it means anything. With a gate, this is a probe bug, not a
  --    property of the machine, so it fails rather than skipping.
  if r_real.waiters <> 2 then
    raise exception 'q01 FAIL: % of 2 racers were ever seen parked at the starting gate within 15s — the gate did not hold them, so the two $8 spends were NOT simultaneous and this probe proved nothing (%)',
      r_real.waiters, r_real.note;
  end if;

  -- 2. THE CONTENTION, which replaces an assertion about clock spans.
  --
  -- The first version of this check required the two spans to INTERSECT, on the
  -- reasoning that sides released together must overlap. That reasoning is
  -- wrong, and it was measured wrong: 1 run in 10 under six competing workers
  -- failed here with both racers provably parked at the gate and their spans
  -- still disjoint by several milliseconds. Being granted a lock is not being
  -- scheduled. Wall-clock overlap cannot be constructed on a box that will not
  -- run you, and a probe that FAILS on it is flaky-red on a money boundary —
  -- the habit AUDIT-004 exists to prevent, arrived at from the other side.
  --
  -- What IS constructible, and is the property actually under test, is that both
  -- racers reached the RPC's `for update` and queued on the same bucket row. A
  -- descheduled backend still holds its place in the lock queue, so this is
  -- immune to load in the way a timestamp is not.
  --
  -- WHAT IT DOES NOT PROVE, stated because the first draft of this comment
  -- claimed it did. It is NOT a test of the RPC's own `for update`. Measured:
  -- with the guard removed, the negative-control stage still records
  -- `contended=2`, because an INSERT into `wallet_transactions` takes
  -- FOR KEY SHARE on the `wallet_buckets` row its `bucket_id` references, and
  -- that conflicts with the holder's FOR UPDATE. Verified directly — holding the
  -- bucket row in one session and issuing a plain INSERT in another blocks the
  -- INSERT. So both racers queue on that row whether or not the RPC locks it.
  --
  -- The guard removal is caught by the OUTCOME assertions below and by the
  -- negative control, which requires the overdraft to reproduce at -$6.00. This
  -- assertion's job is narrower and still worth having: it proves the two
  -- racers were in flight together, which is what the clock spans were supposed
  -- to show and could not.
  if coalesce((select contended from (select substring(r_real.note from 'contended=([0-9]+)')::int as contended) q), 0) < 2 then
    raise exception 'q01 FAIL: the two racers never queued on the spend bucket row, so no race was exercised — if the spend RPC still takes `for update` this is a bug in the probe, and if it does not, that is the defect this probe exists to catch (%)',
      r_real.note;
  end if;

  -- 2b. AND THE SPANS DO OVERLAP — as a COROLLARY of 2, not as a hope.
  --
  -- A standalone overlap assertion was measured flaky (1 run in 10 under six
  -- competing workers) and was right to be removed: sides released together
  -- from an advisory gate are not sides that RUN together, because being
  -- granted a lock is not being scheduled.
  --
  -- The holder changes that, and this is why the assertion can come back. Each
  -- racer stamps `start` immediately BEFORE calling the RPC, and `contended=2`
  -- means a single poll saw both of them blocked at once — so both had already
  -- stamped `start` before the holder committed, and neither could stamp `end`
  -- until after it. Both spans therefore straddle that one commit, and
  -- intersect, by construction rather than by scheduling luck. If this ever
  -- fires it is not load: it means `contended` counted something that was not
  -- these two racers queued on this row, and the evidence above is not what it
  -- claims to be.
  if not ((r_real.raw_a->>'start')::timestamptz < (r_real.raw_b->>'end')::timestamptz
          and (r_real.raw_b->>'start')::timestamptz < (r_real.raw_a->>'end')::timestamptz) then
    raise exception 'q01 FAIL: both racers were seen queued on the spend bucket row at the same instant, and their spans STILL do not intersect — the contention evidence above does not mean what it says, so this is a bug in this probe, not a property of this machine (%)',
      r_real.note;
  end if;

  -- 3. EXACTLY ONE APPROVAL.
  if r_real.approved <> 1 then
    raise exception 'q01 FAIL: % of 2 simultaneous $8 spends were approved against $10 — this is Q-01, and it is open (%)',
      r_real.approved, r_real.note;
  end if;

  -- 4. THE LEDGER SHOWS $8.00 DEBITED, NOT $16.00.
  if r_real.debited <> 800 then
    raise exception 'q01 FAIL: $% was debited by the race, expected exactly $8.00 (%)',
      (r_real.debited / 100.0), r_real.note;
  end if;

  -- 5. THE BALANCE NEVER WENT NEGATIVE.
  if r_real.balance < 0 then
    raise exception 'q01 FAIL: the spend bucket ended at -$% — a child spent money that was not there (%)',
      (abs(r_real.balance) / 100.0), r_real.note;
  end if;
  if r_real.balance <> 200 then
    raise exception 'q01 FAIL: the spend bucket ended at $% rather than the $2.00 left after one $8 spend of $10 — money was created or destroyed (%)',
      (r_real.balance / 100.0), r_real.note;
  end if;

  -- 6. THE LOSER WAS TOLD WHY, in the shape lib/wallet/server.ts renders.
  ok_a := coalesce((r_real.raw_a#>>'{result,ok}')::boolean, false);
  ok_b := coalesce((r_real.raw_b#>>'{result,ok}')::boolean, false);
  refused := case when ok_a then r_real.raw_b->'result' else r_real.raw_a->'result' end;
  if refused->>'reason' is distinct from 'insufficient_funds' then
    raise exception 'q01 FAIL: the spend that lost the race was not refused with insufficient_funds: %', refused;
  end if;
  if coalesce((refused->>'available')::bigint, -1) <> 200 then
    raise exception 'q01 FAIL: the refusal did not carry the $2.00 that was actually left (%) — "Only $X available in Spend." is built from this number', refused;
  end if;

  -- ── 7. THE NEGATIVE CONTROL ───────────────────────────────────────────────
  if r_ctl is null or r_ctl.approved = -1 then
    raise exception 'q01 FAIL: the negative control did not complete (%) — this probe has never been shown to fail, so nothing it asserts is evidence of anything',
      coalesce(r_ctl.note, 'no verdict');
  end if;
  if r_ctl.waiters <> 2 then
    raise exception 'q01 FAIL: the negative control raced only % of 2 parked sessions — it did not run the same race, so it says nothing about the real stage (%)',
      r_ctl.waiters, r_ctl.note;
  end if;
  if not ((r_ctl.raw_a->>'start')::timestamptz < (r_ctl.raw_b->>'end')::timestamptz
          and (r_ctl.raw_b->>'start')::timestamptz < (r_ctl.raw_a->>'end')::timestamptz) then
    raise exception 'q01 FAIL: the negative control''s two sessions did not overlap — bug in this probe (%)', r_ctl.note;
  end if;
  if r_ctl.approved <> 2 then
    raise exception 'q01 FAIL: with the FOR UPDATE removed, only % of 2 simultaneous $8 spends were approved. The overdraft did NOT reproduce, so this probe is decoration rather than a boundary: it would go on passing if someone deleted the lock (%)',
      r_ctl.approved, r_ctl.note;
  end if;
  if r_ctl.balance <> -600 then
    raise exception 'q01 FAIL: with the FOR UPDATE removed the control bucket ended at $% rather than the -$6.00 Q-01 produces — the control is not reproducing the defect (%)',
      (r_ctl.balance / 100.0), r_ctl.note;
  end if;

  raise notice 'q01 race OK: 2 of 2 sessions parked at the starting gate and were released together; 1 of 2 simultaneous $8 spends was approved against $10, $8.00 debited, $2.00 left, the loser refused with insufficient_funds and available=200 (%). NEGATIVE CONTROL: with the FOR UPDATE removed and the sum narrowed to completed, the same race approved 2 of 2 and overdrew the bucket to -$6.00 (%)',
    r_real.note, r_ctl.note;
end
$verdict$;

drop table     if exists q01_verdict;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — THE SHAPE (one connection, one transaction, rolled back)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- What Part 1 cannot reach. The race proves that two spends cannot both be
-- approved; it says nothing about whether the refusal carries the right number,
-- whether a card hold is counted, whether a child is refused, or whether the
-- audit row is inside the transaction. Asserts:
--
--    1. a manager's spend that fits posts, `completed`, with an id;
--    2. a second spend that does not fit is refused — `insufficient_funds`,
--       carrying the `available` cents the caller's message is built from;
--    3. the exact remaining balance still posts (the guard is not off by one);
--    4. one cent past it does not;
--    5. the bucket never goes negative;
--    6. a live `processing` card hold COUNTS against an in-app spend — the
--       cross-path defect, since `bucketBalanceCents` counts `completed` only;
--    7. a held (`requires_parent_approval`) debit is still admitted and is
--       still inert: it moves no money and blocks no later spend;
--    8. `forbidden` for an actor who is not the session, for a child, and for a
--       manager of another family;
--    9. `wallet_not_found` for another family's wallet under this family's id;
--   10. `invalid_amount`, and `spend_bucket_missing` for a wallet without one;
--   11. idempotency per (family, spend bucket, related_type, related_id) when
--       the caller gives a complete key — and a new debit when it differs;
--   12. the `wallet_audit_logs` row lands in the same transaction as the debit;
--   13. NEGATIVE CONTROL: the pre-0342 read-then-insert shape, performed on its
--       own $10 bucket through the same RLS the old path went through, with the
--       snapshot taken before a second spend lands and the write issued after.
--       The overdraft is REQUIRED to land and the bucket is REQUIRED to end at
--       -$6.00; if it does not, this half is decoration and says so.
--
-- Everything below runs inside one transaction and is rolled back, including
-- that control.

\set FA  '00000000-0000-4000-8000-0000000d3420'
\set UP  '00000000-0000-4000-8000-0000000d3421'
\set UK  '00000000-0000-4000-8000-0000000d3422'
\set MK  '00000000-0000-4000-8000-0000000d3423'
\set CW  '00000000-0000-4000-8000-0000000d3424'
\set MN  '00000000-0000-4000-8000-0000000d3425'
\set CN  '00000000-0000-4000-8000-0000000d3426'
\set MB  '00000000-0000-4000-8000-0000000d3427'
\set CB  '00000000-0000-4000-8000-0000000d3428'
\set FB  '00000000-0000-4000-8000-0000000d3429'
\set UB  '00000000-0000-4000-8000-0000000d342a'
\set MB2 '00000000-0000-4000-8000-0000000d342b'
\set CB2 '00000000-0000-4000-8000-0000000d342c'

begin;

insert into auth.users (id, email) values (:'UP','spend-parent@example.com')  on conflict do nothing;
insert into auth.users (id, email) values (:'UK','spend-kid@example.com')     on conflict do nothing;
insert into auth.users (id, email) values (:'UB','spend-outsider@example.com') on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FA','Spend House', :'UP') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FB','Other House', :'UB') on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FA' and user_id = :'UP';
update public.family_members set role = 'parent' where family_id = :'FB' and user_id = :'UB';

-- The child: a real login, a real member row, and no manager role.
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MK', :'FA', :'UK', 'Kid', 'child', true) on conflict do nothing;

-- Three wallets in this family: the one the positive cases spend from, the one
-- the negative control gets to itself, and one with NO spend bucket.
insert into public.family_members (id, family_id, display_name, role, is_active)
  values (:'MN', :'FA', 'Control Kid', 'child', true) on conflict do nothing;
insert into public.family_members (id, family_id, display_name, role, is_active)
  values (:'MB', :'FA', 'Bucketless Kid', 'child', true) on conflict do nothing;
insert into public.family_members (id, family_id, display_name, role, is_active)
  values (:'MB2', :'FB', 'Other Kid', 'child', true) on conflict do nothing;

insert into public.child_wallets (id, family_id, member_id) values (:'CW',  :'FA', :'MK');
insert into public.child_wallets (id, family_id, member_id) values (:'CN',  :'FA', :'MN');
insert into public.child_wallets (id, family_id, member_id) values (:'CB',  :'FA', :'MB');
insert into public.child_wallets (id, family_id, member_id) values (:'CB2', :'FB', :'MB2');

insert into public.wallet_buckets (family_id, child_wallet_id, kind, label)
  values (:'FA', :'CW', 'spend', 'Spend'), (:'FA', :'CN', 'spend', 'Spend'),
         (:'FB', :'CB2', 'spend', 'Spend');
-- :'CB' deliberately gets a SAVE bucket and no spend bucket.
insert into public.wallet_buckets (family_id, child_wallet_id, kind, label)
  values (:'FA', :'CB', 'save', 'Save');

do $probe$
declare
  failures text[] := '{}';
  fam        constant uuid := '00000000-0000-4000-8000-0000000d3420';
  fam_b      constant uuid := '00000000-0000-4000-8000-0000000d3429';
  parent_u   constant uuid := '00000000-0000-4000-8000-0000000d3421';
  kid_u      constant uuid := '00000000-0000-4000-8000-0000000d3422';
  wallet     constant uuid := '00000000-0000-4000-8000-0000000d3424';
  wallet_n   constant uuid := '00000000-0000-4000-8000-0000000d3426';
  wallet_b   constant uuid := '00000000-0000-4000-8000-0000000d3428';
  wallet_b2  constant uuid := '00000000-0000-4000-8000-0000000d342c';
  bucket     uuid;
  bucket_n   uuid;
  r          jsonb;
  r2         jsonb;
  held_txn   uuid;
  total      bigint;
  n          int;
  stale      bigint;
begin
  select id into bucket   from public.wallet_buckets where child_wallet_id = wallet   and kind = 'spend';
  select id into bucket_n from public.wallet_buckets where child_wallet_id = wallet_n and kind = 'spend';

  -- $10 in each spend bucket, committed the way an allowance run leaves it.
  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
  values (fam, wallet,   bucket,   'allowance', 'completed', 'credit', 1000, 'seed $10'),
         (fam, wallet_n, bucket_n, 'allowance', 'completed', 'credit', 1000, 'seed $10');

  -- ── As the parent, through the RPC ──────────────────────────────────────
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- 1. $8 of $10 posts.
  r := public.wallet_debit_spend_bucket(fam, wallet, 800, 'card_spend', 'Toy store', parent_u);
  if coalesce((r->>'ok')::boolean, false) is not true then
    failures := array_append(failures, format('a manager''s $8 spend from $10 was refused (%s) — the guard refuses the case it exists to allow', r));
  elsif r->>'status' is distinct from 'completed' or r->>'transaction_id' is null then
    failures := array_append(failures, format('the $8 spend did not post as a completed debit with an id: %s', r));
  end if;

  -- 2. A second $8 does not, and says why in the shape the caller renders.
  r := public.wallet_debit_spend_bucket(fam, wallet, 800, 'card_spend', 'Candy', parent_u);
  if coalesce((r->>'ok')::boolean, false) is not false then
    failures := array_append(failures, 'a second $8 spend was approved with $2 left — this is Q-01, and it is open');
  elsif r->>'reason' is distinct from 'insufficient_funds' then
    failures := array_append(failures, format('the refusal did not say insufficient_funds: %s', r));
  elsif coalesce((r->>'available')::bigint, -1) <> 200 then
    failures := array_append(failures, format('the refusal did not carry the $2 that is actually left (%s) — lib/wallet/server.ts builds "Only X available in Spend." from this number', r));
  end if;

  -- 3 & 4. Exactly the remainder posts; one cent past it does not.
  r := public.wallet_debit_spend_bucket(fam, wallet, 200, 'card_spend', 'Gum', parent_u);
  if coalesce((r->>'ok')::boolean, false) is not true then
    failures := array_append(failures, format('the exact remaining $2 was refused (%s) — the guard is off by one against the child', r));
  end if;
  r := public.wallet_debit_spend_bucket(fam, wallet, 1, 'card_spend', 'One cent', parent_u);
  if coalesce((r->>'ok')::boolean, false) is not false then
    failures := array_append(failures, 'a spend was approved against a $0 balance');
  end if;

  -- 5. And the ledger is where it should be, not below it.
  perform set_config('role', 'postgres', true);
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into total from public.wallet_transactions
   where bucket_id = bucket and status in ('completed', 'processing');
  if total <> 0 then
    failures := array_append(failures, format('the spend bucket ended at %s cents, not 0 — money was created or destroyed', total));
  end if;

  -- 6. A live card hold counts. bucketBalanceCents totals `completed` only, so
  --    before 0342 a child could tap their card for $8 at a shop and have an $8
  --    in-app spend approved against the same $10 in the same second.
  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, stripe_ref)
  values (fam, wallet, bucket, 'card_spend', 'completed', 'credit', 1000, 'top up $10', null),
         (fam, wallet, bucket, 'card_spend', 'processing', 'debit', 800, 'card hold', 'q01_hold_1');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  r := public.wallet_debit_spend_bucket(fam, wallet, 800, 'card_spend', 'Second $8', parent_u);
  if coalesce((r->>'ok')::boolean, false) is not false then
    failures := array_append(failures, 'an $8 in-app spend was approved while an $8 card hold already reserved the money — the two paths are still totalling different ledgers');
  elsif coalesce((r->>'available')::bigint, -1) <> 200 then
    failures := array_append(failures, format('the hold was not counted at its full value: %s', r));
  end if;
  r := public.wallet_debit_spend_bucket(fam, wallet, 200, 'card_spend', 'What is left', parent_u);
  if coalesce((r->>'ok')::boolean, false) is not true then
    failures := array_append(failures, format('the $2 the hold left over could not be spent (%s) — holds are being over-counted', r));
  end if;

  -- 7. A held debit is admitted and is inert. It moves nothing; wallet_decide_spend
  --    re-sums under this same lock before it ever posts.
  r := public.wallet_debit_spend_bucket(fam, wallet, 5000, 'card_spend', 'Bike', parent_u, true);
  if coalesce((r->>'ok')::boolean, false) is not true then
    failures := array_append(failures, format('a held spend request was refused (%s) — a request a parent has not seen yet moves no money and must still be fileable', r));
  elsif r->>'status' is distinct from 'requires_parent_approval' then
    failures := array_append(failures, format('the held debit did not land as requires_parent_approval: %s', r));
  end if;
  held_txn := (r->>'transaction_id')::uuid;

  perform set_config('role', 'postgres', true);
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into total from public.wallet_transactions
   where bucket_id = bucket and status in ('completed', 'processing');
  if total <> 0 then
    failures := array_append(failures, format('a held debit moved the spendable balance to %s — it is supposed to be inert until it is approved', total));
  end if;
  if not exists (select 1 from public.wallet_transactions
                  where id = held_txn and approved_by is null and created_by = parent_u) then
    failures := array_append(failures, 'the held debit is not unapproved and attributed to the member who filed it');
  end if;

  -- 8. forbidden, three ways.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  r := public.wallet_debit_spend_bucket(fam, wallet, 100, 'card_spend', 'Not me', kid_u);
  if r->>'reason' is distinct from 'forbidden' then
    failures := array_append(failures, format('a debit could be filed in someone else''s name (%s) — 0333''s rule is that a request says who actually filed it', r));
  end if;
  r := public.wallet_debit_spend_bucket(fam_b, wallet_b2, 100, 'card_spend', 'Other family', parent_u);
  if r->>'reason' is distinct from 'forbidden' then
    failures := array_append(failures, format('a manager of one family could spend from another family''s wallet (%s) — SECURITY DEFINER skips RLS, so this function is the only thing standing there', r));
  end if;

  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  r := public.wallet_debit_spend_bucket(fam, wallet, 100, 'card_spend', 'Kid spend', kid_u);
  if r->>'reason' is distinct from 'forbidden' then
    failures := array_append(failures, format('a CHILD wrote the ledger through this function (%s) — wallet_transactions'' INSERT policy is manager-only and a definer function has to restate it, not quietly lift it', r));
  end if;

  -- 9 & 10. Wrong family for the wallet, bad amounts, no spend bucket.
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  r := public.wallet_debit_spend_bucket(fam, wallet_b2, 100, 'card_spend', 'Wrong family', parent_u);
  if r->>'reason' is distinct from 'wallet_not_found' then
    failures := array_append(failures, format('another family''s wallet was accepted under this family''s id (%s)', r));
  end if;
  r := public.wallet_debit_spend_bucket(fam, wallet, 0, 'card_spend', 'Nothing', parent_u);
  if r->>'reason' is distinct from 'invalid_amount' then
    failures := array_append(failures, format('a $0 debit was not refused as invalid_amount (%s)', r));
  end if;
  r := public.wallet_debit_spend_bucket(fam, wallet, -500, 'card_spend', 'Negative', parent_u);
  if r->>'reason' is distinct from 'invalid_amount' then
    failures := array_append(failures, format('a NEGATIVE debit was not refused (%s) — the sign lives in `direction`, so this would have been a credit', r));
  end if;
  r := public.wallet_debit_spend_bucket(fam, wallet_b, 100, 'card_spend', 'No bucket', parent_u);
  if r->>'reason' is distinct from 'spend_bucket_missing' then
    failures := array_append(failures, format('a wallet with no spend bucket did not say so (%s)', r));
  end if;

  -- 11. Idempotency per complete key, and only per complete key.
  perform set_config('role', 'postgres', true);
  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
  values (fam, wallet, bucket, 'allowance', 'completed', 'credit', 5000, 'seed $50');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  r  := public.wallet_debit_spend_bucket(fam, wallet, 300, 'card_spend', 'Order 1', parent_u,
          false, null, 'marketplace_orders', fam);
  r2 := public.wallet_debit_spend_bucket(fam, wallet, 300, 'card_spend', 'Order 1', parent_u,
          false, null, 'marketplace_orders', fam);
  if coalesce((r2->>'ok')::boolean, false) is not true
     or r2->>'transaction_id' is distinct from r->>'transaction_id'
     or coalesce((r2->>'idempotent')::boolean, false) is not true then
    failures := array_append(failures, format('a replayed debit on the same key did not return the first one (%s then %s)', r, r2));
  end if;
  perform set_config('role', 'postgres', true);
  select count(*) into n from public.wallet_transactions
   where bucket_id = bucket and related_type = 'marketplace_orders' and related_id = fam;
  if n <> 1 then
    failures := array_append(failures, format('the replay wrote a second ledger row (%s rows for one key)', n));
  end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  r := public.wallet_debit_spend_bucket(fam, wallet, 300, 'card_spend', 'Order 2', parent_u,
         false, null, 'marketplace_orders', fam_b);
  if r->>'transaction_id' is null or coalesce((r->>'idempotent')::boolean, true) is not false then
    failures := array_append(failures, format('a DIFFERENT key was swallowed as a replay (%s) — the key is (family, bucket, related_type, related_id)', r));
  end if;

  -- 12. The trail is in the transaction, not after it.
  perform set_config('role', 'postgres', true);
  select count(*) into n from public.wallet_audit_logs
   where family_id = fam and actor_user_id = parent_u
     and action = 'debit_card_spend' and entity_id = wallet;
  if n = 0 then
    failures := array_append(failures, 'no wallet_audit_logs row was written for these debits — money moved with no trail');
  end if;

  -- ── 13. NEGATIVE CONTROL ────────────────────────────────────────────────
  -- The pre-0342 shape, on its own untouched $10 bucket, as the parent and
  -- therefore through the same RLS the old code went through. The snapshot is
  -- taken FIRST, a second spend lands, and the write is issued from the
  -- snapshot — which is exactly what two requests a few milliseconds apart did.
  -- The overdraft must LAND. If it does not, this probe cannot see the defect
  -- and every green line above is decoration.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  -- READ (bucketBalanceCents: no lock, `completed` only).
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into stale from public.wallet_transactions
   where family_id = fam and bucket_id = bucket_n and status = 'completed';

  -- The other request lands in between, through the fixed path.
  r := public.wallet_debit_spend_bucket(fam, wallet_n, 800, 'card_spend', 'Racer A', parent_u);
  if coalesce((r->>'ok')::boolean, false) is not true then
    failures := array_append(failures, format('the negative control could not post its first $8 (%s) — the control never got set up', r));
  end if;

  -- DECIDE + WRITE, from the number read before that.
  if stale >= 800 then
    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents,
       description, created_by, approved_by)
    values (fam, wallet_n, bucket_n, 'card_spend', 'completed', 'debit', 800,
            'Racer B (pre-0342 shape)', parent_u, parent_u);
    get diagnostics n = row_count;
  else
    n := 0;
  end if;

  perform set_config('role', 'postgres', true);
  if n <> 1 then
    failures := array_append(failures, 'the pre-0342 read-then-insert shape did NOT overdraw the bucket — this probe has never been shown to fail, so nothing it asserts is evidence of anything');
  end if;
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into total from public.wallet_transactions
   where bucket_id = bucket_n and status in ('completed', 'processing');
  if total <> -600 then
    failures := array_append(failures, format('the control bucket ended at %s cents rather than the -600 the defect produces — the control is not reproducing Q-01', total));
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a child can spend the same dollar twice (Q-01, 0342):\n  - %',
      array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-child-cannot-spend-the-same-dollar-twice: OK (a spend that fits posts, a second one is refused with the cents that are left, the exact remainder still posts, a live card hold counts against an in-app spend, a held request stays inert, forbidden holds for a stranger a child and another family, the key is idempotent only when it is complete, the audit row is in the transaction — and the pre-0342 read-then-insert shape reproduced the overdraft at -600 cents on its own bucket)';
end $probe$;

rollback;
