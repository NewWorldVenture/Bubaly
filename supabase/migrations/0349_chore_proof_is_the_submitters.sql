-- Bubaly :: 0349 - chore proof is the submitter's
--
-- chore_submissions holds a child's proof for a chore: the photos
-- (media_paths), the note, and the review status (0222 guards the decided
-- statuses). It was member FOR ALL, so a sibling could swap another child's
-- proof photos or note while it waited for a parent's review, file a
-- submission in their name, or delete it. Every writer is the submitter on
-- their own row (submitProofAction, disputeSubmissionAction, the cleanup on a
-- failed submit), a manager (approve / reject), or the service role
-- (auto-review). Writes are now the submitter's own, or a manager's.
--
-- Pinned by docs/audit/chore-proof-owner-check.sql.

do $$
declare
  p record;
  own constant text := '(public.is_self_member(member_id) or public.can_manage_family(family_id))';
begin
  if to_regclass('public.chore_submissions') is null then
    return;
  end if;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'chore_submissions' loop
    execute format('drop policy %I on public.chore_submissions', p.policyname);
  end loop;
  create policy chore_submissions_select on public.chore_submissions for select to authenticated
    using (public.is_family_member(family_id));
  execute format('create policy chore_submissions_insert on public.chore_submissions for insert to authenticated with check (public.is_family_member(family_id) and %s)', own);
  execute format('create policy chore_submissions_update on public.chore_submissions for update to authenticated using (public.is_family_member(family_id) and %s) with check (public.is_family_member(family_id) and %s)', own, own);
  execute format('create policy chore_submissions_delete on public.chore_submissions for delete to authenticated using (public.is_family_member(family_id) and %s)', own);
end
$$;
