-- Comprehensive 500+ record seed file for Bubaly
-- Creates realistic test data across all major features
-- Idempotent: safe to run multiple times
-- RLS-scoped: all data properly family-scoped

BEGIN;

-- ===== SETUP: DISABLE CONSTRAINT TRIGGERS =====
SET session_replication_role = REPLICA;

-- ===== CLEANUP: DELETE EXISTING SEED DATA =====
-- Only delete families created by this seed (with distinctive names)
DELETE FROM families WHERE name IN ('Seed Family 1', 'Seed Family 2', 'Seed Family 3', 'Seed Family 4', 'Seed Family 5');

SET session_replication_role = DEFAULT;

-- ===== CREATE: 5 FAMILIES WITH MEMBERS =====
WITH family_data AS (
  INSERT INTO families (name, timezone, created_by)
  VALUES
    ('Seed Family 1', 'America/New_York', auth.uid()),
    ('Seed Family 2', 'America/Los_Angeles', auth.uid()),
    ('Seed Family 3', 'America/Chicago', auth.uid()),
    ('Seed Family 4', 'Europe/London', auth.uid()),
    ('Seed Family 5', 'Australia/Sydney', auth.uid())
  RETURNING id, name
)
INSERT INTO family_members (family_id, user_id, display_name, role, created_by)
SELECT
  f.id,
  CASE
    WHEN m.member_num = 1 THEN auth.uid()
    ELSE NULL
  END,
  CASE
    WHEN m.member_num = 1 THEN 'Parent 1'
    WHEN m.member_num = 2 THEN 'Parent 2'
    WHEN m.member_num = 3 THEN 'Teen Child'
    WHEN m.member_num = 4 THEN 'Younger Child'
    ELSE 'Family Member'
  END,
  CASE
    WHEN m.member_num <= 2 THEN 'parent'
    WHEN m.member_num = 3 THEN 'teen'
    ELSE 'child'
  END,
  auth.uid()
FROM family_data f
CROSS JOIN (SELECT generate_series(1, 4) AS member_num) m;

-- ===== CREATE: CALENDAR EVENTS (300 records) =====
INSERT INTO calendar_events (family_id, title, description, event_date, time_start, time_end, created_by)
SELECT
  f.id,
  CASE (e.event_type)
    WHEN 1 THEN 'School Day'
    WHEN 2 THEN 'Soccer Practice'
    WHEN 3 THEN 'Family Dinner'
    WHEN 4 THEN 'Doctor Appointment'
    WHEN 5 THEN 'Movie Night'
    WHEN 6 THEN 'Birthday Party'
    WHEN 7 THEN 'Work Meeting'
    WHEN 8 THEN 'Piano Lesson'
    WHEN 9 THEN 'Grocery Shopping'
    ELSE 'Team Event'
  END,
  'Auto-generated seed event ' || (e.num),
  CURRENT_DATE + (e.num % 60) DAYS,
  TO_TIMESTAMP('09:00', 'HH24:MI')::TIME,
  TO_TIMESTAMP('10:00', 'HH24:MI')::TIME,
  auth.uid()
FROM families f,
     LATERAL (SELECT generate_series(1, 60) AS num, ((generate_series(1, 60) - 1) % 10 + 1) AS event_type) e
WHERE f.name LIKE 'Seed Family%';

-- ===== CREATE: TODOS (200 records) =====
INSERT INTO todo_items (family_id, title, description, is_done, priority, created_by)
SELECT
  f.id,
  CASE (t.priority_type)
    WHEN 1 THEN 'Finish homework'
    WHEN 2 THEN 'Clean bedroom'
    WHEN 3 THEN 'Call grandma'
    WHEN 4 THEN 'Fix bike'
    WHEN 5 THEN 'Organize files'
    WHEN 6 THEN 'Plan weekend'
    WHEN 7 THEN 'Update resume'
    WHEN 8 THEN 'Schedule doctor visit'
    ELSE 'Review budget'
  END,
  'Auto-generated todo item',
  (t.num % 3 = 0),  -- Mark ~1/3 as done
  CASE (t.num % 3)
    WHEN 0 THEN 'high'
    WHEN 1 THEN 'medium'
    ELSE 'low'
  END,
  auth.uid()
FROM families f,
     LATERAL (SELECT generate_series(1, 40) AS num, ((generate_series(1, 40) - 1) % 9 + 1) AS priority_type) t
