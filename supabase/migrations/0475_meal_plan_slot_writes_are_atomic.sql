-- Replace a meal-plan operation in one transaction and serialize every writer
-- for the affected slots. Existing duplicate rows are left untouched until a
-- family explicitly replaces or removes those slots.

create table if not exists public.meal_plan_write_receipts (
  family_id uuid not null references public.families(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null check (length(request_id) between 1 and 128),
  operation text not null check (operation in ('replace', 'remove')),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (family_id, actor_id, request_id)
);

-- CREATE TABLE IF NOT EXISTS makes migration replay safe, but it must not
-- silently accept a same-named table with a different receipt contract.
do $$
declare
  v_columns text[];
  v_defaults text[];
  v_primary_key text[];
  v_constraints text[];
  v_policy name;
begin
  select array_agg(
    a.attnum::text || ':' || a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text
    order by a.attnum
  ) into v_columns
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.meal_plan_write_receipts'::regclass
    and a.attnum > 0 and not a.attisdropped;

  if v_columns is distinct from array[
    '1:family_id:uuid:true',
    '2:actor_id:uuid:true',
    '3:request_id:text:true',
    '4:operation:text:true',
    '5:payload_hash:text:true',
    '6:result:jsonb:false',
    '7:created_at:timestamp with time zone:true'
  ]::text[] then
    raise exception 'meal_plan_write_receipts has an incompatible column contract';
  end if;

  select array_agg(a.attname || ':' || pg_catalog.pg_get_expr(d.adbin, d.adrelid) order by a.attnum)
    into v_defaults
  from pg_catalog.pg_attrdef d
  join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
  where d.adrelid = 'public.meal_plan_write_receipts'::regclass;
  if v_defaults is distinct from array['created_at:now()']::text[] then
    raise exception 'meal_plan_write_receipts has an incompatible default contract';
  end if;

  select array_agg(a.attname order by k.ordinality) into v_primary_key
  from pg_catalog.pg_constraint c
  cross join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality)
  join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
  where c.conrelid = 'public.meal_plan_write_receipts'::regclass and c.contype = 'p';
  if v_primary_key is distinct from array['family_id', 'actor_id', 'request_id']::text[] then
    raise exception 'meal_plan_write_receipts has an incompatible primary key';
  end if;

  select array_agg(
    case c.contype
      when 'f' then c.conname || ':f:' ||
        (select string_agg(la.attname, ',' order by lk.ordinality)
         from unnest(c.conkey) with ordinality as lk(attnum, ordinality)
         join pg_catalog.pg_attribute la on la.attrelid = c.conrelid and la.attnum = lk.attnum) || '->' ||
        (select rn.nspname || '.' || rr.relname || '(' || string_agg(ra.attname, ',' order by rk.ordinality) || ')'
         from pg_catalog.pg_class rr
         join pg_catalog.pg_namespace rn on rn.oid = rr.relnamespace
         cross join lateral unnest(c.confkey) with ordinality as rk(attnum, ordinality)
         join pg_catalog.pg_attribute ra on ra.attrelid = rr.oid and ra.attnum = rk.attnum
         where rr.oid = c.confrelid
         group by rn.nspname, rr.relname) ||
        ':update=' || c.confupdtype::text || ':delete=' || c.confdeltype::text ||
        ':validated=' || c.convalidated::text ||
        ':deferrable=' || c.condeferrable::text
      else c.conname || ':' || c.contype::text || ':' ||
        pg_catalog.pg_get_constraintdef(c.oid, true) ||
        ':validated=' || c.convalidated::text || ':deferrable=' || c.condeferrable::text
    end order by c.conname
  ) into v_constraints
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.meal_plan_write_receipts'::regclass;
  if v_constraints is distinct from array[
    'meal_plan_write_receipts_actor_id_fkey:f:actor_id->auth.users(id):update=a:delete=c:validated=true:deferrable=false',
    'meal_plan_write_receipts_family_id_fkey:f:family_id->public.families(id):update=a:delete=c:validated=true:deferrable=false',
    'meal_plan_write_receipts_operation_check:c:CHECK (operation = ANY (ARRAY[''replace''::text, ''remove''::text])):validated=true:deferrable=false',
    'meal_plan_write_receipts_payload_hash_check:c:CHECK (payload_hash ~ ''^[0-9a-f]{64}$''::text):validated=true:deferrable=false',
    'meal_plan_write_receipts_pkey:p:PRIMARY KEY (family_id, actor_id, request_id):validated=true:deferrable=false',
    'meal_plan_write_receipts_request_id_check:c:CHECK (length(request_id) >= 1 AND length(request_id) <= 128):validated=true:deferrable=false'
  ]::text[] then
    raise exception 'meal_plan_write_receipts has incompatible constraints';
  end if;

  -- This is an RPC-only private receipt table. Remove any generic family CRUD
  -- policies carried forward by an existing schema before reasserting RLS.
  for v_policy in
    select p.polname from pg_catalog.pg_policy p
    where p.polrelid = 'public.meal_plan_write_receipts'::regclass
  loop
    execute format('drop policy %I on public.meal_plan_write_receipts', v_policy);
  end loop;
