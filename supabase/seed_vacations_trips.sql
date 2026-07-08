-- ============================================================================
-- FamilyOS :: seed_vacations_trips.sql — high-volume Vacation & Trip Planner demo
--
-- Seeds the full 29-table travel planner (migration 0029 trips + 0070 vacations)
-- for the 5 demo families from seed.sql, FK-parented end to end:
--   parents:  vacations (25), trips (25)
--   the 7 primary scrollable lists at 500 rows each (5 families x 100):
--     trip_items, vacation_itinerary_items, vacation_activities,
--     vacation_reservations, vacation_expenses, vacation_packing_items,
--     vacation_checklists
--   plus representative volume in every supporting table (members, destinations,
--   days, flights, transportation, lodging, tickets, budgets, packing lists,
--   documents, emergency contacts, medical info, weather, AI recos/conversations/
--   messages, travel scores, activity logs, notifications, audit logs).
--
-- HOW TO RUN (needs DB access — this file cannot reach your project on its own):
--   • Supabase SQL Editor: paste seed.sql, then this file; or
--   • psql "$DATABASE_URL" -f supabase/seed.sql -f supabase/seed_vacations_trips.sql
--
-- IDEMPOTENT + POOLER-SAFE: no temp tables, no BEGIN/COMMIT. It first clears the
-- two parents (vacations, trips) for the 5 demo families — every child cascades
-- via ON DELETE CASCADE — then re-inserts, so it is safe to run repeatedly and
-- only ever touches those 5 demo families. created_by is left NULL (demo data is
-- not owned by a specific auth user).
-- ============================================================================

-- ── Clear prior seed rows for the 5 demo families (children cascade) ──
DELETE FROM public.vacations WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);
DELETE FROM public.trips     WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- ============================================================================
-- PARENTS
-- ============================================================================

-- 5 vacations per family (25 total), spread across statuses and kinds, each on
-- its own future week so itinerary days / weather never collide.
INSERT INTO public.vacations (family_id, title, kind, status, destination, start_date, end_date, timezone, description, budget_cents, currency, is_international, notes)
SELECT f.id,
  (ARRAY['Summer at the Shore','Mountain Escape','Theme Park Adventure','City Discovery','Grandparents Reunion'])[n] || ' ' || (2025 + n),
  (ARRAY['domestic','camping','theme_park','international','road_trip']::vacation_kind[])[n],
  (ARRAY['planning','booked','active','completed','planning']::vacation_status[])[n],
  (ARRAY['San Diego, CA','Aspen, CO','Orlando, FL','Lisbon, Portugal','Chicago, IL'])[n],
  current_date + ((n * 30) || ' days')::interval,
  current_date + ((n * 30 + 6) || ' days')::interval,
  'America/New_York',
  'A well-planned family getaway with something for everyone.',
  (300000 + n * 125000)::bigint,
  'USD',
  (n = 4),
  'Auto-seeded vacation'
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id), generate_series(1,5) n;

-- 5 legacy trips per family (25 total) for the 0029 Trip Planner.
INSERT INTO public.trips (family_id, name, destination, start_date, end_date, status, traveler_ids, notes)
SELECT f.id,
  (ARRAY['Beach Week','Ski Trip','Disney Days','Euro Tour','Family Reunion'])[n] || ' #' || n,
  (ARRAY['San Diego, CA','Aspen, CO','Orlando, FL','Lisbon, Portugal','Chicago, IL'])[n],
  current_date + ((n * 30) || ' days')::interval,
  current_date + ((n * 30 + 6) || ' days')::interval,
  (ARRAY['planning','booked','active','completed','planning']::trip_status[])[n],
  '{}'::uuid[],
  'Auto-seeded trip'
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id), generate_series(1,5) n;

-- ============================================================================
-- SUPPORTING TABLES (parented on vacations; must precede lists that reference them)
-- ============================================================================

