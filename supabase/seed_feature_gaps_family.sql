-- ============================================================================
-- Bubaly · SEED — feature-gap coverage (500 rows each) for family features that
-- had NO seed and therefore rendered empty at test time:
--   Rides · Renewals · Immunizations · Health Visits · Family Dates ·
--   Screen-time entries · Wallet goals · Reminder lists.
-- Each block is guarded by to_regclass so a missing table is skipped, never fatal.
-- Idempotent: every row's title is prefixed '[seed] ' and cleared before insert.
-- Resolves the family by email (falls back to the oldest family). Enums use each
-- table's own default value, so no enum-label guessing.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  v_m       uuid;
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
  v_m := case when v_members is null then null else v_members[1] end;

  -- ── Rides (500) ──────────────────────────────────────────────────────────
  if to_regclass('public.rides') is not null then
    delete from public.rides where family_id = v_family and title like '[seed]%';
    insert into public.rides (family_id, title, ride_date, pickup_location, dropoff_location,
                              driver_id, rider_ids, notes, created_at)
    select v_family,
      '[seed] ' || (array['Soccer practice','Piano lesson','School pickup','Dentist','Playdate','Tutoring'])[1 + (g % 6)] || ' #' || g,
      (current_date + ((g % 60) - 30))::date,
      (array['Home','School','Rec Center','Grandma''s'])[1 + (g % 4)],
      (array['Field 3','Studio','Clinic','Library'])[1 + (g % 4)],
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      case when v_members is null then '{}'::uuid[] else array[v_members[1 + ((g+1) % array_length(v_members,1))]] end,
      'Seeded ride for testing.',
      now() - ((g % 90) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Renewals (500) ───────────────────────────────────────────────────────
  if to_regclass('public.renewals') is not null then
    delete from public.renewals where family_id = v_family and title like '[seed]%';
    insert into public.renewals (family_id, member_id, title, category, expires_at, reminder_days, cost, notes, created_at)
    select v_family,
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      '[seed] ' || (array['Passport','Driver''s license','Car registration','Home warranty','Costco membership','Amazon Prime'])[1 + (g % 6)] || ' #' || g,
      (array['passport','license','registration','warranty','subscription','insurance'])[1 + (g % 6)],
      (current_date + ((g % 365) - 30))::date,
      (array[14,30,60,90])[1 + (g % 4)],
      round((20 + (g % 40) * 5)::numeric, 2),
      'Seeded renewal for testing.',
      now() - ((g % 120) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Immunizations (500) ──────────────────────────────────────────────────
  if to_regclass('public.immunizations') is not null then
    delete from public.immunizations where family_id = v_family and vaccine like '[seed]%';
    insert into public.immunizations (family_id, member_id, vaccine, dose_label, date_given, next_due_date, provider_name, notes, created_at)
    select v_family,
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      '[seed] ' || (array['Flu','MMR','Tdap','HPV','COVID-19','Hepatitis B'])[1 + (g % 6)],
      (array['Dose 1','Dose 2','Booster','Annual'])[1 + (g % 4)],
      (current_date - (g % 900))::date,
      (current_date + ((g % 365)))::date,
      (array['Dr. Patel','Kids Clinic','County Health','Pharmacy'])[1 + (g % 4)],
      'Seeded immunization for testing.',
      now() - ((g % 300) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Health Visits (500) ──────────────────────────────────────────────────
  if to_regclass('public.health_visits') is not null then
    delete from public.health_visits where family_id = v_family and title like '[seed]%';
    insert into public.health_visits (family_id, member_id, title, provider_name, location, visit_date, reason, outcome, follow_up_date, cost_cents, created_at)
    select v_family,
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      '[seed] ' || (array['Annual checkup','Sick visit','Dental cleaning','Eye exam','Follow-up','Specialist'])[1 + (g % 6)] || ' #' || g,
      (array['Dr. Patel','Bright Smiles','Vision Center','Children''s Hospital'])[1 + (g % 4)],
      (array['Main St Clinic','Downtown','Suburb Office','Telehealth'])[1 + (g % 4)],
      (current_date - (g % 400))::date,
      'Routine seeded visit.',
      (array['All clear','Prescribed rest','Follow-up in 2 weeks','Referred to specialist'])[1 + (g % 4)],
      case when g % 3 = 0 then (current_date + (g % 60))::date else null end,
      (2000 + (g * 37) % 18000),
      now() - ((g % 400) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Family Dates (500) ───────────────────────────────────────────────────
  if to_regclass('public.family_dates') is not null then
    delete from public.family_dates where family_id = v_family and title like '[seed]%';
    insert into public.family_dates (family_id, member_id, title, event_date, notes, remind_days, created_at)
    select v_family,
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      '[seed] ' || (array['Birthday','Anniversary','First day of school','Adoption day','Family reunion','Graduation'])[1 + (g % 6)] || ' #' || g,
      (date '1990-01-01' + ((g * 7) % 13000))::date,
      'Seeded family date for testing.',
      (array[1,3,7,14])[1 + (g % 4)],
      now() - ((g % 200) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Screen-time entries (500) ────────────────────────────────────────────
  if to_regclass('public.screen_time_entries') is not null then
    delete from public.screen_time_entries where family_id = v_family and note like '[seed]%';
    insert into public.screen_time_entries (family_id, member_id, entry_date, minutes, device, note, logged_by, created_at)
    select v_family,
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      (current_date - (g % 120))::date,
      15 + (g * 7) % 180,
      (array['iPad','Switch','TV','Phone','Laptop'])[1 + (g % 5)],
      '[seed] logged screen time',
      null,
      now() - ((g % 120) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Wallet goals (500 shared/family goals) ───────────────────────────────
  if to_regclass('public.wallet_goals') is not null then
    delete from public.wallet_goals where family_id = v_family and title like '[seed]%';
    insert into public.wallet_goals (family_id, child_wallet_id, title, kind, target_cents, saved_cents, target_date, status, created_at)
    select v_family, null,
      '[seed] ' || (array['New bike','College fund','Family vacation','Charity giving','Rainy-day fund','Video game'])[1 + (g % 6)] || ' #' || g,
      (array['bike','college','vacation','giving','emergency','custom'])[1 + (g % 6)],
      (5000 + (g * 313) % 500000)::bigint,
      ((g * 131) % 5000)::bigint,
      (current_date + ((g % 400)))::date,
      (array['active','active','active','reached','archived'])[1 + (g % 5)],
      now() - ((g % 200) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Reminder lists (500) ─────────────────────────────────────────────────
  if to_regclass('public.reminder_lists') is not null then
    delete from public.reminder_lists where family_id = v_family and name like '[seed]%';
    insert into public.reminder_lists (family_id, name, color, icon, sort_order, created_at)
    select v_family,
      '[seed] ' || (array['Groceries','Errands','Work','School','Home','Health','Travel','Projects'])[1 + (g % 8)] || ' #' || g,
      (array['brand','rose','emerald','amber','sky','violet'])[1 + (g % 6)],
      (array['list','cart','home','book','heart','plane'])[1 + (g % 6)],
      g,
      now() - ((g % 150) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  raise notice 'Feature-gap seed complete for family % (8 features × 500).', v_family;
end $$;
