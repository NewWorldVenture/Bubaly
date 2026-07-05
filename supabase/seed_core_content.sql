-- ============================================================================
-- FamilyOS · SEED — Core content (500 records each) for the main family hubs.
-- Fills the everyday surfaces so the app can be tested at volume: Calendar,
-- To-Dos, Groceries, Notes, Photos, Journal, Habits. Idempotent via '[seed:core]'
-- / 'seed-core' markers (never clobbers real data). Get-or-creates the lists.
--
-- RESILIENT: every section is guarded with to_regclass(), so if a table is not
-- yet present in this database (migrations not fully applied), that section is
-- skipped instead of aborting the whole run. It seeds whatever exists today.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email     text := 'newworldventurellc@gmail.com';
  v_family    uuid;
  v_members   uuid[];
  v_todo_list uuid;
  v_groc_list uuid;
  v_skipped   text := '';
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

  -- Calendar — 500 events across ±30 days.
  if to_regclass('public.calendar_events') is not null then
    delete from public.calendar_events where family_id = v_family and description like '%[seed:core]%';
    insert into public.calendar_events (family_id, title, description, starts_at, ends_at, all_day, assignee_id)
    select v_family, 'Event #' || g.i, '[seed:core]',
      (current_date + (floor(random()*60) - 30)::int)::timestamp + time '09:00' + (floor(random()*9)*interval '1 hour'),
      null, false, v_members[1 + floor(random()*array_length(v_members,1))::int]
    from generate_series(1, n) as g(i);
  else v_skipped := v_skipped || 'calendar_events '; end if;

  -- To-Dos — 500 (needs todo_lists + todo_items).
  if to_regclass('public.todo_lists') is not null and to_regclass('public.todo_items') is not null then
    select id into v_todo_list from public.todo_lists where family_id = v_family and archived_at is null order by created_at limit 1;
    if v_todo_list is null then insert into public.todo_lists (family_id, name) values (v_family, 'To-Do') returning id into v_todo_list; end if;
    delete from public.todo_items where family_id = v_family and notes like '%[seed:core]%';
    insert into public.todo_items (family_id, list_id, title, notes, is_done, priority, due_date)
    select v_family, v_todo_list, 'Task #' || g.i, '[seed:core]',
      (g.i % 4 = 0),
      (array['low','medium','high'])[1 + (g.i % 3)],
      (current_date + (floor(random()*40) - 20)::int)
    from generate_series(1, n) as g(i);
  else v_skipped := v_skipped || 'todo_items '; end if;

  -- Groceries — 500 open items (needs grocery_lists + grocery_items).
  if to_regclass('public.grocery_lists') is not null and to_regclass('public.grocery_items') is not null then
    select id into v_groc_list from public.grocery_lists where family_id = v_family and is_archived = false order by created_at limit 1;
    if v_groc_list is null then insert into public.grocery_lists (family_id, name) values (v_family, 'Shopping List') returning id into v_groc_list; end if;
    delete from public.grocery_items where family_id = v_family and category = 'seed-core';
    insert into public.grocery_items (family_id, list_id, name, category, is_checked)
    select v_family, v_groc_list,
      (array['Milk','Eggs','Bread','Apples','Chicken','Rice','Pasta','Cheese','Bananas','Coffee'])[1 + (g.i % 10)] || ' #' || g.i,
      'seed-core', (g.i % 6 = 0)
    from generate_series(1, n) as g(i);
  else v_skipped := v_skipped || 'grocery_items '; end if;

  -- Notes — 500.
  if to_regclass('public.notes') is not null then
    delete from public.notes where family_id = v_family and body like '%[seed:core]%';
    insert into public.notes (family_id, title, body, is_pinned, created_by)
    select v_family, 'Note #' || g.i, 'Sample note content #' || g.i || ' [seed:core]', (g.i % 25 = 0), null
    from generate_series(1, n) as g(i);
  else v_skipped := v_skipped || 'notes '; end if;

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
  else v_skipped := v_skipped || 'family_photos '; end if;

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
  else v_skipped := v_skipped || 'journal_entries '; end if;

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
  else v_skipped := v_skipped || 'habits '; end if;

  if length(v_skipped) > 0 then
    raise notice 'Core content seeded (500 each) for family %. SKIPPED (table not in this DB — apply migrations): %', v_family, v_skipped;
  else
    raise notice 'Core content seeded (500 each) for family %', v_family;
  end if;
end $$;
