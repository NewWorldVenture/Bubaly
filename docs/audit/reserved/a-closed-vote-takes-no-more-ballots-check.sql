-- ── A closed vote takes no more ballots (0525) ──────────────────────────────
--
-- meal_vote_ballots and family_poll_votes check who votes, never whether the
-- vote is still open: a ballot on a closed meal vote, a vote on a closed poll
-- and a vote on a poll past its closes_at all landed. The held 0525 puts a
-- BEFORE INSERT OR UPDATE guard on both tables that reads the vote or poll in
-- the row's family, FOR SHARE, and refuses unless it is open.
--
-- Fixture, Vote House: a parent and a child. Written as the table owner: a
-- closed meal vote with an option and the child's ballot on it (cast while it
-- was open), an open meal vote with an option, a closed poll, an open poll past
-- its closes_at, an open poll closing tomorrow and one with no deadline, each
-- with an option.
--
-- What this probe asserts, through PostgREST's role:
--
--   1. the child's ballot on the closed meal vote is refused (42501, "That vote
--      is closed"), and so is their change of the ballot they cast on it while
--      it was open, which stays as cast;
--   2. the child's vote on the closed poll and on the poll past its closes_at
--      are refused the same way, and no vote lands;
--   3. control: the child's ballot on the open meal vote and votes on the poll
--      closing tomorrow and the poll with no deadline land (OK 1 each);
--   4. control: once the parent reopens the closed meal vote, the child's
--      ballot on it lands;
--   5. wiring: both tables carry trg_<table>_while_open, enabled, FOR EACH ROW,
--      BEFORE INSERT and UPDATE (not DELETE), executing
--      a_ballot_is_cast_while_its_vote_is_open(), which is SECURITY DEFINER
--      with a pinned search_path, reads FOR SHARE, and is not executable by
--      PUBLIC or anon;
--
-- and, only where 0525 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with both triggers disabled, the child's ballot on
--       the closed meal vote lands (OK 1): the fixture reaches the defect;
--   M1. MUTATION CONTROL: with the poll rule reading status alone, the child's
--       vote on the poll past its closes_at lands, so 2. catches the deadline
--       half going.
--
-- The share lock's wait on a close in flight needs two sessions and is not
-- run here; 5. requires the FOR SHARE read.
--
-- Everything is rolled back.
--
-- HELD with 0525: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/closed-vote-runtime.yml runs it there to show the failure,
-- then applies the held migration and requires it to pass. It moves back to
-- docs/audit/ when 0525 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8525-0000000000a1','c0525-parent@example.com'),
  ('00000000-0000-4000-8525-0000000000a4','c0525-child@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8525-0000000000f1','Vote House','00000000-0000-4000-8525-0000000000a1');
update public.family_members set role = 'parent', is_active = true
 where user_id = '00000000-0000-4000-8525-0000000000a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8525-0000000000c4','00000000-0000-4000-8525-0000000000f1','00000000-0000-4000-8525-0000000000a4','Child','child',true);

