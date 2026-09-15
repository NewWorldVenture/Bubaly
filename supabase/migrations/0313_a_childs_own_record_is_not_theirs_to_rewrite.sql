-- Bubaly :: 0313 - the two records a child has the most motive to edit
-- ----------------------------------------------------------------------------
-- Renumbered from 0301. A parallel session landed
-- `0301_notification_authorship.sql` on main for a different finding while this
-- was in flight — the SIXTH migration-number collision between the two
-- sessions, and the second in a single afternoon (0300 was the fifth). Only the
-- number changed; this touches `grades` and `screen_time_limits`, which nothing
-- between 0302 and 0312 goes near.
-- ----------------------------------------------------------------------------
-- `screen_time_limits` and `grades` each carry ONE `FOR ALL … is_family_member`
-- policy, and both are written directly from the browser through the anon
-- client. Neither module has a role gate of any kind — grep for isManager or
-- canEdit in screen-time-module.tsx and school-module.tsx returns nothing — so
-- the UI is not even claiming a boundary the database fails to keep. There
-- simply is none.
--
-- Proven on a full migration replay as a real child session:
--     update grades set grade='A', score=98;              -> UPDATE 1  (was D/55)
--     update screen_time_limits set daily_minutes=1440;   -> UPDATE 1  (was 60)
--
-- The two are NOT the same problem, and are not given the same fix.
--
-- SCREEN TIME LIMITS are unambiguous. A limit is set ON a child BY a parent;
-- there is no reading in which the child raising their own is the product
-- working. Writes become can_manage_family. Reads stay family-wide — a child
-- seeing their own limit is the whole point of showing it.
--
-- GRADES are not. A teen entering "I got a B on the chemistry test" is a
-- plausible use of a family school tracker, and making INSERT manager-only
-- would remove that. What is NOT plausible is a child rewriting a grade their
-- parent recorded. So:
--
--   INSERT           stays open to any member (is_family_member)
--   UPDATE / DELETE  only the row's OWN author, or a manager
--
-- `grades.created_by` makes that expressible. A teen can add and correct their
-- own entry; nobody can silently rewrite somebody else's. This is narrower than
-- manager-only and closes the actual abuse, which is the standard the rest of
-- this sweep has held to: fix what is defective, and do not quietly remove a
-- feature while doing it.
--
-- A RESTRICTIVE guard backs each rule, as 0254 does for the wallet ledger: a
-- stray permissive policy re-added later cannot reopen the boundary on its own.

do $$
declare
  pol       record;
  swept     int := 0;
  remaining int;
begin
  -- ── screen_time_limits: a parental control ───────────────────────────────
  if to_regclass('public.screen_time_limits') is not null then
    alter table public.screen_time_limits enable row level security;

    drop policy if exists screen_time_limits_select on public.screen_time_limits;
    create policy screen_time_limits_select on public.screen_time_limits
      for select to authenticated using (public.is_family_member(family_id));
    drop policy if exists screen_time_limits_mng_insert on public.screen_time_limits;
    create policy screen_time_limits_mng_insert on public.screen_time_limits
      for insert to authenticated with check (public.can_manage_family(family_id));
    drop policy if exists screen_time_limits_mng_update on public.screen_time_limits;
    create policy screen_time_limits_mng_update on public.screen_time_limits
      for update to authenticated using (public.can_manage_family(family_id))
      with check (public.can_manage_family(family_id));
    drop policy if exists screen_time_limits_mng_delete on public.screen_time_limits;
    create policy screen_time_limits_mng_delete on public.screen_time_limits
      for delete to authenticated using (public.can_manage_family(family_id));

    drop policy if exists screen_time_limits_manager_insert_guard on public.screen_time_limits;
    create policy screen_time_limits_manager_insert_guard on public.screen_time_limits
      as restrictive for insert to authenticated with check (public.can_manage_family(family_id));
    drop policy if exists screen_time_limits_manager_update_guard on public.screen_time_limits;
    create policy screen_time_limits_manager_update_guard on public.screen_time_limits
      as restrictive for update to authenticated using (public.can_manage_family(family_id))
      with check (public.can_manage_family(family_id));
    drop policy if exists screen_time_limits_manager_delete_guard on public.screen_time_limits;
    create policy screen_time_limits_manager_delete_guard on public.screen_time_limits
      as restrictive for delete to authenticated using (public.can_manage_family(family_id));

    for pol in
      select p.polname from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'screen_time_limits'
        and p.polpermissive and p.polcmd in ('a','w','d','*')
        and p.polname not in ('screen_time_limits_mng_insert','screen_time_limits_mng_update','screen_time_limits_mng_delete')
    loop
      execute format('drop policy if exists %I on public.screen_time_limits', pol.polname);
      swept := swept + 1;
      raise notice '0301: dropped stray permissive write policy screen_time_limits.%', pol.polname;
    end loop;
  end if;

  -- ── grades: your own entry, or a manager's ───────────────────────────────
  if to_regclass('public.grades') is not null then
    alter table public.grades enable row level security;

    drop policy if exists grades_select on public.grades;
    create policy grades_select on public.grades
      for select to authenticated using (public.is_family_member(family_id));

    -- Anyone in the family may RECORD a grade. Removing this would take a
    -- feature away to fix a different problem.
    drop policy if exists grades_insert on public.grades;
    create policy grades_insert on public.grades
      for insert to authenticated with check (public.is_family_member(family_id));

    -- Rewriting one is a different act. `created_by` is null on rows that
    -- predate the column or came from the trusted server; those are a manager's
    -- to edit, not anyone's.
    drop policy if exists grades_author_or_manager_update on public.grades;
    create policy grades_author_or_manager_update on public.grades
      for update to authenticated
      using (public.can_manage_family(family_id) or created_by = auth.uid())
      with check (public.can_manage_family(family_id) or created_by = auth.uid());
    drop policy if exists grades_author_or_manager_delete on public.grades;
    create policy grades_author_or_manager_delete on public.grades
      for delete to authenticated
      using (public.can_manage_family(family_id) or created_by = auth.uid());

    drop policy if exists grades_author_update_guard on public.grades;
    create policy grades_author_update_guard on public.grades
      as restrictive for update to authenticated
      using (public.can_manage_family(family_id) or created_by = auth.uid())
      with check (public.can_manage_family(family_id) or created_by = auth.uid());
    drop policy if exists grades_author_delete_guard on public.grades;
    create policy grades_author_delete_guard on public.grades
      as restrictive for delete to authenticated
      using (public.can_manage_family(family_id) or created_by = auth.uid());

    for pol in
      select p.polname from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'grades'
        and p.polpermissive and p.polcmd in ('a','w','d','*')
        and p.polname not in ('grades_insert','grades_author_or_manager_update','grades_author_or_manager_delete')
    loop
      execute format('drop policy if exists %I on public.grades', pol.polname);
      swept := swept + 1;
      raise notice '0301: dropped stray permissive write policy grades.%', pol.polname;
    end loop;
  end if;

  select count(*) into remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('screen_time_limits','grades')
    and p.polpermissive and p.polcmd in ('a','w','d','*')
    and p.polname not in (
      'screen_time_limits_mng_insert','screen_time_limits_mng_update','screen_time_limits_mng_delete',
      'grades_insert','grades_author_or_manager_update','grades_author_or_manager_delete'
    );
  if remaining <> 0 then
    raise exception '0301 FAILED: % permissive write policy(ies) still on grades/screen_time_limits after the sweep', remaining;
  end if;

  raise notice '0301 OK: % stray write policy(ies) swept; a limit is a manager''s to set and a grade is its author''s to correct', swept;
end $$;
