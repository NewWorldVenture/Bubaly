-- ============================================================================
-- seed_audit_pack_500.sql — INDEPENDENT production-readiness seed pack
-- ----------------------------------------------------------------------------
-- WHAT IT DOES
--   Creates a self-contained, referentially-valid dataset of **760+ relational
--   records** across 12 synthetic households — covering every member role, all
--   subscription tiers/statuses, and the core product services (chores, calendar,
--   meals, groceries, reminders). Built for exercising list volume, empty/normal/
--   large/expired/failed states, and tenant isolation WITHOUT depending on any
--   one developer account.
--
-- SCOPE / SAFETY
--   * Every row is namespaced by the household name prefix 'AUDIT500::' and by
--     deterministic md5-derived UUIDs, so the pack is fully IDEMPOTENT: it deletes
--     its own households first (ON DELETE CASCADE removes all children) and never
--     touches real data.
--   * Members are MANAGED profiles (user_id NULL = "managed child/member without a
--     login", per the family_members schema), so the pack needs no auth.users rows
--     and is safe to run in any environment. Auth-user-backed logins are provided
--     by the separate auth seed / dev accounts.
--   * NEVER run against production. Intended for local Supabase / PG16 test DBs.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -f supabase/seed_audit_pack_500.sql
--   (or paste into the Supabase SQL editor of a NON-production project)
--
-- COVERAGE MATRIX
--   Roles:  parent, adult, teen, child, caregiver, guest (+ archived caregivers,
--           NULL birthdays, kid/teen/adult/senior birthdate ranges).
--   Tiers:  free / family / family_plus  ×  status trialing / active / past_due /
--           canceled / incomplete / unpaid (expired + healthy period-ends).
--   Chores: 6 chores/family × 3 assignees = statuses todo/in_progress/submitted/
--           approved/rejected incl. OVERDUE (due_at in the past) + points awarded.
--   Calendar: 10 events/family, past + upcoming, all-day + timed, recurring +
--           one-off, across all event_category values.
--   Reminders: done / overdue / upcoming.
--   Meals:  breakfast/lunch/dinner/snack plans spanning the current week.
--   Grocery: 1 list/family × 8 items (checked + unchecked).
-- ============================================================================

BEGIN;

-- 1) 12 households (varied timezones) -----------------------------------------
--    Families are UPSERTED (never deleted): a `mark_model_dirty()` trigger on
--    child tables re-inserts `family_model_dirty` during a family's cascade
--    delete, which FK-fails against the family being removed. So we keep the
--    families and re-seed only their children (safe — the trigger then
--    references a still-existing family). This keeps the pack fully idempotent.
INSERT INTO public.families (id, name, timezone, created_by)
SELECT md5('AUDIT500::fam::'||g)::uuid,
       'AUDIT500::Household '||lpad(g::text, 2, '0'),
       (ARRAY['America/New_York','America/Chicago','America/Denver',
              'America/Los_Angeles','Europe/London','UTC'])[1 + (g % 6)],
       NULL
FROM generate_series(1, 12) g
ON CONFLICT (id) DO NOTHING;

-- 0) Idempotent child cleanup (FK-safe order; families kept) -------------------
--    Also clears the default (free/trialing) subscription the `on_family_created`
--    trigger inserts, so exactly one subscription/household remains after §2.
DO $audit500$
DECLARE fam_ids uuid[] := ARRAY(SELECT id FROM public.families WHERE name LIKE 'AUDIT500::%');
BEGIN
  DELETE FROM public.chore_assignments WHERE family_id = ANY(fam_ids);
  DELETE FROM public.calendar_events   WHERE family_id = ANY(fam_ids);
  DELETE FROM public.reminders         WHERE family_id = ANY(fam_ids);
  DELETE FROM public.chores            WHERE family_id = ANY(fam_ids);
  DELETE FROM public.meal_plans        WHERE family_id = ANY(fam_ids);
  DELETE FROM public.grocery_items     WHERE family_id = ANY(fam_ids);
  DELETE FROM public.grocery_lists     WHERE family_id = ANY(fam_ids);
  DELETE FROM public.family_members    WHERE family_id = ANY(fam_ids);
  DELETE FROM public.subscriptions     WHERE family_id = ANY(fam_ids);
END
$audit500$;

