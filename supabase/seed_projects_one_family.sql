-- ============================================================================
-- seed_projects_one_family.sql — Home Projects demo data for ONE family (TODO-0413)
-- ----------------------------------------------------------------------------
-- WHAT IT SEEDS (250 rows per table):
--   • home_projects     — 250 projects across rooms and kinds: ideas, planning,
--                         quoting, scheduled, in progress, on hold, done, a few
--                         cancelled; DIY and hired; budgets and dates
--   • project_materials — 250 materials with estimates, actuals and purchased
--                         flags, concentrated on the live DIY projects
--   • project_quotes    — 250 contractor quotes (requested / received /
--                         accepted / declined / expired) on the hired projects,
--                         linked to the family's contractor book when present
-- TARGET FAMILY: resolved at runtime (v_email's family → first family).
-- IDEMPOTENT: rows carry notes = '[seed:projects]' and are deleted before re-insert.
-- HOW TO RUN: npm run db:seed:projects   REQUIRES: migration 0246
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_members uuid[];
  m_count   int;
  n         int := 250;
  contractors uuid[];
  c_count   int;
  titles    text[] := array['Paint the kids'' room','Fix the dripping kitchen faucet','Install garage shelving','Refresh the main bathroom','Replace the backsplash','Stain the deck','Build two raised garden beds','Install a smart thermostat','Replace the dining room light fixture','Add smoke and CO detectors upstairs','Closet system for the hall closet','Laminate flooring in the basement','Clean gutters and add guards','Childproof the kitchen cabinets','Repair the fence gate','Mount the TV and hide cables','Replace the front door lock','Fix the squeaky stairs','Weatherstrip the doors','Paint the front door','Organize the pantry','Install a rain barrel','Replace bathroom exhaust fan','Add under-cabinet lighting','Patch and paint the hallway','New mailbox post'];
  descs     text[] := array['Two walls light blue, ceiling white, fix nail holes first.','Cartridge is shot; replace the whole faucet while we are at it.','Three rows of heavy-duty shelves on the back wall.','New vanity, faucet, tile the shower niche, replace the fan.','Subway tile, white grout, remove the old laminate strip.','Clean, let dry two days, two coats of semi-transparent stain.','4×8 cedar beds with drip irrigation from the hose bib.','Needs a C-wire adapter; the old one is a mercury dial.','Match the kitchen pendants; dimmer on the wall switch.','Interconnected units in every bedroom plus the landing.','Double hang rods, shelf on top, shoe rack below.','Floating floor over the concrete with a vapour barrier.','Front and back, then the mesh guards so it is once a year.','Latches on the lower cabinets, anti-tip straps on the dresser.','Post is rotten at the base; new post and re-hang the gate.','Above the fireplace, cable raceway painted to match.','Keypad deadbolt so the kids stop losing keys.','Shims and screws from below where we can reach.','Foam tape on the back door, sweep on the garage door.','Same red, new brass numbers.','Clear bins, labels, spice rack on the door.','Under the kitchen downspout with a diverter.','Quiet model, vent to the roof not the attic.','LED strips on the underside, plug-in dimmer.','Fill the dents from the move, one coat of the same colour.','Cedar post, set in concrete, new box.'];
  rooms     text[] := array['Kids'' room','Kitchen','Garage','Main bathroom','Kitchen','Deck','Backyard','Hallway','Dining room','Upstairs','Hall closet','Basement','Exterior','Kitchen','Backyard','Living room','Front door','Stairs','Doors','Front door','Pantry','Side yard','Bathroom','Kitchen','Hallway','Front yard'];
  kinds     text[] := array['decor','repair','organization','renovation','renovation','outdoor','outdoor','upgrade','upgrade','safety','organization','renovation','repair','safety','repair','upgrade','safety','repair','upgrade','decor','organization','outdoor','upgrade','upgrade','decor','outdoor'];
  diys      boolean[] := array[true,true,true,false,false,true,true,true,false,true,true,false,false,true,true,true,true,true,true,true,true,true,false,true,true,true];
  statuses  text[] := array['idea','planning','quoting','scheduled','in_progress','done','done','done','on_hold','done','planning','idea','done','in_progress','cancelled','done'];
  mats      text[] := array['Interior paint (gallon)|gal|4500','Primer|gal|2500','Roller + tray kit||1500','Painter''s tape|roll|700','Drop cloths||800','Replacement faucet||12000','Supply lines||900','Shelf boards||2500','Brackets||800','Wall anchors + screws|pack|900','Vanity + sink||45000','Tile|sq ft|400','Grout + thinset||4000','Deck stain / sealer|gal|5500','Deck cleaner||2000','Lumber for beds||1800','Garden soil|bag|900','Drip irrigation kit||4500','Smart thermostat||18000','C-wire adapter||2500','Light fixture||15000','Dimmer switch||3000','Smoke / CO detectors||3500','Cabinet latches|pack|1500','Closet system kit||22000','Bins||1200','Flooring|sq ft|350','Underlayment|sq ft|40','Gutter guards||2500','Sealant||900','Weatherstrip tape|roll|1200','Door sweep||1500','Keypad deadbolt||16000','LED strip kit||4000','Cedar post||3500','Concrete mix|bag|700'];
  stores    text[] := array['Home Depot','Lowe''s','Ace Hardware','Amazon','Local paint store','Menards'];
  pros      text[] := array['Bell Plumbing','Northstar Electric','Two Brothers Tile','Green Thumb Landscaping','Summit Roofing','Handy Hank','Precision Flooring','Bright Spark Electrical','Oak & Iron Carpentry','ClearFlow Gutters'];
  q_status  text[] := array['received','received','accepted','declined','requested','received','expired','received'];
  i         int;
  pid       uuid;
  t_idx     int;
  stat      text;
  v_diy     boolean;
  budget    int;
  start_d   date;
  end_d     date;
  part      text[];
  q_stat    text;
  cid       uuid;
begin
  if to_regclass('public.home_projects') is null then
    raise notice 'home_projects not present — apply migration 0246 first. Skipping.';
    return;
  end if;
  select f.id into v_family from public.families f
    join public.family_members fm on fm.family_id = f.id join auth.users u on u.id = fm.user_id
    where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id order by created_at) into v_members from public.family_members where family_id = v_family and is_active;
  m_count := coalesce(array_length(v_members, 1), 0);
  if m_count = 0 then raise exception 'Family % has no active members.', v_family; end if;
  select fm.user_id into v_user from public.family_members fm where fm.family_id = v_family and fm.user_id is not null order by fm.created_at limit 1;
  if to_regclass('public.home_contractors') is not null then
    select array_agg(id order by created_at) into contractors from public.home_contractors where family_id = v_family and deleted_at is null;
  end if;
  c_count := coalesce(array_length(contractors, 1), 0);

  delete from public.project_quotes where family_id = v_family and notes = '[seed:projects]';
  delete from public.project_materials where family_id = v_family and notes = '[seed:projects]';
  delete from public.home_projects where family_id = v_family and notes = '[seed:projects]';

  -- 1) 250 projects --------------------------------------------------------------------
  create temp table seed_projects (idx int primary key, id uuid not null, is_diy boolean not null, status text not null) on commit drop;
  for i in 1..n loop
    pid := gen_random_uuid();
    t_idx := 1 + (i % array_length(titles, 1));
    stat := statuses[1 + ((i * 5) % array_length(statuses, 1))];
    if i <= 16 then stat := statuses[i]; end if;             -- the first 16 cover every status
    v_diy := diys[t_idx];
    budget := case when i % 9 = 0 then null else (case when v_diy then 15000 + (i * 3700) % 120000 else 80000 + (i * 9100) % 900000 end) end;
    start_d := case stat
      when 'idea' then null
      when 'planning' then current_date + 14 + (i % 30)
      when 'quoting' then current_date + 21 + (i % 30)
      when 'scheduled' then current_date + 3 + (i % 21)
      when 'in_progress' then current_date - (i % 10)
      when 'on_hold' then null
      when 'done' then current_date - (30 + (i * 7) % 700)
      else current_date - (i % 90) end;
    end_d := case when start_d is null then null when stat = 'in_progress' and i % 3 = 0 then current_date - 2 else start_d + 2 + (i % 14) end;
    insert into public.home_projects (id, family_id, title, description, room, kind, status, priority, is_diy, budget_cents, labor_cents, target_start, target_end, completed_at, owner_id, contractor_id, notes, created_by)
    values (pid, v_family,
      titles[t_idx] || case when i > array_length(titles, 1) then ' (' || (i / array_length(titles, 1) + 1) || ')' else '' end,
      descs[t_idx], rooms[t_idx], kinds[t_idx], stat,
      (array['high','medium','medium','low'])[1 + (i % 4)],
      v_diy, budget,
      case when stat = 'done' and not v_diy then 40000 + (i * 1300) % 300000 when stat = 'in_progress' and not v_diy then 20000 else 0 end,
      start_d, end_d,
      case when stat = 'done' then (end_d)::timestamptz + interval '17 hours' else null end,
      v_members[1 + (i % m_count)],
      case when not v_diy and c_count > 0 and stat in ('scheduled','in_progress','done') then contractors[1 + (i % c_count)] else null end,
      '[seed:projects]', v_user);
    insert into seed_projects values (i, pid, v_diy, stat);
  end loop;

  -- 2) 250 materials: on DIY projects, live ones first ---------------------------------
  create temp table seed_diy as
    select row_number() over (order by (case when status in ('planning','scheduled','in_progress','quoting') then 0 when status = 'idea' then 1 else 2 end), idx) as r, id, status
    from seed_projects where is_diy;
  for i in 1..n loop
    select id, status into pid, stat from seed_diy where r = 1 + ((i - 1) % (select count(*) from seed_diy));
    part := string_to_array(mats[1 + (i % array_length(mats, 1))], '|');
    insert into public.project_materials (family_id, project_id, name, quantity, unit, est_cost_cents, actual_cost_cents, is_purchased, store, notes, created_by)
    values (v_family, pid, part[1], case when part[2] in ('sq ft') then 40 + (i % 160) when part[2] in ('bag','roll','pack') then 1 + (i % 6) else 1 + (i % 3) end,
      nullif(part[2], ''), part[3]::int,
      case when stat = 'done' or i % 3 = 0 then round(part[3]::int * (0.85 + (i % 30) / 100.0)) else null end,
      stat = 'done' or i % 3 = 0,
      stores[1 + (i % array_length(stores, 1))], '[seed:projects]', v_user);
  end loop;

  -- 3) 250 quotes: on hired projects, up to three per live project ---------------------
  create temp table seed_hired as
    select row_number() over (order by (case when status in ('quoting','planning','scheduled') then 0 when status = 'in_progress' then 1 else 2 end), idx) as r, id, status
    from seed_projects where not is_diy;
  for i in 1..n loop
    select id, status into pid, stat from seed_hired where r = 1 + ((i - 1) / 3) % (select count(*) from seed_hired);
    q_stat := case
      when stat = 'quoting' then (array['received','received','requested'])[1 + (i % 3)]
      when stat in ('scheduled','in_progress','done') then (array['accepted','declined','declined'])[1 + (i % 3)]
      when stat = 'planning' then (array['requested','requested','received'])[1 + (i % 3)]
      else q_status[1 + (i % array_length(q_status, 1))] end;
    cid := case when c_count > 0 and i % 2 = 0 then contractors[1 + (i % c_count)] else null end;
    insert into public.project_quotes (family_id, project_id, contractor_id, contractor_name, amount_cents, includes_materials, lead_time_days, valid_until, status, received_on, notes, created_by)
    values (v_family, pid, cid,
      coalesce((select name from public.home_contractors where id = cid), pros[1 + (i % array_length(pros, 1))]),
      case when q_stat = 'requested' then 0 else 60000 + (i * 4100) % 700000 end,
      i % 3 = 0, 3 + (i % 28),
      case when q_stat = 'expired' then current_date - 10 - (i % 40) when q_stat in ('received','accepted') then current_date + 10 + (i % 40) else null end,
      q_stat,
      case when q_stat = 'requested' then null else current_date - (i % 45) end,
      '[seed:projects]', v_user);
  end loop;

  raise notice 'Seeded projects for family %: % projects, % materials, % quotes (% contractors linked)',
    v_family,
    (select count(*) from public.home_projects where family_id = v_family and notes = '[seed:projects]'),
    (select count(*) from public.project_materials where family_id = v_family and notes = '[seed:projects]'),
    (select count(*) from public.project_quotes where family_id = v_family and notes = '[seed:projects]'),
    c_count;
end $$;
