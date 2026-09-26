-- Bubaly :: 0338 - a private journal is private
--
-- The journal module says "A private space to reflect, process, and grow -
-- just for you", every entry is created with is_private = true (the column
-- default; the module never changes it), and the app only ever reads or
-- writes the signed-in member's own entries (journal-module.tsx, the AI
-- journal prompt route). But 0087 gave the table the family-wide FOR ALL
-- policy "for consistency", so any member - a sibling, a teen, a guest adult -
-- could read, rewrite or delete anyone's journal straight through the API.
--
-- Writes are now the owner's alone (is_self_member(member_id)). Reads are the
-- owner's, plus a family manager for an entry explicitly marked not private -
-- the owner-or-manager design lib/trust/sharing-presets.ts records for M23,
-- bounded by the flag the entry already carries. No application reader loses
-- anything.
--
-- Pinned by docs/audit/private-journal-check.sql.

do $$
declare
  p record;
begin
  if to_regclass('public.journal_entries') is null then
    return;
  end if;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'journal_entries' loop
    execute format('drop policy %I on public.journal_entries', p.policyname);
  end loop;
  create policy journal_entries_select on public.journal_entries for select to authenticated
    using (public.is_family_member(family_id)
           and (public.is_self_member(member_id) or (is_private = false and public.can_manage_family(family_id))));
  create policy journal_entries_insert on public.journal_entries for insert to authenticated
    with check (public.is_family_member(family_id) and public.is_self_member(member_id));
  create policy journal_entries_update on public.journal_entries for update to authenticated
    using (public.is_family_member(family_id) and public.is_self_member(member_id))
    with check (public.is_family_member(family_id) and public.is_self_member(member_id));
  create policy journal_entries_delete on public.journal_entries for delete to authenticated
    using (public.is_family_member(family_id) and public.is_self_member(member_id));
end
$$;
