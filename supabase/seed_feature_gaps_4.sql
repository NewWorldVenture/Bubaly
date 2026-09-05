-- ============================================================================
-- Bubaly · SEED — feature-gap coverage (round 4): more user-facing left-nav
-- tables that had no seed rows. Covers: event RSVPs · meal nutrition · trip plans ·
-- departure plans · calendar feeds · driver licenses · rental cars · vehicle
-- inspections · homes · household info · home security events · gift links ·
-- parent approvals.
--
-- Same conventions as seed_feature_gaps_3.sql: family-by-email, every child insert
-- guarded on its parent (to_regclass + parent existence), enum_range for enums,
-- idempotent via '[seed]' markers / "seed once when none exist". PG16-validated.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_owner   uuid;
  v_members uuid[];
  v_kids    uuid[];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select u.id into v_owner from auth.users u where lower(u.email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  select array_agg(id) into v_kids from public.family_members where family_id = v_family and role in ('child','teen');
  if v_members is null then raise notice 'no members'; return; end if;
  if v_kids is null then v_kids := v_members; end if;

  -- ── Event RSVPs (on existing calendar_events; seed once per family) ───────
  if to_regclass('public.event_rsvps') is not null and to_regclass('public.calendar_events') is not null
     and not exists (select 1 from public.event_rsvps where family_id = v_family) then
    insert into public.event_rsvps (event_id, family_id, member_id, status)
    select e.id, v_family, v_members[1 + ((e.rn + m.i) % array_length(v_members,1))],
      (enum_range(null::rsvp_status))[1 + ((e.rn + m.i) % array_length(enum_range(null::rsvp_status),1))]::rsvp_status
    from (select id, (row_number() over (order by starts_at))::int rn from public.calendar_events where family_id = v_family limit 30) e
    cross join (select generate_series(1, array_length(v_members,1)) as i) m
    on conflict do nothing;
  end if;

  -- ── Meal nutrition (12) ──────────────────────────────────────────────────
  if to_regclass('public.meal_nutrition') is not null then
    delete from public.meal_nutrition where family_id = v_family and summary like '[seed]%';
    insert into public.meal_nutrition (family_id, subject_type, subject_id, servings, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, summary, created_by)
    select v_family,
      (array['recipe','meal','week'])[1 + (g % 3)],
      'seed-' || g,
      2 + (g % 4),
      350 + (g % 8) * 90,
      (12 + (g % 20))::numeric, (25 + (g % 40))::numeric, (8 + (g % 18))::numeric,
      (3 + (g % 8))::numeric, (4 + (g % 15))::numeric, (200 + (g % 10) * 80)::numeric,
      '[seed] balanced meal',
      v_owner
    from generate_series(1, 12) g;
  end if;

  -- ── Trip plans (4; seed once) ────────────────────────────────────────────
  if to_regclass('public.trip_plans') is not null
     and not exists (select 1 from public.trip_plans where family_id = v_family and interests = '[seed]') then
    insert into public.trip_plans (family_id, created_by, title, destination, start_date, end_date, members, interests, status, weather_summary)
    select v_family, v_owner,
      (array['Summer in Maui','Ski week at Tahoe','Grandparents in Denver','City break — NYC'])[g],
      (array['Maui, HI','Lake Tahoe, CA','Denver, CO','New York, NY'])[g],
      current_date + (g * 30), current_date + (g * 30 + 6),
      '["You","Sam","Emma","Leo"]'::jsonb, '[seed]',
      'researched', 'Sunny, mid-70s°F'
    from generate_series(1, 4) g;
  end if;

  -- ── Departure plans (4; seed once — event_start is required) ──────────────
  if to_regclass('public.departure_plans') is not null
     and not exists (select 1 from public.departure_plans where family_id = v_family and title like '[seed]%') then
    insert into public.departure_plans (family_id, created_by, title, origin, destination, event_start, prep_minutes, park_minutes, buffer_minutes, drive_seconds, leave_by, weather_summary, status)
    select v_family, v_owner,
      '[seed] ' || (array['Soccer game','Dentist run','Airport drop-off','School play'])[g],
      'Home', (array['City Field','Main St Clinic','SFO','School Auditorium'])[g],
      now() + (g || ' days')::interval + interval '9 hours',
      30, 10, 5, (900 + g * 300),
      now() + (g || ' days')::interval + interval '8 hours',
      'Clear', 'active'
    from generate_series(1, 4) g;
  end if;

  -- ── Calendar feeds (3) ───────────────────────────────────────────────────
  if to_regclass('public.calendar_feeds') is not null then
    delete from public.calendar_feeds where family_id = v_family and name like '[seed]%';
    insert into public.calendar_feeds (family_id, name, url, color, last_status, event_count, last_synced_at, created_by)
    select v_family,
      '[seed] ' || (array['School Calendar','Soccer League','Holidays'])[g],
      'https://example.com/feed' || g || '.ics',
      (array['blue','green','red'])[g],
      'ok', 10 + g * 5, now() - (g || ' hours')::interval, v_owner
    from generate_series(1, 3) g;
  end if;

  -- ── Driver licenses (per adult-ish member; seed once) ────────────────────
  if to_regclass('public.driver_licenses') is not null
     and not exists (select 1 from public.driver_licenses where family_id = v_family and notes like '[seed]%') then
    insert into public.driver_licenses (family_id, member_id, holder_name, license_number, state, license_class, issued_on, expires_on, status, notes, created_by)
    select v_family, m.id, coalesce(m.display_name,'Driver'),
      'DL' || upper(substr(md5(m.id::text),1,7)),
      (array['CA','TX','NY','WA'])[1 + (m.rn % 4)], 'C',
      current_date - interval '3 years', current_date + interval '2 years',
      'active', '[seed] license', v_owner
    from (select id, display_name, (row_number() over ())::int rn from public.family_members where family_id = v_family and role in ('parent','adult','caregiver')) m;
  end if;

  -- ── Rental cars (3; seed once) ───────────────────────────────────────────
  if to_regclass('public.rental_cars') is not null
     and not exists (select 1 from public.rental_cars where family_id = v_family and notes like '[seed]%') then
    insert into public.rental_cars (family_id, company, confirmation_number, pickup_location, dropoff_location, pickup_at, return_at, vehicle_desc, daily_rate, total_cost, status, notes, created_by)
    select v_family,
      (array['Hertz','Enterprise','Avis'])[g],
      'CONF-' || lpad(g::text,6,'0'),
      (array['SFO Airport','Downtown','Airport'])[g], (array['SFO Airport','Downtown','Airport'])[g],
      now() + (g*20 || ' days')::interval, now() + (g*20+5 || ' days')::interval,
      (array['SUV — Toyota RAV4','Sedan — Honda Accord','Minivan — Chrysler Pacifica'])[g],
      (49 + g*10)::numeric, (245 + g*50)::numeric, 'upcoming', '[seed] rental', v_owner
    from generate_series(1, 3) g;
  end if;

  -- ── Vehicle inspections (on vehicles) ────────────────────────────────────
  if to_regclass('public.vehicle_inspections') is not null and to_regclass('public.vehicles') is not null then
    delete from public.vehicle_inspections where family_id = v_family and notes like '[seed]%';
    insert into public.vehicle_inspections (family_id, vehicle_id, inspection_type, station, inspected_on, expires_on, result, notes, created_by)
    select v_family, v.id,
      (array['safety','emissions','both'])[1 + (g % 3)],
      (array['QuickCheck Station','State Inspection','AutoCare'])[1 + (g % 3)],
      current_date - ((g % 12) * 30), current_date + interval '1 year',
      (array['pass','pass','advisory'])[1 + (g % 3)], '[seed] inspection', v_owner
    from public.vehicles v, generate_series(1, 2) as gs(g)
    where v.family_id = v_family;
  end if;

  -- ── Homes (seed once — 1 primary home) ───────────────────────────────────
  if to_regclass('public.homes') is not null
     and not exists (select 1 from public.homes where family_id = v_family and notes like '[seed]%') then
    insert into public.homes (family_id, name, address, home_type, year_built, square_feet, bedrooms, bathrooms, purchase_date, is_primary, notes, created_by)
    values (v_family, 'Main House', '123 Maple Street', 'single_family', 2004, 2200, 4, 2.5, current_date - interval '6 years', true, '[seed] home', v_owner);
  end if;

  -- ── Household info (10) ───────────────────────────────────────────────────
  if to_regclass('public.household_info') is not null then
    delete from public.household_info where family_id = v_family and note like '[seed]%';
    insert into public.household_info (family_id, category, label, value, note, is_sensitive, sort, created_by)
    select v_family,
      (array['account','contact','wifi','emergency','instruction'])[1 + (g % 5)],
      (array['Electric account','Plumber','Wifi network','Emergency contact','Trash day','Gas account','HOA','Alarm code','Pediatrician','Water account'])[g],
      (array['#4471','555-0110','HomeNet','Aunt May 555-0134','Tuesday','#8891','Maple HOA','on the fridge','Dr. Lee','#2213'])[g],
      '[seed] info', (g % 4 = 0), g, v_owner
    from generate_series(1, 10) g;
  end if;

  -- ── Home security events (12) ────────────────────────────────────────────
  if to_regclass('public.home_security_events') is not null then
    delete from public.home_security_events where family_id = v_family and detail like '[seed]%';
    insert into public.home_security_events (family_id, kind, severity, title, detail, occurred_at, resolved, resolved_at, created_by)
    select v_family,
      (array['motion','door','alarm','camera'])[1 + (g % 4)],
      (array['info','warning','critical'])[1 + (g % 3)],
      (array['Front door opened','Motion detected','Alarm armed','Camera offline','Back door unlocked','Package delivered'])[1 + (g % 6)],
      '[seed] security event',
      now() - ((g % 30) || ' days')::interval - ((g % 12) || ' hours')::interval,
      (g % 3 <> 0), case when g % 3 <> 0 then now() - ((g % 30) || ' days')::interval else null end,
      v_owner
    from generate_series(1, 12) g;
  end if;

  -- ── Gift links (on child_wallets; seed once) ─────────────────────────────
  if to_regclass('public.gift_links') is not null and to_regclass('public.child_wallets') is not null
     and not exists (select 1 from public.gift_links where family_id = v_family and message like '[seed]%') then
    insert into public.gift_links (family_id, child_wallet_id, token, occasion, message, is_active, created_by)
    select v_family, w.id,
      encode(gen_random_bytes(12),'hex'),
      (array['birthday','holiday','graduation','just_because'])[1 + ((row_number() over ())::int % 4)],
      '[seed] Send a little something!', true, v_owner
    from public.child_wallets w where w.family_id = v_family;
  end if;

  -- ── Parent approvals (10) ─────────────────────────────────────────────────
  if to_regclass('public.parent_approvals') is not null then
    delete from public.parent_approvals where family_id = v_family and note like '[seed]%';
    insert into public.parent_approvals (family_id, kind, amount_cents, status, requested_by, decided_by, decided_at, note)
    select v_family,
      (array['gift','chore_reward','card_spend','withdrawal'])[1 + (g % 4)],
      (500 + (g % 8) * 500)::bigint,
      (enum_range(null::approval_status))[1 + (g % array_length(enum_range(null::approval_status),1))]::approval_status,
      v_owner,
      case when g % 2 = 0 then v_owner else null end,
      case when g % 2 = 0 then now() - ((g % 20) || ' days')::interval else null end,
      '[seed] approval'
    from generate_series(1, 10) g;
  end if;

  raise notice 'Feature-gap round-4 seed complete for family %.', v_family;
end $$;
