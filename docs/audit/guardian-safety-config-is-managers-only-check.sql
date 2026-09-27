-- ── AUTHZ-005 A child cannot rewrite the screening that protects them ───────
--
-- `guardian_contacts` holds per-contact TRUST LEVELS and
-- `guardian_member_profiles` holds each member's per-trust-band ROUTING MODES
-- (`default_mode_unknown` is the one applied to a caller never seen before).
-- Between them they decide whether an incoming call or text is screened,
-- blocked, allowed straight through, or escalated to a parent — the
-- configuration of the AI Call Guardian, whose whole purpose is protecting a
-- child from scam and grooming contact.
--
-- Before 0318, `01370_ai_call_guardian.sql` gave both tables a policy
-- `FOR ALL TO authenticated USING (is_family_member(family_id))`. `FOR ALL`
-- covers INSERT, UPDATE and DELETE, so the rule deciding who may change a
-- child's protection asked only whether the caller was in the household — and
-- the child is in the household.
--
-- The application had already written this down. app/(app)/guardian/actions.ts:
--
--   "RLS on the guardian tables is family-scoped (any member), and children have
--    real logins, so these server actions are the authorization boundary: only a
--    family manager (parent/adult) may change safety config."
--
-- Both halves are true and together they are the defect: a server action is not
-- a boundary against a JWT holder. Children have real logins, and a request to
-- /rest/v1/guardian_contacts never passes through app/ at all. A teen wanting an
-- unscreened line to a stranger needed one HTTP request, not a defeated UI.
--
-- Proves the boundary behaviourally, in both directions:
--
--   1. a child cannot mark a contact trusted, nor take their own profile out of
--      screening, nor delete either row;
--   2. a manager still can — a guard that refuses everyone is not a boundary;
--   3. a child CAN still read, recorded rather than asserted as a defect: the
--      Guardian screens render from these rows and a child seeing their own
--      configuration is honest. If that ever changes this line fails on purpose;
--   4. UPDATE pins `family_id` on BOTH sides, so a manager of family A cannot
--      move a row into family B. A missing WITH CHECK is exactly how S-01 let a
--      caller relocate a row into a scope they did not hold.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/guardian-safety-config-is-managers-only-check.sql

\set FG '00000000-0000-4000-8000-0000000000d1'
\set FH '00000000-0000-4000-8000-0000000000d2'
\set UP '00000000-0000-4000-8000-0000000000d3'
\set UK '00000000-0000-4000-8000-0000000000d4'
\set UO '00000000-0000-4000-8000-0000000000d5'

begin;

insert into auth.users (id, email) values (:'UP','g-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','g-kid@example.com')    on conflict do nothing;
insert into auth.users (id, email) values (:'UO','g-other@example.com')  on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FG','Guardian House',:'UP') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FH','Other House',:'UO')    on conflict do nothing;

insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-0000000000d6',:'FG',:'UK','Kid','child',true) on conflict do nothing;
-- The creator is provisioned as a manager by on_family_created; make sure of it
-- rather than assuming, because a seed whose roles are wrong proves nothing.
update public.family_members set role = 'parent' where family_id = :'FG' and user_id = :'UP';
update public.family_members set role = 'parent' where family_id = :'FH' and user_id = :'UO';

insert into public.guardian_contacts (id, family_id, phone, name, trust_level)
  values ('00000000-0000-4000-8000-0000000000d7', :'FG', '+15550100', 'Unknown Caller', 'unknown');
-- `default_mode_unknown` is the mode applied to a caller the household has never
-- seen — the setting that actually decides whether a stranger reaches this child.
insert into public.guardian_member_profiles (id, family_id, member_id, default_mode_unknown)
  values ('00000000-0000-4000-8000-0000000000d8', :'FG', '00000000-0000-4000-8000-0000000000d6', 'ai_handle_first');

grant select, insert, update, delete on public.guardian_contacts        to authenticated;
grant select, insert, update, delete on public.guardian_member_profiles to authenticated;

