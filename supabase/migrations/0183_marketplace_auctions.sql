-- Bubaly :: 0183 — Marketplace auctions (timed bidding — the eBay-beating core)
--
-- Turns any sell listing into a real-time timed auction. Craigslist has no
-- bidding at all; eBay has it but is impersonal and unsafe. Ours is community-
-- scoped (family + circles), trust-scored, with proxy (max) bids, tiered
-- minimum increments, a hidden reserve, optional Buy-It-Now, and anti-sniping
-- (a late bid extends the clock) — so auctions end on price discovery, not luck.
--
-- All bid writes go through the SECURITY DEFINER `marketplace_place_bid` RPC,
-- which locks the listing row FOR UPDATE so two simultaneous bids can never both
-- win the same amount (the same atomicity guarantee the wallet card-auth uses).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

-- ── Auction columns on the listing ───────────────────────────────────────────
alter table public.marketplace_listings
  add column if not exists sale_format text not null default 'fixed'
    check (sale_format in ('fixed', 'auction')),
  add column if not exists auction_starts_at timestamptz,
  add column if not exists auction_ends_at timestamptz,
  add column if not exists starting_bid_cents bigint not null default 0,
  add column if not exists reserve_cents bigint,                    -- hidden floor; null = no reserve
  add column if not exists buy_now_cents bigint,                    -- optional instant purchase
  add column if not exists current_bid_cents bigint not null default 0,
  add column if not exists bid_count integer not null default 0,
  add column if not exists highest_bidder_member_id uuid references public.family_members(id) on delete set null,
  add column if not exists highest_bidder_family_id uuid references public.families(id) on delete set null,
  add column if not exists highest_max_cents bigint not null default 0,   -- current leader's hidden proxy max
  add column if not exists anti_snipe_minutes integer not null default 2,
  add column if not exists auction_closed_at timestamptz;

create index if not exists idx_marketplace_listings_auction
  on public.marketplace_listings(sale_format, auction_ends_at)
  where sale_format = 'auction';

-- ── Bids ──────────────────────────────────────────────────────────────────────
create table if not exists public.marketplace_bids (
  id                uuid primary key default gen_random_uuid(),
  listing_id        uuid not null references public.marketplace_listings(id) on delete cascade,
  family_id         uuid not null references public.families(id) on delete cascade,  -- listing owner's family
  bidder_member_id  uuid not null references public.family_members(id) on delete cascade,
  bidder_family_id  uuid not null references public.families(id) on delete cascade,
  amount_cents      bigint not null check (amount_cents > 0),        -- the visible bid placed
  max_cents         bigint not null check (max_cents > 0),           -- bidder's proxy ceiling (>= amount)
  status            text not null default 'active'
                      check (status in ('active', 'outbid', 'won', 'lost', 'retracted')),
  is_auto           boolean not null default false,                  -- placed by the proxy engine, not a human tap
  created_at        timestamptz not null default now()
);
create index if not exists idx_marketplace_bids_listing on public.marketplace_bids(listing_id, created_at desc);
create index if not exists idx_marketplace_bids_bidder on public.marketplace_bids(bidder_family_id, created_at desc);

alter table public.marketplace_bids enable row level security;

-- Bid history is visible to the seller's family AND the bidder's family.
drop policy if exists marketplace_bids_select on public.marketplace_bids;
create policy marketplace_bids_select on public.marketplace_bids
  for select using (public.is_family_member(family_id) or public.is_family_member(bidder_family_id));

-- Direct inserts must be your own family's bid; the RPC (definer) is the real path.
drop policy if exists marketplace_bids_insert on public.marketplace_bids;
create policy marketplace_bids_insert on public.marketplace_bids
  for insert with check (public.is_family_member(bidder_family_id));

-- ── The atomic bid RPC ────────────────────────────────────────────────────────
-- eBay-style: the bidder submits a MAX (proxy) amount. We reveal only the
-- minimum needed to lead. Locks the listing row so concurrent bids serialize.
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
  v_listing   record;
  v_now       timestamptz := now();
  v_increment bigint;
  v_min_bid   bigint;
  v_new_visible bigint;
  v_extended  boolean := false;
