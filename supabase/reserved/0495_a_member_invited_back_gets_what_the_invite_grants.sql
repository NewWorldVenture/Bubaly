-- 0495 — A member invited back gets the role the invite grants.
-- DB-RPC-001 (accept_invite), found and reproduced 2026-10-09 on a replay of
-- every runnable migration.
--
-- Removing a member is a soft delete: `update family_members set is_active =
-- false` (the family and settings modules, and the Super Admin's remove). The
-- row keeps its role, so the person can be re-added or re-invited. When they
-- accept a new invite, 0136's accept_invite lands them with
--
--   insert into family_members (family_id, user_id, role, display_name)
--   values (v_invite.family_id, auth.uid(), v_invite.role, ...)
--   on conflict (family_id, user_id) do update set is_active = true;
--
-- and the conflict arm never reads the invite's role. So a parent who was
-- removed, the case removal exists for (an estranged co-parent), and later
-- invited back as a GUEST came back as a PARENT: every manager power, plus the
-- parent-only ones such as deleting the family and minting assistant keys.
-- In the other direction a former child invited back as an adult stayed a
-- child. The invite is the family's newest decision about that person; the
-- row's old role is the decision it replaced.
--
-- The rule here: a caller who was NOT an active member of the family before
-- accepting (no row, or an inactive one) gets exactly the invite's role. An
-- ACTIVE member's role does not move. Accepting an invite is not how a role is
-- changed, and if it were, an adult could address a parent invite to their own
-- email and promote themselves by accepting it. Everything else is 0136's
-- function unchanged: its idempotent re-accept, the expiry and email checks,
-- the invite stamp and the active-family default.
--
-- Second rule, same function: a kid login does not join another family.
-- A kid login's address is synthetic and deterministic from its username
-- (child.<username>@kids.bubaly.app), and invites_insert lets any household's
-- parent or adult write an invite to any address. accept_invite compared only
-- addresses, so a child who opened a stranger's join link while signed in was
-- enrolled in that household: its adults could message them and assign them
-- chores, and the child's own parents could not see it. Reproduced on the same
-- replay. The caller is refused when the ACCOUNT ITSELF says it is a kid
-- login, read from auth.users, which only the server writes:
--
--   * its address is on that domain. createChildLoginAction creates kid logins
--     there with the service role, and no household can write another
--     person's auth address; or
--   * its app_metadata carries `bubaly_kid_login: true`, which
--     createChildLoginAction sets and only the service role can write. That
--     keeps a kid login recognised if its address is ever moved off the
--     domain.
--
-- Not child_logins, and not the membership. A household's parent can write a
-- child_logins row (0297: can_manage_family(family_id) and nothing more) for
-- ANY user id, and for any member of their own household who is not a
-- manager: a caregiver or guest with their own ordinary account, active or
-- not. Trusted as identity, either would let one household stop an adult from
-- ever accepting another household's invitation (owner reviews 6089395851 and
-- 6092383149, reproduced on the replay). The membership link (0458) shows whose
-- row it is, not what kind of account it is. user_metadata ({child: true}) is
-- not used either: its owner can edit it.
--
-- Residual, recorded: a kid login created before createChildLoginAction set the
-- app_metadata mark, whose address was later moved off the domain, is not
-- recognised. Its PIN sign-in no longer works either, since that signs in at
-- the synthetic address.
--
-- There is no designed flow for a kid login to belong to a second household;
-- if the owner wants one (two co-parenting households), it should be a
-- parent-to-parent action, not a child's click. The join page refuses an
-- account on the synthetic domain before calling this, which protects most
-- children while this migration is held; it does not stop a direct RPC call.
--
-- The comparison reads the EXISTING row inside the conflict arm
-- (`family_members.is_active` is the row as it was; `excluded` is the proposed
-- one), so it is decided under the row lock ON CONFLICT already takes and a
-- concurrent removal cannot slip between a read and the write.
--
-- Not changed here, and recorded rather than smoothed over:
--   * SEC-026, the owner's decision on whether an adult may make a parent
--     (directly, or through a parent-role invite). This migration neither
--     widens nor narrows who may issue an invite of which role; it makes the
--     role an invite grants the role a returning member gets.
--   * Explicit social_access_permissions rows are keyed by (family_id,
--     user_id) and also outlive a removal. They can be elevations or
--     restrictions, so whether one should survive is a policy question.
--
-- HELD: reserved as 0495 (above the owner's preserved allocations 0477–0491
-- and the held 0492–0494), in supabase/reserved/ until every number below it
-- has landed. Proven by docs/audit/reserved/a-member-invited-back-gets-the-
-- invited-role-check.sql and .github/workflows/invite-rejoin-role-runtime.yml.
-- Not applied to production by an agent; recorded in
-- docs/PENDING_PROD_MIGRATIONS.md for the owner.

create or replace function public.accept_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_invite public.invites;
  v_name   text;
begin
  select * into v_invite from public.invites
  where token = p_token
  for update;

  if not found then
    raise exception 'Invite is invalid or expired';
  end if;

  -- A kid login stays in the family that made it. Read from the account in
  -- auth.users, which only the server writes; see the header.
  if exists (select 1
               from auth.users u
              where u.id = auth.uid()
                and (right(lower(coalesce(u.email, '')), length('@kids.bubaly.app')) = '@kids.bubaly.app'
                     or coalesce(u.raw_app_meta_data->>'bubaly_kid_login', '') = 'true')) then
    raise exception 'A kid login cannot join another family';
  end if;

  -- Idempotent success: this user already accepted this invite.
  if v_invite.status = 'accepted' and v_invite.accepted_by = auth.uid() then
    return v_invite.family_id;
  end if;

  if v_invite.status <> 'pending' or v_invite.expires_at <= now() then
    raise exception 'Invite is invalid or expired';
  end if;

  if lower(v_invite.email) <> lower(coalesce(auth.jwt()->>'email','')) then
    raise exception 'This invite was issued to a different email';
  end if;

  select coalesce(full_name, display_name, email) into v_name
  from public.profiles where id = auth.uid();

  -- A returning member (an inactive row) takes the invite's role; an active
  -- member keeps theirs.
  insert into public.family_members (family_id, user_id, role, display_name)
  values (v_invite.family_id, auth.uid(), v_invite.role, coalesce(v_name,'Member'))
  on conflict (family_id, user_id) do update
    set is_active = true,
        role = case when family_members.is_active then family_members.role
                    else excluded.role end;

  update public.invites
    set status = 'accepted', accepted_by = auth.uid(), updated_at = now()
  where id = v_invite.id;

  update public.user_preferences
    set active_family_id = v_invite.family_id
  where user_id = auth.uid() and active_family_id is null;

  return v_invite.family_id;
end; $$;

comment on function public.accept_invite(text) is
  '0495: accept an invite addressed to the caller. A caller who was not an active member gets the invite''s role; an active member''s role is unchanged; a kid login is refused. Re-accepting one''s own accepted invite answers its family.';

do $$
begin
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.accept_invite(text)'::regprocedure
       and p.prosecdef
       and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public')
  ) then
    raise exception '0495: accept_invite must stay SECURITY DEFINER with search_path=public, or an invitee cannot write their own member row';
  end if;
  -- The kid-login check reads auth.users as the function's owner. Fail here,
  -- at apply time, rather than on every invitation if that owner cannot.
  if not has_table_privilege(
       (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = 'public.accept_invite(text)'::regprocedure),
       'auth.users', 'SELECT') then
    raise exception '0495: accept_invite''s owner cannot read auth.users, so the kid-login check would fail every invitation';
  end if;
end $$;
