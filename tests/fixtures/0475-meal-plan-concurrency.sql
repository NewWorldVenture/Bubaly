-- Real independent PG17 sessions: same-request replay and serialization with
-- an ordinary authenticated PostgREST-style INSERT writer.
DO $$
BEGIN
  IF current_database() <> 'bubaly_meal_plan_atomic_ci' OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION '0475 concurrency requires the dedicated synthetic PostgreSQL 17 database';
  END IF;
END $$;

CREATE EXTENSION dblink;
CREATE TABLE public.meal_plan_test_results (label text PRIMARY KEY, result jsonb, status text);
CREATE OR REPLACE FUNCTION public.meal_plan_test_assert(p_ok boolean, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION '0475 concurrency assertion failed: %', p_label; END IF;
  RAISE NOTICE '0475 PASS %', p_label;
END $$;
CREATE FUNCTION public.meal_plan_test_direct_insert(p_plan_date date) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_state text;
BEGIN
  INSERT INTO public.meal_plans(family_id, meal_id, plan_date, meal_type, created_by)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', p_plan_date, 'dinner', auth.uid());
  RETURN 'inserted';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  RETURN v_state;
END $$;
CREATE FUNCTION public.meal_plan_test_replace_state(p_request_id text, p_plan_date date) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_state text;
BEGIN
  PERFORM public.meal_plan_replace_slots('10000000-0000-0000-0000-000000000001', p_request_id,
    jsonb_build_array(jsonb_build_object('meal_id','30000000-0000-0000-0000-000000000001',
      'plan_date',p_plan_date,'meal_type','dinner')));
  RETURN 'accepted';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  RETURN v_state;
END $$;
CREATE FUNCTION public.meal_plan_test_deactivate_member() RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.family_members SET is_active = false
   WHERE family_id = '10000000-0000-0000-0000-000000000001'
     AND user_id = '20000000-0000-0000-0000-000000000001';
  RETURN 'deactivated';
END $$;

SELECT public.dblink_connect('meal_a', format('host=127.0.0.1 port=%s dbname=bubaly_meal_plan_atomic_ci user=postgres', current_setting('port')));
SELECT public.dblink_connect('meal_b', format('host=127.0.0.1 port=%s dbname=bubaly_meal_plan_atomic_ci user=postgres', current_setting('port')));
SELECT public.dblink_exec('meal_a', 'SET ROLE authenticated');
SELECT public.dblink_exec('meal_b', 'SET ROLE authenticated');
SELECT * FROM public.dblink('meal_a', $$SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false)$$) AS t(setting text);
SELECT * FROM public.dblink('meal_b', $$SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false)$$) AS t(setting text);
CREATE TEMP TABLE meal_test_pids (name text PRIMARY KEY, pid integer NOT NULL);
INSERT INTO meal_test_pids SELECT 'a', pid FROM public.dblink('meal_a', 'SELECT pg_backend_pid()') AS t(pid integer);
INSERT INTO meal_test_pids SELECT 'b', pid FROM public.dblink('meal_b', 'SELECT pg_backend_pid()') AS t(pid integer);
SELECT public.meal_plan_test_assert((SELECT count(DISTINCT pid) = 2 FROM meal_test_pids), 'workers are independent backend sessions');

-- A commits the operation body but holds its transaction open. B's same-key
-- insert must wait on the unique receipt key, then replay A's exact result.
SELECT public.dblink_exec('meal_a', 'BEGIN');
SELECT public.meal_plan_test_assert(public.dblink_send_query('meal_a',
  $$SELECT public.meal_plan_replace_slots('10000000-0000-0000-0000-000000000001','concurrent-same-request',
    '[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-07","meal_type":"dinner"}]'::jsonb)$$) = 1,
  'first concurrent request dispatched');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_a') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0475 timed out waiting for first transaction body'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO public.meal_plan_test_results(label, result)
  SELECT 'same-a', result FROM public.dblink_get_result('meal_a') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_a') AS t(result jsonb);

SELECT public.dblink_exec('meal_b', 'BEGIN');
SELECT public.meal_plan_test_assert(public.dblink_send_query('meal_b',
  $$SELECT public.meal_plan_replace_slots('10000000-0000-0000-0000-000000000001','concurrent-same-request',
    '[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-07","meal_type":"dinner"}]'::jsonb)$$) = 1,
  'same-key retry dispatched');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  LOOP
    EXIT WHEN cardinality(pg_blocking_pids((SELECT pid FROM meal_test_pids WHERE name = 'b'))) > 0;
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0475 retry did not wait on the uncommitted receipt'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
SELECT public.dblink_exec('meal_a', 'COMMIT');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '15 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_b') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0475 same-key retry did not finish after commit'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO public.meal_plan_test_results(label, result)
  SELECT 'same-b', result FROM public.dblink_get_result('meal_b') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_b') AS t(result jsonb);
SELECT public.dblink_exec('meal_b', 'COMMIT');
SELECT public.meal_plan_test_assert(
  (SELECT result->'planned'->0->>'id' FROM public.meal_plan_test_results WHERE label='same-a')
    = (SELECT result->'planned'->0->>'id' FROM public.meal_plan_test_results WHERE label='same-b')
  AND (SELECT (result->>'replayed')::boolean = false FROM public.meal_plan_test_results WHERE label='same-a')
  AND (SELECT (result->>'replayed')::boolean = true FROM public.meal_plan_test_results WHERE label='same-b'),
  'concurrent same-request calls commit once and replay the identical row ID');
SELECT public.meal_plan_test_assert((SELECT count(*) = 1 FROM public.meal_plans WHERE plan_date='2026-10-07'),
  'same-request race leaves exactly one row in the slot');

