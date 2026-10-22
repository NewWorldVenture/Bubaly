-- ── Household money is a parent's or adult's (0514) ─────────────────────────
--
-- Twelve tables hold the household's money and money papers and read with
-- is_family_member(family_id), so a teen, a child, a caregiver or a guest
-- reads the bank balances, every purchase, the Stripe account rows, the plan's
-- billing rows, the babysitter payouts and the paperwork queue. The held 0514
-- replaces each read with, inside is_family_member(family_id):
--
--   managers:  can_manage_family(family_id) -- financial_accounts,
--              family_wallets, stripe_connected_accounts,
--              stripe_financial_accounts, billing_customers, checkout_sessions,
--              babysitter_payments
--   member:    ... or is_self_member(member_id) -- transactions
--   adder:     ... or created_by = auth.uid() -- home_warranties,
--              auto_insurance_policies, vehicle_registrations, paperwork_items
--
-- Fixture, Coin House: a parent and an adult (managers), a teen (who is also
-- the parent of a household of their own), a child, a caregiver, a guest, a
-- ward with no login, and an adult since removed (is_active false). Written as
-- the table owner: one row of each managers table; in transactions, one tagged
-- to each member and one to nobody; in each added-by table, one added by each
-- member with a login and one by nobody; and in the teen's own household one
-- row of each table.
--
-- What this probe asserts, through PostgREST's role:
--
--   1. the teen, the child, the caregiver and the guest read no row of a
--      managers table, only the transaction tagged to them, and only the
--      records they added (counted), and do read those two (a guest not the
--      auto policy they added where the held 0509's guard is installed: it
--      withholds every auto policy from a guest);
--   2. control: the parent and the adult read every Coin House row;
--   3. control: the teen reads every row in the household they manage;
--   4. the removed adult and a stranger read nothing;
--   5. control: the service role, carrying the child's user id and without
--      one, reads every Coin House row;
--   6. control: the writes the screens make come back to their writer: the
--      child's own paperwork item and the teen's own warranty (insert …
--      returning, OK 1 each), the child's status change on their own item
--      (OK 1), and a parent's transaction (insert … returning, OK 1); the
--      child's change to the parent's paperwork reaches no row (OK 0);
--   7. wiring: one permissive read per table, by 0514's name, granted to
--      authenticated, USING exactly 0514's predicate for its rule; the four
--      added-by tables keep their member-wide insert, update and delete, and
--      accounts, wallets, transactions and babysitter payouts their manager
--      ones; the only restrictive read is a guest's (the held 0509's);
--
-- and, only where 0514 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with the family-wide read put back, the child reads
--       the household's row (the ward's transaction, the parent's records) in
--       all twelve (1 each): the fixture reaches the limit;
--   M1. MUTATION CONTROL: with a caregiver clause added to transactions, the
--       caregiver reads the ward's transaction (1), so 1. is what catches a
--       rule wider than the owner's.
--
-- Everything is rolled back.
--
-- HELD with 0514: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/household-money-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0514 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8514-0000000000a1','m0514-parent@example.com'),
  ('00000000-0000-4000-8514-0000000000a2','m0514-adult@example.com'),
  ('00000000-0000-4000-8514-0000000000a3','m0514-teen@example.com'),
  ('00000000-0000-4000-8514-0000000000a4','m0514-child@example.com'),
  ('00000000-0000-4000-8514-0000000000a5','m0514-caregiver@example.com'),
  ('00000000-0000-4000-8514-0000000000a6','m0514-guest@example.com'),
  ('00000000-0000-4000-8514-0000000000a8','m0514-gone@example.com'),
  ('00000000-0000-4000-8514-0000000000a9','m0514-stranger@example.com')
  on conflict do nothing;
-- on_family_created files each creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8514-0000000000f1','Coin House','00000000-0000-4000-8514-0000000000a1'),
  ('00000000-0000-4000-8514-0000000000f2','Teen''s Own House','00000000-0000-4000-8514-0000000000a3'),
  ('00000000-0000-4000-8514-0000000000f3','Next Door','00000000-0000-4000-8514-0000000000a9');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8514-0000000000a1','00000000-0000-4000-8514-0000000000a3','00000000-0000-4000-8514-0000000000a9');
