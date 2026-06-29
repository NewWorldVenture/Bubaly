-- ============================================================================
-- seed_calendar.sql — 500 realistic calendar_events for testing the Calendar page
-- ----------------------------------------------------------------------------
-- WHAT IT DOES
--   Inserts 500 varied calendar events spread across up to 5 existing families.
--   Covers every event_category, all-day & timed events, every recurrence
--   frequency, assigned & unassigned events, and a date spread of overdue /
--   today / this-week / upcoming / far-future so every state on the Calendar
--   page (week grid, all-day row, Upcoming sidebar, Month dots, agenda) renders.
--
-- TABLE TOUCHED
--   public.calendar_events  (id, family_id, title, description, location,
--   category, starts_at, ends_at, all_day, recurrence, recurrence_until,
--   assignee_id, created_by, created_at, updated_at)
--
-- REQUIREMENTS
--   At least one row in public.families with members in public.family_members.
--   (Locally: run after the base seed, e.g. supabase/seed.sql.)
--
-- IDEMPOTENT
--   Every seeded row is tagged with "[seed:calendar]" in its description; the
--   script deletes those first, so re-running never duplicates. It never touches
--   real (untagged) events.
--
-- HOW TO RUN (local)
--   supabase db reset                       # apply migrations + base seed
--   psql "$LOCAL_DB_URL" -f supabase/seed_calendar.sql
--   -- or paste into the Supabase SQL editor for a dev project (NOT production).
--
-- VERIFY
--   SELECT category, count(*) FROM public.calendar_events
--     WHERE description LIKE '%[seed:calendar]%' GROUP BY 1 ORDER BY 1;
--   -- expect ~500 rows across all 9 categories; open /dashboard/calendar.
-- ============================================================================

DELETE FROM public.calendar_events WHERE description LIKE '%[seed:calendar]%';

DO $$
DECLARE
  v_fams        uuid[];
  v_fam         uuid;
  v_members     uuid[];
  v_creator     uuid;
  v_cat         public.event_category;
  v_cats        public.event_category[] := ARRAY[
                  'general','school','sports','appointment','medication',
                  'maintenance','birthday','holiday','other'
                ]::public.event_category[];
  v_recs        public.recurrence_freq[] := ARRAY[
                  'none','none','none','none','none','weekly','weekly','monthly','yearly'
                ]::public.recurrence_freq[];
  v_rec         public.recurrence_freq;
  v_title       text;
  v_desc        text;
  v_loc         text;
  v_start       timestamptz;
  v_allday      boolean;
  v_dur         interval;
  v_assignee    uuid;
  i             int;
  seeded        int := 0;

  -- Per-category title pools (short, long, and edge-case strings).
  t_general     text[] := ARRAY['Family Day','Movie Night','Game Night','Spring Cleaning','Neighborhood BBQ','Plan the week together over coffee and a long, rambling chat about everything','Trash & Recycling Out'];
  t_school      text[] := ARRAY['Parent-Teacher Conference','Science Fair','Field Trip to the Museum','Report Cards','Back-to-School Night','PTA Meeting','Early Dismissal'];
  t_sports      text[] := ARRAY['Soccer Practice','Soccer Game vs. Westview','Swim Meet','Basketball Tryouts','Track & Field Day','Karate Belt Test','Team Photos'];
  t_appt        text[] := ARRAY['Dentist Appointment','Annual Physical','Eye Exam','Orthodontist','Haircut','Vet Visit for Bella','Therapy Session'];
  t_medication  text[] := ARRAY['Morning Meds','Refill Prescription','Allergy Shot','Vitamin D','Flu Shot','Evening Insulin','Pharmacy Pickup'];
  t_maintenance text[] := ARRAY['HVAC Service','Change Furnace Filter','Lawn Mowing','Car Oil Change','Gutter Cleaning','Smoke Detector Batteries','Water Heater Flush'];
  t_birthday    text[] := ARRAY['Mom''s Birthday','Grandma''s Birthday','Ethan turns 9','Lily''s Birthday Party','Dad''s Birthday','Surprise party — keep it quiet!','Cousin Jake''s Birthday'];
  t_holiday     text[] := ARRAY['Thanksgiving','Winter Break Begins','Memorial Day','Family Reunion','New Year''s Eve','Spring Break','Labor Day Weekend Trip'];
  t_other       text[] := ARRAY['Grocery Shopping','Date Night','Book Club','Volunteer at Shelter','Home Office Day','Pick up dry cleaning','Misc'];

  t_locations   text[] := ARRAY['Lincoln High School','Community Field','Riverside Park','Downtown Grill','At Home','Zoom','123 Main St','Dr. Patel''s Office', NULL, NULL];
