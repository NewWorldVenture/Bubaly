-- ============================================================================
-- FamilyOS · SEED — Community Circles (500 records).
-- Makes the cross-family marketplace REAL for testing: 4 partner families
-- (fixed ids, created only if missing), 6 circles (fixed ids + friendly join
-- codes), 30 circle memberships (your family + all 4 partners in every circle),
-- 120 partner listings tagged [seed:circles], and 344 shares — so /marketplace/
-- community shows genuinely cross-family feeds at volume (6+30+120+344 = 500).
-- Idempotent: clears its own circles (cascades memberships/shares) and tagged
-- listings first; partner families are create-if-missing and never deleted.
-- Resolves your family by email. (Needs migrations 0120 + 0173.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email    text := 'newworldventurellc@gmail.com';
  v_family   uuid;
  v_fam_name text;
  partners   uuid[] := array[
    'cc111111-1111-1111-1111-111111111111'::uuid,
    'cc222222-2222-2222-2222-222222222222'::uuid,
    'cc333333-3333-3333-3333-333333333333'::uuid,
    'cc444444-4444-4444-4444-444444444444'::uuid];
  pnames     text[] := array['The Riverside Family','The Okafor-Lees','The Marches','The Delgados'];
  circles    uuid[] := array[
    'dd111111-1111-1111-1111-111111111111'::uuid,
    'dd222222-2222-2222-2222-222222222222'::uuid,
    'dd333333-3333-3333-3333-333333333333'::uuid,
    'dd444444-4444-4444-4444-444444444444'::uuid,
    'dd555555-5555-5555-5555-555555555555'::uuid,
    'dd666666-6666-6666-6666-666666666666'::uuid];
  cnames     text[] := array['Maple Street','Room 14 Parents','Ravens Soccer','Lakeside Swap','Scout Troop 42','Cousins Circle'];
  cemojis    text[] := array['🏡','🏫','⚽','🛶','🏕️','👨‍👩‍👧‍👦'];
  ccodes     text[] := array['MAPLESTC','ROOMFOUR','RAVENSFC','LAKESWAP','TROOPFRT','COUSINSC'];
  cats       text[] := array['toys','clothing','books','electronics','furniture','sports','tools','baby','games','other'];
  conds      text[] := array['new','like_new','good','fair','worn'];
  nouns      text[] := array['bundle','set','pair','lot','kit','collection'];
  listing_ids uuid[] := '{}';
  v_lid      uuid;
  n_listings int := 120;
  n_shares   int := 344;
  i          int;
  pf         uuid;
  cid        uuid;
  price      int;
begin
  if to_regclass('public.marketplace_circles') is null then
    raise notice 'marketplace_circles not present — apply migration 0173 first. Skipping.';
    return;
  end if;

  select f.id, f.name into v_family, v_fam_name
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then
    select id, name into v_family, v_fam_name from public.families order by created_at limit 1;
  end if;
  if v_family is null then raise exception 'No families found.'; end if;

  -- Partner families (create-if-missing; never deleted).
  for i in 1..array_length(partners, 1) loop
    insert into public.families (id, name, timezone)
    values (partners[i], pnames[i], 'UTC')
    on conflict (id) do nothing;
  end loop;

  -- Clear this seed's prior circles (memberships + shares cascade) + listings.
  delete from public.marketplace_circles where id = any(circles);
  delete from public.marketplace_listings
   where family_id = any(partners) and description like '%[seed:circles]%';

  -- Circles (6) + memberships (30 = your family + all 4 partners in each).
  for i in 1..array_length(circles, 1) loop
    insert into public.marketplace_circles (id, name, emoji, join_code, created_by_family)
    values (circles[i], cnames[i], cemojis[i], ccodes[i],
            case when i % 2 = 0 then v_family else partners[1 + (i % 4)] end);

    insert into public.marketplace_circle_members (circle_id, family_id, family_name, role)
    values (circles[i], v_family, coalesce(v_fam_name, 'Your family'),
            case when i % 2 = 0 then 'owner' else 'member' end);
  end loop;
  -- Partner memberships: every partner in every circle (24 rows), founder = owner.
  for i in 1..24 loop
    cid := circles[1 + ((i - 1) % 6)];
    pf  := partners[1 + ((i - 1) / 6)];
    insert into public.marketplace_circle_members (circle_id, family_id, family_name, role)
    values (cid, pf, pnames[1 + ((i - 1) / 6)],
            case when pf = (select created_by_family from public.marketplace_circles c where c.id = cid)
                 then 'owner' else 'member' end)
    on conflict (circle_id, family_id) do nothing;
  end loop;

  -- Partner listings (120) — realistic cross-family supply.
  for i in 1..n_listings loop
    pf    := partners[1 + (i % 4)];
    price := (3 + (i * 11) % 140) * 100;
    insert into public.marketplace_listings
      (family_id, title, description, kind, category, condition, price_cents, status, location, created_at)
    values
      (pf,
       initcap(cats[1 + (i % 10)]) || ' ' || nouns[1 + (i % 6)] || ' · ' || pnames[1 + (i % 4)] || ' #' || i,
       'Shared with the circle — message to arrange pickup. [seed:circles]',
       (array['sell','sell','sell','free','rent'])[1 + (i % 5)],
       cats[1 + (i % 10)], conds[1 + (i % 5)],
       case when (1 + (i % 5)) = 4 then 0 else price end,
       'available',
       'Front porch',
       now() - make_interval(days => i % 30, hours => i % 9))
    returning id into v_lid;
    listing_ids := listing_ids || v_lid;
  end loop;

  -- Shares (350): every partner listing into 2 circles (240), then the first
  -- 110 into a third — unique(listing_id, circle_id) holds by construction.
  for i in 1..n_listings loop
    v_lid := listing_ids[i];
    pf    := partners[1 + (i % 4)];
    insert into public.marketplace_listing_shares (listing_id, circle_id, family_id)
    values (v_lid, circles[1 + (i % 6)], pf),
           (v_lid, circles[1 + ((i + 2) % 6)], pf);
  end loop;
  for i in 1..(n_shares - 2 * n_listings) loop
    v_lid := listing_ids[i];
    pf    := partners[1 + (i % 4)];
    insert into public.marketplace_listing_shares (listing_id, circle_id, family_id)
    values (v_lid, circles[1 + ((i + 4) % 6)], pf)
    on conflict (listing_id, circle_id) do nothing;
  end loop;

  raise notice 'Seeded circles: 6 circles, 24 memberships, % partner listings, ~% shares for family %.',
    n_listings, n_shares, v_family;
end $$;
