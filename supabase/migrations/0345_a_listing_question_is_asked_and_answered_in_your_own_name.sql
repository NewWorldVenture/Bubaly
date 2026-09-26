-- Bubaly :: 0345 - a listing question is asked, and answered, in your own name
--
-- marketplace_questions let any family member INSERT, UPDATE and DELETE any
-- row: ask a question as a sibling (asker_member is just a column), answer on
-- the seller's behalf (answered_by likewise), or rewrite a question after it
-- was answered. The listing-questions component asks as the caller and shows
-- the answer form only to the listing's owner, naming the caller.
--
--   INSERT  asker_member is the caller
--   UPDATE  the listing's owner, answering as themselves
--   DELETE  the asker, the listing's owner, or a manager
--
-- Pinned by docs/audit/listing-question-check.sql.

do $$
declare
  p record;
begin
  if to_regclass('public.marketplace_questions') is null then
    return;
  end if;
  for p in select policyname from pg_policies
            where schemaname = 'public' and tablename = 'marketplace_questions' and cmd <> 'SELECT' loop
    execute format('drop policy %I on public.marketplace_questions', p.policyname);
  end loop;
  create policy marketplace_questions_insert on public.marketplace_questions for insert to authenticated
    with check (public.is_family_member(family_id) and asker_member = public.marketplace_member_id(family_id));
  create policy marketplace_questions_update on public.marketplace_questions for update to authenticated
    using (public.is_family_member(family_id) and exists (
      select 1 from public.marketplace_listings l
       where l.id = marketplace_questions.listing_id
         and l.member_id = public.marketplace_member_id(marketplace_questions.family_id)))
    with check (public.is_family_member(family_id)
      and (answered_by is null or answered_by = public.marketplace_member_id(family_id))
      and exists (
      select 1 from public.marketplace_listings l
       where l.id = marketplace_questions.listing_id
         and l.member_id = public.marketplace_member_id(marketplace_questions.family_id)));
  create policy marketplace_questions_delete on public.marketplace_questions for delete to authenticated
    using (public.is_family_member(family_id) and (
      asker_member = public.marketplace_member_id(family_id)
      or public.can_manage_family(family_id)
      or exists (select 1 from public.marketplace_listings l
                  where l.id = marketplace_questions.listing_id
                    and l.member_id = public.marketplace_member_id(marketplace_questions.family_id))));
end
$$;