end;
$$;

alter table public.meal_plan_write_receipts enable row level security;
alter table public.meal_plan_write_receipts force row level security;
revoke all on public.meal_plan_write_receipts from public, anon, authenticated, service_role;

-- SELECT ... FOR SHARE needs UPDATE privilege on the locked relation, which
-- authenticated clients do not have for family_members. Keep the narrow trigger
-- SECURITY DEFINER with a fixed search_path; authorization remains bound to auth.uid().
create or replace function public.meal_plan_slot_write_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_family_ids uuid[];
  v_family_id uuid;
  v_actor_role public.member_role;
  v_old_key text;
  v_new_key text;
  v_slot_key text;
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      v_family_ids := array[new.family_id];
    elsif tg_op = 'DELETE' then
      v_family_ids := array[old.family_id];
    else
      v_family_ids := array[old.family_id, new.family_id];
    end if;

    -- Direct authenticated table writes are still available to older clients.
    -- Lock every affected membership in stable order so deactivation, deletion,
    -- or a guest-role change cannot commit between authorization and this write.
    for v_family_id in
      select distinct requested.family_id
      from pg_catalog.unnest(v_family_ids) as requested(family_id)
      where requested.family_id is not null
      order by requested.family_id
    loop
      select fm.role into v_actor_role
      from public.family_members fm
      where fm.family_id = v_family_id and fm.user_id = auth.uid() and fm.is_active
      for share;
      if not found then
        raise exception 'Not an active meal-plan member' using errcode = '42501';
      elsif v_actor_role = 'guest' then
        raise exception 'A guest can view the household but not change its meal plan' using errcode = '42501';
      end if;
    end loop;
  end if;
  if tg_op <> 'INSERT' then
    v_old_key := old.family_id::text || ':' || old.plan_date::text || ':' || old.meal_type::text;
  end if;
  if tg_op <> 'DELETE' then
    v_new_key := new.family_id::text || ':' || new.plan_date::text || ':' || new.meal_type::text;
  end if;

  -- Stable order for moves between slots avoids opposite-direction update deadlocks.
  for v_slot_key in
    select distinct k from pg_catalog.unnest(array[v_old_key, v_new_key]) as keys(k)
    where k is not null order by k
  loop
    perform pg_advisory_xact_lock(hashtextextended('meal-plan-slot:' || v_slot_key, 0));
  end loop;

  if tg_op <> 'DELETE' then
    if exists (
      select 1 from public.meal_plans p
      where p.family_id = new.family_id and p.plan_date = new.plan_date and p.meal_type = new.meal_type
        and p.id <> new.id
    ) then
      raise exception 'meal plan slot is already occupied' using errcode = '23505';
    end if;
    return new;
  end if;
  return old;
end;
$$;

revoke all on function public.meal_plan_slot_write_guard() from public, anon, authenticated;
drop trigger if exists meal_plan_slot_write_guard on public.meal_plans;
create trigger meal_plan_slot_write_guard
  before insert or update or delete on public.meal_plans
  for each row execute function public.meal_plan_slot_write_guard();

