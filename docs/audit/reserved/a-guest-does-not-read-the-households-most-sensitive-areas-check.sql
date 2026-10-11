-- ── A guest does not read the household's most sensitive areas (0509) ───────
--
-- /family/permissions and the FAQ promise a guest "limited shared events
-- only", and a guest's session read the whole household: locations, money and
-- cards, medical and insurance records, Guardian and the household inbox
-- (ROLE-SCOPE-001). The held 0509 adds one RESTRICTIVE read policy to each of
-- 59 such tables: not a guest of the row's family, or the row is about the
-- guest themselves. Nobody else's reads change.
--
-- Fixture, Guest House: a parent, a caregiver, a guest and a ward with no
-- login. In each of the 59 tables, written as the table owner (one generic row
-- per table, its required columns filled by type, foreign keys deferred for the
-- seed only): a row about the ward, and, where the table has a member_id, a row
-- about the guest. The guest is also the parent of a household of their own,
-- with a member_locations row about its ward.
--
-- What this probe asserts, through PostgREST's role, in every table:
--
--   1. the guest reads no Guest House row that is not about them (counted);
--   2. control: where a row is about the guest, the guest reads it (1), but
--      in the eight tables the released schema already closes to a guest
--      (0481's sweep; listed in the probe), and in behavior_logs where the
--      held 0510 is installed (a note is read by a manager, its author or a
--      caregiver), and 0509 never takes a guest's own rows away (compared with
--      the 59 policies dropped);
--   3. control: the caregiver and the parent read exactly what they read with
--      0509's 59 policies taken away (counted per table, so 0509 changes no
--      one but a guest), and the parent reads every Guest House row;
--   4. control: the guest reads the row in the household they are a parent of
--      (1), so the narrowing is the row's family's, not the account's;
--   5. control: the service role, carrying the guest's user id and without
--      one, reads every Guest House row;
--   6. wiring: each of the 59 tables carries "A guest does not read <table>",
--      RESTRICTIVE, SELECT, to authenticated, USING exactly 0509's predicate;
--      is_family_guest is SECURITY DEFINER with a pinned search_path and not
--      executable by PUBLIC or anon;
--
-- and, only where 0509 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with the 59 policies dropped, the guest reads the
--       ward's row in every table the released schema leaves open (51; 50
--       with 0510), and in none of the eight it already closes (nine with
--       0510): the fixture reaches the limit 0509 closes, and 0509's guard on
--       those is defence in depth;
--   M1. MUTATION CONTROL: with is_family_guest asking whether the caller is a
--       guest ANYWHERE (not of the row's family), the guest no longer reads
--       the row in the household they are a parent of, so 4. catches it.
--
-- Everything is rolled back.
--
-- HELD with 0509: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/guest-scope-runtime.yml runs it there to show the failure,
-- then applies the held migration and requires it to pass. It moves back to
-- docs/audit/ when 0509 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8509-0000000000a1','g0509-parent@example.com'),
  ('00000000-0000-4000-8509-0000000000a5','g0509-caregiver@example.com'),
  ('00000000-0000-4000-8509-0000000000a6','g0509-guest@example.com')
  on conflict do nothing;
-- on_family_created files each creator as its household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8509-0000000000f1','Guest House','00000000-0000-4000-8509-0000000000a1'),
  ('00000000-0000-4000-8509-0000000000f2','Guest''s Own House','00000000-0000-4000-8509-0000000000a6');
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8509-0000000000c5','00000000-0000-4000-8509-0000000000f1','00000000-0000-4000-8509-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8509-0000000000c6','00000000-0000-4000-8509-0000000000f1','00000000-0000-4000-8509-0000000000a6','Guest','guest',true),
  ('00000000-0000-4000-8509-0000000000c7','00000000-0000-4000-8509-0000000000f1',null,'Ward','child',true),
  ('00000000-0000-4000-8509-0000000000c9','00000000-0000-4000-8509-0000000000f2',null,'Guest''s ward','child',true);

create temp table g0509_tables (t text primary key, has_member boolean) on commit drop;
insert into g0509_tables (t)
select unnest(array[
  'member_locations','location_events','safety_check_ins','driving_trips','family_places','home_locations',
  'allowance_rules','babysitter_payments','billing_customers','bills','budgets',
  'child_wallets','family_wallets','financial_accounts','expense_splits','expense_split_shares',
  'gift_payments','pay_handles','invest_holdings','invest_orders','loyalty_accounts','loyalty_transactions',
  'money_timeline_insights','savings_goals','subscriptions_tracked','transactions','utility_bills',
  'stripe_authorizations','stripe_cardholders','stripe_connected_accounts','stripe_financial_accounts','stripe_issuing_cards',
  'wallet_audit_logs','wallet_buckets','wallet_cards','wallet_goals','wallet_passes','wallet_rewards','wallet_rules','wallet_transactions',
  'medications','medication_schedules','medication_doses','health_providers',
  'insurance_policies','family_insurance_policies','auto_insurance_policies','care_log','behavior_logs','vacation_medical_information',
  'guardian_communications','guardian_audit_log','guardian_contacts','guardian_escalations',
  'guardian_member_profiles','guardian_routing_rules','guardian_screening_sessions','guardian_suggestions','family_inbox_messages']);
update g0509_tables g set has_member = exists (select 1 from information_schema.columns c
                                                 where c.table_schema = 'public' and c.table_name = g.t and c.column_name = 'member_id');

-- One generic row: family_id and member_id as given, every other required
-- column without a default filled by its type (or a literal its CHECK names).
create or replace function pg_temp.g0509_seed(t text, fam uuid, member uuid) returns void
language plpgsql as $fn$
declare
  c record; cols text[] := '{}'; vals text[] := '{}'; v text; lit text;
begin
  for c in select a.attname, format_type(a.atttypid, a.atttypmod) as typ, a.atttypid, ty.typtype, a.attnotnull,
                  pg_get_expr(d.adbin, d.adrelid) as def
             from pg_attribute a join pg_type ty on ty.oid = a.atttypid
             left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where a.attrelid = ('public.' || t)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' loop
    if c.attname = 'family_id' then v := quote_literal(fam);
    elsif c.attname = 'member_id' then v := quote_literal(member);
    elsif not c.attnotnull or c.def is not null then continue;
    elsif t = 'pay_handles' and c.attname = 'handle' then v := quote_literal('g0509_' || left(replace(gen_random_uuid()::text, '-', ''), 8));
    else
      select (regexp_match(pg_get_constraintdef(k.oid), '''([^'']*)''::text'))[1] into lit
        from pg_constraint k where k.conrelid = ('public.' || t)::regclass and k.contype = 'c'
         and pg_get_constraintdef(k.oid) ~ ('\m' || c.attname || '\M') limit 1;
      v := case
        when c.typtype = 'e' then quote_literal((select e.enumlabel from pg_enum e where e.enumtypid = c.atttypid order by e.enumsortorder limit 1)) || '::' || c.typ
        when lit is not null then quote_literal(lit)
        when c.typ like '%[]' then '''{}'''
        when c.typ in ('text', 'citext') or c.typ like 'character varying%' then quote_literal('g0509_' || left(md5(random()::text), 10))
        when c.typ in ('integer', 'bigint', 'smallint', 'real', 'double precision') or c.typ like 'numeric%' then '1'
        when c.typ = 'boolean' then 'false'
        when c.typ = 'date' then 'current_date'
        when c.typ like 'timestamp%' then 'now()'
        when c.typ like 'time%' then '''08:00'''
        when c.typ = 'uuid' then 'gen_random_uuid()'
        when c.typ in ('jsonb', 'json') then '''{}'''
        when c.typ = 'interval' then '''1 day'''
        else 'null' end;
    end if;
    cols := cols || quote_ident(c.attname);
    vals := vals || v;
  end loop;
  execute format('insert into public.%I (%s) values (%s)', t, array_to_string(cols, ', '), array_to_string(vals, ', '));
end
$fn$;

-- What one caller reads of one family's rows in one table: rows not about
-- `self` (or all rows, where the table has no member_id) and rows about `self`.
create or replace function pg_temp.g0509_seen(p_role text, p_uid text, t text, fam uuid, self uuid, has_member boolean,
                                                out others int, out own int) returns record
language plpgsql as $fn$
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  perform set_config('request.jwt.claims',
    case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', p_role)::text end, true);
  begin
    if has_member then
      execute format('select count(*) filter (where member_id is distinct from $2), count(*) filter (where member_id = $2) from public.%I where family_id = $1', t)
        into others, own using fam, self;
    else
      execute format('select count(*), 0 from public.%I where family_id = $1', t) into others, own using fam;
    end if;
  exception when others then
    others := -1; own := -1;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end
$fn$;

do $seed$
declare g record;
begin
  set local session_replication_role = replica;
  for g in select * from g0509_tables loop
    perform pg_temp.g0509_seed(g.t, '00000000-0000-4000-8509-0000000000f1', '00000000-0000-4000-8509-0000000000c7');
    if g.has_member then
      perform pg_temp.g0509_seed(g.t, '00000000-0000-4000-8509-0000000000f1', '00000000-0000-4000-8509-0000000000c6');
    end if;
  end loop;
  perform pg_temp.g0509_seed('member_locations', '00000000-0000-4000-8509-0000000000f2', '00000000-0000-4000-8509-0000000000c9');
  set local session_replication_role = origin;
end
$seed$;

create temp table g0509_baseline (t text, who text, others int, own int) on commit drop;

do $$
declare
  f1        constant uuid := '00000000-0000-4000-8509-0000000000f1';
  f2        constant uuid := '00000000-0000-4000-8509-0000000000f2';
  guest_u   constant text := '00000000-0000-4000-8509-0000000000a6';
  guest_m   constant uuid := '00000000-0000-4000-8509-0000000000c6';
  carer_u   constant text := '00000000-0000-4000-8509-0000000000a5';
  carer_m   constant uuid := '00000000-0000-4000-8509-0000000000c5';
  parent_u  constant text := '00000000-0000-4000-8509-0000000000a1';
  rule_m    constant text := '((NOT is_family_guest(family_id)) OR is_self_member(member_id))';
  rule_n    constant text := '(NOT is_family_guest(family_id))';
  -- Tables the released schema already closes to a guest (0481's sweep): 0509
  -- keeps its guard there too, so a permissive read added later cannot reopen
  -- them, and the negative control expects them closed without 0509. Where the
  -- held 0510 is installed, behavior_logs is closed to a guest without 0509 as
  -- well: a note is read by a manager, its author or a caregiver, and no seeded
  -- note is the guest's.
  closed_before text[] := array['care_log', 'expense_split_shares', 'expense_splits', 'family_places',
                                'gift_payments', 'medication_doses', 'member_locations', 'subscriptions_tracked']
                          || case when exists (select 1 from pg_policies p
                                                where p.schemaname = 'public' and p.tablename = 'behavior_logs'
                                                  and p.policyname = 'A note is read by a manager, its author or a caregiver')
                                  then array['behavior_logs'] else '{}'::text[] end;
  installed boolean := to_regprocedure('public.is_family_guest(uuid)') is not null
                       and exists (select 1 from pg_policies p where p.schemaname = 'public'
                                     and p.policyname = 'A guest does not read member_locations');
  failures  text[] := '{}';
  g         record;
  s         record;
  b         record;
  total     int;
  leaks     text[] := '{}';
  bad       text[] := '{}';
  n         int;
begin
  -- 1-2. The guest.
  for g in select * from g0509_tables order by t loop
    s := pg_temp.g0509_seen('authenticated', guest_u, g.t, f1, guest_m, g.has_member);
    insert into g0509_baseline values (g.t, 'guest', s.others, s.own);
    if s.others <> 0 then
      leaks := leaks || format('%s %s', g.t, s.others);
    end if;
    if g.has_member and s.own <> 1 and not (g.t = any (closed_before)) then
      bad := bad || format('%s (%s)', g.t, s.own);
    end if;
  end loop;
  if cardinality(leaks) > 0 then
    failures := failures || format('the guest reads the household''s rows in %s of 59 sensitive tables (%s)',
                                   cardinality(leaks), array_to_string(leaks, ', '));
  end if;
  if cardinality(bad) > 0 then
    failures := failures || format('CONTROL: the guest no longer reads the rows about themselves in %s', array_to_string(bad, ', '));
  end if;

  -- 3. The caregiver and the parent, as they are now.
  for g in select * from g0509_tables loop
    s := pg_temp.g0509_seen('authenticated', carer_u, g.t, f1, carer_m, g.has_member);
    insert into g0509_baseline values (g.t, 'caregiver', s.others, s.own);
    s := pg_temp.g0509_seen('authenticated', parent_u, g.t, f1, null, g.has_member);
    insert into g0509_baseline values (g.t, 'parent', s.others, s.own);
  end loop;
  bad := '{}';
  for g in select * from g0509_tables order by t loop
    total := case when g.has_member then 2 else 1 end;
    select * into b from g0509_baseline where t = g.t and who = 'parent';
    if b.others <> total then
      bad := bad || format('%s (%s of %s)', g.t, b.others, total);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := failures || format('CONTROL: the parent does not read every Guest House row in %s', array_to_string(bad, ', '));
  end if;

  -- 4. The guest is a parent at home.
  s := pg_temp.g0509_seen('authenticated', guest_u, 'member_locations', f2, guest_m, true);
  if s.others <> 1 then
    failures := failures || format('CONTROL: the guest does not read the location row in the household they are a parent of (%s)', s.others);
  end if;

  -- 5. The server.
  bad := '{}';
  for g in select * from g0509_tables order by t loop
    total := case when g.has_member then 2 else 1 end;
    s := pg_temp.g0509_seen('service_role', guest_u, g.t, f1, null, g.has_member);
    if s.others <> total then bad := bad || format('%s with the guest''s id (%s of %s)', g.t, s.others, total); end if;
    s := pg_temp.g0509_seen('service_role', null, g.t, f1, null, g.has_member);
    if s.others <> total then bad := bad || format('%s with no id (%s of %s)', g.t, s.others, total); end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := failures || format('CONTROL: the service role does not read every Guest House row in %s', array_to_string(bad, ', '));
  end if;

  -- 6. Wiring.
  bad := '{}';
  for g in select * from g0509_tables order by t loop
    if not exists (select 1 from pg_policies p
                    where p.schemaname = 'public' and p.tablename = g.t
                      and p.policyname = 'A guest does not read ' || g.t
                      and p.permissive = 'RESTRICTIVE' and p.cmd = 'SELECT'
                      and p.roles = '{authenticated}'::name[]
                      and p.qual = case when g.has_member then rule_m else rule_n end) then
      bad := bad || g.t;
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := failures || format('no guest read guard with 0509''s exact predicate on %s of 59 tables', cardinality(bad));
  end if;
  if not exists (select 1 from pg_proc f
                  where f.oid = to_regprocedure('public.is_family_guest(uuid)')
                    and f.prosecdef
                    and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) then
    failures := failures || 'is_family_guest(uuid) is missing, or not SECURITY DEFINER with a pinned search_path'::text;
  elsif has_function_privilege('public', 'public.is_family_guest(uuid)', 'execute')
     or has_function_privilege('anon', 'public.is_family_guest(uuid)', 'execute') then
    failures := failures || 'PUBLIC or anon may execute is_family_guest(uuid)'::text;
  end if;

  if installed then
    -- 3 (continued) and N1. The 59 policies taken away: the caregiver and the
    -- parent read exactly what they read with them, and the guest reads the
    -- ward's row everywhere.
    begin
      for g in select * from g0509_tables loop
        execute format('drop policy %I on public.%I', 'A guest does not read ' || g.t, g.t);
      end loop;
      bad := '{}';
      leaks := '{}';
      for g in select * from g0509_tables order by t loop
        s := pg_temp.g0509_seen('authenticated', carer_u, g.t, f1, carer_m, g.has_member);
        select * into b from g0509_baseline where t = g.t and who = 'caregiver';
        if s.others <> b.others or s.own <> b.own then
          bad := bad || format('the caregiver in %s (%s/%s with 0509, %s/%s without)', g.t, b.others, b.own, s.others, s.own);
        end if;
        s := pg_temp.g0509_seen('authenticated', parent_u, g.t, f1, null, g.has_member);
        select * into b from g0509_baseline where t = g.t and who = 'parent';
        if s.others <> b.others then
          bad := bad || format('the parent in %s (%s with 0509, %s without)', g.t, b.others, s.others);
        end if;
        s := pg_temp.g0509_seen('authenticated', guest_u, g.t, f1, guest_m, g.has_member);
        -- Without 0509 the guest reads the ward's row wherever the released
        -- schema left it open, and nowhere it had closed it already.
        if (s.others < 1) <> (g.t = any (closed_before)) then
          leaks := leaks || format('%s (%s; %s)', g.t, s.others,
                                   case when g.t = any (closed_before) then 'expected closed before 0509' else 'expected open before 0509' end);
        end if;
        -- And 0509 never takes away a guest's own rows.
        select * into b from g0509_baseline where t = g.t and who = 'guest';
        if s.own <> b.own then
          bad := bad || format('the guest''s own rows in %s (%s with 0509, %s without)', g.t, b.own, s.own);
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := failures || format('CONTROL: 0509 changes what someone other than a guest reads: %s', array_to_string(bad, '; '));
      end if;
      if cardinality(leaks) > 0 then
        failures := failures || format('NEGATIVE CONTROL: with the 59 policies dropped, what the guest reads of the ward is not the released schema''s: %s', array_to_string(leaks, ', '));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. A guest anywhere, not of the row's family.
    begin
      create or replace function public.is_family_guest(p_family_id uuid)
      returns boolean language sql stable security definer set search_path = public, pg_temp as $m1$
        select exists (select 1 from public.family_members
                        where user_id = auth.uid() and role = 'guest' and is_active)
      $m1$;
      s := pg_temp.g0509_seen('authenticated', guest_u, 'member_locations', f2, guest_m, true);
      if s.others <> 0 then
        failures := failures || format('MUTATION CONTROL: with is_family_guest unbound from the row''s family the guest still read their own household''s location row (%s), so 4. cannot catch that rule', s.others);
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a guest reads the household''s most sensitive areas:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-guest-does-not-read-the-households-most-sensitive-areas: OK (in each of the 59 tables the guest read no Guest House row that is not about them, and read the rows about themselves (0509 takes none away); the parent read every Guest House row; with 0509''s 59 policies taken away the caregiver and the parent read exactly what they read with them; the guest read the location row in the household they are a parent of; the service role with and without a user id read every row; 59 guest read guards with 0509''s exact predicate, is_family_guest pinned SECURITY DEFINER and not executable by PUBLIC or anon; negative control: without the 59 policies the guest read the ward''s row in every table the released schema leaves open and in none of the eight it already closes; mutation control: with is_family_guest unbound from the row''s family the guest lost their own household''s row)';
end $$;

rollback;
