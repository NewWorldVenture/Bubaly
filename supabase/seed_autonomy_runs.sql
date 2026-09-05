-- ============================================================================
-- Bubaly · SEED — Autonomous execution loop (500 records).
-- Fills family_automation_runs with loop-triggered runs (trigger_type
-- 'plan_accepted') so the Concierge Autopilot panel can be tested at volume:
-- realistic "Bubaly did it" summaries across executed / pending / dismissed,
-- step mixes (calendar + reminder + task), approvals stamped on a share of the
-- executed rows, and created_at spread across 60 days so the weekly stats move.
-- Also ensures the family's autopilot dial policy exists (trust_policies,
-- 'Concierge autopilot', default ask-first).
-- Idempotent: tags rows metadata->>'seed' = 'autonomy' and clears its own rows
-- first. Resolves family by email. (Needs migrations 0022 + 0093 — long since
-- applied; NO new migration.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_user   uuid;
  titles   text[] := array[
    'Beach weekend','Emma''s birthday party','Date night downtown','Camping at Silver Lake',
    'Museum day','Soccer season kickoff dinner','Grandma''s visit','Ski trip planning',
    'Backyard movie night','Farmers market Saturday','Spring break road trip','Aquarium outing'];
  stepsets text[] := array[
    'calendar,reminder,task','calendar,reminder','reminder,task','calendar,task','reminder','calendar'];
  n        int := 500;
  i        int;
  ttl      text;
  st       text;
  steps    text[];
  phrase   text;
  created  timestamptz;
  total    int := 0;
begin
  if to_regclass('public.family_automation_runs') is null then
    raise notice 'family_automation_runs not present — apply migration 0022 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select user_id into v_user from public.family_members
  where family_id = v_family and user_id is not null order by created_at limit 1;

  -- The autopilot dial policy (ask-first default) — only if the family has none.
  begin
    if to_regclass('public.trust_policies') is not null and not exists (
      select 1 from public.trust_policies
      where family_id = v_family and name = 'Concierge autopilot'
    ) then
      insert into public.trust_policies
        (family_id, name, description, domain, capability, subject_kind, effect, priority, enabled, is_system, created_by)
      values
        (v_family, 'Concierge autopilot',
         'Governs whether Bubaly executes accepted concierge plans on its own (allow), asks first (require_approval), or stays hands-off (deny).',
         'scheduling', 'automate', 'ai', 'require_approval', 10, true, true, v_user);
    end if;
  exception when undefined_table or undefined_column then null; end;

  -- Clear this seed's prior rows (idempotent re-run).
  delete from public.family_automation_runs
   where family_id = v_family and metadata->>'seed' = 'autonomy';

  for i in 1..n loop
    ttl   := titles[1 + (i % array_length(titles, 1))] || ' #' || i;
    -- ~70% executed, ~15% pending, ~15% dismissed.
    st    := (array['executed','executed','executed','executed','executed','pending','dismissed'])[1 + (i % 7)];
    steps := string_to_array(stepsets[1 + (i % array_length(stepsets, 1))], ',');
    phrase := case
      when array_length(steps, 1) = 3 then 'put it on the calendar, set a follow-up reminder and added a prep task'
      when steps @> array['calendar'] and steps @> array['reminder'] then 'put it on the calendar and set a follow-up reminder'
      when steps @> array['reminder'] and steps @> array['task'] then 'set a follow-up reminder and added a prep task'
      when steps @> array['calendar'] and steps @> array['task'] then 'put it on the calendar and added a prep task'
      when steps @> array['calendar'] then 'put it on the calendar'
      else 'set a follow-up reminder' end;
    created := now() - make_interval(days => i % 60, hours => i % 13);

    insert into public.family_automation_runs
      (family_id, rule_id, trigger_type, status, summary, result, approved_by, approved_at, metadata, created_by, created_at)
    values
      (v_family, null, 'plan_accepted', st,
       case st
         when 'executed' then '“' || ttl || '” accepted — Bubaly ' || phrase || '.'
         when 'pending' then 'Waiting for approval: Execute plan: ' || ttl
         else 'Declined: Execute plan: ' || ttl
       end,
       case when st = 'executed' then jsonb_build_object('steps', to_jsonb(steps)) else '{}'::jsonb end,
       case when st = 'executed' and i % 3 = 0 then v_user else null end,
       case when st = 'executed' and i % 3 = 0 then created + interval '1 hour' else null end,
       jsonb_build_object('seed', 'autonomy', 'plan_id', null, 'kinds', to_jsonb(steps),
                          'basis', case when i % 3 = 0 then 'policy' else 'role_default' end,
                          'reason', 'Seeded autonomous run for volume testing'),
       v_user, created);

    total := total + 1;
  end loop;

  raise notice 'Seeded % family_automation_runs (autonomy loop) for family %.', total, v_family;
end $$;
