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
--      callable by `authenticated`;
--   8. a kid login cannot join another family through an invite. Kid identity
--      is read from the account in auth.users: its synthetic address
--      (child.<username>@kids.bubaly.app, which any household can write an
--      invite to), with or without a child_logins row, or the server's
--      app_metadata mark on an account whose address is ordinary (a genuine
--      kid login whose address was moved). Each is refused with 0495's
--      sentence and leaves no member row in the inviting family;
--   9. neither a child_logins row nor a membership makes anyone a kid login. A
--      parent of a third household writes child_logins rows through the
--      table's own write policy for five adults who are not kid logins:
--      against an unlinked placeholder, against a guest's member row in a
--      FOURTH household, against the adult's own adult row in the mapping
--      household, against an ordinary-email CAREGIVER of the mapping household
--      (active, not a manager), and against an ordinary-email GUEST of it whose
--      membership is inactive. A sixth adult says {child: true} in the
--      user_metadata they can edit. Each still accepts their own invitation
--      with its role.
--
-- MUTATION CONTROLS. Each clause of the kid-login guard decides exactly one
-- case above, and with it taken out of the real function, inside this
-- transaction, that case must flip: without the address clause the unmapped
-- synthetic kid gets in; without the app_metadata clause the ordinary-address
-- kid gets in. A third control swaps the address clause for "holds a
-- child_logins row" (the trust 0495 must not place in that table), and the
-- caregiver the mapping household's parent mapped must then be refused.
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
\set UK '00000000-0000-4000-8495-0000000000a7'
\set UJ '00000000-0000-4000-8495-0000000000a8'
\set UQ '00000000-0000-4000-8495-0000000000a9'
\set UM '00000000-0000-4000-8495-0000000000b1'
\set V1 '00000000-0000-4000-8495-0000000000b2'
\set V2 '00000000-0000-4000-8495-0000000000b3'
\set UO '00000000-0000-4000-8495-0000000000b4'
\set V3 '00000000-0000-4000-8495-0000000000b5'
\set F  '00000000-0000-4000-8495-0000000000f1'
\set F2 '00000000-0000-4000-8495-0000000000f2'
\set F3 '00000000-0000-4000-8495-0000000000f3'
\set F4 '00000000-0000-4000-8495-0000000000f4'

begin;

insert into auth.users (id, email) values
  (:'UP','m0495-parent@example.com'),
  (:'UX','m0495-former-parent@example.com'),
  (:'UY','m0495-former-child@example.com'),
  (:'UA','m0495-adult@example.com'),
  (:'UN','m0495-new@example.com'),
  (:'UW','m0495-control@example.com'),
  (:'UK','child.m0495kid@kids.bubaly.app'),
  (:'UJ','m0495-kid-mapped@example.com'),
  (:'UQ','child.m0495solo@kids.bubaly.app'),
  (:'UM','m0495-mapper@example.com'),
  (:'V1','m0495-unlinked@example.com'),
  (:'V2','m0495-elsewhere@example.com'),
  (:'UO','m0495-elsewhere-parent@example.com'),
  (:'V3','m0495-coadult@example.com'),
  ('00000000-0000-4000-8495-0000000000b6','m0495-caregiver@example.com'),
  ('00000000-0000-4000-8495-0000000000b7','m0495-former-guest@example.com'),
  ('00000000-0000-4000-8495-0000000000b8','m0495-says-child@example.com')
  on conflict do nothing;
-- The genuine kid login under an ordinary address carries the server's mark;
-- the adult who claims to be a child does so in the metadata they can edit.
update auth.users set raw_app_meta_data = '{"bubaly_kid_login": true}'::jsonb where id = :'UJ';
update auth.users set raw_user_meta_data = '{"child": true}'::jsonb where id = '00000000-0000-4000-8495-0000000000b8';

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

-- Three kid logins that belong to that other household, linked to their member
-- rows the way the server links them. One has the synthetic address and its
-- child_logins row; one has the synthetic address and no row (the address
-- clause alone must refuse it); one has an ordinary address and the row (the
-- mapping clause alone must refuse it).
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8495-0000000000d1',:'F2',:'UK','Kid','child',true),
  ('00000000-0000-4000-8495-0000000000d2',:'F2',:'UJ','Mapped Kid','child',true),
  ('00000000-0000-4000-8495-0000000000d6',:'F2',:'UQ','Unmapped Kid','child',true);
insert into public.child_logins (family_id, member_id, user_id, username, created_by) values
  (:'F2','00000000-0000-4000-8495-0000000000d1',:'UK','m0495kid',:'UX'),
  (:'F2','00000000-0000-4000-8495-0000000000d2',:'UJ','m0495mapped',:'UX');

