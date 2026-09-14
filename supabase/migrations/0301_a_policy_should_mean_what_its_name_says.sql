-- Bubaly :: 0301 - a policy should mean what its name says
-- ----------------------------------------------------------------------------
-- TWO tables, one theme: a record ABOUT a child that the child could rewrite.
--
-- child_logins
--   The policy is literally called "Managers manage child_logins" and its
--   predicate is `is_family_member(family_id)` for ALL commands. The name
--   asserts a boundary the predicate does not implement, which is also how the
--   next reviewer is misled.
--   It is NOT an escalation — app/(auth)/actions.ts derives both the email and
--   the password from `row.username` (syntheticChildEmail / deriveChildPassword),
--   so forging a row cannot produce a session for an account that does not
--   already exist under that username. What it is: a child can DELETE a
--   sibling's row, which removes that sibling's ability to sign in (the sign-in
--   lookup is `select … from child_logins where username = …`) and blanks the
--   parent's /dashboard/family-access view. Denial of service against an
--   access-control record.
--   Nothing legitimate is lost. EVERY write path in the app goes through
--   `createServiceClient()` — createChildLoginAction and resetChildPinAction
--   both open with `if (!isManager(ctx.active.role))` and then use the service
--   role, which bypasses RLS entirely. The only authenticated-session use is the
--   SELECT on /dashboard/family-access, which is unchanged.
--
-- behavior_logs
--   `lib/ai/context/policy.ts:68` classes this table as sensitive — "behaviour
--   notes about children" — and its single `FOR ALL … is_family_member` policy
--   let the child that a note is about edit or delete it. The module has no role
--   gate, so any member is offered the controls.
--   Same rule as 0300 gave `grades`, and for the same reason: RECORDING one is
--   plausibly any member's to do and the module offers it, while REWRITING
--   someone else's note is not. `behavior_logs.logged_by` makes the narrow rule
--   expressible. `points` here feeds AI insight summaries only — it is not an
--   economy — so this is about the integrity of a record, not money.
--
-- NOT INCLUDED, deliberately:
--   kid_progress    XP and streaks are updated by lib/chores/server.ts as part
--                   of a child completing a chore. A child's own progress row
--                   being written on the child's action is the feature. Narrowing
--                   it needs the chore-reward path traced first, and a guess here
--                   would break the thing chores exist for.
--   habit_logs      A habit log is the logger's own record by construction.

do $$
declare
  pol       record;
  swept     int := 0;
  remaining int;
begin
  -- ── child_logins: the name was right all along ───────────────────────────
  if to_regclass('public.child_logins') is not null then
    alter table public.child_logins enable row level security;

    drop policy if exists child_logins_select on public.child_logins;
    create policy child_logins_select on public.child_logins
      for select to authenticated using (public.is_family_member(family_id));
    drop policy if exists child_logins_mng_insert on public.child_logins;
    create policy child_logins_mng_insert on public.child_logins
      for insert to authenticated with check (public.can_manage_family(family_id));
    drop policy if exists child_logins_mng_update on public.child_logins;
    create policy child_logins_mng_update on public.child_logins
      for update to authenticated using (public.can_manage_family(family_id))
      with check (public.can_manage_family(family_id));
    drop policy if exists child_logins_mng_delete on public.child_logins;
    create policy child_logins_mng_delete on public.child_logins
      for delete to authenticated using (public.can_manage_family(family_id));

    drop policy if exists child_logins_manager_insert_guard on public.child_logins;
    create policy child_logins_manager_insert_guard on public.child_logins
      as restrictive for insert to authenticated with check (public.can_manage_family(family_id));
    drop policy if exists child_logins_manager_update_guard on public.child_logins;
    create policy child_logins_manager_update_guard on public.child_logins
      as restrictive for update to authenticated using (public.can_manage_family(family_id))
      with check (public.can_manage_family(family_id));
    drop policy if exists child_logins_manager_delete_guard on public.child_logins;
    create policy child_logins_manager_delete_guard on public.child_logins
      as restrictive for delete to authenticated using (public.can_manage_family(family_id));

    for pol in
      select p.polname from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'child_logins'
        and p.polpermissive and p.polcmd in ('a','w','d','*')
        and p.polname not in ('child_logins_mng_insert','child_logins_mng_update','child_logins_mng_delete')
    loop
      execute format('drop policy if exists %I on public.child_logins', pol.polname);
      swept := swept + 1;
      raise notice '0301: dropped stray permissive write policy child_logins.%', pol.polname;
    end loop;
  end if;

  -- ── behavior_logs: your own note, or a manager's ─────────────────────────
  if to_regclass('public.behavior_logs') is not null then
    alter table public.behavior_logs enable row level security;

    drop policy if exists behavior_logs_select on public.behavior_logs;
    create policy behavior_logs_select on public.behavior_logs
      for select to authenticated using (public.is_family_member(family_id));
    drop policy if exists behavior_logs_insert on public.behavior_logs;
    create policy behavior_logs_insert on public.behavior_logs
      for insert to authenticated with check (public.is_family_member(family_id));
    drop policy if exists behavior_logs_author_or_manager_update on public.behavior_logs;
    create policy behavior_logs_author_or_manager_update on public.behavior_logs
      for update to authenticated
      using (public.can_manage_family(family_id) or logged_by = auth.uid())
      with check (public.can_manage_family(family_id) or logged_by = auth.uid());
    drop policy if exists behavior_logs_author_or_manager_delete on public.behavior_logs;
    create policy behavior_logs_author_or_manager_delete on public.behavior_logs
      for delete to authenticated
      using (public.can_manage_family(family_id) or logged_by = auth.uid());

    drop policy if exists behavior_logs_author_update_guard on public.behavior_logs;
    create policy behavior_logs_author_update_guard on public.behavior_logs
      as restrictive for update to authenticated
      using (public.can_manage_family(family_id) or logged_by = auth.uid())
      with check (public.can_manage_family(family_id) or logged_by = auth.uid());
    drop policy if exists behavior_logs_author_delete_guard on public.behavior_logs;
    create policy behavior_logs_author_delete_guard on public.behavior_logs
      as restrictive for delete to authenticated
      using (public.can_manage_family(family_id) or logged_by = auth.uid());

    for pol in
      select p.polname from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'behavior_logs'
        and p.polpermissive and p.polcmd in ('a','w','d','*')
        and p.polname not in ('behavior_logs_insert','behavior_logs_author_or_manager_update','behavior_logs_author_or_manager_delete')
    loop
      execute format('drop policy if exists %I on public.behavior_logs', pol.polname);
      swept := swept + 1;
      raise notice '0301: dropped stray permissive write policy behavior_logs.%', pol.polname;
    end loop;
  end if;

  select count(*) into remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('child_logins','behavior_logs')
    and p.polpermissive and p.polcmd in ('a','w','d','*')
    and p.polname not in (
      'child_logins_mng_insert','child_logins_mng_update','child_logins_mng_delete',
      'behavior_logs_insert','behavior_logs_author_or_manager_update','behavior_logs_author_or_manager_delete'
    );
  if remaining <> 0 then
    raise exception '0301 FAILED: % permissive write policy(ies) still on child_logins/behavior_logs after the sweep', remaining;
  end if;

  raise notice '0301 OK: % stray write policy(ies) swept; child_logins now means what its name said, and a behaviour note is its author''s', swept;
end $$;
