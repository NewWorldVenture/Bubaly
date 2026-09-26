-- Behavioural proof for 0382: two first captures at once give a family ONE
-- default list, not two (DATA-007).
--
-- The race is made deterministic rather than hoped for. A holder session takes
-- ACCESS EXCLUSIVE on grocery_lists, so any read of the table waits. Two racer
-- sessions then call get-or-create at the same moment:
--
--   * with 0382's function, the first racer takes the per-family advisory lock
--     and waits on the table; the second waits on the ADVISORY lock. Released,
--     the first reads nothing and inserts, commits, and only then does the
--     second read — and finds the first one's list.
--   * with the same function minus the advisory lock (the negative control),
--     both racers wait on the table, both then read "no list", and both insert:
--     two lists, which is the defect as shipped.
--
-- Both stages run the SAME race, or the control proves nothing about the probe.
-- dblink opens the sessions; where it is unavailable the race SKIPS, loudly.
--
-- Also asserted, without a race: RLS still decides (a non-member is refused,
-- a member gets the family's list), the call is idempotent, an archived list
-- is not the default, and the to-do twin behaves the same.

create extension if not exists dblink;

-- Re-runnable: the suite is run twice against one database.
delete from public.grocery_lists  where family_id in ('ab820000-0000-4000-8000-0000000000f1', 'ab820000-0000-4000-8000-0000000000f2', 'ab820000-0000-4000-8000-0000000000f3');
delete from public.todo_lists     where family_id = 'ab820000-0000-4000-8000-0000000000f1';
delete from public.family_members where user_id in ('ab820000-0000-4000-8000-000000000001', 'ab820000-0000-4000-8000-000000000002');
delete from public.families       where id in ('ab820000-0000-4000-8000-0000000000f1', 'ab820000-0000-4000-8000-0000000000f2', 'ab820000-0000-4000-8000-0000000000f3');

insert into public.families (id, name) values
  ('ab820000-0000-4000-8000-0000000000f1', 'One List'),
  ('ab820000-0000-4000-8000-0000000000f2', 'One List (race, control)'),
  ('ab820000-0000-4000-8000-0000000000f3', 'One List (race, 0382)');
insert into auth.users (id, email) values
  ('ab820000-0000-4000-8000-000000000001', 'onelist-p@example.test'),
  ('ab820000-0000-4000-8000-000000000002', 'onelist-o@example.test')
  on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('ab820000-0000-4000-8000-0000000000f1', 'ab820000-0000-4000-8000-000000000001', 'Parent', 'parent', true);

-- The negative control's function: 0382's body with the advisory lock removed,
-- asserted to differ from the real one in exactly that.
create or replace function public.dl_probe_no_lock(p_family_id uuid) returns uuid
language plpgsql as $fn$
declare v_id uuid;
begin
  select id into v_id from public.grocery_lists
   where family_id = p_family_id and is_archived = false and archived_at is null
   order by created_at asc, id asc limit 1;
  if v_id is not null then return v_id; end if;
  insert into public.grocery_lists (family_id, name) values (p_family_id, 'Groceries') returning id into v_id;
  return v_id;
end $fn$;

-- The real function behind the same one-argument call the race dispatches.
create or replace function public.dl_probe_with_lock(p_family_id uuid) returns uuid
language sql as $fn$ select public.ensure_default_grocery_list(p_family_id, 'Groceries', null) $fn$;

create or replace procedure public.dl_probe_race(p_call text, p_family uuid, inout p_outcome text)
language plpgsql as $proc$
declare
  v_conn text := 'dbname=' || current_database()
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
    || ' port=' || current_setting('port')
    || ' user=' || current_user;
  waiters int := 0; seen int := 0; waited_ms int := 0;
begin
  perform dblink_connect('dl_hold', v_conn || ' application_name=dl_holder');
  perform dblink_exec('dl_hold', 'begin');
  -- Never hang the suite: a holder that cannot get its lock fails in 5s.
  perform dblink_exec('dl_hold', 'set local lock_timeout = ''5s''');
  perform dblink_exec('dl_hold', 'lock table public.grocery_lists in access exclusive mode');

  perform dblink_connect('dl_a', v_conn || ' application_name=dl_racer');
  perform dblink_connect('dl_b', v_conn || ' application_name=dl_racer');
  perform dblink_send_query('dl_a', format('select %s(%L)::text', p_call, p_family));
  perform dblink_send_query('dl_b', format('select %s(%L)::text', p_call, p_family));

  while waited_ms < 10000 loop
    select count(*) into waiters from pg_stat_activity
     where application_name = 'dl_racer' and wait_event_type = 'Lock';
    if waiters > seen then seen := waiters; end if;
    exit when seen >= 2;
    perform pg_sleep(0.05);
    waited_ms := waited_ms + 50;
  end loop;

  perform dblink_exec('dl_hold', 'commit');
  perform dblink_disconnect('dl_hold');
  perform * from dblink_get_result('dl_a') as t(v text);
  perform * from dblink_get_result('dl_a') as t(v text);
  perform * from dblink_get_result('dl_b') as t(v text);
  perform * from dblink_get_result('dl_b') as t(v text);
  perform dblink_disconnect('dl_a');
  perform dblink_disconnect('dl_b');

  p_outcome := case when seen >= 2 then 'raced' else 'not-raced:' || seen end;
exception when others then
  begin perform dblink_disconnect('dl_hold'); exception when others then null; end;
  begin perform dblink_disconnect('dl_a');    exception when others then null; end;
  begin perform dblink_disconnect('dl_b');    exception when others then null; end;
  raise;
end $proc$;

do $$
declare
  fam   uuid := 'ab820000-0000-4000-8000-0000000000f1';
  first uuid; again uuid; archived uuid; todo_a uuid; todo_b uuid; named uuid;
  n int;
  refused boolean;
  outcome text := '';
  fails text[] := '{}';
begin
  -- 0. The shape: both functions exist, run as the CALLER, and are not anon's.
  if (select prosecdef from pg_proc where oid = 'public.ensure_default_grocery_list(uuid,text,uuid)'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'public.ensure_default_todo_list(uuid,text,boolean,uuid)'::regprocedure) then
    fails := fails || 'a default-list function is SECURITY DEFINER — it would bypass RLS'::text;
  end if;
  if has_function_privilege('anon', 'public.ensure_default_grocery_list(uuid,text,uuid)', 'execute') then
    fails := fails || 'anon can call ensure_default_grocery_list'::text;
  end if;
  if position('pg_advisory_xact_lock' in (select prosrc from pg_proc where oid = 'public.ensure_default_grocery_list(uuid,text,uuid)'::regprocedure)) = 0 then
    fails := fails || 'ensure_default_grocery_list takes no advisory lock — nothing serialises it'::text;
  end if;

  -- 1. As a member: one list, the same one every time.
  perform set_config('request.jwt.claim.sub', 'ab820000-0000-4000-8000-000000000001', true);
  set local role authenticated;
  first := public.ensure_default_grocery_list(fam, 'Groceries', 'ab820000-0000-4000-8000-000000000001');
  again := public.ensure_default_grocery_list(fam, 'Groceries', 'ab820000-0000-4000-8000-000000000001');
  if first is null or first <> again then fails := fails || 'a second call did not return the family''s list'::text; end if;

  -- 2. An archived list is not the default: archive it, and a new one is made.
  update public.grocery_lists set archived_at = now() where id = first;
  archived := public.ensure_default_grocery_list(fam, 'Groceries', 'ab820000-0000-4000-8000-000000000001');
  if archived = first then fails := fails || 'an archived list was handed back as the default'::text; end if;

  -- 3. The to-do twin: default and named lists, each once.
  todo_a := public.ensure_default_todo_list(fam, 'To-Do', false, null);
  todo_b := public.ensure_default_todo_list(fam, 'To-Do', false, null);
  named  := public.ensure_default_todo_list(fam, 'School', true, null);
  if todo_a <> todo_b then fails := fails || 'the default to-do list was created twice'::text; end if;
  if named = todo_a then fails := fails || 'a NAMED to-do list resolved to the default one'::text; end if;
  if public.ensure_default_todo_list(fam, 'School', true, null) <> named then
    fails := fails || 'the named to-do list was created twice'::text;
  end if;
  reset role;

  -- 4. A non-member is refused by the table's own RLS, not waved through.
  perform set_config('request.jwt.claim.sub', 'ab820000-0000-4000-8000-000000000002', true);
  set local role authenticated;
  refused := false;
  begin
    perform public.ensure_default_grocery_list(fam, 'Groceries', 'ab820000-0000-4000-8000-000000000002');
  exception when insufficient_privilege then refused := true;
  end;
  reset role;
  if not refused then fails := fails || 'a non-member created a list in another family'::text; end if;

  if array_length(fails, 1) is not null then
    raise exception 'a family gets one default list: %', array_to_string(fails, ' | ');
  end if;
end $$;

-- 5. The race, twice: the lock-less control, then the real function. Each in
--    its OWN transaction and its own family: anything the calling session has
--    read or written on grocery_lists stays locked until it commits, and the
--    holder's ACCESS EXCLUSIVE would then wait on the probe itself.
do $$
declare
  outcome text;
  n       int;
begin
  call public.dl_probe_race('public.dl_probe_no_lock', 'ab820000-0000-4000-8000-0000000000f2', outcome);
  if outcome <> 'raced' then
    raise notice 'SKIP: the race did not happen (%), so the control proves nothing', outcome;
    return;
  end if;
  select count(*) into n from public.grocery_lists
   where family_id = 'ab820000-0000-4000-8000-0000000000f2' and archived_at is null;
  if n <> 2 then
    raise exception 'negative control did not reproduce the defect: the lock-less get-or-create made % list(s), not 2 — this probe cannot see a race', n;
  end if;
  raise notice 'control: the lock-less get-or-create made 2 default lists under the same race';
end $$;

do $$
declare
  outcome text;
  n       int;
begin
  call public.dl_probe_race('public.dl_probe_with_lock', 'ab820000-0000-4000-8000-0000000000f3', outcome);
  if outcome <> 'raced' then
    raise notice 'SKIP: the race did not happen against 0382 (%)', outcome;
    return;
  end if;
  select count(*) into n from public.grocery_lists
   where family_id = 'ab820000-0000-4000-8000-0000000000f3' and archived_at is null;
  if n <> 1 then
    raise exception 'two first captures at once made % default lists — 0382 does not serialise get-or-create', n;
  end if;
  raise notice 'OK  a family gets one default list: two racing first captures made 1 (the lock-less control made 2); RLS still decides, archived lists are not the default, and the to-do twin holds';
end $$;

drop procedure if exists public.dl_probe_race(text, uuid, text);
drop function if exists public.dl_probe_no_lock(uuid);
drop function if exists public.dl_probe_with_lock(uuid);
