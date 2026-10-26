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
-- (a_meal_ballot_is_cast_while_its_vote_is_open() and
-- a_poll_vote_is_cast_while_its_poll_is_open()) reads the row's vote or poll,
-- in the row's family, FOR SHARE (so a close in
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

-- One function per table: a body that names the other table's column would not
-- resolve against this one (docs/audit/plpgsql-bodies-resolve-check.sql).
create or replace function public.a_meal_ballot_is_cast_while_its_vote_is_open()
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
  select v.status = 'open' into vote_open
    from public.meal_votes v
   where v.id = new.vote_id and v.family_id = new.family_id
     for share;
  if vote_open is distinct from true then
    raise exception 'That vote is closed' using errcode = '42501';
  end if;
  return new;
end
$$;

create or replace function public.a_poll_vote_is_cast_while_its_poll_is_open()
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
  select p.status = 'open' and (p.closes_at is null or p.closes_at > now()) into vote_open
    from public.family_polls p
   where p.id = new.poll_id and p.family_id = new.family_id
     for share;
  if vote_open is distinct from true then
    raise exception 'That vote is closed' using errcode = '42501';
  end if;
  return new;
end
$$;

comment on function public.a_meal_ballot_is_cast_while_its_vote_is_open() is
  'Refuses (42501) a signed-in caller''s meal-vote ballot cast or changed while the vote is not open (0525): the vote is read in the row''s family FOR SHARE, so a close in flight is waited for. The service role and session-less writers are exempt.';
comment on function public.a_poll_vote_is_cast_while_its_poll_is_open() is
  'Refuses (42501) a signed-in caller''s poll vote cast or changed while the poll is not open, isPollClosed''s rule (0525): the poll is read in the row''s family FOR SHARE. The service role and session-less writers are exempt.';

revoke all on function public.a_meal_ballot_is_cast_while_its_vote_is_open() from public, anon;
revoke all on function public.a_poll_vote_is_cast_while_its_poll_is_open() from public, anon;

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
  drop trigger if exists trg_meal_vote_ballots_while_open on public.meal_vote_ballots;
  create trigger trg_meal_vote_ballots_while_open before insert or update on public.meal_vote_ballots
    for each row execute function public.a_meal_ballot_is_cast_while_its_vote_is_open();
  drop trigger if exists trg_family_poll_votes_while_open on public.family_poll_votes;
  create trigger trg_family_poll_votes_while_open before insert or update on public.family_poll_votes
    for each row execute function public.a_poll_vote_is_cast_while_its_poll_is_open();
end
$$;

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_trigger g
   where ((g.tgrelid = 'public.meal_vote_ballots'::regclass
           and g.tgfoid = 'public.a_meal_ballot_is_cast_while_its_vote_is_open()'::regprocedure)
          or (g.tgrelid = 'public.family_poll_votes'::regclass
              and g.tgfoid = 'public.a_poll_vote_is_cast_while_its_poll_is_open()'::regprocedure))
     and g.tgenabled <> 'D'
     and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2      -- FOR EACH ROW, BEFORE
     and (g.tgtype & 4) = 4 and (g.tgtype & 16) = 16    -- INSERT, UPDATE
     and (g.tgtype & 8) = 0;                            -- not DELETE
  if n <> 2 then
    raise exception '0525: % of 2 ballot tables carry the open-vote guard', n;
  end if;
  if (select count(*) from pg_proc p
       where p.oid in ('public.a_meal_ballot_is_cast_while_its_vote_is_open()'::regprocedure,
                       'public.a_poll_vote_is_cast_while_its_poll_is_open()'::regprocedure)
         and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%') <> 2 then
    raise exception '0525: both guards must be SECURITY DEFINER with a pinned search_path';
  end if;
end
$$;
