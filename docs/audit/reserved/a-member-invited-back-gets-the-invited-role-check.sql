-- ── A member invited back gets the role the invite grants ──────────────────
--
-- Removing a member is a soft delete: `update family_members set is_active =
-- false` (the family and settings modules, and the Super Admin's remove). The
-- row keeps its role. `accept_invite` (0136) then lands an invitee with
--
--   insert into family_members (..., role, ...) values (..., v_invite.role, ...)
--   on conflict (family_id, user_id) do update set is_active = true;
--
-- and the conflict arm never reads the invite's role. So a parent who was
-- removed and later invited back as a GUEST came back as a PARENT, with every
-- manager power and the parent-only ones (families_delete, assistant keys,
-- money). The family's newest decision about that person was the invite; the
-- row's old role was the decision it replaced. The same arm also kept a former
-- child a child when the family invited them back as an adult.
--
-- The held 0495 (supabase/reserved/) applies the invite's role whenever the
-- caller was NOT an active member before accepting (no row, or an inactive
-- one). An ACTIVE member's role is
-- left exactly as it was: accepting an invite is not a way to change a role,
-- and if it were, an adult could address a parent invite to themselves and
-- promote themselves by accepting it.
--
-- What this probe asserts, as the invitee and through the real function:
--
--   1. a removed parent invited back as a guest is an active GUEST, and
--      `can_manage_family` answers no for them;
--   2. a removed child invited back as an adult is an active ADULT;
--   3. an active adult accepting a parent invite addressed to themselves stays
--      an ADULT (control: an active member's role does not move);
--   4. a first-time invitee lands with the invite's role (control: the insert
--      path is unchanged);
--   5. the removed parent's row in ANOTHER family is untouched;
--   6. re-accepting the same invite answers the family and keeps the role
--      (0136's idempotence is preserved);
--   7. accept_invite is still SECURITY DEFINER with a pinned search_path and
--      callable by `authenticated`.
--
-- NEGATIVE CONTROL. Inside this transaction the function is put back to 0136's
-- conflict arm, and a second removed parent invited back as a guest must then
-- come back as a PARENT. That proves the fixture detects the defect, so a green
-- run is the fix's and not a fixture that cannot see it. Everything here is
-- rolled back.
--
-- HELD with 0495: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/invite-rejoin-role-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0495 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

\set UP '00000000-0000-4000-8495-0000000000a1'
\set UX '00000000-0000-4000-8495-0000000000a2'
\set UY '00000000-0000-4000-8495-0000000000a3'
\set UA '00000000-0000-4000-8495-0000000000a4'
\set UN '00000000-0000-4000-8495-0000000000a5'
\set UW '00000000-0000-4000-8495-0000000000a6'
\set F  '00000000-0000-4000-8495-0000000000f1'
\set F2 '00000000-0000-4000-8495-0000000000f2'

begin;

insert into auth.users (id, email) values
  (:'UP','m0495-parent@example.com'),
  (:'UX','m0495-former-parent@example.com'),
  (:'UY','m0495-former-child@example.com'),
  (:'UA','m0495-adult@example.com'),
  (:'UN','m0495-new@example.com'),
  (:'UW','m0495-control@example.com')
  on conflict do nothing;

insert into public.families (id, name, created_by) values (:'F','Invited Back House',:'UP') on conflict do nothing;
update public.family_members set role = 'parent', is_active = true where family_id = :'F' and user_id = :'UP';
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  (:'F',:'UX','Former Parent','parent',false),
  (:'F',:'UY','Former Child','child',false),
  (:'F',:'UA','Adult','adult',true),
  (:'F',:'UW','Control Parent','parent',false)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = excluded.is_active;

-- The former parent still runs their own household, where nothing may change.
insert into public.families (id, name, created_by) values (:'F2','Former Parent Elsewhere',:'UX') on conflict do nothing;
update public.family_members set role = 'parent', is_active = true where family_id = :'F2' and user_id = :'UX';

insert into public.invites (family_id, email, role, token, invited_by) values
  (:'F','m0495-former-parent@example.com','guest', 'm0495-tok-x', :'UP'),
  (:'F','M0495-Former-Child@example.com', 'adult', 'm0495-tok-y', :'UP'),
  (:'F','m0495-adult@example.com',        'parent','m0495-tok-a', :'UP'),
  (:'F','m0495-new@example.com',          'teen',  'm0495-tok-n', :'UP'),
  (:'F','m0495-control@example.com',      'guest', 'm0495-tok-w', :'UP');

do $$
declare
  fam   uuid := '00000000-0000-4000-8495-0000000000f1';
  fam2  uuid := '00000000-0000-4000-8495-0000000000f2';
  ux    uuid := '00000000-0000-4000-8495-0000000000a2';
  uy    uuid := '00000000-0000-4000-8495-0000000000a3';
  ua    uuid := '00000000-0000-4000-8495-0000000000a4';
  un    uuid := '00000000-0000-4000-8495-0000000000a5';
  uw    uuid := '00000000-0000-4000-8495-0000000000a6';
  failures text[] := '{}';
  got   uuid;
  r     text;
  act   boolean;
  manages boolean;
  n     int;
  original_def text;
begin
  -- Each invitee accepts their own invite, as themselves. auth.uid() and
  -- auth.jwt() read different settings, so both are set and both are checked:
  -- an impersonation that took only one would make every assertion vacuous.
  perform set_config('role','authenticated', true);

  perform set_config('request.jwt.claim.sub', ux::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', ux, 'role', 'authenticated', 'email', 'm0495-former-parent@example.com')::text, true);
  if auth.uid() is distinct from ux or auth.jwt()->>'email' <> 'm0495-former-parent@example.com' then
    raise exception 'CONTROL: the impersonation did not take; nothing below would measure anything';
  end if;
  got := public.accept_invite('m0495-tok-x');
  if got is distinct from fam then failures := array_append(failures, format('the former parent''s accept answered %s, not the family', got)); end if;
  manages := public.can_manage_family(fam);
  if manages then failures := array_append(failures, 'the former parent, invited back as a guest, can manage the family'); end if;
  -- 0136 made a second accept of one's own invite a success; that must hold.
  got := public.accept_invite('m0495-tok-x');
  if got is distinct from fam then failures := array_append(failures, format('re-accepting the same invite answered %s, not the family', got)); end if;

  perform set_config('request.jwt.claim.sub', uy::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uy, 'role', 'authenticated', 'email', 'm0495-former-child@example.com')::text, true);
  perform public.accept_invite('m0495-tok-y');

  perform set_config('request.jwt.claim.sub', ua::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated', 'email', 'm0495-adult@example.com')::text, true);
  perform public.accept_invite('m0495-tok-a');

  perform set_config('request.jwt.claim.sub', un::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', un, 'role', 'authenticated', 'email', 'm0495-new@example.com')::text, true);
  perform public.accept_invite('m0495-tok-n');

  perform set_config('role','postgres', true);

  select role::text, is_active into r, act from public.family_members where family_id = fam and user_id = ux;
  if r is distinct from 'guest' or act is not true then
    failures := array_append(failures, format('a removed parent invited back as a guest came back as %s (active=%s)', r, act));
  end if;
  select role::text, is_active into r, act from public.family_members where family_id = fam and user_id = uy;
  if r is distinct from 'adult' or act is not true then
    failures := array_append(failures, format('a removed child invited back as an adult came back as %s (active=%s)', r, act));
  end if;
  select role::text, is_active into r, act from public.family_members where family_id = fam and user_id = ua;
  if r is distinct from 'adult' or act is not true then
    failures := array_append(failures, format('an active adult who accepted a parent invite addressed to themselves is now %s (active=%s); an invite must not change an active member''s role', r, act));
  end if;
  select role::text, is_active into r, act from public.family_members where family_id = fam and user_id = un;
  if r is distinct from 'teen' or act is not true then
    failures := array_append(failures, format('a first-time invitee invited as a teen landed as %s (active=%s)', r, act));
  end if;
  select role::text, is_active into r, act from public.family_members where family_id = fam2 and user_id = ux;
  if r is distinct from 'parent' or act is not true then
    failures := array_append(failures, format('the former parent''s row in their OTHER family changed to %s (active=%s)', r, act));
  end if;
  select count(*) into n from public.family_members where family_id = fam and user_id in (ux, uy, ua, un);
  if n <> 4 then failures := array_append(failures, format('%s member rows for four invitees; an accept must neither duplicate nor drop a row', n)); end if;
  select count(*) into n from public.invites where family_id = fam and token in ('m0495-tok-x','m0495-tok-y','m0495-tok-a','m0495-tok-n') and status = 'accepted';
  if n <> 4 then failures := array_append(failures, format('%s of 4 accepted invites are marked accepted', n)); end if;

  select count(*) into n from pg_proc p
   where p.oid = 'public.accept_invite(text)'::regprocedure
     and p.prosecdef
     and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%');
  if n <> 1 then failures := array_append(failures, 'accept_invite is not SECURITY DEFINER with a pinned search_path'); end if;
  if not has_function_privilege('authenticated', 'public.accept_invite(text)', 'EXECUTE') then
    failures := array_append(failures, 'authenticated may not EXECUTE accept_invite, so no invite can be accepted');
  end if;

  -- NEGATIVE CONTROL: 0136's conflict arm, which reactivates without reading
  -- the invite's role. Under it the control parent must come back a PARENT.
  select pg_get_functiondef('public.accept_invite(text)'::regprocedure) into original_def;
  execute $old$
    create or replace function public.accept_invite(p_token text)
    returns uuid language plpgsql security definer set search_path = public as $f$
    declare
      v_invite public.invites;
      v_name   text;
    begin
      select * into v_invite from public.invites where token = p_token for update;
      if not found then raise exception 'Invite is invalid or expired'; end if;
      if v_invite.status = 'accepted' and v_invite.accepted_by = auth.uid() then return v_invite.family_id; end if;
      if v_invite.status <> 'pending' or v_invite.expires_at <= now() then raise exception 'Invite is invalid or expired'; end if;
      if lower(v_invite.email) <> lower(coalesce(auth.jwt()->>'email','')) then raise exception 'This invite was issued to a different email'; end if;
      select coalesce(full_name, display_name, email) into v_name from public.profiles where id = auth.uid();
      insert into public.family_members (family_id, user_id, role, display_name)
      values (v_invite.family_id, auth.uid(), v_invite.role, coalesce(v_name,'Member'))
      on conflict (family_id, user_id) do update set is_active = true;
      update public.invites set status = 'accepted', accepted_by = auth.uid(), updated_at = now() where id = v_invite.id;
      return v_invite.family_id;
    end; $f$
  $old$;
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', uw::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uw, 'role', 'authenticated', 'email', 'm0495-control@example.com')::text, true);
  perform public.accept_invite('m0495-tok-w');
  perform set_config('role','postgres', true);
  execute original_def;
  select role::text into r from public.family_members where family_id = fam and user_id = uw;
  if r is distinct from 'parent' then
    failures := array_append(failures, format('NEGATIVE CONTROL: under 0136''s conflict arm the removed parent invited back as a guest came back as %s, not parent, so this fixture cannot see the defect', r));
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a member invited back does not get the invited role:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-member-invited-back-gets-the-invited-role: OK (a removed parent invited back as a guest is a guest who cannot manage the family; a removed child invited back as an adult is an adult; an active adult''s self-addressed parent invite leaves them an adult; a first-time teen invite lands as a teen; the other family is untouched; a repeated accept stays idempotent; accept_invite is SECURITY DEFINER, search_path pinned, callable by authenticated; negative control: 0136''s conflict arm restored the removed parent''s old parent role)';
end $$;

rollback;
