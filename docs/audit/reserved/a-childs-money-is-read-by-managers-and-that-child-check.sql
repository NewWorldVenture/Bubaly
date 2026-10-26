-- ── A child's money is read by managers and that child (0515) ───────────────
--
-- Sixteen tables hold a child's money and read with is_family_member(family_id),
-- so a sibling, a caregiver or a guest reads every child's balance, ledger,
-- goals, allowance, cards, investments, gift links and Pay-IDs. The held 0515
-- replaces each read with, inside is_family_member(family_id):
--
--   by member:  can_manage_family(family_id) or is_self_member(member_id)
--               -- child_wallets, wallet_cards, wallet_passes, wallet_rewards,
--               stripe_cardholders
--   by wallet:  can_manage_family(family_id)
--               or is_own_child_wallet_in_family(child_wallet_id, family_id)
--               -- stripe_issuing_cards, stripe_authorizations,
--               wallet_transactions, invest_holdings, invest_orders,
--               pay_handles, wallet_buckets, wallet_goals, wallet_rules,
--               allowance_rules, gift_links
--
-- Fixture, Piggy House: a parent and an adult (managers), a teen (who is also
-- the parent of a household of their own), a child (who is also a child in
-- Dad's House, with a wallet there), a caregiver, a guest, a ward with no
-- login, and an adult since removed (is_active false). Wallets for the teen,
-- the child and the ward. Written as the table owner: in each wallet table, a
-- row on each wallet and, where the column allows it, one on no wallet; in
-- each member table, a row on each member it can carry and one on nobody; in
-- the teen's own household one row of each table; and one Piggy House
-- transaction naming the child's wallet in Dad's House.
--
-- What this probe asserts, through PostgREST's role:
--
--   1. the teen and the child read their own rows and no other (counted),
--      and the child not the Piggy House row that names their Dad's House
--      wallet; the caregiver and the guest read only their own cards, passes
--      and rewards;
--   2. control: the parent and the adult read every Piggy House row;
--   3. control: the teen reads every row in the household they manage;
--   4. the removed adult and a stranger read nothing;
--   5. control: the service role, carrying the child's user id and without
--      one, reads every Piggy House row;
--   6. control: the writes the screens make come back to their writer: the
--      teen's own wallet card and a parent's goal for the child (insert …
--      returning, OK 1 each);
--   7. wiring: one permissive read per table, by 0515's name, granted to
--      authenticated, USING exactly 0515's predicate for its rule; the helper
--      is SECURITY DEFINER with a pinned search_path and not executable by
--      PUBLIC or anon; allowance_rules keeps its member-wide insert, update
--      and delete; the only restrictive reads are a guest's (the held 0509's);
--
-- and, only where 0515 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with the family-wide read put back, the child reads
--       the ward's row in all sixteen (1 each): the fixture reaches the limit;
--   M1. MUTATION CONTROL: with the helper no longer pinned to the row's
--       family, the child reads the Piggy House row naming their Dad's House
--       wallet, so 1. is what catches the pin going.
--
-- Everything is rolled back.
--
-- HELD with 0515: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/child-money-runtime.yml runs it there to show the failure,
-- then applies the held migration and requires it to pass. It moves back to
-- docs/audit/ when 0515 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8515-0000000000a1','c0515-parent@example.com'),
  ('00000000-0000-4000-8515-0000000000a2','c0515-adult@example.com'),
  ('00000000-0000-4000-8515-0000000000a3','c0515-teen@example.com'),
  ('00000000-0000-4000-8515-0000000000a4','c0515-child@example.com'),
  ('00000000-0000-4000-8515-0000000000a5','c0515-caregiver@example.com'),
  ('00000000-0000-4000-8515-0000000000a6','c0515-guest@example.com'),
  ('00000000-0000-4000-8515-0000000000a8','c0515-gone@example.com'),
  ('00000000-0000-4000-8515-0000000000a9','c0515-stranger@example.com')
  on conflict do nothing;
