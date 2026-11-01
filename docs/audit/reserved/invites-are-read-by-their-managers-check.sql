-- ── Invites are read by their household's managers and the person invited (0533) ──
--
-- COVER-O1 (N9) and the per-role read matrix for invites (DB-TBL-194).
-- invites_select (0004, 0118) let any member of a household read every invite
-- in it over PostgREST, with the invitee's email, role, bearer token and
-- expiry. The held 0533 makes it can_manage_family(family_id) or the invitee's
-- own email, the register's owner action.
--
-- Fixture: Invite House, with a parent, an adult, a teen, a child, a caregiver
-- and a guest; its pending invites to Nana, to the teen's own address and to
-- Olive, who is in no household; Other House, with its own parent and an
-- invite to Zed; and Ned, in no household and invited nowhere. Each caller's
-- token carries their email, as Supabase's does.
--
-- What this probe asserts, through PostgREST's role, each read in its own
-- rolled-back subtransaction:
--
--   1. the teen, the child, the caregiver and the guest each read no invite
--      but one to their own address: not Nana's, not Olive's (and so no
--      token);
--   2. control (the matrix): the parent and the adult each read all three of
--      Invite House's invites and none of Other House's; the teen reads the
--      invite to their own address; Olive reads hers and no other (the join
--      preview); Ned reads none; the server (service_role, no user) reads all
--      four; the parent files an invite and reads it back (the invite form),
--      and revokes one (PendingInvites);
--   3. wiring: invites_select is the only permissive read on invites, and its
--      qual is the managers' and the invitee's;
--
-- and, only where 0533 is installed:
--
--   N1. NEGATIVE CONTROL: with invites_select back to is_family_member, the
--       child reads Nana's invite: the fixture reaches the defect;
--   M1. MUTATION CONTROL: with the invitee's arm dropped, Olive reads no
--       invite, so 2. is what keeps the join preview.
--
-- Everything is rolled back. This needs none of the other held files.
--
-- HELD with 0533: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/invite-reading-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0533 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8533-0000000000a1','c0533-parent@example.com'),
  ('00000000-0000-4000-8533-0000000000a2','c0533-adult@example.com'),
  ('00000000-0000-4000-8533-0000000000a3','c0533-teen@example.com'),
  ('00000000-0000-4000-8533-0000000000a4','c0533-child@example.com'),
  ('00000000-0000-4000-8533-0000000000a5','c0533-caregiver@example.com'),
  ('00000000-0000-4000-8533-0000000000a6','c0533-guest@example.com'),
  ('00000000-0000-4000-8533-0000000000a7','c0533-olive@example.com'),
  ('00000000-0000-4000-8533-0000000000a8','c0533-other-parent@example.com'),
  ('00000000-0000-4000-8533-0000000000a9','c0533-ned@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8533-0000000000f1','Invite House','00000000-0000-4000-8533-0000000000a1'),
  ('00000000-0000-4000-8533-0000000000f2','Other House','00000000-0000-4000-8533-0000000000a8');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8533-0000000000a1', '00000000-0000-4000-8533-0000000000a8');
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8533-0000000000f1','00000000-0000-4000-8533-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8533-0000000000f1','00000000-0000-4000-8533-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8533-0000000000f1','00000000-0000-4000-8533-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8533-0000000000f1','00000000-0000-4000-8533-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8533-0000000000f1','00000000-0000-4000-8533-0000000000a6','Guest','guest',true);
insert into public.invites (id, family_id, email, role, token, invited_by) values
  ('00000000-0000-4000-8533-0000000000c1','00000000-0000-4000-8533-0000000000f1','nana@example.com','caregiver','c0533-token-nana','00000000-0000-4000-8533-0000000000a1'),
  ('00000000-0000-4000-8533-0000000000c2','00000000-0000-4000-8533-0000000000f1','C0533-Teen@example.com','adult','c0533-token-teen','00000000-0000-4000-8533-0000000000a1'),
  ('00000000-0000-4000-8533-0000000000c3','00000000-0000-4000-8533-0000000000f1','c0533-olive@example.com','adult','c0533-token-olive','00000000-0000-4000-8533-0000000000a1'),
  ('00000000-0000-4000-8533-0000000000c4','00000000-0000-4000-8533-0000000000f2','zed@example.com','adult','c0533-token-zed','00000000-0000-4000-8533-0000000000a8');

