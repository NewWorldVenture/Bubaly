// Paste-ready SQL that seeds the Family Marketplace with 500+ realistic test
// listings (plus offers) so every feature — filters, kinds, statuses, the
// owner offer-review flow, claim/complete — can be exercised with real data.
//
// This string is the single source of truth: it is both rendered on the in-app
// "Seed test data" screen (with a Copy button) and kept here for reference. It
// runs in the Supabase SQL editor (service role → bypasses RLS). Safe to re-run:
// it fully re-seeds the marketplace for the chosen family each time.

export const MARKETPLACE_SEED_SQL = String.raw`-- ============================================================================
-- Bubaly · Marketplace test seed — 500 listings (+ offers)
-- Where: Supabase Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run: it deletes THIS family's existing marketplace rows first,
-- then inserts a fresh 500. It only touches the family resolved below.
-- ============================================================================
do $$
declare
  -- ▼▼ change this to seed a different account (the owner's login email) ▼▼
  v_email    text := 'newworldventurellc@gmail.com';
  n_listings int  := 500;

  v_family   uuid;
  v_members  uuid[];
  v_member   uuid;
  v_listing  uuid;
  v_kind     text;
  v_status   text;
  v_price    int;
  v_claimed  uuid;
  n_off      int;
  i          int;

  kinds      text[] := array['sell','sell','sell','rent','borrow','free','wanted'];
  categories text[] := array['toys','clothing','books','electronics','furniture','sports','tools','baby','games','other'];
  conditions text[] := array['new','like_new','good','fair','worn'];
  periods    text[] := array['hour','day','week','month'];
  statuses   text[] := array['available','available','available','available','pending','claimed','completed'];
  adjs       text[] := array['Vintage','Barely-used','Kids','Wooden','Portable','Deluxe','Compact','Retro','Handmade','Sturdy','Cozy','Bright','Classic','Mini'];
  nouns      text[] := array['bike','bookshelf','stroller','board game','tool set','jacket','desk lamp','soccer ball','puzzle','tablet','crib','tent','guitar','skateboard','high chair','camera','ladder','kettle','scooter','bassinet'];
  places     text[] := array['Garage','Attic','Closet','Basement','Kids room','Kitchen','Shed'];
  messages   text[] := array['Is this still available?','I''d love this!','Can I pick up this weekend?','Would you take a little less?','Perfect for us — dibs!'];
begin
  -- Resolve the target family from the email; fall back to the first family.
  select f.id into v_family
  from public.families f
  join public.family_members m on m.family_id = f.id
  join auth.users u on u.id = m.user_id
  where lower(u.email) = lower(v_email)
  limit 1;

  if v_family is null then
    select id into v_family from public.families order by created_at limit 1;
  end if;
  if v_family is null then
    raise exception 'No families found — create a family first.';
  end if;

  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  if v_members is null or array_length(v_members, 1) = 0 then
    raise exception 'Family % has no members.', v_family;
  end if;

  -- Idempotent reseed: clear this family's marketplace, then repopulate.
  delete from public.marketplace_offers   where family_id = v_family;
  delete from public.marketplace_listings where family_id = v_family;

  for i in 1..n_listings loop
    v_kind   := kinds[1 + floor(random() * array_length(kinds, 1))::int];
    v_status := statuses[1 + floor(random() * array_length(statuses, 1))::int];
    v_member := v_members[1 + floor(random() * array_length(v_members, 1))::int];
    v_price  := case when v_kind in ('sell','rent') then (100 + floor(random() * 20000))::int else 0 end;
    v_claimed := case when v_status in ('claimed','completed')
                      then v_members[1 + floor(random() * array_length(v_members, 1))::int] else null end;

    insert into public.marketplace_listings
      (family_id, member_id, title, description, kind, category, condition,
       price_cents, rent_period, location, status, claimed_by, claimed_at, created_at)
    values
      (v_family, v_member,
       adjs[1 + floor(random() * array_length(adjs, 1))::int] || ' ' ||
         nouns[1 + floor(random() * array_length(nouns, 1))::int] || ' #' || i,
       'Auto-seeded test listing #' || i || ' for QA — great condition.',
       v_kind,
       categories[1 + floor(random() * array_length(categories, 1))::int],
       case when v_kind = 'wanted' then null
            else conditions[1 + floor(random() * array_length(conditions, 1))::int] end,
       v_price,
       case when v_kind = 'rent' then periods[1 + floor(random() * array_length(periods, 1))::int] else null end,
       places[1 + floor(random() * array_length(places, 1))::int],
       v_status, v_claimed,
       case when v_status in ('claimed','completed') then now() - (random() * 30 || ' days')::interval else null end,
       now() - (random() * 60 || ' days')::interval)
    returning id into v_listing;

    -- Offers: every 'pending' listing gets 1–3; ~35% of 'available' get 1–2.
    if v_status = 'pending' then
      n_off := 1 + floor(random() * 3)::int;
    elsif v_status = 'available' and random() < 0.35 then
      n_off := 1 + floor(random() * 2)::int;
    else
      n_off := 0;
    end if;

    if n_off > 0 then
      insert into public.marketplace_offers (family_id, listing_id, member_id, kind, message, status)
      select v_family, v_listing,
             v_members[1 + floor(random() * array_length(v_members, 1))::int],
             (array['interest','claim','offer'])[1 + floor(random() * 3)::int],
             messages[1 + floor(random() * array_length(messages, 1))::int],
             'open'
      from generate_series(1, n_off);
    end if;
  end loop;

  raise notice 'Marketplace seed complete: % listings for family %', n_listings, v_family;
end $$;

-- Verify:
--   select status, count(*) from public.marketplace_listings group by status order by 1;
--   select count(*) as offers from public.marketplace_offers;
`;
