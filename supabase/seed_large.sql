-- ============================================================
-- FamilyOS :: seed_large.sql  — high-volume demo data
--
-- Seeds >= 500 rows into every family-scoped DATA table, on top of the
-- 5 demo families + 25 members from seed.sql. Run seed.sql FIRST (it
-- creates the families, members and reference rows this file references).
--
-- HOW TO RUN (you need DB access — this file cannot reach your project
-- on its own):
--   • Supabase SQL Editor: paste seed.sql, then this file; or
--   • psql "$DATABASE_URL" -f supabase/seed.sql -f supabase/seed_large.sql
--
-- IDEMPOTENT: it first clears prior seed rows for the 5 demo families
-- (by family_id, FK-cascade safe) and re-inserts, so it is safe to run
-- repeatedly. It ONLY touches the 5 demo family ids below — it never
-- deletes or modifies real households.
--
-- CANNOT reach 500 by design (documented, not a bug):
--   • family_digital_twin_profiles, medical_profiles — UNIQUE per member
--     (max 25 across the demo families); seeded fully (one per member).
--   • reference/admin tables (roles, permissions, blog_posts, marketing_*,
--     subscriptions, super_admins, profiles, user_preferences) — fixed or
--     auth-coupled; intentionally not bulk-seeded.
-- ============================================================

BEGIN;

-- The 5 demo families seed.sql creates. All work below is scoped to these.
CREATE TEMP TABLE _seed_fams (id uuid) ON COMMIT DROP;
INSERT INTO _seed_fams VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444'),
  ('55555555-5555-5555-5555-555555555555');

-- ── Clear prior seed rows for these families (cascade-safe) ──
-- Parents first; children with ON DELETE CASCADE follow automatically, but we
-- clear standalone family-scoped tables explicitly so re-runs never duplicate.
DELETE FROM public.family_knowledge_edges      WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.family_knowledge_nodes      WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.family_automation_runs      WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.family_automation_rules     WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.family_stress_predictions   WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.family_stress_signals       WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.family_ai_recommendations   WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.family_emergency_contacts   WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.family_emergency_plans      WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.family_memories             WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.family_milestones           WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.family_routines             WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.family_digital_twin_profiles WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.game_results                WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.teams                       WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.grades                      WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.school_classes              WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.sports_events               WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.school_events               WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.medication_schedules        WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.medications                 WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.appointments                WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.workout_logs                WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.health_metrics              WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.transactions                WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.financial_accounts          WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.bills                       WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.budgets                     WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.savings_goals               WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.maintenance_tasks           WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.home_assets                 WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.documents                   WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.reminders                   WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.notifications               WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.notes                       WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.rewards                     WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.goals                       WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.grocery_items               WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.grocery_lists               WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.meal_plans                  WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.meals                       WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.chore_assignments           WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.chores                      WHERE family_id IN (SELECT id FROM _seed_fams);
DELETE FROM public.calendar_events             WHERE family_id IN (SELECT id FROM _seed_fams);

-- ============================================================
-- FAMILY-SCOPED TABLES — 100 rows/family × 5 = 500 each
-- ============================================================

-- calendar_events
INSERT INTO public.calendar_events (family_id, title, category, starts_at, ends_at, all_day)
SELECT f.id,
  (ARRAY['Dentist','Soccer practice','Parent-teacher night','Family dinner','Piano lesson','Birthday party','Doctor checkup','School play','Swim meet','Game night'])[1+(n%10)] || ' #' || n,
  (ARRAY['appointment','sports','school','general','general','birthday','appointment','school','sports','general'])[1+(n%10)]::public.event_category,
  date_trunc('day', now()) + ((n-50) || ' days')::interval + interval '17 hours',
  date_trunc('day', now()) + ((n-50) || ' days')::interval + interval '18 hours',
  (n % 7 = 0)
FROM _seed_fams f, generate_series(1,100) n;

