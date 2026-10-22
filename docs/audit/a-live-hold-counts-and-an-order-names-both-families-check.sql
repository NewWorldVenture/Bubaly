-- a-live-hold-counts-and-an-order-names-both-families-check.sql
-- Probes for 0483_a_live_hold_counts_and_an_order_names_both_families (the
-- economy and marketplace halves of the 2026-10-10 family-economy audit).
--
-- Every case runs in its own subtransaction and is rolled back, so the cases
-- are independent and the run leaves nothing behind (the whole file is also
-- one rolled-back transaction). Each case is either
--
--   forbidden  PASS when the action is REFUSED
--   allowed    PASS when the action SUCCEEDS
--
-- On a database replayed through 0476 the forbidden cases FAIL (the breach was
-- live: 29 of 49); after 0483 every case PASSES. Calls that name objects 0483
-- adds go through EXECUTE, so the file runs on both. An object that does not exist
-- yet counts as "the path does not exist", which is a FAIL for an allowed case.
--
-- Ends with ERROR if any case failed, so psql -v ON_ERROR_STOP=1 exits 3.
\set ON_ERROR_STOP on
set client_min_messages = notice;

begin;

create temporary table probe_result (
  seq serial, id text, kind text, what text, acted boolean, pass boolean, detail text);

-- Act as a user. Called as postgres; leaves the role at `authenticated` (or
-- service_role) until the next reset role or subtransaction abort.
create function pg_temp.act(p_uid uuid, p_role text default 'authenticated') returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claim.role', p_role, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end $$;

create function pg_temp.rec(p_id text, p_kind text, p_what text, p_acted boolean, p_detail text) returns void
language plpgsql as $$
begin
  insert into probe_result (id, kind, what, acted, pass, detail)
  values (p_id, p_kind, p_what, coalesce(p_acted, false),
          case p_kind when 'forbidden' then not coalesce(p_acted, false) else coalesce(p_acted, false) end,
          left(coalesce(p_detail, ''), 220));
end $$;

do $probe$
declare
  -- users
  u_wp  uuid := '00000000-0000-4000-8000-0000000e0001';  -- wallet family parent
  u_wa  uuid := '00000000-0000-4000-8000-0000000e0002';  -- wallet child A
  u_wb  uuid := '00000000-0000-4000-8000-0000000e0003';  -- wallet child B
  u_sp  uuid := '00000000-0000-4000-8000-0000000e0011';  -- seller parent
  u_sc  uuid := '00000000-0000-4000-8000-0000000e0012';  -- seller-family child (has own listing)
  u_sk  uuid := '00000000-0000-4000-8000-0000000e0013';  -- seller-family sibling, NOT a party
  u_bp  uuid := '00000000-0000-4000-8000-0000000e0021';  -- buyer parent (other family)
  u_bc  uuid := '00000000-0000-4000-8000-0000000e0022';  -- buyer-family child
  u_op  uuid := '00000000-0000-4000-8000-0000000e0031';  -- third family parent (circle member)
  u_np  uuid := '00000000-0000-4000-8000-0000000e0041';  -- fourth family parent (not in circle)
  -- families
  f_w uuid := '00000000-0000-4000-8000-0000000e00f1';
  f_s uuid := '00000000-0000-4000-8000-0000000e00f2';
  f_b uuid := '00000000-0000-4000-8000-0000000e00f3';
  f_o uuid := '00000000-0000-4000-8000-0000000e00f4';
  f_n uuid := '00000000-0000-4000-8000-0000000e00f5';
  m_wp uuid; m_wa uuid; m_wb uuid; m_sp uuid; m_sc uuid; m_sk uuid;
  m_bp uuid; m_bc uuid; m_op uuid; m_np uuid;
  -- wallet
  cw_a uuid := '00000000-0000-4000-8000-0000000e0a01';
  cw_b uuid := '00000000-0000-4000-8000-0000000e0a02';
  bk_a uuid; bk_b uuid;
  tx8 uuid; tx2 uuid; ap8 uuid; ap2 uuid;
  asset uuid; asset_price bigint;
  -- marketplace
  circle  uuid := '00000000-0000-4000-8000-0000000e0c01';
  circle_code text := 'PRPECOAB';  -- no 0/1: join reads those as O/I (0314)
  l_won   uuid := '00000000-0000-4000-8000-0000000e0b01';  -- auction a cross-family parent wins
  l_lead  uuid := '00000000-0000-4000-8000-0000000e0b02';  -- leader raises own max
  l_res   uuid := '00000000-0000-4000-8000-0000000e0b03';  -- reserve covered by max
  l_res2  uuid := '00000000-0000-4000-8000-0000000e0b04';  -- reserve NOT covered
  l_bin   uuid := '00000000-0000-4000-8000-0000000e0b05';  -- BIN after a bid
  l_bin2  uuid := '00000000-0000-4000-8000-0000000e0b06';  -- BIN with no bids
  l_sale  uuid := '00000000-0000-4000-8000-0000000e0b07';  -- fixed-price sale (negotiation)
  l_kid   uuid := '00000000-0000-4000-8000-0000000e0b08';  -- the seller-family child's own listing
  order_won uuid;
  res jsonb;
  acted boolean;
  detail text;
  n int;
  n2 int;
  v bigint;
  v2 bigint;
  t text;
  code text;
