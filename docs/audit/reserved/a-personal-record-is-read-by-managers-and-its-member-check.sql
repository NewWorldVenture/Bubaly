-- ── A personal record is read by managers and its member (0517) ──────────────
--
-- insurance_policies, family_insurance_policies, vacation_documents,
-- voice_commands, vacation_medical_information and health_providers read with
-- is_family_member(family_id), so a teen or a child reads every other
-- member's policy numbers, passport details, verbatim voice commands, travel
-- medical detail and doctors. The held 0517 replaces each read with: a
-- manager of the row's family or the member it is about, inside
-- is_family_member(family_id); for the two medical tables a caregiver too.
--
-- Fixture, Paper House: a parent and an adult (managers), a teen (who is also
-- the parent of a household of their own), a child, a caregiver, a guest, a
-- ward with no login, and a caregiver since removed (is_active false). In each
-- table, written as the table owner: a row about the ward, the parent, the
-- teen, the child, the caregiver and the guest; a row about nobody; and in the
-- teen's own household, a row about its ward.
--
-- What this probe asserts, through PostgREST's role, in each table:
--
--   1. the teen, the child and the guest read their own row and no other
--      (counted);
--   2. the caregiver reads their own row and no other in the four personal
--      tables, and every row in the two medical ones;
--   3. control: the parent and the adult read every Paper House row;
--   4. control: the teen reads the row in the household they manage (1);
--   5. the removed caregiver and a stranger read nothing;
--   6. control: the service role, carrying the child's user id and without
--      one, reads every Paper House row;
--   7. control: the writes the screens make come back to their writer: the
--      child's own travel document and travel medical detail, and their own
--      voice command (insert … returning, OK 1 each); a member still updates
--      and deletes their own travel document (OK 1 each);
--   8. wiring: one permissive read policy per table, by 0517's name, granted
--      to authenticated, USING exactly 0517's predicate; the two travel
--      tables keep a member-wide insert, update and delete; the only
--      restrictive read is a guest's (the held 0509's);
--
-- and, only where 0517 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with the family-wide read put back, the child reads
--       the ward's row in each (1): the fixture reaches the limit;
--   M1. MUTATION CONTROL: with the caregiver clause added to a personal table
--       (voice_commands), the caregiver reads the ward's command (1), so 2.
--       is what catches a rule wider than the owner's.
--
-- Everything is rolled back.
--
-- HELD with 0517: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/personal-records-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0517 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8517-0000000000a1','p0517-parent@example.com'),
  ('00000000-0000-4000-8517-0000000000a2','p0517-adult@example.com'),
  ('00000000-0000-4000-8517-0000000000a3','p0517-teen@example.com'),
  ('00000000-0000-4000-8517-0000000000a4','p0517-child@example.com'),
  ('00000000-0000-4000-8517-0000000000a5','p0517-caregiver@example.com'),
  ('00000000-0000-4000-8517-0000000000a6','p0517-guest@example.com'),
  ('00000000-0000-4000-8517-0000000000a8','p0517-gone@example.com'),
  ('00000000-0000-4000-8517-0000000000a9','p0517-stranger@example.com')
  on conflict do nothing;
-- on_family_created files each creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8517-0000000000f1','Paper House','00000000-0000-4000-8517-0000000000a1'),
  ('00000000-0000-4000-8517-0000000000f2','Teen''s Own House','00000000-0000-4000-8517-0000000000a3'),
  ('00000000-0000-4000-8517-0000000000f3','Next Door','00000000-0000-4000-8517-0000000000a9');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8517-0000000000a1','00000000-0000-4000-8517-0000000000a3','00000000-0000-4000-8517-0000000000a9');
update public.family_members set id = '00000000-0000-4000-8517-0000000000c1'
 where family_id = '00000000-0000-4000-8517-0000000000f1' and user_id = '00000000-0000-4000-8517-0000000000a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8517-0000000000c2','00000000-0000-4000-8517-0000000000f1','00000000-0000-4000-8517-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8517-0000000000c3','00000000-0000-4000-8517-0000000000f1','00000000-0000-4000-8517-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8517-0000000000c4','00000000-0000-4000-8517-0000000000f1','00000000-0000-4000-8517-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8517-0000000000c5','00000000-0000-4000-8517-0000000000f1','00000000-0000-4000-8517-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8517-0000000000c6','00000000-0000-4000-8517-0000000000f1','00000000-0000-4000-8517-0000000000a6','Guest','guest',true),
  ('00000000-0000-4000-8517-0000000000c7','00000000-0000-4000-8517-0000000000f1',null,'Ward','child',true),
  ('00000000-0000-4000-8517-0000000000c8','00000000-0000-4000-8517-0000000000f1','00000000-0000-4000-8517-0000000000a8','Caregiver (removed)','caregiver',false),
  ('00000000-0000-4000-8517-0000000000c9','00000000-0000-4000-8517-0000000000f2',null,'Teen''s ward','child',true);
