-- Execute only after the minimal bootstrap and actual migration 0274.
DO $$
BEGIN
  IF current_database() <> 'bubaly_finance_operation_ci' OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION '0274 runtime requires the dedicated synthetic PostgreSQL 17 database';
  END IF;
END $$;

CREATE FUNCTION public.finance_test_assert(p_ok boolean, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0274 assertion: %', p_label;
  END IF;
  RAISE NOTICE '0274 PASS %', p_label;
END $$;

CREATE FUNCTION public.finance_test_inputs() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"name":"  Coffee  ","amount":4.125,"type":"expense","merchant":" Shop ",
    "category":" food ","notes":"  ","account_id":"40000000-0000-0000-0000-000000000001",
    "member_id":"30000000-0000-0000-0000-000000000002",
    "receipt_document_id":"50000000-0000-0000-0000-000000000001"}'::jsonb
$$;
CREATE FUNCTION public.finance_test_intent() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"version":1,"name":"Coffee","requestedAmount":4.125,"type":"expense",
    "merchant":"Shop","category":"food","date":null,"notes":null,
    "accountId":"40000000-0000-0000-0000-000000000001",
    "memberId":"30000000-0000-0000-0000-000000000002",
    "receiptDocumentId":"50000000-0000-0000-0000-000000000001","source":"ai"}'::jsonb
$$;
CREATE FUNCTION public.finance_test_transaction() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"family_id":"10000000-0000-0000-0000-000000000001","name":"Coffee","amount":4.13,
    "type":"expense","merchant":"Shop","category":"food","date":"2026-09-06","notes":null,
    "account_id":"40000000-0000-0000-0000-000000000001",
    "member_id":"30000000-0000-0000-0000-000000000002",
    "receipt_document_id":"50000000-0000-0000-0000-000000000001","source":"ai",
    "created_by":"20000000-0000-0000-0000-000000000001"}'::jsonb
$$;

CREATE FUNCTION public.finance_test_invoke(
  p_id uuid, p_transaction jsonb DEFAULT NULL,
  p_family uuid DEFAULT '10000000-0000-0000-0000-000000000001',
  p_user uuid DEFAULT '20000000-0000-0000-0000-000000000001',
  p_member uuid DEFAULT '30000000-0000-0000-0000-000000000001',
  p_kind text DEFAULT 'ai',
  p_expected jsonb DEFAULT public.finance_test_inputs(),
  p_intent jsonb DEFAULT public.finance_test_intent()
) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER AS $$
  SELECT public.finance_record_transaction_operation(
    p_id, p_family, p_user, p_member, p_kind, p_expected, p_intent, p_transaction
  )
$$;
CREATE FUNCTION public.finance_test_seed(p_id uuid, p_key text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO public.ai_tool_calls(
    id, family_id, tool_name, requested_by, requested_by_member_id,
    actor_kind, inputs, idempotency_key, locked_at
  ) VALUES (
    p_id, '10000000-0000-0000-0000-000000000001', 'finances.createTransaction',
    '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
    'ai', public.finance_test_inputs(), p_key, '2026-09-06T00:00:00Z'
  )
$$;
-- Deliberately VOLATILE, with independent top-level snapshots around writes.
CREATE FUNCTION public.finance_test_snapshot() RETURNS jsonb
LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object(
    'transactions', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM public.transactions t),
    'receipts', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY family_id, operation_key), '[]')
      FROM public.finance_transaction_operation_receipts r),
    'ledger', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id), '[]') FROM public.ai_tool_calls c)
  )
$$;
CREATE TABLE public.finance_test_results (label text PRIMARY KEY, result jsonb);
GRANT INSERT ON public.finance_test_results TO service_role;

-- Nontransactional counters detect attempted DML even if a subtransaction rolls back.
CREATE SEQUENCE public.finance_test_dml START WITH 1;
SELECT nextval('public.finance_test_dml');
CREATE FUNCTION public.finance_test_observe_dml() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nextval('public.finance_test_dml');
  RETURN NULL;
