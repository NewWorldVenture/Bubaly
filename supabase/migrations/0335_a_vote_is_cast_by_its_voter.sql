-- Bubaly :: 0335 - a vote is cast by its voter
--
-- family_poll_votes, meal_vote_ballots and watchlist_votes let any member
-- write any member's vote: cast a ballot as a sibling, flip a parent's "no" to
-- "yes", or delete everyone else's votes and win the poll. Every writer (the
-- voting, meals and watchlist modules, the recipe-vote action) writes the
-- caller's own member row. Writes now need is_self_member(member_id); a
-- manager may also remove a vote (moderating a poll). Reads unchanged.
--
-- Pinned by docs/audit/vote-owner-check.sql.

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['family_poll_votes', 'meal_vote_ballots', 'watchlist_votes'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_family_member(family_id) and public.is_self_member(member_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_family_member(family_id) and public.is_self_member(member_id)) with check (public.is_family_member(family_id) and public.is_self_member(member_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_family_member(family_id) and (public.is_self_member(member_id) or public.can_manage_family(family_id)))', t || '_delete', t);
  end loop;
end
$$;