WHERE f.name LIKE 'Seed Family%';

-- ===== CREATE: GROCERY LISTS & ITEMS (120+ records) =====
WITH grocery_lists_data AS (
  INSERT INTO grocery_lists (family_id, name, created_by)
  SELECT f.id, 'Weekly Groceries', auth.uid()
  FROM families f
  WHERE f.name LIKE 'Seed Family%'
  RETURNING id, family_id
)
INSERT INTO grocery_items (list_id, family_id, name, category, is_checked, created_by)
SELECT
  gl.id,
  gl.family_id,
  CASE (gi.item_type)
    WHEN 1 THEN 'Apples'
    WHEN 2 THEN 'Milk'
    WHEN 3 THEN 'Bread'
    WHEN 4 THEN 'Eggs'
    WHEN 5 THEN 'Chicken'
    WHEN 6 THEN 'Broccoli'
    WHEN 7 THEN 'Pasta'
    WHEN 8 THEN 'Cheese'
    WHEN 9 THEN 'Yogurt'
    WHEN 10 THEN 'Coffee'
    WHEN 11 THEN 'Juice'
    WHEN 12 THEN 'Cereal'
    ELSE 'Snacks'
  END,
  CASE (gi.item_type)
    WHEN 1 THEN 'Produce'
    WHEN 2 THEN 'Dairy & Eggs'
    WHEN 3 THEN 'Pantry'
    WHEN 4 THEN 'Dairy & Eggs'
    WHEN 5 THEN 'Meat & Seafood'
    WHEN 6 THEN 'Produce'
    WHEN 7 THEN 'Pantry'
    WHEN 8 THEN 'Dairy & Eggs'
    WHEN 9 THEN 'Dairy & Eggs'
    WHEN 10 THEN 'Beverages'
    WHEN 11 THEN 'Beverages'
    WHEN 12 THEN 'Pantry'
    ELSE 'Other'
  END,
  (gi.num % 4 = 0),  -- Mark ~25% as checked
  auth.uid()
FROM grocery_lists_data gl,
     LATERAL (SELECT generate_series(1, 25) AS num, ((generate_series(1, 25) - 1) % 12 + 1) AS item_type) gi;

-- ===== CREATE: MEDICATIONS (50+ records) =====
INSERT INTO medications (family_id, member_id, name, dosage, frequency, reason, created_by)
SELECT
  f.id,
  fm.id,
  CASE (m.med_type)
    WHEN 1 THEN 'Vitamin D'
    WHEN 2 THEN 'Allergy Medicine'
    WHEN 3 THEN 'Insulin'
    WHEN 4 THEN 'Blood Pressure Med'
    WHEN 5 THEN 'Asthma Inhaler'
    ELSE 'Other Medication'
  END,
  '10mg',
  CASE (m.med_type)
    WHEN 1 THEN 'daily'
    WHEN 2 THEN 'as_needed'
    ELSE 'twice_daily'
  END,
  'Health maintenance',
  auth.uid()
FROM families f
CROSS JOIN family_members fm
CROSS JOIN (SELECT generate_series(1, 5) AS member_num, generate_series(1, 5) AS med_type) m
WHERE f.name LIKE 'Seed Family%'
AND fm.display_name NOT LIKE '%Parent%'
LIMIT 50;

-- ===== CREATE: CONTACTS (60+ records) =====
INSERT INTO contacts (family_id, first_name, last_name, email, phone, relationship, created_by)
SELECT
  f.id,
  CASE (c.contact_type)
    WHEN 1 THEN 'Dr.'
    WHEN 2 THEN 'Coach'
    WHEN 3 THEN 'Teacher'
    WHEN 4 THEN 'Friend'
    WHEN 5 THEN 'Relative'
    ELSE 'Other'
  END,
  'Contact ' || (c.num),
  'contact' || (c.num) || '@example.com',
  '555-' || LPAD(c.num::TEXT, 4, '0'),
  CASE (c.contact_type)
    WHEN 1 THEN 'doctor'
    WHEN 2 THEN 'coach'
    WHEN 3 THEN 'teacher'
    WHEN 4 THEN 'friend'
    WHEN 5 THEN 'family'
    ELSE 'other'
  END,
  auth.uid()
FROM families f,
     LATERAL (SELECT generate_series(1, 12) AS num, ((generate_series(1, 12) - 1) % 5 + 1) AS contact_type) c
