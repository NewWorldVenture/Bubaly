-- ── Location history is read by managers, the member and caregivers (0516) ───
--
-- location_events, safety_check_ins and driving_trips read with
-- is_family_member(family_id), so a teen or a child reads every other
-- member's arrivals and departures, check-ins with coordinates, and driving
-- trips. The held 0516 replaces each read with: a manager of the row's family,
-- the member the row is about, or a caregiver, all inside
-- is_family_member(family_id).
--
-- Fixture, Trail House: a parent and an adult (managers), a teen (who is also
-- the parent of a household of their own), a child, a caregiver, a guest, a
-- ward with no login, and a caregiver since removed (is_active false). In each
-- table, written as the table owner: a row about the ward, the parent, the
-- teen, the child, the caregiver and the guest; where member_id may be null,
-- a row about nobody; and in the teen's own household, a row about its ward.
--
-- What this probe asserts, through PostgREST's role, in each table:
--
--   1. the teen, the child and the guest read their own row and no other
--      (counted);
--   2. control: the parent, the adult and the caregiver read every Trail House
--      row;
--   3. control: the teen reads the row in the household they manage (1);
--   4. the removed caregiver and a stranger read nothing;
--   5. control: the service role, carrying the child's user id and without
--      one, reads every Trail House row;
--   6. control: the writes the screens make come back to their writer: the
--      child's own arrival, the child's own check-in and the teen's own trip
--      (insert … returning, OK 1 each);
--   7. wiring: one permissive read policy per table, by 0516's name, granted
--      to authenticated, USING exactly 0516's predicate; the only restrictive
--      read is a guest's (the held 0509's);
--
-- and, only where 0516 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with the family-wide read put back, the child reads
--       the ward's row in each (1): the fixture reaches the limit;
--   M1. MUTATION CONTROL: with 0516's outer is_family_member(family_id) taken
--       off, the removed caregiver reads the ward's row in each (1), so 4.
--       catches a rule that forgets a member can leave.
--
-- Everything is rolled back.
--
-- HELD with 0516: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/location-history-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0516 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8516-0000000000a1','l0516-parent@example.com'),
  ('00000000-0000-4000-8516-0000000000a2','l0516-adult@example.com'),
  ('00000000-0000-4000-8516-0000000000a3','l0516-teen@example.com'),
  ('00000000-0000-4000-8516-0000000000a4','l0516-child@example.com'),
  ('00000000-0000-4000-8516-0000000000a5','l0516-caregiver@example.com'),
  ('00000000-0000-4000-8516-0000000000a6','l0516-guest@example.com'),
  ('00000000-0000-4000-8516-0000000000a8','l0516-gone@example.com'),
  ('00000000-0000-4000-8516-0000000000a9','l0516-stranger@example.com')
  on conflict do nothing;
-- on_family_created files each creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8516-0000000000f1','Trail House','00000000-0000-4000-8516-0000000000a1'),
  ('00000000-0000-4000-8516-0000000000f2','Teen''s Own House','00000000-0000-4000-8516-0000000000a3'),
  ('00000000-0000-4000-8516-0000000000f3','Next Door','00000000-0000-4000-8516-0000000000a9');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8516-0000000000a1','00000000-0000-4000-8516-0000000000a3','00000000-0000-4000-8516-0000000000a9');
update public.family_members set id = '00000000-0000-4000-8516-0000000000c1'
 where family_id = '00000000-0000-4000-8516-0000000000f1' and user_id = '00000000-0000-4000-8516-0000000000a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8516-0000000000c2','00000000-0000-4000-8516-0000000000f1','00000000-0000-4000-8516-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8516-0000000000c3','00000000-0000-4000-8516-0000000000f1','00000000-0000-4000-8516-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8516-0000000000c4','00000000-0000-4000-8516-0000000000f1','00000000-0000-4000-8516-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8516-0000000000c5','00000000-0000-4000-8516-0000000000f1','00000000-0000-4000-8516-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8516-0000000000c6','00000000-0000-4000-8516-0000000000f1','00000000-0000-4000-8516-0000000000a6','Guest','guest',true),
  ('00000000-0000-4000-8516-0000000000c7','00000000-0000-4000-8516-0000000000f1',null,'Ward','child',true),
  ('00000000-0000-4000-8516-0000000000c8','00000000-0000-4000-8516-0000000000f1','00000000-0000-4000-8516-0000000000a8','Caregiver (removed)','caregiver',false),
  ('00000000-0000-4000-8516-0000000000c9','00000000-0000-4000-8516-0000000000f2',null,'Teen''s ward','child',true);

