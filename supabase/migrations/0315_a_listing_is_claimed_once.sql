-- Bubaly :: 0315 - one item cannot be sold to two families
--
-- `marketplace_accept_offer` is SECURITY DEFINER and checks two things before
-- it acts: that the caller owns the listing, and that the OFFER is still open.
--
--   if v_offer.status <> 'open' then raise exception 'Offer is no longer open'; end if;
--
-- It never checks the LISTING. So the guard is on the piece of paper, not on
-- the thing being sold.
--
-- Nothing stops a second offer being written against a claimed listing —
-- `marketplace_offers_insert` requires only family membership and that the
-- offer is made in the member's own name — and a backup offer is a reasonable
-- thing for a family to make ("I'll take it if the first buyer falls through").
-- Accepting one, though, must not sell the item twice.
--
-- Measured on a replayed database, with NO concurrency, as the listing's own
-- owner:
--
--   accepted buyer one -> listing=claimed, orders=1
--   buyer two could place an offer on a CLAIMED listing: t
--   accepted buyer two -> listing=claimed, orders=2
--                         (Buyer one @40, Buyer two @45)
--
-- Two confirmed orders for one balance bike, two families each told it is
-- theirs, and `claimed_by` silently rewritten from the first buyer to the
-- second while the first keeps a confirmed order. `marketplace_orders` carries
-- no unique index on `listing_id`, so the schema does not catch it either.
--
-- ── where the check goes ────────────────────────────────────────────────────
--
-- The precondition goes IN THE UPDATE, not in an `if` above it. An `if` fixes
-- the sequential case only: two genuinely concurrent accepts would both read
-- `available`, both pass the check, and both write. Carrying the condition in
-- the UPDATE makes the row lock do the work — the second one matches zero rows
-- and says so. This is the same shape as the allowance rule the cron
-- re-credited and the social target that published twice: the write that is
-- supposed to be the claim has to be the thing that is exclusive.
--
-- Offers are deliberately left alone. A family may still register interest in
-- something already claimed; what changes is that accepting it cannot sell the
-- item a second time.

create or replace function public.marketplace_accept_offer(p_offer uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer   public.marketplace_offers%rowtype;
  v_listing public.marketplace_listings%rowtype;
  v_caller  uuid;
  v_kind    text;
  v_order   uuid;
  v_claimed uuid;
begin
  select * into v_offer from public.marketplace_offers where id = p_offer;
  if not found then raise exception 'Offer not found'; end if;
  select * into v_listing from public.marketplace_listings where id = v_offer.listing_id;
  if not found then raise exception 'Listing not found'; end if;

  v_caller := public.marketplace_member_id(v_listing.family_id);
  if v_caller is null or v_listing.member_id is distinct from v_caller then
    raise exception 'Only the listing owner can accept offers';
  end if;
  if v_offer.status <> 'open' then raise exception 'Offer is no longer open'; end if;

  -- Claim the listing. The status condition lives here rather than in an `if`
  -- above, so two concurrent accepts serialise on the row and the second one
  -- matches nothing instead of selling the item again.
  update public.marketplace_listings
     set status = 'claimed', claimed_by = v_offer.member_id, claimed_at = now(), updated_at = now()
   where id = v_listing.id
     and status in ('available', 'pending')
  returning id into v_claimed;
  if v_claimed is null then
    raise exception 'This listing is no longer available';
  end if;

  update public.marketplace_offers set status = 'accepted', updated_at = now()
   where id = v_offer.id;
  update public.marketplace_offers set status = 'declined', updated_at = now()
   where listing_id = v_listing.id and status = 'open' and id <> v_offer.id;

  v_kind := case
    when v_listing.kind = 'sell' then 'buy'
    when v_listing.kind in ('rent','borrow','swap','donate','free') then v_listing.kind
    else 'buy'
  end;

  insert into public.marketplace_orders
    (family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents, created_by)
  values
    (v_listing.family_id, v_listing.id, v_offer.member_id, v_listing.member_id, v_kind,
     'confirmed', coalesce(v_offer.amount_cents, v_listing.price_cents), auth.uid())
  returning id into v_order;

  return v_order;
end $$;

comment on function public.marketplace_accept_offer(uuid) is
  'Accepts an offer and creates the confirmed order. The listing is claimed by an UPDATE carrying its own status precondition, so one item cannot be sold twice — sequentially or under two concurrent accepts (0315).';
