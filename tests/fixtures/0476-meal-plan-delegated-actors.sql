-- Exercise both delegated service-role RPCs against the disposable PG17 schema.
-- Actor IDs below are synthetic members from the bootstrap fixture.
BEGIN;
CREATE FUNCTION public.meal_plan_test_fail_pantry_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan_date = '2026-10-23' THEN RAISE EXCEPTION 'synthetic Pantry Chef plan failure'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zz_test_pantry_plan_failure
  BEFORE INSERT ON public.meal_plans FOR EACH ROW
  EXECUTE FUNCTION public.meal_plan_test_fail_pantry_insert();
DO $$
DECLARE
  v_family_a constant uuid := '10000000-0000-0000-0000-000000000001';
  v_family_b constant uuid := '10000000-0000-0000-0000-000000000002';
  v_actor_a constant uuid := '20000000-0000-0000-0000-000000000001';
  v_actor_b constant uuid := '20000000-0000-0000-0000-000000000002';
  v_guest constant uuid := '20000000-0000-0000-0000-000000000003';
  v_existing_a constant uuid := '30000000-0000-0000-0000-000000000001';
  v_existing_b constant uuid := '30000000-0000-0000-0000-000000000002';
  v_recipe_a constant uuid := '32000000-0000-0000-0000-000000000001';
  v_recipe_b constant uuid := '32000000-0000-0000-0000-000000000002';
  v_plan jsonb;
  v_replay jsonb;
  v_remove jsonb;
  v_plan_id uuid;
  v_recipe_plan_id uuid;
  v_inactive_plan jsonb;
  v_ensure jsonb;
  v_pantry jsonb;
  v_legacy_meal uuid := '30000000-0000-0000-0000-000000000003';
  v_state text;
  v_count integer;
