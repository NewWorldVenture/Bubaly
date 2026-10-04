-- Two independent service-role requests with different idempotency keys must
-- serialize by family and normalized custom-meal name on disposable PG17.
DO $$
BEGIN
  IF current_database() <> 'bubaly_meal_plan_atomic_ci' OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION '0476 name-race probe requires its dedicated synthetic PostgreSQL 17 database';
  END IF;
END $$;
-- This test-only invoker wrapper must commit before dblink workers can call it.
CREATE OR REPLACE FUNCTION public.meal_name_race_try_plan(p_request_id text, p_meal_id uuid, p_plan_date date)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.meal_plan_replace_slots_for_actor(
    '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', p_request_id,
    jsonb_build_array(jsonb_build_object('plan_date', p_plan_date, 'meal_type', 'dinner', 'meal_id', p_meal_id)));
  RETURN 'accepted';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $$;
BEGIN;
CREATE EXTENSION IF NOT EXISTS dblink;
CREATE TEMP TABLE meal_name_race_pids (name text PRIMARY KEY, pid integer NOT NULL);
CREATE TEMP TABLE meal_name_race_results (name text PRIMARY KEY, result jsonb NOT NULL);
CREATE TEMP TABLE meal_cleanup_race_meals (case_name text PRIMARY KEY, id uuid NOT NULL);
CREATE TEMP TABLE meal_cleanup_race_results (case_name text PRIMARY KEY, result jsonb NOT NULL);
CREATE FUNCTION public.meal_name_race_assert(p_ok boolean, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION '0476 name-race assertion failed: %', p_label; END IF;
  RAISE NOTICE '0476 PASS %', p_label;
END $$;
SELECT public.dblink_connect('meal_name_a', format('host=127.0.0.1 port=%s dbname=%s user=postgres', current_setting('port'), current_database()));
SELECT public.dblink_connect('meal_name_b', format('host=127.0.0.1 port=%s dbname=%s user=postgres', current_setting('port'), current_database()));
SELECT public.dblink_connect('meal_name_c', format('host=127.0.0.1 port=%s dbname=%s user=postgres', current_setting('port'), current_database()));
SELECT public.dblink_exec('meal_name_a', 'SET ROLE service_role');
SELECT public.dblink_exec('meal_name_b', 'SET ROLE service_role');
SELECT public.dblink_exec('meal_name_c', 'SET ROLE authenticated');
SELECT public.dblink_exec('meal_name_c', $$SET request.jwt.claim.sub = '20000000-0000-0000-0000-000000000001'$$);
INSERT INTO meal_name_race_pids
  SELECT 'a', pid FROM public.dblink('meal_name_a', 'SELECT pg_backend_pid()') AS t(pid integer);
INSERT INTO meal_name_race_pids
  SELECT 'b', pid FROM public.dblink('meal_name_b', 'SELECT pg_backend_pid()') AS t(pid integer);
INSERT INTO meal_name_race_pids
  SELECT 'c', pid FROM public.dblink('meal_name_c', 'SELECT pg_backend_pid()') AS t(pid integer);

-- A completes the meal-plan RPC but holds its transaction open so its name lock
-- remains live while B reaches the exact same family/name with another request ID.
SELECT public.dblink_exec('meal_name_a', 'BEGIN');
SELECT public.meal_name_race_assert(public.dblink_send_query('meal_name_a',
  $$SELECT public.meal_plan_replace_slots_for_actor(
    '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','meal-name-race-a',
    '[{"plan_date":"2026-10-20","meal_type":"dinner","meal_name":"Concurrent synthetic stew","ingredients":[{"name":"beans","qty":"1 cup","unit":null}]}]'::jsonb)$$) = 1,
  'first distinct-key custom-meal request dispatched');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_name_a') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0476 timed out waiting for first delegated meal write'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO meal_name_race_results(name, result)
  SELECT 'a', result FROM public.dblink_get_result('meal_name_a') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_name_a') AS t(result jsonb);

SELECT public.dblink_exec('meal_name_b', 'BEGIN');
SELECT public.meal_name_race_assert(public.dblink_send_query('meal_name_b',
  $$SELECT public.meal_plan_replace_slots_for_actor(
    '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','meal-name-race-b',
    '[{"plan_date":"2026-10-21","meal_type":"dinner","meal_name":" concurrent   synthetic stew ","ingredients":[{"name":"beans","qty":"1 cup","unit":null}]}]'::jsonb)$$) = 1,
  'second distinct-key custom-meal request dispatched');
DO $$
DECLARE
  v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
  v_a integer := (SELECT pid FROM meal_name_race_pids WHERE name = 'a');
  v_b integer := (SELECT pid FROM meal_name_race_pids WHERE name = 'b');
BEGIN
  LOOP
    IF public.dblink_is_busy('meal_name_b') = 0 THEN
      RAISE EXCEPTION '0476 second custom-meal request completed before the first committed';
    END IF;
    EXIT WHEN v_a = ANY(pg_blocking_pids(v_b));
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0476 second request did not block on the first request name lock'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
SELECT public.dblink_exec('meal_name_a', 'COMMIT');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '15 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_name_b') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0476 second custom-meal request did not resume after commit'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO meal_name_race_results(name, result)
  SELECT 'b', result FROM public.dblink_get_result('meal_name_b') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_name_b') AS t(result jsonb);
