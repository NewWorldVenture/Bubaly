-- ============================================================================
-- seed_closet_one_family.sql — Closet & Outfits demo data for ONE family (TODO-0407)
-- ----------------------------------------------------------------------------
-- WHAT IT SEEDS (250 rows per table, spread across every family member):
--   • wardrobe_items — 250 garments: tops, bottoms, dresses, outerwear, shoes,
--                      accessories, activewear, sleepwear with warmth/formality/
--                      seasons, sizes, brands, prices, wear counts, statuses
--                      (mostly active; some laundry / storage / outgrown / donated)
--   • outfits        — 250 saved outfits (3 real items each, same member),
--                      occasions + temperature bands, favourites + ratings
--   • outfit_logs    — 250 days of "what was worn", one per day, with weather
--
-- TARGET FAMILY: resolved at runtime (v_email's family → first family). Change
--   v_email if needed. Members are whatever the family has (needs ≥ 1).
-- IDEMPOTENT: every seeded row carries notes = '[seed:closet]' and is deleted
--   (this family only) before re-insert.
-- HOW TO RUN: npm run db:seed:closet   (or paste into the Supabase SQL editor)
-- REQUIRES: migration 0240_closet_outfits.sql
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_members uuid[];
  m_count   int;
  n         int := 250;
  tops      text[] := array['White tee','Navy polo','Striped long-sleeve','Grey hoodie','Denim shirt','Black turtleneck','Linen button-up','Graphic tee','Cream sweater','Flannel shirt','Cardigan','Henley'];
  bottoms   text[] := array['Blue jeans','Black joggers','Khaki chinos','Denim shorts','Grey trousers','Corduroys','Cargo pants','Leggings','Pleated skirt','Track pants'];
  dresses   text[] := array['Sundress','Wrap dress','School jumper','Knit dress','Party dress','Romper'];
  outer     text[] := array['Rain jacket','Puffer coat','Denim jacket','Wool coat','Fleece zip-up','Windbreaker','Trench coat'];
  shoes     text[] := array['White sneakers','Rain boots','Sandals','Leather loafers','Running shoes','Winter boots','Ballet flats','Hiking shoes'];
  accs      text[] := array['Beanie','Baseball cap','Scarf','Sunglasses','Belt','Backpack','Mittens'];
  active_w  text[] := array['Soccer jersey','Yoga top','Swim shorts','Training tee','Cycling jersey'];
  sleep_w   text[] := array['Flannel pyjamas','Cotton PJ set','Nightgown','Sleep shorts set'];
  colors    text[] := array['white','navy','black','grey','olive','blue','red','cream','tan','pink','forest','burgundy'];
  sizes     text[] := array['XS','S','M','L','XL','4T','6','8','10','12','14','32x30'];
  brands    text[] := array['Uniqlo','Gap','H&M','Nike','Zara','Patagonia','Old Navy','Target','Levi''s','Carter''s','Columbia','Adidas'];
  cats      text[] := array['top','top','bottom','bottom','dress','outerwear','shoes','accessory','activewear','sleepwear'];
  occasions text[] := array['everyday','school','work','sport','dressy','party','outdoor','everyday'];
  weathers  text[] := array['sunny','cloudy','rain','windy','snow','mild','hot','cool'];
  cat       text;
  nm        text;
  warm      int;
  form      int;
  seas      text[];
  stat      text;
  mem       uuid;
  ids       uuid[];
  outfit_id uuid;
  i         int;
begin
  if to_regclass('public.wardrobe_items') is null then
    raise notice 'wardrobe_items not present — apply migration 0240 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select array_agg(id order by created_at) into v_members from public.family_members where family_id = v_family and is_active;
  m_count := coalesce(array_length(v_members, 1), 0);
  if m_count = 0 then raise exception 'Family % has no active members.', v_family; end if;
  select fm.user_id into v_user from public.family_members fm where fm.family_id = v_family and fm.user_id is not null order by fm.created_at limit 1;

  delete from public.outfit_logs where family_id = v_family and notes = '[seed:closet]';
  delete from public.outfits where family_id = v_family and notes = '[seed:closet]';
  delete from public.wardrobe_items where family_id = v_family and notes = '[seed:closet]';

  -- 1) 250 wardrobe items --------------------------------------------------
  for i in 1..n loop
    cat := cats[1 + (i % array_length(cats, 1))];
    mem := v_members[1 + (i % m_count)];
    nm := case cat
      when 'top' then tops[1 + (i % array_length(tops, 1))]
      when 'bottom' then bottoms[1 + (i % array_length(bottoms, 1))]
      when 'dress' then dresses[1 + (i % array_length(dresses, 1))]
      when 'outerwear' then outer[1 + (i % array_length(outer, 1))]
      when 'shoes' then shoes[1 + (i % array_length(shoes, 1))]
      when 'accessory' then accs[1 + (i % array_length(accs, 1))]
      when 'activewear' then active_w[1 + (i % array_length(active_w, 1))]
      else sleep_w[1 + (i % array_length(sleep_w, 1))] end;
    warm := case cat when 'outerwear' then 3 + (i % 3) when 'dress' then 1 + (i % 2) when 'activewear' then 1 + (i % 2) else 1 + (i % 5) end;
    form := case cat when 'activewear' then 1 when 'sleepwear' then 1 when 'dress' then 3 + (i % 3) else 1 + ((i * 7) % 5) end;
    seas := case (i % 5)
      when 0 then array['spring','summer']
      when 1 then array['fall','winter']
      when 2 then array['summer']
      when 3 then array['winter']
      else array[]::text[] end;
    stat := case
      when i % 20 = 0 then 'laundry'
      when i % 25 = 0 then 'storage'
      when i % 33 = 0 then 'outgrown'
      when i % 50 = 0 then 'donated'
      else 'active' end;
    insert into public.wardrobe_items (family_id, member_id, name, category, color, size, brand, warmth, formality, seasons, status,
      purchased_on, price_cents, wear_count, last_worn_on, notes, created_by)
    values (v_family, mem, nm || case when i > 60 then ' #' || ((i / 60) + 1) else '' end, cat,
      colors[1 + (i % array_length(colors, 1))], sizes[1 + ((i * 3) % array_length(sizes, 1))], brands[1 + ((i * 5) % array_length(brands, 1))],
      warm, form, seas, stat,
      current_date - ((i * 13) % 900), 800 + ((i * 371) % 9000), (i * 7) % 45,
      case when (i * 7) % 45 = 0 then null else current_date - ((i * 11) % 200) end,
      '[seed:closet]', v_user);
  end loop;

  -- 2) 250 outfits (3 real active items of the same member) ------------------
  -- Indexed pick table: (member, slot, rn) → item id, so each outfit is three
  -- O(log n) lookups instead of sorted subqueries.
  create temp table tmp_closet_picks on commit drop as
    select member_id,
           case when category in ('top','dress','activewear') then 'top' when category = 'bottom' then 'bottom' else 'shoes' end as slot,
           id,
           row_number() over (partition by member_id, case when category in ('top','dress','activewear') then 'top' when category = 'bottom' then 'bottom' else 'shoes' end order by created_at, id) as rn,
           count(*) over (partition by member_id, case when category in ('top','dress','activewear') then 'top' when category = 'bottom' then 'bottom' else 'shoes' end) as cnt
    from public.wardrobe_items
    where family_id = v_family and notes = '[seed:closet]' and status = 'active' and category in ('top','dress','activewear','bottom','shoes');
  create index on tmp_closet_picks (member_id, slot, rn);

  for i in 1..n loop
    mem := v_members[1 + (i % m_count)];
    select array_remove(array[
      (select id from tmp_closet_picks p where p.member_id = mem and p.slot = 'top' and p.rn = 1 + ((i * 7) % p.cnt) limit 1),
      (select id from tmp_closet_picks p where p.member_id = mem and p.slot = 'bottom' and p.rn = 1 + ((i * 11) % p.cnt) limit 1),
      (select id from tmp_closet_picks p where p.member_id = mem and p.slot = 'shoes' and p.rn = 1 + ((i * 13) % p.cnt) limit 1)
    ], null) into ids;
    insert into public.outfits (family_id, member_id, name, occasion, item_ids, temp_min_c, temp_max_c, rating, is_favorite, notes, created_by)
    values (v_family, mem,
      occasions[1 + (i % array_length(occasions, 1))] || ' look ' || i,
      occasions[1 + (i % array_length(occasions, 1))],
      coalesce(ids, array[]::uuid[]),
      -5 + ((i * 3) % 30), 3 + ((i * 3) % 30),
      case when i % 3 = 0 then null else 2 + (i % 4) end,
      (i % 9 = 0), '[seed:closet]', v_user);
  end loop;

  -- 3) 250 outfit logs — one per day going back --------------------------------
  create temp table tmp_closet_outfits on commit drop as
    select member_id, id, item_ids,
           row_number() over (partition by member_id order by created_at, id) as rn,
           count(*) over (partition by member_id) as cnt
    from public.outfits where family_id = v_family and notes = '[seed:closet]';
  create index on tmp_closet_outfits (member_id, rn);

  for i in 1..n loop
    mem := v_members[1 + (i % m_count)];
    select o.id, o.item_ids into outfit_id, ids from tmp_closet_outfits o where o.member_id = mem and o.rn = 1 + ((i * 5) % o.cnt) limit 1;
    insert into public.outfit_logs (family_id, member_id, outfit_id, worn_on, item_ids, occasion, temp_c, weather, notes, created_by)
    values (v_family, mem, outfit_id, current_date - i, coalesce(ids, array[]::uuid[]),
      occasions[1 + (i % array_length(occasions, 1))],
      round(18 + 12 * sin((i::float / 365.0) * 2 * pi()) + ((i * 7) % 6) - 3)::int,
      weathers[1 + (i % array_length(weathers, 1))], '[seed:closet]', v_user);
  end loop;

  raise notice 'Closet seeded: % items, % outfits, % outfit logs for family % (% members)', n, n, n, v_family, m_count;
end $$;