-- One row in one of the three tables, as the server writes it.
create or replace function pg_temp.l0516_put(t text, fam uuid, member uuid) returns uuid
language plpgsql as $fn$
declare id uuid;
begin
  execute case t
    when 'location_events' then
      'insert into public.location_events (family_id, member_id, place_name, event_type) values ($1, $2, ''l0516 place'', ''arrived'') returning id'
    when 'safety_check_ins' then
      'insert into public.safety_check_ins (family_id, member_id, status, place_label) values ($1, $2, ''safe'', ''l0516 place'') returning id'
    when 'driving_trips' then
      'insert into public.driving_trips (family_id, member_id, label, distance_miles, score) values ($1, $2, ''l0516 trip'', 3, 90) returning id'
  end
  into id using fam, member;
  return id;
end
$fn$;

-- The ids of one family's rows in one table, as one caller sees them; null if
-- the read itself was refused.
create or replace function pg_temp.l0516_seen(p_role text, p_uid text, t text, fam uuid) returns uuid[]
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
create or replace function pg_temp.l0516_as(p_uid text, p_sql text) returns text
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

create temp table l0516_rows (tbl text, who text, id uuid) on commit drop;

do $$
declare
  f1 constant uuid := '00000000-0000-4000-8516-0000000000f1';
  f2 constant uuid := '00000000-0000-4000-8516-0000000000f2';
  t  text;
  x  record;
begin
  foreach t in array array['location_events', 'safety_check_ins', 'driving_trips'] loop
    for x in select * from (values ('ward', '00000000-0000-4000-8516-0000000000c7'::uuid),
                                   ('parent', '00000000-0000-4000-8516-0000000000c1'::uuid),
                                   ('teen', '00000000-0000-4000-8516-0000000000c3'::uuid),
                                   ('child', '00000000-0000-4000-8516-0000000000c4'::uuid),
                                   ('caregiver', '00000000-0000-4000-8516-0000000000c5'::uuid),
                                   ('guest', '00000000-0000-4000-8516-0000000000c6'::uuid)) as v(who, member) loop
      insert into l0516_rows values (t, x.who, pg_temp.l0516_put(t, f1, x.member));
    end loop;
    if t <> 'location_events' then
      insert into l0516_rows values (t, 'nobody', pg_temp.l0516_put(t, f1, null));
    end if;
    insert into l0516_rows values (t, 'elsewhere', pg_temp.l0516_put(t, f2, '00000000-0000-4000-8516-0000000000c9'));
  end loop;
end $$;

do $$
declare
  f1        constant uuid := '00000000-0000-4000-8516-0000000000f1';
  f2        constant uuid := '00000000-0000-4000-8516-0000000000f2';
  child     constant text := '00000000-0000-4000-8516-0000000000a4';
  gone      constant text := '00000000-0000-4000-8516-0000000000a8';
  tables    constant text[] := array['location_events', 'safety_check_ins', 'driving_trips'];
  policy    constant text := 'History is read by a manager, the member or a caregiver';
  rule      constant text := '(is_family_member(family_id) AND (can_manage_family(family_id) OR is_self_member(member_id) OR (family_role(family_id) = ''caregiver''::member_role)))';
  installed boolean := exists (select 1 from pg_policies p where p.schemaname = 'public'
                                 and p.tablename = 'location_events' and p.policyname = 'History is read by a manager, the member or a caregiver');
  failures  text[] := '{}';
  x         record;
  t         text;
  seen      uuid[];
  mine      uuid;
  everyone  uuid[];
  leaks     text[];
  bad       text[];
  n         int;
  got       text;
