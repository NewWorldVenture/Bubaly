-- Bubaly :: 0321 - an invite's terms are fixed at issue
-- ----------------------------------------------------------------------------
-- Renumbered from 0305. main landed seven migrations at once — 0304 economy
-- invest decision guard, 0305 chore award amounts, 0306 money instructions,
-- 0307 chore prices, 0308 reward catalogue, 0309 prescriptions, 0310 UI-only
-- manager gates — colliding with this branch's whole 0304-0310 block. The NINTH
-- collision event between the two sessions and by far the largest; every merge
-- since 0300 has brought one. Only the numbers changed: this branch's seven
-- moved together to 0320-0326, keeping their order relative to each other.
--
-- Main's seven are RESTRICTIVE guards (`as restrictive`, 0254's mechanism), so
-- they AND with everything here and nothing in this block can loosen them by
-- running later. The two sets are defence in depth over the same tables rather
-- than one overwriting the other, and the probes are run against the combined
-- chain to say so rather than to assume it.
-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- COMPANION TO 0298, NOT A REPLACEMENT FOR IT.
--
-- `invites_update` (0004, re-asserted verbatim by 0118) was:
--
--   for update using (can_manage_family(family_id)
--                     or lower(email) = lower(coalesce(auth.jwt()->>'email','')))
--
-- USING only. Postgres reuses a missing WITH CHECK from USING, so the second
-- branch passed for ANY new row whose `email` was still the invitee's — and
-- every other column was unconstrained. `role`, `family_id`, `status` and
-- `expires_at` were all the recipient's to rewrite.
--
-- That row is then trusted completely by `accept_invite` (0005/0136), which is
-- SECURITY DEFINER and inserts `(v_invite.family_id, auth.uid(), v_invite.role)`
-- straight into `family_members` — past `fm_insert`'s can_manage_family check.
-- The invite was attacker-controlled input to a privileged insert:
--
--   update invites set role='parent'            -> accept -> parent, not child
--   update invites set expires_at=now()+'365d'  -> never expires
--   update invites set status='pending'         -> re-accept after removal
--   update invites set family_id='<other fam>'  -> join a household that
--                                                  never issued the invite
--
-- All four confirmed on a full 308-migration replay as the invited user.
-- 0004's own header states the hard guarantee that "no row crosses a family
-- boundary"; this was that guarantee failing inside 0004.
--
-- **0298 has already closed the policy half**, reaching the same shape from the
-- same evidence in a parallel session: the invitee branch removed rather than
-- narrowed, `can_manage_family` on WITH CHECK as well as USING. This migration
-- deliberately does NOT re-assert that policy. Dropping and recreating an
-- identical policy would replace 0298's named, documented object with an
-- indistinguishable copy and cost the repo the account that goes with it, for
-- no change in behaviour. 0298 owns `invites_update`.
--
-- What is left is the half 0298 does not cover, and it is the half that should
-- never be load-bearing on a policy alone. A policy is one `drop policy` away
-- from gone — which is exactly how this hole survived from 0004 through 0118 —
-- and it constrains only the ROLES it names, so it says nothing about what
-- `accept_invite` may do once it is inside SECURITY DEFINER.
--
-- So, in the idiom of 0222/0223/0295: the terms that decide WHAT an acceptance
-- grants — which family, which token, which email — are fixed at issue, and
-- acceptance is terminal. Three of those four rows above are refused by the
-- trigger too, independently of any policy.
--
-- `role` stays editable on a pending invite: a manager may re-issue at a
-- different role, and a manager could have issued that role to begin with, so
-- it is not an escalation now that 0298 has removed the invitee branch.

create or replace function public.invite_terms_are_immutable()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  -- The trusted server (service role, or a migration/seed with no session)
  -- keeps its reach: adminRevokeInviteAction revokes by id, and the onboarding
  -- upsert re-runs under the service role.
  if current_user = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null then
    return new;
  end if;

  if new.family_id is distinct from old.family_id then
    raise exception 'an invite cannot be moved to another family'
      using errcode = '42501';
  end if;
  if new.token is distinct from old.token then
    raise exception 'an invite token cannot be rewritten'
      using errcode = '42501';
  end if;
  if lower(new.email) is distinct from lower(old.email) then
    raise exception 'an invite cannot be readdressed'
      using errcode = '42501';
  end if;
  if old.status = 'accepted' and new.status is distinct from old.status then
    raise exception 'an accepted invite cannot be reopened'
      using errcode = '42501';
  end if;

  return new;
end; $fn$;

drop trigger if exists trg_invite_terms_are_immutable on public.invites;
create trigger trg_invite_terms_are_immutable
  before update on public.invites
  for each row execute function public.invite_terms_are_immutable();

revoke all on function public.invite_terms_are_immutable() from public;
