-- ============================================================================
-- FamilyOS · SEED — Marketplace price history + drop watch (~580 rows).
-- Fills the price-history surface on the item page: 130 fixed-price sale
-- listings, each with a 2–4 step DECLINING price ladder (so the item page shows
-- "Price dropped X%", "Lowest ever", and the history list), plus ~65 watcher
-- saves so the drop-notify path has an audience. History rows are inserted
-- directly (the live trigger fires on listing UPDATEs, not on these inserts),
-- so the seed is fully deterministic. Watchers are a throwaway family.
-- Idempotent: clears its own '[seed:pricehist]' rows first. Resolves family by
-- email. (Needs migrations 0151 + 0191.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_owner  uuid;
  v_user   uuid;
  v_wfam   uuid;
  v_wmem   uuid;
  n_lots   int := 130;
  titles   text[] := array[
    'Road bike','Baby stroller','Standing desk','Espresso machine','Ski set',
    'Guitar + amp','Bookshelf','Drone 4K','Lego set','Patio set',
    'Sewing machine','Camping tent','Monitor 27"','Kids'' bike','Rowing machine'];
  cats     text[] := array['sports','baby','furniture','electronics','other','games'];
  lot      uuid;
  base     bigint;
  steps    int;
  prev     bigint;
  nextp    bigint;
  t0       timestamptz;
  k        int;
begin
  if to_regclass('public.marketplace_price_history') is null then
    raise notice 'marketplace_price_history not present — apply migration 0191 first. Skipping.';
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

  -- Throwaway watcher family + member (stable ids).
  insert into public.families (id, name) values ('a0000000-0000-4000-8000-00000000fb01', 'Price Watchers')
    on conflict (id) do nothing;
  v_wfam := 'a0000000-0000-4000-8000-00000000fb01';
  insert into public.family_members (id, family_id, role, display_name, is_active)
    values ('a0000000-0000-4000-8000-00000000fb11', v_wfam, 'parent', 'Watcher Wendy', true)
    on conflict (id) do nothing;
  v_wmem := 'a0000000-0000-4000-8000-00000000fb11';

  -- Clean prior seed in dependency order (history + saves → listings).
  delete from public.marketplace_price_history h using public.marketplace_listings l
    where h.listing_id = l.id and l.description like '%[seed:pricehist]%';
  delete from public.marketplace_saves s using public.marketplace_listings l
    where s.listing_id = l.id and l.description like '%[seed:pricehist]%';
  delete from public.marketplace_listings where family_id = v_family and description like '%[seed:pricehist]%';

  for i in 0..(n_lots - 1) loop
    base  := 4000 + (i % 20) * 400;      -- current asking $40–$116
    steps := 2 + (i % 3);                -- 2–4 price cuts
    t0    := now() - ((steps + 1) || ' days')::interval;
    lot   := gen_random_uuid();

    insert into public.marketplace_listings
      (id, family_id, member_id, title, description, kind, category, condition, price_cents, status, created_by, created_at)
    values (lot, v_family, v_owner,
      titles[1 + (i % array_length(titles, 1))] || ' — pd' || (i + 1),
      'Priced to move — recently reduced. [seed:pricehist]', 'sell',
      cats[1 + (i % array_length(cats, 1))],
      (array['new','like_new','good','fair'])[1 + (i % 4)],
      base, 'available', v_user, now() - ((i % 25) || ' days')::interval);

    -- Descending ladder ending at the current `base`: each older price was ~12% higher.
    prev := round(base * power(1.12, steps));
    for k in 1..steps loop
      nextp := case when k = steps then base else round(base * power(1.12, steps - k)) end;
      insert into public.marketplace_price_history (listing_id, family_id, old_cents, new_cents, changed_at)
      values (lot, v_family, prev, nextp, t0 + ((k) || ' days')::interval);
      prev := nextp;
    end loop;

    -- Every other listing has a watcher (♥) so drops have an audience.
    if i % 2 = 0 then
      insert into public.marketplace_saves (family_id, listing_id, member_id)
      values (v_wfam, lot, v_wmem) on conflict (listing_id, member_id) do nothing;
    end if;
  end loop;

  raise notice 'Seeded % price-tracked listings (+history +watchers) for family %', n_lots, v_family;
end $$;

-- Verify:
--   select count(*) from marketplace_listings where description like '%[seed:pricehist]%';               -- 130
--   select count(*) from marketplace_price_history h join marketplace_listings l on l.id=h.listing_id
--     where l.description like '%[seed:pricehist]%';                                                      -- ~390
--   select count(*) from marketplace_saves s join marketplace_listings l on l.id=s.listing_id
--     where l.description like '%[seed:pricehist]%';                                                      -- ~65
--   -- every ladder ends at the listing's current price:
--   select count(*) from marketplace_listings l where l.description like '%[seed:pricehist]%'
--     and l.price_cents <> (select new_cents from marketplace_price_history h
--       where h.listing_id=l.id order by changed_at desc limit 1);                                        -- 0