do $$
declare
  n int;
  failures text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-0000000000d1';
  other_fam constant uuid := '00000000-0000-4000-8000-0000000000d2';
  parent_u  constant uuid := '00000000-0000-4000-8000-0000000000d3';
  kid_u     constant uuid := '00000000-0000-4000-8000-0000000000d4';
  kid_m     constant uuid := '00000000-0000-4000-8000-0000000000d6';
  contact   constant uuid := '00000000-0000-4000-8000-0000000000d7';
  profile   constant uuid := '00000000-0000-4000-8000-0000000000d8';
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- The move that matters: promote a stranger to trusted, so their calls stop
  -- being screened.
  update public.guardian_contacts set trust_level = 'trusted_friend' where id = contact;
  get diagnostics n = row_count;
  if n <> 0 then
    failures := array_append(failures, format('a child TRUSTED %s screened contact(s) — an unscreened line to a stranger', n));
  end if;

  -- The same escape one level up: take themselves out of screening entirely.
  update public.guardian_member_profiles set default_mode_unknown = 'immediate_ring' where id = profile;
  get diagnostics n = row_count;
  if n <> 0 then
    failures := array_append(failures, format('a child set %s profile(s) to ring an unknown caller straight through', n));
  end if;

  -- Deleting the configuration is the same escape by another route.
  delete from public.guardian_contacts where id = contact;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s contact trust row(s)', n)); end if;

  delete from public.guardian_member_profiles where id = profile;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s routing profile(s)', n)); end if;

  -- And planting a pre-trusted contact for themselves. `unique_violation` is
  -- caught alongside success on purpose: RLS is checked BEFORE a unique index,
  -- so an insert that reaches the constraint is one RLS let through and must be
  -- reported as a breach rather than swallowed.
  begin
    insert into public.guardian_contacts (family_id, phone, name, trust_level)
      values (fam, '+15550199', 'Planted By The Child', 'trusted_friend');
    failures := array_append(failures, 'a child INSERTED a pre-trusted contact');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s INSERT reached the unique index, so RLS did not refuse it');
  end;

  -- Reads stay open, deliberately. Recorded so the decision is visible.
  select count(*) into n from public.guardian_contacts where id = contact;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ contact trust — that is a change of decision; update finalaudit.md and this probe');
  end if;

  -- ── As the parent: the positive control ─────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  update public.guardian_contacts set trust_level = 'trusted_friend' where id = contact;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not set contact trust — the guard refuses everyone'); end if;

  update public.guardian_member_profiles set default_mode_unknown = 'immediate_ring' where id = profile;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not change a routing profile'); end if;

  begin
    insert into public.guardian_contacts (family_id, phone, name, trust_level)
      values (fam, '+15550200', 'Added By The Parent', 'trusted_friend');
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not add a contact');
  end;

  -- ── The WITH CHECK half: a manager may not relocate a row ───────────────
  -- USING alone would let this through, and the row would land in a household
  -- this caller manages nothing in.
  begin
    update public.guardian_contacts set family_id = other_fam where id = contact;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, 'a manager MOVED a contact trust row into another family — WITH CHECK is missing');
    end if;
  exception when insufficient_privilege then null;
  end;

  -- ── Negative control: prove this probe can SEE the defect ──────────────
  -- A boundary check that passes is worth nothing until it has been shown to
  -- fail against the thing it claims to catch. Restore 01370's permissive
  -- `FOR ALL` policy, re-run the child's escalation, and require that it now
  -- SUCCEEDS. The outer rollback undoes the policy along with everything else.
  perform set_config('role','postgres', true);
  drop policy if exists guardian_contacts_insert on public.guardian_contacts;
  drop policy if exists guardian_contacts_update on public.guardian_contacts;
  drop policy if exists guardian_contacts_delete on public.guardian_contacts;
  execute 'create policy "Family member can manage guardian_contacts" on public.guardian_contacts '
       || 'for all to authenticated using (is_family_member(family_id)) with check (is_family_member(family_id))';

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  update public.guardian_contacts set trust_level = 'immediate_family' where id = contact;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with 01370''s permissive policy restored the child STILL could not raise trust — this probe is decoration, not a boundary');
  end if;

  perform set_config('role','postgres', true);

  if array_length(failures, 1) is not null then
    raise exception E'guardian safety config is not manager-only:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'guardian-safety-config-is-managers-only: OK (child blocked, manager allowed, family_id pinned, negative control saw the defect)';
end $$;

rollback;