-- Meal votes: one closed (with the child's ballot cast while it was open), one open.
insert into public.meal_votes (id, family_id, created_by, title, status) values
  ('00000000-0000-4000-8525-0000000000b1','00000000-0000-4000-8525-0000000000f1','00000000-0000-4000-8525-0000000000a1','Friday dinner','open'),
  ('00000000-0000-4000-8525-0000000000b7','00000000-0000-4000-8525-0000000000f1','00000000-0000-4000-8525-0000000000a1','Saturday lunch','open');
insert into public.meal_vote_options (id, vote_id, family_id, label) values
  ('00000000-0000-4000-8525-0000000000b2','00000000-0000-4000-8525-0000000000b1','00000000-0000-4000-8525-0000000000f1','Tacos'),
  ('00000000-0000-4000-8525-0000000000b8','00000000-0000-4000-8525-0000000000b1','00000000-0000-4000-8525-0000000000f1','Pizza'),
  ('00000000-0000-4000-8525-0000000000b9','00000000-0000-4000-8525-0000000000b7','00000000-0000-4000-8525-0000000000f1','Soup');
insert into public.meal_vote_ballots (id, vote_id, option_id, family_id, member_id, choice) values
  ('00000000-0000-4000-8525-0000000000e1','00000000-0000-4000-8525-0000000000b1','00000000-0000-4000-8525-0000000000b2','00000000-0000-4000-8525-0000000000f1','00000000-0000-4000-8525-0000000000c4','yes');
update public.meal_votes set status = 'closed' where id = '00000000-0000-4000-8525-0000000000b1';

-- Polls: closed, past its deadline, closing tomorrow, no deadline.
insert into public.family_polls (id, family_id, question, status, closes_at, created_by) values
  ('00000000-0000-4000-8525-0000000000d1','00000000-0000-4000-8525-0000000000f1','Where to?','closed',null,'00000000-0000-4000-8525-0000000000a1'),
  ('00000000-0000-4000-8525-0000000000d2','00000000-0000-4000-8525-0000000000f1','When?','open',now() - interval '1 hour','00000000-0000-4000-8525-0000000000a1'),
  ('00000000-0000-4000-8525-0000000000d3','00000000-0000-4000-8525-0000000000f1','Which film?','open',now() + interval '1 day','00000000-0000-4000-8525-0000000000a1'),
  ('00000000-0000-4000-8525-0000000000d4','00000000-0000-4000-8525-0000000000f1','Which game?','open',null,'00000000-0000-4000-8525-0000000000a1');
insert into public.family_poll_options (id, poll_id, family_id, label) values
  ('00000000-0000-4000-8525-00000000aa01','00000000-0000-4000-8525-0000000000d1','00000000-0000-4000-8525-0000000000f1','Beach'),
  ('00000000-0000-4000-8525-00000000aa02','00000000-0000-4000-8525-0000000000d2','00000000-0000-4000-8525-0000000000f1','Saturday'),
  ('00000000-0000-4000-8525-00000000aa03','00000000-0000-4000-8525-0000000000d3','00000000-0000-4000-8525-0000000000f1','The new one'),
  ('00000000-0000-4000-8525-00000000aa04','00000000-0000-4000-8525-0000000000d4','00000000-0000-4000-8525-0000000000f1','Charades');

-- One statement as one signed-in user, and exactly what happened; back to the
-- owner with no user id.
create or replace function pg_temp.c0525_as(p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    got := 'OK ' || n;
  exception when others then
    got := sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return got;
end
$fn$;

do $$
declare
  child constant text := '00000000-0000-4000-8525-0000000000a4';
  parent constant text := '00000000-0000-4000-8525-0000000000a1';
  guard constant text := '42501: That vote is closed';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  got text;
  n bigint;
  x record;
  ballot constant text := 'insert into public.meal_vote_ballots (vote_id, option_id, family_id, member_id, choice) values (%L, %L, ''00000000-0000-4000-8525-0000000000f1'', ''00000000-0000-4000-8525-0000000000c4'', ''yes'')';
  pollvote constant text := 'insert into public.family_poll_votes (poll_id, option_id, family_id, member_id) values (%L, %L, ''00000000-0000-4000-8525-0000000000f1'', ''00000000-0000-4000-8525-0000000000c4'')';
begin
  installed := (select count(*) from pg_trigger
                 where tgfoid = to_regprocedure('public.a_ballot_is_cast_while_its_vote_is_open()')) = 2;

  -- 1. The closed meal vote: a new ballot, and a change of the one already cast.
  got := pg_temp.c0525_as(child, format(ballot, '00000000-0000-4000-8525-0000000000b1', '00000000-0000-4000-8525-0000000000b8'));
  if got is distinct from guard then
    failures := array_append(failures, format('the child cast a ballot on a closed meal vote (%s)', got));
  end if;
  got := pg_temp.c0525_as(child, 'update public.meal_vote_ballots set choice = ''no'' where id = ''00000000-0000-4000-8525-0000000000e1''');
  if got is distinct from guard then
    failures := array_append(failures, format('the child changed their ballot on a closed meal vote (%s)', got));
  end if;
  select count(*) into n from public.meal_vote_ballots where vote_id = '00000000-0000-4000-8525-0000000000b1';
  if n <> 1 or not exists (select 1 from public.meal_vote_ballots where id = '00000000-0000-4000-8525-0000000000e1' and choice = 'yes') then
    failures := array_append(failures, 'the closed meal vote''s ballots are not as they stood when it closed');
  end if;
  delete from public.meal_vote_ballots where vote_id = '00000000-0000-4000-8525-0000000000b1' and id <> '00000000-0000-4000-8525-0000000000e1';
  update public.meal_vote_ballots set choice = 'yes' where id = '00000000-0000-4000-8525-0000000000e1';

  -- 2. The closed poll and the poll past its deadline.
  for x in select * from (values ('a closed poll', '00000000-0000-4000-8525-0000000000d1', '00000000-0000-4000-8525-00000000aa01'),
                                 ('a poll past its closes_at', '00000000-0000-4000-8525-0000000000d2', '00000000-0000-4000-8525-00000000aa02')) as v(label, poll, opt) loop
    got := pg_temp.c0525_as(child, format(pollvote, x.poll, x.opt));
    if got is distinct from guard then
      failures := array_append(failures, format('the child voted on %s (%s)', x.label, got));
    end if;
    delete from public.family_poll_votes where poll_id = x.poll::uuid;
  end loop;

  -- 3. Control: open votes take ballots.
  bad := array[pg_temp.c0525_as(child, format(ballot, '00000000-0000-4000-8525-0000000000b7', '00000000-0000-4000-8525-0000000000b9')),
               pg_temp.c0525_as(child, format(pollvote, '00000000-0000-4000-8525-0000000000d3', '00000000-0000-4000-8525-00000000aa03')),
               pg_temp.c0525_as(child, format(pollvote, '00000000-0000-4000-8525-0000000000d4', '00000000-0000-4000-8525-00000000aa04'))];
  if exists (select 1 from unnest(bad) g where g <> 'OK 1') then
    failures := array_append(failures, format('CONTROL: an open vote did not take the child''s ballot (%s)', array_to_string(bad, ', ')));
  end if;

  -- 4. Control: reopened, the meal vote takes the ballot again.
  got := pg_temp.c0525_as(parent, 'update public.meal_votes set status = ''open'' where id = ''00000000-0000-4000-8525-0000000000b1''');
  if got <> 'OK 1' then
    failures := array_append(failures, format('CONTROL: the parent did not reopen the meal vote (%s)', got));
  end if;
  got := pg_temp.c0525_as(child, format(ballot, '00000000-0000-4000-8525-0000000000b1', '00000000-0000-4000-8525-0000000000b8'));
  if got <> 'OK 1' then
    failures := array_append(failures, format('CONTROL: the reopened meal vote did not take the child''s ballot (%s)', got));
  end if;
  update public.meal_votes set status = 'closed' where id = '00000000-0000-4000-8525-0000000000b1';
  delete from public.meal_vote_ballots where vote_id = '00000000-0000-4000-8525-0000000000b1' and id <> '00000000-0000-4000-8525-0000000000e1';

  -- 5. Wiring.
  bad := '{}';
  for x in select * from (values ('meal_vote_ballots'), ('family_poll_votes')) as v(tbl) loop
    if not exists (select 1 from pg_trigger g
                    where g.tgrelid = ('public.' || x.tbl)::regclass and g.tgname = 'trg_' || x.tbl || '_while_open'
                      and g.tgfoid = to_regprocedure('public.a_ballot_is_cast_while_its_vote_is_open()')
                      and g.tgenabled <> 'D' and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2
                      and (g.tgtype & 4) = 4 and (g.tgtype & 16) = 16 and (g.tgtype & 8) = 0) then
      bad := array_append(bad, x.tbl);
    end if;
  end loop;
  if to_regprocedure('public.a_ballot_is_cast_while_its_vote_is_open()') is null then
    bad := array_append(bad, 'a_ballot_is_cast_while_its_vote_is_open (missing)');
  elsif not exists (select 1 from pg_proc p where p.oid = 'public.a_ballot_is_cast_while_its_vote_is_open()'::regprocedure
                     and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%'
                     and pg_get_functiondef(p.oid) ~* 'for share')
     or has_function_privilege('anon', 'public.a_ballot_is_cast_while_its_vote_is_open()', 'execute')
     or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                 where p.oid = 'public.a_ballot_is_cast_while_its_vote_is_open()'::regprocedure
                   and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    bad := array_append(bad, 'a_ballot_is_cast_while_its_vote_is_open (not SECURITY DEFINER with a pinned search_path and a FOR SHARE read, or executable by PUBLIC or anon)');
  end if;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('0525''s guard is not in place on %s', array_to_string(bad, ', ')));
  end if;

  if installed then
    -- N1. Both triggers disabled.
    begin
      alter table public.meal_vote_ballots disable trigger trg_meal_vote_ballots_while_open;
      alter table public.family_poll_votes disable trigger trg_family_poll_votes_while_open;
      got := pg_temp.c0525_as(child, format(ballot, '00000000-0000-4000-8525-0000000000b1', '00000000-0000-4000-8525-0000000000b8'));
      if got <> 'OK 1' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the triggers disabled the child''s ballot on the closed meal vote still did not land (%s), so this fixture cannot see the defect', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The poll rule on status alone.
    begin
      create or replace function public.a_ballot_is_cast_while_its_vote_is_open()
      returns trigger language plpgsql security definer set search_path = public, pg_temp as $m1$
      declare vote_open boolean;
      begin
        if auth.uid() is null then return new; end if;
        if tg_table_name = 'meal_vote_ballots' then
          select v.status = 'open' into vote_open from public.meal_votes v where v.id = new.vote_id and v.family_id = new.family_id for share;
        else
          select p.status = 'open' into vote_open from public.family_polls p where p.id = new.poll_id and p.family_id = new.family_id for share;
        end if;
        if vote_open is distinct from true then raise exception 'That vote is closed' using errcode = '42501'; end if;
        return new;
      end $m1$;
      got := pg_temp.c0525_as(child, format(pollvote, '00000000-0000-4000-8525-0000000000d2', '00000000-0000-4000-8525-00000000aa02'));
      if got <> 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: with the poll rule on status alone the child''s vote past the deadline still did not land (%s), so 2. cannot catch the deadline half going', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a closed vote takes ballots:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-closed-vote-takes-no-more-ballots: OK (the child''s ballot on the closed meal vote and their change of the one cast before it closed were refused (42501, its own sentence), and the ballots stand as they did; their votes on the closed poll and on the poll past its closes_at were refused; open votes, the poll closing tomorrow and the one with no deadline took ballots; reopened, the meal vote took the ballot; both tables guarded before insert and update with a SECURITY DEFINER FOR SHARE read, search_path pinned, not executable by PUBLIC or anon; negative control: without the triggers the closed vote took the ballot; mutation control: with the poll rule on status alone the vote past the deadline landed)';
end $$;

rollback;