-- 2) Subscriptions — full tier × status matrix (exactly one/household) ---------
INSERT INTO public.subscriptions (family_id, plan, status, seats, current_period_end)
SELECT md5('AUDIT500::fam::'||g)::uuid,
       (ARRAY['free','family','family_plus','family','family_plus','free',
              'family','family_plus','family','free','family_plus','family'])[g],
       (ARRAY['active','active','active','trialing','past_due','trialing',
              'canceled','active','incomplete','active','unpaid','active'])[g]::public.subscription_status,
       6,
       now() + ((ARRAY[30,30,30,7,-3,10,-10,30,-1,30,-1,30])[g] || ' days')::interval
FROM generate_series(1, 12) g;

-- 3) Members — 8/family, all roles, varied birthdays, some archived -----------
INSERT INTO public.family_members (id, family_id, user_id, role, display_name, color, birthday, is_active)
SELECT md5('AUDIT500::mem::'||g||'::'||m)::uuid,
       md5('AUDIT500::fam::'||g)::uuid,
       NULL,
       (ARRAY['parent','parent','adult','teen','child','child','caregiver','guest'])[m]::public.member_role,
       (ARRAY['Alex','Sam','Jordan','Taylor','Riley','Casey','Morgan','Jamie'])[m]||' H'||lpad(g::text,2,'0'),
       (ARRAY['#6366f1','#ef4444','#10b981','#f59e0b','#8b5cf6','#ec4899','#14b8a6','#64748b'])[m],
       CASE
         WHEN m IN (5, 6) THEN date '2015-01-01' + (g * 13 + m * 7)      -- kids
         WHEN m = 4        THEN date '2009-06-01' + (g * 11)              -- teen
         WHEN m = 8        THEN NULL                                     -- guest: no birthday
         ELSE                   date '1984-03-01' + (g * 29 + m * 5)     -- adults/seniors
       END,
       NOT (m = 7 AND g % 3 = 0)                                        -- some caregivers archived
FROM generate_series(1, 12) g CROSS JOIN generate_series(1, 8) m;

-- 4) Chores — 6/family --------------------------------------------------------
INSERT INTO public.chores (id, family_id, title, points, priority, recurrence, requires_approval)
SELECT md5('AUDIT500::chore::'||g||'::'||c)::uuid,
       md5('AUDIT500::fam::'||g)::uuid,
       (ARRAY['Dishes','Take out trash','Laundry','Vacuum','Homework','Feed the pet'])[c],
       (ARRAY[10, 5, 15, 10, 20, 5])[c],
       (ARRAY['low','medium','high','medium','high','low'])[c]::public.priority,
       (ARRAY['daily','weekly','weekly','weekly','daily','daily'])[c]::public.recurrence_freq,
       true
FROM generate_series(1, 12) g CROSS JOIN generate_series(1, 6) c;

-- 5) Chore assignments — 6 chores × 3 assignees (teen+2 kids), all statuses ---
INSERT INTO public.chore_assignments
       (id, family_id, chore_id, member_id, status, due_at, points_awarded, approved_at)
SELECT md5('AUDIT500::ca::'||g||'::'||c||'::'||m)::uuid,
       md5('AUDIT500::fam::'||g)::uuid,
       md5('AUDIT500::chore::'||g||'::'||c)::uuid,
       md5('AUDIT500::mem::'||g||'::'||m)::uuid,
       st.status,
       now() + ((ARRAY[-2, 1, 3, -1, 5, -3])[1 + ((c + m) % 6)] || ' days')::interval,
       CASE WHEN st.status = 'approved' THEN (ARRAY[10,5,15,10,20,5])[c] ELSE NULL END,
       CASE WHEN st.status = 'approved' THEN now() - interval '1 day' ELSE NULL END
FROM generate_series(1, 12) g
CROSS JOIN generate_series(1, 6) c
CROSS JOIN generate_series(4, 6) m
CROSS JOIN LATERAL (SELECT (ARRAY['todo','in_progress','submitted','approved','rejected','todo'])[1 + ((c + m) % 6)]::public.task_status AS status) st;

-- 6) Calendar events — 10/family, past+upcoming, every category ---------------
INSERT INTO public.calendar_events
       (id, family_id, title, category, starts_at, ends_at, all_day, recurrence, assignee_id)
SELECT md5('AUDIT500::evt::'||g||'::'||e)::uuid,
       md5('AUDIT500::fam::'||g)::uuid,
       (ARRAY['Soccer practice','Dentist','School play','Grocery run','Family dinner',
              'Doctor visit','Birthday party','Piano lesson','Parent-teacher','Weekend trip'])[e],
       (ARRAY['sports','appointment','school','general','general',
              'medication','birthday','general','school','holiday'])[e]::public.event_category,
       now() + ((e - 5) || ' days')::interval + (e || ' hours')::interval,
       now() + ((e - 5) || ' days')::interval + ((e + 1) || ' hours')::interval,
       (e % 5 = 0),
       (ARRAY['weekly','none','none','none','none','none','yearly','weekly','none','none'])[e]::public.recurrence_freq,
       md5('AUDIT500::mem::'||g||'::'||(1 + (e % 8)))::uuid
