-- ── An invitee may not rewrite the invite they are about to accept ──────────
--
-- `accept_invite` copies the invite's `role` straight into `family_members`, so
-- whoever controls that column controls the role. Before 0298, `invites_update`
-- carried a USING arm matching the invitee's own email and NO `WITH CHECK` —
-- and when WITH CHECK is omitted Postgres reuses USING for the new row, which
-- "the email is still mine" satisfies. So the invitee could set `role` to
-- 'parent', repoint `family_id` at any family at all, and push `expires_at` out.
--
-- This probe is written to FAIL LOUDLY rather than quietly pass. Every claim it
-- makes about a refusal is preceded by a control proving the refusal came from
-- the policy and not from a broken setup: the impersonation is asserted to have
-- taken (auth.uid() AND auth.jwt()->>'email', which read DIFFERENT GUCs — the
-- dotted `request.jwt.claim.sub` and the JSON `request.jwt.claims` — so setting
-- only one makes every check below vacuous), RLS is shown to be live, and the
-- legitimate flow is shown to still work. A probe that only checks that an
-- attack fails cannot tell a fixed policy from a broken fixture.
--
-- ── the fixture is fresh on every run ───────────────────────────────────────
--
-- The ids below are random per run but the emails used to be string literals,
-- and `auth.users` carries a partial unique index on email. So the probe passed
-- against a virgin database and then failed on the SECOND run for the rest of
-- time:
--
--   ERROR: duplicate key value violates unique constraint "users_email_partial_key"
--   DETAIL: Key (email)=(probe-owner@example.com) already exists.
--
-- That failure is indistinguishable, in a red CI run, from the invite boundary
-- actually breaking — and the natural response to a probe that fails for
-- fixture reasons is to stop running it. The email is load-bearing here (the
-- invite is matched by email and the forged JWT has to carry the same one), so
-- it is derived from the run's uuid rather than dropped.
\set ON_ERROR_STOP on

-- Rows left behind by runs from before the emails were unique. Scoped to this
-- probe's own literals so a concurrent probe's fixture is never touched.
delete from auth.users where email in (
  'probe-owner@example.com', 'probe-invitee@example.com', 'probe-mgr@example.com');

do $$
declare
  fid      uuid := gen_random_uuid();
  other    uuid := gen_random_uuid();
  owner    uuid := gen_random_uuid();
  invitee  uuid := gen_random_uuid();
  tok      text := 'probe_' || replace(gen_random_uuid()::text, '-', '');
  othertok text := 'probe_' || replace(gen_random_uuid()::text, '-', '');
  -- Unique per run: auth.users has a partial unique index on email.
  owner_em text := 'probe-owner-'   || owner   || '@example.com';
  inv_em   text := 'probe-invitee-' || invitee || '@example.com';
  other_em text := 'a-different-person-' || other || '@example.com';
  n        int;
  landed   text;
  blocked  boolean;
