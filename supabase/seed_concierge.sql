-- ============================================================================
-- Bubaly · SEED — AI Concierge (concierge_plans 500).
-- Getaways, restaurants, date nights, parties, travel, services — across every
-- kind + status — so /dashboard/concierge renders at real volume.
-- Idempotent: seed rows carry a '[seed]' title prefix; deleted before re-insert.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  kinds  text[] := array['getaway','restaurant','date_night','activity','party','travel','shopping','service','general'];
  stats  text[] := array['idea','idea','planning','booked','confirmed','completed','cancelled'];
  names  text[] := array['Weekend in the mountains','Anniversary dinner','Kids'' birthday bash','Beach day trip',
                         'Museum afternoon','Farmers market run','Spa evening','Camping getaway','Pizza night out',
                         'Ski trip planning','Zoo outing','Concert night','Brunch with grandparents','Escape room'];
  locs   text[] := array['Lake Tahoe','Downtown','The Grand Bistro','Ocean Beach','City Museum','Central Park',
                         'Serenity Spa','Redwood Campground','Tony''s Pizzeria','Aspen'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.concierge_plans where family_id = v_family and title like '[seed]%';

  insert into public.concierge_plans
    (family_id, title, kind, description, ai_suggestion, status, planned_for, budget_cents, location, created_at)
  select v_family,
    '[seed] ' || names[1 + (g.i % array_length(names,1))] || ' #' || g.i,
    kinds[1 + (g.i % array_length(kinds,1))],
    'A concierge-planned outing the family can book in one tap.',
    'Best window is a weekend afternoon; book 2 weeks out for the best price.',
    stats[1 + (g.i % array_length(stats,1))],
    (current_date + ((g.i % 90) || ' days')::interval)::date,
    (2000 + (g.i * 53) % 40000),
    locs[1 + (g.i % array_length(locs,1))],
    now() - ((g.i % 160) || ' days')::interval
  from generate_series(1, n) as g(i);

  raise notice 'Concierge seeded % plans for family %', n, v_family;
end $$;
