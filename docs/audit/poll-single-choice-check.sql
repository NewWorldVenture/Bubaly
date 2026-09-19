-- A single-choice poll takes one choice per member.
--
-- components/modules/voting-module.tsx enforces the difference between a
-- 'single' and a 'multi' poll in the browser, and says why:
--
--   if (poll.kind === 'single' && mine.size > 0) {
--     // Clear the prior selection first; if this fails, do NOT insert or the
--     // single-choice poll ends up with two votes for this member.
--
-- The comment is right about the consequence. It was also the only thing
-- enforcing it: `family_poll_votes` carries UNIQUE (option_id, member_id) —
-- one vote per OPTION, which is the correct rule for a 'multi' poll and no rule
-- at all for a 'single' one — and the table is reachable from the client.
-- Measured before 0322:
--
--   SINGLE-choice poll: one member cast 3 votes across 3 options
--
-- The controls are load-bearing in both directions here. A guard that simply
-- forbade a second vote would break MULTI polls, which exist to take several;
-- a guard keyed on the wrong column would stop a second MEMBER voting. 4, 5 and
-- 6 fail if either happens.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-000000014001';
  pa_uid uuid := '00000000-0000-4000-8000-0000000140a1';
  ch_uid uuid := '00000000-0000-4000-8000-0000000140a2';
  pa_mid uuid;
  ch_mid uuid;
  single uuid;
  multi  uuid;
  s1 uuid; s2 uuid; s3 uuid;
  m1 uuid; m2 uuid;
  n        int;
  failures int := 0;
begin
  -- Repeatable: this probe owns every poll under `fam`.
  delete from public.family_poll_votes   where family_id = fam;
  delete from public.family_poll_options where family_id = fam;
  delete from public.family_polls        where family_id = fam;

  insert into auth.users (id, email) values
    (pa_uid, 'poll-parent@example.com'), (ch_uid, 'poll-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Polls', pa_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, pa_uid, 'Parent', 'parent', true),
    (fam, ch_uid, 'Child',  'child',  true)
  on conflict do nothing;
  select id into pa_mid from public.family_members where family_id = fam and user_id = pa_uid;
  select id into ch_mid from public.family_members where family_id = fam and user_id = ch_uid;

  insert into public.family_polls (family_id, question, kind, status, created_by)
    values (fam, 'Where for dinner?', 'single', 'open', pa_uid) returning id into single;
  insert into public.family_poll_options (poll_id, family_id, label) values (single, fam, 'Pizza') returning id into s1;
  insert into public.family_poll_options (poll_id, family_id, label) values (single, fam, 'Sushi') returning id into s2;
  insert into public.family_poll_options (poll_id, family_id, label) values (single, fam, 'Tacos') returning id into s3;

  insert into public.family_polls (family_id, question, kind, status, created_by)
    values (fam, 'Which films shall we watch?', 'multi', 'open', pa_uid) returning id into multi;
  insert into public.family_poll_options (poll_id, family_id, label) values (multi, fam, 'Film A') returning id into m1;
  insert into public.family_poll_options (poll_id, family_id, label) values (multi, fam, 'Film B') returning id into m2;

  -- ── as the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', ch_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;

  -- 1. One vote on the single-choice poll. This is the product.
  begin
    insert into public.family_poll_votes (family_id, poll_id, option_id, member_id)
      values (fam, single, s1, ch_mid);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a member could not vote on a single-choice poll (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a member could not vote on a single-choice poll (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 2. A second option in the same single-choice poll is refused.
  begin
    insert into public.family_poll_votes (family_id, poll_id, option_id, member_id)
      values (fam, single, s2, ch_mid);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a member cast a second vote in a single-choice poll (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then null;
  end;

  -- 3. And so is arriving there by RE-POINTING a row rather than adding one.
  --    Without the UPDATE arm a member votes once legally, inserts nothing, and
  --    simply edits their way to a second choice.
  begin
    insert into public.family_poll_votes (family_id, poll_id, option_id, member_id)
      values (fam, multi, m1, ch_mid);
    update public.family_poll_votes
       set poll_id = single, option_id = s3
     where poll_id = multi and option_id = m1 and member_id = ch_mid;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a member re-pointed a vote into a single-choice poll they had already voted in (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then null;
  end;

  -- 4. Changing their mind the way the product does it — clear, then vote —
  --    still works, or the guard has made a single-choice poll unchangeable.
  begin
    delete from public.family_poll_votes where poll_id = single and member_id = ch_mid;
    insert into public.family_poll_votes (family_id, poll_id, option_id, member_id)
      values (fam, single, s3, ch_mid);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a member could not change their single-choice vote (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a member could not change their single-choice vote (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 5. A MULTI poll still takes several. This is what a naive fix breaks.
  begin
    delete from public.family_poll_votes where poll_id = multi and member_id = ch_mid;
    insert into public.family_poll_votes (family_id, poll_id, option_id, member_id) values
      (fam, multi, m1, ch_mid), (fam, multi, m2, ch_mid);
    get diagnostics n = row_count;
    if n <> 2 then
      raise warning 'CONTROL FAILED: a multiple-choice poll took only % of 2 votes', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a multiple-choice poll refused a second choice (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  reset role;

  -- 6. A different MEMBER still votes in the same single-choice poll. This is
  --    what a guard keyed on poll_id alone would break.
  perform set_config('request.jwt.claim.sub', pa_uid::text, true);
  set local role authenticated;
  begin
    insert into public.family_poll_votes (family_id, poll_id, option_id, member_id)
      values (fam, single, s1, pa_mid);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a second member could not vote in the same poll (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a second member could not vote in the same poll (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  -- What the poll reports is one choice per member.
  select count(*) into n from public.family_poll_votes where poll_id = single and member_id = ch_mid;
  if n <> 1 then
    raise warning 'BREACH: the single-choice poll records % votes for one member', n;
    failures := failures + 1;
  end if;

  if failures > 0 then
    raise exception 'poll-single-choice: % assertion(s) failed', failures;
  end if;
  raise notice 'poll-single-choice: OK — one choice per member on a single poll, several on a multi, and everyone still votes';
end
$probe$;
