-- ── ai_score holds a number the AI produced, not one a child typed (0331) ──
--
-- `chore_assignments.ai_score` was added by `00430_chore_missions.sql` and has
-- not appeared in a migration since. The table's policies are `0004_rls.sql`'s
-- role-blind CRUD set; its BEFORE trigger guards the decision status (`0223`)
-- and the award amounts (`0305`) and nothing else.
--
-- Where the column ends up is money. `approveSubmissionAction`
-- (app/(app)/missions/actions.ts ~L305) computes
--
--   const score = intVal(formData, 'score') ?? assignment.ai_score ?? 100;
--
-- -> `finalizeApproval` -> `computeReward(rewardConfig(chore), score)`, which
-- for `reward_mode = 'ai_cash'` is `scaleByScore(cash_min_cents,
-- cash_max_cents, score)`. The result is written to `cash_awarded_cents` in the
-- PARENT'S session — which is how it satisfies `0305` — and
-- `payChoreRewardAction` credits the wallet from that column.
--
-- A blanket manager guard on this column would be WRONG, and proving BOTH
-- halves is the point of this probe. `submitProofAction`
-- (app/(app)/missions/actions.ts ~L194) writes `ai_score` in the SUBMITTING
-- CHILD'S own RLS-bound session:
--
--   await supabase.from('chore_assignments')
--     .update({ ai_score: verdict.quality_score, submitted_at: … })
--
-- so "a non-manager may not write ai_score" returns 42501 on the normal submit
-- path for every child in the family. `restoreAssignmentState` (~L54) is the
-- second member-session writer, putting the previous value back on that
-- action's failure paths.
--
-- So `0331` PINS the column instead of refusing it: a non-manager may set it
-- only to a `quality_score` a service-written `chore_ai_validations` row
-- produced for one of this assignment's own submissions, by this member. That
-- table is genuinely SELECT-only for members (`00430` ~L213 creates a SELECT
-- policy and no other), which is what makes it a sound anchor.
--
-- Asserts, in both directions:
--
--   1. POSITIVE: a child can still run submitProofAction's own write — set
--      ai_score to the score the service-written validation carries — and the
--      rollback that clears it again;
--   2. POSITIVE: 0223's and 0305's member-allowed writes are untouched (a
--      child still ticks a chore 'done' and still creates assignments);
--   3. a child CANNOT type a score nothing vouched for, on UPDATE;
--   4. a child CANNOT be born with one, on INSERT (unique_violation is caught
--      separately and reported as a breach: RLS and triggers run before a
--      unique index, so an insert that reaches one was let through);
--   5. a child CANNOT set status and a forged score in one statement;
--   6. the pin is PER ASSIGNMENT: a real 100 the AI gave one assignment cannot
--      be moved onto another;
--   7. 0223 and 0305 still hold — status='approved', points_awarded and
--      cash_awarded_cents are still refused (this probe re-creates the guard
--      function, so it has to prove it did not drop their guarantees);
--   8. a MANAGER can still set the score, approve, and set the amounts;
--   9. reads are untouched;
--  10. NEGATIVE CONTROL: restore the guard function to its exact pre-0331
--      (0305) body — leaving `chore_assignments_update` and the other three
--      permissive policies exactly as they were — and require the child's
--      forged 100 to succeed again, quoting the cash the parent's approval
--      would then have paid.
--
-- The guard is a trigger, not a policy, so a refusal arrives as a raised
-- exception rather than as zero rows. Both are checked: an UPDATE that changed
-- a row is a breach whether or not anything was raised.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/ai-score-is-not-the-childs-to-write-check.sql

\set FA  '00000000-0000-4000-8000-0000000a5c00'
\set UP  '00000000-0000-4000-8000-0000000a5c01'
\set UK  '00000000-0000-4000-8000-0000000a5c02'
\set MK  '00000000-0000-4000-8000-0000000a5c03'
\set CH  '00000000-0000-4000-8000-0000000a5c04'
\set AS1 '00000000-0000-4000-8000-0000000a5c05'
\set SB1 '00000000-0000-4000-8000-0000000a5c06'
\set VA1 '00000000-0000-4000-8000-0000000a5c07'
\set AS2 '00000000-0000-4000-8000-0000000a5c08'
\set SB2 '00000000-0000-4000-8000-0000000a5c09'
\set VA2 '00000000-0000-4000-8000-0000000a5c0a'

begin;

insert into auth.users (id, email) values (:'UP','ai-score-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','ai-score-kid@example.com')    on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FA','Score House',:'UP') on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MK',:'FA',:'UK','Kid','child',true) on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FA' and user_id = :'UP';

-- An AI-priced chore: the payout is scaleByScore(cash_min_cents,
-- cash_max_cents, score), so the score IS the money.
insert into public.chores (id, family_id, title, created_by, reward_mode, cash_min_cents, cash_max_cents)
  values (:'CH', :'FA', 'Mow the lawn', :'UP', 'ai_cash', 100, 5000);

-- Assignment 1: the child's own, with a service-written verdict of 72.
insert into public.chore_assignments (id, family_id, chore_id, member_id, status)
  values (:'AS1', :'FA', :'CH', :'MK', 'submitted');
