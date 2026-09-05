-- ============================================================================
-- Bubaly · SEED — Finance hub (financial_accounts + transactions 500 +
-- bills 500). A handful of accounts, 500 transactions (income/expense/transfer)
-- and 500 bills across statuses. Idempotent via '[seed:fin]' markers.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  v_accts   uuid[];
  n int := 500;
  merchants text[] := array['Whole Foods','Amazon','Shell','Netflix','Target','Costco','Starbucks',
                           'Apple','Uber','Home Depot','Spotify','Trader Joe''s'];
  cats     text[] := array['groceries','shopping','fuel','subscriptions','dining','utilities','kids','home'];
  ttypes   text[] := array['expense','expense','expense','income','transfer'];
  bstatus  text[] := array['upcoming','paid','overdue'];
  acct_names text[] := array['Everyday Checking','Family Savings','Rewards Credit','Kids Fund'];
  acct_types text[] := array['checking','savings','credit','savings'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  delete from public.transactions where family_id = v_family and notes = '[seed:fin]';
  delete from public.bills where family_id = v_family and category = 'seed-fin';
  delete from public.financial_accounts where family_id = v_family and institution = '[seed:fin]';

  -- Accounts.
  insert into public.financial_accounts (family_id, name, type, institution, last_four, balance, currency)
  select v_family, acct_names[i], acct_types[i]::account_type, '[seed:fin]',
    lpad((1000 + i)::text, 4, '0'), (round((random()*9000+100)::numeric, 2)), 'USD'
  from generate_series(1, array_length(acct_names,1)) as i;
  select array_agg(id) into v_accts from public.financial_accounts where family_id = v_family and institution = '[seed:fin]';

  -- 500 transactions.
  insert into public.transactions (family_id, account_id, name, amount, category, date, type, notes, merchant, member_id)
  select v_family,
    v_accts[1 + (g.i % array_length(v_accts,1))],
    merchants[1 + (g.i % array_length(merchants,1))] || ' purchase',
    round((random()*250 + 3)::numeric, 2),
    cats[1 + (g.i % array_length(cats,1))],
    (current_date - (g.i % 180)),
    ttypes[1 + (g.i % array_length(ttypes,1))]::transaction_type,
    '[seed:fin]',
    merchants[1 + (g.i % array_length(merchants,1))],
    case when v_members is null then null else v_members[1 + (g.i % array_length(v_members,1))] end
  from generate_series(1, n) as g(i);

  -- 500 bills.
  insert into public.bills (family_id, name, amount, due_date, is_recurring, recurrence, status, category, autopay)
  select v_family,
    (array['Electric','Water','Internet','Rent','Phone','Insurance','Gym','Streaming'])[1 + (g.i % 8)] || ' Bill #' || g.i,
    round((random()*300 + 15)::numeric, 2),
    (current_date + ((g.i % 60) - 30)),
    (g.i % 2 = 0),
    (array['monthly','yearly','weekly'])[1 + (g.i % 3)],
    bstatus[1 + (g.i % array_length(bstatus,1))]::bill_status,
    'seed-fin',
    (g.i % 4 = 0)
  from generate_series(1, n) as g(i);

  raise notice 'Finance seeded % transactions + % bills (+accounts) for family %', n, n, v_family;
end $$;
