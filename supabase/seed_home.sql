-- ============================================================
-- FamilyOS :: seed_home.sql  — demo data for the /home dashboard
--
-- WHAT IT SEEDS (everything the /home page reads, with NOW()-relative dates so
-- every widget renders populated — Today's Schedule, Tasks, Upcoming Events,
-- What's for Dinner, Chores, Family Finances, Recent Memories, Family Messages,
-- and the Family Score / "Needs you" signals):
--   • calendar_events     — today (4/family) + upcoming next ~30d (12/family)   = 80
--   • todo_lists / todo_items — 1 list + 24 tasks/family (today/overdue/future/null) = 5 + 120
--   • chores / chore_assignments — 12 chores due today + 12 assignments/family   = 60 + 60
--   • meals / meal_plans  — 10 meals + this-week dinners (incl. TODAY)/family     = 50 + 35
--   • transactions        — this-month income + expenses (20/family)             = 100
--   • family_albums / family_photos — 1 album + 8 photos/family                  = 5 + 40
--   • family_conversations / family_messages — 1 chat + 10 messages/family       = 5 + 50
--   • family_reminders    — overdue / due-today / future / completed (10/family) = 50
--   • family_food_scores  — one snapshot/family (today)                          = 5
--   TOTAL ≈ 665 rows across 13 tables.
--
-- REQUIRES: run supabase/seed.sql FIRST — it creates the 5 demo families and
-- 25 members this file references:
--   11111111-…-1111  The Patel Family      (+ Mom/Dad/Riley/Sam/Alex)
--   22222222-…-2222  The Nguyen Family
--   33333333-…-3333  The Garcia Family
--   44444444-…-4444  The Johnson Family
--   55555555-…-5555  The Okafor Family
-- Members are managed profiles (user_id NULL), so no auth users are needed.
--
-- HOW TO RUN (needs DB access — this file can't reach your project on its own):
--   • npm run seed:home                         (wrapper, see package.json), or
--   • psql "$DATABASE_URL" -f supabase/seed.sql -f supabase/seed_home.sql, or
--   • Supabase SQL Editor: paste seed.sql, then this file.
--
-- SAFETY: IDEMPOTENT + POOLER-SAFE (no temp tables, no BEGIN/COMMIT). Every
-- statement is scoped to the 5 demo family ids AND to rows this file created
-- (tagged via external_uid 'seedhome:%', notes='seedhome', chores.category
-- 'home_demo', album kind 'home_demo', conversation name 'Family Chat'), so it
-- clears its own prior rows and re-inserts — safe to run repeatedly and will
-- only ever affect those 5 demo families even if pointed at a populated DB.
-- NEVER seeds production data: real families are never matched.
-- ============================================================

-- ── Idempotency: clear this file's prior rows (demo families only) ──
delete from public.calendar_events    where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and external_uid like 'seedhome:%';
delete from public.todo_items         where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and list_id in (select id from public.todo_lists where name = 'Family To-Dos');
delete from public.todo_lists         where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and name = 'Family To-Dos';
delete from public.chore_assignments  where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and chore_id in (select id from public.chores where category = 'home_demo');
delete from public.chores             where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and category = 'home_demo';
delete from public.meal_plans         where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and meal_type = 'dinner' and plan_date between current_date and (current_date + 6);
delete from public.meals              where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and notes = 'seedhome';
delete from public.transactions       where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and notes = 'seedhome';
delete from public.family_photos      where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and album_id in (select id from public.family_albums where name = 'Family Moments (demo)');
delete from public.family_albums      where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and name = 'Family Moments (demo)';
delete from public.family_messages    where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and conversation_id in (select id from public.family_conversations where name = 'Family Chat (demo)');
delete from public.family_conversations where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and name = 'Family Chat (demo)';
delete from public.family_reminders   where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and notes = 'seedhome';
delete from public.family_food_scores where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555') and snapshot_date = current_date;

-- Convenience: the 5 demo families as a CTE-less filtered source.
-- (Each insert re-filters families to these ids so real families are untouched.)

-- ── 1) calendar_events — TODAY (Today's Schedule) ──────────────────────────────
insert into public.calendar_events (family_id, title, location, category, starts_at, ends_at, all_day, assignee_id, external_uid)
select f.id,
       (array['Work Meeting','School drop-off','Soccer Practice','Dinner with Grandma'])[s+1],
       (array['Zoom','Lincoln High School','Community Field','At Grandma''s'])[s+1],
       -- pick from the DB's ACTUAL enum values (prod's event_category may differ
       -- from the migration — e.g. lack 'appointment'), so this never 22P02s.
       (enum_range(null::public.event_category))[1 + (s % array_length(enum_range(null::public.event_category), 1))],
       date_trunc('day', now()) + ((array[8,12,15,19])[s+1] || ' hours')::interval,
       date_trunc('day', now()) + (((array[8,12,15,19])[s+1] + 1) || ' hours')::interval,
       false,
       (select id from public.family_members m where m.family_id=f.id order by random() limit 1),
       'seedhome:today:' || f.id || ':' || s
