-- A vote is cast by its voter (0335).
--
-- As TEEN A: casting a poll vote as sibling B, flipping B's watchlist vote, and
-- deleting B's poll vote must be refused. Controls: A votes as A; the PARENT
-- can remove B's vote (moderation).
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ee21';
  uPar uuid := '00000000-0000-4000-8000-00000000ee2a';
  uA uuid := '00000000-0000-4000-8000-00000000ee2b';
  uB uuid := '00000000-0000-4000-8000-00000000ee2c';
  mA uuid; mB uuid; poll uuid; opt1 uuid; opt2 uuid; bVote uuid; title uuid; bWatch uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'vote-parent@example.com'), (uA, 'vote-a@example.com'), (uB, 'vote-b@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Vote family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uA, 'A', 'teen', true) returning id into mA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uB, 'B', 'child', true) returning id into mB;
  insert into public.family_polls (family_id, question) values (fam, 'Pizza or tacos?') returning id into poll;
  insert into public.family_poll_options (family_id, poll_id, label) values (fam, poll, 'Pizza') returning id into opt1;
  insert into public.family_poll_options (family_id, poll_id, label) values (fam, poll, 'Tacos') returning id into opt2;
  insert into public.family_poll_votes (family_id, poll_id, option_id, member_id) values (fam, poll, opt2, mB) returning id into bVote;
  insert into public.watchlist_titles (family_id, title) values (fam, 'Movie') returning id into title;
  insert into public.watchlist_votes (family_id, title_id, member_id, vote) values (fam, title, mB, 'down') returning id into bWatch;

  perform set_config('request.jwt.claim.sub', uA::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uA, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.family_poll_votes (family_id, poll_id, option_id, member_id) values (fam, poll, opt1, mB);
    raise warning 'BREACH: a member voted as a sibling'; failures := failures + 1;
  exception when insufficient_privilege or unique_violation then
    if sqlstate = '23505' then raise warning 'BREACH: a member voted as a sibling (reached the unique index)'; failures := failures + 1; end if;
  end;
  update public.watchlist_votes set vote = 'love' where id = bWatch;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a member flipped a sibling''s vote (rows: %)', n; failures := failures + 1; end if;
  delete from public.family_poll_votes where id = bVote;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a member deleted a sibling''s vote (rows: %)', n; failures := failures + 1; end if;
  insert into public.family_poll_votes (family_id, poll_id, option_id, member_id) values (fam, poll, opt1, mA);
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a member could not vote (rows: %)', n; failures := failures + 1; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.family_poll_votes where id = bVote;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not remove a vote (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uA, uB);

  if failures > 0 then
    raise exception 'vote-owner-check: % failure(s)', failures;
  end if;
end
$probe$;
