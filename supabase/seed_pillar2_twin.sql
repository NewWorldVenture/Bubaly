-- ============================================================================
-- Bubaly · SEED — Pillar #2: Household Digital Twin
-- 500+ records. Gives the decision simulator (/dashboard/family-digital-twin) a
-- rich linked model to reason over: a busy 60-day schedule plus teams, classes,
-- routines and budgets. Idempotent via '[seed:p2]' markers.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  m uuid;
  n_events  int := 500;
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

  delete from public.calendar_events where family_id = v_family and description like '%[seed:p2]%';
  delete from public.teams          where family_id = v_family and season = '[seed:p2]';
  delete from public.school_classes where family_id = v_family and room   = '[seed:p2]';
  delete from public.family_routines where family_id = v_family and description = '[seed:p2]';
  delete from public.budgets        where family_id = v_family and category like 'seed-p2-%';

  -- 470 scheduled commitments the twin simulates against.
  insert into public.calendar_events (family_id, title, description, starts_at, ends_at, all_day, assignee_id, location)
  select v_family,
    (array['Practice','Game','Rehearsal','Lesson','Meeting','Appointment','Shift','Club'])[1 + floor(random()*8)::int] || ' #' || g.i,
    '[seed:p2]',
    ts, ts + interval '1 hour', false,
    v_members[1 + floor(random()*array_length(v_members,1))::int],
    (array['Home','School','Field','Studio','Downtown'])[1 + floor(random()*5)::int]
  from generate_series(1, n_events) as g(i)
  cross join lateral (select (current_date + (floor(random()*60))::int)::timestamp + time '15:00' + (floor(random()*6)*interval '1 hour') as ts) t;

  -- Linked model: 2 teams + 2 classes + 2 routines per member, plus budgets.
  foreach m in array v_members loop
    insert into public.teams (family_id, member_id, sport, team_name, season, is_active, created_by) values
      (v_family, m, (array['Soccer','Basketball','Swim','Baseball'])[1+floor(random()*4)::int], 'Team ' || substr(m::text,1,4), '[seed:p2]', true, null),
      (v_family, m, (array['Track','Tennis','Volleyball'])[1+floor(random()*3)::int], 'Squad ' || substr(m::text,1,4), '[seed:p2]', true, null);
    insert into public.school_classes (family_id, member_id, subject, room, created_by) values
      (v_family, m, (array['Math','Science','English','History'])[1+floor(random()*4)::int], '[seed:p2]', null),
      (v_family, m, (array['Art','Music','PE','Spanish'])[1+floor(random()*4)::int], '[seed:p2]', null);
    insert into public.family_routines (family_id, member_id, title, description, status, days_of_week, created_by) values
      (v_family, m, 'Morning routine', '[seed:p2]', 'active', '{1,2,3,4,5}', null),
      (v_family, m, 'Bedtime routine', '[seed:p2]', 'active', '{0,1,2,3,4,5,6}', null);
  end loop;

  insert into public.budgets (family_id, category, amount, period, created_by) values
    (v_family, 'seed-p2-groceries', 800, 'monthly', null),
    (v_family, 'seed-p2-activities', 300, 'monthly', null),
    (v_family, 'seed-p2-travel', 5000, 'yearly', null),
    (v_family, 'seed-p2-dining', 250, 'monthly', null);

  raise notice 'Pillar #2 (digital twin) seeded % events + linked model for family %', n_events, v_family;
end $$;
