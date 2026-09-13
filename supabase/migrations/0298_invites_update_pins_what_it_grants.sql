-- ── CRITICAL A guest could accept an invite as a parent ─────────────────────
--
-- `invites_update` was created with a `USING` clause and **no `WITH CHECK`**:
--
--   using (can_manage_family(family_id)
--          or lower(email) = lower(coalesce(auth.jwt()->>'email','')))
--
-- When a policy omits `WITH CHECK`, Postgres reuses `USING` as the write check.
-- That clause's invitee branch constrains exactly one column — `email` — so the
-- invited person could freely rewrite `family_id` and `role` on their own row,
-- and every one of those writes satisfied the check, because their email never
-- changed.
--
-- `accept_invite()` is SECURITY DEFINER and inserts
-- `family_members(family_id, role)` straight from the row it reads. So:
--
--   1. a household invites a babysitter as `guest`;
--   2. she issues one PATCH — `update invites set role='parent'` — which
--      PostgREST accepts because `authenticated` holds UPDATE on the table by
--      Supabase's default privileges;
--   3. she accepts through the ordinary flow, and joins as a **parent**.
--
-- Proved end to end against a replay of all 310 migrations:
--
--   NOTICE:  rows updated: 1, invite role is now: parent
--   NOTICE:  the babysitter joined The Host Family as: parent
--
-- She needs no second family and no guessed UUID: the `family_id` is in her own
-- invite row, which `invites_select` lets her read. A parent can read the
-- family's stored card PINs, manage members, and see everything.
--
-- **The invitee branch grants nothing anyone needs.** No application code
-- updates `invites` at all — acceptance runs entirely through the SECURITY
-- DEFINER `accept_invite(p_token)`, which does not require the caller to hold
-- UPDATE. So the branch is removed rather than narrowed, which is the smaller
-- and safer change.
--
-- `WITH CHECK` is now stated explicitly and identically, so a manager cannot
-- move an invite into another family either, and so the omission that caused
-- this cannot recur silently.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).

drop policy if exists invites_update on public.invites;

create policy invites_update on public.invites
  for update to authenticated
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));
