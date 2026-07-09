-- ============================================================================
-- seed_marketplace_saved_searches.sql — 500 marketplace alerts (saved searches)
-- to fully exercise /marketplace/alerts. Distributes standing searches across
-- the family's members with varied criteria (keyword / kind / category / price
-- ceiling) and a last-seen cursor in the recent past so "NEW" badges fire
-- against the seeded listings. Run supabase/seed_marketplace.sql FIRST so there
-- are listings to match.
--
-- Resolves the same family (by the owner email). IDEMPOTENT: wipes this family's
-- saved searches, then inserts 500. Test data only, one family. Safe to re-run.
--
-- HOW TO RUN: Supabase SQL editor → paste → Run → open /marketplace/alerts.
-- ============================================================================

do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_uid     uuid;
  v_members uuid[];
  mcount    int;
  kinds     text[] := array['sell','rent','borrow','free','wanted','swap','donate'];
  cats      text[] := array['toys','clothing','books','electronics','furniture','sports','tools','baby','games','other'];
  words     text[] := array['bike','table','jacket','puzzle','drill','stroller','desk','console','boots','lamp',null,null];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_family and is_active;
  mcount := coalesce(array_length(v_members, 1), 0);
  if mcount = 0 then raise exception 'Family has no members.'; end if;

  delete from public.marketplace_saved_searches where family_id = v_family;

  insert into public.marketplace_saved_searches
    (family_id, member_id, label, query, kind, category, max_price_cents, is_active, last_seen_at, created_by)
  select
    v_family,
    v_members[1 + (g % mcount)],
    null,
    -- ~⅓ have no keyword (kind/category-only alerts guarantee matches)
    words[1 + (g % array_length(words, 1))],
    -- ~⅕ any-kind
    case when g % 5 = 0 then null else kinds[1 + (g % array_length(kinds, 1))] end,
    -- ~¼ any-category
    case when g % 4 = 0 then null else cats[1 + (g % array_length(cats, 1))] end,
    -- ~half carry a price ceiling ($20–$220)
    case when g % 2 = 0 then ((g % 20) + 2) * 1000 else null end,
    true,
    -- last seen 10–70 days ago → recent listings read as NEW
    now() - make_interval(days => (g % 60) + 10),
    v_uid
  from generate_series(1, 500) as g;

  raise notice 'Marketplace saved-searches seed complete for family % (500 alerts).', v_family;
end $$;

-- ── Verify: count + a criteria spread ───────────────────────────────────────
select 'saved_searches' as metric, count(*)::text as value from public.marketplace_saved_searches
  where family_id = (select f.id from public.families f join public.family_members fm on fm.family_id=f.id join auth.users u on u.id=fm.user_id where lower(u.email)=lower('newworldventurellc@gmail.com') limit 1)
union all
select 'with keyword', count(*)::text from public.marketplace_saved_searches
  where family_id = (select f.id from public.families f join public.family_members fm on fm.family_id=f.id join auth.users u on u.id=fm.user_id where lower(u.email)=lower('newworldventurellc@gmail.com') limit 1) and query is not null
union all
select 'with price cap', count(*)::text from public.marketplace_saved_searches
  where family_id = (select f.id from public.families f join public.family_members fm on fm.family_id=f.id join auth.users u on u.id=fm.user_id where lower(u.email)=lower('newworldventurellc@gmail.com') limit 1) and max_price_cents is not null;