begin
  -- 1. The teen, the child and the guest.
  for x in select * from (values ('teen',  '00000000-0000-4000-8516-0000000000a3'),
                                 ('child', '00000000-0000-4000-8516-0000000000a4'),
                                 ('guest', '00000000-0000-4000-8516-0000000000a6')) as v(who, uid) loop
    leaks := '{}';
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.l0516_seen('authenticated', x.uid, t, f1);
      select id into mine from l0516_rows where tbl = t and who = x.who;
      if seen is null then
        bad := array_append(bad, format('%s (the read was refused)', t));
        continue;
      end if;
      select count(*) into n from unnest(seen) s(id) where s.id <> mine;
      if n <> 0 then
        leaks := array_append(leaks, format('%s %s', t, n));
      end if;
      if not mine = any (seen) then
        bad := array_append(bad, t);
      end if;
    end loop;
    if cardinality(leaks) > 0 then
      failures := array_append(failures, format('the %s reads other members'' history in %s of 3 tables (%s)',
                                                x.who, cardinality(leaks), array_to_string(leaks, ', ')));
    end if;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: the %s no longer reads their own row in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 2. The managers and the caregiver, and 5. the service role with and without a user id.
  for x in select * from (values ('the parent', 'authenticated', '00000000-0000-4000-8516-0000000000a1'),
                                 ('the adult', 'authenticated', '00000000-0000-4000-8516-0000000000a2'),
                                 ('the caregiver', 'authenticated', '00000000-0000-4000-8516-0000000000a5'),
                                 ('the service role (with the child''s user id)', 'service_role', child),
                                 ('the service role (no user id)', 'service_role', null)) as v(who, role, uid) loop
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.l0516_seen(x.role, x.uid, t, f1);
      select coalesce(array_agg(r.id), '{}') into everyone from l0516_rows r where r.tbl = t and r.who <> 'elsewhere';
      if seen is null or not (seen @> everyone and everyone @> seen) then
        bad := array_append(bad, format('%s (%s of %s)', t, coalesce(cardinality(seen)::text, 'refused'), cardinality(everyone)));
      end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: %s does not read every Trail House row in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 3. The teen manages a household of their own.
  bad := '{}';
  foreach t in array tables loop
    seen := pg_temp.l0516_seen('authenticated', '00000000-0000-4000-8516-0000000000a3', t, f2);
    if coalesce(cardinality(seen), -1) <> 1 then
      bad := array_append(bad, format('%s (%s)', t, coalesce(cardinality(seen)::text, 'refused')));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('CONTROL: the teen does not read the row in the household they manage in %s', array_to_string(bad, ', ')));
  end if;

  -- 4. The removed caregiver and the stranger.
  for x in select * from (values ('the removed caregiver', gone),
                                 ('a stranger', '00000000-0000-4000-8516-0000000000a9')) as v(who, uid) loop
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.l0516_seen('authenticated', x.uid, t, f1);
      if coalesce(cardinality(seen), 0) <> 0 then
        bad := array_append(bad, format('%s %s', t, cardinality(seen)));
      end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('%s reads Trail House history in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 6. The screens' writes come back to their writer.
  for x in select * from (values
      ('the child''s own arrival', child, format('insert into public.location_events (family_id, member_id, place_name, event_type) values (%L, %L, %L, %L) returning id',
                                                  f1, '00000000-0000-4000-8516-0000000000c4', 'l0516 school', 'arrived')),
      ('the child''s own check-in', child, format('insert into public.safety_check_ins (family_id, member_id, status, created_by) values (%L, %L, %L, %L) returning id',
                                                  f1, '00000000-0000-4000-8516-0000000000c4', 'safe', child)),
      ('the teen''s own trip', '00000000-0000-4000-8516-0000000000a3',
                               format('insert into public.driving_trips (family_id, member_id, label, created_by) values (%L, %L, %L, %L) returning id',
                                      f1, '00000000-0000-4000-8516-0000000000c3', 'l0516 drive', '00000000-0000-4000-8516-0000000000a3'))) as v(what, uid, q) loop
    got := pg_temp.l0516_as(x.uid, x.q);
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
                                and replace(p.qual, 'public.', '') = rule) then
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
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('the read is not 0516''s on %s', array_to_string(bad, ' | ')));
  end if;

  if installed then
    -- N1. The family-wide read put back.
    begin
      foreach t in array tables loop
        execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_n1_read', t);
      end loop;
      bad := '{}';
      foreach t in array tables loop
        seen := pg_temp.l0516_seen('authenticated', child, t, f1);
        if not (select id from l0516_rows where tbl = t and who = 'ward') = any (coalesce(seen, '{}')) then
          bad := array_append(bad, t);
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the family-wide read put back the child did not read the ward''s row in %s, so this fixture cannot see the limit', array_to_string(bad, ', ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The outer is_family_member taken off.
    begin
      foreach t in array tables loop
        execute format('drop policy %I on public.%I', policy, t);
        execute format('create policy %I on public.%I for select to authenticated using ('
                       || 'public.can_manage_family(family_id) or public.is_self_member(member_id) or public.family_role(family_id) = ''caregiver'')',
                       policy, t);
      end loop;
      bad := '{}';
      foreach t in array tables loop
        seen := pg_temp.l0516_seen('authenticated', gone, t, f1);
        if not (select id from l0516_rows where tbl = t and who = 'ward') = any (coalesce(seen, '{}')) then
          bad := array_append(bad, t);
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('MUTATION CONTROL: without the outer is_family_member the removed caregiver did not read the ward''s row in %s, so 4. cannot catch that rule', array_to_string(bad, ', ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'location history is read beyond its managers, its member and a caregiver:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'location-history-is-read-by-managers-the-member-and-caregivers: OK (in location_events, safety_check_ins and driving_trips the teen, the child and the guest read their own row and no other (counted); the parent, the adult and the caregiver read every row; the teen reads the household they manage; the removed caregiver and a stranger read nothing; the service role with and without a user id reads every row; the child''s own arrival and check-in and the teen''s own trip come back from insert … returning (OK 1); one permissive read per table, USING exactly 0516''s predicate, no restrictive read but a guest''s; negative control: with the family-wide read put back the child reads the ward''s row in all three; mutation control: without the outer is_family_member the removed caregiver reads the ward''s row in all three)';
end $$;

rollback;
