-- ── A dispute is raised by anyone and resolved by a manager (0326) ─────────
--
-- `chore_disputes` (00430_chore_missions.sql) carries one policy,
-- `chore_disputes_all`: `FOR ALL TO authenticated USING/WITH CHECK
-- is_family_member(family_id)`.
--
-- Unlike the tables 0322-0325 closed, a blanket manager guard here would be
-- WRONG. `disputeSubmissionAction` (app/(app)/missions/actions.ts) has no role
-- gate at all — a child who thinks the AI marked their chore unfairly says so,
-- and the row is what puts it in front of a parent — and its two rollback paths
-- delete the row they just wrote on the same un-gated client. So the guard is a
-- BEFORE trigger on the decision, exactly as 0222 did for `chore_submissions`,
-- 0223 for `chore_assignments` and 0295 for `reward_redemptions`, and this
-- probe has to prove BOTH halves or it is proving the wrong thing.
--
-- The manager rule lives in `approveSubmissionAction`, which opens
-- `if (!isManager(ctx.active.role)) return;` and then writes
--
--   .update({ status: 'resolved', resolution: 'Approved by parent',
--             resolved_by: ctx.active.member.id, resolved_at: … })
--
-- Nothing else in the codebase ever sets those four things, and the only code
-- that clears them again is that same action rolling its own approval back.
-- app/(app)/missions/page.tsx reads disputes with `.eq('status','open')`, so a
-- self-resolved dispute simply stops appearing on the parent's screen.
--
-- Asserts, in both directions:
--
--   1. a child CAN still raise a dispute, and delete the one they just raised
--      (both are un-gated in the application, and a guard that stopped either
--      would take the appeal away from the person appealing);
--   2. a child CANNOT mark a dispute 'resolved', nor write `resolution`,
--      `resolved_by` or `resolved_at` — on INSERT or on UPDATE;
--   3. a child CANNOT insert a dispute that is born resolved;
--   4. a child CANNOT clear a manager's resolution back to nulls either — a row
--      left open while still carrying a fabricated `resolved_by` is a forgery
--      with better manners;
--   5. a manager can resolve, and can roll their own resolution back, which is
--      what `approveSubmissionAction`'s failure path does;
--   6. reads are untouched;
--   7. NEGATIVE CONTROL: drop ONLY the trigger, leaving `chore_disputes_all`
--      exactly as it was — the pre-0326 state — and require the child's
--      self-resolution to succeed again.
--
-- The guard is a trigger, not a policy, so a refusal arrives as a raised
-- exception rather than as zero rows. Both are checked: an UPDATE that changes
-- a row is a breach whether or not anything was raised.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/chore-dispute-resolution-check.sql

\set FC '00000000-0000-4000-8000-00000000dc10'
\set UP '00000000-0000-4000-8000-00000000dc11'
\set UK '00000000-0000-4000-8000-00000000dc12'

begin;

insert into auth.users (id, email) values (:'UP','dc-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','dc-kid@example.com')    on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FC','Chore House',:'UP') on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000dc13',:'FC',:'UK','Kid','child',true) on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FC' and user_id = :'UP';

insert into public.chores (id, family_id, title, created_by)
  values ('00000000-0000-4000-8000-00000000dc14', :'FC', 'Tidy the kitchen', :'UP');
insert into public.chore_assignments (id, family_id, chore_id, member_id, status)
  values ('00000000-0000-4000-8000-00000000dc15', :'FC', '00000000-0000-4000-8000-00000000dc14',
          '00000000-0000-4000-8000-00000000dc13', 'submitted');
insert into public.chore_submissions (id, family_id, assignment_id, chore_id, member_id, status, note)
  values ('00000000-0000-4000-8000-00000000dc16', :'FC', '00000000-0000-4000-8000-00000000dc15',
          '00000000-0000-4000-8000-00000000dc14', '00000000-0000-4000-8000-00000000dc13',
          'disputed', 'I did do it');
-- The appeal itself, waiting on the parent's screen.
insert into public.chore_disputes (id, family_id, submission_id, member_id, reason, status)
  values ('00000000-0000-4000-8000-00000000dc17', :'FC', '00000000-0000-4000-8000-00000000dc16',
          '00000000-0000-4000-8000-00000000dc13', 'The photo was of the finished kitchen', 'open');

grant select, insert, update, delete on public.chore_disputes to authenticated;

