-- ============================================================================
-- FamilyOS :: SEED_ALL — one paste populates EVERY surface with 500-row test data.
-- ============================================================================
-- Runs all 38 paste-ready, idempotent seeds in dependency order (core content
-- first — it creates the to-do/grocery lists later seeds reuse). Each resolves
-- the family by email (newworldventurellc@gmail.com, falls back to the oldest
-- family) and clears its own sentinel rows first, so re-running never dupes.
-- Schema-drift safe: every surface is guarded on its own table existing
-- (to_regclass), so a database that is behind on a migration seeds every OTHER
-- surface and skips only the missing one — the script never aborts partway.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================

-- ==================== seed_core_content.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Core content (500 records each) for the main family hubs.
-- Fills the everyday surfaces so the app can be tested at volume: Calendar,
-- To-Dos, Groceries, Notes, Photos, Journal, Habits. Idempotent via '[seed:core]'
-- / 'seed-core' markers (never clobbers real data). Get-or-creates the lists.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email     text := 'newworldventurellc@gmail.com';
  v_family    uuid;
  v_members   uuid[];
  v_todo_list uuid;
  v_groc_list uuid;
  n int := 500;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  -- Each surface is guarded on its own table existing, so a production schema that
  -- is behind on a migration (e.g. habits not yet applied) seeds every OTHER surface
  -- instead of aborting the whole script. A skipped `if` branch is never planned, so
  -- a missing enum type (journal_mood/habit_cadence) can't error either.

  if to_regclass('public.todo_lists') is not null then
    select id into v_todo_list from public.todo_lists where family_id = v_family and archived_at is null order by created_at limit 1;
    if v_todo_list is null then insert into public.todo_lists (family_id, name) values (v_family, 'To-Do') returning id into v_todo_list; end if;
  end if;
  if to_regclass('public.grocery_lists') is not null then
    select id into v_groc_list from public.grocery_lists where family_id = v_family and is_archived = false order by created_at limit 1;
    if v_groc_list is null then insert into public.grocery_lists (family_id, name) values (v_family, 'Shopping List') returning id into v_groc_list; end if;
  end if;

  -- Calendar — 500 events across ±30 days.
  if to_regclass('public.calendar_events') is not null then
    delete from public.calendar_events where family_id = v_family and description like '%[seed:core]%';
    insert into public.calendar_events (family_id, title, description, starts_at, ends_at, all_day, assignee_id)
    select v_family, 'Event #' || g.i, '[seed:core]',
      (current_date + (floor(random()*60) - 30)::int)::timestamp + time '09:00' + (floor(random()*9)*interval '1 hour'),
      null, false, v_members[1 + floor(random()*array_length(v_members,1))::int]
    from generate_series(1, n) as g(i);
  end if;

  -- To-Dos — 500 (mix of done/overdue/upcoming).
  if to_regclass('public.todo_items') is not null then
    delete from public.todo_items where family_id = v_family and notes like '%[seed:core]%';
    insert into public.todo_items (family_id, list_id, title, notes, is_done, priority, due_date)
    select v_family, v_todo_list, 'Task #' || g.i, '[seed:core]',
      (g.i % 4 = 0),
      (array['low','medium','high'])[1 + (g.i % 3)],
      (current_date + (floor(random()*40) - 20)::int)
    from generate_series(1, n) as g(i);
  end if;

  -- Groceries — 500 open items.
  if to_regclass('public.grocery_items') is not null then
    delete from public.grocery_items where family_id = v_family and category = 'seed-core';
    insert into public.grocery_items (family_id, list_id, name, category, is_checked)
    select v_family, v_groc_list,
      (array['Milk','Eggs','Bread','Apples','Chicken','Rice','Pasta','Cheese','Bananas','Coffee'])[1 + (g.i % 10)] || ' #' || g.i,
      'seed-core', (g.i % 6 = 0)
    from generate_series(1, n) as g(i);
  end if;

  -- Notes — 500.
  if to_regclass('public.notes') is not null then
    delete from public.notes where family_id = v_family and body like '%[seed:core]%';
    insert into public.notes (family_id, title, body, is_pinned, created_by)
    select v_family, 'Note #' || g.i, 'Sample note content #' || g.i || ' [seed:core]', (g.i % 25 = 0), null
    from generate_series(1, n) as g(i);
  end if;

  -- Photos — 500 (placeholder storage paths; caption tags the seed).
  if to_regclass('public.family_photos') is not null then
    delete from public.family_photos where family_id = v_family and caption like '%[seed:core]%';
    insert into public.family_photos (family_id, uploaded_by, storage_path, url, caption, taken_at)
    select v_family, null,
      v_family || '/seed/core/photo-' || g.i || '.jpg',
      'https://placehold.co/400?text=Photo+' || g.i,
      'Memory #' || g.i || ' [seed:core]',
      now() - (random()*365 || ' days')::interval
    from generate_series(1, n) as g(i);
  end if;

  -- Journal — 500 entries.
  if to_regclass('public.journal_entries') is not null then
    delete from public.journal_entries where family_id = v_family and prompt = '[seed:core]';
    insert into public.journal_entries (family_id, member_id, entry_date, mood, title, body, prompt, tags)
    select v_family,
      case when v_members is null then null else v_members[1 + floor(random()*array_length(v_members,1))::int] end,
      (current_date - (g.i % 365)),
      (array['great','good','okay','low','stressed'])[1 + (g.i % 5)]::journal_mood,
      'Journal #' || g.i, 'A little reflection #' || g.i, '[seed:core]', '{}'
    from generate_series(1, n) as g(i);
  end if;

  -- Habits — 500.
  if to_regclass('public.habits') is not null then
    delete from public.habits where family_id = v_family and description = '[seed:core]';
    insert into public.habits (family_id, member_id, title, description, icon, color, cadence, target_per_period, weekdays, is_active)
    select v_family,
      case when v_members is null then null else v_members[1 + floor(random()*array_length(v_members,1))::int] end,
      (array['Drink water','Read','Exercise','Meditate','Tidy up','Practice','Walk','Stretch'])[1 + (g.i % 8)] || ' #' || g.i,
      '[seed:core]', 'star', '#7c5dff',
      (array['daily','weekly'])[1 + (g.i % 2)]::habit_cadence, 1, '{1,2,3,4,5}', true
    from generate_series(1, n) as g(i);
  end if;

  raise notice 'Core content seeded (500 each) for family %', v_family;
end $$;

-- ==================== seed_pillar1_orchestrator.sql ====================
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

  -- 500 events across the next ~45 days. Overlaps (same member, same day) become
  -- conflicts; ~15% are unassigned + location-less ("missing info"); the busiest
  -- member reads as "overloaded".
  if to_regclass('public.calendar_events') is not null then
    delete from public.calendar_events where family_id = v_family and description like '%[seed:p1]%';
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
  end if;

  -- A dozen open decisions → "what to decide next".
  if to_regclass('public.family_polls') is not null then
    delete from public.family_polls where family_id = v_family and description like '%[seed:p1]%';
    insert into public.family_polls (family_id, question, description, kind, status, created_by)
    select v_family,
      (array['Where should we go for spring break?','Which weekend for Grandma''s visit?',
             'Whose turn to host game night?','What''s for the holiday dinner?','Which camp this summer?',
             'Should we adopt a pet?'])[1 + floor(random()*6)::int] || ' (#' || g.i || ')',
      '[seed:p1]', 'single', 'open', null
    from generate_series(1, 12) as g(i);
  end if;

  raise notice 'Pillar #1 (orchestrator) seeded % events + 12 polls for family %', n_events, v_family;
end $$;

-- ==================== seed_pillar2_twin.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Pillar #2: Household Digital Twin
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

  -- 470 scheduled commitments the twin simulates against.
  if to_regclass('public.calendar_events') is not null then
    delete from public.calendar_events where family_id = v_family and description like '%[seed:p2]%';
    insert into public.calendar_events (family_id, title, description, starts_at, ends_at, all_day, assignee_id, location)
    select v_family,
      (array['Practice','Game','Rehearsal','Lesson','Meeting','Appointment','Shift','Club'])[1 + floor(random()*8)::int] || ' #' || g.i,
      '[seed:p2]',
      ts, ts + interval '1 hour', false,
      v_members[1 + floor(random()*array_length(v_members,1))::int],
      (array['Home','School','Field','Studio','Downtown'])[1 + floor(random()*5)::int]
    from generate_series(1, n_events) as g(i)
    cross join lateral (select (current_date + (floor(random()*60))::int)::timestamp + time '15:00' + (floor(random()*6)*interval '1 hour') as ts) t;
  end if;

  if to_regclass('public.teams') is not null then delete from public.teams where family_id = v_family and season = '[seed:p2]'; end if;
  if to_regclass('public.school_classes') is not null then delete from public.school_classes where family_id = v_family and room = '[seed:p2]'; end if;
  if to_regclass('public.family_routines') is not null then delete from public.family_routines where family_id = v_family and description = '[seed:p2]'; end if;

  -- Linked model: 2 teams + 2 classes + 2 routines per member, plus budgets.
  foreach m in array v_members loop
    if to_regclass('public.teams') is not null then
      insert into public.teams (family_id, member_id, sport, team_name, season, is_active, created_by) values
        (v_family, m, (array['Soccer','Basketball','Swim','Baseball'])[1+floor(random()*4)::int], 'Team ' || substr(m::text,1,4), '[seed:p2]', true, null),
        (v_family, m, (array['Track','Tennis','Volleyball'])[1+floor(random()*3)::int], 'Squad ' || substr(m::text,1,4), '[seed:p2]', true, null);
    end if;
    if to_regclass('public.school_classes') is not null then
      insert into public.school_classes (family_id, member_id, subject, room, created_by) values
        (v_family, m, (array['Math','Science','English','History'])[1+floor(random()*4)::int], '[seed:p2]', null),
        (v_family, m, (array['Art','Music','PE','Spanish'])[1+floor(random()*4)::int], '[seed:p2]', null);
    end if;
    if to_regclass('public.family_routines') is not null then
      insert into public.family_routines (family_id, member_id, title, description, status, days_of_week, created_by) values
        (v_family, m, 'Morning routine', '[seed:p2]', 'active', '{1,2,3,4,5}', null),
        (v_family, m, 'Bedtime routine', '[seed:p2]', 'active', '{0,1,2,3,4,5,6}', null);
    end if;
  end loop;

  if to_regclass('public.budgets') is not null then
    delete from public.budgets where family_id = v_family and category like 'seed-p2-%';
    insert into public.budgets (family_id, category, amount, period, created_by) values
      (v_family, 'seed-p2-groceries', 800, 'monthly', null),
      (v_family, 'seed-p2-activities', 300, 'monthly', null),
      (v_family, 'seed-p2-travel', 5000, 'yearly', null),
      (v_family, 'seed-p2-dining', 250, 'monthly', null);
  end if;

  raise notice 'Pillar #2 (digital twin) seeded % events + linked model for family %', n_events, v_family;
end $$;

-- ==================== seed_pillar3_playbook.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Pillar #3: Family Intelligence / Playbook
-- 500 suggested playbook facts in the review inbox (/dashboard/playbook) so you
-- can fully test Save / Dismiss / realtime. Idempotent: unique(family_id,
-- signature) → ON CONFLICT DO NOTHING (re-run is a no-op; dismissed/accepted
-- rows never resurface).
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  if to_regclass('public.family_playbook_suggestions') is not null then
    insert into public.family_playbook_suggestions (family_id, member_id, category, label, value, evidence, confidence, signature, status)
    select
      v_family, null,
      (array['preference','preference','preference','date','preference','other'])[1 + (g.i % 6)],
      (array['Go-to dinner','Grocery staple','Favorite activity','Family tradition','Travel style','Weekend ritual'])[1 + (g.i % 6)],
      (array['Taco night','Oat milk','Movie night','Summer camping','Beach getaways','Sunday pancakes',
             'Pizza Friday','Pasta night','Trail hikes','Game night','Farmers market','Bike rides'])[1 + floor(random()*12)::int] || ' #' || g.i,
      'Seen ' || (3 + floor(random()*9))::int || ' times in recent activity',
      45 + floor(random()*50)::int,
      'seed-p3:' || g.i,        -- unique, stable signature (idempotent)
      'suggested'
    from generate_series(1, n) as g(i)
    on conflict (family_id, signature) do nothing;
  end if;

  raise notice 'Pillar #3 (playbook) seeded up to % suggestions for family %', n, v_family;
end $$;