begin
  -- ── fixture ───────────────────────────────────────────────────────────────
  insert into auth.users (id, email)
  select x, 'prop-eco-' || right(x::text, 4) || '@example.test'
    from unnest(array[u_wp, u_wa, u_wb, u_sp, u_sc, u_sk, u_bp, u_bc, u_op, u_np]) x
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values
    (f_w, 'Wallet House', u_wp), (f_s, 'Seller House', u_sp), (f_b, 'Buyer House', u_bp),
    (f_o, 'Third House', u_op), (f_n, 'Fourth House', u_np)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (f_w, u_wp, 'WParent', 'parent', true), (f_w, u_wa, 'Kid A', 'child', true), (f_w, u_wb, 'Kid B', 'child', true),
    (f_s, u_sp, 'SParent', 'parent', true), (f_s, u_sc, 'SChild', 'child', true), (f_s, u_sk, 'SSibling', 'teen', true),
    (f_b, u_bp, 'BParent', 'parent', true), (f_b, u_bc, 'BChild', 'child', true),
    (f_o, u_op, 'OParent', 'parent', true), (f_n, u_np, 'NParent', 'parent', true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;
  select id into m_wp from public.family_members where family_id = f_w and user_id = u_wp;
  select id into m_wa from public.family_members where family_id = f_w and user_id = u_wa;
  select id into m_wb from public.family_members where family_id = f_w and user_id = u_wb;
  select id into m_sp from public.family_members where family_id = f_s and user_id = u_sp;
  select id into m_sc from public.family_members where family_id = f_s and user_id = u_sc;
  select id into m_sk from public.family_members where family_id = f_s and user_id = u_sk;
  select id into m_bp from public.family_members where family_id = f_b and user_id = u_bp;
  select id into m_bc from public.family_members where family_id = f_b and user_id = u_bc;
  select id into m_op from public.family_members where family_id = f_o and user_id = u_op;
  select id into m_np from public.family_members where family_id = f_n and user_id = u_np;

  -- wallet: child A has $10 in Spend, an $8 live card hold, and two pending
  -- spend requests ($8 and $2) awaiting a parent.
  insert into public.child_wallets (id, family_id, member_id) values (cw_a, f_w, m_wa), (cw_b, f_w, m_wb);
  insert into public.wallet_buckets (family_id, child_wallet_id, kind, label) values
    (f_w, cw_a, 'spend', 'Spend'), (f_w, cw_a, 'save', 'Save'), (f_w, cw_a, 'give', 'Give'), (f_w, cw_a, 'invest', 'Invest'),
    (f_w, cw_b, 'spend', 'Spend'), (f_w, cw_b, 'save', 'Save'), (f_w, cw_b, 'give', 'Give'), (f_w, cw_b, 'invest', 'Invest');
  select id into bk_a from public.wallet_buckets where child_wallet_id = cw_a and kind = 'spend';
  select id into bk_b from public.wallet_buckets where child_wallet_id = cw_b and kind = 'spend';
  insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
    values (f_w, cw_a, bk_a, 'allowance', 'completed', 'credit', 1000, 'seed $10');
  insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, stripe_ref)
    values (f_w, cw_a, bk_a, 'card_spend', 'processing', 'debit', 800, 'card hold $8', 'iauth_prop_eco');
  insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
    values (f_w, cw_a, bk_a, 'card_spend', 'requires_parent_approval', 'debit', 800, 'ask $8') returning id into tx8;
  insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
    values (f_w, cw_a, bk_a, 'card_spend', 'requires_parent_approval', 'debit', 200, 'ask $2') returning id into tx2;
  insert into public.parent_approvals (family_id, kind, ref_type, ref_id, amount_cents, status, requested_by)
    values (f_w, 'card_spend', 'wallet_transactions', tx8, 800, 'pending', u_wa) returning id into ap8;
  insert into public.parent_approvals (family_id, kind, ref_type, ref_id, amount_cents, status, requested_by)
    values (f_w, 'card_spend', 'wallet_transactions', tx2, 200, 'pending', u_wa) returning id into ap2;
  select id, price_cents into asset, asset_price from public.invest_assets where is_active order by symbol limit 1;
  insert into public.gift_payments (family_id, child_wallet_id, giver_name, amount_cents, message, status)
    values (f_w, cw_a, 'A stranger', 2500, 'DM me at 555-0100', 'pending');

  -- marketplace: S owns a circle; B and O are members; N is outside it.
  insert into public.marketplace_circles (id, name, join_code, created_by_family, created_by)
    values (circle, 'Maple Street', circle_code, f_s, u_sp);
  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role) values
    (circle, f_s, 'Seller House', 'owner'), (circle, f_b, 'Buyer House', 'member'), (circle, f_o, 'Third House', 'member');
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status, location,
      sale_format, starting_bid_cents, reserve_cents, buy_now_cents, auction_ends_at) values
    (l_won,  f_s, m_sp, u_sp, 'Road bike',  'sell', 'available', 'Garage shelf', 'auction', 1000, null, null, now() + interval '1 day'),
    (l_lead, f_s, m_sp, u_sp, 'Kayak',      'sell', 'available', 'Garage shelf', 'auction', 1000, null, null, now() + interval '1 day'),
    (l_res,  f_s, m_sp, u_sp, 'Telescope',  'sell', 'available', 'Garage shelf', 'auction', 1000, 3000, null, now() + interval '1 day'),
    (l_res2, f_s, m_sp, u_sp, 'Drum kit',   'sell', 'available', 'Garage shelf', 'auction', 1000, 3000, null, now() + interval '1 day'),
    (l_bin,  f_s, m_sp, u_sp, 'Tent',       'sell', 'available', 'Garage shelf', 'auction', 1000, null, 5000, now() + interval '1 day'),
    (l_bin2, f_s, m_sp, u_sp, 'Canoe',      'sell', 'available', 'Garage shelf', 'auction', 1000, null, 5000, now() + interval '1 day');
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status, price_cents, location) values
    (l_sale, f_s, m_sp, u_sp, 'Stroller', 'sell', 'available', 8000, 'Garage shelf'),
    (l_kid,  f_s, m_sc, u_sc, 'Lego set', 'sell', 'available', 3000, 'My room');
  insert into public.marketplace_listing_shares (listing_id, circle_id, family_id)
  select x, circle, f_s from unnest(array[l_won, l_lead, l_res, l_res2, l_bin, l_bin2, l_sale]) x;

  -- The won auction: B's parent bids, the cron closes it, a confirmed hand-off
  -- with code ABC123 exists. Set up as each real actor would.
  perform pg_temp.act(u_bp);
  res := public.marketplace_place_bid(l_won, m_bp, f_b, 2000);
  reset role;
  if not coalesce((res->>'ok')::boolean, false) then
    raise exception 'FIXTURE: B''s parent could not bid on the won auction: %', res;
  end if;
  perform pg_temp.act(null, 'service_role');
  res := public.marketplace_close_auction(l_won, now() + interval '2 days');
  reset role;
  order_won := (res->>'order_id')::uuid;
  if order_won is null then raise exception 'FIXTURE: close did not create an order: %', res; end if;
  insert into public.marketplace_handoffs (order_id, family_id, listing_id, proposed_by, proposer_role,
      location_label, status, confirm_code, confirmed_at)
    values (order_won, f_s, l_won, m_sp, 'seller', 'Library', 'confirmed', 'ABC123', now());

  -- ══ 1. Spend bucket and card holds ═══════════════════════════════════════
  perform pg_temp.act(u_wp);
  begin
    res := public.wallet_decide_spend(f_w, ap8, 'approved', null, u_wp);
    acted := coalesce((res->>'ok')::boolean, false); detail := res::text;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('W1', 'forbidden', '$10 bucket, $8 hold: parent approves an $8 spend', acted, detail);

  perform pg_temp.act(u_wp);
  begin
    res := public.wallet_decide_spend(f_w, ap2, 'approved', null, u_wp);
    acted := coalesce((res->>'ok')::boolean, false); detail := res::text;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('W2', 'allowed', '$10 bucket, $8 hold: parent approves a $2 spend', acted, detail);

  perform pg_temp.act(u_wp);
  begin
    res := public.wallet_transfer(f_w, cw_a, cw_b, 800, 'to sibling', u_wp);
    acted := coalesce((res->>'ok')::boolean, false); detail := res::text;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('W3', 'forbidden', '$10 bucket, $8 hold: parent transfers $8 to a sibling', acted, detail);

  perform pg_temp.act(u_wp);
  begin
    res := public.wallet_transfer(f_w, cw_a, cw_b, 200, 'to sibling', u_wp);
    acted := coalesce((res->>'ok')::boolean, false); detail := res::text;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('W4', 'allowed', '$10 bucket, $8 hold: parent transfers $2 to a sibling', acted, detail);

  -- ══ 2. The cross-family winner's order ═══════════════════════════════════
  perform pg_temp.act(u_bp);
  begin
    select count(*) into n from public.marketplace_orders where id = order_won;
    acted := n = 1; detail := format('winner sees %s of 1 order rows', n);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('O1', 'allowed', 'winner from another family reads their order', acted, detail);

  begin
    execute 'select buyer_family_id from public.marketplace_orders where id = $1' into t using order_won;
    acted := t = f_b::text; detail := 'buyer_family_id = ' || coalesce(t, 'null');
  exception when others then acted := false; detail := sqlerrm; end;
  perform pg_temp.rec('O2', 'allowed', 'the auction order records the winner''s family', acted, detail);

  perform pg_temp.act(u_bp);
  begin
    update public.marketplace_handoffs set status = 'proposed', confirm_code = null, location_label = 'Park'
     where order_id = order_won;
    get diagnostics n = row_count;
    insert into public.marketplace_handoffs (order_id, family_id, listing_id, proposed_by, proposer_role, location_label, status)
      values (order_won, f_s, l_won, m_bp, 'buyer', 'Park', 'proposed')
      on conflict (order_id) do update set location_label = excluded.location_label, proposer_role = 'buyer', status = 'proposed';
    acted := true; detail := 'winner proposed the pickup';
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('O3', 'allowed', 'winner from another family proposes the pickup', acted, detail);

  perform pg_temp.act(u_bp);
  begin
    res := public.marketplace_complete_handoff(order_won, 'ABC123');
    acted := coalesce((res->>'ok')::boolean, false); detail := res::text;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('O4', 'allowed', 'winner from another family completes the hand-off', acted, detail);

  perform pg_temp.act(u_sp);
  begin
    select count(*) into n from public.marketplace_orders where id = order_won;
    select count(*) into n2 from public.marketplace_handoffs where order_id = order_won;
    acted := n = 1 and n2 = 1; detail := format('seller sees order %s, handoff %s', n, n2);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('O5', 'allowed', 'seller (party) still reads the order and hand-off', acted, detail);

  -- ══ 3. A non-party sibling and the hand-off ══════════════════════════════
  perform pg_temp.act(u_sk);
  begin
    select confirm_code into t from public.marketplace_handoffs where order_id = order_won;
    acted := t is not null; detail := 'sibling read confirm_code: ' || coalesce(t, '(nothing)');
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('H1', 'forbidden', 'non-party sibling reads the hand-off code', acted, detail);

  perform pg_temp.act(u_sk);
  begin
    res := public.marketplace_complete_handoff(order_won, 'ABC123');
    acted := coalesce((res->>'ok')::boolean, false); detail := res::text;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('H2', 'forbidden', 'non-party sibling completes the hand-off', acted, detail);

  perform pg_temp.act(u_sk);
  begin
    select count(*) into n from public.marketplace_orders where id = order_won;
    acted := n = 1; detail := format('seller-family sibling sees %s order rows', n);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('H3', 'allowed', 'seller''s family keeps read access to the order', acted, detail);

  -- ══ 4. invest_orders ══════════════════════════════════════════════════════
  perform pg_temp.act(u_wa);
  begin
    insert into public.invest_orders (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, requested_by)
      values (f_w, cw_b, asset, 'sell', 1, asset_price, asset_price, u_wa);
    acted := true; detail := 'child queued a sell on the sibling''s wallet';
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('I1', 'forbidden', 'child places an invest order on a sibling''s wallet', acted, detail);

  perform pg_temp.act(u_wa);
  begin
    insert into public.invest_orders (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, requested_by)
      values (f_w, cw_a, asset, 'buy', 1, asset_price, asset_price, u_wa);
    acted := true; detail := 'child queued a buy on their own wallet';
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('I2', 'allowed', 'child places an invest order on their own wallet', acted, detail);

  perform pg_temp.act(u_wp);
  begin
    insert into public.invest_orders (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, requested_by)
      values (f_w, cw_b, asset, 'buy', 1, asset_price, asset_price, u_wp);
    acted := true; detail := 'parent queued a buy on a child''s wallet';
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('I3', 'allowed', 'parent places an invest order on any child''s wallet', acted, detail);

  perform pg_temp.act(u_sp);
  begin
    insert into public.invest_orders (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, requested_by)
      values (f_s, cw_a, asset, 'buy', 1, asset_price, asset_price, u_sp);
    acted := true; detail := 'another family''s parent filed an order against this wallet';
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('I4', 'forbidden', 'a parent files an invest order under their family on ANOTHER family''s wallet', acted, detail);

  -- ══ 5. Proxy bidding ═════════════════════════════════════════════════════
  perform pg_temp.act(u_bp);
  begin
    res := public.marketplace_place_bid(l_lead, m_bp, f_b, 5000);
    reset role;  -- read the listing as the owner: the bidder's own view of it is not the point
    select current_bid_cents into v from public.marketplace_listings where id = l_lead;
    perform pg_temp.act(u_bp);
    res := public.marketplace_place_bid(l_lead, m_bp, f_b, 8000);
    reset role;
    select current_bid_cents, bid_count into v2, n from public.marketplace_listings where id = l_lead;
    if v is null or v2 is null then raise exception 'B1 could not read the listing'; end if;
    acted := v2 > v or n <> 1; detail := format('visible %s -> %s after the leader raised its own max; bid_count %s; %s', v, v2, n, res);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('B1', 'forbidden', 'leader raising its own max pushes the visible price up', acted, detail);

  perform pg_temp.act(u_bp);
  begin
    res := public.marketplace_place_bid(l_lead, m_bp, f_b, 5000);
    res := public.marketplace_place_bid(l_lead, m_bp, f_b, 8000);
    reset role;
    select highest_max_cents into v from public.marketplace_listings where id = l_lead;
    select count(*) into n from public.marketplace_bids where listing_id = l_lead and status = 'active' and max_cents = 8000;
    perform pg_temp.act(u_op);
    res := public.marketplace_place_bid(l_lead, m_op, f_o, 6000);
    reset role;
    select current_bid_cents, highest_bidder_family_id::text into v2, t from public.marketplace_listings where id = l_lead;
    acted := v = 8000 and n = 1 and t = f_b::text and v2 between 6000 and 8000;
    detail := format('hidden max %s, active bid at 8000: %s; after a 6000 challenger: leader %s at %s', v, n,
                     case when t = f_b::text then 'B' else coalesce(t, '?') end, v2);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('B2', 'allowed', 'leader''s raised max is kept and still defends the lead', acted, detail);

  perform pg_temp.act(u_bp);
  begin
    res := public.marketplace_place_bid(l_res, m_bp, f_b, 5000);
    reset role;
    select current_bid_cents into v from public.marketplace_listings where id = l_res;
    perform pg_temp.act(null, 'service_role');
    res := public.marketplace_close_auction(l_res, now() + interval '2 days');
    reset role;
    select amount_cents into v2 from public.marketplace_orders where listing_id = l_res;
    acted := v = 3000 and coalesce((res->>'sold')::boolean, false) and v2 = 3000;
    detail := format('reserve 3000, lone max 5000: visible %s; close sold=%s at %s', v, res->>'sold', coalesce(v2::text, 'no order'));
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('R1', 'allowed', 'max covers the reserve: price shows the reserve; sells at the reserve', acted, detail);

  -- (close on its own, with a bid that predates the raise-to-reserve rule)
  begin
    perform pg_temp.act(u_bp);
    res := public.marketplace_place_bid(l_res, m_bp, f_b, 5000);
    reset role;
    update public.marketplace_listings set current_bid_cents = 1000 where id = l_res;  -- as 0476 left it
    perform pg_temp.act(null, 'service_role');
    res := public.marketplace_close_auction(l_res, now() + interval '2 days');
    reset role;
    select amount_cents into v2 from public.marketplace_orders where listing_id = l_res;
    acted := coalesce((res->>'sold')::boolean, false) and v2 = 3000;
    detail := format('legacy visible 1000 < reserve 3000 <= max 5000: sold=%s at %s', res->>'sold', coalesce(v2::text, 'no order'));
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('R2', 'allowed', 'close decides on the max and settles at greatest(price, reserve)', acted, detail);

  begin
    perform pg_temp.act(u_bp);
    res := public.marketplace_place_bid(l_res2, m_bp, f_b, 2000);
    reset role;
    select current_bid_cents into v from public.marketplace_listings where id = l_res2;
    perform pg_temp.act(null, 'service_role');
    res := public.marketplace_close_auction(l_res2, now() + interval '2 days');
    reset role;
    acted := coalesce((res->>'sold')::boolean, false);
    detail := format('reserve 3000, max 2000: visible %s; close sold=%s', v, res->>'sold');
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('R3', 'forbidden', 'max below the reserve: the auction sells anyway', acted, detail);

  begin
    perform pg_temp.act(u_bp);
    res := public.marketplace_place_bid(l_res2, m_bp, f_b, 2000);
    res := public.marketplace_place_bid(l_res2, m_bp, f_b, 4000);
    reset role;
    select current_bid_cents into v from public.marketplace_listings where id = l_res2;
    acted := v = 3000;
    detail := format('leader raised max 2000 -> 4000 past reserve 3000: visible %s', v);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('R4', 'allowed', 'leader''s raise that newly covers the reserve shows the reserve', acted, detail);

  -- ══ 6. Buy-It-Now after bids ═════════════════════════════════════════════
  begin
    perform pg_temp.act(u_bp);
    res := public.marketplace_place_bid(l_bin, m_bp, f_b, 2000);
    reset role;
    perform pg_temp.act(u_op);
    res := public.marketplace_buy_now(l_bin, m_op, f_o);
    acted := coalesce((res->>'ok')::boolean, false); detail := res::text;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('N1', 'forbidden', 'Buy-It-Now once a bid stands', acted, detail);

  begin
    perform pg_temp.act(u_op);
    res := public.marketplace_buy_now(l_bin2, m_op, f_o);
    acted := coalesce((res->>'ok')::boolean, false);
    select count(*) into n from public.marketplace_orders where listing_id = l_bin2;
    acted := acted and n = 1;
    detail := format('%s; buyer reads %s order rows', res, n);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('N2', 'allowed', 'Buy-It-Now with no bids, and the buyer reads the order', acted, detail);

  -- ══ 7. Role gates ════════════════════════════════════════════════════════
  perform pg_temp.act(u_bc);
  begin
    res := public.marketplace_place_bid(l_bin2, m_bc, f_b, 2000);
    acted := coalesce((res->>'ok')::boolean, false); detail := res::text;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('G1', 'forbidden', 'a child bids on another family''s auction', acted, detail);

  perform pg_temp.act(u_bc);
  begin
    res := public.marketplace_buy_now(l_bin2, m_bc, f_b);
    acted := coalesce((res->>'ok')::boolean, false); detail := res::text;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('G2', 'forbidden', 'a child uses Buy-It-Now', acted, detail);

  perform pg_temp.act(u_bc);
  begin
    res := public.marketplace_negotiation_offer(l_sale, m_bc, f_b, 5000, null);
    acted := coalesce((res->>'ok')::boolean, false); detail := res::text;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('G3', 'forbidden', 'a child makes an offer to another family', acted, detail);

  begin
    perform pg_temp.act(u_bp);
    res := public.marketplace_negotiation_offer(l_sale, m_bp, f_b, 5000, null);
    reset role;
    perform pg_temp.act(u_sp);
    res := public.marketplace_negotiation_respond((res->>'negotiation_id')::uuid, 'accept', null, null);
    reset role;
    perform pg_temp.act(u_bp);
    select count(*) into n from public.marketplace_orders where listing_id = l_sale;
    acted := coalesce((res->>'ok')::boolean, false) and n = 1;
    detail := format('%s; buyer reads %s order rows', res, n);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('G4', 'allowed', 'parents negotiate across families; the buyer reads the agreed order', acted, detail);

  begin
    perform pg_temp.act(u_bp);
    res := public.marketplace_place_bid(l_bin2, m_bp, f_b, 2000);
    acted := coalesce((res->>'ok')::boolean, false); detail := res::text;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('G5', 'allowed', 'a parent bids', acted, detail);

  perform pg_temp.act(u_bc);
  begin
    -- B is already a member, so a permitted call is a no-op; the question is
    -- only whether the child is let through.
    perform public.marketplace_join_circle(f_b, circle_code);
    acted := true; detail := 'child ran join for the family';
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('G6', 'forbidden', 'a child joins the family to a circle', acted, detail);

  perform pg_temp.act(u_sc);
  begin
    perform public.marketplace_create_circle(f_s, 'Kid circle', null);
    acted := true; detail := 'child created a circle';
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('G7', 'forbidden', 'a child creates a circle', acted, detail);

  perform pg_temp.act(u_sc);
  begin
    insert into public.marketplace_listing_shares (listing_id, circle_id, family_id) values (l_kid, circle, f_s);
    acted := true; detail := 'child shared their listing into the circle';
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('G8', 'forbidden', 'a child shares a listing into a circle', acted, detail);

  update public.marketplace_listings set member_id = m_sp, created_by = u_sp where id = l_kid;
  perform pg_temp.act(u_sp);
  begin
    insert into public.marketplace_listing_shares (listing_id, circle_id, family_id) values (l_kid, circle, f_s);
    acted := true; detail := 'parent shared a listing';
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('G9', 'allowed', 'a parent shares a listing into a circle', acted, detail);

  begin
    perform pg_temp.act(u_np);
    perform public.marketplace_join_circle(f_n, circle_code);
    reset role;
    select count(*) into n from public.marketplace_circle_members where circle_id = circle and family_id = f_n;
    acted := n = 1; detail := format('parent joined: %s membership row', n);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('G10', 'allowed', 'a parent joins a circle with its code', acted, detail);

  -- ══ 8. Circles: remove, block, rotate, and what members see ══════════════
  begin
    perform pg_temp.act(u_sp);
    execute 'select public.marketplace_remove_circle_member($1, $2, $3, true)' into res using f_s, circle, f_b;
    reset role;
    perform pg_temp.act(u_bp);
    acted := coalesce((res->>'ok')::boolean, false)
             and not public.marketplace_listing_visible_to(l_sale, f_b);
    detail := format('%s; B can still see the listing: %s', res, public.marketplace_listing_visible_to(l_sale, f_b));
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('C1', 'allowed', 'circle owner''s parent removes a member family; it loses sight of listings', acted, detail);

  begin
    perform pg_temp.act(u_sp);
    execute 'select public.marketplace_remove_circle_member($1, $2, $3, true)' into res using f_s, circle, f_b;
    reset role;
    perform pg_temp.act(u_bp);
    perform public.marketplace_join_circle(f_b, circle_code);
    reset role;
    select count(*) into n from public.marketplace_circle_members where circle_id = circle and family_id = f_b;
    acted := n = 1; detail := format('after removal B rejoined: %s membership rows', n);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('C2', 'forbidden', 'a removed (blocked) family rejoins with the old code', acted, detail);

  -- (before the proposal there is no removal path at all; a member family can
  --  only leave of its own accord. C1 records that as a FAIL.)
  perform pg_temp.act(u_op);
  begin
    execute 'select public.marketplace_remove_circle_member($1, $2, $3, true)' into res using f_o, circle, f_b;
    acted := coalesce((res->>'ok')::boolean, false); detail := res::text;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('C3', 'forbidden', 'a non-owner member family removes another family', acted, detail);

  perform pg_temp.act(u_sc);
  begin
    execute 'select public.marketplace_remove_circle_member($1, $2, $3, true)' into res using f_s, circle, f_b;
    acted := coalesce((res->>'ok')::boolean, false); detail := res::text;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('C4', 'forbidden', 'a child of the owner family removes a family', acted, detail);

  begin
    perform pg_temp.act(u_sp);
    execute 'select public.marketplace_rotate_circle_code($1, $2)' into code using f_s, circle;
    reset role;
    perform pg_temp.act(u_np);
    begin
      perform public.marketplace_join_circle(f_n, circle_code);
      n := 1;
    exception when others then n := 0; end;
    perform public.marketplace_join_circle(f_n, code);
    reset role;
    select count(*) into n2 from public.marketplace_circle_members where circle_id = circle and family_id = f_n;
    acted := code is not null and code <> circle_code and n = 0 and n2 = 1;
    detail := format('new code %s; old code still joins: %s; new code joins: %s', coalesce(code, 'none'), n = 1, n2 = 1);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('C5', 'allowed', 'owner rotates the code: the old one stops working, the new one works', acted, detail);

  perform pg_temp.act(u_op);
  begin
    execute 'select public.marketplace_rotate_circle_code($1, $2)' into code using f_o, circle;
    acted := code is not null; detail := 'non-owner rotated to ' || coalesce(code, 'null');
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('C6', 'forbidden', 'a non-owner rotates the circle code', acted, detail);

  perform pg_temp.act(u_bp);
  begin
    select location, member_id::text into t, detail from public.marketplace_listings where id = l_sale;
    acted := t is not null; detail := format('circle member read location=%s member_id=%s', coalesce(t, '-'), coalesce(detail, '-'));
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('C7', 'forbidden', 'a circle member reads a shared listing''s location and member id', acted, detail);

  perform pg_temp.act(u_bp);
  begin
    execute 'select count(*) from public.marketplace_circle_listings where id = $1 and title = ''Stroller''' into n using l_sale;
    acted := n = 1; detail := format('circle feed view returns %s row(s)', n);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('C8', 'allowed', 'a circle member reads the shared listing''s feed columns', acted, detail);

  perform pg_temp.act(u_np);
  begin
    select count(*) into n2 from public.marketplace_listings where id = l_sale;
    begin
      execute 'select count(*) from public.marketplace_circle_listings where id = $1' into n using l_sale;
    exception when undefined_table then n := 0; end;
    acted := n + n2 > 0; detail := format('outsider sees feed %s, base %s', n, n2);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := 'outsider: ' || sqlerrm; end;
  reset role;
  perform pg_temp.rec('C9', 'forbidden', 'a family outside the circle reads the shared listing', acted, detail);

  perform pg_temp.act(u_sk);
  begin
    select count(*), max(location) into n, t from public.marketplace_listings where id = l_sale;
    acted := n = 1 and t is not null; detail := format('own family reads its listing incl. location: %s', t);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('C10', 'allowed', 'the listing''s own family still reads the whole row', acted, detail);

  -- ══ 9. gift_payments ══════════════════════════════════════════════════════
  perform pg_temp.act(u_wa);
  begin
    select message into t from public.gift_payments where family_id = f_w limit 1;
    acted := t is not null; detail := 'child read: ' || coalesce(t, '(nothing)');
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('F1', 'forbidden', 'a child reads a pending gift''s stranger message', acted, detail);

  perform pg_temp.act(u_wp);
  begin
    select message into t from public.gift_payments where family_id = f_w limit 1;
    acted := t is not null; detail := 'parent read: ' || coalesce(t, '(nothing)');
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('F2', 'allowed', 'a parent reads the pending gift', acted, detail);

  begin
    update public.gift_payments set status = 'completed' where family_id = f_w;
    perform pg_temp.act(u_wa);
    select count(*) into n from public.gift_payments where family_id = f_w and child_wallet_id = cw_a;
    acted := n = 1; detail := format('child sees %s applied gift(s) on their own wallet', n);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('F3', 'allowed', 'a child reads a gift a parent applied to their own wallet', acted, detail);

  begin
    update public.gift_payments set status = 'completed' where family_id = f_w;
    perform pg_temp.act(u_wb);
    select count(*) into n from public.gift_payments where family_id = f_w and child_wallet_id = cw_a;
    acted := n > 0; detail := format('sibling sees %s of the other child''s gifts', n);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('F4', 'forbidden', 'a sibling reads another child''s applied gift', acted, detail);

  -- ══ service_role still works ═════════════════════════════════════════════
  perform pg_temp.act(null, 'service_role');
  begin
    select count(*) into n from public.marketplace_orders where id = order_won;
    select count(*) into n2 from public.marketplace_handoffs where order_id = order_won;
    acted := n = 1 and n2 = 1;
    select count(*) into n from public.gift_payments where family_id = f_w;
    acted := acted and n = 1;
    insert into public.invest_orders (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents)
      values (f_w, cw_b, asset, 'buy', 1, asset_price, asset_price);
    res := public.marketplace_close_auction(l_lead, now() + interval '2 days');
    acted := acted and coalesce((res->>'ok')::boolean, false);
    detail := format('orders/handoffs/gifts read, invest insert, close: %s', res);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null; when others then acted := false; detail := sqlerrm; end;
  reset role;
  perform pg_temp.rec('S1', 'allowed', 'service_role reads orders, hand-offs, gifts, writes invest orders, closes auctions', acted, detail);
end
$probe$;

-- ABSENT: a forbidden case whose path does not exist yet on this database (it
-- cannot be exercised, so it is not counted either way).
select id, kind,
       case when kind = 'forbidden' and detail ~ 'does not exist' then 'ABSENT'
            when pass then 'PASS' else 'FAIL' end as verdict,
       case when acted then 'acted' else 'refused' end as outcome, what, detail
  from probe_result order by seq;

do $$
declare n int; f text;
begin
  select count(*) filter (where not pass), string_agg(id, ' ' order by seq) filter (where not pass)
    into n, f from probe_result
   where not (kind = 'forbidden' and detail ~ 'does not exist');
  if n > 0 then
    raise exception '0483 FAILED (economy): % case(s) failed: %', n, f;
  end if;
  raise notice '0483 OK (economy): all % cases PASSED', (select count(*) from probe_result);
end $$;

rollback;