from public.families f
cross join generate_series(0,3) as s
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ── 1b) calendar_events — UPCOMING (next ~30 days, Upcoming Events) ────────────
insert into public.calendar_events (family_id, title, category, starts_at, ends_at, all_day, assignee_id, external_uid)
select f.id,
       (array['Ethan''s Birthday','Soccer Game','Dance Recital','Memorial Day','Parent-Teacher Night',
              'Doctor Checkup','Piano Lesson','Swim Meet','Family Movie Night','Library Trip',
              'Science Fair','Camping Trip'])[1+(n%12)],
       (enum_range(null::public.event_category))[1 + (n % array_length(enum_range(null::public.event_category), 1))],
       date_trunc('day', now()) + ((n*2) || ' days')::interval + interval '10 hours',
       date_trunc('day', now()) + ((n*2) || ' days')::interval + interval '12 hours',
       (n % 4 = 0),
       (select id from public.family_members m where m.family_id=f.id order by random() limit 1),
       'seedhome:up:' || f.id || ':' || n
from public.families f
cross join generate_series(1,12) as n
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ── 2) todo_lists + todo_items (Tasks) ─────────────────────────────────────────
with lists as (
  insert into public.todo_lists (family_id, name, color, icon, is_shared, sort_order)
  select f.id, 'Family To-Dos', '#6366f1', 'list', true, 0
  from public.families f
  where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555')
  returning id, family_id
)
insert into public.todo_items (family_id, list_id, title, notes, is_done, priority, due_date, assigned_to_id, tags, sort_order)
select l.family_id, l.id,
       (array['Grocery shopping','Finish science project','Pay electricity bill','Clean upstairs bathroom',
              'Plan weekend getaway','Book dentist appointment','Renew car registration',
              'Submit field-trip permission slip','Order a birthday cake for the weekend party at the park',
              'Schedule annual physical checkups for all three kids before school starts',
              'Replace the HVAC air filter','Return the overdue library books','Email the soccer coach',
              'Prep Monday lunches'])[1+(n%14)],
       case when n % 5 = 0 then null else 'Added by the family' end,
       (n % 7 = 0),                                  -- a few completed; widget shows open ones
       (array['low','medium','high'])[1+(n%3)],
       case (n % 5)
         when 0 then null                            -- no due date (null handling)
         when 1 then current_date                    -- due today
         when 2 then current_date - (((n%6)+1))      -- overdue
         when 3 then current_date + (((n%10)+2))     -- upcoming
         else current_date + (n%3)                   -- soon
       end,
       (select id from public.family_members m where m.family_id=l.family_id order by random() limit 1),
       case when n % 4 = 0 then array['home']::text[] else '{}'::text[] end,
       n
from lists l
cross join generate_series(1,24) as n;

-- ── 3) chores + chore_assignments due TODAY (Chores + Family Score) ────────────
with ch as (
  insert into public.chores (family_id, title, points, priority, recurrence, due_at, category, is_active)
  select f.id,
         (array['Take out the trash','Fold laundry','Water the plants','Set the table','Load the dishwasher',
                'Walk the dog','Make the beds','Vacuum the living room','Wipe kitchen counters','Feed the cat',
                'Tidy the playroom','Sort the recycling'])[n],
         (array[5,10,5,5,10,15,5,20,10,5,10,5])[n],
         (enum_range(null::public.priority))[1 + (n % array_length(enum_range(null::public.priority),1))]::public.priority,
         'daily'::public.recurrence_freq,
         date_trunc('day', now()) + interval '18 hours',   -- due today
         'home_demo', true
  from public.families f
  cross join generate_series(1,12) as n
  where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555')
  returning id, family_id, due_at
)
insert into public.chore_assignments (family_id, chore_id, member_id, status, due_at, approved_at)
select c.family_id, c.id,
       (select id from public.family_members m where m.family_id=c.family_id and m.role in ('child','teen') order by random() limit 1),
       (array['approved','todo','in_progress','todo','approved','todo','in_progress','todo','approved','todo','todo','in_progress'])[1+(abs(hashtext(c.id::text))%12)]::public.task_status,
       c.due_at,
       case when (array['approved','todo','in_progress','todo','approved','todo','in_progress','todo','approved','todo','todo','in_progress'])[1+(abs(hashtext(c.id::text))%12)] = 'approved' then now() else null end
