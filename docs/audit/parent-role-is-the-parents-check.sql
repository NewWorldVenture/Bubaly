-- Only a parent makes, changes or removes a parent. (SEC-026, migration 0337)
--
-- The role model says a parent has "full control: members, billing, and all
-- household data" and an adult "manages shared household data and approves
-- chores". Parent is not an invitable role, and invite-role-escalation-check
-- proves an invitation cannot be rewritten into one. But fm_insert, fm_update
-- and fm_delete all gate on can_manage_family, which is true for adults too,
-- and put no limit on `role`. So an invited adult could, straight from the
-- browser (the family module even offers it), make themselves a parent, demote
-- the family's parent to a child, or remove them — and as a parent, delete the
-- whole family (families_delete is is_family_admin).
--
--   an adult promotes themselves to parent               -> REFUSED
--   an adult adds a new member as a parent               -> REFUSED
--   an adult demotes the parent                          -> REFUSED
--   an adult deactivates (removes) the parent            -> REFUSED
--   an adult deletes the parent's member row             -> REFUSED
--   an adult edits the parent's row (name)               -> REFUSED
--   an adult adds, edits and removes a child             -> allowed  (control)
--   an adult changes their own role downward             -> allowed  (control)
--   a parent promotes an adult to parent, and back       -> allowed  (control)
--   a family whose only parent stepped down makes one   -> allowed  (control)
--   the service role writes a parent (onboarding)        -> allowed  (control)
--
-- Rolled back: nothing here should outlive the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  parent_uid uuid := '00000000-0000-4000-8000-00000000eb01';
  adult_uid  uuid := '00000000-0000-4000-8000-00000000eb02';
  adult2_uid uuid := '00000000-0000-4000-8000-00000000eb03';
  fam        uuid := '00000000-0000-4000-8000-00000000eb11';
  parent_row uuid;
  adult_row  uuid;
  adult2_row uuid;
  kid_row    uuid;
  n          int;
  failures   int := 0;
begin
  insert into auth.users (id, email) values
    (parent_uid, 'role-parent@example.test'), (adult_uid, 'role-adult@example.test'),
    (adult2_uid, 'role-adult2@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Roles', parent_uid) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, adult_uid, 'Adult', 'adult', true),
    (fam, adult2_uid, 'Adult Two', 'adult', true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = excluded.is_active;
  select id into parent_row from public.family_members where family_id = fam and user_id = parent_uid;
  select id into adult_row  from public.family_members where family_id = fam and user_id = adult_uid;
  select id into adult2_row from public.family_members where family_id = fam and user_id = adult2_uid;

  -- Every attempt below runs as the adult, and undoes its own write (PXUND)
  -- so one success cannot mask the next.
  perform set_config('request.jwt.claims', json_build_object('sub', adult_uid::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- ── 1. self-promotion, and what it unlocks ───────────────────────────────
  begin
    update public.family_members set role = 'parent' where id = adult_row;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: an adult promoted themselves to parent';
      failures := failures + 1;
      if public.is_family_admin(fam) then
        raise warning 'BREACH: ... and now passes is_family_admin, which is what families_delete checks';
        failures := failures + 1;
      end if;
    end if;
    raise exception using errcode = 'PXUND', message = 'undo';
  exception when insufficient_privilege then null; when sqlstate 'PXUND' then null;
  end;

  -- ── 2. minting a parent ──────────────────────────────────────────────────
  begin
    insert into public.family_members (family_id, display_name, role) values (fam, 'New parent', 'parent');
    raise warning 'BREACH: an adult added a member as a parent';
    failures := failures + 1;
    raise exception using errcode = 'PXUND', message = 'undo';
  exception when insufficient_privilege then null; when sqlstate 'PXUND' then null;
  end;

  -- ── 3-6. the parent's own row ────────────────────────────────────────────
  begin
    update public.family_members set role = 'child' where id = parent_row;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: an adult demoted the parent'; failures := failures + 1; end if;
    raise exception using errcode = 'PXUND', message = 'undo';
  exception when insufficient_privilege then null; when sqlstate 'PXUND' then null;
  end;
  begin
    update public.family_members set is_active = false where id = parent_row;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: an adult removed the parent'; failures := failures + 1; end if;
    raise exception using errcode = 'PXUND', message = 'undo';
  exception when insufficient_privilege then null; when sqlstate 'PXUND' then null;
  end;
  begin
    delete from public.family_members where id = parent_row;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: an adult deleted the parent''s member row'; failures := failures + 1; end if;
    raise exception using errcode = 'PXUND', message = 'undo';
  exception when insufficient_privilege then null; when sqlstate 'PXUND' then null;
  end;
  begin
    update public.family_members set display_name = 'Renamed by adult' where id = parent_row;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: an adult edited the parent''s member row'; failures := failures + 1; end if;
    raise exception using errcode = 'PXUND', message = 'undo';
  exception when insufficient_privilege then null; when sqlstate 'PXUND' then null;
  end;

  -- ── CONTROLS, still as the adult ─────────────────────────────────────────
  begin
    insert into public.family_members (family_id, display_name, role) values (fam, 'Kid', 'child') returning id into kid_row;
    update public.family_members set display_name = 'Kiddo', role = 'teen' where id = kid_row;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'edit wrote % rows', n; end if;
    update public.family_members set is_active = false where id = kid_row;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'removal wrote % rows', n; end if;
    update public.family_members set role = 'caregiver' where id = adult2_row;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'editing another adult wrote % rows', n; end if;
    update public.family_members set role = 'teen' where id = adult_row;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'own downgrade wrote % rows', n; end if;
  exception when others then
    reset role;
    raise exception 'CONTROL FAILED: an adult could not manage a non-parent member: %', sqlerrm;
  end;
  reset role;
  update public.family_members set role = 'adult' where id in (adult_row, adult2_row);

  -- ── CONTROL: a parent makes and unmakes a parent ─────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', parent_uid::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update public.family_members set role = 'parent' where id = adult_row;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'promotion wrote % rows', n; end if;
    update public.family_members set role = 'adult' where id = adult_row;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'demotion wrote % rows', n; end if;
    update public.family_members set display_name = 'Parent (renamed)' where id = parent_row;
  exception when others then
    reset role;
    raise exception 'CONTROL FAILED: a parent could not manage parents: %', sqlerrm;
  end;
  reset role;

  -- ── CONTROL: a family whose only parent stepped down can make one ────────
  perform set_config('request.jwt.claims', json_build_object('sub', parent_uid::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.family_members set role = 'adult' where id = parent_row;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', adult_uid::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update public.family_members set role = 'parent' where id = adult_row;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'wrote % rows', n; end if;
  exception when others then
    reset role;
    raise exception 'CONTROL FAILED: a family with no parent could not make one: %', sqlerrm;
  end;
  reset role;
  update public.family_members set role = 'parent' where id = parent_row;
  update public.family_members set role = 'adult' where id = adult_row;

  -- ── CONTROL: the server writes a parent ──────────────────────────────────
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  begin
    update public.family_members set role = 'parent' where id = adult2_row;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'wrote % rows', n; end if;
  exception when others then
    reset role;
    raise exception 'CONTROL FAILED: the service role could not write a parent: %', sqlerrm;
  end;
  reset role;

  if failures > 0 then
    raise exception 'BREACH: % way(s) a non-parent made, changed or removed a parent', failures;
  end if;
  raise notice 'OK: only a parent makes, changes or removes a parent; adults still manage everyone else.';
end
$probe$;

rollback;
