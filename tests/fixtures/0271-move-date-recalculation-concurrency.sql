-- Execute ONLY after fresh 0271 bootstrap + actual 0245 + actual 0271.
-- The preceding single-session fixture rolls back its entire schema first.
-- This independent fixture commits synthetic setup so separate PostgreSQL
-- sessions can see it. GitHub disposes of the whole dedicated service afterward.
-- No host/production URLs, external cleanup, credentials, or service startup.
DO $guard$
BEGIN
  IF pg_catalog.current_database() <> 'bubaly_move_recalc_ci'
    OR CURRENT_USER <> 'postgres'
    OR pg_catalog.current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
    OR EXISTS (SELECT 1 FROM public.moves)
    OR EXISTS (SELECT 1 FROM auth.users)
  THEN
    RAISE EXCEPTION '0271 concurrency requires its fresh isolated CI bootstrap';
  END IF;
END;
$guard$;

CREATE EXTENSION dblink WITH SCHEMA public;
CREATE TABLE public.test_0271_concurrency_proofs (name text PRIMARY KEY);
CREATE FUNCTION public.test_0271_concurrency_assert(p_ok boolean, p_name text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0271 concurrency assertion failed: %', p_name;
  END IF;
  INSERT INTO public.test_0271_concurrency_proofs(name) VALUES (p_name);
END;
$function$;

CREATE FUNCTION public.test_0271_wait_blocked(p_waiter integer, p_holder integer)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_deadline timestamptz := pg_catalog.clock_timestamp() + interval '5 seconds';
BEGIN
  LOOP
    IF p_holder = ANY(pg_catalog.pg_blocking_pids(p_waiter)) THEN
      RETURN;
    END IF;
    IF pg_catalog.clock_timestamp() >= v_deadline THEN
      RAISE EXCEPTION '0271 expected real lock blocker %, waiter %', p_holder, p_waiter;
    END IF;
    PERFORM pg_catalog.pg_sleep(0.01);
  END LOOP;
END;
$function$;

-- The mutation alone is caught. Caller assertions inspect its returned SQLSTATE
-- outside this exception block and then inspect actually committed source rows.
CREATE FUNCTION public.test_0271_try_write(p_sql text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_state text := '00000'; v_message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
  END;
  RETURN pg_catalog.jsonb_build_object(
    'sqlstate', v_state, 'message', v_message,
    'actor', CURRENT_USER, 'userId', auth.uid()
  );
END;
$function$;

INSERT INTO auth.users(id, email) VALUES ('20000000-0000-4000-8000-000000000001', 'concurrency-parent@example.test');
INSERT INTO public.families(id, name, created_by) VALUES ('10000000-0000-4000-8000-000000000001', 'Synthetic concurrent family', '20000000-0000-4000-8000-000000000001');
INSERT INTO public.family_members(id, family_id, user_id, role, display_name)
VALUES ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'parent', 'Synthetic Concurrent Parent');
INSERT INTO public.moves(id, family_id, title, move_date)
VALUES ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Synthetic concurrent move', DATE '2026-09-06');
INSERT INTO public.move_tasks(id, family_id, move_id, title, date_mode, offset_days, due_date)
VALUES ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Existing relative task', 'relative', 0, DATE '2026-09-06');

COMMIT;
SET statement_timeout = '60s';
SET lock_timeout = '5s';

DO $concurrency$
DECLARE
  v_rpc_pid integer;
  v_writer_pid integer;
  v_preview jsonb;
  v_result jsonb;
  v_outcome jsonb;
  v_write text;
  v_row uuid;
BEGIN
  PERFORM public.dblink_connect('moving_rpc',
    'host=/var/run/postgresql port=5432 dbname=bubaly_move_recalc_ci user=postgres application_name=moving_0271_rpc');
  PERFORM public.dblink_connect('moving_writer',
    'host=/var/run/postgresql port=5432 dbname=bubaly_move_recalc_ci user=postgres application_name=moving_0271_writer');
  PERFORM public.dblink_exec('moving_rpc', 'SET statement_timeout = ''12s''');
  PERFORM public.dblink_exec('moving_writer', 'SET statement_timeout = ''12s''');
  PERFORM public.dblink_exec('moving_rpc', 'SET ROLE authenticated');
  PERFORM public.dblink_exec('moving_writer', 'SET ROLE authenticated');
  PERFORM public.dblink_exec('moving_rpc', 'SET request.jwt.claim.sub = ''20000000-0000-4000-8000-000000000001''');
  PERFORM public.dblink_exec('moving_writer', 'SET request.jwt.claim.sub = ''20000000-0000-4000-8000-000000000001''');
  SELECT pid INTO v_rpc_pid FROM public.dblink('moving_rpc', 'SELECT pg_backend_pid()') AS response(pid integer);
  SELECT pid INTO v_writer_pid FROM public.dblink('moving_writer', 'SELECT pg_backend_pid()') AS response(pid integer);
  PERFORM public.test_0271_concurrency_assert(
    v_rpc_pid <> v_writer_pid AND v_rpc_pid <> pg_catalog.pg_backend_pid()
      AND v_writer_pid <> pg_catalog.pg_backend_pid(), 'three_distinct_real_postgres_sessions'
  );

  -- RPC first: retain preview locks, dispatch an old-date INSERT, and prove
  -- the writer really waits on the RPC backend before applying and committing.
  PERFORM public.dblink_exec('moving_rpc', 'BEGIN');
  SELECT result->'preview' INTO v_preview
  FROM public.dblink('moving_rpc',
    'SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001'', ''40000000-0000-4000-8000-000000000001'', ''30000000-0000-4000-8000-000000000001'', DATE ''2026-09-20'')'
  ) AS response(result jsonb);
  PERFORM public.dblink_exec('moving_writer', 'BEGIN');
  v_write := 'INSERT INTO public.move_tasks(id, family_id, move_id, title, date_mode, offset_days, due_date)
    VALUES (''50000000-0000-4000-8000-000000000002'', ''10000000-0000-4000-8000-000000000001'', ''40000000-0000-4000-8000-000000000001'', ''Queued old-date task'', ''relative'', 0, DATE ''2026-09-06'')';
  IF public.dblink_send_query('moving_writer',
    pg_catalog.format('SELECT public.test_0271_try_write(%L)', v_write)) <> 1
  THEN RAISE EXCEPTION '0271 failed to dispatch insert'; END IF;
  PERFORM public.test_0271_wait_blocked(v_writer_pid, v_rpc_pid);
  SELECT result INTO v_result
  FROM public.dblink('moving_rpc', pg_catalog.format(
    'SELECT public.move_recalculate_date(%L::uuid,%L::uuid,%L::uuid,%L::date,%L::jsonb,%L::uuid)',
    '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '2026-09-20', v_preview::text, '60000000-0000-4000-8000-000000000101'
  )) AS response(result jsonb);
  PERFORM public.dblink_exec('moving_rpc', 'COMMIT');
  SELECT result INTO v_outcome FROM public.dblink_get_result('moving_writer') AS response(result jsonb);
  PERFORM result FROM public.dblink_get_result('moving_writer') AS response(result jsonb);
  PERFORM public.dblink_exec('moving_writer', 'COMMIT');
  PERFORM public.test_0271_concurrency_assert(
    v_outcome->>'sqlstate' = '40001' AND v_outcome->>'message' = 'stale_review'
      AND v_outcome->>'actor' = 'authenticated' AND v_outcome->>'userId' = '20000000-0000-4000-8000-000000000001'
      AND NOT EXISTS (SELECT 1 FROM public.move_tasks WHERE id = '50000000-0000-4000-8000-000000000002')
      AND (SELECT move_date = DATE '2026-09-20' FROM public.moves WHERE id = '40000000-0000-4000-8000-000000000001')
      AND (SELECT due_date = DATE '2026-09-20' FROM public.move_tasks WHERE id = '50000000-0000-4000-8000-000000000001'),
    'rpc_first_waiting_old_relative_insert_rejected_without_stale_row'
  );
  PERFORM public.test_0271_concurrency_assert(
    v_result->'preview' = v_preview AND v_result->'applied' = 'true'::jsonb
      AND (SELECT result = v_result FROM public.move_date_recalculations WHERE request_id = '60000000-0000-4000-8000-000000000101'),
    'rpc_first_apply_and_receipt_remain_atomic'
  );

  -- An explicitly refreshed creation succeeds against the committed move date.
  PERFORM public.dblink_exec('moving_writer',
    'INSERT INTO public.move_tasks(id, family_id, move_id, title, date_mode, offset_days, due_date)
     VALUES (''50000000-0000-4000-8000-000000000002'', ''10000000-0000-4000-8000-000000000001'', ''40000000-0000-4000-8000-000000000001'', ''Fresh relative task'', ''relative'', 0, DATE ''2026-09-20'')');
  PERFORM public.test_0271_concurrency_assert(
    (SELECT due_date = DATE '2026-09-20' FROM public.move_tasks WHERE id = '50000000-0000-4000-8000-000000000002'),
    'refreshed_relative_insert_commits_current_date'
  );

  -- Writer first: its parent SHARE lock must block RPC FOR UPDATE. Once it
  -- commits, a fresh RPC snapshot must include and subsequently shift its task.
  PERFORM public.dblink_exec('moving_writer', 'BEGIN');
  PERFORM public.dblink_exec('moving_writer',
    'INSERT INTO public.move_tasks(id, family_id, move_id, title, date_mode, offset_days, due_date)
     VALUES (''50000000-0000-4000-8000-000000000003'', ''10000000-0000-4000-8000-000000000001'', ''40000000-0000-4000-8000-000000000001'', ''Insert-first relative task'', ''relative'', 2, DATE ''2026-09-22'')');
  PERFORM public.dblink_exec('moving_rpc', 'BEGIN');
  IF public.dblink_send_query('moving_rpc',
    'SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001'', ''40000000-0000-4000-8000-000000000001'', ''30000000-0000-4000-8000-000000000001'', DATE ''2026-10-04'')') <> 1
  THEN RAISE EXCEPTION '0271 failed to dispatch preview'; END IF;
  PERFORM public.test_0271_wait_blocked(v_rpc_pid, v_writer_pid);
  PERFORM public.dblink_exec('moving_writer', 'COMMIT');
  SELECT result->'preview' INTO v_preview FROM public.dblink_get_result('moving_rpc') AS response(result jsonb);
  PERFORM result FROM public.dblink_get_result('moving_rpc') AS response(result jsonb);
  PERFORM public.test_0271_concurrency_assert(
    EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(v_preview->'tasks') AS task(value)
      WHERE task.value->>'id' = '50000000-0000-4000-8000-000000000003'
        AND task.value->>'dueDate' = '2026-09-22'
        AND task.value->>'nextDueDate' = '2026-10-06'
        AND task.value->>'action' = 'shift'
    ), 'insert_first_commit_visible_in_locked_rpc_preview'
  );
  SELECT result INTO v_result
  FROM public.dblink('moving_rpc', pg_catalog.format(
    'SELECT public.move_recalculate_date(%L::uuid,%L::uuid,%L::uuid,%L::date,%L::jsonb,%L::uuid)',
    '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '2026-10-04', v_preview::text, '60000000-0000-4000-8000-000000000102'
  )) AS response(result jsonb);
  PERFORM public.dblink_exec('moving_rpc', 'COMMIT');
  PERFORM public.test_0271_concurrency_assert(
    (SELECT due_date = DATE '2026-10-06' FROM public.move_tasks WHERE id = '50000000-0000-4000-8000-000000000003')
      AND (SELECT move_date = DATE '2026-10-04' FROM public.moves WHERE id = '40000000-0000-4000-8000-000000000001')
      AND (SELECT result = v_result FROM public.move_date_recalculations WHERE request_id = '60000000-0000-4000-8000-000000000102'),
    'insert_first_task_shifted_and_receipt_committed'
  );

  -- A scheduling UPDATE queued behind the RPC's task lock cannot overwrite
  -- the new due_date with a stale constant after the RPC commits.
  PERFORM public.dblink_exec('moving_rpc', 'BEGIN');
  SELECT result->'preview' INTO v_preview
  FROM public.dblink('moving_rpc',
    'SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001'', ''40000000-0000-4000-8000-000000000001'', ''30000000-0000-4000-8000-000000000001'', DATE ''2026-10-18'')'
  ) AS response(result jsonb);
  PERFORM public.dblink_exec('moving_writer', 'BEGIN');
  v_write := 'UPDATE public.move_tasks SET due_date = DATE ''2026-10-05'' WHERE id = ''50000000-0000-4000-8000-000000000002''';
  IF public.dblink_send_query('moving_writer',
    pg_catalog.format('SELECT public.test_0271_try_write(%L)', v_write)) <> 1
  THEN RAISE EXCEPTION '0271 failed to dispatch task update'; END IF;
  PERFORM public.test_0271_wait_blocked(v_writer_pid, v_rpc_pid);
  SELECT result INTO v_result
  FROM public.dblink('moving_rpc', pg_catalog.format(
    'SELECT public.move_recalculate_date(%L::uuid,%L::uuid,%L::uuid,%L::date,%L::jsonb,%L::uuid)',
    '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '2026-10-18', v_preview::text, '60000000-0000-4000-8000-000000000103'
  )) AS response(result jsonb);
  PERFORM public.dblink_exec('moving_rpc', 'COMMIT');
  SELECT result INTO v_outcome FROM public.dblink_get_result('moving_writer') AS response(result jsonb);
  PERFORM result FROM public.dblink_get_result('moving_writer') AS response(result jsonb);
  PERFORM public.dblink_exec('moving_writer', 'COMMIT');
  PERFORM public.test_0271_concurrency_assert(
    v_outcome->>'sqlstate' = '40001' AND v_outcome->>'actor' = 'authenticated'
      AND (SELECT due_date = DATE '2026-10-18' FROM public.move_tasks WHERE id = '50000000-0000-4000-8000-000000000002')
      AND (SELECT pg_catalog.count(*) FROM public.move_date_recalculations) = 3,
    'queued_relative_date_update_cannot_overwrite_recalculated_date'
  );

  -- Exercise the reverse child/parent lock order deliberately: parent held,
  -- child not yet locked. The UPDATE guard must return 40001 promptly rather
  -- than waiting on the parent while holding the child's row lock.
  PERFORM public.dblink_exec('moving_rpc', 'BEGIN');
  SELECT id INTO v_row FROM public.dblink('moving_rpc',
    'SELECT id FROM public.moves WHERE id = ''40000000-0000-4000-8000-000000000001'' FOR UPDATE'
  ) AS response(id uuid);
  SELECT result INTO v_outcome FROM public.dblink('moving_writer', pg_catalog.format(
    'SELECT public.test_0271_try_write(%L)',
    'UPDATE public.move_tasks SET offset_days = 1, due_date = DATE ''2026-10-19'' WHERE id = ''50000000-0000-4000-8000-000000000002'''
  )) AS response(result jsonb);
  PERFORM public.test_0271_concurrency_assert(
    v_outcome->>'sqlstate' = '40001' AND v_outcome->>'message' = 'stale_review'
      AND (SELECT offset_days = 0 AND due_date = DATE '2026-10-18' FROM public.move_tasks WHERE id = '50000000-0000-4000-8000-000000000002'),
    'busy_parent_update_fails_without_reverse_order_deadlock'
  );
  PERFORM public.dblink_exec('moving_rpc', 'COMMIT');
  PERFORM public.dblink_disconnect('moving_writer');
  PERFORM public.dblink_disconnect('moving_rpc');
EXCEPTION WHEN OTHERS THEN
  IF 'moving_writer' = ANY(COALESCE(public.dblink_get_connections(), ARRAY[]::text[])) THEN
    PERFORM public.dblink_disconnect('moving_writer');
  END IF;
  IF 'moving_rpc' = ANY(COALESCE(public.dblink_get_connections(), ARRAY[]::text[])) THEN
    PERFORM public.dblink_disconnect('moving_rpc');
  END IF;
  RAISE;
END;
$concurrency$;

SELECT '0271_CONCURRENCY_OK ' || name FROM public.test_0271_concurrency_proofs ORDER BY name;
SELECT '0271_CONCURRENCY_PROOF_COUNT ' || pg_catalog.count(*)::text FROM public.test_0271_concurrency_proofs;
SELECT '0271_UNPROVEN multi_session_membership_revocation_and_request_uuid_races';
-- The dedicated GitHub service is destroyed by job teardown, including on error.