from ch c;

-- ── 4) meals + meal_plans (What's for Dinner — incl. TODAY) ────────────────────
insert into public.meals (family_id, name, meal_type, ingredients, notes)
select f.id,
       (array['Tuscan Chicken Pasta','Taco Tuesday','Spaghetti Bolognese','Grilled chicken & veg','Veggie stir-fry',
              'Homemade pizza','Salmon & rice','Hearty chili','Pancake night','Beef stew'])[n],
       'dinner'::public.meal_type,
       '[{"name":"chicken","qty":"1 lb"},{"name":"garlic","qty":"2 cloves"},{"name":"olive oil","qty":"2 tbsp"}]'::jsonb,
       'seedhome'
from public.families f
cross join generate_series(1,10) as n
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- this week's dinners; TODAY (d=0) is always the signature dish so the widget matches the design
insert into public.meal_plans (family_id, meal_id, plan_date, meal_type)
select f.id,
       case when d = 0
            then (select id from public.meals m where m.family_id=f.id and m.notes='seedhome' and m.name='Tuscan Chicken Pasta' limit 1)
            else (select id from public.meals m where m.family_id=f.id and m.notes='seedhome' order by random() limit 1)
       end,
       (current_date + d)::date, 'dinner'::public.meal_type
from public.families f
cross join generate_series(0,6) as d
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ── 5) transactions — this month (Family Finances) ─────────────────────────────
-- 2 income rows + 18 varied expense rows per family, all dated within this month.
insert into public.transactions (family_id, name, amount, category, date, type, notes)
select f.id, x.name, x.amount, x.category,
       (date_trunc('month', now()) + ((x.day - 1) || ' days')::interval)::date,
       x.type::public.transaction_type, 'seedhome'
from public.families f
cross join (values
  ('Monthly Salary',        6450.00, 'Income',        1, 'income'),
  ('Freelance Project',      820.00, 'Income',        8, 'income'),
  ('Rent / Mortgage',       1800.00, 'Housing',       3, 'expense'),
  ('Weekly Groceries',       186.40, 'Groceries',     4, 'expense'),
  ('Groceries',              142.10, 'Groceries',    11, 'expense'),
  ('Groceries',              173.90, 'Groceries',    18, 'expense'),
  ('Electric Bill',          138.20, 'Utilities',     6, 'expense'),
  ('Water & Sewer',           64.00, 'Utilities',     6, 'expense'),
  ('Internet',                79.99, 'Utilities',     9, 'expense'),
  ('Gas / Fuel',             112.45, 'Transport',     7, 'expense'),
  ('Car Insurance',          148.00, 'Insurance',    10, 'expense'),
  ('Family Dining Out',      96.50,  'Dining',       12, 'expense'),
  ('Kids'' Activities',      120.00, 'Activities',   14, 'expense'),
  ('Streaming Subscriptions', 47.97, 'Subscriptions',15, 'expense'),
  ('Pharmacy',                34.20, 'Health',       16, 'expense'),
  ('Clothing',               129.99, 'Shopping',     17, 'expense'),
  ('Household Supplies',      58.30,  'Home',         19, 'expense'),
  ('Coffee & Snacks',         28.75, 'Dining',       20, 'expense'),
  ('Birthday Gift',           45.00, 'Gifts',        21, 'expense'),
  ('Phone Bill',              90.00, 'Utilities',    22, 'expense')
) as x(name, amount, category, day, type)
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ── 6) family_albums + family_photos (Recent Memories) ─────────────────────────
with alb as (
  insert into public.family_albums (family_id, name, kind, is_shared, photo_count)
  select f.id, 'Family Moments (demo)', 'general', true, 8
  from public.families f
  where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555')
  returning id, family_id
)
insert into public.family_photos (family_id, album_id, storage_path, url, thumbnail_url, caption, taken_at, media_type, is_favorite, tags, member_tags)
select a.family_id, a.id,
       'seedhome/' || a.family_id || '/' || n || '.jpg',
       'https://picsum.photos/seed/' || substr(md5(a.family_id::text || n::text), 1, 8) || '/600/600',
       'https://picsum.photos/seed/' || substr(md5(a.family_id::text || n::text), 1, 8) || '/300/300',
       (array['Park day','Backyard picnic','Beach trip','Movie night','Baking together',
              'First soccer goal','Grandma''s visit','Sunday brunch'])[n],
       (now() - ((n*3) || ' days')::interval),
       'image', (n % 4 = 0), '{}'::text[], '{}'::uuid[]
