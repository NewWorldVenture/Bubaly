-- Two distinct meal-plan requests replacing one slot must serialize before the
-- first transaction commits. Both calls must complete, the second must observe
-- and replace the first row, and the slot must finish with exactly one row.
--
-- The test holds the first RPC's transaction open, starts the second RPC over a
-- separate dblink session, and observes that session waiting on the exact
-- family/date/type advisory lock before it commits the holder. It never relies
-- on timing alone. All fixtures use fresh synthetic UUIDs and are removed before
-- this probe returns, including after an RPC or dblink error.

\set ON_ERROR_STOP on
set client_min_messages = warning;

create extension if not exists dblink;
-- On plain PostgreSQL, default privileges may expose dblink's SECURITY DEFINER
-- helpers to client roles. Remove only grants owned by this probe's current
-- user; hosted Supabase's extension owner and client grants stay untouched.
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    join pg_extension e on e.oid = d.refobjid
    where e.extname = 'dblink'
      and p.proowner = (select oid from pg_roles where rolname = current_user)
      and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

create temp table meal_replace_race_verdict (
  ok boolean not null,
  detail text not null
);

-- Seed and commit synthetic rows before the dblink sessions begin; their writes
-- must be visible to both RPC calls. Session GUCs carry generated ids to the
-- race and cleanup blocks without putting stable fixture ids in the database.
do $seed$
declare
  v_family uuid := gen_random_uuid();
  v_actor uuid := gen_random_uuid();
  v_meal_a uuid := gen_random_uuid();
  v_meal_b uuid := gen_random_uuid();
  v_request_a text := 'meal-race-a-' || gen_random_uuid()::text;
  v_request_b text := 'meal-race-b-' || gen_random_uuid()::text;
begin
  perform set_config('bubaly.meal_race.family', v_family::text, false);
  perform set_config('bubaly.meal_race.actor', v_actor::text, false);
  perform set_config('bubaly.meal_race.meal_a', v_meal_a::text, false);
  perform set_config('bubaly.meal_race.meal_b', v_meal_b::text, false);
  perform set_config('bubaly.meal_race.request_a', v_request_a, false);
  perform set_config('bubaly.meal_race.request_b', v_request_b, false);
  perform set_config('bubaly.meal_race.plan_date', (current_date + 1)::text, false);

  insert into auth.users (id, email)
  values (v_actor, 'meal-race-' || replace(v_actor::text, '-', '') || '@example.test');
  insert into public.families (id, name, created_by)
  values (v_family, 'Synthetic meal replacement race', v_actor);
  -- Full migration replay runs 0003's on_family_created trigger, which already
  -- inserts the creator as a family member. Keep this seed idempotent when that
  -- provisioner has already created the same membership.
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (v_family, v_actor, 'Race Parent', 'parent', true)
  on conflict do nothing;
  insert into public.meals (id, family_id, name, meal_type, ingredients)
  values
    (v_meal_a, v_family, 'Synthetic race meal A', 'dinner', '[]'::jsonb),
    (v_meal_b, v_family, 'Synthetic race meal B', 'dinner', '[]'::jsonb);
end
$seed$;

do $probe$
declare
  v_family uuid := current_setting('bubaly.meal_race.family')::uuid;
  v_actor uuid := current_setting('bubaly.meal_race.actor')::uuid;
  v_meal_a uuid := current_setting('bubaly.meal_race.meal_a')::uuid;
  v_meal_b uuid := current_setting('bubaly.meal_race.meal_b')::uuid;
  v_request_a text := current_setting('bubaly.meal_race.request_a');
  v_request_b text := current_setting('bubaly.meal_race.request_b');
  v_plan_date date := current_setting('bubaly.meal_race.plan_date')::date;
  v_entries_a jsonb;
  v_entries_b jsonb;
  v_conn text := 'dbname=' || current_database()
    || ' host=' || coalesce(nullif(split_part(current_setting('unix_socket_directories'), ',', 1), ''), '127.0.0.1')
    || ' port=' || current_setting('port')
    || ' user=' || current_user || ' connect_timeout=5';
  v_app_a text := 'meal_replace_a_' || replace(current_setting('bubaly.meal_race.family'), '-', '');
  v_app_b text := 'meal_replace_b_' || replace(current_setting('bubaly.meal_race.family'), '-', '');
  v_lock_key bigint;
  v_a_pid integer;
  v_b_pid integer;
  v_result_a jsonb;
  v_result_b jsonb;
  v_a_connected boolean := false;
  v_b_connected boolean := false;
  v_a_in_transaction boolean := false;
  v_b_query_sent boolean := false;
  v_a_holds_slot boolean := false;
  v_b_rpc_started boolean := false;
  v_b_pid_visible boolean := false;
  v_b_application_matches boolean := false;
  v_b_query_prefix_matches boolean := false;
  v_b_waited_on_slot boolean := false;
  v_observe_deadline timestamptz;
  v_b_state text;
  v_b_wait_event_type text;
  v_b_wait_event text;
  v_b_observer_detail text;
  v_sent integer;
  v_final_count integer := 0;
  v_final_meals uuid[];
  v_receipt_count integer := 0;
  v_ok boolean := false;
  v_detail text;
  v_error text;
