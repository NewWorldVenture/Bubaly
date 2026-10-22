-- Bubaly :: 0479 - a reminder or a to-do is deleted by a manager or its author
-- ----------------------------------------------------------------------------
-- From the 2026-10-10 reminder/to-do audit (proposed-reminder-todo-delete-rls.sql,
-- the SQL half of audit/reminder-todo-deletes-fix). Numbered 0479 by owner
-- decision of 2026-10-10; the SQL is the proposal's, unchanged.
--
-- Companion to the app-side gate in deleteReminderAction / deleteTodoAction
-- (canDeleteReminder / canDeleteTodo). Today both tables carry one blanket
-- permissive policy, `for all using (is_family_member(family_id))` (0014 /
-- 0015, restated by 0426), and todo_items additionally carries 0106's four
-- per-command policies, all `is_family_member(family_id)`. So any active member
-- -- guest and caregiver included -- can DELETE any family reminder or task
-- straight against PostgREST, whatever the server action says.
--
-- This replaces them with per-command policies:
--   * SELECT / INSERT / UPDATE: unchanged semantics, is_family_member(family_id).
--     (Not tightened here. Note UPDATE still lets any member rewrite
--     assigned_to_id / member_id, which is exactly why DELETE must not trust them.)
--   * DELETE: a manager (can_manage_family: active parent/adult), or an active
--     member who is not a guest or caregiver AND authored the row.
--
-- Authorship, verified against the migrations:
--   * family_reminders.created_by  uuid references auth.users(id)          (0014)
--       -> compared with auth.uid() directly.
--   * todo_items.created_by        uuid references public.family_members(id) (0015)
--       -> NOT an auth uid. Compared with the caller's own ACTIVE membership
--          row in the row's family. The subquery states its own is_active, so
--          it does not lean on fm_select (see 0426) and passes 0426's sweep.
--   * assigned_to_id / member_id are deliberately ignored: any member can set
--     them (see above), so they are not ownership.
--
-- Idempotent: every policy is dropped if it exists and re-created; each table
-- is skipped with a notice if it is absent (to_regclass guard, as in 0378).

-- ── family_reminders ────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.family_reminders') is null then
    raise notice '0479: public.family_reminders is not there -- skipped';
    return;
  end if;

  execute 'alter table public.family_reminders enable row level security';

  -- The blanket policy (0014, rewritten by 0426) and any earlier run of this file.
  execute 'drop policy if exists "family members can manage reminders" on public.family_reminders';
  execute 'drop policy if exists family_reminders_select on public.family_reminders';
  execute 'drop policy if exists family_reminders_insert on public.family_reminders';
  execute 'drop policy if exists family_reminders_update on public.family_reminders';
  execute 'drop policy if exists family_reminders_delete on public.family_reminders';

  execute 'create policy family_reminders_select on public.family_reminders '
          'for select to public using (public.is_family_member(family_id))';
  execute 'create policy family_reminders_insert on public.family_reminders '
          'for insert to public with check (public.is_family_member(family_id))';
  execute 'create policy family_reminders_update on public.family_reminders '
          'for update to public '
          'using (public.is_family_member(family_id)) '
          'with check (public.is_family_member(family_id))';
  execute 'create policy family_reminders_delete on public.family_reminders '
          'for delete to public using ('
          '  public.can_manage_family(family_id)'
          '  or ('
          '    public.is_family_member(family_id)'
          '    and created_by = auth.uid()'
          '    and coalesce(public.family_role(family_id)::text, ''guest'') not in (''guest'', ''caregiver'')'
          '  )'
          ')';
end
$$;

-- ── todo_items ──────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.todo_items') is null then
    raise notice '0479: public.todo_items is not there -- skipped';
    return;
  end if;

  execute 'alter table public.todo_items enable row level security';

  -- The blanket policy (0015, rewritten by 0426), 0106's per-command policies
  -- (same names as below; todo_items_delete is the permissive one that would
  -- otherwise OR the narrowing away), and any earlier run of this file.
  execute 'drop policy if exists "family member access" on public.todo_items';
  execute 'drop policy if exists todo_items_select on public.todo_items';
  execute 'drop policy if exists todo_items_insert on public.todo_items';
  execute 'drop policy if exists todo_items_update on public.todo_items';
  execute 'drop policy if exists todo_items_delete on public.todo_items';

  execute 'create policy todo_items_select on public.todo_items '
          'for select to public using (public.is_family_member(family_id))';
  execute 'create policy todo_items_insert on public.todo_items '
          'for insert to public with check (public.is_family_member(family_id))';
  execute 'create policy todo_items_update on public.todo_items '
          'for update to public '
          'using (public.is_family_member(family_id)) '
          'with check (public.is_family_member(family_id))';
  -- created_by is a family_members id (0015), so "created_by = auth.uid()" would
  -- never match; the author test is "created_by is MY active member row here".
  execute 'create policy todo_items_delete on public.todo_items '
          'for delete to public using ('
          '  public.can_manage_family(family_id)'
          '  or ('
          '    public.is_family_member(family_id)'
          '    and created_by in ('
          '      select fm.id from public.family_members fm'
          '      where fm.family_id = todo_items.family_id'
          '        and fm.user_id = auth.uid()'
          '        and fm.is_active'
          '    )'
          '    and coalesce(public.family_role(family_id)::text, ''guest'') not in (''guest'', ''caregiver'')'
          '  )'
          ')';
end
$$;

-- ── Check: no other permissive DELETE path is left on either table ──────────
-- A permissive policy ORs; one stray `for all` or `for delete` would undo the
-- narrowing above. Fails the migration rather than leaving it silently open.
do $$
declare
  stray text;
begin
  select string_agg(format('%s.%s', c.relname, p.polname), ', ' order by c.relname, p.polname)
    into stray
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relname in ('family_reminders', 'todo_items')
    and p.polpermissive
    and p.polcmd in ('*', 'd')
    and p.polname not in ('family_reminders_delete', 'todo_items_delete');

  if stray is not null then
    raise exception '0479: a permissive policy still grants DELETE beside the narrowed one: %', stray;
  end if;

  raise notice '0479 OK: family_reminders / todo_items DELETE is manager-or-author';
end
$$;
