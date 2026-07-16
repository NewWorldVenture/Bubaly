-- ── A-08 Wallet money-safety probe (PAY-1 overspend prevention) ──────────────
-- Proves wallet_reserve_card_auth() cannot approve card authorizations beyond a
-- child's spendable balance, is idempotent per authorization id, and counts a
-- pending hold against the balance (so concurrent auths serialize under its
-- FOR UPDATE lock). Self-contained: funds a fresh $10 spend bucket for the
-- anchor family, runs a fixed auth sequence, and RAISE EXCEPTIONs on any breach.
--
--   bash docs/audit/verify-pg.sh up
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=familyos \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/wallet-overspend-check.sql

do $$
declare
  v_family  uuid := '00000000-0000-4000-8000-0000000000f1';
  v_member  uuid;
  v_wallet  uuid := 'd0000000-0000-4000-8000-0000000000a8';
  v_bucket  uuid;
  r boolean;
  holds int;
  spendable bigint;
begin
  -- Dedicated child member for the probe (child_wallets is unique per member).
  v_member := 'e0000000-0000-4000-8000-0000000000a8';

  -- Fresh, isolated test wallet (clean re-run each time).
  delete from public.wallet_transactions where child_wallet_id = v_wallet;
  delete from public.wallet_buckets where child_wallet_id = v_wallet;
  delete from public.child_wallets where id = v_wallet;
  delete from public.family_members where id = v_member;
  insert into public.family_members (id, family_id, display_name, role)
    values (v_member, v_family, 'Probe Child', 'child');
  insert into public.child_wallets (id, family_id, member_id) values (v_wallet, v_family, v_member);
  insert into public.wallet_buckets (family_id, child_wallet_id, kind, label)
    values (v_family, v_wallet, 'spend', 'Spend') returning id into v_bucket;
  insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
    values (v_family, v_wallet, v_bucket, 'allowance', 'completed', 'credit', 1000, 'seed $10');

  -- 1) $8 of $10 → approve
  r := public.wallet_reserve_card_auth(v_family, v_wallet, 800, 'a8_auth_1', 'Toy Store');
  if not r then raise exception 'A-08 FAIL: first $8 hold on $10 was declined'; end if;

  -- 2) another $8 → decline (only $2 left; the first hold counts against balance)
  r := public.wallet_reserve_card_auth(v_family, v_wallet, 800, 'a8_auth_2', 'Candy');
  if r then raise exception 'A-08 FAIL: overspend — second $8 approved with only $2 left'; end if;

  -- 3) replay auth_1 → approve, idempotent (must NOT place a second hold)
  r := public.wallet_reserve_card_auth(v_family, v_wallet, 800, 'a8_auth_1', 'Toy Store');
  if not r then raise exception 'A-08 FAIL: idempotent replay of a hold was declined'; end if;

  -- 4) exactly the remaining $2 → approve
  r := public.wallet_reserve_card_auth(v_family, v_wallet, 200, 'a8_auth_3', 'Gum');
  if not r then raise exception 'A-08 FAIL: exact-fit $2 hold was declined'; end if;

  -- 5) $1 more → decline (balance now $0)
  r := public.wallet_reserve_card_auth(v_family, v_wallet, 100, 'a8_auth_4', 'More');
  if r then raise exception 'A-08 FAIL: overspend — approved a hold against a $0 balance'; end if;

  select count(*) into holds from public.wallet_transactions
   where child_wallet_id = v_wallet and status = 'processing';
  if holds <> 2 then raise exception 'A-08 FAIL: expected 2 holds (auth_1 $8 + auth_3 $2), found %', holds; end if;

  select coalesce(sum(case when direction='credit' then amount_cents else -amount_cents end),0) into spendable
    from public.wallet_transactions where bucket_id = v_bucket and status in ('completed','processing');
  if spendable <> 0 then raise exception 'A-08 FAIL: spendable should be $0 after holds, was %', spendable; end if;

  -- tidy up so the probe leaves no residue
  delete from public.wallet_transactions where child_wallet_id = v_wallet;
  delete from public.wallet_buckets where child_wallet_id = v_wallet;
  delete from public.child_wallets where id = v_wallet;
  delete from public.family_members where id = v_member;

  raise notice 'A-08 OK: overspend prevented, holds counted, idempotent per auth id';
end $$;

select 'A-08 wallet overspend probe: ALL INVARIANTS PASSED' as result;