BEGIN
  IF current_database() <> 'bubaly_meal_plan_atomic_ci' OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION '0476 delegated actor probe requires its dedicated synthetic PostgreSQL 17 database';
  END IF;
  IF has_function_privilege('anon', 'public.meal_plan_replace_slots_for_actor(uuid,uuid,text,jsonb)', 'execute')
     OR has_function_privilege('authenticated', 'public.meal_plan_replace_slots_for_actor(uuid,uuid,text,jsonb)', 'execute')
     OR NOT has_function_privilege('service_role', 'public.meal_plan_replace_slots_for_actor(uuid,uuid,text,jsonb)', 'execute')
     OR has_function_privilege('anon', 'public.meal_plan_remove_slot_for_actor(uuid,uuid,text,uuid)', 'execute')
     OR has_function_privilege('authenticated', 'public.meal_plan_remove_slot_for_actor(uuid,uuid,text,uuid)', 'execute')
     OR NOT has_function_privilege('service_role', 'public.meal_plan_remove_slot_for_actor(uuid,uuid,text,uuid)', 'execute') THEN
    RAISE EXCEPTION '0476 delegated actor RPC grants are not service-role-only';
  END IF;
  INSERT INTO public.meals(id, family_id, name, meal_type, ingredients, created_by)
  VALUES (v_legacy_meal, v_family_a, 'Legacy qty dialect dish', 'dinner',
    '[{"name":"beans","quantity":"1 cup","unit":null}]'::jsonb, v_actor_a);

  -- The browser role cannot call the service-role actor endpoint even when it
  -- supplies a valid family member ID.
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    PERFORM public.meal_plan_replace_slots_for_actor(v_family_a, v_actor_a, 'client-cannot-call',
      jsonb_build_array(jsonb_build_object('meal_id', v_existing_a, 'plan_date', '2026-10-09', 'meal_type', 'dinner')));
    RAISE EXCEPTION USING errcode = 'P0001', message = 'authenticated unexpectedly executed delegated replace';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' THEN RAISE EXCEPTION 'expected authenticated replace rejection 42501, got %', v_state; END IF;
  END;
  BEGIN
    PERFORM public.meal_plan_remove_slot_for_actor(v_family_a, v_actor_a, 'client-cannot-remove',
      '40000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION USING errcode = 'P0001', message = 'authenticated unexpectedly executed delegated remove';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' THEN RAISE EXCEPTION 'expected authenticated remove rejection 42501, got %', v_state; END IF;
  END;

  -- Ordinary authenticated meal-library writes use the same shared lock and
  -- creator binding without accepting a caller-supplied actor ID.
  PERFORM set_config('request.jwt.claim.sub', v_actor_a::text, true);
  v_ensure := public.meal_ensure_custom(v_family_a, 'Ordinary synthetic dish', 'dinner', '[]'::jsonb,
    null, null, true, false, false);
  IF v_ensure->>'created' <> 'true' OR v_ensure->'meal'->>'created_by' <> v_actor_a::text THEN
    RAISE EXCEPTION '0476 authenticated meal ensure failed to create for the auth actor';
  END IF;
  v_replay := public.meal_ensure_custom(v_family_a, ' ordinary   synthetic dish ', 'dinner', '[]'::jsonb,
    null, null, true, false, false);
  IF v_replay->>'created' <> 'false' OR v_replay->'meal'->>'id' <> v_ensure->'meal'->>'id'
     OR has_function_privilege('authenticated', 'public.meal_ensure_custom_for_actor(uuid,uuid,text,public.meal_type,jsonb,text,text,text,boolean,boolean,boolean,boolean)', 'execute') THEN
    RAISE EXCEPTION '0476 ordinary ensure did not reuse the meal or internal helper leaked execute';
  END IF;
  v_replay := public.meal_ensure_custom(v_family_a, 'Legacy qty dialect dish', 'dinner',
    '[{"name":"beans","qty":"1 cup","unit":null}]'::jsonb, null, null, true, false, false);
  IF v_replay->>'created' <> 'false' OR v_replay->'meal'->>'id' <> v_legacy_meal::text THEN
    RAISE EXCEPTION '0476 shared ensure changed legacy quantity-dialect matching';
  END IF;

  -- Service role can invoke replacement, but the supplied actor must still be
  -- an active non-guest member of exactly that family.
  PERFORM set_config('role', 'service_role', true);
  v_plan := public.meal_plan_replace_slots_for_actor(v_family_a, v_actor_a, 'delegated-custom-test',
    '[{"plan_date":"2026-10-10","meal_type":"dinner","meal_name":"Delegated synthetic stew","ingredients":[{"name":"beans","qty":"2 cups","unit":null}]}]'::jsonb);
  v_plan_id := (v_plan->'planned'->0->>'id')::uuid;
  IF v_plan->>'replayed' <> 'false' OR (v_plan->>'created_meals')::integer <> 1
     OR v_plan->'planned'->0->>'created_by' <> v_actor_a::text THEN
    RAISE EXCEPTION '0476 delegated custom replacement did not return the acting user and newly created dish';
  END IF;
  v_replay := public.meal_plan_replace_slots_for_actor(v_family_a, v_actor_a, 'delegated-custom-test',
    '[{"plan_date":"2026-10-10","meal_type":"dinner","meal_name":"Delegated synthetic stew","ingredients":[{"name":"beans","qty":"2 cups","unit":null}]}]'::jsonb);
  IF v_replay->>'replayed' <> 'true' OR (v_replay->>'created_meals')::integer <> 0
     OR v_replay->'planned'->0->>'id' <> v_plan_id::text THEN
    RAISE EXCEPTION '0476 lost-response replay created another meal or changed the slot receipt';
  END IF;

  -- Pantry Chef's recipe steps survive the shared path, and plan failure rolls
  -- back its otherwise-new meal because both writes are one actor RPC call.
  v_pantry := public.meal_plan_replace_slots_for_actor(v_family_a, v_actor_a, 'pantry-chef-notes-test',
    '[{"plan_date":"2026-10-22","meal_type":"dinner","meal_name":"Pantry Chef synthetic dish","ingredients":[{"name":"beans"}],"notes":"Simmer, stir, serve."}]'::jsonb);
  PERFORM set_config('role', 'none', true);
  IF (v_pantry->>'created_meals')::integer <> 1
     OR (SELECT notes FROM public.meals WHERE id = (v_pantry->'planned'->0->>'meal_id')::uuid) <> 'Simmer, stir, serve.' THEN
    RAISE EXCEPTION '0476 Pantry Chef notes were not persisted by the atomic meal-plan RPC';
  END IF;
  PERFORM set_config('role', 'service_role', true);
  BEGIN
    PERFORM public.meal_plan_replace_slots_for_actor(v_family_a, v_actor_a, 'pantry-chef-failed-plan-test',
      '[{"plan_date":"2026-10-23","meal_type":"dinner","meal_name":"Pantry Chef rolled back dish","ingredients":[{"name":"rice"}],"notes":"This must roll back."}]'::jsonb);
    RAISE EXCEPTION USING errcode = 'P0002', message = 'synthetic meal-plan insert failure did not fire';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> 'P0001' THEN RAISE EXCEPTION 'expected synthetic plan failure P0001, got %', v_state; END IF;
  END;
  PERFORM set_config('role', 'none', true);
  IF EXISTS (SELECT 1 FROM public.meals WHERE family_id = v_family_a AND name = 'Pantry Chef rolled back dish') THEN
    RAISE EXCEPTION '0476 failed Pantry Chef plan left an orphan meal';
  END IF;
  PERFORM set_config('role', 'service_role', true);
  BEGIN
    PERFORM public.meal_plan_replace_slots_for_actor(v_family_a, v_actor_a, 'delegated-custom-test',
      '[{"plan_date":"2026-10-10","meal_type":"dinner","meal_name":"Changed synthetic intent","ingredients":[]}]'::jsonb);
    RAISE EXCEPTION USING errcode = 'P0001', message = 'same delegated request ID accepted different intent';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> '22023' THEN RAISE EXCEPTION 'expected changed-intent replay rejection 22023, got %', v_state; END IF;
  END;

  v_plan := public.meal_plan_replace_slots_for_actor(v_family_a, v_actor_a, 'delegated-recipe-test',
    jsonb_build_array(jsonb_build_object('plan_date','2026-10-11','meal_type','lunch','recipe_id',v_recipe_a)));
  v_recipe_plan_id := (v_plan->'planned'->0->>'id')::uuid;
  IF v_plan->>'replayed' <> 'false' OR (v_plan->>'created_meals')::integer <> 1
     OR v_plan->'planned'->0->>'created_by' <> v_actor_a::text THEN
    RAISE EXCEPTION '0476 delegated recipe replacement lost actor attribution';
  END IF;

  -- Family isolation is checked for both existing dishes and recipes inside
  -- the function transaction. Neither attempt may create a meal or slot.
  BEGIN
    PERFORM public.meal_plan_replace_slots_for_actor(v_family_b, v_actor_a, 'wrong-family-actor',
      jsonb_build_array(jsonb_build_object('meal_id',v_existing_b,'plan_date','2026-10-12','meal_type','dinner')));
    RAISE EXCEPTION USING errcode = 'P0001', message = 'actor crossed family boundary';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' THEN RAISE EXCEPTION 'expected wrong-family actor rejection 42501, got %', v_state; END IF;
  END;
  BEGIN
    PERFORM public.meal_plan_replace_slots_for_actor(v_family_a, v_actor_a, 'foreign-meal',
      jsonb_build_array(jsonb_build_object('meal_id',v_existing_b,'plan_date','2026-10-12','meal_type','dinner')));
    RAISE EXCEPTION USING errcode = 'P0001', message = 'foreign meal was accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' THEN RAISE EXCEPTION 'expected foreign meal rejection 42501, got %', v_state; END IF;
  END;
  BEGIN
    PERFORM public.meal_plan_replace_slots_for_actor(v_family_a, v_actor_a, 'foreign-recipe',
      jsonb_build_array(jsonb_build_object('plan_date','2026-10-12','meal_type','dinner','recipe_id',v_recipe_b)));
    RAISE EXCEPTION USING errcode = 'P0001', message = 'foreign recipe was accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' THEN RAISE EXCEPTION 'expected foreign recipe rejection 42501, got %', v_state; END IF;
  END;
  BEGIN
    PERFORM public.meal_plan_replace_slots_for_actor(v_family_a, v_guest, 'guest-cannot-plan',
      '[{"plan_date":"2026-10-12","meal_type":"dinner","meal_name":"Must not be materialized"}]'::jsonb);
    RAISE EXCEPTION USING errcode = 'P0001', message = 'guest actor was accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' THEN RAISE EXCEPTION 'expected guest rejection 42501, got %', v_state; END IF;
  END;

  v_remove := public.meal_plan_remove_slot_for_actor(v_family_a, v_actor_a, 'delegated-remove-test', v_recipe_plan_id);
  IF v_remove->>'id' <> v_recipe_plan_id::text OR v_remove->>'plan_date' <> '2026-10-11'
     OR v_remove->>'meal_type' <> 'lunch' OR v_remove->>'replayed' <> 'false' THEN
    RAISE EXCEPTION '0476 delegated remove returned an incomplete receipt';
  END IF;
  v_remove := public.meal_plan_remove_slot_for_actor(v_family_a, v_actor_a, 'delegated-remove-test', v_recipe_plan_id);
  IF v_remove->>'id' <> v_recipe_plan_id::text OR v_remove->>'replayed' <> 'true' THEN
    RAISE EXCEPTION '0476 delegated remove did not replay its receipt';
  END IF;
  PERFORM set_config('role', 'none', true);

  -- The endpoint also rejects a previously valid actor immediately after
  -- their membership is deactivated, for both replacement and removal.
  UPDATE public.family_members SET is_active = false
   WHERE family_id = v_family_a AND user_id = v_actor_a;
  PERFORM set_config('role', 'service_role', true);
  BEGIN
    v_inactive_plan := public.meal_plan_replace_slots_for_actor(v_family_a, v_actor_a, 'inactive-replace-test',
      '[{"plan_date":"2026-10-13","meal_type":"dinner","meal_name":"Inactive actor must not create"}]'::jsonb);
    RAISE EXCEPTION USING errcode = 'P0001', message = 'inactive actor was accepted for replacement';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' THEN RAISE EXCEPTION 'expected inactive replace rejection 42501, got %', v_state; END IF;
  END;
  BEGIN
    PERFORM public.meal_plan_remove_slot_for_actor(v_family_a, v_actor_a, 'inactive-remove-test', v_plan_id);
    RAISE EXCEPTION USING errcode = 'P0001', message = 'inactive actor was accepted for removal';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' THEN RAISE EXCEPTION 'expected inactive remove rejection 42501, got %', v_state; END IF;
  END;
  PERFORM set_config('role', 'none', true);

  IF (SELECT count(*) FROM public.meals WHERE family_id = v_family_a AND name = 'Delegated synthetic stew' AND created_by = v_actor_a) <> 1
     OR (SELECT count(*) FROM public.meals WHERE family_id = v_family_a AND name = 'Family A recipe' AND created_by = v_actor_a) <> 1
     OR EXISTS (SELECT 1 FROM public.meals WHERE name = 'Must not be materialized')
     OR EXISTS (SELECT 1 FROM public.meals WHERE name = 'Changed synthetic intent' OR name = 'Inactive actor must not create')
     OR EXISTS (SELECT 1 FROM public.meal_plans WHERE family_id = v_family_b AND plan_date = '2026-10-12')
     OR EXISTS (SELECT 1 FROM public.meal_plans WHERE family_id = v_family_a AND plan_date = '2026-10-13')
     OR EXISTS (SELECT 1 FROM public.meal_plans WHERE id = v_recipe_plan_id) THEN
    RAISE EXCEPTION '0476 family isolation, custom materialization, attribution, or remove assertions failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.meal_plans WHERE id = v_plan_id AND family_id = v_family_a AND created_by = v_actor_a)
     OR NOT EXISTS (SELECT 1 FROM public.meal_plan_write_receipts WHERE family_id = v_family_a AND actor_id = v_actor_a
       AND operation = 'replace' AND request_id = 'actor-replace:' || encode(pg_catalog.sha256(convert_to('delegated-custom-test','UTF8')),'hex'))
     OR NOT EXISTS (SELECT 1 FROM public.meal_plan_write_receipts WHERE family_id = v_family_a AND actor_id = v_actor_a
       AND operation = 'remove' AND request_id LIKE 'delegated-remove:%') THEN
    RAISE EXCEPTION '0476 service RPC receipts or planned actor attribution were not persisted';
  END IF;
  SELECT count(*) INTO v_count FROM public.meal_plans WHERE family_id = v_family_a AND plan_date = '2026-10-12';
  IF v_count <> 0 THEN RAISE EXCEPTION '0476 denied delegated writes left a plan behind'; END IF;
  RAISE NOTICE '0476 delegated actor probe passed: service-role replace/remove, authenticated denial, family isolation, guest denial, recipe/custom actor attribution and replay';
END;
$$;
ROLLBACK;