begin
  -- ── Fixture (as the table owner; setup is not the test) ──
  insert into auth.users(id, email) values
    (owner, owner_em), (invitee, inv_em);
  insert into public.families(id, name) values (fid, 'Probe'), (other, 'Unrelated');
  insert into public.family_members(family_id, user_id, role, display_name, is_active)
    values (fid, owner, 'parent', 'Owner', true);
  insert into public.invites(family_id, email, role, token, status, invited_by, expires_at) values
    (fid,   inv_em,   'guest', tok,      'pending', owner, now() + interval '7 days'),
    (other, other_em, 'guest', othertok, 'pending', owner, now() + interval '7 days');

  -- ── Become the invitee ──
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', invitee::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', invitee::text, 'email', inv_em)::text, true);

  -- ── Guards: prove the probe is testing what it claims ──
  if current_user <> 'authenticated' then
    raise exception 'INVITE-ESC FAIL: running as %, so RLS is not being enforced at all', current_user;
  end if;
  if auth.uid() is distinct from invitee then
    raise exception 'INVITE-ESC FAIL: auth.uid() is %, expected the invitee — impersonation did not take', auth.uid();
  end if;
  if auth.jwt()->>'email' is distinct from inv_em then
    raise exception 'INVITE-ESC FAIL: auth.jwt() email is % — the email arm is untested', auth.jwt()->>'email';
  end if;
  if public.can_manage_family(fid) then
    raise exception 'INVITE-ESC FAIL: the invitee already manages the family; every refusal below would be meaningless';
  end if;

  -- ── Controls: RLS is live in BOTH directions ──
  select count(*) into n from public.invites where token = othertok;
  if n <> 0 then
    raise exception 'INVITE-ESC FAIL: another person''s invite is visible (% rows) — invites_select is not holding', n;
  end if;
  begin
    insert into public.family_members(family_id, user_id, role, display_name, is_active)
      values (fid, invitee, 'parent', 'sneak', true);
    blocked := false;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'INVITE-ESC FAIL: a non-member wrote family_members directly — the escalation path below is the least of it';
  end if;
  -- The invitee MUST still be able to read their own invite, or the refusals
  -- below could simply be a row nobody can see.
  select count(*) into n from public.invites where token = tok;
  if n <> 1 then
    raise exception 'INVITE-ESC FAIL: the invitee cannot see their own invite (% rows) — the flow is broken, and the refusals below prove nothing', n;
  end if;

  -- ── The attacks ──
  update public.invites set role = 'parent' where token = tok;
  get diagnostics n = ROW_COUNT;
  if n <> 0 then
    raise exception 'INVITE-ESC FAIL: the invitee rewrote their own invite role (% rows); accept_invite will hand them that role', n;
  end if;

  begin
    update public.invites set family_id = other, role = 'parent' where token = tok;
    get diagnostics n = ROW_COUNT;
    if n <> 0 then
      raise exception 'INVITE-ESC FAIL: the invitee repointed their invite at an unrelated family (% rows)', n;
    end if;
  exception when insufficient_privilege then null;  -- refused by WITH CHECK, which is the point
  end;

  update public.invites set expires_at = now() + interval '999 days' where token = tok;
  get diagnostics n = ROW_COUNT;
  if n <> 0 then
    raise exception 'INVITE-ESC FAIL: the invitee extended their own invite expiry (% rows)', n;
  end if;

  -- ── The legitimate flow still works, at the role that was GRANTED ──
  perform public.accept_invite(tok);
  select role::text into landed from public.family_members where family_id = fid and user_id = invitee;
  if landed is distinct from 'guest' then
    raise exception 'INVITE-ESC FAIL: accept_invite landed the invitee as %, expected guest', coalesce(landed, '(no member row)');
  end if;
  if public.accept_invite(tok) is distinct from fid then
    raise exception 'INVITE-ESC FAIL: re-accepting is no longer idempotent (0136 regressed)';
  end if;

  raise notice 'INVITE-ESC OK: role rewrite, family pivot and expiry extension all refused; the invitee still accepts at the granted role';
end $$;

-- ── A manager must keep managing ──
do $$
declare
  fid uuid := gen_random_uuid(); other uuid := gen_random_uuid();
  owner uuid := gen_random_uuid();
  tok text := 'probe_' || replace(gen_random_uuid()::text, '-', '');
  mgr_em text := 'probe-mgr-' || owner || '@example.com';
  guest_em text := 'someone-' || owner || '@example.com';
  n int;
begin
  insert into auth.users(id, email) values (owner, mgr_em);
  insert into public.families(id, name) values (fid, 'Managed'), (other, 'Unmanaged');
  insert into public.family_members(family_id, user_id, role, display_name, is_active)
    values (fid, owner, 'parent', 'Owner', true);
  insert into public.invites(family_id, email, role, token, status, invited_by, expires_at)
    values (fid, guest_em, 'guest', tok, 'pending', owner, now() + interval '7 days');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', owner::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', owner::text, 'email', mgr_em)::text, true);
  if not public.can_manage_family(fid) then
    raise exception 'INVITE-ESC FAIL: the manager fixture is wrong — can_manage_family is false';
  end if;

  update public.invites set status = 'revoked' where token = tok;
  get diagnostics n = ROW_COUNT;
  if n <> 1 then
    raise exception 'INVITE-ESC FAIL: a manager can no longer revoke an invite in their own family (% rows)', n;
  end if;

  -- 0298's WITH CHECK: not even a manager may push an invite somewhere else.
  begin
    update public.invites set family_id = other where token = tok;
    get diagnostics n = ROW_COUNT;
    if n <> 0 then
      raise exception 'INVITE-ESC FAIL: a manager moved an invite into a family they do not manage (% rows)', n;
    end if;
  exception when insufficient_privilege then null;
  end;

  raise notice 'INVITE-ESC OK: managers still manage their own invites and cannot move one out of their family';
end $$;
