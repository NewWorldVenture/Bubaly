-- ============================================================================
-- Bubaly · SEED — Workload snapshots (500 records).
-- Fills workload_snapshots so Workload Balance analytics can be tested at
-- volume: up to 5 members × 100 ISO weeks of history, with a realistic drift
-- (one member consistently heavier, slowly rebalancing toward fair).
-- Idempotent: upserts on (family_id, member_id, week_start) with note tag
-- '[seed:workload]' and clears its own rows first. Resolves family by email.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0174 applied.)
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  m_count   int;
  n_weeks   int;
  total     int := 0;
  w         int;
  mi        int;
  base_pct  numeric;
  drift     numeric;
  pct       numeric;
  mins      int;
begin
  if to_regclass('public.workload_snapshots') is null then
    raise notice 'workload_snapshots not present — apply migration 0174 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select array_agg(id) into v_members from (
    select id from public.family_members where family_id = v_family and is_active
    order by created_at limit 5
  ) s;
  m_count := coalesce(array_length(v_members, 1), 0);
  if m_count = 0 then raise exception 'No members in family %.', v_family; end if;

  n_weeks := ceil(500.0 / m_count)::int;   -- e.g. 5 members → 100 weeks

  delete from public.workload_snapshots where family_id = v_family and note = '[seed:workload]';

  for w in 0..(n_weeks - 1) loop
    for mi in 1..m_count loop
      exit when total >= 500;
      -- Member 1 starts heavy (~55%) and drifts toward fair; others share the rest.
      drift := least(w * 0.15, 15);   -- older weeks were more unbalanced
      if mi = 1 then
        base_pct := (100.0 / m_count) + 20 - drift;
      else
        base_pct := (100.0 - ((100.0 / m_count) + 20 - drift)) / (m_count - 1);
      end if;
      pct := greatest(2, round(base_pct + ((w * mi) % 5) - 2, 1));
      mins := (pct * 6)::int + ((w + mi) % 30);

      insert into public.workload_snapshots
        (family_id, member_id, week_start,
         chore_minutes, chore_count, task_count, event_count, invisible_count,
         load_score, share_pct, note, created_at)
      values (
        v_family, v_members[mi],
        (date_trunc('week', current_date)::date - (w * 7)),
        mins, 2 + ((w + mi) % 8), (w + mi) % 6, (w * mi) % 5, (w + mi) % 4,
        least(100, (pct * 1.6)::int), least(100, pct), '[seed:workload]',
        now() - (w || ' weeks')::interval
      )
      on conflict (family_id, member_id, week_start) do update set
        chore_minutes = excluded.chore_minutes,
        share_pct     = excluded.share_pct,
        load_score    = excluded.load_score,
        note          = excluded.note;
      total := total + 1;
    end loop;
  end loop;

  raise notice 'Workload snapshots seeded % rows (% members × % weeks) for family %',
    total, m_count, n_weeks, v_family;
end $$;

-- Verify:
--   select count(*) from workload_snapshots where note = '[seed:workload]';   -- 500
--   select member_id, round(avg(share_pct),1) from workload_snapshots group by member_id;
