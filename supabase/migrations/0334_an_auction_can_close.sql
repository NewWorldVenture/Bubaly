-- An auction can close. (DB-FN-003)
--
-- `marketplace_close_auction` (0185) settles an ended auction: it claims the
-- listing for the highest bidder or withdraws it, and creates the order. It
-- opens with
--
--   if current_user <> 'service_role' then raise exception 'forbidden'; end if;
--
-- It is SECURITY DEFINER, owned by postgres, and inside a definer function
-- current_user is the owner. So the condition is true for every caller and the
-- function has refused every call since 0185. Measured on the local stack,
-- called exactly as app/api/cron/close-auctions does, through the service
-- client:
--
--   rpc marketplace_close_auction -> {"code":"P0001","message":"forbidden"}
--
-- The cron treats that as "settlement failed; leaving it retryable", so every
-- ended auction has stayed `available` indefinitely: no winner claimed, no
-- order, no notification, while `marketplace_place_bid` refuses new bids as
-- `ended`.
--
-- The caller's role is in the request JWT, which auth.role() reads, the same
-- test the chore and reward guards already use. Nothing else in the function
-- changes. The client roles also lose EXECUTE: this is the server's to call,
-- and Supabase's default privileges gave anon and authenticated a direct grant
-- that 0185's `revoke ... from public` never removed (see 0333).
--
-- Deploy: data effect only. The first settlement run after this is applied
-- closes every auction that ended while the function was dead, up to the
-- cron's batch size per run. Winners and sellers are notified for all of them.

CREATE OR REPLACE FUNCTION public.marketplace_close_auction(p_listing_id uuid, p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_listing record;
  v_now timestamptz := coalesce(p_now, now());
  v_sold boolean;
  v_order_id uuid;
begin
  -- Inside a SECURITY DEFINER function current_user is the OWNER, never the
  -- caller, so the check that stood here (current_user <> 'service_role')
  -- refused every call there has ever been — the settlement cron's included.
  -- The caller's role is in the request's JWT claims.
  if coalesce(auth.role(), '') <> 'service_role' then
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
end $function$;

revoke all on function public.marketplace_close_auction(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.marketplace_close_auction(uuid, timestamptz) to service_role;

do $check$
begin
  if position('current_user' in pg_get_functiondef('public.marketplace_close_auction(uuid, timestamptz)'::regprocedure)) > 0
     and position('auth.role()' in pg_get_functiondef('public.marketplace_close_auction(uuid, timestamptz)'::regprocedure)) = 0 then
    raise exception '0334: marketplace_close_auction still tests current_user';
  end if;
  if has_function_privilege('anon', 'public.marketplace_close_auction(uuid, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.marketplace_close_auction(uuid, timestamptz)', 'execute') then
    raise exception '0334: a client role can execute marketplace_close_auction';
  end if;
end
$check$;
