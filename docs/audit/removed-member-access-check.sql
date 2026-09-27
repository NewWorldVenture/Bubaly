-- Does removing someone from a family actually remove them?
--
-- Removing a member is `family_members.update({ is_active: false })` — the row
-- stays, so history keeps its author. The helpers most policies use
-- (is_family_member, can_manage_family) require `is_active`. Ten tables carry
-- an older policy written out longhand instead:
--
--   family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid())
--
-- with no `is_active`. Today that is still safe, and only for a reason the
-- policy does not state: the subquery reads family_members under the caller's
-- own RLS, and fm_select is `is_family_member(family_id)`, so a removed
-- member cannot see even their own row and the subquery comes back empty.
--
-- That makes fm_select load-bearing for messages, photos, contacts,
-- reminders, recipes, albums, the family tree and every to-do list. A policy
-- as natural as "a user can see their own membership rows" (for an account
-- page, a leave-family flow) would hand all ten back to every former partner
-- or ended caregiver with a live session. Calibrated: adding exactly that
-- policy fails this probe 22 times.
--
-- Control first (the member really could read while active), then the same
-- member deactivated. Judged on row counts: a refused read or write raises
-- nothing, it just matches zero rows.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam   uuid := '00000000-0000-4000-8000-00000000ed01';
  uPar  uuid := '00000000-0000-4000-8000-00000000ed0a';
  uEx   uuid := '00000000-0000-4000-8000-00000000ed0b';
  mEx   uuid;
  conv  uuid; list uuid;
  t     text;
  tbls  text[] := array['family_albums','family_contacts','family_conversations','family_messages',
                        'family_photos','family_recipes','family_reminders','family_tree_nodes',
                        'todo_lists','todo_items'];
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'removed-parent@example.com'), (uEx, 'removed-member@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Removal family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uEx, 'Former partner', 'adult', true) returning id into mEx;

  insert into public.family_albums (family_id, name) values (fam, 'Holidays');
  insert into public.family_contacts (family_id, name) values (fam, 'Pediatrician');
  insert into public.family_conversations (family_id) values (fam) returning id into conv;
  insert into public.family_messages (family_id, conversation_id) values (fam, conv);
  insert into public.family_photos (family_id, storage_path) values (fam, fam || '/beach.jpg');
  insert into public.family_recipes (family_id, name) values (fam, 'Pancakes');
  insert into public.family_reminders (family_id, title) values (fam, 'School pickup 3pm');
  insert into public.family_tree_nodes (family_id, name) values (fam, 'Grandma');
  insert into public.todo_lists (family_id, name) values (fam, 'Groceries') returning id into list;
  insert into public.todo_items (family_id, list_id, title) values (fam, list, 'Milk');

  perform set_config('request.jwt.claim.sub', uEx::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uEx, 'role', 'authenticated')::text, true);

  -- Control: while active, every table is readable.
  set local role authenticated;
  foreach t in array tbls loop
    execute format('select count(*) from public.%I where family_id = $1', t) into n using fam;
    if n <> 1 then
      raise warning 'CONTROL FAILED: an active member cannot read % (rows: %)', t, n;
      failures := failures + 1;
    end if;
  end loop;
  reset role;

  -- Remove them the way the app does.
  update public.family_members set is_active = false where id = mEx;

  set local role authenticated;
  foreach t in array tbls loop
    execute format('select count(*) from public.%I where family_id = $1', t) into n using fam;
    if n <> 0 then
      raise warning 'BREACH: a removed member still reads % (rows: %)', t, n;
      failures := failures + 1;
    end if;
    execute format('update public.%I set family_id = family_id where family_id = $1', t) using fam;
    get diagnostics n = row_count;
    if n <> 0 then
      raise warning 'BREACH: a removed member still writes % (rows: %)', t, n;
      failures := failures + 1;
    end if;
  end loop;

  -- And adds to it.
  begin
    insert into public.family_reminders (family_id, title) values (fam, 'Inserted after removal');
    raise warning 'BREACH: a removed member still inserts into family_reminders';
    failures := failures + 1;
  exception when insufficient_privilege then null;
  end;

  -- And deletes from it.
  delete from public.family_photos where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then
    raise warning 'BREACH: a removed member still deletes family_photos (rows: %)', n;
    failures := failures + 1;
  end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uEx);

  if failures > 0 then
    raise exception 'removed-member-access-check: % failure(s)', failures;
  end if;
  raise notice 'removed-member-access-check: a removed member reaches none of the ten tables';
end
$probe$;