from alb a
cross join generate_series(1,8) as n;

-- ── 7) family_conversations + family_messages (Family Messages) ────────────────
with conv as (
  insert into public.family_conversations (family_id, name, kind, avatar_emoji, member_ids, participant_ids, last_message_at)
  select f.id, 'Family Chat (demo)', 'group', '🏠',
         array(select id from public.family_members m where m.family_id=f.id and m.is_active),
         array(select id from public.family_members m where m.family_id=f.id and m.is_active),
         now()
  from public.families f
  where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555')
  returning id, family_id
)
-- sender_id is an auth.users FK; demo members are managed profiles (no auth user),
-- so sender_id stays NULL and the display name is carried by sender_name.
insert into public.family_messages (conversation_id, family_id, sender_id, sender_name, content, kind, reactions, read_by, created_at)
select c.id, c.family_id, null, snd.display_name,
       (array['Don''t forget Ethan''s school project is due Friday!','Can you pick me up at 3:45 today?',
              'Can''t wait for dinner tonight! 🍝','Soccer practice moved to 5pm','Who''s making lunch tomorrow?',
              'I''ll grab milk on the way home','Great game today, team! ⚽','Reminder: dentist at 4',
              'Movie night this Saturday?','Homework all done ✅'])[n],
       'text', '{}'::jsonb, '{}'::uuid[],
       now() - ((n*37) || ' minutes')::interval
from conv c
cross join generate_series(1,10) as n
cross join lateral (
  select id, display_name from public.family_members m where m.family_id=c.family_id order by random() limit 1
) as snd;

-- ── 8) family_reminders — overdue / today / future / completed ("Needs you") ───
insert into public.family_reminders (family_id, title, notes, kind, remind_at, priority, status, recurrence, member_id, tags, subtasks, completed_at)
select f.id,
       (array['Pay the electric bill','Refill prescription','RSVP to the birthday party','Sign the permission slip',
              'Renew the library books','Schedule an oil change','Water the plants','Call grandma',
              'Submit the timesheet','Buy a birthday gift'])[n],
       'seedhome', 'time',
       case
         when n <= 3 then now() - ((n) || ' days')::interval        -- overdue (active) → Needs you
         when n <= 5 then date_trunc('day', now()) + interval '20 hours'  -- due today
         else now() + ((n) || ' days')::interval                    -- future
       end,
       (array['low','medium','high'])[1+(n%3)],
       case when n in (9,10) then 'completed' else 'active' end,
       'none',
       (select id from public.family_members m where m.family_id=f.id order by random() limit 1),
       '{}'::text[], '[]'::jsonb,
       case when n in (9,10) then now() - interval '1 day' else null end
from public.families f
cross join generate_series(1,10) as n
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ── 9) family_food_scores — one snapshot/family (today) ────────────────────────
insert into public.family_food_scores (family_id, snapshot_date, overall, grade, sub_scores, coaching, metadata)
select f.id, current_date,
       (array[92,86,78,95,83])[1+(abs(hashtext(f.id::text))%5)],
       (array['A','B','C','A','B'])[1+(abs(hashtext(f.id::text))%5)],
       '[{"key":"variety","label":"Variety","score":80},{"key":"balance","label":"Balance","score":85},{"key":"home_cooked","label":"Home cooked","score":90}]'::jsonb,
       '["Great balance this week — keep planning dinners ahead."]'::jsonb,
       '{"source":"seed_home"}'::jsonb
from public.families f
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ============================================================
-- Done. ≈665 rows across 13 tables for 5 demo families. Re-runnable.
-- Verify (optional):
--   select 'calendar' t, count(*) from public.calendar_events where external_uid like 'seedhome:%'
--   union all select 'todos', count(*) from public.todo_items where list_id in (select id from public.todo_lists where name='Family To-Dos')
--   union all select 'chores', count(*) from public.chores where category='home_demo'
--   union all select 'meals', count(*) from public.meals where notes='seedhome'
--   union all select 'txns', count(*) from public.transactions where notes='seedhome'
--   union all select 'photos', count(*) from public.family_photos where album_id in (select id from public.family_albums where kind='home_demo')
--   union all select 'messages', count(*) from public.family_messages where conversation_id in (select id from public.family_conversations where kind='home_demo')
--   union all select 'reminders', count(*) from public.family_reminders where notes='seedhome';
-- ============================================================