END $$;
CREATE TRIGGER finance_test_transaction_dml BEFORE INSERT OR UPDATE OR DELETE ON public.transactions
  FOR EACH STATEMENT EXECUTE FUNCTION public.finance_test_observe_dml();
CREATE TRIGGER finance_test_receipt_dml BEFORE INSERT OR UPDATE OR DELETE ON public.finance_transaction_operation_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION public.finance_test_observe_dml();
CREATE TRIGGER finance_test_ledger_dml BEFORE INSERT OR UPDATE OR DELETE ON public.ai_tool_calls
  FOR EACH STATEMENT EXECUTE FUNCTION public.finance_test_observe_dml();

CREATE FUNCTION public.finance_test_reject(
  p_query text, p_label text, p_state text DEFAULT '22023', p_role text DEFAULT 'service_role'
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_state text; v_before jsonb := public.finance_test_snapshot();
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_query;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  RESET ROLE;
  PERFORM public.finance_test_assert(v_state = p_state, p_label || ': expected SQLSTATE');
  PERFORM public.finance_test_assert(public.finance_test_snapshot() = v_before, p_label || ': no committed writes');
END $$;

INSERT INTO public.families VALUES
 ('10000000-0000-0000-0000-000000000001'), ('10000000-0000-0000-0000-000000000002');
INSERT INTO auth.users VALUES
 ('20000000-0000-0000-0000-000000000001'), ('20000000-0000-0000-0000-000000000002');
INSERT INTO public.family_members VALUES
 ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
 ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001'),
 ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002');
INSERT INTO public.financial_accounts VALUES
 ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
 ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002');
INSERT INTO public.documents VALUES
 ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
 ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002');
SELECT public.finance_test_seed('60000000-0000-0000-0000-000000000001', 'purchase-one');
SELECT public.finance_test_seed('60000000-0000-0000-0000-000000000002', 'purchase-two');
SELECT public.finance_test_seed('60000000-0000-0000-0000-000000000003', 'binding-negative');
SELECT public.finance_test_seed('60000000-0000-0000-0000-000000000004', 'rollback-insert');
SELECT public.finance_test_seed('60000000-0000-0000-0000-000000000005', 'concurrent-one');

CREATE TEMP TABLE finance_before AS SELECT public.finance_test_snapshot() AS rows, last_value AS dml
  FROM public.finance_test_dml;
SET ROLE service_role;
INSERT INTO public.finance_test_results VALUES
 ('probe-miss', public.finance_test_invoke('60000000-0000-0000-0000-000000000001'));
RESET ROLE;
SELECT public.finance_test_assert((SELECT result IS NULL FROM public.finance_test_results WHERE label = 'probe-miss'),
  'receipt-only probe misses without creating a transaction');
SELECT public.finance_test_assert(
  (SELECT rows = public.finance_test_snapshot() AND dml = (SELECT last_value FROM public.finance_test_dml)
   FROM finance_before), 'probe has neither committed nor attempted DML');

SET ROLE service_role;
INSERT INTO public.finance_test_results VALUES
 ('first', public.finance_test_invoke('60000000-0000-0000-0000-000000000001', public.finance_test_transaction()));
RESET ROLE;
SELECT public.finance_test_assert(
  (SELECT result ->> 'replayed' = 'false' AND result ->> 'recordState' = 'unchanged'
    AND result #>> '{transaction,amount}' = '4.13'
    AND result #>> '{transaction,status}' = 'posted'
    AND result #>> '{transaction,fingerprint}' IS NULL
   FROM public.finance_test_results WHERE label = 'first'), 'first write returns the complete physical row');
SELECT public.finance_test_assert(
  (SELECT count(*) = 1 FROM public.transactions)
  AND (SELECT count(*) = 1 FROM public.finance_transaction_operation_receipts),
  'first operation commits one transaction and one durable receipt');
SELECT public.finance_test_assert(
  (SELECT rows -> 'ledger' = public.finance_test_snapshot() -> 'ledger' FROM finance_before),
  'RPC does not finalize or mutate the ledger');

-- The first transaction committed while the ledger remained reserved with no output.
CREATE TEMP TABLE finance_after_first AS SELECT public.finance_test_snapshot() AS rows, last_value AS dml
  FROM public.finance_test_dml;
SET ROLE service_role;
INSERT INTO public.finance_test_results VALUES
 ('retry-no-finalization', public.finance_test_invoke('60000000-0000-0000-0000-000000000001', public.finance_test_transaction())),
 ('probe-hit', public.finance_test_invoke('60000000-0000-0000-0000-000000000001')),
 ('midnight', public.finance_test_invoke('60000000-0000-0000-0000-000000000001',
   public.finance_test_transaction() || '{"date":"2026-09-07"}'::jsonb));
RESET ROLE;
SELECT public.finance_test_assert(
  (SELECT bool_and(result ->> 'replayed' = 'true' AND result ->> 'recordState' = 'unchanged'
      AND result -> 'transaction' = (SELECT result -> 'transaction' FROM public.finance_test_results WHERE label = 'first'))
   FROM public.finance_test_results WHERE label IN ('retry-no-finalization', 'probe-hit', 'midnight')),
  'missing finalization, receipt probe and midnight retry replay the original row');
SELECT public.finance_test_assert(
  (SELECT rows = public.finance_test_snapshot() AND dml = (SELECT last_value FROM public.finance_test_dml)
   FROM finance_after_first), 'replays perform no DML and never update ledger fields');

-- Independent keys must preserve identical purchases rather than deduplicate by contents.
SET ROLE service_role;
INSERT INTO public.finance_test_results VALUES
 ('second', public.finance_test_invoke('60000000-0000-0000-0000-000000000002', public.finance_test_transaction()));
RESET ROLE;
SELECT public.finance_test_assert(
  (SELECT count(*) = 2 AND count(DISTINCT id) = 2 FROM public.transactions)
  AND (SELECT count(*) = 2 FROM public.finance_transaction_operation_receipts),
  'identical purchases with distinct operation keys remain two purchases');

CREATE TEMP TABLE finance_before_negatives AS SELECT last_value AS dml FROM public.finance_test_dml;
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000003', public.finance_test_transaction(),
    p_family => '10000000-0000-0000-0000-000000000002')$$, 'foreign family');
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000003', public.finance_test_transaction(),
    p_user => '20000000-0000-0000-0000-000000000002')$$, 'different user');
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000003', public.finance_test_transaction(),
    p_member => NULL)$$, 'null-safe member mismatch');
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000003', public.finance_test_transaction(),
    p_kind => 'system')$$, 'different actor kind');
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000003', public.finance_test_transaction(),
    p_expected => public.finance_test_inputs() || '{"amount":5}'::jsonb)$$, 'changed observed ledger inputs');
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000003', public.finance_test_transaction(),
    p_intent => public.finance_test_intent() || '{"requestedAmount":5}'::jsonb)$$, 'changed canonical intent');
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000003',
    public.finance_test_transaction() || '{"name":"Other purchase"}'::jsonb)$$, 'changed normalized insert payload');
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000003',
    public.finance_test_transaction() || '{"amount":0}'::jsonb)$$, 'zero quantized amount');
