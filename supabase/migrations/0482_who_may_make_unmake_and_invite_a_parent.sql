-- Bubaly :: 0482 - who may make, unmake and invite a parent
-- ----------------------------------------------------------------------------
-- From the 2026-10-10 family-membership audit (proposed-family-roles.sql, the
-- SQL half of audit/family-membership-fix; written against 8b78130d7 and tested
-- on PG16 with the full probe suite). Numbered 0482 by owner decision of
-- 2026-10-10; the SQL is the proposal's, unchanged.
--
-- Three existing probes carry fixture or allowlist edits for what this changes
-- on purpose: family-keeps-a-manager-check (a family that has a parent keeps
-- one), invite-terms-boundary-check and invite-role-escalation-check (the
-- invite terms are the server's to set).
--
-- ── what is wrong today ─────────────────────────────────────────────────────
--
-- A. family_members. fm_insert, fm_update and fm_delete are all
--    `can_manage_family(family_id)` (01100_family_profile.sql:63-68, 0118:69-77,
--    0211:11-14), i.e. parent OR adult. Nothing pins a column, so an ADULT can:
--      * PATCH their own row to role = 'parent' (0381:134-140 recorded this and
--        left it as its own finding — this is that finding);
--      * demote, deactivate or delete a real parent;
--      * move any member row into another family they manage (family_id is
--        only re-checked as "a family I manage", not "the same family").
--    0299's family_keeps_a_manager only asks for "a parent OR an adult", so a
--    household can also lose its last parent to a client write as long as
--    one adult is left.
--
-- B. invites. invites_insert is `can_manage_family` (0118:86-88) and
--    invites_update the same (0298). An adult can therefore issue a 'parent'
--    invite to a second address they own and become a parent through the
--    supported accept_invite path. And the client chooses every column: a
--    status of 'accepted', someone else's invited_by, a token of its choosing
--    (a guessable join link), an expires_at decades away.
--
-- C. accept_invite (0136). The ON CONFLICT branch only sets is_active = true,
--    so a removed member re-invited as a guest comes back with whatever role
--    they had when they were removed — a removed parent re-invited as a guest
--    is a parent again. And an invite stays good after the person who sent it
--    has been removed or demoted below the role it grants.
--
-- D. A removed child keeps a working session. child_logins (01051) maps a
--    synthetic auth user to a member; removing the member is
--    `is_active = false`, which leaves the child_logins row and the auth user
--    in place. That session can call families_insert (`created_by =
--    auth.uid()`, 0118:56) and handle_new_family makes it the PARENT of a new
--    household. Separately, removing ANY member leaves their sync_accounts /
--    sync_tokens / sync_connections running against the family they left.
--
-- ── the shape of the fix ────────────────────────────────────────────────────
--
-- Client role is decided exactly as in 0458: `current_user in
-- ('authenticated','anon')` inside a SECURITY INVOKER trigger. Inside the
-- database's own SECURITY DEFINER functions (accept_invite, handle_new_family,
-- ensure_family_for_user), in FK cascades, and for the service role, current_user
-- is something else and the server's own writes are unchanged.
--
-- Guard TRIGGERS that raise 42501, not narrower policies, for the reason 0464
-- gives: a restrictive UPDATE/DELETE policy FILTERS, PostgREST answers
-- `error: null` and the screen reports a change that never happened. A raise
-- is an answer describeDbError can show.
--
--   A1  trg_family_member_parent_is_a_parents_to_make   (BEFORE I/U/D, row)
--   A2  family_keeps_a_manager() extended               (0299's deferred trigger)
--   B1  member_role_rank()                              (ROLE_ORDER, roles.ts)
--   B2  invites_insert / invites_update                 (policy WITH CHECK)
--   B3  trg_invite_terms_are_the_servers_to_set          (BEFORE I/U, row)
--   C   accept_invite()                                 NOT here: held 0495's
--   D1  families_insert + is_child_login_account()
--   D2  trg_removed_member_keeps_no_sync_link           (AFTER U of is_active / D)
--
-- C is not in this file. accept_invite is the subject of the held
-- 0495_a_member_invited_back_gets_what_the_invite_grants (supabase/reserved/),
-- whose negative control, .github/workflows/invite-rejoin-role-runtime.yml,
-- replays the released schema and requires its probe to still show a returning
-- member keeping their old role before 0495 repairs it. A rewrite here would
-- close that first and fail the control on the wrong error, so 0136's
-- accept_invite is left exactly as it is and the returning member's role is
-- 0495's to fix. The inviter-still-active re-check (an invite stays good after
-- the person who sent it was removed or demoted below the role it grants) is
-- a follow-up once 0495 has landed.
--
-- Probe: docs/audit/a-parent-is-made-unmade-and-invited-only-by-a-parent-check.sql, which records each
-- forbidden write succeeding before this file and refused after it.
--
-- Everything is idempotent: create or replace, drop … if exists before create.