-- chores
INSERT INTO public.chores (family_id, title, points, priority, recurrence, due_at, requires_approval)
SELECT f.id,
  (ARRAY['Take out trash','Load dishwasher','Walk the dog','Make bed','Vacuum living room','Clean bathroom','Mow lawn','Fold laundry','Set the table','Feed the cat'])[1+(n%10)] || ' #' || n,
  (ARRAY[5,10,15,5,20,25,30,10,5,5])[1+(n%10)],
  (ARRAY['low','medium','high'])[1+(n%3)]::public.priority,
  (ARRAY['daily','weekly','none'])[1+(n%3)]::public.recurrence_freq,
  now() + ((n-30) || ' days')::interval,
  (n % 4 = 0)
FROM _seed_fams f, generate_series(1,100) n;

-- chore_assignments — one per chore (>=500)
INSERT INTO public.chore_assignments (family_id, chore_id, member_id, status, due_at)
SELECT c.family_id, c.id,
  (SELECT id FROM public.family_members m WHERE m.family_id = c.family_id AND m.role IN ('child','teen') ORDER BY random() LIMIT 1),
  (ARRAY['todo','in_progress','submitted','approved'])[1+(abs(hashtext(c.id::text)) % 4)]::public.task_status,
  c.due_at
FROM public.chores c WHERE c.family_id IN (SELECT id FROM _seed_fams);

-- rewards
INSERT INTO public.rewards (family_id, title, description, cost_points)
SELECT f.id,
  (ARRAY['Movie night pick','Extra screen time','Ice cream trip','Stay up late','Choose dinner','$5 allowance','Friend sleepover','Skip a chore','New book','Theme park day'])[1+(n%10)] || ' #' || n,
  'Redeemable reward', (ARRAY[50,30,40,60,20,100,150,80,45,500])[1+(n%10)]
FROM _seed_fams f, generate_series(1,100) n;

-- meals
INSERT INTO public.meals (family_id, name, meal_type, ingredients)
SELECT f.id,
  (ARRAY['Taco Tuesday','Spaghetti Bolognese','Grilled chicken & veg','Veggie stir-fry','Homemade pizza','Salmon & rice','Chili','Pancake breakfast','Caesar salad','Beef stew'])[1+(n%10)] || ' #' || n,
  (ARRAY['breakfast','lunch','dinner','snack'])[1+(n%4)]::public.meal_type,
  '[{"name":"onion","qty":"1"},{"name":"garlic","qty":"2 cloves"},{"name":"olive oil","qty":"2 tbsp"}]'::jsonb
FROM _seed_fams f, generate_series(1,100) n;

-- meal_plans — 100 distinct dates/family
INSERT INTO public.meal_plans (family_id, meal_id, plan_date, meal_type)
SELECT f.id,
  (SELECT id FROM public.meals m WHERE m.family_id = f.id ORDER BY random() LIMIT 1),
  (current_date - 50 + n)::date,
  (ARRAY['breakfast','lunch','dinner','snack'])[1+(n%4)]::public.meal_type
FROM _seed_fams f, generate_series(1,100) n;

-- grocery_lists (100/family) + grocery_items (>=500 via 5 items each)
WITH lists AS (
  INSERT INTO public.grocery_lists (family_id, name, is_archived)
  SELECT f.id, 'List #' || n, (n % 5 = 0)
  FROM _seed_fams f, generate_series(1,100) n
  RETURNING id, family_id
)
INSERT INTO public.grocery_items (family_id, list_id, name, quantity, category, is_checked)
SELECT l.family_id, l.id,
  (ARRAY['Milk','Eggs','Bread','Apples','Chicken'])[g] || '',
  (ARRAY['1 gal','1 dozen','2 loaves','6','2 lb'])[g],
  (ARRAY['Dairy','Dairy','Bakery','Produce','Meat'])[g],
  (g % 3 = 0)
FROM lists l, generate_series(1,5) g;

-- notes
INSERT INTO public.notes (family_id, title, body, is_pinned)
SELECT f.id, 'Note #' || n,
  (ARRAY['Babysitter contact and house rules.','WiFi password is on the fridge.','Soccer carpool schedule for the month.','Grandma''s birthday gift ideas.','Vacation packing checklist.'])[1+(n%5)],
  (n % 10 = 0)