SELECT public.finance_test_assert(
  (SELECT dml = (SELECT last_value FROM public.finance_test_dml) FROM finance_before_negatives),
  'binding and payload failures occur before attempted DML');

UPDATE public.ai_tool_calls SET tool_name = 'other.tool'
 WHERE id = '60000000-0000-0000-0000-000000000003';
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000003', public.finance_test_transaction())$$,
  'wrong canonical tool');
UPDATE public.ai_tool_calls SET tool_name = 'finances.createTransaction'
 WHERE id = '60000000-0000-0000-0000-000000000003';

-- Change both the ledger snapshot and intent: historical receipt binding must still fail.
UPDATE public.ai_tool_calls SET inputs = inputs || '{"amount":5}'::jsonb
 WHERE id = '60000000-0000-0000-0000-000000000001';
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000001',
    p_expected => public.finance_test_inputs() || '{"amount":5}'::jsonb,
    p_intent => public.finance_test_intent() || '{"requestedAmount":5}'::jsonb)$$,
  'existing durable key rejects changed intent even after ledger input replacement');
UPDATE public.ai_tool_calls SET inputs = public.finance_test_inputs()
 WHERE id = '60000000-0000-0000-0000-000000000001';
UPDATE public.ai_tool_calls SET requested_by = '20000000-0000-0000-0000-000000000002'
 WHERE id = '60000000-0000-0000-0000-000000000001';
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000001',
    p_user => '20000000-0000-0000-0000-000000000002')$$,
  'existing durable key rejects changed actor even after ledger actor replacement');
