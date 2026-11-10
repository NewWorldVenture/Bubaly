-- ── The household's document, renewal and Autopilot insights are a parent's or adult's (0531) ──
--
-- OPSD-O08 and OPSD-O09: daily_insights (0141) is read by is_family_member, and
-- the household's rows (member_id null) are a parent's or adult's reading. Rows
-- of the document, renewal and autopilot kinds carry what a child or a guest is
-- not shown: a document 0266 keeps from a child, an insurance renewal and its
-- amount, a manager-only Autopilot suggestion. The held 0531 narrows those
-- kinds with a restrictive read.
--
-- Fixture, Insight House: a parent, an adult, a teen, a child, a caregiver and
-- a guest; today's household insights of the document, renewal, autopilot,
-- meal and conflict kinds, and yesterday's document reading of the child's own
-- (member_id the child's).
--
-- What this probe asserts, through PostgREST's role, each attempt in its own
-- rolled-back subtransaction:
--
--   1. as the teen, the child, the caregiver and the guest, each of the
--      household's document, renewal and autopilot insights reads as no row,
--      and so does the child's own reading as the teen; and dismissing the
--      household's document insight as the child, by kind, and its renewal
--      insight as the guest, by id, each change no row;
--   2. control: the parent and the adult read all six rows; the teen, the
--      child, the caregiver and the guest read the household's meal and
--      conflict insights; the child reads their own reading and dismisses it,
--      and dismisses the household's meal insight; the app's writes go through
--      as before: a parent's upsert keeps the household's document row, the
--      child's ignoreDuplicates insert of that kind changes nothing and raises
--      nothing, and a kind the child starts is theirs to read until a parent's
--      upsert makes it the household's; the server (service_role, no user)
--      reads all six;
--   3. wiring: daily_insights keeps row-level security, and the read is a
--      RESTRICTIVE select policy for authenticated;
--
-- and, only where 0531 is installed:
--
--   N1. NEGATIVE CONTROL: with the policy dropped, the child reads the
--       household's document insight: the fixture reaches the defect;
--   M1. MUTATION CONTROL: with autopilot left out of the policy's kinds, the
--       child reads the household's Autopilot insight, so 1. checks each kind.
--
-- Everything is rolled back. This needs none of the other held files.
--
-- HELD with 0531: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/daily-insight-reading-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0531 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8531-0000000000a1','c0531-parent@example.com'),
  ('00000000-0000-4000-8531-0000000000a2','c0531-adult@example.com'),
  ('00000000-0000-4000-8531-0000000000a3','c0531-teen@example.com'),
  ('00000000-0000-4000-8531-0000000000a4','c0531-child@example.com'),
  ('00000000-0000-4000-8531-0000000000a5','c0531-caregiver@example.com'),
  ('00000000-0000-4000-8531-0000000000a6','c0531-guest@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8531-0000000000f1','Insight House','00000000-0000-4000-8531-0000000000a1');
update public.family_members set role = 'parent', is_active = true
 where user_id = '00000000-0000-4000-8531-0000000000a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8531-0000000000d2','00000000-0000-4000-8531-0000000000f1','00000000-0000-4000-8531-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8531-0000000000d3','00000000-0000-4000-8531-0000000000f1','00000000-0000-4000-8531-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8531-0000000000d4','00000000-0000-4000-8531-0000000000f1','00000000-0000-4000-8531-0000000000a4','Kit','child',true),
  ('00000000-0000-4000-8531-0000000000d5','00000000-0000-4000-8531-0000000000f1','00000000-0000-4000-8531-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8531-0000000000d6','00000000-0000-4000-8531-0000000000f1','00000000-0000-4000-8531-0000000000a6','Guest','guest',true);