insert into public.chore_submissions (id, family_id, assignment_id, chore_id, member_id, status, note)
  values (:'SB1', :'FA', :'AS1', :'CH', :'MK', 'pending', 'all done');
insert into public.chore_ai_validations (id, family_id, submission_id, status, quality_score, confidence)
  values (:'VA1', :'FA', :'SB1', 'parent_review_required', 72, 80);

-- Assignment 2: a different chore of the same child's that the AI really did
-- score 100. The pin must not let that 100 travel to assignment 1.
insert into public.chore_assignments (id, family_id, chore_id, member_id, status)
  values (:'AS2', :'FA', :'CH', :'MK', 'submitted');
insert into public.chore_submissions (id, family_id, assignment_id, chore_id, member_id, status)
  values (:'SB2', :'FA', :'AS2', :'CH', :'MK', 'pending');
insert into public.chore_ai_validations (id, family_id, submission_id, status, quality_score, confidence)
  values (:'VA2', :'FA', :'SB2', 'approved', 100, 95);

grant select, insert, update, delete on public.chore_assignments to authenticated;

do $probe$
declare
  n int;
  final_score int;
  failures text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-0000000a5c00';
  parent_u  constant uuid := '00000000-0000-4000-8000-0000000a5c01';
  kid_u     constant uuid := '00000000-0000-4000-8000-0000000a5c02';
  kid_m     constant uuid := '00000000-0000-4000-8000-0000000a5c03';
  chore     constant uuid := '00000000-0000-4000-8000-0000000a5c04';
  assign1   constant uuid := '00000000-0000-4000-8000-0000000a5c05';
  born      uuid;
  paid_fair int;
  paid_forged int;
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- 1. submitProofAction's own write, in the child's session. This is the
  --    feature; a guard that stopped it would 42501 every child's submit.
  begin
    update public.chore_assignments
       set ai_score = 72, submitted_at = now()
     where id = assign1 and family_id = fam;
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, 'a CHILD could not write the AI''s own score onto their assignment — submitProofAction (~L194) runs in the submitting child''s session and is now broken for every child');
    end if;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a CHILD could not write the AI''s own score onto their assignment — submitProofAction (~L194) runs in the submitting child''s session and is now broken for every child');
  end;

  -- …and restoreAssignmentState's rollback, which clears it again.
  begin
    update public.chore_assignments set ai_score = null where id = assign1;
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, 'a CHILD could not clear ai_score — restoreAssignmentState (~L54) rolls this column back in the member''s own session');
    end if;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a CHILD could not clear ai_score — restoreAssignmentState (~L54) rolls this column back in the member''s own session');
  end;
  update public.chore_assignments set ai_score = 72 where id = assign1;

  -- 2. 0223's member-allowed statuses still work, and creating an assignment
  --    without a score still works (dashboard/migrate and createChoreAction).
  begin
    update public.chore_assignments set status = 'done' where id = assign1;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, 'a member could no longer tick their own chore ''done'' — 0223 allows this and this probe''s guard must not have taken it away'); end if;
    update public.chore_assignments set status = 'submitted' where id = assign1;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a member could no longer tick their own chore ''done'' — 0223 allows this and this probe''s guard must not have taken it away');
  end;

  begin
    insert into public.chore_assignments (family_id, chore_id, member_id, status)
      values (fam, chore, kid_m, 'todo') returning id into born;
    if born is null then failures := array_append(failures, 'a member could not create a scoreless assignment'); end if;
    delete from public.chore_assignments where id = born;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a member could not create a scoreless assignment — createChoreAction and the migrate importer both do this');
  end;

  -- 3. A score nothing vouched for.
  begin
    update public.chore_assignments set ai_score = 100 where id = assign1;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a child raised ai_score to 100 on %s of their own assignment(s) — approveSubmissionAction falls back to that number and computeReward scales an ai_cash payout from it', n)); end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. Born with one.
  begin
    insert into public.chore_assignments (family_id, chore_id, member_id, status, ai_score)
      values (fam, chore, kid_m, 'submitted', 100);
    failures := array_append(failures, 'a child INSERTED an assignment that was born carrying ai_score = 100');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s pre-scored chore_assignments INSERT reached a unique index, so the guard did not refuse it');
  end;

  -- 5. Status and a forged score in one statement — the shape 0305 exists for.
  begin
    update public.chore_assignments set status = 'done', ai_score = 100 where id = assign1;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a child set status and a forged ai_score together on %s row(s)', n)); end if;
  exception when insufficient_privilege then null;
  end;

  -- 6. The pin is per assignment: a real 100 from another of the child's own
  --    assignments must not travel onto this one.
  begin
    update public.chore_assignments set ai_score = 100 where id = assign1;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a child moved a 100 the AI gave a DIFFERENT assignment onto %s row(s) of this one', n)); end if;
  exception when insufficient_privilege then null;
  end;

  -- 7. 0223 and 0305 must still hold — this migration re-creates their
  --    function, so their guarantees are this probe's business too.
  begin
    update public.chore_assignments set status = 'approved' where id = assign1;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a child self-APPROVED %s assignment(s) — 0223''s guarantee was dropped when the function was re-created', n)); end if;
  exception when insufficient_privilege then null;
  end;

  begin
    update public.chore_assignments set points_awarded = 9999 where id = assign1;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a child set points_awarded on %s assignment(s) — 0305''s guarantee was dropped when the function was re-created', n)); end if;
  exception when insufficient_privilege then null;
  end;

  begin
    update public.chore_assignments set cash_awarded_cents = 500000 where id = assign1;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a child set cash_awarded_cents on %s assignment(s) — 0305''s guarantee was dropped when the function was re-created', n)); end if;
  exception when insufficient_privilege then null;
  end;

  -- 8. Reads stay open, deliberately: /kids and /missions are RLS-bound reads
  --    with no role gate.
  select count(*) into n from public.chore_assignments where id = assign1;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ their own assignment — that is a change of decision; update finalaudit.md and this probe');
  end if;

  -- The score must have survived every attempt above unchanged.
  perform set_config('role','postgres', true);
  select ai_score into final_score from public.chore_assignments where id = assign1;
  if final_score is distinct from 72 then
    failures := array_append(failures, format('the assignment ended at ai_score %s, not the 72 the AI gave it — a child changed the number the payout is computed from', final_score));
  end if;

  -- ── As the parent: the positive control ─────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  update public.chore_assignments set ai_score = 90 where id = assign1;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not set ai_score — a parent deciding what the work was worth is the feature, and the guard refuses everyone'); end if;

  update public.chore_assignments
     set status = 'approved', approved_at = now(), points_awarded = 10, cash_awarded_cents = 4600
   where id = assign1;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not approve and set the award amounts — finalizeApproval runs in the parent''s session and is broken'); end if;

  perform set_config('role','postgres', true);
  update public.chore_assignments set status = 'submitted', ai_score = 72, points_awarded = null, cash_awarded_cents = null, approved_at = null where id = assign1;

  -- ── Negative control: prove this probe can SEE the defect ──────────────
  -- Put the guard function back to its EXACT pre-0331 body (0305's), leaving
  -- chore_assignments_select/_insert/_update/_delete exactly as they are —
  -- which is precisely the pre-0331 state. The outer rollback undoes this
  -- along with everything else.
  execute $ctl$
    create or replace function public.chore_assignment_decision_guard()
    returns trigger
    language plpgsql
    security definer
    set search_path = public, pg_temp
    as $g305$
    declare
      deciding boolean;
      amount_changed boolean;
    begin
      deciding := new.status in ('approved','rejected')
        and (tg_op = 'INSERT' or new.status is distinct from old.status);
      amount_changed := case
        when tg_op = 'INSERT' then
          coalesce(new.points_awarded, 0) <> 0 or coalesce(new.cash_awarded_cents, 0) <> 0
        else
          new.points_awarded is distinct from old.points_awarded
          or new.cash_awarded_cents is distinct from old.cash_awarded_cents
      end;
      if deciding or amount_changed then
        if current_user = 'service_role'
           or coalesce(auth.role(), '') = 'service_role'
           or auth.uid() is null
           or public.can_manage_family(new.family_id) then
          return new;
        end if;
        if deciding then
          raise exception
            'chore assignment status % may only be set by a family manager', new.status
            using errcode = '42501';
        end if;
        raise exception
          'chore assignment award amounts may only be set by a family manager'
          using errcode = '42501';
      end if;
      return new;
    end;
    $g305$;
  $ctl$;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  update public.chore_assignments set ai_score = 100 where id = assign1;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with only 0223 and 0305 in place the child STILL could not raise their own ai_score — this probe is decoration, not a boundary');
  end if;

  perform set_config('role','postgres', true);
  select ai_score into final_score from public.chore_assignments where id = assign1;
  if final_score is distinct from 100 then
    failures := array_append(failures, format('with the ai_score pin removed the score did not end up 100 (got %s) — this probe has never been shown to fail', final_score));
  end if;

  -- What that number was worth, in the parent's own approval path:
  -- computeReward -> scaleByScore(cash_min_cents, cash_max_cents, score).
  select round(100 + ((5000 - 100) * 72) / 100.0)::int  into paid_fair;
  select round(100 + ((5000 - 100) * 100) / 100.0)::int into paid_forged;

  if array_length(failures, 1) is not null then
    raise exception E'ai_score is not the child''s to write (AUTHZ-014, 0331):\n  - %\n  (for this fixture the parent''s approval would pay % cents at the AI''s 72 and % cents at a forged 100)',
      array_to_string(failures, E'\n  - '), paid_fair, paid_forged;
  end if;
  raise notice 'ai-score-is-not-the-childs-to-write: OK (a child still writes the AI''s own score and clears it; a typed or borrowed score is refused; 0223 status and 0305 amounts still hold; a manager is unaffected; negative control reproduced the forged 100, worth % cents instead of %)', paid_forged, paid_fair;
end $probe$;

rollback;