UPDATE public.ai_tool_calls SET requested_by = '20000000-0000-0000-0000-000000000001'
 WHERE id = '60000000-0000-0000-0000-000000000001';

-- Test all three family references using normalized payloads matching their ledger.
DO $$
DECLARE
  v_field text; v_intent_field text; v_foreign text;
  v_inputs jsonb; v_intent jsonb; v_transaction jsonb;
BEGIN
  FOR v_field, v_intent_field, v_foreign IN VALUES
    ('account_id', 'accountId', '40000000-0000-0000-0000-000000000002'),
    ('member_id', 'memberId', '30000000-0000-0000-0000-000000000003'),
    ('receipt_document_id', 'receiptDocumentId', '50000000-0000-0000-0000-000000000002')
  LOOP
    v_inputs := public.finance_test_inputs() || jsonb_build_object(v_field, v_foreign);
    v_intent := public.finance_test_intent() || jsonb_build_object(v_intent_field, v_foreign);
    v_transaction := public.finance_test_transaction() || jsonb_build_object(v_field, v_foreign);
    UPDATE public.ai_tool_calls SET inputs = v_inputs
      WHERE id = '60000000-0000-0000-0000-000000000003';
    PERFORM public.finance_test_reject(format(
      'SELECT public.finance_test_invoke(%L, %L::jsonb, p_expected => %L::jsonb, p_intent => %L::jsonb)',
      '60000000-0000-0000-0000-000000000003', v_transaction, v_inputs, v_intent),
      'RPC rejects foreign ' || v_field);
  END LOOP;
END $$;
UPDATE public.ai_tool_calls SET inputs = public.finance_test_inputs()
 WHERE id = '60000000-0000-0000-0000-000000000003';

-- Force failure between the actual transaction insert and actual receipt insert.
CREATE FUNCTION public.finance_test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_key = 'rollback-insert' THEN
    RAISE EXCEPTION USING ERRCODE = 'P7702', MESSAGE = 'synthetic receipt insertion failure';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finance_test_fail_receipt BEFORE INSERT ON public.finance_transaction_operation_receipts
  FOR EACH ROW EXECUTE FUNCTION public.finance_test_fail_receipt();
CREATE TEMP TABLE finance_before_rollback AS SELECT last_value AS dml FROM public.finance_test_dml;
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000004', public.finance_test_transaction())$$,
  'transaction and receipt roll back together', 'P7702');
SELECT public.finance_test_assert(
  (SELECT (SELECT last_value FROM public.finance_test_dml) >= dml + 2 FROM finance_before_rollback)
  AND NOT EXISTS (SELECT 1 FROM public.finance_transaction_operation_receipts WHERE operation_key = 'rollback-insert'),
  'failure occurred after attempted transaction and receipt inserts');

-- Runtime permission failures, not just catalog inspection.
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000001')$$,
  'anonymous RPC denied', '42501', 'anon');
SELECT public.finance_test_reject(
  $$SELECT public.finance_test_invoke('60000000-0000-0000-0000-000000000001')$$,
  'authenticated RPC denied', '42501', 'authenticated');
SELECT public.finance_test_reject(
  $$SELECT * FROM public.finance_transaction_operation_receipts$$,
  'direct service-role receipt read denied', '42501');
SELECT public.finance_test_reject(
  $$INSERT INTO public.finance_transaction_operation_receipts
    SELECT * FROM public.finance_transaction_operation_receipts WHERE false$$,
  'direct service-role receipt insert denied', '42501');
SELECT public.finance_test_reject(
  $$UPDATE public.finance_transaction_operation_receipts SET intent_version = 1$$,
  'direct service-role receipt update denied', '42501');