create or replace function public.meal_plan_replace_slots(
  p_family_id uuid,
  p_request_id text,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role public.member_role;
  v_hash text;
  v_receipt public.meal_plan_write_receipts%rowtype;
  v_claimed integer;
  v_entry jsonb;
  v_slot record;
  v_meal_id uuid;
  v_replaced integer;
  v_rows jsonb;
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'Not a member of this family' using errcode = '42501';
  end if;
  -- Serialize authorization with membership changes: a concurrent removal or
  -- guest-role change waits until this write commits, or wins before this read.
  select fm.role into v_actor_role from public.family_members fm
   where fm.family_id = p_family_id and fm.user_id = v_actor and fm.is_active
   for share;
  if not found or v_actor_role = 'guest' then
    raise exception 'Not a member of this family' using errcode = '42501';
  end if;
  if p_request_id is null or length(p_request_id) not between 1 and 128
     or p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) not between 1 and 40 then
    raise exception 'Invalid meal-plan request' using errcode = '22023';
  end if;

  -- Hash PostgreSQL's canonical JSONB representation; callers cannot choose
  -- the payload fingerprint that binds a retry to its original operation.
  v_hash := encode(sha256(convert_to(jsonb_build_object('operation', 'replace', 'entries', p_entries)::text, 'UTF8')), 'hex');

  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    if jsonb_typeof(v_entry) <> 'object'
      or (v_entry->>'plan_date') is null
      or (v_entry->>'meal_type') is null
      or (v_entry->>'meal_type') not in ('breakfast', 'lunch', 'dinner', 'snack')
      or (v_entry->>'meal_id') is null
      or (v_entry->>'meal_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (v_entry->>'plan_date') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Invalid or unavailable meal-plan entry' using errcode = '22023';
    end if;
    v_meal_id := (v_entry->>'meal_id')::uuid;
    perform 1 from public.meals m where m.id = v_meal_id and m.family_id = p_family_id for key share;
    if not found then raise exception 'Invalid or unavailable meal-plan entry' using errcode = '42501'; end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(p_entries) e
      group by e.value->>'plan_date', e.value->>'meal_type' having count(*) > 1) then
    raise exception 'A meal-plan slot was supplied more than once' using errcode = '22023';
  end if;

  insert into public.meal_plan_write_receipts(family_id, actor_id, request_id, operation, payload_hash)
  values (p_family_id, v_actor, p_request_id, 'replace', v_hash)
  on conflict do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select * into v_receipt from public.meal_plan_write_receipts
      where family_id = p_family_id and actor_id = v_actor and request_id = p_request_id;
    if not found or v_receipt.operation <> 'replace' or v_receipt.payload_hash <> v_hash or v_receipt.result is null then
      raise exception 'Meal-plan request ID was already used for a different or incomplete request' using errcode = '22023';
    end if;
    return jsonb_set(v_receipt.result, '{replayed}', 'true'::jsonb, true);
  end if;

  -- Lock all slots in one deterministic order before observing or changing any.
  for v_slot in
    select distinct (e.value->>'plan_date')::date as plan_date, e.value->>'meal_type' as meal_type
    from jsonb_array_elements(p_entries) e
    order by plan_date, meal_type
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'meal-plan-slot:' || p_family_id::text || ':' || v_slot.plan_date::text || ':' || v_slot.meal_type, 0));
  end loop;

  select count(*) into v_replaced
  from public.meal_plans p
  join (select distinct (e.value->>'plan_date')::date as plan_date, e.value->>'meal_type' as meal_type
        from jsonb_array_elements(p_entries) e) slots
    on p.plan_date = slots.plan_date and p.meal_type::text = slots.meal_type
  where p.family_id = p_family_id;

  delete from public.meal_plans p using (
    select distinct (e.value->>'plan_date')::date as plan_date, e.value->>'meal_type' as meal_type
    from jsonb_array_elements(p_entries) e
  ) slots where p.family_id = p_family_id and p.plan_date = slots.plan_date and p.meal_type::text = slots.meal_type;

  insert into public.meal_plans(family_id, meal_id, plan_date, meal_type, created_by)
  select p_family_id, (e.value->>'meal_id')::uuid, (e.value->>'plan_date')::date,
         (e.value->>'meal_type')::public.meal_type, v_actor
  from jsonb_array_elements(p_entries) e;

  select coalesce(jsonb_agg(to_jsonb(p) order by p.plan_date, p.meal_type), '[]'::jsonb)
    into v_rows from public.meal_plans p
    join (select distinct (e.value->>'plan_date')::date as plan_date, e.value->>'meal_type' as meal_type
          from jsonb_array_elements(p_entries) e) slots
      on p.plan_date = slots.plan_date and p.meal_type::text = slots.meal_type
    where p.family_id = p_family_id;
  v_result := jsonb_build_object('planned', v_rows, 'replaced', v_replaced, 'replayed', false);
  update public.meal_plan_write_receipts set result = v_result
    where family_id = p_family_id and actor_id = v_actor and request_id = p_request_id;
  return v_result;