-- ════════════════════════════════════════════════════════════════════════════
-- B1. Role ranking — mirrors ROLE_ORDER in lib/constants/roles.ts
--     ['parent','adult','teen','child','caregiver','guest']; 0 is highest.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.member_role_rank(p_role public.member_role)
returns int
language sql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select case p_role
    when 'parent'    then 0
    when 'adult'     then 1
    when 'teen'      then 2
    when 'child'     then 3
    when 'caregiver' then 4
    when 'guest'     then 5
  end
$$;

comment on function public.member_role_rank(public.member_role) is
  'Rank of a member_role, 0 = highest, in the order of ROLE_ORDER in lib/constants/roles.ts. Used by invites_insert / invites_update.';

-- ════════════════════════════════════════════════════════════════════════════
-- A1. Only a parent makes, unmakes or removes a parent; family_id is fixed.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.family_member_parent_is_a_parents_to_make()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    if new.role = 'parent' and not public.is_family_admin(new.family_id) then
      raise exception 'Only a parent can add a parent to the family.'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.family_id is distinct from old.family_id then
      raise exception 'A member cannot be moved to another family.'
        using errcode = 'insufficient_privilege';
    end if;
    if new.role = 'parent' and old.role is distinct from 'parent'
       and not public.is_family_admin(old.family_id) then
      raise exception 'Only a parent can make someone a parent.'
        using errcode = 'insufficient_privilege';
    end if;
    if old.role = 'parent'
       and (new.role is distinct from old.role or new.is_active is distinct from old.is_active)
       and not public.is_family_admin(old.family_id) then
      raise exception 'Only a parent can change or remove a parent.'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- DELETE
  if old.role = 'parent' and not public.is_family_admin(old.family_id) then
    raise exception 'Only a parent can remove a parent.'
      using errcode = 'insufficient_privilege';
  end if;
  return old;
end;
$$;

comment on function public.family_member_parent_is_a_parents_to_make() is
  '0482: for client roles (current_user authenticated/anon, as in 0458), refuses with 42501 setting role=parent, or changing role/is_active of or deleting a parent row, unless the caller is_family_admin; and refuses any change of family_id. Server, definer functions and FK cascades are exempt.';

revoke all on function public.family_member_parent_is_a_parents_to_make() from public, anon, authenticated;

drop trigger if exists trg_family_member_parent_is_a_parents_to_make on public.family_members;
create trigger trg_family_member_parent_is_a_parents_to_make
  before insert or update or delete on public.family_members
  for each row execute function public.family_member_parent_is_a_parents_to_make();

-- ════════════════════════════════════════════════════════════════════════════
-- A2. A family that has a parent keeps one (extends 0299, same deferred
--     constraint trigger, so a swap of parents in one transaction still works
--     and a whole-family teardown is still not a violation).
--
--     The condition is per row: THIS row was an active parent before the
--     change, and at COMMIT its family still has active members but no
--     active parent. A family that never had a parent (a managed household of
--     adults) is not newly constrained. Unlike A1 this is an invariant, not a
--     permission, so like 0299 it binds the service role too; a Super Admin
--     removing a sole parent must promote someone first.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.family_keeps_a_manager()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_family uuid := coalesce(old.family_id, new.family_id);
  v_members int;
  v_managers int;
  v_parents int;
begin
  -- The family itself is gone (its delete cascaded here). Nothing to protect.
  if not exists (select 1 from public.families where id = v_family) then
    return null;
  end if;

  select
    count(*) filter (where is_active),
    count(*) filter (where is_active and role in ('parent', 'adult')),
    count(*) filter (where is_active and role = 'parent')
  into v_members, v_managers, v_parents
  from public.family_members
  where family_id = v_family;

  -- No active members at all: an empty family locks nobody out.
  if v_members = 0 then
    return null;
  end if;

  if v_managers = 0 then
    raise exception
      'A family must keep at least one active parent or adult, otherwise nobody can manage it. Add or promote another member first.'
      using errcode = 'check_violation';
  end if;

  -- 0482: the row that just stopped being an active parent was the last.
  if tg_op in ('UPDATE', 'DELETE') and old.is_active and old.role = 'parent'
     and v_parents = 0 then
    raise exception
      'A family must keep at least one active parent. Make another member a parent first.'
      using errcode = 'check_violation';
  end if;

  return null;
end;
$function$;

revoke all on function public.family_keeps_a_manager() from public, anon, authenticated, service_role;
-- The trigger itself (0299) is unchanged: deferrable initially deferred,
-- after insert or update or delete, for each row.

