-- ── A health record is read by a manager or its own member (0506) ───────────
--
-- symptom_logs, health_metrics, health_goals, health_visits, immunizations,
-- sleep_logs, sleep_checkins and nutrition_logs each read with
-- is_family_member(family_id), so a teen, a child, a caregiver and a guest read
-- every other member's symptoms, measurements, goals, visits, vaccinations,
-- sleep and meals. The held 0506 replaces that read on all eight with: a
-- manager of the row's family, the member the row is about, or its author,
-- all still inside is_family_member(family_id).
--
-- Fixture, Health House: a parent and an adult (managers), a teen (who is also
-- the parent of a household of their own), a child, a caregiver, a guest, a
-- ward with no login, and a caregiver since removed (is_active false). In each
-- table, as the server writes them:
--
--   the ward's record, by the parent           (another member's)
--   each non-manager's own record, by the parent
--   a record about the ward, by the caregiver  (the caregiver's own writing)
--   a record about the ward, by the removed caregiver
--   a record about nobody, by the parent       (where member_id may be null)
--   in the teen's own household: its ward's record, with no author
--
-- What this probe asserts, through PostgREST's role, in every table:
--
--   1. the teen, the child, the caregiver and the guest read no Health House
--      record that is neither about them nor written by them (counted);
--   2. control: each of them reads their own record, and the caregiver the one
--      they wrote about the ward (1 each);
--   3. control: the parent and the adult read every Health House record;
--   4. control: the teen reads the record in the household they manage (1),
--      so 1. is the row's family deciding, not the teen being unable to read;
--   5. the removed caregiver reads nothing, not even the record they wrote,
--      and a stranger in a household of their own reads nothing;
--   6. control: the service role, carrying the child's user id and without
--      one, reads every Health House record;
--   7. control: the writes the screens make still come back to their writer:
--      the child's own symptom (insert … returning, OK 1), the caregiver's meal
--      logged for the ward (OK 1), and the child's second night upserted onto
--      their own (on conflict do update, OK 1);
--   8. wiring: one permissive read policy per table, by 0506's name, granted
--      to authenticated, USING exactly 0506's predicate, and no restrictive
--      read policy;
--
-- and, only where 0506 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with the family-wide read put back on all eight, the
--       child reads the ward's record in each (1): the fixture reaches the
--       limit 0506 closes;
--   M1. MUTATION CONTROL: with 0506's outer is_family_member(family_id) taken
--       off, the removed caregiver reads the record they wrote in each (1), so
--       5. is what catches a rule that forgets a member can leave.
--
-- Everything is rolled back.
--
-- HELD with 0506: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/health-records-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0506 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8506-0000000000a1','h0506-parent@example.com'),
  ('00000000-0000-4000-8506-0000000000a2','h0506-adult@example.com'),
  ('00000000-0000-4000-8506-0000000000a3','h0506-teen@example.com'),
  ('00000000-0000-4000-8506-0000000000a4','h0506-child@example.com'),
  ('00000000-0000-4000-8506-0000000000a5','h0506-caregiver@example.com'),
  ('00000000-0000-4000-8506-0000000000a6','h0506-guest@example.com'),
  ('00000000-0000-4000-8506-0000000000a8','h0506-gone@example.com'),
  ('00000000-0000-4000-8506-0000000000a9','h0506-stranger@example.com')
  on conflict do nothing;
-- on_family_created files each creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8506-0000000000f1','Health House','00000000-0000-4000-8506-0000000000a1'),
  ('00000000-0000-4000-8506-0000000000f2','Teen''s Own House','00000000-0000-4000-8506-0000000000a3'),
  ('00000000-0000-4000-8506-0000000000f3','Next Door','00000000-0000-4000-8506-0000000000a9');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8506-0000000000a1','00000000-0000-4000-8506-0000000000a3','00000000-0000-4000-8506-0000000000a9');
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8506-0000000000c2','00000000-0000-4000-8506-0000000000f1','00000000-0000-4000-8506-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8506-0000000000c3','00000000-0000-4000-8506-0000000000f1','00000000-0000-4000-8506-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8506-0000000000c4','00000000-0000-4000-8506-0000000000f1','00000000-0000-4000-8506-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8506-0000000000c5','00000000-0000-4000-8506-0000000000f1','00000000-0000-4000-8506-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8506-0000000000c6','00000000-0000-4000-8506-0000000000f1','00000000-0000-4000-8506-0000000000a6','Guest','guest',true),
  ('00000000-0000-4000-8506-0000000000c7','00000000-0000-4000-8506-0000000000f1',null,'Ward','child',true),
  ('00000000-0000-4000-8506-0000000000c8','00000000-0000-4000-8506-0000000000f1','00000000-0000-4000-8506-0000000000a8','Caregiver (removed)','caregiver',false),
  ('00000000-0000-4000-8506-0000000000c9','00000000-0000-4000-8506-0000000000f2',null,'Teen''s ward','child',true);

-- One row in one of the eight tables, as the server writes it. `tag` keeps the
-- per-member unique keys (sleep and check-in dates, goal metrics) apart.
create or replace function pg_temp.h0506_put(t text, fam uuid, member uuid, author uuid, tag int) returns uuid
language plpgsql as $fn$
declare id uuid;
begin
  execute case t
    when 'symptom_logs' then
      'insert into public.symptom_logs (family_id, member_id, symptom, severity, created_by) values ($1, $2, ''h0506 '' || $4, 2, $3) returning id'
    when 'health_metrics' then
      'insert into public.health_metrics (family_id, member_id, type, value, created_by) values ($1, $2, ''steps'', $4, $3) returning id'
    when 'health_goals' then
      'insert into public.health_goals (family_id, member_id, metric_type, target, period, created_by) values ($1, $2, ''h0506_'' || $4, 1, ''daily'', $3) returning id'
    when 'health_visits' then
      'insert into public.health_visits (family_id, member_id, title, visit_date, created_by) values ($1, $2, ''h0506 '' || $4, current_date - $4, $3) returning id'
    when 'immunizations' then
      'insert into public.immunizations (family_id, member_id, vaccine, created_by) values ($1, $2, ''h0506 '' || $4, $3) returning id'
    when 'sleep_logs' then
      'insert into public.sleep_logs (family_id, member_id, sleep_date, bedtime, wake_time, duration_min, created_by) values ($1, $2, current_date - $4, now() - interval ''9 hours'', now() - interval ''1 hour'', 480, $3) returning id'
    when 'sleep_checkins' then
      'insert into public.sleep_checkins (family_id, member_id, checkin_date, created_by) values ($1, $2, current_date - $4, $3) returning id'
    when 'nutrition_logs' then
      'insert into public.nutrition_logs (family_id, member_id, item, created_by) values ($1, $2, ''h0506 '' || $4, $3) returning id'
  end
  into id using fam, member, author, tag;
  return id;
end
$fn$;

-- The ids of one family's rows in one table, as one caller sees them; null if
-- the read itself was refused.
create or replace function pg_temp.h0506_seen(p_role text, p_uid text, t text, fam uuid) returns uuid[]
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
create or replace function pg_temp.h0506_as(p_uid text, p_sql text) returns text
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

create temp table h0506_rows (tbl text, kind text, who text, id uuid) on commit drop;

do $$
declare
  f1      constant uuid := '00000000-0000-4000-8506-0000000000f1';
  f2      constant uuid := '00000000-0000-4000-8506-0000000000f2';
  parent  constant uuid := '00000000-0000-4000-8506-0000000000a1';
  carer   constant uuid := '00000000-0000-4000-8506-0000000000a5';
  gone    constant uuid := '00000000-0000-4000-8506-0000000000a8';
  ward    constant uuid := '00000000-0000-4000-8506-0000000000c7';
  ward2   constant uuid := '00000000-0000-4000-8506-0000000000c9';
  t   text;
  x   record;
  tag int := 0;
begin
  foreach t in array array['symptom_logs', 'health_metrics', 'health_goals', 'health_visits',
                           'immunizations', 'sleep_logs', 'sleep_checkins', 'nutrition_logs'] loop
    tag := tag + 1;
    insert into h0506_rows values (t, 'other', null, pg_temp.h0506_put(t, f1, ward, parent, tag));
    for x in select * from (values ('teen', '00000000-0000-4000-8506-0000000000c3'::uuid),
                                   ('child', '00000000-0000-4000-8506-0000000000c4'::uuid),
                                   ('caregiver', '00000000-0000-4000-8506-0000000000c5'::uuid),
                                   ('guest', '00000000-0000-4000-8506-0000000000c6'::uuid)) as v(who, member) loop
      tag := tag + 1;
      insert into h0506_rows values (t, 'own', x.who, pg_temp.h0506_put(t, f1, x.member, parent, tag));
    end loop;
    tag := tag + 1;
    insert into h0506_rows values (t, 'authored', 'caregiver', pg_temp.h0506_put(t, f1, ward, carer, tag));
    tag := tag + 1;
    insert into h0506_rows values (t, 'gone', null, pg_temp.h0506_put(t, f1, ward, gone, tag));
    if t in ('health_visits', 'immunizations', 'nutrition_logs') then
      tag := tag + 1;
      insert into h0506_rows values (t, 'nobody', null, pg_temp.h0506_put(t, f1, null, parent, tag));
    end if;
    tag := tag + 1;
    insert into h0506_rows values (t, 'elsewhere', null, pg_temp.h0506_put(t, f2, ward2, null, tag));
  end loop;
end $$;

do $$
declare
  f1        constant uuid := '00000000-0000-4000-8506-0000000000f1';
  f2        constant uuid := '00000000-0000-4000-8506-0000000000f2';
  child     constant text := '00000000-0000-4000-8506-0000000000a4';
  carer     constant text := '00000000-0000-4000-8506-0000000000a5';
  gone      constant text := '00000000-0000-4000-8506-0000000000a8';
  tables    constant text[] := array['symptom_logs', 'health_metrics', 'health_goals', 'health_visits',
                                     'immunizations', 'sleep_logs', 'sleep_checkins', 'nutrition_logs'];
  rule      constant text := '(is_family_member(family_id) AND (can_manage_family(family_id) OR is_self_member(member_id) OR (created_by = auth.uid())))';
  installed boolean := exists (select 1 from pg_policies p where p.schemaname = 'public'
                                 and p.tablename = 'symptom_logs' and p.policyname = 'Members read their own symptom_logs');
  failures  text[] := '{}';
  x         record;
  t         text;
  seen      uuid[];
  mine      uuid[];
  everyone  uuid[];
  leaks     text[];
  bad       text[];
  n         int;
  got       text;
begin
  -- 1-2. The non-managers.
  for x in select * from (values ('teen',      '00000000-0000-4000-8506-0000000000a3'),
                                 ('child',     '00000000-0000-4000-8506-0000000000a4'),
                                 ('caregiver', '00000000-0000-4000-8506-0000000000a5'),
                                 ('guest',     '00000000-0000-4000-8506-0000000000a6')) as v(who, uid) loop
    leaks := '{}';
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.h0506_seen('authenticated', x.uid, t, f1);
      select coalesce(array_agg(r.id), '{}') into mine from h0506_rows r
       where r.tbl = t and r.who = x.who and r.kind in ('own', 'authored');
      if seen is null then
        bad := array_append(bad, format('%s (the read was refused)', t));
        continue;
      end if;
      select count(*) into n from unnest(seen) s(id) where s.id <> all (mine);
      if n <> 0 then
        leaks := array_append(leaks, format('%s %s', t, n));
      end if;
      select count(*) into n from unnest(mine) m(id) where m.id = any (seen);
      if n <> cardinality(mine) then
        bad := array_append(bad, format('%s (%s of %s)', t, n, cardinality(mine)));
      end if;
    end loop;
    if cardinality(leaks) > 0 then
      failures := array_append(failures, format('the %s reads records about other members in %s of 8 health tables (%s)',
                                                x.who, cardinality(leaks), array_to_string(leaks, ', ')));
    end if;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: the %s no longer reads their own record%s in %s', x.who,
                                                case when x.who = 'caregiver' then ' or what they wrote' else '' end,
                                                array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 3. The managers, and 6. the service role with and without a user id.
  for x in select * from (values ('the parent', 'authenticated', '00000000-0000-4000-8506-0000000000a1'),
                                 ('the adult', 'authenticated', '00000000-0000-4000-8506-0000000000a2'),
                                 ('the service role (with the child''s user id)', 'service_role', child),
                                 ('the service role (no user id)', 'service_role', null)) as v(who, role, uid) loop
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.h0506_seen(x.role, x.uid, t, f1);
      select coalesce(array_agg(r.id), '{}') into everyone from h0506_rows r where r.tbl = t and r.kind <> 'elsewhere';
      if seen is null or not (seen @> everyone and everyone @> seen) then
        bad := array_append(bad, format('%s (%s of %s)', t, coalesce(cardinality(seen)::text, 'refused'), cardinality(everyone)));
      end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: %s does not read every Health House record in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 4. The teen manages a household of their own.
  bad := '{}';
  foreach t in array tables loop
    seen := pg_temp.h0506_seen('authenticated', '00000000-0000-4000-8506-0000000000a3', t, f2);
    if coalesce(cardinality(seen), -1) <> 1 then
      bad := array_append(bad, format('%s (%s)', t, coalesce(cardinality(seen)::text, 'refused')));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('CONTROL: the teen does not read the record in the household they manage in %s', array_to_string(bad, ', ')));
  end if;

  -- 5. The removed caregiver and the stranger.
  for x in select * from (values ('the removed caregiver', gone),
                                 ('a stranger', '00000000-0000-4000-8506-0000000000a9')) as v(who, uid) loop
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.h0506_seen('authenticated', x.uid, t, f1);
      if coalesce(cardinality(seen), 0) <> 0 then
        bad := array_append(bad, format('%s %s', t, cardinality(seen)));
      end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('%s reads Health House records in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 7. The screens' writes come back to their writer.
  got := pg_temp.h0506_as(child, format(
    'insert into public.symptom_logs (family_id, member_id, symptom, severity, created_by) values (%L, %L, %L, 2, %L) returning id',
    f1, '00000000-0000-4000-8506-0000000000c4', 'h0506 own cough', child));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the child''s own symptom, inserted with returning, did not come back (%s)', got));
  end if;
  got := pg_temp.h0506_as(carer, format(
    'insert into public.nutrition_logs (family_id, member_id, item, created_by) values (%L, %L, %L, %L) returning id',
    f1, '00000000-0000-4000-8506-0000000000c7', 'h0506 ward''s lunch', carer));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the caregiver''s meal for the ward, inserted with returning, did not come back (%s)', got));
  end if;
  select format(
    'insert into public.sleep_logs (family_id, member_id, sleep_date, bedtime, wake_time, duration_min, created_by) '
    || 'values (%L, %L, %L, now() - interval ''8 hours'', now(), 420, %L) '
    || 'on conflict (member_id, sleep_date) do update set duration_min = excluded.duration_min, created_by = excluded.created_by',
    f1, s.member_id, s.sleep_date, child)
    into got
    from public.sleep_logs s
    join h0506_rows r on r.id = s.id and r.tbl = 'sleep_logs' and r.kind = 'own' and r.who = 'child';
  got := pg_temp.h0506_as(child, got);
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the child''s night, upserted onto their own, was refused (%s)', got));
  end if;

  -- 8. Wiring.
  bad := '{}';
  foreach t in array tables loop
    select count(*) into n from pg_policies p
     where p.schemaname = 'public' and p.tablename = t and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL');
    if n <> 1 or not exists (select 1 from pg_policies p
                              where p.schemaname = 'public' and p.tablename = t
                                and p.policyname = 'Members read their own ' || t
                                and p.permissive = 'PERMISSIVE' and p.cmd = 'SELECT'
                                and p.roles::text[] = array['authenticated']
                                and replace(p.qual, 'public.', '') = rule) then
      bad := array_append(bad, format('%s (%s permissive read polic(ies): %s)', t, n,
        (select string_agg(p.policyname || ' USING ' || replace(p.qual, 'public.', ''), '; ')
           from pg_policies p
          where p.schemaname = 'public' and p.tablename = t and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL'))));
    end if;
    if exists (select 1 from pg_policies p
                where p.schemaname = 'public' and p.tablename = t and p.permissive = 'RESTRICTIVE' and p.cmd in ('SELECT', 'ALL')) then
      bad := array_append(bad, format('%s (a restrictive read policy)', t));
    end if;
    if not exists (select 1 from pg_class c where c.oid = ('public.' || t)::regclass and c.relrowsecurity) then
      bad := array_append(bad, format('%s (row security off)', t));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('the read is not 0506''s on %s', array_to_string(bad, ' | ')));
  end if;

  if installed then
    -- N1. The family-wide read put back.
    begin
      foreach t in array tables loop
        execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_read', t);
      end loop;
      bad := '{}';
      foreach t in array tables loop
        seen := pg_temp.h0506_seen('authenticated', child, t, f1);
        select count(*) into n from unnest(seen) s(id) join h0506_rows r on r.id = s.id and r.kind = 'other';
        if n <> 1 then
          bad := array_append(bad, format('%s %s', t, n));
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the family-wide read put back the child did not read the ward''s record (%s), so this fixture cannot see the limit', array_to_string(bad, ', ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The outer is_family_member taken off.
    begin
      foreach t in array tables loop
        execute format('drop policy %I on public.%I', 'Members read their own ' || t, t);
        execute format('create policy %I on public.%I for select to authenticated using ('
                       || 'public.can_manage_family(family_id) or public.is_self_member(member_id) or created_by = auth.uid())',
                       'Members read their own ' || t, t);
      end loop;
      bad := '{}';
      foreach t in array tables loop
        seen := pg_temp.h0506_seen('authenticated', gone, t, f1);
        select count(*) into n from unnest(seen) s(id) join h0506_rows r on r.id = s.id and r.kind = 'gone';
        if n <> 1 then
          bad := array_append(bad, format('%s %s', t, n));
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('MUTATION CONTROL: without the outer is_family_member the removed caregiver did not read what they wrote (%s), so 5. cannot catch that rule', array_to_string(bad, ', ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a health record is read beyond its manager and its own member:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-health-record-is-read-by-a-manager-or-its-own-member: OK (in each of the eight health tables the teen, the child, the caregiver and the guest read no record about another member (counted) and each reads their own, the caregiver also what they wrote about the ward; the parent and the adult read every record; the teen reads the record in the household they manage; the removed caregiver and a stranger read nothing; the service role with and without a user id reads every record; the child''s own symptom and the caregiver''s meal for the ward come back from insert … returning (OK 1) and the child''s night upserts onto their own (OK 1); one permissive read policy per table, USING exactly 0506''s predicate, no restrictive read; negative control: with the family-wide read put back the child read the ward''s record in all eight; mutation control: without the outer is_family_member the removed caregiver read what they wrote in all eight)';
end $$;

rollback;
