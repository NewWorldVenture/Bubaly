-- ============================================================================
-- 0186 · Marketplace "Make an Offer" — real back-and-forth negotiation.
--
-- The eBay "Best Offer" gap. Today a buyer can send ONE offer amount and the
-- seller can only accept or decline it — there's no counter, no thread, no
-- negotiation (Craigslist has none of this at all). This adds a proper
-- two-sided negotiation:
--   • marketplace_negotiations      — one thread per (listing, buyer)
--   • marketplace_negotiation_rounds — the ordered offer/counter/… history
--   • marketplace_negotiation_offer(...)   — buyer opens or counters
--   • marketplace_negotiation_respond(...) — either party counters/accepts/
--        declines/withdraws, with a strict turn model and an atomic accept
--        that claims the listing + writes a confirmed order (same pattern as
--        marketplace_accept_offer) and closes every competing thread/offer.
--
-- All writes go through SECURITY DEFINER RPCs that lock the listing FOR UPDATE
-- and verify the caller is the buyer (in their own family) or the listing owner
-- (in theirs) — so two families racing can't both "win" the same item. RLS is
-- read-only from the app: a row is visible to the buyer's family OR the seller's.
--
-- Additive + idempotent. Requires 0120 + 0151 + 0154. Apply to prod (see
-- docs/PENDING_PROD_MIGRATIONS.md) — the item page's offer thread calls these.
-- ============================================================================

