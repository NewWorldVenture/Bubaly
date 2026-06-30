-- ============================================================================
-- seed_tasks_one_family.sql — 500 todo_items for ONE family (The Kramer Family).
-- ----------------------------------------------------------------------------
-- WHAT IT DOES
--   1. Re-asserts the family-scoped RLS policies on todo_lists/todo_items
--      (so authenticated members can actually read the rows — same drift fix
--      as migration 0106). Safe/idempotent.
--   2. Ensures 8 task categories (todo_lists) exist for the family.
--   3. Seeds 500 todo_items across those categories with a realistic spread of
--      priorities, assignees (incl. the signed-in user), completed/active, and
--      due dates (overdue / today / this-week / upcoming / far-future / none)
--      so every section of the Tasks page and the summary donut render.
--
-- TARGET FAMILY: 92298eb2-1a9e-4bdc-9361-677b6c01b499  (active fam of
--   newworldventurellc@gmail.com). Change v_fam / v_email below if needed.
--
-- IDEMPOTENT: seeded rows are tagged 'seed:tasks' and deleted before re-insert
--   (within this family only); categories are created only if missing.
--
-- HOW TO RUN: paste into the Supabase SQL editor and Run, then hard-refresh
--   /dashboard/todos.
-- ============================================================================

-- 1) RLS repair (so the page can READ the seeded rows) ------------------------
do $$
declare t text;
begin
  foreach t in array array['todo_lists','todo_items'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

-- 2) + 3) Categories and 500 tasks -------------------------------------------
do $$
declare
  v_fam   uuid := '92298eb2-1a9e-4bdc-9361-677b6c01b499';
  v_email text := 'newworldventurellc@gmail.com';
  v_uid   uuid;
  v_self  uuid;
  v_members uuid[];
  v_lists uuid[] := '{}';
  v_listid uuid;  tmp uuid;
  v_cat int;  v_title text;  v_notes text;  v_prio text;
  v_due date;  v_done boolean;  v_assignee uuid;  v_creator uuid;  v_completed timestamptz;
  i int;  seeded int := 0;

  cat_names  text[] := ARRAY['School','Finances','Shopping','Chores','Activities','Personal','Family','Health'];
  cat_icons  text[] := ARRAY['📚','💰','🛒','🧹','⚽','🎯','👪','💊'];
  cat_colors text[] := ARRAY['blue','amber','green','teal','rose','violet','rose','green'];
  prios      text[] := ARRAY['low','medium','medium','high','urgent','medium','high','low','medium','urgent'];

  t_school   text[] := ARRAY['Finish science project','Math homework','Read 20 minutes','Book report','Study for spelling test','Sign permission slip','Parent-teacher conference','Pack library books','Practice times tables','Sign reading log'];
  t_finance  text[] := ARRAY['Pay electricity bill','Review monthly budget','Pay credit card','Transfer to savings','Renew car insurance','File receipts','Pay water bill','Update budget spreadsheet','Cancel unused subscription','Schedule mortgage payment'];
  t_shopping text[] := ARRAY['Grocery shopping','Buy birthday gift','Order printer ink','Pick up dry cleaning','Buy school supplies','Replace air filter','Order new shoes','Buy dog food','Restock pantry','Get fresh flowers'];
  t_chores   text[] := ARRAY['Take out the trash','Do the laundry','Vacuum living room','Clean the bathroom','Mow the lawn','Wash the car','Empty the dishwasher','Change bed sheets','Water the plants','Organize the garage'];
  t_activity text[] := ARRAY['Soccer practice','Soccer game vs. Westview','Piano lesson','Swim class','Karate belt test','Dance recital rehearsal','Scout meeting','Basketball tryouts','Art class','Chess club'];
  t_personal text[] := ARRAY['Morning workout','Call Grandma Mary','Write journal entry','Meditate 10 minutes','Plan weekend getaway','Read a chapter','Schedule haircut','Reply to emails','Walk the dog','Stretch routine'];
  t_family   text[] := ARRAY['Plan family movie night','Schedule family photos','Organize game night','Family dinner prep','Visit the grandparents','Plan birthday party','Sync the family calendar','Weekend hike','Plan a day trip','Write thank-you cards'];
  t_health   text[] := ARRAY['Dentist appointment','Annual physical','Refill prescription','Eye exam','Schedule flu shot','Take vitamins','Drink more water','Therapy session','Book orthodontist','Take morning meds'];
