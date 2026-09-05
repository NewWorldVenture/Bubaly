-- ============================================================================
-- Bubaly · SEED — Proactive Front Door (R5)  [seed:frontdoor]
-- Populates the Home front-door hero at volume:
--   • 300 AUTO-EXECUTED autopilot_suggestions (last ~48h) → "I already handled N"
--   • 250 PENDING approval_requests (varied priority)     → "N waiting on your OK"
-- Total: 550 records (>500). Both feed lib/home/front-door.ts::buildFrontDoor.
-- Idempotent: clears its own rows first (payload->>'seed' = 'frontdoor').
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migrations 0085 + 0093.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  kinds  text[] := array['groceries','document','appointment','chore','birthday','reminder','wellbeing','finance'];
  titles text[] := array['Reordered milk','Filed the permission slip','Booked the dentist reminder',
                         'Reassigned the trash chore','Added a birthday gift reminder','Snoozed a low-priority nudge',
                         'Logged a wellness check-in','Categorized this month''s expenses'];
  domains text[] := array['finance','calendar','household','health','shopping'];
  areqs  text[] := array['Approve field-trip payment','Confirm the babysitter booking','OK the grocery reorder',
                         'Approve a subscription renewal','Confirm the weekend plan','Authorize a wallet top-up'];
  prios  text[] := array['low','normal','normal','high','urgent'];
  agents text[] := array['Budget Coach','Scheduler','Household Manager','Meal Planner','Chief of Staff'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  -- Clear prior seed.
  delete from public.autopilot_suggestions where family_id = v_family and payload->>'seed' = 'frontdoor';
  delete from public.approval_requests    where family_id = v_family and payload->>'seed' = 'frontdoor';

  -- 300 auto-executed autopilot actions, timestamped across the last ~47 hours.
  insert into public.autopilot_suggestions
    (family_id, kind, title, detail, confidence, urgency, status, action_type, action_label, payload, dedupe_key, created_at, updated_at, resolved_at)
  select
    v_family,
    kinds[1 + (g.i % array_length(kinds,1))],
    titles[1 + (g.i % array_length(titles,1))],
    'Handled automatically — reversible from Autopilot.',
    85 + (g.i % 15),
    1 + (g.i % 3),
    'auto_executed',
    'none',
    'Undo',
    '{"seed":"frontdoor"}'::jsonb,
    'seed:frontdoor:' || g.i,
    now() - (g.i % 47) * interval '1 hour',
    now() - (g.i % 47) * interval '1 hour',
    now() - (g.i % 47) * interval '1 hour'
  from generate_series(1, 300) as g(i);

  -- 250 pending approvals, varied priority + agent.
  insert into public.approval_requests
    (family_id, domain, capability, requested_by_kind, agent, title, summary, payload, priority, status, reasoning)
  select
    v_family,
    domains[1 + (g.i % array_length(domains,1))],
    'automate',
    'ai',
    agents[1 + (g.i % array_length(agents,1))],
    areqs[1 + (g.i % array_length(areqs,1))] || ' #' || g.i,
    'Proposed by the assistant — needs a yes/no.',
    '{"seed":"frontdoor"}'::jsonb,
    prios[1 + (g.i % array_length(prios,1))],
    'pending',
    'Above the auto-approve threshold — a human should confirm.'
  from generate_series(1, 250) as g(i);

  raise notice 'Front door seeded: 300 auto-executed + 250 pending approvals for family %.', v_family;
end $$;

-- Verify:
--   select count(*) from autopilot_suggestions where payload->>'seed'='frontdoor' and status='auto_executed'; -- 300
--   select count(*) from approval_requests    where payload->>'seed'='frontdoor' and status='pending';        -- 250
--   -- then open /home → the hero reads "I already handled 300 things — 250 need your OK."