WHERE f.name LIKE 'Seed Family%';

-- ===== CREATE: NOTES (80+ records) =====
INSERT INTO notes (family_id, title, body, created_by)
SELECT
  f.id,
  'Note ' || (n.num),
  'This is a test note with some content. Auto-generated for seed data testing.',
  auth.uid()
FROM families f,
     LATERAL (SELECT generate_series(1, 16) AS num) n
WHERE f.name LIKE 'Seed Family%';

-- ===== CREATE: PHOTOS (100+ records) =====
INSERT INTO family_photos (family_id, uploaded_by, caption)
SELECT
  f.id,
  auth.uid(),
  'Photo ' || (p.num)
FROM families f,
     LATERAL (SELECT generate_series(1, 20) AS num) p
WHERE f.name LIKE 'Seed Family%';

-- ===== CREATE: INSURANCE POLICIES (25+ records) =====
INSERT INTO family_insurance_policies (family_id, policy_type, insurer, policy_number, premium_amount, premium_frequency, effective_date, created_by)
SELECT
  f.id,
  CASE (i.policy_type % 4)
    WHEN 0 THEN 'health'
    WHEN 1 THEN 'auto'
    WHEN 2 THEN 'home'
    ELSE 'life'
  END,
  'Insurance Company ' || (i.policy_type),
  'POL-' || LPAD(i.policy_type::TEXT, 6, '0'),
  (100 + i.policy_type * 50) * 100,  -- in cents
  CASE (i.policy_type % 3)
    WHEN 0 THEN 'monthly'
    WHEN 1 THEN 'annual'
    ELSE 'quarterly'
  END,
  CURRENT_DATE - (365 DAYS),
  auth.uid()
FROM families f,
     LATERAL (SELECT generate_series(1, 5) AS policy_type) i
WHERE f.name LIKE 'Seed Family%';

-- ===== CREATE: GOALS (30+ records) =====
INSERT INTO goals (family_id, member_id, title, target_value, unit, created_by)
SELECT
  f.id,
  fm.id,
  CASE (g.goal_type)
    WHEN 1 THEN 'Read 20 books this year'
    WHEN 2 THEN 'Exercise 3x per week'
    WHEN 3 THEN 'Save money for vacation'
    WHEN 4 THEN 'Learn new skill'
    WHEN 5 THEN 'Improve grades'
    ELSE 'Get fit'
  END,
  100,
  CASE (g.goal_type)
    WHEN 1 THEN 'books'
    WHEN 2 THEN 'workouts'
    WHEN 3 THEN 'dollars'
    WHEN 4 THEN 'hours'
    ELSE 'points'
  END,
  auth.uid()
FROM families f
CROSS JOIN family_members fm
CROSS JOIN (SELECT generate_series(1, 3) AS goal_type) g
WHERE f.name LIKE 'Seed Family%'
LIMIT 30;

-- ===== CREATE: BEHAVIOR LOGS (60+ records) =====
INSERT INTO behavior_logs (family_id, member_id, category, kind, points, created_by)
SELECT
  f.id,
  fm.id,
  CASE (b.cat % 4)
    WHEN 0 THEN 'communication'
    WHEN 1 THEN 'responsibility'
    WHEN 2 THEN 'attitude'
    ELSE 'kindness'
  END,
  CASE (b.kind % 2)
    WHEN 0 THEN 'positive'
    ELSE 'concern'
  END,
  (CASE WHEN b.kind % 2 = 0 THEN 5 ELSE -3 END),
  auth.uid()
FROM families f
CROSS JOIN family_members fm
CROSS JOIN (SELECT generate_series(1, 12) AS cat, generate_series(1, 12) AS kind) b
WHERE f.name LIKE 'Seed Family%'
AND fm.display_name NOT LIKE '%Parent%'
LIMIT 60;

-- ===== CREATE: SUBSCRIPTIONS (20+ records) =====
INSERT INTO subscriptions_tracked (family_id, name, category, amount_cents, frequency, next_billing_date, created_by)
SELECT
  f.id,
  CASE (s.sub_type)
    WHEN 1 THEN 'Streaming Service'
    WHEN 2 THEN 'Magazine'
    WHEN 3 THEN 'Gym Membership'
    WHEN 4 THEN 'Software License'
    WHEN 5 THEN 'Cloud Storage'
    ELSE 'Other Service'
  END,
  CASE (s.sub_type)
    WHEN 1 THEN 'entertainment'
    WHEN 2 THEN 'media'
    WHEN 3 THEN 'fitness'
    WHEN 4 THEN 'software'
    ELSE 'services'
  END,
  (CASE s.sub_type
    WHEN 1 THEN 1499
    WHEN 2 THEN 999
    WHEN 3 THEN 4999
    ELSE 2499
  END),
  CASE (s.sub_type % 2)
    WHEN 0 THEN 'monthly'
    ELSE 'annual'
  END,
  CURRENT_DATE + (30 DAYS),
  auth.uid()
