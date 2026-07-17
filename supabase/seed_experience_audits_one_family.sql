-- ============================================================================
-- seed_experience_audits_one_family.sql — ≥500 records to fully exercise T8
-- (the Experience Scorecard). Populates dated audits for ~30 surfaces across the
-- last ~68 days so the scorecard renders real grades, per-dimension health, and
-- an upward TREND (the premium-consistency sweep improving things over time),
-- with accessibility running weakest and a handful of surfaces still below the
-- premium bar (score < 70) so the "needs work" flags fire.
--
-- TARGET: The Kramer Family. IDEMPOTENT: seeded rows are tagged notes '[seed:t8]'
-- and deleted before re-insert (this family only). The unique(family_id,
-- surface_key, audited_on) index also makes dates collision-safe. Safe to re-run.
--
-- VOLUME: 30 surfaces × 18 audit dates = 540 rows.
--
-- HOW TO RUN: paste into the Supabase SQL editor, Run, then open
--   /dashboard/experience.
-- ============================================================================

do $$
declare
  v_fam uuid := coalesce((select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1),(select fm.family_id from public.family_members fm where fm.is_active and fm.role not in ('parent','adult') group by fm.family_id order by min(fm.created_at) limit 1),(select id from public.families order by created_at limit 1));  -- reproducible (was a hardcoded prod UUID)
  v_email text := 'newworldventurellc@gmail.com';
  v_uid   uuid;
begin
  if not exists (select 1 from public.families where id = v_fam) then
    raise exception 'Family % not found', v_fam;
  end if;
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;

  -- ── clean prior seed (this family only) ──────────────────────────────────
  delete from public.experience_audits where family_id = v_fam and notes = '[seed:t8]';

  insert into public.experience_audits
    (family_id, surface_key, surface_label, category, audited_on,
     empty_state, error_recovery, transitions, performance, accessibility, consistency,
     score, grade, notes, created_by)
  select
    v_fam, s.key, s.label, s.cat,
    (current_date - (d.d * 4)),
    dims.es, dims.er, dims.tr, dims.pe, dims.ac, dims.co,
    sc.score,
    case when sc.score >= 90 then 'A' when sc.score >= 80 then 'B'
         when sc.score >= 70 then 'C' when sc.score >= 60 then 'D' else 'F' end,
    '[seed:t8]', v_uid
  from (
    values
      ('home',            'Home',               'module',  86),
      ('calendar',        'Calendar',           'module',  80),
      ('tasks',           'Tasks',              'module',  82),
      ('meals',           'Meals',              'module',  74),
      ('grocery',         'Grocery',            'module',  72),
      ('finances',        'Finances',           'module',  70),
      ('documents',       'Documents',          'module',  76),
      ('reminders',       'Reminders',          'module',  78),
      ('voting',          'Group Voting',       'module',  84),
      ('decisions',       'Decision Engine',    'module',  81),
      ('autopilot',       'Autopilot',          'module',  83),
      ('agents',          'Agents',             'module',  79),
      ('memories',        'Memories',           'module',  75),
      ('messages',        'Messages',           'module',  54),
      ('homework',        'Homework',           'module',  58),
      ('medications',     'Medications',        'module',  71),
      ('appointments',    'Appointments',       'module',  73),
      ('chores',          'Chores',             'module',  77),
      ('renewals',        'Renewals',           'module',  69),
      ('conflicts',       'Conflicts',          'module',  72),
      ('playbook',        'Family Playbook',    'module',  85),
      ('calm',            'Calm Inbox',         'module',  80),
      ('connections',     'Connections',        'module',  52),
      ('wallet',          'Wallet',             'module',  57),
      ('operating-index', 'Operating Index',    'module',  82),
      ('briefing',        'Daily Briefing',     'module',  81),
      ('capture',         'Capture a thought',  'journey', 88),
      ('onboarding',      'Onboarding',         'journey', 76),
      ('plan-dinner',     'Plan tonight''s dinner', 'journey', 70),
      ('add-memory',      'Add a memory',       'journey', 79)
  ) as s(key, label, cat, base)
  cross join generate_series(0, 17) as d(d)
  cross join lateral (
    -- Older audits (larger d) score lower → an upward trend to today. Each
    -- dimension gets a fixed offset; accessibility trails (the weakest area).
    select
      least(99, greatest(40, (s.base + (17 - d.d) * 0.6 + 4)))::int as es,
      least(99, greatest(40, (s.base + (17 - d.d) * 0.6 + 0)))::int as er,
      least(99, greatest(40, (s.base + (17 - d.d) * 0.6 + 2)))::int as tr,
      least(99, greatest(40, (s.base + (17 - d.d) * 0.6 - 3)))::int as pe,
      least(99, greatest(40, (s.base + (17 - d.d) * 0.6 - 6)))::int as ac,
      least(99, greatest(40, (s.base + (17 - d.d) * 0.6 + 3)))::int as co
  ) dims
  cross join lateral (
    -- Weighted composite matching lib/experience/scorecard.ts (weights sum 6.2).
    select round((dims.es*1.0 + dims.er*1.2 + dims.tr*1.0 + dims.pe*1.0 + dims.ac*1.1 + dims.co*0.9) / 6.2)::int as score
  ) sc;

  raise notice 'T8 experience-audits seed complete for family % (540 rows / 30 surfaces × 18 dates).', v_fam;
end $$;

-- ── Verify: total + latest-per-surface grade distribution ───────────────────
select 'total rows' as metric, count(*)::text as value
  from public.experience_audits where family_id = (select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1) and notes = '[seed:t8]'
union all
select 'surfaces', count(distinct surface_key)::text
  from public.experience_audits where family_id = (select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1) and notes = '[seed:t8]'
union all
select 'latest below bar (<70)', count(*)::text from (
  select distinct on (surface_key) surface_key, score
  from public.experience_audits
  where family_id = (select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1) and notes = '[seed:t8]'
  order by surface_key, audited_on desc
) latest where score < 70;