-- Who is going: every family member on every vacation (125). UNIQUE(vacation,member).
INSERT INTO public.vacation_members (family_id, vacation_id, member_id, role, dietary_restrictions, preferences)
SELECT v.family_id, v.id, m.id,
  (ARRAY['adult','child','adult','child','grandparent'])[1 + (abs(hashtext(m.id::text)) % 5)],
  (ARRAY[NULL,'vegetarian','nut allergy','gluten-free',NULL])[1 + (abs(hashtext(m.id::text)) % 5)],
  'Window seat; early riser'
FROM public.vacations v
JOIN public.family_members m ON m.family_id = v.family_id
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Destinations: 3 stops per vacation (75), ordered.
INSERT INTO public.vacation_destinations (family_id, vacation_id, name, region, country, arrive_date, depart_date, sort_order, notes)
SELECT v.family_id, v.id,
  (ARRAY['Old Town','Waterfront','National Park'])[g],
  (ARRAY['Central','Coast','Highlands'])[g],
  CASE WHEN v.is_international THEN 'Portugal' ELSE 'USA' END,
  v.start_date + ((g - 1) * 2),
  v.start_date + ((g - 1) * 2 + 1),
  g,
  'Auto-seeded destination'
FROM public.vacations v, generate_series(1,3) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Itinerary days: 7 per vacation (175). UNIQUE(vacation, day_date).
INSERT INTO public.vacation_itinerary_days (family_id, vacation_id, day_date, title, summary)
SELECT v.family_id, v.id, v.start_date + g, 'Day ' || (g + 1), 'Plans for day ' || (g + 1)
FROM public.vacations v, generate_series(0,6) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Flights: 2 per vacation (50).
INSERT INTO public.vacation_flights (family_id, vacation_id, airline, flight_number, depart_airport, arrive_airport, depart_at, arrive_at, seats, confirmation_code, booked, cost_cents)
SELECT v.family_id, v.id,
  (ARRAY['United','Delta','Southwest','JetBlue'])[1 + (g % 4)],
  'UA' || (100 + g * 37),
  (ARRAY['JFK','ORD','ATL','LAX'])[1 + (g % 4)],
  (ARRAY['SAN','ASE','MCO','LIS'])[1 + (g % 4)],
  (v.start_date + (g - 1))::timestamptz + interval '8 hours',
  (v.start_date + (g - 1))::timestamptz + interval '13 hours',
  '14A, 14B, 14C',
  'CONF' || upper(substr(md5(v.id::text || g), 1, 6)),
  (g = 1),
  (28000 + g * 4200)::bigint
FROM public.vacations v, generate_series(1,2) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Ground transportation: 2 per vacation (50).
INSERT INTO public.vacation_transportation (family_id, vacation_id, kind, provider, from_location, to_location, depart_at, arrive_at, confirmation_code, distance_miles, booked, cost_cents)
SELECT v.family_id, v.id,
  (ARRAY['car','train','rideshare','shuttle']::vac_transport_kind[])[1 + (g % 4)],
  (ARRAY['Hertz','Amtrak','Uber','Airport Shuttle'])[1 + (g % 4)],
  'Airport', 'Hotel',
  (v.start_date + (g - 1))::timestamptz + interval '14 hours',
  (v.start_date + (g - 1))::timestamptz + interval '15 hours',
  'TR' || upper(substr(md5(v.id::text || 't' || g), 1, 6)),
  (12.5 + g * 3.0)::numeric(8,1),
  (g = 1),
  (6000 + g * 1500)::bigint
FROM public.vacations v, generate_series(1,2) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Lodging: 2 per vacation (50).
INSERT INTO public.vacation_lodging (family_id, vacation_id, kind, name, address, check_in, check_out, confirmation_code, nightly_cents, total_cents, booked, notes)
SELECT v.family_id, v.id,
  (ARRAY['hotel','airbnb','resort','cabin']::vac_lodging_kind[])[1 + (g % 4)],
  (ARRAY['Seaside Inn','Cozy Downtown Loft','Grand Resort & Spa','Pinewood Cabin'])[1 + (g % 4)],
  (100 + g) || ' Main St',
  v.start_date, v.end_date,
  'LDG' || upper(substr(md5(v.id::text || 'l' || g), 1, 6)),
  (18000 + g * 4000)::bigint,
  (18000 + g * 4000)::bigint * 6,
  (g = 1),
  'Auto-seeded lodging'
