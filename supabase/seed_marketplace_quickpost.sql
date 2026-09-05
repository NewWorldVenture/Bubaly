-- ============================================================================
-- Bubaly · SEED — Quick-Post comparables (500 records).
-- Fills marketplace_listings with priced SELL comparables across all 10
-- categories × 5 conditions with realistic per-category price bands, so the
-- "Post in 60 seconds" AI price suggestion (lib/marketplace/quick-post.ts —
-- category median normalized by condition) has dense, believable comps to
-- reason over at volume. Also exercises the browse board at scale.
-- Idempotent: tags rows with '[seed:quickpost]' in the description and clears
-- its own rows first. Resolves family by email. (Needs migration 0120.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_member  uuid;
  cats      text[] := array['toys','clothing','books','electronics','furniture','sports','tools','baby','games','other'];
  -- Per-category base price bands (dollars) — median lands near base.
  bases     int[]  := array[25, 15, 8, 120, 90, 45, 60, 40, 20, 18];
  conds     text[] := array['new','like_new','good','fair','worn'];
  factors   numeric[] := array[1.25, 1.10, 1.00, 0.80, 0.60];
  nouns     text[] := array['bundle','set','kit','lot','pair','collection','starter pack','deluxe edition'];
  n         int := 500;
  i         int;
  ci        int;
  di        int;
  base      int;
  price     numeric;
  total     int := 0;
begin
  if to_regclass('public.marketplace_listings') is null then
    raise notice 'marketplace_listings not present — apply migration 0120 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select user_id, id into v_user, v_member from public.family_members
  where family_id = v_family and user_id is not null order by created_at limit 1;

  delete from public.marketplace_listings
   where family_id = v_family and description like '%[seed:quickpost]%';

  for i in 1..n loop
    ci   := 1 + (i % array_length(cats, 1));
    di   := 1 + ((i / 10) % array_length(conds, 1));
    base := bases[ci];
    -- Spread ±40% around the category base, then apply the condition factor —
    -- deterministic per row (no random(), which Postgres constant-folds).
    price := round(base * (0.6 + ((i * 7) % 81) / 100.0) * factors[di]);
    if price < 1 then price := 1; end if;

    insert into public.marketplace_listings
      (family_id, member_id, created_by, title, description, kind, category,
       condition, price_cents, status, location, created_at)
    values
      (v_family, v_member, v_user,
       initcap(cats[ci]) || ' ' || nouns[1 + (i % array_length(nouns, 1))] || ' #' || i,
       'Comparable listing for quick-post price suggestions. [seed:quickpost]',
       'sell', cats[ci], conds[di], (price * 100)::int, 'available',
       (array['In the garage','In the basement','On the porch','In the playroom'])[1 + (i % 4)],
       now() - make_interval(days => i % 75, hours => i % 11));

    total := total + 1;
  end loop;

  raise notice 'Seeded % quick-post comparables for family %.', total, v_family;
end $$;