-- ════════════════════════════════════════════════════════════════════════════
-- B2. Who may issue (or re-word) an invite for which role.
--     * a 'parent' invite needs a parent;
--     * nobody invites above their own rank (family_role, 0003; NULL for a
--       non-member, which makes the comparison NULL and refuses).
-- ════════════════════════════════════════════════════════════════════════════
drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites for insert
  with check (
    public.can_manage_family(family_id)
    and (role <> 'parent' or public.is_family_admin(family_id))
    and public.member_role_rank(role) >= public.member_role_rank(public.family_role(family_id))
  );

drop policy if exists invites_update on public.invites;
create policy invites_update on public.invites for update
  using (public.can_manage_family(family_id))
  with check (
    public.can_manage_family(family_id)
    and (role <> 'parent' or public.is_family_admin(family_id))
    and public.member_role_rank(role) >= public.member_role_rank(public.family_role(family_id))
  );

-- ════════════════════════════════════════════════════════════════════════════
-- B3. The terms of an invite are the server's to set.
--     INSERT by a client: status = 'pending', invited_by = auth.uid(), a fresh
--       token from the column's own generator, accepted_by = NULL, and
--       expires_at clamped to at most now() + 14 days (the column default).
--       Clamped, not refused: the app never sends these columns
--       (components/family/invite-form.tsx sends family_id/email/role/
--       invited_by), so only a hand-made request is affected.
--     UPDATE by a client: token and accepted_by are fixed; status
--       may stay or go pending -> revoked, nothing else (no resurrecting an
--       accepted, revoked or expired invite); expires_at is clamped the same
--       way; whoever changes role, email or expiry becomes invited_by (they now
--       vouch for it; accept_invite re-checking the inviter is the follow-up
--       noted above), otherwise invited_by is kept.
--     BEFORE triggers run before the policy's WITH CHECK, so the forced values
--     are what the policy sees.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.invite_terms_are_the_servers_to_set()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_latest timestamptz := now() + interval '14 days';
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.status      := 'pending';
    new.invited_by  := auth.uid();
    new.token       := encode(gen_random_bytes(24), 'hex');
    new.accepted_by := null;
    new.expires_at  := least(coalesce(new.expires_at, v_latest), v_latest);
    return new;
  end if;

  -- UPDATE. family_id is deliberately NOT fixed here: the policy's WITH
  -- CHECK already applies every rule above to the NEW family, a manager of
  -- both families gains nothing they could not get by issuing a fresh invite
  -- there, and invite-cannot-rewrite-what-it-grants-check.sql and
  -- invite-role-escalation-check.sql use exactly that move as their control.
  if new.token is distinct from old.token or new.accepted_by is distinct from old.accepted_by then
    raise exception 'An invite''s link and acceptance are set by the server.'
      using errcode = 'insufficient_privilege';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'pending' and new.status = 'revoked') then
    raise exception 'An invite can only be revoked from here.'
      using errcode = 'insufficient_privilege';
  end if;
  if new.expires_at is distinct from old.expires_at then
    new.expires_at := least(new.expires_at, v_latest);
  end if;
  if new.role is distinct from old.role
     or new.email is distinct from old.email
     or new.expires_at is distinct from old.expires_at then
    new.invited_by := auth.uid();
  else
    new.invited_by := old.invited_by;
  end if;
  return new;
end;
$$;

comment on function public.invite_terms_are_the_servers_to_set() is
  '0482: for client roles, forces status/invited_by/token/accepted_by and clamps expires_at to now()+14 days on INSERT; on UPDATE fixes token/accepted_by, allows only pending->revoked, clamps expiry and re-stamps invited_by when role/email/expiry change. Server writes are unchanged.';

revoke all on function public.invite_terms_are_the_servers_to_set() from public, anon, authenticated;

drop trigger if exists trg_invite_terms_are_the_servers_to_set on public.invites;
create trigger trg_invite_terms_are_the_servers_to_set
  before insert or update on public.invites
  for each row execute function public.invite_terms_are_the_servers_to_set();

-- ════════════════════════════════════════════════════════════════════════════
-- D1. A child-login account does not found a household.
--     Identified the way the server identifies it: a child_logins row
--     (01051, written only by the service role) for auth.uid(), or the
--     synthetic address the server gives that auth user
--     (lib/onboarding/child-login.ts syntheticChildEmail:
--     child.<username>@kids.bubaly.app), read from auth.users, not from the
--     JWT or user_metadata (which the account itself can edit).
--     SECURITY DEFINER because a REMOVED child no longer passes
--     child_logins' is_family_member SELECT policy — the case this is for.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.is_child_login_account()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select auth.uid() is not null and (
    exists (select 1 from public.child_logins c where c.user_id = auth.uid())
    or exists (select 1 from auth.users u
                where u.id = auth.uid()
                  and lower(u.email) like '%@kids.bubaly.app')
  )
