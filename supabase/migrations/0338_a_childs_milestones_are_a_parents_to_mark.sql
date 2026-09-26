-- 0338_a_childs_milestones_are_a_parents_to_mark.sql
--
-- independence_milestones is the Independence Ladder: the responsibilities a
-- parent hands a child as they grow ("Makes their own lunch", "Walks to school
-- alone"), with each one moved in_progress -> achieved or skipped. 0175 created
-- it with plain family-membership policies for every command, so any member —
-- the child the ladder is ABOUT included — could mark their own milestones
-- achieved, skip the ones they did not like, delete a sibling's, or start
-- milestones on anyone's track. The actions in app/(app)/dashboard/independence
-- check no role either; every string the module shows is written from the
-- parent's side ("Added to Casey's ladder", "Casey achieved …").
--
-- The same shape this branch has closed for grades (0301), chores (0303), health
-- records (0307) and Guardian screening (0333): every member still READS the
-- ladder — a child seeing their own progress is the point of it — and only a
-- manager writes it. Applied in 0333's idiom: permissive mng_* policies, a
-- RESTRICTIVE guard per command so a later permissive policy cannot reopen it,
-- strays swept by shape, and an assertion that none remain.
--
-- Idempotent.

do $$
declare
  t         text;
  pol       record;
  swept     int := 0;
  remaining int;
  ladder text[] := array['independence_milestones'];
begin
  foreach t in array ladder loop
    if to_regclass('public.' || t) is null then continue; end if;

    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_mng_insert on public.%1$I', t);
    execute format('create policy %1$s_mng_insert on public.%1$I for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_mng_update on public.%1$I', t);
    execute format('create policy %1$s_mng_update on public.%1$I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_mng_delete on public.%1$I', t);
    execute format('create policy %1$s_mng_delete on public.%1$I for delete to authenticated using (public.can_manage_family(family_id))', t);

    execute format('drop policy if exists %1$s_manager_insert_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_insert_guard on public.%1$I as restrictive for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_manager_update_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_update_guard on public.%1$I as restrictive for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_manager_delete_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_delete_guard on public.%1$I as restrictive for delete to authenticated using (public.can_manage_family(family_id))', t);

    -- By SHAPE: every other permissive write policy goes, whatever it is called —
    -- including 0175's independence_milestones_insert/_update/_delete.
    for pol in
      select p.polname
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = t
        and p.polpermissive
        and p.polcmd in ('a','w','d','*')
        and p.polname not in (t || '_mng_insert', t || '_mng_update', t || '_mng_delete')
    loop
      execute format('drop policy if exists %I on public.%I', pol.polname, t);
      swept := swept + 1;
      raise notice '0338: dropped permissive write policy %.%', t, pol.polname;
    end loop;
  end loop;

  select count(*) into remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (ladder)
    and p.polpermissive
    and p.polcmd in ('a','w','d','*')
    and pg_get_expr(coalesce(p.polqual, p.polwithcheck), p.polrelid) !~ 'can_manage_family';
  if remaining <> 0 then
    raise exception '0338: % permissive write policy(ies) on independence_milestones still do not require a manager', remaining;
  end if;

  raise notice '0338: independence milestones are manager-written (% stray policy(ies) swept)', swept;
end $$;
