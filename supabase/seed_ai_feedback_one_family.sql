-- ============================================================================
-- seed_ai_feedback_one_family.sql — ≥500 records to fully exercise T7
-- ("Why this?" everywhere). Populates the ai_feedback learning log with a
-- realistic spread of family responses to AI recommendations across every
-- surface (insight / autopilot / agent / voting / decision / briefing) and every
-- signal (helpful / not_helpful / dismissed / undo / adjusted), attributed to
-- real family members over the last ~60 days.
--
-- TARGET: The Kramer Family. IDEMPOTENT: every seeded row has ref_id prefixed
-- 'seed-t7-'; those are deleted before re-insert (this family only). Safe to
-- re-run. Scoped to this family only.
--
-- VOLUME: 600 rows (generate_series 1..600).
--
-- HOW TO RUN: paste into the Supabase SQL editor, Run. The feedback surfaces
-- via the "Why this?" affordance on Home, /dashboard/autopilot, /dashboard/agents
-- and /dashboard/voting; this backfills the log the model-refresh can learn from.
-- ============================================================================

do $$
declare
  v_fam     uuid := '92298eb2-1a9e-4bdc-9361-677b6c01b499';
  v_email   text := 'newworldventurellc@gmail.com';
  v_uid     uuid;
  v_members uuid[];
  v_mcount  int;
begin
  if not exists (select 1 from public.families where id = v_fam) then
    raise exception 'Family % not found', v_fam;
  end if;
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_fam and is_active;
  v_mcount := coalesce(array_length(v_members, 1), 0);

  -- ── clean prior seed (this family only) ──────────────────────────────────
  delete from public.ai_feedback where family_id = v_fam and ref_id like 'seed-t7-%';

  insert into public.ai_feedback
    (family_id, member_id, surface, ref_kind, ref_id, signal, reason, note, created_by, created_at)
  select
    v_fam,
    case when v_mcount > 0 then v_members[1 + (g % v_mcount)] else null end,
    surf,
    rkind,
    'seed-t7-' || surf || '-' || g,
    sig,
    reason_txt,
    case when sig = 'adjusted' then 'Tweaked the suggestion to fit us better.' else null end,
    v_uid,
    now() - make_interval(days => (g % 60), mins => (g * 7) % 1440)
  from generate_series(1, 600) g
  cross join lateral (
    select
      (array['insight','autopilot','agent','voting','decision','briefing'])[1 + (g % 6)]              as surf,
      (array['conflict','groceries','scheduler','meal','vacation','morning'])[1 + (g % 6)]            as rkind,
      -- weighted toward 'helpful' (the common case), with a real tail of the rest
      (array['helpful','helpful','helpful','not_helpful','dismissed','undo','adjusted'])[1 + (g % 7)] as sig,
      (array[
        'Surfaced as the most time-sensitive item today.',
        'High confidence from your grocery list.',
        'Balances the vote with your budget and dietary needs.',
        'Flagged while watching your calendar.',
        'Recommended because it best fits budget + availability.',
        'Part of your morning briefing recap.'
      ])[1 + (g % 6)]                                                                                  as reason_txt
  ) picks;

  raise notice 'T7 ai_feedback seed complete for family % (600 rows).', v_fam;
end $$;

-- ── Verify: counts by surface + by signal ───────────────────────────────────
select 'by surface' as grouping, surface as bucket, count(*)
  from public.ai_feedback
  where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and ref_id like 'seed-t7-%'
  group by surface
union all
select 'by signal', signal, count(*)
  from public.ai_feedback
  where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and ref_id like 'seed-t7-%'
  group by signal
union all
select 'TOTAL', '—', count(*)
  from public.ai_feedback
  where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and ref_id like 'seed-t7-%'
order by grouping, bucket;
