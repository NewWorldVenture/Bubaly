-- ── A note about a member is read by managers, its author and caregivers (0510) ─
--
-- behavior_logs and care_log read with is_family_member(family_id), so a teen
-- or a child reads every behaviour note and every care note written about every
-- other member of the household, and the ones a parent wrote about them. The
-- held 0510 replaces that read on both with: a manager of the row's family, the
-- note's author (behavior_logs.logged_by, care_log.created_by), or a caregiver,
-- all still inside is_family_member(family_id).
--
-- Fixture, Note House: a parent and an adult (managers), a teen (who is also
-- the parent of a household of their own), a child, a caregiver, a guest, a
-- ward with no login, and a caregiver since removed (is_active false). In each
-- table, as the server writes them:
--
--   the ward's note, by the parent              (another member's)
--   a note about each of the teen, the child, the caregiver and the guest, by
--   the parent                                   (about them, not theirs)
--   the teen's and the child's own note about themselves
--   a note about the ward, by the caregiver     (the caregiver's own writing)
--   a note about the ward, by the removed caregiver
--   in the teen's own household: its ward's note, with no author
--
-- What this probe asserts, through PostgREST's role, in both tables:
--
--   1. the teen and the child read no Note House note they did not write,
--      not even the parent's note about them (counted);
--   2. control: each of them reads the note they wrote (1 each);
--   3. the guest reads no Note House note (0481 already closes care_log to a
--      guest, and the held 0509 both tables; 0510 alone holds behavior_logs);
--   4. control: the parent, the adult and the caregiver read every Note House
--      note;
--   5. control: the teen reads the note in the household they manage (1), so
--      1. is the row's family deciding, not the teen being unable to read;
--   6. the removed caregiver reads nothing, not even the note they wrote, and
--      a stranger in a household of their own reads nothing;
--   7. control: the service role, carrying the child's user id and without
--      one, reads every Note House note;
--   8. control: the writes the screens make still come back to their writer:
--      the child's own care note and the caregiver's care note for the ward
--      (insert … returning, OK 1 each), the child's edit of their own care note
--      (update … returning, OK 1), and a parent's behaviour note and the
--      child's own (insert … returning, OK 1 each);
--   9. wiring: one permissive read policy per table, by 0510's name, granted
--      to authenticated, USING exactly 0510's predicate over that table's
--      author column; the only restrictive read policies are a guest's
--      (0481's care_log_not_a_guests_read, the held 0509's);
--
-- and, only where 0510 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with the family-wide read put back on both, the
--       child reads the ward's note in each (1): the fixture reaches the limit
--       0510 closes;
--   M1. MUTATION CONTROL: with 0510's outer is_family_member(family_id) taken
--       off, the removed caregiver reads the note they wrote in each (1), so
--       6. is what catches a rule that forgets a member can leave.
--
-- Everything is rolled back.
--
-- HELD with 0510: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/member-notes-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0510 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8510-0000000000a1','n0510-parent@example.com'),
  ('00000000-0000-4000-8510-0000000000a2','n0510-adult@example.com'),
  ('00000000-0000-4000-8510-0000000000a3','n0510-teen@example.com'),
  ('00000000-0000-4000-8510-0000000000a4','n0510-child@example.com'),
  ('00000000-0000-4000-8510-0000000000a5','n0510-caregiver@example.com'),
  ('00000000-0000-4000-8510-0000000000a6','n0510-guest@example.com'),
  ('00000000-0000-4000-8510-0000000000a8','n0510-gone@example.com'),
  ('00000000-0000-4000-8510-0000000000a9','n0510-stranger@example.com')
  on conflict do nothing;
-- on_family_created files each creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8510-0000000000f1','Note House','00000000-0000-4000-8510-0000000000a1'),
  ('00000000-0000-4000-8510-0000000000f2','Teen''s Own House','00000000-0000-4000-8510-0000000000a3'),
  ('00000000-0000-4000-8510-0000000000f3','Next Door','00000000-0000-4000-8510-0000000000a9');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8510-0000000000a1','00000000-0000-4000-8510-0000000000a3','00000000-0000-4000-8510-0000000000a9');
-- The parent's own row gets a fixed id, so a care note can name its logger.
update public.family_members set id = '00000000-0000-4000-8510-0000000000c1'
 where family_id = '00000000-0000-4000-8510-0000000000f1' and user_id = '00000000-0000-4000-8510-0000000000a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8510-0000000000c2','00000000-0000-4000-8510-0000000000f1','00000000-0000-4000-8510-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8510-0000000000c3','00000000-0000-4000-8510-0000000000f1','00000000-0000-4000-8510-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8510-0000000000c4','00000000-0000-4000-8510-0000000000f1','00000000-0000-4000-8510-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8510-0000000000c5','00000000-0000-4000-8510-0000000000f1','00000000-0000-4000-8510-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8510-0000000000c6','00000000-0000-4000-8510-0000000000f1','00000000-0000-4000-8510-0000000000a6','Guest','guest',true),
  ('00000000-0000-4000-8510-0000000000c7','00000000-0000-4000-8510-0000000000f1',null,'Ward','child',true),
  ('00000000-0000-4000-8510-0000000000c8','00000000-0000-4000-8510-0000000000f1','00000000-0000-4000-8510-0000000000a8','Caregiver (removed)','caregiver',false),
  ('00000000-0000-4000-8510-0000000000c9','00000000-0000-4000-8510-0000000000f2',null,'Teen''s ward','child',true);

