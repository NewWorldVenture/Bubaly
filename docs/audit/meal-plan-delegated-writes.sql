-- Synthetic PostgreSQL 17 proof for the service-role AI meal-planning caller.
-- The service session intentionally has no request JWT, so auth.uid() is NULL.
DO $$
BEGIN
  IF current_database() <> 'bubaly_meal_plan_atomic_ci'
     OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'delegated meal-plan proof requires the isolated synthetic PostgreSQL 17 database';
  END IF;
END $$;

CREATE FUNCTION pg_temp.meal_delegated_assert(p_ok boolean, p_message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'MEAL DELEGATION PROOF FAILED: %', p_message; END IF;
  RAISE NOTICE 'MEAL DELEGATION PASS: %', p_message;
END $$;

CREATE FUNCTION pg_temp.meal_delegated_expect_denied(
  p_label text, p_family uuid, p_actor uuid, p_request text, p_entries jsonb, p_expected text
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    PERFORM public.meal_plan_replace_slots_for_actor(p_family, p_actor, p_request, p_entries);
    RAISE EXCEPTION 'MEAL DELEGATION AUTHORIZATION FAILURE: % unexpectedly succeeded', p_label;
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%' || p_expected || '%' THEN
      RAISE EXCEPTION 'MEAL DELEGATION AUTHORIZATION FAILURE: % returned unexpected error: %', p_label, SQLERRM;
    END IF;
    RAISE NOTICE 'MEAL DELEGATION PASS: % denied with expected authorization error', p_label;
  END;
END $$;

CREATE FUNCTION pg_temp.meal_delegated_expect_remove_denied(
  p_label text, p_family uuid, p_actor uuid, p_request text, p_plan uuid, p_expected text
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    PERFORM public.meal_plan_remove_slot_for_actor(p_family, p_actor, p_request, p_plan);
    RAISE EXCEPTION 'MEAL DELEGATION AUTHORIZATION FAILURE: % unexpectedly succeeded', p_label;
  EXCEPTION WHEN insufficient_privilege OR no_data_found THEN
    IF SQLERRM NOT LIKE '%' || p_expected || '%' THEN
      RAISE EXCEPTION 'MEAL DELEGATION AUTHORIZATION FAILURE: % returned unexpected error: %', p_label, SQLERRM;
    END IF;
    RAISE NOTICE 'MEAL DELEGATION PASS: % denied with expected authorization error', p_label;
  END;
END $$;

INSERT INTO auth.users(id) VALUES ('20000000-0000-0000-0000-000000000004') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.family_members(id,family_id,user_id,role,is_active)
VALUES ('31000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000004','adult',false)
ON CONFLICT (id) DO UPDATE SET is_active=false, role='adult';
INSERT INTO public.meal_plans(id,family_id,meal_id,plan_date,meal_type,created_by)
VALUES ('40000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000002','2026-10-22','dinner','20000000-0000-0000-0000-000000000002')
ON CONFLICT (id) DO UPDATE SET family_id=excluded.family_id, meal_id=excluded.meal_id,
  plan_date=excluded.plan_date, meal_type=excluded.meal_type, created_by=excluded.created_by;

-- The service-role invocation has an empty request subject by design.
SELECT set_config('request.jwt.claim.sub','',false);
SET ROLE service_role;
DO $$
DECLARE
  v_replace jsonb;
  v_replay jsonb;
  v_remove jsonb;
  v_remove_replay jsonb;
  v_plan_id uuid;
  v_request_prefix text := 'delegated-' || gen_random_uuid()::text;
BEGIN
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'service-role fixture unexpectedly has auth.uid()'; END IF;

  v_replace := public.meal_plan_replace_slots_for_actor(
    '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
    v_request_prefix || '-replace','[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-19","meal_type":"dinner"}]'::jsonb);
  IF (v_replace->>'replayed')::boolean THEN RAISE EXCEPTION 'first delegated replace was marked as replay'; END IF;
  v_replay := public.meal_plan_replace_slots_for_actor(
    '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
    v_request_prefix || '-replace','[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-19","meal_type":"dinner"}]'::jsonb);
  IF NOT (v_replay->>'replayed')::boolean THEN RAISE EXCEPTION 'delegated replace replay was not recognized'; END IF;
  v_plan_id := (v_replace->'planned'->0->>'id')::uuid;
  IF v_plan_id IS NULL THEN RAISE EXCEPTION 'delegated replace returned no planned row'; END IF;
  IF v_replace->'planned'->0->>'created_by' <> '20000000-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'delegated replace did not preserve the authorized actor as created_by';
  END IF;

  v_remove := public.meal_plan_remove_slot_for_actor(
    '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
    v_request_prefix || '-remove',v_plan_id);
  IF (v_remove->>'replayed')::boolean THEN RAISE EXCEPTION 'first delegated remove was marked as replay'; END IF;
  v_remove_replay := public.meal_plan_remove_slot_for_actor(
    '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
    v_request_prefix || '-remove',v_plan_id);
  IF NOT (v_remove_replay->>'replayed')::boolean THEN RAISE EXCEPTION 'delegated remove replay was not recognized'; END IF;
  RAISE NOTICE 'MEAL DELEGATION PASS: NULL-auth service role can write, replay, remove and replay removal for an authorized actor';

  PERFORM pg_temp.meal_delegated_expect_denied('NULL actor','10000000-0000-0000-0000-000000000001',NULL,
    'delegated-null-actor','[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-20","meal_type":"dinner"}]'::jsonb,
    'Not a member of this family');
  PERFORM pg_temp.meal_delegated_expect_denied('guest actor','10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000003','delegated-guest',
    '[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-20","meal_type":"dinner"}]'::jsonb,
    'Not a member of this family');
  PERFORM pg_temp.meal_delegated_expect_denied('inactive actor','10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000004','delegated-inactive',
    '[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-20","meal_type":"dinner"}]'::jsonb,
    'Not a member of this family');
  PERFORM pg_temp.meal_delegated_expect_denied('actor from a different family','10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002','delegated-foreign-actor',
    '[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-20","meal_type":"dinner"}]'::jsonb,
    'Not a member of this family');
  PERFORM pg_temp.meal_delegated_expect_denied('cross-family meal reference','10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001','delegated-foreign-meal',
    '[{"meal_id":"30000000-0000-0000-0000-000000000002","plan_date":"2026-10-20","meal_type":"dinner"}]'::jsonb,
    'Invalid or unavailable meal-plan entry');
  PERFORM pg_temp.meal_delegated_expect_remove_denied('NULL actor remove','10000000-0000-0000-0000-000000000001',NULL,
    'delegated-null-remove','40000000-0000-0000-0000-000000000001','Not a member of this family');
  PERFORM pg_temp.meal_delegated_expect_remove_denied('guest actor remove','10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000003','delegated-guest-remove','40000000-0000-0000-0000-000000000001','Not a member of this family');
  PERFORM pg_temp.meal_delegated_expect_remove_denied('inactive actor remove','10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000004','delegated-inactive-remove','40000000-0000-0000-0000-000000000001','Not a member of this family');
  PERFORM pg_temp.meal_delegated_expect_remove_denied('foreign actor remove','10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002','delegated-foreign-remove','40000000-0000-0000-0000-000000000001','Not a member of this family');
  PERFORM pg_temp.meal_delegated_expect_remove_denied('cross-family plan ID','10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001','delegated-foreign-plan','40000000-0000-0000-0000-000000000003','Planned meal not found');

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('service_role','public.meal_plan_replace_slots_for_actor(uuid,uuid,text,jsonb)',true),
      ('service_role','public.meal_plan_remove_slot_for_actor(uuid,uuid,text,uuid)',true),
      ('service_role','public.meal_plan_replace_slots(uuid,text,jsonb)',false),
      ('service_role','public.meal_plan_remove_slot(uuid,text,uuid)',false),
      ('service_role','public.meal_plan_replace_slots_internal(uuid,uuid,text,jsonb)',false),
      ('service_role','public.meal_plan_remove_slot_internal(uuid,uuid,text,uuid)',false),
      ('authenticated','public.meal_plan_replace_slots(uuid,text,jsonb)',true),
      ('authenticated','public.meal_plan_remove_slot(uuid,text,uuid)',true),
      ('authenticated','public.meal_plan_replace_slots_for_actor(uuid,uuid,text,jsonb)',false),
      ('authenticated','public.meal_plan_remove_slot_for_actor(uuid,uuid,text,uuid)',false),
      ('authenticated','public.meal_plan_replace_slots_internal(uuid,uuid,text,jsonb)',false),
      ('authenticated','public.meal_plan_remove_slot_internal(uuid,uuid,text,uuid)',false),
      ('anon','public.meal_plan_replace_slots(uuid,text,jsonb)',false),
      ('anon','public.meal_plan_remove_slot(uuid,text,uuid)',false),
      ('anon','public.meal_plan_replace_slots_for_actor(uuid,uuid,text,jsonb)',false),
      ('anon','public.meal_plan_remove_slot_for_actor(uuid,uuid,text,uuid)',false),
      ('anon','public.meal_plan_replace_slots_internal(uuid,uuid,text,jsonb)',false),
      ('anon','public.meal_plan_remove_slot_internal(uuid,uuid,text,uuid)',false)
    ) AS acl(role_name,signature,should_execute)
    WHERE has_function_privilege(role_name, signature, 'EXECUTE') IS DISTINCT FROM should_execute
  ) THEN
    RAISE EXCEPTION 'MEAL DELEGATION PRIVILEGE FAILURE: actor-aware functions are exposed to an unauthorized role';
  END IF;
  RAISE NOTICE 'MEAL DELEGATION PASS: actor-aware core and service wrappers are unavailable to authenticated and anon';
END $$;
RESET ROLE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.meal_plans WHERE plan_date='2026-10-19'
      AND family_id='10000000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'MEAL DELEGATION PROOF FAILED: delegated remove left its meal-plan row behind';
  END IF;
  RAISE NOTICE 'MEAL DELEGATION PASS: delegated remove deleted the target row';
END $$;

-- Also exercise ACL enforcement, not only the catalog view, for both public
-- roles. Neither can call actor-aware wrappers or the private core.
SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.meal_plan_replace_slots_for_actor('10000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001','auth-direct','[]'::jsonb);
    RAISE EXCEPTION 'MEAL DELEGATION PRIVILEGE FAILURE: authenticated invoked service wrapper';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.meal_plan_replace_slots_internal('10000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001','auth-core','[]'::jsonb);
    RAISE EXCEPTION 'MEAL DELEGATION PRIVILEGE FAILURE: authenticated invoked private core';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
SET ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM public.meal_plan_remove_slot_for_actor('10000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001','anon-direct','40000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'MEAL DELEGATION PRIVILEGE FAILURE: anon invoked service wrapper';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.meal_plan_remove_slot_internal('10000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001','anon-core','40000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'MEAL DELEGATION PRIVILEGE FAILURE: anon invoked private core';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

-- Existing request-authenticated wrappers remain usable and still derive the
-- actor from auth.uid() rather than any caller-supplied actor argument.
SET request.jwt.claim.sub='20000000-0000-0000-0000-000000000001';
SET ROLE authenticated;
DO $$
DECLARE
  v_result jsonb;
  v_request text := 'authenticated-wrapper-' || gen_random_uuid()::text;
BEGIN
  v_result := public.meal_plan_replace_slots('10000000-0000-0000-0000-000000000001',v_request,
    '[{"meal_id":"30000000-0000-0000-0000-000000000001","plan_date":"2026-10-21","meal_type":"dinner"}]'::jsonb);
  IF (v_result->>'replayed')::boolean THEN RAISE EXCEPTION 'authenticated wrapper did not preserve first-write semantics'; END IF;
  RAISE NOTICE 'MEAL DELEGATION PASS: existing authenticated wrapper still derives and accepts its authenticated actor';
END $$;
RESET ROLE;