FROM _seed_fams f, generate_series(1,100) n;

-- reminders
INSERT INTO public.reminders (family_id, title, notes, remind_at, recurrence, is_done)
SELECT f.id,
  (ARRAY['Pay electric bill','Refill prescription','RSVP to party','Sign permission slip','Renew library books','Schedule oil change','Water the plants','Call grandma','Submit timesheet','Buy birthday gift'])[1+(n%10)] || ' #' || n,
  'Auto-seeded reminder', now() + ((n-30) || ' days')::interval,
  (ARRAY['none','weekly','monthly'])[1+(n%3)]::public.recurrence_freq, (n % 6 = 0)
FROM _seed_fams f, generate_series(1,100) n;

-- notifications
INSERT INTO public.notifications (family_id, type, title, body, is_read, send_at)
SELECT f.id,
  (ARRAY['chore_due','medication_due','calendar_event','school_event','sports_event','maintenance_task','grocery_reminder','document_expiry','family_invite','system'])[1+(n%10)]::public.notification_type,
  'Notification #' || n, 'Auto-seeded notification body.', (n % 3 = 0),
  now() - ((n) || ' hours')::interval
FROM _seed_fams f, generate_series(1,100) n;

-- documents
INSERT INTO public.documents (family_id, title, category, storage_path, mime_type, size_bytes, expires_at)
SELECT f.id, 'Document #' || n,
  (ARRAY['insurance','legal','school','home','medical'])[1+(n%5)],
  'documents/' || f.id || '/doc-' || n || '.pdf', 'application/pdf', 50000 + n*137,
  (current_date + (n % 365))::date
FROM _seed_fams f, generate_series(1,100) n;

-- goals
INSERT INTO public.goals (family_id, title, description, target_date, progress, is_complete)
SELECT f.id,
  (ARRAY['Save for summer vacation','Read 20 books as a family','Declutter the garage','Family fitness challenge','Learn to cook together'])[1+(n%5)] || ' #' || n,
  'Auto-seeded goal', (current_date + (n % 300))::date, (n % 101), (n % 9 = 0)
FROM _seed_fams f, generate_series(1,100) n;

-- home_assets
INSERT INTO public.home_assets (family_id, name, category, location, brand, purchased_on, warranty_until)
SELECT f.id,
  (ARRAY['HVAC System','Water Heater','Refrigerator','Dishwasher','Smoke Detectors','Washer','Dryer','Furnace','Garage Door','Lawn Mower'])[1+(n%10)] || ' #' || n,
  (ARRAY['Climate','Plumbing','Kitchen','Kitchen','Safety'])[1+(n%5)],
  (ARRAY['Basement','Garage','Kitchen','Hallway','Yard'])[1+(n%5)],
  (ARRAY['Carrier','Rheem','LG','Bosch','Nest'])[1+(n%5)],
  (current_date - (n*10))::date, (current_date + (365 + n))::date
FROM _seed_fams f, generate_series(1,100) n;

-- maintenance_tasks
INSERT INTO public.maintenance_tasks (family_id, asset_id, title, priority, recurrence, interval_days, due_at, status)
SELECT f.id,
  (SELECT id FROM public.home_assets a WHERE a.family_id = f.id ORDER BY random() LIMIT 1),
  (ARRAY['Change HVAC filter','Flush water heater','Clean fridge coils','Test smoke detectors','Clean gutters'])[1+(n%5)] || ' #' || n,
  (ARRAY['low','medium','high'])[1+(n%3)]::public.priority, 'monthly'::public.recurrence_freq,
  (ARRAY[90,365,180,180,365])[1+(n%5)], now() + ((n*3) || ' days')::interval,
  (ARRAY['todo','in_progress','submitted'])[1+(n%3)]::public.task_status
FROM _seed_fams f, generate_series(1,100) n;

