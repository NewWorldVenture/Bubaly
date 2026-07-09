-- ============================================================================
-- FamilyOS · SEED — Trips + Vacation Planner OS (the last big feature-gap).
-- ----------------------------------------------------------------------------
-- The Trip Planner (`trips`/`trip_items`) and the 27-table Vacation Planner
-- (`vacations` + every child: destinations, itinerary days/items, flights,
-- transportation, lodging, activities + tickets, reservations, budgets +
-- expenses, packing lists/items, documents, emergency + medical, checklists,
-- weather, AI recommendations/conversations/messages, travel scores, activity
-- logs, notifications, audit) had NO seed and rendered empty at test time.
--
-- This seeds a realistic set of parent trips/vacations and populates every
-- child table. The primary scrollable lists a user actually pages through —
-- trip_items, itinerary_items, activities, reservations, expenses,
-- packing_items, checklists — each reach 500; the rest get proportionate,
-- realistic volume so every planner tab renders at real density.
--
-- IDEMPOTENT: seed trips/vacations carry a '[seed]' title prefix; deleting them
-- CASCADES every child row (all FKs are ON DELETE CASCADE), so re-running is
-- clean. Family-scoped; resolves the family by email (falls back to the oldest
-- family). Guarded by to_regclass so a missing table is skipped, never fatal.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
#variable_conflict use_column
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_uid     uuid;
  v_members uuid[];
  v_mcount  int;
  n int := 500;
  v_trips   uuid[];
  v_vacs    uuid[];
  v_dests   uuid[];
  v_days    uuid[];
  v_acts    uuid[];
  v_lists   uuid[];
  v_convos  uuid[];
  v_vid uuid; v_did uuid; v_aid uuid; v_lid uuid; v_cid uuid; v_mid uuid;
  g int; j int;
  vkinds text[] := array['road_trip','flight','cruise','theme_park','international','domestic','staycation','camping','other'];
  vstats text[] := array['planning','planning','booked','active','completed','cancelled'];
  places text[] := array['Orlando, FL','San Diego, CA','Yellowstone','Paris, France','Maui, HI','New York, NY',
                         'Grand Canyon','London, UK','Cancún, MX','Lake Tahoe','Rome, Italy','Vancouver, BC'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  v_mcount := coalesce(array_length(v_members, 1), 0);

  -- ══ TRIPS (simple planner: trips + 500 trip_items) ════════════════════════
  if to_regclass('public.trips') is not null then
    delete from public.trips where family_id = v_family and name like '[seed]%';  -- cascades trip_items
    insert into public.trips (family_id, name, destination, start_date, end_date, status, traveler_ids, notes, created_by)
    select v_family,
      '[seed] ' || (array['Summer road trip','Ski week','Beach getaway','Grandparents visit','Spring break',
                          'Anniversary trip','Camping weekend','Theme-park days','City break','Reunion'])[1 + (g % 10)] || ' #' || g,
      places[1 + (g % array_length(places,1))],
      (current_date + ((g % 200) - 60 || ' days')::interval)::date,
      (current_date + ((g % 200) - 60 + 5 || ' days')::interval)::date,
      vstats[1 + (g % array_length(vstats,1))]::trip_status,
      coalesce(v_members, '{}'),
      'Seeded trip for testing the planner.', v_uid
    from generate_series(1, 12) as g;
    select array_agg(id) into v_trips from public.trips where family_id = v_family and name like '[seed]%';

    if to_regclass('public.trip_items') is not null then
      insert into public.trip_items (family_id, trip_id, kind, label, details, assignee_id, is_done, due_at, sort_order, created_by)
      select v_family,
        v_trips[1 + (g % array_length(v_trips,1))],
        (array['packing','todo','reservation','document'])[1 + (g % 4)]::trip_item_kind,
        (array['Sunscreen','Book rental car','Dinner reservation','Passports','Phone chargers','Confirm hotel',
               'Snacks for drive','Print boarding passes','Beach towels','Travel insurance'])[1 + (g % 10)] || ' #' || g,
        'Seeded checklist item.',
        case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
        (g % 3 = 0),
        (now() + ((g % 60) || ' days')::interval),
        g, v_uid
      from generate_series(1, n) as g;
    end if;
  end if;

  -- ══ VACATIONS (rich planner) ══════════════════════════════════════════════
  if to_regclass('public.vacations') is null then
    raise notice 'vacations table absent — skipped.'; return;
  end if;

  delete from public.vacations where family_id = v_family and title like '[seed]%';  -- cascades all children

  insert into public.vacations (family_id, title, kind, status, destination, start_date, end_date, timezone,
                                description, budget_cents, currency, is_international, notes, created_by)
  select v_family,
    '[seed] ' || (array['Disney World','SoCal Adventure','National Parks','Paris & Rome','Hawaii Escape',
                        'Big Apple Weekend','Grand Canyon Road Trip','London Half-Term','Cancún All-Inclusive',
                        'Tahoe Ski Week','Italy Family Tour','Vancouver Summer'])[g] || ' ' || (2025 + (g % 3)),
    vkinds[1 + (g % array_length(vkinds,1))]::vacation_kind,
    vstats[1 + (g % array_length(vstats,1))]::vacation_status,
    places[g],
    (current_date + ((g * 21) - 120 || ' days')::interval)::date,
    (current_date + ((g * 21) - 120 + 6 || ' days')::interval)::date,
    'America/New_York',
    'Seeded vacation exercising the full planner at real volume.',
    (200000 + g * 75000)::bigint, 'USD', (g % 3 = 0),
    'Seeded trip.', v_uid
  from generate_series(1, 12) as g;
  select array_agg(id) into v_vacs from public.vacations where family_id = v_family and title like '[seed]%';

  -- ── members on each vacation (bounded: members × vacations) ────────────────
  if to_regclass('public.vacation_members') is not null and v_members is not null then
    insert into public.vacation_members (family_id, vacation_id, member_id, role, dietary_restrictions, preferences, created_by)
    select v_family, v, m,
      (array['adult','child','grandparent','caregiver'])[1 + ((row_number() over ())::int % 4)],
      (array['none','vegetarian','gluten-free','nut allergy'])[1 + ((row_number() over ())::int % 4)],
      'Window seat; early riser.', v_uid
    from unnest(v_vacs) as v cross join unnest(v_members) as m
    on conflict (vacation_id, member_id) do nothing;
  end if;

  -- ── destinations (3 per vacation) ─────────────────────────────────────────
  if to_regclass('public.vacation_destinations') is not null then
    insert into public.vacation_destinations (family_id, vacation_id, name, region, country, latitude, longitude, arrive_date, depart_date, sort_order, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      places[1 + (g % array_length(places,1))],
      (array['Coast','Mountains','Downtown','Countryside'])[1 + (g % 4)],
      (array['USA','France','Italy','UK','Mexico','Canada'])[1 + (g % 6)],
      25 + (g % 40), -120 + (g % 200), current_date + (g % 30), current_date + (g % 30) + 3,
      g % 3, 'Seeded stop.', v_uid
    from generate_series(1, 36) as g;
    select array_agg(id) into v_dests from public.vacation_destinations
      where family_id = v_family and vacation_id = any(v_vacs);
  end if;

  -- ── itinerary days (7 distinct days per vacation) ─────────────────────────
  if to_regclass('public.vacation_itinerary_days') is not null then
    for j in 1..array_length(v_vacs,1) loop
      v_vid := v_vacs[j];
      insert into public.vacation_itinerary_days (family_id, vacation_id, day_date, title, summary, created_by)
      select v_family, v_vid,
        (current_date + ((j * 21) - 120 + g || ' days')::interval)::date,
        'Day ' || g, 'Seeded itinerary day.', v_uid
      from generate_series(0, 6) as g
      on conflict (vacation_id, day_date) do nothing;
    end loop;
    select array_agg(id) into v_days from public.vacation_itinerary_days
      where family_id = v_family and vacation_id = any(v_vacs);
  end if;

  -- ── itinerary items (500, linked to a day of the same vacation) ───────────
  if to_regclass('public.vacation_itinerary_items') is not null then
    for g in 1..n loop
      v_vid := v_vacs[1 + (g % array_length(v_vacs,1))];
      select id into v_did from public.vacation_itinerary_days
        where vacation_id = v_vid order by day_date offset (g % 7) limit 1;
      insert into public.vacation_itinerary_items
        (family_id, vacation_id, day_id, kind, day_part, title, location, start_time, end_time, duration_min, cost_cents, booked, notes, member_ids, sort_order, created_by)
      values (v_family, v_vid, v_did,
        (array['activity','reservation','meal','travel','reminder','note','free_time'])[1 + (g % 7)]::vac_item_kind,
        (array['morning','afternoon','evening','all_day'])[1 + (g % 4)]::vac_day_part,
        (array['Breakfast','Museum visit','Pool time','City tour','Dinner out','Beach','Show','Park entry','Shopping','Rest'])[1 + (g % 10)] || ' #' || g,
        places[1 + (g % array_length(places,1))],
        (make_time(8 + (g % 10), (g % 4) * 15, 0)),
        (make_time(9 + (g % 10), (g % 4) * 15, 0)),
        30 + (g % 8) * 15, (g % 12) * 1500, (g % 2 = 0), 'Seeded itinerary item.',
        coalesce(v_members, '{}'), g, v_uid);
    end loop;
  end if;

  -- ── flights (48) ──────────────────────────────────────────────────────────
  if to_regclass('public.vacation_flights') is not null then
    insert into public.vacation_flights (family_id, vacation_id, airline, flight_number, depart_airport, arrive_airport, depart_at, arrive_at, terminal, gate, seats, confirmation_code, booked, cost_cents, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['Delta','United','American','Southwest','JetBlue','Alaska'])[1 + (g % 6)],
      'FL' || (100 + g), (array['JFK','LAX','ORD','ATL','SFO','MIA'])[1 + (g % 6)],
      (array['MCO','SAN','LHR','CDG','HNL','YVR'])[1 + (g % 6)],
      now() + ((g % 90) || ' days')::interval, now() + ((g % 90) || ' days')::interval + interval '5 hours',
      'T' || (1 + g % 4), 'G' || (1 + g % 30), (g % 30) || 'A', 'CONF' || lpad(g::text,4,'0'),
      (g % 2 = 0), (15000 + g * 900)::bigint, 'Seeded flight.', v_uid
    from generate_series(1, 48) as g;
  end if;

  -- ── ground transportation (48) ────────────────────────────────────────────
  if to_regclass('public.vacation_transportation') is not null then
    insert into public.vacation_transportation (family_id, vacation_id, kind, provider, from_location, to_location, depart_at, arrive_at, confirmation_code, distance_miles, fuel_estimate_cents, booked, cost_cents, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['car','train','bus','ferry','rideshare','shuttle','subway'])[1 + (g % 7)]::vac_transport_kind,
      (array['Hertz','Amtrak','Greyhound','Uber','Airport Shuttle'])[1 + (g % 5)],
      places[1 + (g % array_length(places,1))], places[1 + ((g+1) % array_length(places,1))],
      now() + ((g % 80) || ' days')::interval, now() + ((g % 80) || ' days')::interval + interval '3 hours',
      'TR' || lpad(g::text,4,'0'), (10 + g % 300)::numeric, (g % 20) * 500, (g % 2 = 0), (g % 15) * 2500, 'Seeded transport.', v_uid
    from generate_series(1, 48) as g;
  end if;

  -- ── lodging (36) ──────────────────────────────────────────────────────────
  if to_regclass('public.vacation_lodging') is not null then
    insert into public.vacation_lodging (family_id, vacation_id, kind, name, address, phone, check_in, check_out, confirmation_code, nightly_cents, total_cents, booked, url, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['hotel','airbnb','resort','cabin','campground','rental'])[1 + (g % 6)]::vac_lodging_kind,
      (array['Seaside Inn','Grand Resort','Cozy Cabin','Downtown Suites','Family Lodge'])[1 + (g % 5)] || ' #' || g,
      (100 + g) || ' Main St', '555-01' || lpad(g::text,2,'0'),
      current_date + (g % 60), current_date + (g % 60) + 4, 'LDG' || lpad(g::text,4,'0'),
      (12000 + g * 300)::bigint, (48000 + g * 1200)::bigint, (g % 2 = 0), 'https://example.com/stay/' || g, 'Seeded lodging.', v_uid
    from generate_series(1, 36) as g;
  end if;

  -- ── activities (500) + tickets ────────────────────────────────────────────
  if to_regclass('public.vacation_activities') is not null then
    insert into public.vacation_activities (family_id, vacation_id, name, category, location, scheduled_at, duration_min, cost_cents, family_friendly, url, booked, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['Theme park','Guided tour','Snorkeling','Museum','Hiking','Cooking class','Boat cruise','Zoo','Beach day','Show'])[1 + (g % 10)] || ' #' || g,
      (array['attraction','tour','restaurant','show','outdoor'])[1 + (g % 5)],
      places[1 + (g % array_length(places,1))],
      now() + ((g % 90) || ' days')::interval, 60 + (g % 8) * 30, (g % 20) * 2000, (g % 4 <> 0),
      'https://example.com/act/' || g, (g % 2 = 0), 'Seeded activity.', v_uid
    from generate_series(1, n) as g;
    select array_agg(id) into v_acts from public.vacation_activities
      where family_id = v_family and vacation_id = any(v_vacs) and notes = 'Seeded activity.';

    if to_regclass('public.vacation_activity_tickets') is not null and v_acts is not null then
      insert into public.vacation_activity_tickets (family_id, vacation_id, activity_id, holder_member_id, holder_name, ticket_type, confirmation_code, price_cents, notes, created_by)
      select v_family,
        (select vacation_id from public.vacation_activities a where a.id = v_acts[1 + (g % array_length(v_acts,1))]),
        v_acts[1 + (g % array_length(v_acts,1))],
        case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
        'Guest ' || g, (array['adult','child','senior','group'])[1 + (g % 4)],
        'TKT' || lpad(g::text,4,'0'), (g % 15) * 2500, 'Seeded ticket.', v_uid
      from generate_series(1, 150) as g;
    end if;
  end if;

  -- ── reservations (500) ────────────────────────────────────────────────────
  if to_regclass('public.vacation_reservations') is not null then
    insert into public.vacation_reservations (family_id, vacation_id, kind, name, location, reserved_at, party_size, confirmation_code, cost_cents, booked, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['dining','spa','tour','rental','excursion'])[1 + (g % 5)],
      (array['The Grand Bistro','Serenity Spa','Sunset Cruise','Bike Rental','Guided Hike'])[1 + (g % 5)] || ' #' || g,
      places[1 + (g % array_length(places,1))],
      now() + ((g % 90) || ' days')::interval, 2 + (g % 6), 'RSV' || lpad(g::text,4,'0'),
      (g % 12) * 3000, (g % 2 = 0), 'Seeded reservation.', v_uid
    from generate_series(1, n) as g;
  end if;

  -- ── budgets (9 categories per vacation) ───────────────────────────────────
  if to_regclass('public.vacation_budgets') is not null then
    insert into public.vacation_budgets (family_id, vacation_id, category, planned_cents, notes, created_by)
    select v_family, v, c::vac_budget_category, (25000 + (row_number() over ()) * 1500)::bigint, 'Seeded budget line.', v_uid
    from unnest(v_vacs) as v
    cross join unnest(array['flights','lodging','transportation','activities','food','shopping','insurance','fees','misc']) as c
    on conflict (vacation_id, category) do nothing;
  end if;

  -- ── expenses (500) ────────────────────────────────────────────────────────
  if to_regclass('public.vacation_expenses') is not null then
    insert into public.vacation_expenses (family_id, vacation_id, category, description, amount_cents, spent_on, paid_by_member_id, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['flights','lodging','transportation','activities','food','shopping','insurance','fees','misc'])[1 + (g % 9)]::vac_budget_category,
      (array['Lunch','Souvenirs','Parking','Tickets','Taxi','Groceries','Coffee','Dinner','Gift shop','Tips'])[1 + (g % 10)] || ' #' || g,
      (500 + (g % 40) * 250)::bigint, (current_date - (g % 120)),
      case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
      'Seeded expense.', v_uid
    from generate_series(1, n) as g;
  end if;

  -- ── packing lists (per member per vacation + a master) + 500 items ────────
  if to_regclass('public.vacation_packing_lists') is not null then
    -- one master list per vacation
    insert into public.vacation_packing_lists (family_id, vacation_id, name, member_id, is_master, created_by)
    select v_family, v, 'Family master list', null, true, v_uid from unnest(v_vacs) as v;
    -- a personal list per member per vacation
    if v_members is not null then
      insert into public.vacation_packing_lists (family_id, vacation_id, name, member_id, is_master, created_by)
      select v_family, v, 'Personal list', m, false, v_uid
      from unnest(v_vacs) as v cross join unnest(v_members) as m;
    end if;
    select array_agg(id) into v_lists from public.vacation_packing_lists
      where family_id = v_family and vacation_id = any(v_vacs);

    if to_regclass('public.vacation_packing_items') is not null and v_lists is not null then
      for g in 1..n loop
        v_lid := v_lists[1 + (g % array_length(v_lists,1))];
        select vacation_id into v_vid from public.vacation_packing_lists where id = v_lid;
        insert into public.vacation_packing_items (family_id, vacation_id, list_id, name, category, quantity, packed, ai_suggested, notes, created_by)
        values (v_family, v_vid, v_lid,
          (array['T-shirts','Sunscreen','Toothbrush','Charger','Passport','Swimsuit','Sandals','Jacket','Snacks','First-aid kit'])[1 + (g % 10)] || ' #' || g,
          (array['clothes','toiletries','electronics','medications','documents','sports','beach','snacks','other'])[1 + (g % 9)]::vac_pack_category,
          1 + (g % 4), (g % 2 = 0), (g % 5 = 0), 'Seeded packing item.', v_uid);
      end loop;
    end if;
  end if;

  -- ── documents (96) ────────────────────────────────────────────────────────
  if to_regclass('public.vacation_documents') is not null then
    insert into public.vacation_documents (family_id, vacation_id, kind, title, member_id, number, issued_on, expires_on, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['passport','id','visa','ticket','boarding_pass','hotel_confirmation','insurance','itinerary'])[1 + (g % 8)]::vac_doc_kind,
      (array['Passport','Driver ID','Travel Visa','Event Ticket','Boarding Pass','Hotel Confirmation','Insurance Card','Trip Itinerary'])[1 + (g % 8)] || ' #' || g,
      case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
      'DOC' || lpad(g::text,6,'0'), current_date - (g % 800), current_date + (g % 800), 'Seeded document.', v_uid
    from generate_series(1, 96) as g;
  end if;

  -- ── emergency contacts (60) ───────────────────────────────────────────────
  if to_regclass('public.vacation_emergency_contacts') is not null then
    insert into public.vacation_emergency_contacts (family_id, vacation_id, name, relationship, phone, email, category, address, notes, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['Dr. Smith','City Hospital','Travel Insurer','US Embassy','Local Police','Grandma'])[1 + (g % 6)] || ' #' || g,
      (array['doctor','hospital','insurer','embassy','police','family'])[1 + (g % 6)],
      '555-02' || lpad(g::text,2,'0'), 'contact' || g || '@example.com',
      (array['doctor','insurance','embassy','local_emergency','family'])[1 + (g % 5)],
      (200 + g) || ' Care Ave', 'Seeded emergency contact.', v_uid
    from generate_series(1, 60) as g;
  end if;

  -- ── medical information (per member per vacation) ─────────────────────────
  if to_regclass('public.vacation_medical_information') is not null and v_members is not null then
    insert into public.vacation_medical_information (family_id, vacation_id, member_id, allergies, conditions, medications, blood_type, insurance_provider, insurance_number, physician, physician_phone, notes, created_by)
    select v_family, v, m,
      (array['none','peanuts','penicillin','pollen'])[1 + ((row_number() over ())::int % 4)],
      (array['none','asthma','none','none'])[1 + ((row_number() over ())::int % 4)],
      'As needed', (array['O+','A+','B+','AB+','O-'])[1 + ((row_number() over ())::int % 5)],
      'FamilyCare Health', 'INS' || lpad((row_number() over ())::text,6,'0'),
      'Dr. Jordan', '555-0100', 'Seeded medical info.', v_uid
    from unnest(v_vacs) as v cross join unnest(v_members) as m;
  end if;

  -- ── checklists (500) ──────────────────────────────────────────────────────
  if to_regclass('public.vacation_checklists') is not null then
    insert into public.vacation_checklists (family_id, vacation_id, title, done, due_date, assignee_member_id, sort_order, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['Book flights','Reserve hotel','Buy travel insurance','Renew passports','Arrange pet care',
             'Hold mail','Pack bags','Print itinerary','Exchange currency','Charge devices'])[1 + (g % 10)] || ' #' || g,
      (g % 3 = 0), current_date + (g % 60),
      case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
      g, v_uid
    from generate_series(1, n) as g;
  end if;

  -- ── weather snapshots (per vacation × 7 days) ─────────────────────────────
  if to_regclass('public.vacation_weather_snapshots') is not null then
    for j in 1..array_length(v_vacs,1) loop
      v_vid := v_vacs[j];
      insert into public.vacation_weather_snapshots (family_id, vacation_id, location_label, latitude, longitude, forecast_date, temp_high_c, temp_low_c, precip_prob, precip_mm, wind_kph, weather_code, summary, created_by)
      select v_family, v_vid, places[1 + (j % array_length(places,1))], 30.0 + j, -90.0 + j,
        (current_date + (g || ' days')::interval)::date,
        22 + (g % 10), 12 + (g % 8), (g * 13) % 101, (g % 12)::numeric, (5 + g % 20)::numeric, g % 5,
        (array['Sunny','Partly cloudy','Light rain','Clear','Windy'])[1 + (g % 5)], v_uid
      from generate_series(0, 6) as g
      on conflict (vacation_id, location_label, forecast_date) do nothing;
    end loop;
  end if;

  -- ── AI recommendations (200) ──────────────────────────────────────────────
  if to_regclass('public.vacation_ai_recommendations') is not null then
    insert into public.vacation_ai_recommendations (family_id, vacation_id, kind, status, title, detail, severity, source, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['missing_reservation','packing','budget_warning','weather_warning','travel_conflict','activity_suggestion','restaurant','document_missing','suggestion'])[1 + (g % 9)]::vac_reco_kind,
      (array['open','open','accepted','dismissed','done'])[1 + (g % 5)]::vac_reco_status,
      (array['Add a dinner reservation','Pack rain gear','You are over budget','Storm expected','Overlapping plans','Try this tour','Book this restaurant','Missing passport scan','Consider travel insurance'])[1 + (g % 9)] || ' #' || g,
      'Seeded AI recommendation the planner can action.', 1 + (g % 3),
      (array['rules','ai'])[1 + (g % 2)], v_uid
    from generate_series(1, 200) as g;
  end if;

  -- ── AI conversations (24) + messages (500) ────────────────────────────────
  if to_regclass('public.vacation_ai_conversations') is not null then
    insert into public.vacation_ai_conversations (family_id, vacation_id, title, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))], '[seed] Concierge chat #' || g, v_uid
    from generate_series(1, 24) as g;
    select array_agg(id) into v_convos from public.vacation_ai_conversations
      where family_id = v_family and title like '[seed]%';

    if to_regclass('public.vacation_ai_messages') is not null and v_convos is not null then
      insert into public.vacation_ai_messages (family_id, conversation_id, role, content, created_by)
      select v_family, v_convos[1 + (g % array_length(v_convos,1))],
        (case when g % 2 = 0 then 'user' else 'assistant' end)::ai_role,
        case when g % 2 = 0 then 'What should we do on day ' || (1 + g % 6) || '?'
             else 'Here is a family-friendly plan for that day, within your budget.' end,
        v_uid
      from generate_series(1, n) as g;
    end if;
  end if;

  -- ── travel/readiness scores (120) ─────────────────────────────────────────
  if to_regclass('public.vacation_travel_scores') is not null then
    insert into public.vacation_travel_scores (family_id, vacation_id, score, breakdown, computed_at)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))], 40 + (g * 7) % 61,
      jsonb_build_object('bookings', 20 + g % 30, 'packing', 10 + g % 40, 'documents', 15 + g % 25),
      now() - ((g % 120) || ' days')::interval
    from generate_series(1, 120) as g;
  end if;

  -- ── activity logs (500) ───────────────────────────────────────────────────
  if to_regclass('public.vacation_activity_logs') is not null then
    insert into public.vacation_activity_logs (family_id, vacation_id, actor_member_id, action, detail, created_by, created_at)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
      (array['created','updated','booked','cancelled','commented','packed','checked_in'])[1 + (g % 7)],
      'Seeded activity log entry.', v_uid, now() - ((g % 180) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── notifications (200) ───────────────────────────────────────────────────
  if to_regclass('public.vacation_notifications') is not null then
    insert into public.vacation_notifications (family_id, vacation_id, member_id, title, body, read, send_at, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      case when v_members is null then null else v_members[1 + (g % v_mcount)] end,
      (array['Trip in 7 days','Check-in open','Weather alert','Reservation reminder','Packing reminder'])[1 + (g % 5)] || ' #' || g,
      'Seeded notification body.', (g % 2 = 0), now() + ((g % 30) || ' days')::interval, v_uid
    from generate_series(1, 200) as g;
  end if;

  -- ── audit logs (120) ──────────────────────────────────────────────────────
  if to_regclass('public.vacation_audit_logs') is not null then
    insert into public.vacation_audit_logs (family_id, vacation_id, table_name, record_id, action, changes, actor_user_id, created_by)
    select v_family, v_vacs[1 + (g % array_length(v_vacs,1))],
      (array['vacation_itinerary_items','vacation_expenses','vacation_lodging','vacation_activities'])[1 + (g % 4)],
      gen_random_uuid(), (array['insert','update','delete'])[1 + (g % 3)],
      jsonb_build_object('field', 'value', 'n', g), v_uid, v_uid
    from generate_series(1, 120) as g;
  end if;

  raise notice 'Trips + Vacation Planner seed complete for family % (trips 12/items 500; 12 vacations; itinerary/activities/reservations/expenses/packing/checklists/logs/messages at 500).', v_family;
end $$;
