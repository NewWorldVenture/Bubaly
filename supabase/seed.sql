-- Bubaly :: seed.sql
-- Demo data. Members are seeded as "managed profiles" (user_id null) so this runs
-- without provisioning auth users. Real members attach when they sign up / accept invites.
-- Idempotent-ish: safe to run on a fresh db.

-- ---------- reference: roles ----------
insert into public.roles (role, label, description) values
  ('parent','Parent / Admin','Manages everything in the household'),
  ('adult','Adult','Manages shared household data'),
  ('teen','Teen','Manages own tasks and activities'),
  ('child','Child','Completes assigned chores and views items'),
  ('caregiver','Caregiver','Views assigned areas'),
  ('guest','Guest','Views limited shared events')
on conflict (role) do nothing;

-- ---------- reference: permission matrix ----------
insert into public.permissions (role, resource, can_create, can_read, can_update, can_delete)
select r.role, res.resource,
  case when r.role in ('parent','adult') then true
       when r.role='teen' and res.resource in ('chores','calendar_events','reminders') then true
       else false end,
  true,
  case when r.role in ('parent','adult') then true
       when r.role in ('teen','child') and res.resource='chore_assignments' then true
       else false end,
  case when r.role='parent' then true else false end
from public.roles r
cross join (values ('calendar_events'),('chores'),('chore_assignments'),
  ('meals'),('grocery_items'),('documents'),('reminders'),('notes')) as res(resource)
on conflict (role, resource) do nothing;

-- ---------- families ----------
insert into public.families (id, name, timezone) values
  ('11111111-1111-1111-1111-111111111111','The Patel Family','America/New_York'),
  ('22222222-2222-2222-2222-222222222222','The Nguyen Family','America/Los_Angeles'),
  ('33333333-3333-3333-3333-333333333333','The Garcia Family','America/Chicago'),
  ('44444444-4444-4444-4444-444444444444','The Johnson Family','America/Denver'),
  ('55555555-5555-5555-5555-555555555555','The Okafor Family','America/New_York')
on conflict (id) do nothing;

-- ---------- members: 5 per family = 25 ----------
insert into public.family_members (family_id, role, display_name, color, birthday)
select f.id, m.role::public.member_role, m.name, m.color, m.bday::date
from public.families f
cross join (values
  ('parent','Mom','#ec4899','1986-04-12'),
  ('parent','Dad','#3b82f6','1984-09-03'),
  ('teen','Riley','#10b981','2009-02-20'),
  ('child','Sam','#f59e0b','2014-07-08'),
  ('child','Alex','#8b5cf6','2016-11-30')
) as m(role,name,color,bday);

-- helper note: pick member by role within a family in subqueries below.

-- ---------- calendar_events: 20 per family = 100 ----------
insert into public.calendar_events (family_id, title, category, starts_at, ends_at, all_day, created_by)
select f.id,
       (array['Dentist','Soccer practice','Parent-teacher night','Family dinner','Piano lesson',
              'Birthday party','Doctor checkup','School play','Swim meet','Game night'])[1+(n%10)],
       -- pick from the DB's ACTUAL enum values (some DBs predate newer categories
       -- like 'appointment'), so this never errors with 22P02 invalid enum input.
       (enum_range(null::public.event_category))[1 + (n % array_length(enum_range(null::public.event_category), 1))],
       date_trunc('day', now()) + (n || ' days')::interval + interval '17 hours',
       date_trunc('day', now()) + (n || ' days')::interval + interval '18 hours',
       false, null
from public.families f, generate_series(1,20) as n;

-- ---------- chores: 20 per family = 100 ----------
insert into public.chores (family_id, title, points, priority, recurrence, due_at)
select f.id,
       (array['Take out trash','Load dishwasher','Walk the dog','Make bed','Vacuum living room',
              'Clean bathroom','Mow lawn','Fold laundry','Set the table','Feed the cat'])[1+(n%10)],
       (array[5,10,15,5,20,25,30,10,5,5])[1+(n%10)],
       (array['low','medium','high'])[1+(n%3)]::public.priority,
       (array['daily','weekly','none'])[1+(n%3)]::public.recurrence_freq,
       now() + (n || ' days')::interval
