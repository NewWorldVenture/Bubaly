-- ============================================================================
-- FamilyOS · SEED — Autopilot (autopilot_suggestions 500 + approval_requests 500).
-- The Autopilot queue + the approval inbox at volume, spanning statuses.
-- Idempotent: suggestions cleared by dedupe_key prefix 'seed-ap-'; approvals by
-- a '[seed:ap]' summary marker.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  n int := 500;
  s_titles text[] := array['Reschedule overlapping events','Reorder low grocery staples','Prep for tomorrow''s game',
                          'Renew expiring document','Plan 3 unplanned dinners','Confirm the appointment',
                          'Split a bill fairly','Nudge an overdue chore','Batch school forms','Book a sitter'];
  s_status text[] := array['open','open','approved','executed','auto_executed','dismissed','snoozed'];
  a_titles text[] := array['Approve $24 grocery top-up','Allow calendar auto-merge','Approve babysitter booking',
                          'Confirm allowance run','Approve meal-plan order','Grant location share',
                          'Approve subscription renewal','Authorize ride booking'];
  a_status text[] := array['pending','pending','approved','rejected','expired','cancelled'];
  a_prio   text[] := array['low','normal','high','urgent'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  delete from public.autopilot_suggestions where family_id = v_family and dedupe_key like 'seed-ap-%';
  delete from public.approval_requests where family_id = v_family and summary = '[seed:ap]';

  insert into public.autopilot_suggestions (family_id, member_id, kind, title, detail, confidence, urgency, status, action_type, action_label, dedupe_key)
  select v_family,
    case when v_members is null then null else v_members[1 + (g.i % array_length(v_members,1))] end,
    (array['schedule','grocery','prep','document','meal'])[1 + (g.i % 5)],
    s_titles[1 + (g.i % array_length(s_titles,1))] || ' #' || g.i,
    'Autopilot spotted this and can handle it for you.',
    50 + (g.i % 50),
    1 + (g.i % 3),
    s_status[1 + (g.i % array_length(s_status,1))]::autopilot_status,
    'confirm', 'Approve',
    'seed-ap-' || g.i
  from generate_series(1, n) as g(i);

  insert into public.approval_requests (family_id, domain, title, summary, requested_by_kind, agent, amount_cents, confidence, approval_model, status, priority)
  select v_family,
    (array['finance','calendar','safety','commerce'])[1 + (g.i % 4)],
    a_titles[1 + (g.i % array_length(a_titles,1))] || ' #' || g.i,
    '[seed:ap]',
    'ai', 'autopilot',
    (500 + (g.i * 37) % 20000),
    round((0.5 + (g.i % 50) * 0.01)::numeric, 2),
    'single',
    a_status[1 + (g.i % array_length(a_status,1))],
    a_prio[1 + (g.i % array_length(a_prio,1))]
  from generate_series(1, n) as g(i);

  raise notice 'Autopilot seeded % suggestions + % approvals for family %', n, n, v_family;
end $$;