insert into public.vacations (id, family_id, title) values
  ('00000000-0000-4000-8517-0000000000e1','00000000-0000-4000-8517-0000000000f1','Paper trip'),
  ('00000000-0000-4000-8517-0000000000e2','00000000-0000-4000-8517-0000000000f2','Teen''s trip');

-- One row in one of the six tables, as the server writes it.
create or replace function pg_temp.p0517_put(t text, fam uuid, member uuid) returns uuid
language plpgsql as $fn$
declare id uuid; trip uuid;
begin
  trip := case fam when '00000000-0000-4000-8517-0000000000f1' then '00000000-0000-4000-8517-0000000000e1'::uuid
                   else '00000000-0000-4000-8517-0000000000e2'::uuid end;
  execute case t
    when 'insurance_policies' then
      'insert into public.insurance_policies (family_id, member_id, insurer, policy_number) values ($1, $2, ''p0517 insurer'', ''P-1'') returning id'
    when 'family_insurance_policies' then
      'insert into public.family_insurance_policies (family_id, member_id, insurer, policy_number) values ($1, $2, ''p0517 insurer'', ''F-1'') returning id'
    when 'vacation_documents' then
      'insert into public.vacation_documents (family_id, vacation_id, member_id, title) values ($1, $3, $2, ''p0517 passport'') returning id'
    when 'voice_commands' then
      'insert into public.voice_commands (family_id, member_id, transcript) values ($1, $2, ''p0517 the garage code is 1234'') returning id'
    when 'vacation_medical_information' then
      'insert into public.vacation_medical_information (family_id, vacation_id, member_id, allergies) values ($1, $3, $2, ''p0517 peanuts'') returning id'
    when 'health_providers' then
      'insert into public.health_providers (family_id, member_id, name) values ($1, $2, ''p0517 Dr Ada'') returning id'
  end
  into id using fam, member, trip;
  return id;
end
$fn$;

-- The ids of one family's rows in one table, as one caller sees them; null if
-- the read itself was refused.
create or replace function pg_temp.p0517_seen(p_role text, p_uid text, t text, fam uuid) returns uuid[]
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
create or replace function pg_temp.p0517_as(p_uid text, p_sql text) returns text
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

create temp table p0517_rows (tbl text, who text, id uuid) on commit drop;

do $$
declare
  f1 constant uuid := '00000000-0000-4000-8517-0000000000f1';
  f2 constant uuid := '00000000-0000-4000-8517-0000000000f2';
  t  text;
  x  record;
begin
  foreach t in array array['insurance_policies', 'family_insurance_policies', 'vacation_documents', 'voice_commands',
                           'vacation_medical_information', 'health_providers'] loop
    for x in select * from (values ('ward', '00000000-0000-4000-8517-0000000000c7'::uuid),
                                   ('parent', '00000000-0000-4000-8517-0000000000c1'::uuid),
                                   ('teen', '00000000-0000-4000-8517-0000000000c3'::uuid),
                                   ('child', '00000000-0000-4000-8517-0000000000c4'::uuid),
                                   ('caregiver', '00000000-0000-4000-8517-0000000000c5'::uuid),
                                   ('guest', '00000000-0000-4000-8517-0000000000c6'::uuid),
                                   ('nobody', null::uuid)) as v(who, member) loop
      insert into p0517_rows values (t, x.who, pg_temp.p0517_put(t, f1, x.member));
    end loop;
    insert into p0517_rows values (t, 'elsewhere', pg_temp.p0517_put(t, f2, '00000000-0000-4000-8517-0000000000c9'));
  end loop;
end $$;

