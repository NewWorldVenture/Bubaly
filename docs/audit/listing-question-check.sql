-- A listing question is asked, and answered, in your own name (0345).
--
-- SELLER S owns a listing; BUYER B asked a question. As SIBLING X: asking as
-- B, answering as S, and rewriting B's question must be refused. Controls: X
-- asks as X; S answers B's question.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000eec1';
  uPar uuid := '00000000-0000-4000-8000-00000000eeca';
  uS uuid := '00000000-0000-4000-8000-00000000eecb';
  uB uuid := '00000000-0000-4000-8000-00000000eecc';
  uX uuid := '00000000-0000-4000-8000-00000000eecd';
  mS uuid; mB uuid; mX uuid; listing uuid; q uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'q-parent@example.com'), (uS, 'q-s@example.com'), (uB, 'q-b@example.com'), (uX, 'q-x@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Question family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uS, 'S', 'teen', true) returning id into mS;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uB, 'B', 'teen', true) returning id into mB;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uX, 'X', 'child', true) returning id into mX;
  insert into public.marketplace_listings (family_id, member_id, title) values (fam, mS, 'Scooter') returning id into listing;
  insert into public.marketplace_questions (family_id, listing_id, asker_member, question) values (fam, listing, mB, 'Does it fold?') returning id into q;

  perform set_config('request.jwt.claim.sub', uX::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uX, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.marketplace_questions (family_id, listing_id, asker_member, question) values (fam, listing, mB, 'Is it stolen?');
    raise warning 'BREACH: a member asked a question as a sibling'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  update public.marketplace_questions set answer = 'No, broken', answered_by = mS, answered_at = now() where id = q;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a member answered on the seller''s behalf (rows: %)', n; failures := failures + 1; end if;
  update public.marketplace_questions set question = 'Rewritten' where id = q;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a member rewrote someone''s question (rows: %)', n; failures := failures + 1; end if;
  insert into public.marketplace_questions (family_id, listing_id, asker_member, question) values (fam, listing, mX, 'What colour?');
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a member could not ask (rows: %)', n; failures := failures + 1; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', uS::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uS, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.marketplace_questions set answer = 'Yes', answered_by = mS, answered_at = now() where id = q;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: the seller could not answer (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uS, uB, uX);

  if failures > 0 then
    raise exception 'listing-question-check: % failure(s)', failures;
  end if;
end
$probe$;