SELECT public.dblink_exec('meal_name_b', 'COMMIT');

SELECT public.meal_name_race_assert(
  (SELECT result->>'created_meals' = '1' FROM meal_name_race_results WHERE name='a')
  AND (SELECT result->>'created_meals' = '0' FROM meal_name_race_results WHERE name='b')
  AND (SELECT result->'planned'->0->>'meal_id' FROM meal_name_race_results WHERE name='a')
      = (SELECT result->'planned'->0->>'meal_id' FROM meal_name_race_results WHERE name='b')
  AND (SELECT count(*) = 1 FROM public.meals
        WHERE family_id='10000000-0000-0000-0000-000000000001'
          AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))='concurrent synthetic stew'),
  'distinct idempotency keys serialize lookup and reuse the committed family meal');

-- A normal authenticated planner ensure blocks on the same lock held by a
-- delegated service-role plan replacement, then reuses its meal after commit.
SELECT public.dblink_exec('meal_name_a', 'BEGIN');
SELECT public.meal_name_race_assert(public.dblink_send_query('meal_name_a',
  $$SELECT public.meal_plan_replace_slots_for_actor(
    '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','mixed-writer-delegated',
    '[{"plan_date":"2026-10-22","meal_type":"dinner","meal_name":"Mixed writer synthetic curry","ingredients":[]}]'::jsonb)$$) = 1,
  'mixed-race delegated writer dispatched');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_name_a') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0476 timed out waiting for mixed delegated meal write'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO meal_name_race_results(name, result)
  SELECT 'mixed-a', result FROM public.dblink_get_result('meal_name_a') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_name_a') AS t(result jsonb);

SELECT public.dblink_exec('meal_name_c', 'BEGIN');
SELECT public.meal_name_race_assert(public.dblink_send_query('meal_name_c',
  $$SELECT public.meal_ensure_custom(
    '10000000-0000-0000-0000-000000000001',' mixed   writer synthetic curry ','dinner','[]'::jsonb,
    null,null,true,false,false)$$) = 1,
  'mixed-race ordinary authenticated ensure dispatched');
DO $$
DECLARE
  v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
  v_a integer := (SELECT pid FROM meal_name_race_pids WHERE name = 'a');
  v_c integer := (SELECT pid FROM meal_name_race_pids WHERE name = 'c');
BEGIN
  LOOP
    IF public.dblink_is_busy('meal_name_c') = 0 THEN
      RAISE EXCEPTION '0476 ordinary writer completed before delegated transaction committed';
    END IF;
    EXIT WHEN v_a = ANY(pg_blocking_pids(v_c));
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0476 ordinary writer did not block on delegated family/name lock'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
SELECT public.dblink_exec('meal_name_a', 'COMMIT');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '15 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_name_c') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0476 ordinary writer did not resume after delegated commit'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO meal_name_race_results(name, result)
  SELECT 'mixed-b', result FROM public.dblink_get_result('meal_name_c') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_name_c') AS t(result jsonb);
SELECT public.dblink_exec('meal_name_c', 'COMMIT');

SELECT public.meal_name_race_assert(
  (SELECT result->>'created_meals' = '1' FROM meal_name_race_results WHERE name='mixed-a')
  AND (SELECT result->'planned'->0->>'meal_id' FROM meal_name_race_results WHERE name='mixed-a')
      = (SELECT result->'meal'->>'id' FROM meal_name_race_results WHERE name='mixed-b')
  AND (SELECT result->>'created' = 'false' FROM meal_name_race_results WHERE name='mixed-b')
  AND (SELECT count(*) = 1 FROM public.meals
        WHERE family_id='10000000-0000-0000-0000-000000000001'
          AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))='mixed writer synthetic curry'),
  'ordinary authenticated ensure shares delegated transaction lock and reuses one meal');

-- Regression for planWeek cleanup after a later recipe lookup fails. If another
-- transaction adopts the newly-created meal first, cleanup must wait for the
-- FK key-share lock and retain the committed meal/slot instead of SET NULL.
INSERT INTO meal_cleanup_race_meals
  SELECT 'adopted', (result->'meal'->>'id')::uuid
    FROM public.dblink('meal_name_c', $$SELECT public.meal_ensure_custom(
      '10000000-0000-0000-0000-000000000001','cleanup adopted synthetic meal','dinner','[]'::jsonb,
      null,null,false,false,false)$$) AS t(result jsonb);
