-- ============================================================================
-- seed_inventory_one_family.sql — Home Inventory demo data for ONE family (TODO-0409)
-- ----------------------------------------------------------------------------
-- WHAT IT SEEDS (250 rows per table):
--   • home_locations  — 250 places: 14 rooms/areas + 236 containers (closets,
--                       shelves, boxes, drawers, cabinets) nested under them
--   • inventory_items — 250 possessions across every category with quantities,
--                       values, brands/models/serials, warranties, tags, owners,
--                       and a realistic status mix (in place / lent / repair / lost / disposed)
--   • inventory_moves — 250 relocations over the last 250 days
-- TARGET FAMILY: resolved at runtime (v_email's family → first family).
-- IDEMPOTENT: rows carry notes = '[seed:inventory]' and are deleted before re-insert.
-- HOW TO RUN: npm run db:seed:inventory   REQUIRES: migration 0242
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_members uuid[];
  m_count   int;
  n         int := 250;
  rooms     text[] := array['Garage','Kitchen','Living room','Primary bedroom','Kids'' room','Office','Basement','Attic','Laundry room','Hall closet','Shed','Bathroom','Mudroom','Car'];
  room_kind text[] := array['garage','room','room','room','room','room','basement','attic','room','closet','shed','room','room','vehicle'];
  cont_kind text[] := array['shelf','box','drawer','cabinet','closet','box','shelf','box'];
  cont_name text[] := array['Shelf A','Shelf B','Shelf C','Bin 1','Bin 2','Bin 3','Top drawer','Middle drawer','Bottom drawer','Cabinet L','Cabinet R','Tote (blue)','Tote (grey)','Overhead rack','Toolbox','Filing box','Under-bed box','Bookshelf'];
  cats      text[] := array['electronics','tools','sports','toys','documents','kitchen','furniture','seasonal','clothing','outdoor','medical','keys','jewelry','other'];
  names_e   text[] := array['Laptop','Tablet','Bluetooth speaker','Camera','Game console','Router','Label printer','Headphones'];
  names_t   text[] := array['Cordless drill','Socket set','Level','Stud finder','Circular saw','Ladder','Tape measure','Hex keys'];
  names_s   text[] := array['Bike helmet','Tennis racket','Soccer ball','Ski helmet','Yoga mat','Skateboard','Baseball glove','Snowboard'];
  names_y   text[] := array['Lego bin','Board games','Puzzle set','Dollhouse','RC car','Kite','Card games','Building blocks'];
  names_d   text[] := array['Passports','Birth certificates','Car title','Insurance binder','Tax folder','School records','Warranty folder','Vaccination cards'];
  names_k   text[] := array['Stand mixer','Instant pot','Cast-iron pan','Blender','Knife set','Air fryer','Slow cooker','Cake stand'];
  names_f   text[] := array['Folding chairs','Bookshelf','Card table','Bar stools','Floor lamp','Rug (rolled)','Crib','Desk'];
  names_h   text[] := array['Holiday lights','Tree stand','Halloween bin','Easter baskets','Beach umbrella','Camping tent','Sleeping bags','Cooler'];
  names_c   text[] := array['Winter coats','Rain boots','Ski jackets','Hand-me-downs (6)','Snow pants','Swim gear','Costumes','Sports uniforms'];
  names_o   text[] := array['Garden hose','Lawn mower','Hedge trimmer','Patio cushions','Bike pump','Wheelbarrow','Sprinkler','Leaf blower'];
  names_m   text[] := array['First-aid kit','Thermometer','Nebulizer','Crutches','Blood-pressure cuff','Epi-pens','Heating pad','Humidifier'];
  names_key text[] := array['Spare house key','Car key fob','Mailbox key','Shed padlock key','Bike lock key','Safe key','Garage remote','Storage unit key'];
  names_j   text[] := array['Grandma''s watch','Wedding rings box','Pearl necklace','Cufflinks','Silver set','Coin collection','Heirloom brooch','Bracelet'];
  names_x   text[] := array['Suitcases','Picture frames','Extension cords','Batteries box','Gift-wrap bin','Craft supplies','Old phones','Spare cables'];
  brands    text[] := array['DeWalt','Apple','Samsung','KitchenAid','Giro','Lego','Coleman','IKEA','Sony','Bosch','Ninja','Trek'];
  statuses  text[] := array['in_place','in_place','in_place','in_place','in_place','in_place','in_place','lent','in_place','in_repair','in_place','lost','in_place','disposed'];
  lenders   text[] := array['The Nguyens next door','Grandma','Coach Lee','Sam''s friend Ava','Uncle Rob','The school'];
  reasons   text[] := array['spring clean','moved to make room','back from repair','lent and returned','seasonal swap','reorganized shelves','found it!','new home'];
  cat       text;
  nm        text;
  stat      text;
  i         int;
  room_ids  uuid[] := array[]::uuid[];
  rid       uuid;
  loc       uuid;
  item      uuid;
  from_loc  uuid;
  to_loc    uuid;
begin
  if to_regclass('public.inventory_items') is null then
    raise notice 'inventory_items not present — apply migration 0242 first. Skipping.';
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

  delete from public.inventory_moves where family_id = v_family and reason like '%[seed:inventory]%';
  delete from public.inventory_items where family_id = v_family and notes = '[seed:inventory]';
  delete from public.home_locations where family_id = v_family and notes = '[seed:inventory]';

  -- 1) 250 locations: rooms first, then containers nested under them -------------
  for i in 1..array_length(rooms, 1) loop
    insert into public.home_locations (family_id, name, kind, parent_id, notes, created_by)
    values (v_family, rooms[i], room_kind[i], null, '[seed:inventory]', v_user) returning id into rid;
    room_ids := room_ids || rid;
  end loop;
  for i in 1..(n - array_length(rooms, 1)) loop
    insert into public.home_locations (family_id, name, kind, parent_id, notes, created_by)
    values (v_family,
      cont_name[1 + (i % array_length(cont_name, 1))] || case when i > array_length(cont_name, 1) then ' ' || (i / array_length(cont_name, 1) + 1) else '' end,
      cont_kind[1 + (i % array_length(cont_kind, 1))],
      room_ids[1 + (i % array_length(room_ids, 1))],
      '[seed:inventory]', v_user);
  end loop;

  create temp table tmp_inv_locs on commit drop as
    select id, row_number() over (order by created_at, id) as rn, count(*) over () as cnt
    from public.home_locations where family_id = v_family and notes = '[seed:inventory]';
  create index on tmp_inv_locs (rn);

  -- 2) 250 items -----------------------------------------------------------------
  for i in 1..n loop
    cat := cats[1 + (i % array_length(cats, 1))];
    nm := case cat
      when 'electronics' then names_e[1 + (i % 8)] when 'tools' then names_t[1 + (i % 8)] when 'sports' then names_s[1 + (i % 8)]
      when 'toys' then names_y[1 + (i % 8)] when 'documents' then names_d[1 + (i % 8)] when 'kitchen' then names_k[1 + (i % 8)]
      when 'furniture' then names_f[1 + (i % 8)] when 'seasonal' then names_h[1 + (i % 8)] when 'clothing' then names_c[1 + (i % 8)]
      when 'outdoor' then names_o[1 + (i % 8)] when 'medical' then names_m[1 + (i % 8)] when 'keys' then names_key[1 + (i % 8)]
      when 'jewelry' then names_j[1 + (i % 8)] else names_x[1 + (i % 8)] end;
    stat := statuses[1 + (i % array_length(statuses, 1))];
    select id into loc from tmp_inv_locs where rn = 1 + ((i * 17) % 250);
    insert into public.inventory_items (family_id, name, category, location_id, owner_member_id, quantity, value_cents, purchased_on, brand, model, serial_number,
      warranty_until, tags, status, lent_to, lent_on, notes, created_by)
    values (v_family,
      nm || case when i > 112 then ' #' || (i / 112 + 1) else '' end, cat,
      case when i % 9 = 0 then null else loc end,
      case when i % 3 = 0 then v_members[1 + (i % m_count)] else null end,
      case when cat in ('furniture','clothing','toys') then 1 + (i % 4) else 1 end,
      case when i % 5 = 0 then null else 1500 + ((i * 731) % 120000) end,
      current_date - ((i * 23) % 2400),
      case when i % 4 = 0 then null else brands[1 + ((i * 3) % array_length(brands, 1))] end,
      case when i % 4 = 0 then null else 'M-' || (1000 + (i * 37) % 9000) end,
      case when cat in ('electronics','tools','kitchen') then 'SN' || lpad(((i * 9973) % 1000000)::text, 6, '0') else null end,
      case when cat in ('electronics','tools','kitchen','outdoor') then current_date + (((i * 41) % 900) - 300) else null end,
      array[cat, case when i % 2 = 0 then 'insured' else 'household' end],
      stat,
      case when stat = 'lent' then lenders[1 + (i % array_length(lenders, 1))] else null end,
      case when stat = 'lent' then current_date - ((i * 7) % 90) else null end,
      '[seed:inventory]', v_user);
  end loop;

  create temp table tmp_inv_items on commit drop as
    select id, location_id, row_number() over (order by created_at, id) as rn, count(*) over () as cnt
    from public.inventory_items where family_id = v_family and notes = '[seed:inventory]';
  create index on tmp_inv_items (rn);

  -- 3) 250 moves over the last 250 days -------------------------------------------
  for i in 1..n loop
    select id, location_id into item, to_loc from tmp_inv_items where rn = 1 + ((i * 13) % 250);
    select id into from_loc from tmp_inv_locs where rn = 1 + ((i * 29) % 250);
    insert into public.inventory_moves (family_id, item_id, from_location_id, to_location_id, moved_by, moved_at, reason, created_by)
    values (v_family, item, from_loc, to_loc, v_members[1 + (i % m_count)], now() - (i || ' days')::interval - ((i * 37) % 24 || ' hours')::interval,
      reasons[1 + (i % array_length(reasons, 1))] || ' [seed:inventory]', v_user);
  end loop;

  raise notice 'Inventory seeded: % locations, % items, % moves for family %', n, n, n, v_family;
end $$;