-- ── marketplace_negotiations ────────────────────────────────────────────────
create table if not exists public.marketplace_negotiations (
  id                  uuid primary key default gen_random_uuid(),
  family_id           uuid not null references public.families(id) on delete cascade,       -- seller's family (owns the listing)
  listing_id          uuid not null references public.marketplace_listings(id) on delete cascade,
  buyer_member_id     uuid not null references public.family_members(id) on delete cascade,
  buyer_family_id     uuid not null references public.families(id) on delete cascade,
  status              text not null default 'open'
                        check (status in ('open','agreed','declined','withdrawn','expired')),
  current_amount_cents bigint not null check (current_amount_cents > 0),   -- latest amount on the table
  last_actor          text not null check (last_actor in ('buyer','seller')),  -- who moved last (the OTHER party responds)
  rounds_count        int not null default 1,
  agreed_amount_cents bigint,
  order_id            uuid references public.marketplace_orders(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_mkt_negotiations_listing on public.marketplace_negotiations(listing_id);
create index if not exists idx_mkt_negotiations_buyer   on public.marketplace_negotiations(buyer_family_id, buyer_member_id);
create index if not exists idx_mkt_negotiations_family  on public.marketplace_negotiations(family_id, status);
-- at most one OPEN thread per (listing, buyer)
create unique index if not exists uq_mkt_negotiations_open
  on public.marketplace_negotiations(listing_id, buyer_member_id) where status = 'open';

-- ── marketplace_negotiation_rounds ──────────────────────────────────────────
create table if not exists public.marketplace_negotiation_rounds (
  id               uuid primary key default gen_random_uuid(),
  negotiation_id   uuid not null references public.marketplace_negotiations(id) on delete cascade,
  listing_id       uuid not null references public.marketplace_listings(id) on delete cascade,
  actor_member_id  uuid references public.family_members(id) on delete set null,
  actor_role       text not null check (actor_role in ('buyer','seller')),
  kind             text not null check (kind in ('offer','counter','accept','decline','withdraw')),
  amount_cents     bigint,
  message          text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_mkt_neg_rounds_thread on public.marketplace_negotiation_rounds(negotiation_id, created_at);

-- ── RLS: readable by the buyer's family OR the seller's family ───────────────
alter table public.marketplace_negotiations       enable row level security;
alter table public.marketplace_negotiation_rounds enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
      and tablename='marketplace_negotiations' and policyname='mkt_neg_select') then
    create policy mkt_neg_select on public.marketplace_negotiations for select using (
      public.is_family_member(family_id) or public.is_family_member(buyer_family_id)
    );
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
      and tablename='marketplace_negotiation_rounds' and policyname='mkt_neg_rounds_select') then
    create policy mkt_neg_rounds_select on public.marketplace_negotiation_rounds for select using (
      exists (
        select 1 from public.marketplace_negotiations n
        where n.id = negotiation_id
          and (public.is_family_member(n.family_id) or public.is_family_member(n.buyer_family_id))
      )
    );
  end if;
end $$;

-- ── Buyer opens a negotiation, or counters the seller's last move ────────────
-- Returns the negotiation id. First call for a (listing, buyer) opens the
-- thread ('offer'); a later call while it's the buyer's turn is a 'counter'.
create or replace function public.marketplace_negotiation_offer(
  p_listing uuid, p_buyer_member uuid, p_buyer_family uuid, p_amount bigint, p_message text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_listing public.marketplace_listings%rowtype;
  v_caller  uuid;
  v_neg     public.marketplace_negotiations%rowtype;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'bad_amount');
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
end $$;

-- ── Either party responds: counter / accept / decline / withdraw ─────────────
-- Turn model: counter & accept require it to be YOUR turn (the other party
-- moved last). decline (seller) / withdraw (buyer) can end the thread anytime.
-- accept is atomic: claims the listing, writes a confirmed order, and closes
-- every competing open thread + open offer on the listing.
create or replace function public.marketplace_negotiation_respond(
  p_negotiation uuid, p_action text, p_amount bigint default null, p_message text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_neg     public.marketplace_negotiations%rowtype;
  v_listing public.marketplace_listings%rowtype;
  v_seller_member uuid;
  v_buyer_caller  uuid;
  v_role    text;
  v_actor   uuid;
  v_order   uuid;
begin
  select * into v_neg from public.marketplace_negotiations where id = p_negotiation for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into v_listing from public.marketplace_listings where id = v_neg.listing_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'listing_missing'); end if;
  if v_neg.status <> 'open' then return jsonb_build_object('ok', false, 'reason', 'not_open'); end if;

  -- Who is calling? Seller (listing owner) or the buyer on this thread.
  v_seller_member := public.marketplace_member_id(v_listing.family_id);
  v_buyer_caller  := public.marketplace_member_id(v_neg.buyer_family_id);
  if v_seller_member is not null and v_seller_member = v_listing.member_id then
    v_role := 'seller'; v_actor := v_seller_member;
  elsif v_buyer_caller is not null and v_buyer_caller = v_neg.buyer_member_id then
    v_role := 'buyer'; v_actor := v_buyer_caller;
  else
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  if p_action = 'withdraw' then
    if v_role <> 'buyer' then return jsonb_build_object('ok', false, 'reason', 'buyer_only'); end if;
    update public.marketplace_negotiations set status = 'withdrawn', updated_at = now() where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, message)
    values (v_neg.id, v_listing.id, v_actor, v_role, 'withdraw', p_message);
    return jsonb_build_object('ok', true, 'status', 'withdrawn');
  end if;

  if p_action = 'decline' then
    if v_role <> 'seller' then return jsonb_build_object('ok', false, 'reason', 'seller_only'); end if;
    update public.marketplace_negotiations set status = 'declined', updated_at = now() where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, message)
    values (v_neg.id, v_listing.id, v_actor, v_role, 'decline', p_message);
    return jsonb_build_object('ok', true, 'status', 'declined');
  end if;

  -- counter / accept require it to be this caller's turn.
  if (v_role = 'seller' and v_neg.last_actor <> 'buyer')
     or (v_role = 'buyer' and v_neg.last_actor <> 'seller') then
    return jsonb_build_object('ok', false, 'reason', 'not_your_turn');
  end if;

  if p_action = 'counter' then
    if p_amount is null or p_amount <= 0 then return jsonb_build_object('ok', false, 'reason', 'bad_amount'); end if;
    update public.marketplace_negotiations
       set current_amount_cents = p_amount, last_actor = v_role,
           rounds_count = rounds_count + 1, updated_at = now()
     where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message)
    values (v_neg.id, v_listing.id, v_actor, v_role, 'counter', p_amount, p_message);
    return jsonb_build_object('ok', true, 'status', 'open', 'amount_cents', p_amount);
  end if;

  if p_action = 'accept' then
    if v_listing.status not in ('available','pending') then
      return jsonb_build_object('ok', false, 'reason', 'not_available');
    end if;
    -- Claim the listing for this buyer + record the deal at the agreed price.
    update public.marketplace_listings
       set status = 'claimed', claimed_by = v_neg.buyer_member_id, claimed_at = now(), updated_at = now()
     where id = v_listing.id;

    insert into public.marketplace_orders
      (family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents, notes, created_by)
    values (v_listing.family_id, v_listing.id, v_neg.buyer_member_id, v_listing.member_id,
            'buy', 'confirmed', v_neg.current_amount_cents, 'Agreed via Make an Offer', auth.uid())
    returning id into v_order;

    update public.marketplace_negotiations
       set status = 'agreed', agreed_amount_cents = v_neg.current_amount_cents,
           order_id = v_order, updated_at = now()
     where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message)
    values (v_neg.id, v_listing.id, v_actor, v_role, 'accept', v_neg.current_amount_cents, p_message);

    -- Close every competing thread + open offer on this now-claimed listing.
    update public.marketplace_negotiations set status = 'declined', updated_at = now()
     where listing_id = v_listing.id and status = 'open' and id <> v_neg.id;
    update public.marketplace_offers set status = 'declined', updated_at = now()
     where listing_id = v_listing.id and status = 'open';

    return jsonb_build_object('ok', true, 'status', 'agreed', 'order_id', v_order,
                              'amount_cents', v_neg.current_amount_cents);
  end if;

  return jsonb_build_object('ok', false, 'reason', 'bad_action');
end $$;

revoke all on function public.marketplace_negotiation_offer(uuid, uuid, uuid, bigint, text) from public;
revoke all on function public.marketplace_negotiation_respond(uuid, text, bigint, text) from public;
grant execute on function public.marketplace_negotiation_offer(uuid, uuid, uuid, bigint, text) to authenticated, service_role;
grant execute on function public.marketplace_negotiation_respond(uuid, text, bigint, text) to authenticated, service_role;
