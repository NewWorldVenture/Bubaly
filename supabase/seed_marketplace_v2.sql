-- ============================================================================
-- FamilyOS · SEED — Marketplace V2 (1,200+ records).
-- Fills the AI-first marketplace so every V2 surface renders at volume:
--   • a storefront per family member (+ follows between members)
--   • 6 curated collections with ~150 items
--   • 300 saves (♥), 300 orders (status spread), ~500 two-sided reviews
-- Requires the marketplace listings seed first (seed_marketplace.sql) and
-- migration 0151. Idempotent: stores upsert; follows/saves insert-once via their
-- unique keys; seed orders/reviews/collections carry a '[seed]' marker and are
-- cleared before re-insert. Resolves the family by email.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email    text := 'newworldventurellc@gmail.com';
  v_family   uuid;
  v_members  uuid[];
  v_listings uuid[];
  v_prices   bigint[];
  v_kinds    text[];
  v_stores   uuid[];
  nm int; nl int;
  store_names text[] := array['Style Corner','Outdoor Hub','Baby Gear Co.','Tech Finds','The Book Nook','Game Shelf','Handy House','Little Loft'];
  store_emoji text[] := array['👗','🏕️','🍼','📱','📚','🎲','🔧','🧸'];
  coll_names  text[] := array['Wedding Guest Dresses','Camping Gear Rentals','Baby Essentials to Borrow','Summer Vibes Favorites','Back to School','Game Night'];
  coll_emoji  text[] := array['💃','⛺','🍼','🌞','🎒','🎲'];
  coll_ids    uuid[] := array[]::uuid[];
  cid uuid;
  i int;
