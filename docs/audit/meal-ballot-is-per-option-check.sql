-- One member holds ONE ballot per OPTION, not one ballot per VOTE.
--
-- `meal_vote_ballots` carries `choice text NOT NULL CHECK (choice IN
-- ('yes','no','maybe'))` and `CONSTRAINT meal_vote_ballots_once UNIQUE
-- (option_id, member_id)` (0055). That pair is deliberate: a member rates each
-- option of a vote, so "yes to tacos, no to sushi, maybe to pizza" is THREE
-- rows sharing one vote_id and one member_id. `castBallot`
-- (app/(app)/dashboard/recipes/vote/actions.ts) is exactly that surface — it
-- upserts on `option_id,member_id` with the choice the member picked.
--
-- A second surface, `castVote` in components/modules/meals-module.tsx, offers
-- a single pick and clears the member's prior ballot before inserting the new
-- one. Under THAT surface alone a member does hold one ballot per vote, which
-- makes `UNIQUE (vote_id, member_id)` look like the constraint the table is
-- missing. It is not. Adding it would refuse the second option a member rates
-- on /dashboard/recipes/vote and break a shipped feature.
--
-- This probe exists because that constraint has been proposed in the history
-- of this repository as the invariant the table ought to carry. It asserts the
-- opposite invariant against the real replayed schema, so the proposal fails
-- loudly here instead of quietly in production.
--
-- Judged on ROW COUNTS, not exceptions.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam   uuid := '00000000-0000-4000-8000-0000000ba110';
  usr   uuid := '00000000-0000-4000-8000-0000000ba11a';
  mem   uuid;
  vote  uuid;
  optA  uuid; optB uuid; optC uuid;
  n int;
  failures int := 0;
begin
  delete from public.meal_vote_ballots where family_id = fam;
  delete from public.meal_vote_options where family_id = fam;
  delete from public.meal_votes        where family_id = fam;
  -- Not family_members directly: trg_family_keeps_a_manager refuses removing a
  -- family's last manager. Dropping the family cascades to its members.
  delete from public.families          where id = fam;

  insert into auth.users (id, email) values (usr, 'ballot-probe@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Ballot family', usr)
    on conflict (id) do nothing;
  -- `on_family_created` already provisions the creator's parent membership, so
  -- take that row rather than inserting a second one.
  select id into mem from public.family_members
   where family_id = fam and user_id = usr and is_active;
  if mem is null then
    insert into public.family_members (family_id, user_id, display_name, role, is_active)
      values (fam, usr, 'Parent', 'parent', true) returning id into mem;
  end if;

  insert into public.meal_votes (family_id, title, created_by)
    values (fam, 'Friday dinner', usr) returning id into vote;
  insert into public.meal_vote_options (vote_id, family_id, label)
    values (vote, fam, 'Tacos') returning id into optA;
  insert into public.meal_vote_options (vote_id, family_id, label)
    values (vote, fam, 'Sushi') returning id into optB;
  insert into public.meal_vote_options (vote_id, family_id, label)
    values (vote, fam, 'Pizza') returning id into optC;

  -- 1. The invariant: one member rates every option of the same vote.
  --    A UNIQUE (vote_id, member_id) would refuse the second insert here.
  begin
    insert into public.meal_vote_ballots (vote_id, option_id, family_id, member_id, choice)
    values (vote, optA, fam, mem, 'yes'),
           (vote, optB, fam, mem, 'no'),
           (vote, optC, fam, mem, 'maybe');
  exception when unique_violation then
    raise warning 'BREACH: a member cannot hold a ballot on more than one option of a vote — UNIQUE (vote_id, member_id) is present and breaks /dashboard/recipes/vote (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  select count(*) into n from public.meal_vote_ballots
   where vote_id = vote and member_id = mem;
  if n <> 3 then
    raise warning 'BREACH: expected 3 ballots for one member across three options, got %', n;
    failures := failures + 1;
  end if;

  -- 2. The constraint that DOES hold: the same member cannot rate one option
  --    twice. This is the control — without it, assertion 1 passing could just
  --    mean the table has no uniqueness at all.
  begin
    insert into public.meal_vote_ballots (vote_id, option_id, family_id, member_id, choice)
    values (vote, optA, fam, mem, 'no');
    raise warning 'CONTROL FAILED: meal_vote_ballots_once did not refuse a second ballot on the same option';
    failures := failures + 1;
  exception when unique_violation then null;
  end;

  -- 3. Control: the upsert castBallot actually issues still changes the choice
  --    in place rather than adding a row.
  insert into public.meal_vote_ballots (vote_id, option_id, family_id, member_id, choice)
  values (vote, optA, fam, mem, 'maybe')
  on conflict (option_id, member_id) do update set choice = excluded.choice;

  select count(*) into n from public.meal_vote_ballots
   where vote_id = vote and member_id = mem;
  if n <> 3 then
    raise warning 'CONTROL FAILED: the castBallot upsert added a row instead of updating (rows: %)', n;
    failures := failures + 1;
  end if;

  select count(*) into n from public.meal_vote_ballots
   where vote_id = vote and member_id = mem and option_id = optA and choice = 'maybe';
  if n <> 1 then
    raise warning 'CONTROL FAILED: the castBallot upsert did not change the choice in place (rows: %)', n;
    failures := failures + 1;
  end if;

  delete from public.meal_vote_ballots where family_id = fam;
  delete from public.meal_vote_options where family_id = fam;
  delete from public.meal_votes        where family_id = fam;
  delete from public.families          where id = fam;

  if failures > 0 then
    raise exception 'meal-ballot-is-per-option FAILED: % assertion(s)', failures;
  end if;
  raise notice 'meal-ballot-is-per-option OK: a member rates each option, and only once per option (5 assertions)';
end
$probe$;
