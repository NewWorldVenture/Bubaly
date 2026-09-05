-- ============================================================================
-- Bubaly · SEED — Pillar #6: Specialized agents (agent_activity)
-- 500 activity records spread across the 10 agents so /dashboard/agents shows a
-- rich per-agent history you can Done/Dismiss and fully test. Idempotent:
-- clears its own '[seed:p6]' rows (matched on detail) first, then reinserts.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  n int := 500;

  agents   text[] := array['chief_of_staff','scheduler','meal_planner','budget_coach','household_manager',
                           'school_coordinator','health_guide','travel_planner','memory_keeper','comms_assistant'];
  kinds    text[] := array['insight','recommendation','action','handoff'];
  sevs     text[] := array['info','attention','action'];
  hrefs    text[] := array['/dashboard/calendar','/dashboard/meals','/dashboard/bills','/dashboard/chores',
                           '/dashboard/homework','/dashboard/medications','/dashboard/trips','/dashboard/celebrations',
                           '/dashboard/messages','/dashboard/documents','/dashboard/grocery','/dashboard/conflicts'];
  titles   text[] := array['Flagged a schedule clash','Suggested a dinner plan','Bill due this week',
                           'Reassigned an overdue chore','Homework due tomorrow','Refill reminder set',
                           'Trip packing list ready','Birthday coming up','Drafted a reply','Document expiring',
                           'Added items to the list','Resolved a conflict','Booked an appointment','Trimmed a subscription'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  delete from public.agent_activity where family_id = v_family and detail like '%[seed:p6]%';

  insert into public.agent_activity (family_id, member_id, agent, kind, title, detail, href, severity, status, created_at)
  select
    v_family,
    case when random() < 0.5 or v_members is null then null else v_members[1 + floor(random()*array_length(v_members,1))::int] end,
    agents[1 + floor(random()*array_length(agents,1))::int],
    kinds[1 + floor(random()*array_length(kinds,1))::int],
    titles[1 + floor(random()*array_length(titles,1))::int] || ' #' || g.i,
    '[seed:p6] auto-logged by the agent',
    hrefs[1 + floor(random()*array_length(hrefs,1))::int],
    sevs[1 + floor(random()*array_length(sevs,1))::int],
    -- ~70% active (visible), the rest already resolved for history.
    (array['active','active','active','active','active','active','active','done','done','dismissed'])[1 + floor(random()*10)::int],
    now() - (random() * 90 || ' days')::interval
  from generate_series(1, n) as g(i);

  raise notice 'Pillar #6 (agents) seeded % activity records for family %', n, v_family;
end $$;

-- Verify:
--   select agent, count(*) from public.agent_activity group by agent order by 2 desc;
--   select status, count(*) from public.agent_activity group by status;
