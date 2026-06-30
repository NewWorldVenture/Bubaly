-- ============================================================
-- FamilyOS :: seed_planning.sql — demo data for /dashboard/planning
--
-- The Planning & Organization hub previews 8 domains. Calendar / Tasks /
-- Reminders / Family-Wall photos are seeded by seed_home.sql; THIS file fills the
-- four planning-specific tables the hub reads that those don't cover:
--   • notes            — 24/family   = 120
--   • documents        — 24/family   = 120
--   • family_contacts  — 26/family   = 130
--   • family_milestones— 26/family   = 130
--   TOTAL = 500 rows across 4 tables for the 5 demo families.
--
-- Run seed.sql first (creates the 5 demo families + 25 members). For a fully
-- populated hub, also run seed_home.sql (calendar/tasks/reminders/photos):
--   psql "$DATABASE_URL" -f supabase/seed.sql -f supabase/seed_home.sql -f supabase/seed_planning.sql
--   (or: npm run seed:planning ; or paste into the Supabase SQL Editor)
--
-- Covers required states: pinned/unpinned notes, null titles, long bodies;
-- documents with future/past/null expiry and varied categories/mime types;
-- emergency & non-emergency contacts across every allowed category with
-- birthdays; past (completed) and upcoming milestones across categories.
--
-- SAFETY: idempotent + pooler-safe (no temp tables / no BEGIN-COMMIT). Scoped to
-- the 5 demo family ids only (which exist solely for seeding), so it clears those
-- families' rows in these tables and re-inserts — safe to re-run and never
-- touches real/production families.
-- ============================================================

-- ── Idempotency: clear demo-family rows in the four planning tables ──
delete from public.notes             where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');
delete from public.documents         where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');
delete from public.family_contacts   where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');
delete from public.family_milestones where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ── notes (24/family = 120) ──
insert into public.notes (family_id, title, body, is_pinned, checklist)
select f.id,
       case when n % 5 = 0 then null    -- null titles (null handling)
            else (array['Vacation Ideas','Grocery List','Project Plan','Family Meeting Notes',
                        'Book Recommendations','Daily Gratitude','School Project Ideas','Workout Plan',
                        'Weekend Plans','Recipe to Try','Home Projects','Gift Ideas'])[1+(n%12)] end,
       case when n % 9 = 0
            then 'A longer note to test wrapping: ' || repeat('plan ahead, stay organized, and keep the whole family in sync. ', 6)
            else (array['Top places for our summer vacation.','Milk, eggs, bread, chicken, rice.',
                        'Q2 marketing campaign strategy.','Discussed budget, vacation, and chores.',
                        'The 5 Love Languages; Atomic Habits.','Grateful for a beautiful day with family.',
                        'Volcano model; solar system presentation.','Mon: chest. Tue: back. Wed: legs.'])[1+(n%8)] end,
       (n % 7 = 0),
       case when n % 6 = 0 then '[{"text":"First item","done":true},{"text":"Second item","done":false}]'::jsonb else null end
from public.families f
cross join generate_series(1,24) as n
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ── documents (24/family = 120) ──
insert into public.documents (family_id, title, category, storage_path, mime_type, size_bytes, expires_at)
select f.id,
       (array['Passport','School Report Card','Summer Vacation Itinerary','House Insurance Policy',
              'Q2 Budget','Family Photo','Dance Recital Video','Auto Insurance Policy','Medical Records',
              'Home Warranty'])[1+(n%10)] || ' #' || n,
       (array['legal','school','travel','insurance','finance','photos','videos','insurance','medical','home'])[1+(n%10)],
       'documents/' || f.id || '/' || n || '.bin',
       (array['application/pdf','application/pdf','image/jpeg','video/mp4','application/vnd.ms-excel'])[1+(n%5)],
       (array[1200000,2400000,856000,1800000,46000,3100000])[1+(n%6)],
       case (n % 4)
         when 0 then null                              -- no expiry (null handling)
         when 1 then (current_date + (60 + n))::date   -- future
         when 2 then (current_date - (n % 90))::date   -- expired
         else (current_date + 365)::date
       end
from public.families f
cross join generate_series(1,24) as n
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ── family_contacts (26/family = 130) ──
insert into public.family_contacts (family_id, name, relationship, category, phone, email, is_emergency, birthday_month, birthday_day, organization, specialty, notes)
select f.id,
       (array['Daniel Parker','Jessica Parker','Michael Parker','Emily Parker','Sophia Parker',
              'Grandma Linda','Coach Mike','Dr. Alvarez','Ms. Bennett','Sam the Neighbor',
              'Aunt Carol','Uncle Joe','Riley''s Friend'])[1+(n%13)] || ' ' || n,
       (array['Dad','Mom','Son','Daughter','Daughter','Grandparent','Coach','Doctor','Teacher','Neighbor','Aunt','Uncle','Friend'])[1+(n%13)],
       (array['family','family','family','family','family','family','coach','doctor','teacher','neighbor','family','family','friend'])[1+(n%13)],
       '(555) ' || lpad(((100 + n) % 900 + 100)::text, 3, '0') || '-' || lpad(((n * 37) % 9000 + 1000)::text, 4, '0'),
       lower(replace((array['daniel','jessica','michael','emily','sophia','linda','mike','alvarez','bennett','sam','carol','joe','riley'])[1+(n%13)], ' ', '')) || n || '@example.com',
       (n % 9 = 0),
       1 + (n % 12),
       1 + (n % 28),
       case when n % 5 = 0 then (array['Lincoln High','City Clinic','Soccer Club','Maple Elementary'])[1+(n%4)] else null end,
       case when n % 7 = 0 then (array['Pediatrics','Orthodontics','Coaching','Mathematics'])[1+(n%4)] else null end,
       case when n % 6 = 0 then 'Primary emergency contact for the kids during school hours.' else null end
from public.families f
cross join generate_series(1,26) as n
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ── family_milestones (26/family = 130) ──
insert into public.family_milestones (family_id, title, description, milestone_date, category, status, member_id)
select f.id,
       (array['Emily''s Birthday','Wedding Anniversary','Michael''s Soccer Tournament','Sophia''s Birthday',
              'End of School Year','Vacation: Florida','Independence Day','First Day of School','Graduation',
              'Family Reunion'])[1+(n%10)],
       case when n % 4 = 0 then null else 'A milestone worth remembering and planning around.' end,
       case when n % 3 = 0 then (current_date - (n % 120))::date   -- past (completed)
            else (current_date + (n % 180))::date end,             -- upcoming
       (array['birthday','anniversary','sports','birthday','school','vacation','holiday','school','school','family'])[1+(n%10)],
       case when n % 3 = 0 then 'completed' else 'upcoming' end,
       (select id from public.family_members m where m.family_id=f.id order by random() limit 1)
from public.families f
cross join generate_series(1,26) as n
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ============================================================
-- Done. 500 rows across notes / documents / family_contacts / family_milestones
-- for the 5 demo families. Re-runnable. Verify (optional):
--   select 'notes' t, count(*) from public.notes where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555')
--   union all select 'documents', count(*) from public.documents where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555')
--   union all select 'contacts', count(*) from public.family_contacts where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555')
--   union all select 'milestones', count(*) from public.family_milestones where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');
-- ============================================================
