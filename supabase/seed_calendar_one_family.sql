-- ============================================================================
-- seed_calendar_one_family.sql — 500 calendar_events for ONE family only.
-- Production-safe variant of seed_calendar.sql: it resolves a single family by
-- the email of one of its members and seeds ONLY that family, so it never
-- touches real customers' calendars.
--
-- TARGET: change the email on the next line if needed.
-- IDEMPOTENT: rows are tagged [seed:calendar] and deleted before insert (only
-- within the target family).
-- ============================================================================

DO $$
DECLARE
  v_email    text := 'newworldventurellc@gmail.com';   -- <-- target family member
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
  i int;  seeded int := 0;

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

  SELECT up.active_family_id INTO v_fam FROM public.user_preferences up WHERE up.user_id = v_uid;
  IF v_fam IS NULL THEN SELECT id INTO v_fam FROM public.families WHERE created_by = v_uid ORDER BY created_at LIMIT 1; END IF;
  IF v_fam IS NULL THEN SELECT family_id INTO v_fam FROM public.family_members WHERE user_id = v_uid AND is_active ORDER BY created_at LIMIT 1; END IF;
  IF v_fam IS NULL THEN RAISE EXCEPTION 'No family for %', v_email; END IF;

  -- Clean previous seed rows for THIS family only.
  DELETE FROM public.calendar_events WHERE family_id = v_fam AND description LIKE '%[seed:calendar]%';

  SELECT array_agg(id) INTO v_members FROM public.family_members WHERE family_id = v_fam AND is_active;
  v_creator := v_uid;

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

  RAISE NOTICE 'Seeded % calendar_events for % (family %).', seeded, v_email, v_fam;
END $$;

SELECT category, count(*) AS n FROM public.calendar_events
WHERE description LIKE '%[seed:calendar]%'
  AND family_id = (SELECT active_family_id FROM public.user_preferences up
                   JOIN auth.users u ON u.id = up.user_id
                   WHERE lower(u.email) = 'newworldventurellc@gmail.com' LIMIT 1)
GROUP BY 1 ORDER BY 2 DESC;
