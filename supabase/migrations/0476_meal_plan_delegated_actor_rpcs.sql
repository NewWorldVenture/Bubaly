-- The executor holds a service-role client, so auth.uid() is NULL at the RPC
-- boundary. These narrow wrappers accept the verified scope actor, recheck
-- that actor's live family membership, then run the existing atomic slot RPC
-- inside the same transaction with that actor's claim. Service role is the
-- only caller; browser clients cannot choose an actor or bypass membership.
-- Preserve the service's legacy ingredient dialect matching (strings, `qty`, and
-- `quantity`) while comparing variants in one canonical shape.
create or replace function public.meal_normalize_custom_ingredients(p_ingredients jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'name', line.name, 'qty', line.qty, 'unit', line.unit) order by line.ordinality), '[]'::jsonb)
  from (
    select e.ordinality,
      case when pg_catalog.jsonb_typeof(e.value) = 'string' then btrim(e.value #>> '{}') else btrim(e.value->>'name') end as name,
      case
        when pg_catalog.jsonb_typeof(e.value) = 'object' and pg_catalog.jsonb_typeof(e.value->'quantity') in ('string','number') then nullif(btrim(e.value->>'quantity'), '')
        when pg_catalog.jsonb_typeof(e.value) = 'object' and pg_catalog.jsonb_typeof(e.value->'qty') in ('string','number') then nullif(btrim(e.value->>'qty'), '')
      end as qty,
      case when pg_catalog.jsonb_typeof(e.value) = 'object' and pg_catalog.jsonb_typeof(e.value->'unit') = 'string' then nullif(btrim(e.value->>'unit'), '') end as unit
    from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(p_ingredients) = 'array' then p_ingredients else '[]'::jsonb end)
      with ordinality e(value, ordinality)
    where (pg_catalog.jsonb_typeof(e.value) = 'string' and btrim(e.value #>> '{}') <> '')
       or (pg_catalog.jsonb_typeof(e.value) = 'object' and pg_catalog.jsonb_typeof(e.value->'name') = 'string' and btrim(e.value->>'name') <> '')
  ) line;
$$;
-- Shared transactional custom-meal path for ordinary and delegated writers.
create or replace function public.meal_ensure_custom_for_actor(
  p_family_id uuid, p_actor_id uuid, p_name text, p_meal_type public.meal_type,
  p_ingredients jsonb, p_recipe_url text, p_image_url text, p_notes text,
  p_has_ingredients boolean, p_has_recipe_url boolean, p_has_image_url boolean, p_has_notes boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_role public.member_role; v_name text; v_normalized_name text;
  v_ingredients jsonb; v_recipe_url text; v_image_url text; v_notes text;
  v_meal public.meals%rowtype; v_created boolean := false;
begin
  if p_family_id is null or p_actor_id is null then raise exception 'A family and acting user are required' using errcode = '22023'; end if;
  select fm.role into v_actor_role from public.family_members fm
   where fm.family_id = p_family_id and fm.user_id = p_actor_id and fm.is_active for share;
  if not found or v_actor_role = 'guest' then raise exception 'The acting user cannot change this family meal library' using errcode = '42501'; end if;
  v_name := btrim(p_name);
  if v_name is null or length(v_name) not between 1 and 300 or p_meal_type is null
     or p_has_ingredients is null or p_has_recipe_url is null or p_has_image_url is null or p_has_notes is null then
    raise exception 'Invalid custom meal content' using errcode = '22023';
  end if;
  v_normalized_name := lower(regexp_replace(v_name, '\s+', ' ', 'g'));
  v_ingredients := case when p_has_ingredients then p_ingredients else '[]'::jsonb end;
  if v_ingredients is null or jsonb_typeof(v_ingredients) <> 'array' or jsonb_array_length(v_ingredients) > 100
     or exists (select 1 from jsonb_array_elements(v_ingredients) i(value)
       where jsonb_typeof(i.value) <> 'object' or jsonb_typeof(i.value->'name') <> 'string'
          or length(btrim(i.value->>'name')) not between 1 and 300
          or (i.value ? 'qty' and jsonb_typeof(i.value->'qty') not in ('string','null'))
          or length(coalesce(i.value->>'qty','')) > 100
          or (i.value ? 'unit' and jsonb_typeof(i.value->'unit') not in ('string','null'))
          or length(coalesce(i.value->>'unit','')) > 100) then
    raise exception 'Invalid meal ingredients' using errcode = '22023';
  end if;
  v_recipe_url := case when p_has_recipe_url then nullif(btrim(p_recipe_url), '') else null end;
  v_image_url := case when p_has_image_url then nullif(btrim(p_image_url), '') else null end;
  v_notes := case when p_has_notes then nullif(btrim(p_notes), '') else null end;
  if (v_recipe_url is not null and (length(v_recipe_url) > 2048 or v_recipe_url !~* '^https?://'))
     or (v_image_url is not null and (length(v_image_url) > 2048 or v_image_url !~* '^https?://'))
     or (v_notes is not null and length(v_notes) > 2000) then
    raise exception 'Invalid custom meal content' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('meal-library-name:' || p_family_id::text || ':' || v_normalized_name, 0));
  select m.* into v_meal from public.meals m
   where m.family_id = p_family_id and lower(regexp_replace(btrim(m.name), '\s+', ' ', 'g')) = v_normalized_name
     and m.meal_type = p_meal_type
     and (not p_has_ingredients or public.meal_normalize_custom_ingredients(m.ingredients) = public.meal_normalize_custom_ingredients(v_ingredients))
     and (not p_has_recipe_url or coalesce(m.recipe_url, '') = coalesce(v_recipe_url, ''))
     and (not p_has_image_url or coalesce(m.image_url, '') = coalesce(v_image_url, ''))
     and (not p_has_notes or coalesce(m.notes, '') = coalesce(v_notes, ''))
   order by m.created_at, m.id limit 1 for key share;
  if not found then
    insert into public.meals(family_id, name, meal_type, ingredients, recipe_url, image_url, notes, created_by)
    values (p_family_id, v_name, p_meal_type, v_ingredients, v_recipe_url, v_image_url, v_notes, p_actor_id)
    returning * into v_meal;
    v_created := true;
  end if;
  return jsonb_build_object('meal', to_jsonb(v_meal), 'created', v_created);
end;
$$;

create or replace function public.meal_ensure_custom(
  p_family_id uuid, p_name text, p_meal_type public.meal_type, p_ingredients jsonb,
  p_recipe_url text, p_image_url text, p_has_ingredients boolean, p_has_recipe_url boolean, p_has_image_url boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  return public.meal_ensure_custom_for_actor(p_family_id, auth.uid(), p_name, p_meal_type, p_ingredients,
    p_recipe_url, p_image_url, null, p_has_ingredients, p_has_recipe_url, p_has_image_url, false);
end;
$$;

-- Best-effort rollback of meals created before a later plan-resolution error.
-- Lock parent rows before checking references so FK key-share locks serialize
-- cleanup against concurrent plan adoption; a committed plan is never nulled.
create or replace function public.meal_cleanup_unreferenced_custom(
  p_family_id uuid,
  p_meal_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role public.member_role;
  v_meal_id uuid;
  v_deleted integer := 0;
  v_retained integer := 0;
  v_affected integer;
begin
  if v_actor_id is null or p_family_id is null or p_meal_ids is null
     or cardinality(p_meal_ids) not between 1 and 40
     or array_position(p_meal_ids, null) is not null then
    raise exception 'Invalid meal cleanup request' using errcode = '22023';
  end if;
  select fm.role into v_actor_role from public.family_members fm
   where fm.family_id = p_family_id and fm.user_id = v_actor_id and fm.is_active
   for share;
  if not found or v_actor_role = 'guest' then
    raise exception 'The acting user cannot change this family meal library' using errcode = '42501';
  end if;

  for v_meal_id in
    select distinct m.id from public.meals m
     where m.family_id = p_family_id and m.created_by = v_actor_id and m.id = any(p_meal_ids)
     order by m.id
  loop
    -- FK inserts take KEY SHARE on the parent. If a plan is committing now,
    -- wait for it before checking references in the next command snapshot.
    perform 1 from public.meals m
     where m.id = v_meal_id and m.family_id = p_family_id and m.created_by = v_actor_id
     for update;
    if not found then continue; end if;

    if exists (select 1 from public.meal_plans p
      where p.family_id = p_family_id and p.meal_id = v_meal_id) then
      v_retained := v_retained + 1;
    else
      delete from public.meals m
       where m.id = v_meal_id and m.family_id = p_family_id and m.created_by = v_actor_id
         and not exists (select 1 from public.meal_plans p
           where p.family_id = p_family_id and p.meal_id = v_meal_id);
      get diagnostics v_affected = row_count;
      v_deleted := v_deleted + v_affected;
    end if;
  end loop;
  return jsonb_build_object('deleted', v_deleted, 'retained_referenced', v_retained);
end;
$$;

create or replace function public.meal_plan_replace_slots_for_actor(
  p_family_id uuid,
  p_actor_id uuid,
  p_request_id text,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.member_role;
  v_hash text;
  v_receipt_request_id text;
  v_inner_request_id text;
  v_receipt public.meal_plan_write_receipts%rowtype;
  v_claimed integer;
  v_entry jsonb;
  v_date date;
  v_meal_type text;
  v_source_count integer;
  v_meal_id uuid;
  v_name text;
  v_ingredients jsonb;
  v_recipe_url text;
  v_image_url text;
  v_notes text;
  v_has_ingredients boolean;
  v_has_recipe_url boolean;
  v_has_image_url boolean;
  v_has_notes boolean;
  v_recipe record;
  v_normalized_entries jsonb := '[]'::jsonb;
  v_created_meals integer := 0;
  v_inner_result jsonb;
  v_result jsonb;
  v_previous_actor_claim text;
begin
  if p_family_id is null or p_actor_id is null then
    raise exception 'A family and acting user are required' using errcode = '22023';
  end if;
  select fm.role into v_actor_role
    from public.family_members fm
   where fm.family_id = p_family_id and fm.user_id = p_actor_id and fm.is_active
   for share;
  if not found or v_actor_role = 'guest' then
    raise exception 'The acting user cannot change this family meal plan' using errcode = '42501';
  end if;
  if p_request_id is null or length(p_request_id) not between 1 and 128
     or p_entries is null or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) not between 1 and 40 then
    raise exception 'Invalid meal-plan request' using errcode = '22023';
  end if;

  v_hash := encode(pg_catalog.sha256(convert_to(
    jsonb_build_object('operation', 'replace_for_actor', 'entries', p_entries)::text, 'UTF8')), 'hex');
  v_receipt_request_id := 'actor-replace:' || encode(pg_catalog.sha256(convert_to(p_request_id, 'UTF8')), 'hex');
  v_inner_request_id := 'delegated-replace:' || encode(pg_catalog.sha256(convert_to(
    p_family_id::text || ':' || p_actor_id::text || ':' || p_request_id, 'UTF8')), 'hex');

  -- This outer receipt binds the raw intent before custom dishes are resolved.
  -- It is separate from the inner slot receipt so a lost response can replay
  -- the same created meal rows without materializing duplicates.
  insert into public.meal_plan_write_receipts(family_id, actor_id, request_id, operation, payload_hash)
  values (p_family_id, p_actor_id, v_receipt_request_id, 'replace', v_hash)
  on conflict do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select * into v_receipt from public.meal_plan_write_receipts
     where family_id = p_family_id and actor_id = p_actor_id and request_id = v_receipt_request_id
     for update;
    if not found or v_receipt.operation <> 'replace' or v_receipt.payload_hash <> v_hash or v_receipt.result is null then
      raise exception 'Meal-plan request ID was already used for a different or incomplete delegated request' using errcode = '22023';
    end if;
    return jsonb_set(v_receipt.result, '{replayed}', 'true'::jsonb, true)
      || jsonb_build_object('created_meals', 0);
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_entries) e
     group by e.value->>'plan_date', e.value->>'meal_type' having count(*) > 1
  ) then
    raise exception 'A meal-plan slot was supplied more than once' using errcode = '22023';
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    if jsonb_typeof(v_entry) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_entry) k(key)
                   where k.key not in ('plan_date','meal_type','meal_id','recipe_id','meal_name','ingredients','recipe_url','image_url','notes'))
       or (v_entry->>'plan_date') !~ '^\d{4}-\d{2}-\d{2}$'
       or (v_entry->>'meal_type') not in ('breakfast','lunch','dinner','snack') then
      raise exception 'Invalid meal-plan entry' using errcode = '22023';
    end if;
    begin
      v_date := (v_entry->>'plan_date')::date;
    exception when others then
      raise exception 'Invalid meal-plan date' using errcode = '22023';
    end;
    if to_char(v_date, 'YYYY-MM-DD') <> v_entry->>'plan_date' then
      raise exception 'Invalid meal-plan date' using errcode = '22023';
    end if;
    v_meal_type := v_entry->>'meal_type';
    v_source_count := (case when nullif(btrim(v_entry->>'meal_id'), '') is not null then 1 else 0 end)
      + (case when nullif(btrim(v_entry->>'recipe_id'), '') is not null then 1 else 0 end)
      + (case when nullif(btrim(v_entry->>'meal_name'), '') is not null then 1 else 0 end);
    if v_source_count <> 1 then
      raise exception 'Choose one meal, recipe or custom dish' using errcode = '22023';
    end if;
    if (v_entry ? 'meal_id' and (v_entry->>'meal_id') is not null
         and ((v_entry->>'meal_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or v_entry ?| array['recipe_id','meal_name','ingredients','recipe_url','image_url','notes']))
       or (v_entry ? 'recipe_id' and (v_entry->>'recipe_id') is not null
         and ((v_entry->>'recipe_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or v_entry ?| array['meal_id','meal_name','ingredients','recipe_url','image_url','notes'])) then
      raise exception 'Invalid meal-plan source' using errcode = '22023';
    end if;

    if v_entry->>'meal_id' is not null then
      v_meal_id := (v_entry->>'meal_id')::uuid;
      perform 1 from public.meals m where m.id = v_meal_id and m.family_id = p_family_id for key share;
      if not found then raise exception 'Meal is unavailable to this family' using errcode = '42501'; end if;
      v_normalized_entries := v_normalized_entries || jsonb_build_array(jsonb_build_object(
        'meal_id', v_meal_id, 'plan_date', v_date, 'meal_type', v_meal_type));
      continue;
    end if;

    v_has_ingredients := v_entry ? 'ingredients';
    v_has_recipe_url := v_entry ? 'recipe_url';
    v_has_image_url := v_entry ? 'image_url';
    if v_has_ingredients and (
      jsonb_typeof(v_entry->'ingredients') <> 'array'
      or jsonb_array_length(v_entry->'ingredients') > 100
      or exists (
        select 1 from jsonb_array_elements(v_entry->'ingredients') i(value)
        where jsonb_typeof(i.value) <> 'object'
          or jsonb_typeof(i.value->'name') <> 'string'
          or length(btrim(i.value->>'name')) not between 1 and 300
          or (i.value ? 'qty' and jsonb_typeof(i.value->'qty') not in ('string','null'))
          or length(coalesce(i.value->>'qty','')) > 100
          or (i.value ? 'unit' and jsonb_typeof(i.value->'unit') not in ('string','null'))
          or length(coalesce(i.value->>'unit','')) > 100
      )
    ) then
      raise exception 'Invalid meal ingredients' using errcode = '22023';
    end if;

    if v_entry->>'recipe_id' is not null then
      select * into v_recipe from public.family_recipes r
       where r.id = (v_entry->>'recipe_id')::uuid and r.family_id = p_family_id
       for share;
      if not found then raise exception 'Recipe is unavailable to this family' using errcode = '42501'; end if;
      v_name := btrim(v_recipe.name);
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', ingredient.name,
        'qty', ingredient.qty,
        'unit', ingredient.unit
      ) order by ingredient.ordinality), '[]'::jsonb)
        into v_ingredients
        from (
          select e.ordinality,
            case when jsonb_typeof(e.value) = 'string' then btrim(e.value #>> '{}') else btrim(e.value->>'name') end as name,
            case when jsonb_typeof(e.value) = 'object'
              and jsonb_typeof(coalesce(e.value->'quantity', e.value->'qty')) in ('string','number')
              then nullif(btrim(coalesce(e.value->>'quantity', e.value->>'qty')), '') end as qty,
            case when jsonb_typeof(e.value) = 'object' then nullif(btrim(e.value->>'unit'), '') end as unit
          from jsonb_array_elements(v_recipe.ingredients) with ordinality e(value, ordinality)
          where (jsonb_typeof(e.value) = 'string' and btrim(e.value #>> '{}') <> '')
             or (jsonb_typeof(e.value) = 'object' and jsonb_typeof(e.value->'name') = 'string'
                 and btrim(e.value->>'name') <> '')
        ) ingredient;
      v_recipe_url := nullif(btrim(v_recipe.source_url), '');
      v_image_url := nullif(btrim(v_recipe.photo_url), '');
      v_notes := null;
      v_has_notes := false;
      v_has_ingredients := true;
      v_has_recipe_url := true;
      v_has_image_url := true;
    else
      v_name := btrim(v_entry->>'meal_name');
      v_ingredients := coalesce(v_entry->'ingredients', '[]'::jsonb);
      v_recipe_url := nullif(btrim(v_entry->>'recipe_url'), '');
      v_image_url := nullif(btrim(v_entry->>'image_url'), '');
      v_notes := nullif(btrim(v_entry->>'notes'), '');
      v_has_notes := v_entry ? 'notes';
      if length(v_name) > 300 then raise exception 'Invalid meal name' using errcode = '22023'; end if;
    end if;
    if v_name is null or length(v_name) not between 1 and 300
       or (v_recipe_url is not null and (length(v_recipe_url) > 2048 or v_recipe_url !~* '^https?://'))
       or (v_image_url is not null and (length(v_image_url) > 2048 or v_image_url !~* '^https?://'))
       or (v_entry ? 'notes' and jsonb_typeof(v_entry->'notes') not in ('string','null'))
       or length(coalesce(v_entry->>'notes','')) > 2000 then
      raise exception 'Invalid custom meal content' using errcode = '22023';
    end if;

    -- Shared helper serializes ordinary, delegated, and Pantry Chef writers.
    v_inner_result := public.meal_ensure_custom_for_actor(
      p_family_id, p_actor_id, v_name, v_meal_type::public.meal_type,
      v_ingredients, v_recipe_url, v_image_url, v_notes,
      v_has_ingredients, v_has_recipe_url, v_has_image_url, v_has_notes);
    v_meal_id := (v_inner_result->'meal'->>'id')::uuid;
    if (v_inner_result->>'created')::boolean then v_created_meals := v_created_meals + 1; end if;
    v_normalized_entries := v_normalized_entries || jsonb_build_array(jsonb_build_object(
      'meal_id', v_meal_id, 'plan_date', v_date, 'meal_type', v_meal_type));
  end loop;

  v_previous_actor_claim := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', p_actor_id::text, true);
  v_inner_result := public.meal_plan_replace_slots(p_family_id, v_inner_request_id, v_normalized_entries);
  perform set_config('request.jwt.claim.sub', coalesce(v_previous_actor_claim, ''), true);
  v_result := v_inner_result || jsonb_build_object('created_meals', v_created_meals, 'replayed', false);
  update public.meal_plan_write_receipts set result = v_result
   where family_id = p_family_id and actor_id = p_actor_id and request_id = v_receipt_request_id;
  return v_result;
end;
$$;

create or replace function public.meal_plan_remove_slot_for_actor(
  p_family_id uuid,
  p_actor_id uuid,
  p_request_id text,
  p_plan_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.member_role;
  v_previous_actor_claim text;
  v_inner_request_id text;
  v_result jsonb;
begin
  if p_family_id is null or p_actor_id is null then
    raise exception 'A family and acting user are required' using errcode = '22023';
  end if;
  select fm.role into v_actor_role
    from public.family_members fm
   where fm.family_id = p_family_id and fm.user_id = p_actor_id and fm.is_active
   for share;
  if not found or v_actor_role = 'guest' then
    raise exception 'The acting user cannot change this family meal plan' using errcode = '42501';
  end if;
  if p_request_id is null or length(p_request_id) not between 1 and 128 or p_plan_id is null then
    raise exception 'Invalid meal-plan request' using errcode = '22023';
  end if;
  v_inner_request_id := 'delegated-remove:' || encode(pg_catalog.sha256(convert_to(
    p_family_id::text || ':' || p_actor_id::text || ':' || p_request_id, 'UTF8')), 'hex');
  v_previous_actor_claim := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', p_actor_id::text, true);
  v_result := public.meal_plan_remove_slot(p_family_id, v_inner_request_id, p_plan_id);
  perform set_config('request.jwt.claim.sub', coalesce(v_previous_actor_claim, ''), true);
  return v_result;
end;
$$;

revoke all on function public.meal_plan_replace_slots_for_actor(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.meal_plan_remove_slot_for_actor(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.meal_normalize_custom_ingredients(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.meal_ensure_custom_for_actor(uuid, uuid, text, public.meal_type, jsonb, text, text, text, boolean, boolean, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.meal_ensure_custom(uuid, text, public.meal_type, jsonb, text, text, boolean, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.meal_cleanup_unreferenced_custom(uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.meal_plan_replace_slots_for_actor(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.meal_plan_remove_slot_for_actor(uuid, uuid, text, uuid) to service_role;
grant execute on function public.meal_ensure_custom(uuid, text, public.meal_type, jsonb, text, text, boolean, boolean, boolean) to authenticated;
grant execute on function public.meal_cleanup_unreferenced_custom(uuid, uuid[]) to authenticated;

do $$
declare
  v_replace constant text := 'public.meal_plan_replace_slots_for_actor(uuid, uuid, text, jsonb)';
  v_remove constant text := 'public.meal_plan_remove_slot_for_actor(uuid, uuid, text, uuid)';
  v_ensure constant text := 'public.meal_ensure_custom(uuid, text, public.meal_type, jsonb, text, text, boolean, boolean, boolean)';
  v_cleanup constant text := 'public.meal_cleanup_unreferenced_custom(uuid, uuid[])';
  v_helper constant text := 'public.meal_ensure_custom_for_actor(uuid, uuid, text, public.meal_type, jsonb, text, text, text, boolean, boolean, boolean, boolean)';
  v_normalize constant text := 'public.meal_normalize_custom_ingredients(jsonb)';
begin
  if has_function_privilege('anon', v_replace, 'execute')
     or has_function_privilege('authenticated', v_replace, 'execute')
     or not has_function_privilege('service_role', v_replace, 'execute') then
    raise exception '0479: delegated replace RPC must be executable only by service_role';
  end if;
  if has_function_privilege('anon', v_remove, 'execute')
     or has_function_privilege('authenticated', v_remove, 'execute')
     or not has_function_privilege('service_role', v_remove, 'execute') then
    raise exception '0479: delegated remove RPC must be executable only by service_role';
  end if;
  if has_function_privilege('anon', v_ensure, 'execute')
     or not has_function_privilege('authenticated', v_ensure, 'execute')
     or has_function_privilege('service_role', v_ensure, 'execute')
     or has_function_privilege('anon', v_cleanup, 'execute')
     or not has_function_privilege('authenticated', v_cleanup, 'execute')
     or has_function_privilege('service_role', v_cleanup, 'execute')
     or has_function_privilege('anon', v_helper, 'execute')
     or has_function_privilege('authenticated', v_helper, 'execute')
     or has_function_privilege('service_role', v_helper, 'execute')
     or has_function_privilege('anon', v_normalize, 'execute')
     or has_function_privilege('authenticated', v_normalize, 'execute')
     or has_function_privilege('service_role', v_normalize, 'execute') then
    raise exception '0479: ordinary ensure RPC or internal helper grants are not scoped safely';
  end if;
  if not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_ensure::regprocedure)
     or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_helper::regprocedure)
     or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_cleanup::regprocedure) then
    raise exception '0479: custom-meal ensure and cleanup functions must be SECURITY DEFINER';
  end if;
  if not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_replace::regprocedure)
     or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_remove::regprocedure) then
    raise exception '0479: delegated RPCs must be SECURITY DEFINER';
  end if;
end;
$$;