-- A third household, whose parent will write the poisoned mappings, with a
-- placeholder child (no login) and an adult whose login the server linked
-- there. A fourth household where the second poisoned adult is a guest.
insert into public.families (id, name, created_by) values (:'F3','Mapping House',:'UM') on conflict do nothing;
update public.family_members set role = 'parent', is_active = true where family_id = :'F3' and user_id = :'UM';
insert into public.families (id, name, created_by) values (:'F4','Elsewhere House',:'UO') on conflict do nothing;
update public.family_members set role = 'parent', is_active = true where family_id = :'F4' and user_id = :'UO';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8495-0000000000d3',:'F3',null,'Placeholder','child',true),
  ('00000000-0000-4000-8495-0000000000d4',:'F4',:'V2','Guest Elsewhere','guest',true),
  ('00000000-0000-4000-8495-0000000000d5',:'F3',:'V3','Co-adult','adult',true),
  ('00000000-0000-4000-8495-0000000000d7',:'F3','00000000-0000-4000-8495-0000000000b6','Caregiver','caregiver',true),
  ('00000000-0000-4000-8495-0000000000d8',:'F3','00000000-0000-4000-8495-0000000000b7','Former Guest','guest',false);

insert into public.invites (family_id, email, role, token, invited_by) values
  (:'F','m0495-former-parent@example.com','guest', 'm0495-tok-x', :'UP'),
  (:'F','M0495-Former-Child@example.com', 'adult', 'm0495-tok-y', :'UP'),
  (:'F','m0495-adult@example.com',        'parent','m0495-tok-a', :'UP'),
  (:'F','m0495-new@example.com',          'teen',  'm0495-tok-n', :'UP'),
  (:'F','m0495-control@example.com',      'guest', 'm0495-tok-w', :'UP'),
  (:'F','child.m0495kid@kids.bubaly.app', 'child', 'm0495-tok-k', :'UP'),
  (:'F','m0495-kid-mapped@example.com',   'child', 'm0495-tok-j', :'UP'),
  (:'F','child.m0495solo@kids.bubaly.app','child', 'm0495-tok-q', :'UP'),
  (:'F','m0495-unlinked@example.com',     'adult', 'm0495-tok-v1', :'UP'),
  (:'F','m0495-elsewhere@example.com',    'adult', 'm0495-tok-v2', :'UP'),
  (:'F','m0495-coadult@example.com',      'guest', 'm0495-tok-v3', :'UP'),
  (:'F','m0495-caregiver@example.com',    'adult', 'm0495-tok-v4', :'UP'),
  (:'F','m0495-former-guest@example.com', 'adult', 'm0495-tok-v5', :'UP'),
  (:'F','m0495-says-child@example.com',   'adult', 'm0495-tok-v6', :'UP');