begin
  if v_request_a = v_request_b then
    raise exception 'generated race requests are not distinct';
  end if;

  v_entries_a := jsonb_build_array(jsonb_build_object(
    'plan_date', v_plan_date::text, 'meal_type', 'dinner', 'meal_id', v_meal_a));
  v_entries_b := jsonb_build_array(jsonb_build_object(
    'plan_date', v_plan_date::text, 'meal_type', 'dinner', 'meal_id', v_meal_b));
  v_lock_key := hashtextextended(
    'meal-plan-slot:' || v_family::text || ':' || v_plan_date::text || ':dinner', 0);

  perform dblink_connect('meal_replace_a', v_conn || ' application_name=' || v_app_a);
  v_a_connected := true;
  select t.pid into v_a_pid
  from dblink('meal_replace_a', 'select pg_backend_pid()') as t(pid integer);
  if v_a_pid is null then
    raise exception 'first dblink backend PID could not be captured';
  end if;
  perform dblink_exec('meal_replace_a', format('set "request.jwt.claim.sub" = %L', v_actor::text));
  perform dblink_exec('meal_replace_a', 'set role authenticated');
  perform dblink_exec('meal_replace_a', 'set statement_timeout = ''20s''');
  perform dblink_exec('meal_replace_a', 'begin');
  v_a_in_transaction := true;

  select t.result into v_result_a
  from dblink('meal_replace_a', format(
    'select public.meal_plan_replace_slots(%L::uuid, %L, %L::jsonb)',
    v_family::text, v_request_a, v_entries_a::text)) as t(result jsonb);

  -- The first RPC must still hold this exact transaction-scoped advisory key
  -- when it returns but before we commit its explicit dblink transaction.
  -- pg_stat_activity is transaction-cached by default, so refresh before each
  -- observation to avoid hiding sessions that connected after an earlier read.
  perform pg_stat_clear_snapshot();
  select exists (
    select 1
    from pg_locks l join pg_stat_activity sa on sa.pid = l.pid
    where l.pid = v_a_pid and sa.application_name = v_app_a
      and l.locktype = 'advisory' and l.granted and l.objsubid = 1
      and l.classid::bigint = ((v_lock_key >> 32) & 4294967295::bigint)
      and l.objid::bigint = (v_lock_key & 4294967295::bigint)
      and l.database = (select oid from pg_database where datname = current_database())
  ) into v_a_holds_slot;

  perform dblink_connect('meal_replace_b', v_conn || ' application_name=' || v_app_b);
  v_b_connected := true;
  select t.pid into v_b_pid
  from dblink('meal_replace_b', 'select pg_backend_pid()') as t(pid integer);
  if v_b_pid is null then
    raise exception 'second dblink backend PID could not be captured';
  end if;
  perform dblink_exec('meal_replace_b', format('set "request.jwt.claim.sub" = %L', v_actor::text));
  perform dblink_exec('meal_replace_b', 'set role authenticated');
  perform dblink_exec('meal_replace_b', 'set statement_timeout = ''20s''');
  v_sent := dblink_send_query('meal_replace_b', format(
    'select public.meal_plan_replace_slots(%L::uuid, %L, %L::jsonb)',
    v_family::text, v_request_b, v_entries_b::text));
  if v_sent <> 1 then
    raise exception 'second RPC could not be dispatched over its independent session';
  end if;
  v_b_query_sent := true;

  -- dblink_send_query only confirms dispatch, not that the remote backend has
  -- started executing. First observe this exact backend running the RPC; keep
  -- a separate deadline so delayed dispatch is reported as B-not-started.
  v_observe_deadline := clock_timestamp() + interval '10 seconds';
  loop
    perform pg_stat_clear_snapshot();
    select sa.application_name = v_app_b,
           sa.state,
           sa.wait_event_type,
           sa.wait_event,
           left(lower(coalesce(sa.query, '')), length('select public.meal_plan_replace_slots('))
             = 'select public.meal_plan_replace_slots('
      into v_b_application_matches, v_b_state, v_b_wait_event_type,
           v_b_wait_event, v_b_query_prefix_matches
    from pg_stat_activity sa
    where sa.pid = v_b_pid;
    v_b_pid_visible := found;
    if not v_b_pid_visible then
      v_b_application_matches := false;
      v_b_state := null;
      v_b_wait_event_type := null;
      v_b_wait_event := null;
      v_b_query_prefix_matches := false;
    end if;
    -- This dedicated connection has no other query outstanding; PID + app
    -- identity + active state is the start gate. Query text is diagnostic only.
    v_b_rpc_started := v_b_pid_visible
      and coalesce(v_b_application_matches, false)
      and coalesce(v_b_state = 'active', false);
    exit when v_b_rpc_started or clock_timestamp() >= v_observe_deadline;
    perform pg_sleep(0.01);
  end loop;

  -- Once B's dedicated backend is active, require it to wait on the exact hashed
  -- advisory key held by A. pg_blocking_pids ties the pending lock to A's
  -- stable backend PID instead of inferring contention from timing alone.
  if v_b_rpc_started then
    v_observe_deadline := clock_timestamp() + interval '10 seconds';
    loop
      perform pg_stat_clear_snapshot();
      select exists (
        select 1
        from pg_locks l join pg_stat_activity sa on sa.pid = l.pid
        where l.pid = v_b_pid and sa.application_name = v_app_b
          and sa.state = 'active'
          and sa.wait_event_type = 'Lock' and sa.wait_event = 'advisory'
          and l.locktype = 'advisory' and not l.granted and l.objsubid = 1
          and l.classid::bigint = ((v_lock_key >> 32) & 4294967295::bigint)
          and l.objid::bigint = (v_lock_key & 4294967295::bigint)
          and l.database = (select oid from pg_database where datname = current_database())
          and v_a_pid = any(pg_blocking_pids(v_b_pid))
      ) into v_b_waited_on_slot;
      exit when v_b_waited_on_slot or clock_timestamp() >= v_observe_deadline;
      perform pg_sleep(0.01);
    end loop;
  end if;

  -- Refresh sanitized metadata before releasing A. Do not log the PID, app
  -- name, or full query; the booleans and state fields distinguish a missing
  -- backend from a query-prefix mismatch or an RPC waiting elsewhere.
  perform pg_stat_clear_snapshot();
  select sa.application_name = v_app_b,
         sa.state,
         sa.wait_event_type,
         sa.wait_event,
         left(lower(coalesce(sa.query, '')), length('select public.meal_plan_replace_slots('))
           = 'select public.meal_plan_replace_slots('
    into v_b_application_matches, v_b_state, v_b_wait_event_type,
         v_b_wait_event, v_b_query_prefix_matches
  from pg_stat_activity sa
  where sa.pid = v_b_pid;
  v_b_pid_visible := found;
  if not v_b_pid_visible then
    v_b_application_matches := false;
    v_b_state := null;
    v_b_wait_event_type := null;
    v_b_wait_event := null;
    v_b_query_prefix_matches := false;
  end if;
  v_b_observer_detail := format(
    'B startup gate matched=%s; B-not-started-within-window=%s; pid_visible=%s; app_matches=%s; state=%s; wait_event_type=%s; wait_event=%s; RPC-prefix-matched=%s',
    v_b_rpc_started, not v_b_rpc_started, v_b_pid_visible,
    coalesce(v_b_application_matches, false), coalesce(v_b_state, '<missing>'),
    coalesce(v_b_wait_event_type, '<none>'), coalesce(v_b_wait_event, '<none>'),
    coalesce(v_b_query_prefix_matches, false));

  perform dblink_exec('meal_replace_a', 'commit');
  v_a_in_transaction := false;

  select t.result into v_result_b
  from dblink_get_result('meal_replace_b') as t(result jsonb);
  perform * from dblink_get_result('meal_replace_b') as t(result jsonb);
  v_b_query_sent := false;

  perform dblink_disconnect('meal_replace_a');
  v_a_connected := false;
  perform dblink_disconnect('meal_replace_b');
  v_b_connected := false;

  select count(*), array_agg(p.meal_id)
    into v_final_count, v_final_meals
    from public.meal_plans p
   where p.family_id = v_family and p.plan_date = v_plan_date and p.meal_type = 'dinner';
  select count(*) into v_receipt_count
    from public.meal_plan_write_receipts r
   where r.family_id = v_family and r.actor_id = v_actor
     and r.request_id in (v_request_a, v_request_b);

  v_ok := v_a_holds_slot
      and v_b_rpc_started
      and v_b_waited_on_slot
      and v_result_a is not null and v_result_a->>'replayed' = 'false'
      and (v_result_a->>'replaced')::integer = 0
      and v_result_b is not null and v_result_b->>'replayed' = 'false'
      and (v_result_b->>'replaced')::integer = 1
      and v_final_count = 1
      and v_final_meals[1] = v_meal_b
      and v_receipt_count = 2;
  v_detail := format(
    'A held slot key=%s; %s; B waited on A exact slot advisory=%s; A replaced=%s; B replaced=%s; final rows=%s; final meal is B=%s; distinct receipts=%s',
    v_a_holds_slot,
    v_b_observer_detail,
    v_b_waited_on_slot,
    coalesce(v_result_a->>'replaced', '<no result>'),
    coalesce(v_result_b->>'replaced', '<no result>'),
    v_final_count, coalesce(v_final_meals[1] = v_meal_b, false), v_receipt_count);
  insert into pg_temp.meal_replace_race_verdict(ok, detail) values (v_ok, v_detail);
