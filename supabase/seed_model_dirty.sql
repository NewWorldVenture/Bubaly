-- ============================================================================
-- Bubaly · SEED — Auto-refresh / model-dirty (R3)  [seed:dirty]
-- Exercises the R3 chain end to end: inserting into a WATCHED source table fires
-- the 0134 `trg_mark_model_dirty` trigger → the family is marked dirty → the next
-- time any graph surface loads (loadFamilyGraph), scheduleGraphAutoRefresh
-- re-projects the twin in the background → these rows become graph place-nodes.
--
-- We seed `family_places` (both watched by 0134 AND read by the twin projector),
-- so after one graph-surface visit the graph gains 500 place entities — no manual
-- "Rebuild". Volume: 500 rows.
-- Idempotent: clears its own '[seed:dirty]' rows first (naming convention).
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migrations 0042 + 0134.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  icons text[] := array['home','school','work','gym','other'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  -- Clear prior seed (this DELETE also fires the dirty trigger — fine).
  delete from public.family_places where family_id = v_family and name like 'Seed Place #%';

  -- 500 places. Each INSERT fires trg_mark_model_dirty → the family is marked
  -- dirty. Coordinates are spread deterministically around a base point.
  insert into public.family_places (family_id, name, icon, address, latitude, longitude, radius_m)
  select
    v_family,
    'Seed Place #' || g.i,
    icons[1 + (g.i % array_length(icons,1))],
    g.i || ' Test Street',
    37.7749 + ((g.i % 100) - 50) * 0.001,     -- ~±0.05° lat
    -122.4194 + ((g.i % 80) - 40) * 0.001,    -- ~±0.04° lng
    100 + (g.i % 8) * 25
  from generate_series(1, n) as g(i);

  -- Belt-and-suspenders: ensure the dirty flag is set even if the trigger list
  -- differs in this environment.
  insert into public.family_model_dirty (family_id, dirty, reason, marked_at)
  values (v_family, true, 'seed:family_places', now())
  on conflict (family_id) do update set dirty = true, reason = excluded.reason, marked_at = now();

  raise notice 'Seeded % family_places for family % and marked it dirty. Open any graph surface to auto-project.', n, v_family;
end $$;

-- Verify:
--   select dirty, reason, refreshed_at from family_model_dirty where family_id = <fam>;  -- dirty=true
--   -- then open /dashboard/graph (or any R2 surface) once, wait a moment, re-check:
--   select dirty, refreshed_at from family_model_dirty where family_id = <fam>;          -- dirty=false
--   select count(*) from graph_entities where family_id = <fam> and ref_table='family_places'; -- ~500