FROM families f,
     LATERAL (SELECT generate_series(1, 4) AS sub_type) s
WHERE f.name LIKE 'Seed Family%';

-- ===== CREATE: TAX DOCUMENTS (30+ records) =====
INSERT INTO tax_documents (family_id, tax_year, category, name, amount_cents, created_by)
SELECT
  f.id,
  EXTRACT(YEAR FROM CURRENT_DATE)::INT,
  CASE (td.cat % 5)
    WHEN 0 THEN 'receipt'
    WHEN 1 THEN 'invoice'
    WHEN 2 THEN 'w2'
    WHEN 3 THEN '1099'
    ELSE 'other'
  END,
  'Document ' || (td.num),
  (100 + td.num * 50) * 100,  -- in cents
  auth.uid()
FROM families f,
     LATERAL (SELECT generate_series(1, 6) AS num, generate_series(1, 6) AS cat) td
WHERE f.name LIKE 'Seed Family%';

-- ===== CREATE: UTILITY BILLS (50+ records) =====
INSERT INTO utility_bills (family_id, kind, amount_cents, period_month, created_by)
SELECT
  f.id,
  CASE (ub.kind % 4)
    WHEN 0 THEN 'electric'
    WHEN 1 THEN 'water'
    WHEN 2 THEN 'gas'
    ELSE 'internet'
  END,
  (50 + ub.kind * 25) * 100,  -- in cents
  DATE_TRUNC('month', CURRENT_DATE - (ub.num DAYS))::DATE,
  auth.uid()
FROM families f,
     LATERAL (SELECT generate_series(1, 10) AS num, generate_series(1, 10) AS kind) ub
WHERE f.name LIKE 'Seed Family%';

-- ===== CREATE: FAMILY ANNOUNCEMENTS (40+ records) =====
INSERT INTO announcements (family_id, title, content, is_pinned, created_by)
SELECT
  f.id,
  'Announcement ' || (a.num),
  'This is an important family announcement. Lorem ipsum dolor sit amet.',
  (a.num % 5 = 0),  -- Pin ~20%
  auth.uid()
FROM families f,
     LATERAL (SELECT generate_series(1, 8) AS num) a
WHERE f.name LIKE 'Seed Family%';

-- ===== CREATE: FAMILY POLLS (20+ records) =====
INSERT INTO family_polls (family_id, question, kind, created_by)
SELECT
  f.id,
  CASE (p.poll_type % 4)
    WHEN 0 THEN 'Where should we go for vacation?'
    WHEN 1 THEN 'What should we have for dinner?'
    WHEN 2 THEN 'What movie should we watch?'
    ELSE 'What game should we play?'
  END,
  CASE (p.poll_type % 2)
    WHEN 0 THEN 'single'
    ELSE 'multi'
  END,
  auth.uid()
FROM families f,
     LATERAL (SELECT generate_series(1, 4) AS poll_type) p
WHERE f.name LIKE 'Seed Family%';

-- ===== CREATE: POLL OPTIONS (80+ records) =====
WITH poll_data AS (
  SELECT id, family_id FROM family_polls WHERE family_id IN (SELECT id FROM families WHERE name LIKE 'Seed Family%')
)
INSERT INTO family_poll_options (poll_id, family_id, label, sort)
SELECT
  pd.id,
  pd.family_id,
  CASE (po.opt_num)
    WHEN 1 THEN 'Option A'
    WHEN 2 THEN 'Option B'
    WHEN 3 THEN 'Option C'
    ELSE 'Option D'
  END,
  po.opt_num
FROM poll_data pd,
     LATERAL (SELECT generate_series(1, 4) AS opt_num) po;

