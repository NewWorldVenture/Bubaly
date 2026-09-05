-- Bubaly :: 0185 - atomic expired auction settlement
--
-- The close-auctions cron must not claim a listing before its winner order is
-- durable. This service-role-only RPC locks and settles one auction in a
-- single transaction; a failed order insert rolls the whole settlement back
-- so the next cron run can safely retry it.

create or replace function public.marketplace_close_auction(
  p_listing_id uuid,
  p_now timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing record;
  v_now timestamptz := coalesce(p_now, now());
  v_sold boolean;
  v_order_id uuid;
begin
  if current_user <> 'service_role' then
    raise exception 'forbidden';
  end if;

  select * into v_listing
  from public.marketplace_listings
  where id = p_listing_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_listing.sale_format <> 'auction'
    or v_listing.status <> 'available'
    or v_listing.auction_ends_at is null
    or v_listing.auction_ends_at > v_now then
    return jsonb_build_object('ok', false, 'reason', 'not_due');
  end if;

  v_sold := v_listing.bid_count > 0
    and v_listing.current_bid_cents >= coalesce(v_listing.reserve_cents, 0)
    and v_listing.highest_bidder_member_id is not null
    and v_listing.highest_bidder_family_id is not null;

  update public.marketplace_listings
  set status = case when v_sold then 'claimed' else 'withdrawn' end,
      auction_closed_at = v_now,
      claimed_by = case when v_sold then v_listing.highest_bidder_member_id else null end,
      claimed_at = case when v_sold then v_now else null end,
      updated_at = v_now
  where id = v_listing.id and status = 'available';

  if v_sold then
    insert into public.marketplace_orders
      (family_id, listing_id, buyer_member, seller_member, kind, status,
       amount_cents, notes)
    values
      (v_listing.family_id, v_listing.id, v_listing.highest_bidder_member_id,
       v_listing.member_id, 'buy', 'confirmed', v_listing.current_bid_cents,
       'Won at auction')
    returning id into v_order_id;

    update public.marketplace_bids
    set status = 'won'
    where listing_id = v_listing.id
      and bidder_member_id = v_listing.highest_bidder_member_id
      and status = 'active';

    update public.marketplace_bids
    set status = 'lost'
    where listing_id = v_listing.id and status in ('active', 'outbid');
  else
    update public.marketplace_bids
    set status = 'lost'
    where listing_id = v_listing.id and status in ('active', 'outbid');
  end if;

  return jsonb_build_object(
    'ok', true,
    'reason', 'closed',
    'sold', v_sold,
    'had_bids', v_listing.bid_count > 0,
    'listing_id', v_listing.id,
    'title', v_listing.title,
    'seller_family_id', v_listing.family_id,
    'winner_family_id', case when v_sold then v_listing.highest_bidder_family_id else null end,
    'winner_member_id', case when v_sold then v_listing.highest_bidder_member_id else null end,
    'current_bid_cents', v_listing.current_bid_cents,
    'order_id', v_order_id
  );
end $$;

revoke all on function public.marketplace_close_auction(uuid, timestamptz) from public;
grant execute on function public.marketplace_close_auction(uuid, timestamptz) to service_role;
