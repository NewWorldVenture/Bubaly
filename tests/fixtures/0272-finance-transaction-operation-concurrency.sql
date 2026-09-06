-- Real independent sessions, not mocked promises or nested savepoints.
-- Runs after runtime.sql has committed its synthetic setup and assertion helpers.
DO $$
BEGIN
  IF current_database() <> 'bubaly_finance_operation_ci' OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION '0272 concurrency requires the dedicated synthetic PostgreSQL 17 database';
  END IF;
END $$;
CREATE EXTENSION dblink;
SET statement_timeout = '60s';
SELECT public.dblink_connect('finance_a',
  'host=/var/run/postgresql dbname=bubaly_finance_operation_ci user=postgres application_name=finance_0272_a');
SELECT public.dblink_connect('finance_b',
  'host=/var/run/postgresql dbname=bubaly_finance_operation_ci user=postgres application_name=finance_0272_b');
SELECT public.dblink_exec('finance_a', 'SET statement_timeout = ''25s''');
SELECT public.dblink_exec('finance_b', 'SET statement_timeout = ''25s''');
SELECT public.dblink_exec('finance_a', 'SET ROLE service_role');
SELECT public.dblink_exec('finance_b', 'SET ROLE service_role');
CREATE TEMP TABLE finance_session_pids (name text PRIMARY KEY, pid integer NOT NULL);
INSERT INTO finance_session_pids
 SELECT 'a', pid FROM public.dblink('finance_a', 'SELECT pg_backend_pid()') AS t(pid integer);
INSERT INTO finance_session_pids
 SELECT 'b', pid FROM public.dblink('finance_b', 'SELECT pg_backend_pid()') AS t(pid integer);
SELECT public.finance_test_assert(
  (SELECT count(DISTINCT pid) = 2 AND bool_and(pid <> pg_backend_pid()) FROM finance_session_pids),
  'concurrency uses two independent worker sessions plus the coordinator');
CREATE TEMP TABLE finance_before_concurrency AS SELECT public.finance_test_snapshot() AS rows,
  last_value AS dml FROM public.finance_test_dml;

-- Both requests must demonstrably wait on the same real ledger row before release.
BEGIN;
SELECT id FROM public.ai_tool_calls
 WHERE id = '60000000-0000-0000-0000-000000000005' FOR UPDATE;
SELECT public.finance_test_assert(public.dblink_send_query('finance_a',
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000005', public.finance_test_transaction())$$) = 1,
  'first concurrent request dispatched');
SELECT public.finance_test_assert(public.dblink_send_query('finance_b',
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000005', public.finance_test_transaction())$$) = 1,
  'second concurrent request dispatched');
DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '8 seconds'; v_waiting integer;
BEGIN
  LOOP
    SELECT count(*) INTO v_waiting FROM finance_session_pids
      WHERE cardinality(pg_blocking_pids(pid)) > 0;
    EXIT WHEN v_waiting = 2;
    IF clock_timestamp() > v_deadline THEN
      RAISE EXCEPTION '0272 concurrency: both sessions did not reach the lock barrier';
    END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
  PERFORM public.finance_test_assert(v_waiting = 2, 'both real requests reached the ledger lock barrier');
END $$;
COMMIT;

DO $$
DECLARE v_deadline timestamptz := clock_timestamp() + interval '25 seconds';
BEGIN
  WHILE public.dblink_is_busy('finance_a') = 1 OR public.dblink_is_busy('finance_b') = 1 LOOP
    IF clock_timestamp() > v_deadline THEN
      RAISE EXCEPTION '0272 concurrency: requests did not finish after lock release';
    END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
END $$;
INSERT INTO public.finance_test_results
 SELECT 'concurrent-a', result FROM public.dblink_get_result('finance_a') AS t(result jsonb);
INSERT INTO public.finance_test_results
 SELECT 'concurrent-b', result FROM public.dblink_get_result('finance_b') AS t(result jsonb);
-- Drain each asynchronous command's terminal empty result before reusing a session.
SELECT count(*) FROM public.dblink_get_result('finance_a') AS t(result jsonb);
SELECT count(*) FROM public.dblink_get_result('finance_b') AS t(result jsonb);

SELECT public.finance_test_assert(
  (SELECT count(*) = 2 AND count(DISTINCT result -> 'transaction') = 1
    AND count(*) FILTER (WHERE result ->> 'replayed' = 'false') = 1
    AND count(*) FILTER (WHERE result ->> 'replayed' = 'true') = 1
    AND bool_and(result ->> 'recordState' = 'unchanged')
   FROM public.finance_test_results WHERE label IN ('concurrent-a', 'concurrent-b')),
  'concurrent requests return one original write and one identical replay');
SELECT public.finance_test_assert(
  (SELECT count(*) = 1 FROM public.finance_transaction_operation_receipts WHERE operation_key = 'concurrent-one')
  AND (SELECT count(*) = 1 FROM public.transactions WHERE id = (
    SELECT transaction_id FROM public.finance_transaction_operation_receipts WHERE operation_key = 'concurrent-one'))
  AND (SELECT (SELECT count(*) FROM public.transactions) = jsonb_array_length(rows -> 'transactions') + 1
    AND (SELECT count(*) FROM public.finance_transaction_operation_receipts) = jsonb_array_length(rows -> 'receipts') + 1
    FROM finance_before_concurrency), 'concurrent committed state contains exactly one added transaction and receipt');
SELECT public.finance_test_assert(
  (SELECT rows -> 'ledger' = public.finance_test_snapshot() -> 'ledger'
    AND (SELECT last_value FROM public.finance_test_dml) = dml + 2
   FROM finance_before_concurrency),
  'concurrent retry adds exactly two DML attempts and never finalizes the ledger');

-- Synthetic executor reclamation after a committed write with no ledger finalization.
-- This fixture setup is the only ledger update; the RPC itself must not change it.
UPDATE public.ai_tool_calls SET attempt = attempt + 1, locked_at = '2026-09-07T00:00:00Z'
 WHERE id = '60000000-0000-0000-0000-000000000005' AND state = 'reserved' AND outputs IS NULL;
CREATE TEMP TABLE finance_before_reclaimed_retry AS SELECT public.finance_test_snapshot() AS rows,
  last_value AS dml FROM public.finance_test_dml;
SELECT public.dblink_exec('finance_a',
  $$INSERT INTO public.finance_test_results VALUES ('reclaimed-retry',
    public.finance_test_invoke('60000000-0000-0000-0000-000000000005', public.finance_test_transaction()))$$);
SELECT public.finance_test_assert(
  (SELECT result ->> 'replayed' = 'true'
    AND result -> 'transaction' = (SELECT result -> 'transaction' FROM public.finance_test_results WHERE label = 'concurrent-a')
   FROM public.finance_test_results WHERE label = 'reclaimed-retry')
  AND (SELECT rows = public.finance_test_snapshot() AND dml = (SELECT last_value FROM public.finance_test_dml)
    FROM finance_before_reclaimed_retry),
  'reclaimed reservation after missing finalization replays without a duplicate or ledger mutation');
SELECT public.dblink_disconnect('finance_a');
SELECT public.dblink_disconnect('finance_b');
