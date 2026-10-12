-- A listing is acted on only by a family that can see it. (DB-RPC-M01, 0462)
--
-- A marketplace listing is visible to its own family and to the families in a
-- circle it is shared into. Before 0462 nothing that ACTS on a listing asked
-- that question: a family in no such circle, which cannot SELECT the listing,
-- could with nothing but its id
--
--   bid on it                      marketplace_place_bid          -> leading
--   open a negotiation             marketplace_negotiation_offer  -> ok
--   Buy-It-Now it                  marketplace_buy_now            -> claimed, order
--   file an offer                  insert marketplace_offers      -> the definer
--                                  trigger flipped it to 'pending'
--   and ask about / save / collect it (hygiene: nothing else acts on those)
--
-- Every path is exercised as the outsider and must be refused, with the listing
-- still 'available', no order and no negotiation left behind. The controls
-- prove each refusal is the visibility rule and not a broken feature: a family
-- IN the circle still bids, negotiates, asks, saves, collects and buys, and the
-- seller's own family still files the in-family offer that flips the listing.
--
-- 0483 changed two of the controls, on purpose: a circle member reads a shared
-- listing through public.marketplace_circle_listings (§8c replaced the whole-row
-- base-table policy with that view), and Buy-It-Now closes at the first bid
-- (§6), so the BIN control runs against a second shared auction nobody has bid
-- on while the bid-carrying one must be refused as bids_placed.
--
-- Rolled back: nothing here outlives the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  seller   uuid := '00000000-0000-4000-8000-0000000d6201';
  partner  uuid := '00000000-0000-4000-8000-0000000d6202';
  alice    uuid := '00000000-0000-4000-8000-0000000d6203';
  outsider uuid := '00000000-0000-4000-8000-0000000d6204';
  fam_s    uuid := '00000000-0000-4000-8000-0000000d6211';
  fam_a    uuid := '00000000-0000-4000-8000-0000000d6212';
  fam_x    uuid := '00000000-0000-4000-8000-0000000d6213';
  circle   uuid := '00000000-0000-4000-8000-0000000d6221';
  auction  uuid := '00000000-0000-4000-8000-0000000d6231';
  sale     uuid := '00000000-0000-4000-8000-0000000d6232';
  auction2 uuid := '00000000-0000-4000-8000-0000000d6233';
  coll_a   uuid := '00000000-0000-4000-8000-0000000d6241';
  coll_x   uuid := '00000000-0000-4000-8000-0000000d6242';
  mem_s    uuid;
  mem_p    uuid;
  mem_a    uuid;
  mem_x    uuid;
  res      jsonb;
  n        int;
  st       text;
  refused  boolean;
  failures int := 0;
