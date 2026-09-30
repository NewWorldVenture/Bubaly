-- Bubaly :: 0462 - a listing is bid on, bought, offered for and asked about
--                   only by a family that can see it (DB-RPC-M01)
-- ----------------------------------------------------------------------------
-- A marketplace listing is visible to its own family and to every family in a
-- circle it is shared into (marketplace_listings_select and
-- marketplace_listings_circle_read). Nothing that ACTS on a listing asked the
-- same question. Measured on a database replayed through 0461, as a parent of
-- a family in no circle the listing is shared with, who cannot SELECT it (0 of
-- 2 rows), given only its id:
--
--   marketplace_place_bid(auction, …)          {"ok": true, "leading": true}
--   marketplace_negotiation_offer(sale, …)     {"ok": true, "negotiation_id": …}
--   marketplace_buy_now(auction, …)            {"ok": true, "order_id": …}
--                                              -> the listing is 'claimed' and a
--                                                 confirmed order names the outsider
--   insert into marketplace_offers (… listing_id = someone else's listing …)
--                                              -> INSERT 1, and the SECURITY
--                                                 DEFINER trigger
--                                                 marketplace_offer_flip_pending
--                                                 moved that listing from
--                                                 'available' to 'pending'
--
-- The three functions are SECURITY DEFINER, so RLS on the listing never ran;
-- each checked that the caller is who they claim to be in THEIR family and
-- never whether that family can see the listing. The offers INSERT policy
-- checks only the row's own family_id and member_id — the class 0311 names —
-- and the trigger behind it acts on the reference as the table owner. A
-- listing id is a uuid, but it is in every item URL a circle member shares.
--
-- ── the fix ─────────────────────────────────────────────────────────────────
--
-- marketplace_listing_visible_to(listing, family): the caller belongs to
-- `family`, and the listing is that family's or is shared into a circle that
-- family is in — the two read policies, as one predicate. SECURITY DEFINER
-- because a circle member cannot read the other families' membership rows it
-- needs; it names the caller (is_family_member) so it is not an oracle for
-- families the caller is not in.
--
--   * marketplace_place_bid, marketplace_buy_now, marketplace_negotiation_offer
--     refuse a listing the acting family cannot see, as 'not_found', which
--     every caller already maps. Each body below is the one 0461 left in the
--     database with that one check added; nothing else changes.
--   * marketplace_offers: an offer is the in-family flow (makeOfferAction and
--     the marketplace module both read the listing under the family's own id;
--     cross-family interest goes through negotiations), so its listing must
--     be in the offer's own family. That is exactly 0311's
--     reference_shares_family, wired here. A circle member who CAN see the
--     listing is refused too, which is right: the seller's family could never
--     read that offer, and its only effect was the flip to 'pending'.
--   * marketplace_questions, marketplace_saves, marketplace_collection_items
--     take a listing from another family legitimately (a question on a circle
--     listing, a save, a collection), so they get a RESTRICTIVE insert policy
--     on visibility rather than the same-family rule. Their writes act on
--     nothing else, so this is hygiene, not the breach above.
--
-- Probe: docs/audit/a-listing-is-acted-on-only-by-who-can-see-it-check.sql
-- (outsider refused on all seven paths, the listing still 'available' with no
-- order; a circle member's bid, offer, question and save still land; the
-- seller's own family still makes an offer and flips its listing).

create or replace function public.marketplace_listing_visible_to(p_listing_id uuid, p_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_family_member(p_family_id)
     and exists (
       select 1
         from public.marketplace_listings l
        where l.id = p_listing_id
          and (l.family_id = p_family_id
               or exists (select 1
                            from public.marketplace_listing_shares s
                            join public.marketplace_circle_members m on m.circle_id = s.circle_id
                           where s.listing_id = l.id
                             and m.family_id = p_family_id)));
$$;

comment on function public.marketplace_listing_visible_to(uuid, uuid) is
  'True when the caller belongs to p_family_id and that family can see the listing: its own, or shared into a circle it is a member of. The same rule as the two SELECT policies on marketplace_listings, for code that acts on a listing id (0462).';

revoke all on function public.marketplace_listing_visible_to(uuid, uuid) from public, anon;
grant execute on function public.marketplace_listing_visible_to(uuid, uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.marketplace_place_bid(p_listing_id uuid, p_bidder_member_id uuid, p_bidder_family_id uuid, p_max_cents bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- The listing must be one this family can see (0462): its own, or one
  -- shared into a circle the family belongs to. 'not_found', because to
  -- a family that cannot see it, it is not there.
  if not public.marketplace_listing_visible_to(p_listing_id, p_bidder_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  return public.marketplace_place_bid_unchecked(
    p_listing_id, p_bidder_member_id, p_bidder_family_id, p_max_cents
  );
end $function$;

CREATE OR REPLACE FUNCTION public.marketplace_buy_now(p_listing_id uuid, p_buyer_member_id uuid, p_buyer_family_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- The listing must be one this family can see (0462): its own, or one
  -- shared into a circle the family belongs to. 'not_found', because to
  -- a family that cannot see it, it is not there.
  if not public.marketplace_listing_visible_to(p_listing_id, p_buyer_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
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
end $function$;

CREATE OR REPLACE FUNCTION public.marketplace_negotiation_offer(p_listing uuid, p_buyer_member uuid, p_buyer_family uuid, p_amount bigint, p_message text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_listing public.marketplace_listings%rowtype;
  v_caller  uuid;
  v_neg     public.marketplace_negotiations%rowtype;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'bad_amount');
  end if;

  -- The listing must be one this family can see (0462): its own, or one
  -- shared into a circle the family belongs to. 'not_found', because to
  -- a family that cannot see it, it is not there.
  if not public.marketplace_listing_visible_to(p_listing, p_buyer_family) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into v_listing from public.marketplace_listings where id = p_listing for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_listing.kind <> 'sell' then return jsonb_build_object('ok', false, 'reason', 'not_negotiable'); end if;
  if v_listing.status not in ('available','pending') then
    return jsonb_build_object('ok', false, 'reason', 'not_available');
  end if;

  -- Caller must be the acting member of the buyer family they claim.
  v_caller := public.marketplace_member_id(p_buyer_family);
  if v_caller is null or v_caller is distinct from p_buyer_member then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  if p_buyer_member = v_listing.member_id then
    return jsonb_build_object('ok', false, 'reason', 'own_listing');
  end if;
  -- A "make an offer" is a bid below the asking price; at/above, just buy it.
  if p_amount >= v_listing.price_cents and v_listing.price_cents > 0 then
    return jsonb_build_object('ok', false, 'reason', 'at_or_above_ask');
  end if;

  select * into v_neg from public.marketplace_negotiations
    where listing_id = p_listing and buyer_member_id = p_buyer_member and status = 'open'
    for update;

  if found then
    -- Existing thread → this is a buyer counter; only legal when it's the buyer's turn.
    if v_neg.last_actor <> 'seller' then
      return jsonb_build_object('ok', false, 'reason', 'not_your_turn', 'negotiation_id', v_neg.id);
    end if;
    update public.marketplace_negotiations
       set current_amount_cents = p_amount, last_actor = 'buyer',
           rounds_count = rounds_count + 1, updated_at = now()
     where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message)
    values (v_neg.id, p_listing, p_buyer_member, 'buyer', 'counter', p_amount, p_message);
    return jsonb_build_object('ok', true, 'negotiation_id', v_neg.id, 'amount_cents', p_amount, 'countered', true);
  end if;

  -- New thread.
  insert into public.marketplace_negotiations
    (family_id, listing_id, buyer_member_id, buyer_family_id, status, current_amount_cents, last_actor, rounds_count)
  values (v_listing.family_id, p_listing, p_buyer_member, p_buyer_family, 'open', p_amount, 'buyer', 1)
  returning * into v_neg;
  insert into public.marketplace_negotiation_rounds
    (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message)
  values (v_neg.id, p_listing, p_buyer_member, 'buyer', 'offer', p_amount, p_message);
  return jsonb_build_object('ok', true, 'negotiation_id', v_neg.id, 'amount_cents', p_amount, 'countered', false);
end $function$;

-- ── offers: the listing is the offer's own family's ─────────────────────────
do $$
begin
  if to_regprocedure('public.reference_shares_family()') is null then
    raise exception '0462 needs reference_shares_family() from 0311';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'marketplace_listings' and column_name = 'family_id') then
    raise exception 'marketplace_listings.family_id does not exist, so the guard would raise 42703 on every authenticated offer';
  end if;
end
$$;

drop trigger if exists trg_marketplace_offers_listing_id_family on public.marketplace_offers;
create trigger trg_marketplace_offers_listing_id_family
  before insert or update of listing_id, family_id on public.marketplace_offers
  for each row execute function public.reference_shares_family('listing_id', 'marketplace_listings');

-- ── questions, saves, collection items: a listing the family can see ────────
drop policy if exists marketplace_questions_listing_is_visible on public.marketplace_questions;
create policy marketplace_questions_listing_is_visible on public.marketplace_questions
  as restrictive for insert to authenticated
  with check (public.marketplace_listing_visible_to(listing_id, family_id));

drop policy if exists marketplace_saves_listing_is_visible on public.marketplace_saves;
create policy marketplace_saves_listing_is_visible on public.marketplace_saves
  as restrictive for insert to authenticated
  with check (public.marketplace_listing_visible_to(listing_id, family_id));

drop policy if exists marketplace_collection_items_listing_is_visible on public.marketplace_collection_items;
create policy marketplace_collection_items_listing_is_visible on public.marketplace_collection_items
  as restrictive for insert to authenticated
  with check (public.marketplace_listing_visible_to(listing_id, family_id));
