-- ============================================================================
-- Bubaly · SEED — Reasoning snapshots (500 records).
-- Fills reasoning_snapshots so the unified Family Reasoning Engine (R7) can be
-- tested at volume and its day-over-day trend renders: 500 distinct days, each a
-- compact six-question report with a varying all-clear / attention mix. Idempotent
-- via report->>'seed' = 'true'; resolves the family by email. (Needs migration
-- 0149 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_user   uuid;
  n int := 500;
  -- The six questions the engine answers, in canonical order.
  qids      text[] := array['matters_most','forgotten','decide_next','auto_complete','who_needs_help','what_next'];
  qtext     text[] := array[
    'What matters most right now?','What''s likely being forgotten?','What should we decide next?',
    'What can Bubaly just handle?','Who needs help this week?','What''s the next best move?'];
begin
  if to_regclass('public.reasoning_snapshots') is null then
    raise notice 'reasoning_snapshots not present — apply migration 0149 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select fm.user_id into v_user from public.family_members fm
  where fm.family_id = v_family and fm.user_id is not null limit 1;

  delete from public.reasoning_snapshots where family_id = v_family and (report->>'seed') = 'true';

  -- One snapshot per distinct day, 500 days back. attention_count cycles 0..3 so
  -- the trend shows a realistic mix of calm and busy weeks; the report mirrors the
  -- shape lib/reasoning/engine.ts#reasoningSummary persists.
  insert into public.reasoning_snapshots
    (family_id, as_of_date, all_clear, attention_count, report, created_by, created_at)
  select
    v_family,
    (current_date - g.i),
    (g.i % 4) = 0,                       -- ~1 in 4 days fully clear
    (g.i % 4),                           -- 0..3 areas needing attention
    jsonb_build_object(
      'seed', true,
      'allClear', (g.i % 4) = 0,
      'answers', (
        select jsonb_agg(
          jsonb_build_object(
            'id', qids[q],
            'question', qtext[q],
            'status', case when q <= (g.i % 4) then 'attention' else 'clear' end,
            'headline', case when q <= (g.i % 4)
              then 'Needs a look this week.' else 'Nothing pressing here.' end,
            'count', case when q <= (g.i % 4) then 1 + (g.i % 3) else 0 end
          ) order by q
        )
        from generate_series(1, 6) q
      )
    ),
    v_user,
    now() - ((g.i) || ' days')::interval
  from generate_series(0, n - 1) g(i)
  on conflict (family_id, as_of_date) do nothing;

  raise notice 'Reasoning snapshots seeded 500 rows for family %', v_family;
end $$;

-- Verify:
--   select count(*) from reasoning_snapshots where (report->>'seed') = 'true';  -- 500
--   select all_clear, count(*) from reasoning_snapshots group by all_clear;
--   select as_of_date, attention_count from reasoning_snapshots order by as_of_date desc limit 10;
