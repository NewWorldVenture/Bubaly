-- ============================================================================
-- Bubaly · SEED — Independence milestones (500 records).
-- Fills independence_milestones so the growth-ladder module can be tested at
-- volume: every domain × age band across the family's kids (falls back to any
-- members if no child/teen), realistic status mix (achieved with evidence +
-- dates, in_progress, suggested, skipped). Unique (family,member,domain,title)
-- is satisfied by suffixing generated titles.
-- Idempotent: clears its own '[seed:indep]' rows first. Resolves family by email.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0175 applied.)
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_kids    uuid[];
  v_user    uuid;
  k_count   int;
  n int := 500;
  domains  text[] := array['chores','money','safety','self_care','school','social'];
  bands    text[] := array['4-6','7-9','10-12','13-15','16-18'];
  titles   text[] := array[
    'Makes their bed daily','Helps with dishes','Saves for a goal','Sticks to a small budget',
    'Crosses the street safely','Basic first aid','Showers independently','Packs for a trip',
    'Tracks assignments','Emails a teacher','Orders their own food','Handles losing a game'];
  statuses text[] := array['achieved','achieved','achieved','in_progress','in_progress','suggested','skipped'];
  evid     text[] := array[
    'Did it every day for two weeks','Showed us without being asked','Teacher confirmed it',
    'Nailed it on the family trip','Handled it solo while we watched from afar'];
  st text; di int; bi int;
begin
  if to_regclass('public.independence_milestones') is null then
    raise notice 'independence_milestones not present — apply migration 0175 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select array_agg(id) into v_kids from (
    select id from public.family_members
    where family_id = v_family and is_active and role in ('child','teen')
    order by created_at limit 6
  ) s;
  if v_kids is null then
    select array_agg(id) into v_kids from (
      select id from public.family_members where family_id = v_family and is_active
      order by created_at limit 6
    ) s;
  end if;
  k_count := coalesce(array_length(v_kids, 1), 0);
  if k_count = 0 then raise exception 'No members in family %.', v_family; end if;

  select user_id into v_user from public.family_members
  where family_id = v_family and user_id is not null order by created_at limit 1;

  delete from public.independence_milestones
  where family_id = v_family and description like '%[seed:indep]%';

  insert into public.independence_milestones
    (family_id, member_id, domain, title, description, age_band, status,
     points, evidence, achieved_at, created_by, created_at)
  select
    v_family,
    v_kids[1 + (g.i % k_count)],
    domains[1 + (g.i % 6)],
    titles[1 + (g.i % array_length(titles, 1))] || ' #' || (g.i / array_length(titles, 1))::text,
    'Ladder skill for growing independence. [seed:indep]',
    bands[1 + (g.i % 5)],
    statuses[1 + (g.i % array_length(statuses, 1))],
    5 + 5 * (g.i % 5),
    case when statuses[1 + (g.i % array_length(statuses, 1))] = 'achieved'
         then evid[1 + (g.i % array_length(evid, 1))] else null end,
    case when statuses[1 + (g.i % array_length(statuses, 1))] = 'achieved'
         then now() - ((g.i % 365) || ' days')::interval else null end,
    v_user,
    now() - (g.i || ' hours')::interval
  from generate_series(0, n - 1) g(i)
  on conflict (family_id, member_id, domain, title) do nothing;

  raise notice 'Independence milestones seeded % rows across % kids for family %', n, k_count, v_family;
end $$;

-- Verify:
--   select count(*) from independence_milestones where description like '%[seed:indep]%';  -- 500
--   select status, count(*) from independence_milestones group by status order by 2 desc;
--   select domain, age_band, count(*) from independence_milestones group by 1,2 order by 1,2;
