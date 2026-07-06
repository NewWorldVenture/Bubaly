-- ============================================================================
-- seed_operating_index_one_family.sql — 613 records to fully exercise the
-- Family Operating Index (#7) in its full capacity. Every input the FOI reads
-- is populated so all 7 dimensions render with real signals (not calm-by-
-- omission) and the composite lands in a realistic "stretched/steady" band.
--
-- TARGET: The Kramer Family (92298eb2-…). IDEMPOTENT: rows are tagged
-- (calendar '[seed:foi]' in description, transactions '[seed:foi]' in notes,
-- everything else a 'FOI · ' name/title prefix; budgets by category+period) and
-- deleted before re-insert (this family only). Safe to re-run.
--
-- COVERAGE by FOI dimension:
--   planning         → 300 calendar_events (some owned; some missing location)
--   schedule stab.   → the 300 events collide across day/hour slots (conflicts)
--   financial        → 220 expenses over 2 budgets (overspent) + 1 checking < 0
--   readiness        → 30 pantry (low), 10 documents (expiring), 10 maintenance
--   communication    → 6 open decisions (3 meal_votes + 3 family_polls); unread
--                       threads + pending approvals add volume via seed_messages
--   routine          → covered by seed_chores_one_family.sql (chore_assignments)
--   goals            → 10 goals off-track (progress < 50, deadline < 30d)
--   + 15 overdue reminders, 12 bills due (some no autopay)
--
-- HOW TO RUN: paste into the Supabase SQL editor, Run, then open
--   /dashboard/family-operating-index.
-- ============================================================================

do $$
declare
  v_fam   uuid := '92298eb2-1a9e-4bdc-9361-677b6c01b499';
  v_email text := 'newworldventurellc@gmail.com';
  v_uid   uuid;
  v_members uuid[];
begin
  if not exists (select 1 from public.families where id = v_fam) then
    raise exception 'Family % not found', v_fam;
  end if;
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_fam and is_active;

  -- ── clean prior seed (this family only) ──────────────────────────────────
  delete from public.calendar_events    where family_id = v_fam and description like '%[seed:foi]%';
  delete from public.transactions        where family_id = v_fam and notes like '%[seed:foi]%';
  delete from public.budgets             where family_id = v_fam and period = 'monthly' and category in ('Groceries','Dining');
  delete from public.financial_accounts  where family_id = v_fam and name like 'FOI · %';
  delete from public.pantry_items        where family_id = v_fam and name like 'FOI · %';
  delete from public.family_reminders    where family_id = v_fam and title like 'FOI · %';
  delete from public.documents           where family_id = v_fam and title like 'FOI · %';
  delete from public.maintenance_tasks   where family_id = v_fam and title like 'FOI · %';
  delete from public.goals               where family_id = v_fam and title like 'FOI · %';
  delete from public.bills               where family_id = v_fam and name like 'FOI · %';
  delete from public.meal_votes          where family_id = v_fam and title like 'FOI · %';
  delete from public.family_polls        where family_id = v_fam and question like 'FOI · %';

  -- ── PLANNING + STABILITY + LOADS + MISSING-INFO: 300 upcoming events ──────
  insert into public.calendar_events
    (family_id, title, description, location, category, starts_at, ends_at, all_day, recurrence, assignee_id, created_by)
  select
    v_fam,
    'FOI Event ' || g,
    '[seed:foi]',
    -- needs-location categories with NULL location = "info missing"
    case when g % 3 = 0 then null else 'Place ' || (g % 20) end,
    (array['appointment','school','sports','general','medication','other','appointment','school','maintenance'])[1 + (g % 9)],
    now() + make_interval(days => (g % 7), hours => 2 + (g % 10)),
    now() + make_interval(days => (g % 7), hours => 3 + (g % 10)),
    false, 'none',
    case when g % 2 = 0 and v_members is not null then v_members[1 + (g % array_length(v_members,1))] else null end,
    v_uid
  from generate_series(1, 300) g;

  -- ── FINANCIAL: 220 expenses (Groceries+Dining blow their caps) ───────────
  insert into public.budgets (family_id, category, amount, period, created_by) values
    (v_fam, 'Groceries', 300, 'monthly', v_uid),
    (v_fam, 'Dining',    100, 'monthly', v_uid);

  insert into public.transactions (family_id, name, amount, category, date, type, notes, created_by)
  select
    v_fam,
    'FOI Purchase ' || g,
    12 + (g % 30),
    (array['Groceries','Groceries','Dining','Utilities','Shopping','Kids','Transportation','Entertainment'])[1 + (g % 8)],
    (date_trunc('month', current_date) + make_interval(days => (g % 27)))::date,
    'expense', 'Auto-import. [seed:foi]', v_uid
  from generate_series(1, 220) g;

  -- Accounts: one spendable account below zero (flag); a credit card negative
  -- (expected — must NOT count).
  insert into public.financial_accounts (family_id, name, type, balance, currency, created_by) values
    (v_fam, 'FOI · Everyday Checking', 'checking',  -142.50, 'USD', v_uid),
    (v_fam, 'FOI · Family Savings',    'savings',    5400.00, 'USD', v_uid),
    (v_fam, 'FOI · Rewards Card',      'credit',     -820.00, 'USD', v_uid),
    (v_fam, 'FOI · Brokerage',         'investment', 20100.00,'USD', v_uid);

  -- ── READINESS: pantry (low), documents (expiring), maintenance (overdue) ─
  insert into public.pantry_items (family_id, name, location, quantity, low_threshold, created_by)
  select v_fam, 'FOI · Item ' || g,
    (array['pantry','fridge','freezer','counter','garage','other'])[1 + (g % 6)],
    case when g % 3 = 0 then 1 else 8 end,   -- ~10 at/below threshold
    3, v_uid
  from generate_series(1, 30) g;

  insert into public.documents (family_id, title, category, storage_path, expires_at, created_by)
  select v_fam, 'FOI · Doc ' || g, 'general',
    v_fam || '/foi/placeholder-' || g || '.pdf',
    (current_date + make_interval(days => (g % 25)))::date,  -- expiring within 30d
    v_uid
  from generate_series(1, 10) g;

  insert into public.maintenance_tasks (family_id, title, status, priority, recurrence, due_at, created_by)
  select v_fam, 'FOI · Maintenance ' || g, 'todo', 'medium', 'none',
    now() - make_interval(days => 1 + (g % 20)),  -- overdue
    v_uid
  from generate_series(1, 10) g;

  -- ── ROUTINE-adjacent: 15 overdue active reminders ───────────────────────
  insert into public.family_reminders (family_id, title, kind, remind_at, created_by)
  select v_fam, 'FOI · Reminder ' || g, 'time',
    now() - make_interval(hours => 1 + (g % 12)),  -- overdue (status defaults 'active')
    v_uid
  from generate_series(1, 15) g;

  -- ── GOALS: 10 off-track (progress < 50, deadline within 30 days) ─────────
  insert into public.goals (family_id, title, progress, is_complete, target_date, created_by)
  select v_fam, 'FOI · Goal ' || g, (g * 7) % 45, false,
    (current_date + make_interval(days => (g % 20)))::date,
    v_uid
  from generate_series(1, 10) g;

  -- ── BILLS: 12 due within 14 days, ~1/3 on autopay ───────────────────────
  insert into public.bills (family_id, name, amount, due_date, is_recurring, recurrence, status, category, autopay, created_by)
  select v_fam, 'FOI · Bill ' || g,
    40 + (g * 13 % 200),
    (current_date + make_interval(days => (g % 14)))::date,
    true, 'monthly',
    case when g % 5 = 0 then 'overdue' else 'upcoming' end,
    'Utilities',
    (g % 3 = 0), v_uid
  from generate_series(1, 12) g;

  -- ── COMMUNICATION: 6 open decisions (votes + polls) → the comms dimension ─
  insert into public.meal_votes (family_id, title, status, created_by)
  select v_fam, 'FOI · Dinner vote ' || g, 'open', v_uid from generate_series(1, 3) g;

  insert into public.family_polls (family_id, question, kind, status, created_by)
  select v_fam, 'FOI · Poll ' || g, 'single', 'open', v_uid from generate_series(1, 3) g;

  raise notice 'FOI seed complete for family % (≈619 records across 12 tables).', v_fam;
end $$;

-- ── Verify: row counts per FOI input (should total ≈613) ────────────────────
select 'calendar_events'   as tbl, count(*) from public.calendar_events   where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and description like '%[seed:foi]%'
union all select 'transactions',       count(*) from public.transactions       where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and notes like '%[seed:foi]%'
union all select 'budgets',            count(*) from public.budgets            where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and period='monthly' and category in ('Groceries','Dining')
union all select 'financial_accounts', count(*) from public.financial_accounts where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and name like 'FOI · %'
union all select 'pantry_items',       count(*) from public.pantry_items       where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and name like 'FOI · %'
union all select 'documents',          count(*) from public.documents          where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and title like 'FOI · %'
union all select 'maintenance_tasks',  count(*) from public.maintenance_tasks  where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and title like 'FOI · %'
union all select 'family_reminders',   count(*) from public.family_reminders   where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and title like 'FOI · %'
union all select 'goals',              count(*) from public.goals              where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and title like 'FOI · %'
union all select 'bills',              count(*) from public.bills              where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and name like 'FOI · %'
union all select 'meal_votes',         count(*) from public.meal_votes         where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and title like 'FOI · %'
union all select 'family_polls',       count(*) from public.family_polls       where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and question like 'FOI · %';