do $$
declare
  fam   uuid := '00000000-0000-4000-8495-0000000000f1';
  fam2  uuid := '00000000-0000-4000-8495-0000000000f2';
  ux    uuid := '00000000-0000-4000-8495-0000000000a2';
  uy    uuid := '00000000-0000-4000-8495-0000000000a3';
  ua    uuid := '00000000-0000-4000-8495-0000000000a4';
  un    uuid := '00000000-0000-4000-8495-0000000000a5';
  uw    uuid := '00000000-0000-4000-8495-0000000000a6';
  uk    uuid := '00000000-0000-4000-8495-0000000000a7';
  uj    uuid := '00000000-0000-4000-8495-0000000000a8';
  uq    uuid := '00000000-0000-4000-8495-0000000000a9';
  um    uuid := '00000000-0000-4000-8495-0000000000b1';
  v1    uuid := '00000000-0000-4000-8495-0000000000b2';
  v2    uuid := '00000000-0000-4000-8495-0000000000b3';
  v3    uuid := '00000000-0000-4000-8495-0000000000b5';
  v4    uuid := '00000000-0000-4000-8495-0000000000b6';
  v5    uuid := '00000000-0000-4000-8495-0000000000b7';
  v6    uuid := '00000000-0000-4000-8495-0000000000b8';
  fam3  uuid := '00000000-0000-4000-8495-0000000000f3';
  kid   record;
  victim record;
  m     record;
  joined boolean;
  err   text;
  poisoned_by_policy boolean;
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

  -- The third household's parent writes three child_logins rows, through the
  -- table's own write policy, naming adults who are not its kids. Should that
  -- policy ever refuse them, the rows are written as the server instead: the
  -- question here is what accept_invite believes, not who could write them.
  perform set_config('request.jwt.claim.sub', um::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated', 'email', 'm0495-mapper@example.com')::text, true);
  poisoned_by_policy := true;
  begin
    insert into public.child_logins (family_id, member_id, user_id, username, created_by) values
      (fam3, '00000000-0000-4000-8495-0000000000d3', v1, 'm0495poisona', um),
      (fam3, '00000000-0000-4000-8495-0000000000d4', v2, 'm0495poisonb', um),
      (fam3, '00000000-0000-4000-8495-0000000000d5', v3, 'm0495poisonc', um),
      (fam3, '00000000-0000-4000-8495-0000000000d7', v4, 'm0495poisond', um),
      (fam3, '00000000-0000-4000-8495-0000000000d8', v5, 'm0495poisone', um);
  exception when insufficient_privilege then
    poisoned_by_policy := false;
  end;
  if not poisoned_by_policy then
    perform set_config('role','postgres', true);
    insert into public.child_logins (family_id, member_id, user_id, username, created_by) values
      (fam3, '00000000-0000-4000-8495-0000000000d3', v1, 'm0495poisona', um),
      (fam3, '00000000-0000-4000-8495-0000000000d4', v2, 'm0495poisonb', um),
      (fam3, '00000000-0000-4000-8495-0000000000d5', v3, 'm0495poisonc', um),
      (fam3, '00000000-0000-4000-8495-0000000000d7', v4, 'm0495poisond', um),
      (fam3, '00000000-0000-4000-8495-0000000000d8', v5, 'm0495poisone', um);
    perform set_config('role','authenticated', true);
  end if;

  -- Each poisoned adult accepts the invitation addressed to them, as themselves.
  for victim in select * from (values
      (v1, 'm0495-unlinked@example.com',  'm0495-tok-v1', 'an adult mapped against another household''s unlinked placeholder'),
      (v2, 'm0495-elsewhere@example.com', 'm0495-tok-v2', 'a guest of a fourth household mapped through their member row there'),
      (v3, 'm0495-coadult@example.com',   'm0495-tok-v3', 'an adult of the mapping household mapped through their own adult member row'),
      (v4, 'm0495-caregiver@example.com', 'm0495-tok-v4', 'an ordinary-email caregiver of the mapping household its parent mapped'),
      (v5, 'm0495-former-guest@example.com', 'm0495-tok-v5', 'an ordinary-email guest of the mapping household, inactive, its parent mapped'),
      (v6, 'm0495-says-child@example.com', 'm0495-tok-v6', 'an adult whose own user_metadata says child')
    ) as v(uid, email, token, label) loop
    perform set_config('request.jwt.claim.sub', victim.uid::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', victim.uid, 'role', 'authenticated', 'email', victim.email)::text, true);
    begin
      got := public.accept_invite(victim.token);
      if got is distinct from fam then
        failures := array_append(failures, format('%s: their accept answered %s, not the family', victim.label, got));
      end if;
    exception when others then
      failures := array_append(failures, format('%s could not accept their own invitation: %s', victim.label, sqlerrm));
    end;
  end loop;

  -- Each kid login opens the other household's link, as itself.
  for kid in select * from (values
      (uk, 'child.m0495kid@kids.bubaly.app',  'm0495-tok-k', 'a kid login on its synthetic address and holding a child_logins row'),
      (uq, 'child.m0495solo@kids.bubaly.app', 'm0495-tok-q', 'a kid login on its synthetic address with no child_logins row'),
      (uj, 'm0495-kid-mapped@example.com',    'm0495-tok-j', 'a kid login under an ordinary address carrying the server''s app_metadata mark')
    ) as k(uid, email, token, label) loop
    perform set_config('request.jwt.claim.sub', kid.uid::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', kid.uid, 'role', 'authenticated', 'email', kid.email)::text, true);
    begin
      perform public.accept_invite(kid.token);
      failures := array_append(failures, format('%s joined another family through an invite', kid.label));
    exception when others then
      if sqlerrm not like '%kid login cannot join another family%' then
        failures := array_append(failures, format('%s was refused for another reason: %s', kid.label, sqlerrm));
      end if;
    end;
  end loop;

  perform set_config('role','postgres', true);

  select count(*) into n from public.family_members where family_id = fam and user_id in (uk, uj, uq);
  if n <> 0 then failures := array_append(failures, format('%s kid login(s) hold a member row in the household that invited them', n)); end if;

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
  for victim in select * from (values
      (v1, 'adult', 'an adult mapped against another household''s unlinked placeholder'),
      (v2, 'adult', 'a guest of a fourth household mapped through their member row there'),
      (v3, 'guest', 'an adult of the mapping household mapped through their own adult member row'),
      (v4, 'adult', 'an ordinary-email caregiver of the mapping household its parent mapped'),
      (v5, 'adult', 'an ordinary-email guest of the mapping household, inactive, its parent mapped'),
      (v6, 'adult', 'an adult whose own user_metadata says child')
    ) as v(uid, role, label) loop
    select role::text, is_active into r, act from public.family_members where family_id = fam and user_id = victim.uid;
    if r is distinct from victim.role or act is not true then
      failures := array_append(failures, format('%s, invited as %s, is %s in the inviting family (active=%s)', victim.label, victim.role, coalesce(r, 'not a member'), act));
    end if;
  end loop;

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

  -- MUTATION CONTROLS: take one clause of the kid-login guard out of the real
  -- function and replay the one case that clause alone decides. A kid must
  -- then get in, or a poisoned adult's re-accept must then be refused as a
  -- kid login. On the released schema there is no guard to take apart, and
  -- the kid cases above have already failed.
  select pg_get_functiondef('public.accept_invite(text)'::regprocedure) into original_def;
  if position('kid login cannot join another family' in original_def) > 0 then
    for m in select * from (values
        ($c$right(lower(coalesce(u.email, '')), length('@kids.bubaly.app')) = '@kids.bubaly.app'$c$, 'false',
         uq, 'child.m0495solo@kids.bubaly.app', 'm0495-tok-q', true,
         'without the address clause, the kid login on its synthetic address with no child_logins row'),
        ($c$coalesce(u.raw_app_meta_data->>'bubaly_kid_login', '') = 'true'$c$, 'false',
         uj, 'm0495-kid-mapped@example.com', 'm0495-tok-j', true,
         'without the app_metadata clause, the kid login under an ordinary address'),
        ($c$right(lower(coalesce(u.email, '')), length('@kids.bubaly.app')) = '@kids.bubaly.app'$c$,
         $c$exists (select 1 from public.child_logins cl where cl.user_id = u.id)$c$,
         v4, 'm0495-caregiver@example.com', 'm0495-tok-v4', false,
         'trusting child_logins instead, the caregiver its household''s parent mapped')
      ) as x(clause, replacement, uid, email, token, kid_gets_in, label) loop
      if position(m.clause in original_def) = 0 then
        failures := array_append(failures, format('PROBE DRIFT: the guard no longer contains %s, so its mutation control measures nothing', m.clause));
        continue;
      end if;
      perform set_config('role','postgres', true);
      execute replace(original_def, m.clause, m.replacement);
      perform set_config('role','authenticated', true);
      perform set_config('request.jwt.claim.sub', m.uid::text, true);
      perform set_config('request.jwt.claims', json_build_object('sub', m.uid, 'role', 'authenticated', 'email', m.email)::text, true);
      joined := true;
      err := null;
      begin
        perform public.accept_invite(m.token);
      exception when others then
        joined := false;
        err := sqlerrm;
      end;
      perform set_config('role','postgres', true);
      execute original_def;
      if m.kid_gets_in and not joined then
        failures := array_append(failures, format('MUTATION CONTROL: %s was still refused (%s), so this probe cannot tell whether that clause is there', m.label, err));
      elsif not m.kid_gets_in and (joined or err not like '%kid login cannot join another family%') then
        failures := array_append(failures, format('MUTATION CONTROL: %s was not refused as a kid login (%s), so this probe cannot tell whether that clause is there', m.label, coalesce(err, 'accepted')));
      end if;
    end loop;
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
  raise notice 'a-member-invited-back-gets-the-invited-role: OK (a removed parent invited back as a guest is a guest who cannot manage the family; a removed child invited back as an adult is an adult; an active adult''s self-addressed parent invite leaves them an adult; a first-time teen invite lands as a teen; the other family is untouched; a repeated accept stays idempotent; a kid login on its synthetic address with or without a child_logins row, or under an ordinary address with the server''s app_metadata mark, is refused and left out of the inviting family; five adults named in child_logins rows a household''s parent wrote (unlinked placeholder, a fourth household''s guest row, their own adult row, an active ordinary-email caregiver, an inactive ordinary-email guest; written %) and an adult whose own user_metadata says child each accepted their invitation with its role; mutation controls: without the address or the app_metadata clause its kid got in, and trusting child_logins instead refused the mapped caregiver; accept_invite is SECURITY DEFINER, search_path pinned, callable by authenticated; negative control: 0136''s conflict arm restored the removed parent''s old parent role)',
    case when poisoned_by_policy then 'by that household''s parent through child_logins'' own write policy'
         else 'as the server, because that policy now refuses the parent' end;
end $$;

rollback;
