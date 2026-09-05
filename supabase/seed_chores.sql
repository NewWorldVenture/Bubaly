-- ============================================================================
-- Bubaly · SEED — Chores (chores 500 + chore_assignments 500).
-- 500 chores across priorities/recurrence + one assignment each spanning the
-- full task_status lifecycle. Idempotent via a '[seed:chore]' description marker
-- (assignments cascade-cleared by chore_id).
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  n int := 500;
  titles text[] := array['Take out trash','Load dishwasher','Walk the dog','Make bed','Vacuum living room',
                         'Fold laundry','Wipe counters','Water plants','Feed the cat','Tidy playroom',
                         'Sweep kitchen','Clean bathroom','Set the table','Empty recycling','Rake leaves'];
  prios     text[] := array['low','medium','high'];
  recurs    text[] := array['none','daily','weekly','monthly'];
  statuses  text[] := array['todo','in_progress','submitted','approved','done','rejected'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  if v_members is null then raise exception 'Family has no members (needed for chore assignments).'; end if;

  delete from public.chore_assignments a using public.chores c
    where a.chore_id = c.id and c.family_id = v_family and c.description like '%[seed:chore]%';
  delete from public.chores where family_id = v_family and description like '%[seed:chore]%';

  with new_chores as (
    insert into public.chores (family_id, title, description, points, priority, recurrence, due_at, requires_approval, is_active)
    select
      v_family,
      titles[1 + (g.i % array_length(titles,1))] || ' #' || g.i,
      '[seed:chore]',
      5 + (g.i % 20),
      prios[1 + (g.i % array_length(prios,1))]::priority,
      recurs[1 + (g.i % array_length(recurs,1))]::recurrence_freq,
      now() + ((g.i % 14) || ' days')::interval,
      (g.i % 5 = 0),
      true
    from generate_series(1, n) as g(i)
    returning id
  ), numbered as (
    select id, row_number() over () as rn from new_chores
  )
  insert into public.chore_assignments (family_id, chore_id, member_id, status, due_at, points_awarded)
  select
    v_family, nc.id,
    v_members[1 + (nc.rn::int % array_length(v_members,1))],
    statuses[1 + (nc.rn::int % array_length(statuses,1))]::task_status,
    now() + ((nc.rn % 14) || ' days')::interval,
    case when statuses[1 + (nc.rn::int % array_length(statuses,1))] in ('approved','done') then 10 else 0 end
  from numbered nc;

  raise notice 'Chores + assignments seeded % rows each for family %', n, v_family;
end $$;