-- financial_accounts
INSERT INTO public.financial_accounts (family_id, name, type, institution, last_four, balance, currency)
SELECT f.id,
  (ARRAY['Everyday Checking','Family Savings','Rewards Card','Brokerage','401k'])[1+(n%5)] || ' #' || n,
  (ARRAY['checking','savings','credit','investment','retirement'])[1+(n%5)]::public.account_type,
  (ARRAY['Chase','Ally','Amex','Fidelity','Vanguard'])[1+(n%5)],
  lpad((n*7 % 10000)::text, 4, '0'), round((random()*20000)::numeric, 2), 'USD'
FROM _seed_fams f, generate_series(1,100) n;

-- transactions
INSERT INTO public.transactions (family_id, account_id, name, amount, category, date, type, notes)
SELECT f.id,
  (SELECT id FROM public.financial_accounts a WHERE a.family_id = f.id ORDER BY random() LIMIT 1),
  (ARRAY['Groceries','Gas','Restaurant','Utilities','Subscription','Pharmacy','Clothing','School fees','Paycheck','Refund'])[1+(n%10)],
  round((random()*250 + 5)::numeric, 2),
  (ARRAY['Food','Transport','Dining','Utilities','Entertainment','Health','Apparel','Education','Income','Misc'])[1+(n%10)],
  (current_date - (n % 90))::date,
  (CASE WHEN n%10 IN (8,9) THEN 'income' ELSE 'expense' END)::public.transaction_type,
  'Auto-seeded transaction'
FROM _seed_fams f, generate_series(1,100) n;

-- budgets
INSERT INTO public.budgets (family_id, category, amount, period)
SELECT f.id,
  (ARRAY['Food','Transport','Dining','Utilities','Entertainment','Health','Apparel','Education','Childcare','Misc'])[1+(n%10)] || ' #' || n,
  round((random()*800 + 100)::numeric, 2),
  (ARRAY['weekly','monthly','yearly'])[1+(n%3)]::public.budget_period
FROM _seed_fams f, generate_series(1,100) n;

-- bills
INSERT INTO public.bills (family_id, name, amount, due_date, is_recurring, recurrence, status, category)
SELECT f.id,
  (ARRAY['Electric','Water','Internet','Mortgage','Car Insurance','Phone','Streaming','Gym','Trash','Daycare'])[1+(n%10)] || ' #' || n,
  round((random()*400 + 20)::numeric, 2), (current_date - 30 + (n % 90))::date,
  (n % 2 = 0), 'monthly',
  (ARRAY['upcoming','paid','overdue'])[1+(n%3)]::public.bill_status,
  (ARRAY['Utilities','Housing','Insurance','Subscription','Childcare'])[1+(n%5)]
FROM _seed_fams f, generate_series(1,100) n;

-- savings_goals
INSERT INTO public.savings_goals (family_id, name, target_amount, current_amount, target_date, emoji)
SELECT f.id,
  (ARRAY['Vacation','Emergency Fund','New Car','Home Reno','College','Holidays','Braces','Camp','Bikes','Rainy Day'])[1+(n%10)] || ' #' || n,
  round((random()*9000 + 1000)::numeric, 2), round((random()*1000)::numeric, 2),
  (current_date + (n % 365))::date, (ARRAY['🎯','🏖️','🚗','🏡','🎓'])[1+(n%5)]
FROM _seed_fams f, generate_series(1,100) n;

-- school_events
INSERT INTO public.school_events (family_id, member_id, title, event_type, starts_at)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id=f.id AND m.role IN ('child','teen') ORDER BY random() LIMIT 1),
  (ARRAY['Field trip','Parent meeting','Spring break','Science fair','Report cards'])[1+(n%5)] || ' #' || n,
  (ARRAY['field_trip','parent_meeting','holiday','general','general'])[1+(n%5)],
  now() + ((n) || ' days')::interval
FROM _seed_fams f, generate_series(1,100) n;

