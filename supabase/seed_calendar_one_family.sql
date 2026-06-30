-- ============================================================================
-- seed_calendar_one_family.sql — 500 calendar_events per family for ONE user.
-- Production-safe variant of seed_calendar.sql: it resolves the target USER by
-- email and seeds ONLY the families that user is an ACTIVE member of, so it
-- never touches other customers' calendars.
--
-- WHY "every active family": the app picks the active family as
-- user_preferences.active_family_id IF set, else the FIRST family_members row
-- (lib/supabase/auth.ts) — it never uses families.created_by. Seeding ALL of
-- the user's active families guarantees the one the calendar page actually
-- shows is populated, regardless of which resolution wins.
--
-- TARGET: change the email on the next line if needed.
-- IDEMPOTENT: rows are tagged [seed:calendar] and deleted before insert (only
-- within the target user's families).
-- ============================================================================

DO $$
DECLARE
  v_email    text := 'newworldventurellc@gmail.com';   -- <-- target user
  v_uid      uuid;
  v_fam      uuid;
  v_members  uuid[];
  v_creator  uuid;
  v_cat      public.event_category;
  v_cats     public.event_category[] := ARRAY['general','school','sports','appointment','medication','maintenance','birthday','holiday','other']::public.event_category[];
  v_recs     public.recurrence_freq[] := ARRAY['none','none','none','none','none','weekly','weekly','monthly','yearly']::public.recurrence_freq[];
  v_rec      public.recurrence_freq;
  v_title    text;  v_desc text;  v_loc text;
  v_start    timestamptz;  v_allday boolean;  v_dur interval;  v_assignee uuid;
  i int;  seeded int := 0;  fam_count int := 0;

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
  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = lower(v_email) LIMIT 1;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No auth user for %', v_email; END IF;
  v_creator := v_uid;

  -- Seed every family the user is an active member of (covers whichever family
  -- the calendar page resolves as "active").
  FOR v_fam IN
    SELECT DISTINCT family_id FROM public.family_members WHERE user_id = v_uid AND is_active
  LOOP
    fam_count := fam_count + 1;

    -- Clean previous seed rows for THIS family only.
    DELETE FROM public.calendar_events WHERE family_id = v_fam AND description LIKE '%[seed:calendar]%';

    SELECT array_agg(id) INTO v_members FROM public.family_members WHERE family_id = v_fam AND is_active;

    FOR i IN 1..500 LOOP
      v_cat := v_cats[1 + (i % array_length(v_cats,1))];
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
      v_allday := (i % 7 = 0) OR v_cat IN ('holiday','birthday');
      v_start := date_trunc('day', now())
                 + (((i * 7) % 95) - 30) * interval '1 day'
                 + CASE WHEN v_allday THEN interval '0 hour'
                        ELSE (8 + (i % 11)) * interval '1 hour' + (CASE WHEN i % 2 = 0 THEN interval '30 min' ELSE interval '0 min' END) END;
      v_dur := (ARRAY['30 min','1 hour','1 hour','90 min','2 hours']::interval[])[1 + (i % 5)];
      v_rec := v_recs[1 + (i % array_length(v_recs,1))];
      IF v_members IS NOT NULL AND array_length(v_members,1) IS NOT NULL AND (i % 10) >= 3
        THEN v_assignee := v_members[1 + (i % array_length(v_members,1))];
        ELSE v_assignee := NULL; END IF;
      v_desc := CASE (i % 4)
        WHEN 0 THEN 'Quick note. [seed:calendar]'
        WHEN 1 THEN 'Remember to bring everything needed and confirm the time the day before; carpool TBD and weather may shift this outdoors/indoors. [seed:calendar]'
        WHEN 2 THEN '[seed:calendar]'
        ELSE        'Recurring family commitment. [seed:calendar]' END;
      v_loc := t_locations[1 + (i % array_length(t_locations,1))];

      INSERT INTO public.calendar_events
        (family_id, title, description, location, category, starts_at, ends_at, all_day, recurrence, recurrence_until, assignee_id, created_by)
      VALUES (v_fam, v_title, v_desc, v_loc, v_cat, v_start,
              CASE WHEN v_allday THEN NULL ELSE v_start + v_dur END,
              v_allday, v_rec,
              CASE WHEN v_rec = 'none' THEN NULL ELSE v_start + interval '180 days' END,
              v_assignee, v_creator);
      seeded := seeded + 1;
    END LOOP;
  END LOOP;

  IF fam_count = 0 THEN RAISE EXCEPTION 'No active family membership for %', v_email; END IF;
  RAISE NOTICE 'Seeded % calendar_events across % family(ies) for %.', seeded, fam_count, v_email;
END $$;

-- Verification: total seeded rows per family for the target user.
WITH usr AS (
  SELECT id FROM auth.users WHERE lower(email) = 'newworldventurellc@gmail.com' LIMIT 1
)
SELECT ce.family_id, f.name AS family, count(*) AS events
FROM public.calendar_events ce
JOIN public.families f ON f.id = ce.family_id
WHERE ce.description LIKE '%[seed:calendar]%'
  AND ce.family_id IN (
    SELECT family_id FROM public.family_members
    WHERE user_id = (SELECT id FROM usr) AND is_active
  )
GROUP BY ce.family_id, f.name ORDER BY events DESC;