do $$
declare
  f1        constant uuid := '00000000-0000-4000-8517-0000000000f1';
  f2        constant uuid := '00000000-0000-4000-8517-0000000000f2';
  child     constant text := '00000000-0000-4000-8517-0000000000a4';
  carer     constant text := '00000000-0000-4000-8517-0000000000a5';
  gone      constant text := '00000000-0000-4000-8517-0000000000a8';
  personal  constant text[] := array['insurance_policies', 'family_insurance_policies', 'vacation_documents', 'voice_commands'];
  medical   constant text[] := array['vacation_medical_information', 'health_providers'];
  tables    constant text[] := array['insurance_policies', 'family_insurance_policies', 'vacation_documents', 'voice_commands',
                                     'vacation_medical_information', 'health_providers'];
  policy    constant text := 'A personal record is read by a manager or its member';
  rule_p    constant text := '(is_family_member(family_id) AND (can_manage_family(family_id) OR is_self_member(member_id)))';
  rule_m    constant text := '(is_family_member(family_id) AND (can_manage_family(family_id) OR is_self_member(member_id) OR (family_role(family_id) = ''caregiver''::member_role)))';
  installed boolean := exists (select 1 from pg_policies p where p.schemaname = 'public'
                                 and p.tablename = 'voice_commands' and p.policyname = 'A personal record is read by a manager or its member');
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
  q         text;