-- sports_events
INSERT INTO public.sports_events (family_id, member_id, sport, team, title, event_type, location, recurrence, starts_at)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id=f.id AND m.role IN ('child','teen') ORDER BY random() LIMIT 1),
  (ARRAY['Soccer','Basketball','Swimming','Baseball','Tennis'])[1+(n%5)],
  (ARRAY['Tigers','Sharks','Eagles','Comets','Rockets'])[1+(n%5)],
  (ARRAY['Practice','Game','Meet','Scrimmage','Lesson'])[1+(n%5)] || ' #' || n,
  (ARRAY['practice','game','tournament','practice','practice'])[1+(n%5)],
  (ARRAY['City Field','Rec Center','Aquatic Center','Diamond Park','Court 3'])[1+(n%5)],
  'weekly'::public.recurrence_freq, now() + ((n) || ' days')::interval + interval '18 hours'
FROM _seed_fams f, generate_series(1,100) n;

-- teams (100/family) + game_results (1 per team)
INSERT INTO public.teams (family_id, member_id, sport, team_name, season, coach, is_active)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id=f.id AND m.role IN ('child','teen') ORDER BY random() LIMIT 1),
  (ARRAY['Soccer','Basketball','Swimming','Baseball','Tennis'])[1+(n%5)],
  (ARRAY['Tigers','Sharks','Eagles','Comets','Rockets'])[1+(n%5)] || ' #' || n,
  (ARRAY['Fall 2025','Winter 2025','Spring 2026','Summer 2026'])[1+(n%4)],
  (ARRAY['Coach Lee','Coach Ramos','Coach Patel','Coach Kim','Coach Brown'])[1+(n%5)],
  (n % 7 <> 0)
FROM _seed_fams f, generate_series(1,100) n;

INSERT INTO public.game_results (family_id, team_id, opponent, our_score, their_score, date, result)
SELECT t.family_id, t.id,
  (ARRAY['Wildcats','Bears','Hawks','Lions','Wolves'])[1+(abs(hashtext(t.id::text))%5)],
  (abs(hashtext(t.id::text)) % 6), (abs(hashtext(t.id::text || 'x')) % 6),
  (current_date - (abs(hashtext(t.id::text)) % 120))::date,
  (CASE WHEN (abs(hashtext(t.id::text))%3)=0 THEN 'win' WHEN (abs(hashtext(t.id::text))%3)=1 THEN 'loss' ELSE 'tie' END)::public.game_result
FROM public.teams t WHERE t.family_id IN (SELECT id FROM _seed_fams);

-- medications (100/family) + medication_schedules (1 per medication)
INSERT INTO public.medications (family_id, member_id, name, dosage, instructions, is_active)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id=f.id ORDER BY random() LIMIT 1),
  (ARRAY['Amoxicillin','Ibuprofen','Vitamin D','Allergy Relief','Inhaler','Melatonin','Acetaminophen','Iron','Probiotic','Fluoride'])[1+(n%10)] || ' #' || n,
  (ARRAY['250mg','200mg','1000 IU','10mg','2 puffs'])[1+(n%5)],
  'Take as directed', (n % 5 <> 0)
FROM _seed_fams f, generate_series(1,100) n;

INSERT INTO public.medication_schedules (family_id, medication_id, time_of_day, days_of_week, starts_on)
SELECT m.family_id, m.id, (ARRAY['08:00','12:00','18:00','21:00'])[1+(abs(hashtext(m.id::text))%4)]::time,
  ARRAY[1,3,5], current_date
FROM public.medications m WHERE m.family_id IN (SELECT id FROM _seed_fams);

-- appointments
INSERT INTO public.appointments (family_id, member_id, title, provider, location, starts_at, ends_at, notes)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id=f.id ORDER BY random() LIMIT 1),
  (ARRAY['Annual physical','Dental cleaning','Eye exam','Orthodontist','Pediatrician','Dermatology','Therapy','Vaccination','Follow-up','Lab work'])[1+(n%10)] || ' #' || n,
  (ARRAY['Dr. Adams','Dr. Chen','Dr. Patel','Dr. Gomez','Dr. Webb'])[1+(n%5)],
  (ARRAY['Main St Clinic','Downtown Medical','Children''s Hospital','Family Dental','Vision Center'])[1+(n%5)],
  now() + ((n-20) || ' days')::interval + interval '9 hours',
  now() + ((n-20) || ' days')::interval + interval '10 hours', 'Auto-seeded appointment'