-- on_family_created files each creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8515-0000000000f1','Piggy House','00000000-0000-4000-8515-0000000000a1'),
  ('00000000-0000-4000-8515-0000000000f2','Teen''s Own House','00000000-0000-4000-8515-0000000000a3'),
  ('00000000-0000-4000-8515-0000000000f3','Next Door','00000000-0000-4000-8515-0000000000a9'),
  ('00000000-0000-4000-8515-0000000000f4','Dad''s House','00000000-0000-4000-8515-0000000000a9');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8515-0000000000a1','00000000-0000-4000-8515-0000000000a3','00000000-0000-4000-8515-0000000000a9');
update public.family_members set id = '00000000-0000-4000-8515-0000000000c1'
 where family_id = '00000000-0000-4000-8515-0000000000f1' and user_id = '00000000-0000-4000-8515-0000000000a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8515-0000000000c2','00000000-0000-4000-8515-0000000000f1','00000000-0000-4000-8515-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8515-0000000000c3','00000000-0000-4000-8515-0000000000f1','00000000-0000-4000-8515-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8515-0000000000c4','00000000-0000-4000-8515-0000000000f1','00000000-0000-4000-8515-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8515-0000000000c5','00000000-0000-4000-8515-0000000000f1','00000000-0000-4000-8515-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8515-0000000000c6','00000000-0000-4000-8515-0000000000f1','00000000-0000-4000-8515-0000000000a6','Guest','guest',true),
  ('00000000-0000-4000-8515-0000000000c7','00000000-0000-4000-8515-0000000000f1',null,'Ward','child',true),
  ('00000000-0000-4000-8515-0000000000c8','00000000-0000-4000-8515-0000000000f1','00000000-0000-4000-8515-0000000000a8','Adult (removed)','adult',false),
  ('00000000-0000-4000-8515-0000000000c9','00000000-0000-4000-8515-0000000000f2',null,'Teen''s ward','child',true),
  ('00000000-0000-4000-8515-0000000000ca','00000000-0000-4000-8515-0000000000f4','00000000-0000-4000-8515-0000000000a4','Child','child',true);
insert into public.child_wallets (id, family_id, member_id) values
  ('00000000-0000-4000-8515-0000000000d3','00000000-0000-4000-8515-0000000000f1','00000000-0000-4000-8515-0000000000c3'),
  ('00000000-0000-4000-8515-0000000000d4','00000000-0000-4000-8515-0000000000f1','00000000-0000-4000-8515-0000000000c4'),
  ('00000000-0000-4000-8515-0000000000d7','00000000-0000-4000-8515-0000000000f1','00000000-0000-4000-8515-0000000000c7'),
  ('00000000-0000-4000-8515-0000000000d9','00000000-0000-4000-8515-0000000000f2','00000000-0000-4000-8515-0000000000c9'),
  ('00000000-0000-4000-8515-0000000000da','00000000-0000-4000-8515-0000000000f4','00000000-0000-4000-8515-0000000000ca');

