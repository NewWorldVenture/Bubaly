-- ============================================================================
-- Bubaly · SEED — feature-gap coverage (round 3): user-facing, left-nav tables
-- that had NO seed rows, so their pages rendered empty during testing. Covers:
--   Care Log · Habit logs · Health goals/providers/symptoms · Insurance Hub ·
--   Expense split shares · Reward redemptions · Pet care · Auto (registrations,
--   service) · Home (contractors, service) · Relationship (profile, gift ideas) ·
--   Allowance rules · Member badges · Screen-time limits · Leftovers · Kid progress.
--
-- Resolves the family by the owner email; idempotent (seed rows carry '[seed]'
-- markers or use ON CONFLICT); every child insert is guarded on its parent so a
-- missing table/parent skips that block instead of aborting. Enum columns use
-- enum_range so they never drift. Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email    text := 'newworldventurellc@gmail.com';
  v_family   uuid;
  v_owner    uuid;
  v_members  uuid[];
  v_kids     uuid[];
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
  select array_agg(id) into v_kids from public.family_members
    where family_id = v_family and role in ('child','teen');
  if v_members is null then raise notice 'Family % has no members; nothing to seed.', v_family; return; end if;
  if v_kids is null then v_kids := v_members; end if;

  -- ── Care Log (60) ────────────────────────────────────────────────────────
  if to_regclass('public.care_log') is not null then
    delete from public.care_log where family_id = v_family and note like '[seed]%';
    insert into public.care_log (family_id, member_id, log_type, occurred_at, wellbeing, note, logged_by, created_by)
    select v_family,
      v_members[1 + (g % array_length(v_members,1))],
      (enum_range(null::care_log_type))[1 + (g % array_length(enum_range(null::care_log_type),1))]::care_log_type,
      now() - ((g % 60) || ' days')::interval - ((g % 5) * 3 || ' hours')::interval,
      1 + (g % 5),
      '[seed] Wellbeing check-in',
      v_members[1 + ((g+1) % array_length(v_members,1))],
      v_owner
    from generate_series(1, 60) g;
  end if;

  -- ── Habit logs (up to 120, on existing habits) ───────────────────────────
  if to_regclass('public.habit_logs') is not null and to_regclass('public.habits') is not null then
    delete from public.habit_logs where family_id = v_family and note like '[seed]%';
    insert into public.habit_logs (family_id, habit_id, member_id, log_date, count, note, created_by)
    select v_family, h.id,
      v_members[1 + (d % array_length(v_members,1))],
      (current_date - d),
      1, '[seed] done',
      v_owner
    from public.habits h
    cross join generate_series(0, 19) d
    where h.family_id = v_family and (d % 3) <> 0        -- ~13 of 20 days per habit
    on conflict (habit_id, log_date) do nothing;
  end if;

  -- ── Health goals (per member × metric) ───────────────────────────────────
  if to_regclass('public.health_goals') is not null then
    insert into public.health_goals (family_id, member_id, metric_type, target, period, label, is_active, created_by)
    select v_family, m,
      mt.metric, mt.target, 'daily', mt.label, true, v_owner
    from unnest(v_members) m
    cross join (values ('steps', 8000, 'Daily steps'), ('sleep_hours', 8, 'Sleep'), ('water_ml', 2000, 'Hydration')) as mt(metric, target, label)
    on conflict (member_id, metric_type, period) do nothing;
  end if;

  -- ── Symptom logs (30) ────────────────────────────────────────────────────
  if to_regclass('public.symptom_logs') is not null then
    delete from public.symptom_logs where family_id = v_family and notes like '[seed]%';
    insert into public.symptom_logs (family_id, member_id, symptom, severity, body_area, started_at, ended_at, status, notes, created_by)
    select v_family,
      v_members[1 + (g % array_length(v_members,1))],
      (array['Headache','Cough','Sore throat','Fever','Stomach ache','Runny nose'])[1 + (g % 6)],
      1 + (g % 5),
      (array['head','chest','throat','whole body','abdomen','nose'])[1 + (g % 6)],
      now() - ((g % 40) || ' days')::interval,
      case when g % 3 = 0 then null else now() - ((g % 40) || ' days')::interval + '2 days'::interval end,
      case when g % 3 = 0 then 'active' else 'resolved' end,
      '[seed] symptom note',
      v_owner
    from generate_series(1, 30) g;
  end if;

  -- ── Health providers (8) ─────────────────────────────────────────────────
  if to_regclass('public.health_providers') is not null then
    delete from public.health_providers where family_id = v_family and notes like '[seed]%';
    insert into public.health_providers (family_id, member_id, kind, name, specialty, practice_name, phone, is_primary, notes, created_by)
    select v_family,
      v_members[1 + (g % array_length(v_members,1))],
      (enum_range(null::record_kind))[1 + (g % array_length(enum_range(null::record_kind),1))]::record_kind,
      (array['Dr. Amara Lee','Dr. Ben Ortiz','Dr. Priya Shah','Dr. Chris Wong','City Pediatrics','Bright Smiles Dental','Vision Plus','Dr. Dana Ree'])[1 + (g % 8)],
      (array['Family Medicine','Pediatrics','Dentistry','Optometry','Dermatology','Cardiology','ENT','Orthodontics'])[1 + (g % 8)],
      (array['Downtown Clinic','Main St Medical','Kids Health','Uptown Care'])[1 + (g % 4)],
      '555-01' || lpad(g::text, 2, '0'),
      (g = 1),
      '[seed] provider',
      v_owner
    from generate_series(1, 8) g;
  end if;

  -- ── Insurance policies (6) ───────────────────────────────────────────────
  if to_regclass('public.insurance_policies') is not null then
    delete from public.insurance_policies where family_id = v_family and notes like '[seed]%';
    insert into public.insurance_policies (family_id, member_id, kind, insurer, plan_name, plan_type, policy_number, group_number, customer_service_phone, effective_date, is_primary, notes, created_by)
    select v_family,
      v_members[1 + (g % array_length(v_members,1))],
      (enum_range(null::record_kind))[1 + (g % array_length(enum_range(null::record_kind),1))]::record_kind,
      (array['BlueCross','Aetna','Kaiser','UnitedHealth','Cigna','Delta Dental'])[1 + (g % 6)],
      (array['PPO Gold','HMO Silver','Family Plus','Standard','Premier','Basic'])[1 + (g % 6)],
      (array['PPO','HMO','EPO','POS','PPO','HMO'])[1 + (g % 6)],
      'POL-' || lpad(g::text, 6, '0'),
      'GRP-' || lpad(g::text, 4, '0'),
      '800-555-0' || lpad(g::text, 3, '0'),
      current_date - ((g % 3) || ' years')::interval,
      (g = 1),
      '[seed] policy',
      v_owner
    from generate_series(1, 6) g;
  end if;

  -- ── Expense split shares (guarded on expense_splits; no marker col, so seed
  --    once — re-running never dupes because we skip when shares already exist) ─
  if to_regclass('public.expense_split_shares') is not null and to_regclass('public.expense_splits') is not null
     and not exists (select 1 from public.expense_split_shares where family_id = v_family) then
    insert into public.expense_split_shares (family_id, split_id, member_id, share_cents, settled, settled_at)
    select v_family, s.id,
      v_members[1 + (rn % array_length(v_members,1))],
      2500 + (rn % 6) * 750,
      (rn % 2 = 0),
      case when rn % 2 = 0 then now() - ((rn % 20) || ' days')::interval else null end
    from (
      select id, (row_number() over (order by created_at))::int as rn
      from public.expense_splits where family_id = v_family limit 40
    ) s
    on conflict do nothing;
  end if;

  -- ── Reward redemptions (guarded on rewards) ──────────────────────────────
  if to_regclass('public.reward_redemptions') is not null and to_regclass('public.rewards') is not null then
    delete from public.reward_redemptions where family_id = v_family and note like '[seed]%';
    insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status, note, decided_by, decided_at, created_at)
    select v_family, r.id,
      v_kids[1 + (n % array_length(v_kids,1))],
      r.title, coalesce(r.cost_points, 50),
      (enum_range(null::redemption_status))[1 + (n % array_length(enum_range(null::redemption_status),1))]::redemption_status,
      '[seed] redemption',
      v_members[1], now() - ((n % 30) || ' days')::interval,
      now() - ((n % 30) || ' days')::interval
    from (select id, title, cost_points from public.rewards where family_id = v_family limit 20) r
    cross join generate_series(1, 2) as n
    limit 40;
  end if;

  -- ── Pet care records (guarded on pets) ───────────────────────────────────
  if to_regclass('public.pet_care_records') is not null and to_regclass('public.pets') is not null then
    delete from public.pet_care_records where family_id = v_family and notes like '[seed]%';
    insert into public.pet_care_records (family_id, pet_id, kind, title, record_date, next_due, dose, weight_kg, notes, created_by)
    select v_family, p.id,
      (enum_range(null::public.pet_care_kind))[1 + (g % array_length(enum_range(null::public.pet_care_kind),1))]::public.pet_care_kind,
      (array['Annual checkup','Rabies vaccine','Flea treatment','Grooming','Dental cleaning','Weight check'])[1 + (g % 6)],
      current_date - ((g % 8) * 30),
      current_date + ((g % 6) * 45),
      (array['1 tablet','5 mL','1 dose', null, null, null])[1 + (g % 6)],
      (4.5 + (g % 10))::numeric(6,2),
      '[seed] pet care',
      v_owner
    from public.pets p, generate_series(1, 8) as gs(g)
    where p.family_id = v_family;
  end if;

  -- ── Auto: registrations + service records (guarded on vehicles) ──────────
  if to_regclass('public.vehicle_registrations') is not null and to_regclass('public.vehicles') is not null then
    delete from public.vehicle_registrations where family_id = v_family and notes like '[seed]%';
    insert into public.vehicle_registrations (family_id, vehicle_id, plate, state, registered_on, expires_on, fee, status, notes, created_by)
    select v_family, v.id,
      upper(substr(md5(v.id::text), 1, 3)) || '-' || lpad((1000 + (row_number() over ()))::text, 4, '0'),
      (array['CA','TX','NY','WA','CO'])[1 + ((row_number() over ())::int % 5)],
      current_date - interval '10 months', current_date + interval '2 months',
      85 + (row_number() over () % 4) * 15, 'active', '[seed] registration', v_owner
    from public.vehicles v where v.family_id = v_family;
  end if;
  if to_regclass('public.auto_service_records') is not null and to_regclass('public.vehicles') is not null then
    delete from public.auto_service_records where family_id = v_family and description like '[seed]%';
    insert into public.auto_service_records (family_id, vehicle_id, title, service_date, provider, cost, mileage, description, next_due_on, next_due_mileage, created_by)
    select v_family, v.id,
      (array['Oil change','Tire rotation','Brake service','Battery replacement','Inspection','Coolant flush'])[1 + (g % 6)],
      current_date - ((g % 12) * 30),
      (array['QuickLube','Firestone','Dealer Service','Pep Boys'])[1 + (g % 4)],
      (45 + (g % 8) * 35)::numeric(10,2),
      15000 + g * 900,
      '[seed] service',
      current_date + ((g % 6) * 45),
      15000 + g * 900 + 5000,
      v_owner
    from public.vehicles v, generate_series(1, 15) as gs(g)
    where v.family_id = v_family limit 30;
  end if;

  -- ── Home: contractors (10) + service records (guarded, home_id nullable) ─
  if to_regclass('public.home_contractors') is not null then
    delete from public.home_contractors where family_id = v_family and notes like '[seed]%';
    insert into public.home_contractors (family_id, name, trade, company, phone, email, rating, hourly_rate, is_preferred, last_used_on, notes, created_by)
    select v_family,
      (array['Mike the Plumber','Ace Electric','Cool Air HVAC','Green Lawns','Roof Masters','Bug Away','Handy Hank','Bright Paint','Sparkle Clean','Fix-It Fred'])[g],
      (array['plumbing','electrical','hvac','landscaping','roofing','pest','general','general','general','general'])[g],
      (array['Mike LLC','Ace Co','Cool Air Inc','Green Lawns','Roof Masters','Bug Away','Handy Co','Bright Paint','Sparkle','Fix-It'])[g],
      '555-02' || lpad(g::text, 2, '0'),
      'contact' || g || '@example.com',
      3 + (g % 3),
      (65 + (g % 5) * 20)::numeric(10,2),
      (g <= 3),
      current_date - ((g % 6) * 40),
      '[seed] contractor',
      v_owner
    from generate_series(1, 10) g;
  end if;
  if to_regclass('public.home_service_records') is not null then
    delete from public.home_service_records where family_id = v_family and description like '[seed]%';
    insert into public.home_service_records (family_id, contractor_id, title, service_date, provider, cost, description, next_due_on, created_by)
    select v_family,
      (select id from public.home_contractors where family_id = v_family order by created_at offset (g % greatest((select count(*) from public.home_contractors where family_id = v_family),1)) limit 1),
      (array['HVAC tune-up','Gutter cleaning','Water heater flush','Lawn treatment','Roof inspection','Pest control','Deep clean','Repaint trim'])[1 + (g % 8)],
      current_date - ((g % 10) * 30),
      (array['Cool Air Inc','Green Lawns','Roof Masters','Bug Away'])[1 + (g % 4)],
      (90 + (g % 8) * 45)::numeric(12,2),
      '[seed] home service',
      current_date + ((g % 6) * 60),
      v_owner
    from generate_series(1, 20) g;
  end if;

  -- ── Relationship: profile (1, upsert) + gift ideas (12) ──────────────────
  if to_regclass('public.relationship_profile') is not null then
    insert into public.relationship_profile (family_id, created_by, partner_name, interests, love_languages, gift_budget_cents, notes)
    values (v_family, v_owner, 'Alex', array['hiking','cooking','jazz'], array['quality_time','acts_of_service'], 15000, '[seed] profile')
    on conflict (family_id) do update set partner_name = excluded.partner_name;
  end if;
  if to_regclass('public.relationship_gift_ideas') is not null then
    delete from public.relationship_gift_ideas where family_id = v_family and reason like '[seed]%';
    insert into public.relationship_gift_ideas (family_id, created_by, for_name, title, url, price_cents, occasion, reason, source, status)
    select v_family, v_owner, 'Alex',
      (array['Cooking class','Weekend getaway','Wireless headphones','Concert tickets','Spa day','Book set','Watch','Plant subscription','Board game','Coffee gear','Running shoes','Art print'])[g],
      'https://example.com/gift/' || g,
      (2000 + g * 1500),
      (array['anniversary','birthday','just because','holiday'])[1 + (g % 4)],
      '[seed] gift idea',
      (array['manual','ai','wishlist'])[1 + (g % 3)],
      (array['idea','saved','ordered'])[1 + (g % 3)]
    from generate_series(1, 12) g;
  end if;

  -- ── Allowance rules (guarded on child_wallets; seed once so re-runs don't dupe) ─
  if to_regclass('public.allowance_rules') is not null and to_regclass('public.child_wallets') is not null
     and not exists (select 1 from public.allowance_rules where family_id = v_family) then
    insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on, created_by)
    select v_family, w.id,
      (500 + (row_number() over () % 4) * 250)::bigint,
      (enum_range(null::allowance_cadence))[1 + ((row_number() over ())::int % array_length(enum_range(null::allowance_cadence),1))]::allowance_cadence,
      true, current_date + interval '7 days', v_owner
    from public.child_wallets w where w.family_id = v_family
    on conflict do nothing;
  end if;

  -- ── Member badges (guarded on badges) ────────────────────────────────────
  if to_regclass('public.member_badges') is not null and to_regclass('public.badges') is not null then
    insert into public.member_badges (family_id, member_id, badge_id, awarded_at)
    select v_family, m, b.id, now() - ((b.rn % 30) || ' days')::interval
    from unnest(v_kids) m
    cross join (select id, row_number() over () rn from public.badges limit 6) b
    on conflict (member_id, badge_id) do nothing;
  end if;

  -- ── Kid progress (per kid, upsert) ───────────────────────────────────────
  if to_regclass('public.kid_progress') is not null then
    insert into public.kid_progress (family_id, member_id, xp, level, current_streak, longest_streak, last_activity)
    select v_family, m,
      250 + (row_number() over () * 120)::int,
      1 + (row_number() over () % 5)::int,
      (row_number() over () % 8)::int,
      5 + (row_number() over () % 12)::int,
      current_date - ((row_number() over ())::int % 3)
    from unnest(v_kids) m
    on conflict (member_id) do update set xp = excluded.xp, level = excluded.level;
  end if;

  -- ── Screen-time limits (per kid, upsert) ─────────────────────────────────
  if to_regclass('public.screen_time_limits') is not null then
    insert into public.screen_time_limits (family_id, member_id, daily_minutes, created_by)
    select v_family, m, 60 + (row_number() over () % 4) * 30, v_owner
    from unnest(v_kids) m
    on conflict (family_id, member_id) do update set daily_minutes = excluded.daily_minutes;
  end if;

  -- ── Leftover inventory (12) ──────────────────────────────────────────────
  if to_regclass('public.leftover_inventory') is not null then
    delete from public.leftover_inventory where family_id = v_family and notes like '[seed]%';
    insert into public.leftover_inventory (family_id, name, source_meal, quantity, stored_on, use_by, location, status, notes, created_by)
    select v_family,
      (array['Roast chicken','Veggie curry','Spaghetti','Fried rice','Chili','Lasagna','Stir-fry','Soup','Tacos','Pizza','Salmon','Pancakes'])[g],
      (array['Sunday roast','Weeknight curry','Pasta night','Takeout','Batch cook','Freezer meal'])[1 + (g % 6)],
      (1 + (g % 4)) || ' servings',
      current_date - (g % 5),
      current_date + (3 - (g % 3)),
      (array['fridge','freezer','counter','fridge'])[1 + (g % 4)],
      (array['fresh','frozen','fresh','eaten'])[1 + (g % 4)],
      '[seed] leftover',
      v_owner
    from generate_series(1, 12) g;
  end if;

  raise notice 'Feature-gap round-3 seed complete for family %.', v_family;
end $$;
