-- Two numbers a child could write that a money path trusts.
--
-- 0254 and 0275 guard the money tables they enumerate. `allowance_rules` and
-- `invest_orders` are not on those lists, and both feed real credits:
--
--   allowance_rules.amount_cents  -> the nightly cron calls creditChildWallet
--                                    with it, on a schedule, with nobody in
--                                    the loop.
--   invest_orders.{shares,price_cents,amount_cents}
--                                 -> invest_decide_order debits the wallet with
--                                    the stored amount and credits the stored
--                                    shares, checking neither against the other
--                                    nor against the asset.
--
-- Judged on ROW COUNTS as well as refusals, and every refusal is paired with
-- the legitimate write it must NOT block — a guard that closed the feature
-- would pass a refusal-only probe just as happily.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000000ab11';
  parent_uid uuid := '00000000-0000-4000-8000-00000000abb1';
  child_uid  uuid := '00000000-0000-4000-8000-00000000abb2';
  child_mid uuid;
  wallet uuid;
  asset uuid;
  asset_price bigint;
  n int;
  failures int := 0;
begin
  delete from public.invest_orders where family_id = fam;
  delete from public.allowance_rules where family_id = fam;

  insert into auth.users (id, email) values
    (parent_uid, 'allow-parent@example.com'), (child_uid, 'allow-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Money Instructions', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;
  select id into child_mid from public.family_members where family_id = fam and user_id = child_uid;

  select id into wallet from public.child_wallets where family_id = fam limit 1;
  if wallet is null then
    insert into public.child_wallets (family_id, member_id) values (fam, child_mid) returning id into wallet;
  end if;
  select id, price_cents into asset, asset_price from public.invest_assets where price_cents is not null limit 1;
  if asset is null then
    insert into public.invest_assets (symbol, name, price_cents) values ('MIGX', 'Money Instr Asset', 250)
    returning id, price_cents into asset, asset_price;
  end if;

  -- ── as the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;

  -- 1. A child may not write themselves a standing payment instruction.
  begin
    insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on)
    values (fam, wallet, 100000, 'weekly', true, current_date);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child created their own allowance rule (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 2. Nor raise one a parent set up.
  begin
    update public.allowance_rules set amount_cents = 100000 where family_id = fam;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child raised an existing allowance rule (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. A child MAY place an investment order at the asset's own price — the
  --    positive control. The product's own action does exactly this, deriving
  --    both numbers server-side, and a guard that blocked it would have closed
  --    the feature rather than the hole.
  begin
    insert into public.invest_orders
      (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status, requested_by)
    values (fam, wallet, asset, 'buy', 2, asset_price, 2 * asset_price, 'pending', child_uid);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a child could not place an honest invest order (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a child could not place an honest invest order (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 4. But not at a price of their own choosing.
  begin
    insert into public.invest_orders
      (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status, requested_by)
    values (fam, wallet, asset, 'buy', 1000, 1, 1000, 'pending', child_uid);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child priced their own order below the asset (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when check_violation then null; when insufficient_privilege then null;
  end;

  -- 5. Nor with an amount that does not match the shares it buys.
  begin
    insert into public.invest_orders
      (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status, requested_by)
    values (fam, wallet, asset, 'buy', 1000, asset_price, 1, 'pending', child_uid);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child bought % shares for one cent (rows: %)', 1000, n;
      failures := failures + 1;
    end if;
  exception when check_violation then null; when insufficient_privilege then null;
  end;

  reset role;

  -- 6. A manager still sets an allowance, or the guard has closed the product.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  begin
    insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on)
    values (fam, wallet, 500, 'weekly', true, current_date);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not create an allowance rule (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not create an allowance rule (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'money-instruction-write: % assertion(s) failed', failures;
  end if;
  raise notice 'money-instruction-write: OK — a child may ask to invest at the real price, and may not pay themselves';
end
$probe$;
