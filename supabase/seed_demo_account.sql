-- ============================================================================
-- seed_demo_account.sql — ~200 curated records for THE demo account so every
-- major surface is populated for a polished, hands-on demo. Targets the primary
-- demo family (The Patel Family, 1111…). ADDITIVE + IDEMPOTENT: every row is
-- tagged ('Demo · ' name/title prefix, '[demo]' in description/notes) and the
-- tagged rows are deleted before re-insert — it never touches other data, and it
-- won't disturb seed_prod's larger dataset.
--
-- SCHEMA-DRIFT SAFE: each table is wrapped so a not-yet-migrated table/column is
-- skipped, not fatal. Safe to run in the Supabase SQL editor at any time.
-- ============================================================================

do $$
declare
  v_fam     uuid := '11111111-1111-1111-1111-111111111111';
  v_members uuid[];
  v_mid     uuid;   -- a member for assignee/member_id
  n int;
begin
  if not exists (select 1 from public.families where id = v_fam) then
    raise notice 'Demo family % not found — run seed_prod.sql first. Skipping.', v_fam;
    return;
  end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_fam;
  v_mid := case when v_members is null then null else v_members[1] end;

  -- ── Calendar (24) ────────────────────────────────────────────────────────
  begin
    delete from public.calendar_events where family_id = v_fam and description = '[demo]';
    insert into public.calendar_events (family_id, title, description, location, category, starts_at, ends_at, all_day, recurrence, assignee_id, created_by)
    select v_fam, 'Demo · '||(array['Soccer practice','Dentist','Piano lesson','Book club','Team meeting','Swim class','Birthday party','Parent-teacher night','Dance recital','Doctor visit','Study group','Game night'])[1+(g%12)],
      '[demo]', 'Place '||(g%8), (array['sports','appointment','school','general','birthday','medication','maintenance','other'])[1+(g%8)],
      now() + make_interval(days => (g%14), hours => 1+(g%9)), now() + make_interval(days => (g%14), hours => 2+(g%9)),
      false, 'none',
      case when v_members is not null then v_members[1+(g%array_length(v_members,1))] else null end, null
    from generate_series(1,24) g;
  exception when undefined_table or undefined_column then null; end;

  -- ── Transactions (24) ────────────────────────────────────────────────────
  begin
    delete from public.transactions where family_id = v_fam and notes = '[demo]';
    insert into public.transactions (family_id, name, amount, category, date, type, notes, created_by)
    select v_fam, 'Demo · '||(array['Groceries','Coffee','Gas','Dining','Shopping','Pharmacy','Toys','Books'])[1+(g%8)],
      8+(g%60), (array['Groceries','Dining','Transportation','Shopping','Kids','Utilities','Entertainment','Health'])[1+(g%8)],
      (current_date - (g%28))::date, 'expense', '[demo]', null
    from generate_series(1,24) g;
  exception when undefined_table or undefined_column then null; end;

  -- ── Budgets (6) ──────────────────────────────────────────────────────────
  begin
    delete from public.budgets where family_id = v_fam and category like 'Demo · %';
    insert into public.budgets (family_id, category, amount, period, created_by)
    select v_fam, 'Demo · '||c.name, c.amt, 'monthly', null
    from (values ('Groceries',600),('Dining',200),('Transportation',150),('Kids',250),('Entertainment',120),('Utilities',300)) as c(name,amt);
  exception when undefined_table or undefined_column then null; end;

  -- ── Financial accounts (5) ───────────────────────────────────────────────
  begin
    delete from public.financial_accounts where family_id = v_fam and name like 'Demo · %';
    insert into public.financial_accounts (family_id, name, type, balance, currency, created_by)
    select v_fam, 'Demo · '||a.name, a.typ, a.bal, 'USD', null
    from (values ('Everyday Checking','checking',3240.55),('Family Savings','savings',12800.00),('Rewards Card','credit',-640.20),('Kids College','investment',8600.00),('Vacation Fund','savings',2150.00)) as a(name,typ,bal);
  exception when undefined_table or undefined_column then null; end;

  -- ── Bills (12) ───────────────────────────────────────────────────────────
  begin
    delete from public.bills where family_id = v_fam and name like 'Demo · %';
    insert into public.bills (family_id, name, amount, due_date, is_recurring, recurrence, status, category, autopay, created_by)
    select v_fam, 'Demo · '||(array['Electricity','Water','Internet','Phone','Streaming','Insurance','Mortgage','Gym','Trash','Daycare','Music','Car'])[1+(g%12)],
      30+(g*13%220), (current_date + (g%20))::date, true, 'monthly',
      case when g%6=0 then 'overdue' else 'upcoming' end, 'Utilities', (g%3=0), null
    from generate_series(1,12) g;
  exception when undefined_table or undefined_column then null; end;

  -- ── Reminders (14) ───────────────────────────────────────────────────────
  begin
    delete from public.family_reminders where family_id = v_fam and title like 'Demo · %';
    insert into public.family_reminders (family_id, title, kind, remind_at, created_by)
    select v_fam, 'Demo · '||(array['Pay rent','Refill prescription','Water plants','Call grandma','Renew library books','School forms','Take out trash'])[1+(g%7)],
      'time', now() + make_interval(hours => (g%48) - 6), null
    from generate_series(1,14) g;
  exception when undefined_table or undefined_column then null; end;

  -- ── Goals (10) ───────────────────────────────────────────────────────────
  begin
    delete from public.goals where family_id = v_fam and title like 'Demo · %';
    insert into public.goals (family_id, title, progress, is_complete, target_date, created_by)
    select v_fam, 'Demo · '||(array['Family trip to Japan','New bikes','Emergency fund','Kitchen remodel','Read 20 books','Learn guitar','Garden makeover','Save for laptop','Run a 5K','Declutter garage'])[1+((g-1)%10)],
      (g*9)%100, (g%7=0), (current_date + (g*10))::date, null
    from generate_series(1,10) g;
  exception when undefined_table or undefined_column then null; end;

  -- ── Documents (10) ───────────────────────────────────────────────────────
  begin
    delete from public.documents where family_id = v_fam and title like 'Demo · %';
    insert into public.documents (family_id, title, category, storage_path, expires_at, created_by)
    select v_fam, 'Demo · '||(array['Passport','Insurance policy','Warranty','Lease','Vaccination record','Car registration','Will','School report','Tax return','Membership'])[1+((g-1)%10)],
      'general', v_fam||'/demo/doc-'||g||'.pdf', (current_date + (g%40))::date, null
    from generate_series(1,10) g;
  exception when undefined_table or undefined_column then null; end;

  -- ── Maintenance (8) ──────────────────────────────────────────────────────
  begin
    delete from public.maintenance_tasks where family_id = v_fam and title like 'Demo · %';
    insert into public.maintenance_tasks (family_id, title, status, priority, recurrence, due_at, created_by)
    select v_fam, 'Demo · '||(array['Change HVAC filter','Test smoke alarms','Clean gutters','Service the car','Descale kettle','Check tire pressure','Flush water heater','Mow the lawn'])[1+((g-1)%8)],
      'todo', 'medium', 'none', now() + make_interval(days => (g%20) - 5), null
    from generate_series(1,8) g;
  exception when undefined_table or undefined_column then null; end;

  -- ── Pantry (20) ──────────────────────────────────────────────────────────
  begin
    delete from public.pantry_items where family_id = v_fam and name like 'Demo · %';
    insert into public.pantry_items (family_id, name, location, quantity, low_threshold, created_by)
    select v_fam, 'Demo · '||(array['Milk','Eggs','Flour','Rice','Pasta','Cereal','Coffee','Sugar','Butter','Bread','Apples','Chicken'])[1+(g%12)],
      (array['pantry','fridge','freezer','counter'])[1+(g%4)], case when g%3=0 then 1 else 6 end, 3, null
    from generate_series(1,20) g;
  exception when undefined_table or undefined_column then null; end;

  -- ── Family facts / knowledge (12) ────────────────────────────────────────
  begin
    delete from public.family_facts where family_id = v_fam and label like 'Demo · %';
    insert into public.family_facts (family_id, category, label, value, notes, is_pinned, created_by)
    select v_fam, (array['preference','sizes','medical','contact','important','about'])[1+(g%6)],
      'Demo · '||(array['Shoe size','Allergy','Pediatrician','Wifi password','Favorite meal','Shirt size','Blood type','Emergency contact','Coffee order','Bedtime','Dentist','Car plate'])[1+(g%12)],
      (array['US 8','Peanuts','Dr. Lee 555-0100','on the fridge','Taco night','Medium','O+','Aunt May','oat latte','8:30pm','Dr. Kim','ABC-1234'])[1+(g%12)],
      null, (g%5=0), null
    from generate_series(1,12) g;
  exception when undefined_table or undefined_column then null; end;

  -- ── Meal votes + polls (12) ──────────────────────────────────────────────
  begin
    delete from public.meal_votes where family_id = v_fam and title like 'Demo · %';
    insert into public.meal_votes (family_id, title, status, created_by)
    select v_fam, 'Demo · Dinner vote '||g, 'open', null from generate_series(1,6) g;
  exception when undefined_table or undefined_column then null; end;
  begin
    delete from public.family_polls where family_id = v_fam and question like 'Demo · %';
    insert into public.family_polls (family_id, question, kind, status, created_by)
    select v_fam, 'Demo · '||(array['Movie night pick?','Weekend plan?','Where to eat?','Vacation spot?','Chore swap?','Game to play?'])[1+((g-1)%6)], 'single', 'open', null
    from generate_series(1,6) g;
  exception when undefined_table or undefined_column then null; end;

  -- ── Marketplace: listings (18) + saves (12) + reviews (10) ───────────────
  begin
    delete from public.marketplace_listings where family_id = v_fam and description = '[demo]';
    insert into public.marketplace_listings (family_id, member_id, title, description, kind, category, condition, price_cents, status, location, created_by)
    select v_fam,
      case when v_members is not null then v_members[1+(g%array_length(v_members,1))] else null end,
      'Demo · '||(array['Balance bike','Board games bundle','Winter coat','Bookshelf','Lego set','Guitar','Stroller','Desk lamp','Tennis racket','Puzzle','Baby monitor','Cookbook'])[1+(g%12)],
      '[demo]', (array['sell','sell','rent','free','wanted','borrow'])[1+(g%6)],
      (array['toys','books','clothing','furniture','sports','baby','games','other'])[1+(g%8)],
      (array['good','like_new','new','fair'])[1+(g%4)], (g%5)*1000, 'available', 'Garage', null
    from generate_series(1,18) g;
  exception when undefined_table or undefined_column then null; end;
  begin
    insert into public.marketplace_saves (family_id, listing_id, member_id)
    select v_fam, l.id, case when v_members is not null then v_members[1+((row_number() over ())::int % array_length(v_members,1))] else null end
    from (select id from public.marketplace_listings where family_id=v_fam and description='[demo]' order by created_at limit 12) l
    on conflict do nothing;
  exception when undefined_table or undefined_column then null; end;
  begin
    insert into public.marketplace_reviews (family_id, listing_id, reviewer_member, reviewee_member, role, rating, comment)
    select v_fam, l.id,
      case when v_members is not null then v_members[1+((rn) % array_length(v_members,1))] else null end,
      case when v_members is not null then v_members[1+((rn+1) % array_length(v_members,1))] else null end,
      'buyer', 4 + (rn % 2), 'Demo · Smooth hand-off!'
    from (select id, (row_number() over ())::int as rn from public.marketplace_listings where family_id=v_fam and description='[demo]' order by created_at limit 10) l;
  exception when undefined_table or undefined_column then null; end;

  raise notice 'Demo account seed complete for family % (~200 curated rows).', v_fam;
end $$;
