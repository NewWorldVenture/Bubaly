-- ── "Two parents" is a rule the database keeps, not only the server action (0381)
--
-- Settings -> Trust & Permissions lets a family put an approval behind "Two
-- parents" (approval_model = 'two_parent'). Until 0381 that rule lived only in
-- lib/services/approvals/index.ts `decide()`, while `approval_requests_decide`
-- (0251:135-137) let any manager write any column of a pending row. So an adult
-- — the role `decide()` refuses — could PATCH `{"status":"approved"}` straight
-- through PostgREST, or write two parents' votes into `approvals` and then
-- flip, and the database said yes. lib/ai/runs/executor.ts reads only
-- `status`, so the gated step then ran with `skipTrust: true`.
--
-- Asserts, in both directions:
--
--   1. an ADULT cannot declare a two-parent row approved: not bare, not with
--      their own vote, not with forged votes naming both parents, and not as
--      'modified' (the executor treats it exactly like 'approved');
--   2. nobody can relax the rule on the way past: approval_model and
--      required_approvals are frozen — for the service role too;
--   3. a PARENT can record their own vote and leave the row pending, cannot
--      add the other parent's vote for them, and cannot flip on one vote;
--   4. the second parent's decide()-shaped write — append their own vote AND
--      flip, in one UPDATE — lands. A boundary that stops the honest path is
--      the wrong boundary;
--   5. a 'single' row still goes through on one adult's yes, and a "no" from
--      anyone still closes a row;
--   6. a write to an ALREADY-decided row that is not a decision (the
--      executed_at stamp stampExecution and the private-purchase result make)
--      still lands — including on a row decided before 0381 with no votes at
--      all, which is the shape the old Autopilot button minted. The threshold
--      belongs to the transition, not to every write after it;
--   7. the threshold helper is not a membership oracle: asked about a family
--      the caller is not in, it counts nothing; asked by that family's own
--      parent, the same question answers true. anon cannot call it;
--   8. the server (service role) is not newly refused a status write;
--   9. NEGATIVE CONTROL: drop ONLY 0381's decision trigger and require the
--      adult's bare flip AND the forged-votes flip to succeed again.
--  10. (0388) a decision once made stays made: a manager cannot re-open a
--      DECLINED row by taking the "no" away, cannot move a declined 'single'
--      row to approved on their own yes in one PATCH (0381's A and B both pass
--      that write), cannot un-expire a row, cannot reverse an approval, cannot
--      rewrite `edited_payload` after the deciding vote, cannot rewrite
--      `payload` on a PENDING row between the first yes and the second, and
--      cannot re-open a row decided before 0381; while the execution stamp on
--      a DECLINED row (decide()'s error path) still lands;
--  11. NEGATIVE CONTROL for 0388: drop ONLY its trigger, leave 0381's two in
--      place, and require the rejected->approved flip and the re-open to land.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/two-parents-means-two-parents-check.sql

\set FT '00000000-0000-4000-8000-000000038100'
\set UM '00000000-0000-4000-8000-000000038101'
\set UD '00000000-0000-4000-8000-000000038102'
\set UN '00000000-0000-4000-8000-000000038103'
\set FO '00000000-0000-4000-8000-000000038104'
\set UO '00000000-0000-4000-8000-000000038105'

begin;

insert into auth.users (id, email) values (:'UM','two-parents-mum@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UD','two-parents-dad@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UN','two-parents-nan@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UO','two-parents-other@example.com') on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FT','Two Parent House',:'UM') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FO','Next Door',:'UO') on conflict do nothing;

insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FT',:'UM','Mum','parent',true) on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FT',:'UD','Dad','parent',true) on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FT',:'UN','Nan','adult',true) on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FO',:'UO','Neighbour','parent',true) on conflict do nothing;
-- on_family_created provisions the creator; make the roles what the fixture
-- says rather than assuming, because a fixture whose roles are wrong proves
-- nothing.
update public.family_members set role = 'parent', is_active = true where family_id = :'FT' and user_id in (:'UM', :'UD');
update public.family_members set role = 'adult',  is_active = true where family_id = :'FT' and user_id = :'UN';
update public.family_members set role = 'parent', is_active = true where family_id = :'FO' and user_id = :'UO';

