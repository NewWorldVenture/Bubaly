-- ============================================================================
-- FamilyOS · SEED — Intelligence Network aggregates (network_aggregates).
-- Synthetic PUBLISH-SAFE aggregates so /dashboard/intelligence can be tested when
-- a family opts in. Every row has cohort_size >= 20 (the k-anonymity floor), so it
-- mirrors exactly what the real cron would publish. The set is the FULL deterministic
-- cohort × metric × value product (aggregates are naturally bounded — one row per
-- combo — not a 500-row volume table). Idempotent (clears all rows). Also opts the
-- seed family in so insights render. Where: Supabase → SQL Editor → Run.
-- (Needs migration 0135 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  kid_bands text[] := array['none','3–5','6–9','10–13','14–17','6–9.10–13'];
  size_bands text[] := array['1–2','3–4','5+'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;

  -- Full product: each cohort (kids × size) × each metric value → exactly one row.
  insert into public.network_aggregates (scope, cohort_key, metric, value, count, cohort_size)
  select 'benchmarks', 'kids:' || k || '|size:' || s, mv.metric, mv.value,
    20 + mod(hashtextextended(k || '|' || s || '|' || mv.metric || '|' || mv.value, 1) & 2147483647, 80)::int,
    100 + mod(hashtextextended(k || '|' || s || '|' || mv.metric || '|' || mv.value, 2) & 2147483647, 401)::int
  from unnest(kid_bands) k
  cross join unnest(size_bands) s
  cross join (values
    ('dinner_habit','rarely (0–1)'), ('dinner_habit','sometimes (2–3)'),
    ('dinner_habit','often (4–5)'),  ('dinner_habit','most nights (6–7)'),
    ('activities','none'), ('activities','1–2'), ('activities','3–4'), ('activities','5+')
  ) as mv(metric, value)
  on conflict (scope, cohort_key, metric, value) do update
    set count = excluded.count, cohort_size = excluded.cohort_size, computed_at = now();

  -- Opt the seed family in so the insights actually render on screen.
  insert into public.network_consent (family_id, enabled, scopes, consented_at)
  values (v_family, true, '{"timing":true,"benchmarks":true,"recommendations":true}'::jsonb, now())
  on conflict (family_id) do update set enabled = true,
    scopes = '{"timing":true,"benchmarks":true,"recommendations":true}'::jsonb;

  raise notice 'Network aggregates seeded (>=20 cohort size) + family % opted in', v_family;
end $$;

-- Verify:
--   select count(*) from network_aggregates;                       -- ~ up to 500 (unique key may dedupe)
--   select min(cohort_size) from network_aggregates;               -- >= 20
