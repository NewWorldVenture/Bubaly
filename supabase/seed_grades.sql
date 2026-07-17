-- ============================================================================
-- FamilyOS · SEED — Student grades (~528 records).
-- Fills `grades` so the Grades section of /dashboard/family-school renders
-- populated — the table ships in 0006 but had NO seed anywhere (LB-014). Seeds
-- realistic gradebook rows for the family's kids: each child × 8 subjects × ~22
-- assignments across every grade_type, scores 62–100 with a matching letter, and
-- `date` spread across the past school year. Depends on the family having child /
-- teen members — run `seed_anchor_household.sql` first (LB-014 root-cause fix).
-- Idempotent: rows are tagged with a '[seed] ' title prefix and cleared first
-- (grades is a leaf table — safe to delete). Resolves the family by the anchored
-- account email. Standalone (LB-014 owner wires it into SEED_ALL). Needs 0006.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_kids    uuid[];
  v_kcount  int;

  subjects  text[] := array['Math','Science','English','History','Art','P.E.','Music','Spanish'];
  gtypes    text[] := array['test','quiz','homework','project','final','participation','other'];
  n_each    int := 22;                       -- assignments per kid per subject

  k         int;
  sj        int;
  a         int;
  v_kid     uuid;
  v_score   numeric(5,2);
  v_grade   text;
  v_date    date;
  total     int := 0;
begin
  if to_regclass('public.grades') is null then
    raise notice 'grades table not present — apply migration 0006 first. Skipping.';
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

  select array_agg(id) into v_kids from public.family_members
  where family_id = v_family and coalesce(role::text,'') in ('child','teen');
  if v_kids is null or array_length(v_kids,1) is null then
    raise notice 'grades seed: no child/teen members for family % — run seed_anchor_household.sql first. Skipping.', v_family;
    return;
  end if;
  v_kcount := array_length(v_kids,1);

  delete from public.grades where family_id = v_family and title like '[seed]%';

  for k in 1 .. v_kcount loop
    v_kid := v_kids[k];
    for sj in 1 .. array_length(subjects,1) loop
      for a in 0 .. (n_each - 1) loop
        -- Deterministic-but-varied score in 62..100.
        v_score := 62 + ((k * 7 + sj * 13 + a * 5) % 39);
        v_grade := case
          when v_score >= 93 then 'A'  when v_score >= 90 then 'A-'
          when v_score >= 87 then 'B+' when v_score >= 83 then 'B'
          when v_score >= 80 then 'B-' when v_score >= 77 then 'C+'
          when v_score >= 73 then 'C'  when v_score >= 70 then 'C-'
          when v_score >= 65 then 'D'  else 'F' end;
        -- Spread across the past ~200 school days.
        v_date := current_date - ((a * 200 / n_each) || ' days')::interval;

        insert into public.grades
          (family_id, member_id, class_id, subject, title, grade, grade_type, score, max_score, date, created_by)
        values (
          v_family, v_kid, null,
          subjects[sj],
          '[seed] ' || subjects[sj] || ' ' || initcap(gtypes[(a % array_length(gtypes,1)) + 1]) || ' #' || (a + 1),
          v_grade,
          gtypes[(a % array_length(gtypes,1)) + 1]::grade_type,
          v_score, 100, v_date, v_user);
        total := total + 1;
      end loop;
    end loop;
  end loop;

  raise notice 'seed_grades: % grade rows across % kids × % subjects for family %', total, v_kcount, array_length(subjects,1), v_family;
end $$;
