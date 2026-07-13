-- ============================================================================
-- FamilyOS | SEED | Production-readiness dataset (600 realistic records)
--
-- Purpose: exercise the independence ladder with enough persisted data to
-- validate filtering, aggregation, pagination, empty/loading/error recovery,
-- and mobile rendering at realistic volume.
--
-- Safety: idempotent upsert on the table's natural key; never clears a table,
-- never writes auth.users, and never overwrites a non-seed row on conflict.
-- Requires migration 0175_independence_milestones.sql.
-- ============================================================================

do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  v_user    uuid;
  m_count   integer;
  domains   text[] := array['chores','money','safety','self_care','school','social'];
  bands     text[] := array['4-6','7-9','10-12','13-15','16-18'];
  statuses  text[] := array['suggested','in_progress','achieved','achieved','skipped'];
  titles    text[] := array[
    'Plans a balanced breakfast',
    'Sorts laundry by color',
    'Checks a smoke detector',
    'Packs a school bag independently',
    'Tracks a savings goal',
    'Uses a calm conflict reset',
    'Prepares a simple snack',
    'Keeps a shared space tidy',
    'Knows a trusted emergency contact',
    'Follows a morning routine',
    'Compares prices before buying',
    'Invites someone into a game'
  ];
  evidence_examples text[] := array[
    'Completed independently for two weeks',
    'Explained the steps to another family member',
    'Handled the task calmly without a reminder',
    'Practiced successfully during a real family routine',
    'Showed the skill three times in one week'
  ];
begin
  if to_regclass('public.independence_milestones') is null then
    raise notice 'independence_milestones is not present; apply migration 0175 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email)
  limit 1;

  if v_family is null then
    select id into v_family from public.families order by created_at limit 1;
  end if;
  if v_family is null then
    raise exception 'No family exists for production-readiness seed.';
  end if;

  select array_agg(id order by created_at) into v_members
  from (
    select id, created_at
    from public.family_members
    where family_id = v_family and is_active and role in ('child','teen')
    order by created_at
    limit 6
  ) selected_members;

  if v_members is null then
    select array_agg(id order by created_at) into v_members
    from (
      select id, created_at
      from public.family_members
      where family_id = v_family and is_active
      order by created_at
      limit 6
    ) selected_members;
  end if;

  m_count := coalesce(array_length(v_members, 1), 0);
  if m_count = 0 then
    raise exception 'No active family members for family %.', v_family;
  end if;

  select user_id into v_user
  from public.family_members
  where family_id = v_family and user_id is not null
  order by created_at
  limit 1;

  insert into public.independence_milestones as target
    (family_id, member_id, domain, title, description, age_band, status,
     points, evidence, achieved_at, created_by, created_at, updated_at)
  select
    v_family,
    v_members[1 + (g.i % m_count)],
    domains[1 + (g.i % array_length(domains, 1))],
    titles[1 + (g.i % array_length(titles, 1))] || ' #' || lpad((g.i + 1)::text, 4, '0'),
    '[seed:production-readiness] Realistic ladder record for volume and workflow validation.',
    bands[1 + (g.i % array_length(bands, 1))],
    statuses[1 + (g.i % array_length(statuses, 1))],
    5 + ((g.i * 3) % 46),
    case when statuses[1 + (g.i % array_length(statuses, 1))] = 'achieved'
      then evidence_examples[1 + (g.i % array_length(evidence_examples, 1))]
      else null end,
    case when statuses[1 + (g.i % array_length(statuses, 1))] = 'achieved'
      then now() - ((g.i % 365) || ' days')::interval
      else null end,
    v_user,
    now() - ((g.i % 540) || ' days')::interval,
    now()
  from generate_series(0, 599) as g(i)
  on conflict (family_id, member_id, domain, title) do update set
    description = excluded.description,
    age_band = excluded.age_band,
    status = excluded.status,
    points = excluded.points,
    evidence = excluded.evidence,
    achieved_at = excluded.achieved_at,
    updated_at = now()
  where target.description like '[seed:production-readiness]%';

  raise notice 'Production-readiness seed upserted 600 independence records for family %.', v_family;
end $$;

-- Verify:
-- select count(*) from public.independence_milestones
-- where description like '[seed:production-readiness]%';
-- select status, count(*) from public.independence_milestones
-- where description like '[seed:production-readiness]%'
-- group by status order by status;
