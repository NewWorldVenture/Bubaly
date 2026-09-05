-- ============================================================================
-- Bubaly · SEED — Marketplace (marketplace_listings 500 + offers 500).
-- Buy / sell / rent / borrow / free / wanted listings across every category and
-- status, each with an offer, so /dashboard/marketplace renders at real volume.
-- Idempotent: seed rows carry description='[seed]'; deleting the listings
-- cascades their offers (FK ON DELETE CASCADE).
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  n int := 500;
  titles text[] := array['Kids'' bike','Winter coat (age 8)','Board game bundle','Bluetooth speaker','Toddler crib',
                         'Soccer cleats','Drill + bits','Baby monitor','Nintendo Switch','Dining chairs',
                         'Lego city set','Rain boots','Textbook set','Camping tent','Stroller'];
  kinds  text[] := array['sell','rent','borrow','free','wanted'];
  cats   text[] := array['toys','clothing','books','electronics','furniture','sports','tools','baby','games','other'];
  conds  text[] := array['new','like_new','good','fair','worn'];
  stats  text[] := array['available','available','pending','claimed','completed','withdrawn'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  delete from public.marketplace_listings where family_id = v_family and description = '[seed]';

  insert into public.marketplace_listings
    (family_id, member_id, title, description, kind, category, condition, price_cents, status, location, photo_url, created_at)
  select v_family,
    case when v_members is null then null else v_members[1 + (g.i % array_length(v_members,1))] end,
    titles[1 + (g.i % array_length(titles,1))] || ' #' || g.i,
    '[seed]',
    kinds[1 + (g.i % array_length(kinds,1))],
    cats[1 + (g.i % array_length(cats,1))],
    conds[1 + (g.i % array_length(conds,1))],
    (g.i % 6) * 500,
    stats[1 + (g.i % array_length(stats,1))],
    (array['Home','Garage','Attic','Neighborhood','Storage'])[1 + (g.i % 5)],
    'https://picsum.photos/seed/mkt' || g.i || '/600/450',
    now() - ((g.i % 200) || ' days')::interval
  from generate_series(1, n) as g(i);

  -- One offer per seed listing (interest / claim / offer).
  insert into public.marketplace_offers (family_id, listing_id, member_id, kind, amount_cents, message, status)
  select v_family, l.id,
    case when v_members is null then null else v_members[1 + ((row_number() over (order by l.created_at))::int % array_length(v_members,1))] end,
    (array['interest','claim','offer'])[1 + ((row_number() over (order by l.created_at))::int % 3)],
    ((row_number() over (order by l.created_at))::int % 6) * 400,
    '[seed] Interested — is this still available?',
    (array['open','open','accepted','declined','withdrawn'])[1 + ((row_number() over (order by l.created_at))::int % 5)]
  from public.marketplace_listings l
  where l.family_id = v_family and l.description = '[seed]';

  raise notice 'Marketplace seeded % listings + offers for family %', n, v_family;
end $$;
