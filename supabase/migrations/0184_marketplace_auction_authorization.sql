-- Bubaly :: 0184 - auction authorization and atomic Buy-It-Now
--
-- Migration 0183 exposed two unsafe paths: authenticated clients could insert
-- directly into marketplace_bids, and Buy-It-Now claimed a listing before its
-- order insert completed. Keep the original bid algorithm private behind an
-- auth-checked wrapper and move Buy-It-Now into one locked transaction.

-- The client must use the authorization wrapper below; service-role seed and
-- maintenance work may still call the original implementation internally.
drop policy if exists marketplace_bids_insert on public.marketplace_bids;
revoke insert on public.marketplace_bids from anon, authenticated;

do $$
begin
  if to_regprocedure('public.marketplace_place_bid(uuid,uuid,uuid,bigint)') is not null
    and to_regprocedure('public.marketplace_place_bid_unchecked(uuid,uuid,uuid,bigint)') is null then
    execute 'alter function public.marketplace_place_bid(uuid, uuid, uuid, bigint) rename to marketplace_place_bid_unchecked';
  end if;
end $$;
revoke all on function public.marketplace_place_bid_unchecked(uuid, uuid, uuid, bigint) from public;
grant execute on function public.marketplace_place_bid_unchecked(uuid, uuid, uuid, bigint) to service_role;

create or replace function public.marketplace_place_bid(
  p_listing_id uuid,
  p_bidder_member_id uuid,
  p_bidder_family_id uuid,
  p_max_cents bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_family uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;

  select family_id into v_member_family
  from public.family_members
  where id = p_bidder_member_id and user_id = auth.uid() and is_active;

  if v_member_family is null or v_member_family is distinct from p_bidder_family_id then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;
  if p_max_cents is null or p_max_cents <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  return public.marketplace_place_bid_unchecked(
    p_listing_id, p_bidder_member_id, p_bidder_family_id, p_max_cents
  );
end $$;

revoke all on function public.marketplace_place_bid(uuid, uuid, uuid, bigint) from public;
grant execute on function public.marketplace_place_bid(uuid, uuid, uuid, bigint) to authenticated, service_role;

create or replace function public.marketplace_buy_now(
  p_listing_id uuid,
  p_buyer_member_id uuid,
  p_buyer_family_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing record;
  v_member_family uuid;
  v_order_id uuid;
  v_now timestamptz := now();
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;

  select family_id into v_member_family
  from public.family_members
  where id = p_buyer_member_id and user_id = auth.uid() and is_active;
  if v_member_family is null or v_member_family is distinct from p_buyer_family_id then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;

  select id, family_id, member_id, buy_now_cents, status, sale_format,
         auction_starts_at, auction_ends_at
  into v_listing
  from public.marketplace_listings
  where id = p_listing_id
  for update;

  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_listing.sale_format <> 'auction' or v_listing.buy_now_cents is null
    or v_listing.buy_now_cents <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_available');
  end if;
  if v_listing.status <> 'available' then
    return jsonb_build_object('ok', false, 'reason', 'not_available');
  end if;
  if v_listing.family_id = p_buyer_family_id then
    return jsonb_build_object('ok', false, 'reason', 'own_listing');
  end if;
  if v_listing.auction_ends_at is null or v_now >= v_listing.auction_ends_at then
    return jsonb_build_object('ok', false, 'reason', 'ended');
  end if;
  if v_listing.auction_starts_at is not null and v_now < v_listing.auction_starts_at then
    return jsonb_build_object('ok', false, 'reason', 'not_started');
  end if;

  update public.marketplace_listings
  set status = 'claimed', claimed_by = p_buyer_member_id,
      claimed_at = v_now, auction_closed_at = v_now, updated_at = v_now
  where id = p_listing_id and status = 'available';

  update public.marketplace_bids
  set status = 'lost'
  where listing_id = p_listing_id and status in ('active', 'outbid');

  insert into public.marketplace_orders
    (family_id, listing_id, buyer_member, seller_member, kind, status,
     amount_cents, notes, created_by)
  values
    (v_listing.family_id, v_listing.id, p_buyer_member_id, v_listing.member_id,
     'buy', 'confirmed', v_listing.buy_now_cents, 'Buy-It-Now', auth.uid())
  returning id into v_order_id;

  return jsonb_build_object('ok', true, 'order_id', v_order_id);
end $$;

revoke all on function public.marketplace_buy_now(uuid, uuid, uuid) from public;
grant execute on function public.marketplace_buy_now(uuid, uuid, uuid) to authenticated, service_role;
