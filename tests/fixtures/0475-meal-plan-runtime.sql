-- Run after 0475 on the dedicated minimal PG17 bootstrap.
DO $$
BEGIN
  IF current_database() <> 'bubaly_meal_plan_atomic_ci' OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION '0475 runtime requires the dedicated synthetic PostgreSQL 17 database';
  END IF;
END $$;

CREATE FUNCTION public.meal_plan_test_assert(p_ok boolean, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION '0475 assertion failed: %', p_label; END IF;
  RAISE NOTICE '0475 PASS %', p_label;
END $$;

CREATE FUNCTION public.meal_plan_test_reject_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.meal_id = '30000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'synthetic failure after slot deletion' USING errcode = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meal_plan_test_reject_insert BEFORE INSERT ON public.meal_plans
  FOR EACH ROW EXECUTE FUNCTION public.meal_plan_test_reject_insert();

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', false);
DO $$
DECLARE v_state text; v_before jsonb;
BEGIN
  SELECT jsonb_agg(to_jsonb(p) ORDER BY id) INTO v_before FROM public.meal_plans p;
  BEGIN
    PERFORM public.meal_plan_replace_slots(
      '10000000-0000-0000-0000-000000000001', 'rollback-replace',
      '[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-04","meal_type":"dinner"}]'::jsonb);
  EXCEPTION WHEN check_violation THEN v_state := SQLSTATE;
  END;
  PERFORM public.meal_plan_test_assert(v_state = '23514', 'injected insert failure is surfaced');
  PERFORM public.meal_plan_test_assert(
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.meal_plans p) = v_before,
    'delete then failed insert rolls back all old rows and receipt');
END $$;
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', false);
DO $$
DECLARE v_state text; v_before integer;
BEGIN
  SELECT count(*) INTO v_before FROM public.meal_plans;
  PERFORM public.meal_plan_test_assert(public.family_role('10000000-0000-0000-0000-000000000001') = 'parent',
    'synthetic legacy helper prefers inactive parent over active guest');
  BEGIN
    PERFORM public.meal_plan_replace_slots(
      '10000000-0000-0000-0000-000000000001', 'guest-denied',
      '[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-06","meal_type":"dinner"}]'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN v_state := SQLSTATE;
  END;
  PERFORM public.meal_plan_test_assert(v_state = '42501', 'guest role cannot use privileged replacement RPC');
  v_state := null;
  BEGIN
    INSERT INTO public.meal_plans(family_id, meal_id, plan_date, meal_type, created_by)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '2026-10-06', 'dinner', auth.uid());
  EXCEPTION WHEN insufficient_privilege THEN v_state := SQLSTATE;
  END;
  PERFORM public.meal_plan_test_assert(v_state = '42501', 'guest role cannot bypass RPC via a direct insert');
  PERFORM public.meal_plan_test_assert((SELECT count(*) = v_before FROM public.meal_plans), 'guest denials make no plan change');