-- ===== CREATE: POLL VOTES (100+ records) =====
WITH poll_option_data AS (
  SELECT id, poll_id, family_id FROM family_poll_options WHERE family_id IN (SELECT id FROM families WHERE name LIKE 'Seed Family%')
),
member_data AS (
  SELECT id, family_id FROM family_members WHERE family_id IN (SELECT id FROM families WHERE name LIKE 'Seed Family%')
)
INSERT INTO family_poll_votes (poll_id, option_id, family_id, member_id)
SELECT
  pod.poll_id,
  pod.id,
  pod.family_id,
  md.id
FROM poll_option_data pod
CROSS JOIN member_data md
WHERE pod.family_id = md.family_id
AND RANDOM() < 0.5;  -- ~50% vote

-- ===== CREATE: SHOPPING LISTS (20+ records) =====
INSERT INTO grocery_lists (family_id, name, created_by)
SELECT
  f.id,
  CASE (sl.list_type)
    WHEN 1 THEN 'Costco'
    WHEN 2 THEN 'Target'
    WHEN 3 THEN 'Hardware Store'
    ELSE 'Farmers Market'
  END,
  auth.uid()
FROM families f,
     LATERAL (SELECT generate_series(1, 4) AS list_type) sl
WHERE f.name LIKE 'Seed Family%';

-- ===== CREATE: REWARDS/POINTS (40+ records) =====
INSERT INTO points_transactions (family_id, member_id, points, reason, created_by)
SELECT
  f.id,
  fm.id,
  CASE (pt.reason_type % 3)
    WHEN 0 THEN 50
    WHEN 1 THEN 100
    ELSE 25
  END,
  CASE (pt.reason_type % 3)
    WHEN 0 THEN 'Chore completed'
    WHEN 1 THEN 'Good behavior'
    ELSE 'Bonus'
  END,
  auth.uid()
FROM families f
CROSS JOIN family_members fm
CROSS JOIN (SELECT generate_series(1, 8) AS reason_type) pt
WHERE f.name LIKE 'Seed Family%'
AND fm.display_name NOT LIKE '%Parent%'
LIMIT 40;

-- ===== VERIFY DATA =====
SELECT 'Families created: ' || COUNT(*) FROM families WHERE name LIKE 'Seed Family%' UNION ALL
SELECT 'Members created: ' || COUNT(*) FROM family_members fm
  INNER JOIN families f ON f.id = fm.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Events created: ' || COUNT(*) FROM calendar_events ce
  INNER JOIN families f ON f.id = ce.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Todos created: ' || COUNT(*) FROM todo_items ti
  INNER JOIN families f ON f.id = ti.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Grocery items created: ' || COUNT(*) FROM grocery_items gi
  INNER JOIN families f ON f.id = gi.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Medications created: ' || COUNT(*) FROM medications m
  INNER JOIN families f ON f.id = m.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Contacts created: ' || COUNT(*) FROM contacts c
  INNER JOIN families f ON f.id = c.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Notes created: ' || COUNT(*) FROM notes n
  INNER JOIN families f ON f.id = n.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Photos created: ' || COUNT(*) FROM family_photos fp
  INNER JOIN families f ON f.id = fp.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Insurance policies created: ' || COUNT(*) FROM family_insurance_policies fip
  INNER JOIN families f ON f.id = fip.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Goals created: ' || COUNT(*) FROM goals g
  INNER JOIN families f ON f.id = g.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Behavior logs created: ' || COUNT(*) FROM behavior_logs bl
  INNER JOIN families f ON f.id = bl.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Subscriptions created: ' || COUNT(*) FROM subscriptions_tracked st
  INNER JOIN families f ON f.id = st.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Tax documents created: ' || COUNT(*) FROM tax_documents td
  INNER JOIN families f ON f.id = td.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Utility bills created: ' || COUNT(*) FROM utility_bills ub
  INNER JOIN families f ON f.id = ub.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Announcements created: ' || COUNT(*) FROM announcements a
  INNER JOIN families f ON f.id = a.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Polls created: ' || COUNT(*) FROM family_polls fp2
  INNER JOIN families f ON f.id = fp2.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Poll votes created: ' || COUNT(*) FROM family_poll_votes fpv
  INNER JOIN families f ON f.id = fpv.family_id
  WHERE f.name LIKE 'Seed Family%' UNION ALL
SELECT 'Points transactions created: ' || COUNT(*) FROM points_transactions pt
  INNER JOIN families f ON f.id = pt.family_id
  WHERE f.name LIKE 'Seed Family%';

COMMIT;