insert into public.daily_insights (id, family_id, as_of_date, kind, title, detail, member_id, created_by) values
  ('00000000-0000-4000-8531-0000000000e1','00000000-0000-4000-8531-0000000000f1', current_date, 'document', 'Mum''s passport expires in 6 days', 'Passport', null, '00000000-0000-4000-8531-0000000000a1'),
  ('00000000-0000-4000-8531-0000000000e2','00000000-0000-4000-8531-0000000000f1', current_date, 'renewal', 'Car insurance renews in 3 days', '$1,240', null, '00000000-0000-4000-8531-0000000000a1'),
  ('00000000-0000-4000-8531-0000000000e3','00000000-0000-4000-8531-0000000000f1', current_date, 'autopilot', 'Refinance the mortgage', '92% confidence', null, '00000000-0000-4000-8531-0000000000a1'),
  ('00000000-0000-4000-8531-0000000000e4','00000000-0000-4000-8531-0000000000f1', current_date, 'meal', 'Plan 4 dinners', null, null, '00000000-0000-4000-8531-0000000000a1'),
  ('00000000-0000-4000-8531-0000000000e5','00000000-0000-4000-8531-0000000000f1', current_date, 'conflict', 'Two events tomorrow', null, null, '00000000-0000-4000-8531-0000000000a1'),
  ('00000000-0000-4000-8531-0000000000e6','00000000-0000-4000-8531-0000000000f1', current_date - 1, 'document', 'Kit''s library book is due in 2 days', null, '00000000-0000-4000-8531-0000000000d4', '00000000-0000-4000-8531-0000000000a4');

