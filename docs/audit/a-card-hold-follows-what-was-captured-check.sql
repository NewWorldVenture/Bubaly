-- ── A card hold follows what was captured (0487) ────────────────────────────
--
-- An approved card authorization holds money: wallet_reserve_card_auth (0155)
-- writes a `processing` card_spend keyed by the authorization id, and every
-- spend decision counts it. The capture path released the WHOLE hold when the
-- first capture posted, so a merchant that captured less than it authorized
-- left the rest spendable while Stripe could still take it.
--
-- 0487 moves both steps into the database:
--   wallet_settle_card_capture  child wallet FOR KEY SHARE, spend bucket FOR
--                               UPDATE; post the capture once, cancel the live
--                               holds, hold the uncaptured remainder again under
--                               `<authorization>#remainder`;
--   wallet_close_card_auth      same locks; release what is left.
-- An authorization's holds are every live card_spend keyed by its id or by its
-- id then `#`: the remainder, and each later request's increase, which the app
-- holds under `<authorization>#request-<n>` so 0155 balance-checks it.
--
-- PART 1 — THE RACES. Two real connections each, through dblink. A HOLDER runs
--   the first step inside an open transaction; the RACER sends the second call
--   and is proven to be waiting on a lock (pg_locks, by the racer's own pid)
--   before the holder commits. No timing is trusted.
--     1  settle(40 of 100) | close        → the close releases the $60 remainder
--     2  close             | settle(40)   → no remainder is re-created
--     3  settle            | same settle  → one debit, the remainder held once
--     4  0205's lock order | settle       → the holder (child wallet FOR UPDATE,
--        then the bucket, as wallet_credit_child_ledger does) gets the bucket:
--        the settle waits on the child wallet BEFORE taking the bucket. With
--        the bucket taken first, PostgreSQL 16 reported `deadlock detected`.
--   Seeds are top-level statements, so psql commits them and the racers see
--   them. Failures are recorded, every connection is torn down and the seed is
--   deleted, and only THEN is the verdict raised — a failing race leaves no
--   rows and no idle-in-transaction holder behind.
--
-- PART 2 — THE SHAPE. One connection, one transaction, rolled back: full,
--   partial, over and forced captures; a capture after the close; duplicates;
--   a debit the fallback path posted (settled once, only against holds that
--   existed when it posted); a refund sharing the id; refusals, and a capture
--   already posted staying a success after its bucket is gone; reserve after a
--   partial capture (a replay is balance-checked, an increment that fits is
--   held and drawn by the next capture); another child's hold; the audit row;
--   client roles; a merchant's increments before any capture (each checked and
--   held under its own key, then drawn down or released with the rest); and a
--   hold whose key only LOOKS like the authorization's (a longer id, or `_` in
--   another character's place) left alone; and a fallback-posted capture
--   settled only against the holds that fallback releases, never an increase.
--
--   It also replays the pre-0487 statements (debit, then release the whole
--   hold) on a bucket of their own, to show the arithmetic of the defect next
--   to 0487's result for the same capture, and shows 0155 answering an
--   increase keyed by the authorization id "already reserved" with no hold. That pair documents the difference;
--   it does not test 0487 by itself. The evidence that this probe can fail is
--   the mutation recorded on the PR: a settle that re-holds nothing fails
--   races 1 and 3.

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — THE RACES
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists dblink;
-- Same hygiene as a-child-cannot-spend-the-same-dollar-twice-check.sql: only
-- this probe, as the owner, calls dblink, so no client role keeps any of it.
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

-- One run at a time: two runs would seed and delete the same family.
do $solo$
declare
  waited_ms int := 0;
begin
  while not pg_try_advisory_lock(487) loop
    if waited_ms >= 60000 then
      raise exception 'card-hold: another run of this probe has held its single-run lock (advisory key 487) for 60s. Wait for it, or use a throwaway instance — docs/audit/verify-pg.sh up.';
    end if;
    perform pg_sleep(0.05);
    waited_ms := waited_ms + 50;
  end loop;
end
$solo$;

-- Both functions exist and lock, judged on their CODE: comments are stripped
-- first, so a body whose lock was removed but whose comment still says
-- "for update" is not mistaken for one that locks.
do $precheck$
declare
  fn text;
  v_code text;
begin
  foreach fn in array array['wallet_settle_card_capture', 'wallet_close_card_auth'] loop
    select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_code
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = fn;
    if v_code is null then
      raise exception 'card-hold: public.% does not exist — apply supabase/migrations/0487_a_card_hold_follows_what_was_captured.sql first', fn;
    end if;
    if v_code !~* 'from\s+public\.wallet_buckets[^;]*for\s+update' then
      raise exception 'card-hold: public.% does not take the spend bucket FOR UPDATE — the races below would prove nothing', fn;
    end if;
    if v_code !~* 'from\s+public\.child_wallets[^;]*for\s+key\s+share' then
      raise exception 'card-hold: public.% does not take the child wallet FOR KEY SHARE before the bucket — the lock order 0205 needs', fn;
    end if;
  end loop;