-- A direct authenticated INSERT that started before A commits must see the
-- committed occupant after acquiring the slot advisory lock and be rejected.
SELECT public.dblink_exec('meal_a', 'BEGIN');
SELECT public.dblink_exec('meal_a', $query$DO $lock$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('meal-plan-slot:10000000-0000-0000-0000-000000000001:2026-10-08:dinner',0));
END $lock$$query$);
SELECT public.dblink_exec('meal_a', $$INSERT INTO public.meal_plans(family_id,meal_id,plan_date,meal_type,created_by)
  VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','2026-10-08','dinner',auth.uid())$$);
SELECT public.meal_plan_test_assert(public.dblink_send_query('meal_b',
  $$SELECT public.meal_plan_test_direct_insert('2026-10-08')$$) = 1, 'uncoordinated direct insert dispatched');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  LOOP
    EXIT WHEN cardinality(pg_blocking_pids((SELECT pid FROM meal_test_pids WHERE name = 'b'))) > 0;
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0475 direct insert did not block on slot lock'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
SELECT public.dblink_exec('meal_a', 'COMMIT');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '15 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_b') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0475 direct insert did not resume after slot commit'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO public.meal_plan_test_results(label, status)
  SELECT 'direct-b', status FROM public.dblink_get_result('meal_b') AS t(status text);
SELECT count(*) FROM public.dblink_get_result('meal_b') AS t(status text);
SELECT public.meal_plan_test_assert((SELECT status = '23505' FROM public.meal_plan_test_results WHERE label='direct-b'),
  'direct writer rechecks occupancy after waiting on the slot lock');
SELECT public.meal_plan_test_assert((SELECT count(*) = 1 FROM public.meal_plans WHERE plan_date='2026-10-08'),
  'racing direct insert cannot create a duplicate slot');

-- Authorization is held to transaction end. A membership deactivation that
-- starts after the RPC checked the active row must wait for the accepted write;
-- after deactivation commits, a new write must be denied.
SELECT public.dblink_exec('meal_a', 'BEGIN');
SELECT public.meal_plan_test_assert(public.dblink_send_query('meal_a',
  $$SELECT public.meal_plan_replace_slots('10000000-0000-0000-0000-000000000001','membership-lock-write',
    '[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-09","meal_type":"dinner"}]'::jsonb)$$) = 1,
  'authenticated write dispatched while membership is active');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_a') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0475 timed out waiting for authorized write'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO public.meal_plan_test_results(label, result)
  SELECT 'membership-write', result FROM public.dblink_get_result('meal_a') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_a') AS t(result jsonb);

SELECT public.dblink_exec('meal_b', 'RESET ROLE');
SELECT public.dblink_exec('meal_b', 'BEGIN');
SELECT public.meal_plan_test_assert(public.dblink_send_query('meal_b',
  $$SELECT public.meal_plan_test_deactivate_member()$$) = 1,
  'membership deactivation dispatched in an independent session');
DO $$
DECLARE
  v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
  v_a integer := (SELECT pid FROM meal_test_pids WHERE name = 'a');
  v_b integer := (SELECT pid FROM meal_test_pids WHERE name = 'b');
BEGIN
  LOOP
    IF public.dblink_is_busy('meal_b') = 0 THEN
      RAISE EXCEPTION '0475 membership deactivation completed while the meal RPC held FOR SHARE';
    END IF;
    EXIT WHEN v_a = ANY(pg_blocking_pids(v_b));
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0475 membership deactivation did not block on the active membership row'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
SELECT public.dblink_exec('meal_a', 'COMMIT');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '15 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_b') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0475 membership deactivation did not resume after meal write commit'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO public.meal_plan_test_results(label, status)
  SELECT 'membership-deactivation', result FROM public.dblink_get_result('meal_b') AS t(result text);
SELECT count(*) FROM public.dblink_get_result('meal_b') AS t(result text);
SELECT public.meal_plan_test_assert(
  (SELECT result->'planned'->0->>'plan_date' = '2026-10-09' FROM public.meal_plan_test_results WHERE label='membership-write')
  AND (SELECT status = 'deactivated' FROM public.meal_plan_test_results WHERE label='membership-deactivation'),
  'the already-authorized write commits before the waiting deactivation');
SELECT public.dblink_exec('meal_b', 'COMMIT');
SELECT public.meal_plan_test_assert(
  NOT (SELECT is_active FROM public.family_members WHERE family_id='10000000-0000-0000-0000-000000000001'
       AND user_id='20000000-0000-0000-0000-000000000001')
  AND (SELECT count(*) = 1 FROM public.meal_plans WHERE plan_date='2026-10-09'),
  'deactivation commits after the in-flight write');
SELECT public.meal_plan_test_assert(
  (SELECT result = '42501' FROM public.dblink('meal_a',
    $$SELECT public.meal_plan_test_replace_state('membership-write-after-revoke','2026-10-10')$$) AS t(result text))
  AND NOT EXISTS (SELECT 1 FROM public.meal_plans WHERE plan_date='2026-10-10'),
  'a new authenticated write after committed deactivation is rejected');
UPDATE public.family_members SET is_active = true
 WHERE family_id='10000000-0000-0000-0000-000000000001'
   AND user_id='20000000-0000-0000-0000-000000000001';
SELECT public.meal_plan_test_assert(
  (SELECT is_active FROM public.family_members WHERE family_id='10000000-0000-0000-0000-000000000001'
     AND user_id='20000000-0000-0000-0000-000000000001'),
  'synthetic actor membership restored for later fixture steps');
SELECT public.dblink_disconnect('meal_a');
SELECT public.dblink_disconnect('meal_b');