end;
$$;

create or replace function public.meal_plan_remove_slot(
  p_family_id uuid,
  p_request_id text,
  p_plan_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role public.member_role;
  v_hash text;
  v_receipt public.meal_plan_write_receipts%rowtype;
  v_claimed integer;
  v_row public.meal_plans%rowtype;
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'Not a member of this family' using errcode = '42501';
  end if;
  select fm.role into v_actor_role from public.family_members fm
   where fm.family_id = p_family_id and fm.user_id = v_actor and fm.is_active
   for share;
  if not found or v_actor_role = 'guest' then
    raise exception 'Not a member of this family' using errcode = '42501';
  end if;
  if p_request_id is null or length(p_request_id) not between 1 and 128 or p_plan_id is null then
    raise exception 'Invalid meal-plan request' using errcode = '22023';
  end if;
  v_hash := encode(sha256(convert_to(jsonb_build_object('operation', 'remove', 'plan_id', p_plan_id)::text, 'UTF8')), 'hex');

  insert into public.meal_plan_write_receipts(family_id, actor_id, request_id, operation, payload_hash)
  values (p_family_id, v_actor, p_request_id, 'remove', v_hash)
  on conflict do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select * into v_receipt from public.meal_plan_write_receipts
      where family_id = p_family_id and actor_id = v_actor and request_id = p_request_id;
    if not found or v_receipt.operation <> 'remove' or v_receipt.payload_hash <> v_hash or v_receipt.result is null then
      raise exception 'Meal-plan request ID was already used for a different or incomplete request' using errcode = '22023';
    end if;
    return jsonb_set(v_receipt.result, '{replayed}', 'true'::jsonb, true);
  end if;

  select * into v_row from public.meal_plans where id = p_plan_id and family_id = p_family_id;
  if not found then raise exception 'Planned meal not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'meal-plan-slot:' || v_row.family_id::text || ':' || v_row.plan_date::text || ':' || v_row.meal_type::text, 0));
  select * into v_row from public.meal_plans where id = p_plan_id and family_id = p_family_id for update;
  if not found then raise exception 'Planned meal changed before it could be cleared' using errcode = 'P0002'; end if;
  delete from public.meal_plans where id = p_plan_id and family_id = p_family_id;
  v_result := jsonb_build_object('id', p_plan_id, 'plan_date', v_row.plan_date, 'meal_type', v_row.meal_type, 'replayed', false);
  update public.meal_plan_write_receipts set result = v_result
    where family_id = p_family_id and actor_id = v_actor and request_id = p_request_id;
  return v_result;
end;
$$;

revoke all on function public.meal_plan_replace_slots(uuid, text, jsonb) from public, anon;
revoke all on function public.meal_plan_remove_slot(uuid, text, uuid) from public, anon;
grant execute on function public.meal_plan_replace_slots(uuid, text, jsonb) to authenticated;
grant execute on function public.meal_plan_remove_slot(uuid, text, uuid) to authenticated;

comment on table public.meal_plan_write_receipts is
  'Private actor-scoped durable receipts for atomic meal-plan operations; rows can only be written/read by the restricted meal-plan RPCs.';