-- One row in one of the eleven wallet tables, as the server writes it, on a
-- wallet (or none). Written past the tables' own triggers: these are fixture
-- rows, not the writes under test.
create or replace function pg_temp.c0515_put(t text, fam uuid, wallet uuid, tag text) returns uuid
language plpgsql as $fn$
declare id uuid; holder uuid; asset uuid;
begin
  select a.id into asset from public.invest_assets a order by a.id limit 1;
  if t = 'stripe_issuing_cards' then
    insert into public.stripe_cardholders (family_id, member_id, child_wallet_id, stripe_cardholder_id)
      select w.family_id, w.member_id, w.id, 'ich_c0515_' || tag from public.child_wallets w where w.id = wallet
      on conflict (family_id, member_id) do update set child_wallet_id = excluded.child_wallet_id
      returning stripe_cardholders.id into holder;
  end if;
  execute case t
    when 'stripe_issuing_cards' then
      'insert into public.stripe_issuing_cards (family_id, child_wallet_id, cardholder_id, stripe_card_id) values ($1, $2, $4, ''ic_c0515_'' || $3) returning id'
    when 'stripe_authorizations' then
      'insert into public.stripe_authorizations (family_id, child_wallet_id, outcome, stripe_authorization_id) values ($1, $2, ''approved'', ''iauth_c0515_'' || $3) returning id'
    when 'wallet_transactions' then
      'insert into public.wallet_transactions (family_id, child_wallet_id, type, status, direction, amount_cents, description) values ($1, $2, ''parent_top_up'', ''completed'', ''credit'', 500, ''c0515 '' || $3) returning id'
    when 'invest_holdings' then
      'insert into public.invest_holdings (family_id, child_wallet_id, asset_id, shares, avg_cost_cents) values ($1, $2, $5, 1, 100) returning id'
    when 'invest_orders' then
      'insert into public.invest_orders (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents) values ($1, $2, $5, ''buy'', 1, 100, 100) returning id'
    when 'pay_handles' then
      'insert into public.pay_handles (family_id, child_wallet_id, handle) values ($1, $2, ''c0515_'' || $3) returning id'
    when 'wallet_buckets' then
      'insert into public.wallet_buckets (family_id, child_wallet_id, kind, label) values ($1, $2, ''save'', ''c0515 '' || $3) returning id'
    when 'wallet_goals' then
      'insert into public.wallet_goals (family_id, child_wallet_id, title, target_cents) values ($1, $2, ''c0515 '' || $3, 5000) returning id'
    when 'wallet_rules' then
      'insert into public.wallet_rules (family_id, child_wallet_id) values ($1, $2) returning id'
    when 'allowance_rules' then
      'insert into public.allowance_rules (family_id, child_wallet_id, amount_cents) values ($1, $2, 500) returning id'
    when 'gift_links' then
      'insert into public.gift_links (family_id, child_wallet_id, token) values ($1, $2, ''c0515_gift_'' || $3) returning id'
  end
  into id using fam, wallet, tag, holder, asset;
  return id;
end
$fn$;

-- One row in one of the member tables, on a member (or none).
create or replace function pg_temp.c0515_putm(t text, fam uuid, member uuid, tag text) returns uuid
language plpgsql as $fn$
declare id uuid;
begin
  execute case t
    when 'wallet_cards' then
      'insert into public.wallet_cards (family_id, member_id, name) values ($1, $2, ''c0515 card '' || $3) returning id'
    when 'wallet_passes' then
      'insert into public.wallet_passes (family_id, member_id, name) values ($1, $2, ''c0515 pass '' || $3) returning id'
    when 'wallet_rewards' then
      'insert into public.wallet_rewards (family_id, member_id, name) values ($1, $2, ''c0515 reward '' || $3) returning id'
    when 'stripe_cardholders' then
      'insert into public.stripe_cardholders (family_id, member_id, stripe_cardholder_id) values ($1, $2, ''ich_c0515m_'' || $3)
         on conflict (family_id, member_id) do update set stripe_cardholder_id = stripe_cardholders.stripe_cardholder_id returning id'
  end
  into id using fam, member, tag;
  return id;
end
$fn$;

-- The ids of one family's rows in one table, as one caller sees them; null if
-- the read itself was refused.
create or replace function pg_temp.c0515_seen(p_role text, p_uid text, t text, fam uuid) returns uuid[]
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
create or replace function pg_temp.c0515_as(p_uid text, p_sql text) returns text
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

create temp table c0515_rows (tbl text, who text, id uuid) on commit drop;

do $$
declare
  f1 constant uuid := '00000000-0000-4000-8515-0000000000f1';
  f2 constant uuid := '00000000-0000-4000-8515-0000000000f2';
  t  text;
  x  record;
  nullable_wallet constant text[] := array['gift_links', 'pay_handles', 'stripe_authorizations', 'wallet_goals', 'wallet_rules', 'wallet_transactions'];