end
$precheck$;

create temp table cardhold_failures (msg text);

delete from public.wallet_audit_logs   where family_id = '00000000-0000-4000-8000-0000000c4870';
delete from public.wallet_transactions where family_id = '00000000-0000-4000-8000-0000000c4870';
delete from public.wallet_buckets      where family_id = '00000000-0000-4000-8000-0000000c4870';
delete from public.child_wallets       where family_id = '00000000-0000-4000-8000-0000000c4870';
delete from public.family_members      where family_id = '00000000-0000-4000-8000-0000000c4870';
delete from public.families            where id        = '00000000-0000-4000-8000-0000000c4870';
delete from auth.users                 where id        = '00000000-0000-4000-8000-0000000c4871';

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-0000000c4871', 'card-hold-race-parent@example.com');

insert into public.families (id, name, created_by)
values ('00000000-0000-4000-8000-0000000c4870', 'Card Hold House', '00000000-0000-4000-8000-0000000c4871');

-- Four children, one per race, so no race sees another's rows.
insert into public.family_members (id, family_id, display_name, role, is_active)
values ('00000000-0000-4000-8000-0000000c4881', '00000000-0000-4000-8000-0000000c4870', 'Race One',   'child', true),
       ('00000000-0000-4000-8000-0000000c4882', '00000000-0000-4000-8000-0000000c4870', 'Race Two',   'child', true),
       ('00000000-0000-4000-8000-0000000c4883', '00000000-0000-4000-8000-0000000c4870', 'Race Three', 'child', true),
       ('00000000-0000-4000-8000-0000000c4884', '00000000-0000-4000-8000-0000000c4870', 'Race Four',  'child', true);

insert into public.child_wallets (id, family_id, member_id)
values ('00000000-0000-4000-8000-0000000c4891', '00000000-0000-4000-8000-0000000c4870', '00000000-0000-4000-8000-0000000c4881'),
       ('00000000-0000-4000-8000-0000000c4892', '00000000-0000-4000-8000-0000000c4870', '00000000-0000-4000-8000-0000000c4882'),
       ('00000000-0000-4000-8000-0000000c4893', '00000000-0000-4000-8000-0000000c4870', '00000000-0000-4000-8000-0000000c4883'),
       ('00000000-0000-4000-8000-0000000c4894', '00000000-0000-4000-8000-0000000c4870', '00000000-0000-4000-8000-0000000c4884');

insert into public.wallet_buckets (family_id, child_wallet_id, kind, label)
select '00000000-0000-4000-8000-0000000c4870', id, 'spend', 'Spend'
  from public.child_wallets where family_id = '00000000-0000-4000-8000-0000000c4870';

