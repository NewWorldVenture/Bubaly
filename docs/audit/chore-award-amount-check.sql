-- What the approval was WORTH, not just who made it.
--
-- 0223 stops a child moving their own chore assignment into 'approved'. It
-- says nothing about `points_awarded` and `cash_awarded_cents`, and a child may
-- legitimately set their own assignment to 'done' — so both amounts could be
-- written in that same statement.
--
-- The cash column is the one with teeth: payChoreRewardAction credits a child's
-- wallet with `assignment.cash_awarded_cents ?? chore.cash_cents`. The chores
-- board hides its Pay button while that column is truthy, which happens to
-- block the ordinary click path — an accident of a condition written for
-- idempotency, not a boundary.
--
-- Judged on ROW COUNTS: an UPDATE refused by a policy raises, but one refused
-- by nothing simply lands, and an exception-only assertion would report a
-- boundary that is not there.
--
-- NEGATIVE CONTROL, and it runs FIRST, before the refusals it gives meaning to
-- ---------------------------------------------------------------------------
-- MECHANISM. This boundary is not RLS. `chore_assignments` carries
-- `0004_rls.sql`'s role-blind CRUD set — four permissive policies, all
-- `is_family_member(family_id)` — and no later migration replaces or narrows
-- them. Do NOT look for the policy names in the migrations: 0004 builds them in
-- a loop (`foreach t in array fam_tables` … `execute format('create policy
-- %1$s_select on public.%1$I' …)`), so `grep chore_assignments_update
-- supabase/migrations` returns NOTHING — an earlier version of this comment
-- claimed it returned 0004, which no one re-running it could reproduce. The
-- reproducible check is membership: 'chore_assignments' is an element of
-- 0004's `fam_tables` (L22), and `grep -rln 'create policy' supabase/migrations
-- | xargs grep -ln chore_assignments` returns exactly 0004 and 0174, where 0174
-- names this table only in a comment and creates its policies on
-- `workload_snapshots`. Because a sentence like that can go stale, the probe
-- also ASSERTS the catalog (0b below): RLS enabled, exactly four permissive
-- policies, every predicate `is_family_member(family_id)`.
--
-- What refuses checks 2-5 is a BEFORE INSERT OR UPDATE TRIGGER,
-- `trg_chore_assignment_decision_guard`, and 0b asserts that too — installed,
-- enabled, BEFORE / ROW / INSERT and UPDATE, executing
-- `public.chore_assignment_decision_guard()`, whose body still asks
-- `can_manage_family(new.family_id)` and still raises the award-amount message.
-- Behaviour alone cannot make that attribution: a policy tightened to
-- `can_manage_family` would refuse check 5's INSERT with the same 42501, and
-- the control — a manager in its own family — would still land.
--
-- And the body under test is the LAST one written, not 0223's and not 0305's.
-- `0223` created the function, `0305` added the award-amount rule, and
-- `0331_ai_score_is_not_the_childs_to_write.sql` (L114) does `create or
-- replace` on it for the third time and re-creates the trigger. 0331 is the
-- last of the three hits for `chore_assignment_decision_guard` across
-- supabase/migrations, so 0331's body is the one running; it carries 0305's
-- amount rule through verbatim, which is why the checks below still read the
-- way 0305 wrote them.
--
-- In that body the amount branch is exactly one question:
--
--   amount_changed and not (service_role or auth.uid() is null
--                           or public.can_manage_family(new.family_id))
--
-- One question is all the boundary is, so the control is the same child, the
-- same trigger and the same two verbs in a SECOND family where that child IS a
-- manager: the same actor through the same predicate with the answer the other
-- way, which must land. `ctl_fam` is a household the child created, so
-- `can_manage_family` answers YES there for the very user it answers no for in
-- `fam`. Nothing else about the statements changes.
--
-- Without it, checks 2-5 are refusals with no attribution: each catches
-- `insufficient_privilege` and credits the guard, but 42501 is also what a
-- COLUMN-level denial of `points_awarded` or `cash_awarded_cents` raises, and
-- what any second guard trigger raises. This repository refuses writes with
-- guard triggers in 0223, 0305, 0326 and 0331, and three other triggers already
-- fire on this very table — 0311's pair of `reference_shares_family` guards,
-- which refuse with 42501, and 0003's `set_updated_at`, which refuses nothing —
-- so a second guard here is not hypothetical. A guard that returns NULL instead
-- of raising is quieter still: the row is dropped, nothing is raised, ROW_COUNT
-- is 0, and the zero-row arms of checks 2-5 would read that as the boundary
-- holding. Both legs of the control demand ROW_COUNT 1, so a silent swallow on
-- these columns fails the control instead of passing the checks.
--
-- Two refusals the control also catches were ALREADY caught, and are not
-- credited to it: a table-wide `revoke insert, update on chore_assignments`
-- fails step 1 (a child could not tick their own chore done), and a dead
-- `auth.uid()` fails the `is_family_member(fam)` precondition before block 0.
-- The control merely reports them first. Likewise "a row this session cannot
-- see or cannot write reports zero" is answered for `asg` by step 1, which
-- updates `asg` itself and must move one row — not by the control, which
-- writes its own row in ctl_fam. What the control ALONE proves is narrow and
-- worth having: the child's session holds the column privileges checks 2-5
-- exercise, and nothing on this table but the guard's predicate stands between
-- that session and these two columns.
--
-- The control's UPDATE names THE SAME THREE COLUMNS check 4 writes — `status`,
-- `points_awarded` AND `cash_awarded_cents` — and that is not decoration. A
-- column-level denial of `cash_awarded_cents` (`revoke update on
-- public.chore_assignments from authenticated; grant update (status, …) …`
-- naming every column but that one — a bare `revoke update (col)` is a no-op
-- while the table-level grant stands) sails straight past a control that only
-- touches `status`, which is all step 1 does: step 1 is a real positive control
-- for the member-allowed path, but it proves nothing about the two guarded
-- columns because it never names them. Postgres checks column privileges
-- against the SET list and not against the values, so writing both amounts onto
-- the control's OWN row — in the family the child DOES manage — is the whole of
-- that proof. The control's INSERT names check 5's column list for the same
-- reason. (Denying `status` would fail the control too, but it fails step 1
-- just the same, and a child who cannot tick a chore done is a broken feature:
-- that red is not a false one.)
--
-- Step 7's manager write does not cover either: it proves the guard lets
-- SOMEBODY through, not that the CHILD's session could have written these two
-- columns at all.
--
-- If the control is refused, the probe reports this boundary as UNPROVEN
-- rather than as holding, and stops — every check after it would be
-- unreadable, and a build that cannot tell is red either way.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000000ca01';
  parent_uid uuid := '00000000-0000-4000-8000-00000000caa1';
  child_uid  uuid := '00000000-0000-4000-8000-00000000caa2';
  child_mid uuid;
  chore_id uuid;
  asg uuid;
  n int;
  failures int := 0;
  -- ── the negative control's own household ─────────────────────────────────
  -- A SECOND family the SAME child manages, so `can_manage_family(new.family_id)`
  -- — the one question the guard asks — answers yes for the very user it answers
  -- no for in `fam`. Checked unique across docs/audit and supabase/migrations:
  -- every probe in docs/audit shares one database (run-probes.sh globs them
  -- into it) and seeded rows outlive the probe that wrote them, so a reused
  -- anchor would silently rewrite somebody else's assertion.
  ctl_fam   uuid := '00000000-0000-4000-8000-00000000ca02';
  ctl_mid   uuid;
  ctl_chore uuid;
  ctl_asg   uuid;
  ctl_fail  text[] := '{}';
  -- ── 0b's catalog reads ───────────────────────────────────────────────────
  guard_src text;
  n_pol     int;
  n_blind   int;
begin
  delete from public.chore_assignments where family_id = fam;
  delete from public.chores where family_id = fam;
  -- An earlier version of this probe tore down only the control's assignments
  -- and left the household itself behind; sweep whatever a rerun finds, so the
  -- seed below is a fresh family and not a leftover. Everything that hangs off
  -- `families` cascades (0002, 0257, 0134 all declare `on delete cascade`), and
  -- 0299's manager guard is explicitly not a violation once the families row is
  -- gone.
  delete from public.chore_assignments where family_id = ctl_fam;
  delete from public.chores where family_id = ctl_fam;
  delete from public.family_members where family_id = ctl_fam;
  delete from public.families where id = ctl_fam;

  insert into auth.users (id, email) values
    (parent_uid, 'chore-parent@example.com'), (child_uid, 'chore-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Chore Awards', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;
  select id into child_mid from public.family_members where family_id = fam and user_id = child_uid;

  insert into public.chores (family_id, title, points) values (fam, 'Dishes', 5) returning id into chore_id;
  insert into public.chore_assignments (family_id, chore_id, member_id, status)
    values (fam, chore_id, child_mid, 'todo') returning id into asg;

  -- ── the negative control's household ─────────────────────────────────────
  -- Seeded here, while the trusted server's exemption is still in force
  -- (`auth.uid()` is null until the set_config below), exactly as `fam` is. The
  -- control's chore and member live in ctl_fam because 0311's two
  -- `reference_shares_family` triggers require a row's references to share the
  -- row's family — a control that tripped THOSE would fail for a reason that is
  -- not the control's.
  insert into public.families (id, name, created_by)
    values (ctl_fam, 'Chore Awards (the child manages this one)', child_uid)
  on conflict (id) do nothing;
  -- on_family_created already files the creator as a 'parent'; upsert rather
  -- than assume, because a seed whose roles are wrong would fail the control
  -- for a reason that is not the control's either.
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (ctl_fam, child_uid, 'Child (a manager here)', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
  select id into ctl_mid from public.family_members where family_id = ctl_fam and user_id = child_uid;

  insert into public.chores (family_id, title, points)
    values (ctl_fam, 'Dishes (control house)', 5) returning id into ctl_chore;
  -- No amounts on the seeded row, deliberately: the control's UPDATE has to be
  -- an actual CHANGE to both columns or `amount_changed` is false and the guard
  -- is never reached, which would make the control pass without testing it.
  insert into public.chore_assignments (family_id, chore_id, member_id, status)
    values (ctl_fam, ctl_chore, ctl_mid, 'todo') returning id into ctl_asg;

  -- ── as the child ─────────────────────────────────────────────────────────
  -- Set BEFORE dropping role, or auth.uid() is null and the guard waves it
  -- through as the trusted server — every assertion below would pass falsely.
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;
  -- The control's own precondition: the SAME session must be a manager of
  -- ctl_fam, or the control is not this predicate answered the other way and
  -- its failure would say nothing about the guard.
  if not public.can_manage_family(ctl_fam) then
    raise exception 'CONTROL FAILED: this child is not a manager of the control family %, so the control below is not the same predicate with the answer the other way', ctl_fam;
  end if;

  -- 0. NEGATIVE CONTROL — the same child, the same trigger, the other answer.
  --    Runs BEFORE checks 2-5, because it is what makes their refusals mean
  --    "the guard said no" rather than "something said no". Both legs must
  --    LAND, and land as ONE ROW: a column-level denial of either amount column
  --    or a second guard trigger keyed on them would raise here too, and a
  --    guard that swallows the row instead of raising would report 0 here —
  --    where checks 2-5 would have read every one of those as the boundary
  --    holding.
  begin
    -- The same three columns check 4 writes, and the same values.
    update public.chore_assignments
       set status = 'done', points_awarded = 9999, cash_awarded_cents = 500000
     where id = ctl_asg;
    get diagnostics n = row_count;
    if n <> 1 then
      ctl_fail := array_append(ctl_fail, format(
        'this child''s UPDATE of status + points_awarded + cash_awarded_cents in the family they DO manage changed %s rows, not 1 — a trigger that returns NULL drops the row without raising, and would drop checks 2-5''s writes just as quietly, leaving their zero-row arms to credit the guard', n));
    end if;
  exception when others then
    ctl_fail := array_append(ctl_fail, format(
      'this child was refused status + points_awarded + cash_awarded_cents in the family they DO manage (%s: %s) — so checks 2-4 catching insufficient_privilege would prove only that something said no, not that the award guard said it', sqlstate, sqlerrm));
  end;

  begin
    -- Check 5's column list, in the family the child manages.
    insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded, cash_awarded_cents)
    values (ctl_fam, ctl_chore, ctl_mid, 'done', 9999, 500000);
    get diagnostics n = row_count;
    -- Not a dead arm. RLS refuses an INSERT by raising, but a BEFORE INSERT
    -- trigger that returns NULL skips the row and reports `INSERT 0 0` with no
    -- error at all — the one refusal that neither raises nor lands.
    if n <> 1 then
      ctl_fail := array_append(ctl_fail, format(
        'this child''s INSERT of an assignment carrying both award amounts in the family they DO manage stored %s rows, not 1 — a BEFORE INSERT trigger returning NULL is the one refusal that neither raises nor lands, and check 5''s zero-row arm would have credited it to the guard', n));
    end if;
  exception when others then
    ctl_fail := array_append(ctl_fail, format(
      'this child was refused an INSERT carrying both award amounts in the family they DO manage (%s: %s) — so check 5''s insufficient_privilege would prove only that something said no', sqlstate, sqlerrm));
  end;

  -- The control's household does not outlive the control — none of it. Not
  -- only the assignment carrying 9999 points and $5,000: the `families` row,
  -- the `family_members` row that made this child a 'parent' somewhere, the
  -- chore, and the `subscriptions`, `family_ai_settings` and
  -- `family_model_dirty` rows that on_family_created (0257) and
  -- trg_mark_model_dirty (0134) filed for it. Every probe shares this database,
  -- and one that later picks "some other family" or counts where this child
  -- is a manager would otherwise inherit them. Deleting the families row
  -- cascades to all of it; the item rows go first anyway so a failure names
  -- its table. 0299's trg_family_keeps_a_manager is DEFERRABLE INITIALLY
  -- DEFERRED and returns without objection once the families row is gone —
  -- chore-price-check.sql and money-write-boundary-check.sql tear down their
  -- ctl_fam the same way. On the UNPROVEN path none of this is needed: the
  -- raise below aborts the transaction and the seed rolls back with it.
  reset role;
  delete from public.chore_assignments where family_id = ctl_fam;
  delete from public.chores where family_id = ctl_fam;
  delete from public.family_members where family_id = ctl_fam;
  delete from public.families where id = ctl_fam;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- A failed control makes every refusal below unreadable. The boundary is not
  -- reported as holding and it is not reported as broken: it is reported as
  -- unproven, here, while the reason is still in hand.
  if array_length(ctl_fail, 1) is not null then
    raise exception 'chore award amount boundary UNPROVEN (the control this probe rests on did not hold): %', array_to_string(ctl_fail, ' | ');
  end if;

  -- 0b. The mechanism is the one the header credits. 0331's own post-install
  --     block asserts the trigger exists; this asserts what that block cannot
  --     see — enabled, BEFORE / ROW / INSERT and UPDATE, still executing 0331's
  --     function, whose body still asks the one question and still raises the
  --     amount message — and that 0004's four policies are still role-blind, so
  --     a 42501 below is the guard's and not a policy's. Counted as failures
  --     rather than raised: a missing guard also makes checks 2-5 land, and a
  --     red build should name both.
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.chore_assignments'::regclass
       and tgname = 'trg_chore_assignment_decision_guard'
       and not tgisinternal
       and tgenabled in ('O', 'A')
       and tgtype & 23 = 23  -- ROW(1) | BEFORE(2) | INSERT(4) | UPDATE(16)
       and tgfoid = to_regprocedure('public.chore_assignment_decision_guard()')
  ) then
    raise warning 'ATTRIBUTION FAILED: trg_chore_assignment_decision_guard is no longer what 0331 installs — an enabled BEFORE INSERT OR UPDATE row trigger on public.chore_assignments executing public.chore_assignment_decision_guard() — so a refusal below cannot be credited to it';
    failures := failures + 1;
  end if;
  select prosrc into guard_src
    from pg_proc where oid = to_regprocedure('public.chore_assignment_decision_guard()');
  if guard_src is null
     or guard_src not like '%can_manage_family(new.family_id)%'
     or guard_src not like '%award amounts may only be set by a family manager%' then
    raise warning 'ATTRIBUTION FAILED: chore_assignment_decision_guard() no longer asks can_manage_family(new.family_id) and raises the award-amount refusal, so the refusals below are not 0305''s rule as 0331 carries it';
    failures := failures + 1;
  end if;
  select count(*),
         count(*) filter (
           where polpermissive
             and coalesce(replace(pg_get_expr(polqual, polrelid), 'public.', ''), 'is_family_member(family_id)') = 'is_family_member(family_id)'
             and coalesce(replace(pg_get_expr(polwithcheck, polrelid), 'public.', ''), 'is_family_member(family_id)') = 'is_family_member(family_id)')
    into n_pol, n_blind
    from pg_policy
   where polrelid = 'public.chore_assignments'::regclass;
  if n_pol <> 4 or n_blind <> 4
     or not (select relrowsecurity from pg_class where oid = 'public.chore_assignments'::regclass) then
    raise warning 'ATTRIBUTION FAILED: chore_assignments no longer carries exactly 0004''s four permissive is_family_member(family_id) policies with RLS enabled (% policies, % of them role-blind), so a 42501 below may be a policy''s and not the guard''s', n_pol, n_blind;
    failures := failures + 1;
  end if;

  -- 1. Ticking a chore done is theirs to do — the positive control. A guard
  --    that blocked this would have broken the feature rather than closed the
  --    hole, and every refusal below would mean nothing. This is also what
  --    proves `asg` is visible and writable to this session, so a zero-row
  --    result in checks 2-4 is a refusal and not a row it could not reach.
  begin
    update public.chore_assignments set status = 'done' where id = asg;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a child could not tick their own chore done (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a child could not tick their own chore done (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 2. But not for a points figure of their choosing.
  begin
    update public.chore_assignments set points_awarded = 9999 where id = asg;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child set their own points_awarded (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. Nor a cash figure — the column payChoreRewardAction credits a wallet from.
  begin
    update public.chore_assignments set cash_awarded_cents = 500000 where id = asg;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child set their own cash_awarded_cents (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. Nor smuggled in beside a status they ARE allowed to set.
  begin
    update public.chore_assignments
       set status = 'done', points_awarded = 9999, cash_awarded_cents = 500000
     where id = asg;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child set both amounts alongside status=done (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 5. Nor on a fresh assignment of their own.
  begin
    insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded, cash_awarded_cents)
    values (fam, chore_id, child_mid, 'done', 9999, 500000);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child inserted an assignment carrying its own award amounts (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 6. And the displayed total is still the honest one.
  select coalesce(sum(points_awarded), 0) into n
    from public.chore_assignments
   where family_id = fam and member_id = child_mid and status in ('done', 'approved');
  if n <> 0 then
    raise warning 'BREACH: the child''s displayed points total is % after the attempts above', n;
    failures := failures + 1;
  end if;

  reset role;

  -- 7. A manager still awards, or the guard has closed the product.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  begin
    update public.chore_assignments
       set status = 'approved', points_awarded = 5, cash_awarded_cents = 250
     where id = asg;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not approve and award (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not approve and award (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'chore-award-amount: % assertion(s) failed', failures;
  end if;
  raise notice 'chore-award-amount: OK — a child may tick a chore done, and may not price it';
end
$probe$;
