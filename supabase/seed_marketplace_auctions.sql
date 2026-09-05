-- ============================================================================
-- Bubaly · SEED — Marketplace auctions (60 auctions + ~470 bids ≈ 530 rows).
-- Fills the auction surface so /marketplace/auctions and the item auction panel
-- can be tested at volume: a spread of live/ending-soon/scheduled auctions with
-- realistic bid ladders, reserves, and Buy-It-Now, plus bid history per lot.
-- Bids are attributed to a throwaway "Auction Bidders" family so they're valid
-- cross-family bids (you can't bid on your own listing).
-- Idempotent: clears its own '[seed:auction]' rows first. Resolves family by email.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0183 applied.)
-- ============================================================================
do $$
declare
  v_email    text := 'newworldventurellc@gmail.com';
  v_family   uuid;
  v_owner    uuid;      -- a member of the seller family (listing owner)
  v_user     uuid;
  v_bfam     uuid;      -- throwaway bidder family
  v_bmem     uuid[];    -- bidder members
  n_lots     int := 60;
  titles     text[] := array[
    'Vintage road bike','LEGO Millennium Falcon','Nintendo Switch bundle','Mid-century armchair',
    'Baby jogger stroller','Electric guitar + amp','Camping tent (4-person)','KitchenAid mixer',
    'Mountain bike, kids','Bookshelf, solid oak','Drone with 4K camera','Board game megabox'];
  cats       text[] := array['sports','games','electronics','furniture','baby','other'];
  photos     text[] := array[
    'https://images.unsplash.com/photo-1485965120184-e220f721d03e',
    'https://images.unsplash.com/photo-1606813907291-d86efa9b94db',
    'https://images.unsplash.com/photo-1600080972464-8e5f35f63d08'];
  lot        uuid;
  start_cents bigint;
  ends       timestamptz;
  bidders    int;
  cur        bigint;
  b          int;
  bidder     uuid;
begin
  if to_regclass('public.marketplace_bids') is null then
    raise notice 'marketplace_bids not present — apply migration 0183 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select fm.id, fm.user_id into v_owner, v_user
  from public.family_members fm where fm.family_id = v_family order by fm.created_at limit 1;

  -- Throwaway bidder family + two members (stable ids so re-runs reuse them).
  insert into public.families (id, name) values ('a0000000-0000-4000-8000-00000000b1d5', 'Auction Bidders')
    on conflict (id) do nothing;
  v_bfam := 'a0000000-0000-4000-8000-00000000b1d5';
  insert into public.family_members (id, family_id, role, display_name, is_active) values
    ('a0000000-0000-4000-8000-00000000b1e1', v_bfam, 'parent', 'Bidder One', true),
    ('a0000000-0000-4000-8000-00000000b1e2', v_bfam, 'parent', 'Bidder Two', true)
    on conflict (id) do nothing;
  v_bmem := array['a0000000-0000-4000-8000-00000000b1e1'::uuid, 'a0000000-0000-4000-8000-00000000b1e2'::uuid];

  -- Clean prior seed.
  delete from public.marketplace_bids b using public.marketplace_listings l
    where b.listing_id = l.id and l.description like '%[seed:auction]%';
  delete from public.marketplace_listings where family_id = v_family and description like '%[seed:auction]%';

  for i in 0..(n_lots - 1) loop
    start_cents := 1000 + (i % 12) * 750;              -- $10–$92 starting bids
    -- ends: mix of ending-soon (<1h), live (hours→days), and a few scheduled/future.
    ends := case
      when i % 5 = 0 then now() + ((5 + (i % 40)) || ' minutes')::interval    -- ending soon
      when i % 5 = 4 then now() + ((2 + (i % 6)) || ' days')::interval          -- long-running
      else now() + ((1 + (i % 20)) || ' hours')::interval end;                  -- live
    lot := gen_random_uuid();

    insert into public.marketplace_listings
      (id, family_id, member_id, title, description, kind, category, condition,
       price_cents, status, sale_format, auction_ends_at, starting_bid_cents,
       reserve_cents, buy_now_cents, anti_snipe_minutes, created_by, created_at)
    values (
      lot, v_family, v_owner,
      titles[1 + (i % array_length(titles, 1))] || ' — lot ' || (i + 1),
      'Community auction. Local pickup, cash or Bubaly pay. [seed:auction]',
      'sell', cats[1 + (i % array_length(cats, 1))],
      (array['new','like_new','good','fair'])[1 + (i % 4)],
      0, 'available', 'auction', ends, start_cents,
      case when i % 3 = 0 then start_cents * 3 else null end,          -- reserve on 1/3
      case when i % 4 = 0 then start_cents * 5 else null end,          -- buy-now on 1/4
      2, v_user, now() - ((i % 48) || ' hours')::interval
    );

    -- Bid ladder: alternating bidders, each a valid increment up. Most lots are
    -- hotly contested (4–14 bids); every 8th lot has none, to exercise the
    -- "no bids yet" state. ~470 bids + 60 lots ≈ 530 rows total.
    bidders := case when i % 8 = 0 then 0 else 4 + (i % 11) end;
    cur := start_cents;
    for b in 1..bidders loop
      bidder := v_bmem[1 + (b % 2)];
      cur := cur + case
        when cur < 500 then 25 when cur < 2500 then 50 when cur < 10000 then 100
        when cur < 25000 then 250 else 500 end;
      insert into public.marketplace_bids
        (listing_id, family_id, bidder_member_id, bidder_family_id, amount_cents, max_cents, status, created_at)
      values (lot, v_family, bidder, v_bfam, cur, cur + 500,
        case when b = bidders then 'active' else 'outbid' end,
        now() - ((bidders - b) || ' minutes')::interval);
    end loop;

    if bidders > 0 then
      update public.marketplace_listings set
        current_bid_cents = cur, bid_count = bidders,
        highest_bidder_member_id = v_bmem[1 + (bidders % 2)],
        highest_bidder_family_id = v_bfam,
        highest_max_cents = cur + 500
      where id = lot;
    end if;
  end loop;

  raise notice 'Seeded % auctions + bids for family %', n_lots, v_family;
end $$;

-- Verify:
--   select count(*) from marketplace_listings where description like '%[seed:auction]%' and sale_format='auction';  -- 60
--   select count(*) from marketplace_bids b join marketplace_listings l on l.id=b.listing_id where l.description like '%[seed:auction]%';
--   select status, count(*) from marketplace_listings where sale_format='auction' group by 1;