begin
  if to_regclass('public.marketplace_stores') is null then
    raise notice 'marketplace V2 tables not present — apply migration 0151 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select array_agg(id) into v_members from public.family_members where family_id = v_family and is_active;
  nm := coalesce(array_length(v_members, 1), 0);
  if nm = 0 then raise exception 'No members in family %', v_family; end if;

  select array_agg(id), array_agg(price_cents), array_agg(kind)
    into v_listings, v_prices, v_kinds
  from (select id, price_cents, kind from public.marketplace_listings
        where family_id = v_family order by created_at limit 400) s;
  nl := coalesce(array_length(v_listings, 1), 0);
  if nl = 0 then
    raise notice 'No marketplace listings — run seed_marketplace.sql first. Skipping.';
    return;
  end if;

  -- ── Stores: one per member (upsert; names cycle) ──────────────────────────
  for i in 1..nm loop
    insert into public.marketplace_stores (family_id, member_id, name, tagline, emoji, is_active)
    values (v_family, v_members[i], store_names[1 + ((i - 1) % 8)],
            'Quality finds from the family. [seed]', store_emoji[1 + ((i - 1) % 8)], true)
    on conflict (family_id, member_id) do update set is_active = true;
  end loop;
  select array_agg(id) into v_stores from public.marketplace_stores where family_id = v_family;

  -- ── Follows: every member follows every other member's store ─────────────
  insert into public.marketplace_follows (family_id, store_id, member_id)
  select v_family, s.id, m.mid
  from public.marketplace_stores s
  cross join (select unnest(v_members) mid) m
  where s.family_id = v_family and s.member_id <> m.mid
  on conflict (store_id, member_id) do nothing;

  -- ── Collections (marker-cleared) + ~25 items each ─────────────────────────
  delete from public.marketplace_collections where family_id = v_family and description like '%[seed]%';
  for i in 1..6 loop
    insert into public.marketplace_collections (family_id, name, emoji, description)
    values (v_family, coll_names[i], coll_emoji[i], 'Curated from the family board. [seed]')
    returning id into cid;
    coll_ids := coll_ids || cid;
    insert into public.marketplace_collection_items (family_id, collection_id, listing_id)
    select v_family, cid, v_listings[1 + (((i - 1) * 25 + g.n) % nl)]
    from generate_series(0, 24) g(n)
    on conflict (collection_id, listing_id) do nothing;
  end loop;

  -- ── Saves: 300 deterministic member×listing pairs ─────────────────────────
  insert into public.marketplace_saves (family_id, listing_id, member_id)
  select v_family, v_listings[1 + (g.i % nl)], v_members[1 + ((g.i / 7) % nm)]
  from generate_series(0, 299) g(i)
  on conflict (listing_id, member_id) do nothing;

  -- ── Orders: 300 with a status spread (marker-cleared) ─────────────────────
  delete from public.marketplace_reviews where family_id = v_family and comment like '%[seed]%';
  delete from public.marketplace_orders where family_id = v_family and notes like '%[seed]%';

  insert into public.marketplace_orders
    (family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents, notes, created_at)
  select
    v_family,
    v_listings[1 + (g.i % nl)],
    v_members[1 + (g.i % nm)],
    v_members[1 + ((g.i + 1) % nm)],
    case coalesce(v_kinds[1 + (g.i % nl)], 'sell')
      when 'sell' then 'buy' when 'rent' then 'rent' when 'borrow' then 'borrow'
      when 'swap' then 'swap' when 'donate' then 'donate' else 'free' end,
    (array['requested','confirmed','active','completed','completed'])[1 + (g.i % 5)],
    coalesce(v_prices[1 + (g.i % nl)], 0),
    'Family exchange. [seed]',
    now() - ((g.i * 3) || ' hours')::interval
  from generate_series(0, 299) g(i);

  -- ── Reviews: both sides of every completed seed order (~240) ─────────────
  insert into public.marketplace_reviews
    (family_id, order_id, listing_id, reviewer_member, reviewee_member, role, rating, comment, created_at)
  select v_family, o.id, o.listing_id, o.buyer_member, o.seller_member, 'buyer',
         3 + (abs(hashtext(o.id::text)) % 3),
         'Smooth hand-off, great condition. [seed]', o.created_at + interval '1 day'
  from public.marketplace_orders o
  where o.family_id = v_family and o.status = 'completed' and o.notes like '%[seed]%'
  on conflict do nothing;

  insert into public.marketplace_reviews
    (family_id, order_id, listing_id, reviewer_member, reviewee_member, role, rating, comment, created_at)
  select v_family, o.id, o.listing_id, o.seller_member, o.buyer_member, 'seller',
         4 + (abs(hashtext(o.id::text)) % 2),
         'Easy to coordinate with — would trade again. [seed]', o.created_at + interval '1 day'
  from public.marketplace_orders o
  where o.family_id = v_family and o.status = 'completed' and o.notes like '%[seed]%'
    and o.buyer_member is distinct from o.seller_member
  on conflict do nothing;

  -- ── Standalone listing reviews for rating spread (~260) ───────────────────
  insert into public.marketplace_reviews
    (family_id, order_id, listing_id, reviewer_member, reviewee_member, role, rating, comment, created_at)
  select v_family, null, v_listings[1 + (g.i % nl)],
         v_members[1 + (g.i % nm)], v_members[1 + ((g.i + 1) % nm)],
         (array['buyer','seller'])[1 + (g.i % 2)],
         3 + (g.i % 3),
         'Exactly as described. [seed]',
         now() - ((g.i * 5) || ' hours')::interval
  from generate_series(0, 259) g(i);

  raise notice 'Marketplace V2 seeded: % stores, follows, 6 collections (+items), 300 saves, 300 orders, ~500 reviews for family %', nm, v_family;
end $$;

-- Verify:
--   select count(*) from marketplace_orders where notes like '%[seed]%';     -- 300
--   select count(*) from marketplace_reviews where comment like '%[seed]%';  -- ~500
--   select count(*) from marketplace_saves;                                  -- ≥ 250
--   select status, count(*) from marketplace_orders group by status;
