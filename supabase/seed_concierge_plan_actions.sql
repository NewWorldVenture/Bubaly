-- ============================================================================
-- Bubaly · SEED — Concierge plan actions (500 records).
-- Fills concierge_plan_actions so the deeper write-back audit renders at volume:
-- 500 materializations (calendar / reminder / task) across the family's concierge
-- plans, one per (plan, kind). Requires the concierge plans seeded first
-- (seed_concierge.sql) and migration 0158. Idempotent via detail like '%[seed]%';
-- resolves the family by email.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_user   uuid;
  v_plans  uuid[];
  np int; n int := 500;
  kinds  text[] := array['calendar','reminder','task'];
  tables text[] := array['calendar_events','family_reminders','family_reminders'];
begin
  if to_regclass('public.concierge_plan_actions') is null then
    raise notice 'concierge_plan_actions not present — apply migration 0158 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select fm.user_id into v_user from public.family_members fm
  where fm.family_id = v_family and fm.user_id is not null limit 1;

  select array_agg(id) into v_plans from (
    select id from public.concierge_plans where family_id = v_family order by created_at limit 1000
  ) s;
  np := coalesce(array_length(v_plans, 1), 0);
  if np = 0 then
    raise notice 'No concierge plans — run seed_concierge.sql first. Skipping.';
    return;
  end if;

  delete from public.concierge_plan_actions where family_id = v_family and detail like '%[seed]%';

  -- Grid walk: kind = i % 3 (even spread across all three kinds), plan = i / 3.
  -- Each plan gets its 3 kinds before the next → distinct (plan, kind) pairs,
  -- balanced, unique for np ≥ 167.
  insert into public.concierge_plan_actions
    (family_id, plan_id, action_kind, target_table, target_id, detail, created_by, created_at)
  select
    v_family,
    v_plans[1 + ((g.i / 3) % np)],
    kinds[1 + (g.i % 3)],
    tables[1 + (g.i % 3)],
    null,
    'Materialized by the concierge. [seed]',
    v_user,
    now() - ((g.i % 90) || ' days')::interval
  from generate_series(0, n - 1) g(i)
  on conflict (family_id, plan_id, action_kind) do nothing;

  raise notice 'Concierge plan actions seeded (up to 500) across % plans for family %', np, v_family;
end $$;

-- Verify:
--   select count(*) from concierge_plan_actions where detail like '%[seed]%';   -- up to 500
--   select action_kind, count(*) from concierge_plan_actions group by action_kind;
