-- ============================================================================
-- Bubaly · SEED — School & Sports calendar events (520 records).
-- Fills school_events + sports_events so the School and Sports calendar surfaces
-- render populated in a fresh/demo environment (both tables ship in 0002 but had
-- NO seed anywhere — see LB-014). 260 school events across all event types +
-- 260 sports events across practice/game/tournament, assigned to the family's
-- child members, with starts_at spread from ~60 days back to ~120 days ahead.
-- Idempotent: every seeded row's title is prefixed '[seed] ' and the script
-- clears its own rows first. Resolves the family by the anchored account email.
-- Standalone (not yet wired into SEED_ALL — LB-014 owner wires it): paste into
-- Supabase SQL Editor → Run, or run against the verify-pg.sh harness.
-- ============================================================================
do $$
declare
  v_email    text := 'newworldventurellc@gmail.com';
  v_family   uuid;
  v_user     uuid;
  v_members  uuid[];
  v_mcount   int;

  schools    text[] := array['Lincoln Elementary','Roosevelt Middle','Washington High','Maple Grove Academy'];
  sch_types  text[] := array['holiday','field_trip','parent_meeting','exam','early_release','conference','general','spirit_day'];
  sch_titles text[] := array[
    'Picture Day','Field Trip to the Science Museum','Parent-Teacher Conference','Midterm Exam',
    'Early Release Day','Winter Break Begins','Spring Book Fair','Report Cards Sent Home',
    'School Play Rehearsal','Spelling Bee','Career Day','Fall Festival','Standardized Testing',
    'Kindergarten Orientation','Band Concert','Art Show','Honor Roll Assembly','Fire Drill'];

  sports     text[] := array['Soccer','Basketball','Baseball','Swimming','Volleyball','Track & Field','Tennis'];
  teams      text[] := array['Hawks','Tigers','Sharks','Comets','Rockets','Wolves','Falcons'];
  spo_types  text[] := array['practice','practice','practice','game','game','tournament'];
  venues     text[] := array['Home Field','Community Rec Center','Away — Jefferson Park','City Sports Complex','School Gym','Riverside Fields'];
  opponents  text[] := array['Jefferson','Riverside','Oakdale','Westview','Hillcrest','Pinewood'];

  n_each     int := 260;
  i          int;
  v_member   uuid;
  v_start    timestamptz;
  v_title    text;
  total_sch  int := 0;
  total_spo  int := 0;
begin
  if to_regclass('public.school_events') is null or to_regclass('public.sports_events') is null then
    raise notice 'school_events/sports_events not present — skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then
    raise notice 'No family found for % — skipping.', v_email;
    return;
  end if;

  select fm.user_id into v_user from public.family_members fm
  where fm.family_id = v_family and fm.user_id is not null limit 1;

  -- Prefer child members (these events are about the kids); fall back to any member.
  select array_agg(id) into v_members from public.family_members
  where family_id = v_family and coalesce(role::text,'') in ('child','teen');
  if v_members is null or array_length(v_members,1) is null then
    select array_agg(id) into v_members from public.family_members where family_id = v_family;
  end if;
  v_mcount := coalesce(array_length(v_members,1), 0);

  -- Idempotent: clear this seed's own rows.
  delete from public.school_events where family_id = v_family and title like '[seed]%';
  delete from public.sports_events where family_id = v_family and title like '[seed]%';

  for i in 0..(n_each - 1) loop
    v_member := case when v_mcount > 0 then v_members[(i % v_mcount) + 1] else null end;
    -- Spread from 60 days back to 120 days ahead, at plausible school hours.
    v_start := date_trunc('day', now()) - interval '60 days'
               + ((i * 180.0 / n_each) || ' days')::interval
               + ((8 + (i % 8)) || ' hours')::interval;

    v_title := '[seed] ' || sch_titles[(i % array_length(sch_titles,1)) + 1];
    insert into public.school_events
      (family_id, member_id, school_name, title, event_type, starts_at, ends_at, notes, source, created_by)
    values (
      v_family, v_member,
      schools[(i % array_length(schools,1)) + 1],
      v_title,
      sch_types[(i % array_length(sch_types,1)) + 1],
      v_start, v_start + interval '2 hours',
      'Auto-seeded school calendar event for demo volume.',
      'seed', v_user);
    total_sch := total_sch + 1;

    v_start := date_trunc('day', now()) - interval '60 days'
               + ((i * 180.0 / n_each) || ' days')::interval
               + ((16 + (i % 4)) || ' hours')::interval;
    v_title := '[seed] ' || sports[(i % array_length(sports,1)) + 1] || ' '
               || initcap(spo_types[(i % array_length(spo_types,1)) + 1])
               || case when spo_types[(i % array_length(spo_types,1)) + 1] = 'game'
                       then ' vs ' || opponents[(i % array_length(opponents,1)) + 1] else '' end;
    insert into public.sports_events
      (family_id, member_id, sport, team, title, event_type, location, starts_at, ends_at, created_by)
    values (
      v_family, v_member,
      sports[(i % array_length(sports,1)) + 1],
      teams[(i % array_length(teams,1)) + 1],
      v_title,
      spo_types[(i % array_length(spo_types,1)) + 1],
      venues[(i % array_length(venues,1)) + 1],
      v_start, v_start + interval '90 minutes',
      v_user);
    total_spo := total_spo + 1;
  end loop;

  raise notice 'seed_school_sports_events: % school_events + % sports_events for family %', total_sch, total_spo, v_family;
end $$;
