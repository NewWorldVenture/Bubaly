-- Synthetic PostgreSQL 17 proof: family membership revocation serializes with
-- meal-plan RPCs, receipt retries, and direct authenticated table writes.
-- Run after the minimal 0475 fixture and actual 0478 migration; never production.
DO $$
BEGIN
  IF current_database() <> 'bubaly_meal_plan_atomic_ci'
     OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'membership revocation proof requires the isolated synthetic PostgreSQL 17 database';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS dblink;
CREATE TEMP TABLE meal_membership_test_pids (label text PRIMARY KEY, pid integer NOT NULL);
CREATE TEMP TABLE meal_membership_test_results (label text PRIMARY KEY, result jsonb);

CREATE FUNCTION pg_temp.meal_membership_assert(p_ok boolean, p_message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'MEAL MEMBERSHIP PROOF FAILED: %', p_message; END IF;
  RAISE NOTICE 'MEAL MEMBERSHIP PASS: %', p_message;
END $$;

CREATE FUNCTION pg_temp.meal_membership_wait_blocked(p_connection text, p_pid integer, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  LOOP
    EXIT WHEN cardinality(pg_blocking_pids(p_pid)) > 0;
    IF public.dblink_is_busy(p_connection) = 0 THEN
      RAISE EXCEPTION 'MEAL MEMBERSHIP ORDERING FAILURE: % completed before reaching its expected lock wait', p_label;
    END IF;
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION 'MEAL MEMBERSHIP PROOF TIMEOUT: %', p_label; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;

CREATE FUNCTION pg_temp.meal_membership_wait_done(p_connection text, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  WHILE public.dblink_is_busy(p_connection) = 1 LOOP
    IF clock_timestamp() > v_deadline THEN RAISE EXCEPTION 'MEAL MEMBERSHIP PROOF TIMEOUT: %', p_label; END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;

CREATE FUNCTION pg_temp.meal_membership_assert_rpc_denied(p_label text, p_query text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_rows integer; v_error text;
BEGIN
  SELECT count(*) INTO v_rows FROM public.dblink('meal_membership_rpc', p_query, false) AS t(result jsonb);
  v_error := public.dblink_error_message('meal_membership_rpc');
  IF v_rows <> 0 OR v_error NOT LIKE '%Not a member of this family%' THEN
    RAISE EXCEPTION 'MEAL MEMBERSHIP AUTHORIZATION FAILURE: % unexpectedly succeeded or returned an unrelated error: %', p_label, v_error;
  END IF;
  RAISE NOTICE 'MEAL MEMBERSHIP PASS: % denied after revocation', p_label;
END $$;

CREATE FUNCTION pg_temp.meal_membership_assert_insert_denied(p_label text, p_query text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_rows integer; v_error text;
BEGIN
  SELECT count(*) INTO v_rows FROM public.dblink('meal_membership_rpc', p_query, false) AS t(id uuid);
  v_error := public.dblink_error_message('meal_membership_rpc');
  IF v_rows <> 0 OR (v_error NOT LIKE '%Not a member of this family%'
                     AND v_error NOT LIKE '%row-level security policy%') THEN
    RAISE EXCEPTION 'MEAL MEMBERSHIP AUTHORIZATION FAILURE: % unexpectedly succeeded or returned an unrelated error: %', p_label, v_error;
  END IF;
  RAISE NOTICE 'MEAL MEMBERSHIP PASS: % denied after revocation', p_label;
END $$;

SELECT public.dblink_connect('meal_membership_rpc', format('host=127.0.0.1 port=%s dbname=bubaly_meal_plan_atomic_ci user=postgres', current_setting('port')));
SELECT public.dblink_connect('meal_membership_slot', format('host=127.0.0.1 port=%s dbname=bubaly_meal_plan_atomic_ci user=postgres', current_setting('port')));
SELECT public.dblink_connect('meal_membership_revoker', format('host=127.0.0.1 port=%s dbname=bubaly_meal_plan_atomic_ci user=postgres', current_setting('port')));
SELECT public.dblink_exec('meal_membership_rpc', 'SET ROLE authenticated');
SELECT * FROM public.dblink('meal_membership_rpc', $$SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false)$$) AS t(setting text);
INSERT INTO meal_membership_test_pids VALUES
  ('rpc', (SELECT pid FROM public.dblink('meal_membership_rpc','SELECT pg_backend_pid()') AS t(pid integer))),
  ('slot', (SELECT pid FROM public.dblink('meal_membership_slot','SELECT pg_backend_pid()') AS t(pid integer))),
  ('revoker', (SELECT pid FROM public.dblink('meal_membership_revoker','SELECT pg_backend_pid()') AS t(pid integer)));

-- Keep ordinary first-write and durable same-key replay controls green.
INSERT INTO meal_membership_test_results
SELECT 'valid-first-write', result FROM public.dblink('meal_membership_rpc',
  $$SELECT public.meal_plan_replace_slots('10000000-0000-0000-0000-000000000001','membership-valid-replay','[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-15","meal_type":"dinner"}]'::jsonb)$$) AS t(result jsonb);
INSERT INTO meal_membership_test_results
SELECT 'valid-replay', result FROM public.dblink('meal_membership_rpc',
  $$SELECT public.meal_plan_replace_slots('10000000-0000-0000-0000-000000000001','membership-valid-replay','[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-15","meal_type":"dinner"}]'::jsonb)$$) AS t(result jsonb);
SELECT pg_temp.meal_membership_assert(
  (SELECT (result->>'replayed')::boolean = false FROM meal_membership_test_results WHERE label='valid-first-write')
  AND (SELECT (result->>'replayed')::boolean = true FROM meal_membership_test_results WHERE label='valid-replay'),
  'active non-guest first write and same-request replay remain valid');

-- Valid ordinary-member direct INSERT proves the trigger's fixed SECURITY
-- DEFINER lock path does not require granting UPDATE on family_members.
INSERT INTO meal_membership_test_results(label, result)
SELECT 'valid-direct-insert', jsonb_build_object('id', id)
FROM public.dblink('meal_membership_rpc',
  $$INSERT INTO public.meal_plans(family_id,meal_id,plan_date,meal_type,created_by)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','2026-10-16','dinner',auth.uid())
    RETURNING id$$) AS t(id uuid);
SELECT pg_temp.meal_membership_assert(
  (SELECT count(*) = 1 FROM public.meal_plans WHERE plan_date='2026-10-16' AND family_id='10000000-0000-0000-0000-000000000001'),
  'ordinary active member can still insert directly under existing RLS');

-- A direct DELETE passed RLS USING before its trigger waited on the slot lock
-- in the unguarded version. The trigger must now hold the membership row too.
SELECT public.dblink_exec('meal_membership_slot','BEGIN');
SELECT public.dblink_exec('meal_membership_slot', $do$DO $lock$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('meal-plan-slot:10000000-0000-0000-0000-000000000001:2026-10-16:dinner',0));
END $lock$$do$);
SELECT public.dblink_exec('meal_membership_rpc','BEGIN');
SELECT public.dblink_send_query('meal_membership_rpc',
  $$DELETE FROM public.meal_plans WHERE family_id='10000000-0000-0000-0000-000000000001' AND plan_date='2026-10-16' RETURNING id$$);
SELECT pg_temp.meal_membership_wait_blocked('meal_membership_rpc', (SELECT pid FROM meal_membership_test_pids WHERE label='rpc'), 'direct DELETE to wait on slot advisory lock');
SELECT public.dblink_exec('meal_membership_revoker','BEGIN');
SELECT public.dblink_send_query('meal_membership_revoker',
  $$UPDATE public.family_members SET is_active=false WHERE id='31000000-0000-0000-0000-000000000001' RETURNING is_active$$);
SELECT pg_temp.meal_membership_wait_blocked('meal_membership_revoker', (SELECT pid FROM meal_membership_test_pids WHERE label='revoker'), 'revocation to wait behind admitted direct DELETE');
SELECT public.dblink_exec('meal_membership_slot','COMMIT');
SELECT pg_temp.meal_membership_wait_done('meal_membership_rpc','direct DELETE to finish before revocation');
INSERT INTO meal_membership_test_results(label, result)
SELECT 'direct-delete', jsonb_build_object('id',id) FROM public.dblink_get_result('meal_membership_rpc') AS t(id uuid);
SELECT count(*) FROM public.dblink_get_result('meal_membership_rpc') AS t(id uuid);
SELECT pg_temp.meal_membership_assert(public.dblink_is_busy('meal_membership_revoker') = 1
  AND cardinality(pg_blocking_pids((SELECT pid FROM meal_membership_test_pids WHERE label='revoker'))) > 0,
  'revoker stays blocked until admitted direct DELETE transaction commits');
SELECT public.dblink_exec('meal_membership_rpc','COMMIT');
SELECT pg_temp.meal_membership_wait_done('meal_membership_revoker','direct DELETE revocation to resume after writer commit');
SELECT count(*) FROM public.dblink_get_result('meal_membership_revoker') AS t(active boolean);
SELECT count(*) FROM public.dblink_get_result('meal_membership_revoker') AS t(active boolean);
SELECT public.dblink_exec('meal_membership_revoker','COMMIT');
SELECT pg_temp.meal_membership_assert((SELECT NOT is_active FROM public.family_members WHERE id='31000000-0000-0000-0000-000000000001')
  AND NOT EXISTS (SELECT 1 FROM public.meal_plans WHERE plan_date='2026-10-16' AND family_id='10000000-0000-0000-0000-000000000001'),
  'direct DELETE completed before revocation committed');
SELECT pg_temp.meal_membership_assert_insert_denied('direct INSERT',
  $$INSERT INTO public.meal_plans(family_id,meal_id,plan_date,meal_type,created_by) VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','2026-10-17','dinner',auth.uid()) RETURNING id$$);

-- Replacement operation: the membership lock is acquired before the RPC can
-- block at the requested slot, so revocation cannot commit ahead of it.
UPDATE public.family_members SET is_active=true, role='adult' WHERE id='31000000-0000-0000-0000-000000000001';
SELECT public.dblink_exec('meal_membership_slot','BEGIN');
SELECT public.dblink_exec('meal_membership_slot', $do$DO $lock$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('meal-plan-slot:10000000-0000-0000-0000-000000000001:2026-10-12:dinner',0));
END $lock$$do$);
SELECT public.dblink_exec('meal_membership_rpc','BEGIN');
SELECT public.dblink_send_query('meal_membership_rpc',
  $$SELECT public.meal_plan_replace_slots('10000000-0000-0000-0000-000000000001','membership-replace-race','[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-12","meal_type":"dinner"}]'::jsonb)$$);
SELECT pg_temp.meal_membership_wait_blocked('meal_membership_rpc', (SELECT pid FROM meal_membership_test_pids WHERE label='rpc'), 'replacement to wait on slot advisory lock');
SELECT public.dblink_exec('meal_membership_revoker','BEGIN');
SELECT public.dblink_send_query('meal_membership_revoker',
  $$UPDATE public.family_members SET role='guest' WHERE id='31000000-0000-0000-0000-000000000001' RETURNING role::text$$);
SELECT pg_temp.meal_membership_wait_blocked('meal_membership_revoker', (SELECT pid FROM meal_membership_test_pids WHERE label='revoker'), 'demotion to wait behind admitted replacement');
SELECT public.dblink_exec('meal_membership_slot','COMMIT');
SELECT pg_temp.meal_membership_wait_done('meal_membership_rpc','replacement to finish before demotion');
INSERT INTO meal_membership_test_results SELECT 'replace-race', result FROM public.dblink_get_result('meal_membership_rpc') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_membership_rpc') AS t(result jsonb);
SELECT pg_temp.meal_membership_assert((SELECT (result->>'replayed')::boolean = false FROM meal_membership_test_results WHERE label='replace-race')
  AND public.dblink_is_busy('meal_membership_revoker') = 1,
  'replacement commits its first-write result before demotion can finish');
SELECT public.dblink_exec('meal_membership_rpc','COMMIT');
SELECT pg_temp.meal_membership_wait_done('meal_membership_revoker','demotion to resume after replacement commit');
SELECT count(*) FROM public.dblink_get_result('meal_membership_revoker') AS t(role text);
SELECT count(*) FROM public.dblink_get_result('meal_membership_revoker') AS t(role text);
SELECT public.dblink_exec('meal_membership_revoker','COMMIT');
SELECT pg_temp.meal_membership_assert((SELECT role='guest' AND is_active FROM public.family_members WHERE id='31000000-0000-0000-0000-000000000001'),
  'guest demotion committed after replacement');
SELECT pg_temp.meal_membership_assert_rpc_denied('replacement replay',
  $$SELECT public.meal_plan_replace_slots('10000000-0000-0000-0000-000000000001','membership-replace-race','[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-12","meal_type":"dinner"}]'::jsonb)$$);
SELECT pg_temp.meal_membership_assert_rpc_denied('new replacement',
  $$SELECT public.meal_plan_replace_slots('10000000-0000-0000-0000-000000000001','membership-replace-new','[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-18","meal_type":"dinner"}]'::jsonb)$$);

-- Removal uses the same admission lock, held across its slot wait and delete.
UPDATE public.family_members SET role='adult' WHERE id='31000000-0000-0000-0000-000000000001';
INSERT INTO public.meal_plans(id,family_id,meal_id,plan_date,meal_type,created_by)
VALUES ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001','2026-10-04','dinner','20000000-0000-0000-0000-000000000001');
SELECT public.dblink_exec('meal_membership_slot','BEGIN');
SELECT public.dblink_exec('meal_membership_slot', $do$DO $lock$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('meal-plan-slot:10000000-0000-0000-0000-000000000001:2026-10-04:dinner',0));
END $lock$$do$);
SELECT public.dblink_exec('meal_membership_rpc','BEGIN');
SELECT public.dblink_send_query('meal_membership_rpc',
  $$SELECT public.meal_plan_remove_slot('10000000-0000-0000-0000-000000000001','membership-remove-race','40000000-0000-0000-0000-000000000001')$$);
SELECT pg_temp.meal_membership_wait_blocked('meal_membership_rpc', (SELECT pid FROM meal_membership_test_pids WHERE label='rpc'), 'removal to wait on slot advisory lock');
SELECT public.dblink_exec('meal_membership_revoker','BEGIN');
SELECT public.dblink_send_query('meal_membership_revoker',
  $$UPDATE public.family_members SET is_active=false WHERE id='31000000-0000-0000-0000-000000000001' RETURNING is_active$$);
SELECT pg_temp.meal_membership_wait_blocked('meal_membership_revoker', (SELECT pid FROM meal_membership_test_pids WHERE label='revoker'), 'revocation to wait behind admitted removal');
SELECT public.dblink_exec('meal_membership_slot','COMMIT');
SELECT pg_temp.meal_membership_wait_done('meal_membership_rpc','removal to finish before revocation');
INSERT INTO meal_membership_test_results SELECT 'remove-race', result FROM public.dblink_get_result('meal_membership_rpc') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_membership_rpc') AS t(result jsonb);
SELECT pg_temp.meal_membership_assert((SELECT (result->>'replayed')::boolean = false FROM meal_membership_test_results WHERE label='remove-race')
  AND public.dblink_is_busy('meal_membership_revoker') = 1,
  'removal commits its first-write result before revocation can finish');
SELECT public.dblink_exec('meal_membership_rpc','COMMIT');
SELECT pg_temp.meal_membership_wait_done('meal_membership_revoker','removal revocation to resume after writer commit');
SELECT count(*) FROM public.dblink_get_result('meal_membership_revoker') AS t(active boolean);
SELECT count(*) FROM public.dblink_get_result('meal_membership_revoker') AS t(active boolean);
SELECT public.dblink_exec('meal_membership_revoker','COMMIT');
SELECT pg_temp.meal_membership_assert(NOT EXISTS (SELECT 1 FROM public.meal_plans WHERE id='40000000-0000-0000-0000-000000000001'),
  'remove completed before revocation committed');
SELECT pg_temp.meal_membership_assert_rpc_denied('removal replay',
  $$SELECT public.meal_plan_remove_slot('10000000-0000-0000-0000-000000000001','membership-remove-race','40000000-0000-0000-0000-000000000001')$$);

-- Receipt replay may itself wait. Its admission lock must be held before that
-- wait, so revocation commits only after the retry has returned its receipt.
UPDATE public.family_members SET is_active=true, role='adult' WHERE id='31000000-0000-0000-0000-000000000001';
INSERT INTO meal_membership_test_results
SELECT 'replay-seed', result FROM public.dblink('meal_membership_rpc',
  $$SELECT public.meal_plan_replace_slots('10000000-0000-0000-0000-000000000001','membership-replay-race','[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-13","meal_type":"dinner"}]'::jsonb)$$) AS t(result jsonb);
SELECT public.dblink_exec('meal_membership_slot','BEGIN');
SELECT public.dblink_exec('meal_membership_slot', $do$DO $lock$ BEGIN
  PERFORM 1 FROM public.meal_plan_write_receipts WHERE family_id='10000000-0000-0000-0000-000000000001'
    AND actor_id='20000000-0000-0000-0000-000000000001' AND request_id='membership-replay-race' FOR UPDATE;
END $lock$$do$);
SELECT public.dblink_exec('meal_membership_rpc','BEGIN');
SELECT public.dblink_send_query('meal_membership_rpc',
  $$SELECT public.meal_plan_replace_slots('10000000-0000-0000-0000-000000000001','membership-replay-race','[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-13","meal_type":"dinner"}]'::jsonb)$$);
SELECT pg_temp.meal_membership_wait_blocked('meal_membership_rpc', (SELECT pid FROM meal_membership_test_pids WHERE label='rpc'), 'receipt replay to wait on existing receipt row');
SELECT public.dblink_exec('meal_membership_revoker','BEGIN');
SELECT public.dblink_send_query('meal_membership_revoker',
  $$UPDATE public.family_members SET is_active=false WHERE id='31000000-0000-0000-0000-000000000001' RETURNING is_active$$);
SELECT pg_temp.meal_membership_wait_blocked('meal_membership_revoker', (SELECT pid FROM meal_membership_test_pids WHERE label='revoker'), 'revocation to wait behind admitted receipt replay');
SELECT public.dblink_exec('meal_membership_slot','COMMIT');
SELECT pg_temp.meal_membership_wait_done('meal_membership_rpc','receipt replay to finish before revocation');
INSERT INTO meal_membership_test_results SELECT 'replay-race', result FROM public.dblink_get_result('meal_membership_rpc') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('meal_membership_rpc') AS t(result jsonb);
SELECT pg_temp.meal_membership_assert((SELECT (result->>'replayed')::boolean FROM meal_membership_test_results WHERE label='replay-race')
  AND public.dblink_is_busy('meal_membership_revoker') = 1,
  'receipt replay returns only before the pending revocation can commit');
SELECT public.dblink_exec('meal_membership_rpc','COMMIT');
SELECT pg_temp.meal_membership_wait_done('meal_membership_revoker','replay revocation to resume after retry commit');
SELECT count(*) FROM public.dblink_get_result('meal_membership_revoker') AS t(active boolean);
SELECT count(*) FROM public.dblink_get_result('meal_membership_revoker') AS t(active boolean);
SELECT public.dblink_exec('meal_membership_revoker','COMMIT');
SELECT pg_temp.meal_membership_assert(NOT (SELECT is_active FROM public.family_members WHERE id='31000000-0000-0000-0000-000000000001'),
  'replay revocation committed after receipt was returned');
SELECT pg_temp.meal_membership_assert_rpc_denied('receipt replay after revocation',
  $$SELECT public.meal_plan_replace_slots('10000000-0000-0000-0000-000000000001','membership-replay-race','[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-13","meal_type":"dinner"}]'::jsonb)$$);

SELECT public.dblink_disconnect('meal_membership_rpc');
SELECT public.dblink_disconnect('meal_membership_slot');
SELECT public.dblink_disconnect('meal_membership_revoker');
