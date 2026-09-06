-- Durable purchase execution identity, independent of transaction charge fingerprints.
-- Application access is RPC-only. Ledger/transaction deletion never cascades into history.
CREATE TABLE public.finance_transaction_operation_receipts (
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (length(operation_key) > 0),
  original_tool_call_id uuid NOT NULL,
  actor_user_id uuid,
  actor_member_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('ai', 'member', 'system')),
  intent_version integer NOT NULL DEFAULT 1 CHECK (intent_version = 1),
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
  transaction_id uuid NOT NULL,
  transaction_snapshot jsonb NOT NULL CHECK (jsonb_typeof(transaction_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, operation_key)
);

ALTER TABLE public.finance_transaction_operation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.finance_transaction_operation_receipts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.finance_record_transaction_operation(
  p_tool_call_id uuid,
  p_family_id uuid,
  p_actor_user_id uuid,
  p_actor_member_id uuid,
  p_actor_kind text,
  p_expected_inputs jsonb,
  p_intent jsonb,
  p_transaction jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET timezone = 'UTC'
AS $function$
DECLARE
  v_call public.ai_tool_calls%ROWTYPE;
  v_receipt public.finance_transaction_operation_receipts%ROWTYPE;
  v_transaction public.transactions%ROWTYPE;
  v_inputs jsonb;
  v_bound_intent jsonb;
  v_expected_transaction jsonb;
  v_current jsonb;
  v_field text;
  v_name text;
  v_date text;
  v_type text;
  v_source text;
  v_requested_amount numeric;
  v_amount numeric;
  v_account_id uuid;
  v_member_id uuid;
  v_document_id uuid;
  -- ECMAScript String.trim whitespace, not just PostgreSQL btrim's ordinary space.
  v_whitespace constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF p_actor_kind IS NULL OR p_actor_kind NOT IN ('ai', 'member', 'system') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation actor is invalid';
  END IF;

  SELECT c.* INTO v_call FROM public.ai_tool_calls AS c
  WHERE c.id = p_tool_call_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation reservation is missing';
  END IF;
  IF v_call.family_id IS DISTINCT FROM p_family_id
     OR v_call.tool_name IS DISTINCT FROM 'finances.createTransaction'
     OR v_call.requested_by IS DISTINCT FROM p_actor_user_id
     OR v_call.requested_by_member_id IS DISTINCT FROM p_actor_member_id
     OR v_call.actor_kind::text IS DISTINCT FROM p_actor_kind
     OR v_call.inputs IS DISTINCT FROM p_expected_inputs
     OR v_call.idempotency_key IS NULL OR length(v_call.idempotency_key) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation reservation binding changed';
  END IF;

  v_inputs := v_call.inputs;
  IF jsonb_typeof(v_inputs) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_inputs -> 'name') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v_inputs -> 'amount') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation inputs are invalid';
  END IF;
  FOREACH v_field IN ARRAY ARRAY[
    'merchant', 'category', 'date', 'notes', 'type',
    'account_id', 'member_id', 'receipt_document_id'
  ] LOOP
    IF v_inputs ? v_field AND v_inputs -> v_field <> 'null'::jsonb
       AND jsonb_typeof(v_inputs -> v_field) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation input field is invalid';
    END IF;
  END LOOP;

  v_name := btrim(v_inputs ->> 'name', v_whitespace);
  v_requested_amount := (v_inputs ->> 'amount')::numeric;
  v_type := coalesce(v_inputs ->> 'type', 'expense');
  v_date := nullif(btrim(v_inputs ->> 'date', v_whitespace), '');
  v_source := CASE WHEN p_actor_kind = 'ai' THEN 'ai' ELSE 'manual' END;
  IF v_name = '' OR v_requested_amount <= 0
     OR v_requested_amount > 1.7976931348623157e308::numeric
     OR v_type NOT IN ('income', 'expense', 'transfer')
     OR (v_date IS NOT NULL AND v_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation canonical inputs are invalid';
  END IF;

  -- The tool has no source argument. Its canonical source is bound to its actor.
  -- Keep the original amount and omitted-date sentinel, not the first write's date.
  v_bound_intent := jsonb_build_object(
    'version', 1, 'name', v_name, 'requestedAmount', v_requested_amount,
    'type', v_type, 'merchant', nullif(btrim(v_inputs ->> 'merchant', v_whitespace), ''),
    'category', nullif(btrim(v_inputs ->> 'category', v_whitespace), ''),
    'date', v_date, 'notes', nullif(btrim(v_inputs ->> 'notes', v_whitespace), ''),
    'accountId', v_inputs ->> 'account_id', 'memberId', v_inputs ->> 'member_id',
    'receiptDocumentId', v_inputs ->> 'receipt_document_id', 'source', v_source
  );
  IF p_intent IS DISTINCT FROM v_bound_intent THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation intent does not match its reservation';
  END IF;

  SELECT r.* INTO v_receipt FROM public.finance_transaction_operation_receipts AS r
  WHERE r.family_id = p_family_id AND r.operation_key = v_call.idempotency_key;
  IF FOUND THEN
    IF v_receipt.actor_user_id IS DISTINCT FROM p_actor_user_id
       OR v_receipt.actor_member_id IS DISTINCT FROM p_actor_member_id
       OR v_receipt.actor_kind IS DISTINCT FROM p_actor_kind
       OR v_receipt.intent_version <> 1 OR v_receipt.intent IS DISTINCT FROM p_intent THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation receipt binding changed';
    END IF;
    SELECT to_jsonb(t) INTO v_current FROM public.transactions AS t
    WHERE t.id = v_receipt.transaction_id AND t.family_id = p_family_id;
    RETURN jsonb_build_object(
      'transaction', v_receipt.transaction_snapshot, 'replayed', true,
      'recordState', CASE WHEN v_current IS NULL THEN 'deleted'
        WHEN v_current = v_receipt.transaction_snapshot THEN 'unchanged' ELSE 'edited' END
    );
  END IF;

  -- A miss must return before reference checks or any insert. The caller then
  -- performs its own RLS-scoped reference checks before submitting a write.
  IF p_transaction IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(p_transaction) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_transaction -> 'amount') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_transaction -> 'date') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation transaction payload is invalid';
  END IF;
  v_amount := (p_transaction ->> 'amount')::numeric;
  IF v_amount <= 0 OR v_amount > 9999999999.99
     OR v_amount <> round(v_amount, 2)
     -- The service owns JS cent quantization. Check its bounded cent result
     -- without imposing a conflicting SQL rounding choice at floating-point ties.
     OR abs(v_amount - v_requested_amount) > 0.005000001 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation quantized amount is invalid';
  END IF;
  IF p_transaction ->> 'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR (v_date IS NOT NULL AND p_transaction ->> 'date' IS DISTINCT FROM v_date) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation transaction date is invalid';
  END IF;
  -- Casting also rejects impossible calendar dates before the transaction insert.
  PERFORM (p_transaction ->> 'date')::date;

  v_expected_transaction := jsonb_build_object(
    'family_id', p_family_id, 'name', v_name, 'amount', v_amount, 'type', v_type,
    'merchant', v_bound_intent -> 'merchant', 'category', v_bound_intent -> 'category',
    'date', p_transaction -> 'date', 'notes', v_bound_intent -> 'notes',
    'account_id', v_bound_intent -> 'accountId', 'member_id', v_bound_intent -> 'memberId',
    'receipt_document_id', v_bound_intent -> 'receiptDocumentId',
    'source', v_source, 'created_by', p_actor_user_id
  );
  IF p_transaction IS DISTINCT FROM v_expected_transaction THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation transaction differs from its intent';
  END IF;

  v_account_id := (v_bound_intent ->> 'accountId')::uuid;
  v_member_id := (v_bound_intent ->> 'memberId')::uuid;
  v_document_id := (v_bound_intent ->> 'receiptDocumentId')::uuid;
  IF v_account_id IS NOT NULL THEN
    PERFORM 1 FROM public.financial_accounts
    WHERE id = v_account_id AND family_id = p_family_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation account is outside its family';
    END IF;
  END IF;
  IF v_member_id IS NOT NULL THEN
    PERFORM 1 FROM public.family_members
    WHERE id = v_member_id AND family_id = p_family_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation member is outside its family';
    END IF;
  END IF;
  IF v_document_id IS NOT NULL THEN
    PERFORM 1 FROM public.documents
    WHERE id = v_document_id AND family_id = p_family_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'finance operation document is outside its family';
    END IF;
  END IF;

  INSERT INTO public.transactions (
    family_id, name, amount, type, merchant, category, date, notes,
    account_id, member_id, receipt_document_id, source, created_by
  ) VALUES (
    p_family_id, v_name, v_amount, v_type::public.transaction_type,
    v_bound_intent ->> 'merchant', v_bound_intent ->> 'category',
    (p_transaction ->> 'date')::date, v_bound_intent ->> 'notes',
    v_account_id, v_member_id, v_document_id, v_source, p_actor_user_id
  ) RETURNING * INTO v_transaction;

  INSERT INTO public.finance_transaction_operation_receipts (
    family_id, operation_key, original_tool_call_id, actor_user_id, actor_member_id,
    actor_kind, intent_version, intent, transaction_id, transaction_snapshot
  ) VALUES (
    p_family_id, v_call.idempotency_key, v_call.id, p_actor_user_id, p_actor_member_id,
    p_actor_kind, 1, p_intent, v_transaction.id, to_jsonb(v_transaction)
  );
  -- No ai_tool_calls state, attempt, lock timestamp, output, or finalization writes.
  RETURN jsonb_build_object(
    'transaction', to_jsonb(v_transaction), 'replayed', false, 'recordState', 'unchanged'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.finance_record_transaction_operation(
  uuid, uuid, uuid, uuid, text, jsonb, jsonb, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finance_record_transaction_operation(
  uuid, uuid, uuid, uuid, text, jsonb, jsonb, jsonb
) TO service_role;
