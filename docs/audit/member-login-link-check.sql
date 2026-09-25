-- A family manager cannot link someone else's login to a member row. (SEC-025, migration 0335)
--
-- `family_members.user_id` is what makes a row a person's membership. The RLS
-- policies let a family's parent or adult insert and update member rows in
-- their own family — every column of them, user_id included. So any account
-- (every account is the parent of the family it made) could write a
-- stranger's user id into its own family and:
--
--   read the stranger's profile — email, full name, date of birth, phone —
--   through `profiles_select_self`, which shows co-members to each other;
--   and put a family the stranger never joined into their family switcher.
--
-- A user id is not a secret: the feedback board shows every idea's author_id
-- and every vote's user_id to any signed-in account.
--
-- Nothing in the app writes user_id from the browser. Logins are linked by the
-- server (child logins, admin tools, onboarding) and by the database's own
-- functions (accept_invite, handle_new_family, ensure_family_for_user).
--
--   a manager inserts a member row carrying another user's id -> REFUSED
--   a manager relinks an existing member row to another user   -> REFUSED
--   ... so the other user's profile stays unreadable           -> REFUSED
--   a manager unlinks a co-parent's login from their row        -> REFUSED
--   a manager adds, edits and removes members                   -> allowed  (control)
--   creating a family makes its creator a member                -> allowed  (control)
--   the service role links a child login                        -> allowed  (control)
--
-- Rolled back: nothing here should outlive the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  attacker uuid := '00000000-0000-4000-8000-00000000e601';
  victim   uuid := '00000000-0000-4000-8000-00000000e602';
  coparent uuid := '00000000-0000-4000-8000-00000000e603';
  kidlogin uuid := '00000000-0000-4000-8000-00000000e604';
  fam_a    uuid := '00000000-0000-4000-8000-00000000e611';
  fam_v    uuid := '00000000-0000-4000-8000-00000000e612';
  kid      uuid := '00000000-0000-4000-8000-00000000e621';
  coparent_row uuid;
  new_member uuid;
  new_family uuid;
  n        int;
  failures int := 0;
begin
  insert into auth.users (id, email) values
    (attacker, 'link-attacker@example.test'), (victim, 'link-victim@example.test'),
    (coparent, 'link-coparent@example.test'), (kidlogin, 'link-kid@example.test')
  on conflict (id) do nothing;
  insert into public.profiles (id, email, full_name, phone, date_of_birth)
  values (victim, 'link-victim@example.test', 'Victim Person', '+15550100', '1990-01-01')
  on conflict (id) do update set email = excluded.email, full_name = excluded.full_name,
    phone = excluded.phone, date_of_birth = excluded.date_of_birth;
  insert into public.families (id, name, created_by) values (fam_a, 'Attacker', attacker), (fam_v, 'Victim', victim)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam_a, attacker, 'Attacker', 'parent', true),
    (fam_a, coparent, 'Co-parent', 'parent', true),
    (fam_v, victim, 'Victim', 'parent', true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = excluded.is_active;
  insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (kid, fam_a, null, 'Kid', 'child', true)
  on conflict (id) do update set user_id = null;
  select id into coparent_row from public.family_members where family_id = fam_a and user_id = coparent;

  perform set_config('request.jwt.claims', json_build_object('sub', attacker::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- The premise: before anything is written, the victim's profile is private.
  select count(*) into n from public.profiles where id = victim;
  if n <> 0 then
    raise exception 'PREMISE FAILED: the attacker can already read the victim''s profile (fixture shares a family?)';
  end if;

  -- Each breach undoes its own write (PXUND), so one success does not mask the
  -- next, and each checks what the planted link exposes while it is in place.

  -- ── 1. insert a member row that carries the victim's login ───────────────
  begin
    insert into public.family_members (family_id, user_id, display_name, role)
    values (fam_a, victim, 'Planted', 'child');
    raise warning 'BREACH: a manager inserted a member row carrying another user''s login';
    failures := failures + 1;
    select count(*) into n from public.profiles where id = victim;
    if n <> 0 then
      raise warning 'BREACH: ... and through it read the victim''s profile (email, name, birth date, phone)';
      failures := failures + 1;
    end if;
    raise exception using errcode = 'PXUND', message = 'undo';
  exception
    when insufficient_privilege then null;
    when sqlstate 'PXUND' then null;
  end;

  -- ── 2. relink an existing member row to the victim ───────────────────────
  begin
    update public.family_members set user_id = victim where id = kid;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a manager relinked a member row to another user''s login';
      failures := failures + 1;
      select count(*) into n from public.profiles where id = victim;
      if n <> 0 then
        raise warning 'BREACH: ... and through it read the victim''s profile';
        failures := failures + 1;
      end if;
    end if;
    raise exception using errcode = 'PXUND', message = 'undo';
  exception
    when insufficient_privilege then null;
    when sqlstate 'PXUND' then null;
  end;

  -- ── 3. nothing was left behind: the victim's profile is private again ────
  select count(*) into n from public.profiles where id = victim;
  if n <> 0 then
    raise warning 'BREACH: the victim''s profile is still readable after the attempts';
    failures := failures + 1;
  end if;

  -- ── 4. unlink a co-parent's login from their own row ─────────────────────
  begin
    update public.family_members set user_id = null where id = coparent_row;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a manager unlinked a co-parent''s login from their member row';
      failures := failures + 1;
    end if;
    raise exception using errcode = 'PXUND', message = 'undo';
  exception
    when insufficient_privilege then null;
    when sqlstate 'PXUND' then null;
  end;

  -- ── CONTROLS: managing members still works ───────────────────────────────
  begin
    insert into public.family_members (family_id, display_name, role)
    values (fam_a, 'New kid', 'child') returning id into new_member;
    update public.family_members set display_name = 'Renamed', role = 'teen', birthday = '2012-05-01' where id = new_member;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'edit wrote % rows', n; end if;
    update public.family_members set is_active = false where id = new_member;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'removal wrote % rows', n; end if;
    -- An update that repeats the row's own login is not a relink.
    update public.family_members set user_id = coparent, display_name = 'Co-parent' where id = coparent_row;
  exception when others then
    reset role;
    raise exception 'CONTROL FAILED: a manager could not add, edit or remove a member: %', sqlerrm;
  end;

  begin
    -- No RETURNING: the new row is not visible to its creator until the
    -- membership trigger has run, and RETURNING checks visibility first.
    new_family := gen_random_uuid();
    insert into public.families (id, name, created_by) values (new_family, 'Second family', attacker);
  exception when others then
    reset role;
    raise exception 'CONTROL FAILED: a user could not create a family: %', sqlerrm;
  end;
  reset role;
  if not exists (select 1 from public.family_members where family_id = new_family and user_id = attacker and role = 'parent') then
    raise exception 'CONTROL FAILED: creating a family did not make its creator a member';
  end if;

  -- The server links a child login with the service role.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  begin
    update public.family_members set user_id = kidlogin where id = kid;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'wrote % rows', n; end if;
  exception when others then
    reset role;
    raise exception 'CONTROL FAILED: the service role could not link a child login: %', sqlerrm;
  end;
  reset role;

  if failures > 0 then
    raise exception 'BREACH: % way(s) to link or unlink a login from the browser', failures;
  end if;
  raise notice 'OK: only the server and the database''s own functions link a login to a member; managing members still works.';
end
$probe$;

rollback;