SELECT public.dblink_exec('meal_name_a', 'BEGIN');
SELECT public.meal_name_race_assert(public.dblink_send_query('meal_name_a', format(
  $$SELECT public.meal_plan_replace_slots_for_actor(
    '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','cleanup-adopted-plan',
    jsonb_build_array(jsonb_build_object('plan_date','2026-10-23','meal_type','dinner','meal_id',%L::uuid)))$$,
  (SELECT id::text FROM meal_cleanup_race_meals WHERE case_name='adopted'))) = 1,
  'concurrent plan adoption dispatched before cleanup');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_name_a') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0476 timed out waiting for plan adoption'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO meal_cleanup_race_results
  SELECT 'adopted-plan', result FROM public.dblink_get_result('meal_name_a') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_name_a') AS t(result jsonb);
SELECT public.dblink_exec('meal_name_c', 'BEGIN');
SELECT public.meal_name_race_assert(public.dblink_send_query('meal_name_c', format(
  $$SELECT public.meal_cleanup_unreferenced_custom(
    '10000000-0000-0000-0000-000000000001', ARRAY[%L::uuid])$$,
  (SELECT id::text FROM meal_cleanup_race_meals WHERE case_name='adopted'))) = 1,
  'cleanup dispatched while adopted plan transaction holds its FK lock');
DO $$
DECLARE
  v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
  v_a integer := (SELECT pid FROM meal_name_race_pids WHERE name = 'a');
  v_c integer := (SELECT pid FROM meal_name_race_pids WHERE name = 'c');
BEGIN
  LOOP
    IF public.dblink_is_busy('meal_name_c') = 0 THEN
      RAISE EXCEPTION '0476 cleanup completed before concurrent plan committed';
    END IF;
    EXIT WHEN v_a = ANY(pg_blocking_pids(v_c));
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0476 cleanup did not block on the plan FK lock'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
SELECT public.dblink_exec('meal_name_a', 'COMMIT');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '15 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_name_c') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0476 cleanup did not resume after plan commit'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO meal_cleanup_race_results
  SELECT 'adopted-cleanup', result FROM public.dblink_get_result('meal_name_c') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_name_c') AS t(result jsonb);
SELECT public.dblink_exec('meal_name_c', 'COMMIT');
SELECT public.meal_name_race_assert(
  (SELECT result->'planned'->0->>'meal_id' FROM meal_cleanup_race_results WHERE case_name='adopted-plan')
      = (SELECT id::text FROM meal_cleanup_race_meals WHERE case_name='adopted')
  AND (SELECT result->>'deleted'='0' AND result->>'retained_referenced'='1'
       FROM meal_cleanup_race_results WHERE case_name='adopted-cleanup')
  AND EXISTS (SELECT 1 FROM public.meals m JOIN public.meal_plans p ON p.meal_id=m.id
       WHERE m.id=(SELECT id FROM meal_cleanup_race_meals WHERE case_name='adopted')
         AND p.plan_date='2026-10-23'),
  'cleanup retains a meal adopted by a committed plan; FK does not null the slot');

-- Reverse ordering: cleanup locks and deletes an unreferenced meal first. The
-- plan blocks, then receives a clear authorization/unavailable SQLSTATE after
-- cleanup commits. It must never succeed with a silently-null meal_id.
INSERT INTO meal_cleanup_race_meals
  SELECT 'deleted-first', (result->'meal'->>'id')::uuid
    FROM public.dblink('meal_name_c', $$SELECT public.meal_ensure_custom(
      '10000000-0000-0000-0000-000000000001','cleanup deleted-first synthetic meal','dinner','[]'::jsonb,
      null,null,false,false,false)$$) AS t(result jsonb);
SELECT public.dblink_exec('meal_name_c', 'BEGIN');
SELECT public.meal_name_race_assert(public.dblink_send_query('meal_name_c', format(
  $$SELECT public.meal_cleanup_unreferenced_custom(
    '10000000-0000-0000-0000-000000000001', ARRAY[%L::uuid])$$,
  (SELECT id::text FROM meal_cleanup_race_meals WHERE case_name='deleted-first'))) = 1,
  'unreferenced meal cleanup dispatched');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_name_c') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0476 cleanup did not finish its delete'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO meal_cleanup_race_results
  SELECT 'deleted-first-cleanup', result FROM public.dblink_get_result('meal_name_c') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_name_c') AS t(result jsonb);
