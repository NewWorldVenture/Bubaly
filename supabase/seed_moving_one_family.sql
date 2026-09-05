-- ============================================================================
-- seed_moving_one_family.sql — Move Planner demo data for ONE family (TODO-0412)
-- ----------------------------------------------------------------------------
-- WHAT IT SEEDS (250 rows per table):
--   • moves      — 1 live move five weeks out (planning, kids + pets, budget,
--                  mover quote) + 249 finished moves spread over past years
--   • move_tasks — the full T-8w → T+2w checklist for the live move (with
--                  template keys so the planner never duplicates it), the rest
--                  as completed tasks on the older moves
--   • move_boxes — numbered, labelled boxes with contents; the live move's
--                  boxes are mid-packing, older moves are fully unpacked
-- TARGET FAMILY: resolved at runtime (v_email's family → first family).
-- IDEMPOTENT: rows carry notes = '[seed:moving]' and are deleted before re-insert.
-- HOW TO RUN: npm run db:seed:moving   REQUIRES: migration 0245
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_members uuid[];
  m_count   int;
  n         int := 250;
  streets   text[] := array['Maple Street','Oak Avenue','Riverside Drive','Hillcrest Road','Elm Court','Cedar Lane','Lakeview Terrace','Birch Way','Sunset Boulevard','Harbor Street','Willow Close','Meadow Lane','Pine Ridge','Park Place','Orchard Row','Station Road'];
  cities    text[] := array['Austin','Denver','Portland','Raleigh','Madison','Boise','Nashville','Tucson','Columbus','Richmond'];
  kinds     text[] := array['local','local','local','long_distance','within_building','long_distance','international'];
  -- Template (key, title, category, offset) — mirrors lib/moving/planner.ts MOVE_TEMPLATE.
  t_keys    text[] := array['budget','quotes','declutter','school-notify','school-enrol','landlord','book-movers','supplies','vet','medical-records','insurance','pack-storage','utilities-new','utilities-old','mail','address-bank','address-gov','pack-rooms','time-off','pet-sitter','confirm-movers','essentials-box','defrost','kids-bag','cash-tips','walkthrough','load','beds-first','deposit','register-local','pet-tag','unpack-all','neighbours'];
  t_titles  text[] := array['Set the moving budget and open a moving folder','Get three mover quotes (or book a truck)','Declutter room by room: sell, donate, toss','Tell the current school and request records','Enrol at the new school / childcare','Give notice to the landlord / confirm handover date','Book the movers and confirm the date in writing','Order boxes, tape, markers and bubble wrap','Vet visit: records, vaccines, travel certificate','Transfer doctor, dentist and pharmacy records','Update home / renters and car insurance','Pack storage, books, off-season clothes','Set up power, water, internet at the new place','Schedule final readings / disconnect at the old place','Mail forwarding with the post office','Change address: bank, cards, employer, subscriptions','Change address: licence, vehicle registration, voter roll','Pack every room except the kitchen and daily essentials','Book time off work and arrange childcare for move day','Arrange a pet sitter or a quiet room for move day','Confirm movers, parking and elevator booking','Pack the first-night essentials box (kettle, meds, chargers, sheets)','Empty and defrost the fridge / freezer','Each kid packs a moving-day backpack','Cash for tips, snacks and water for the crew','Final walk-through, photos, meter readings, keys','Load: fragile last on, essentials box in the car','Beds, bathroom and kitchen unpacked first','Return keys and chase the deposit','Register with a new doctor, dentist and vet','Update the pet’s microchip and tag address','Every box unpacked and flattened','Meet the neighbours, find the nearest playground and pharmacy'];
  t_cats    text[] := array['finance','movers','packing','school','school','admin','movers','packing','pets','medical','finance','packing','utilities','utilities','address','address','address','packing','admin','pets','movers','packing','cleaning','school','movers','cleaning','movers','settling','finance','medical','pets','settling','settling'];
  t_offsets int[]  := array[-56,-56,-49,-49,-42,-42,-42,-35,-35,-35,-28,-28,-21,-21,-14,-14,-14,-10,-10,-7,-7,-3,-2,-2,-1,0,0,1,3,7,7,14,14];
  rooms     text[] := array['Kitchen','Living room','Primary bedroom','Kids'' room','Office','Bathroom','Garage','Dining room','Playroom','Hall closet','Laundry','Basement'];
  labels    text[] := array['Everyday plates and bowls','Pots and pans','Books — top shelf','Winter coats','Board games','Desk drawer contents','Towels and sheets','Lego and blocks','Framed photos','Small appliances','Toiletries','Tools','Cables and chargers','Shoes','Lamps','Glassware','Pantry dry goods','School supplies','Craft supplies','Bedding','Sports gear','Vinyl records','Bathroom cabinet','Spare linens'];
  contents  text[] := array['Plates|Bowls|Mugs|Cutlery tray','Frying pan|Stock pot|Lids|Trivets','Novels|Cookbooks|Atlas','Puffer coat|Wool coat|Gloves|Scarves',
    'Catan|Ticket to Ride|Uno|Chess set','Pens|Stapler|Notebooks|Headphones','Bath towels|Fitted sheets|Pillowcases','Lego bins|Wooden blocks|Duplo',
    'Wedding photo|School portraits|Frames','Toaster|Kettle|Blender','Shampoo|Toothbrushes|First-aid kit','Drill|Screwdrivers|Tape measure|Level',
    'HDMI cables|Chargers|Power strips|Router','Sneakers|Boots|Sandals','Bedside lamp|Floor lamp|Bulbs','Wine glasses|Tumblers|Pitcher',
    'Rice|Pasta|Tins|Spices','Backpacks|Pencil cases|Folders','Paints|Paper|Glue|Scissors','Duvet|Comforter|Pillows',
    'Soccer ball|Bike helmets|Tennis rackets','Records|Turntable|Speaker','Medicine|Razors|Hair dryer','Guest sheets|Blankets|Throws'];
  i         int;
  mv        uuid;
  live      uuid;
  mem       uuid;
  tcount    int;
  mv_date   date;
  v_status  text;
  box_stat  text;
begin
  if to_regclass('public.moves') is null then
    raise notice 'moves not present — apply migration 0245 first. Skipping.';
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
  tcount := array_length(t_keys, 1);

  delete from public.move_boxes where family_id = v_family and notes = '[seed:moving]';
  delete from public.move_tasks where family_id = v_family and notes = '[seed:moving]';
  delete from public.moves where family_id = v_family and notes = '[seed:moving]';

  -- 1) 250 moves: #1 live, the rest history ---------------------------------------
  create temp table seed_moves (idx int primary key, id uuid not null, move_date date not null, has_kids boolean, has_pets boolean) on commit drop;
  for i in 1..n loop
    mv := gen_random_uuid();
    if i = 1 then
      mv_date := current_date + 35; v_status := 'planning';
    else
      mv_date := current_date - ((i - 1) * 37 + (i % 11)) ; v_status := case when i % 23 = 0 then 'cancelled' else 'done' end;
    end if;
    insert into public.moves (id, family_id, title, from_address, to_address, move_date, status, move_kind, budget_cents, spent_cents, mover_name, mover_phone, mover_quote_cents, has_kids, has_pets, is_renting_out, notes, created_by)
    values (mv, v_family,
      case when i = 1 then 'Move to Maple Street' else 'Move to ' || streets[1 + (i % array_length(streets, 1))] || case when i > array_length(streets, 1) then ' (' || cities[1 + (i % array_length(cities, 1))] || ')' else '' end end,
      (10 + i) || ' ' || streets[1 + ((i + 5) % array_length(streets, 1))] || ', ' || cities[1 + ((i + 3) % array_length(cities, 1))],
      (20 + i) || ' ' || streets[1 + (i % array_length(streets, 1))] || ', ' || cities[1 + (i % array_length(cities, 1))],
      mv_date, v_status, kinds[1 + (i % array_length(kinds, 1))],
      case when i % 5 = 0 then null else 300000 + (i * 1700) % 600000 end,
      case when i = 1 then 145000 else 200000 + (i * 1300) % 500000 end,
      case when i % 3 = 0 then null else (array['Two Guys & a Truck','Northstar Movers','Bell Family Removals','CityHaul'])[1 + (i % 4)] end,
      case when i % 3 = 0 then null else '555-01' || lpad((i % 100)::text, 2, '0') end,
      case when i % 3 = 0 then null else 180000 + (i * 900) % 300000 end,
      i % 4 <> 3, i % 3 = 0, i % 7 = 0,
      '[seed:moving]', v_user);
    insert into seed_moves values (i, mv, mv_date, i % 4 <> 3, i % 3 = 0);
  end loop;
  select id into live from seed_moves where idx = 1;

  -- 2) 250 tasks: full checklist on the live move, done tasks on older moves ----------
  for i in 1..n loop
    if i <= tcount then
      -- Live move: the template, keyed. Past-due steps are done, the rest todo/doing.
      mem := v_members[1 + (i % m_count)];
      insert into public.move_tasks (family_id, move_id, title, category, offset_days, due_date, assignee_id, status, completed_at, template_key, notes, created_by)
      values (v_family, live, t_titles[i], t_cats[i], t_offsets[i], current_date + 35 + t_offsets[i], mem,
        case when t_offsets[i] <= -42 then 'done' when t_offsets[i] <= -35 and i % 2 = 0 then 'done' when t_offsets[i] <= -28 and i % 3 = 0 then 'doing' else 'todo' end,
        case when t_offsets[i] <= -42 or (t_offsets[i] <= -35 and i % 2 = 0) then now() - ((-(35 + t_offsets[i])) || ' days')::interval else null end,
        t_keys[i], '[seed:moving]', v_user);
    else
      -- Older moves: completed checklist steps spread over the history.
      select id, move_date into mv, mv_date from seed_moves where idx = 2 + ((i - tcount - 1) % (n - 1));
      insert into public.move_tasks (family_id, move_id, title, category, offset_days, due_date, assignee_id, status, completed_at, template_key, notes, created_by)
      values (v_family, mv, t_titles[1 + (i % tcount)], t_cats[1 + (i % tcount)], t_offsets[1 + (i % tcount)], mv_date + t_offsets[1 + (i % tcount)], v_members[1 + (i % m_count)],
        case when i % 17 = 0 then 'skipped' else 'done' end,
        case when i % 17 = 0 then null else (mv_date + t_offsets[1 + (i % tcount)])::timestamptz + interval '18 hours' end,
        t_keys[1 + (i % tcount)], '[seed:moving]', v_user);
    end if;
  end loop;

  -- 3) 250 boxes: live move mid-packing (#1–60), older moves fully unpacked ---------
  for i in 1..n loop
    if i <= 60 then
      mv := live;
      box_stat := case when i <= 22 or i % 9 = 0 then 'packed' else 'empty' end;
    else
      select id into mv from seed_moves where idx = 2 + ((i - 61) % (n - 1));
      box_stat := case when i % 29 = 0 then 'delivered' else 'unpacked' end;
    end if;
    insert into public.move_boxes (family_id, move_id, box_number, label, from_room, to_room, contents, is_fragile, is_essential, status, packed_by, notes, created_by)
    values (v_family, mv,
      case when i <= 60 then i else 1 + ((i - 61) / (n - 1)) + ((i - 61) % 7) end,
      labels[1 + (i % array_length(labels, 1))] || case when i <= 60 and i > array_length(labels, 1) then ' ' || (i / array_length(labels, 1)) + 1 else '' end,
      rooms[1 + (i % array_length(rooms, 1))], rooms[1 + (i % array_length(rooms, 1))],
      string_to_array(contents[1 + (i % array_length(labels, 1))], '|'),
      i % 6 = 0, i % 15 = 1, box_stat,
      case when box_stat = 'empty' then null else v_members[1 + (i % m_count)] end,
      '[seed:moving]', v_user);
  end loop;

  raise notice 'Seeded moving for family %: % moves, % tasks, % boxes',
    v_family,
    (select count(*) from public.moves where family_id = v_family and notes = '[seed:moving]'),
    (select count(*) from public.move_tasks where family_id = v_family and notes = '[seed:moving]'),
    (select count(*) from public.move_boxes where family_id = v_family and notes = '[seed:moving]');
end $$;