update public.family_members set id = '00000000-0000-4000-8514-0000000000c1'
 where family_id = '00000000-0000-4000-8514-0000000000f1' and user_id = '00000000-0000-4000-8514-0000000000a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8514-0000000000c2','00000000-0000-4000-8514-0000000000f1','00000000-0000-4000-8514-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8514-0000000000c3','00000000-0000-4000-8514-0000000000f1','00000000-0000-4000-8514-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8514-0000000000c4','00000000-0000-4000-8514-0000000000f1','00000000-0000-4000-8514-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8514-0000000000c5','00000000-0000-4000-8514-0000000000f1','00000000-0000-4000-8514-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8514-0000000000c6','00000000-0000-4000-8514-0000000000f1','00000000-0000-4000-8514-0000000000a6','Guest','guest',true),
  ('00000000-0000-4000-8514-0000000000c7','00000000-0000-4000-8514-0000000000f1',null,'Ward','child',true),
  ('00000000-0000-4000-8514-0000000000c8','00000000-0000-4000-8514-0000000000f1','00000000-0000-4000-8514-0000000000a8','Adult (removed)','adult',false),
  ('00000000-0000-4000-8514-0000000000c9','00000000-0000-4000-8514-0000000000f2',null,'Teen''s ward','child',true);

-- One row in one of the twelve tables, as the server writes it. `who` is the
-- member a transaction is tagged to, or the user who added a record.
create or replace function pg_temp.m0514_put(t text, fam uuid, who uuid, tag text) returns uuid
language plpgsql as $fn$
declare id uuid;
begin
  execute case t
    when 'financial_accounts' then
      'insert into public.financial_accounts (family_id, name, balance) values ($1, ''m0514 current account'', 2400) returning id'
    when 'family_wallets' then
      'insert into public.family_wallets (family_id) values ($1) returning id'
    when 'stripe_connected_accounts' then
      'insert into public.stripe_connected_accounts (family_id, stripe_account_id) values ($1, ''acct_m0514_'' || $3) returning id'
    when 'stripe_financial_accounts' then
      'insert into public.stripe_financial_accounts (family_id, connected_account_id, stripe_financial_account_id)
         select $1, c.id, ''fa_m0514_'' || $3 from public.stripe_connected_accounts c where c.family_id = $1 returning id'
    when 'billing_customers' then
      'insert into public.billing_customers (family_id) values ($1) returning id'
    when 'checkout_sessions' then
      'insert into public.checkout_sessions (family_id, session_id) values ($1, ''cs_m0514_'' || $3) returning id'
    when 'babysitter_payments' then
      'insert into public.babysitter_payments (family_id, amount_cents) values ($1, 4500) returning id'
    when 'transactions' then
      'insert into public.transactions (family_id, name, amount, member_id) values ($1, ''m0514 '' || $3, -12.50, $2) returning id'
    when 'home_warranties' then
      'insert into public.home_warranties (family_id, name, created_by) values ($1, ''m0514 fridge '' || $3, $2) returning id'
    when 'auto_insurance_policies' then
      'insert into public.auto_insurance_policies (family_id, created_by) values ($1, $2) returning id'
    when 'vehicle_registrations' then
      'insert into public.vehicle_registrations (family_id, created_by) values ($1, $2) returning id'
    when 'paperwork_items' then
      'insert into public.paperwork_items (family_id, title, created_by) values ($1, ''m0514 slip '' || $3, $2) returning id'
  end
  into id using fam, who, tag;
  return id;
end
$fn$;

-- The ids of one family's rows in one table, as one caller sees them; null if
-- the read itself was refused.
create or replace function pg_temp.m0514_seen(p_role text, p_uid text, t text, fam uuid) returns uuid[]
language plpgsql as $fn$
declare ids uuid[];
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  perform set_config('request.jwt.claims',
    case when p_uid is null then json_build_object('role', p_role)
         else json_build_object('sub', p_uid, 'role', p_role) end::text, true);
  begin
    execute format('select coalesce(array_agg(id), ''{}'') from public.%I where family_id = $1', t) into ids using fam;
  exception when others then
    ids := null;
  end;
  perform set_config('role', 'postgres', true);
  return ids;
end
$fn$;

