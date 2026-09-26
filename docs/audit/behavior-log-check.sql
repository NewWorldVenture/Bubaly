-- A behavior log is not the child's to erase (0351).
--
-- As the CHILD: deleting a challenging entry about themselves, or editing it
-- into a positive one, must be refused. Controls: the child still logs; the
-- PARENT deletes an entry.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ef21';
  uPar uuid := '00000000-0000-4000-8000-00000000ef2a';
  uKid uuid := '00000000-0000-4000-8000-00000000ef2b';
  mKid uuid; hard uuid; mine uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'beh-parent@example.com'), (uKid, 'beh-kid@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Behavior family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uKid, 'Kid', 'child', true) returning id into mKid;
  insert into public.behavior_logs (family_id, member_id, kind, note, points, logged_by)
    values (fam, mKid, 'concern', 'Hit sibling', -5, uPar) returning id into hard;

  perform set_config('request.jwt.claim.sub', uKid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uKid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.behavior_logs set kind = 'positive', note = 'Helped sibling', points = 5 where id = hard;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child rewrote a behavior entry about themselves (rows: %)', n; failures := failures + 1; end if;
  delete from public.behavior_logs where id = hard;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child deleted a behavior entry about themselves (rows: %)', n; failures := failures + 1; end if;
  insert into public.behavior_logs (family_id, member_id, kind, note, logged_by) values (fam, mKid, 'positive', 'Read a book', uKid) returning id into mine;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a child could not log (rows: %)', n; failures := failures + 1; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.behavior_logs where id = mine;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not delete an entry (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uKid);

  if failures > 0 then
    raise exception 'behavior-log-check: % failure(s)', failures;
  end if;
end
$probe$;