SELECT public.meal_name_race_assert(
  (SELECT result->>'deleted'='1' AND result->>'retained_referenced'='0'
   FROM meal_cleanup_race_results WHERE case_name='deleted-first-cleanup'),
  'cleanup acquired the candidate row and deleted the unreferenced meal');
SELECT public.dblink_exec('meal_name_a', 'BEGIN');
SELECT public.meal_name_race_assert(public.dblink_send_query('meal_name_a', format(
  $$SELECT public.meal_name_race_try_plan('cleanup-deleted-first-plan', %L::uuid, '2026-10-24'::date)$$,
  (SELECT id::text FROM meal_cleanup_race_meals WHERE case_name='deleted-first'))) = 1,
  'competing plan dispatched while cleanup owns meal delete lock');
DO $$
DECLARE
  v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
  v_a integer := (SELECT pid FROM meal_name_race_pids WHERE name = 'a');
  v_c integer := (SELECT pid FROM meal_name_race_pids WHERE name = 'c');
  v_early_result text;
BEGIN
  LOOP
    IF public.dblink_is_busy('meal_name_a') = 0 THEN
      SELECT result INTO v_early_result FROM public.dblink_get_result('meal_name_a') AS t(result text);
      PERFORM count(*) FROM public.dblink_get_result('meal_name_a') AS t(result text);
      RAISE EXCEPTION '0476 competing plan finished before cleanup commit (result %, blockers %)', v_early_result, pg_blocking_pids(v_a);
    END IF;
    EXIT WHEN v_c = ANY(pg_blocking_pids(v_a));
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0476 competing plan did not block on cleanup row lock'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
SELECT public.dblink_exec('meal_name_c', 'COMMIT');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '15 seconds';
BEGIN
  WHILE public.dblink_is_busy('meal_name_a') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION '0476 competing plan did not resume after cleanup commit'; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO meal_cleanup_race_results
  SELECT 'deleted-first-plan', to_jsonb(result) FROM public.dblink_get_result('meal_name_a') AS t(result text);
SELECT count(*) FROM public.dblink_get_result('meal_name_a') AS t(result text);
SELECT public.dblink_exec('meal_name_a', 'COMMIT');
SELECT public.meal_name_race_assert(
  (SELECT result #>> '{}' = '42501' FROM meal_cleanup_race_results WHERE case_name='deleted-first-plan')
  AND NOT EXISTS (SELECT 1 FROM public.meal_plans WHERE plan_date='2026-10-24')
  AND NOT EXISTS (SELECT 1 FROM public.meals WHERE id=(SELECT id FROM meal_cleanup_race_meals WHERE case_name='deleted-first')),
  'plan receives explicit SQLSTATE after cleanup-first delete; no null-meal plan is committed');

SELECT public.dblink_disconnect('meal_name_a');
SELECT public.dblink_disconnect('meal_name_b');
SELECT public.dblink_disconnect('meal_name_c');
DELETE FROM public.meal_plans
 WHERE family_id='10000000-0000-0000-0000-000000000001' AND plan_date IN ('2026-10-20','2026-10-21','2026-10-22');
DELETE FROM public.meal_plan_write_receipts
 WHERE family_id='10000000-0000-0000-0000-000000000001'
   AND actor_id='20000000-0000-0000-0000-000000000001'
   AND request_id IN (
     'actor-replace:' || encode(pg_catalog.sha256(convert_to('meal-name-race-a','UTF8')),'hex'),
     'actor-replace:' || encode(pg_catalog.sha256(convert_to('meal-name-race-b','UTF8')),'hex'),
     'delegated-replace:' || encode(pg_catalog.sha256(convert_to('10000000-0000-0000-0000-000000000001:20000000-0000-0000-0000-000000000001:meal-name-race-a','UTF8')),'hex'),
     'delegated-replace:' || encode(pg_catalog.sha256(convert_to('10000000-0000-0000-0000-000000000001:20000000-0000-0000-0000-000000000001:meal-name-race-b','UTF8')),'hex'),
     'actor-replace:' || encode(pg_catalog.sha256(convert_to('mixed-writer-delegated','UTF8')),'hex'),
     'delegated-replace:' || encode(pg_catalog.sha256(convert_to('10000000-0000-0000-0000-000000000001:20000000-0000-0000-0000-000000000001:mixed-writer-delegated','UTF8')),'hex')
   );
DELETE FROM public.meals
 WHERE family_id='10000000-0000-0000-0000-000000000001'
   AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) IN (
     'concurrent synthetic stew','mixed writer synthetic curry',
     'cleanup adopted synthetic meal','cleanup deleted-first synthetic meal');
DROP FUNCTION public.meal_name_race_assert(boolean, text);
DROP FUNCTION public.meal_name_race_try_plan(text, uuid, date);
COMMIT;