SELECT public.finance_test_reject(
  $$DELETE FROM public.finance_transaction_operation_receipts$$,
  'direct service-role receipt delete denied', '42501');
SELECT public.finance_test_reject(
  $$TRUNCATE public.finance_transaction_operation_receipts$$,
  'direct service-role receipt truncate denied', '42501');

UPDATE public.transactions SET notes = 'Edited after original recording'
 WHERE id = (SELECT (result #>> '{transaction,id}')::uuid FROM public.finance_test_results WHERE label = 'first');
SET ROLE service_role;
INSERT INTO public.finance_test_results VALUES
 ('edited', public.finance_test_invoke('60000000-0000-0000-0000-000000000001'));
RESET ROLE;
SELECT public.finance_test_assert(
  (SELECT result ->> 'recordState' = 'edited' AND result ->> 'replayed' = 'true'
    AND result -> 'transaction' = (SELECT result -> 'transaction' FROM public.finance_test_results WHERE label = 'first')
   FROM public.finance_test_results WHERE label = 'edited'), 'edited replay preserves the original result');

DELETE FROM public.transactions
 WHERE id = (SELECT (result #>> '{transaction,id}')::uuid FROM public.finance_test_results WHERE label = 'first');
DELETE FROM public.financial_accounts WHERE id = '40000000-0000-0000-0000-000000000001';
DELETE FROM public.documents WHERE id = '50000000-0000-0000-0000-000000000001';
DELETE FROM public.family_members WHERE id = '30000000-0000-0000-0000-000000000002';
CREATE TEMP TABLE finance_before_deleted_replay AS SELECT public.finance_test_snapshot() AS rows,
  last_value AS dml FROM public.finance_test_dml;
SET ROLE service_role;
INSERT INTO public.finance_test_results VALUES
 ('deleted-probe', public.finance_test_invoke('60000000-0000-0000-0000-000000000001')),
 ('deleted-write', public.finance_test_invoke('60000000-0000-0000-0000-000000000001', public.finance_test_transaction()));
RESET ROLE;
SELECT public.finance_test_assert(
  (SELECT bool_and(result ->> 'recordState' = 'deleted' AND result ->> 'replayed' = 'true'
    AND result -> 'transaction' = (SELECT result -> 'transaction' FROM public.finance_test_results WHERE label = 'first'))
   FROM public.finance_test_results WHERE label IN ('deleted-probe', 'deleted-write')),
  'deleted transaction and references do not destroy history or cause recreation');
SELECT public.finance_test_assert(
  (SELECT rows = public.finance_test_snapshot() AND dml = (SELECT last_value FROM public.finance_test_dml)
    FROM finance_before_deleted_replay), 'deleted replay bypasses obsolete references without DML');

-- The durable operation key also survives deletion/regeneration of the ledger ID.
DELETE FROM public.ai_tool_calls WHERE id = '60000000-0000-0000-0000-000000000001';
SELECT public.finance_test_seed('60000000-0000-0000-0000-000000000006', 'purchase-one');
SET ROLE service_role;
INSERT INTO public.finance_test_results VALUES
 ('replacement-ledger', public.finance_test_invoke('60000000-0000-0000-0000-000000000006', public.finance_test_transaction()));
RESET ROLE;
SELECT public.finance_test_assert(
  (SELECT result ->> 'replayed' = 'true' AND result ->> 'recordState' = 'deleted'
    AND result -> 'transaction' = (SELECT result -> 'transaction' FROM public.finance_test_results WHERE label = 'first')
   FROM public.finance_test_results WHERE label = 'replacement-ledger')
  AND (SELECT original_tool_call_id = '60000000-0000-0000-0000-000000000001'::uuid
    FROM public.finance_transaction_operation_receipts WHERE operation_key = 'purchase-one'),
  'regenerated ledger ID replays by durable key and retains original provenance');

-- Restore only synthetic reference rows for the independent committed concurrency case.
INSERT INTO public.financial_accounts VALUES
 ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001');
INSERT INTO public.family_members VALUES
 ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001');
INSERT INTO public.documents VALUES
 ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001');
