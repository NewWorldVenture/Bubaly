-- ============================================================================
-- Bubaly · SEED — Feature-matrix gap tables (500 records each).
-- Fills the competitive-matrix features that lacked a 500-row seed so every one
-- can be tested at volume: Pets, Vehicles, Contacts, Wish lists, Medications,
-- Homework, Insurance, Utilities, Family tree, Announcements, Subscriptions,
-- Health metrics. Idempotent via '[seed:matrix]' / 'seed' sentinels; resolves
-- the family by email. Where: Supabase → SQL Editor → paste → Run.
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

  -- ── Pets (500) ──────────────────────────────────────────────────────────
  delete from public.pets where family_id = v_family and notes = '[seed:matrix]';
  insert into public.pets (family_id, name, species, breed, color, notes, is_active)
  select v_family,
    (array['Bella','Max','Luna','Charlie','Lucy','Cooper','Daisy','Rocky'])[1+(g.i%8)] || ' #' || g.i,
    (enum_range(null::pet_species))[1 + (g.i % array_length(enum_range(null::pet_species),1))]::pet_species,
    (array['Labrador','Tabby','Parakeet','Goldfish','Gecko','Hamster'])[1+(g.i%6)],
    (array['Brown','Black','White','Golden','Grey'])[1+(g.i%5)], '[seed:matrix]', true
  from generate_series(1,n) g(i);

  -- ── Vehicles (500) ──────────────────────────────────────────────────────
  delete from public.vehicles where family_id = v_family and notes = '[seed:matrix]';
  insert into public.vehicles (family_id, nickname, make, model, year, color, mileage, status, notes, primary_driver)
  select v_family,
    (array['Family SUV','Commuter','The Van','Weekend Car'])[1+(g.i%4)] || ' #' || g.i,
    (array['Toyota','Honda','Ford','Subaru','Tesla'])[1+(g.i%5)],
    (array['Highlander','CR-V','F-150','Outback','Model Y'])[1+(g.i%5)],
    2012 + (g.i % 13), (array['Silver','Blue','Black','Red','White'])[1+(g.i%5)],
    10000 + (g.i*137)%140000, 'active', '[seed:matrix]',
    case when v_members is null then null else v_members[1+(g.i%array_length(v_members,1))] end
  from generate_series(1,n) g(i);

  -- ── Family contacts (500) ───────────────────────────────────────────────
  delete from public.family_contacts where family_id = v_family and notes = '[seed:matrix]';
  insert into public.family_contacts (family_id, name, relationship, category, phone, email, is_emergency, notes)
  select v_family,
    (array['Dr. Lee','Coach Rivera','Grandma Sue','Aunt Mia','Mr. Park','Nurse Kim'])[1+(g.i%6)] || ' #' || g.i,
    (array['Doctor','Coach','Grandparent','Aunt','Teacher','Neighbor'])[1+(g.i%6)],
    (array['doctor','coach','family','emergency','neighbor','teacher'])[1+(g.i%6)],
    '555-' || lpad((g.i%10000)::text,4,'0'), 'contact'||g.i||'@example.com',
    (g.i%7=0), '[seed:matrix]'
  from generate_series(1,n) g(i);

  -- ── Wish lists (500) — needs a member ───────────────────────────────────
  if v_members is not null then
    delete from public.wishlist_items where family_id = v_family and notes = '[seed:matrix]';
    insert into public.wishlist_items (family_id, member_id, title, url, price, priority, notes, is_purchased)
    select v_family, v_members[1+(g.i%array_length(v_members,1))],
      (array['Lego set','Bike','Headphones','Book','Sneakers','Board game'])[1+(g.i%6)] || ' #' || g.i,
      'https://example.com/'||g.i, round((10+random()*200)::numeric,2),
      (enum_range(null::wish_priority))[1 + (g.i % array_length(enum_range(null::wish_priority),1))]::wish_priority, '[seed:matrix]', (g.i%9=0)
    from generate_series(1,n) g(i);
  end if;

  -- ── Medications (500) ───────────────────────────────────────────────────
  delete from public.medications where family_id = v_family and instructions = '[seed:matrix]';
  insert into public.medications (family_id, member_id, name, dosage, instructions, is_active, refill_on)
  select v_family, case when v_members is null then null else v_members[1+(g.i%array_length(v_members,1))] end,
    (array['Amoxicillin','Vitamin D','Ibuprofen','Allergy Rx','Inhaler','Melatonin'])[1+(g.i%6)] || ' #' || g.i,
    (array['5mg','10mg','1 tab','2 tabs','1 puff'])[1+(g.i%5)], '[seed:matrix]', true,
    (current_date + (g.i%40))
  from generate_series(1,n) g(i);

  -- ── Homework (500) ──────────────────────────────────────────────────────
  delete from public.homework_assignments where family_id = v_family and details = '[seed:matrix]';
  insert into public.homework_assignments (family_id, member_id, subject, title, details, due_at, status)
  select v_family, case when v_members is null then null else v_members[1+(g.i%array_length(v_members,1))] end,
    (array['Math','Science','English','History','Art','PE'])[1+(g.i%6)],
    (array['Worksheet','Reading','Project','Essay','Lab report'])[1+(g.i%5)] || ' #' || g.i,
    '[seed:matrix]', now() + ((g.i%21) || ' days')::interval,
    (enum_range(null::homework_status))[1 + (g.i % array_length(enum_range(null::homework_status),1))]::homework_status
  from generate_series(1,n) g(i);

  -- ── Insurance policies (500) ────────────────────────────────────────────
  delete from public.family_insurance_policies where family_id = v_family and notes = '[seed:matrix]';
  insert into public.family_insurance_policies (family_id, policy_type, insurer, policy_number, premium_amount, premium_frequency, renewal_date, notes, is_active)
  select v_family,
    (enum_range(null::insurance_policy_type))[1 + (g.i % array_length(enum_range(null::insurance_policy_type),1))]::insurance_policy_type,
    (array['Aetna','Delta','VSP','Geico','StateFarm','Prudential'])[1+(g.i%6)],
    'POL-' || lpad(g.i::text,6,'0'), round((50+random()*400)::numeric,2),
    (enum_range(null::premium_frequency))[1 + (g.i % array_length(enum_range(null::premium_frequency),1))]::premium_frequency,
    (current_date + (g.i%365)), '[seed:matrix]', true
  from generate_series(1,n) g(i);

  -- ── Utility bills (500) ─────────────────────────────────────────────────
  delete from public.utility_bills where family_id = v_family and note = '[seed:matrix]';
  insert into public.utility_bills (family_id, kind, provider, period_month, amount_cents, usage, unit, note)
  select v_family,
    (array['electric','water','gas','internet','trash'])[1+(g.i%5)],
    (array['PG&E','City Water','SoCalGas','Comcast','WM'])[1+(g.i%5)],
    (date_trunc('month', current_date) - ((g.i%24) || ' months')::interval)::date,
    (3000 + (g.i*97)%25000), round((random()*500)::numeric,1),
    (array['kWh','gal','therm','GB','lbs'])[1+(g.i%5)], '[seed:matrix]'
  from generate_series(1,n) g(i);

  -- ── Family tree (500) ───────────────────────────────────────────────────
  delete from public.family_tree_nodes where family_id = v_family and bio = '[seed:matrix]';
  insert into public.family_tree_nodes (family_id, name, relationship, birth_year, bio)
  select v_family,
    (array['Grandpa Joe','Grandma Ann','Uncle Ray','Cousin Kai','Great Aunt Bea'])[1+(g.i%5)] || ' #' || g.i,
    (array['grandparent','uncle','aunt','cousin','sibling'])[1+(g.i%5)],
    1930 + (g.i%80), '[seed:matrix]'
  from generate_series(1,n) g(i);

  -- ── Announcements (500) ─────────────────────────────────────────────────
  delete from public.family_announcements where family_id = v_family and body like '%[seed:matrix]%';
  insert into public.family_announcements (family_id, title, body, is_pinned)
  select v_family,
    (array['Family meeting','Chore day','Movie night','Trip planning','Reminder'])[1+(g.i%5)] || ' #' || g.i,
    'Details for this announcement #' || g.i || ' [seed:matrix]', (g.i%25=0)
  from generate_series(1,n) g(i);

  -- ── Subscriptions (500) ─────────────────────────────────────────────────
  delete from public.subscriptions_tracked where family_id = v_family and note = '[seed:matrix]';
  insert into public.subscriptions_tracked (family_id, name, cost_cents, cadence, category, status, next_charge, note)
  select v_family,
    (array['Netflix','Spotify','Disney+','Amazon Prime','iCloud','NYT'])[1+(g.i%6)] || ' #' || g.i,
    (499 + (g.i*13)%3000), (array['monthly','yearly'])[1+(g.i%2)],
    (array['streaming','music','storage','news','shopping'])[1+(g.i%5)],
    (array['active','trial','canceled'])[1+(g.i%3)], (current_date + (g.i%30)), '[seed:matrix]'
  from generate_series(1,n) g(i);

  -- ── Health metrics (500) — needs a member; unit='seed' is the sentinel ───
  if v_members is not null then
    delete from public.health_metrics where family_id = v_family and unit = 'seed';
    insert into public.health_metrics (family_id, member_id, type, value, unit, recorded_at)
    select v_family, v_members[1+(g.i%array_length(v_members,1))],
      (enum_range(null::metric_type))[1 + (g.i % array_length(enum_range(null::metric_type),1))]::metric_type,
      round((10 + random()*9000)::numeric,1), 'seed', now() - ((g.i) || ' hours')::interval
    from generate_series(1,n) g(i);
  end if;

  raise notice 'Matrix-gap features seeded (500 each) for family %', v_family;
end $$;