begin
  -- Lock the listing so two bids can't race on the same current price.
  select * into v_listing from public.marketplace_listings
    where id = p_listing_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_listing.sale_format <> 'auction' then return jsonb_build_object('ok', false, 'reason', 'not_auction'); end if;
  if v_listing.status <> 'available' then return jsonb_build_object('ok', false, 'reason', 'not_available'); end if;
  if v_listing.auction_ends_at is null or v_now >= v_listing.auction_ends_at then
    return jsonb_build_object('ok', false, 'reason', 'ended');
  end if;
  if v_listing.auction_starts_at is not null and v_now < v_listing.auction_starts_at then
    return jsonb_build_object('ok', false, 'reason', 'not_started');
  end if;
  -- Can't bid on your own listing.
  if v_listing.family_id = p_bidder_family_id then
    return jsonb_build_object('ok', false, 'reason', 'own_listing');
  end if;

  -- Tiered minimum increment (eBay-like), based on current price.
  v_increment := case
    when v_listing.current_bid_cents < 100 then 5
    when v_listing.current_bid_cents < 500 then 25
    when v_listing.current_bid_cents < 2500 then 50
    when v_listing.current_bid_cents < 10000 then 100
    when v_listing.current_bid_cents < 25000 then 250
    when v_listing.current_bid_cents < 100000 then 500
    else 1000 end;

  -- Minimum acceptable max: at/above starting bid on the first bid, otherwise
  -- one increment over the current price.
  if v_listing.bid_count = 0 then
    v_min_bid := greatest(v_listing.starting_bid_cents, 1);
  else
    v_min_bid := v_listing.current_bid_cents + v_increment;
  end if;
  if p_max_cents < v_min_bid then
    return jsonb_build_object('ok', false, 'reason', 'too_low', 'min_cents', v_min_bid);
  end if;

  -- Proxy resolution.
  if v_listing.bid_count = 0 then
    -- First bid: visible price = starting bid.
    v_new_visible := greatest(v_listing.starting_bid_cents, v_increment);
    if v_new_visible > p_max_cents then v_new_visible := p_max_cents; end if;
  elsif p_max_cents > v_listing.highest_max_cents then
    -- New leader: reveal just enough to beat the previous leader's max.
    v_new_visible := least(p_max_cents, v_listing.highest_max_cents + v_increment);
    -- Mark the old leader outbid.
    update public.marketplace_bids set status = 'outbid'
      where listing_id = p_listing_id and status = 'active';
  else
    -- Bid doesn't beat the standing proxy: the leader auto-covers it. The
    -- visible price rises to one increment over this challenger (capped by the
    -- leader's max), the leader stays in front, and we record the loss.
    v_new_visible := least(v_listing.highest_max_cents, p_max_cents + v_increment);
    insert into public.marketplace_bids
      (listing_id, family_id, bidder_member_id, bidder_family_id, amount_cents, max_cents, status)
      values (p_listing_id, v_listing.family_id, p_bidder_member_id, p_bidder_family_id, p_max_cents, p_max_cents, 'outbid');
    update public.marketplace_listings
      set current_bid_cents = v_new_visible, bid_count = bid_count + 1, updated_at = v_now
      where id = p_listing_id;
    return jsonb_build_object('ok', true, 'leading', false, 'current_cents', v_new_visible);
  end if;

  -- Record the winning (leading) bid + promote the bidder to highest.
  insert into public.marketplace_bids
    (listing_id, family_id, bidder_member_id, bidder_family_id, amount_cents, max_cents, status)
    values (p_listing_id, v_listing.family_id, p_bidder_member_id, p_bidder_family_id, v_new_visible, p_max_cents, 'active');

  -- Anti-snipe: a bid inside the window pushes the end out.
  if v_listing.auction_ends_at - v_now < make_interval(mins => v_listing.anti_snipe_minutes) then
    v_extended := true;
  end if;

  update public.marketplace_listings set
    current_bid_cents = v_new_visible,
    bid_count = bid_count + 1,
    highest_bidder_member_id = p_bidder_member_id,
    highest_bidder_family_id = p_bidder_family_id,
    highest_max_cents = p_max_cents,
    auction_ends_at = case when v_extended
      then v_now + make_interval(mins => v_listing.anti_snipe_minutes) else auction_ends_at end,
    updated_at = v_now
  where id = p_listing_id;

  return jsonb_build_object('ok', true, 'leading', true,
    'current_cents', v_new_visible, 'extended', v_extended);
end $$;

revoke all on function public.marketplace_place_bid(uuid, uuid, uuid, bigint) from public;
grant execute on function public.marketplace_place_bid(uuid, uuid, uuid, bigint) to authenticated, service_role;