do $$
declare
  n int;
  row_status text;
  row_by uuid;
  failures text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-00000000dc10';
  parent_u  constant uuid := '00000000-0000-4000-8000-00000000dc11';
  kid_u     constant uuid := '00000000-0000-4000-8000-00000000dc12';
  kid_m     constant uuid := '00000000-0000-4000-8000-00000000dc13';
  submission constant uuid := '00000000-0000-4000-8000-00000000dc16';
  dispute   constant uuid := '00000000-0000-4000-8000-00000000dc17';
  raised    uuid;
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- 1. Raising. This is the feature; it has to keep working.
  begin
    insert into public.chore_disputes (family_id, submission_id, member_id, reason, status)
      values (fam, submission, kid_m, 'Asking a parent to look again', 'open')
      returning id into raised;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MEMBER could not RAISE a dispute — disputeSubmissionAction has no role gate and the guard has taken the appeal away from the person appealing');
  end;

  -- And the rollback path disputeSubmissionAction runs when a later write fails.
  if raised is not null then
    delete from public.chore_disputes where id = raised;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, 'a MEMBER could not delete the dispute they had just raised — disputeSubmissionAction''s own cleanup path is broken'); end if;
  end if;

  -- 2. Resolving it themselves.
  begin
    update public.chore_disputes
       set status = 'resolved', resolution = 'Approved by parent',
           resolved_by = kid_m, resolved_at = now()
     where id = dispute;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a child RESOLVED %s of their own dispute(s) in a parent''s name — it leaves the parent''s queue and nobody is told', n)); end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. The decision columns on their own, without touching status.
  begin
    update public.chore_disputes set resolved_by = kid_m, resolved_at = now() where id = dispute;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a child stamped %s dispute(s) with a resolver while leaving the status alone', n)); end if;
  exception when insufficient_privilege then null;
  end;

  begin
    update public.chore_disputes set resolution = 'Parent said it was fine' where id = dispute;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a child wrote the resolution text on %s dispute(s)', n)); end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. Born resolved.
  begin
    insert into public.chore_disputes (family_id, submission_id, member_id, reason, status, resolution, resolved_by, resolved_at)
      values (fam, submission, kid_m, 'Already sorted', 'resolved', 'Approved by parent', kid_m, now());
    failures := array_append(failures, 'a child INSERTED a dispute that was born resolved');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s pre-resolved chore_disputes INSERT reached a unique index, so the guard did not refuse it');
  end;

  -- 5. Cancelling their own ask stays open (0295 drew the same line).
  begin
    update public.chore_disputes set status = 'cancelled' where id = dispute;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, 'a member could not WITHDRAW their own dispute — cancelling needs no parent'); end if;
    update public.chore_disputes set status = 'open' where id = dispute;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a member could not WITHDRAW their own dispute — cancelling needs no parent');
  end;

  -- 6. Reads stay open, deliberately.
  select count(*) into n from public.chore_disputes where id = dispute;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ their own dispute — that is a change of decision; update finalaudit.md and this probe');
  end if;

  -- ── As the parent: the positive control ─────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  update public.chore_disputes
     set status = 'resolved', resolution = 'Approved by parent',
         resolved_by = (select id from public.family_members where family_id = fam and user_id = parent_u limit 1),
         resolved_at = now()
   where id = dispute and status = 'open';
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not resolve a dispute — the guard refuses everyone'); end if;

  -- approveSubmissionAction's failure path puts it back.
  update public.chore_disputes
     set status = 'open', resolution = null, resolved_by = null, resolved_at = null
   where id = dispute and status = 'resolved';
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not roll their own resolution back — approveSubmissionAction''s rollback path is broken'); end if;

  -- 7. And the child cannot UN-resolve a manager's decision either.
  update public.chore_disputes
     set status = 'resolved', resolution = 'Approved by parent',
         resolved_by = (select id from public.family_members where family_id = fam and user_id = parent_u limit 1),
         resolved_at = now()
   where id = dispute;
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  begin
    update public.chore_disputes set status = 'open', resolution = null, resolved_by = null, resolved_at = null
     where id = dispute;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a child REOPENED %s resolved dispute(s), erasing the record of the decision', n)); end if;
  exception when insufficient_privilege then null;
  end;

  perform set_config('role','postgres', true);
  select status, resolved_by into row_status, row_by from public.chore_disputes where id = dispute;
  if row_status <> 'resolved' or row_by is null then
    failures := array_append(failures, format('the dispute ended at status %L / resolved_by %s — a child changed a manager''s decision', row_status, row_by));
  end if;

  -- ── Negative control: prove this probe can SEE the defect ──────────────
  -- Drop ONLY the trigger. `chore_disputes_all` is left exactly as it was,
  -- which is precisely the pre-0326 state. The outer rollback undoes this
  -- along with everything else.
  drop trigger if exists trg_chore_dispute_resolution_guard on public.chore_disputes;

  update public.chore_disputes set status = 'open', resolution = null, resolved_by = null, resolved_at = null where id = dispute;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  update public.chore_disputes
     set status = 'resolved', resolution = 'Approved by parent',
         resolved_by = kid_m, resolved_at = now()
   where id = dispute;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with chore_disputes_all alone the child STILL could not resolve their own dispute — this probe is decoration, not a boundary');
  end if;

  perform set_config('role','postgres', true);
  select status into row_status from public.chore_disputes where id = dispute;
  if row_status <> 'resolved' then
    failures := array_append(failures, format('with the trigger removed the dispute did not end up %L (got %L) — this probe has never been shown to fail', 'resolved', row_status));
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'chore dispute resolution is not a manager''s call:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'chore-dispute-resolution: OK (a member raises, withdraws and deletes their own dispute; only a manager resolves, un-resolves or stamps a resolver; negative control reproduced the self-resolution)';
end $$;

rollback;
