-- ============================================================================
-- FamilyOS · SEED — Pillar #5: Command Center evening summary
-- 500 daily Family Operating Index snapshots (one per day, 500 days back). The
-- "yesterday" snapshot carries open suggestions + a lower composite, so the
-- "Since yesterday" recap on /dashboard/command-center (and the Operating Index)
-- shows real cleared items + an improvement once today is computed live.
-- Idempotent: upserts on unique(family_id, as_of_date).
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  insert into public.family_operating_index (family_id, as_of_date, composite, band, dimensions, suggestions)
  select
    v_family,
    current_date - g.i,
    comp,
    case when comp >= 85 then 'thriving' when comp >= 70 then 'steady' when comp >= 55 then 'stretched' else 'overloaded' end,
    jsonb_build_object(
      'planning', comp, 'schedule', greatest(0, comp - 6), 'financial', least(100, comp + 5),
      'readiness', comp, 'communication', least(100, comp + 3), 'routines', greatest(0, comp - 4), 'goals', comp),
    case when g.i in (1, 2) then
      '[{"id":"seed-doc","title":"A document is expiring soon","detail":"Renew it before it lapses","href":"/dashboard/documents","dimension":"readiness","impact":8},
        {"id":"seed-dinner","title":"3 dinners this week are unplanned","detail":"Plan meals","href":"/dashboard/meals","dimension":"routines","impact":6},
        {"id":"seed-conflict","title":"A schedule clash tomorrow","detail":"Decide who covers what","href":"/dashboard/conflicts","dimension":"schedule","impact":9}]'::jsonb
    else '[]'::jsonb end
  from generate_series(0, 499) as g(i)
  cross join lateral (select (55 + ((g.i * 7) % 45))::int as comp) c
  on conflict (family_id, as_of_date) do update
    set composite = excluded.composite, band = excluded.band,
        dimensions = excluded.dimensions, suggestions = excluded.suggestions;

  raise notice 'Pillar #5 (command center) seeded 500 daily snapshots for family %', v_family;
end $$;
