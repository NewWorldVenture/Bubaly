-- 0419 — A parent who leaves the family takes no assistant key with them.
-- SRV-001 l12, re-derived from the source before this was written.
--
-- An assistant key (public.assistant_links) is a standing bearer grant over a
-- household: whoever holds its secret can have POST /api/assistant (or the
-- Alexa route) read the family's day aloud — today's and tomorrow's calendar,
-- open tasks, the shopping and to-do lists — and, with the `capture` scope,
-- write events, notes, groceries and to-dos back. Only a parent can mint one
-- (0343; dashboard/assistants `isAdmin`), and the key is stamped with that
-- parent's user_id.
--
-- Removing a member is `update family_members set is_active = false` (the
-- family and settings modules, and the Super Admin's remove), and demoting one
-- is an UPDATE of `role`. Neither touched assistant_links: the only trigger on
-- family_members was 0299's keep-a-manager check, and the key's user_id
-- cascades only on deleting the AUTH account. So a second parent removed from
-- the household — the case removal exists for, an estranged co-parent — kept
-- a live key until someone found it on /dashboard/assistants (which does not
-- say whose key each one is) and pressed Revoke.
--
-- The application half is lib/assistant/service.ts resolveAssistantLink: a
-- key resolves only while its owner is an active parent of its family. That
-- holds without this migration. This is the database half, so the key is
-- actually retired rather than merely refused:
--
--   * an AFTER UPDATE (is_active, role, user_id, family_id) OR DELETE trigger
--     on family_members that, whenever the row's OLD (family_id, user_id) no
--     longer has an active parent row, stamps revoked_at on every live key
--     that pair minted in that family. "No longer" is read after the change,
--     from the table, so it covers deactivation, demotion, a moved row and a
--     deleted row with one condition, and leaves a still-active parent alone;
--   * a one-time backfill that retires the keys already orphaned the same
--     way before this existed. It touches only rows whose owner is not an
--     active parent of the key's family, and only sets revoked_at.
--
-- SECURITY DEFINER with a pinned search_path, because the member who removes
-- a parent (an adult may, under 0211's fm_update) is refused writes on
-- assistant_links by 0343's parent-only guards — and revoking the departed
-- parent's key must not depend on who pressed Remove. EXECUTE is revoked from
-- the API roles; a trigger function is only ever called by its trigger.
--
-- Held by docs/audit/a-departed-parent-keeps-no-assistant-key-check.sql.
-- Not applied to production by an agent; recorded in
-- docs/PENDING_PROD_MIGRATIONS.md for the owner.

create or replace function public.retire_assistant_keys_of_a_departed_parent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is null then
    return null;
  end if;
  if not exists (
    select 1 from public.family_members m
     where m.family_id = old.family_id
       and m.user_id = old.user_id
       and m.is_active
       and m.role = 'parent'
  ) then
    update public.assistant_links
       set revoked_at = now()
     where family_id = old.family_id
       and user_id = old.user_id
       and revoked_at is null;
  end if;
  return null;
end
$$;

comment on function public.retire_assistant_keys_of_a_departed_parent() is
  '0419 (SRV-001 l12): after a family_members row is deactivated, demoted, moved or deleted, retire every live assistant key its (family_id, user_id) minted in that family unless that pair is still an active parent there.';

revoke all on function public.retire_assistant_keys_of_a_departed_parent() from public;
revoke all on function public.retire_assistant_keys_of_a_departed_parent() from anon, authenticated;

drop trigger if exists family_members_retire_departed_parent_keys on public.family_members;
create trigger family_members_retire_departed_parent_keys
  after update of is_active, role, user_id, family_id or delete on public.family_members
  for each row execute function public.retire_assistant_keys_of_a_departed_parent();

-- The keys already orphaned before this trigger existed.
update public.assistant_links l
   set revoked_at = now()
 where l.revoked_at is null
   and not exists (
     select 1 from public.family_members m
      where m.family_id = l.family_id
        and m.user_id = l.user_id
        and m.is_active
        and m.role = 'parent'
   );

do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'family_members_retire_departed_parent_keys'
       and tgrelid = 'public.family_members'::regclass
       and not tgisinternal
  ) then
    raise exception '0419: family_members_retire_departed_parent_keys is missing';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.retire_assistant_keys_of_a_departed_parent()'::regprocedure) then
    raise exception '0419: retire_assistant_keys_of_a_departed_parent must be SECURITY DEFINER, or an adult removing a parent is refused the revoke by 0343';
  end if;
end $$;
