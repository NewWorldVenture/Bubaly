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
CREATE FUNCTION public.meal_plan_test_direct_write(p_operation text, p_plan_date date, p_new_plan_date date DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_state text; v_rows integer;
BEGIN
  IF p_operation = 'insert' THEN
    INSERT INTO public.meal_plans(family_id, meal_id, plan_date, meal_type, created_by)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', p_plan_date, 'dinner', auth.uid());
  ELSIF p_operation = 'update' THEN
    UPDATE public.meal_plans SET plan_date = p_new_plan_date
     WHERE family_id = '10000000-0000-0000-0000-000000000001' AND plan_date = p_plan_date AND meal_type = 'dinner';
  ELSIF p_operation = 'delete' THEN
    DELETE FROM public.meal_plans
     WHERE family_id = '10000000-0000-0000-0000-000000000001' AND plan_date = p_plan_date AND meal_type = 'dinner';
  ELSE
    RAISE EXCEPTION 'unknown synthetic direct write operation: %', p_operation USING ERRCODE = '22023';
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN p_operation || ':' || v_rows::text;
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
CREATE FUNCTION public.meal_plan_test_direct_deactivation_race(
  p_operation text, p_plan_date date, p_new_plan_date date, p_expected_result text
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_query text;
  v_result text;
  v_deactivation text;
  v_deadline timestamptz;
  v_a integer := (SELECT pid FROM meal_test_pids WHERE name = 'a');
  v_b integer := (SELECT pid FROM meal_test_pids WHERE name = 'b');
BEGIN
  v_query := format('SELECT public.meal_plan_test_direct_write(%L::text,%L::date,%L::date)',
    p_operation, p_plan_date, p_new_plan_date);
  PERFORM public.dblink_exec('meal_a', 'BEGIN');
  IF public.dblink_send_query('meal_a', v_query) <> 1 THEN
    RAISE EXCEPTION '0475 failed to dispatch direct %', p_operation;
  END IF;
  v_deadline := clock_timestamp() + interval '10 seconds';
  WHILE public.dblink_is_busy('meal_a') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0475 direct % did not finish its write body', p_operation; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
  SELECT result INTO v_result FROM public.dblink_get_result('meal_a') AS t(result text);
  PERFORM 1 FROM public.dblink_get_result('meal_a') AS t(result text);
  IF v_result <> p_expected_result THEN
    RAISE EXCEPTION '0475 direct % returned %, expected %', p_operation, v_result, p_expected_result;
  END IF;

  PERFORM public.dblink_exec('meal_b', 'BEGIN');
  IF public.dblink_send_query('meal_b', 'SELECT public.meal_plan_test_deactivate_member()') <> 1 THEN
    RAISE EXCEPTION '0475 failed to dispatch deactivation during direct %', p_operation;
  END IF;
  v_deadline := clock_timestamp() + interval '10 seconds';
  LOOP
    IF public.dblink_is_busy('meal_b') = 0 THEN
      RAISE EXCEPTION '0475 membership deactivation passed the direct % before its transaction committed', p_operation;
    END IF;
    EXIT WHEN v_a = ANY(pg_blocking_pids(v_b));
    IF clock_timestamp() > v_deadline THEN
      RAISE EXCEPTION '0475 direct % did not hold an active membership lock against deactivation', p_operation;
    END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;

  PERFORM public.dblink_exec('meal_a', 'COMMIT');
  v_deadline := clock_timestamp() + interval '15 seconds';
  WHILE public.dblink_is_busy('meal_b') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0475 deactivation did not resume after direct % committed', p_operation; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
  SELECT status INTO v_deactivation FROM public.dblink_get_result('meal_b') AS t(status text);
  PERFORM 1 FROM public.dblink_get_result('meal_b') AS t(status text);
  PERFORM public.dblink_exec('meal_b', 'COMMIT');
  IF v_deactivation <> 'deactivated' THEN
    RAISE EXCEPTION '0475 deactivation after direct % returned %', p_operation, v_deactivation;
  END IF;
  RETURN v_result;
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

-- Distinct request ids must serialize on the slot key, not on the receipt key.
-- A completes its replacement but keeps the transaction open; B must be
-- observed waiting on the exact same family/date/type advisory key before A
-- commits. B then replaces A's row and both durable receipts remain distinct.
INSERT INTO public.meals(id, family_id, name, meal_type, ingredients)
VALUES ('30000000-0000-0000-0000-000000000003',
        '10000000-0000-0000-0000-000000000001',
        'Synthetic distinct-request race meal B', 'dinner', '[]'::jsonb);

SELECT public.dblink_exec('meal_a', 'BEGIN');
SELECT public.meal_plan_test_assert(public.dblink_send_query('meal_a',
  $$SELECT public.meal_plan_replace_slots(
      '10000000-0000-0000-0000-000000000001','distinct-slot-request-a',
      '[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-14","meal_type":"dinner"}]'::jsonb)$$) = 1,
  'first distinct-request replacement dispatched');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_a') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0475 timed out waiting for first distinct-request replacement'; END IF;
    PERFORM pg_sleep(0.01);
  END LOOP;
END $$;
INSERT INTO public.meal_plan_test_results(label, result)
  SELECT 'distinct-a', result FROM public.dblink_get_result('meal_a') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_a') AS t(result jsonb);
DO $$
DECLARE
  v_lock bigint := hashtextextended('meal-plan-slot:10000000-0000-0000-0000-000000000001:2026-10-14:dinner', 0);
  v_a integer := (SELECT pid FROM meal_test_pids WHERE name = 'a');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_locks l
    WHERE l.pid = v_a AND l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
      AND l.classid::bigint = ((v_lock >> 32) & 4294967295::bigint)
      AND l.objid::bigint = (v_lock & 4294967295::bigint)
  ) THEN
    RAISE EXCEPTION '0475 first distinct-request replacement did not retain the exact slot advisory lock';
  END IF;
END $$;

SELECT public.meal_plan_test_assert(public.dblink_send_query('meal_b',
  $$SELECT public.meal_plan_replace_slots(
      '10000000-0000-0000-0000-000000000001','distinct-slot-request-b',
      '[{"meal_id":"30000000-0000-0000-0000-000000000003","plan_date":"2026-10-14","meal_type":"dinner"}]'::jsonb)$$) = 1,
  'second distinct-request replacement dispatched');
DO $$
DECLARE
  v_lock bigint := hashtextextended('meal-plan-slot:10000000-0000-0000-0000-000000000001:2026-10-14:dinner', 0);
  v_a integer := (SELECT pid FROM meal_test_pids WHERE name = 'a');
  v_b integer := (SELECT pid FROM meal_test_pids WHERE name = 'b');
  v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  LOOP
    EXIT WHEN EXISTS (
      SELECT 1 FROM pg_locks l JOIN pg_stat_activity sa ON sa.pid = l.pid
      WHERE l.pid = v_b AND sa.wait_event_type = 'Lock' AND sa.wait_event = 'advisory'
        AND l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
        AND l.classid::bigint = ((v_lock >> 32) & 4294967295::bigint)
        AND l.objid::bigint = (v_lock & 4294967295::bigint)
    );
    IF clock_timestamp() > v_deadline THEN
      RAISE EXCEPTION '0475 second distinct request did not wait on A''s exact slot lock before commit (A pid %, B pid %)', v_a, v_b;
    END IF;
    PERFORM pg_sleep(0.01);
  END LOOP;
END $$;

SELECT public.dblink_exec('meal_a', 'COMMIT');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '15 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_b') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0475 second distinct request did not finish after A committed'; END IF;
    PERFORM pg_sleep(0.01);
  END LOOP;
