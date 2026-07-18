-- FamilyOS :: seed_behavior_logs.sql
-- LB-014 slice (agent-05, PLA-0803): `behavior_logs` (migration 0073) had ZERO
-- seed coverage anywhere (not in SEED_ALL, not in any seed_*.sql), so the Behavior
-- Tracking dashboard (/dashboard/behavior → behavior-module) renders EMPTY in a
-- fresh/demo environment — no balance score, trends, streaks, or AI tips. This
-- standalone, idempotent seed fills ~30 per-child observations across every kind
-- and category over the last ~90 days for each family that has children.
--
-- Standalone (NOT wired into SEED_ALL) to avoid colliding with the A-02/seed owner
-- mid-edit — ready to wire (mirrors the care_log / independence_milestones seed
-- style). Additive + idempotent (re-runnable): deletes its own '[seed]%' rows for
-- each family before inserting. Family-scoped; member_id is the child; logged_by is
-- a parent's auth.users id. Requires the household seed's kids to produce rows for
-- the anchor family (see supabase/seed_anchor_household.sql).

do $$
declare
  v_family   uuid;
  v_child    uuid;
  v_parent   uuid;
  g          int;
  v_kind     behavior_kind;
  v_cat      text;
  v_cats     text[] := array[
    'responsibility','kindness','focus','respect','honesty',
    'cooperation','mood','screen','homework','general'];
  v_pos      text[] := array[
    'Helped a sibling without being asked','Finished homework early',
    'Shared without being reminded','Owned up to a mistake honestly',
    'Great focus during reading time','Set the table on their own'];
  v_con      text[] := array[
    'Skipped assigned chores','Too much screen time before homework',
    'Struggled to stay on task','Talked back at bedtime',
    'Forgot to pack their school bag','Left a mess in shared space'];
begin
  if to_regclass('public.behavior_logs') is null then
    raise notice 'behavior_logs not present — apply migration 0073 first. Skipping.';
    return;
  end if;

  for v_family in select id from public.families loop
    -- Attribute each observation to a parent/adult (logged_by -> auth.users).
    select fm.user_id into v_parent
      from public.family_members fm
      where fm.family_id = v_family
        and fm.role in ('parent','adult')
        and fm.user_id is not null
      order by fm.created_at
      limit 1;

    -- Idempotent: clear this family's prior seed rows before reinserting.
    delete from public.behavior_logs
      where family_id = v_family and note like '[seed]%';

    for v_child in
      select id from public.family_members
      where family_id = v_family
        and role in ('child','teen')
        and is_active
      order by created_at
    loop
      for g in 0..29 loop
        v_kind := (case
          when g % 3 = 0 then 'concern'
          when g % 3 = 1 then 'neutral'
          else 'positive' end)::behavior_kind;
        v_cat := v_cats[1 + (g % array_length(v_cats, 1))];
        insert into public.behavior_logs
          (family_id, member_id, kind, category, note, points, occurred_at, logged_by)
        values (
          v_family,
          v_child,
          v_kind,
          v_cat,
          '[seed] ' || (case
            when v_kind = 'concern' then v_con[1 + (g % array_length(v_con, 1))]
            else v_pos[1 + (g % array_length(v_pos, 1))] end),
          (case v_kind
            when 'positive' then 1 + (g % 3)
            when 'concern'  then -(1 + (g % 2))
            else 0 end),
          now() - ((g * 3) || ' days')::interval - ((g % 6) || ' hours')::interval,
          v_parent
        );
      end loop;
    end loop;
  end loop;
end $$;