-- $150 in each Spend bucket, and a $100 hold placed the way an approval places it.
insert into public.wallet_transactions
  (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
select '00000000-0000-4000-8000-0000000c4870', b.child_wallet_id, b.id,
       'parent_top_up', 'completed', 'credit', 15000, 'seed $150'
  from public.wallet_buckets b
 where b.family_id = '00000000-0000-4000-8000-0000000c4870' and b.kind = 'spend';

select public.wallet_reserve_card_auth('00000000-0000-4000-8000-0000000c4870', id, 10000,
         'cardhold_r' || right(id::text, 1) || '_auth', 'Gas')
  from public.child_wallets where family_id = '00000000-0000-4000-8000-0000000c4870' order by id;

do $race$
declare
  fam constant uuid := '00000000-0000-4000-8000-0000000c4870';
  v_conn text;
  pair record;
  waited_ms int;
  waiting int;
  racer_pid int;
  raced jsonb;
  debits bigint;
  held bigint;
  spendable bigint;
  bucket_got boolean;
begin
  v_conn := 'dbname=' || current_database()
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
    || ' port=' || current_setting('port')
    || ' user=' || current_user;

  for pair in
    select * from (values
      (1, '00000000-0000-4000-8000-0000000c4891'::uuid,
          'select public.wallet_settle_card_capture(%L, %L, ''cardhold_r1_cap'', ''cardhold_r1_auth'', 4000, ''Gas'')',
          'select public.wallet_close_card_auth(%L, %L, ''cardhold_r1_auth'')',
          'released_cents', '6000', 1::bigint, 0::bigint, 11000::bigint),
      (2, '00000000-0000-4000-8000-0000000c4892'::uuid,
          'select public.wallet_close_card_auth(%L, %L, ''cardhold_r2_auth'')',
          'select public.wallet_settle_card_capture(%L, %L, ''cardhold_r2_cap'', ''cardhold_r2_auth'', 4000, ''Gas'')',
          'remainder_cents', '0', 1::bigint, 0::bigint, 11000::bigint),
      (3, '00000000-0000-4000-8000-0000000c4893'::uuid,
          'select public.wallet_settle_card_capture(%L, %L, ''cardhold_r3_cap'', ''cardhold_r3_auth'', 4000, ''Gas'')',
          'select public.wallet_settle_card_capture(%L, %L, ''cardhold_r3_cap'', ''cardhold_r3_auth'', 4000, ''Gas'')',
          'idempotent', 'true', 1::bigint, 6000::bigint, 5000::bigint),
      (4, '00000000-0000-4000-8000-0000000c4894'::uuid,
          'select id from public.child_wallets where id = %2$L and family_id = %1$L for update',
          'select public.wallet_settle_card_capture(%L, %L, ''cardhold_r4_cap'', ''cardhold_r4_auth'', 4000, ''Gas'')',
          'remainder_cents', '6000', 1::bigint, 6000::bigint, 5000::bigint)
    ) as t(n, wallet, first_call, second_call, key, want, want_debits, want_held, want_spendable)
  loop
    begin
      -- The HOLDER runs the first step in an open transaction and keeps its locks.
      perform dblink_connect('cardhold_hold', v_conn || ' application_name=cardhold_holder');
      perform dblink_exec('cardhold_hold', 'begin');
      if pair.n = 4 then
        perform * from dblink('cardhold_hold', format(pair.first_call, fam, pair.wallet)) as t(id uuid);
      else
        perform * from dblink('cardhold_hold', format(pair.first_call, fam, pair.wallet)) as t(v jsonb);
      end if;

      perform dblink_connect('cardhold_race', v_conn || ' application_name=cardhold_racer');
      -- The racer's pid, asked of the racer itself. Not pg_stat_activity: this
      -- block is one transaction, and that view is snapshotted once per
      -- transaction, so a racer connected for a later pair would never appear.
      select pid into racer_pid from dblink('cardhold_race', 'select pg_backend_pid()') as t(pid int);
      perform dblink_send_query('cardhold_race', format(pair.second_call, fam, pair.wallet));

      -- PROOF OF CONTENTION: the racer is waiting on a lock the holder holds.
      waited_ms := 0;
      loop
        select count(*) into waiting from pg_locks l where l.pid = racer_pid and not l.granted;
        exit when waiting > 0 or waited_ms >= 15000;
        perform pg_sleep(0.002);
        waited_ms := waited_ms + 2;
      end loop;
      if waiting = 0 then
        insert into cardhold_failures values (format('race %s: the second call never waited on a lock — it did not contend with the first, so this pair proves nothing', pair.n));
      end if;

      if pair.n = 4 then
        -- 0205's second step: the bucket. The settle must not be holding it.
        perform dblink_exec('cardhold_hold', 'set local lock_timeout = ''3s''');
        begin
          perform * from dblink('cardhold_hold', format(
            'select id from public.wallet_buckets where child_wallet_id = %L and kind = ''spend'' for update', pair.wallet)) as t(id uuid);
          bucket_got := true;
        exception when others then
          bucket_got := false;
        end;
        if not bucket_got then
          insert into cardhold_failures values ('race 4: a transaction holding the child wallet (0205''s order) could not take the spend bucket — the settle took the bucket before the child wallet, the order that deadlocks against wallet_credit_child_ledger');
        end if;
      end if;

      perform dblink_exec('cardhold_hold', case when pair.n = 4 and not bucket_got then 'rollback' else 'commit' end);
      perform dblink_disconnect('cardhold_hold');
      select v into raced from dblink_get_result('cardhold_race') as t(v jsonb);
      perform * from dblink_get_result('cardhold_race') as t(v jsonb);
      perform dblink_disconnect('cardhold_race');
    exception when others then
      insert into cardhold_failures values (format('race %s: %s', pair.n, sqlerrm));
      if 'cardhold_hold' = any(coalesce(dblink_get_connections(), '{}')) then perform dblink_disconnect('cardhold_hold'); end if;
      if 'cardhold_race' = any(coalesce(dblink_get_connections(), '{}')) then perform dblink_disconnect('cardhold_race'); end if;
      continue;
    end;

    if raced->>pair.key is distinct from pair.want then
      insert into cardhold_failures values (format('race %s: the waiting call answered %s, expected %s = %s', pair.n, raced, pair.key, pair.want));
    end if;
    select count(*) into debits from public.wallet_transactions
     where stripe_ref = 'cardhold_r' || pair.n || '_cap' and type = 'card_spend' and status = 'completed';
    select coalesce(sum(amount_cents), 0) into held from public.wallet_transactions
     where stripe_ref in ('cardhold_r' || pair.n || '_auth', 'cardhold_r' || pair.n || '_auth#remainder')
       and type = 'card_spend' and status = 'processing';
    select coalesce(sum(case when t.direction = 'credit' then t.amount_cents else -t.amount_cents end), 0) into spendable
      from public.wallet_transactions t join public.wallet_buckets b on b.id = t.bucket_id
     where b.child_wallet_id = pair.wallet and b.kind = 'spend' and t.status in ('completed', 'processing');
    if debits <> pair.want_debits or held <> pair.want_held or spendable <> pair.want_spendable then
      insert into cardhold_failures values (format('race %s: ended with %s debit(s), %s cents held, %s spendable — expected %s, %s, %s',
        pair.n, debits, held, spendable, pair.want_debits, pair.want_held, pair.want_spendable));
    end if;
  end loop;
end $race$;

-- Teardown BEFORE the verdict: a failing race leaves nothing behind.
delete from public.wallet_audit_logs   where family_id = '00000000-0000-4000-8000-0000000c4870';
delete from public.wallet_transactions where family_id = '00000000-0000-4000-8000-0000000c4870';
delete from public.wallet_buckets      where family_id = '00000000-0000-4000-8000-0000000c4870';
delete from public.child_wallets       where family_id = '00000000-0000-4000-8000-0000000c4870';
delete from public.family_members      where family_id = '00000000-0000-4000-8000-0000000c4870';
delete from public.families            where id        = '00000000-0000-4000-8000-0000000c4870';
delete from auth.users                 where id        = '00000000-0000-4000-8000-0000000c4871';

do $verdict$
declare
  failures text;
begin
  select string_agg(msg, E'\n  - ') into failures from cardhold_failures;
  if failures is not null then
    perform pg_advisory_unlock(487);
    raise exception E'a card hold does not follow what was captured under concurrency (0487):\n  - %', failures;
  end if;
  raise notice 'a-card-hold-follows-what-was-captured (races): OK (a close waiting on a partial capture releases its $60 remainder, a capture waiting on a close re-creates no hold, a capture delivered twice at once posts once with the remainder held once, and a transaction holding the child wallet the way 0205 does still gets the bucket)';
end $verdict$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — THE SHAPE (one transaction, rolled back)
-- ═══════════════════════════════════════════════════════════════════════════

begin;

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-0000000c4872', 'card-hold-shape-parent@example.com');
insert into public.families (id, name, created_by)
values ('00000000-0000-4000-8000-0000000c4873', 'Card Hold Shape', '00000000-0000-4000-8000-0000000c4872');

do $probe$
declare
  fam constant uuid := '00000000-0000-4000-8000-0000000c4873';
  -- Every message is appended as text: after `text[] ||` an untyped literal is
  -- read as an array and raises `malformed array literal` instead of itself.
  failures text[] := '{}';
  r jsonb;
  m uuid; w uuid; b uuid;
  wallets uuid[] := '{}';
  buckets uuid[] := '{}';
  i int;
  got bigint;
begin
  -- Twenty children, each with $150 in Spend (index = scenario).
  for i in 1..20 loop
    insert into public.family_members (family_id, display_name, role, is_active)
    values (fam, 'Shape ' || i, 'child', true) returning id into m;
    insert into public.child_wallets (family_id, member_id) values (fam, m) returning id into w;
    insert into public.wallet_buckets (family_id, child_wallet_id, kind, label) values (fam, w, 'spend', 'Spend') returning id into b;
    insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
    values (fam, w, b, 'parent_top_up', 'completed', 'credit', 15000, 'seed $150');
    wallets := wallets || w; buckets := buckets || b;
  end loop;

  -- 1. A full capture: the hold goes, nothing is re-held, one audit row naming the transaction.
  perform public.wallet_reserve_card_auth(fam, wallets[1], 2000, 'shape1_auth', 'Books');
  r := public.wallet_settle_card_capture(fam, wallets[1], 'shape1_cap', 'shape1_auth', 2000, 'Books');
  if (r->>'released_cents')::bigint is distinct from 2000 or (r->>'remainder_cents')::bigint is distinct from 0 then
    failures := failures || format('full capture answered %s', r);
  end if;
  if (select count(*) from public.wallet_audit_logs where entity_id = wallets[1] and action = 'card_spend' and metadata->>'stripeRef' = 'shape1_cap') <> 1 then
    failures := failures || 'a full capture did not write exactly one card_spend audit row naming its transaction'::text;
  end if;

  -- 2. A partial capture: $40 of $100 leaves $60 held, and a second capture takes it.
  perform public.wallet_reserve_card_auth(fam, wallets[2], 10000, 'shape2_auth', 'Gas');
  perform public.wallet_settle_card_capture(fam, wallets[2], 'shape2_cap1', 'shape2_auth', 4000, 'Gas');
  select coalesce(sum(amount_cents), 0) into got from public.wallet_transactions
   where stripe_ref in ('shape2_auth', 'shape2_auth#remainder') and status = 'processing';
  if got <> 6000 then failures := failures || format('a $40 capture of a $100 hold left %s cents held, not 6000', got); end if;
  perform public.wallet_settle_card_capture(fam, wallets[2], 'shape2_cap2', 'shape2_auth', 6000, 'Gas');
  select coalesce(sum(amount_cents), 0) into got from public.wallet_transactions
   where stripe_ref in ('shape2_auth', 'shape2_auth#remainder') and status = 'processing';
  if got <> 0 then failures := failures || format('the second capture left %s cents held, not 0', got); end if;

  -- 3. A partial capture, then the close: the remainder is released, once.
  perform public.wallet_reserve_card_auth(fam, wallets[3], 10000, 'shape3_auth', 'Gas');
  perform public.wallet_settle_card_capture(fam, wallets[3], 'shape3_cap', 'shape3_auth', 4000, 'Gas');
  r := public.wallet_close_card_auth(fam, wallets[3], 'shape3_auth');
  if (r->>'released_cents')::bigint is distinct from 6000 then failures := failures || format('the close after a partial capture answered %s', r); end if;
  r := public.wallet_close_card_auth(fam, wallets[3], 'shape3_auth');
  if (r->>'released_cents')::bigint is distinct from 0 then failures := failures || format('a second close answered %s', r); end if;

  -- 4. A capture after the close: debited, no hold re-created.
  perform public.wallet_reserve_card_auth(fam, wallets[4], 2000, 'shape4_auth', 'Books');
  perform public.wallet_close_card_auth(fam, wallets[4], 'shape4_auth');
  perform public.wallet_settle_card_capture(fam, wallets[4], 'shape4_cap', 'shape4_auth', 1500, 'Books');
  select coalesce(sum(amount_cents), 0) into got from public.wallet_transactions
   where stripe_ref in ('shape4_auth', 'shape4_auth#remainder') and status = 'processing';
  if got <> 0 then failures := failures || format('a capture after the close re-held %s cents', got); end if;

  -- 5. The same capture twice: idempotent, holds included; $50 left, where the
  --    pre-0487 statements (scenario 15) leave $110.
  perform public.wallet_reserve_card_auth(fam, wallets[5], 10000, 'shape5_auth', 'Gas');
  perform public.wallet_settle_card_capture(fam, wallets[5], 'shape5_cap', 'shape5_auth', 4000, 'Gas');
  r := public.wallet_settle_card_capture(fam, wallets[5], 'shape5_cap', 'shape5_auth', 4000, 'Gas');
  select coalesce(sum(amount_cents), 0) into got from public.wallet_transactions
   where stripe_ref in ('shape5_auth', 'shape5_auth#remainder') and status = 'processing';
  if (r->>'idempotent')::boolean is not true or got <> 6000 then
    failures := failures || format('a second delivery answered %s and left %s cents held, not idempotent with 6000', r, got);
  end if;
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0) into got
    from public.wallet_transactions where bucket_id = buckets[5] and status in ('completed', 'processing');
  if got <> 5000 then failures := failures || format('0487 left %s cents spendable after a $40 capture of a $100 hold, not 5000', got); end if;

  -- 6. A capture above the hold (a tip): nothing stays held.
  perform public.wallet_reserve_card_auth(fam, wallets[6], 2000, 'shape6_auth', 'Cafe');
  r := public.wallet_settle_card_capture(fam, wallets[6], 'shape6_cap', 'shape6_auth', 2500, 'Cafe');
  if (r->>'remainder_cents')::bigint is distinct from 0 then failures := failures || format('an over-capture answered %s', r); end if;

  -- 7. A force capture (no authorization) touches no hold.
  perform public.wallet_reserve_card_auth(fam, wallets[7], 2000, 'shape7_auth', 'Books');
  perform public.wallet_settle_card_capture(fam, wallets[7], 'shape7_cap', null, 1000, 'Forced');
  select coalesce(sum(amount_cents), 0) into got from public.wallet_transactions
   where stripe_ref = 'shape7_auth' and status = 'processing';
  if got <> 2000 then failures := failures || format('a force capture changed another hold to %s cents', got); end if;

  -- 8. Refusals write nothing; a capture already posted stays a success after its bucket is gone.
  if public.wallet_settle_card_capture(fam, gen_random_uuid(), 'shape8_cap', null, 100, 'x')->>'reason' is distinct from 'no_spend_bucket'
     or public.wallet_settle_card_capture(fam, wallets[8], 'shape8_cap', null, 0, 'x')->>'reason' is distinct from 'invalid_amount'
     or public.wallet_settle_card_capture(fam, wallets[8], '', null, 100, 'x')->>'reason' is distinct from 'missing_transaction'
     or public.wallet_close_card_auth(fam, wallets[8], '')->>'reason' is distinct from 'missing_authorization' then
    failures := failures || 'a refusal did not name its reason'::text;
  end if;
  if exists (select 1 from public.wallet_transactions where stripe_ref = 'shape8_cap') then
    failures := failures || 'a refused capture wrote a row'::text;
  end if;
  perform public.wallet_settle_card_capture(fam, wallets[8], 'shape8_posted', null, 100, 'x');
  update public.wallet_buckets set kind = 'save' where id = buckets[8];
  if (public.wallet_settle_card_capture(fam, wallets[8], 'shape8_posted', null, 100, 'x')->>'ok')::boolean is not true then
    failures := failures || 'a capture already posted was refused once its spend bucket had gone'::text;
  end if;

  -- 9. After a partial capture, reserve is balance-checked again: a replayed
  --    $100 request does not fit the $50 left and places nothing; a $30
  --    increment (the app's second request) fits, and the next capture draws
  --    down both.
  perform public.wallet_reserve_card_auth(fam, wallets[9], 10000, 'shape9_auth', 'Gas');
  perform public.wallet_settle_card_capture(fam, wallets[9], 'shape9_cap', 'shape9_auth', 4000, 'Gas');
  if public.wallet_reserve_card_auth(fam, wallets[9], 10000, 'shape9_auth', 'Gas') then
    failures := failures || 'a $100 request after a $40 partial capture was approved against the $50 left'::text;
  end if;
  if not public.wallet_reserve_card_auth(fam, wallets[9], 3000, 'shape9_auth#request-1', 'Gas') then
    failures := failures || 'a $30 increment that fits was declined'::text;
  end if;
  perform public.wallet_settle_card_capture(fam, wallets[9], 'shape9_cap2', 'shape9_auth', 9000, 'Gas');
  select coalesce(sum(amount_cents), 0) into got from public.wallet_transactions
   where stripe_ref like 'shape9%' and type = 'card_spend' and status = 'processing';
  if got <> 0 then failures := failures || format('a $90 capture left %s cents of the remainder and increment held', got); end if;

  -- 10. A debit the fallback posted (no hold_settled mark) is settled against
  --     the hold that existed when it posted — once.
  perform public.wallet_reserve_card_auth(fam, wallets[10], 10000, 'shape10_auth', 'Gas');
  insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, stripe_ref, metadata, created_at)
  values (fam, wallets[10], buckets[10], 'card_spend', 'completed', 'debit', 4000, 'Gas', 'shape10_cap', '{"source":"issuing"}', now() + interval '1 second');
  perform public.wallet_settle_card_capture(fam, wallets[10], 'shape10_cap', 'shape10_auth', 4000, 'Gas');
  perform public.wallet_settle_card_capture(fam, wallets[10], 'shape10_cap', 'shape10_auth', 4000, 'Gas');
  select coalesce(sum(amount_cents), 0) into got from public.wallet_transactions
   where stripe_ref in ('shape10_auth', 'shape10_auth#remainder') and status = 'processing';
  if got <> 6000 then failures := failures || format('a fallback-posted $40 capture left %s cents of a $100 hold held, not 6000 (drawn once)', got); end if;

  -- 11. …and never against a hold placed after it.
  insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, stripe_ref, metadata, created_at)
  values (fam, wallets[11], buckets[11], 'card_spend', 'completed', 'debit', 4000, 'Gas', 'shape11_cap', '{"source":"issuing"}', now() - interval '1 minute');
  perform public.wallet_reserve_card_auth(fam, wallets[11], 3000, 'shape11_auth', 'Gas');
  perform public.wallet_settle_card_capture(fam, wallets[11], 'shape11_cap', 'shape11_auth', 4000, 'Gas');
  select coalesce(sum(amount_cents), 0) into got from public.wallet_transactions
   where stripe_ref = 'shape11_auth' and status = 'processing';
  if got <> 3000 then failures := failures || format('a fallback debit drew down a hold placed after it (%s cents left)', got); end if;

  -- 12. A refund sharing the capture's id is not the capture.
  perform public.wallet_reserve_card_auth(fam, wallets[12], 2000, 'shape12_auth', 'Books');
  insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, stripe_ref)
  values (fam, wallets[12], buckets[12], 'card_refund', 'completed', 'credit', 2000, 'Books', 'shape12_cap');
  r := public.wallet_settle_card_capture(fam, wallets[12], 'shape12_cap', 'shape12_auth', 2000, 'Books');
  if (r->>'idempotent')::boolean is not false then failures := failures || format('a refund was mistaken for its capture: %s', r); end if;

  -- 13. A hold in ANOTHER child's bucket under the same authorization id is not drawn down.
  perform public.wallet_reserve_card_auth(fam, wallets[13], 2000, 'shape13_auth', 'Books');
  perform public.wallet_settle_card_capture(fam, wallets[14], 'shape13_cap', 'shape13_auth', 2000, 'Books');
  select coalesce(sum(amount_cents), 0) into got from public.wallet_transactions
   where stripe_ref = 'shape13_auth' and status = 'processing';
  if got <> 2000 then failures := failures || format('a capture on one child released another child''s hold (%s cents left)', got); end if;

  -- 14. Client roles cannot call either function.
  if has_function_privilege('anon', 'public.wallet_settle_card_capture(uuid, uuid, text, text, bigint, text)', 'execute')
     or has_function_privilege('authenticated', 'public.wallet_settle_card_capture(uuid, uuid, text, text, bigint, text)', 'execute')
     or has_function_privilege('anon', 'public.wallet_close_card_auth(uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.wallet_close_card_auth(uuid, uuid, text)', 'execute') then
    failures := failures || 'a client role can execute a card-hold function'::text;
  end if;

  -- 15. The pre-0487 statements on a bucket of their own (see the header):
  --     debit, then release the WHOLE hold. Same capture as scenario 5.
  perform public.wallet_reserve_card_auth(fam, wallets[15], 10000, 'shape15_auth', 'Gas');
  insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, stripe_ref)
  values (fam, wallets[15], buckets[15], 'card_spend', 'completed', 'debit', 4000, 'Gas', 'shape15_cap');
  update public.wallet_transactions set status = 'cancelled'
   where stripe_ref = 'shape15_auth' and type = 'card_spend' and status = 'processing';
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0) into got
    from public.wallet_transactions where bucket_id = buckets[15] and status in ('completed', 'processing');
  if got <> 11000 then
    failures := failures || format('the pre-0487 statements left %s cents spendable, not the 11000 that releasing the whole hold produces', got);
  end if;

  -- 16. A merchant raising an authorization before any capture (a hotel).
  --     $40 held; under the authorization id, 0155 answers a $200 increase
  --     "already reserved" and holds nothing (the defect, shown not tested);
  --     under the app's key it is checked against the $110 left and declined,
  --     a $30 one is held once however often it is delivered, and a $70
  --     capture draws down both, leaving nothing held.
  perform public.wallet_reserve_card_auth(fam, wallets[16], 4000, 'shape16_auth', 'Hotel');
  if not public.wallet_reserve_card_auth(fam, wallets[16], 20000, 'shape16_auth', 'Hotel')
     or (select count(*) from public.wallet_transactions where bucket_id = buckets[16] and status = 'processing') <> 1 then
    failures := failures || '0155 no longer answers an increase under the authorization id "already reserved" with no hold: re-read the app''s keying (cardHoldRef)'::text;
  end if;
  if public.wallet_reserve_card_auth(fam, wallets[16], 20000, 'shape16_auth#request-1', 'Hotel') then
    failures := failures || 'a $200 increase was approved against the $110 left'::text;
  end if;
  if not public.wallet_reserve_card_auth(fam, wallets[16], 3000, 'shape16_auth#request-2', 'Hotel')
     or not public.wallet_reserve_card_auth(fam, wallets[16], 3000, 'shape16_auth#request-2', 'Hotel') then
    failures := failures || 'a $30 increase that fits was declined'::text;
  end if;
  select coalesce(sum(amount_cents), 0) into got from public.wallet_transactions
   where bucket_id = buckets[16] and type = 'card_spend' and status = 'processing';
  if got <> 7000 then failures := failures || format('the $40 hold and a $30 increase delivered twice hold %s cents, not 7000', got); end if;
  r := public.wallet_settle_card_capture(fam, wallets[16], 'shape16_cap', 'shape16_auth', 7000, 'Hotel');
  select coalesce(sum(amount_cents), 0) into got from public.wallet_transactions
   where bucket_id = buckets[16] and type = 'card_spend' and status = 'processing';
  if (r->>'released_cents')::bigint is distinct from 7000 or got <> 0 then
    failures := failures || format('a $70 capture of a $40 hold and its $30 increase answered %s and left %s cents held', r, got);
  end if;
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0) into got
    from public.wallet_transactions where bucket_id = buckets[16] and status in ('completed', 'processing');
  if got <> 8000 then failures := failures || format('after the $70 stay %s cents are spendable, not 8000', got); end if;

  -- 17. A partial capture across the first hold and an increase: $50 of $70
  --     leaves $20 held; a further $10 increase is held; the close releases
  --     the $30, once.
  perform public.wallet_reserve_card_auth(fam, wallets[17], 4000, 'shape17_auth', 'Car');
  perform public.wallet_reserve_card_auth(fam, wallets[17], 3000, 'shape17_auth#request-1', 'Car');
  r := public.wallet_settle_card_capture(fam, wallets[17], 'shape17_cap', 'shape17_auth', 5000, 'Car');
  if (r->>'released_cents')::bigint is distinct from 7000 or (r->>'remainder_cents')::bigint is distinct from 2000 then
    failures := failures || format('a $50 capture of $40 + $30 held answered %s, not 7000 released and 2000 re-held', r);
  end if;
  perform public.wallet_reserve_card_auth(fam, wallets[17], 1000, 'shape17_auth#request-2', 'Car');
  r := public.wallet_close_card_auth(fam, wallets[17], 'shape17_auth');
  if (r->>'released_cents')::bigint is distinct from 3000 then
    failures := failures || format('the close after a partial capture and a later increase answered %s, not 3000', r);
  end if;
  if (public.wallet_close_card_auth(fam, wallets[17], 'shape17_auth')->>'released_cents')::bigint is distinct from 0
     or exists (select 1 from public.wallet_transactions where bucket_id = buckets[17] and type = 'card_spend' and status = 'processing') then
    failures := failures || 'a hold of the closed authorization is still live, or a second close released more'::text;
  end if;

  -- 18. Holds whose keys only look like the authorization's are not its own:
  --     a longer id (`shape18_auth2`), and `_` in another character's place
  --     (`shape18Xauth#request-1`, which LIKE 'shape18_auth#%' would match).
  perform public.wallet_reserve_card_auth(fam, wallets[18], 2000, 'shape18_auth', 'Books');
  perform public.wallet_reserve_card_auth(fam, wallets[18], 1000, 'shape18_auth2', 'Books');
  perform public.wallet_reserve_card_auth(fam, wallets[18], 1500, 'shape18Xauth#request-1', 'Books');
  perform public.wallet_settle_card_capture(fam, wallets[18], 'shape18_cap', 'shape18_auth', 1000, 'Books');
  perform public.wallet_close_card_auth(fam, wallets[18], 'shape18_auth');
  select coalesce(sum(amount_cents), 0) into got from public.wallet_transactions
   where bucket_id = buckets[18] and stripe_ref in ('shape18_auth2', 'shape18Xauth#request-1') and status = 'processing';
  if got <> 2500 then failures := failures || format('settling and closing shape18_auth released holds of other authorizations (%s of 2500 cents still held)', got); end if;
  if exists (select 1 from public.wallet_transactions where bucket_id = buckets[18] and stripe_ref like 'shape18\_auth%' and stripe_ref <> 'shape18_auth2' and status = 'processing') then
    failures := failures || 'a hold of the closed shape18_auth is still live'::text;
  end if;

  -- 19. A debit the fallback posted is settled only against what the fallback
  --     releases. $100 held and a $50 increase; the fallback posted the $100
  --     capture and released the $100 hold, and the event comes back once
  --     0487 is there: the $50 increase may still be captured, so it stays.
  perform public.wallet_reserve_card_auth(fam, wallets[19], 10000, 'shape19_auth', 'Hotel');
  perform public.wallet_reserve_card_auth(fam, wallets[19], 5000, 'shape19_auth#request-1', 'Hotel');
  insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, stripe_ref, metadata, created_at)
  values (fam, wallets[19], buckets[19], 'card_spend', 'completed', 'debit', 10000, 'Hotel', 'shape19_cap', '{"source":"issuing"}', now() + interval '1 second');
  update public.wallet_transactions set status = 'cancelled'
   where stripe_ref in ('shape19_auth', 'shape19_auth#remainder') and type = 'card_spend' and status = 'processing';
  r := public.wallet_settle_card_capture(fam, wallets[19], 'shape19_cap', 'shape19_auth', 10000, 'Hotel');
  select coalesce(sum(amount_cents), 0) into got from public.wallet_transactions
   where bucket_id = buckets[19] and type = 'card_spend' and status = 'processing';
  if (r->>'released_cents')::bigint is distinct from 0 or got <> 5000 then
    failures := failures || format('settling a fallback-posted $100 capture answered %s and left %s cents held, not the $50 increase (5000)', r, got);
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a card hold does not follow what was captured (0487):\n  - %',
      array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-card-hold-follows-what-was-captured: OK (full, partial, over and forced captures, a capture after the close, duplicates, a fallback-posted debit settled once and never against a later hold, a refund sharing the id, refusals, reserve balance-checked after a partial capture, another child''s hold, the audit row and client roles, a merchant''s increases checked, held and released with the rest, a fallback-posted capture never freeing an increase, and lookalike keys left alone; a $40 capture of a $100 hold leaves $50 where the pre-0487 statements leave $110)';
end $probe$;

rollback;

select pg_advisory_unlock(487);
