-- A parent can approve a child's investment order, not only refuse it.
--
-- `invest_decide_order` has two outcomes and only one of them worked. Measured
-- as a manager, against a funded wallet and a pending buy:
--
--   invest_decide_order(APPROVE) FAILS: column "direction" is of type
--                                wallet_txn_direction but expression is of
--                                type text (42804)
--   invest_decide_order(REJECT)  -> {"ok": true, "status": "rejected"}
--
-- The ledger insert on the approval path wrote `direction` from
-- `case when v_order.side = 'buy' then 'debit' else 'credit' end`. A bare
-- literal is `unknown` and coerces to the enum — which is why `'adjustment'`
-- and `'completed'` on the lines above it were fine — but a CASE over two
-- literals is `text`, and `text` does not implicitly cast to an enum. 0321
-- casts it.
--
-- The asymmetry is why nobody noticed: rejection returns before that INSERT, so
-- the feature looked alive while no order had ever been filled since 0196.
--
-- BOTH SIDES are exercised. `buy` takes the 'debit' branch and `sell` takes
-- 'credit' — a fix that cast only one of them would leave half the feature
-- broken and a buy-only probe would call it green.
--
-- The assertions are on the LEDGER AND THE HOLDING, not on the returned jsonb.
-- `{"ok": true, "status": "filled"}` is a claim; the debited balance and the
-- shares on the books are whether it happened.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-000000012001';
  pa_uid uuid := '00000000-0000-4000-8000-0000000120a1';
  ch_uid uuid := '00000000-0000-4000-8000-0000000120a2';
  ch_mid uuid;
  wal    uuid;
  buck   uuid;
  asset  uuid;
  ord    uuid;
  res    jsonb;
  sh     numeric;
  bal    bigint;
  failures int := 0;
begin
  -- Repeatable: this probe owns every row under `fam`.
  delete from public.invest_orders       where family_id = fam;
  delete from public.invest_holdings     where family_id = fam;
  delete from public.wallet_audit_logs   where family_id = fam;
  delete from public.wallet_transactions where family_id = fam;
  delete from public.wallet_buckets      where family_id = fam;
  delete from public.child_wallets       where family_id = fam;

  insert into auth.users (id, email) values
    (pa_uid, 'invest-parent@example.com'), (ch_uid, 'invest-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Invest', pa_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, pa_uid, 'Parent', 'parent', true),
    (fam, ch_uid, 'Child',  'child',  true)
  on conflict do nothing;
  select id into ch_mid from public.family_members where family_id = fam and user_id = ch_uid;

  insert into public.child_wallets (family_id, member_id) values (fam, ch_mid) returning id into wal;
  insert into public.wallet_buckets (family_id, child_wallet_id, label, kind)
    values (fam, wal, 'Invest', 'invest') returning id into buck;
  -- $1,000.00 of investable cash.
  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, created_by)
    values (fam, wal, buck, 'adjustment', 'completed', 'credit', 100000, 'probe seed', pa_uid);

  select id into asset from public.invest_assets where symbol = 'PROBE';
  if asset is null then
    insert into public.invest_assets (symbol, name, kind, emoji, price_cents, risk_level, is_active, sort_order)
      values ('PROBE', 'Probe Co', 'stock', '📈', 1000, 'low', true, 1) returning id into asset;
  end if;

  -- ── a member is not a decider (control) ──────────────────────────────────
  insert into public.invest_orders
    (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status, requested_by)
    values (fam, wal, asset, 'buy', 2, 1000, 2000, 'pending', ch_uid) returning id into ord;
  perform set_config('request.jwt.claim.sub', ch_uid::text, true);
  res := public.invest_decide_order(ord, true);
  if res->>'reason' is distinct from 'forbidden' then
    raise warning 'BREACH: a child decided their own investment order (%)', res;
    failures := failures + 1;
  end if;

  -- ── as the parent ────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', pa_uid::text, true);

  -- 1. A BUY fills: the 'debit' branch of the CASE.
  res := public.invest_decide_order(ord, true);
  if res->>'status' is distinct from 'filled' then
    raise warning 'BREACH: a parent could not approve a buy order (%)', res;
    failures := failures + 1;
  end if;

  select shares into sh from public.invest_holdings
   where family_id = fam and asset_id = asset;
  if coalesce(sh, 0) <> 2 then
    raise warning 'BREACH: the buy reported filled but the holding is % shares, expected 2', coalesce(sh, 0);
    failures := failures + 1;
  end if;

  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into bal from public.wallet_transactions
   where family_id = fam and bucket_id = buck and status in ('completed', 'processing');
  if bal <> 98000 then
    raise warning 'BREACH: the buy reported filled but the wallet holds % cents, expected 98000', bal;
    failures := failures + 1;
  end if;

  -- 2. Deciding it again is refused, or a parent could pay twice for one order.
  res := public.invest_decide_order(ord, true);
  if res->>'reason' is distinct from 'already_decided' then
    raise warning 'BREACH: a filled order was decided a second time (%)', res;
    failures := failures + 1;
  end if;

  -- 3. A SELL fills: the 'credit' branch, which a buy-only probe never reaches.
  insert into public.invest_orders
    (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status, requested_by)
    values (fam, wal, asset, 'sell', 1, 1000, 1000, 'pending', ch_uid) returning id into ord;
  res := public.invest_decide_order(ord, true);
  if res->>'status' is distinct from 'filled' then
    raise warning 'BREACH: a parent could not approve a sell order (%)', res;
    failures := failures + 1;
  end if;

  select shares into sh from public.invest_holdings where family_id = fam and asset_id = asset;
  if coalesce(sh, -1) <> 1 then
    raise warning 'BREACH: the sell reported filled but the holding is % shares, expected 1', coalesce(sh, -1);
    failures := failures + 1;
  end if;
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into bal from public.wallet_transactions
   where family_id = fam and bucket_id = buck and status in ('completed', 'processing');
  if bal <> 99000 then
    raise warning 'BREACH: the sell reported filled but the wallet holds % cents, expected 99000', bal;
    failures := failures + 1;
  end if;

  -- 4. Rejection still works — it is the half that always did, and a fix that
  --    broke it would trade one dead path for another.
  insert into public.invest_orders
    (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status, requested_by)
    values (fam, wal, asset, 'buy', 1, 1000, 1000, 'pending', ch_uid) returning id into ord;
  res := public.invest_decide_order(ord, false);
  if res->>'status' is distinct from 'rejected' then
    raise warning 'CONTROL FAILED: a parent could not reject an order (%)', res;
    failures := failures + 1;
  end if;

  -- 5. An order beyond the balance is refused rather than overdrawing.
  insert into public.invest_orders
    (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status, requested_by)
    values (fam, wal, asset, 'buy', 1000, 1000, 1000000, 'pending', ch_uid) returning id into ord;
  res := public.invest_decide_order(ord, true);
  if res->>'reason' is distinct from 'insufficient_cash' then
    raise warning 'BREACH: an order larger than the wallet was not refused (%)', res;
    failures := failures + 1;
  end if;
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into bal from public.wallet_transactions
   where family_id = fam and bucket_id = buck and status in ('completed', 'processing');
  if bal <> 99000 then
    raise warning 'BREACH: the refused order still moved the wallet: % cents', bal;
    failures := failures + 1;
  end if;

  if failures > 0 then
    raise exception 'invest-order-fill: % assertion(s) failed', failures;
  end if;
  raise notice 'invest-order-fill: OK — buy and sell both fill, the ledger and holding agree, and refusals move nothing';
end
$probe$;