-- One note in one of the two tables, as the server writes it: behavior_logs
-- signs with the author's user id, care_log with the author's user id and
-- their membership row.
create or replace function pg_temp.n0510_put(t text, fam uuid, member uuid, author uuid, tag int) returns uuid
language plpgsql as $fn$
declare id uuid;
begin
  if t = 'behavior_logs' then
    insert into public.behavior_logs (family_id, member_id, kind, category, note, points, logged_by)
      values (fam, member, 'concern', 'focus', 'n0510 ' || tag, -1, author)
      returning behavior_logs.id into id;
  else
    insert into public.care_log (family_id, member_id, log_type, note, logged_by, created_by)
      values (fam, member, 'note', 'n0510 ' || tag,
              (select fm.id from public.family_members fm where fm.family_id = fam and fm.user_id = author), author)
      returning care_log.id into id;
  end if;
  return id;
end
$fn$;

-- The ids of one family's notes in one table, as one caller sees them; null if
-- the read itself was refused.
create or replace function pg_temp.n0510_seen(p_role text, p_uid text, t text, fam uuid) returns uuid[]
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
create or replace function pg_temp.n0510_as(p_uid text, p_sql text) returns text
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

create temp table n0510_rows (tbl text, kind text, who text, id uuid) on commit drop;

do $$
declare
  f1      constant uuid := '00000000-0000-4000-8510-0000000000f1';
  f2      constant uuid := '00000000-0000-4000-8510-0000000000f2';
  parent  constant uuid := '00000000-0000-4000-8510-0000000000a1';
  carer   constant uuid := '00000000-0000-4000-8510-0000000000a5';
  gone    constant uuid := '00000000-0000-4000-8510-0000000000a8';
  ward    constant uuid := '00000000-0000-4000-8510-0000000000c7';
  ward2   constant uuid := '00000000-0000-4000-8510-0000000000c9';
  t   text;
  x   record;
  tag int := 0;