FROM _seed_fams f, generate_series(1,100) n;

-- ============================================================
-- MEMBER-SCOPED TABLES — 20 rows × 25 members = 500 each
-- ============================================================
CREATE TEMP TABLE _seed_members ON COMMIT DROP AS
  SELECT m.id, m.family_id FROM public.family_members m
  WHERE m.family_id IN (SELECT id FROM _seed_fams);

-- health_metrics
INSERT INTO public.health_metrics (family_id, member_id, type, value, unit, recorded_at)
SELECT sm.family_id, sm.id,
  (ARRAY['steps','sleep_hours','heart_rate','calories','active_minutes','distance','weight','water_cups'])[1+(g%8)]::public.metric_type,
  round((random()*100 + 1)::numeric, 2),
  (ARRAY['count','hours','bpm','kcal','min','mi','lb','cups'])[1+(g%8)],
  now() - ((g) || ' days')::interval
FROM _seed_members sm, generate_series(1,20) g;

-- workout_logs
INSERT INTO public.workout_logs (family_id, member_id, activity, duration_minutes, calories, distance, recorded_at)
SELECT sm.family_id, sm.id,
  (ARRAY['Run','Bike','Swim','Yoga','Soccer','Walk','Strength','HIIT','Dance','Hike'])[1+(g%10)],
  15 + (g*3 % 90), 100 + (g*17 % 600), round((random()*6)::numeric, 2),
  now() - ((g) || ' days')::interval
FROM _seed_members sm, generate_series(1,20) g;

-- school_classes
INSERT INTO public.school_classes (family_id, member_id, subject, teacher, room, time_slot, day_of_week, school_name)
SELECT sm.family_id, sm.id,
  (ARRAY['Math','Science','English','History','Art','PE','Music','Spanish','Biology','Coding'])[1+(g%10)] || ' #' || g,
  (ARRAY['Ms. Lee','Mr. Ortiz','Mrs. Khan','Mr. Davis','Ms. Park'])[1+(g%5)],
  'Room ' || (100 + g), (ARRAY['8:00','9:00','10:00','11:00','13:00'])[1+(g%5)],
  1+(g%5), 'Lincoln School'
FROM _seed_members sm, generate_series(1,20) g;

-- grades
INSERT INTO public.grades (family_id, member_id, subject, title, grade, grade_type, score, max_score, date)
SELECT sm.family_id, sm.id,
  (ARRAY['Math','Science','English','History','Art'])[1+(g%5)],
  'Assessment #' || g,
  (ARRAY['A','A-','B+','B','C'])[1+(g%5)],
  (ARRAY['test','quiz','homework','project','final'])[1+(g%5)]::public.grade_type,
  round((random()*40 + 60)::numeric, 1), 100, (current_date - (g*3))::date
FROM _seed_members sm, generate_series(1,20) g;

-- ============================================================
-- NEW FAMILY-OS MODULE TABLES — 100/family × 5 = 500 each
-- ============================================================

-- family_routines
INSERT INTO public.family_routines (family_id, member_id, title, description, category, time_of_day, days_of_week, status)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id=f.id ORDER BY random() LIMIT 1),
  (ARRAY['Morning checklist','Bedtime routine','Homework hour','Tidy-up','Screen wind-down'])[1+(n%5)] || ' #' || n,
  'Auto-seeded routine', (ARRAY['morning','evening','afternoon'])[1+(n%3)],
  (ARRAY['07:00','20:00','16:00'])[1+(n%3)], ARRAY[1,2,3,4,5], 'active'
FROM _seed_fams f, generate_series(1,100) n;