begin
  -- 1-2. The teen, the child, the guest, and the caregiver on the personal tables.
  for x in select * from (values ('teen', '00000000-0000-4000-8517-0000000000a3', false),
                                 ('child', '00000000-0000-4000-8517-0000000000a4', false),
                                 ('guest', '00000000-0000-4000-8517-0000000000a6', false),
                                 ('caregiver', carer, true)) as v(who, uid, personal_only) loop
    leaks := '{}';
    bad := '{}';
    foreach t in array (case when x.personal_only then personal else tables end) loop
      seen := pg_temp.p0517_seen('authenticated', x.uid, t, f1);
      select id into mine from p0517_rows where tbl = t and who = x.who;
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
      failures := array_append(failures, format('the %s reads other members'' personal records in %s of %s tables (%s)',
                                                x.who, cardinality(leaks), case when x.personal_only then 4 else 6 end, array_to_string(leaks, ', ')));
    end if;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: the %s no longer reads their own row in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 3. The managers, 2. the caregiver on the medical tables, and 6. the service role.
  for x in select * from (values ('the parent', 'authenticated', '00000000-0000-4000-8517-0000000000a1', 'all'),
                                 ('the adult', 'authenticated', '00000000-0000-4000-8517-0000000000a2', 'all'),
                                 ('the caregiver', 'authenticated', carer, 'medical'),
                                 ('the service role (with the child''s user id)', 'service_role', child, 'all'),
                                 ('the service role (no user id)', 'service_role', null, 'all')) as v(who, role, uid, which) loop
    bad := '{}';
    foreach t in array (case when x.which = 'medical' then medical else tables end) loop
      seen := pg_temp.p0517_seen(x.role, x.uid, t, f1);
      select coalesce(array_agg(r.id), '{}') into everyone from p0517_rows r where r.tbl = t and r.who <> 'elsewhere';
      if seen is null or not (seen @> everyone and everyone @> seen) then
        bad := array_append(bad, format('%s (%s of %s)', t, coalesce(cardinality(seen)::text, 'refused'), cardinality(everyone)));
      end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: %s does not read every Paper House row in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 4. The teen manages a household of their own.
  bad := '{}';
  foreach t in array tables loop
    seen := pg_temp.p0517_seen('authenticated', '00000000-0000-4000-8517-0000000000a3', t, f2);
    if coalesce(cardinality(seen), -1) <> 1 then
      bad := array_append(bad, format('%s (%s)', t, coalesce(cardinality(seen)::text, 'refused')));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('CONTROL: the teen does not read the row in the household they manage in %s', array_to_string(bad, ', ')));
  end if;

  -- 5. The removed caregiver and the stranger.
  for x in select * from (values ('the removed caregiver', gone),
                                 ('a stranger', '00000000-0000-4000-8517-0000000000a9')) as v(who, uid) loop
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.p0517_seen('authenticated', x.uid, t, f1);
      if coalesce(cardinality(seen), 0) <> 0 then
        bad := array_append(bad, format('%s %s', t, cardinality(seen)));
      end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('%s reads Paper House records in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 7. The screens' writes come back to their writer.
  for x in select * from (values
      ('the child''s own travel document', format('insert into public.vacation_documents (family_id, vacation_id, member_id, title, created_by) values (%L, %L, %L, %L, %L) returning id',
                                                   f1, '00000000-0000-4000-8517-0000000000e1', '00000000-0000-4000-8517-0000000000c4', 'p0517 my passport', child)),
      ('the child''s own travel medical detail', format('insert into public.vacation_medical_information (family_id, vacation_id, member_id, allergies, created_by) values (%L, %L, %L, %L, %L) returning id',
                                                   f1, '00000000-0000-4000-8517-0000000000e1', '00000000-0000-4000-8517-0000000000c4', 'p0517 dust', child)),
      ('the child''s own voice command', format('insert into public.voice_commands (family_id, member_id, transcript, created_by) values (%L, %L, %L, %L) returning id',
                                                   f1, '00000000-0000-4000-8517-0000000000c4', 'p0517 add milk', child))) as v(what, q) loop
    got := pg_temp.p0517_as(child, x.q);
    if got is distinct from 'OK 1' then
      failures := array_append(failures, format('CONTROL: %s, inserted with returning, did not come back (%s)', x.what, got));
    end if;
  end loop;
  select id::text into q from p0517_rows where tbl = 'vacation_documents' and who = 'child';
  got := pg_temp.p0517_as(child, format('update public.vacation_documents set notes = %L where id = %L', 'p0517 bring a copy', q));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the child could not update their own travel document (%s)', got));
  end if;
  got := pg_temp.p0517_as(child, format('delete from public.vacation_documents where id = %L', q));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the child could not delete their own travel document (%s)', got));
  end if;

  -- 8. Wiring.
  bad := '{}';
  foreach t in array tables loop
    select count(*) into n from pg_policies p
     where p.schemaname = 'public' and p.tablename = t and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL');
    if n <> 1 or not exists (select 1 from pg_policies p
                              where p.schemaname = 'public' and p.tablename = t and p.policyname = policy
                                and p.permissive = 'PERMISSIVE' and p.cmd = 'SELECT' and p.roles::text[] = array['authenticated']
                                and replace(p.qual, 'public.', '') = case when t = any (medical) then rule_m else rule_p end) then
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
  foreach t in array array['vacation_documents', 'vacation_medical_information'] loop
    if (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = t and p.permissive = 'PERMISSIVE'
           and p.cmd in ('INSERT', 'UPDATE', 'DELETE')
           and replace(coalesce(p.qual, p.with_check), 'public.', '') = 'is_family_member(family_id)') <> 3 then
      bad := array_append(bad, format('%s (its member-wide insert, update and delete are not all there)', t));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('the read is not 0517''s on %s', array_to_string(bad, ' | ')));
  end if;

  if installed then
    -- N1. The family-wide read put back.
    begin
      foreach t in array tables loop
        execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_n1_read', t);
      end loop;
      bad := '{}';
      foreach t in array tables loop
        seen := pg_temp.p0517_seen('authenticated', child, t, f1);
        if not (select id from p0517_rows where tbl = t and who = 'ward') = any (coalesce(seen, '{}')) then
          bad := array_append(bad, t);
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the family-wide read put back the child did not read the ward''s row in %s, so this fixture cannot see the limit', array_to_string(bad, ', ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The caregiver clause added to a personal table.
    begin
      drop policy "A personal record is read by a manager or its member" on public.voice_commands;
      create policy "A personal record is read by a manager or its member" on public.voice_commands for select to authenticated
        using (public.is_family_member(family_id) and (public.can_manage_family(family_id) or public.is_self_member(member_id)
               or public.family_role(family_id) = 'caregiver'));
      seen := pg_temp.p0517_seen('authenticated', carer, 'voice_commands', f1);
      if not (select id from p0517_rows where tbl = 'voice_commands' and who = 'ward') = any (coalesce(seen, '{}')) then
        failures := array_append(failures, 'MUTATION CONTROL: with the caregiver clause on voice_commands the caregiver still did not read the ward''s command, so 2. cannot catch a rule wider than the owner''s');
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a personal record is read beyond its managers and its member:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-personal-record-is-read-by-managers-and-its-member: OK (in the six tables the teen, the child and the guest read their own row and no other (counted); the caregiver reads their own row only in the four personal tables and every row in the two medical ones; the parent and the adult read every row; the teen reads the household they manage; the removed caregiver and a stranger read nothing; the service role with and without a user id reads every row; the child''s own travel document, travel medical detail and voice command come back from insert … returning (OK 1), and the child updates and deletes their own travel document (OK 1); one permissive read per table with 0517''s exact predicate, the travel tables keep their member-wide writes, no restrictive read but a guest''s; negative control: with the family-wide read put back the child reads the ward''s row in all six; mutation control: with a caregiver clause on voice_commands the caregiver reads the ward''s command)';
end $$;

rollback;
