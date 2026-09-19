-- The fourth and fifth decision surfaces: economy redemptions and invest orders.
--
-- 0222 guarded chore submissions, 0223 chore assignments, 0295 reward
-- redemptions — and 0295 called itself "the last of the three decision
-- surfaces to be guarded". Two tables of the same shape were not guarded:
-- `status` defaulting to pending, a `decided_by`, and an INSERT policy open to
-- any family member with nothing constraining the state it may be created in.
--
-- So a child could insert a row already approved (or filled) with `decided_by`
-- naming a parent — and neither RPC can undo it, because each refuses a row it
-- does not find pending. 0304 is the guard; this is what measures it.
--
-- Judged on ROW COUNTS as well as refusals: an insert that is blocked by a
-- policy raises, but one blocked by nothing at all simply lands, and a probe
-- that only watched for exceptions would report a boundary that is not there.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000000ec01';
  parent_uid uuid := '00000000-0000-4000-8000-00000000eca1';
  child_uid  uuid := '00000000-0000-4000-8000-00000000eca2';
  child_mid uuid;
  currency uuid;
  sticker  uuid;   -- a real, priced reward (see the note at the request control)
  wallet uuid;
  asset uuid;
  queued uuid;
  n int;
  failures int := 0;
begin
  -- Repeatable across runs.
  delete from public.economy_redemptions where family_id = fam;
  delete from public.invest_orders where family_id = fam;

  insert into auth.users (id, email) values
    (parent_uid, 'econ-parent@example.com'), (child_uid, 'econ-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Economy Guard', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;
  select id into child_mid from public.family_members where family_id = fam and user_id = child_uid;

  select id into currency from public.family_currencies where family_id = fam limit 1;
  if currency is null then
    insert into public.family_currencies (family_id, name) values (fam, 'Stars') returning id into currency;
  end if;
  -- A catalogue reward for the request control below to name. It has to exist
  -- because a redemption is no longer allowed to invent its own price: 0320's
  -- `economy_redemption_request_guard` requires a member's request to name a
  -- real, active reward of this family and to carry that reward's own cost and
  -- currency. This probe's control previously inserted a free-form
  -- ('Sticker', cost 1) row with no `reward_id`, which is precisely the shape
  -- that guard refuses — a child naming their own price. The CONTROL is
  -- unchanged in intent (a child may still queue a redemption); it just asks
  -- for something off the shelf.
  insert into public.economy_rewards (family_id, currency_id, title, emoji, cost, is_active)
  values (fam, currency, 'Sticker', '⭐', 1, true)
  on conflict do nothing;
  select id into sticker from public.economy_rewards
   where family_id = fam and title = 'Sticker' limit 1;

  select id into wallet from public.child_wallets where family_id = fam limit 1;
  if wallet is null then
    insert into public.child_wallets (family_id, member_id) values (fam, child_mid) returning id into wallet;
  end if;
  select id into asset from public.invest_assets limit 1;
  if asset is null then
    insert into public.invest_assets (symbol, name, price_cents) values ('TSTX', 'Test Asset', 100) returning id into asset;
  end if;

  -- ── as the child ─────────────────────────────────────────────────────────
  -- `request.jwt.claim.sub` (singular) is what this harness resolves auth.uid()
  -- from, and it must be set BEFORE dropping to the authenticated role.
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- Controls first: a probe acting as a stranger measures nothing, because
  -- every write would be refused for the wrong reason.
  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;

  -- 1. A child may not create an already-approved redemption.
  begin
    insert into public.economy_redemptions
      (family_id, currency_id, member_id, title, cost, status, requested_by, decided_by, decided_at)
    values (fam, currency, child_mid, 'Console', 1, 'approved', child_uid, parent_uid, now());
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child inserted an APPROVED economy redemption (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 2. A child may not create an already-filled invest order.
  begin
    insert into public.invest_orders
      (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents,
       status, requested_by, decided_by, decided_at)
    values (fam, wallet, asset, 'buy', 1, 100, 100, 'filled', child_uid, parent_uid, now());
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child inserted a FILLED invest order (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. Asking is still allowed — the positive control. A guard that blocked
  --    this would have closed the feature rather than the hole.
  begin
    insert into public.economy_redemptions
      (family_id, currency_id, member_id, reward_id, title, cost, status, requested_by)
    values (fam, currency, child_mid, sticker, 'Sticker', 1, 'pending', child_uid)
    returning id into queued;
    if queued is null then
      raise warning 'CONTROL FAILED: a child could not REQUEST a redemption';
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a child could not REQUEST a redemption (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 4. Nor may they approve the one they queued.
  if queued is not null then
    begin
      update public.economy_redemptions
         set status = 'approved', decided_by = parent_uid, decided_at = now()
       where id = queued;
      get diagnostics n = row_count;
      if n > 0 then
        raise warning 'BREACH: a child approved their own queued redemption (rows: %)', n;
        failures := failures + 1;
      end if;
    exception when insufficient_privilege then null;
    end;

    -- 5. Not even to cancel. This differs from reward_redemptions, where 0295
    --    deliberately leaves 'cancelled' open to the member who asked: THIS
    --    table's UPDATE policy is manager-only (economy_redemptions_mng_update),
    --    so a child cannot change their own row at all. Asserted so the
    --    difference is recorded rather than rediscovered — an earlier draft of
    --    this probe assumed the reward-table behaviour and reported the
    --    product's actual design as a control failure.
    begin
      update public.economy_redemptions set status = 'cancelled' where id = queued;
      get diagnostics n = row_count;
      if n <> 0 then
        raise warning 'UNEXPECTED: a child updated their own economy redemption (rows: %)', n;
        failures := failures + 1;
      end if;
    exception when insufficient_privilege then null;
    end;
  end if;

  reset role;

  -- 6. A manager still decides, or the guard has broken the product.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  begin
    insert into public.economy_redemptions
      (family_id, currency_id, member_id, title, cost, status, requested_by, decided_by, decided_at)
    values (fam, currency, child_mid, 'Manager grant', 1, 'approved', parent_uid, parent_uid, now());
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not record an approved redemption (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not record an approved redemption (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'economy-invest-decision: % assertion(s) failed', failures;
  end if;
  raise notice 'economy-invest-decision: OK — a child may ask and withdraw, and may not decide';
end
$probe$;