do $$
declare
  n         int;
  ok        boolean;
  st        text;
  failures  text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-000000038100';
  other_fam constant uuid := '00000000-0000-4000-8000-000000038104';
  mum_u     constant uuid := '00000000-0000-4000-8000-000000038101';
  dad_u     constant uuid := '00000000-0000-4000-8000-000000038102';
  nan_u     constant uuid := '00000000-0000-4000-8000-000000038103';
  other_u   constant uuid := '00000000-0000-4000-8000-000000038105';
  mum_m     uuid;
  dad_m     uuid;
  nan_m     uuid;
  other_m   uuid;
  two       uuid;   -- the two-parent row the parents decide properly
  two_b     uuid;   -- a two-parent row for the adult's 'modified' attempt
  two_c     uuid;   -- a two-parent row the negative control flips
  single_r  uuid;   -- a 'single' row one adult may decide
  reject_r  uuid;   -- a two-parent row an adult declines
  server_r  uuid;   -- a row the service role closes
  legacy    uuid;   -- decided before 0381, with no votes at all
  single_no uuid;   -- a 'single' row an adult declines, then tries to un-decline (0388)
begin
  select id into mum_m   from public.family_members where family_id = fam and user_id = mum_u;
  select id into dad_m   from public.family_members where family_id = fam and user_id = dad_u;
  select id into nan_m   from public.family_members where family_id = fam and user_id = nan_u;
  select id into other_m from public.family_members where family_id = other_fam and user_id = other_u;
  if mum_m is null or dad_m is null or nan_m is null or other_m is null then
    raise exception 'fixture is wrong: a member row is missing (mum %, dad %, nan %, other %)', mum_m, dad_m, nan_m, other_m;
  end if;

  insert into public.approval_requests (family_id, domain, title, requested_by_kind, agent, approval_model, required_approvals)
    values (fam, 'scheduling', 'Two-parent: soccer Saturday', 'ai', 'Concierge', 'two_parent', 1) returning id into two;
  insert into public.approval_requests (family_id, domain, title, requested_by_kind, agent, approval_model, required_approvals)
    values (fam, 'scheduling', 'Two-parent: modified door', 'ai', 'Concierge', 'two_parent', 1) returning id into two_b;
  insert into public.approval_requests (family_id, domain, title, requested_by_kind, agent, approval_model, required_approvals)
    values (fam, 'scheduling', 'Two-parent: negative control', 'ai', 'Concierge', 'two_parent', 1) returning id into two_c;
  insert into public.approval_requests (family_id, domain, title, requested_by_kind, agent, approval_model, required_approvals)
    values (fam, 'tasks', 'Single: add a task', 'ai', 'Concierge', 'single', 1) returning id into single_r;
  insert into public.approval_requests (family_id, domain, title, requested_by_kind, agent, approval_model, required_approvals)
    values (fam, 'scheduling', 'Two-parent: declined', 'ai', 'Concierge', 'two_parent', 1) returning id into reject_r;
  insert into public.approval_requests (family_id, domain, title, requested_by_kind, agent, approval_model, required_approvals)
    values (fam, 'tasks', 'Closed by the server', 'ai', 'Concierge', 'two_parent', 1) returning id into server_r;
  insert into public.approval_requests (family_id, domain, title, requested_by_kind, agent, approval_model, required_approvals, status, decided_at)
    values (fam, 'scheduling', 'Approved before 0381', 'ai', 'Concierge', 'two_parent', 1, 'approved', now()) returning id into legacy;
  insert into public.approval_requests (family_id, domain, title, requested_by_kind, agent, approval_model, required_approvals)
    values (fam, 'tasks', 'Single: declined, then un-declined', 'ai', 'Concierge', 'single', 1) returning id into single_no;

  -- ── As the ADULT ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  perform set_config('request.jwt.claim.sub', nan_u::text, true);

  -- 1a. The bare flip.
  begin
    update public.approval_requests set status = 'approved', decided_by = nan_m, decided_at = now() where id = two;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'an ADULT flipped a two-parent row to approved with no votes at all'); end if;
  exception when insufficient_privilege then null;
  end;

  -- 1b. Their own vote, then the flip — decide() refuses this for a non-parent.
  begin
    update public.approval_requests
       set status = 'approved',
           approvals = approvals || jsonb_build_array(jsonb_build_object('member_id', nan_m, 'decision', 'approved', 'role', 'parent'))
     where id = two;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'an ADULT approved a two-parent row on their own vote by calling themselves a parent'); end if;
  exception when insufficient_privilege then null;
  end;

  -- 1c. Forged votes naming both parents — both ids are one family_members read away.
  begin
    update public.approval_requests
       set status = 'approved',
           approvals = jsonb_build_array(
             jsonb_build_object('member_id', mum_m, 'decision', 'approved', 'role', 'parent'),
             jsonb_build_object('member_id', dad_m, 'decision', 'approved', 'role', 'parent'))
     where id = two;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'an ADULT wrote both parents'' votes into approvals and flipped the row — the threshold counts forgeries'); end if;
  exception when insufficient_privilege then null;
  end;

  -- 1d. The same forgery WITHOUT the flip, to pre-load the row for a later tap.
  begin
    update public.approval_requests
       set approvals = jsonb_build_array(jsonb_build_object('member_id', mum_m, 'decision', 'approved'))
     where id = two;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'an ADULT recorded a vote in MUM''s name on a pending row'); end if;
  exception when insufficient_privilege then null;
  end;

  -- 1e. 'modified' is the same door.
  begin
    update public.approval_requests
       set status = 'modified',
           approvals = approvals || jsonb_build_array(jsonb_build_object('member_id', nan_m, 'decision', 'approved'))
     where id = two_b;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'an ADULT moved a two-parent row to modified — reconcileApprovals runs that exactly like approved'); end if;
  exception when insufficient_privilege then null;
  end;

  -- 2. Relax the rule first.
  begin
    update public.approval_requests set approval_model = 'single' where id = two;
    failures := array_append(failures, 'an ADULT changed approval_model on a pending row — the threshold is one extra PATCH away');
  exception when raise_exception then null;
  end;
  begin
    update public.approval_requests set required_approvals = 0 where id = two;
    failures := array_append(failures, 'an ADULT changed required_approvals on a pending row');
  exception when raise_exception then null;
  end;

  -- 5a. A 'single' row: one adult's own yes is enough, as it always was.
  begin
    update public.approval_requests
       set status = 'approved', decided_by = nan_m, decided_at = now(),
           approvals = approvals || jsonb_build_array(jsonb_build_object('member_id', nan_m, 'decision', 'approved', 'role', 'adult'))
     where id = single_r;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, format('an ADULT''s own yes did not decide a single-approver row (%s rows)', n)); end if;
  exception when others then
    failures := array_append(failures, format('an ADULT''s own yes on a single-approver row was refused: %s %s', sqlstate, sqlerrm));
  end;

  -- 5b. One "no" from anyone still stops the AI.
  begin
    update public.approval_requests
       set status = 'rejected', decided_by = nan_m, decided_at = now(),
           approvals = approvals || jsonb_build_array(jsonb_build_object('member_id', nan_m, 'decision', 'rejected', 'role', 'adult'))
     where id = reject_r;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, format('an ADULT could not decline a two-parent row (%s rows)', n)); end if;
  exception when others then
    failures := array_append(failures, format('an ADULT''s "no" was refused: %s %s', sqlstate, sqlerrm));
  end;

  -- 5c. And a "no" on a single-approver row — the row 10b and the 0388
  --     negative control then try to un-decline.
  begin
    update public.approval_requests
       set status = 'rejected', decided_by = nan_m, decided_at = now(),
           approvals = approvals || jsonb_build_array(jsonb_build_object('member_id', nan_m, 'decision', 'rejected', 'role', 'adult'))
     where id = single_no;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, format('an ADULT could not decline a single-approver row (%s rows)', n)); end if;
  exception when others then
    failures := array_append(failures, format('an ADULT''s "no" on a single-approver row was refused: %s %s', sqlstate, sqlerrm));
  end;

  -- 7a. Not an oracle: a question about another family counts nothing.
  select public.approval_votes_satisfy(other_fam, 'single', 1,
    jsonb_build_array(jsonb_build_object('member_id', other_m, 'decision', 'approved'))) into ok;
  if ok then
    failures := array_append(failures, 'approval_votes_satisfy told a caller from ANOTHER family that a member id is an active manager there — a membership oracle past family_members'' RLS');
  end if;

  -- ── As MUM ──────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', mum_u::text, true);

  -- 3a. Her own vote, row stays pending — decide()'s first-of-two write.
  begin
    update public.approval_requests
       set approvals = approvals || jsonb_build_array(jsonb_build_object('member_id', mum_m, 'decision', 'approved', 'role', 'parent'))
     where id = two;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, format('MUM could not record her own vote (%s rows)', n)); end if;
  exception when others then
    failures := array_append(failures, format('MUM''s own vote was refused: %s %s', sqlstate, sqlerrm));
  end;

  -- 3b. One parent is not two.
  begin
    update public.approval_requests set status = 'approved', decided_by = mum_m, decided_at = now() where id = two;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'MUM flipped a two-parent row on her vote alone'); end if;
  exception when insufficient_privilege then null;
  end;

  -- 3c. Nor can she vote for Dad.
  begin
    update public.approval_requests
       set status = 'approved',
           approvals = approvals || jsonb_build_array(jsonb_build_object('member_id', dad_m, 'decision', 'approved', 'role', 'parent'))
     where id = two;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'MUM cast DAD''s vote for him and flipped the row'); end if;
  exception when insufficient_privilege then null;
  end;

  -- ── As DAD: the deciding vote, exactly the shape decide() writes ────────
  perform set_config('request.jwt.claim.sub', dad_u::text, true);
  begin
    update public.approval_requests
       set status = 'approved', decided_by = dad_m, decided_at = now(), reviewed_by = dad_m,
           approvals = approvals || jsonb_build_array(jsonb_build_object('member_id', dad_m, 'decision', 'approved', 'role', 'parent'))
     where id = two and status = 'pending';
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, format('the SECOND PARENT''s deciding vote did not land (%s rows) — decide() is broken', n)); end if;
  exception when others then
    failures := array_append(failures, format('the SECOND PARENT''s deciding vote was refused: %s %s', sqlstate, sqlerrm));
  end;

  -- 6. Stamps on decided rows are not decisions.
  begin
    update public.approval_requests set executed_at = now(), execution_result = 'Added to the calendar' where id = two;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, format('stampExecution could not stamp the row it had just decided (%s rows)', n)); end if;
  exception when others then
    failures := array_append(failures, format('stampExecution on a just-decided row was refused: %s %s', sqlstate, sqlerrm));
  end;
  begin
    update public.approval_requests set executed_at = now(), execution_result = 'Checked' where id = legacy;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, format('a stamp on a row decided BEFORE 0381 did not land (%s rows)', n)); end if;
  exception when others then
    failures := array_append(failures, format('a stamp on a row decided before 0381 was refused — the threshold is being re-checked on writes that decide nothing: %s %s', sqlstate, sqlerrm));
  end;

  -- ── As the OTHER family's parent: the helper does answer its own family ──
  perform set_config('request.jwt.claim.sub', other_u::text, true);
  select public.approval_votes_satisfy(other_fam, 'single', 1,
    jsonb_build_array(jsonb_build_object('member_id', other_m, 'decision', 'approved'))) into ok;
  if not coalesce(ok, false) then
    failures := array_append(failures, 'approval_votes_satisfy said no to a family''s own parent about their own family — 7a proves nothing if it always says no');
  end if;

  -- ── As the SERVER ───────────────────────────────────────────────────────
  perform set_config('role','service_role', true);
  -- 8. The server's own status writes are not newly refused.
  begin
    update public.approval_requests set status = 'expired', decided_at = now() where id = server_r;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, format('the SERVICE ROLE could not expire a row (%s rows)', n)); end if;
  exception when others then
    failures := array_append(failures, format('the SERVICE ROLE was refused a status write: %s %s', sqlstate, sqlerrm));
  end;
  -- 2 again, for the server: the family's rule is not Bubaly's to relax.
  begin
    update public.approval_requests set approval_model = 'single' where id = two_c;
    failures := array_append(failures, 'the SERVICE ROLE changed approval_model — the rule is not frozen for the server');
  exception when raise_exception then null;
  end;
  perform set_config('role','postgres', true);

  -- ── 10. A decision once made stays made (0388) ──────────────────────────
  -- Every row below is already decided (or, for 10g, still pending). 0381
  -- gates only the way INTO a decision; these are the ways OUT of one, each of
  -- which `approval_requests_decide` let a manager take with one PATCH.
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', nan_u::text, true);

  -- 10a. Re-open a declined two-parent row by taking the "no" away. 0381's A
  --      lets votes be removed; B does not run for a move to pending.
  begin
    update public.approval_requests
       set status = 'pending', approvals = '[]'::jsonb, decided_by = null, decided_at = null
     where id = reject_r;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'an ADULT re-opened a DECLINED two-parent row by removing the rejecting vote — a "no" is not final'); end if;
  exception when insufficient_privilege then null;
  end;

  -- 10b. Flip a declined 'single' row straight to approved on their own yes.
  --      A passes (one vote, their own) and B passes (one manager satisfies
  --      'single'); only 0388 stands between this write and the executor.
  begin
    update public.approval_requests
       set status = 'approved', decided_by = nan_m, decided_at = now(),
           approvals = approvals || jsonb_build_array(jsonb_build_object('member_id', nan_m, 'decision', 'approved', 'role', 'adult'))
     where id = single_no;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'an ADULT moved a DECLINED single-approver row to approved with one PATCH — reconcileApprovals would run it with skipTrust'); end if;
  exception when insufficient_privilege then null;
  end;

  -- 10c. Un-expire a row nobody answered.
  begin
    update public.approval_requests set status = 'pending', decided_at = null where id = server_r;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'an ADULT re-opened an EXPIRED row'); end if;
  exception when insufficient_privilege then null;
  end;

  -- 10d. The stamp decide() writes on its error path lands on a declined row:
  --      a decided row is frozen in its decision, not in every column.
  begin
    update public.approval_requests
       set executed_at = now(), execution_result = 'error: Bubaly could not work out what this approval would do'
     where id = reject_r;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, format('stampExecution could not stamp a DECLINED row (%s rows) — 0388 froze more than the decision', n)); end if;
  exception when others then
    failures := array_append(failures, format('a stamp on a declined row was refused: %s %s', sqlstate, sqlerrm));
  end;

  perform set_config('request.jwt.claim.sub', dad_u::text, true);

  -- 10e. Reverse an approval after the fact.
  begin
    update public.approval_requests set status = 'rejected' where id = two;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'a PARENT moved an APPROVED row to rejected — a decision is not a record'); end if;
  exception when insufficient_privilege then null;
  end;

  -- 10f. Change what an approved plan step will run, after both parents said yes.
  begin
    update public.approval_requests set edited_payload = '{"title":"something nobody voted on"}'::jsonb where id = two;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'a PARENT rewrote edited_payload on an APPROVED row — the executor runs that column'); end if;
  exception when insufficient_privilege then null;
  end;

  -- 10g. Rewrite the ask on a row that is still PENDING — between the first
  --      yes and the second.
  begin
    update public.approval_requests
       set payload = '{"name":"finances.transfer","args":{"amount_cents":900000}}'::jsonb
     where id = two_c;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'a PARENT rewrote payload on a PENDING row — the second parent would approve something the first never saw'); end if;
  exception when insufficient_privilege then null;
  end;

  -- 10h. A row decided before 0381, with no votes at all, is decided all the same.
  begin
    update public.approval_requests set status = 'pending' where id = legacy;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'a PARENT re-opened a row decided before 0381'); end if;
  exception when insufficient_privilege then null;
  end;

  perform set_config('role','postgres', true);

  select status into st from public.approval_requests where id = two;
  if st is distinct from 'approved' then
    failures := array_append(failures, format('the two-parent row ended at %L, not approved', st));
  end if;
  select status into st from public.approval_requests where id = reject_r;
  if st is distinct from 'rejected' then
    failures := array_append(failures, format('the declined two-parent row ended at %L, not rejected', st));
  end if;
  select status into st from public.approval_requests where id = single_no;
  if st is distinct from 'rejected' then
    failures := array_append(failures, format('the declined single-approver row ended at %L, not rejected', st));
  end if;

  -- 7b. The grant layer.
  if has_function_privilege('anon', 'public.approval_votes_satisfy(uuid, text, integer, jsonb)', 'EXECUTE') then
    failures := array_append(failures, 'anon may EXECUTE approval_votes_satisfy');
  end if;

  -- ── Negative control for 0388: prove this probe can SEE that defect ────
  -- Drop ONLY 0388's trigger, leaving 0381's two in place, and require the
  -- adult's one-PATCH flip of a DECLINED single-approver row and the re-open
  -- of a declined two-parent row to land — exactly what 0381 alone permitted.
  -- The outer rollback restores it.
  drop trigger if exists approval_requests_decision_is_final on public.approval_requests;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', nan_u::text, true);
  update public.approval_requests
     set status = 'approved', decided_by = nan_m, decided_at = now(),
         approvals = approvals || jsonb_build_array(jsonb_build_object('member_id', nan_m, 'decision', 'approved', 'role', 'adult'))
   where id = single_no;
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, format('with 0388''s trigger removed the adult''s rejected->approved flip touched %s row(s) — that defect did not reproduce, so 10b proves nothing', n));
  end if;
  update public.approval_requests
     set status = 'pending', approvals = '[]'::jsonb, decided_by = null, decided_at = null
   where id = reject_r;
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, format('with 0388''s trigger removed the adult''s re-open of a declined row touched %s row(s) — the defect did not reproduce', n));
  end if;
  perform set_config('role','postgres', true);
  select status into st from public.approval_requests where id = single_no;
  if st is distinct from 'approved' then
    failures := array_append(failures, format('with 0388''s trigger removed the declined single row ended at %L, not approved — the negative control did not reproduce the flip', st));
  end if;

  -- ── Negative control: prove this probe can SEE the defect ──────────────
  -- Drop ONLY 0381's decision trigger. The outer rollback restores it.
  drop trigger if exists approval_requests_decision_is_earned on public.approval_requests;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', nan_u::text, true);
  update public.approval_requests
     set status = 'approved',
         approvals = jsonb_build_array(
           jsonb_build_object('member_id', mum_m, 'decision', 'approved'),
           jsonb_build_object('member_id', dad_m, 'decision', 'approved'))
   where id = two_c;
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, format('with the trigger removed the adult''s forged-votes flip touched %s row(s) — this probe has never been shown to fail', n));
  end if;
  update public.approval_requests set status = 'modified' where id = two_b;
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, format('with the trigger removed the adult''s bare flip touched %s row(s) — the defect did not reproduce', n));
  end if;
  perform set_config('role','postgres', true);

  if array_length(failures, 1) is not null then
    raise exception E'"Two parents" is not a rule the database keeps:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'two-parents-means-two-parents: OK (an adult cannot approve or modify a two-parent row bare, on their own vote, or with forged parent votes; the rule columns are frozen for everyone; a parent votes only for herself and one vote is not two; the second parent''s decide()-shaped write lands; single rows and a "no" still work; stamps on decided rows, including pre-0381 ones, still land; the helper is not an oracle and anon cannot call it; the server is not newly refused; negative control reproduced both flips; 0388: a declined, approved, expired or pre-0381 row cannot be re-opened, reversed or re-edited and a pending ask cannot be rewritten, while a stamp on a declined row lands, and its negative control reproduced the rejected->approved flip and the re-open)';
end $$;

rollback;