begin
  perform set_config('session_replication_role', 'replica', true);
  -- The wallets themselves.
  insert into c0515_rows values
    ('child_wallets', 'teen', '00000000-0000-4000-8515-0000000000d3'), ('child_wallets', 'child', '00000000-0000-4000-8515-0000000000d4'),
    ('child_wallets', 'ward', '00000000-0000-4000-8515-0000000000d7'), ('child_wallets', 'elsewhere', '00000000-0000-4000-8515-0000000000d9');
  -- The eleven wallet tables, on each wallet, on none where allowed, and in the teen's household.
  foreach t in array array['stripe_issuing_cards', 'stripe_authorizations', 'wallet_transactions', 'invest_holdings', 'invest_orders',
                           'pay_handles', 'wallet_buckets', 'wallet_goals', 'wallet_rules', 'allowance_rules', 'gift_links'] loop
    for x in select * from (values ('teen', '00000000-0000-4000-8515-0000000000d3'::uuid),
                                   ('child', '00000000-0000-4000-8515-0000000000d4'::uuid),
                                   ('ward', '00000000-0000-4000-8515-0000000000d7'::uuid)) as v(who, wallet) loop
      insert into c0515_rows values (t, x.who, pg_temp.c0515_put(t, f1, x.wallet, x.who || '_' || substr(md5(t), 1, 6)));
    end loop;
    if t = any (nullable_wallet) then
      insert into c0515_rows values (t, 'nobody', pg_temp.c0515_put(t, f1, null, 'nobody_' || substr(md5(t), 1, 6)));
    end if;
    insert into c0515_rows values (t, 'elsewhere', pg_temp.c0515_put(t, f2, '00000000-0000-4000-8515-0000000000d9', 'else_' || substr(md5(t), 1, 6)));
  end loop;
  -- A Piggy House transaction naming the child's wallet in Dad's House.
  insert into c0515_rows values ('wallet_transactions', 'pinned',
    pg_temp.c0515_put('wallet_transactions', f1, '00000000-0000-4000-8515-0000000000da', 'pinned'));
  -- The member tables.
  foreach t in array array['wallet_cards', 'wallet_passes', 'wallet_rewards'] loop
    for x in select * from (values ('parent', '00000000-0000-4000-8515-0000000000c1'::uuid),
                                   ('teen', '00000000-0000-4000-8515-0000000000c3'::uuid),
                                   ('child', '00000000-0000-4000-8515-0000000000c4'::uuid),
                                   ('caregiver', '00000000-0000-4000-8515-0000000000c5'::uuid),
                                   ('guest', '00000000-0000-4000-8515-0000000000c6'::uuid),
                                   ('ward', '00000000-0000-4000-8515-0000000000c7'::uuid),
                                   ('nobody', null::uuid)) as v(who, member) loop
      insert into c0515_rows values (t, x.who, pg_temp.c0515_putm(t, f1, x.member, x.who));
    end loop;
    insert into c0515_rows values (t, 'elsewhere', pg_temp.c0515_putm(t, f2, '00000000-0000-4000-8515-0000000000c9', 'elsewhere'));
  end loop;
  -- Cardholders (one per member), the issuing-card fixture above made the teen's, the child's and the ward's.
  insert into c0515_rows
    select 'stripe_cardholders', case h.member_id when '00000000-0000-4000-8515-0000000000c3' then 'teen'
                                                  when '00000000-0000-4000-8515-0000000000c4' then 'child'
                                                  when '00000000-0000-4000-8515-0000000000c7' then 'ward' else 'elsewhere' end, h.id
      from public.stripe_cardholders h
     where h.family_id in (f1, f2);
  perform set_config('session_replication_role', 'origin', true);
end $$;

