-- A guest views the household; it does not rewrite it. (ROLE-M03, 0464)
--
-- The role a parent picks for an extended-family invite is described, on the
-- invite form, on /family/permissions and in the trust engine, as view-only.
-- Before 0464 an active guest could create, edit and delete the family's
-- calendar events, chores, documents, groceries, meals, notes and reminders.
--
-- This probe measures, for each of the eight resources /family/permissions
-- shows, what a guest can actually do (C/R/U/D, one row each, as the guest's
-- own session), and requires it to be view-only (-R--) and, where the page's
-- seeded guest row exists, to equal it. So the page and the database cannot
-- drift apart for this role again in either direction.
--
-- Controls: the parent still creates, reads, edits and deletes each resource,
-- a child still adds a grocery item and a calendar event (0464 narrows the
-- guest, not the household), and the guest still reads every resource.
--
-- Rolled back: nothing here outlives the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-0000000d6711';
  parent uuid := '00000000-0000-4000-8000-0000000d6701';
  child  uuid := '00000000-0000-4000-8000-0000000d6702';
  guest  uuid := '00000000-0000-4000-8000-0000000d6703';
  kidmem uuid;
  list   uuid;
  chore  uuid;
  res    text[] := array['calendar_events', 'chore_assignments', 'chores', 'documents',
                         'grocery_items', 'meals', 'notes', 'reminders'];
  t      text;
  who    uuid;
  seeded uuid;
  n      int;
  got    text;
  shown  text;
  failures int := 0;
  seq    int := 0;
begin
  insert into auth.users (id, email) values
    (parent, 'guest464-parent@example.test'), (child, 'guest464-child@example.test'), (guest, 'guest464-guest@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Guest 0464', parent) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent, 'Parent', 'parent', true), (fam, child, 'Child', 'child', true), (fam, guest, 'Grandma', 'guest', true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;
  select id into kidmem from public.family_members where family_id = fam and user_id = child;
  insert into public.grocery_lists (family_id, name) values (fam, 'Main') returning id into list;
  insert into public.chores (family_id, title) values (fam, 'Seed chore') returning id into chore;

  foreach who in array array[parent, guest] loop
    foreach t in array res loop
      got := '';
      seq := seq + 1;
      perform set_config('request.jwt.claim.sub', who::text, true);
      perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);

      -- C, as the caller
      set local role authenticated;
      begin
        execute case t
          when 'calendar_events'   then format('insert into public.calendar_events (family_id, title, starts_at) values (%L, ''probe'', now())', fam)
          when 'chore_assignments' then format('insert into public.chore_assignments (family_id, chore_id, member_id) values (%L, %L, %L)', fam, chore, kidmem)
          when 'chores'            then format('insert into public.chores (family_id, title) values (%L, ''probe'')', fam)
          when 'documents'         then format('insert into public.documents (family_id, title, storage_path) values (%L, ''probe'', %L)', fam, fam::text || '/probe-c-' || seq || '.pdf')
          when 'grocery_items'     then format('insert into public.grocery_items (family_id, list_id, name) values (%L, %L, ''probe'')', fam, list)
          when 'meals'             then format('insert into public.meals (family_id, name) values (%L, ''probe'')', fam)
          when 'notes'             then format('insert into public.notes (family_id, title) values (%L, ''probe'')', fam)
          when 'reminders'         then format('insert into public.reminders (family_id, title, remind_at) values (%L, ''probe'', now() + interval ''1 day'')', fam)
        end;
        got := got || 'C';
      exception when insufficient_privilege then got := got || '-';
      end;
      reset role;

      -- a row of the family's, written by the server (no session), for R/U/D
      perform set_config('request.jwt.claim.sub', '', true);
      perform set_config('request.jwt.claims', '', true);
      execute case t
        when 'calendar_events'   then format('insert into public.calendar_events (family_id, title, starts_at) values (%L, ''seed'', now()) returning id', fam)
        when 'chore_assignments' then format('insert into public.chore_assignments (family_id, chore_id, member_id) values (%L, %L, %L) returning id', fam, chore, kidmem)
        when 'chores'            then format('insert into public.chores (family_id, title) values (%L, ''seed'') returning id', fam)
        when 'documents'         then format('insert into public.documents (family_id, title, storage_path) values (%L, ''seed'', %L) returning id', fam, fam::text || '/probe-s-' || seq || '.pdf')
        when 'grocery_items'     then format('insert into public.grocery_items (family_id, list_id, name) values (%L, %L, ''seed'') returning id', fam, list)
        when 'meals'             then format('insert into public.meals (family_id, name) values (%L, ''seed'') returning id', fam)
        when 'notes'             then format('insert into public.notes (family_id, title) values (%L, ''seed'') returning id', fam)
        when 'reminders'         then format('insert into public.reminders (family_id, title, remind_at) values (%L, ''seed'', now() + interval ''1 day'') returning id', fam)
      end into seeded;

      perform set_config('request.jwt.claim.sub', who::text, true);
      perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
      set local role authenticated;
      execute format('select count(*) from public.%I where id = %L', t, seeded) into n;
      got := got || case when n = 1 then 'R' else '-' end;
      begin
        execute format('update public.%I set updated_at = now() where id = %L', t, seeded);
        get diagnostics n = row_count;
        got := got || case when n = 1 then 'U' else '-' end;
      exception when insufficient_privilege then got := got || '-';
      end;
      begin
        execute format('delete from public.%I where id = %L', t, seeded);
        get diagnostics n = row_count;
        got := got || case when n = 1 then 'D' else '-' end;
      exception when insufficient_privilege then got := got || '-';
      end;
      reset role;

      if who = parent then
        -- chore_assignments: a manager updates and deletes too (0336 and on)
        if got <> 'CRUD' then
          raise warning 'CONTROL FAILED: the parent can only % on %', got, t;
          failures := failures + 1;
        end if;
      else
        select (case when can_create then 'C' else '-' end) || (case when can_read then 'R' else '-' end)
            || (case when can_update then 'U' else '-' end) || (case when can_delete then 'D' else '-' end)
          into shown
          from public.permissions where role = 'guest' and resource = t;
        -- The rule is view-only (-R--) whether or not the page's rows exist:
        -- public.permissions is filled by supabase/seed.sql, not a migration, so
        -- a freshly bootstrapped database (CI) has none. Where the page does
        -- show a guest row, it must say the same.
        if got <> '-R--' then
          raise warning 'BREACH: a guest can % on % (a guest views the household: -R--)', got, t;
          failures := failures + 1;
        end if;
        if shown is not null and shown <> got then
          raise warning 'DRIFT: /family/permissions shows the parent % for a guest on %, and the database enforces %', shown, t, got;
          failures := failures + 1;
        end if;
      end if;
    end loop;
  end loop;

  -- the household is not narrowed: a child still adds to the list and the calendar
  perform set_config('request.jwt.claim.sub', child::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', child::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.grocery_items (family_id, list_id, name) values (fam, list, 'milk');
    insert into public.calendar_events (family_id, title, starts_at) values (fam, 'Football', now());
  exception when insufficient_privilege then
    raise warning 'REGRESSION: a child can no longer add a grocery item or a calendar event (%)', sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'a guest rewrites the household: % finding(s)', failures;
  end if;
  raise notice 'OK: on all eight resources /family/permissions shows, a guest can do exactly what the page says (read); the parent still creates, edits and deletes each, and a child still adds to the list and the calendar.';
end
$probe$;

rollback;