END $$;
RESET ROLE;
DROP TRIGGER meal_plan_test_reject_insert ON public.meal_plans;
DROP FUNCTION public.meal_plan_test_reject_insert();

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', false);
DO $$
DECLARE v_result jsonb; v_state text; v_before integer;
BEGIN
  SELECT count(*) INTO v_before FROM public.meal_plans;
  BEGIN
    PERFORM public.meal_plan_replace_slots(
      '10000000-0000-0000-0000-000000000002', 'cross-family',
      '[{"meal_id":"30000000-0000-0000-0000-000000000002","plan_date":"2026-10-05","meal_type":"dinner"}]'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN v_state := SQLSTATE;
  END;
  PERFORM public.meal_plan_test_assert(v_state = '42501', 'a member cannot write another family plan');
  PERFORM public.meal_plan_test_assert((SELECT count(*) FROM public.meal_plans) = v_before, 'cross-family denial makes no change');

  v_state := null;
  BEGIN
    PERFORM public.meal_plan_replace_slots(
      '10000000-0000-0000-0000-000000000001', 'foreign-meal',
      '[{"meal_id":"30000000-0000-0000-0000-000000000002","plan_date":"2026-10-05","meal_type":"dinner"}]'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN v_state := SQLSTATE;
  END;
  PERFORM public.meal_plan_test_assert(v_state = '42501', 'a family cannot plan another family meal');

  v_result := public.meal_plan_replace_slots(
    '10000000-0000-0000-0000-000000000001', 'replace-legacy-duplicates',
    '[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-04","meal_type":"dinner"}]'::jsonb);
  PERFORM public.meal_plan_test_assert((v_result->>'replaced')::integer = 2, 'legacy duplicate rows are explicitly replaced together');
  PERFORM public.meal_plan_test_assert(jsonb_array_length(v_result->'planned') = 1, 'replacement leaves one slot row');
  PERFORM public.meal_plan_test_assert((v_result->>'replayed')::boolean = false, 'first write is not marked replayed');

  v_result := public.meal_plan_replace_slots(
    '10000000-0000-0000-0000-000000000001', 'replace-legacy-duplicates',
    '[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-04","meal_type":"dinner"}]'::jsonb);
  PERFORM public.meal_plan_test_assert((v_result->>'replayed')::boolean, 'same request replays its committed result');
  PERFORM public.meal_plan_test_assert(jsonb_array_length(v_result->'planned') = 1
    AND (SELECT count(*) = 1 FROM public.meal_plans WHERE plan_date = '2026-10-04'), 'same-request replay creates no second row');

  v_state := null;
  BEGIN
    PERFORM public.meal_plan_replace_slots(
      '10000000-0000-0000-0000-000000000001', 'replace-legacy-duplicates',
      '[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-06","meal_type":"dinner"}]'::jsonb);
  EXCEPTION WHEN invalid_parameter_value THEN v_state := SQLSTATE;
  END;
  PERFORM public.meal_plan_test_assert(v_state = '22023', 'request ID cannot be rebound to another payload');

  v_state := null;
  BEGIN
    INSERT INTO public.meal_plan_write_receipts(family_id, actor_id, request_id, operation, payload_hash)
    VALUES ('10000000-0000-0000-0000-000000000001', auth.uid(), 'forged', 'remove', repeat('0',64));
  EXCEPTION WHEN insufficient_privilege THEN v_state := SQLSTATE;
  END;
  PERFORM public.meal_plan_test_assert(v_state = '42501', 'authenticated caller cannot forge private receipts');

  v_state := null;
  BEGIN
    INSERT INTO public.meal_plans(family_id, meal_id, plan_date, meal_type, created_by)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '2026-10-04', 'dinner', auth.uid());
  EXCEPTION WHEN unique_violation THEN v_state := SQLSTATE;
  END;
  PERFORM public.meal_plan_test_assert(v_state = '23505', 'direct writer cannot create a duplicate slot');

  v_result := public.meal_plan_remove_slot(
    '10000000-0000-0000-0000-000000000001', 'remove-once', (v_result->'planned'->0->>'id')::uuid);
  PERFORM public.meal_plan_test_assert((v_result->>'replayed')::boolean = false, 'first clear commits once');
  PERFORM public.meal_plan_test_assert((SELECT count(*) = 0 FROM public.meal_plans WHERE plan_date='2026-10-04'), 'slot is empty after clear');
  v_state := null;
  BEGIN
    PERFORM public.meal_plan_remove_slot(
      '10000000-0000-0000-0000-000000000001', 'remove-once', '40000000-0000-0000-0000-000000000002');
  EXCEPTION WHEN invalid_parameter_value THEN v_state := SQLSTATE;
  END;
  PERFORM public.meal_plan_test_assert(v_state = '22023', 'remove receipt cannot be rebound to another plan ID');
  PERFORM public.meal_plan_test_assert((SELECT count(*) = 0 FROM public.meal_plans WHERE plan_date='2026-10-04'), 'wrong-ID replay cannot restore or delete a row');
  v_result := public.meal_plan_remove_slot(
    '10000000-0000-0000-0000-000000000001', 'remove-once', (v_result->>'id')::uuid);
  PERFORM public.meal_plan_test_assert((v_result->>'replayed')::boolean, 'clear retry replays its receipt');
  PERFORM public.meal_plan_test_assert((SELECT count(*) = 0 FROM public.meal_plans WHERE plan_date='2026-10-04'), 'clear replay does not resurrect the row');
END $$;
RESET ROLE;

SELECT public.meal_plan_test_assert(
  NOT EXISTS (SELECT 1 FROM public.meal_plan_write_receipts WHERE request_id = 'rollback-replace'),
  'failed atomic request leaves no committed receipt');
SELECT public.meal_plan_test_assert(
  (SELECT count(*) = 1 FROM public.meal_plan_write_receipts WHERE request_id='replace-legacy-duplicates')
  AND (SELECT count(*) = 1 FROM public.meal_plan_write_receipts WHERE request_id='remove-once'),
  'one private durable receipt exists for each committed operation');
