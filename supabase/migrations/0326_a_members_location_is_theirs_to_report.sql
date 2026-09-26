-- Bubaly :: 0326 - a member's location and safety check-ins are theirs to report
--
-- Three tables carry a family's live safety picture, and each let ANY member
-- write ANY member's rows:
--
--   member_locations  each member's live position and is_sharing flag.
--   location_events   the arrived/left timeline behind "Kid arrived at school".
--   safety_check_ins  "I'm safe" / "I need help" check-ins.
--
-- So a teen could place a sibling at school while they were somewhere else,
-- switch a parent's sharing off, write a sibling's arrival, check a sibling in
-- as safe, or delete someone else's "I need help". Every application writer
-- writes the caller's OWN member row (locator actions, the check-in view), so
-- writes become "your own member row, or a family manager". Reads are not
-- touched here: who may SEE whose location is an open owner decision recorded
-- in finalaudit.md (the 0297 read-scope list); this migration is only about
-- who may WRITE it, which no product reading leaves open.
--
-- is_self_member (0272) is: this member row belongs to auth.uid() and is active.
-- Pinned by docs/audit/member-location-owner-check.sql.

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['member_locations', 'location_events', 'safety_check_ins'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    -- Drop the existing policies whatever they are called, then restate SELECT
    -- exactly as it was (family members) and scope the writes.
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_family_member(family_id) and (public.is_self_member(member_id) or public.can_manage_family(family_id)))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_family_member(family_id) and (public.is_self_member(member_id) or public.can_manage_family(family_id))) with check (public.is_family_member(family_id) and (public.is_self_member(member_id) or public.can_manage_family(family_id)))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_family_member(family_id) and (public.is_self_member(member_id) or public.can_manage_family(family_id)))', t || '_delete', t);
  end loop;
end
$$;