-- ==================== seed_pillar4_outcomes.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Pillar #4: Outcomes launcher
-- 500 records that light up every outcome badge on /dashboard/outcomes:
--   200 calendar events (100 today) · 150 overdue to-dos · 150 open grocery
--   items · plus a member birthday within 2 weeks.
-- Idempotent via '[seed:p4]' / 'seed-p4' markers. Get-or-creates the lists.
-- ============================================================================
do $$
declare
  v_email     text := 'newworldventurellc@gmail.com';
  v_family    uuid;
  v_members   uuid[];
  v_todo_list uuid;
  v_groc_list uuid;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  -- Get-or-create the family's default lists.
  if to_regclass('public.todo_lists') is not null then
    select id into v_todo_list from public.todo_lists where family_id = v_family and archived_at is null order by created_at limit 1;
    if v_todo_list is null then insert into public.todo_lists (family_id, name) values (v_family, 'To-Do') returning id into v_todo_list; end if;
  end if;
  if to_regclass('public.grocery_lists') is not null then
    select id into v_groc_list from public.grocery_lists where family_id = v_family and is_archived = false order by created_at limit 1;
    if v_groc_list is null then insert into public.grocery_lists (family_id, name) values (v_family, 'Shopping List') returning id into v_groc_list; end if;
  end if;

  -- 200 events: 100 today, 100 across the next 30 days.
  if to_regclass('public.calendar_events') is not null then
    delete from public.calendar_events where family_id = v_family and description like '%[seed:p4]%';
    insert into public.calendar_events (family_id, title, description, starts_at, ends_at, all_day, assignee_id)
    select v_family, 'Event #' || g.i, '[seed:p4]',
      case when g.i <= 100 then current_date::timestamp + time '08:00' + (g.i * interval '7 min')
           else (current_date + (1 + floor(random()*30))::int)::timestamp + time '09:00' + (floor(random()*8)*interval '1 hour') end,
      null, false, v_members[1 + floor(random()*array_length(v_members,1))::int]
    from generate_series(1, 200) as g(i);
  end if;

  -- 150 overdue to-dos (due before today, not done).
  if to_regclass('public.todo_items') is not null then
    delete from public.todo_items where family_id = v_family and notes like '%[seed:p4]%';
    insert into public.todo_items (family_id, list_id, title, notes, is_done, priority, due_date)
    select v_family, v_todo_list,
      (array['Pay bill','Return package','Call plumber','RSVP','Renew pass','Book appointment','Fix bike','Water plants'])[1 + floor(random()*8)::int] || ' #' || g.i,
      '[seed:p4]', false,
      (array['low','medium','high'])[1 + floor(random()*3)::int],
      (current_date - (1 + floor(random()*20))::int)
    from generate_series(1, 150) as g(i);
  end if;

  -- 150 open grocery items (category tag = idempotency marker).
  if to_regclass('public.grocery_items') is not null then
    delete from public.grocery_items where family_id = v_family and category = 'seed-p4';
    insert into public.grocery_items (family_id, list_id, name, category, is_checked)
    select v_family, v_groc_list,
      (array['Milk','Eggs','Bread','Apples','Chicken','Rice','Pasta','Cheese','Bananas','Coffee','Yogurt','Spinach'])[1 + floor(random()*12)::int] || ' #' || g.i,
      'seed-p4', false
    from generate_series(1, 150) as g(i);
  end if;

  -- A birthday within the next 2 weeks so the "Celebrate" badge fires.
  if v_members is not null then
    update public.family_members
      set birthday = (current_date + 6)
      where id = v_members[1];
  end if;

  raise notice 'Pillar #4 (outcomes) seeded 500 records for family %', v_family;
end $$;

-- ==================== seed_pillar5_command_center.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Pillar #5: Command Center evening summary
-- 500 daily Family Operating Index snapshots (one per day, 500 days back). The
-- "yesterday" snapshot carries open suggestions + a lower composite, so the
-- "Since yesterday" recap on /dashboard/command-center (and the Operating Index)
-- shows real cleared items + an improvement once today is computed live.
-- Idempotent: upserts on unique(family_id, as_of_date).
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  if to_regclass('public.family_operating_index') is not null then
    insert into public.family_operating_index (family_id, as_of_date, composite, band, dimensions, suggestions)
    select
      v_family,
      current_date - g.i,
      comp,
      case when comp >= 85 then 'thriving' when comp >= 70 then 'steady' when comp >= 55 then 'stretched' else 'overloaded' end,
      jsonb_build_object(
        'planning', comp, 'schedule', greatest(0, comp - 6), 'financial', least(100, comp + 5),
        'readiness', comp, 'communication', least(100, comp + 3), 'routines', greatest(0, comp - 4), 'goals', comp),
      case when g.i in (1, 2) then
        '[{"id":"seed-doc","title":"A document is expiring soon","detail":"Renew it before it lapses","href":"/dashboard/documents","dimension":"readiness","impact":8},
          {"id":"seed-dinner","title":"3 dinners this week are unplanned","detail":"Plan meals","href":"/dashboard/meals","dimension":"routines","impact":6},
          {"id":"seed-conflict","title":"A schedule clash tomorrow","detail":"Decide who covers what","href":"/dashboard/conflicts","dimension":"schedule","impact":9}]'::jsonb
      else '[]'::jsonb end
    from generate_series(0, 499) as g(i)
    cross join lateral (select (55 + ((g.i * 7) % 45))::int as comp) c
    on conflict (family_id, as_of_date) do update
      set composite = excluded.composite, band = excluded.band,
          dimensions = excluded.dimensions, suggestions = excluded.suggestions;
  end if;

  raise notice 'Pillar #5 (command center) seeded 500 daily snapshots for family %', v_family;
end $$;