END $$;
INSERT INTO public.meal_plan_test_results(label, result)
  SELECT 'distinct-b', result FROM public.dblink_get_result('meal_b') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_b') AS t(result jsonb);
SELECT public.dblink_exec('meal_b', 'COMMIT');
SELECT public.meal_plan_test_assert(
  (SELECT (result->>'replaced')::integer = 0 AND (result->>'replayed')::boolean = false
     FROM public.meal_plan_test_results WHERE label = 'distinct-a')
  AND (SELECT (result->>'replaced')::integer = 1 AND (result->>'replayed')::boolean = false
     FROM public.meal_plan_test_results WHERE label = 'distinct-b')
  AND (SELECT result->'planned'->0->>'meal_id' = '30000000-0000-0000-0000-000000000001'
     FROM public.meal_plan_test_results WHERE label = 'distinct-a')
  AND (SELECT result->'planned'->0->>'meal_id' = '30000000-0000-0000-0000-000000000003'
     FROM public.meal_plan_test_results WHERE label = 'distinct-b'),
  'both distinct requests complete and B replaces A''s slot');
SELECT public.meal_plan_test_assert(
  (SELECT count(*) = 1 FROM public.meal_plans
   WHERE family_id = '10000000-0000-0000-0000-000000000001'
     AND plan_date = '2026-10-14' AND meal_type = 'dinner')
  AND (SELECT meal_id = '30000000-0000-0000-0000-000000000003' FROM public.meal_plans
       WHERE family_id = '10000000-0000-0000-0000-000000000001'
         AND plan_date = '2026-10-14' AND meal_type = 'dinner')
  AND (SELECT count(*) = 2 FROM public.meal_plan_write_receipts
       WHERE family_id = '10000000-0000-0000-0000-000000000001'
         AND actor_id = '20000000-0000-0000-0000-000000000001'
         AND request_id IN ('distinct-slot-request-a', 'distinct-slot-request-b')),
  'distinct same-slot requests leave exactly one B row and two separate receipts');