-- family_memories
INSERT INTO public.family_memories (family_id, member_id, title, body, kind, memory_date, tags, is_favorite)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id=f.id ORDER BY random() LIMIT 1),
  (ARRAY['First day of school','Beach trip','Birthday','Lost a tooth','Won the game','Family reunion','Camping','Recital','Graduation','Road trip'])[1+(n%10)] || ' #' || n,
  'Auto-seeded memory', (ARRAY['photo','quote','trip','achievement','journal','milestone'])[1+(n%6)],
  (current_date - (n*3))::date, ARRAY['family','2026'], (n % 8 = 0)
FROM _seed_fams f, generate_series(1,100) n;

-- family_milestones
INSERT INTO public.family_milestones (family_id, member_id, title, description, milestone_date, category)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id=f.id ORDER BY random() LIMIT 1),
  (ARRAY['First steps','First words','Lost first tooth','Learned to ride a bike','Honor roll'])[1+(n%5)] || ' #' || n,
  'Auto-seeded milestone', (current_date - (n*7))::date, (ARRAY['growth','school','sports','personal'])[1+(n%4)]
FROM _seed_fams f, generate_series(1,100) n;

-- family_ai_recommendations
INSERT INTO public.family_ai_recommendations (family_id, member_id, category, title, body, priority, cta_href, source, status)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id=f.id ORDER BY random() LIMIT 1),
  (ARRAY['schedule','finance','health','school','general'])[1+(n%5)],
  'Recommendation #' || n, 'Auto-seeded AI recommendation body.',
  (ARRAY['low','medium','high'])[1+(n%3)], '/dashboard/family-operations', 'seed',
  (ARRAY['pending','accepted','dismissed','done'])[1+(n%4)]
FROM _seed_fams f, generate_series(1,100) n;

-- family_stress_signals
INSERT INTO public.family_stress_signals (family_id, member_id, signal_type, weight, source, occurred_on, notes)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id=f.id ORDER BY random() LIMIT 1),
  (ARRAY['poor_sleep','off_routine','big_deadline','travel','illness','other'])[1+(n%6)],
  round((random()*3 + 1)::numeric, 2), 'seed', (current_date - (n % 60))::date, 'Auto-seeded signal'
FROM _seed_fams f, generate_series(1,100) n;

-- family_stress_predictions
INSERT INTO public.family_stress_predictions (family_id, for_date, score, level, factors, suggestions)
SELECT f.id, (current_date - 50 + n)::date, (n % 101),
  (ARRAY['low','moderate','elevated','high'])[1+(n%4)],
  '[{"label":"Overloaded day","points":12}]'::jsonb,
  '["Move one flexible item to the weekend."]'::jsonb
FROM _seed_fams f, generate_series(1,100) n;

-- family_automation_rules (100/family) + family_automation_runs (1 per rule)
INSERT INTO public.family_automation_rules (family_id, name, trigger_type, action_type, is_enabled, requires_approval)
SELECT f.id, 'Rule #' || n,
  (ARRAY['task_overdue','chore_missed','appointment_tomorrow','school_project_due','practice_scheduled','bill_due','stress_high','emergency_plan_updated'])[1+(n%8)],
  (ARRAY['send_reminder','create_task','notify_parent','add_calendar_event','create_ai_summary','suggest_reschedule'])[1+(n%6)],
  (n % 4 <> 0), (n % 2 = 0)
FROM _seed_fams f, generate_series(1,100) n;

INSERT INTO public.family_automation_runs (family_id, rule_id, trigger_type, status, summary)
SELECT r.family_id, r.id, r.trigger_type,
  (ARRAY['pending','approved','executed','skipped','failed'])[1+(abs(hashtext(r.id::text))%5)],
  'Run for ' || r.name
FROM public.family_automation_rules r WHERE r.family_id IN (SELECT id FROM _seed_fams);

-- family_knowledge_nodes (100/family) + family_knowledge_edges (100/family)
INSERT INTO public.family_knowledge_nodes (family_id, member_id, node_type, label, weight)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id=f.id ORDER BY random() LIMIT 1),
  (ARRAY['member','task','event','document','health','school','sports','memory','goal','routine'])[1+(n%10)],
  'Node #' || n, round((random()*5 + 1)::numeric, 2)
