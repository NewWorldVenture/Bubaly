-- ============================================================================
-- FamilyOS · SEED — Family Operating Index history (500 daily snapshots).
-- Fills family_operating_index with 500 days of daily snapshots so the FOI
-- **trend line** + "since yesterday" day-over-day recap render at volume (the
-- page shows "first reading" until history exists). A gentle wave around the mid-
-- 70s with a slight recent upward drift; per-dimension scores + captured
-- suggestions per snapshot. Idempotent: upserts on (family_id, as_of_date), so
-- re-running overwrites the same 500 days and never deletes real snapshots.
-- Resolves the family by email. (Needs migration 0125 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
begin
  if to_regclass('public.family_operating_index') is null then
    raise notice 'family_operating_index not present — apply migration 0125 first. Skipping.';
    return;
  end if;

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
    (current_date - g.i),
    c.composite,
    case when c.composite >= 85 then 'thriving'
         when c.composite >= 70 then 'steady'
         when c.composite >= 50 then 'stretched'
         else 'overloaded' end,
    -- per-dimension scores derived from the composite with fixed per-dim offsets.
    jsonb_build_object(
      'planning',      greatest(0, least(100, c.composite + 4)),
      'routine',       greatest(0, least(100, c.composite - 3)),
      'stability',     greatest(0, least(100, c.composite + 1)),
      'financial',     greatest(0, least(100, c.composite - 6)),
      'readiness',     greatest(0, least(100, c.composite + 2)),
      'communication', greatest(0, least(100, c.composite - 2)),
      'goals',         greatest(0, least(100, c.composite + 5))
    ),
    jsonb_build_array(
      jsonb_build_object('id','s1','title','Confirm 2 events missing a location','detail','Tap to add where they are','href','/dashboard/calendar','dimension','planning','impact','medium'),
      jsonb_build_object('id','s2','title','Review this week''s budget','detail','One category is trending over','href','/wallet','dimension','financial','impact','low')
    )
  from generate_series(0, n - 1) g(i)
  cross join lateral (
    -- recent days drift a little higher; a ±12 wave keeps bands varied.
    select greatest(30, least(98, round(60 + ((n - g.i)::numeric / n) * 18 + 12 * sin(g.i / 7.0))::int)) as composite
  ) c
  on conflict (family_id, as_of_date) do update
    set composite = excluded.composite, band = excluded.band,
        dimensions = excluded.dimensions, suggestions = excluded.suggestions;

  raise notice 'FOI history seeded 500 daily snapshots for family %', v_family;
end $$;

-- Verify:
--   select count(*) from family_operating_index where family_id = (select id from families order by created_at limit 1);  -- ≥ 500
--   select band, count(*) from family_operating_index group by band;
--   select as_of_date, composite, band from family_operating_index order by as_of_date desc limit 10;