-- A direct authenticated INSERT that started before A commits must see the
-- committed occupant after acquiring the slot advisory lock and be rejected.
SELECT public.dblink_exec('meal_a', 'BEGIN');
SELECT public.dblink_exec('meal_a', $query$DO $lock$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('meal-plan-slot:10000000-0000-0000-0000-000000000001:2026-10-08:dinner',0));
END $lock$$query$);
SELECT public.dblink_exec('meal_a', $$INSERT INTO public.meal_plans(family_id,meal_id,plan_date,meal_type,created_by)
  VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','2026-10-08','dinner',auth.uid())$$);
SELECT public.meal_plan_test_assert(public.dblink_send_query('meal_b',
  $$SELECT public.meal_plan_test_direct_write('insert','2026-10-08',NULL)$$) = 1, 'uncoordinated direct insert dispatched');
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

-- Authenticated direct DML must hold the same active-membership row lock as
-- the RPCs for each trigger operation, so deactivation cannot overtake it.
SELECT public.dblink_exec('meal_b', 'RESET ROLE');
SELECT public.meal_plan_test_assert(
  public.meal_plan_test_direct_deactivation_race('insert','2026-10-11',NULL,'insert:1') = 'insert:1',
  'direct INSERT holds membership FOR SHARE until deactivation follows');
SELECT public.meal_plan_test_assert(
  NOT (SELECT is_active FROM public.family_members WHERE family_id='10000000-0000-0000-0000-000000000001'
       AND user_id='20000000-0000-0000-0000-000000000001')
  AND EXISTS (SELECT 1 FROM public.meal_plans WHERE plan_date='2026-10-11'),
  'direct INSERT commits before the waiting deactivation');
SELECT public.meal_plan_test_assert(
  (SELECT result = '42501' FROM public.dblink('meal_a',
    $$SELECT public.meal_plan_test_direct_write('insert','2026-10-13',NULL)$$) AS t(result text))
  AND (SELECT result = 'update:0' FROM public.dblink('meal_a',
    $$SELECT public.meal_plan_test_direct_write('update','2026-10-11','2026-10-12')$$) AS t(result text))
  AND (SELECT result = 'delete:0' FROM public.dblink('meal_a',
    $$SELECT public.meal_plan_test_direct_write('delete','2026-10-11',NULL)$$) AS t(result text))
  AND EXISTS (SELECT 1 FROM public.meal_plans WHERE plan_date='2026-10-11')
  AND NOT EXISTS (SELECT 1 FROM public.meal_plans WHERE plan_date IN ('2026-10-12','2026-10-13')),
  'inactive membership rejects authenticated direct INSERT and hides UPDATE/DELETE targets without changing rows');
UPDATE public.family_members SET is_active = true
 WHERE family_id='10000000-0000-0000-0000-000000000001'
   AND user_id='20000000-0000-0000-0000-000000000001';
SELECT public.meal_plan_test_assert(
  public.meal_plan_test_direct_deactivation_race('update','2026-10-11','2026-10-12','update:1') = 'update:1',
  'direct UPDATE holds membership FOR SHARE until deactivation follows');
SELECT public.meal_plan_test_assert(
  NOT (SELECT is_active FROM public.family_members WHERE family_id='10000000-0000-0000-0000-000000000001'
       AND user_id='20000000-0000-0000-0000-000000000001')
  AND EXISTS (SELECT 1 FROM public.meal_plans WHERE plan_date='2026-10-12')
  AND NOT EXISTS (SELECT 1 FROM public.meal_plans WHERE plan_date='2026-10-11'),
  'direct UPDATE commits before the waiting deactivation');
UPDATE public.family_members SET is_active = true
 WHERE family_id='10000000-0000-0000-0000-000000000001'
   AND user_id='20000000-0000-0000-0000-000000000001';
SELECT public.meal_plan_test_assert(
  public.meal_plan_test_direct_deactivation_race('delete','2026-10-12',NULL,'delete:1') = 'delete:1',
  'direct DELETE holds membership FOR SHARE until deactivation follows');
SELECT public.meal_plan_test_assert(
  NOT (SELECT is_active FROM public.family_members WHERE family_id='10000000-0000-0000-0000-000000000001'
       AND user_id='20000000-0000-0000-0000-000000000001')
  AND NOT EXISTS (SELECT 1 FROM public.meal_plans WHERE plan_date='2026-10-12'),
  'direct DELETE commits before the waiting deactivation');
UPDATE public.family_members SET is_active = true
 WHERE family_id='10000000-0000-0000-0000-000000000001'
   AND user_id='20000000-0000-0000-0000-000000000001';
SELECT public.dblink_disconnect('meal_a');
SELECT public.dblink_disconnect('meal_b');
