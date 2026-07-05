-- ============================================================================
-- FamilyOS · SEED — Pillar #1: Orchestrator questions (Operating Layer)
-- 500+ records. Feeds the five daily questions on
-- /dashboard/family-operating-index (what'll go wrong tomorrow · who's
-- overloaded · what to decide next · what info is missing · what can auto-run).
-- Idempotent: clears its own '[seed:p1]' rows first, then reinserts.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';   -- ← account to seed
  v_family  uuid;
  v_members uuid[];
  n_events  int  := 500;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  if v_members is null then raise exception 'Family % has no members.', v_family; end if;

  delete from public.calendar_events where family_id = v_family and description like '%[seed:p1]%';
  delete from public.family_polls    where family_id = v_family and description like '%[seed:p1]%';

  -- 500 events across the next ~45 days. Overlaps (same member, same day) become
  -- conflicts; ~15% are unassigned + location-less ("missing info"); the busiest
  -- member reads as "overloaded".
  insert into public.calendar_events (family_id, title, description, starts_at, ends_at, all_day, assignee_id, location)
  select
    v_family,
    (array['Soccer practice','Dentist','Piano lesson','Work call','Swim meet','Study group',
           'Playdate','Doctor visit','Recital','Team game','Tutoring','Scouts','Band','Checkup'])[1 + floor(random()*14)::int] || ' #' || g.i,
    '[seed:p1]',
    ts,
    ts + interval '45 min' + (floor(random()*3) * interval '30 min'),
    false,
    case when random() < 0.15 then null else v_members[1 + floor(random()*array_length(v_members,1))::int] end,
    case when random() < 0.15 then null else (array['Home','Field 3','School','Clinic','Studio','Gym','Library'])[1 + floor(random()*7)::int] end
  from generate_series(1, n_events) as g(i)
  cross join lateral (
    select (current_date + (floor(random()*45))::int)::timestamp
           + time '08:00' + (floor(random()*11) * interval '1 hour') as ts
  ) t;

  -- A dozen open decisions → "what to decide next".
  insert into public.family_polls (family_id, question, description, kind, status, created_by)
  select v_family,
    (array['Where should we go for spring break?','Which weekend for Grandma''s visit?',
           'Whose turn to host game night?','What''s for the holiday dinner?','Which camp this summer?',
           'Should we adopt a pet?'])[1 + floor(random()*6)::int] || ' (#' || g.i || ')',
    '[seed:p1]', 'single', 'open', null
  from generate_series(1, 12) as g(i);

  raise notice 'Pillar #1 (orchestrator) seeded % events + 12 polls for family %', n_events, v_family;
end $$;