FROM public.vacations v, generate_series(1,2) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Budgets: one row per (vacation, category) (225). UNIQUE(vacation, category).
INSERT INTO public.vacation_budgets (family_id, vacation_id, category, planned_cents, notes)
SELECT v.family_id, v.id, c.cat, (50000 + (abs(hashtext(v.id::text || c.cat::text)) % 200000))::bigint, 'Planned budget'
FROM public.vacations v, unnest(enum_range(NULL::vac_budget_category)) c(cat)
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Packing lists: 2 per vacation (50) — needed before packing items.
INSERT INTO public.vacation_packing_lists (family_id, vacation_id, name, is_master)
SELECT v.family_id, v.id, (ARRAY['Family Master List','Kids Bag'])[g], (g = 1)
FROM public.vacations v, generate_series(1,2) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Documents: 3 per vacation (75).
INSERT INTO public.vacation_documents (family_id, vacation_id, kind, title, number, issued_on, expires_on, notes)
SELECT v.family_id, v.id,
  (ARRAY['passport','ticket','hotel_confirmation']::vac_doc_kind[])[g],
  (ARRAY['Passport','Flight Ticket','Hotel Confirmation'])[g],
  upper(substr(md5(v.id::text || 'd' || g), 1, 9)),
  current_date - 200, current_date + 3000,
  'Auto-seeded document'
FROM public.vacations v, generate_series(1,3) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Emergency contacts: 2 per vacation (50).
INSERT INTO public.vacation_emergency_contacts (family_id, vacation_id, name, relationship, phone, category)
SELECT v.family_id, v.id,
  (ARRAY['Dr. Reyes','Aunt Carol'])[g],
  (ARRAY['physician','relative'])[g],
  '+1-555-01' || lpad((g * 7)::text, 2, '0'),
  (ARRAY['doctor','local_emergency'])[g]
FROM public.vacations v, generate_series(1,2) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Medical info: one per vacation member subset (50 = 2 members per vacation).
INSERT INTO public.vacation_medical_information (family_id, vacation_id, member_id, allergies, conditions, blood_type, insurance_provider)
SELECT v.family_id, v.id,
  (SELECT m.id FROM public.family_members m WHERE m.family_id = v.family_id ORDER BY random() LIMIT 1),
  (ARRAY['None','Peanuts'])[g], (ARRAY['None','Asthma'])[g], (ARRAY['O+','A-'])[g], 'BlueCross'
FROM public.vacations v, generate_series(1,2) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Weather snapshots: 7 forecast days per vacation (175). UNIQUE(vacation,label,date).
INSERT INTO public.vacation_weather_snapshots (family_id, vacation_id, location_label, forecast_date, temp_high_c, temp_low_c, precip_prob, wind_kph, summary)
SELECT v.family_id, v.id, 'Primary', v.start_date + g,
  (24 + (g % 6))::numeric(5,1), (14 + (g % 4))::numeric(5,1), (g * 11) % 100, (8 + g)::numeric(6,1),
  (ARRAY['Sunny','Partly cloudy','Light rain','Clear','Windy','Overcast','Warm'])[1 + (g % 7)]
FROM public.vacations v, generate_series(0,6) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- AI recommendations: 4 per vacation (100).
INSERT INTO public.vacation_ai_recommendations (family_id, vacation_id, kind, status, title, detail, severity, source)
SELECT v.family_id, v.id,
  (ARRAY['packing','budget_warning','activity_suggestion','document_missing']::vac_reco_kind[])[g],
  (ARRAY['open','open','accepted','done']::vac_reco_status[])[g],
  (ARRAY['Pack rain jackets','Lodging over budget','Try the harbor tour','Passport expires soon'])[g],
  'Auto-seeded recommendation detail.',
  1 + (g % 3),
  CASE WHEN g % 2 = 0 THEN 'ai' ELSE 'rules' END