from public.families f, generate_series(1,20) as n;

-- ---------- chore_assignments: assign each chore to a child/teen ----------
insert into public.chore_assignments (family_id, chore_id, member_id, status, due_at)
select c.family_id, c.id,
       (select id from public.family_members m
        where m.family_id = c.family_id and m.role in ('child','teen')
        order by random() limit 1),
       (array['todo','in_progress','submitted','approved'])[1+ (abs(hashtext(c.id::text)) % 4)]::public.task_status,
       c.due_at
from public.chores c;

-- ---------- meals: 10 per family = 50 ----------
insert into public.meals (family_id, name, meal_type, ingredients)
select f.id,
       (array['Taco Tuesday','Spaghetti Bolognese','Grilled chicken & veg','Veggie stir-fry','Homemade pizza',
              'Salmon & rice','Chili','Pancake breakfast','Caesar salad','Beef stew'])[1+(n%10)],
       'dinner'::public.meal_type,
       '[{"name":"onion","qty":"1"},{"name":"garlic","qty":"2 cloves"},{"name":"olive oil","qty":"2 tbsp"}]'::jsonb
from public.families f, generate_series(1,10) as n;

-- ---------- meal_plans: next 7 days dinner per family ----------
insert into public.meal_plans (family_id, meal_id, plan_date, meal_type)
select f.id,
       (select id from public.meals m where m.family_id = f.id order by random() limit 1),
       (current_date + d)::date, 'dinner'::public.meal_type
from public.families f, generate_series(0,6) as d;

-- ---------- grocery: one list + 20 items per family = 100 items ----------
with lists as (
  insert into public.grocery_lists (family_id, name)
  select id, 'Weekly Groceries' from public.families
  returning id, family_id
)
insert into public.grocery_items (family_id, list_id, name, quantity, category, is_checked)
select l.family_id, l.id,
       (array['Milk','Eggs','Bread','Apples','Chicken','Rice','Pasta','Tomatoes','Cheese','Cereal',
              'Bananas','Yogurt','Coffee','Butter','Onions','Carrots','Spinach','Olive oil','Cereal bars','Orange juice'])[n],
       (array['1 gal','1 dozen','2 loaves','6','2 lb','1 bag','2 boxes','5','1 block','1 box',
              '1 bunch','4 cups','1 bag','1','3 lb','2 lb','1 bag','1 bottle','1 box','1 carton'])[n],
       (array['Dairy','Dairy','Bakery','Produce','Meat','Pantry','Pantry','Produce','Dairy','Pantry',
              'Produce','Dairy','Beverages','Dairy','Produce','Produce','Produce','Pantry','Snacks','Beverages'])[n],
       (n % 4 = 0)
from lists l, generate_series(1,20) as n;

-- ---------- home_assets: 5 per family = 25 ----------
insert into public.home_assets (family_id, name, category, location)
select f.id,
       (array['HVAC System','Water Heater','Refrigerator','Dishwasher','Smoke Detectors'])[n],
       (array['Climate','Plumbing','Kitchen','Kitchen','Safety'])[n],
       (array['Basement','Garage','Kitchen','Kitchen','Hallway'])[n]
from public.families f, generate_series(1,5) as n;

-- ---------- maintenance_tasks: 10 per family = 50 ----------
insert into public.maintenance_tasks (family_id, asset_id, title, priority, recurrence, interval_days, due_at, status)
select f.id,
       (select id from public.home_assets a where a.family_id = f.id order by random() limit 1),
       (array['Change HVAC filter','Flush water heater','Clean fridge coils','Test smoke detectors','Clean gutters',
              'Service furnace','Replace AC filter','Check roof','Reseal driveway','Clean dryer vent'])[1+(n%10)],
       (array['low','medium','high'])[1+(n%3)]::public.priority,
       'monthly'::public.recurrence_freq,
       (array[90,365,180,180,365,365,90,365,730,180])[1+(n%10)],
       now() + ((n*7) || ' days')::interval,
       'todo'::public.task_status