-- One statement as one caller, whose token carries their email, and exactly
-- what happened; back to the owner with no user id. p_uid '' is a caller with
-- no user (the service role).
create or replace function pg_temp.c0533_as(p_role text, p_uid text, p_email text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
  perform set_config('request.jwt.claims', case when p_uid = '' then json_build_object('role', p_role)
                                                 else json_build_object('sub', p_uid, 'role', p_role, 'email', p_email) end::text, true);
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
create or replace function pg_temp.c0533_try(p_role text, p_uid text, p_email text, p_sql text) returns text
language plpgsql as $fn$
declare got text;
begin
  begin
    got := pg_temp.c0533_as(p_role, p_uid, p_email, p_sql);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  return got;
end
$fn$;

do $$
declare
  parent constant text := '00000000-0000-4000-8533-0000000000a1';
  child constant text := '00000000-0000-4000-8533-0000000000a4';
  olive constant text := '00000000-0000-4000-8533-0000000000a7';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  m record;
  r record;
  got text;
  qual text;
begin
  installed := exists (select 1 from pg_policy p
                        where p.polrelid = 'public.invites'::regclass and p.polname = 'invites_select'
                          and pg_get_expr(p.polqual, p.polrelid) like '(can_manage_family(family_id) OR %');

  -- 1. What the teen, the child, the caregiver and the guest may not read.
  for m in select * from (values ('teen', '00000000-0000-4000-8533-0000000000a3', 'c0533-teen@example.com'),
                                 ('child', '00000000-0000-4000-8533-0000000000a4', 'c0533-child@example.com'),
                                 ('caregiver', '00000000-0000-4000-8533-0000000000a5', 'c0533-caregiver@example.com'),
                                 ('guest', '00000000-0000-4000-8533-0000000000a6', 'c0533-guest@example.com')) v(role, uid, email) loop
    for r in select * from (values ('Nana', '00000000-0000-4000-8533-0000000000c1'),
                                   ('Olive', '00000000-0000-4000-8533-0000000000c3')) v(who, id) loop
      got := pg_temp.c0533_try('authenticated', m.uid, m.email, format('select token from public.invites where id = %L', r.id));
      if got <> 'OK 0' then
        failures := array_append(failures, format('the %s read the invite to %s, with its token (%s)', m.role, r.who, got));
      end if;
    end loop;
  end loop;

  -- 2. Controls: the matrix.
  bad := '{}';
  for r in select * from (values
      ('the parent read Invite House''s three invites', 'authenticated', parent, 'c0533-parent@example.com', 'OK 3',
       'select 1 from public.invites where family_id = ''00000000-0000-4000-8533-0000000000f1'''),
      ('the adult read Invite House''s three invites', 'authenticated', '00000000-0000-4000-8533-0000000000a2', 'c0533-adult@example.com', 'OK 3',
       'select 1 from public.invites where family_id = ''00000000-0000-4000-8533-0000000000f1'''),
      ('the parent read none of Other House''s invites', 'authenticated', parent, 'c0533-parent@example.com', 'OK 0',
       'select 1 from public.invites where family_id = ''00000000-0000-4000-8533-0000000000f2'''),
      ('the teen read the invite to their own address, and no other', 'authenticated', '00000000-0000-4000-8533-0000000000a3', 'c0533-teen@example.com', 'OK 1',
       'select 1 from public.invites where id = ''00000000-0000-4000-8533-0000000000c2'' and family_id = ''00000000-0000-4000-8533-0000000000f1'''),
      ('Olive read her own invite (the join preview)', 'authenticated', olive, 'c0533-olive@example.com', 'OK 1',
       'select 1 from public.invites'),
      ('Ned, invited nowhere, read no invite', 'authenticated', '00000000-0000-4000-8533-0000000000a9', 'c0533-ned@example.com', 'OK 0',
       'select 1 from public.invites'),
      ('the server read all four invites', 'service_role', '', '', 'OK 4',
       'select 1 from public.invites where family_id in (''00000000-0000-4000-8533-0000000000f1'', ''00000000-0000-4000-8533-0000000000f2'')'),
      ('the parent filed an invite and read it back (the invite form)', 'authenticated', parent, 'c0533-parent@example.com', 'OK 1',
       'insert into public.invites (family_id, email, role, invited_by) values (''00000000-0000-4000-8533-0000000000f1'', ''uncle@example.com'', ''adult'', ''00000000-0000-4000-8533-0000000000a1'') returning id'),
      ('the parent revoked Nana''s invite (PendingInvites)', 'authenticated', parent, 'c0533-parent@example.com', 'OK 1',
       'update public.invites set status = ''revoked'' where id = ''00000000-0000-4000-8533-0000000000c1'' and status = ''pending'' returning id')) v(what, role, uid, email, want, stmt) loop
    got := pg_temp.c0533_try(r.role, r.uid, r.email, r.stmt);
    if got is distinct from r.want then
      bad := array_append(bad, format('%s: want %s, got %s', r.what, r.want, got));
    end if;
  end loop;
  -- The teen reads only that one of Invite House's invites.
  got := pg_temp.c0533_try('authenticated', '00000000-0000-4000-8533-0000000000a3', 'c0533-teen@example.com',
    'select 1 from public.invites where family_id = ''00000000-0000-4000-8533-0000000000f1''');
  if installed and got <> 'OK 1' then
    bad := array_append(bad, format('the teen read %s of Invite House''s invites, not only their own', got));
  end if;
  if cardinality(bad) > 0 then
    failures := array_append(failures, 'CONTROL: ' || array_to_string(bad, '; '));
  end if;

  -- 3. Wiring.
  select pg_get_expr(p.polqual, p.polrelid) into qual
    from pg_policy p
   where p.polrelid = 'public.invites'::regclass and p.polname = 'invites_select' and p.polcmd = 'r' and p.polpermissive;
  if qual is distinct from '(can_manage_family(family_id) OR (lower(email) = lower(COALESCE((auth.jwt() ->> ''email''::text), ''''::text))))'
     or (select count(*) from pg_policy p
          where p.polrelid = 'public.invites'::regclass and p.polcmd in ('r', '*') and p.polpermissive) <> 1 then
    failures := array_append(failures, format('0533 is not in place: invites_select is %s', coalesce(qual, 'missing')));
  end if;

  if installed then
    -- N1. invites_select back to is_family_member.
    begin
      drop policy invites_select on public.invites;
      create policy invites_select on public.invites for select
        using (public.is_family_member(family_id) or lower(email) = lower(coalesce(auth.jwt()->>'email','')));
      got := pg_temp.c0533_as('authenticated', child, 'c0533-child@example.com',
        'select token from public.invites where id = ''00000000-0000-4000-8533-0000000000c1''');
      if got <> 'OK 1' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with invites_select back to is_family_member the child still did not read Nana''s invite (%s), so this fixture cannot see the defect', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The invitee's arm dropped.
    begin
      drop policy invites_select on public.invites;
      create policy invites_select on public.invites for select using (public.can_manage_family(family_id));
      got := pg_temp.c0533_as('authenticated', olive, 'c0533-olive@example.com', 'select 1 from public.invites');
      if got <> 'OK 0' then
        failures := array_append(failures, format('MUTATION CONTROL: with the invitee''s arm dropped Olive still read an invite (%s), so 2. cannot catch the join preview going', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'an invite is read by more than its household''s managers and the person invited:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'invites-are-read-by-their-managers: OK (the teen, the child, the caregiver and the guest each read neither Nana''s nor Olive''s invite, nor its token; the parent and the adult read all three of Invite House''s invites and none of Other House''s, the teen reads only the invite to their own address, Olive reads hers and Ned none, the server reads all four, and the parent files an invite and reads it back and revokes one; invites_select is the only permissive read, the managers'' and the invitee''s; negative control: with it back to is_family_member the child read Nana''s invite; mutation control: with the invitee''s arm dropped Olive read none)';
end $$;

rollback;
