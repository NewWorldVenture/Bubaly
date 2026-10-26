-- 0525 — A closed vote takes no more ballots.
-- Requested on #771 in comment 6402862474, before any SQL: the database half
-- Support left for the owner in 6137789822 ("a close that lands between the
-- read and the write can still let one ballot through. Shutting that needs a
-- database rule (an RLS or trigger check on meal_votes.status)"), and the same
-- gap on family polls, which components/modules/voting-module.tsx names
-- itself: "nothing in the database refuses a vote on a closed poll".
--
-- The ballot tables check who votes (the member's own row, not a guest) but
-- never whether the vote is still open. Measured on a replay of main with
-- every held file through 0524 applied, as an active child, one PostgREST
-- insert each: a ballot on a closed meal vote OK 1; a vote on a closed poll
-- OK 1; a vote on an open poll past its closes_at OK 1. The screens ask first,
-- but a page left open, a second device or a direct request goes through, and
-- a close racing the screen's own read lets the ballot land after it.
--
-- A BEFORE INSERT OR UPDATE trigger on meal_vote_ballots and family_poll_votes
-- reads the row's vote or poll, in the row's family, FOR SHARE (so a close in
-- flight is waited for and then seen), and refuses with 42501 ("That vote is
-- closed") unless it is open:
--
--   meal_votes      status = 'open'
--   family_polls    status = 'open' and (closes_at is null or closes_at > now()),
--                   lib/voting/polls.ts isPollClosed's own rule
--
-- A vote or poll that is missing, or in another family, is not open either.
-- SECURITY DEFINER with a pinned search_path, so the share lock and the read do
-- not depend on the voter's own UPDATE rights or read rules. The service role
-- and session-less writers are exempt (no auth.uid()), as in 0464. Deletes,
-- reads, the guest guards, the member checks and every other rule are
-- unchanged; reopening a vote takes ballots again.
--
-- HELD: 0525, requested on #771 in comment 6402862474 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/a-closed-vote-takes-no-more-ballots-check.sql
-- and .github/workflows/closed-vote-runtime.yml. Not applied to production by
-- an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

create or replace function public.a_ballot_is_cast_while_its_vote_is_open()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  vote_open boolean;
begin
  if auth.uid() is null then
    return new; -- service role / server-side jobs
  end if;
  if tg_table_name = 'meal_vote_ballots' then
    select v.status = 'open' into vote_open
      from public.meal_votes v
     where v.id = new.vote_id and v.family_id = new.family_id
       for share;
  else
    select p.status = 'open' and (p.closes_at is null or p.closes_at > now()) into vote_open
      from public.family_polls p
     where p.id = new.poll_id and p.family_id = new.family_id
       for share;
  end if;
  if vote_open is distinct from true then
    raise exception 'That vote is closed' using errcode = '42501';
  end if;
  return new;
end
$$;

comment on function public.a_ballot_is_cast_while_its_vote_is_open() is
  'Refuses (42501) a signed-in caller''s ballot cast or changed on a meal vote or family poll that is not open (0525): the vote is read in the row''s family FOR SHARE, so a close in flight is waited for. The service role and session-less writers are exempt.';

revoke all on function public.a_ballot_is_cast_while_its_vote_is_open() from public, anon;

do $$
declare
  t text;
begin
  foreach t in array array['meal_vote_ballots', 'family_poll_votes'] loop
    if to_regclass('public.' || t) is null then
      raise exception '0525 needs public.%', t;
    end if;
  end loop;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'family_polls' and column_name = 'closes_at')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'meal_votes' and column_name = 'status') then
    raise exception '0525 needs family_polls.closes_at and meal_votes.status';
  end if;
  foreach t in array array['meal_vote_ballots', 'family_poll_votes'] loop
    execute format('drop trigger if exists %I on public.%I', 'trg_' || t || '_while_open', t);
    execute format('create trigger %I before insert or update on public.%I '
                   'for each row execute function public.a_ballot_is_cast_while_its_vote_is_open()',
                   'trg_' || t || '_while_open', t);
  end loop;
end
$$;

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_trigger g
   where g.tgfoid = 'public.a_ballot_is_cast_while_its_vote_is_open()'::regprocedure
     and g.tgenabled <> 'D'
     and g.tgrelid in ('public.meal_vote_ballots'::regclass, 'public.family_poll_votes'::regclass)
     and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2      -- FOR EACH ROW, BEFORE
     and (g.tgtype & 4) = 4 and (g.tgtype & 16) = 16    -- INSERT, UPDATE
     and (g.tgtype & 8) = 0;                            -- not DELETE
  if n <> 2 then
    raise exception '0525: % of 2 ballot tables carry the open-vote guard', n;
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.a_ballot_is_cast_while_its_vote_is_open()'::regprocedure
                  and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%') then
    raise exception '0525: the guard must be SECURITY DEFINER with a pinned search_path';
  end if;
end
$$;