FROM public.vacations v, generate_series(1,4) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- AI conversations: one per vacation (25) — needed before AI messages.
INSERT INTO public.vacation_ai_conversations (family_id, vacation_id, title)
SELECT v.family_id, v.id, 'Trip concierge — ' || v.title
FROM public.vacations v
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- AI messages: 6 per conversation (150). role is NOT NULL (ai_role).
INSERT INTO public.vacation_ai_messages (family_id, conversation_id, role, content)
SELECT c.family_id, c.id,
  (ARRAY['user','assistant','user','assistant','user','assistant']::ai_role[])[g],
  (ARRAY['What should we pack?','Bring layers and rain gear.','Any kid-friendly activities?','Yes — the aquarium and harbor tour.','How is the budget looking?','You are on track; lodging is the biggest line.'])[g]
FROM public.vacation_ai_conversations c, generate_series(1,6) g
WHERE c.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Travel/readiness scores: 3 per vacation (75).
INSERT INTO public.vacation_travel_scores (family_id, vacation_id, score, breakdown, computed_at)
SELECT v.family_id, v.id, 60 + (g * 10) + (abs(hashtext(v.id::text)) % 10),
  jsonb_build_object('bookings', 70 + g, 'packing', 60 + g, 'documents', 80 + g),
  now() - ((g * 2) || ' days')::interval
FROM public.vacations v, generate_series(1,3) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Activity logs: 5 per vacation (125).
INSERT INTO public.vacation_activity_logs (family_id, vacation_id, actor_member_id, action, detail)
SELECT v.family_id, v.id,
  (SELECT m.id FROM public.family_members m WHERE m.family_id = v.family_id ORDER BY random() LIMIT 1),
  (ARRAY['created_trip','booked_flight','added_activity','updated_budget','packed_item'])[g],
  'Auto-seeded activity log entry.'
FROM public.vacations v, generate_series(1,5) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Notifications: 4 per vacation (100).
INSERT INTO public.vacation_notifications (family_id, vacation_id, member_id, title, body, read, send_at)
SELECT v.family_id, v.id,
  (SELECT m.id FROM public.family_members m WHERE m.family_id = v.family_id ORDER BY random() LIMIT 1),
  (ARRAY['Check-in opens soon','Packing reminder','Reservation confirmed','Weather alert'])[g],
  'Auto-seeded notification body.',
  (g % 2 = 0),
  now() + ((g) || ' days')::interval
FROM public.vacations v, generate_series(1,4) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Audit logs: 4 per vacation (100).
INSERT INTO public.vacation_audit_logs (family_id, vacation_id, table_name, record_id, action, changes)
SELECT v.family_id, v.id,
  (ARRAY['vacations','vacation_flights','vacation_lodging','vacation_expenses'])[g],
  v.id, (ARRAY['insert','update','update','insert'])[g],
  jsonb_build_object('seed', true, 'step', g)
FROM public.vacations v, generate_series(1,4) g
WHERE v.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- ============================================================================
-- ACTIVITIES (parent for tickets) — 500 (5 families x 100)
-- ============================================================================
INSERT INTO public.vacation_activities (family_id, vacation_id, name, category, location, scheduled_at, duration_min, cost_cents, family_friendly, booked, notes)
SELECT f.id, vv.id,
  (ARRAY['Aquarium Visit','Harbor Tour','Museum','Hiking Trail','Beach Day','Theme Park','City Walk','Cooking Class','Zoo','Kayaking'])[1 + (n % 10)] || ' #' || n,
  (ARRAY['attraction','tour','museum','outdoor','show'])[1 + (n % 5)],
  (ARRAY['Downtown','Waterfront','Old Town','Park','Pier'])[1 + (n % 5)],
  now() + ((n - 30) || ' days')::interval + interval '10 hours',
  (60 + (n % 6) * 30),
  (2000 + (n % 20) * 750)::bigint,
  (n % 4 <> 0),
  (n % 3 = 0),
  'Auto-seeded activity'
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id),
     generate_series(1,100) n,
     LATERAL (SELECT id FROM public.vacations v WHERE v.family_id = f.id ORDER BY random() LIMIT 1) vv;