do $$
declare
  f1        constant uuid := '00000000-0000-4000-8515-0000000000f1';
  f2        constant uuid := '00000000-0000-4000-8515-0000000000f2';
  parent    constant text := '00000000-0000-4000-8515-0000000000a1';
  teen      constant text := '00000000-0000-4000-8515-0000000000a3';
  child     constant text := '00000000-0000-4000-8515-0000000000a4';
  members   constant text[] := array['child_wallets', 'wallet_cards', 'wallet_passes', 'wallet_rewards', 'stripe_cardholders'];
  wallets   constant text[] := array['stripe_issuing_cards', 'stripe_authorizations', 'wallet_transactions', 'invest_holdings',
                                     'invest_orders', 'pay_handles', 'wallet_buckets', 'wallet_goals', 'wallet_rules',
                                     'allowance_rules', 'gift_links'];
  tables    constant text[] := members || wallets;
  policy    constant text := 'A child''s money is read by a manager or that child';
  rule_mem  constant text := '(is_family_member(family_id) AND (can_manage_family(family_id) OR is_self_member(member_id)))';
  rule_wal  constant text := '(is_family_member(family_id) AND (can_manage_family(family_id) OR is_own_child_wallet_in_family(child_wallet_id, family_id)))';
  installed boolean := exists (select 1 from pg_policies p where p.schemaname = 'public'
                                 and p.tablename = 'child_wallets' and p.policyname = 'A child''s money is read by a manager or that child');
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
begin
  -- 1. The teen, the child, the caregiver and the guest.
  for x in select * from (values ('teen', teen), ('child', child),
                                 ('caregiver', '00000000-0000-4000-8515-0000000000a5'),
                                 ('guest', '00000000-0000-4000-8515-0000000000a6')) as v(who, uid) loop
    leaks := '{}';
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.c0515_seen('authenticated', x.uid, t, f1);
      select coalesce(array_agg(r.id), '{}') into allowed from c0515_rows r where r.tbl = t and r.who = x.who;
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
      failures := array_append(failures, format('the %s reads other members'' money in %s of 16 tables (%s)',
                                                x.who, cardinality(leaks), array_to_string(leaks, ', ')));
    end if;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: the %s no longer reads their own money in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 2. The managers, and 5. the service role.
  for x in select * from (values ('the parent', 'authenticated', parent),
                                 ('the adult', 'authenticated', '00000000-0000-4000-8515-0000000000a2'),
                                 ('the service role (with the child''s user id)', 'service_role', child),
                                 ('the service role (no user id)', 'service_role', null)) as v(who, role, uid) loop
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.c0515_seen(x.role, x.uid, t, f1);
      select coalesce(array_agg(r.id), '{}') into everyone from c0515_rows r where r.tbl = t and r.who <> 'elsewhere';
      if seen is null or not (seen @> everyone and everyone @> seen) then
        bad := array_append(bad, format('%s (%s of %s)', t, coalesce(cardinality(seen)::text, 'refused'), cardinality(everyone)));
      end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: %s does not read every Piggy House row in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 3. The teen manages a household of their own.
  bad := '{}';
  foreach t in array tables loop
    seen := pg_temp.c0515_seen('authenticated', teen, t, f2);
    select coalesce(array_agg(r.id), '{}') into everyone from c0515_rows r where r.tbl = t and r.who = 'elsewhere';
    if seen is null or not (seen @> everyone and everyone @> seen) then
      bad := array_append(bad, format('%s (%s)', t, coalesce(cardinality(seen)::text, 'refused')));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('CONTROL: the teen does not read the household they manage in %s', array_to_string(bad, ', ')));
  end if;

  -- 4. The removed adult and the stranger.
  for x in select * from (values ('the removed adult', '00000000-0000-4000-8515-0000000000a8'),
                                 ('a stranger', '00000000-0000-4000-8515-0000000000a9')) as v(who, uid) loop
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.c0515_seen('authenticated', x.uid, t, f1);
      if coalesce(cardinality(seen), 0) <> 0 then
        bad := array_append(bad, format('%s %s', t, cardinality(seen)));
      end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('%s reads Piggy House money in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 6. The screens' writes come back to their writer.
  for x in select * from (values
      ('the teen''s own wallet card', teen,
       format('insert into public.wallet_cards (family_id, member_id, name, created_by) values (%L, %L, %L, %L) returning id',
              f1, '00000000-0000-4000-8515-0000000000c3', 'c0515 my card', teen)),
      ('a parent''s goal for the child', parent,
       format('insert into public.wallet_goals (family_id, child_wallet_id, title, target_cents, created_by) values (%L, %L, %L, %s, %L) returning id',
              f1, '00000000-0000-4000-8515-0000000000d4', 'c0515 bike', 20000, parent))) as v(what, uid, q) loop
    got := pg_temp.c0515_as(x.uid, x.q);
    if got is distinct from 'OK 1' then
      failures := array_append(failures, format('CONTROL: %s, inserted with returning, did not come back (%s)', x.what, got));
    end if;
  end loop;

  -- 7. Wiring.
  bad := '{}';
  foreach t in array tables loop
    select count(*) into n from pg_policies p
     where p.schemaname = 'public' and p.tablename = t and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL');
    if n <> 1 or not exists (select 1 from pg_policies p
                              where p.schemaname = 'public' and p.tablename = t and p.policyname = policy
                                and p.permissive = 'PERMISSIVE' and p.cmd = 'SELECT' and p.roles::text[] = array['authenticated']
                                and replace(p.qual, 'public.', '') = case when t = any (members) then rule_mem else rule_wal end) then
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
  if (select count(*) from pg_policies p
       where p.schemaname = 'public' and p.tablename = 'allowance_rules' and p.permissive = 'PERMISSIVE'
         and p.cmd in ('INSERT', 'UPDATE', 'DELETE')
         and replace(coalesce(p.qual, p.with_check), 'public.', '') = 'is_family_member(family_id)') <> 3 then
    bad := array_append(bad, 'allowance_rules (its member-wide insert, update and delete are not all there)');
  end if;
  if to_regprocedure('public.is_own_child_wallet_in_family(uuid,uuid)') is null then
    bad := array_append(bad, 'is_own_child_wallet_in_family (missing)');
  elsif not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.is_own_child_wallet_in_family(uuid,uuid)')
                     and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%')
     or has_function_privilege('anon', 'public.is_own_child_wallet_in_family(uuid,uuid)', 'execute')
     or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                 where p.oid = to_regprocedure('public.is_own_child_wallet_in_family(uuid,uuid)')
                   and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    bad := array_append(bad, 'is_own_child_wallet_in_family (not SECURITY DEFINER with a pinned search_path, or executable by PUBLIC or anon)');
  end if;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('the read is not 0515''s on %s', array_to_string(bad, ' | ')));
  end if;

  if installed then
    -- N1. The family-wide read put back.
    begin
      foreach t in array tables loop
        execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_n1_read', t);
      end loop;
      bad := '{}';
      foreach t in array tables loop
        seen := pg_temp.c0515_seen('authenticated', child, t, f1);
        if not (select id from c0515_rows where tbl = t and who = 'ward' limit 1) = any (coalesce(seen, '{}')) then
          bad := array_append(bad, t);
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the family-wide read put back the child did not read the ward''s row in %s, so this fixture cannot see the limit', array_to_string(bad, ', ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The helper no longer pinned to the row's family.
    begin
      create or replace function public.is_own_child_wallet_in_family(p_child_wallet_id uuid, p_family_id uuid)
      returns boolean language sql stable security definer set search_path = public, pg_temp as
      $m1$ select exists (select 1 from public.child_wallets w where w.id = p_child_wallet_id and public.is_self_member(w.member_id)) $m1$;
      seen := pg_temp.c0515_seen('authenticated', child, 'wallet_transactions', f1);
      if not (select id from c0515_rows where tbl = 'wallet_transactions' and who = 'pinned') = any (coalesce(seen, '{}')) then
        failures := array_append(failures, 'MUTATION CONTROL: with the helper no longer pinned to the row''s family the child still did not read the Piggy House row naming their Dad''s House wallet, so 1. cannot catch the pin going');
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a child''s money is read beyond its managers and that child:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-childs-money-is-read-by-managers-and-that-child: OK (the teen and the child read their own rows in the sixteen tables and no other (counted), the child not the Piggy House row naming their other household''s wallet; the caregiver and the guest read only their own cards, passes and rewards; the parent and the adult read every row; the teen reads the household they manage; the removed adult and a stranger read nothing; the service role with and without a user id reads every row; the teen''s own wallet card and a parent''s goal for the child come back from insert … returning (OK 1); one permissive read per table with 0515''s exact predicate for its rule, the helper SECURITY DEFINER with a pinned search_path and not executable by PUBLIC or anon, allowance_rules keeps its member-wide writes, no restrictive read but a guest''s; negative control: with the family-wide read put back the child reads the ward''s row in all sixteen; mutation control: with the helper unpinned the child reads the row naming their other household''s wallet)';
end $$;

rollback;