begin
  -- ── structure: the rule exists, and is not an oracle for strangers ────────
  if not exists (
       select 1 from pg_proc p
        where p.oid = to_regprocedure('public.marketplace_listing_visible_to(uuid,uuid)')
          and p.prosecdef
          and exists (select 1 from unnest(p.proconfig) c where c ~ '^search_path=')) then
    raise warning 'MISSING: public.marketplace_listing_visible_to(uuid, uuid) is not a SECURITY DEFINER function with a pinned search_path';
    failures := failures + 1;
  elsif has_function_privilege('anon', 'public.marketplace_listing_visible_to(uuid,uuid)', 'execute') then
    raise warning 'BREACH: anon can execute marketplace_listing_visible_to';
    failures := failures + 1;
  end if;

  select string_agg(p.proname, ', ' order by p.proname) into st
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname = 'public'
   where p.proname in ('marketplace_place_bid', 'marketplace_buy_now', 'marketplace_negotiation_offer')
     and p.prosrc !~ 'marketplace_listing_visible_to\(';
  if st is not null then
    raise warning 'UNGUARDED: these act on a listing id without asking whether the family can see it: %', st;
    failures := failures + 1;
  end if;

  -- ── fixture: a seller family (two members), a circle member, an outsider ──
  insert into auth.users (id, email) values
    (seller, 'vis462-seller@example.test'), (partner, 'vis462-partner@example.test'),
    (alice, 'vis462-alice@example.test'), (outsider, 'vis462-outsider@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values
    (fam_s, 'Seller', seller), (fam_a, 'Alice', alice), (fam_x, 'Outsider', outsider)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam_s, seller, 'Seller', 'parent', true), (fam_s, partner, 'Partner', 'adult', true),
    (fam_a, alice, 'Alice', 'parent', true), (fam_x, outsider, 'Outsider', 'parent', true)
  on conflict (family_id, user_id) do update set is_active = true;
  select id into mem_s from public.family_members where family_id = fam_s and user_id = seller;
  select id into mem_p from public.family_members where family_id = fam_s and user_id = partner;
  select id into mem_a from public.family_members where family_id = fam_a and user_id = alice;
  select id into mem_x from public.family_members where family_id = fam_x and user_id = outsider;

  insert into public.marketplace_circles (id, name, join_code, created_by_family, created_by)
    values (circle, 'Maple Street', 'VIS462A1', fam_s, seller);
  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role) values
    (circle, fam_s, 'Seller', 'owner'), (circle, fam_a, 'Alice', 'member');
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status,
      sale_format, starting_bid_cents, buy_now_cents, auction_ends_at)
    values (auction, fam_s, mem_s, seller, 'Road bike', 'sell', 'available',
      'auction', 1000, 5000, now() + interval '1 day');
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status, price_cents)
    values (sale, fam_s, mem_s, seller, 'Stroller', 'sell', 'available', 8000);
  -- A second shared auction nobody bids on, for the Buy-It-Now control: 0483 §6
  -- closes Buy-It-Now at the first bid, and section 2 bids on `auction`.
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status,
      sale_format, starting_bid_cents, buy_now_cents, auction_ends_at)
    values (auction2, fam_s, mem_s, seller, 'Scooter', 'sell', 'available',
      'auction', 1000, 4000, now() + interval '1 day');
  insert into public.marketplace_listing_shares (listing_id, circle_id, family_id) values
    (auction, circle, fam_s), (sale, circle, fam_s), (auction2, circle, fam_s);
  insert into public.marketplace_collections (id, family_id, name) values
    (coll_a, fam_a, 'Wish list'), (coll_x, fam_x, 'Wish list');

  -- ── 1. the outsider: sees nothing, can do nothing ─────────────────────────
  perform set_config('request.jwt.claim.sub', outsider::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', outsider::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.marketplace_listings where id in (auction, sale);
  if n <> 0 then
    raise warning 'CONTROL FAILED: the outsider can see % of the two listings, so a refusal below would prove nothing', n;
    failures := failures + 1;
  end if;

  res := public.marketplace_place_bid(auction, mem_x, fam_x, 2000);
  if coalesce((res ->> 'ok')::boolean, false) then
    raise warning 'BREACH: a family that cannot see the auction placed a bid on it: %', res;
    failures := failures + 1;
  end if;

  res := public.marketplace_negotiation_offer(sale, mem_x, fam_x, 5000, 'is this still for sale?');
  if coalesce((res ->> 'ok')::boolean, false) then
    raise warning 'BREACH: a family that cannot see the listing opened a negotiation on it: %', res;
    failures := failures + 1;
  end if;

  res := public.marketplace_buy_now(auction, mem_x, fam_x);
  if coalesce((res ->> 'ok')::boolean, false) then
    raise warning 'BREACH: a family that cannot see the auction bought it outright: %', res;
    failures := failures + 1;
  end if;

  refused := false;
  begin
    insert into public.marketplace_offers (family_id, listing_id, member_id, kind, created_by)
      values (fam_x, sale, mem_x, 'interest', outsider);
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise warning 'BREACH: a family that cannot see the listing filed an offer on it';
    failures := failures + 1;
  end if;

  refused := false;
  begin
    insert into public.marketplace_questions (family_id, listing_id, asker_member, question, created_by)
      values (fam_x, sale, mem_x, 'Does it fold?', outsider);
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise warning 'BREACH: a family that cannot see the listing asked a question on it';
    failures := failures + 1;
  end if;

  refused := false;
  begin
    insert into public.marketplace_saves (family_id, listing_id, member_id) values (fam_x, sale, mem_x);
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise warning 'BREACH: a family that cannot see the listing saved it';
    failures := failures + 1;
  end if;

  refused := false;
  begin
    insert into public.marketplace_collection_items (family_id, collection_id, listing_id) values (fam_x, coll_x, sale);
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise warning 'BREACH: a family that cannot see the listing added it to a collection';
    failures := failures + 1;
  end if;

  reset role;
  select string_agg(format('%s is %s', title, status), ', ') into st
    from public.marketplace_listings where id in (auction, sale) and status <> 'available';
  if st is not null then
    raise warning 'BREACH: the outsider moved a listing it cannot see: %', st;
    failures := failures + 1;
  end if;
  select (select count(*) from public.marketplace_orders where listing_id in (auction, sale))
       + (select count(*) from public.marketplace_negotiations where listing_id in (auction, sale))
       + (select count(*) from public.marketplace_bids where listing_id in (auction, sale))
    into n;
  if n <> 0 then
    raise warning 'BREACH: the outsider left % order/negotiation/bid row(s) on listings it cannot see', n;
    failures := failures + 1;
  end if;

  -- ── 2. a family in the circle: everything still works ─────────────────────
  perform set_config('request.jwt.claim.sub', alice::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', alice::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 0483 §8c moved the cross-family read off the base table: a circle member
  -- reads a shared listing through public.marketplace_circle_listings (the
  -- shopper-facing columns), and the whole-row marketplace_listings_circle_read
  -- policy is gone. Both halves are the control: the view shows both listings,
  -- the base table shows neither.
  select count(*) into n from public.marketplace_circle_listings where id in (auction, sale);
  if n <> 2 then
    raise warning 'CONTROL FAILED: the circle member sees % of the two shared listings through marketplace_circle_listings', n;
    failures := failures + 1;
  end if;
  select count(*) into n from public.marketplace_listings where id in (auction, sale);
  if n <> 0 then
    raise warning 'REGRESSION: the circle member reads % whole listing row(s) from marketplace_listings — 0483 §8c replaced that read with the circle view', n;
    failures := failures + 1;
  end if;

  res := public.marketplace_place_bid(auction, mem_a, fam_a, 2000);
  if coalesce((res ->> 'ok')::boolean, false) is not true then
    raise warning 'REGRESSION: a circle member can no longer bid on a shared auction: %', res;
    failures := failures + 1;
  end if;

  res := public.marketplace_negotiation_offer(sale, mem_a, fam_a, 5000, 'would you take 50?');
  if coalesce((res ->> 'ok')::boolean, false) is not true then
    raise warning 'REGRESSION: a circle member can no longer make an offer on a shared listing: %', res;
    failures := failures + 1;
  end if;

  begin
    insert into public.marketplace_questions (family_id, listing_id, asker_member, question, created_by)
      values (fam_a, sale, mem_a, 'Does it fold?', alice);
    insert into public.marketplace_saves (family_id, listing_id, member_id) values (fam_a, sale, mem_a);
    insert into public.marketplace_collection_items (family_id, collection_id, listing_id) values (fam_a, coll_a, sale);
  exception when insufficient_privilege then
    raise warning 'REGRESSION: a circle member can no longer ask about, save or collect a shared listing (%)', sqlerrm;
    failures := failures + 1;
  end;

  -- An offer is the in-family flow: a circle member who can SEE the listing is
  -- still refused, because the seller's family could never read that offer and
  -- its only effect was flipping the listing to 'pending'.
  refused := false;
  begin
    insert into public.marketplace_offers (family_id, listing_id, member_id, kind, created_by)
      values (fam_a, sale, mem_a, 'interest', alice);
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise warning 'BREACH: a circle member filed an in-family offer on another family''s listing';
    failures := failures + 1;
  end if;
  reset role;
  select status into st from public.marketplace_listings where id = sale;
  if st <> 'available' then
    raise warning 'BREACH: another family''s offer moved the listing to %', st;
    failures := failures + 1;
  end if;

  -- ── 3. the seller's own family: the in-family offer still flips it ────────
  perform set_config('request.jwt.claim.sub', partner::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', partner::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.marketplace_offers (family_id, listing_id, member_id, kind, created_by)
      values (fam_s, sale, mem_p, 'interest', partner);
  exception when insufficient_privilege then
    raise warning 'REGRESSION: the seller''s own family can no longer file an offer on its listing (%)', sqlerrm;
    failures := failures + 1;
  end;
  reset role;
  select status into st from public.marketplace_listings where id = sale;
  if st <> 'pending' then
    raise warning 'REGRESSION: an in-family offer no longer marks the listing pending (it is %)', st;
    failures := failures + 1;
  end if;

  -- ── 4. Buy-It-Now: closed at the first bid, still open before one ─────────
  perform set_config('request.jwt.claim.sub', alice::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', alice::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  -- `auction` carries Alice's own bid from section 2. 0483 §6 refuses Buy-It-Now
  -- once any bid exists (buyNowClosedByBids in lib/marketplace/auction.ts),
  -- under the listing lock.
  res := public.marketplace_buy_now(auction, mem_a, fam_a);
  if coalesce((res ->> 'ok')::boolean, false) or res ->> 'detail' is distinct from 'bids_placed' then
    raise warning 'REGRESSION: Buy-It-Now on an auction that already carries a bid was not refused as bids_placed (0483 §6): %', res;
    failures := failures + 1;
  end if;
  -- A shared auction with no bids is still bought outright by a circle member.
  res := public.marketplace_buy_now(auction2, mem_a, fam_a);
  reset role;
  if coalesce((res ->> 'ok')::boolean, false) is not true then
    raise warning 'REGRESSION: a circle member can no longer Buy-It-Now a shared auction: %', res;
    failures := failures + 1;
  end if;

  if failures > 0 then
    raise exception 'a listing is acted on by a family that cannot see it: % finding(s)', failures;
  end if;
  raise notice 'OK: a family outside every circle a listing is shared with cannot bid, negotiate, buy, offer, ask, save or collect it, and the listing is untouched; a circle member still bids, negotiates, asks, saves, collects and buys, and the seller''s own family still files the offer that marks it pending.';
end
$probe$;

rollback;