-- ============================================================================
-- THE 7 PRIMARY SCROLLABLE LISTS — 500 rows each (5 families x 100)
-- ============================================================================

-- 1) trip_items (0029) — attached to a random trip in the same family.
INSERT INTO public.trip_items (family_id, trip_id, kind, label, details, assignee_id, is_done, due_at, sort_order)
SELECT f.id, t.id,
  (ARRAY['packing','todo','reservation','document']::trip_item_kind[])[1 + (n % 4)],
  (ARRAY['Sunscreen','Book rental car','Dinner reservation','Print boarding pass','Passports','Chargers','Swimsuits','Snacks','First-aid kit','Camera'])[1 + (n % 10)] || ' #' || n,
  'Auto-seeded trip item',
  (SELECT m.id FROM public.family_members m WHERE m.family_id = f.id ORDER BY random() LIMIT 1),
  (n % 3 = 0),
  now() + ((n - 20) || ' days')::interval,
  n
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id),
     generate_series(1,100) n,
     LATERAL (SELECT id FROM public.trips tr WHERE tr.family_id = f.id ORDER BY random() LIMIT 1) t;

-- 2) vacation_itinerary_items — attached to a random itinerary day (vacation derived from it).
INSERT INTO public.vacation_itinerary_items (family_id, vacation_id, day_id, kind, day_part, title, location, start_time, end_time, duration_min, cost_cents, booked, sort_order)
SELECT f.id, d.vacation_id, d.id,
  (ARRAY['activity','reservation','meal','travel','reminder','note','free_time']::vac_item_kind[])[1 + (n % 7)],
  (ARRAY['morning','afternoon','evening','all_day']::vac_day_part[])[1 + (n % 4)],
  (ARRAY['Breakfast','Museum','Lunch','Beach','Dinner','Show','Rest','Shopping','Park','Sunset walk'])[1 + (n % 10)] || ' #' || n,
  (ARRAY['Hotel','Downtown','Pier','Old Town','Park'])[1 + (n % 5)],
  (time '08:00' + ((n % 10) || ' hours')::interval),
  (time '09:00' + ((n % 10) || ' hours')::interval),
  (30 + (n % 8) * 15),
  (0 + (n % 15) * 500)::bigint,
  (n % 2 = 0),
  n
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id),
     generate_series(1,100) n,
     LATERAL (SELECT id, vacation_id FROM public.vacation_itinerary_days d WHERE d.family_id = f.id ORDER BY random() LIMIT 1) d;

-- 3) vacation_reservations — attached to a random vacation in the same family.
INSERT INTO public.vacation_reservations (family_id, vacation_id, kind, name, location, reserved_at, party_size, confirmation_code, cost_cents, booked, notes)
SELECT f.id, vv.id,
  (ARRAY['dining','spa','tour','rental'])[1 + (n % 4)],
  (ARRAY['The Harbor Grill','Seaside Spa','Sunset Cruise','Bike Rental','Rooftop Bistro','Kids Club','Wine Tasting','Snorkel Tour','Trattoria','Escape Room'])[1 + (n % 10)] || ' #' || n,
  (ARRAY['Downtown','Resort','Marina','Old Town','Pier'])[1 + (n % 5)],
  now() + ((n - 25) || ' days')::interval + interval '19 hours',
  2 + (n % 6),
  'RSV' || upper(substr(md5(f.id::text || n), 1, 6)),
  (3000 + (n % 12) * 900)::bigint,
  (n % 3 <> 0),
  'Auto-seeded reservation'
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id),
     generate_series(1,100) n,
     LATERAL (SELECT id FROM public.vacations v WHERE v.family_id = f.id ORDER BY random() LIMIT 1) vv;