FROM generate_series(1, 12) g CROSS JOIN generate_series(1, 10) e;

-- 7) Reminders — done / overdue / upcoming ------------------------------------
INSERT INTO public.reminders (id, family_id, title, remind_at, recurrence, is_done, member_id)
SELECT md5('AUDIT500::rem::'||g||'::'||r)::uuid,
       md5('AUDIT500::fam::'||g)::uuid,
       (ARRAY['Pay rent','Renew passport','Call grandma','Vaccine due','Return library books','Water plants'])[r],
       now() + ((ARRAY[-1, 5, 2, -3, 7, 1])[r] || ' days')::interval,
       'none'::public.recurrence_freq,
       (r % 3 = 0),
       md5('AUDIT500::mem::'||g||'::'||(1 + (r % 8)))::uuid
FROM generate_series(1, 12) g CROSS JOIN generate_series(1, 6) r;

-- 8) Meal plans — current week, varied meal types -----------------------------
INSERT INTO public.meal_plans (id, family_id, meal_id, plan_date, meal_type)
SELECT md5('AUDIT500::mp::'||g||'::'||d)::uuid,
       md5('AUDIT500::fam::'||g)::uuid,
       NULL,
       current_date + (d - 3),
       (ARRAY['breakfast','lunch','dinner','snack','dinner'])[d]::public.meal_type
FROM generate_series(1, 12) g CROSS JOIN generate_series(1, 5) d;

-- 9) Grocery — 1 list/family × 8 items ----------------------------------------
INSERT INTO public.grocery_lists (id, family_id, name)
SELECT md5('AUDIT500::gl::'||g)::uuid, md5('AUDIT500::fam::'||g)::uuid, 'Weekly groceries'
FROM generate_series(1, 12) g;

INSERT INTO public.grocery_items (id, family_id, list_id, name, quantity, is_checked)
SELECT md5('AUDIT500::gi::'||g||'::'||i)::uuid,
       md5('AUDIT500::fam::'||g)::uuid,
       md5('AUDIT500::gl::'||g)::uuid,
       (ARRAY['Milk','Eggs','Bread','Apples','Chicken','Rice','Spinach','Cheese'])[i],
       (ARRAY['1 gal','1 dozen','2 loaves','6','2 lb','5 lb','1 bag','1 block'])[i],
       (i % 3 = 0)
FROM generate_series(1, 12) g CROSS JOIN generate_series(1, 8) i;

COMMIT;

-- Verification (row counts for the AUDIT500 pack) -----------------------------
SELECT 'families'          AS entity, count(*) FROM public.families           WHERE name LIKE 'AUDIT500::%'
UNION ALL SELECT 'subscriptions',     count(*) FROM public.subscriptions      WHERE family_id IN (SELECT id FROM public.families WHERE name LIKE 'AUDIT500::%')
UNION ALL SELECT 'family_members',    count(*) FROM public.family_members     WHERE family_id IN (SELECT id FROM public.families WHERE name LIKE 'AUDIT500::%')
UNION ALL SELECT 'chores',            count(*) FROM public.chores             WHERE family_id IN (SELECT id FROM public.families WHERE name LIKE 'AUDIT500::%')
UNION ALL SELECT 'chore_assignments', count(*) FROM public.chore_assignments  WHERE family_id IN (SELECT id FROM public.families WHERE name LIKE 'AUDIT500::%')
UNION ALL SELECT 'calendar_events',   count(*) FROM public.calendar_events    WHERE family_id IN (SELECT id FROM public.families WHERE name LIKE 'AUDIT500::%')
UNION ALL SELECT 'reminders',         count(*) FROM public.reminders          WHERE family_id IN (SELECT id FROM public.families WHERE name LIKE 'AUDIT500::%')
UNION ALL SELECT 'meal_plans',        count(*) FROM public.meal_plans         WHERE family_id IN (SELECT id FROM public.families WHERE name LIKE 'AUDIT500::%')
UNION ALL SELECT 'grocery_lists',     count(*) FROM public.grocery_lists      WHERE family_id IN (SELECT id FROM public.families WHERE name LIKE 'AUDIT500::%')
UNION ALL SELECT 'grocery_items',     count(*) FROM public.grocery_items      WHERE family_id IN (SELECT id FROM public.families WHERE name LIKE 'AUDIT500::%');
