-- ============================================================================
-- seed_operating_index_all_families.sql — seeds the Family Operating Index
-- (public.family_operating_index, migration 0125) for EVERY family/profile.
-- ----------------------------------------------------------------------------
-- WHY: the "since yesterday" recap (pillar #5) surfaced on the Operating Index
-- page, the Family Command Center, and the Daily Briefing evening tab needs at
-- least TWO daily snapshots to diff. In a fresh environment every family has
-- zero snapshots, so the recap always reads "first reading". This seeds a
-- yesterday + today snapshot per family — deliberately DIFFERENT — so the recap
-- renders a real narrative everywhere (a point move, a cleared suggestion, a new
-- one, and a couple of dimension shifts).
--
-- TABLE: public.family_operating_index.   SCOPE: ALL families (all profiles).
--   Two rows per family (as_of_date = today and yesterday).
--
-- IDEMPOTENT: the table is unique on (family_id, as_of_date); this upserts on
--   that key, so re-running refreshes the same two dates in place. It only ever
--   touches yesterday/today; older real snapshots are untouched. The live app's
--   loadOperatingIndex upserts today's real snapshot on next visit, replacing
--   the seeded "today" with computed values — the seed just guarantees history.
--
-- HOW TO RUN:
--   psql "$SUPABASE_DB_URL" -f supabase/seed_operating_index_all_families.sql
--   (or paste into the Supabase SQL editor and press Run). Requires migration
--   0125_family_operating_index.sql applied first.
--
-- VERIFY: open /dashboard/family-operating-index (or /dashboard/command-center)
--   on any profile and hard-refresh — the "Since yesterday" card renders with a
--   point move + cleared/new items.
-- ============================================================================

do $$
declare
  f      record;
  fams   int := 0;
  -- Yesterday's suggestions: a, b, c.  Today's: b, c, d  → 'a' cleared, 'd' new.
  sugg_y jsonb := '[
    {"id":"plan-week","title":"Plan 3 unplanned dinners this week","href":"/dashboard/meals","dimension":"planning"},
    {"id":"assign-events","title":"Assign owners to 2 events","href":"/dashboard/calendar","dimension":"stability"},
    {"id":"renew-doc","title":"Renew an expiring document","href":"/dashboard/documents","dimension":"readiness"}
  ]'::jsonb;
  sugg_t jsonb := '[
    {"id":"assign-events","title":"Assign owners to 2 events","href":"/dashboard/calendar","dimension":"stability"},
    {"id":"renew-doc","title":"Renew an expiring document","href":"/dashboard/documents","dimension":"readiness"},
    {"id":"log-spend","title":"Log this week''s grocery spend","href":"/dashboard/expenses","dimension":"financial"}
  ]'::jsonb;
  -- Dimensions: today rises on planning (+12) and routine (+8), dips on financial (-7).
  dims_y jsonb := '{"planning":66,"stability":74,"financial":80,"readiness":70,"communication":82,"routine":68,"goals":60}'::jsonb;
  dims_t jsonb := '{"planning":78,"stability":76,"financial":73,"readiness":72,"communication":83,"routine":76,"goals":61}'::jsonb;
begin
  for f in select id from public.families loop
    fams := fams + 1;

    -- Yesterday: composite 72 (steady).
    insert into public.family_operating_index (family_id, as_of_date, composite, band, dimensions, suggestions)
    values (f.id, current_date - 1, 72, 'steady', dims_y, sugg_y)
    on conflict (family_id, as_of_date) do update
      set composite = excluded.composite, band = excluded.band,
          dimensions = excluded.dimensions, suggestions = excluded.suggestions;

    -- Today: composite 77 (steady, up 5) — one cleared, one new, dims shifted.
    insert into public.family_operating_index (family_id, as_of_date, composite, band, dimensions, suggestions)
    values (f.id, current_date, 77, 'steady', dims_t, sugg_t)
    on conflict (family_id, as_of_date) do update
      set composite = excluded.composite, band = excluded.band,
          dimensions = excluded.dimensions, suggestions = excluded.suggestions;
  end loop;

  raise notice 'Seeded 2 Operating Index snapshots (yesterday + today) for % families.', fams;
end $$;

-- VERIFY ----------------------------------------------------------------------
select
  count(*)                                        as rows_seeded,
  count(distinct family_id)                       as families,
  count(*) filter (where as_of_date = current_date)     as today_rows,
  count(*) filter (where as_of_date = current_date - 1) as yesterday_rows,
  round(avg(composite) filter (where as_of_date = current_date))     as avg_today,
  round(avg(composite) filter (where as_of_date = current_date - 1)) as avg_yesterday
from public.family_operating_index
where as_of_date in (current_date, current_date - 1);
