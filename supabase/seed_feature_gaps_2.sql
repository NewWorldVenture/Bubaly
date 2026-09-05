-- ============================================================================
-- Bubaly · SEED — feature-gap coverage, batch 2 (500 rows each) for more live
-- family features that had NO seed and rendered empty at test time:
--   Smart Devices · Home Warranties · Babysitters · Expense Splits · Date Nights.
-- Each block is guarded by to_regclass (missing table = skipped, never fatal).
-- Idempotent: rows carry a '[seed]' marker in a text column, cleared before insert.
-- Resolves the family by email (falls back to the oldest family). Enums/checks use
-- each table's own default value, so no label guessing.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  n int := 500;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  -- ── Smart Devices (500) ──────────────────────────────────────────────────
  if to_regclass('public.smart_devices') is not null then
    delete from public.smart_devices where family_id = v_family and note like '[seed]%';
    insert into public.smart_devices (family_id, name, type, room, brand, integration, status, last_state, note, created_at)
    select v_family,
      (array['Living Room Light','Front Door Lock','Hallway Thermostat','Backyard Camera','Kitchen Plug','Bedroom Speaker','Doorbell','Robot Vacuum'])[1 + (g % 8)] || ' #' || g,
      (array['light','lock','thermostat','camera','plug','speaker','doorbell','vacuum'])[1 + (g % 8)],
      (array['Living Room','Kitchen','Bedroom','Hallway','Garage','Backyard'])[1 + (g % 6)],
      (array['Philips Hue','August','Nest','Ring','TP-Link','Sonos'])[1 + (g % 6)],
      (array['homekit','google','alexa','smartthings','matter','manual'])[1 + (g % 6)],
      (array['online','offline','unknown'])[1 + (g % 3)],
      (array['On','Off','72°F','Locked','Idle'])[1 + (g % 5)],
      '[seed] device',
      now() - ((g % 120) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Home Warranties (500) ────────────────────────────────────────────────
  if to_regclass('public.home_warranties') is not null then
    delete from public.home_warranties where family_id = v_family and name like '[seed]%';
    insert into public.home_warranties (family_id, name, provider, warranty_type, coverage, starts_on, expires_on, cost, premium_period, created_at)
    select v_family,
      '[seed] ' || (array['Fridge','Washer','HVAC','Roof','Water Heater','Dishwasher'])[1 + (g % 6)] || ' warranty #' || g,
      (array['LG','Asurion','First American','Samsung','Choice Home','American Home Shield'])[1 + (g % 6)],
      (array['manufacturer','extended','home_warranty','service_plan'])[1 + (g % 4)],
      'Parts + labor; $75 deductible per claim.',
      (current_date - (g % 800))::date,
      (current_date + ((g % 700) - 60))::date,
      round((50 + (g % 40) * 10)::numeric, 2),
      (array['one_time','monthly','annual'])[1 + (g % 3)],
      now() - ((g % 300) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Babysitters (500) ────────────────────────────────────────────────────
  if to_regclass('public.babysitter_profiles') is not null then
    delete from public.babysitter_profiles where family_id = v_family and notes like '[seed]%';
    insert into public.babysitter_profiles (family_id, name, phone, email, rate_cents, notes, is_active, created_at)
    select v_family,
      (array['Emma','Olivia','Sophia','Liam','Noah','Ava','Mia','Grace'])[1 + (g % 8)] || ' Sitter ' || g,
      '+1555' || lpad(((g * 3571) % 10000000)::text, 7, '0'),
      'sitter' || g || '@example.com',
      (1500 + (g % 15) * 100)::bigint,
      '[seed] trusted sitter',
      (g % 7 <> 0),
      now() - ((g % 200) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Expense Splits (500) ─────────────────────────────────────────────────
  if to_regclass('public.expense_splits') is not null then
    delete from public.expense_splits where family_id = v_family and description like '[seed]%';
    insert into public.expense_splits (family_id, description, total_cents, category, paid_by, spent_on, note, created_at)
    select v_family,
      '[seed] ' || (array['Groceries','Dinner out','Gas','Movie tickets','Birthday gift','Household supplies'])[1 + (g % 6)] || ' #' || g,
      (500 + (g * 137) % 20000),
      (array['food','transport','entertainment','gifts','household','other'])[1 + (g % 6)],
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      (current_date - (g % 180))::date,
      'Seeded split for testing.',
      now() - ((g % 180) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Date Nights / relationship dates (500) ───────────────────────────────
  if to_regclass('public.relationship_dates') is not null then
    delete from public.relationship_dates where family_id = v_family and title like '[seed]%';
    insert into public.relationship_dates (family_id, kind, title, event_date, recurs_annually, reminder_days_before, member_id, location, notes, created_at)
    select v_family,
      (array['anniversary','birthday','first_date','date_night','milestone','custom'])[1 + (g % 6)],
      '[seed] ' || (array['Anniversary dinner','Movie night','Weekend getaway','Concert','Cooking class','Picnic'])[1 + (g % 6)] || ' #' || g,
      (current_date + ((g % 400) - 100))::date,
      (g % 2 = 0),
      (array[3,7,14,30])[1 + (g % 4)],
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      (array['Home','Downtown','The Grove','Lakeside','Rooftop'])[1 + (g % 5)],
      'Seeded date for testing.',
      now() - ((g % 200) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  raise notice 'Feature-gap batch 2 complete for family % (SmartDevices/Warranties/Babysitters/ExpenseSplits/DateNights, 500 each).', v_family;
end $$;
