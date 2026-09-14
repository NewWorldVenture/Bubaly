-- Bubaly :: 0298 - an invite's terms are set by the family, not by its recipient
-- ----------------------------------------------------------------------------
-- `invites_update` (0004, re-asserted verbatim by 0118) is:
--
--   for update using (can_manage_family(family_id)
--                     or lower(email) = lower(coalesce(auth.jwt()->>'email','')))
--
-- USING only. Postgres reuses a missing WITH CHECK from USING, so the second
-- branch passes for ANY new row whose `email` is still the invitee's — and
-- every other column is unconstrained. `role`, `family_id`, `status`,
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
--
-- 0004's own header states the hard guarantee that "no row crosses a family
-- boundary". This is that guarantee failing inside 0004.
--
-- TWO changes, because one of them should never be load-bearing alone:
--
--   1. The policy. The invitee branch is REMOVED, not narrowed. An invitee has
--      never needed UPDATE: `accept_invite` is SECURITY DEFINER and writes the
--      acceptance itself. Every other writer in the app is the service role
--      (adminRevokeInviteAction, the onboarding upsert) or a manager's own
--      insert (components/family/invite-form.tsx). Managers keep the same
--      predicate, now on WITH CHECK as well as USING, so a manager cannot
--      re-point an invite at a family they do not manage either.
--
--   2. A trigger, in the idiom of 0222/0223/0295. The terms that decide WHAT an
--      acceptance grants — which family, which token, which email — are fixed
--      at issue, and acceptance is terminal. A policy is one `drop policy` away
--      from gone; this survives that.
--
-- `role` stays editable on a pending invite: a manager may re-issue at a
-- different role, and a manager could have issued that role to begin with, so
-- it is not an escalation once branch 1 is in place.

drop policy if exists invites_update on public.invites;
create policy invites_update on public.invites for update
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));

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