begin
  foreach t in array array['behavior_logs', 'care_log'] loop
    tag := tag + 1;
    insert into n0510_rows values (t, 'other', null, pg_temp.n0510_put(t, f1, ward, parent, tag));
    for x in select * from (values ('teen', '00000000-0000-4000-8510-0000000000c3'::uuid, '00000000-0000-4000-8510-0000000000a3'::uuid),
                                   ('child', '00000000-0000-4000-8510-0000000000c4'::uuid, '00000000-0000-4000-8510-0000000000a4'::uuid),
                                   ('caregiver', '00000000-0000-4000-8510-0000000000c5'::uuid, null),
                                   ('guest', '00000000-0000-4000-8510-0000000000c6'::uuid, null)) as v(who, member, uid) loop
      tag := tag + 1;
      insert into n0510_rows values (t, 'about', x.who, pg_temp.n0510_put(t, f1, x.member, parent, tag));
      if x.uid is not null then
        tag := tag + 1;
        insert into n0510_rows values (t, 'own', x.who, pg_temp.n0510_put(t, f1, x.member, x.uid, tag));
      end if;
    end loop;
    tag := tag + 1;
    insert into n0510_rows values (t, 'own', 'caregiver', pg_temp.n0510_put(t, f1, ward, carer, tag));
    tag := tag + 1;
    insert into n0510_rows values (t, 'gone', null, pg_temp.n0510_put(t, f1, ward, gone, tag));
    tag := tag + 1;
    insert into n0510_rows values (t, 'elsewhere', null, pg_temp.n0510_put(t, f2, ward2, null, tag));
  end loop;
end $$;

do $$
declare
  f1        constant uuid := '00000000-0000-4000-8510-0000000000f1';
  f2        constant uuid := '00000000-0000-4000-8510-0000000000f2';
  child     constant text := '00000000-0000-4000-8510-0000000000a4';
  carer     constant text := '00000000-0000-4000-8510-0000000000a5';
  gone      constant text := '00000000-0000-4000-8510-0000000000a8';
  tables    constant text[] := array['behavior_logs', 'care_log'];
  policy    constant text := 'A note is read by a manager, its author or a caregiver';
  installed boolean := exists (select 1 from pg_policies p where p.schemaname = 'public'
                                 and p.tablename = 'behavior_logs' and p.policyname = 'A note is read by a manager, its author or a caregiver');
  failures  text[] := '{}';
  x         record;
  t         text;
  author    text;
  seen      uuid[];
  mine      uuid[];
  everyone  uuid[];
  leaks     text[];
  bad       text[];
  n         int;
  m         int;
  got       text;
  sql       text;