begin
  if not exists (select 1 from public.families where id = v_fam) then
    raise exception 'Family % not found', v_fam;
  end if;

  select id into v_uid  from auth.users where lower(email) = lower(v_email) limit 1;
  select id into v_self from public.family_members where family_id = v_fam and user_id = v_uid and is_active limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_fam and is_active;

  -- Ensure the 8 categories exist; collect their ids in order.
  for i in 1..array_length(cat_names,1) loop
    select id into tmp from public.todo_lists
      where family_id = v_fam and name = cat_names[i] and archived_at is null limit 1;
    if tmp is null then
      insert into public.todo_lists (family_id, name, icon, color, is_shared, sort_order)
      values (v_fam, cat_names[i], cat_icons[i], cat_colors[i], true, i)
      returning id into tmp;
    end if;
    v_lists := array_append(v_lists, tmp);
  end loop;

  -- Clean previous seeded tasks (this family only).
  delete from public.todo_items where family_id = v_fam and 'seed:tasks' = any(tags);

  for i in 1..500 loop
    v_cat    := 1 + (i % 8);
    v_listid := v_lists[v_cat];
    v_title  := case v_cat
      when 1 then t_school  [1 + (i % array_length(t_school,1))]
      when 2 then t_finance [1 + (i % array_length(t_finance,1))]
      when 3 then t_shopping[1 + (i % array_length(t_shopping,1))]
      when 4 then t_chores  [1 + (i % array_length(t_chores,1))]
      when 5 then t_activity[1 + (i % array_length(t_activity,1))]
      when 6 then t_personal[1 + (i % array_length(t_personal,1))]
      when 7 then t_family  [1 + (i % array_length(t_family,1))]
      else        t_health  [1 + (i % array_length(t_health,1))]
    end;
    v_prio := prios[1 + (i % array_length(prios,1))];

    -- Due-date spread.
    case (i % 10)
      when 0,1 then v_due := current_date - (1 + (i % 21));     -- overdue
      when 2   then v_due := current_date;                      -- today
      when 3,4 then v_due := current_date + (1 + (i % 6));      -- this week
      when 5,6,7 then v_due := current_date + (7 + (i % 53));   -- upcoming
      when 8   then v_due := null;                              -- no due date
      else        v_due := current_date + (60 + (i % 120));     -- far future
    end case;

    -- ~20% completed (give them a past due date + completed_at).
    v_done := (i % 5 = 0);
    if v_done then
      v_completed := now() - ((i % 30) * interval '1 day');
      if v_due is null or v_due > current_date then v_due := current_date - (1 + (i % 14)); end if;
    else
      v_completed := null;
    end if;

    -- Creator: ~40% the signed-in user (powers "My Tasks"), else a member.
    if v_self is not null and (i % 5) < 2 then v_creator := v_self;
    elsif v_members is not null then v_creator := v_members[1 + (i % array_length(v_members,1))];
    else v_creator := null; end if;

    -- Assignee: ~30% you, ~40% another member, ~30% unassigned.
    case (i % 10)
      when 0,1,2 then v_assignee := v_self;
      when 3,4,5,6 then v_assignee := case when v_members is not null
                                           then v_members[1 + ((i + 3) % array_length(v_members,1))] else null end;
      else v_assignee := null;
    end case;

    v_notes := case (i % 3) when 0 then 'Don''t forget to follow up.' when 1 then null else 'Added during weekly planning.' end;

    insert into public.todo_items
      (family_id, list_id, created_by, assigned_to_id, title, notes, is_done, priority, due_date, tags, sort_order, completed_at)
    values (v_fam, v_listid, v_creator, v_assignee, v_title, v_notes, v_done, v_prio, v_due, array['seed:tasks'], i, v_completed);
    seeded := seeded + 1;
  end loop;

  raise notice 'Seeded % todo_items across % categories for family %.', seeded, array_length(v_lists,1), v_fam;
end $$;

-- 4) Verify the spread -------------------------------------------------------
select
  count(*)                                                                              as total,
  count(*) filter (where not is_done and due_date < current_date)                       as overdue,
  count(*) filter (where not is_done and due_date = current_date)                       as today,
  count(*) filter (where not is_done and due_date > current_date and due_date <= current_date + 7) as this_week,
  count(*) filter (where not is_done and due_date is null)                              as no_due_date,
  count(*) filter (where is_done)                                                       as completed
from public.todo_items
where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and 'seed:tasks' = any(tags);