-- 4) vacation_expenses — attached to a random vacation in the same family.
INSERT INTO public.vacation_expenses (family_id, vacation_id, category, description, amount_cents, spent_on, paid_by_member_id, notes)
SELECT f.id, vv.id,
  (ARRAY['flights','lodging','transportation','activities','food','shopping','insurance','fees','misc']::vac_budget_category[])[1 + (n % 9)],
  (ARRAY['Dinner out','Museum tickets','Gas','Souvenirs','Groceries','Parking','Snacks','Tolls','Coffee','Ice cream'])[1 + (n % 10)] || ' #' || n,
  (500 + (n % 40) * 350)::bigint,
  current_date - (n % 30),
  (SELECT m.id FROM public.family_members m WHERE m.family_id = f.id ORDER BY random() LIMIT 1),
  'Auto-seeded expense'
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id),
     generate_series(1,100) n,
     LATERAL (SELECT id FROM public.vacations v WHERE v.family_id = f.id ORDER BY random() LIMIT 1) vv;

-- 5) vacation_packing_items — attached to a random packing list (vacation derived from it).
INSERT INTO public.vacation_packing_items (family_id, vacation_id, list_id, name, category, quantity, packed, ai_suggested, notes)
SELECT f.id, l.vacation_id, l.id,
  (ARRAY['T-shirts','Toothbrush','Phone charger','Sunscreen','Passport','Swim goggles','Hiking boots','Rain jacket','Snacks','Sunglasses'])[1 + (n % 10)] || ' #' || n,
  (ARRAY['clothes','toiletries','electronics','toiletries','documents','sports','sports','clothes','snacks','other']::vac_pack_category[])[1 + (n % 10)],
  1 + (n % 5),
  (n % 2 = 0),
  (n % 4 = 0),
  'Auto-seeded packing item'
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id),
     generate_series(1,100) n,
     LATERAL (SELECT id, vacation_id FROM public.vacation_packing_lists pl WHERE pl.family_id = f.id ORDER BY random() LIMIT 1) l;

-- 6) vacation_checklists — attached to a random vacation in the same family.
INSERT INTO public.vacation_checklists (family_id, vacation_id, title, done, due_date, assignee_member_id, sort_order)
SELECT f.id, vv.id,
  (ARRAY['Confirm flights','Hold mail','Arrange pet sitter','Charge devices','Refill medications','Set out-of-office','Exchange currency','Download offline maps','Pack carry-ons','Check passports'])[1 + (n % 10)] || ' #' || n,
  (n % 3 = 0),
  current_date + (n % 20),
  (SELECT m.id FROM public.family_members m WHERE m.family_id = f.id ORDER BY random() LIMIT 1),
  n
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id),
     generate_series(1,100) n,
     LATERAL (SELECT id FROM public.vacations v WHERE v.family_id = f.id ORDER BY random() LIMIT 1) vv;

-- ============================================================================
-- ACTIVITY TICKETS — parented on activities (100 = 5 families x 20)
-- ============================================================================
INSERT INTO public.vacation_activity_tickets (family_id, vacation_id, activity_id, holder_member_id, holder_name, ticket_type, confirmation_code, price_cents, notes)
SELECT f.id, a.vacation_id, a.id,
  (SELECT m.id FROM public.family_members m WHERE m.family_id = f.id ORDER BY random() LIMIT 1),
  NULL,
  (ARRAY['adult','child','senior','group'])[1 + (n % 4)],
  'TKT' || upper(substr(md5(f.id::text || 'k' || n), 1, 6)),
  (1500 + (n % 10) * 600)::bigint,
  'Auto-seeded ticket'
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id),
     generate_series(1,20) n,
     LATERAL (SELECT id, vacation_id FROM public.vacation_activities a WHERE a.family_id = f.id ORDER BY random() LIMIT 1) a;

-- ============================================================================
-- Done! Vacation & Trip Planner seeded for the 5 demo families.
-- ============================================================================
