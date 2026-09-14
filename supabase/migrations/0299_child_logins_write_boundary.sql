-- ── S-03 A policy named "Managers manage" that means "any member" ────────────
--
-- `child_logins` maps a child's public login handle to their synthetic auth user.
-- Its write policy is named "Managers manage child_logins" and predicated on
-- `is_family_member(family_id)` — so every member of the household, including a
-- child, can INSERT, UPDATE and DELETE any row in it. Found by Claude-3 and
-- verified against the schema.
--
-- Two consequences, and the second is worse than it looks.
--
-- 1. A child can DELETE a sibling's login row. `family_members.user_id` still
--    points at the auth user, so the sibling's account exists and no username
--    resolves to it: a permanent lockout with no recovery anywhere in the UI.
--
-- 2. A child can UPDATE `user_id`. `resetChildPinAction`
--    (app/(app)/family/child-login-actions.ts) is manager-gated, reads
--    `row.user_id` straight out of this table, and calls
--    `admin.auth.admin.updateUserById(row.user_id, { password })` with the
--    service role. So a child points their own row's `user_id` at a PARENT's
--    auth user, asks that parent to reset their PIN — an ordinary request, "I
--    forgot my PIN" — and the reset sets the PARENT's account password to
--    `deriveChildPassword(secret, childUsername, pin)`, a value the child chose.
--    Child to parent account takeover, with the parent's own hand on the button.
--
-- The fix is `can_manage_family(family_id)`, the predicate `family_members`,
-- `subscriptions` and `medical_profiles` already use — and the one this schema
-- reaches for whenever a table governs the household rather than belonging to it.
-- Third table in this audit with the same defect, after F20's chore board and
-- O-01's password vault.
--
-- A single conjunct on both sides, deliberately: S-01 was a policy whose USING
-- was a disjunction and whose WITH CHECK was missing, which let a caller move a
-- row into a scope they did not hold. One predicate that pins the authorization
-- column must hold on the NEW row too, so there is nowhere to move it to.
--
-- READS are left alone. `Members can view child_logins` is a separate permissive
-- SELECT policy, so this does not touch it: a username is a handle the family
-- shares, the kid surface shows it, and nothing here depends on hiding it. The
-- `user_id` it also exposes is only useful together with the write hole this
-- closes.
--
-- The application half of this defect is fixed separately and does NOT wait for
-- this migration: `resetChildPinAction` now resolves the auth user from
-- `family_members` (manager-only writable) and refuses when this table disagrees
-- with it. That matters because production's migration ledger is gated (F-001),
-- so this file will sit unapplied while the takeover path is closed in code.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).

drop policy if exists "Managers manage child_logins" on public.child_logins;

create policy "Managers manage child_logins" on public.child_logins
  for all to authenticated
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));