exception when others then
  v_error := format('%s: %s', sqlstate, sqlerrm);
  if v_a_connected and v_a_in_transaction then
    begin perform dblink_exec('meal_replace_a', 'rollback'); exception when others then null; end;
    v_a_in_transaction := false;
  end if;
  if v_b_connected and v_b_query_sent then
    begin perform dblink_cancel_query('meal_replace_b'); exception when others then null; end;
    begin perform * from dblink_get_result('meal_replace_b') as t(result jsonb); exception when others then null; end;
    begin perform * from dblink_get_result('meal_replace_b') as t(result jsonb); exception when others then null; end;
  end if;
  if v_a_connected then
    begin perform dblink_disconnect('meal_replace_a'); exception when others then null; end;
  end if;
  if v_b_connected then
    begin perform dblink_disconnect('meal_replace_b'); exception when others then null; end;
  end if;
  insert into pg_temp.meal_replace_race_verdict(ok, detail) values (false, v_error);
end
$probe$;

-- The race session and both dblink connections are closed before cleanup. The
-- final assertion runs only after every synthetic row has been removed.
delete from public.meal_plans
 where family_id = current_setting('bubaly.meal_race.family')::uuid;
delete from public.meal_plan_write_receipts
 where family_id = current_setting('bubaly.meal_race.family')::uuid;
delete from public.meals
 where family_id = current_setting('bubaly.meal_race.family')::uuid;
delete from public.family_members
 where family_id = current_setting('bubaly.meal_race.family')::uuid;
delete from public.families
 where id = current_setting('bubaly.meal_race.family')::uuid;
delete from auth.users
 where id = current_setting('bubaly.meal_race.actor')::uuid;

set client_min_messages = notice;
do $assert$
declare
  v_ok boolean;
  v_detail text;
begin
  select ok, detail into v_ok, v_detail
  from pg_temp.meal_replace_race_verdict;
  if not coalesce(v_ok, false) then
    raise exception 'MEAL-REPLACE-RACE FAILED: %', coalesce(v_detail, 'no verdict was recorded');
  end if;
  raise notice 'MEAL-REPLACE-RACE OK: distinct same-slot requests serialized; both completed and exactly one final row remains (%)', v_detail;
end
$assert$;
