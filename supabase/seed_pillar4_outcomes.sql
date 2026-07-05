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
  select id into v_todo_list from public.todo_lists where family_id = v_family and archived_at is null order by created_at limit 1;
  if v_todo_list is null then insert into public.todo_lists (family_id, name) values (v_family, 'To-Do') returning id into v_todo_list; end if;
  select id into v_groc_list from public.grocery_lists where family_id = v_family and is_archived = false order by created_at limit 1;
  if v_groc_list is null then insert into public.grocery_lists (family_id, name) values (v_family, 'Shopping List') returning id into v_groc_list; end if;

  -- Clean prior seed rows.
  delete from public.calendar_events where family_id = v_family and description like '%[seed:p4]%';
  delete from public.todo_items      where family_id = v_family and notes like '%[seed:p4]%';
  delete from public.grocery_items   where family_id = v_family and category = 'seed-p4';

  -- 200 events: 100 today, 100 across the next 30 days.
  insert into public.calendar_events (family_id, title, description, starts_at, ends_at, all_day, assignee_id)
  select v_family, 'Event #' || g.i, '[seed:p4]',
    case when g.i <= 100 then current_date::timestamp + time '08:00' + (g.i * interval '7 min')
         else (current_date + (1 + floor(random()*30))::int)::timestamp + time '09:00' + (floor(random()*8)*interval '1 hour') end,
    null, false, v_members[1 + floor(random()*array_length(v_members,1))::int]
  from generate_series(1, 200) as g(i);

  -- 150 overdue to-dos (due before today, not done).
  insert into public.todo_items (family_id, list_id, title, notes, is_done, priority, due_date)
  select v_family, v_todo_list,
    (array['Pay bill','Return package','Call plumber','RSVP','Renew pass','Book appointment','Fix bike','Water plants'])[1 + floor(random()*8)::int] || ' #' || g.i,
    '[seed:p4]', false,
    (array['low','medium','high'])[1 + floor(random()*3)::int],
    (current_date - (1 + floor(random()*20))::int)
  from generate_series(1, 150) as g(i);

  -- 150 open grocery items (category tag = idempotency marker).
  insert into public.grocery_items (family_id, list_id, name, category, is_checked)
  select v_family, v_groc_list,
    (array['Milk','Eggs','Bread','Apples','Chicken','Rice','Pasta','Cheese','Bananas','Coffee','Yogurt','Spinach'])[1 + floor(random()*12)::int] || ' #' || g.i,
    'seed-p4', false
  from generate_series(1, 150) as g(i);

  -- A birthday within the next 2 weeks so the "Celebrate" badge fires.
  update public.family_members
    set birthday = (current_date + 6)
    where id = v_members[1];

  raise notice 'Pillar #4 (outcomes) seeded 500 records for family %', v_family;
end $$;