-- One statement as one caller, and exactly what happened; back to the owner
-- with no user id. p_uid '' is a caller with no user (the service role).
create or replace function pg_temp.c0531_as(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
  perform set_config('request.jwt.claims', case when p_uid = '' then json_build_object('role', p_role)
                                                 else json_build_object('sub', p_uid, 'role', p_role) end::text, true);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    got := 'OK ' || n;
  exception when others then
    got := sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return got;
end
$fn$;

-- The same, undone afterwards, so no attempt changes what the next one sees.
create or replace function pg_temp.c0531_try(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare got text;
begin
  begin
    got := pg_temp.c0531_as(p_role, p_uid, p_sql);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  return got;
end
$fn$;

do $$
declare
  parent constant text := '00000000-0000-4000-8531-0000000000a1';
  child constant text := '00000000-0000-4000-8531-0000000000a4';
  guest constant text := '00000000-0000-4000-8531-0000000000a6';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  m record;
  r record;
  got text;
  got2 text;
  got3 text;
  kept_title text;
  kept_member uuid;
begin
  installed := exists (select 1 from pg_policy p
                        where p.polrelid = 'public.daily_insights'::regclass
                          and p.polname = 'A document, renewal or Autopilot insight is a manager''s');

  -- 1. What the teen, the child, the caregiver and the guest may not read.
  for m in select * from (values ('teen', '00000000-0000-4000-8531-0000000000a3'),
                                 ('child', '00000000-0000-4000-8531-0000000000a4'),
                                 ('caregiver', '00000000-0000-4000-8531-0000000000a5'),
                                 ('guest', '00000000-0000-4000-8531-0000000000a6')) v(role, uid) loop
    for r in select * from (values ('document', '00000000-0000-4000-8531-0000000000e1', 'Mum''s passport expires in 6 days'),
                                   ('renewal', '00000000-0000-4000-8531-0000000000e2', 'Car insurance renews in 3 days'),
                                   ('autopilot', '00000000-0000-4000-8531-0000000000e3', 'Refinance the mortgage')) v(kind, id, title) loop
      got := pg_temp.c0531_try('authenticated', m.uid, format('select 1 from public.daily_insights where id = %L', r.id));
      if got <> 'OK 0' then
        failures := array_append(failures, format('the %s read the household''s %s insight, "%s" (%s)', m.role, r.kind, r.title, got));
      end if;
    end loop;
  end loop;
  got := pg_temp.c0531_try('authenticated', '00000000-0000-4000-8531-0000000000a3',
    'select 1 from public.daily_insights where id = ''00000000-0000-4000-8531-0000000000e6''');
  if got <> 'OK 0' then
    failures := array_append(failures, format('the teen read the child''s own document reading (%s)', got));
  end if;
  got := pg_temp.c0531_try('authenticated', child,
    'update public.daily_insights set status = ''dismissed'' where kind = ''document'' and as_of_date = current_date');
  if got <> 'OK 0' then
    failures := array_append(failures, format('the child dismissed the household''s document insight (%s)', got));
  end if;
  got := pg_temp.c0531_try('authenticated', guest,
    'update public.daily_insights set status = ''dismissed'' where id = ''00000000-0000-4000-8531-0000000000e2''');
  if got <> 'OK 0' then
    failures := array_append(failures, format('the guest dismissed the household''s renewal insight (%s)', got));
  end if;

  -- 2. Controls.
  bad := '{}';
  for m in select * from (values ('parent', '00000000-0000-4000-8531-0000000000a1'),
                                 ('adult', '00000000-0000-4000-8531-0000000000a2')) v(role, uid) loop
    got := pg_temp.c0531_try('authenticated', m.uid,
      'select 1 from public.daily_insights where family_id = ''00000000-0000-4000-8531-0000000000f1''');
    if got <> 'OK 6' then
      bad := array_append(bad, format('the %s could not read all six insights (%s)', m.role, got));
    end if;
  end loop;
  for m in select * from (values ('teen', '00000000-0000-4000-8531-0000000000a3'),
                                 ('child', '00000000-0000-4000-8531-0000000000a4'),
                                 ('caregiver', '00000000-0000-4000-8531-0000000000a5'),
                                 ('guest', '00000000-0000-4000-8531-0000000000a6')) v(role, uid) loop
    got := pg_temp.c0531_try('authenticated', m.uid,
      'select 1 from public.daily_insights where id in (''00000000-0000-4000-8531-0000000000e4'', ''00000000-0000-4000-8531-0000000000e5'')');
    if got <> 'OK 2' then
      bad := array_append(bad, format('the %s could not read the household''s meal and conflict insights (%s)', m.role, got));
    end if;
  end loop;
  for r in select * from (values
      ('read their own document reading', 'OK 1',
       'select 1 from public.daily_insights where id = ''00000000-0000-4000-8531-0000000000e6'''),
      ('dismiss their own document reading', 'OK 1',
       'update public.daily_insights set status = ''dismissed'' where id = ''00000000-0000-4000-8531-0000000000e6'''),
      ('dismiss the household''s meal insight', 'OK 1',
       'update public.daily_insights set status = ''dismissed'' where id = ''00000000-0000-4000-8531-0000000000e4'''),
      ('start tomorrow''s renewal reading as their own and read it back', 'OK 1',
       'insert into public.daily_insights (family_id, as_of_date, kind, title, member_id, created_by) values (''00000000-0000-4000-8531-0000000000f1'', current_date + 1, ''renewal'', ''Kit''''s bus pass renews in 5 days'', ''00000000-0000-4000-8531-0000000000d4'', ''00000000-0000-4000-8531-0000000000a4'') returning id')) v(what, want, stmt) loop
    got := pg_temp.c0531_try('authenticated', child, r.stmt);
    if got is distinct from r.want then
      bad := array_append(bad, format('the child could not %s (%s)', r.what, got));
    end if;
  end loop;
  -- The app's writes (components/dashboard/ai-home-dashboard.tsx): a parent's
  -- upsert keeps the household's row; a non-manager's ignoreDuplicates insert
  -- of a kind the household already has changes nothing and raises nothing.
  got := pg_temp.c0531_try('authenticated', parent,
    'insert into public.daily_insights (family_id, as_of_date, kind, title, member_id, created_by) values (''00000000-0000-4000-8531-0000000000f1'', current_date, ''document'', ''Mum''''s passport expires in 6 days'', null, ''00000000-0000-4000-8531-0000000000a1'') on conflict (family_id, as_of_date, kind) do update set title = excluded.title, member_id = excluded.member_id');
  if got <> 'OK 1' then
    bad := array_append(bad, format('the parent''s upsert of the household''s document insight did not go through (%s)', got));
  end if;
  begin
    got := pg_temp.c0531_as('authenticated', child,
      'insert into public.daily_insights (family_id, as_of_date, kind, title, member_id, created_by) values (''00000000-0000-4000-8531-0000000000f1'', current_date, ''document'', ''Kit''''s reading'', ''00000000-0000-4000-8531-0000000000d4'', ''00000000-0000-4000-8531-0000000000a4'') on conflict (family_id, as_of_date, kind) do nothing');
    select i.title, i.member_id into kept_title, kept_member from public.daily_insights i where i.id = '00000000-0000-4000-8531-0000000000e1';
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  if got <> 'OK 0' then
    bad := array_append(bad, format('the child''s ignoreDuplicates insert of a document reading was not a quiet no-op (%s)', got));
  elsif kept_title is distinct from 'Mum''s passport expires in 6 days' or kept_member is not null then
    bad := array_append(bad, format('the child''s ignoreDuplicates insert changed the household''s document insight (%s, %s)', kept_title, kept_member));
  end if;
  -- A kind the child starts is theirs until a parent's upsert makes it the
  -- household's, and then it is not theirs to read.
  begin
    got := pg_temp.c0531_as('authenticated', child,
      'insert into public.daily_insights (family_id, as_of_date, kind, title, member_id, created_by) values (''00000000-0000-4000-8531-0000000000f1'', current_date + 1, ''renewal'', ''Kit''''s bus pass renews in 5 days'', ''00000000-0000-4000-8531-0000000000d4'', ''00000000-0000-4000-8531-0000000000a4'')');
    got2 := pg_temp.c0531_as('authenticated', parent,
      'insert into public.daily_insights (family_id, as_of_date, kind, title, member_id, created_by) values (''00000000-0000-4000-8531-0000000000f1'', current_date + 1, ''renewal'', ''Car insurance renews in 2 days'', null, ''00000000-0000-4000-8531-0000000000a1'') on conflict (family_id, as_of_date, kind) do update set title = excluded.title, member_id = excluded.member_id');
    got3 := pg_temp.c0531_as('authenticated', child,
      'select 1 from public.daily_insights where family_id = ''00000000-0000-4000-8531-0000000000f1'' and as_of_date = current_date + 1 and kind = ''renewal''');
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  if got <> 'OK 1' or got2 <> 'OK 1' then
    bad := array_append(bad, format('the child''s reading and the parent''s upsert over it did not both go through (%s, %s)', got, got2));
  elsif got3 <> 'OK 0' then
    failures := array_append(failures, format('the child read tomorrow''s renewal insight after a parent''s upsert made it the household''s (%s)', got3));
  end if;
  got := pg_temp.c0531_try('service_role', '',
    'select 1 from public.daily_insights where family_id = ''00000000-0000-4000-8531-0000000000f1''');
  if got <> 'OK 6' then
    bad := array_append(bad, format('the server could not read all six insights (%s)', got));
  end if;
  if cardinality(bad) > 0 then
    failures := array_append(failures, 'CONTROL: ' || array_to_string(bad, '; '));
  end if;

  -- 3. Wiring.
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.daily_insights'::regclass)
     or not exists (select 1 from pg_policy p
                     where p.polrelid = 'public.daily_insights'::regclass
                       and p.polname = 'A document, renewal or Autopilot insight is a manager''s'
                       and not p.polpermissive and p.polcmd = 'r'
                       and p.polroles = array[(select o.oid from pg_roles o where o.rolname = 'authenticated')]) then
    failures := array_append(failures, '0531''s restrictive read is not in place on daily_insights');
  end if;

  if installed then
    -- N1. The policy dropped.
    begin
      drop policy "A document, renewal or Autopilot insight is a manager's" on public.daily_insights;
      got := pg_temp.c0531_as('authenticated', child,
        'select 1 from public.daily_insights where id = ''00000000-0000-4000-8531-0000000000e1''');
      if got <> 'OK 1' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the policy dropped the child still did not read the household''s document insight (%s), so this fixture cannot see the defect', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. Autopilot left out of the policy's kinds.
    begin
      drop policy "A document, renewal or Autopilot insight is a manager's" on public.daily_insights;
      create policy "A document, renewal or Autopilot insight is a manager's" on public.daily_insights
        as restrictive for select to authenticated
        using (kind not in ('document', 'renewal')
               or public.can_manage_family(family_id)
               or (member_id is not null and public.is_self_member(member_id)));
      got := pg_temp.c0531_as('authenticated', child,
        'select 1 from public.daily_insights where id = ''00000000-0000-4000-8531-0000000000e3''');
      if got <> 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: with autopilot left out of the policy the child still did not read the household''s Autopilot insight (%s), so 1. cannot catch a kind going', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'the household''s document, renewal and Autopilot insights are not only a parent''s or adult''s:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-households-document-renewal-and-autopilot-insights-are-a-parents-or-adults: OK (as the teen, the child, the caregiver and the guest, the household''s document, renewal and Autopilot insights read as no row, as did the child''s own reading as the teen, and dismissing the household''s document insight by kind and its renewal insight by id changed no row; parents and adults read all six; every member still reads the household''s meal and conflict insights; the child reads and dismisses their own reading and dismisses the household''s meal insight; a parent''s upsert keeps the household''s row, the child''s ignoreDuplicates insert of a kind the household has changes nothing quietly, and a kind the child starts is theirs until a parent''s upsert makes it the household''s; the server reads all six; the restrictive read is in place; negative control: with it dropped the child read the household''s document insight; mutation control: with autopilot left out the child read the household''s Autopilot insight)';
end $$;

rollback;