FROM _seed_fams f, generate_series(1,100) n;

INSERT INTO public.family_knowledge_edges (family_id, source_id, target_id, relation, weight)
SELECT f.id,
  (SELECT id FROM public.family_knowledge_nodes s WHERE s.family_id=f.id ORDER BY random() LIMIT 1),
  (SELECT id FROM public.family_knowledge_nodes t WHERE t.family_id=f.id ORDER BY random() LIMIT 1),
  (ARRAY['owns','assigned_to','related_to','scheduled_for','depends_on','impacts','completed_by'])[1+(n%7)],
  round((random()*3 + 1)::numeric, 2)
FROM _seed_fams f, generate_series(1,100) n;

-- family_emergency_contacts
INSERT INTO public.family_emergency_contacts (family_id, member_id, name, relationship, phone, alt_phone, is_primary, can_pickup, priority)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id=f.id ORDER BY random() LIMIT 1),
  (ARRAY['Grandma Rose','Uncle Joe','Neighbor Pat','Aunt May','Coach Lee'])[1+(n%5)] || ' #' || n,
  (ARRAY['Grandparent','Uncle','Neighbor','Aunt','Coach'])[1+(n%5)],
  '555-' || lpad((n*13 % 10000)::text, 4, '0'), '555-' || lpad((n*29 % 10000)::text, 4, '0'),
  (n % 20 = 0), (n % 3 = 0), 1 + (n % 5)
FROM _seed_fams f, generate_series(1,100) n;

-- family_emergency_plans
INSERT INTO public.family_emergency_plans (family_id, title, plan_type, content, safe_location, instructions, is_active)
SELECT f.id, (ARRAY['Fire evacuation','Severe weather','Medical emergency','Power outage','Lost child'])[1+(n%5)] || ' #' || n,
  (ARRAY['fire','weather','medical','utility','safety'])[1+(n%5)], 'Auto-seeded plan content.',
  (ARRAY['Front driveway','Neighbor''s porch','Garage','Mailbox','School gate'])[1+(n%5)],
  'Stay calm and follow the steps.', (n % 6 <> 0)
FROM _seed_fams f, generate_series(1,100) n;

-- ============================================================
-- UNIQUE-PER-MEMBER TABLES — one row per member (max 25 each)
-- ============================================================

-- family_digital_twin_profiles (UNIQUE family_id, member_id)
INSERT INTO public.family_digital_twin_profiles (family_id, member_id, strengths, ai_insights, stress_baseline)
SELECT sm.family_id, sm.id, 'Organized and dependable', 'Focuses best in the morning; prefers clear routines.', (random()*40)::int
FROM _seed_members sm
ON CONFLICT (family_id, member_id) DO NOTHING;

-- medical_profiles (UNIQUE family_id, member_id) — created by 0009; seed one per member
INSERT INTO public.medical_profiles (family_id, member_id, blood_type, allergies, conditions, emergency_contact_name, emergency_contact_phone)
SELECT sm.family_id, sm.id,
  (ARRAY['O+','A+','B+','AB+','O-'])[1+(abs(hashtext(sm.id::text))%5)],
  (ARRAY['Peanuts','None','Penicillin','Pollen','Lactose'])[1+(abs(hashtext(sm.id::text))%5)],
  (ARRAY['None','Asthma','Eczema','None','ADHD'])[1+(abs(hashtext(sm.id::text))%5)],
  'Emergency Contact', '555-0100'
FROM _seed_members sm
ON CONFLICT (member_id) DO NOTHING;

COMMIT;

-- ============================================================
-- Row-count verification — run after seeding to confirm volumes.
--   SELECT 'calendar_events' t, count(*) FROM public.calendar_events
--   WHERE family_id IN ('11111111-1111-1111-1111-111111111111', ...)
--   UNION ALL ...  (>=500 for every data table above)
-- ============================================================
