-- ============================================================================
-- Bubaly · SEED — Prep Plans (prep_plans 500 + prep_plan_steps ~2000).
-- 500 look-ahead plans across kinds/urgencies, each with a few timed steps, so
-- /dashboard/prep-plans can be tested at volume. Idempotent: clears its own
-- 'seed-prep-%' signal rows (steps cascade). Where: Supabase → SQL Editor → Run.
-- (Needs migration 0131 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  kinds text[] := array['trip','birthday','doc_expiry','school_start','event'];
  urg   text[] := array['now','soon','later'];
  titles text[] := array['Get ready: Beach Trip','Plan: Emma''s Birthday','Renew: Passport',
                        'Prep for: School Start','Prepare for: Recital','Get ready: Ski Weekend',
                        'Plan: Anniversary','Renew: Car Registration','Prep for: New Term'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.prep_plans where family_id = v_family and signal_id like 'seed-prep-%';

  with new_plans as (
    insert into public.prep_plans (family_id, signal_kind, signal_id, title, target_date, urgency, status)
    select v_family,
      kinds[1 + (g.i % array_length(kinds,1))],
      'seed-prep-' || g.i,
      titles[1 + (g.i % array_length(titles,1))] || ' #' || g.i,
      (current_date + (5 + (g.i % 110)))::date,
      urg[1 + (g.i % array_length(urg,1))],
      'active'
    from generate_series(1, n) as g(i)
    returning id, family_id, target_date
  )
  insert into public.prep_plan_steps (family_id, plan_id, label, href, due_date, lead_days, is_done, sort_order)
  select np.family_id, np.id,
    (array['Confirm details','Gather what''s needed','Book/order','Final prep'])[k.k],
    '/dashboard/calendar',
    (np.target_date - (array[21,14,7,1])[k.k])::date,
    (array[21,14,7,1])[k.k],
    (k.k = 1 and random() < 0.3),
    k.k - 1
  from new_plans np
  cross join generate_series(1, 4) as k(k);

  raise notice 'Prep Plans seeded % plans (+4 steps each) for family %', n, v_family;
end $$;

-- Verify:
--   select count(*) from prep_plans where signal_id like 'seed-prep-%';
--   select count(*) from prep_plan_steps s join prep_plans p on p.id=s.plan_id where p.signal_id like 'seed-prep-%';
