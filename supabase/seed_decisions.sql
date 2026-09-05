-- ============================================================================
-- Bubaly · SEED — Decision Engine (family_decisions 500 + decision_options ~1500).
-- 500 trade-off decisions, each with 3 options carrying real metrics so the engine
-- can score them. Idempotent: clears its own '[seed:dec]' rows (detail marker);
-- options cascade from decisions. Where: Supabase → SQL Editor → paste → Run.
-- (Needs migration 0130 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  questions text[] := array['Which vacation this summer?','Add another activity?','Which grocery run?',
                            'Weekend plan?','Which after-school program?','Birthday party venue?',
                            'Which car repair shop?','Weeknight dinner plan?','Which summer camp?',
                            'How to spend Saturday?'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.family_decisions where family_id = v_family and detail = '[seed:dec]';

  -- 500 decisions, then 3 options each via a lateral generate_series.
  with new_decisions as (
    insert into public.family_decisions (family_id, question, detail, status, budget_cents, max_travel_minutes)
    select v_family,
      questions[1 + (g.i % array_length(questions,1))] || ' #' || g.i,
      '[seed:dec]',
      case when g.i % 5 = 0 then 'decided' else 'open' end,
      case when g.i % 3 = 0 then (50000 + (g.i % 20) * 10000)::bigint else null end,
      case when g.i % 4 = 0 then 60 + (g.i % 6) * 30 else null end
    from generate_series(1, n) as g(i)
    returning id, family_id
  )
  insert into public.decision_options (family_id, decision_id, label, cost_cents, time_minutes, travel_minutes, load_delta, benefit)
  select nd.family_id, nd.id,
    (array['Option A','Option B','Option C'])[k.k],
    (30000 + (k.k * 40000) + floor(random()*30000))::bigint,
    (30 + k.k * 20 + floor(random()*30))::int,
    (20 + k.k * 40 + floor(random()*30))::int,
    (15 + k.k * 20 + floor(random()*20))::int,
    (90 - k.k * 15 + floor(random()*10))::int
  from new_decisions nd
  cross join generate_series(1, 3) as k(k);

  raise notice 'Decision Engine seeded % decisions (+3 options each) for family %', n, v_family;
end $$;

-- Verify:
--   select count(*) from family_decisions where detail='[seed:dec]';
--   select count(*) from decision_options o join family_decisions d on d.id=o.decision_id where d.detail='[seed:dec]';