-- One statement as one signed-in user, and exactly what happened.
create or replace function pg_temp.m0514_as(p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    got := 'OK ' || n;
  exception when others then
    got := sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  return got;
end
$fn$;

create temp table m0514_rows (tbl text, who text, id uuid) on commit drop;

do $$
declare
  f1 constant uuid := '00000000-0000-4000-8514-0000000000f1';
  f2 constant uuid := '00000000-0000-4000-8514-0000000000f2';
  t  text;
  x  record;
begin
  foreach t in array array['financial_accounts', 'family_wallets', 'stripe_connected_accounts', 'stripe_financial_accounts',
                           'billing_customers', 'checkout_sessions', 'babysitter_payments'] loop
    insert into m0514_rows values (t, 'household', pg_temp.m0514_put(t, f1, null, 'coin'));
    insert into m0514_rows values (t, 'elsewhere', pg_temp.m0514_put(t, f2, null, 'teen'));
  end loop;
  -- Transactions, tagged to each member and to nobody.
  for x in select * from (values ('ward', '00000000-0000-4000-8514-0000000000c7'::uuid),
                                 ('parent', '00000000-0000-4000-8514-0000000000c1'::uuid),
                                 ('teen', '00000000-0000-4000-8514-0000000000c3'::uuid),
                                 ('child', '00000000-0000-4000-8514-0000000000c4'::uuid),
                                 ('caregiver', '00000000-0000-4000-8514-0000000000c5'::uuid),
                                 ('guest', '00000000-0000-4000-8514-0000000000c6'::uuid),
                                 ('nobody', null::uuid)) as v(who, member) loop
    insert into m0514_rows values ('transactions', x.who, pg_temp.m0514_put('transactions', f1, x.member, x.who));
  end loop;
  insert into m0514_rows values ('transactions', 'elsewhere', pg_temp.m0514_put('transactions', f2, '00000000-0000-4000-8514-0000000000c9', 'elsewhere'));
  -- The added-by records, added by each member with a login and by nobody.
  foreach t in array array['home_warranties', 'auto_insurance_policies', 'vehicle_registrations', 'paperwork_items'] loop
    for x in select * from (values ('parent', '00000000-0000-4000-8514-0000000000a1'::uuid),
                                   ('teen', '00000000-0000-4000-8514-0000000000a3'::uuid),
                                   ('child', '00000000-0000-4000-8514-0000000000a4'::uuid),
                                   ('caregiver', '00000000-0000-4000-8514-0000000000a5'::uuid),
                                   ('guest', '00000000-0000-4000-8514-0000000000a6'::uuid),
                                   ('nobody', null::uuid)) as v(who, adder) loop
      insert into m0514_rows values (t, x.who, pg_temp.m0514_put(t, f1, x.adder, x.who));
    end loop;
    insert into m0514_rows values (t, 'elsewhere', pg_temp.m0514_put(t, f2, '00000000-0000-4000-8514-0000000000a3', 'elsewhere'));
  end loop;
end $$;

do $$
declare
  f1        constant uuid := '00000000-0000-4000-8514-0000000000f1';
  f2        constant uuid := '00000000-0000-4000-8514-0000000000f2';
  parent    constant text := '00000000-0000-4000-8514-0000000000a1';
  teen      constant text := '00000000-0000-4000-8514-0000000000a3';
  child     constant text := '00000000-0000-4000-8514-0000000000a4';
  carer     constant text := '00000000-0000-4000-8514-0000000000a5';
  managers  constant text[] := array['financial_accounts', 'family_wallets', 'stripe_connected_accounts', 'stripe_financial_accounts',
                                     'billing_customers', 'checkout_sessions', 'babysitter_payments'];
  added     constant text[] := array['home_warranties', 'auto_insurance_policies', 'vehicle_registrations', 'paperwork_items'];
  tables    constant text[] := managers || array['transactions'] || added;
  policy    constant text := 'Household money is read by a parent or adult';
  rule_mgr  constant text := '(is_family_member(family_id) AND can_manage_family(family_id))';
  rule_mem  constant text := '(is_family_member(family_id) AND (can_manage_family(family_id) OR is_self_member(member_id)))';
  rule_add  constant text := '(is_family_member(family_id) AND (can_manage_family(family_id) OR (created_by = auth.uid())))';
  installed boolean := exists (select 1 from pg_policies p where p.schemaname = 'public'
                                 and p.tablename = 'financial_accounts' and p.policyname = 'Household money is read by a parent or adult');
  failures  text[] := '{}';
  x         record;
  t         text;
  seen      uuid[];
  allowed   uuid[];
  everyone  uuid[];
  leaks     text[];
  bad       text[];
  n         int;
  got       text;
  q         text;
begin
  -- 1. The teen, the child, the caregiver and the guest.
  for x in select * from (values ('teen', teen), ('child', child), ('caregiver', carer),
                                 ('guest', '00000000-0000-4000-8514-0000000000a6')) as v(who, uid) loop
    leaks := '{}';
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.m0514_seen('authenticated', x.uid, t, f1);
      -- What the rule gives them: their own transaction, their own records.
      select coalesce(array_agg(r.id), '{}') into allowed from m0514_rows r
       where r.tbl = t and r.who = x.who and t <> all (managers);
      -- The held 0509 withholds every auto policy from a guest (the table has
      -- no member), so there the guest's own is not theirs to read either.
      if x.who = 'guest' and t = 'auto_insurance_policies'
         and exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t
                       and p.policyname = 'A guest does not read ' || t) then
        allowed := '{}';
      end if;
      if seen is null then
        bad := array_append(bad, format('%s (the read was refused)', t));
        continue;
      end if;
      select count(*) into n from unnest(seen) s(id) where not s.id = any (allowed);
      if n <> 0 then
        leaks := array_append(leaks, format('%s %s', t, n));
      end if;
      if not seen @> allowed then
        bad := array_append(bad, t);
      end if;
    end loop;
    if cardinality(leaks) > 0 then
      failures := array_append(failures, format('the %s reads the household''s money in %s of 12 tables (%s)',
                                                x.who, cardinality(leaks), array_to_string(leaks, ', ')));
    end if;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: the %s no longer reads their own transaction or records in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 2. The managers, and 5. the service role.
  for x in select * from (values ('the parent', 'authenticated', parent),
                                 ('the adult', 'authenticated', '00000000-0000-4000-8514-0000000000a2'),
                                 ('the service role (with the child''s user id)', 'service_role', child),
                                 ('the service role (no user id)', 'service_role', null)) as v(who, role, uid) loop
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.m0514_seen(x.role, x.uid, t, f1);
      select coalesce(array_agg(r.id), '{}') into everyone from m0514_rows r where r.tbl = t and r.who <> 'elsewhere';
      if seen is null or not (seen @> everyone and everyone @> seen) then
        bad := array_append(bad, format('%s (%s of %s)', t, coalesce(cardinality(seen)::text, 'refused'), cardinality(everyone)));
      end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: %s does not read every Coin House row in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 3. The teen manages a household of their own.
  bad := '{}';
  foreach t in array tables loop
    seen := pg_temp.m0514_seen('authenticated', teen, t, f2);
    if coalesce(cardinality(seen), -1) <> 1 then
      bad := array_append(bad, format('%s (%s)', t, coalesce(cardinality(seen)::text, 'refused')));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('CONTROL: the teen does not read the row in the household they manage in %s', array_to_string(bad, ', ')));
  end if;

  -- 4. The removed adult and the stranger.
  for x in select * from (values ('the removed adult', '00000000-0000-4000-8514-0000000000a8'),
                                 ('a stranger', '00000000-0000-4000-8514-0000000000a9')) as v(who, uid) loop
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.m0514_seen('authenticated', x.uid, t, f1);
      if coalesce(cardinality(seen), 0) <> 0 then
        bad := array_append(bad, format('%s %s', t, cardinality(seen)));
      end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('%s reads Coin House money in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 6. The screens' writes come back to their writer.
  for x in select * from (values
      ('the child''s own paperwork item', child,
       format('insert into public.paperwork_items (family_id, title, created_by) values (%L, %L, %L) returning id', f1, 'm0514 my slip', child)),
      ('the teen''s own warranty', teen,
       format('insert into public.home_warranties (family_id, name, created_by) values (%L, %L, %L) returning id', f1, 'm0514 my bike', teen)),
      ('a parent''s transaction', parent,
       format('insert into public.transactions (family_id, name, amount) values (%L, %L, %s) returning id', f1, 'm0514 groceries', -40))) as v(what, uid, q) loop
    got := pg_temp.m0514_as(x.uid, x.q);
    if got is distinct from 'OK 1' then
      failures := array_append(failures, format('CONTROL: %s, inserted with returning, did not come back (%s)', x.what, got));
    end if;
  end loop;
  select id::text into q from m0514_rows where tbl = 'paperwork_items' and who = 'child';
  got := pg_temp.m0514_as(child, format('update public.paperwork_items set status = %L where id = %L', 'in_progress', q));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the child could not change their own paperwork item (%s)', got));
  end if;
  select id::text into q from m0514_rows where tbl = 'paperwork_items' and who = 'parent';
  got := pg_temp.m0514_as(child, format('update public.paperwork_items set status = %L where id = %L', 'archived', q));
  if got is distinct from 'OK 0' then
    failures := array_append(failures, format('the child changed the parent''s paperwork item (%s)', got));
  end if;

  -- 7. Wiring.
  bad := '{}';
  foreach t in array tables loop
    select count(*) into n from pg_policies p
     where p.schemaname = 'public' and p.tablename = t and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL');
    if n <> 1 or not exists (select 1 from pg_policies p
                              where p.schemaname = 'public' and p.tablename = t and p.policyname = policy
                                and p.permissive = 'PERMISSIVE' and p.cmd = 'SELECT' and p.roles::text[] = array['authenticated']
                                and replace(p.qual, 'public.', '') = case when t = any (managers) then rule_mgr
                                                                          when t = 'transactions' then rule_mem
                                                                          else rule_add end) then
      bad := array_append(bad, format('%s (%s permissive read polic(ies): %s)', t, n,
        (select string_agg(p.policyname || ' USING ' || replace(p.qual, 'public.', ''), '; ') from pg_policies p
          where p.schemaname = 'public' and p.tablename = t and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL'))));
    end if;
    if exists (select 1 from pg_policies p
                where p.schemaname = 'public' and p.tablename = t and p.permissive = 'RESTRICTIVE' and p.cmd in ('SELECT', 'ALL')
                  and p.policyname <> 'A guest does not read ' || t) then
      bad := array_append(bad, format('%s (a restrictive read policy other than a guest''s)', t));
    end if;
  end loop;
  foreach t in array added loop
    if (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = t and p.permissive = 'PERMISSIVE'
           and p.cmd in ('INSERT', 'UPDATE', 'DELETE')
           and replace(coalesce(p.qual, p.with_check), 'public.', '') = 'is_family_member(family_id)') <> 3 then
      bad := array_append(bad, format('%s (its member-wide insert, update and delete are not all there)', t));
    end if;
  end loop;
  foreach t in array array['financial_accounts', 'family_wallets', 'transactions', 'babysitter_payments'] loop
    if (select count(distinct p.cmd) from pg_policies p
         where p.schemaname = 'public' and p.tablename = t and p.permissive = 'PERMISSIVE'
           and p.cmd in ('INSERT', 'UPDATE', 'DELETE')
           and replace(coalesce(p.qual, p.with_check), 'public.', '') = 'can_manage_family(family_id)') <> 3 then
      bad := array_append(bad, format('%s (its manager insert, update and delete are not all there)', t));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('the read is not 0514''s on %s', array_to_string(bad, ' | ')));
  end if;

  if installed then
    -- N1. The family-wide read put back.
    begin
      foreach t in array tables loop
        execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_n1_read', t);
      end loop;
      bad := '{}';
      foreach t in array tables loop
        seen := pg_temp.m0514_seen('authenticated', child, t, f1);
        if not (select id from m0514_rows where tbl = t
                  and who = case when t = any (managers) then 'household' when t = 'transactions' then 'ward' else 'parent' end)
               = any (coalesce(seen, '{}')) then
          bad := array_append(bad, t);
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the family-wide read put back the child did not read the household''s row in %s, so this fixture cannot see the limit', array_to_string(bad, ', ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. A caregiver clause added to transactions.
    begin
      drop policy "Household money is read by a parent or adult" on public.transactions;
      create policy "Household money is read by a parent or adult" on public.transactions for select to authenticated
        using (public.is_family_member(family_id) and (public.can_manage_family(family_id) or public.is_self_member(member_id)
               or public.family_role(family_id) = 'caregiver'));
      seen := pg_temp.m0514_seen('authenticated', carer, 'transactions', f1);
      if not (select id from m0514_rows where tbl = 'transactions' and who = 'ward') = any (coalesce(seen, '{}')) then
        failures := array_append(failures, 'MUTATION CONTROL: with a caregiver clause on transactions the caregiver still did not read the ward''s transaction, so 1. cannot catch a rule wider than the owner''s');
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'household money is read beyond its parents and adults:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'household-money-is-a-parents-or-adults: OK (the teen, the child, the caregiver and the guest read no row of the seven managers tables, only the transaction tagged to them and only the records they added (counted); the parent and the adult read every row; the teen reads the household they manage; the removed adult and a stranger read nothing; the service role with and without a user id reads every row; the child''s own paperwork item, the teen''s own warranty and a parent''s transaction come back from insert … returning (OK 1), the child changes their own paperwork item (OK 1) and not the parent''s (OK 0); one permissive read per table with 0514''s exact predicate for its rule, the added-by tables keep their member-wide writes and the money tables their manager ones, no restrictive read but a guest''s; negative control: with the family-wide read put back the child reads the household''s row in all twelve; mutation control: with a caregiver clause on transactions the caregiver reads the ward''s transaction)';
end $$;

rollback;