begin
  -- 1-2. The teen and the child.
  for x in select * from (values ('teen',  '00000000-0000-4000-8510-0000000000a3'),
                                 ('child', '00000000-0000-4000-8510-0000000000a4')) as v(who, uid) loop
    leaks := '{}';
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.n0510_seen('authenticated', x.uid, t, f1);
      select coalesce(array_agg(r.id), '{}') into mine from n0510_rows r where r.tbl = t and r.who = x.who and r.kind = 'own';
      if seen is null then
        bad := array_append(bad, format('%s (the read was refused)', t));
        continue;
      end if;
      select count(*) into n from unnest(seen) s(id) where s.id <> all (mine);
      select count(*) into m from unnest(seen) s(id) join n0510_rows r on r.id = s.id and r.kind = 'about' and r.who = x.who;
      if n <> 0 then
        leaks := array_append(leaks, format('%s %s, the parent''s note about them %s', t, n, case when m = 1 then 'among them' else 'not' end));
      end if;
      select count(*) into n from unnest(mine) o(id) where o.id = any (seen);
      if n <> 1 or cardinality(mine) <> 1 then
        bad := array_append(bad, format('%s (%s of %s)', t, n, cardinality(mine)));
      end if;
    end loop;
    if cardinality(leaks) > 0 then
      failures := array_append(failures, format('the %s reads notes they did not write in %s of 2 tables (%s)',
                                                x.who, cardinality(leaks), array_to_string(leaks, '; ')));
    end if;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: the %s no longer reads the note they wrote in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 3. The guest.
  bad := '{}';
  foreach t in array tables loop
    seen := pg_temp.n0510_seen('authenticated', '00000000-0000-4000-8510-0000000000a6', t, f1);
    if coalesce(cardinality(seen), 0) <> 0 then
      bad := array_append(bad, format('%s %s', t, cardinality(seen)));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('the guest reads Note House notes in %s', array_to_string(bad, ', ')));
  end if;

  -- 4. The managers and the caregiver, and 7. the service role with and without a user id.
  for x in select * from (values ('the parent', 'authenticated', '00000000-0000-4000-8510-0000000000a1'),
                                 ('the adult', 'authenticated', '00000000-0000-4000-8510-0000000000a2'),
                                 ('the caregiver', 'authenticated', carer),
                                 ('the service role (with the child''s user id)', 'service_role', child),
                                 ('the service role (no user id)', 'service_role', null)) as v(who, role, uid) loop
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.n0510_seen(x.role, x.uid, t, f1);
      select coalesce(array_agg(r.id), '{}') into everyone from n0510_rows r where r.tbl = t and r.kind <> 'elsewhere';
      if seen is null or not (seen @> everyone and everyone @> seen) then
        bad := array_append(bad, format('%s (%s of %s)', t, coalesce(cardinality(seen)::text, 'refused'), cardinality(everyone)));
      end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: %s does not read every Note House note in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 5. The teen manages a household of their own.
  bad := '{}';
  foreach t in array tables loop
    seen := pg_temp.n0510_seen('authenticated', '00000000-0000-4000-8510-0000000000a3', t, f2);
    if coalesce(cardinality(seen), -1) <> 1 then
      bad := array_append(bad, format('%s (%s)', t, coalesce(cardinality(seen)::text, 'refused')));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('CONTROL: the teen does not read the note in the household they manage in %s', array_to_string(bad, ', ')));
  end if;

  -- 6. The removed caregiver and the stranger.
  for x in select * from (values ('the removed caregiver', gone),
                                 ('a stranger', '00000000-0000-4000-8510-0000000000a9')) as v(who, uid) loop
    bad := '{}';
    foreach t in array tables loop
      seen := pg_temp.n0510_seen('authenticated', x.uid, t, f1);
      if coalesce(cardinality(seen), 0) <> 0 then
        bad := array_append(bad, format('%s %s', t, cardinality(seen)));
      end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('%s reads Note House notes in %s', x.who, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 8. The screens' writes come back to their writer.
  got := pg_temp.n0510_as(child, format(
    'insert into public.care_log (family_id, member_id, log_type, note, logged_by, created_by) values (%L, %L, %L, %L, %L, %L) returning id',
    f1, '00000000-0000-4000-8510-0000000000c4', 'check_in', 'n0510 own check-in', '00000000-0000-4000-8510-0000000000c4', child));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the child''s own care note, inserted with returning, did not come back (%s)', got));
  end if;
  got := pg_temp.n0510_as(carer, format(
    'insert into public.care_log (family_id, member_id, log_type, note, logged_by, created_by) values (%L, %L, %L, %L, %L, %L) returning id',
    f1, '00000000-0000-4000-8510-0000000000c7', 'meal', 'n0510 ward''s lunch', '00000000-0000-4000-8510-0000000000c5', carer));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the caregiver''s care note for the ward, inserted with returning, did not come back (%s)', got));
  end if;
  select format('update public.care_log set note = %L where id = %L and family_id = %L returning id', 'n0510 edited', r.id, f1)
    into sql from n0510_rows r where r.tbl = 'care_log' and r.kind = 'own' and r.who = 'child';
  got := pg_temp.n0510_as(child, sql);
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the child''s edit of their own care note, with returning, did not come back (%s)', got));
  end if;
  got := pg_temp.n0510_as('00000000-0000-4000-8510-0000000000a1', format(
    'insert into public.behavior_logs (family_id, member_id, kind, category, note, points, logged_by) values (%L, %L, %L, %L, %L, 1, %L) returning id',
    f1, '00000000-0000-4000-8510-0000000000c4', 'positive', 'kindness', 'n0510 shared', '00000000-0000-4000-8510-0000000000a1'));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the parent''s behaviour note, inserted with returning, did not come back (%s)', got));
  end if;
  got := pg_temp.n0510_as(child, format(
    'insert into public.behavior_logs (family_id, member_id, kind, category, note, points, logged_by) values (%L, %L, %L, %L, %L, 0, %L) returning id',
    f1, '00000000-0000-4000-8510-0000000000c4', 'neutral', 'general', 'n0510 read a book', child));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the child''s own behaviour note, inserted with returning, did not come back (%s)', got));
  end if;

  -- 9. Wiring.
  bad := '{}';
  foreach t in array tables loop
    author := case t when 'behavior_logs' then 'logged_by' else 'created_by' end;
    select count(*) into n from pg_policies p
     where p.schemaname = 'public' and p.tablename = t and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL');
    if n <> 1 or not exists (select 1 from pg_policies p
                              where p.schemaname = 'public' and p.tablename = t
                                and p.policyname = policy
                                and p.permissive = 'PERMISSIVE' and p.cmd = 'SELECT'
                                and p.roles::text[] = array['authenticated']
                                and replace(p.qual, 'public.', '') = format(
                                  '(is_family_member(family_id) AND (can_manage_family(family_id) OR (%s = auth.uid()) OR (family_role(family_id) = ''caregiver''::member_role)))',
                                  author)) then
      bad := array_append(bad, format('%s (%s permissive read polic(ies): %s)', t, n,
        (select string_agg(p.policyname || ' USING ' || replace(p.qual, 'public.', ''), '; ')
           from pg_policies p
          where p.schemaname = 'public' and p.tablename = t and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL'))));
    end if;
    if exists (select 1 from pg_policies p
                where p.schemaname = 'public' and p.tablename = t and p.permissive = 'RESTRICTIVE' and p.cmd in ('SELECT', 'ALL')
                  and p.policyname not in ('care_log_not_a_guests_read', 'A guest does not read ' || t)) then
      bad := array_append(bad, format('%s (a restrictive read policy other than a guest''s)', t));
    end if;
    if not exists (select 1 from pg_class c where c.oid = ('public.' || t)::regclass and c.relrowsecurity) then
      bad := array_append(bad, format('%s (row security off)', t));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('the read is not 0510''s on %s', array_to_string(bad, ' | ')));
  end if;

  if installed then
    -- N1. The family-wide read put back.
    begin
      foreach t in array tables loop
        execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_n1_read', t);
      end loop;
      bad := '{}';
      foreach t in array tables loop
        seen := pg_temp.n0510_seen('authenticated', child, t, f1);
        select count(*) into n from unnest(seen) s(id) join n0510_rows r on r.id = s.id and r.kind = 'other';
        if n <> 1 then
          bad := array_append(bad, format('%s %s', t, n));
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the family-wide read put back the child did not read the ward''s note (%s), so this fixture cannot see the limit', array_to_string(bad, ', ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The outer is_family_member taken off.
    begin
      foreach t in array tables loop
        execute format('drop policy %I on public.%I', policy, t);
        execute format('create policy %I on public.%I for select to authenticated using ('
                       || 'public.can_manage_family(family_id) or %I = auth.uid() or public.family_role(family_id) = ''caregiver'')',
                       policy, t, case t when 'behavior_logs' then 'logged_by' else 'created_by' end);
      end loop;
      bad := '{}';
      foreach t in array tables loop
        seen := pg_temp.n0510_seen('authenticated', gone, t, f1);
        select count(*) into n from unnest(seen) s(id) join n0510_rows r on r.id = s.id and r.kind = 'gone';
        if n <> 1 then
          bad := array_append(bad, format('%s %s', t, n));
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('MUTATION CONTROL: without the outer is_family_member the removed caregiver did not read what they wrote (%s), so 6. cannot catch that rule', array_to_string(bad, ', ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a note about a member is read beyond its managers, its author and a caregiver:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-note-about-a-member-is-read-by-managers-its-author-and-caregivers: OK (in behavior_logs and care_log the teen and the child read no note they did not write, not even the parent''s note about them (counted), and each reads the note they wrote; the guest reads no note; the parent, the adult and the caregiver read every note; the teen reads the note in the household they manage; the removed caregiver and a stranger read nothing; the service role with and without a user id reads every note; the child''s own care note and the caregiver''s care note for the ward come back from insert … returning (OK 1), the child''s edit of their own care note from update … returning (OK 1), and the parent''s and the child''s behaviour notes from insert … returning (OK 1); one permissive read policy per table, USING exactly 0510''s predicate over its author column, no restrictive read but a guest''s; negative control: with the family-wide read put back the child read the ward''s note in both; mutation control: without the outer is_family_member the removed caregiver read what they wrote in both)';
end $$;

rollback;