$$;

comment on function public.is_child_login_account() is
  '0482: true when the caller is a child-login auth user (child_logins.user_id, or the synthetic @kids.bubaly.app address). Answers only about the caller.';

revoke all on function public.is_child_login_account() from public, anon;
grant execute on function public.is_child_login_account() to authenticated, service_role;

drop policy if exists families_insert on public.families;
create policy families_insert on public.families for insert
  with check (created_by = auth.uid() and not public.is_child_login_account());

-- ════════════════════════════════════════════════════════════════════════════
-- D2. A member who leaves takes their calendar/reminder sync with them.
--     sync_accounts, sync_tokens, sync_connections (0018_sync_platform.sql)
--     are keyed by (user_id, family_id) and do not cascade from
--     family_members. When a row goes active -> inactive, or is deleted, every
--     sync row that (family_id, user_id) holds in that family is set to
--     sync_direction = 'disabled', sync_status = 'disabled', and the token
--     ciphertext is cleared so it cannot be used or refreshed. Reactivation
--     does not re-enable anything: the member reconnects. Same shape as 0419
--     (SECURITY DEFINER: an adult removing a member has no RLS over that
--     member's sync rows, and the cleanup must not depend on who pressed
--     Remove).
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.removed_member_keeps_no_sync_link()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if old.user_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and not (old.is_active and not new.is_active) then
    return null;
  end if;
  -- A family delete cascades its sync rows away on its own.
  if not exists (select 1 from public.families where id = old.family_id) then
    return null;
  end if;

  update public.sync_tokens t
     set access_token_enc = null,
         refresh_token_enc = null,
         sync_direction = 'disabled',
         sync_status = 'disabled'
   where t.user_id = old.user_id
     and (t.family_id = old.family_id
          or t.account_id in (select a.id from public.sync_accounts a
                               where a.user_id = old.user_id and a.family_id = old.family_id));

  update public.sync_connections c
     set sync_direction = 'disabled',
         sync_status = 'disabled'
   where c.user_id = old.user_id
     and c.family_id = old.family_id;

  update public.sync_accounts a
     set sync_direction = 'disabled',
         sync_status = 'disabled'
   where a.user_id = old.user_id
     and a.family_id = old.family_id;

  return null;
end;
$$;

comment on function public.removed_member_keeps_no_sync_link() is
  '0482: after a family_members row is deactivated or deleted, disables every sync_accounts/sync_connections row and clears every sync_tokens ciphertext that (family_id, user_id) holds in that family.';

revoke all on function public.removed_member_keeps_no_sync_link() from public, anon, authenticated;

drop trigger if exists trg_removed_member_keeps_no_sync_link on public.family_members;
create trigger trg_removed_member_keeps_no_sync_link
  after update of is_active or delete on public.family_members
  for each row execute function public.removed_member_keeps_no_sync_link();

-- ════════════════════════════════════════════════════════════════════════════
-- Self-check, as 0299 / 0419 / 0458 do.
-- ════════════════════════════════════════════════════════════════════════════
do $check$
begin
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.family_members'::regclass
                    and tgname = 'trg_family_member_parent_is_a_parents_to_make'
                    and tgenabled <> 'D') then
    raise exception '0482: the parent-role guard trigger is missing or disabled';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.family_members'::regclass
                    and tgname = 'trg_family_keeps_a_manager'
                    and tgdeferrable and tginitdeferred) then
    raise exception '0482: trg_family_keeps_a_manager (0299) is missing or no longer deferred';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.invites'::regclass
                    and tgname = 'trg_invite_terms_are_the_servers_to_set'
                    and tgenabled <> 'D') then
    raise exception '0482: the invite terms trigger is missing or disabled';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.family_members'::regclass
                    and tgname = 'trg_removed_member_keeps_no_sync_link'
                    and tgenabled <> 'D') then
    raise exception '0482: the removed-member sync trigger is missing or disabled';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.family_member_parent_is_a_parents_to_make()'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'public.invite_terms_are_the_servers_to_set()'::regprocedure) then
    raise exception '0482: the current_user guards must be SECURITY INVOKER, or current_user is the owner and every caller is exempt (0334)';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.removed_member_keeps_no_sync_link()'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.is_child_login_account()'::regprocedure) then
    raise exception '0482: removed_member_keeps_no_sync_link and is_child_login_account must be SECURITY DEFINER';
  end if;
end
$check$;
