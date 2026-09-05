-- ============================================================================
-- Bubaly · SEED — Time-Saved metric (R11)  [seed:timesaved]
-- Populates the three "system handled it for you" inputs lib/metric/time-saved.ts
-- counts over the last 7 days, so the Home + Experience "N hours saved this week"
-- banner shows a real figure:
--   • 250 auto-executed autopilot_suggestions   (5 min each)
--   • 150 done agent_activity rows               (4 min each)
--   • 150 completed family_reminders             (2 min each)
-- Total: 550 records (>500) → ~250*5 + 150*4 + 150*2 = 2150 min ≈ 35.8 hours.
-- Idempotent: clears its own rows first. Where: Supabase SQL Editor → Run.
-- (Needs migrations 0085 autopilot · 0127 agent_activity · family_reminders.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  agents text[] := array['scheduler','meal_planner','budget_coach','household_manager','chief_of_staff'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.autopilot_suggestions where family_id = v_family and payload->>'seed' = 'timesaved';
  delete from public.agent_activity        where family_id = v_family and title like 'Seed handled #%';
  delete from public.family_reminders      where family_id = v_family and title like 'Seed reminder #%';

  -- 250 auto-executed autopilot actions across the last 7 days.
  insert into public.autopilot_suggestions
    (family_id, kind, title, detail, confidence, urgency, status, action_type, payload, dedupe_key, created_at, updated_at, resolved_at)
  select v_family, 'reminder', 'Auto-handled task #' || g.i, 'Handled for you.', 90, 1, 'auto_executed', 'none',
         '{"seed":"timesaved"}'::jsonb, 'seed:timesaved:' || g.i,
         now() - (g.i % 7) * interval '1 day', now() - (g.i % 7) * interval '1 day', now() - (g.i % 7) * interval '1 day'
  from generate_series(1, 250) as g(i);

  -- 150 agent actions marked done across the last 7 days.
  insert into public.agent_activity (family_id, agent, kind, title, detail, severity, status, created_at, updated_at)
  select v_family, agents[1 + (g.i % array_length(agents,1))], 'action',
         'Seed handled #' || g.i, 'Resolved by your assistant.', 'info', 'done',
         now() - (g.i % 7) * interval '1 day', now() - (g.i % 7) * interval '1 day'
  from generate_series(1, 150) as g(i);

  -- 150 reminders delivered (completed) across the last 7 days.
  insert into public.family_reminders (family_id, title, kind, status, remind_at, completed_at, updated_at, ai_suggested)
  select v_family, 'Seed reminder #' || g.i, 'time', 'completed',
         now() - (g.i % 7) * interval '1 day', now() - (g.i % 7) * interval '1 day', now() - (g.i % 7) * interval '1 day', true
  from generate_series(1, 150) as g(i);

  raise notice 'Time-saved seeded: 250 autopilot + 150 agent + 150 reminders for family %.', v_family;
end $$;

-- Verify (each within the last 7 days):
--   select count(*) from autopilot_suggestions where payload->>'seed'='timesaved' and status='auto_executed'; -- 250
--   select count(*) from agent_activity where title like 'Seed handled #%' and status='done';                 -- 150
--   select count(*) from family_reminders where title like 'Seed reminder #%' and status='completed';         -- 150
--   -- then /home shows "≈ 35.8 hours saved this week — 550 things handled for you."