from public.families f, generate_series(1,10) as n;

-- ---------- school + sports: 5 each per family = 50 ----------
insert into public.school_events (family_id, member_id, title, event_type, starts_at)
select f.id,
       (select id from public.family_members m where m.family_id=f.id and m.role in ('child','teen') order by random() limit 1),
       (array['Field trip','Parent meeting','Spring break','Science fair','Report cards'])[n],
       (array['field_trip','parent_meeting','holiday','general','general'])[n],
       now() + ((n*10) || ' days')::interval
from public.families f, generate_series(1,5) as n;

insert into public.sports_events (family_id, member_id, sport, title, event_type, recurrence, starts_at)
select f.id,
       (select id from public.family_members m where m.family_id=f.id and m.role in ('child','teen') order by random() limit 1),
       (array['Soccer','Basketball','Swimming','Baseball','Tennis'])[n],
       (array['Soccer practice','Basketball game','Swim meet','Baseball practice','Tennis lesson'])[n],
       (array['practice','game','tournament','practice','practice'])[n],
       'weekly'::public.recurrence_freq,
       now() + ((n*2) || ' days')::interval + interval '18 hours'
from public.families f, generate_series(1,5) as n;

-- ---------- reminders: 10 per family = 50 ----------
insert into public.reminders (family_id, title, remind_at, recurrence)
select f.id,
       (array['Pay electric bill','Refill prescription','RSVP to party','Sign permission slip','Renew library books',
              'Schedule oil change','Water the plants','Call grandma','Submit timesheet','Buy birthday gift'])[1+(n%10)],
       now() + (n || ' days')::interval,
       (array['none','weekly','monthly'])[1+(n%3)]::public.recurrence_freq
from public.families f, generate_series(1,10) as n;

-- ---------- documents metadata: 5 per family = 25 ----------
insert into public.documents (family_id, title, category, storage_path, mime_type, expires_at)
select f.id,
       (array['Auto Insurance Policy','Passport - Mom','School Enrollment','Home Warranty','Medical Records'])[n],
       (array['insurance','legal','school','home','medical'])[n],
       'documents/' || f.id || '/' || (array['auto-insurance','passport-mom','enrollment','warranty','medical'])[n] || '.pdf',
       'application/pdf',
       (current_date + (array[120,400,200,60,365])[n])::date
from public.families f, generate_series(1,5) as n;

-- ---------- goals: 3 per family ----------
insert into public.goals (family_id, title, target_date, progress)
select f.id,
       (array['Save for summer vacation','Read 20 books as a family','Declutter the garage'])[n],
       (current_date + (array[120,300,45])[n])::date,
       (array[35,60,10])[n]
from public.families f, generate_series(1,3) as n;

-- ---------- AI conversation sample (Patel family) ----------
with conv as (
  insert into public.ai_conversations (family_id, title, provider, model)
  values ('11111111-1111-1111-1111-111111111111','Plan our week','anthropic','claude-sonnet-4-6')
  returning id, family_id
)
insert into public.ai_messages (family_id, conversation_id, role, content, tool_calls, tool_results)
select c.family_id, c.id, x.role::public.ai_role, x.content, x.tc, x.tr
from conv c, (values
  ('user','What''s happening this week?', null::jsonb, null::jsonb),
  ('assistant','You have 6 events this week: Riley''s soccer practice Tue & Thu at 6pm, a dentist appointment Wed, and family dinner Sunday. Want me to plan dinners around the practices?', null, null),
  ('user','Yes, and add soccer practice every Tuesday.', null, null),
  ('assistant','Done — I added a recurring Tuesday 6pm soccer practice and built a meal plan that puts quick dinners (tacos, stir-fry) on practice nights.',
    '[{"tool":"create_sports_event","args":{"title":"Soccer practice","recurrence":"weekly","day":"Tuesday","time":"18:00"}},{"tool":"create_meal_plan","args":{"week":"current"}}]'::jsonb,
    '[{"tool":"create_sports_event","status":"ok"},{"tool":"create_meal_plan","status":"ok","meals":5}]'::jsonb)
) as x(role, content, tc, tr);
