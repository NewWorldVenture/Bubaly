-- ============================================================================
-- 0154 · Marketplace object-level authorization (ownership) + safe hand-off.
--
-- Closes the audit's SEC-1/SEC-2/REL-1/REL-3/RACE-1 findings. Prior policies
-- gated marketplace tables by family membership ALONE, so any member could edit
-- another member's listing/store, accept offers they don't own, or forge
-- saves/offers/reviews with a spoofed member id (inflating trust scores). This
-- migration:
--   • adds public.marketplace_member_id(family) — the caller's member id;
--   • ties INSERTs to the acting member and UPDATE/DELETE to the row owner;
--   • moves the offer hand-off + listing status changes into SECURITY DEFINER
--     RPCs that verify ownership and run atomically;
--   • flips a listing to 'pending' via a trigger on offer insert (so the
--     interested member no longer needs UPDATE on someone else's listing);
--   • adds a partial unique index so a member can hold at most one OPEN offer
--     per listing (idempotent "I'm interested").
--
-- Additive + idempotent. Requires 0120 + 0151. Apply to prod (see
-- docs/PENDING_PROD_MIGRATIONS.md) — the app's marketplace mutations call the
-- new RPCs and rely on the tightened policies.
-- ============================================================================

-- ── Caller's member id within a family (null if not a member) ───────────────
create or replace function public.marketplace_member_id(p_family_id uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select id from public.family_members
  where family_id = p_family_id and user_id = auth.uid() and is_active
  limit 1;
$$;

-- ── Collapse any pre-existing duplicate OPEN offers before the unique index ──
-- Keep the earliest per (listing, member); withdraw the rest. Null member ids
-- are treated as distinct (never collapsed).
update public.marketplace_offers o
   set status = 'withdrawn'
 where o.status = 'open'
   and o.member_id is not null
   and exists (
     select 1 from public.marketplace_offers o2
     where o2.listing_id = o.listing_id
       and o2.member_id = o.member_id
       and o2.status = 'open'
       and o2.id < o.id
   );

create unique index if not exists uq_marketplace_offers_open
  on public.marketplace_offers(listing_id, member_id)
  where status = 'open';

-- ── Flip an available listing to 'pending' when its first offer lands ────────
-- Runs as the table owner (definer), so the interested member needs no UPDATE
-- grant on the owner's listing.
create or replace function public.marketplace_offer_flip_pending()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.marketplace_listings
     set status = 'pending', updated_at = now()
   where id = new.listing_id and status = 'available';
  return new;
end $$;

drop trigger if exists trg_marketplace_offer_flip_pending on public.marketplace_offers;
create trigger trg_marketplace_offer_flip_pending
  after insert on public.marketplace_offers
  for each row execute function public.marketplace_offer_flip_pending();

-- ── Owner-checked, atomic offer accept → order + review path ─────────────────
create or replace function public.marketplace_accept_offer(p_offer uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_offer   public.marketplace_offers%rowtype;
  v_listing public.marketplace_listings%rowtype;
  v_caller  uuid;
  v_kind    text;
  v_order   uuid;
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

  update public.marketplace_listings
     set status = 'claimed', claimed_by = v_offer.member_id, claimed_at = now(), updated_at = now()
   where id = v_listing.id;

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

-- ── Owner-checked decline of a single offer ─────────────────────────────────
create or replace function public.marketplace_decline_offer(p_offer uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_offer   public.marketplace_offers%rowtype;
  v_listing public.marketplace_listings%rowtype;
  v_caller  uuid;
begin
  select * into v_offer from public.marketplace_offers where id = p_offer;
  if not found then raise exception 'Offer not found'; end if;
  select * into v_listing from public.marketplace_listings where id = v_offer.listing_id;
  if not found then raise exception 'Listing not found'; end if;

  v_caller := public.marketplace_member_id(v_listing.family_id);
  if v_caller is null or v_listing.member_id is distinct from v_caller then
    raise exception 'Only the listing owner can decline offers';
  end if;

  update public.marketplace_offers set status = 'declined', updated_at = now()
   where id = v_offer.id and status = 'open';
end $$;

-- ── Owner-checked listing status transition (legal transitions only) ─────────
create or replace function public.marketplace_set_listing_status(p_listing uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_listing public.marketplace_listings%rowtype;
  v_caller  uuid;
  v_ok      boolean;
begin
  select * into v_listing from public.marketplace_listings where id = p_listing;
  if not found then raise exception 'Listing not found'; end if;

  v_caller := public.marketplace_member_id(v_listing.family_id);
  if v_caller is null or v_listing.member_id is distinct from v_caller then
    raise exception 'Only the listing owner can change this listing';
  end if;

  v_ok := case
    when p_status = 'withdrawn'  then v_listing.status in ('available','pending','claimed')
    when p_status = 'completed'  then v_listing.status in ('claimed','pending')
    when p_status = 'available'  then v_listing.status in ('pending','withdrawn')
    when p_status = 'pending'    then v_listing.status = 'available'
    else false
  end;
  if not v_ok then
    raise exception 'Cannot move listing from % to %', v_listing.status, p_status;
  end if;

  update public.marketplace_listings set status = p_status, updated_at = now()
   where id = v_listing.id;
end $$;

grant execute on function public.marketplace_member_id(uuid) to authenticated;
grant execute on function public.marketplace_accept_offer(uuid) to authenticated;
grant execute on function public.marketplace_decline_offer(uuid) to authenticated;
grant execute on function public.marketplace_set_listing_status(uuid, text) to authenticated;

-- ── Tighten policies: bind writes to the acting member / row owner ───────────
do $$
begin
  -- Listings + stores: only the owning member may UPDATE/DELETE. Status changes
  -- and the offer hand-off go through the SECURITY DEFINER RPCs above, which
  -- bypass RLS after their own ownership checks.
  execute 'drop policy if exists marketplace_listings_update on public.marketplace_listings';
  execute 'create policy marketplace_listings_update on public.marketplace_listings for update '
       || 'using (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id)) '
       || 'with check (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';
  execute 'drop policy if exists marketplace_listings_delete on public.marketplace_listings';
  execute 'create policy marketplace_listings_delete on public.marketplace_listings for delete '
       || 'using (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';

  execute 'drop policy if exists marketplace_listings_insert on public.marketplace_listings';
  execute 'create policy marketplace_listings_insert on public.marketplace_listings for insert '
       || 'with check (public.is_family_member(family_id) and (member_id is null or member_id = public.marketplace_member_id(family_id)))';

  execute 'drop policy if exists marketplace_stores_update on public.marketplace_stores';
  execute 'create policy marketplace_stores_update on public.marketplace_stores for update '
       || 'using (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id)) '
       || 'with check (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';
  execute 'drop policy if exists marketplace_stores_delete on public.marketplace_stores';
  execute 'create policy marketplace_stores_delete on public.marketplace_stores for delete '
       || 'using (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';
  execute 'drop policy if exists marketplace_stores_insert on public.marketplace_stores';
  execute 'create policy marketplace_stores_insert on public.marketplace_stores for insert '
       || 'with check (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';

  -- Per-member rows: the member id on INSERT must be the caller's.
  execute 'drop policy if exists marketplace_saves_insert on public.marketplace_saves';
  execute 'create policy marketplace_saves_insert on public.marketplace_saves for insert '
       || 'with check (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';

  execute 'drop policy if exists marketplace_follows_insert on public.marketplace_follows';
  execute 'create policy marketplace_follows_insert on public.marketplace_follows for insert '
       || 'with check (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';

  execute 'drop policy if exists marketplace_offers_insert on public.marketplace_offers';
  execute 'create policy marketplace_offers_insert on public.marketplace_offers for insert '
       || 'with check (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';

  -- Offers UPDATE: the offer owner (withdraw own) or the listing owner. RPCs run
  -- as definer, so this only bounds any direct client write.
  execute 'drop policy if exists marketplace_offers_update on public.marketplace_offers';
  execute 'create policy marketplace_offers_update on public.marketplace_offers for update '
       || 'using (public.is_family_member(family_id) and ('
       || '  member_id = public.marketplace_member_id(family_id) '
       || '  or exists (select 1 from public.marketplace_listings l where l.id = listing_id '
       || '             and l.member_id = public.marketplace_member_id(family_id)))) '
       || 'with check (public.is_family_member(family_id))';

  -- Reviews: the reviewer must be the caller.
  execute 'drop policy if exists marketplace_reviews_insert on public.marketplace_reviews';
  execute 'create policy marketplace_reviews_insert on public.marketplace_reviews for insert '
       || 'with check (public.is_family_member(family_id) and reviewer_member = public.marketplace_member_id(family_id))';

  -- Orders UPDATE: only the two parties may advance the lifecycle.
  execute 'drop policy if exists marketplace_orders_update on public.marketplace_orders';
  execute 'create policy marketplace_orders_update on public.marketplace_orders for update '
       || 'using (public.is_family_member(family_id) and ('
       || '  buyer_member = public.marketplace_member_id(family_id) '
       || '  or seller_member = public.marketplace_member_id(family_id))) '
       || 'with check (public.is_family_member(family_id))';
end $$;