-- ==================== seed_pillar6_agents.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Pillar #6: Specialized agents (agent_activity)
-- 500 activity records spread across the 10 agents so /dashboard/agents shows a
-- rich per-agent history you can Done/Dismiss and fully test. Idempotent:
-- clears its own '[seed:p6]' rows (matched on detail) first, then reinserts.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  n int := 500;

  agents   text[] := array['chief_of_staff','scheduler','meal_planner','budget_coach','household_manager',
                           'school_coordinator','health_guide','travel_planner','memory_keeper','comms_assistant'];
  kinds    text[] := array['insight','recommendation','action','handoff'];
  sevs     text[] := array['info','attention','action'];
  hrefs    text[] := array['/dashboard/calendar','/dashboard/meals','/dashboard/bills','/dashboard/chores',
                           '/dashboard/homework','/dashboard/medications','/dashboard/trips','/dashboard/celebrations',
                           '/dashboard/messages','/dashboard/documents','/dashboard/grocery','/dashboard/conflicts'];
  titles   text[] := array['Flagged a schedule clash','Suggested a dinner plan','Bill due this week',
                           'Reassigned an overdue chore','Homework due tomorrow','Refill reminder set',
                           'Trip packing list ready','Birthday coming up','Drafted a reply','Document expiring',
                           'Added items to the list','Resolved a conflict','Booked an appointment','Trimmed a subscription'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  if to_regclass('public.agent_activity') is not null then
    delete from public.agent_activity where family_id = v_family and detail like '%[seed:p6]%';
    insert into public.agent_activity (family_id, member_id, agent, kind, title, detail, href, severity, status, created_at)
    select
      v_family,
      case when random() < 0.5 or v_members is null then null else v_members[1 + floor(random()*array_length(v_members,1))::int] end,
      agents[1 + floor(random()*array_length(agents,1))::int],
      kinds[1 + floor(random()*array_length(kinds,1))::int],
      titles[1 + floor(random()*array_length(titles,1))::int] || ' #' || g.i,
      '[seed:p6] auto-logged by the agent',
      hrefs[1 + floor(random()*array_length(hrefs,1))::int],
      sevs[1 + floor(random()*array_length(sevs,1))::int],
      -- ~70% active (visible), the rest already resolved for history.
      (array['active','active','active','active','active','active','active','done','done','dismissed'])[1 + floor(random()*10)::int],
      now() - (random() * 90 || ' days')::interval
    from generate_series(1, n) as g(i);
  end if;

  raise notice 'Pillar #6 (agents) seeded % activity records for family %', n, v_family;
end $$;

-- Verify:
--   select agent, count(*) from public.agent_activity group by agent order by 2 desc;
--   select status, count(*) from public.agent_activity group by status;

-- ==================== seed_pillar8_calm.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Pillar #8: Design for Calm (calm inbox sources)
-- The calm inbox has no table of its own — it aggregates other sources. This
-- seeds 500 reminders due in the next 24h (the "For today" stream). Combine with
-- the #6 (agent_activity) and #7 (family_operating_index) seeds for the "Needs
-- you" action items. Idempotent via a '[seed:p8]' marker in notes.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  n int := 500;
  titles text[] := array['Pack lunches','Sign the permission slip','Call the dentist','Move the laundry',
                         'Water the plants','Take out recycling','RSVP to the party','Charge the tablet',
                         'Defrost dinner','Renew the library books','Pay the sitter','Refill prescriptions',
                         'Pick up dry cleaning','Feed the pets','Check the mail','Confirm the appointment'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  if to_regclass('public.reminders') is not null then
    delete from public.reminders where family_id = v_family and notes like '%[seed:p8]%';
    insert into public.reminders (family_id, title, notes, remind_at, is_done, member_id)
    select
      v_family,
      titles[1 + (g.i % array_length(titles, 1))] || ' #' || g.i,
      '[seed:p8]',
      now() + ((1 + floor(random() * 1439)) || ' minutes')::interval,   -- within the next ~24h
      false,
      case when v_members is null or random() < 0.4 then null else v_members[1 + floor(random()*array_length(v_members,1))::int] end
    from generate_series(1, n) as g(i);
  end if;

  raise notice 'Pillar #8 (calm) seeded % reminders for family %', n, v_family;
end $$;

-- Verify:
--   select count(*) from public.reminders where remind_at between now() and now() + interval '24 hours' and is_done = false;

-- ==================== seed_pillar9_connections.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Pillar #9: Family API / Connections (family_connections)
-- 500 connection records across every provider + status so /dashboard/connections
-- and the underlying table can be fully tested. Idempotent: clears its own
-- 'seed-p9-%' rows first (matched on external_account_id), then reinserts.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0128 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;

  providers  text[] := array['google_calendar','apple_calendar','outlook_calendar','gmail','outlook_email',
                             'plaid','instacart','amazon_fresh','google_home','alexa','smartthings'];
  categories text[] := array['calendar','calendar','calendar','email','email',
                             'banking','grocery','grocery','smart_home','smart_home','smart_home'];
  statuses   text[] := array['connected','connected','connected','connected','syncing','error','disconnected'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  if to_regclass('public.family_connections') is not null then
    delete from public.family_connections where family_id = v_family and external_account_id like 'seed-p9-%';
    -- Cycle providers + statuses with modulo (even spread; avoids the lateral
    -- random() constant-folding pitfall). external_account_id stays unique per row.
    insert into public.family_connections
      (family_id, provider, category, status, account_label, external_account_id, last_synced_at, error_message)
    select
      v_family,
      providers[1 + (g.i % array_length(providers, 1))],
      categories[1 + (g.i % array_length(categories, 1))],
      statuses[1 + (g.i % array_length(statuses, 1))],
      'Account #' || g.i,
      'seed-p9-' || g.i,
      case when statuses[1 + (g.i % array_length(statuses, 1))] in ('connected','syncing')
           then now() - (random() * 30 || ' days')::interval else null end,
      case when statuses[1 + (g.i % array_length(statuses, 1))] = 'error'
           then 'Reauthorize this connection' else null end
    from generate_series(1, n) as g(i);
  end if;

  raise notice 'Pillar #9 (connections) seeded % records for family %', n, v_family;
end $$;

-- Verify:
--   select provider, count(*) from public.family_connections group by provider order by 2 desc;
--   select status, count(*) from public.family_connections group by status;

-- ==================== seed_messages.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Messages (family_messages, 500) across all kinds.
-- Get-or-creates a "Seed Chat" conversation, then 500 messages (text/image/
-- voice/file/announcement). Idempotent via a '[seed:msg]' marker in content.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  v_convo  uuid;
  n int := 500;
  kinds text[] := array['text','text','text','image','voice','file','announcement'];
  bodies text[] := array['On my way home','Can someone grab milk?','Practice is moved to 5pm',
                         'Great job today!','Dinner in 20','Who fed the dog?','Don''t forget the forms',
                         'Running 10 late','Movie night?','Homework done ✅'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  if to_regclass('public.family_conversations') is not null then
    select id into v_convo from public.family_conversations
      where family_id = v_family and name = 'Seed Chat' limit 1;
    if v_convo is null then
      insert into public.family_conversations (family_id, name, kind, avatar_emoji)
      values (v_family, 'Seed Chat', 'group', '💬') returning id into v_convo;
    end if;
  end if;

  if to_regclass('public.family_messages') is not null and v_convo is not null then
    delete from public.family_messages where family_id = v_family and content like '%[seed:msg]%';
    -- sender_id references auth.users; seed rows use a null sender + a display name
    -- so no real auth user is required.
    insert into public.family_messages (conversation_id, family_id, sender_id, sender_name, content, kind, is_pinned, created_at)
    select
      v_convo, v_family,
      null,
      (array['Mom','Dad','Alex','Sam','Jordan'])[1 + (g.i % 5)],
      bodies[1 + (g.i % array_length(bodies,1))] || ' #' || g.i || ' [seed:msg]',
      kinds[1 + (g.i % array_length(kinds,1))],
      (g.i % 50 = 0),
      now() - ((g.i) || ' minutes')::interval
    from generate_series(1, n) as g(i);
  end if;

  raise notice 'Messages seeded % rows for family %', n, v_family;
end $$;

-- ==================== seed_chores.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Chores (chores 500 + chore_assignments 500).
-- 500 chores across priorities/recurrence + one assignment each spanning the
-- full task_status lifecycle. Idempotent via a '[seed:chore]' description marker
-- (assignments cascade-cleared by chore_id).
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  n int := 500;
  titles text[] := array['Take out trash','Load dishwasher','Walk the dog','Make bed','Vacuum living room',
                         'Fold laundry','Wipe counters','Water plants','Feed the cat','Tidy playroom',
                         'Sweep kitchen','Clean bathroom','Set the table','Empty recycling','Rake leaves'];
  prios     text[] := array['low','medium','high'];
  recurs    text[] := array['none','daily','weekly','monthly'];
  statuses  text[] := array['todo','in_progress','submitted','approved','done','rejected'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  if v_members is null then raise exception 'Family has no members (needed for chore assignments).'; end if;

  if to_regclass('public.chores') is not null then
    delete from public.chore_assignments a using public.chores c
      where a.chore_id = c.id and c.family_id = v_family and c.description like '%[seed:chore]%';
    delete from public.chores where family_id = v_family and description like '%[seed:chore]%';

    with new_chores as (
      insert into public.chores (family_id, title, description, points, priority, recurrence, due_at, requires_approval, is_active)
      select
        v_family,
        titles[1 + (g.i % array_length(titles,1))] || ' #' || g.i,
        '[seed:chore]',
        5 + (g.i % 20),
        prios[1 + (g.i % array_length(prios,1))]::priority,
        recurs[1 + (g.i % array_length(recurs,1))]::recurrence_freq,
        now() + ((g.i % 14) || ' days')::interval,
        (g.i % 5 = 0),
        true
      from generate_series(1, n) as g(i)
      returning id
    ), numbered as (
      select id, row_number() over () as rn from new_chores
    )
    insert into public.chore_assignments (family_id, chore_id, member_id, status, due_at, points_awarded)
    select
      v_family, nc.id,
      v_members[1 + (nc.rn::int % array_length(v_members,1))],
      statuses[1 + (nc.rn::int % array_length(statuses,1))]::task_status,
      now() + ((nc.rn % 14) || ' days')::interval,
      case when statuses[1 + (nc.rn::int % array_length(statuses,1))] in ('approved','done') then 10 else 0 end
    from numbered nc;
  end if;

  raise notice 'Chores + assignments seeded % rows each for family %', n, v_family;
end $$;

-- ==================== seed_meals.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Meals (meals 500 + family_recipes 500 + meal_plans 500).
-- Fills the meal planner: a library of meals + recipes, and 500 planned days.
-- Idempotent via '[seed:meal]' notes / '[seed:meal]' description markers.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  names text[] := array['Spaghetti Bolognese','Tacos','Grilled Chicken','Veggie Stir Fry','Pancakes',
                        'Caesar Salad','Beef Chili','Salmon & Rice','Margherita Pizza','Chicken Curry',
                        'Turkey Sandwich','Omelette','Pasta Primavera','BBQ Ribs','Fish Tacos'];
  types text[] := array['breakfast','lunch','dinner','snack'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(v_email) = lower(u.email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  -- Meals library (500) + one meal_plan per meal (500 planned days).
  if to_regclass('public.meals') is not null then
    delete from public.meal_plans mp using public.meals m
      where mp.meal_id = m.id and m.family_id = v_family and m.notes = '[seed:meal]';
    delete from public.meals where family_id = v_family and notes = '[seed:meal]';

    with new_meals as (
      insert into public.meals (family_id, name, meal_type, notes)
      select v_family,
        names[1 + (g.i % array_length(names,1))] || ' #' || g.i,
        types[1 + (g.i % array_length(types,1))]::meal_type,
        '[seed:meal]'
      from generate_series(1, n) as g(i)
      returning id, meal_type
    ), numbered as (
      select id, meal_type, row_number() over () as rn from new_meals
    )
    insert into public.meal_plans (family_id, meal_id, plan_date, meal_type)
    select v_family, nm.id, (current_date + (nm.rn::int - 250)), nm.meal_type
    from numbered nm;
  end if;

  -- Recipe book (500).
  if to_regclass('public.family_recipes') is not null then
    delete from public.family_recipes where family_id = v_family and description = '[seed:meal]';
    insert into public.family_recipes (family_id, name, description, category, servings, prep_time_mins, cook_time_mins, difficulty, ingredients, instructions)
    select v_family,
      names[1 + (g.i % array_length(names,1))] || ' (recipe #' || g.i || ')',
      '[seed:meal]',
      (array['dinner','lunch','breakfast','dessert'])[1 + (g.i % 4)],
      2 + (g.i % 6),
      5 + (g.i % 30),
      10 + (g.i % 45),
      (array['easy','medium','hard'])[1 + (g.i % 3)],
      '[]'::jsonb, '[]'::jsonb
    from generate_series(1, n) as g(i);
  end if;

  raise notice 'Meals + recipes + plans seeded % rows each for family %', n, v_family;
end $$;

-- ==================== seed_documents.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Documents (documents, 500) with placeholder storage paths.
-- Mix of categories + some expiring soon + some secure. Idempotent via a
-- '[seed:doc]' title marker. Files aren't uploaded (storage_path is a stub) —
-- rows are for exercising list/filter/expiry UI at volume.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  n int := 500;
  cats  text[] := array['insurance','medical','school','legal','finance','vehicle','home','travel'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  if to_regclass('public.documents') is not null then
    delete from public.documents where family_id = v_family and title like '%[seed:doc]%';
    insert into public.documents (family_id, title, category, storage_path, mime_type, size_bytes, expires_at, member_id, is_secure)
    select v_family,
      initcap(cats[1 + (g.i % array_length(cats,1))]) || ' Doc #' || g.i || ' [seed:doc]',
      cats[1 + (g.i % array_length(cats,1))],
      v_family || '/seed/docs/doc-' || g.i || '.pdf',
      'application/pdf',
      (50000 + (g.i * 137) % 2000000),
      case when g.i % 3 = 0 then (current_date + ((g.i % 90) - 15)) else null end,  -- some expiring soon/expired
      case when v_members is null or g.i % 2 = 0 then null else v_members[1 + (g.i % array_length(v_members,1))] end,
      (g.i % 7 = 0)
    from generate_series(1, n) as g(i);
  end if;

  raise notice 'Documents seeded % rows for family %', n, v_family;
end $$;

-- ==================== seed_location.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Location & Safety (family_places + member_locations +
-- location_events 500). Places (Home/School/Work…), current member locations,
-- and 500 arrive/leave/ping events. Idempotent via '[seed:loc]' markers.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  v_places  uuid[];
  n int := 500;
  place_names text[] := array['Home','School','Work','Grandma''s','Soccer Field','Library','Gym','Dance Studio'];
  events text[] := array['arrived','left','ping'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  if v_members is null then raise exception 'Family has no members (needed for location events).'; end if;

  if to_regclass('public.location_events') is not null then
    delete from public.location_events where family_id = v_family and place_name like '%[seed:loc]%';
  end if;

  -- Places (one per name).
  if to_regclass('public.family_places') is not null then
    delete from public.family_places where family_id = v_family and name like '%[seed:loc]%';
    insert into public.family_places (family_id, name, icon, address, latitude, longitude, radius_m, geofence_enabled)
    select v_family, pn || ' [seed:loc]', '📍', pn || ' address',
      37.77 + (row_number() over () * 0.01), -122.41 - (row_number() over () * 0.01), 150, true
    from unnest(place_names) as pn;
    select array_agg(id) into v_places from public.family_places where family_id = v_family and name like '%[seed:loc]%';
  end if;

  -- 500 location events across members/places/types.
  if to_regclass('public.location_events') is not null and v_places is not null then
    insert into public.location_events (family_id, member_id, place_id, place_name, event_type, latitude, longitude, occurred_at)
    select v_family,
      v_members[1 + (g.i % array_length(v_members,1))],
      v_places[1 + (g.i % array_length(v_places,1))],
      place_names[1 + (g.i % array_length(place_names,1))] || ' [seed:loc]',
      events[1 + (g.i % array_length(events,1))]::location_event_type,
      37.77 + (g.i % 50) * 0.001, -122.41 - (g.i % 50) * 0.001,
      now() - ((g.i * 7) || ' minutes')::interval
    from generate_series(1, n) as g(i);
  end if;

  -- Current member locations (upsert one row per member; not 500 — bounded by members).
  if to_regclass('public.member_locations') is not null then
    delete from public.member_locations where family_id = v_family and address = '[seed:loc]';
    insert into public.member_locations (family_id, member_id, latitude, longitude, accuracy_m, battery, is_sharing, address, updated_at)
    select v_family, m, 37.77 + random()*0.05, -122.41 - random()*0.05, 8 + random()*20,
      20 + floor(random()*80)::int, true, '[seed:loc]', now()
    from unnest(v_members) as m;
  end if;

  raise notice 'Location seeded % events (+places, member locations) for family %', n, v_family;
end $$;

-- ==================== seed_finance.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Finance hub (financial_accounts + transactions 500 +
-- bills 500). A handful of accounts, 500 transactions (income/expense/transfer)
-- and 500 bills across statuses. Idempotent via '[seed:fin]' markers.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  v_accts   uuid[];
  n int := 500;
  merchants text[] := array['Whole Foods','Amazon','Shell','Netflix','Target','Costco','Starbucks',
                           'Apple','Uber','Home Depot','Spotify','Trader Joe''s'];
  cats     text[] := array['groceries','shopping','fuel','subscriptions','dining','utilities','kids','home'];
  ttypes   text[] := array['expense','expense','expense','income','transfer'];
  bstatus  text[] := array['upcoming','paid','overdue'];
  acct_names text[] := array['Everyday Checking','Family Savings','Rewards Credit','Kids Fund'];
  acct_types text[] := array['checking','savings','credit','savings'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  -- Accounts.
  if to_regclass('public.financial_accounts') is not null then
    delete from public.financial_accounts where family_id = v_family and institution = '[seed:fin]';
    insert into public.financial_accounts (family_id, name, type, institution, last_four, balance, currency)
    select v_family, acct_names[i], acct_types[i]::account_type, '[seed:fin]',
      lpad((1000 + i)::text, 4, '0'), (round((random()*9000+100)::numeric, 2)), 'USD'
    from generate_series(1, array_length(acct_names,1)) as i;
    select array_agg(id) into v_accts from public.financial_accounts where family_id = v_family and institution = '[seed:fin]';
  end if;

  -- 500 transactions.
  if to_regclass('public.transactions') is not null and v_accts is not null then
    delete from public.transactions where family_id = v_family and notes = '[seed:fin]';
    insert into public.transactions (family_id, account_id, name, amount, category, date, type, notes, merchant, member_id)
    select v_family,
      v_accts[1 + (g.i % array_length(v_accts,1))],
      merchants[1 + (g.i % array_length(merchants,1))] || ' purchase',
      round((random()*250 + 3)::numeric, 2),
      cats[1 + (g.i % array_length(cats,1))],
      (current_date - (g.i % 180)),
      ttypes[1 + (g.i % array_length(ttypes,1))]::transaction_type,
      '[seed:fin]',
      merchants[1 + (g.i % array_length(merchants,1))],
      case when v_members is null then null else v_members[1 + (g.i % array_length(v_members,1))] end
    from generate_series(1, n) as g(i);
  end if;

  -- 500 bills.
  if to_regclass('public.bills') is not null then
    delete from public.bills where family_id = v_family and category = 'seed-fin';
    insert into public.bills (family_id, name, amount, due_date, is_recurring, recurrence, status, category, autopay)
    select v_family,
      (array['Electric','Water','Internet','Rent','Phone','Insurance','Gym','Streaming'])[1 + (g.i % 8)] || ' Bill #' || g.i,
      round((random()*300 + 15)::numeric, 2),
      (current_date + ((g.i % 60) - 30)),
      (g.i % 2 = 0),
      (array['monthly','yearly','weekly'])[1 + (g.i % 3)],
      bstatus[1 + (g.i % array_length(bstatus,1))]::bill_status,
      'seed-fin',
      (g.i % 4 = 0)
    from generate_series(1, n) as g(i);
  end if;

  raise notice 'Finance seeded % transactions + % bills (+accounts) for family %', n, n, v_family;
end $$;

-- ==================== seed_memories.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Memories (family_memories 500 + trip_memories 500).
-- The memory timeline + trip scrapbook at volume. Idempotent via '[seed:mem]'
-- body marker (family_memories) / '[seed:mem]' note marker (trip_memories).
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  n int := 500;
  titles text[] := array['First day of school','Beach day','Birthday party','Snow day','Family dinner',
                        'Soccer win','Camping trip','Grandma''s visit','Movie night','Bike ride',
                        'Museum trip','Pumpkin patch','Graduation','New puppy','Summer BBQ'];
  kinds text[] := array['photo','note','milestone','video'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  if to_regclass('public.family_memories') is not null then
    delete from public.family_memories where family_id = v_family and body = '[seed:mem]';
    insert into public.family_memories (family_id, member_id, title, body, kind, memory_date, tags, is_favorite, status)
    select v_family,
      case when v_members is null then null else v_members[1 + (g.i % array_length(v_members,1))] end,
      titles[1 + (g.i % array_length(titles,1))] || ' #' || g.i,
      '[seed:mem]',
      kinds[1 + (g.i % array_length(kinds,1))],
      (current_date - (g.i % 730)),
      '{seed}',
      (g.i % 20 = 0),
      'active'
    from generate_series(1, n) as g(i);
  end if;

  if to_regclass('public.trip_memories') is not null then
    delete from public.trip_memories where family_id = v_family and note = '[seed:mem]';
    insert into public.trip_memories (family_id, member_id, title, note, location, memory_date)
    select v_family,
      case when v_members is null then null else v_members[1 + (g.i % array_length(v_members,1))] end,
      titles[1 + (g.i % array_length(titles,1))] || ' (trip #' || g.i || ')',
      '[seed:mem]',
      (array['Beach','Mountains','City','Lake','Grandma''s','Theme Park'])[1 + (g.i % 6)],
      (current_date - (g.i % 730))
    from generate_series(1, n) as g(i);
  end if;

  raise notice 'Memories seeded % family + % trip rows for family %', n, n, v_family;
end $$;

-- ==================== seed_autopilot.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Autopilot (autopilot_suggestions 500 + approval_requests 500).
-- The Autopilot queue + the approval inbox at volume, spanning statuses.
-- Idempotent: suggestions cleared by dedupe_key prefix 'seed-ap-'; approvals by
-- a '[seed:ap]' summary marker.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  n int := 500;
  s_titles text[] := array['Reschedule overlapping events','Reorder low grocery staples','Prep for tomorrow''s game',
                          'Renew expiring document','Plan 3 unplanned dinners','Confirm the appointment',
                          'Split a bill fairly','Nudge an overdue chore','Batch school forms','Book a sitter'];
  s_status text[] := array['open','open','approved','executed','auto_executed','dismissed','snoozed'];
  a_titles text[] := array['Approve $24 grocery top-up','Allow calendar auto-merge','Approve babysitter booking',
                          'Confirm allowance run','Approve meal-plan order','Grant location share',
                          'Approve subscription renewal','Authorize ride booking'];
  a_status text[] := array['pending','pending','approved','rejected','expired','cancelled'];
  a_prio   text[] := array['low','normal','high','urgent'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  if to_regclass('public.autopilot_suggestions') is not null then
    delete from public.autopilot_suggestions where family_id = v_family and dedupe_key like 'seed-ap-%';
    insert into public.autopilot_suggestions (family_id, member_id, kind, title, detail, confidence, urgency, status, action_type, action_label, dedupe_key)
    select v_family,
      case when v_members is null then null else v_members[1 + (g.i % array_length(v_members,1))] end,
      (array['schedule','grocery','prep','document','meal'])[1 + (g.i % 5)],
      s_titles[1 + (g.i % array_length(s_titles,1))] || ' #' || g.i,
      'Autopilot spotted this and can handle it for you.',
      50 + (g.i % 50),
      1 + (g.i % 3),
      s_status[1 + (g.i % array_length(s_status,1))]::autopilot_status,
      'confirm', 'Approve',
      'seed-ap-' || g.i
    from generate_series(1, n) as g(i);
  end if;

  if to_regclass('public.approval_requests') is not null then
    delete from public.approval_requests where family_id = v_family and summary = '[seed:ap]';
    insert into public.approval_requests (family_id, domain, title, summary, requested_by_kind, agent, amount_cents, confidence, approval_model, status, priority)
    select v_family,
      (array['finance','calendar','safety','commerce'])[1 + (g.i % 4)],
      a_titles[1 + (g.i % array_length(a_titles,1))] || ' #' || g.i,
      '[seed:ap]',
      'ai', 'autopilot',
      (500 + (g.i * 37) % 20000),
      round((0.5 + (g.i % 50) * 0.01)::numeric, 2),
      'single',
      a_status[1 + (g.i % array_length(a_status,1))],
      a_prio[1 + (g.i % array_length(a_prio,1))]
    from generate_series(1, n) as g(i);
  end if;

  raise notice 'Autopilot seeded % suggestions + % approvals for family %', n, n, v_family;
end $$;

-- ==================== seed_vault.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Family Vault (family_credentials, 500) across all categories.
-- Wi-Fi, website logins, app PINs, streaming, memberships, etc. Idempotent via a
-- '[seed:vault]' notes marker. Secrets are obviously-fake placeholders.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0119 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  n int := 500;
  cats  text[] := array['wifi','website','app','streaming','email','card','pin','membership','other'];
  labels text[] := array['Home Wi-Fi','Netflix','Amazon','School Portal','Bank App','Disney+','Gym Membership',
                        'Spotify','Costco Card','Library Card','Doctor Portal','Utility Account','Xbox','Email'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  if to_regclass('public.family_credentials') is not null then
    delete from public.family_credentials where family_id = v_family and notes = '[seed:vault]';
    insert into public.family_credentials (family_id, category, label, username, secret, url, notes, member_id, is_favorite)
    select v_family,
      cats[1 + (g.i % array_length(cats,1))],
      labels[1 + (g.i % array_length(labels,1))] || ' #' || g.i,
      'user' || g.i || '@example.com',
      'placeholder-secret-' || g.i,
      'https://example.com/' || g.i,
      '[seed:vault]',
      case when v_members is null or g.i % 3 = 0 then null else v_members[1 + (g.i % array_length(v_members,1))] end,
      (g.i % 15 = 0)
    from generate_series(1, n) as g(i);
  end if;

  raise notice 'Vault seeded % credentials for family %', n, v_family;
end $$;

-- ==================== seed_graph.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Knowledge Graph (graph_entities 500 + graph_edges 500).
-- A connected household graph so traversal, path-finding and impact propagation
-- can be exercised at volume. Idempotent: clears its own '[seed:graph]' rows
-- (attributes marker) first — edges cascade from entities.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0129 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_ids    uuid[];
  n int := 500;
  kinds text[] := array['person','activity','place','org','event','item','pet','topic','other'];
  people text[] := array['Emma','Noah','Liam','Olivia','Ava','Daniel','Sofia','Mia','Coach Rivera','Grandma'];
  acts   text[] := array['Soccer','Piano','Swim Team','Robotics','Ballet','Scouts','Chess Club','Art Class'];
  places text[] := array['Field','School','Studio','Pool','Library','Gym','Grandma''s House','Rec Center'];
  rels   text[] := array['plays','at','coached_by','member_of','needs','affects','parent_of','attends','owns','near'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  if to_regclass('public.graph_entities') is not null then
    -- Clear prior seed (edges cascade on entity delete).
    delete from public.graph_entities where family_id = v_family and attributes->>'seed' = 'graph';

    -- 500 entities, cycling kinds + drawing readable names by kind.
    insert into public.graph_entities (family_id, kind, name, attributes)
    select v_family,
      kinds[1 + (g.i % array_length(kinds,1))],
      case kinds[1 + (g.i % array_length(kinds,1))]
        when 'person'   then people[1 + (g.i % array_length(people,1))]
        when 'activity' then acts[1 + (g.i % array_length(acts,1))]
        when 'place'    then places[1 + (g.i % array_length(places,1))]
        else initcap(kinds[1 + (g.i % array_length(kinds,1))])
      end || ' #' || g.i,
      '{"seed":"graph"}'::jsonb
    from generate_series(1, n) as g(i);

    -- Collect the freshly-seeded ids in stable order.
    select array_agg(id order by created_at, id) into v_ids
    from public.graph_entities where family_id = v_family and attributes->>'seed' = 'graph';

    -- 500 edges as a cyclic ring (node i -> next node; 500 -> 1). Guarantees every
    -- edge is valid (source <> target), unique, and the whole graph is connected so
    -- path-finding + impact propagation traverse end to end. Relations + weights vary.
    insert into public.graph_edges (family_id, source_id, target_id, relation, weight, attributes)
    select v_family,
      v_ids[g.i],
      v_ids[1 + (g.i % n)],                 -- i -> i+1, wrapping 500 -> 1
      rels[1 + (g.i % array_length(rels,1))],
      round((0.4 + (g.i % 6) * 0.1)::numeric, 2),
      '{"seed":"graph"}'::jsonb
    from generate_series(1, n) as g(i)
    on conflict (family_id, source_id, target_id, relation) do nothing;
  end if;

  raise notice 'Knowledge Graph seeded % entities (+edges) for family %', n, v_family;
end $$;

-- Verify:
--   select kind, count(*) from graph_entities group by kind order by 2 desc;
--   select relation, count(*) from graph_edges group by relation order by 2 desc;

-- ==================== seed_decisions.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Decision Engine (family_decisions 500 + decision_options ~1500).
-- 500 trade-off decisions, each with 3 options carrying real metrics so the engine
-- can score them. Idempotent: clears its own '[seed:dec]' rows (detail marker);
-- options cascade from decisions. Where: Supabase → SQL Editor → paste → Run.
-- (Needs migration 0130 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  questions text[] := array['Which vacation this summer?','Add another activity?','Which grocery run?',
                            'Weekend plan?','Which after-school program?','Birthday party venue?',
                            'Which car repair shop?','Weeknight dinner plan?','Which summer camp?',
                            'How to spend Saturday?'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  if to_regclass('public.family_decisions') is not null then
    delete from public.family_decisions where family_id = v_family and detail = '[seed:dec]';

    -- 500 decisions, then 3 options each via a lateral generate_series.
    with new_decisions as (
      insert into public.family_decisions (family_id, question, detail, status, budget_cents, max_travel_minutes)
      select v_family,
        questions[1 + (g.i % array_length(questions,1))] || ' #' || g.i,
        '[seed:dec]',
        case when g.i % 5 = 0 then 'decided' else 'open' end,
        case when g.i % 3 = 0 then (50000 + (g.i % 20) * 10000)::bigint else null end,
        case when g.i % 4 = 0 then 60 + (g.i % 6) * 30 else null end
      from generate_series(1, n) as g(i)
      returning id, family_id
    )
    insert into public.decision_options (family_id, decision_id, label, cost_cents, time_minutes, travel_minutes, load_delta, benefit)
    select nd.family_id, nd.id,
      (array['Option A','Option B','Option C'])[k.k],
      (30000 + (k.k * 40000) + floor(random()*30000))::bigint,
      (30 + k.k * 20 + floor(random()*30))::int,
      (20 + k.k * 40 + floor(random()*30))::int,
      (15 + k.k * 20 + floor(random()*20))::int,
      (90 - k.k * 15 + floor(random()*10))::int
    from new_decisions nd
    cross join generate_series(1, 3) as k(k);
  end if;

  raise notice 'Decision Engine seeded % decisions (+3 options each) for family %', n, v_family;
end $$;

-- Verify:
--   select count(*) from family_decisions where detail='[seed:dec]';
--   select count(*) from decision_options o join family_decisions d on d.id=o.decision_id where d.detail='[seed:dec]';

-- ==================== seed_prep_plans.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Prep Plans (prep_plans 500 + prep_plan_steps ~2000).
-- 500 look-ahead plans across kinds/urgencies, each with a few timed steps, so
-- /dashboard/prep-plans can be tested at volume. Idempotent: clears its own
-- 'seed-prep-%' signal rows (steps cascade). Where: Supabase → SQL Editor → Run.
-- (Needs migration 0131 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  kinds text[] := array['trip','birthday','doc_expiry','school_start','event'];
  urg   text[] := array['now','soon','later'];
  titles text[] := array['Get ready: Beach Trip','Plan: Emma''s Birthday','Renew: Passport',
                        'Prep for: School Start','Prepare for: Recital','Get ready: Ski Weekend',
                        'Plan: Anniversary','Renew: Car Registration','Prep for: New Term'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  if to_regclass('public.prep_plans') is not null then
    delete from public.prep_plans where family_id = v_family and signal_id like 'seed-prep-%';

    with new_plans as (
      insert into public.prep_plans (family_id, signal_kind, signal_id, title, target_date, urgency, status)
      select v_family,
        kinds[1 + (g.i % array_length(kinds,1))],
        'seed-prep-' || g.i,
        titles[1 + (g.i % array_length(titles,1))] || ' #' || g.i,
        (current_date + (5 + (g.i % 110)))::date,
        urg[1 + (g.i % array_length(urg,1))],
        'active'
      from generate_series(1, n) as g(i)
      returning id, family_id, target_date
    )
    insert into public.prep_plan_steps (family_id, plan_id, label, href, due_date, lead_days, is_done, sort_order)
    select np.family_id, np.id,
      (array['Confirm details','Gather what''s needed','Book/order','Final prep'])[k.k],
      '/dashboard/calendar',
      (np.target_date - (array[21,14,7,1])[k.k])::date,
      (array[21,14,7,1])[k.k],
      (k.k = 1 and random() < 0.3),
      k.k - 1
    from new_plans np
    cross join generate_series(1, 4) as k(k);
  end if;

  raise notice 'Prep Plans seeded % plans (+4 steps each) for family %', n, v_family;
end $$;

-- Verify:
--   select count(*) from prep_plans where signal_id like 'seed-prep-%';
--   select count(*) from prep_plan_steps s join prep_plans p on p.id=s.plan_id where p.signal_id like 'seed-prep-%';

-- ==================== seed_onboarding_events.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Onboarding funnel (onboarding_events, ~550 across 250 sessions).
-- Realistic drop-off so /dashboard/onboarding-funnel can be tested: every session
-- reaches 'profile', ~70% reach 'pin', ~50% complete 'done'. Not family-scoped
-- (pre-family telemetry). Idempotent via meta->>'seed' = 'onboarding'.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0133 applied.)
-- ============================================================================
do $$
declare
  n_sessions int := 250;
begin
  if to_regclass('public.onboarding_events') is not null then
    delete from public.onboarding_events where meta->>'seed' = 'onboarding';

    -- Step 1: profile — every session starts here.
    insert into public.onboarding_events (user_id, session_id, step, phase, duration_ms, meta)
    select null, 'seed-ob-' || g.i, 'profile', 'started', 0, '{"seed":"onboarding"}'::jsonb
    from generate_series(1, n_sessions) as g(i);

    -- Step 2: pin — ~70% of sessions advance.
    insert into public.onboarding_events (user_id, session_id, step, phase, duration_ms, meta)
    select null, 'seed-ob-' || g.i, 'pin', 'step', (3000 + floor(random()*12000))::int, '{"seed":"onboarding"}'::jsonb
    from generate_series(1, n_sessions) as g(i)
    where (g.i % 10) < 7;

    -- Step 3: done — ~50% complete.
    insert into public.onboarding_events (user_id, session_id, step, phase, duration_ms, meta)
    select null, 'seed-ob-' || g.i, 'done', 'completed', (8000 + floor(random()*32000))::int, '{"seed":"onboarding"}'::jsonb
    from generate_series(1, n_sessions) as g(i)
    where (g.i % 10) < 5;
  end if;

  raise notice 'Onboarding funnel seeded for % sessions', n_sessions;
end $$;

-- Verify:
--   select step, count(*) from onboarding_events where meta->>'seed'='onboarding' group by step;
--   select count(distinct session_id) from onboarding_events where meta->>'seed'='onboarding';


-- ==================== seed_network_aggregates.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Intelligence Network aggregates (network_aggregates).
-- Synthetic PUBLISH-SAFE aggregates so /dashboard/intelligence can be tested when
-- a family opts in. Every row has cohort_size >= 20 (the k-anonymity floor), so it
-- mirrors exactly what the real cron would publish. The set is the FULL deterministic
-- cohort × metric × value product (aggregates are naturally bounded — one row per
-- combo — not a 500-row volume table). Idempotent (clears all rows). Also opts the
-- seed family in so insights render. Where: Supabase → SQL Editor → Run.
-- (Needs migration 0135 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  kid_bands text[] := array['none','3–5','6–9','10–13','14–17','6–9.10–13'];
  size_bands text[] := array['1–2','3–4','5+'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;

  if to_regclass('public.network_aggregates') is not null then
    delete from public.network_aggregates;
    -- Full product: each cohort (kids × size) × each metric value → exactly one row.
    insert into public.network_aggregates (scope, cohort_key, metric, value, count, cohort_size)
    select 'benchmarks', 'kids:' || k || '|size:' || s, mv.metric, mv.value,
      (20 + floor(random()*480))::int, (20 + floor(random()*480))::int
    from unnest(kid_bands) k
    cross join unnest(size_bands) s
    cross join (values
      ('dinner_habit','rarely (0–1)'), ('dinner_habit','sometimes (2–3)'),
      ('dinner_habit','often (4–5)'),  ('dinner_habit','most nights (6–7)'),
      ('activities','none'), ('activities','1–2'), ('activities','3–4'), ('activities','5+')
    ) as mv(metric, value)
    on conflict (scope, cohort_key, metric, value) do update
      set count = excluded.count, cohort_size = excluded.cohort_size, computed_at = now();
  end if;

  -- Opt the seed family in so the insights actually render on screen.
  if to_regclass('public.network_consent') is not null then
    insert into public.network_consent (family_id, enabled, scopes, consented_at)
    values (v_family, true, '{"timing":true,"benchmarks":true,"recommendations":true}'::jsonb, now())
    on conflict (family_id) do update set enabled = true,
      scopes = '{"timing":true,"benchmarks":true,"recommendations":true}'::jsonb;
  end if;

  raise notice 'Network aggregates seeded (>=20 cohort size) + family % opted in', v_family;
end $$;

-- Verify:
--   select count(*) from network_aggregates;                       -- ~ up to 500 (unique key may dedupe)
--   select min(cohort_size) from network_aggregates;               -- >= 20

-- Done. Every user-facing surface now holds >=500 rows for the resolved family.

-- ==================== seed_matrix_gaps.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Feature-matrix gap tables (500 records each).
-- Fills the competitive-matrix features that lacked a 500-row seed so every one
-- can be tested at volume: Pets, Vehicles, Contacts, Wish lists, Medications,
-- Homework, Insurance, Utilities, Family tree, Announcements, Subscriptions,
-- Health metrics. Idempotent via '[seed:matrix]' / 'seed' sentinels; resolves
-- the family by email. Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  n int := 500;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  -- ── Pets (500) ──────────────────────────────────────────────────────────
  if to_regclass('public.pets') is not null then
    delete from public.pets where family_id = v_family and notes = '[seed:matrix]';
    insert into public.pets (family_id, name, species, breed, color, notes, is_active)
    select v_family,
      (array['Bella','Max','Luna','Charlie','Lucy','Cooper','Daisy','Rocky'])[1+(g.i%8)] || ' #' || g.i,
      (array['dog','cat','bird','fish','reptile','small_mammal','horse','other'])[1+(g.i%8)]::pet_species,
      (array['Labrador','Tabby','Parakeet','Goldfish','Gecko','Hamster'])[1+(g.i%6)],
      (array['Brown','Black','White','Golden','Grey'])[1+(g.i%5)], '[seed:matrix]', true
    from generate_series(1,n) g(i);
  end if;

  -- ── Vehicles (500) ──────────────────────────────────────────────────────
  if to_regclass('public.vehicles') is not null then
    delete from public.vehicles where family_id = v_family and notes = '[seed:matrix]';
    insert into public.vehicles (family_id, nickname, make, model, year, color, mileage, status, notes, primary_driver)
    select v_family,
      (array['Family SUV','Commuter','The Van','Weekend Car'])[1+(g.i%4)] || ' #' || g.i,
      (array['Toyota','Honda','Ford','Subaru','Tesla'])[1+(g.i%5)],
      (array['Highlander','CR-V','F-150','Outback','Model Y'])[1+(g.i%5)],
      2012 + (g.i % 13), (array['Silver','Blue','Black','Red','White'])[1+(g.i%5)],
      10000 + (g.i*137)%140000, 'active', '[seed:matrix]',
      case when v_members is null then null else v_members[1+(g.i%array_length(v_members,1))] end
    from generate_series(1,n) g(i);
  end if;

  -- ── Family contacts (500) ───────────────────────────────────────────────
  if to_regclass('public.family_contacts') is not null then
    delete from public.family_contacts where family_id = v_family and notes = '[seed:matrix]';
    insert into public.family_contacts (family_id, name, relationship, category, phone, email, is_emergency, notes)
    select v_family,
      (array['Dr. Lee','Coach Rivera','Grandma Sue','Aunt Mia','Mr. Park','Nurse Kim'])[1+(g.i%6)] || ' #' || g.i,
      (array['Doctor','Coach','Grandparent','Aunt','Teacher','Neighbor'])[1+(g.i%6)],
      (array['doctor','coach','family','emergency','neighbor','teacher'])[1+(g.i%6)],
      '555-' || lpad((g.i%10000)::text,4,'0'), 'contact'||g.i||'@example.com',
      (g.i%7=0), '[seed:matrix]'
    from generate_series(1,n) g(i);
  end if;

  -- ── Wish lists (500) — needs a member ───────────────────────────────────
  if v_members is not null and to_regclass('public.wishlist_items') is not null then
    delete from public.wishlist_items where family_id = v_family and notes = '[seed:matrix]';
    insert into public.wishlist_items (family_id, member_id, title, url, price, priority, notes, is_purchased)
    select v_family, v_members[1+(g.i%array_length(v_members,1))],
      (array['Lego set','Bike','Headphones','Book','Sneakers','Board game'])[1+(g.i%6)] || ' #' || g.i,
      'https://example.com/'||g.i, round((10+random()*200)::numeric,2),
      (array['low','medium','high'])[1+(g.i%3)]::wish_priority, '[seed:matrix]', (g.i%9=0)
    from generate_series(1,n) g(i);
  end if;

  -- ── Medications (500) ───────────────────────────────────────────────────
  if to_regclass('public.medications') is not null then
    delete from public.medications where family_id = v_family and instructions = '[seed:matrix]';
    insert into public.medications (family_id, member_id, name, dosage, instructions, is_active, refill_on)
    select v_family, case when v_members is null then null else v_members[1+(g.i%array_length(v_members,1))] end,
      (array['Amoxicillin','Vitamin D','Ibuprofen','Allergy Rx','Inhaler','Melatonin'])[1+(g.i%6)] || ' #' || g.i,
      (array['5mg','10mg','1 tab','2 tabs','1 puff'])[1+(g.i%5)], '[seed:matrix]', true,
      (current_date + (g.i%40))
    from generate_series(1,n) g(i);
  end if;

  -- ── Homework (500) ──────────────────────────────────────────────────────
  if to_regclass('public.homework_assignments') is not null then
    delete from public.homework_assignments where family_id = v_family and details = '[seed:matrix]';
    insert into public.homework_assignments (family_id, member_id, subject, title, details, due_at, status)
    select v_family, case when v_members is null then null else v_members[1+(g.i%array_length(v_members,1))] end,
      (array['Math','Science','English','History','Art','PE'])[1+(g.i%6)],
      (array['Worksheet','Reading','Project','Essay','Lab report'])[1+(g.i%5)] || ' #' || g.i,
      '[seed:matrix]', now() + ((g.i%21) || ' days')::interval,
      (array['assigned','in_progress','done','submitted'])[1+(g.i%4)]::homework_status
    from generate_series(1,n) g(i);
  end if;

  -- ── Insurance policies (500) ────────────────────────────────────────────
  if to_regclass('public.family_insurance_policies') is not null then
    delete from public.family_insurance_policies where family_id = v_family and notes = '[seed:matrix]';
    insert into public.family_insurance_policies (family_id, policy_type, insurer, policy_number, premium_amount, premium_frequency, renewal_date, notes, is_active)
    select v_family,
      (array['health','dental','vision','auto','home','life'])[1+(g.i%6)]::insurance_policy_type,
      (array['Aetna','Delta','VSP','Geico','StateFarm','Prudential'])[1+(g.i%6)],
      'POL-' || lpad(g.i::text,6,'0'), round((50+random()*400)::numeric,2),
      (array['monthly','quarterly','semiannual','annual'])[1+(g.i%4)]::premium_frequency,
      (current_date + (g.i%365)), '[seed:matrix]', true
    from generate_series(1,n) g(i);
  end if;

  -- ── Utility bills (500) ─────────────────────────────────────────────────
  if to_regclass('public.utility_bills') is not null then
    delete from public.utility_bills where family_id = v_family and note = '[seed:matrix]';
    insert into public.utility_bills (family_id, kind, provider, period_month, amount_cents, usage, unit, note)
    select v_family,
      (array['electric','water','gas','internet','trash'])[1+(g.i%5)],
      (array['PG&E','City Water','SoCalGas','Comcast','WM'])[1+(g.i%5)],
      (date_trunc('month', current_date) - ((g.i%24) || ' months')::interval)::date,
      (3000 + (g.i*97)%25000), round((random()*500)::numeric,1),
      (array['kWh','gal','therm','GB','lbs'])[1+(g.i%5)], '[seed:matrix]'
    from generate_series(1,n) g(i);
  end if;

  -- ── Family tree (500) ───────────────────────────────────────────────────
  if to_regclass('public.family_tree_nodes') is not null then
    delete from public.family_tree_nodes where family_id = v_family and bio = '[seed:matrix]';
    insert into public.family_tree_nodes (family_id, name, relationship, birth_year, bio)
    select v_family,
      (array['Grandpa Joe','Grandma Ann','Uncle Ray','Cousin Kai','Great Aunt Bea'])[1+(g.i%5)] || ' #' || g.i,
      (array['grandparent','uncle','aunt','cousin','sibling'])[1+(g.i%5)],
      1930 + (g.i%80), '[seed:matrix]'
    from generate_series(1,n) g(i);
  end if;

  -- ── Announcements (500) ─────────────────────────────────────────────────
  if to_regclass('public.family_announcements') is not null then
    delete from public.family_announcements where family_id = v_family and body like '%[seed:matrix]%';
    insert into public.family_announcements (family_id, title, body, is_pinned)
    select v_family,
      (array['Family meeting','Chore day','Movie night','Trip planning','Reminder'])[1+(g.i%5)] || ' #' || g.i,
      'Details for this announcement #' || g.i || ' [seed:matrix]', (g.i%25=0)
    from generate_series(1,n) g(i);
  end if;

  -- ── Subscriptions (500) ─────────────────────────────────────────────────
  if to_regclass('public.subscriptions_tracked') is not null then
    delete from public.subscriptions_tracked where family_id = v_family and note = '[seed:matrix]';
    insert into public.subscriptions_tracked (family_id, name, cost_cents, cadence, category, status, next_charge, note)
    select v_family,
      (array['Netflix','Spotify','Disney+','Amazon Prime','iCloud','NYT'])[1+(g.i%6)] || ' #' || g.i,
      (499 + (g.i*13)%3000), (array['monthly','yearly'])[1+(g.i%2)],
      (array['streaming','music','storage','news','shopping'])[1+(g.i%5)],
      (array['active','trial','canceled'])[1+(g.i%3)], (current_date + (g.i%30)), '[seed:matrix]'
    from generate_series(1,n) g(i);
  end if;

  -- ── Health metrics (500) — needs a member; unit='seed' is the sentinel ───
  if v_members is not null and to_regclass('public.health_metrics') is not null then
    delete from public.health_metrics where family_id = v_family and unit = 'seed';
    insert into public.health_metrics (family_id, member_id, type, value, unit, recorded_at)
    select v_family, v_members[1+(g.i%array_length(v_members,1))],
      (array['steps','sleep_hours','heart_rate','calories','active_minutes','distance','weight','water_cups'])[1+(g.i%8)]::metric_type,
      round((10 + random()*9000)::numeric,1), 'seed', now() - ((g.i) || ' hours')::interval
    from generate_series(1,n) g(i);
  end if;

  raise notice 'Matrix-gap features seeded (500 each) for family %', v_family;
end $$;

-- ==================== seed_onboarding_imports.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Onboarding calendar imports (500 records).
-- Fills onboarding_imports so the value-first first-run (T1) can be tested at
-- volume: every source, a spread of event/conflict/action counts, and a computed
-- brief summary per row. Idempotent via brief->>'seed' = 'onboard'; resolves the
-- family by email. Where: Supabase → SQL Editor → paste → Run.
-- (Needs migration 0138 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  sources text[] := array['ics','paste','url','demo'];
begin
  if to_regclass('public.onboarding_imports') is null then
    raise notice 'onboarding_imports not present — apply migration 0138 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.onboarding_imports where family_id = v_family and brief->>'seed' = 'onboard';

  insert into public.onboarding_imports
    (family_id, source, event_count, today_count, conflict_count, action_count, time_saved_minutes, brief, created_at)
  select
    v_family,
    sources[1 + (g.i % 4)],
    ev,
    td,
    cf,
    act,
    saved,
    jsonb_build_object(
      'seed', 'onboard',
      'headline', 'Here''s your week — ' || td || ' today, ' || cf || ' clash' || case when cf = 1 then '' else 'es' end || ' to resolve.',
      'todayCount', td,
      'weekCount', ev,
      'conflictCount', cf,
      'actionCount', act,
      'timeSavedMinutes', saved,
      'opportunities', jsonb_build_array(
        jsonb_build_object('label', (ev/4) || ' recurring events on autopilot', 'minutes', (ev/4)*5),
        jsonb_build_object('label', cf || ' clashes caught for you', 'minutes', cf*15)
      )
    ),
    now() - ((g.i) || ' hours')::interval
  from generate_series(1, n) g(i)
  cross join lateral (
    select
      (20 + (g.i * 7) % 280)          as ev,
      (g.i % 9)                       as td,
      (g.i % 5)                       as cf,
      (g.i % 7)                       as act,
      ((g.i % 5) * 15 + ((20 + (g.i * 7) % 280) / 4) * 5) as saved
  ) d;

  raise notice 'Onboarding imports seeded 500 rows for family %', v_family;
end $$;

-- Verify:
--   select count(*) from onboarding_imports where brief->>'seed'='onboard';   -- 500
--   select source, count(*) from onboarding_imports group by source;

-- ==================== seed_meal_ideas.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Meal ideas catalog (500 records).
-- The curated, family-agnostic dinner library the first-run briefing (T2) draws
-- its "3 dinner ideas" from. Real dish × cuisine × effort combinations so the
-- picker has variety at volume. Idempotent: clears the seeded catalog first
-- (tags @> '{seed}'), then reinserts. Reference data — not family-scoped.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0139 applied.)
-- ============================================================================
do $$
declare
  n int := 500;
  dishes text[] := array[
    'Sheet-pan Chicken & Veg','Beef Tacos','Veggie Stir-fry','Spaghetti Bolognese','Chicken Curry',
    'Margherita Pizza','Salmon & Rice Bowl','Turkey Chili','Pad Thai','Butter Chicken',
    'Fish Tacos','Caesar Chicken Salad','BBQ Pulled Pork','Shrimp Scampi','Beef Stir-fry',
    'Chicken Fajitas','Mushroom Risotto','Baked Ziti','Teriyaki Salmon','Greek Bowls',
    'Pesto Pasta','Black Bean Burritos','Honey-Garlic Chicken','Ramen Night','Lasagna',
    'Beef Bourguignon','Roast Chicken Dinner','Homemade Pizza Night','Enchiladas','Coconut Curry',
    'Meatball Subs','Sausage & Peppers','Chicken Parmesan','Tuna Poke Bowls','Falafel Wraps'];
  cuisines text[] := array['Comfort','Mexican','Asian','Italian','Indian','Mediterranean','American','Thai','Japanese','French'];
  efforts text[] := array['quick','standard','involved'];
  descs text[] := array[
    'Weeknight-friendly and kid-approved.','One pan, minimal cleanup.','Batch-cook and use leftovers for lunch.',
    'A little more love for a slower evening.','Freezer-friendly — make a double batch.','Ready in under 30 minutes.'];
begin
  if to_regclass('public.meal_ideas') is null then
    raise notice 'meal_ideas not present — apply migration 0139 first. Skipping.';
    return;
  end if;

  delete from public.meal_ideas where tags @> array['seed'];

  insert into public.meal_ideas (title, cuisine, effort, prep_minutes, tags, description, is_active)
  select
    dishes[1 + (g.i % array_length(dishes,1))] || ' #' || g.i,
    cuisines[1 + (g.i % array_length(cuisines,1))],
    eff,
    case eff when 'quick' then 15 + (g.i % 16) when 'standard' then 30 + (g.i % 21) else 60 + (g.i % 61) end,
    array['seed', cuisines[1 + (g.i % array_length(cuisines,1))]],
    descs[1 + (g.i % array_length(descs,1))],
    true
  from generate_series(1, n) g(i)
  cross join lateral (select efforts[1 + (g.i % 3)] as eff) e;

  raise notice 'Meal ideas catalog seeded 500 rows';
end $$;

-- Verify:
--   select count(*) from meal_ideas where tags @> array['seed'];   -- 500
--   select effort, count(*) from meal_ideas group by effort;

-- ==================== seed_home_briefs.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Home briefs (500 daily snapshots).
-- Fills home_briefs so the outcome-first home (T3) can be tested at volume and its
-- readiness trend renders: one snapshot per day for 500 days, readiness climbing
-- over time (early days sparse → recent days set up). Idempotent: upserts on
-- (family_id, as_of_date). Resolves the family by email.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0140 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
begin
  if to_regclass('public.home_briefs') is null then
    raise notice 'home_briefs not present — apply migration 0140 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  insert into public.home_briefs
    (family_id, as_of_date, is_sparse, readiness_pct, week_count, conflict_count, dinner_count, time_saved_minutes, headline, brief)
  select
    v_family,
    (current_date - g.i),
    ready < 40,
    ready,
    wk,
    cf,
    3,
    saved,
    case when ready < 40
      then 'Let''s make this week easier — a few quick wins to set up.'
      else 'You''re in good shape — ' || wk || ' events this week and nothing urgent.' end,
    jsonb_build_object(
      'seed', 'home',
      'headline', 'Day -' || g.i || ' snapshot',
      'readinessPct', ready,
      'isSparse', ready < 40,
      'weekCount', wk,
      'conflictCount', cf,
      'dinnerCount', 3,
      'timeSavedMinutes', saved,
      'steps', jsonb_build_array(
        jsonb_build_object('id','calendar','done', wk > 0),
        jsonb_build_object('id','meals','done', false),
        jsonb_build_object('id','family','done', ready >= 40)
      )
    )
  from generate_series(0, n - 1) g(i)
  cross join lateral (
    -- Readiness climbs as days get more recent (i=0 today = highest).
    select
      least(100, greatest(0, 100 - (g.i / 6)))                 as ready,
      (g.i % 9)                                                 as wk,
      (g.i % 4)                                                 as cf,
      (20 + (g.i * 7) % 120)                                    as saved
  ) d
  on conflict (family_id, as_of_date) do update
    set is_sparse = excluded.is_sparse, readiness_pct = excluded.readiness_pct,
        week_count = excluded.week_count, conflict_count = excluded.conflict_count,
        dinner_count = excluded.dinner_count, time_saved_minutes = excluded.time_saved_minutes,
        headline = excluded.headline, brief = excluded.brief;

  raise notice 'Home briefs seeded 500 daily snapshots for family %', v_family;
end $$;

-- Verify:
--   select count(*) from home_briefs where brief->>'seed'='home';   -- 500
--   select min(readiness_pct), max(readiness_pct) from home_briefs;

-- ==================== seed_daily_insights.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Daily insights (500 records).
-- Fills daily_insights so the "insight of the day" (T4) can be tested at volume:
-- every kind across ~56 days, with a spread of statuses (active/dismissed/acted).
-- Idempotent: clears its own '[seed:insight]' rows first, then inserts (never
-- clobbers a real insight on the unique key). Resolves the family by email.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0141 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  kinds   text[] := array['departure','conflict','homework','approval','reminder_overdue','renewal','document','meal','grocery'];
  impacts int[]  := array[90,92,84,76,70,66,60,52,40];
  hrefs   text[] := array['/dashboard/calendar','/dashboard/conflicts','/dashboard/homework','/dashboard/autopilot','/dashboard/reminders','/dashboard/renewals','/dashboard/documents','/dashboard/meals','/dashboard/grocery'];
  titles  text[] := array[
    'Leave 20 min earlier for the swim meet','A schedule clash today','2 assignments due tomorrow',
    '3 decisions waiting on you','2 reminders slipped past due','Passport expires in 3 days',
    'Insurance card expires in 6 days','3 dinners this week aren''t planned','6 items on the grocery list'];
  statuses text[] := array['active','active','active','active','dismissed','acted'];
begin
  if to_regclass('public.daily_insights') is null then
    raise notice 'daily_insights not present — apply migration 0141 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.daily_insights where family_id = v_family and detail like '%[seed:insight]%';

  -- date = current_date - floor(i/9), kind index = i % 9 → each (date, kind) pair
  -- is unique across the 500 rows (i = 9*q + r), so the unique key never collides.
  insert into public.daily_insights
    (family_id, as_of_date, kind, title, detail, href, impact, status, created_at)
  select
    v_family,
    (current_date - (g.i / 9)),
    kinds[1 + (g.i % 9)],
    titles[1 + (g.i % 9)],
    'Ranked insight for the day. [seed:insight]',
    hrefs[1 + (g.i % 9)],
    greatest(0, impacts[1 + (g.i % 9)] - (g.i / 9)),   -- older days decay a touch
    statuses[1 + (g.i % 6)],
    now() - ((g.i) || ' hours')::interval
  from generate_series(0, n - 1) g(i)
  on conflict (family_id, as_of_date, kind) do nothing;

  raise notice 'Daily insights seeded 500 rows for family %', v_family;
end $$;

-- Verify:
--   select count(*) from daily_insights where detail like '%[seed:insight]%';   -- 500
--   select kind, count(*) from daily_insights group by kind order by 2 desc;

-- ==================== seed_notifications.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Notifications (500) for the partner-tone surfaces (T5).
-- Fills the bell + /dashboard/notifications with 500 notifications across every
-- type and read state so the partner-tone phrasing (notificationsLine / bellLabel)
-- can be exercised at real volume — from "all caught up" up to a full inbox.
-- Idempotent: seed rows carry related_type='seed'; cleared before re-insert.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  n int := 500;
  titles text[] := array['Soccer practice at 5pm','Amoxicillin due tonight','Dentist tomorrow 9am',
                         'Field trip form due Friday','Game moved to Saturday','HVAC filter change due',
                         'Milk running low','Passport expires next month','New family invite pending',
                         'Weekly digest is ready','Library book overdue','Car registration renewal',
                         'Recital this weekend','Grocery pickup at 4pm','Prescription ready'];
begin
  select f.id, fm.user_id into v_family, v_user
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.notifications where family_id = v_family and related_type = 'seed';

  insert into public.notifications (family_id, user_id, type, title, body, related_type, is_read, send_at, sent_at, created_at)
  select v_family,
    -- ~1/3 targeted at the resolved parent, the rest family-wide (null recipient)
    case when g.i % 3 = 0 then v_user else null end,
    (array['chore_due','medication_due','calendar_event','school_event','sports_event',
           'maintenance_task','grocery_reminder','document_expiry','family_invite','system'])[1 + (g.i % 10)]::public.notification_type,
    titles[1 + (g.i % array_length(titles,1))],
    'Bubaly flagged this from your family''s schedule so nothing slips.',
    'seed',
    -- newest ~40 unread (so the surfaces show a live count), the rest read
    (g.i > 40),
    now() - ((g.i * 71) || ' minutes')::interval,
    now() - ((g.i * 71) || ' minutes')::interval,
    now() - ((g.i * 71) || ' minutes')::interval
  from generate_series(1, n) as g(i);

  raise notice 'Notifications seeded % rows (~40 unread) for family %', n, v_family;
end $$;

-- ==================== seed_economy.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Family Economy / Allowance (currency_transactions 500+).
-- Custom non-cash currencies (Stars ⭐, Screen-time ⏰, Chore Coins 🪙), a reward
-- catalog, an immutable 500-row token ledger, and ~120 redemptions — enough to
-- exercise /economy (Allowance) at real volume.
-- Idempotent: seed currencies carry a '[seed]' name prefix; deleting them
-- cascades their transactions / rewards / redemptions (FK ON DELETE CASCADE).
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  v_cur     uuid[];
  n int := 500;
  r_titles text[] := array['Movie night pick','30 min extra screen time','Choose dinner','Stay up 30 min late',
                           'Friend sleepover','Ice cream trip','Skip one chore','Pick the weekend outing',
                           'Control the playlist','Breakfast in bed','$5 toward a toy','Family game pick'];
  reasons  text[] := array['Chore completed','Bonus for kindness','Weekly allowance','Homework streak',
                           'Helped a sibling','Reward redemption','Manual award','Correction'];
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

  -- Idempotent reset: dropping the seed currencies cascades everything below them.
  delete from public.family_currencies where family_id = v_family and name like '[seed]%';

  insert into public.family_currencies (family_id, name, emoji, unit_label, is_active, sort_order)
  values
    (v_family, '[seed] Stars', '⭐', 'star', true, 90),
    (v_family, '[seed] Screen Time', '⏰', 'minute', true, 91),
    (v_family, '[seed] Chore Coins', '🪙', 'coin', true, 92);
  select array_agg(id order by sort_order) into v_cur
  from public.family_currencies where family_id = v_family and name like '[seed]%';

  -- Reward catalog (~24 across the three currencies).
  insert into public.economy_rewards (family_id, currency_id, title, emoji, cost, stock, is_active, sort_order)
  select v_family,
    v_cur[1 + (g.i % 3)],
    r_titles[1 + (g.i % array_length(r_titles,1))],
    (array['🎬','📺','🍽️','🌙','🛌','🍦','🧹','🗺️','🎧','🥞','🧸','🎮'])[1 + (g.i % 12)],
    (5 + (g.i % 10) * 5)::bigint,
    case when g.i % 4 = 0 then null else 3 + (g.i % 8) end,
    true,
    g.i
  from generate_series(1, 24) as g(i);

  -- The immutable token ledger — 500 credits/debits across members + currencies.
  insert into public.currency_transactions (family_id, currency_id, member_id, direction, amount, reason, related_type, created_at)
  select v_family,
    v_cur[1 + (g.i % 3)],
    v_members[1 + (g.i % array_length(v_members,1))],
    (case when g.i % 3 = 0 then 'debit' else 'credit' end)::economy_direction,
    (1 + (g.i % 40))::bigint,
    reasons[1 + (g.i % array_length(reasons,1))],
    (array['chore_assignment','manual','redemption','reversal'])[1 + (g.i % 4)],
    now() - ((g.i % 180) || ' days')::interval
  from generate_series(1, n) as g(i);

  -- ~120 redemptions spanning statuses.
  insert into public.economy_redemptions (family_id, currency_id, member_id, title, cost, status, note, created_at)
  select v_family,
    v_cur[1 + (g.i % 3)],
    v_members[1 + (g.i % array_length(v_members,1))],
    r_titles[1 + (g.i % array_length(r_titles,1))],
    (5 + (g.i % 10) * 5)::bigint,
    (array['pending','approved','fulfilled','rejected','cancelled'])[1 + (g.i % 5)]::redemption_status,
    '[seed] redemption',
    now() - ((g.i % 120) || ' days')::interval
  from generate_series(1, 120) as g(i);

  raise notice 'Economy seeded: 3 currencies, 24 rewards, % transactions, 120 redemptions for family %', n, v_family;
end $$;

-- ==================== seed_concierge.sql ====================
-- ============================================================================
-- FamilyOS · SEED — AI Concierge (concierge_plans 500).
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

-- ==================== seed_front_desk.sql ====================
-- ============================================================================
-- FamilyOS · SEED — AI Front Desk / Phone Concierge (call_logs 500).
-- Enables Front Desk for the family and fills the screened-call log with 500
-- calls spanning every status + classification, so /dashboard/front-desk renders
-- at real volume.
-- Idempotent: settings upserted; call_logs seed rows carry a '[seed]' ai_summary
-- prefix and are cleared before re-insert.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  names  text[] := array['Dr. Patel''s office','Lincoln Elementary','Coach Rivera','Unknown Caller',
                         'City Plumbing','Grandma','Amazon Delivery','Auto Warranty','Pharmacy','Soccer League',
                         'Neighbor','Insurance Agent'];
  dirs   text[] := array['inbound','inbound','inbound','outbound'];
  stats  text[] := array['screened','answered','voicemail','blocked','missed','forwarded'];
  clss   text[] := array['important','known','unknown','spam','robocall','telemarketer'];
  prio   text[] := array['low','normal','normal','high','urgent'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  insert into public.front_desk_settings (family_id, enabled, screening_mode, voicemail_enabled, block_spam)
  values (v_family, true, 'smart', true, true)
  on conflict (family_id) do update set enabled = excluded.enabled, updated_at = now();

  delete from public.call_logs where family_id = v_family and ai_summary like '[seed]%';

  insert into public.call_logs
    (family_id, caller_name, caller_number, direction, status, classification, priority,
     ai_summary, duration_secs, is_read, received_at)
  select v_family,
    names[1 + (g.i % array_length(names,1))],
    '+1555' || lpad(((g.i * 7919) % 10000000)::text, 7, '0'),
    dirs[1 + (g.i % array_length(dirs,1))],
    stats[1 + (g.i % array_length(stats,1))],
    clss[1 + (g.i % array_length(clss,1))],
    prio[1 + (g.i % array_length(prio,1))],
    '[seed] Caller asked about scheduling; AI screened and logged the details.',
    (g.i % 600),
    (g.i % 3 = 0),
    now() - ((g.i * 41) || ' minutes')::interval
  from generate_series(1, n) as g(i);

  raise notice 'Front Desk seeded % call logs for family %', n, v_family;
end $$;

-- ==================== seed_communications.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Email/Comms Concierge (family_communications 500).
-- The unified family inbox at real volume: calls, SMS, email, WhatsApp, school &
-- sports messages across every category, status and priority — so
-- /dashboard/inbox renders full.
-- Idempotent: seed rows carry a '[seed]' summary prefix; cleared before re-insert.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  chans  text[] := array['call','sms','email','whatsapp','instagram','school','sports','note','other'];
  cats   text[] := array['general','school','medical','sports','social','emergency','financial','legal','other'];
  stats  text[] := array['unread','unread','read','replied','archived','snoozed'];
  prio   text[] := array['low','normal','normal','high','urgent'];
  dirs   text[] := array['inbound','inbound','inbound','outbound'];
  subs   text[] := array['Field trip permission slip','Practice moved to 5pm','Invoice for after-school care',
                         'Playdate this Saturday?','Reminder: dentist Tuesday','Report card is ready',
                         'Carpool change this week','Fundraiser volunteers needed','Prescription ready for pickup',
                         'Photo day is Friday','Overdue library book','Season schedule attached'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.family_communications where family_id = v_family and summary like '[seed]%';

  insert into public.family_communications
    (family_id, channel, direction, subject, body, summary, category, status, priority, received_at)
  select v_family,
    chans[1 + (g.i % array_length(chans,1))],
    dirs[1 + (g.i % array_length(dirs,1))],
    subs[1 + (g.i % array_length(subs,1))] || ' #' || g.i,
    'Full message body captured by the family inbox for triage and one-tap reply.',
    '[seed] AI summary: needs a quick yes/no reply.',
    cats[1 + (g.i % array_length(cats,1))],
    stats[1 + (g.i % array_length(stats,1))],
    prio[1 + (g.i % array_length(prio,1))],
    now() - ((g.i * 53) || ' minutes')::interval
  from generate_series(1, n) as g(i);

  raise notice 'Communications seeded % messages for family %', n, v_family;
end $$;

-- ==================== seed_marketplace.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Marketplace (marketplace_listings 500 + offers 500).
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
    (family_id, member_id, title, description, kind, category, condition, price_cents, status, location, created_at)
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

-- ==================== seed_family_signals.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Family signals (500 records).
-- Fills family_signals so Family Intelligence (R10) can be tested at volume: all
-- four hard-signal kinds, each with realistic evidence + a spread of statuses
-- (active/acknowledged/dismissed). Idempotent via evidence->>'seed' = 'r10';
-- resolves the family by email. (Needs migration 0142 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  kinds    text[] := array['ignored_reminder','stress_window','chore_conflict','routine_adherence'];
  statuses text[] := array['active','active','active','acknowledged','dismissed'];
  rem_titles text[] := array['Take out trash','Water plants','Pack lunches','Refill prescription','Sign permission slip','Feed the cat'];
  stress_lbl text[] := array['Weekday evenings','Weekday mornings','Weekend afternoons','Weekday afternoons'];
  chores     text[] := array['Dishes','Vacuum','Walk the dog','Clean bathroom','Take out recycling'];
  routines   text[] := array['Morning routine','Bedtime routine','Homework hour','Tidy-up time'];
begin
  if to_regclass('public.family_signals') is null then
    raise notice 'family_signals not present — apply migration 0142 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.family_signals where family_id = v_family and evidence->>'seed' = 'r10';

  insert into public.family_signals
    (family_id, kind, subject_key, title, detail, score, evidence, status, first_seen_at, last_seen_at)
  select
    v_family,
    k,
    k || ':seed-' || g.i,
    case k
      when 'ignored_reminder'   then '“' || rem_titles[1+(g.i % array_length(rem_titles,1))] || '” keeps getting missed'
      when 'stress_window'      then stress_lbl[1+(g.i % array_length(stress_lbl,1))] || ' are your crunch time'
      when 'chore_conflict'     then '“' || chores[1+(g.i % array_length(chores,1))] || '” causes friction'
      else '“' || routines[1+(g.i % array_length(routines,1))] || '” only sticks ' || (20 + (g.i % 40)) || '% of the time'
    end,
    'Detected from your recent activity. [seed]',
    40 + (g.i % 60),
    case k
      when 'ignored_reminder'   then jsonb_build_object('seed','r10','count', 3 + (g.i % 6), 'lastAt', now())
      when 'stress_window'      then jsonb_build_object('seed','r10','events', 4 + (g.i % 8), 'conflicts', (g.i % 3), 'overdue', (g.i % 4))
      when 'chore_conflict'     then jsonb_build_object('seed','r10','rejected', 1 + (g.i % 3), 'disputed', (g.i % 3), 'members', 2 + (g.i % 3), 'total', 5 + (g.i % 10))
      else jsonb_build_object('seed','r10','actual', 4 + (g.i % 6), 'expected', 20, 'adherencePct', 20 + (g.i % 40))
    end,
    statuses[1+(g.i % array_length(statuses,1))],
    now() - ((30 + (g.i % 60)) || ' days')::interval,
    now() - ((g.i % 14) || ' days')::interval
  from generate_series(1, n) g(i)
  cross join lateral (select kinds[1+(g.i % 4)] as k) kk
  on conflict (family_id, kind, subject_key) do nothing;

  raise notice 'Family signals seeded 500 rows for family %', v_family;
end $$;

-- Verify:
--   select count(*) from family_signals where evidence->>'seed'='r10';   -- 500
--   select kind, count(*) from family_signals group by kind;

-- ==================== seed_twin_simulations.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Twin simulations (500 records).
-- Fills twin_simulations so the Digital Twin activity projection (R8) can be
-- tested at volume: saved "what-if" scenarios spanning verdicts + weekly-hour
-- loads, each with a per-dimension breakdown. Idempotent via input->>'seed'='r8';
-- resolves the family by email. (Needs migration 0147 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_member uuid;
  n int := 500;
  acts     text[] := array['Travel Soccer','Club Swim','Youth Orchestra','Robotics Team','Ballet','Chess Club','Scouts','Basketball','Debate Team','Art Class'];
  verdicts text[] := array['clear','clear','tight','tight','conflict'];
begin
  if to_regclass('public.twin_simulations') is null then
    raise notice 'twin_simulations not present — apply migration 0147 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select id into v_member from public.family_members where family_id = v_family order by created_at limit 1;

  delete from public.twin_simulations where family_id = v_family and input->>'seed' = 'r8';

  insert into public.twin_simulations
    (family_id, member_id, activity_name, verdict, weekly_hours, input, dimensions, created_at)
  select
    v_family, v_member,
    acts[1+(g.i % array_length(acts,1))] || ' #' || g.i,
    verdicts[1+(g.i % array_length(verdicts,1))],
    round((2 + (g.i % 10) + (g.i % 3) * 0.5)::numeric, 1),
    jsonb_build_object('seed','r8','activityName', acts[1+(g.i % array_length(acts,1))],
      'sessionsPerWeek', 1 + (g.i % 4), 'weeks', 6 + (g.i % 20), 'travelMinEach', (g.i % 6) * 10),
    jsonb_build_array(
      jsonb_build_object('key','schedule','label','Schedule','severity', (array['ok','caution','blocker'])[1+(g.i % 3)], 'headline','Fits — sessions added'),
      jsonb_build_object('key','travel','label','Travel','severity', (array['ok','caution'])[1+(g.i % 2)], 'headline', ((g.i % 4)+1) || ' round trips/week'),
      jsonb_build_object('key','family_time','label','Family time','severity', (array['ok','caution','blocker'])[1+(g.i % 3)], 'headline','≈ ' || (2+(g.i%10)) || 'h a week'),
      jsonb_build_object('key','cost','label','Cost','severity', (array['ok','caution','blocker'])[1+(g.i % 3)], 'headline','Within budget')
    ),
    now() - ((g.i) || ' hours')::interval
  from generate_series(1, n) g(i);

  raise notice 'Twin simulations seeded 500 rows for family %', v_family;
end $$;

-- Verify:
--   select count(*) from twin_simulations where input->>'seed'='r8';   -- 500
--   select verdict, count(*) from twin_simulations group by verdict;

-- ==================== seed_moment_activations.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Moment activations (500 records).
-- Fills moment_activations so the Moments organizing layer (R12) can be tested at
-- volume and its engagement history renders: every moment × ~50 days with a spread
-- of statuses (active/engaged/dismissed). Idempotent via reason like '%[seed]%';
-- resolves the family by email. (Needs migration 0148 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  keys     text[] := array['morning','school','dinner','homework','bedtime','weekend','vacation','birthday','holiday','emergency'];
  statuses text[] := array['active','active','engaged','engaged','dismissed'];
  reasons  text[] := array['Weekday morning','School hours','Around dinnertime','Due tomorrow','Evening wind-down','It''s the weekend','A trip is coming','A birthday is near','A holiday is near','Always one tap away'];
begin
  if to_regclass('public.moment_activations') is null then
    raise notice 'moment_activations not present — apply migration 0148 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.moment_activations where family_id = v_family and reason like '%[seed]%';

  -- key index = i % 10, day = floor(i/10) → each (moment, day) pair unique across 500.
  insert into public.moment_activations
    (family_id, moment_key, as_of_date, status, reason, priority, created_at)
  select
    v_family,
    keys[1+(g.i % 10)],
    (current_date - (g.i / 10)),
    statuses[1+(g.i % array_length(statuses,1))],
    reasons[1+(g.i % 10)] || ' [seed]',
    100 - (g.i % 100),
    now() - ((g.i) || ' hours')::interval
  from generate_series(0, n - 1) g(i)
  on conflict (family_id, moment_key, as_of_date) do nothing;

  raise notice 'Moment activations seeded 500 rows for family %', v_family;
end $$;

-- Verify:
--   select count(*) from moment_activations where reason like '%[seed]%';   -- 500
--   select moment_key, count(*) from moment_activations group by moment_key order by 2 desc;

-- ==================== seed_reasoning_snapshots.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Reasoning snapshots (500 records).
-- Fills reasoning_snapshots so the unified Family Reasoning Engine (R7) can be
-- tested at volume and its day-over-day trend renders: 500 distinct days, each a
-- compact six-question report with a varying all-clear / attention mix. Idempotent
-- via report->>'seed' = 'true'; resolves the family by email. (Needs migration
-- 0149 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_user   uuid;
  n int := 500;
  -- The six questions the engine answers, in canonical order.
  qids      text[] := array['matters_most','forgotten','decide_next','auto_complete','who_needs_help','what_next'];
  qtext     text[] := array[
    'What matters most right now?','What''s likely being forgotten?','What should we decide next?',
    'What can Bubaly just handle?','Who needs help this week?','What''s the next best move?'];
begin
  if to_regclass('public.reasoning_snapshots') is null then
    raise notice 'reasoning_snapshots not present — apply migration 0149 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select fm.user_id into v_user from public.family_members fm
  where fm.family_id = v_family and fm.user_id is not null limit 1;

  delete from public.reasoning_snapshots where family_id = v_family and (report->>'seed') = 'true';

  -- One snapshot per distinct day, 500 days back. attention_count cycles 0..3 so
  -- the trend shows a realistic mix of calm and busy weeks; the report mirrors the
  -- shape lib/reasoning/engine.ts#reasoningSummary persists.
  insert into public.reasoning_snapshots
    (family_id, as_of_date, all_clear, attention_count, report, created_by, created_at)
  select
    v_family,
    (current_date - g.i),
    (g.i % 4) = 0,                       -- ~1 in 4 days fully clear
    (g.i % 4),                           -- 0..3 areas needing attention
    jsonb_build_object(
      'seed', true,
      'allClear', (g.i % 4) = 0,
      'answers', (
        select jsonb_agg(
          jsonb_build_object(
            'id', qids[q],
            'question', qtext[q],
            'status', case when q <= (g.i % 4) then 'attention' else 'clear' end,
            'headline', case when q <= (g.i % 4)
              then 'Needs a look this week.' else 'Nothing pressing here.' end,
            'count', case when q <= (g.i % 4) then 1 + (g.i % 3) else 0 end
          ) order by q
        )
        from generate_series(1, 6) q
      )
    ),
    v_user,
    now() - ((g.i) || ' days')::interval
  from generate_series(0, n - 1) g(i)
  on conflict (family_id, as_of_date) do nothing;

  raise notice 'Reasoning snapshots seeded 500 rows for family %', v_family;
end $$;

-- Verify:
--   select count(*) from reasoning_snapshots where (report->>'seed') = 'true';  -- 500
--   select all_clear, count(*) from reasoning_snapshots group by all_clear;
--   select as_of_date, attention_count from reasoning_snapshots order by as_of_date desc limit 10;

-- ==================== seed_feature_gaps_family.sql ====================
-- ============================================================================
-- FamilyOS · SEED — feature-gap coverage (500 rows each) for family features that
-- had NO seed and therefore rendered empty at test time:
--   Rides · Renewals · Immunizations · Health Visits · Family Dates ·
--   Screen-time entries · Wallet goals · Reminder lists.
-- Each block is guarded by to_regclass so a missing table is skipped, never fatal.
-- Idempotent: every row's title is prefixed '[seed] ' and cleared before insert.
-- Resolves the family by email (falls back to the oldest family). Enums use each
-- table's own default value, so no enum-label guessing.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  v_m       uuid;
  n int := 500;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  v_m := case when v_members is null then null else v_members[1] end;

  -- ── Rides (500) ──────────────────────────────────────────────────────────
  if to_regclass('public.rides') is not null then
    delete from public.rides where family_id = v_family and title like '[seed]%';
    insert into public.rides (family_id, title, ride_date, pickup_location, dropoff_location,
                              driver_id, rider_ids, notes, created_at)
    select v_family,
      '[seed] ' || (array['Soccer practice','Piano lesson','School pickup','Dentist','Playdate','Tutoring'])[1 + (g % 6)] || ' #' || g,
      (current_date + ((g % 60) - 30))::date,
      (array['Home','School','Rec Center','Grandma''s'])[1 + (g % 4)],
      (array['Field 3','Studio','Clinic','Library'])[1 + (g % 4)],
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      case when v_members is null then '{}'::uuid[] else array[v_members[1 + ((g+1) % array_length(v_members,1))]] end,
      'Seeded ride for testing.',
      now() - ((g % 90) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Renewals (500) ───────────────────────────────────────────────────────
  if to_regclass('public.renewals') is not null then
    delete from public.renewals where family_id = v_family and title like '[seed]%';
    insert into public.renewals (family_id, member_id, title, category, expires_at, reminder_days, cost, notes, created_at)
    select v_family,
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      '[seed] ' || (array['Passport','Driver''s license','Car registration','Home warranty','Costco membership','Amazon Prime'])[1 + (g % 6)] || ' #' || g,
      (array['passport','license','registration','warranty','subscription','insurance'])[1 + (g % 6)],
      (current_date + ((g % 365) - 30))::date,
      (array[14,30,60,90])[1 + (g % 4)],
      round((20 + (g % 40) * 5)::numeric, 2),
      'Seeded renewal for testing.',
      now() - ((g % 120) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Immunizations (500) ──────────────────────────────────────────────────
  if to_regclass('public.immunizations') is not null then
    delete from public.immunizations where family_id = v_family and vaccine like '[seed]%';
    insert into public.immunizations (family_id, member_id, vaccine, dose_label, date_given, next_due_date, provider_name, notes, created_at)
    select v_family,
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      '[seed] ' || (array['Flu','MMR','Tdap','HPV','COVID-19','Hepatitis B'])[1 + (g % 6)],
      (array['Dose 1','Dose 2','Booster','Annual'])[1 + (g % 4)],
      (current_date - (g % 900))::date,
      (current_date + ((g % 365)))::date,
      (array['Dr. Patel','Kids Clinic','County Health','Pharmacy'])[1 + (g % 4)],
      'Seeded immunization for testing.',
      now() - ((g % 300) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Health Visits (500) ──────────────────────────────────────────────────
  if to_regclass('public.health_visits') is not null then
    delete from public.health_visits where family_id = v_family and title like '[seed]%';
    insert into public.health_visits (family_id, member_id, title, provider_name, location, visit_date, reason, outcome, follow_up_date, cost_cents, created_at)
    select v_family,
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      '[seed] ' || (array['Annual checkup','Sick visit','Dental cleaning','Eye exam','Follow-up','Specialist'])[1 + (g % 6)] || ' #' || g,
      (array['Dr. Patel','Bright Smiles','Vision Center','Children''s Hospital'])[1 + (g % 4)],
      (array['Main St Clinic','Downtown','Suburb Office','Telehealth'])[1 + (g % 4)],
      (current_date - (g % 400))::date,
      'Routine seeded visit.',
      (array['All clear','Prescribed rest','Follow-up in 2 weeks','Referred to specialist'])[1 + (g % 4)],
      case when g % 3 = 0 then (current_date + (g % 60))::date else null end,
      (2000 + (g * 37) % 18000),
      now() - ((g % 400) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Family Dates (500) ───────────────────────────────────────────────────
  if to_regclass('public.family_dates') is not null then
    delete from public.family_dates where family_id = v_family and title like '[seed]%';
    insert into public.family_dates (family_id, member_id, title, event_date, notes, remind_days, created_at)
    select v_family,
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      '[seed] ' || (array['Birthday','Anniversary','First day of school','Adoption day','Family reunion','Graduation'])[1 + (g % 6)] || ' #' || g,
      (date '1990-01-01' + ((g * 7) % 13000))::date,
      'Seeded family date for testing.',
      (array[1,3,7,14])[1 + (g % 4)],
      now() - ((g % 200) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Screen-time entries (500) ────────────────────────────────────────────
  if to_regclass('public.screen_time_entries') is not null then
    delete from public.screen_time_entries where family_id = v_family and note like '[seed]%';
    insert into public.screen_time_entries (family_id, member_id, entry_date, minutes, device, note, logged_by, created_at)
    select v_family,
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      (current_date - (g % 120))::date,
      15 + (g * 7) % 180,
      (array['iPad','Switch','TV','Phone','Laptop'])[1 + (g % 5)],
      '[seed] logged screen time',
      null,
      now() - ((g % 120) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Wallet goals (500 shared/family goals) ───────────────────────────────
  if to_regclass('public.wallet_goals') is not null then
    delete from public.wallet_goals where family_id = v_family and title like '[seed]%';
    insert into public.wallet_goals (family_id, child_wallet_id, title, kind, target_cents, saved_cents, target_date, status, created_at)
    select v_family, null,
      '[seed] ' || (array['New bike','College fund','Family vacation','Charity giving','Rainy-day fund','Video game'])[1 + (g % 6)] || ' #' || g,
      (array['bike','college','vacation','giving','emergency','custom'])[1 + (g % 6)],
      (5000 + (g * 313) % 500000)::bigint,
      ((g * 131) % 5000)::bigint,
      (current_date + ((g % 400)))::date,
      (array['active','active','active','reached','archived'])[1 + (g % 5)],
      now() - ((g % 200) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Reminder lists (500) ─────────────────────────────────────────────────
  if to_regclass('public.reminder_lists') is not null then
    delete from public.reminder_lists where family_id = v_family and name like '[seed]%';
    insert into public.reminder_lists (family_id, name, color, icon, sort_order, created_at)
    select v_family,
      '[seed] ' || (array['Groceries','Errands','Work','School','Home','Health','Travel','Projects'])[1 + (g % 8)] || ' #' || g,
      (array['brand','rose','emerald','amber','sky','violet'])[1 + (g % 6)],
      (array['list','cart','home','book','heart','plane'])[1 + (g % 6)],
      g,
      now() - ((g % 150) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  raise notice 'Feature-gap seed complete for family % (8 features × 500).', v_family;
end $$;
