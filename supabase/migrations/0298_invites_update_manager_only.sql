-- Bubaly :: 0298 an invitee could rewrite their own invite before accepting it
-- ----------------------------------------------------------------------------
-- 0118 left `invites_update` with a USING clause and NO `WITH CHECK`:
--
--   create policy invites_update on public.invites for update
--     using (public.can_manage_family(family_id)
--            or lower(email) = lower(coalesce(auth.jwt()->>'email','')));
--
-- Two things go wrong together.
--
-- First, the second arm hands the INVITEE update rights over their own invite
-- row. Nothing constrains WHICH columns, so the person invited as a 'guest' can
-- set `role = 'parent'` and then accept it through the ordinary supported path:
-- `accept_invite` copies `v_invite.role` straight into `family_members`. The
-- lowest-privilege role in the product promotes itself to a family manager.
--
-- Second, when an UPDATE policy omits `WITH CHECK`, Postgres applies the USING
-- expression to the NEW row as well — and that expression is still satisfied by
-- "the email is mine". So `family_id` is unconstrained too: an invite can be
-- repointed at ANY family, its `expires_at` pushed out, and accepted. The holder
-- of a single pending invite becomes a manager of a household they were never
-- invited to.
--
-- Measured on a database replayed from these migrations, as `authenticated`,
-- with controls proving RLS was live throughout (another person's invite was
-- invisible, a direct `family_members` insert raised 42501, and updating someone
-- else's invite changed 0 rows):
--
--   invite role after the invitee's UPDATE ....... parent
--   family_members.role they ended up with ....... parent
--   can_manage_family(their own family) .......... true
--   rows repointed to an UNRELATED family ........ 1
--   role obtained in that unrelated family ....... parent
--
-- The invitee arm is not needed by anything. `accept_invite` is SECURITY
-- DEFINER and writes `status`/`accepted_by` itself, bypassing RLS; the only
-- other update in the product is the admin revoke, which uses the service role.
-- So the fix is to say what was meant: invites are managed by the people who
-- manage the family, and an explicit WITH CHECK stops a manager moving an
-- invite into a family they do not manage either.
--
-- SELECT is deliberately unchanged: seeing an invite addressed to your own
-- email address is the invite flow working, not a leak.

drop policy if exists invites_update on public.invites;
create policy invites_update on public.invites for update
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));
