-- ============================================================================
-- FamilyOS :: SEED_ALL — one paste populates EVERY surface with 500-row test data.
-- ============================================================================
-- Runs all 46 paste-ready, idempotent seeds in dependency order (core content
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
      (enum_range(null::journal_mood))[1 + (g.i % array_length(enum_range(null::journal_mood),1))]::journal_mood,
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
      (enum_range(null::habit_cadence))[1 + (g.i % array_length(enum_range(null::habit_cadence),1))]::habit_cadence, 1, '{1,2,3,4,5}', true
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
      (enum_range(null::pet_species))[1 + (g.i % array_length(enum_range(null::pet_species),1))]::pet_species,
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
      (enum_range(null::wish_priority))[1 + (g.i % array_length(enum_range(null::wish_priority),1))]::wish_priority, '[seed:matrix]', (g.i%9=0)
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
      (enum_range(null::homework_status))[1 + (g.i % array_length(enum_range(null::homework_status),1))]::homework_status
    from generate_series(1,n) g(i);
  end if;

  -- ── Insurance policies (500) ────────────────────────────────────────────
  if to_regclass('public.family_insurance_policies') is not null then
    delete from public.family_insurance_policies where family_id = v_family and notes = '[seed:matrix]';
    insert into public.family_insurance_policies (family_id, policy_type, insurer, policy_number, premium_amount, premium_frequency, renewal_date, notes, is_active)
    select v_family,
      (enum_range(null::insurance_policy_type))[1 + (g.i % array_length(enum_range(null::insurance_policy_type),1))]::insurance_policy_type,
      (array['Aetna','Delta','VSP','Geico','StateFarm','Prudential'])[1+(g.i%6)],
      'POL-' || lpad(g.i::text,6,'0'), round((50+random()*400)::numeric,2),
      (enum_range(null::premium_frequency))[1 + (g.i % array_length(enum_range(null::premium_frequency),1))]::premium_frequency,
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
      (enum_range(null::metric_type))[1 + (g.i % array_length(enum_range(null::metric_type),1))]::metric_type,
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
    -- Pick from the enum's ACTUAL labels (drift-proof): the live DB's
    -- notification_type may not carry every label this repo's migration defines,
    -- so read enum_range instead of hard-coding values that could be missing.
    (enum_range(null::public.notification_type))[1 + (g.i % array_length(enum_range(null::public.notification_type), 1))],
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
    -- economy redemptions never use the 'requested' state (that's a
    -- reward_redemptions value); some prod DBs carry a status CHECK that rejects
    -- it, so seed only the economy-valid lifecycle statuses.
    (array['pending','approved','fulfilled','rejected'])[1 + (g.i % 4)]::redemption_status,
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

-- ==================== seed_sync_microsoft.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Microsoft / Outlook two-way sync (500+ records).
-- Exercises the R9 provider-agnostic adapter at volume: a connected Microsoft
-- sync_account + connection, an Outlook calendar mirror, and 500 already-synced
-- Outlook-origin events with their external mappings (exactly what the generic
-- engine's PULL path produces). Lets the sync/Connections surfaces render a
-- SECOND live provider and the local reconcile queries run at scale — no live
-- Graph API or OAuth keys needed for the local side.
-- Idempotent: keyed on the seed account external_id; re-run safe. Resolves the
-- family by email. (Needs migration 0018 applied; 'microsoft' is already a
-- registered provider row.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email     text := 'newworldventurellc@gmail.com';
  v_acct_ext  text := 'seed-outlook@bubaly.test';
  v_family    uuid;
  v_user      uuid;
  v_account   uuid;
  v_calendar  uuid;
  n int := 500;
begin
  if to_regclass('public.sync_accounts') is null then
    raise notice 'sync platform (0018) not present — skipping.';
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
  if v_user is null then raise exception 'No user in family to own the connected account.'; end if;

  -- Ensure the provider reference row exists (0018 seeds it; upsert to be safe).
  insert into public.sync_providers (provider, label, auth_kind)
  values ('microsoft', 'Microsoft / Outlook', 'oauth2')
  on conflict (provider) do nothing;

  -- Connected account (idempotent on the unique (user_id, provider, external_id)).
  insert into public.sync_accounts (user_id, family_id, provider, external_id, display_name, sync_status, scopes, created_by)
  values (v_user, v_family, 'microsoft', v_acct_ext, 'Outlook (seed)', 'synced',
          array['Calendars.ReadWrite','Tasks.ReadWrite'], v_user)
  on conflict (user_id, provider, external_id) do update set sync_status = 'synced'
  returning id into v_account;
  if v_account is null then
    select id into v_account from public.sync_accounts where user_id = v_user and provider = 'microsoft' and external_id = v_acct_ext;
  end if;

  insert into public.sync_connections (account_id, user_id, family_id, provider, external_id, item_types, sync_direction, sync_status, health)
  values (v_account, v_user, v_family, 'microsoft', v_acct_ext, array['calendar','event']::public.sync_item_type[], 'two_way', 'synced', 'healthy')
  on conflict do nothing;

  -- Outlook calendar mirror (one per account; keyed by external_id).
  insert into public.sync_calendars (family_id, user_id, account_id, provider, external_id, name, timezone, is_primary, is_owned_locally, sync_status, sync_token)
  values (v_family, v_user, v_account, 'microsoft', 'ms-cal-primary', 'Outlook Calendar', 'UTC', true, false, 'synced', 'seed-delta-cursor')
  on conflict do nothing;
  select id into v_calendar from public.sync_calendars where account_id = v_account and provider = 'microsoft' and external_id = 'ms-cal-primary' limit 1;

  -- Clean prior seed rows for a deterministic re-run.
  delete from public.sync_external_mappings where account_id = v_account and external_id like 'ms-seed-%';
  delete from public.sync_calendar_events where calendar_id = v_calendar and external_id like 'ms-seed-%';

  -- 500 Outlook-origin events (provider='microsoft'), spread across ±120 days.
  insert into public.sync_calendar_events
    (calendar_id, family_id, user_id, provider, external_id, uid, title, description, location,
     starts_at, ends_at, all_day, status, etag, content_hash, sync_status, last_synced_at, metadata)
  select
    v_calendar, v_family, v_user, 'microsoft',
    'ms-seed-' || g.i,
    'ms-uid-' || g.i,
    (array['Standup','Dentist','Soccer practice','Piano lesson','Parent-teacher','Grocery run','Date night','Doctor','Team lunch','Book club'])[1+(g.i % 10)] || ' #' || g.i,
    'Synced from Outlook (seed).',
    (array['Home','Office','Field 3','School','Downtown','Clinic',null])[1+(g.i % 7)],
    (now() + ((g.i - 250) || ' hours')::interval),
    (now() + ((g.i - 250) || ' hours')::interval + interval '1 hour'),
    (g.i % 17) = 0,
    'confirmed',
    'etag-' || g.i,
    md5('ms-seed-' || g.i),          -- stand-in content hash (unique per event)
    'synced',
    now() - ((g.i % 48) || ' hours')::interval,
    '{"origin":"remote"}'::jsonb
  from generate_series(0, n - 1) g(i)
  on conflict do nothing;

  -- One external mapping per seeded event (the local<->remote backbone).
  insert into public.sync_external_mappings
    (family_id, account_id, provider, item_type, local_id, external_id, external_etag, sync_status, last_synced_at, metadata)
  select
    v_family, v_account, 'microsoft', 'event', e.id, e.external_id, e.etag, 'synced', now(),
    jsonb_build_object('lastHash', e.content_hash)
  from public.sync_calendar_events e
  where e.calendar_id = v_calendar and e.external_id like 'ms-seed-%'
  on conflict (provider, item_type, external_id, account_id) do nothing;

  raise notice 'Microsoft sync seeded: account %, calendar %, % events for family %',
    v_account, v_calendar, n, v_family;
end $$;

-- Verify:
--   select count(*) from sync_calendar_events where provider='microsoft' and external_id like 'ms-seed-%';  -- 500
--   select count(*) from sync_external_mappings where provider='microsoft' and external_id like 'ms-seed-%'; -- 500
--   select provider, sync_status from sync_accounts where external_id='seed-outlook@bubaly.test';

-- ==================== seed_marketplace_matches.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Marketplace matches (500 records).
-- Fills marketplace_matches so the supply↔demand strip (0150) renders at volume:
-- pairs the family's open "wanted" listings with open supply listings (sell /
-- free / rent / borrow) posted by someone else, scored + reasoned. Requires the
-- marketplace itself to be seeded first (seed_marketplace_family.sql / the in-app
-- seed screen) so there are listings to pair. Idempotent: clears prior seed rows
-- (reason like '%[seed]%') for the family before inserting. Resolves family by
-- email. (Needs migrations 0120 + 0150 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_wanted  uuid[];
  v_supply  uuid[];
  nw int; ns int;
  n int := 500;
  inserted int := 0;
begin
  if to_regclass('public.marketplace_matches') is null then
    raise notice 'marketplace_matches not present — apply migration 0150 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select array_agg(id) into v_wanted from public.marketplace_listings
    where family_id = v_family and kind = 'wanted' and status in ('available','pending');
  select array_agg(id) into v_supply from public.marketplace_listings
    where family_id = v_family and kind in ('sell','free','rent','borrow') and status in ('available','pending');

  nw := coalesce(array_length(v_wanted, 1), 0);
  ns := coalesce(array_length(v_supply, 1), 0);
  if nw = 0 or ns = 0 then
    raise notice 'No wanted/supply listings to pair (wanted=%, supply=%). Seed the marketplace first. Skipping.', nw, ns;
    return;
  end if;

  delete from public.marketplace_matches where family_id = v_family and reason like '%[seed]%';

  -- Generate up to 500 distinct (wanted, supply) pairs by walking the cross-grid.
  insert into public.marketplace_matches (family_id, wanted_id, supply_id, score, reason, status)
  select
    v_family,
    v_wanted[1 + (g.i % nw)],
    v_supply[1 + ((g.i / nw) % ns)],
    30 + (g.i % 70),                                   -- score spread 30..99
    'Someone wants what''s on the board. [seed]',
    (array['active','active','active','dismissed','actioned'])[1 + (g.i % 5)]
  from generate_series(0, n - 1) g(i)
  where v_wanted[1 + (g.i % nw)] <> v_supply[1 + ((g.i / nw) % ns)]
  on conflict (family_id, wanted_id, supply_id) do nothing;

  get diagnostics inserted = row_count;
  raise notice 'Marketplace matches seeded % rows (wanted=%, supply=%) for family %', inserted, nw, ns, v_family;
end $$;

-- Verify:
--   select count(*) from marketplace_matches where reason like '%[seed]%';       -- up to 500
--   select status, count(*) from marketplace_matches group by status;

-- ==================== seed_marketplace_v2.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Marketplace V2 (1,200+ records).
-- Fills the AI-first marketplace so every V2 surface renders at volume:
--   • a storefront per family member (+ follows between members)
--   • 6 curated collections with ~150 items
--   • 300 saves (♥), 300 orders (status spread), ~500 two-sided reviews
-- Requires the marketplace listings seed first (seed_marketplace.sql) and
-- migration 0151. Idempotent: stores upsert; follows/saves insert-once via their
-- unique keys; seed orders/reviews/collections carry a '[seed]' marker and are
-- cleared before re-insert. Resolves the family by email.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email    text := 'newworldventurellc@gmail.com';
  v_family   uuid;
  v_members  uuid[];
  v_listings uuid[];
  v_prices   bigint[];
  v_kinds    text[];
  v_stores   uuid[];
  nm int; nl int;
  store_names text[] := array['Style Corner','Outdoor Hub','Baby Gear Co.','Tech Finds','The Book Nook','Game Shelf','Handy House','Little Loft'];
  store_emoji text[] := array['👗','🏕️','🍼','📱','📚','🎲','🔧','🧸'];
  coll_names  text[] := array['Wedding Guest Dresses','Camping Gear Rentals','Baby Essentials to Borrow','Summer Vibes Favorites','Back to School','Game Night'];
  coll_emoji  text[] := array['💃','⛺','🍼','🌞','🎒','🎲'];
  coll_ids    uuid[] := array[]::uuid[];
  cid uuid;
  i int;
begin
  if to_regclass('public.marketplace_stores') is null then
    raise notice 'marketplace V2 tables not present — apply migration 0151 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select array_agg(id) into v_members from public.family_members where family_id = v_family and is_active;
  nm := coalesce(array_length(v_members, 1), 0);
  if nm = 0 then raise exception 'No members in family %', v_family; end if;

  select array_agg(id), array_agg(price_cents), array_agg(kind)
    into v_listings, v_prices, v_kinds
  from (select id, price_cents, kind from public.marketplace_listings
        where family_id = v_family order by created_at limit 400) s;
  nl := coalesce(array_length(v_listings, 1), 0);
  if nl = 0 then
    raise notice 'No marketplace listings — run seed_marketplace.sql first. Skipping.';
    return;
  end if;

  -- ── Stores: one per member (upsert; names cycle) ──────────────────────────
  for i in 1..nm loop
    insert into public.marketplace_stores (family_id, member_id, name, tagline, emoji, is_active)
    values (v_family, v_members[i], store_names[1 + ((i - 1) % 8)],
            'Quality finds from the family. [seed]', store_emoji[1 + ((i - 1) % 8)], true)
    on conflict (family_id, member_id) do update set is_active = true;
  end loop;
  select array_agg(id) into v_stores from public.marketplace_stores where family_id = v_family;

  -- ── Follows: every member follows every other member's store ─────────────
  insert into public.marketplace_follows (family_id, store_id, member_id)
  select v_family, s.id, m.mid
  from public.marketplace_stores s
  cross join (select unnest(v_members) mid) m
  where s.family_id = v_family and s.member_id <> m.mid
  on conflict (store_id, member_id) do nothing;

  -- ── Collections (marker-cleared) + ~25 items each ─────────────────────────
  delete from public.marketplace_collections where family_id = v_family and description like '%[seed]%';
  for i in 1..6 loop
    insert into public.marketplace_collections (family_id, name, emoji, description)
    values (v_family, coll_names[i], coll_emoji[i], 'Curated from the family board. [seed]')
    returning id into cid;
    coll_ids := coll_ids || cid;
    insert into public.marketplace_collection_items (family_id, collection_id, listing_id)
    select v_family, cid, v_listings[1 + (((i - 1) * 25 + g.n) % nl)]
    from generate_series(0, 24) g(n)
    on conflict (collection_id, listing_id) do nothing;
  end loop;

  -- ── Saves: 300 deterministic member×listing pairs ─────────────────────────
  insert into public.marketplace_saves (family_id, listing_id, member_id)
  select v_family, v_listings[1 + (g.i % nl)], v_members[1 + ((g.i / 7) % nm)]
  from generate_series(0, 299) g(i)
  on conflict (listing_id, member_id) do nothing;

  -- ── Orders: 300 with a status spread (marker-cleared) ─────────────────────
  delete from public.marketplace_reviews where family_id = v_family and comment like '%[seed]%';
  delete from public.marketplace_orders where family_id = v_family and notes like '%[seed]%';

  insert into public.marketplace_orders
    (family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents, notes, created_at)
  select
    v_family,
    v_listings[1 + (g.i % nl)],
    v_members[1 + (g.i % nm)],
    v_members[1 + ((g.i + 1) % nm)],
    case coalesce(v_kinds[1 + (g.i % nl)], 'sell')
      when 'sell' then 'buy' when 'rent' then 'rent' when 'borrow' then 'borrow'
      when 'swap' then 'swap' when 'donate' then 'donate' else 'free' end,
    (array['requested','confirmed','active','completed','completed'])[1 + (g.i % 5)],
    coalesce(v_prices[1 + (g.i % nl)], 0),
    'Family exchange. [seed]',
    now() - ((g.i * 3) || ' hours')::interval
  from generate_series(0, 299) g(i);

  -- ── Reviews: both sides of every completed seed order (~240) ─────────────
  insert into public.marketplace_reviews
    (family_id, order_id, listing_id, reviewer_member, reviewee_member, role, rating, comment, created_at)
  select v_family, o.id, o.listing_id, o.buyer_member, o.seller_member, 'buyer',
         3 + (abs(hashtext(o.id::text)) % 3),
         'Smooth hand-off, great condition. [seed]', o.created_at + interval '1 day'
  from public.marketplace_orders o
  where o.family_id = v_family and o.status = 'completed' and o.notes like '%[seed]%'
  on conflict do nothing;

  insert into public.marketplace_reviews
    (family_id, order_id, listing_id, reviewer_member, reviewee_member, role, rating, comment, created_at)
  select v_family, o.id, o.listing_id, o.seller_member, o.buyer_member, 'seller',
         4 + (abs(hashtext(o.id::text)) % 2),
         'Easy to coordinate with — would trade again. [seed]', o.created_at + interval '1 day'
  from public.marketplace_orders o
  where o.family_id = v_family and o.status = 'completed' and o.notes like '%[seed]%'
    and o.buyer_member is distinct from o.seller_member
  on conflict do nothing;

  -- ── Standalone listing reviews for rating spread (~260) ───────────────────
  insert into public.marketplace_reviews
    (family_id, order_id, listing_id, reviewer_member, reviewee_member, role, rating, comment, created_at)
  select v_family, null, v_listings[1 + (g.i % nl)],
         v_members[1 + (g.i % nm)], v_members[1 + ((g.i + 1) % nm)],
         (array['buyer','seller'])[1 + (g.i % 2)],
         3 + (g.i % 3),
         'Exactly as described. [seed]',
         now() - ((g.i * 5) || ' hours')::interval
  from generate_series(0, 259) g(i);

  raise notice 'Marketplace V2 seeded: % stores, follows, 6 collections (+items), 300 saves, 300 orders, ~500 reviews for family %', nm, v_family;
end $$;

-- Verify:
--   select count(*) from marketplace_orders where notes like '%[seed]%';     -- 300
--   select count(*) from marketplace_reviews where comment like '%[seed]%';  -- ~500
--   select count(*) from marketplace_saves;                                  -- ≥ 250
--   select status, count(*) from marketplace_orders group by status;


-- ============================================================================
-- FamilyOS · SEED — feature-gap coverage, batch 2 (500 rows each) for more live
-- family features that had NO seed and rendered empty at test time:
--   Smart Devices · Home Warranties · Babysitters · Expense Splits · Date Nights.
-- Each block is guarded by to_regclass (missing table = skipped, never fatal).
-- Idempotent: rows carry a '[seed]' marker in a text column, cleared before insert.
-- Resolves the family by email (falls back to the oldest family). Enums/checks use
-- each table's own default value, so no label guessing.
-- Where: Supabase → SQL Editor → paste → Run.
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

  -- ── Smart Devices (500) ──────────────────────────────────────────────────
  if to_regclass('public.smart_devices') is not null then
    delete from public.smart_devices where family_id = v_family and note like '[seed]%';
    insert into public.smart_devices (family_id, name, type, room, brand, integration, status, last_state, note, created_at)
    select v_family,
      (array['Living Room Light','Front Door Lock','Hallway Thermostat','Backyard Camera','Kitchen Plug','Bedroom Speaker','Doorbell','Robot Vacuum'])[1 + (g % 8)] || ' #' || g,
      (array['light','lock','thermostat','camera','plug','speaker','doorbell','vacuum'])[1 + (g % 8)],
      (array['Living Room','Kitchen','Bedroom','Hallway','Garage','Backyard'])[1 + (g % 6)],
      (array['Philips Hue','August','Nest','Ring','TP-Link','Sonos'])[1 + (g % 6)],
      (array['homekit','google','alexa','smartthings','matter','manual'])[1 + (g % 6)],
      (array['online','offline','unknown'])[1 + (g % 3)],
      (array['On','Off','72°F','Locked','Idle'])[1 + (g % 5)],
      '[seed] device',
      now() - ((g % 120) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Home Warranties (500) ────────────────────────────────────────────────
  if to_regclass('public.home_warranties') is not null then
    delete from public.home_warranties where family_id = v_family and name like '[seed]%';
    insert into public.home_warranties (family_id, name, provider, warranty_type, coverage, starts_on, expires_on, cost, premium_period, created_at)
    select v_family,
      '[seed] ' || (array['Fridge','Washer','HVAC','Roof','Water Heater','Dishwasher'])[1 + (g % 6)] || ' warranty #' || g,
      (array['LG','Asurion','First American','Samsung','Choice Home','American Home Shield'])[1 + (g % 6)],
      (array['manufacturer','extended','home_warranty','service_plan'])[1 + (g % 4)],
      'Parts + labor; $75 deductible per claim.',
      (current_date - (g % 800))::date,
      (current_date + ((g % 700) - 60))::date,
      round((50 + (g % 40) * 10)::numeric, 2),
      (array['one_time','monthly','annual'])[1 + (g % 3)],
      now() - ((g % 300) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Babysitters (500) ────────────────────────────────────────────────────
  if to_regclass('public.babysitter_profiles') is not null then
    delete from public.babysitter_profiles where family_id = v_family and notes like '[seed]%';
    insert into public.babysitter_profiles (family_id, name, phone, email, rate_cents, notes, is_active, created_at)
    select v_family,
      (array['Emma','Olivia','Sophia','Liam','Noah','Ava','Mia','Grace'])[1 + (g % 8)] || ' Sitter ' || g,
      '+1555' || lpad(((g * 3571) % 10000000)::text, 7, '0'),
      'sitter' || g || '@example.com',
      (1500 + (g % 15) * 100)::bigint,
      '[seed] trusted sitter',
      (g % 7 <> 0),
      now() - ((g % 200) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Expense Splits (500) ─────────────────────────────────────────────────
  if to_regclass('public.expense_splits') is not null then
    delete from public.expense_splits where family_id = v_family and description like '[seed]%';
    insert into public.expense_splits (family_id, description, total_cents, category, paid_by, spent_on, note, created_at)
    select v_family,
      '[seed] ' || (array['Groceries','Dinner out','Gas','Movie tickets','Birthday gift','Household supplies'])[1 + (g % 6)] || ' #' || g,
      (500 + (g * 137) % 20000),
      (array['food','transport','entertainment','gifts','household','other'])[1 + (g % 6)],
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      (current_date - (g % 180))::date,
      'Seeded split for testing.',
      now() - ((g % 180) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Date Nights / relationship dates (500) ───────────────────────────────
  if to_regclass('public.relationship_dates') is not null then
    delete from public.relationship_dates where family_id = v_family and title like '[seed]%';
    insert into public.relationship_dates (family_id, kind, title, event_date, recurs_annually, reminder_days_before, member_id, location, notes, created_at)
    select v_family,
      (array['anniversary','birthday','first_date','date_night','milestone','custom'])[1 + (g % 6)],
      '[seed] ' || (array['Anniversary dinner','Movie night','Weekend getaway','Concert','Cooking class','Picnic'])[1 + (g % 6)] || ' #' || g,
      (current_date + ((g % 400) - 100))::date,
      (g % 2 = 0),
      (array[3,7,14,30])[1 + (g % 4)],
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      (array['Home','Downtown','The Grove','Lakeside','Rooftop'])[1 + (g % 5)],
      'Seeded date for testing.',
      now() - ((g % 200) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  raise notice 'Feature-gap batch 2 complete for family % (SmartDevices/Warranties/Babysitters/ExpenseSplits/DateNights, 500 each).', v_family;
end $$;


-- ============================================================================
-- FamilyOS · SEED — feature-gap coverage for FK-parented tables that had no seed:
--   Medication Doses (500) and Kid Investing order history (500), plus the parent
--   rows they require (seed medications; an educational asset catalog + a child
--   investing wallet per member + starter holdings).
-- Guarded by to_regclass; idempotent (seed medications/assets carry markers and
-- deleting them cascades their children). Resolves the family by email.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  v_meds    uuid[];
  v_assets  uuid[];
  v_wallets uuid[];
  n int := 500;
  v_price bigint; v_shares numeric; v_wid uuid; v_aid uuid;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  -- ── Medication doses (500), on seed medications ──────────────────────────
  if to_regclass('public.medication_doses') is not null and to_regclass('public.medications') is not null then
    delete from public.medications where family_id = v_family and name like '[seed]%';  -- cascades doses
    insert into public.medications (family_id, member_id, name, dosage, instructions, is_active)
    select v_family,
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      '[seed] ' || (array['Vitamin D','Amoxicillin','Ibuprofen','Allergy tablet','Inhaler','Melatonin'])[1 + (g % 6)],
      (array['1 tablet','5 mL','200 mg','1 puff','10 mg','1 gummy'])[1 + (g % 6)],
      'Seeded medication for testing.', true
    from generate_series(1, 6) as g;
    select array_agg(id) into v_meds from public.medications where family_id = v_family and name like '[seed]%';

    insert into public.medication_doses (family_id, medication_id, member_id, scheduled_for, status, taken_at, notes, created_at)
    select v_family,
      v_meds[1 + (g % array_length(v_meds,1))],
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      (now() - ((g % 90) || ' days')::interval - ((g % 3) * 8 || ' hours')::interval),
      (enum_range(null::dose_status))[1 + (g % array_length(enum_range(null::dose_status),1))]::dose_status,
      case when g % 5 < 3 then (now() - ((g % 90) || ' days')::interval) else null end,
      '[seed] dose',
      now() - ((g % 90) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Kid investing: asset catalog + wallets + holdings + 500 orders ────────
  if to_regclass('public.invest_orders') is not null and v_members is not null then
    -- Educational asset catalog (global, unique by symbol; ZSEED* namespace).
    insert into public.invest_assets (symbol, name, kind, emoji, description, price_cents, risk_level, sort_order)
    select 'ZSEED' || lpad(g::text, 2, '0'),
      'Seed ' || (array['Fund','Stocks','Bonds','Basket'])[1 + (g % 4)] || ' ' || g,
      (array['fund','stocks','bonds','basket'])[1 + (g % 4)],
      (array['📈','💻','🏦','🧺','🌎','⚡'])[1 + (g % 6)],
      'Seeded educational asset.',
      (1000 + g * 250)::bigint,
      (array['low','medium','high'])[1 + (g % 3)],
      g
    from generate_series(1, 12) as g
    on conflict (symbol) do nothing;
    select array_agg(id) into v_assets from public.invest_assets where symbol like 'ZSEED%';

    -- A child investing wallet per member (idempotent).
    insert into public.child_wallets (family_id, member_id)
    select v_family, m from unnest(v_members) as m
    on conflict (family_id, member_id) do nothing;
    select array_agg(id) into v_wallets from public.child_wallets where family_id = v_family;

    -- Reset prior seed orders/holdings (scoped to the seed assets).
    delete from public.invest_orders   where family_id = v_family and asset_id = any(v_assets);
    delete from public.invest_holdings where family_id = v_family and asset_id = any(v_assets);

    -- Starter holdings: each wallet holds a few seed assets (capped by wallets×assets).
    insert into public.invest_holdings (family_id, child_wallet_id, asset_id, shares, avg_cost_cents)
    select v_family, w, a, (5 + (row_number() over () % 20))::numeric, (1000 + (row_number() over () % 40) * 250)::bigint
    from unnest(v_wallets) as w cross join unnest(v_assets) as a
    on conflict (child_wallet_id, asset_id) do nothing;

    -- 500 buy/sell orders across wallets × assets (order history — no unique cap).
    for g in 1..n loop
      v_wid   := v_wallets[1 + (g % array_length(v_wallets,1))];
      v_aid   := v_assets[1 + (g % array_length(v_assets,1))];
      v_price := (1000 + (g % 50) * 100)::bigint;
      v_shares:= (1 + (g % 20))::numeric;
      insert into public.invest_orders (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status, created_at)
      values (v_family, v_wid, v_aid,
        (case when g % 3 = 0 then 'sell' else 'buy' end)::invest_order_side,
        v_shares, v_price, (v_shares * v_price)::bigint,
        (enum_range(null::invest_order_status))[1 + (g % array_length(enum_range(null::invest_order_status),1))]::invest_order_status,
        now() - ((g % 180) || ' days')::interval);
    end loop;
  end if;

  raise notice 'FK-parented feature-gap seed complete for family % (medication_doses 500, invest_orders 500).', v_family;
end $$;


-- ============================================================================
-- FamilyOS · SEED — Trips + Vacation Planner OS (the last big feature-gap).
-- ----------------------------------------------------------------------------
-- The Trip Planner (`trips`/`trip_items`) and the 27-table Vacation Planner
-- (`vacations` + every child: destinations, itinerary days/items, flights,
-- transportation, lodging, activities + tickets, reservations, budgets +
-- expenses, packing lists/items, documents, emergency + medical, checklists,
-- weather, AI recommendations/conversations/messages, travel scores, activity
-- logs, notifications, audit) had NO seed and rendered empty at test time.
--
-- This seeds a realistic set of parent trips/vacations and populates every
-- child table. The primary scrollable lists a user actually pages through —
-- trip_items, itinerary_items, activities, reservations, expenses,
-- packing_items, checklists — each reach 500; the rest get proportionate,
-- realistic volume so every planner tab renders at real density.
--
-- IDEMPOTENT: seed trips/vacations carry a '[seed]' title prefix; deleting them
-- CASCADES every child row (all FKs are ON DELETE CASCADE), so re-running is
-- clean. Family-scoped; resolves the family by email (falls back to the oldest
-- family). Guarded by to_regclass so a missing table is skipped, never fatal.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
#variable_conflict use_column
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_uid     uuid;
  v_members uuid[];
  v_mcount  int;
  n int := 500;
  v_trips   uuid[];
  v_vacs    uuid[];
  v_dests   uuid[];
  v_days    uuid[];
  v_acts    uuid[];
  v_lists   uuid[];
  v_convos  uuid[];
  v_vid uuid; v_did uuid; v_aid uuid; v_lid uuid; v_cid uuid; v_mid uuid;
  g int; j int;
  vkinds text[] := array['road_trip','flight','cruise','theme_park','international','domestic','staycation','camping','other'];
  vstats text[] := array['planning','planning','booked','active','completed','cancelled'];
  places text[] := array['Orlando, FL','San Diego, CA','Yellowstone','Paris, France','Maui, HI','New York, NY',
                         'Grand Canyon','London, UK','Cancún, MX','Lake Tahoe','Rome, Italy','Vancouver, BC'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  v_mcount := coalesce(array_length(v_members, 1), 0);

  -- ══ TRIPS (simple planner: trips + 500 trip_items) ════════════════════════
  if to_regclass('public.trips') is not null then
    delete from public.trips where family_id = v_family and name like '[seed]%';  -- cascades trip_items
    insert into public.trips (family_id, name, destination, start_date, end_date, status, traveler_ids, notes, created_by)
    select v_family,
      '[seed] ' || (array['Summer road trip','Ski week','Beach getaway','Grandparents visit','Spring break',
                          'Anniversary trip','Camping weekend','Theme-park days','City break','Reunion'])[1 + (g % 10)] || ' #' || g,
      places[1 + (g % array_length(places,1))],
      (current_date + ((g % 200) - 60 || ' days')::interval)::date,
      (current_date + ((g % 200) - 60 + 5 || ' days')::interval)::date,
      vstats[1 + (g % array_length(vstats,1))]::trip_status,
      coalesce(v_members, '{}'),
      'Seeded trip for testing the planner.', v_uid
    from generate_series(1, 12) as g;
    select array_agg(id) into v_trips from public.trips where family_id = v_family and name like '[seed]%';

    if to_regclass('public.trip_items') is not null then
      insert into public.trip_items (family_id, trip_id, kind, label, details, assignee_id, is_done, due_at, sort_order, created_by)
      select v_family,
        v_trips[1 + (g % array_length(v_trips,1))],
        (enum_range(null::trip_item_kind))[1 + (g % array_length(enum_range(null::trip_item_kind),1))]::trip_item_kind,
        (array['Sunscreen','Book rental car','Dinner reservation','Passports','Phone chargers','Confirm hotel',
               'Snacks for drive','Print boarding passes','Beach towels','Travel insurance'])[1 + (g % 10)] || ' #' || g,
        'Seeded checklist item.',
        case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
        (g % 3 = 0),
        (now() + ((g % 60) || ' days')::interval),
        g, v_uid
      from generate_series(1, n) as g;
    end if;
  end if;

  -- ══ VACATIONS (rich planner) ══════════════════════════════════════════════
  if to_regclass('public.vacations') is null then
    raise notice 'vacations table absent — skipped.'; return;
  end if;

  delete from public.vacations where family_id = v_family and title like '[seed]%';  -- cascades all children

  insert into public.vacations (family_id, title, kind, status, destination, start_date, end_date, timezone,
                                description, budget_cents, currency, is_international, notes, created_by)
  select v_family,
    '[seed] ' || (array['Disney World','SoCal Adventure','National Parks','Paris & Rome','Hawaii Escape',
                        'Big Apple Weekend','Grand Canyon Road Trip','London Half-Term','Cancún All-Inclusive',
                        'Tahoe Ski Week','Italy Family Tour','Vancouver Summer'])[g] || ' ' || (2025 + (g % 3)),
    vkinds[1 + (g % array_length(vkinds,1))]::vacation_kind,
    vstats[1 + (g % array_length(vstats,1))]::vacation_status,
    places[g],
    (current_date + ((g * 21) - 120 || ' days')::interval)::date,
    (current_date + ((g * 21) - 120 + 6 || ' days')::interval)::date,
    'America/New_York',
    'Seeded vacation exercising the full planner at real volume.',
    (200000 + g * 75000)::bigint, 'USD', (g % 3 = 0),
    'Seeded trip.', v_uid
  from generate_series(1, 12) as g;
  select array_agg(id) into v_vacs from public.vacations where family_id = v_family and title like '[seed]%';

  -- ── members on each vacation (bounded: members × vacations) ────────────────
  if to_regclass('public.vacation_members') is not null and v_members is not null then
    insert into public.vacation_members (family_id, vacation_id, member_id, role, dietary_restrictions, preferences, created_by)
    select v_family, v, m,
      (array['adult','child','grandparent','caregiver'])[1 + ((row_number() over ())::int % 4)],
      (array['none','vegetarian','gluten-free','nut allergy'])[1 + ((row_number() over ())::int % 4)],
      'Window seat; early riser.', v_uid
    from unnest(v_vacs) as v cross join unnest(v_members) as m
    on conflict (vacation_id, member_id) do nothing;
  end if;

  -- ── destinations (3 per vacation) ─────────────────────────────────────────
  if to_regclass('public.vacation_destinations') is not null then
    insert into public.vacation_destinations (family_id, vacation_id, name, region, country, latitude, longitude, arrive_date, depart_date, sort_order, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      places[1 + (g % array_length(places,1))],
      (array['Coast','Mountains','Downtown','Countryside'])[1 + (g % 4)],
      (array['USA','France','Italy','UK','Mexico','Canada'])[1 + (g % 6)],
      25 + (g % 40), -120 + (g % 200), current_date + (g % 30), current_date + (g % 30) + 3,
      g % 3, 'Seeded stop.', v_uid
    from generate_series(1, 36) as g;
    select array_agg(id) into v_dests from public.vacation_destinations
      where family_id = v_family and vacation_id = any(v_vacs);
  end if;

  -- ── itinerary days (7 distinct days per vacation) ─────────────────────────
  if to_regclass('public.vacation_itinerary_days') is not null then
    for j in 1..array_length(v_vacs,1) loop
      v_vid := v_vacs[j];
      insert into public.vacation_itinerary_days (family_id, vacation_id, day_date, title, summary, created_by)
      select v_family, v_vid,
        (current_date + ((j * 21) - 120 + g || ' days')::interval)::date,
        'Day ' || g, 'Seeded itinerary day.', v_uid
      from generate_series(0, 6) as g
      on conflict (vacation_id, day_date) do nothing;
    end loop;
    select array_agg(id) into v_days from public.vacation_itinerary_days
      where family_id = v_family and vacation_id = any(v_vacs);
  end if;

  -- ── itinerary items (500, linked to a day of the same vacation) ───────────
  if to_regclass('public.vacation_itinerary_items') is not null then
    for g in 1..n loop
      v_vid := v_vacs[1 + (g % array_length(v_vacs,1))];
      select id into v_did from public.vacation_itinerary_days
        where vacation_id = v_vid order by day_date offset (g % 7) limit 1;
      insert into public.vacation_itinerary_items
        (family_id, vacation_id, day_id, kind, day_part, title, location, start_time, end_time, duration_min, cost_cents, booked, notes, member_ids, sort_order, created_by)
      values (v_family, v_vid, v_did,
        (enum_range(null::vac_item_kind))[1 + (g % array_length(enum_range(null::vac_item_kind),1))]::vac_item_kind,
        (enum_range(null::vac_day_part))[1 + (g % array_length(enum_range(null::vac_day_part),1))]::vac_day_part,
        (array['Breakfast','Museum visit','Pool time','City tour','Dinner out','Beach','Show','Park entry','Shopping','Rest'])[1 + (g % 10)] || ' #' || g,
        places[1 + (g % array_length(places,1))],
        (make_time(8 + (g % 10), (g % 4) * 15, 0)),
        (make_time(9 + (g % 10), (g % 4) * 15, 0)),
        30 + (g % 8) * 15, (g % 12) * 1500, (g % 2 = 0), 'Seeded itinerary item.',
        coalesce(v_members, '{}'), g, v_uid);
    end loop;
  end if;

  -- ── flights (48) ──────────────────────────────────────────────────────────
  if to_regclass('public.vacation_flights') is not null then
    insert into public.vacation_flights (family_id, vacation_id, airline, flight_number, depart_airport, arrive_airport, depart_at, arrive_at, terminal, gate, seats, confirmation_code, booked, cost_cents, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['Delta','United','American','Southwest','JetBlue','Alaska'])[1 + (g % 6)],
      'FL' || (100 + g), (array['JFK','LAX','ORD','ATL','SFO','MIA'])[1 + (g % 6)],
      (array['MCO','SAN','LHR','CDG','HNL','YVR'])[1 + (g % 6)],
      now() + ((g % 90) || ' days')::interval, now() + ((g % 90) || ' days')::interval + interval '5 hours',
      'T' || (1 + g % 4), 'G' || (1 + g % 30), (g % 30) || 'A', 'CONF' || lpad(g::text,4,'0'),
      (g % 2 = 0), (15000 + g * 900)::bigint, 'Seeded flight.', v_uid
    from generate_series(1, 48) as g;
  end if;

  -- ── ground transportation (48) ────────────────────────────────────────────
  if to_regclass('public.vacation_transportation') is not null then
    insert into public.vacation_transportation (family_id, vacation_id, kind, provider, from_location, to_location, depart_at, arrive_at, confirmation_code, distance_miles, fuel_estimate_cents, booked, cost_cents, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (enum_range(null::vac_transport_kind))[1 + (g % array_length(enum_range(null::vac_transport_kind),1))]::vac_transport_kind,
      (array['Hertz','Amtrak','Greyhound','Uber','Airport Shuttle'])[1 + (g % 5)],
      places[1 + (g % array_length(places,1))], places[1 + ((g+1) % array_length(places,1))],
      now() + ((g % 80) || ' days')::interval, now() + ((g % 80) || ' days')::interval + interval '3 hours',
      'TR' || lpad(g::text,4,'0'), (10 + g % 300)::numeric, (g % 20) * 500, (g % 2 = 0), (g % 15) * 2500, 'Seeded transport.', v_uid
    from generate_series(1, 48) as g;
  end if;

  -- ── lodging (36) ──────────────────────────────────────────────────────────
  if to_regclass('public.vacation_lodging') is not null then
    insert into public.vacation_lodging (family_id, vacation_id, kind, name, address, phone, check_in, check_out, confirmation_code, nightly_cents, total_cents, booked, url, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (enum_range(null::vac_lodging_kind))[1 + (g % array_length(enum_range(null::vac_lodging_kind),1))]::vac_lodging_kind,
      (array['Seaside Inn','Grand Resort','Cozy Cabin','Downtown Suites','Family Lodge'])[1 + (g % 5)] || ' #' || g,
      (100 + g) || ' Main St', '555-01' || lpad(g::text,2,'0'),
      current_date + (g % 60), current_date + (g % 60) + 4, 'LDG' || lpad(g::text,4,'0'),
      (12000 + g * 300)::bigint, (48000 + g * 1200)::bigint, (g % 2 = 0), 'https://example.com/stay/' || g, 'Seeded lodging.', v_uid
    from generate_series(1, 36) as g;
  end if;

  -- ── activities (500) + tickets ────────────────────────────────────────────
  if to_regclass('public.vacation_activities') is not null then
    insert into public.vacation_activities (family_id, vacation_id, name, category, location, scheduled_at, duration_min, cost_cents, family_friendly, url, booked, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['Theme park','Guided tour','Snorkeling','Museum','Hiking','Cooking class','Boat cruise','Zoo','Beach day','Show'])[1 + (g % 10)] || ' #' || g,
      (array['attraction','tour','restaurant','show','outdoor'])[1 + (g % 5)],
      places[1 + (g % array_length(places,1))],
      now() + ((g % 90) || ' days')::interval, 60 + (g % 8) * 30, (g % 20) * 2000, (g % 4 <> 0),
      'https://example.com/act/' || g, (g % 2 = 0), 'Seeded activity.', v_uid
    from generate_series(1, n) as g;
    select array_agg(id) into v_acts from public.vacation_activities
      where family_id = v_family and vacation_id = any(v_vacs) and notes = 'Seeded activity.';

    if to_regclass('public.vacation_activity_tickets') is not null and v_acts is not null then
      insert into public.vacation_activity_tickets (family_id, vacation_id, activity_id, holder_member_id, holder_name, ticket_type, confirmation_code, price_cents, notes, created_by)
      select v_family,
        (select vacation_id from public.vacation_activities a where a.id = v_acts[1 + (g % array_length(v_acts,1))]),
        v_acts[1 + (g % array_length(v_acts,1))],
        case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
        'Guest ' || g, (array['adult','child','senior','group'])[1 + (g % 4)],
        'TKT' || lpad(g::text,4,'0'), (g % 15) * 2500, 'Seeded ticket.', v_uid
      from generate_series(1, 150) as g;
    end if;
  end if;

  -- ── reservations (500) ────────────────────────────────────────────────────
  if to_regclass('public.vacation_reservations') is not null then
    insert into public.vacation_reservations (family_id, vacation_id, kind, name, location, reserved_at, party_size, confirmation_code, cost_cents, booked, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['dining','spa','tour','rental','excursion'])[1 + (g % 5)],
      (array['The Grand Bistro','Serenity Spa','Sunset Cruise','Bike Rental','Guided Hike'])[1 + (g % 5)] || ' #' || g,
      places[1 + (g % array_length(places,1))],
      now() + ((g % 90) || ' days')::interval, 2 + (g % 6), 'RSV' || lpad(g::text,4,'0'),
      (g % 12) * 3000, (g % 2 = 0), 'Seeded reservation.', v_uid
    from generate_series(1, n) as g;
  end if;

  -- ── budgets (9 categories per vacation) ───────────────────────────────────
  if to_regclass('public.vacation_budgets') is not null then
    insert into public.vacation_budgets (family_id, vacation_id, category, planned_cents, notes, created_by)
    select v_family, v, c::vac_budget_category, (25000 + (row_number() over ()) * 1500)::bigint, 'Seeded budget line.', v_uid
    from unnest(v_vacs) as v
    cross join unnest(array['flights','lodging','transportation','activities','food','shopping','insurance','fees','misc']) as c
    on conflict (vacation_id, category) do nothing;
  end if;

  -- ── expenses (500) ────────────────────────────────────────────────────────
  if to_regclass('public.vacation_expenses') is not null then
    insert into public.vacation_expenses (family_id, vacation_id, category, description, amount_cents, spent_on, paid_by_member_id, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (enum_range(null::vac_budget_category))[1 + (g % array_length(enum_range(null::vac_budget_category),1))]::vac_budget_category,
      (array['Lunch','Souvenirs','Parking','Tickets','Taxi','Groceries','Coffee','Dinner','Gift shop','Tips'])[1 + (g % 10)] || ' #' || g,
      (500 + (g % 40) * 250)::bigint, (current_date - (g % 120)),
      case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
      'Seeded expense.', v_uid
    from generate_series(1, n) as g;
  end if;

  -- ── packing lists (per member per vacation + a master) + 500 items ────────
  if to_regclass('public.vacation_packing_lists') is not null then
    -- one master list per vacation
    insert into public.vacation_packing_lists (family_id, vacation_id, name, member_id, is_master, created_by)
    select v_family, v, 'Family master list', null, true, v_uid from unnest(v_vacs) as v;
    -- a personal list per member per vacation
    if v_members is not null then
      insert into public.vacation_packing_lists (family_id, vacation_id, name, member_id, is_master, created_by)
      select v_family, v, 'Personal list', m, false, v_uid
      from unnest(v_vacs) as v cross join unnest(v_members) as m;
    end if;
    select array_agg(id) into v_lists from public.vacation_packing_lists
      where family_id = v_family and vacation_id = any(v_vacs);

    if to_regclass('public.vacation_packing_items') is not null and v_lists is not null then
      for g in 1..n loop
        v_lid := v_lists[1 + (g % array_length(v_lists,1))];
        select vacation_id into v_vid from public.vacation_packing_lists where id = v_lid;
        insert into public.vacation_packing_items (family_id, vacation_id, list_id, name, category, quantity, packed, ai_suggested, notes, created_by)
        values (v_family, v_vid, v_lid,
          (array['T-shirts','Sunscreen','Toothbrush','Charger','Passport','Swimsuit','Sandals','Jacket','Snacks','First-aid kit'])[1 + (g % 10)] || ' #' || g,
          (enum_range(null::vac_pack_category))[1 + (g % array_length(enum_range(null::vac_pack_category),1))]::vac_pack_category,
          1 + (g % 4), (g % 2 = 0), (g % 5 = 0), 'Seeded packing item.', v_uid);
      end loop;
    end if;
  end if;

  -- ── documents (96) ────────────────────────────────────────────────────────
  if to_regclass('public.vacation_documents') is not null then
    insert into public.vacation_documents (family_id, vacation_id, kind, title, member_id, number, issued_on, expires_on, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (enum_range(null::vac_doc_kind))[1 + (g % array_length(enum_range(null::vac_doc_kind),1))]::vac_doc_kind,
      (array['Passport','Driver ID','Travel Visa','Event Ticket','Boarding Pass','Hotel Confirmation','Insurance Card','Trip Itinerary'])[1 + (g % 8)] || ' #' || g,
      case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
      'DOC' || lpad(g::text,6,'0'), current_date - (g % 800), current_date + (g % 800), 'Seeded document.', v_uid
    from generate_series(1, 96) as g;
  end if;

  -- ── emergency contacts (60) ───────────────────────────────────────────────
  if to_regclass('public.vacation_emergency_contacts') is not null then
    insert into public.vacation_emergency_contacts (family_id, vacation_id, name, relationship, phone, email, category, address, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['Dr. Smith','City Hospital','Travel Insurer','US Embassy','Local Police','Grandma'])[1 + (g % 6)] || ' #' || g,
      (array['doctor','hospital','insurer','embassy','police','family'])[1 + (g % 6)],
      '555-02' || lpad(g::text,2,'0'), 'contact' || g || '@example.com',
      (array['doctor','insurance','embassy','local_emergency','family'])[1 + (g % 5)],
      (200 + g) || ' Care Ave', 'Seeded emergency contact.', v_uid
    from generate_series(1, 60) as g;
  end if;

  -- ── medical information (per member per vacation) ─────────────────────────
  if to_regclass('public.vacation_medical_information') is not null and v_members is not null then
    insert into public.vacation_medical_information (family_id, vacation_id, member_id, allergies, conditions, medications, blood_type, insurance_provider, insurance_number, physician, physician_phone, notes, created_by)
    select v_family, v, m,
      (array['none','peanuts','penicillin','pollen'])[1 + ((row_number() over ())::int % 4)],
      (array['none','asthma','none','none'])[1 + ((row_number() over ())::int % 4)],
      'As needed', (array['O+','A+','B+','AB+','O-'])[1 + ((row_number() over ())::int % 5)],
      'FamilyCare Health', 'INS' || lpad((row_number() over ())::text,6,'0'),
      'Dr. Jordan', '555-0100', 'Seeded medical info.', v_uid
    from unnest(v_vacs) as v cross join unnest(v_members) as m;
  end if;

  -- ── checklists (500) ──────────────────────────────────────────────────────
  if to_regclass('public.vacation_checklists') is not null then
    insert into public.vacation_checklists (family_id, vacation_id, title, done, due_date, assignee_member_id, sort_order, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['Book flights','Reserve hotel','Buy travel insurance','Renew passports','Arrange pet care',
             'Hold mail','Pack bags','Print itinerary','Exchange currency','Charge devices'])[1 + (g % 10)] || ' #' || g,
      (g % 3 = 0), current_date + (g % 60),
      case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
      g, v_uid
    from generate_series(1, n) as g;
  end if;

  -- ── weather snapshots (per vacation × 7 days) ─────────────────────────────
  if to_regclass('public.vacation_weather_snapshots') is not null then
    for j in 1..array_length(v_vacs,1) loop
      v_vid := v_vacs[j];
      insert into public.vacation_weather_snapshots (family_id, vacation_id, location_label, latitude, longitude, forecast_date, temp_high_c, temp_low_c, precip_prob, precip_mm, wind_kph, weather_code, summary, created_by)
      select v_family, v_vid, places[1 + (j % array_length(places,1))], 30.0 + j, -90.0 + j,
        (current_date + (g || ' days')::interval)::date,
        22 + (g % 10), 12 + (g % 8), (g * 13) % 101, (g % 12)::numeric, (5 + g % 20)::numeric, g % 5,
        (array['Sunny','Partly cloudy','Light rain','Clear','Windy'])[1 + (g % 5)], v_uid
      from generate_series(0, 6) as g
      on conflict (vacation_id, location_label, forecast_date) do nothing;
    end loop;
  end if;

  -- ── AI recommendations (200) ──────────────────────────────────────────────
  if to_regclass('public.vacation_ai_recommendations') is not null then
    insert into public.vacation_ai_recommendations (family_id, vacation_id, kind, status, title, detail, severity, source, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (enum_range(null::vac_reco_kind))[1 + (g % array_length(enum_range(null::vac_reco_kind),1))]::vac_reco_kind,
      (enum_range(null::vac_reco_status))[1 + (g % array_length(enum_range(null::vac_reco_status),1))]::vac_reco_status,
      (array['Add a dinner reservation','Pack rain gear','You are over budget','Storm expected','Overlapping plans','Try this tour','Book this restaurant','Missing passport scan','Consider travel insurance'])[1 + (g % 9)] || ' #' || g,
      'Seeded AI recommendation the planner can action.', 1 + (g % 3),
      (array['rules','ai'])[1 + (g % 2)], v_uid
    from generate_series(1, 200) as g;
  end if;

  -- ── AI conversations (24) + messages (500) ────────────────────────────────
  if to_regclass('public.vacation_ai_conversations') is not null then
    insert into public.vacation_ai_conversations (family_id, vacation_id, title, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))], '[seed] Concierge chat #' || g, v_uid
    from generate_series(1, 24) as g;
    select array_agg(id) into v_convos from public.vacation_ai_conversations
      where family_id = v_family and title like '[seed]%';

    if to_regclass('public.vacation_ai_messages') is not null and v_convos is not null then
      insert into public.vacation_ai_messages (family_id, conversation_id, role, content, created_by)
      select v_family, v_convos[1 + (g % array_length(v_convos,1))],
        (case when g % 2 = 0 then 'user' else 'assistant' end)::ai_role,
        case when g % 2 = 0 then 'What should we do on day ' || (1 + g % 6) || '?'
             else 'Here is a family-friendly plan for that day, within your budget.' end,
        v_uid
      from generate_series(1, n) as g;
    end if;
  end if;

  -- ── travel/readiness scores (120) ─────────────────────────────────────────
  if to_regclass('public.vacation_travel_scores') is not null then
    insert into public.vacation_travel_scores (family_id, vacation_id, score, breakdown, computed_at)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))], 40 + (g * 7) % 61,
      jsonb_build_object('bookings', 20 + g % 30, 'packing', 10 + g % 40, 'documents', 15 + g % 25),
      now() - ((g % 120) || ' days')::interval
    from generate_series(1, 120) as g;
  end if;

  -- ── activity logs (500) ───────────────────────────────────────────────────
  if to_regclass('public.vacation_activity_logs') is not null then
    insert into public.vacation_activity_logs (family_id, vacation_id, actor_member_id, action, detail, created_by, created_at)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
      (array['created','updated','booked','cancelled','commented','packed','checked_in'])[1 + (g % 7)],
      'Seeded activity log entry.', v_uid, now() - ((g % 180) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── notifications (200) ───────────────────────────────────────────────────
  if to_regclass('public.vacation_notifications') is not null then
    insert into public.vacation_notifications (family_id, vacation_id, member_id, title, body, read, send_at, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
      (array['Trip in 7 days','Check-in open','Weather alert','Reservation reminder','Packing reminder'])[1 + (g % 5)] || ' #' || g,
      'Seeded notification body.', (g % 2 = 0), now() + ((g % 30) || ' days')::interval, v_uid
    from generate_series(1, 200) as g;
  end if;

  -- ── audit logs (120) ──────────────────────────────────────────────────────
  if to_regclass('public.vacation_audit_logs') is not null then
    insert into public.vacation_audit_logs (family_id, vacation_id, table_name, record_id, action, changes, actor_user_id, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['vacation_itinerary_items','vacation_expenses','vacation_lodging','vacation_activities'])[1 + (g % 4)],
      gen_random_uuid(), (array['insert','update','delete'])[1 + (g % 3)],
      jsonb_build_object('field', 'value', 'n', g), v_uid, v_uid
    from generate_series(1, 120) as g;
  end if;

  raise notice 'Trips + Vacation Planner seed complete for family % (trips 12/items 500; 12 vacations; itinerary/activities/reservations/expenses/packing/checklists/logs/messages at 500).', v_family;
end $$;

-- ==================== seed_operating_index_history.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Family Operating Index history (500 daily snapshots).
-- Fills family_operating_index with 500 days of daily snapshots so the FOI
-- **trend line** + "since yesterday" day-over-day recap render at volume (the
-- page shows "first reading" until history exists). A gentle wave around the mid-
-- 70s with a slight recent upward drift; per-dimension scores + captured
-- suggestions per snapshot. Idempotent: upserts on (family_id, as_of_date), so
-- re-running overwrites the same 500 days and never deletes real snapshots.
-- Resolves the family by email. (Needs migration 0125 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
begin
  if to_regclass('public.family_operating_index') is null then
    raise notice 'family_operating_index not present — apply migration 0125 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  insert into public.family_operating_index (family_id, as_of_date, composite, band, dimensions, suggestions)
  select
    v_family,
    (current_date - g.i),
    c.composite,
    case when c.composite >= 85 then 'thriving'
         when c.composite >= 70 then 'steady'
         when c.composite >= 50 then 'stretched'
         else 'overloaded' end,
    -- per-dimension scores derived from the composite with fixed per-dim offsets.
    jsonb_build_object(
      'planning',      greatest(0, least(100, c.composite + 4)),
      'routine',       greatest(0, least(100, c.composite - 3)),
      'stability',     greatest(0, least(100, c.composite + 1)),
      'financial',     greatest(0, least(100, c.composite - 6)),
      'readiness',     greatest(0, least(100, c.composite + 2)),
      'communication', greatest(0, least(100, c.composite - 2)),
      'goals',         greatest(0, least(100, c.composite + 5))
    ),
    jsonb_build_array(
      jsonb_build_object('id','s1','title','Confirm 2 events missing a location','detail','Tap to add where they are','href','/dashboard/calendar','dimension','planning','impact','medium'),
      jsonb_build_object('id','s2','title','Review this week''s budget','detail','One category is trending over','href','/wallet','dimension','financial','impact','low')
    )
  from generate_series(0, n - 1) g(i)
  cross join lateral (
    -- recent days drift a little higher; a ±12 wave keeps bands varied.
    select greatest(30, least(98, round(60 + ((n - g.i)::numeric / n) * 18 + 12 * sin(g.i / 7.0))::int)) as composite
  ) c
  on conflict (family_id, as_of_date) do update
    set composite = excluded.composite, band = excluded.band,
        dimensions = excluded.dimensions, suggestions = excluded.suggestions;

  raise notice 'FOI history seeded 500 daily snapshots for family %', v_family;
end $$;

-- Verify:
--   select count(*) from family_operating_index where family_id = (select id from families order by created_at limit 1);  -- ≥ 500
--   select band, count(*) from family_operating_index group by band;
--   select as_of_date, composite, band from family_operating_index order by as_of_date desc limit 10;

-- ==================== seed_meal_votes.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Meal votes (500 + 2 options each).
-- Fills meal_votes (+ meal_vote_options) at volume so the FOI **communication**
-- dimension (open decisions) and /dashboard/voting render at scale. 500 votes
-- with a status/meal-type spread, each with two options. Idempotent via title
-- like '%[seed-mv]%'; resolves the family by email. (Needs the meals schema.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_user   uuid;
  n int := 500;
  types    text[] := array['breakfast','lunch','dinner','snack'];
  statuses text[] := array['open','open','open','closed'];
  dishes   text[] := array['Tacos','Pasta night','Stir-fry','Pizza','Curry','Burgers','Salad bar','Soup & bread','Breakfast-for-dinner','Grill night'];
begin
  if to_regclass('public.meal_votes') is null then
    raise notice 'meal_votes not present — apply the meals schema first. Skipping.';
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

  -- Options first (FK), then votes: delete children before parents.
  delete from public.meal_vote_options o
    using public.meal_votes v
    where o.vote_id = v.id and v.family_id = v_family and v.title like '%[seed-mv]%';
  delete from public.meal_votes where family_id = v_family and title like '%[seed-mv]%';

  -- 500 votes.
  insert into public.meal_votes (family_id, created_by, title, meal_type, status, meal_date, allow_maybe, created_at)
  select
    v_family, v_user,
    'What''s for ' || types[1+(g.i % 4)] || '? #' || g.i || ' [seed-mv]',
    types[1+(g.i % 4)],
    statuses[1+(g.i % 4)],
    (current_date + (g.i % 21)),
    (g.i % 2 = 0),
    now() - ((g.i % 120) || ' days')::interval
  from generate_series(1, n) g(i);

  -- Two options per seeded vote (distinct dishes).
  insert into public.meal_vote_options (vote_id, family_id, label)
  select v.id, v_family, d.label
  from public.meal_votes v
  cross join lateral (
    select dishes[1 + (abs(hashtext(v.id::text))     % 10)] as label
    union all
    select dishes[1 + ((abs(hashtext(v.id::text)) + 3) % 10)]
  ) d
  where v.family_id = v_family and v.title like '%[seed-mv]%';

  raise notice 'Meal votes seeded 500 (+ options) for family %', v_family;
end $$;

-- Verify:
--   select count(*) from meal_votes where title like '%[seed-mv]%';                     -- 500
--   select count(*) from meal_vote_options o join meal_votes v on v.id=o.vote_id where v.title like '%[seed-mv]%';  -- ~1000
--   select status, count(*) from meal_votes where title like '%[seed-mv]%' group by status;

-- ==================== seed_concierge_plan_actions.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Concierge plan actions (500 records).
-- Fills concierge_plan_actions so the deeper write-back audit renders at volume:
-- 500 materializations (calendar / reminder / task) across the family's concierge
-- plans, one per (plan, kind). Requires the concierge plans seeded first
-- (seed_concierge.sql) and migration 0158. Idempotent via detail like '%[seed]%';
-- resolves the family by email.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_user   uuid;
  v_plans  uuid[];
  np int; n int := 500;
  kinds  text[] := array['calendar','reminder','task'];
  tables text[] := array['calendar_events','family_reminders','family_reminders'];
begin
  if to_regclass('public.concierge_plan_actions') is null then
    raise notice 'concierge_plan_actions not present — apply migration 0158 first. Skipping.';
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

  select array_agg(id) into v_plans from (
    select id from public.concierge_plans where family_id = v_family order by created_at limit 1000
  ) s;
  np := coalesce(array_length(v_plans, 1), 0);
  if np = 0 then
    raise notice 'No concierge plans — run seed_concierge.sql first. Skipping.';
    return;
  end if;

  delete from public.concierge_plan_actions where family_id = v_family and detail like '%[seed]%';

  -- Grid walk: kind = i % 3 (even spread across all three kinds), plan = i / 3.
  -- Each plan gets its 3 kinds before the next → distinct (plan, kind) pairs,
  -- balanced, unique for np ≥ 167.
  insert into public.concierge_plan_actions
    (family_id, plan_id, action_kind, target_table, target_id, detail, created_by, created_at)
  select
    v_family,
    v_plans[1 + ((g.i / 3) % np)],
    kinds[1 + (g.i % 3)],
    tables[1 + (g.i % 3)],
    null,
    'Materialized by the concierge. [seed]',
    v_user,
    now() - ((g.i % 90) || ' days')::interval
  from generate_series(0, n - 1) g(i)
  on conflict (family_id, plan_id, action_kind) do nothing;

  raise notice 'Concierge plan actions seeded (up to 500) across % plans for family %', np, v_family;
end $$;

-- Verify:
--   select count(*) from concierge_plan_actions where detail like '%[seed]%';   -- up to 500
--   select action_kind, count(*) from concierge_plan_actions group by action_kind;

-- ==================== seed_onboarding_progress.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Onboarding progress (500 accounts).
-- Fills onboarding_progress (migration 0159) at volume so the onboarding
-- lifecycle + marketing-signal layer can be tested across a realistic mix of
-- accounts: fully-onboarded wizard graduates, the "needs setup" auto-provisioned
-- cohort (skipped the wizard — no questionnaire/goals/marketing profile), and a
-- reset tail. Because onboarding_progress is ONE-per-account (unique user_id),
-- this seeds 500 synthetic auth.users (shared '@seed-onb.bubaly.test' domain) and
-- one progress row each — so marketing segments (value_engaged, source, status,
-- completeness) can be exercised at 500-account scale.
--
-- Realistic distribution across 500 accounts:
--   ~55% wizard + completed        (value_engaged mostly true, high completeness)
--   ~35% auto_provision + in_progress ("needs setup" — low completeness, no goals)
--   ~10% reset                     (explicitly restarted setup)
--
-- IDEMPOTENT: the synthetic users share the '@seed-onb.bubaly.test' domain and
-- their progress rows are removed (cascade) before re-insert. Resolves the family
-- by email for family_id. Degrades safely if 0159 isn't applied yet.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  goalset  text[] := array['chores','calendar','meals','groceries','budget','health','school','activities'];
  refs     text[] := array['friend','search','social','app_store','blog','other'];
begin
  if to_regclass('public.onboarding_progress') is null then
    raise notice 'onboarding_progress not present — apply migration 0159 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;

  -- Clean prior seed: delete synthetic users → onboarding_progress cascades.
  begin
    delete from auth.users where email like '%@seed-onb.bubaly.test';
  exception when others then raise notice 'skip auth.users cleanup: %', sqlerrm; end;

  -- 500 synthetic accounts.
  begin
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
    select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'onb'||g||'@seed-onb.bubaly.test', crypt('Password123!', gen_salt('bf')), now(),
           now() - ((g % 120) || ' days')::interval, now(),
           '{"provider":"email","providers":["email"]}'::jsonb,
           jsonb_build_object('full_name','Onboard Test '||g), false, false
    from generate_series(1, 500) as gs(g) on conflict do nothing;
  exception when others then
    raise notice 'skip auth.users insert (cannot seed synthetic accounts): %', sqlerrm;
    return;
  end;

  -- One progress row per synthetic account, with a realistic cohort spread.
  insert into public.onboarding_progress
    (user_id, family_id, status, source, steps_completed, value_engaged, import_source,
     events_imported, time_saved_minutes, goals, referral_source,
     household_adults, household_children, members_added, members_invited, has_pin,
     marketing_opt_in, completeness, completed_at, reset_at, created_at)
  select
    u.id,
    v_family,
    c.status,
    c.source,
    c.steps,
    c.value_engaged,
    case when c.value_engaged then (array['paste','demo','ics'])[1 + (n % 3)] else null end,
    case when c.value_engaged then 8 + (n % 40) else 0 end,
    case when c.value_engaged then 15 + (n % 45) else 0 end,
    c.goals,
    case when c.source = 'wizard' then refs[1 + (n % 6)] else null end,
    case when c.source = 'wizard' then 1 + (n % 2) else null end,
    case when c.source = 'wizard' then (n % 4) else null end,
    case when c.source = 'wizard' then (n % 3) else 0 end,
    case when c.source = 'wizard' then (n % 2) else 0 end,
    c.has_pin,
    (n % 10) <> 0,                                   -- ~90% marketing opt-in
    c.completeness,
    case when c.status = 'completed' then now() - ((n % 120) || ' days')::interval else null end,
    case when c.status = 'reset' then now() - ((n % 30) || ' days')::interval else null end,
    now() - ((n % 120) || ' days')::interval
  from (
    select u.id, row_number() over (order by u.created_at, u.id) as n
    from auth.users u where u.email like '%@seed-onb.bubaly.test'
  ) u
  cross join lateral (
    select
      case when (u.n % 20) < 11 then 'completed'
           when (u.n % 20) < 18 then 'in_progress'
           else 'reset' end                                             as status,
      case when (u.n % 20) < 11 then 'wizard'
           when (u.n % 20) < 18 then 'auto_provision'
           else 'wizard' end                                           as source,
      case when (u.n % 20) < 11 then array['profile','family','value','about','members','pin']
           when (u.n % 20) < 18 then array['profile']
           else array['profile','family']::text[] end                  as steps,
      ((u.n % 20) < 11 and (u.n % 3) <> 0)                             as value_engaged,
      case when (u.n % 20) < 11 then array[goalset[1 + (u.n % 8)], goalset[1 + ((u.n + 3) % 8)]]
           else array[]::text[] end                                    as goals,
      ((u.n % 20) < 11 and (u.n % 4) = 0)                              as has_pin,
      case when (u.n % 20) < 11 then 80 + (u.n % 21)                   -- completed: 80..100
           when (u.n % 20) < 18 then 30 + (u.n % 15)                   -- needs setup: 30..44
           else 15 + (u.n % 20) end                                    as completeness
  ) c
  on conflict (user_id) do update
    set status = excluded.status, source = excluded.source,
        steps_completed = excluded.steps_completed, value_engaged = excluded.value_engaged,
        goals = excluded.goals, has_pin = excluded.has_pin, completeness = excluded.completeness,
        completed_at = excluded.completed_at, reset_at = excluded.reset_at;

  raise notice 'onboarding_progress seeded 500 accounts (family %).', v_family;
end $$;

-- Verify:
--   select count(*) from onboarding_progress op join auth.users u on u.id=op.user_id where u.email like '%@seed-onb.bubaly.test';  -- 500
--   select status, source, count(*) from onboarding_progress op join auth.users u on u.id=op.user_id where u.email like '%@seed-onb.bubaly.test' group by 1,2 order by 1,2;
--   select count(*) filter (where value_engaged) as engaged, round(avg(completeness)) as avg_score from onboarding_progress op join auth.users u on u.id=op.user_id where u.email like '%@seed-onb.bubaly.test';

-- ==================== seed_feature_gaps_3.sql ====================
-- ============================================================================
-- FamilyOS · SEED — feature-gap coverage (round 3): user-facing, left-nav tables
-- that had NO seed rows, so their pages rendered empty during testing. Covers:
--   Care Log · Habit logs · Health goals/providers/symptoms · Insurance Hub ·
--   Expense split shares · Reward redemptions · Pet care · Auto (registrations,
--   service) · Home (contractors, service) · Relationship (profile, gift ideas) ·
--   Allowance rules · Member badges · Screen-time limits · Leftovers · Kid progress.
--
-- Resolves the family by the owner email; idempotent (seed rows carry '[seed]'
-- markers or use ON CONFLICT); every child insert is guarded on its parent so a
-- missing table/parent skips that block instead of aborting. Enum columns use
-- enum_range so they never drift. Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email    text := 'newworldventurellc@gmail.com';
  v_family   uuid;
  v_owner    uuid;
  v_members  uuid[];
  v_kids     uuid[];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select u.id into v_owner from auth.users u where lower(u.email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  select array_agg(id) into v_kids from public.family_members
    where family_id = v_family and role in ('child','teen');
  if v_members is null then raise notice 'Family % has no members; nothing to seed.', v_family; return; end if;
  if v_kids is null then v_kids := v_members; end if;

  -- ── Care Log (60) ────────────────────────────────────────────────────────
  if to_regclass('public.care_log') is not null then
    delete from public.care_log where family_id = v_family and note like '[seed]%';
    insert into public.care_log (family_id, member_id, log_type, occurred_at, wellbeing, note, logged_by, created_by)
    select v_family,
      v_members[1 + (g % array_length(v_members,1))],
      (enum_range(null::care_log_type))[1 + (g % array_length(enum_range(null::care_log_type),1))]::care_log_type,
      now() - ((g % 60) || ' days')::interval - ((g % 5) * 3 || ' hours')::interval,
      1 + (g % 5),
      '[seed] Wellbeing check-in',
      v_members[1 + ((g+1) % array_length(v_members,1))],
      v_owner
    from generate_series(1, 60) g;
  end if;

  -- ── Habit logs (up to 120, on existing habits) ───────────────────────────
  if to_regclass('public.habit_logs') is not null and to_regclass('public.habits') is not null then
    delete from public.habit_logs where family_id = v_family and note like '[seed]%';
    insert into public.habit_logs (family_id, habit_id, member_id, log_date, count, note, created_by)
    select v_family, h.id,
      v_members[1 + (d % array_length(v_members,1))],
      (current_date - d),
      1, '[seed] done',
      v_owner
    from public.habits h
    cross join generate_series(0, 19) d
    where h.family_id = v_family and (d % 3) <> 0        -- ~13 of 20 days per habit
    on conflict (habit_id, log_date) do nothing;
  end if;

  -- ── Health goals (per member × metric) ───────────────────────────────────
  if to_regclass('public.health_goals') is not null then
    insert into public.health_goals (family_id, member_id, metric_type, target, period, label, is_active, created_by)
    select v_family, m,
      mt.metric, mt.target, 'daily', mt.label, true, v_owner
    from unnest(v_members) m
    cross join (values ('steps', 8000, 'Daily steps'), ('sleep_hours', 8, 'Sleep'), ('water_ml', 2000, 'Hydration')) as mt(metric, target, label)
    on conflict (member_id, metric_type, period) do nothing;
  end if;

  -- ── Symptom logs (30) ────────────────────────────────────────────────────
  if to_regclass('public.symptom_logs') is not null then
    delete from public.symptom_logs where family_id = v_family and notes like '[seed]%';
    insert into public.symptom_logs (family_id, member_id, symptom, severity, body_area, started_at, ended_at, status, notes, created_by)
    select v_family,
      v_members[1 + (g % array_length(v_members,1))],
      (array['Headache','Cough','Sore throat','Fever','Stomach ache','Runny nose'])[1 + (g % 6)],
      1 + (g % 5),
      (array['head','chest','throat','whole body','abdomen','nose'])[1 + (g % 6)],
      now() - ((g % 40) || ' days')::interval,
      case when g % 3 = 0 then null else now() - ((g % 40) || ' days')::interval + '2 days'::interval end,
      case when g % 3 = 0 then 'active' else 'resolved' end,
      '[seed] symptom note',
      v_owner
    from generate_series(1, 30) g;
  end if;

  -- ── Health providers (8) ─────────────────────────────────────────────────
  if to_regclass('public.health_providers') is not null then
    delete from public.health_providers where family_id = v_family and notes like '[seed]%';
    insert into public.health_providers (family_id, member_id, kind, name, specialty, practice_name, phone, is_primary, notes, created_by)
    select v_family,
      v_members[1 + (g % array_length(v_members,1))],
      (enum_range(null::record_kind))[1 + (g % array_length(enum_range(null::record_kind),1))]::record_kind,
      (array['Dr. Amara Lee','Dr. Ben Ortiz','Dr. Priya Shah','Dr. Chris Wong','City Pediatrics','Bright Smiles Dental','Vision Plus','Dr. Dana Ree'])[1 + (g % 8)],
      (array['Family Medicine','Pediatrics','Dentistry','Optometry','Dermatology','Cardiology','ENT','Orthodontics'])[1 + (g % 8)],
      (array['Downtown Clinic','Main St Medical','Kids Health','Uptown Care'])[1 + (g % 4)],
      '555-01' || lpad(g::text, 2, '0'),
      (g = 1),
      '[seed] provider',
      v_owner
    from generate_series(1, 8) g;
  end if;

  -- ── Insurance policies (6) ───────────────────────────────────────────────
  if to_regclass('public.insurance_policies') is not null then
    delete from public.insurance_policies where family_id = v_family and notes like '[seed]%';
    insert into public.insurance_policies (family_id, member_id, kind, insurer, plan_name, plan_type, policy_number, group_number, customer_service_phone, effective_date, is_primary, notes, created_by)
    select v_family,
      v_members[1 + (g % array_length(v_members,1))],
      (enum_range(null::record_kind))[1 + (g % array_length(enum_range(null::record_kind),1))]::record_kind,
      (array['BlueCross','Aetna','Kaiser','UnitedHealth','Cigna','Delta Dental'])[1 + (g % 6)],
      (array['PPO Gold','HMO Silver','Family Plus','Standard','Premier','Basic'])[1 + (g % 6)],
      (array['PPO','HMO','EPO','POS','PPO','HMO'])[1 + (g % 6)],
      'POL-' || lpad(g::text, 6, '0'),
      'GRP-' || lpad(g::text, 4, '0'),
      '800-555-0' || lpad(g::text, 3, '0'),
      current_date - ((g % 3) || ' years')::interval,
      (g = 1),
      '[seed] policy',
      v_owner
    from generate_series(1, 6) g;
  end if;

  -- ── Expense split shares (guarded on expense_splits; no marker col, so seed
  --    once — re-running never dupes because we skip when shares already exist) ─
  if to_regclass('public.expense_split_shares') is not null and to_regclass('public.expense_splits') is not null
     and not exists (select 1 from public.expense_split_shares where family_id = v_family) then
    insert into public.expense_split_shares (family_id, split_id, member_id, share_cents, settled, settled_at)
    select v_family, s.id,
      v_members[1 + (rn % array_length(v_members,1))],
      2500 + (rn % 6) * 750,
      (rn % 2 = 0),
      case when rn % 2 = 0 then now() - ((rn % 20) || ' days')::interval else null end
    from (
      select id, (row_number() over (order by created_at))::int as rn
      from public.expense_splits where family_id = v_family limit 40
    ) s
    on conflict do nothing;
  end if;

  -- ── Reward redemptions (guarded on rewards) ──────────────────────────────
  if to_regclass('public.reward_redemptions') is not null and to_regclass('public.rewards') is not null then
    delete from public.reward_redemptions where family_id = v_family and note like '[seed]%';
    insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status, note, decided_by, decided_at, created_at)
    select v_family, r.id,
      v_kids[1 + (n % array_length(v_kids,1))],
      r.title, coalesce(r.cost_points, 50),
      (enum_range(null::redemption_status))[1 + (n % array_length(enum_range(null::redemption_status),1))]::redemption_status,
      '[seed] redemption',
      v_members[1], now() - ((n % 30) || ' days')::interval,
      now() - ((n % 30) || ' days')::interval
    from (select id, title, cost_points from public.rewards where family_id = v_family limit 20) r
    cross join generate_series(1, 2) as n
    limit 40;
  end if;

  -- ── Pet care records (guarded on pets) ───────────────────────────────────
  if to_regclass('public.pet_care_records') is not null and to_regclass('public.pets') is not null then
    delete from public.pet_care_records where family_id = v_family and notes like '[seed]%';
    insert into public.pet_care_records (family_id, pet_id, kind, title, record_date, next_due, dose, weight_kg, notes, created_by)
    select v_family, p.id,
      (enum_range(null::public.pet_care_kind))[1 + (g % array_length(enum_range(null::public.pet_care_kind),1))]::public.pet_care_kind,
      (array['Annual checkup','Rabies vaccine','Flea treatment','Grooming','Dental cleaning','Weight check'])[1 + (g % 6)],
      current_date - ((g % 8) * 30),
      current_date + ((g % 6) * 45),
      (array['1 tablet','5 mL','1 dose', null, null, null])[1 + (g % 6)],
      (4.5 + (g % 10))::numeric(6,2),
      '[seed] pet care',
      v_owner
    from public.pets p, generate_series(1, 8) as gs(g)
    where p.family_id = v_family;
  end if;

  -- ── Auto: registrations + service records (guarded on vehicles) ──────────
  if to_regclass('public.vehicle_registrations') is not null and to_regclass('public.vehicles') is not null then
    delete from public.vehicle_registrations where family_id = v_family and notes like '[seed]%';
    insert into public.vehicle_registrations (family_id, vehicle_id, plate, state, registered_on, expires_on, fee, status, notes, created_by)
    select v_family, v.id,
      upper(substr(md5(v.id::text), 1, 3)) || '-' || lpad((1000 + (row_number() over ()))::text, 4, '0'),
      (array['CA','TX','NY','WA','CO'])[1 + ((row_number() over ())::int % 5)],
      current_date - interval '10 months', current_date + interval '2 months',
      85 + (row_number() over () % 4) * 15, 'active', '[seed] registration', v_owner
    from public.vehicles v where v.family_id = v_family;
  end if;
  if to_regclass('public.auto_service_records') is not null and to_regclass('public.vehicles') is not null then
    delete from public.auto_service_records where family_id = v_family and description like '[seed]%';
    insert into public.auto_service_records (family_id, vehicle_id, title, service_date, provider, cost, mileage, description, next_due_on, next_due_mileage, created_by)
    select v_family, v.id,
      (array['Oil change','Tire rotation','Brake service','Battery replacement','Inspection','Coolant flush'])[1 + (g % 6)],
      current_date - ((g % 12) * 30),
      (array['QuickLube','Firestone','Dealer Service','Pep Boys'])[1 + (g % 4)],
      (45 + (g % 8) * 35)::numeric(10,2),
      15000 + g * 900,
      '[seed] service',
      current_date + ((g % 6) * 45),
      15000 + g * 900 + 5000,
      v_owner
    from public.vehicles v, generate_series(1, 15) as gs(g)
    where v.family_id = v_family limit 30;
  end if;

  -- ── Home: contractors (10) + service records (guarded, home_id nullable) ─
  if to_regclass('public.home_contractors') is not null then
    delete from public.home_contractors where family_id = v_family and notes like '[seed]%';
    insert into public.home_contractors (family_id, name, trade, company, phone, email, rating, hourly_rate, is_preferred, last_used_on, notes, created_by)
    select v_family,
      (array['Mike the Plumber','Ace Electric','Cool Air HVAC','Green Lawns','Roof Masters','Bug Away','Handy Hank','Bright Paint','Sparkle Clean','Fix-It Fred'])[g],
      (array['plumbing','electrical','hvac','landscaping','roofing','pest','general','general','general','general'])[g],
      (array['Mike LLC','Ace Co','Cool Air Inc','Green Lawns','Roof Masters','Bug Away','Handy Co','Bright Paint','Sparkle','Fix-It'])[g],
      '555-02' || lpad(g::text, 2, '0'),
      'contact' || g || '@example.com',
      3 + (g % 3),
      (65 + (g % 5) * 20)::numeric(10,2),
      (g <= 3),
      current_date - ((g % 6) * 40),
      '[seed] contractor',
      v_owner
    from generate_series(1, 10) g;
  end if;
  if to_regclass('public.home_service_records') is not null then
    delete from public.home_service_records where family_id = v_family and description like '[seed]%';
    insert into public.home_service_records (family_id, contractor_id, title, service_date, provider, cost, description, next_due_on, created_by)
    select v_family,
      (select id from public.home_contractors where family_id = v_family order by created_at offset (g % greatest((select count(*) from public.home_contractors where family_id = v_family),1)) limit 1),
      (array['HVAC tune-up','Gutter cleaning','Water heater flush','Lawn treatment','Roof inspection','Pest control','Deep clean','Repaint trim'])[1 + (g % 8)],
      current_date - ((g % 10) * 30),
      (array['Cool Air Inc','Green Lawns','Roof Masters','Bug Away'])[1 + (g % 4)],
      (90 + (g % 8) * 45)::numeric(12,2),
      '[seed] home service',
      current_date + ((g % 6) * 60),
      v_owner
    from generate_series(1, 20) g;
  end if;

  -- ── Relationship: profile (1, upsert) + gift ideas (12) ──────────────────
  if to_regclass('public.relationship_profile') is not null then
    insert into public.relationship_profile (family_id, created_by, partner_name, interests, love_languages, gift_budget_cents, notes)
    values (v_family, v_owner, 'Alex', array['hiking','cooking','jazz'], array['quality_time','acts_of_service'], 15000, '[seed] profile')
    on conflict (family_id) do update set partner_name = excluded.partner_name;
  end if;
  if to_regclass('public.relationship_gift_ideas') is not null then
    delete from public.relationship_gift_ideas where family_id = v_family and reason like '[seed]%';
    insert into public.relationship_gift_ideas (family_id, created_by, for_name, title, url, price_cents, occasion, reason, source, status)
    select v_family, v_owner, 'Alex',
      (array['Cooking class','Weekend getaway','Wireless headphones','Concert tickets','Spa day','Book set','Watch','Plant subscription','Board game','Coffee gear','Running shoes','Art print'])[g],
      'https://example.com/gift/' || g,
      (2000 + g * 1500),
      (array['anniversary','birthday','just because','holiday'])[1 + (g % 4)],
      '[seed] gift idea',
      (array['manual','ai','wishlist'])[1 + (g % 3)],
      (array['idea','saved','ordered'])[1 + (g % 3)]
    from generate_series(1, 12) g;
  end if;

  -- ── Allowance rules (guarded on child_wallets; seed once so re-runs don't dupe) ─
  if to_regclass('public.allowance_rules') is not null and to_regclass('public.child_wallets') is not null
     and not exists (select 1 from public.allowance_rules where family_id = v_family) then
    insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on, created_by)
    select v_family, w.id,
      (500 + (row_number() over () % 4) * 250)::bigint,
      (enum_range(null::allowance_cadence))[1 + ((row_number() over ())::int % array_length(enum_range(null::allowance_cadence),1))]::allowance_cadence,
      true, current_date + interval '7 days', v_owner
    from public.child_wallets w where w.family_id = v_family
    on conflict do nothing;
  end if;

  -- ── Member badges (guarded on badges) ────────────────────────────────────
  if to_regclass('public.member_badges') is not null and to_regclass('public.badges') is not null then
    insert into public.member_badges (family_id, member_id, badge_id, awarded_at)
    select v_family, m, b.id, now() - ((b.rn % 30) || ' days')::interval
    from unnest(v_kids) m
    cross join (select id, row_number() over () rn from public.badges limit 6) b
    on conflict (member_id, badge_id) do nothing;
  end if;

  -- ── Kid progress (per kid, upsert) ───────────────────────────────────────
  if to_regclass('public.kid_progress') is not null then
    insert into public.kid_progress (family_id, member_id, xp, level, current_streak, longest_streak, last_activity)
    select v_family, m,
      250 + (row_number() over () * 120)::int,
      1 + (row_number() over () % 5)::int,
      (row_number() over () % 8)::int,
      5 + (row_number() over () % 12)::int,
      current_date - ((row_number() over ())::int % 3)
    from unnest(v_kids) m
    on conflict (member_id) do update set xp = excluded.xp, level = excluded.level;
  end if;

  -- ── Screen-time limits (per kid, upsert) ─────────────────────────────────
  if to_regclass('public.screen_time_limits') is not null then
    insert into public.screen_time_limits (family_id, member_id, daily_minutes, created_by)
    select v_family, m, 60 + (row_number() over () % 4) * 30, v_owner
    from unnest(v_kids) m
    on conflict (family_id, member_id) do update set daily_minutes = excluded.daily_minutes;
  end if;

  -- ── Leftover inventory (12) ──────────────────────────────────────────────
  if to_regclass('public.leftover_inventory') is not null then
    delete from public.leftover_inventory where family_id = v_family and notes like '[seed]%';
    insert into public.leftover_inventory (family_id, name, source_meal, quantity, stored_on, use_by, location, status, notes, created_by)
    select v_family,
      (array['Roast chicken','Veggie curry','Spaghetti','Fried rice','Chili','Lasagna','Stir-fry','Soup','Tacos','Pizza','Salmon','Pancakes'])[g],
      (array['Sunday roast','Weeknight curry','Pasta night','Takeout','Batch cook','Freezer meal'])[1 + (g % 6)],
      (1 + (g % 4)) || ' servings',
      current_date - (g % 5),
      current_date + (3 - (g % 3)),
      (array['fridge','freezer','counter','fridge'])[1 + (g % 4)],
      (array['fresh','frozen','fresh','eaten'])[1 + (g % 4)],
      '[seed] leftover',
      v_owner
    from generate_series(1, 12) g;
  end if;

  raise notice 'Feature-gap round-3 seed complete for family %.', v_family;
end $$;

-- ==================== seed_feature_gaps_4.sql ====================
-- ============================================================================
-- FamilyOS · SEED — feature-gap coverage (round 4): more user-facing left-nav
-- tables that had no seed rows. Covers: event RSVPs · meal nutrition · trip plans ·
-- departure plans · calendar feeds · driver licenses · rental cars · vehicle
-- inspections · homes · household info · home security events · gift links ·
-- parent approvals.
--
-- Same conventions as seed_feature_gaps_3.sql: family-by-email, every child insert
-- guarded on its parent (to_regclass + parent existence), enum_range for enums,
-- idempotent via '[seed]' markers / "seed once when none exist". PG16-validated.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_owner   uuid;
  v_members uuid[];
  v_kids    uuid[];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select u.id into v_owner from auth.users u where lower(u.email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  select array_agg(id) into v_kids from public.family_members where family_id = v_family and role in ('child','teen');
  if v_members is null then raise notice 'no members'; return; end if;
  if v_kids is null then v_kids := v_members; end if;

  -- ── Event RSVPs (on existing calendar_events; seed once per family) ───────
  if to_regclass('public.event_rsvps') is not null and to_regclass('public.calendar_events') is not null
     and not exists (select 1 from public.event_rsvps where family_id = v_family) then
    insert into public.event_rsvps (event_id, family_id, member_id, status)
    select e.id, v_family, v_members[1 + ((e.rn + m.i) % array_length(v_members,1))],
      (enum_range(null::rsvp_status))[1 + ((e.rn + m.i) % array_length(enum_range(null::rsvp_status),1))]::rsvp_status
    from (select id, (row_number() over (order by starts_at))::int rn from public.calendar_events where family_id = v_family limit 30) e
    cross join (select generate_series(1, array_length(v_members,1)) as i) m
    on conflict do nothing;
  end if;

  -- ── Meal nutrition (12) ──────────────────────────────────────────────────
  if to_regclass('public.meal_nutrition') is not null then
    delete from public.meal_nutrition where family_id = v_family and summary like '[seed]%';
    insert into public.meal_nutrition (family_id, subject_type, subject_id, servings, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, summary, created_by)
    select v_family,
      (array['recipe','meal','week'])[1 + (g % 3)],
      'seed-' || g,
      2 + (g % 4),
      350 + (g % 8) * 90,
      (12 + (g % 20))::numeric, (25 + (g % 40))::numeric, (8 + (g % 18))::numeric,
      (3 + (g % 8))::numeric, (4 + (g % 15))::numeric, (200 + (g % 10) * 80)::numeric,
      '[seed] balanced meal',
      v_owner
    from generate_series(1, 12) g;
  end if;

  -- ── Trip plans (4; seed once) ────────────────────────────────────────────
  if to_regclass('public.trip_plans') is not null
     and not exists (select 1 from public.trip_plans where family_id = v_family and interests = '[seed]') then
    insert into public.trip_plans (family_id, created_by, title, destination, start_date, end_date, members, interests, status, weather_summary)
    select v_family, v_owner,
      (array['Summer in Maui','Ski week at Tahoe','Grandparents in Denver','City break — NYC'])[g],
      (array['Maui, HI','Lake Tahoe, CA','Denver, CO','New York, NY'])[g],
      current_date + (g * 30), current_date + (g * 30 + 6),
      '["You","Sam","Emma","Leo"]'::jsonb, '[seed]',
      'researched', 'Sunny, mid-70s°F'
    from generate_series(1, 4) g;
  end if;

  -- ── Departure plans (4; seed once — event_start is required) ──────────────
  if to_regclass('public.departure_plans') is not null
     and not exists (select 1 from public.departure_plans where family_id = v_family and title like '[seed]%') then
    insert into public.departure_plans (family_id, created_by, title, origin, destination, event_start, prep_minutes, park_minutes, buffer_minutes, drive_seconds, leave_by, weather_summary, status)
    select v_family, v_owner,
      '[seed] ' || (array['Soccer game','Dentist run','Airport drop-off','School play'])[g],
      'Home', (array['City Field','Main St Clinic','SFO','School Auditorium'])[g],
      now() + (g || ' days')::interval + interval '9 hours',
      30, 10, 5, (900 + g * 300),
      now() + (g || ' days')::interval + interval '8 hours',
      'Clear', 'active'
    from generate_series(1, 4) g;
  end if;

  -- ── Calendar feeds (3) ───────────────────────────────────────────────────
  if to_regclass('public.calendar_feeds') is not null then
    delete from public.calendar_feeds where family_id = v_family and name like '[seed]%';
    insert into public.calendar_feeds (family_id, name, url, color, last_status, event_count, last_synced_at, created_by)
    select v_family,
      '[seed] ' || (array['School Calendar','Soccer League','Holidays'])[g],
      'https://example.com/feed' || g || '.ics',
      (array['blue','green','red'])[g],
      'ok', 10 + g * 5, now() - (g || ' hours')::interval, v_owner
    from generate_series(1, 3) g;
  end if;

  -- ── Driver licenses (per adult-ish member; seed once) ────────────────────
  if to_regclass('public.driver_licenses') is not null
     and not exists (select 1 from public.driver_licenses where family_id = v_family and notes like '[seed]%') then
    insert into public.driver_licenses (family_id, member_id, holder_name, license_number, state, license_class, issued_on, expires_on, status, notes, created_by)
    select v_family, m.id, coalesce(m.display_name,'Driver'),
      'DL' || upper(substr(md5(m.id::text),1,7)),
      (array['CA','TX','NY','WA'])[1 + (m.rn % 4)], 'C',
      current_date - interval '3 years', current_date + interval '2 years',
      'active', '[seed] license', v_owner
    from (select id, display_name, (row_number() over ())::int rn from public.family_members where family_id = v_family and role in ('parent','adult','caregiver')) m;
  end if;

  -- ── Rental cars (3; seed once) ───────────────────────────────────────────
  if to_regclass('public.rental_cars') is not null
     and not exists (select 1 from public.rental_cars where family_id = v_family and notes like '[seed]%') then
    insert into public.rental_cars (family_id, company, confirmation_number, pickup_location, dropoff_location, pickup_at, return_at, vehicle_desc, daily_rate, total_cost, status, notes, created_by)
    select v_family,
      (array['Hertz','Enterprise','Avis'])[g],
      'CONF-' || lpad(g::text,6,'0'),
      (array['SFO Airport','Downtown','Airport'])[g], (array['SFO Airport','Downtown','Airport'])[g],
      now() + (g*20 || ' days')::interval, now() + (g*20+5 || ' days')::interval,
      (array['SUV — Toyota RAV4','Sedan — Honda Accord','Minivan — Chrysler Pacifica'])[g],
      (49 + g*10)::numeric, (245 + g*50)::numeric, 'upcoming', '[seed] rental', v_owner
    from generate_series(1, 3) g;
  end if;

  -- ── Vehicle inspections (on vehicles) ────────────────────────────────────
  if to_regclass('public.vehicle_inspections') is not null and to_regclass('public.vehicles') is not null then
    delete from public.vehicle_inspections where family_id = v_family and notes like '[seed]%';
    insert into public.vehicle_inspections (family_id, vehicle_id, inspection_type, station, inspected_on, expires_on, result, notes, created_by)
    select v_family, v.id,
      (array['safety','emissions','both'])[1 + (g % 3)],
      (array['QuickCheck Station','State Inspection','AutoCare'])[1 + (g % 3)],
      current_date - ((g % 12) * 30), current_date + interval '1 year',
      (array['pass','pass','advisory'])[1 + (g % 3)], '[seed] inspection', v_owner
    from public.vehicles v, generate_series(1, 2) as gs(g)
    where v.family_id = v_family;
  end if;

  -- ── Homes (seed once — 1 primary home) ───────────────────────────────────
  if to_regclass('public.homes') is not null
     and not exists (select 1 from public.homes where family_id = v_family and notes like '[seed]%') then
    insert into public.homes (family_id, name, address, home_type, year_built, square_feet, bedrooms, bathrooms, purchase_date, is_primary, notes, created_by)
    values (v_family, 'Main House', '123 Maple Street', 'single_family', 2004, 2200, 4, 2.5, current_date - interval '6 years', true, '[seed] home', v_owner);
  end if;

  -- ── Household info (10) ───────────────────────────────────────────────────
  if to_regclass('public.household_info') is not null then
    delete from public.household_info where family_id = v_family and note like '[seed]%';
    insert into public.household_info (family_id, category, label, value, note, is_sensitive, sort, created_by)
    select v_family,
      (array['account','contact','wifi','emergency','instruction'])[1 + (g % 5)],
      (array['Electric account','Plumber','Wifi network','Emergency contact','Trash day','Gas account','HOA','Alarm code','Pediatrician','Water account'])[g],
      (array['#4471','555-0110','HomeNet','Aunt May 555-0134','Tuesday','#8891','Maple HOA','on the fridge','Dr. Lee','#2213'])[g],
      '[seed] info', (g % 4 = 0), g, v_owner
    from generate_series(1, 10) g;
  end if;

  -- ── Home security events (12) ────────────────────────────────────────────
  if to_regclass('public.home_security_events') is not null then
    delete from public.home_security_events where family_id = v_family and detail like '[seed]%';
    insert into public.home_security_events (family_id, kind, severity, title, detail, occurred_at, resolved, resolved_at, created_by)
    select v_family,
      (array['motion','door','alarm','camera'])[1 + (g % 4)],
      (array['info','warning','critical'])[1 + (g % 3)],
      (array['Front door opened','Motion detected','Alarm armed','Camera offline','Back door unlocked','Package delivered'])[1 + (g % 6)],
      '[seed] security event',
      now() - ((g % 30) || ' days')::interval - ((g % 12) || ' hours')::interval,
      (g % 3 <> 0), case when g % 3 <> 0 then now() - ((g % 30) || ' days')::interval else null end,
      v_owner
    from generate_series(1, 12) g;
  end if;

  -- ── Gift links (on child_wallets; seed once) ─────────────────────────────
  if to_regclass('public.gift_links') is not null and to_regclass('public.child_wallets') is not null
     and not exists (select 1 from public.gift_links where family_id = v_family and message like '[seed]%') then
    insert into public.gift_links (family_id, child_wallet_id, token, occasion, message, is_active, created_by)
    select v_family, w.id,
      encode(gen_random_bytes(12),'hex'),
      (array['birthday','holiday','graduation','just_because'])[1 + ((row_number() over ())::int % 4)],
      '[seed] Send a little something!', true, v_owner
    from public.child_wallets w where w.family_id = v_family;
  end if;

  -- ── Parent approvals (10) ─────────────────────────────────────────────────
  if to_regclass('public.parent_approvals') is not null then
    delete from public.parent_approvals where family_id = v_family and note like '[seed]%';
    insert into public.parent_approvals (family_id, kind, amount_cents, status, requested_by, decided_by, decided_at, note)
    select v_family,
      (array['gift','chore_reward','card_spend','withdrawal'])[1 + (g % 4)],
      (500 + (g % 8) * 500)::bigint,
      (enum_range(null::approval_status))[1 + (g % array_length(enum_range(null::approval_status),1))]::approval_status,
      v_owner,
      case when g % 2 = 0 then v_owner else null end,
      case when g % 2 = 0 then now() - ((g % 20) || ' days')::interval else null end,
      '[seed] approval'
    from generate_series(1, 10) g;
  end if;

  raise notice 'Feature-gap round-4 seed complete for family %.', v_family;
end $$;

-- ==================== seed_feature_gaps_5.sql ====================
-- ============================================================================
-- FamilyOS · SEED — feature-gap coverage (round 5): the last user-facing left-nav
-- tables with no seed rows. Covers: Loyalty (account + transactions + redemptions) ·
-- Weather saved locations · wallet Pay handles · Assistant chat history
-- (conversations + messages) · Concierge sessions · Opportunities.
--
-- Same conventions as rounds 3/4: family-by-email, to_regclass + parent guards,
-- enum_range for enums, idempotent via '[seed]' markers / "seed once when none".
-- PG16-validated. Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_owner   uuid;
  v_members uuid[];
  v_conv    uuid;
  v_ci      int;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select u.id into v_owner from auth.users u where lower(u.email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  -- ── Loyalty account (1, upsert) + transactions (20) + redemptions (6) ────
  if to_regclass('public.loyalty_accounts') is not null then
    insert into public.loyalty_accounts (family_id, points_balance, lifetime_points, tier)
    values (v_family, 1250, 4300, 'silver')
    on conflict (family_id) do update set points_balance = excluded.points_balance;
  end if;
  if to_regclass('public.loyalty_transactions') is not null then
    delete from public.loyalty_transactions where family_id = v_family and reason like '[seed]%';
    insert into public.loyalty_transactions (family_id, points, kind, reason, source, balance_after, created_by, created_at)
    select v_family,
      case when g % 4 = 0 then -(50 + (g % 5) * 25) else (25 + (g % 6) * 20) end,
      case when g % 4 = 0 then 'redeem' else 'earn' end,
      '[seed] ' || (array['Welcome bonus','Referral reward','Left a review','Monthly bonus','Redeemed a perk','Purchase points'])[1 + (g % 6)],
      (array['signup','referral','review','manual','redemption','purchase'])[1 + (g % 6)],
      1000 + g * 15,
      v_owner,
      now() - ((g % 60) || ' days')::interval
    from generate_series(1, 20) g;
  end if;
  if to_regclass('public.loyalty_redemptions') is not null then
    delete from public.loyalty_redemptions where family_id = v_family and notes like '[seed]%';
    insert into public.loyalty_redemptions (family_id, reward_name, cost_points, status, code, notes, created_by, created_at)
    select v_family,
      (array['$5 gift card','Free month','Premium sticker pack','Movie rental','Coffee voucher','Charity donation'])[g],
      100 + g * 50,
      (array['pending','fulfilled','fulfilled','pending','fulfilled','cancelled'])[g],
      'RDM-' || lpad(g::text, 5, '0'),
      '[seed] redemption', v_owner,
      now() - ((g % 40) || ' days')::interval
    from generate_series(1, 6) g;
  end if;

  -- ── Weather saved locations (seed once — Home + 2 others) ────────────────
  if to_regclass('public.weather_locations') is not null
     and not exists (select 1 from public.weather_locations where family_id = v_family) then
    insert into public.weather_locations (family_id, name, admin1, country, latitude, longitude, is_default, sort_order, created_by)
    values
      (v_family, 'Home', 'California', 'US', 37.7749, -122.4194, true, 0, v_owner),
      (v_family, 'Grandma''s', 'Colorado', 'US', 39.7392, -104.9903, false, 1, v_owner),
      (v_family, 'Beach House', 'California', 'US', 36.9741, -122.0308, false, 2, v_owner);
  end if;

  -- ── Wallet pay handles (family-level + per child wallet; seed once) ───────
  if to_regclass('public.pay_handles') is not null
     and not exists (select 1 from public.pay_handles where family_id = v_family) then
    insert into public.pay_handles (family_id, child_wallet_id, handle, is_active, created_by)
    values (v_family, null, 'the_' || substr(md5(v_family::text), 1, 6) || '_family', true, v_owner);
    if to_regclass('public.child_wallets') is not null then
      insert into public.pay_handles (family_id, child_wallet_id, handle, is_active, created_by)
      select v_family, w.id, 'kid_' || substr(md5(w.id::text), 1, 8), true, v_owner
      from public.child_wallets w where w.family_id = v_family
      on conflict do nothing;
    end if;
  end if;

  -- ── Assistant chat history (2 conversations × a few messages; seed once) ─
  if to_regclass('public.ai_conversations') is not null and to_regclass('public.ai_messages') is not null
     and not exists (select 1 from public.ai_conversations where family_id = v_family and title like '[seed]%') then
    for v_ci in 1..2 loop
      v_conv := gen_random_uuid();
      insert into public.ai_conversations (id, family_id, user_id, title, provider, model)
      values (v_conv, v_family, v_owner, '[seed] ' || (array['Plan the week','Dinner ideas'])[v_ci], 'anthropic', 'claude-sonnet-5');
      insert into public.ai_messages (family_id, conversation_id, role, content, created_at)
      select v_family, v_conv,
        (enum_range(null::public.ai_role))[1 + (i % 2)]::public.ai_role,
        case when i % 2 = 1 then 'Can you help me organize this week?' else 'Absolutely — here is a plan for your family.' end,
        now() - ((6 - i) || ' hours')::interval
      from generate_series(1, 4) i;
    end loop;
  end if;

  -- ── Concierge sessions (5) ────────────────────────────────────────────────
  if to_regclass('public.concierge_sessions') is not null then
    delete from public.concierge_sessions where family_id = v_family and notes like '[seed]%';
    insert into public.concierge_sessions (family_id, created_by, title, kind, status, notes, ai_summary, created_at)
    select v_family, v_owner,
      (array['Plan Emma''s birthday','Book summer camp','Weekend getaway','Find a babysitter','Organize the move'])[g],
      (array['party','activity','travel','service','general'])[g],
      (array['planning','booked','confirmed','completed','planning'])[g],
      '[seed] concierge request',
      'A short AI summary of the request and next steps.',
      now() - ((g % 20) || ' days')::interval
    from generate_series(1, 5) g;
  end if;

  -- ── Opportunities (10) ────────────────────────────────────────────────────
  if to_regclass('public.opportunities') is not null then
    delete from public.opportunities where family_id = v_family and notes like '[seed]%';
    insert into public.opportunities (family_id, member_id, title, category, url, cost, opens_at, deadline, status, notes, created_by)
    select v_family,
      v_members[1 + (g % array_length(v_members,1))],
      (array['Summer coding camp','Soccer league','Art class','Robotics club','Swim lessons','Scout troop','Music lessons','Chess club','Drama camp','Science fair'])[g],
      (array['camp','sports','class','activity','class','activity','class','activity','camp','school'])[g],
      'https://example.com/opp/' || g,
      (50 + g * 25)::numeric,
      current_date + (g * 5), current_date + (g * 5 + 20),
      (enum_range(null::opportunity_status))[1 + (g % array_length(enum_range(null::opportunity_status),1))]::opportunity_status,
      '[seed] opportunity', v_owner
    from generate_series(1, 10) g;
  end if;

  raise notice 'Feature-gap round-5 seed complete for family %.', v_family;
end $$;


-- ==================== seed_concierge_calls.sql ====================
-- ============================================================================
-- FamilyOS · SEED — AI Concierge Calls (500 records).
-- Fills concierge_calls so the outbound "Bubaly calls for you" module can be
-- tested at volume: every task_kind × category, the full status lifecycle
-- (draft/queued/calling/completed/failed/action_needed/cancelled), an
-- AI-generated brief on every row, and outcomes/transcripts on completed calls.
-- Idempotent: clears its own '[seed:call]' rows first, then inserts. Resolves
-- the family by email (falls back to the oldest family).
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0165 applied.)
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_member  uuid;
  v_user    uuid;
  n int := 500;
  kinds     text[] := array['book','reschedule','cancel','confirm','inquire','follow_up','other'];
  cats      text[] := array['medical','dental','school','restaurant','service','utility','retail','government','other'];
  names     text[] := array[
    'Bright Smiles Dental','Dr. Alvarez Pediatrics','Lincoln Elementary Office','Nonna''s Trattoria',
    'GreenLeaf Lawn Care','City Power & Light','The Bike Shop','County Passport Office',
    'Sunrise Family Clinic','Ace Plumbing','Riverside Vet','Summit Orthodontics'];
  goals     text[] := array[
    'Book a cleaning for two kids on the same afternoon',
    'Reschedule Thursday''s appointment to next week',
    'Cancel the standing Friday slot and stop billing',
    'Confirm the reservation for 6 at 7pm Saturday',
    'Ask whether they take our insurance and the copay',
    'Follow up on the refund promised two weeks ago',
    'Get the earliest available new-patient opening'];
  priorities text[] := array['low','normal','normal','high','urgent'];
  -- status mix: mostly completed, with a realistic spread of the lifecycle.
  statuses   text[] := array[
    'completed','completed','completed','completed','completed','completed',
    'queued','queued','action_needed','failed','draft','cancelled','calling'];
  outcomes   text[] := array[
    'Booked. Tue 3:40pm, both kids back-to-back. Confirmation texted to the family.',
    'Moved to next Wednesday 10:15am. They''ll send a reminder the day before.',
    'Cancelled and confirmed no further charges. Final statement mailed.',
    'Reservation confirmed for 6 at 7:00pm under the family name.',
    'They''re in-network; copay is $25. New patients need the intake form first.',
    'Refund was reissued today; 3–5 business days to the card on file.'];
  transcripts text[] := array[
    'Reached the front desk, gave both children''s names and DOBs, took the first same-day pair.',
    'Spoke to scheduling; original slot released, new one held under the family name.',
    'Confirmed account number, requested cancellation, got a confirmation code.',
    'Confirmed party size, time, and seating preference; noted a nut allergy.',
    'Verified plan and member ID; asked about copay and new-patient steps.',
    'Referenced the ticket number; agent located it and pushed the refund through.'];
  ki int; ci int; si int; st text;
  is_done boolean;
begin
  if to_regclass('public.concierge_calls') is null then
    raise notice 'concierge_calls not present — apply migration 0165 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select fm.id, fm.user_id into v_member, v_user
  from public.family_members fm where fm.family_id = v_family
  order by fm.created_at limit 1;

  delete from public.concierge_calls where family_id = v_family and goal like '%[seed:call]%';

  for i in 0..(n - 1) loop
    ki := 1 + (i % 7);
    ci := 1 + (i % 9);
    si := 1 + (i % array_length(statuses, 1));
    st := statuses[si];
    is_done := st = 'completed';

    insert into public.concierge_calls
      (family_id, requested_by, task_kind, callee_name, callee_phone, callee_category,
       goal, details, brief, status, priority, scheduled_for,
       outcome, transcript_summary, duration_seconds, attempts, provider_ref,
       completed_at, created_by, created_at)
    values (
      v_family, v_member, kinds[ki],
      names[1 + (i % array_length(names, 1))],
      -- ~1 in 6 requests has no number yet (parks as draft-style intent).
      case when i % 6 = 5 then null else '+1206555' || lpad((1000 + (i % 9000))::text, 4, '0') end,
      cats[ci],
      goals[ki] || ' [seed:call]',
      jsonb_build_object(
        'memberName', (array['Ava','Liam','Noah','Mia','the family'])[1 + (i % 5)],
        'preferredTimes', (array['weekday afternoons','Saturday morning','after 5pm','any time next week'])[1 + (i % 4)],
        'referenceNumber', case when i % 3 = 0 then 'REF-' || (10000 + i)::text else null end
      ),
      jsonb_build_object(
        'opening', 'Hi, I''m calling on behalf of the family regarding ' || goals[ki] || '.',
        'keyPoints', jsonb_build_array(
          'Be polite and concise.',
          'State the goal: ' || goals[ki] || '.',
          'Confirm details before agreeing to anything.'),
        'questions', jsonb_build_array(
          'What is the earliest available option?',
          'Is there a confirmation number?'),
        'successCriteria', 'The goal is met and a confirmation is captured.',
        'fallback', 'If unavailable, ask for the next opening and a callback number.'),
      st,
      priorities[1 + (i % array_length(priorities, 1))],
      case when st in ('queued','calling') then now() + ((i % 72) || ' hours')::interval else null end,
      case when is_done then outcomes[1 + (i % array_length(outcomes, 1))] else null end,
      case when is_done then transcripts[1 + (i % array_length(transcripts, 1))] else null end,
      case when is_done then 45 + (i % 300) else null end,
      case when st in ('completed','failed','calling') then 1 + (i % 3) else 0 end,
      case when is_done then 'seed-' || substr(md5(i::text), 1, 12) else null end,
      case when is_done then now() - ((i % 240) || ' hours')::interval else null end,
      v_user,
      now() - ((i) || ' hours')::interval
    );
  end loop;

  raise notice 'Concierge calls seeded % rows for family %', n, v_family;
end $$;

-- Verify:
--   select count(*) from concierge_calls where goal like '%[seed:call]%';        -- 500
--   select status, count(*) from concierge_calls group by status order by 2 desc;
--   select task_kind, count(*) from concierge_calls group by task_kind order by 2 desc;

-- ============================================================================
-- ==================== seed_family_apps.sql ====================
-- ============================================================================
-- ============================================================================
-- SEED — Family App Store catalog (family_apps, 500 rows).
-- Reference data (no family scoping). Idempotent: seed rows use slug 'seed-app-%'
-- and are deleted + reinserted. Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  n int := 500;
  cats  text[] := array['calendar','meals','chores','school','sports','health','finance','travel','safety','home','ai_agents','other'];
  emos  text[] := array['🗓️','🍽️','🧹','🎒','⚽','🩺','💳','✈️','🛟','🏠','🤖','✨'];
  adjs  text[] := array['Smart','Auto','Family','Daily','Instant','AI','Pocket','Super','Bright','Calm','Swift','Prime'];
  nouns text[] := array['Planner','Assistant','Tracker','Coach','Organizer','Butler','Concierge','Radar','Copilot','Hub','Genie','Companion'];
  caps  text[] := array['reads_email','books_appointments','fills_forms','sends_reminders','summarizes','negotiates','predicts','auto_schedules','tracks_spend','answers_calls'];
  pubs  text[] := array['Bubaly','Bubaly Labs','Family Collective','OpenFamily','Hearth AI'];
begin
  delete from public.family_apps where slug like 'seed-app-%';

  insert into public.family_apps
    (slug, name, tagline, description, category, emoji, publisher, capabilities, is_official, is_ai, rating, install_count, status, sort_order)
  select
    'seed-app-' || g.i,
    adjs[1 + (g.i % array_length(adjs,1))] || ' ' || nouns[1 + ((g.i/3) % array_length(nouns,1))] || ' #' || g.i,
    'AI ' || nouns[1 + (g.i % array_length(nouns,1))] || ' for ' || cats[1 + (g.i % array_length(cats,1))] || ' — hands-free.',
    'A world-class AI extension that plugs into your family workflows to handle ' ||
      cats[1 + (g.i % array_length(cats,1))] || ' automatically. Installs in one tap, mobile-first.',
    cats[1 + (g.i % array_length(cats,1))],
    emos[1 + (g.i % array_length(emos,1))],
    pubs[1 + (g.i % array_length(pubs,1))],
    -- 2–4 capabilities, deterministic per row
    (select array_agg(distinct caps[1 + ((g.i + k) % array_length(caps,1))]) from generate_series(0, 2 + (g.i % 3)) k),
    (g.i % 4 = 0),                                   -- ~25% official
    true,
    round((35 + (g.i % 16)) / 10.0, 1),              -- 3.5–5.0
    (g.i * 37) % 5000,                               -- pseudo install counts
    (array['published','published','published','beta','coming_soon'])[1 + (g.i % 5)],
    g.i % 100
  from generate_series(1, n) as g(i);

  raise notice 'Family App Store seeded % catalog apps', n;
end $$;


-- ==================== seed_workload.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Workload snapshots (500 records).
-- Fills workload_snapshots so Workload Balance analytics can be tested at
-- volume: up to 5 members × 100 ISO weeks of history, with a realistic drift
-- (one member consistently heavier, slowly rebalancing toward fair).
-- Idempotent: upserts on (family_id, member_id, week_start) with note tag
-- '[seed:workload]' and clears its own rows first. Resolves family by email.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0166 applied.)
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  m_count   int;
  n_weeks   int;
  total     int := 0;
  w         int;
  mi        int;
  base_pct  numeric;
  drift     numeric;
  pct       numeric;
  mins      int;
begin
  if to_regclass('public.workload_snapshots') is null then
    raise notice 'workload_snapshots not present — apply migration 0166 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select array_agg(id) into v_members from (
    select id from public.family_members where family_id = v_family and is_active
    order by created_at limit 5
  ) s;
  m_count := coalesce(array_length(v_members, 1), 0);
  if m_count = 0 then raise exception 'No members in family %.', v_family; end if;

  n_weeks := ceil(500.0 / m_count)::int;   -- e.g. 5 members → 100 weeks

  delete from public.workload_snapshots where family_id = v_family and note = '[seed:workload]';

  for w in 0..(n_weeks - 1) loop
    for mi in 1..m_count loop
      exit when total >= 500;
      -- Member 1 starts heavy (~55%) and drifts toward fair; others share the rest.
      drift := least(w * 0.15, 15);   -- older weeks were more unbalanced
      if mi = 1 then
        base_pct := (100.0 / m_count) + 20 - drift;
      else
        base_pct := (100.0 - ((100.0 / m_count) + 20 - drift)) / (m_count - 1);
      end if;
      pct := greatest(2, round(base_pct + ((w * mi) % 5) - 2, 1));
      mins := (pct * 6)::int + ((w + mi) % 30);

      insert into public.workload_snapshots
        (family_id, member_id, week_start,
         chore_minutes, chore_count, task_count, event_count, invisible_count,
         load_score, share_pct, note, created_at)
      values (
        v_family, v_members[mi],
        (date_trunc('week', current_date)::date - (w * 7)),
        mins, 2 + ((w + mi) % 8), (w + mi) % 6, (w * mi) % 5, (w + mi) % 4,
        least(100, (pct * 1.6)::int), least(100, pct), '[seed:workload]',
        now() - (w || ' weeks')::interval
      )
      on conflict (family_id, member_id, week_start) do update set
        chore_minutes = excluded.chore_minutes,
        share_pct     = excluded.share_pct,
        load_score    = excluded.load_score,
        note          = excluded.note;
      total := total + 1;
    end loop;
  end loop;

  raise notice 'Workload snapshots seeded % rows (% members × % weeks) for family %',
    total, m_count, n_weeks, v_family;
end $$;

-- Verify:
--   select count(*) from workload_snapshots where note = '[seed:workload]';   -- 500
--   select member_id, round(avg(share_pct),1) from workload_snapshots group by member_id;


-- ==================== seed_independence.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Independence milestones (500 records).
-- Fills independence_milestones so the growth-ladder module can be tested at
-- volume: every domain × age band across the family's kids (falls back to any
-- members if no child/teen), realistic status mix (achieved with evidence +
-- dates, in_progress, suggested, skipped). Unique (family,member,domain,title)
-- is satisfied by suffixing generated titles.
-- Idempotent: clears its own '[seed:indep]' rows first. Resolves family by email.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0167 applied.)
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_kids    uuid[];
  v_user    uuid;
  k_count   int;
  n int := 500;
  domains  text[] := array['chores','money','safety','self_care','school','social'];
  bands    text[] := array['4-6','7-9','10-12','13-15','16-18'];
  titles   text[] := array[
    'Makes their bed daily','Helps with dishes','Saves for a goal','Sticks to a small budget',
    'Crosses the street safely','Basic first aid','Showers independently','Packs for a trip',
    'Tracks assignments','Emails a teacher','Orders their own food','Handles losing a game'];
  statuses text[] := array['achieved','achieved','achieved','in_progress','in_progress','suggested','skipped'];
  evid     text[] := array[
    'Did it every day for two weeks','Showed us without being asked','Teacher confirmed it',
    'Nailed it on the family trip','Handled it solo while we watched from afar'];
  st text; di int; bi int;
begin
  if to_regclass('public.independence_milestones') is null then
    raise notice 'independence_milestones not present — apply migration 0167 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select array_agg(id) into v_kids from (
    select id from public.family_members
    where family_id = v_family and is_active and role in ('child','teen')
    order by created_at limit 6
  ) s;
  if v_kids is null then
    select array_agg(id) into v_kids from (
      select id from public.family_members where family_id = v_family and is_active
      order by created_at limit 6
    ) s;
  end if;
  k_count := coalesce(array_length(v_kids, 1), 0);
  if k_count = 0 then raise exception 'No members in family %.', v_family; end if;

  select user_id into v_user from public.family_members
  where family_id = v_family and user_id is not null order by created_at limit 1;

  delete from public.independence_milestones
  where family_id = v_family and description like '%[seed:indep]%';

  insert into public.independence_milestones
    (family_id, member_id, domain, title, description, age_band, status,
     points, evidence, achieved_at, created_by, created_at)
  select
    v_family,
    v_kids[1 + (g.i % k_count)],
    domains[1 + (g.i % 6)],
    titles[1 + (g.i % array_length(titles, 1))] || ' #' || (g.i / array_length(titles, 1))::text,
    'Ladder skill for growing independence. [seed:indep]',
    bands[1 + (g.i % 5)],
    statuses[1 + (g.i % array_length(statuses, 1))],
    5 + 5 * (g.i % 5),
    case when statuses[1 + (g.i % array_length(statuses, 1))] = 'achieved'
         then evid[1 + (g.i % array_length(evid, 1))] else null end,
    case when statuses[1 + (g.i % array_length(statuses, 1))] = 'achieved'
         then now() - ((g.i % 365) || ' days')::interval else null end,
    v_user,
    now() - (g.i || ' hours')::interval
  from generate_series(0, n - 1) g(i)
  on conflict (family_id, member_id, domain, title) do nothing;

  raise notice 'Independence milestones seeded % rows across % kids for family %', n, k_count, v_family;
end $$;

-- Verify:
--   select count(*) from independence_milestones where description like '%[seed:indep]%';  -- 500
--   select status, count(*) from independence_milestones group by status order by 2 desc;
--   select domain, age_band, count(*) from independence_milestones group by 1,2 order by 1,2;
