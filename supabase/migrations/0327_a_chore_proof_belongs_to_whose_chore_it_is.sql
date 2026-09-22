-- A chore proof belongs to whose chore it is. (F-F07, the AUTHZ half)
--
-- `chore_submissions` and `chore_disputes` are both governed by a single
-- `is_family_member(family_id)` policy FOR ALL. That answers "is this user in
-- the family" and says nothing about WHICH member the row is about, so any
-- member could insert a submission or a dispute naming any other member:
--
--   chore_submissions | chore_submissions_all | ALL | is_family_member(family_id)
--   chore_disputes    | chore_disputes_all    | ALL | is_family_member(family_id)
--
-- The app layer had the same gap and is fixed alongside this migration:
-- `submitProofAction` and `disputeSubmissionAction` loaded their row filtered on
-- `family_id` only and then attributed the write to the ASSIGNEE — so a sibling
-- could submit a photo against another child's chore, or open a dispute the
-- record said that child had raised. Every product write to these tables goes
-- through those two actions, so the app fix closes the product path; this closes
-- the direct-PostgREST path, which is the one a session cookie reaches without
-- rendering a page (the same distinction ADMIN-001 and AUTHZ-008 turn on).
--
-- ── the rule, and why it is not managers-only ─────────────────────────────
--
-- Submitting proof of your own chore IS the child's half of the product: the
-- kids page exists for it. So the rule is the row's own member OR a manager —
-- a parent submitting on a child's behalf is a real case and is kept. That is
-- the same shape 0319 put on `member_locations` after SEC-006.
--
-- RESTRICTIVE, so it is ANDed with the family policy already there rather than
-- replacing it, and INSERT and UPDATE both carry it: without the UPDATE half a
-- member could insert a correctly attributed row and then re-point it.
--
-- 0222 already blocks a member from moving a submission INTO a manager-decision
-- status, and deliberately lets members submit (pending) and dispute
-- (disputed). This narrows WHOSE submissions and disputes they may create; it
-- does not touch that.
--
-- Held by docs/audit/chore-proof-ownership-check.sql.

drop policy if exists chore_submissions_member_owns_it on public.chore_submissions;
create policy chore_submissions_member_owns_it on public.chore_submissions
  as restrictive for insert to authenticated
  with check (public.can_manage_family(family_id) or public.is_self_member(member_id));

drop policy if exists chore_submissions_member_owns_it_update on public.chore_submissions;
create policy chore_submissions_member_owns_it_update on public.chore_submissions
  as restrictive for update to authenticated
  using (public.can_manage_family(family_id) or public.is_self_member(member_id))
  with check (public.can_manage_family(family_id) or public.is_self_member(member_id));

drop policy if exists chore_disputes_member_owns_it on public.chore_disputes;
create policy chore_disputes_member_owns_it on public.chore_disputes
  as restrictive for insert to authenticated
  with check (public.can_manage_family(family_id) or public.is_self_member(member_id));

drop policy if exists chore_disputes_member_owns_it_update on public.chore_disputes;
create policy chore_disputes_member_owns_it_update on public.chore_disputes
  as restrictive for update to authenticated
  using (public.can_manage_family(family_id) or public.is_self_member(member_id))
  with check (public.can_manage_family(family_id) or public.is_self_member(member_id));
