-- Bubaly :: 0336 - a read receipt is the reader's
--
-- announcement_reads records who has read a family announcement; the
-- announcements module shows it ("read by"), and the only writer marks the
-- caller's own member row. The table was member FOR ALL, so a member could
-- mark a sibling (or a parent) as having read something they never opened,
-- or erase someone's receipt. Writes now need is_self_member(member_id).
--
-- Pinned by docs/audit/read-receipt-check.sql.

do $$
declare
  p record;
begin
  if to_regclass('public.announcement_reads') is null then
    return;
  end if;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'announcement_reads' loop
    execute format('drop policy %I on public.announcement_reads', p.policyname);
  end loop;
  create policy announcement_reads_select on public.announcement_reads for select to authenticated
    using (public.is_family_member(family_id));
  create policy announcement_reads_insert on public.announcement_reads for insert to authenticated
    with check (public.is_family_member(family_id) and public.is_self_member(member_id));
  create policy announcement_reads_update on public.announcement_reads for update to authenticated
    using (public.is_family_member(family_id) and public.is_self_member(member_id))
    with check (public.is_family_member(family_id) and public.is_self_member(member_id));
  create policy announcement_reads_delete on public.announcement_reads for delete to authenticated
    using (public.is_family_member(family_id) and public.is_self_member(member_id));
end
$$;
