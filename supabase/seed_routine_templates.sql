-- ============================================================================
-- Bubaly · SEED — Routine templates + items (60 templates × 9 items = 540 rows).
-- Fills routine_templates + routine_template_items so the calendar Routines panel
-- (components/modules/routines-panel.tsx) renders populated in a fresh env — the
-- table ships in 0122 but had NO seed anywhere (LB-014). 60 realistic routines
-- (Morning/Bedtime/After-School/Homework/Weekend…) each with 9 timed steps,
-- assigned to the family's members. Idempotent: template names are prefixed
-- '[seed] ' and cleared first (items cascade). Resolves the family by the anchored
-- account email. Standalone (LB-014 owner wires it into SEED_ALL). Needs 0122.
-- ============================================================================
do $$
declare
  v_email    text := 'newworldventurellc@gmail.com';
  v_family   uuid;
  v_user     uuid;
  v_members  uuid[];
  v_mcount   int;

  routines   text[] := array[
    'Morning Routine','Bedtime Routine','After-School Routine','Homework Time',
    'Weekend Chores','Get Ready for School','Screen-Time Wind-Down','Saturday Reset',
    'Sunday Prep','Sports Practice Prep','Reading Time','Tidy-Up Time'];
  icons      text[] := array['🌅','🌙','🎒','📚','🧹','👟','📵','🧺','🗓️','⚽','📖','🧸'];
  colors     text[] := array['violet','blue','amber','emerald','rose','cyan','indigo','lime'];
  -- weekday_mask: 31 = Mon–Fri, 96 = Sat+Sun, 127 = every day
  masks      int[]  := array[31,31,31,31,96,31,127,96,64,31,127,96];

  steps      text[] := array[
    'Wake up','Make the bed','Brush teeth','Get dressed','Eat breakfast','Pack backpack',
    'Homework','Read for 20 min','Tidy room','Lay out clothes','Shower','Lights out'];
  cats       text[] := array[
    'general','general','general','general','general','school',
    'school','general','maintenance','general','general','general']::text[];

  n_tpl      int := 60;
  n_item     int := 9;
  t          int;
  s          int;
  v_tpl      uuid;
  v_member   uuid;
  v_idx      int;
  total_tpl  int := 0;
  total_item int := 0;
begin
  if to_regclass('public.routine_templates') is null or to_regclass('public.routine_template_items') is null then
    raise notice 'routine_templates not present — apply migration 0122 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then
    raise notice 'No family found for % — skipping.', v_email;
    return;
  end if;

  select fm.user_id into v_user from public.family_members fm
  where fm.family_id = v_family and fm.user_id is not null limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  v_mcount := coalesce(array_length(v_members,1), 0);

  -- Idempotent: clearing the seed templates cascades to their items (0122 FK).
  delete from public.routine_templates where family_id = v_family and name like '[seed]%';

  for t in 0..(n_tpl - 1) loop
    v_idx := (t % array_length(routines,1)) + 1;
    insert into public.routine_templates
      (family_id, name, icon, color, weekday_mask, is_active, source, created_by)
    values (
      v_family,
      '[seed] ' || routines[v_idx] || ' ' || (t / array_length(routines,1) + 1),
      icons[v_idx],
      colors[(t % array_length(colors,1)) + 1],
      masks[v_idx],
      (t % 7 <> 0),                                   -- ~1 in 7 inactive
      case when t % 3 = 0 then 'detected' else 'manual' end,
      v_user)
    returning id into v_tpl;
    total_tpl := total_tpl + 1;

    for s in 0..(n_item - 1) loop
      v_member := case when v_mcount > 0 then v_members[((t + s) % v_mcount) + 1] else null end;
      insert into public.routine_template_items
        (template_id, family_id, title, category, start_minutes, duration_minutes, assignee_id, sort_order)
      values (
        v_tpl, v_family,
        steps[(s % array_length(steps,1)) + 1],
        cats[(s % array_length(cats,1)) + 1]::public.event_category,
        (6 * 60) + s * 20,                            -- from 06:00, 20-min slots
        least(20 + (s % 3) * 10, 60),
        v_member, s);
      total_item := total_item + 1;
    end loop;
  end loop;

  raise notice 'seed_routine_templates: % templates + % items for family %', total_tpl, total_item, v_family;
end $$;