BEGIN
  SELECT array_agg(id) INTO v_fams
  FROM (SELECT id FROM public.families ORDER BY created_at LIMIT 5) s;

  IF v_fams IS NULL OR array_length(v_fams, 1) IS NULL THEN
    RAISE NOTICE 'No families found — seed skipped. Run the base seed first.';
    RETURN;
  END IF;

  FOR i IN 1..500 LOOP
    v_fam := v_fams[1 + (i % array_length(v_fams, 1))];

    SELECT array_agg(id) INTO v_members
      FROM public.family_members WHERE family_id = v_fam AND is_active;
    SELECT created_by INTO v_creator FROM public.families WHERE id = v_fam;

    v_cat := v_cats[1 + (i % array_length(v_cats, 1))];

    v_title := CASE v_cat
      WHEN 'general'     THEN t_general[1 + (i % array_length(t_general,1))]
      WHEN 'school'      THEN t_school[1 + (i % array_length(t_school,1))]
      WHEN 'sports'      THEN t_sports[1 + (i % array_length(t_sports,1))]
      WHEN 'appointment' THEN t_appt[1 + (i % array_length(t_appt,1))]
      WHEN 'medication'  THEN t_medication[1 + (i % array_length(t_medication,1))]
      WHEN 'maintenance' THEN t_maintenance[1 + (i % array_length(t_maintenance,1))]
      WHEN 'birthday'    THEN t_birthday[1 + (i % array_length(t_birthday,1))]
      WHEN 'holiday'     THEN t_holiday[1 + (i % array_length(t_holiday,1))]
      ELSE                    t_other[1 + (i % array_length(t_other,1))]
    END;

    -- Date spread: i mod 95 maps to roughly [-30 .. +64] days from today, at a
    -- plausible hour (8am–7pm). Every-7th event is all-day.
    v_allday := (i % 7 = 0) OR v_cat IN ('holiday','birthday');
    v_start := date_trunc('day', now())
               + (((i * 7) % 95) - 30) * interval '1 day'
               + CASE WHEN v_allday THEN interval '0 hour'
                      ELSE (8 + (i % 11)) * interval '1 hour' + (CASE WHEN i % 2 = 0 THEN interval '30 min' ELSE interval '0 min' END)
                 END;

    v_dur := (ARRAY['30 min','1 hour','1 hour','90 min','2 hours']::interval[])[1 + (i % 5)];

    v_rec := v_recs[1 + (i % array_length(v_recs, 1))];

    -- ~30% unassigned; otherwise a real active member of the family.
    IF v_members IS NOT NULL AND array_length(v_members,1) IS NOT NULL AND (i % 10) >= 3 THEN
      v_assignee := v_members[1 + (i % array_length(v_members, 1))];
    ELSE
      v_assignee := NULL;
    END IF;

    -- Some events get long notes, some short, some none (NULL) — but every row
    -- carries the [seed:calendar] tag so the cleanup above stays exact.
    v_desc := CASE (i % 4)
      WHEN 0 THEN 'Quick note. [seed:calendar]'
      WHEN 1 THEN 'Remember to bring everything needed and confirm the time the day before; carpool TBD and weather may shift this outdoors/indoors. [seed:calendar]'
      WHEN 2 THEN '[seed:calendar]'
      ELSE        'Recurring family commitment. [seed:calendar]'
    END;

    v_loc := t_locations[1 + (i % array_length(t_locations, 1))];

    INSERT INTO public.calendar_events
      (family_id, title, description, location, category, starts_at, ends_at,
       all_day, recurrence, recurrence_until, assignee_id, created_by)
    VALUES (
      v_fam,
      v_title,
      v_desc,
      v_loc,
      v_cat,
      v_start,
      CASE WHEN v_allday THEN NULL ELSE v_start + v_dur END,
      v_allday,
      v_rec,
      CASE WHEN v_rec = 'none' THEN NULL ELSE v_start + interval '180 days' END,
      v_assignee,
      v_creator
    );

    seeded := seeded + 1;
  END LOOP;

  RAISE NOTICE 'Seeded % calendar_events across % families.', seeded, array_length(v_fams, 1);
END $$;

-- Quick verification (counts per category):
-- SELECT category, count(*) FROM public.calendar_events
--   WHERE description LIKE '%[seed:calendar]%' GROUP BY 1 ORDER BY 2 DESC;
