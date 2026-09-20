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
--
-- ── the second session needs a password ────────────────────────────────────
--
-- dblink refuses a password-less connection unless the caller is a SUPERUSER,
-- and on Supabase the `postgres` role is not one:
--
--   select current_user, usesuper from pg_user where usename = current_user;
--   postgres | f
--
-- So this probe did not skip and did not pass — it ERRORED, on every Supabase
-- database it was ever pointed at:
--
--   ERROR: password is required
--   DETAIL: Non-superusers must provide a password in the connection string.
--   CONTEXT: SQL statement "SELECT dblink_connect('a15_a', v_conn)"
--
-- which means the overlapping-transaction race below has never once been
-- exercised. The password is read from a GUC rather than hardcoded; run-probes.sh
-- forwards $PGPASSWORD into it. Absent one the probe SKIPS and says exactly what
-- to set, which is the same bargain as the missing-dblink case above.

create extension if not exists dblink;

-- Committed seed: a fresh $10 wallet, isolated from the sequential probe's.
--
-- These rows go into the SEEDED ANCHOR FAMILY, and they are committed, because
-- the dblink sessions below have to see them. Clearing them at the start makes
-- the probe repeatable — but repeatable is not the same as clean, and this one
-- was not: after every run a phantom "Race Child" member stayed in the anchor
-- family until the next run cleared it. It was found by a cross-family sweep
-- that counted a `family_members` row with a null `user_id` that no fixture in
-- that sweep had created.
--
-- A probe that leaves a member behind in the family everything else is measured
-- against is a probe that changes what the next measurement sees: anything
-- counting members, listing children, or asserting a household's shape gets a
-- child nobody added. So the same fixtures are cleared again at the END of the
-- file. The start-of-run delete stays, because a run that dies mid-way still
-- has to leave the next one a clean slate.
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
  v_pass   text;
  v_super  boolean;
  approved_a boolean;
  approved_b boolean;
  n_approved int;
  held bigint;
begin
  if to_regprocedure('public.dblink(text,text)') is null then
    raise warning 'PROBE-SKIPPED: A-15 — dblink unavailable, concurrency not exercised here';
    return;
  end if;

  select usesuper into v_super from pg_user where usename = current_user;
  v_pass := coalesce(current_setting('bubaly.dblink_password', true), '');

  if v_super then
    -- A superuser may open a password-less session over the local socket.
    v_conn := 'dbname=' || current_database()
      || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
      || ' port=' || current_setting('port')
      || ' user=' || current_user;
  elsif v_pass <> '' and inet_server_addr() is not null then
    -- Everyone else needs a host that ASKS for the password. Supplying one is
    -- not enough: dblink also refuses when the server would not have demanded
    -- it, so that a non-superuser cannot connect as anybody they like —
    --
    --   host all all 127.0.0.1/32  trust           -- refused, no password asked
    --   host all all 172.16.0.0/12 scram-sha-256   -- accepted
    --
    -- `inet_server_addr()` is the address this very session reached the server
    -- on, so it is the one address known to be routable and covered by a real
    -- pg_hba line, without the probe hardcoding anything about the deployment.
    v_conn := 'dbname=' || current_database()
      || ' host=' || host(inet_server_addr())
      || ' port=' || current_setting('port')
      || ' user=' || current_user
      || ' password=' || v_pass;
  else
    raise warning 'PROBE-SKIPPED: A-15 — % is not a superuser and no usable password/TCP address is available, so dblink cannot open the second session; run via docs/audit/run-probes.sh with PGHOST/PGPASSWORD set', current_user;
    return;
  end if;

  -- ASYNC on purpose. Two plain dblink() calls would run one after the other,
  -- each in its own committed transaction — that proves a hold is counted across
  -- transactions, which is worth knowing but is NOT the same as proving two
  -- OVERLAPPING transactions serialize. Sending both before collecting either
  -- puts them genuinely in flight together, which is the thing FOR UPDATE is
  -- there for.
  perform dblink_connect('a15_a', v_conn);
  perform dblink_connect('a15_b', v_conn);

  perform dblink_send_query('a15_a',
    format('select public.wallet_reserve_card_auth(%L,%L,800,%L,%L)::text',
           v_family, v_wallet, 'a15_race_a', 'Store A'));
  perform dblink_send_query('a15_b',
    format('select public.wallet_reserve_card_auth(%L,%L,800,%L,%L)::text',
           v_family, v_wallet, 'a15_race_b', 'Store B'));

  select v::boolean into approved_a from dblink_get_result('a15_a') as t(v text);
  select v::boolean into approved_b from dblink_get_result('a15_b') as t(v text);

  -- Drain the trailing empty result each async connection returns, then close.
  perform * from dblink_get_result('a15_a') as t(v text);
  perform * from dblink_get_result('a15_b') as t(v text);
  perform dblink_disconnect('a15_a');
  perform dblink_disconnect('a15_b');

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

  raise notice 'A-15 OK: 1 of 2 simultaneous $8 authorizations approved against $10; $8.00 held';
end $$;

-- Leave the anchor family exactly as it was found. Same rows, same order as the
-- seed above, so the pair reads as one unit.
delete from public.wallet_transactions where child_wallet_id = 'd0000000-0000-4000-8000-0000000000c9';
delete from public.wallet_buckets      where child_wallet_id = 'd0000000-0000-4000-8000-0000000000c9';
delete from public.child_wallets       where id              = 'd0000000-0000-4000-8000-0000000000c9';
delete from public.family_members      where id              = 'e0000000-0000-4000-8000-0000000000c9';

select 'A-15 wallet concurrency probe: ALL INVARIANTS PASSED' as result;
