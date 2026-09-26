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
-- NEGATIVE CONTROL, and it runs FIRST, before any of the refusals
-- ---------------------------------------------------------------------------
-- The rule under test is 0298's, not 0004's and not 0118's. `invites_update`
-- was created three times: 0004_rls.sql:106, then 0118_rls_drift_repair.sql:90
-- re-asserted the same shape verbatim, and `0298_invites_update_manager_only
-- .sql` DROPPED it and re-created it on a different predicate — the invitee
-- arm `lower(email) = lower(auth.jwt()->>'email')` is gone and the whole
-- policy is now `using (public.can_manage_family(family_id)) with check
-- (public.can_manage_family(family_id))`. 0298 is the LAST migration that
-- names the table: a case-insensitive grep for "invites" across
-- supabase/migrations stops there (0002, 0004, 0005, 0118, 0136, 0202, 0210,
-- 0298). What a grep for the NAME cannot see is a loop, and the one trigger the
-- table carries came from exactly that: 0003:87-98 walks `information_schema
-- .columns where column_name = 'updated_at'` and runs `execute format('create
-- trigger trg_set_updated_at before update on public.%I ...')` for every table
-- in the set, `invites.updated_at` (0002:77) included. It assigns
-- `new.updated_at` and raises nothing. No later migration that builds DDL with
-- `execute format` names `invites` or walks a catalog broad enough to reach it
-- (each drives a literal list or a whitelist; 0311 is the pattern). Rather than
-- trust that inventory to stay true, the block at the FOOT of this file reads
-- pg_trigger and pg_policy and pins the two facts the attributions here lean
-- on: `trg_set_updated_at` is the ONLY trigger on `invites`, and the ONE policy
-- governing UPDATE is `invites_update` with a WITH CHECK that asks
-- `can_manage_family(family_id)`. So the MECHANISM here is an RLS POLICY and
-- the PREDICATE is one question — `can_manage_family(family_id)`, asked on
-- both sides.
--
-- How that one policy answers decides what each refusal below can MEAN. USING
-- is evaluated on the EXISTING row, and a row it rejects is simply not in the
-- UPDATE's row set: the statement reports ZERO ROWS and raises nothing. WITH
-- CHECK is evaluated on the NEW row, only for rows USING let through, and a
-- violation RAISES 42501. For this invitee `can_manage_family(fid)` is false,
-- so every attack below is refused by USING as zero rows and WITH CHECK is
-- never reached — an invitee cannot exercise 0298's WITH CHECK at all. The
-- MANAGER block at the foot of the file is what exercises it: the manager
-- passes USING on fid, and the move to `other` is the one write in this file
-- that WITH CHECK itself refuses, as a caught 42501. That block is not an
-- afterthought. It is the only place here where the WITH CHECK half of 0298 is
-- measured, and its control is what keeps that caught 42501 honest.
--
-- One question is all the boundary is, so the control is the SAME invitee,
-- through the SAME policy, in a family where that question answers YES: two
-- households seeded below that the invitee manages, and the same UPDATEs the
-- attacks issue must LAND there. Its invite is addressed to somebody else on
-- purpose — the email arm 0298 deleted must not be what carries the control,
-- so within `invites_update` `can_manage_family` is the only arm that can pass
-- the row, which is what makes it the same predicate answered the other way.
-- The row's VISIBILITY is a second policy's business: an UPDATE's WHERE reads
-- through `invites_select` (0118_rls_drift_repair.sql:81), and for a row
-- addressed to somebody else it is that policy's `is_family_member(family_id)`
-- arm that shows it to the invitee. So the control asserts the row is visible
-- BEFORE it tries to write it, and a zero-row control is charged to the policy
-- that produced it rather than to `invites_update` by default.
--
-- What the control buys, stated exactly, because it is uneven:
--
--   * the role rewrite and the expiry extension assert ZERO ROWS and are
--     deliberately UNGUARDED. A revoked GRANT, a column denial or a guard
--     trigger raises 42501 there and aborts the block — red already, so at
--     those two sites the control does not turn a green red. What it adds is
--     the attribution: it fails first and says which of those it was, instead
--     of a raw "permission denied for table invites". (A row this session
--     cannot SEE reports zero too; that is ruled out where it matters, by the
--     guard before the attacks that asserts `tok` itself is visible.)
--   * the direct `family_members` INSERT — the probe's own proof that RLS is
--     live — catches `insufficient_privilege` and credits `fm_insert`
--     (0118_rls_drift_repair.sql:70, `with check (can_manage_family
--     (family_id))`, cited as still current by 0339's header). That handler
--     would swallow a missing INSERT grant, a column denial or a guard trigger
--     on `family_members` just as readily — the way this repository refuses
--     writes in 0223, 0305, 0326 and 0331 — and read it as the boundary
--     holding: a REAL false green. The `family_members` leg of the control is
--     what converts it: the same session inserts a member into a family it
--     DOES manage, and that must land. This is the strongest thing the control
--     does.
--   * the manager's move-out at the foot of the file catches 42501 and credits
--     WITH CHECK. USING genuinely passes there, so a 42501 genuinely arrives —
--     and a denial on `family_id` from any other source would be swallowed by
--     the same handler. The manager leg (move the invite into a second family
--     the manager DOES manage, and back, on the same column) is what catches
--     that: the second real conversion.
--   * the invitee's own pivot used to swallow 42501 as well, under a comment
--     that credited WITH CHECK. It never is WITH CHECK: USING filters the row
--     first (see above), the role rewrite one statement earlier ran the same
--     USING on the same row and had to report zero rows for the probe to get
--     that far, and a row USING filters reaches neither WITH CHECK nor a row
--     trigger. What CAN raise 42501 on a statement that touches no rows is the
--     privilege check on the SET list — exactly the confound the control
--     mirrors. So the handler no longer swallows: a 42501 there FAILS the
--     probe by name, as a denial from outside the policy.
--
-- A dead `auth.uid()` — one GUC set and not the other — is not on that list,
-- because it does not raise 42501 on these UPDATEs: `can_manage_family`
-- answers false and USING reports zero rows. On the INSERT it does raise.
-- Either way it is caught before any of this by the guard that asserts
-- `auth.uid()` IS the invitee, which is why both GUCs are asserted, not one.
--
-- The control's UPDATEs name the SAME COLUMNS the attacks write — `role`,
-- `expires_at` and `family_id` — and that is not decoration. Postgres checks
-- column privileges against the SET list and not against the values. The
-- denial that matters is NOT `revoke update (role) on invites from
-- authenticated` on its own: pg-bootstrap.sh runs `alter default privileges in
-- schema public grant all on tables to authenticated` before the first
-- migration, so `authenticated` holds TABLE-level UPDATE on `invites`, and
-- revoking a column privilege that was never granted at column level is a
-- no-op (measured on a replayed copy: `has_column_privilege('authenticated',
-- 'public.invites', 'role', 'UPDATE')` stays true). The shape that denies one
-- column is `revoke update on public.invites from authenticated; grant update
-- (status, role, expires_at) on public.invites to authenticated` — table-level
-- gone, a column list back that omits `family_id` (measured: `family_id`
-- false, `role` true). Under it a control that only touched `expires_at` would
-- land, and the pivot below would abort on a bare "permission denied for table
-- invites": red, with the attribution thrown away. So the pivot is mirrored
-- in the control — repointing the control's own invite at ctl_dest, a family
-- the invitee DOES manage, is the mirror of repointing the real one at a
-- family they do not.
--
-- The manager block gets the same treatment for the same reason: its existing
-- positive control writes `status`, so the column-list grant above would turn
-- its move-out refusal into a swallowed 42501. Its control moves the invite
-- between two families that manager DOES manage, and moves it back, so the
-- assertion after it runs on the fixture unchanged.
--
-- Next to docs/audit/invite-cannot-rewrite-what-it-grants-check.sql, which
-- controls the same policy the same way (same actor, two managed households, a
-- control invite addressed to somebody else): that file runs on FIXED anchors
-- inside one rolled-back transaction and pins the full policy shape in
-- pg_policy. This one mints its anchors at run time and COMMITS them — the
-- uuids are fresh every run, `onboarding_key` is null and 0210's unique index
-- on (family_id, onboarding_key) treats nulls as distinct, so nothing here can
-- collide with another probe's literals or with its own last run — covers
-- `expires_at`, and carries the `family_members` leg and the trigger-inventory
-- pin the sibling lacks. One idea for the `invites_update` control, in two
-- files; the differences are why both exist, and the audit should count them
-- as one proof of that control, not two.
\set ON_ERROR_STOP on

do $$
declare
  fid      uuid := gen_random_uuid();
  other    uuid := gen_random_uuid();
  owner    uuid := gen_random_uuid();
  invitee  uuid := gen_random_uuid();
  tok      text := 'probe_' || replace(gen_random_uuid()::text, '-', '');
  othertok text := 'probe_' || replace(gen_random_uuid()::text, '-', '');
  -- The negative control's own anchors. Minted the same way every other id in
  -- this probe is — `gen_random_uuid()` at run time — which is this file's
  -- anchor style and the reason none of them can collide with the literal
  -- anchors the other probes seed into the one shared database.
  ctl_fam  uuid := gen_random_uuid();
  ctl_dest uuid := gen_random_uuid();
  ctltok   text := 'probe_' || replace(gen_random_uuid()::text, '-', '');
  ctl_err  text;
  n        int;
  landed   text;
  blocked  boolean;
begin
  -- ── Fixture (as the table owner; setup is not the test) ──
  insert into auth.users(id, email) values
    (owner, 'probe-owner@example.com'), (invitee, 'probe-invitee@example.com');
  insert into public.families(id, name) values (fid, 'Probe'), (other, 'Unrelated');
  insert into public.family_members(family_id, user_id, role, display_name, is_active)
    values (fid, owner, 'parent', 'Owner', true);
  insert into public.invites(family_id, email, role, token, status, invited_by, expires_at) values
    (fid,   'probe-invitee@example.com', 'guest', tok,      'pending', owner, now() + interval '7 days'),
    (other, 'a-different-person@example.com', 'guest', othertok, 'pending', owner, now() + interval '7 days');

  -- ── The negative control's own households ──
  -- Two families the INVITEE manages, so `can_manage_family(family_id)` — the
  -- whole of `invites_update` since 0298, and the whole of `fm_insert` —
  -- answers YES for the very user it answers NO for in `fid`. Seeded HERE, as
  -- the table owner and before the session switches, exactly like every row the
  -- attacks below run against: a control seeded after the switch would be
  -- proving the setup rather than the session's access. The roles are stated
  -- rather than left to `on_family_created` (these rows carry no `created_by`,
  -- and `handle_new_family` provisions a member only when it is not null), so
  -- a seed whose roles were wrong cannot fail the control for a reason that is
  -- not the control's.
  insert into public.families(id, name) values
    (ctl_fam,  'Probe (the invitee manages this one)'),
    (ctl_dest, 'Probe (and this one, so the pivot has a legal destination)');
  insert into public.family_members(family_id, user_id, role, display_name, is_active) values
    (ctl_fam,  invitee, 'parent', 'Invitee, a manager here', true),
    (ctl_dest, invitee, 'parent', 'Invitee, a manager here too', true);
  -- Addressed to somebody ELSE on purpose. If this invite carried the invitee's
  -- own address, a restored `lower(email) = lower(auth.jwt()->>'email')` arm
  -- would carry the control too, and the control would stop being the same
  -- question. Within `invites_update`, `can_manage_family` is the only arm that
  -- can pass this row; the invitee SEES it through `invites_select`'s
  -- `is_family_member` arm, which the visibility check below asserts apart.
  insert into public.invites(family_id, email, role, token, status, invited_by, expires_at)
    values (ctl_fam, 'probe-ctl-addressee@example.com', 'guest', ctltok, 'pending', invitee, now() + interval '7 days');

  -- ── Become the invitee ──
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', invitee::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', invitee::text, 'email', 'probe-invitee@example.com')::text, true);

  -- ── Guards: prove the probe is testing what it claims ──
  if current_user <> 'authenticated' then
    raise exception 'INVITE-ESC FAIL: running as %, so RLS is not being enforced at all', current_user;
  end if;
  if auth.uid() is distinct from invitee then
    raise exception 'INVITE-ESC FAIL: auth.uid() is %, expected the invitee — impersonation did not take', auth.uid();
  end if;
  if auth.jwt()->>'email' is distinct from 'probe-invitee@example.com' then
    raise exception 'INVITE-ESC FAIL: auth.jwt() email is % — the email arm is untested', auth.jwt()->>'email';
  end if;
  if public.can_manage_family(fid) then
    raise exception 'INVITE-ESC FAIL: the invitee already manages the family; every refusal below would be meaningless';
  end if;
  if not public.can_manage_family(ctl_fam) or not public.can_manage_family(ctl_dest) then
    raise exception 'INVITE-ESC FAIL: the control households are mis-seeded (can_manage_family: ctl_fam=%, ctl_dest=%) — the control below would fail for a reason that is not the control''s',
      public.can_manage_family(ctl_fam), public.can_manage_family(ctl_dest);
  end if;

  -- ── NEGATIVE CONTROL: the same invitee, the same policy, the other answer ──
  -- The same UPDATEs the attacks issue, on an invite in a family this invitee
  -- DOES manage, naming the SAME columns. All of them must land. If any does
  -- not, this session never had the access the refusals below are supposed to be
  -- measuring, and the probe says the boundary is UNPROVEN instead of reporting
  -- a boundary it cannot see.
  --
  -- The row has to be VISIBLE before it can be written: an UPDATE's WHERE reads
  -- the existing row through `invites_select`, and for an invite addressed to
  -- somebody else that is its `is_family_member(family_id)` arm — a different
  -- policy from the one under test. Asserted on its own so that a zero-row
  -- control below is charged to the policy that produced it.
  select count(*) into n from public.invites where token = ctltok;
  if n <> 1 then
    raise exception 'INVITE-ESC UNPROVEN (the control this probe rests on did not hold): the invitee sees % rows of the control invite in a family they DO manage, so invites_select''s is_family_member arm is not showing it — the UPDATE controls would report zero for a reason that is not invites_update''s', n;
  end if;
  --
  -- Each control is wrapped, and each raises AFTER its handler rather than
  -- inside it: a `raise` in the body of a block with `exception when others`
  -- is caught by that block's own handler, so the diagnosis would be swallowed
  -- by the very construct meant to report it. Wrapped at all because the
  -- attacks below are deliberately unguarded — a revoked UPDATE privilege would
  -- abort this block there and bury the reason under a raw "permission denied
  -- for table invites". Say WHY the probe cannot speak here, while the reason is
  -- still in hand. The boundary is then reported as neither holding nor broken:
  -- it is reported as unproven, and the run is red either way.
  begin
    update public.invites set role = 'parent', expires_at = now() + interval '999 days'
      where token = ctltok;
    get diagnostics n = ROW_COUNT;
    if n <> 1 then
      ctl_err := format('this invitee''s UPDATE of role AND expires_at — the two columns the attacks below write — on an invite in the family they DO manage (a row this session has just SEEN) changed %s rows, not 1, so invites_update''s USING is refusing a row can_manage_family says yes to, and the zero-row refusals below prove nothing', n);
    end if;
  exception when others then
    ctl_err := format('this invitee''s UPDATE of role AND expires_at on an invite in the family they DO manage raised %s: %s — a revoked GRANT, a column denial or a guard trigger, and the unguarded refusals below would have aborted on it with no attribution', sqlstate, sqlerrm);
  end;
  if ctl_err is not null then
    raise exception 'INVITE-ESC UNPROVEN (the control this probe rests on did not hold): %', ctl_err;
  end if;

  begin
    update public.invites set family_id = ctl_dest, role = 'parent' where token = ctltok;
    get diagnostics n = ROW_COUNT;
    if n <> 1 then
      ctl_err := format('this invitee moved their own invite between two families they DO manage on %s rows, not 1 — the mirror of the pivot below, so that refusal measures nothing', n);
    end if;
  exception when others then
    ctl_err := format('this invitee''s move of an invite between two families they DO manage raised %s: %s — a column-level denial on family_id (table UPDATE revoked and a column list granted back without it), a missing GRANT or a guard trigger, and the pivot below would have aborted on the same thing', sqlstate, sqlerrm);
  end;
  if ctl_err is not null then
    raise exception 'INVITE-ESC UNPROVEN (the control this probe rests on did not hold): %', ctl_err;
  end if;

  -- The same shape against `fm_insert`, so the direct-write control below is a
  -- refusal with an attribution too — and this is the leg that converts a real
  -- false green: that control SWALLOWS 42501, so without this a missing INSERT
  -- grant or a guard trigger on family_members would read as fm_insert holding.
  -- `owner` is not yet a member of ctl_fam, so the unique (family_id, user_id)
  -- index is not what is being measured.
  begin
    insert into public.family_members(family_id, user_id, role, display_name, is_active)
      values (ctl_fam, owner, 'parent', 'Control member', true);
    get diagnostics n = ROW_COUNT;
    if n <> 1 then
      ctl_err := format('this invitee''s INSERT into family_members in the family they DO manage stored %s rows, not 1', n);
    end if;
  exception when others then
    ctl_err := format('this invitee''s INSERT into family_members in the family they DO manage raised %s: %s — so the 42501 the direct-write control below credits to fm_insert could be a missing GRANT, a column denial or a guard trigger instead', sqlstate, sqlerrm);
  end;
  if ctl_err is not null then
    raise exception 'INVITE-ESC UNPROVEN (the control this probe rests on did not hold): %', ctl_err;
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
  -- below could simply be a row nobody can see. (Through `invites_select`'s
  -- email arm, which 0298 left in place: is_family_member(fid) is false here.)
  select count(*) into n from public.invites where token = tok;
  if n <> 1 then
    raise exception 'INVITE-ESC FAIL: the invitee cannot see their own invite (% rows) — the flow is broken, and the refusals below prove nothing', n;
  end if;

  -- ── The attacks ──
  -- Refused by USING, as zero rows: can_manage_family(fid) is false for the
  -- invitee, so the row is not in the UPDATE's set and WITH CHECK is never
  -- consulted. Unguarded on purpose — a 42501 here is red on its own, and the
  -- control above has already said what it would be.
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
  exception when insufficient_privilege then
    -- Unreachable on 0298's shape, and kept only to say so by name. USING is
    -- `can_manage_family(family_id)`, false for the invitee on fid: the row is
    -- filtered before WITH CHECK is consulted and the statement reports zero
    -- rows. Nor is it WITH CHECK under any other shape — the role rewrite one
    -- statement up ran the same USING on the same row and had to report zero
    -- to get here, and a row USING filters reaches neither WITH CHECK nor a
    -- row trigger. What raises 42501 on a statement with no rows is the
    -- privilege check on the SET list, and the control above just passed the
    -- same columns. So this is never "refused by WITH CHECK, which is the
    -- point", as an earlier revision said; it is a denial from outside the
    -- policy, and it is named rather than swallowed.
    raise exception 'INVITE-ESC FAIL: the family pivot raised 42501 (%) — not 0298''s WITH CHECK, which the invitee cannot reach (USING has just refused this same row as zero rows), so a privilege denial or a mechanism outside invites_update refused it, after the control on the same columns landed', sqlerrm;
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

  raise notice 'INVITE-ESC OK: the same invitee CAN rewrite role, expires_at and family_id on an invite in the families they manage, and CAN add a member there (control); in the family they do not manage the role rewrite, family pivot and expiry extension are all refused by USING as zero rows; the invitee still accepts at the granted role';
end $$;

-- ── A manager must keep managing ──
-- And the one place in this file where 0298's WITH CHECK is exercised: the
-- manager passes USING on fid, so the move-out below is refused by the NEW-row
-- check, as a raised 42501, not as zero rows.
do $$
declare
  fid uuid := gen_random_uuid(); other uuid := gen_random_uuid();
  owner uuid := gen_random_uuid();
  -- A SECOND family this manager also manages: the legal destination that makes
  -- the move-out refusal below attributable. Same run-time anchor style as the
  -- rest of this file, so it cannot collide with another probe's literals.
  dest uuid := gen_random_uuid();
  tok text := 'probe_' || replace(gen_random_uuid()::text, '-', '');
  ctl_err text;
  n int;
begin
  insert into auth.users(id, email) values (owner, 'probe-mgr@example.com');
  insert into public.families(id, name) values
    (fid, 'Managed'), (other, 'Unmanaged'), (dest, 'Also Managed');
  insert into public.family_members(family_id, user_id, role, display_name, is_active) values
    (fid,  owner, 'parent', 'Owner', true),
    (dest, owner, 'parent', 'Owner here too', true);
  insert into public.invites(family_id, email, role, token, status, invited_by, expires_at)
    values (fid, 'someone@example.com', 'guest', tok, 'pending', owner, now() + interval '7 days');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', owner::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', owner::text, 'email', 'probe-mgr@example.com')::text, true);
  if not public.can_manage_family(fid) then
    raise exception 'INVITE-ESC FAIL: the manager fixture is wrong — can_manage_family is false';
  end if;
  if not public.can_manage_family(dest) then
    raise exception 'INVITE-ESC FAIL: the control household is mis-seeded — can_manage_family(dest) is false, so the control below would fail for a reason that is not the control''s';
  end if;

  -- ── NEGATIVE CONTROL, first, for the move-out refusal at the foot of this
  -- block: the SAME manager, the SAME policy, the SAME column, and a
  -- destination where `can_manage_family` answers YES. Both moves must land.
  -- The revoke below is a positive control too, but it writes `status`, so a
  -- column-level denial on `family_id` — table UPDATE revoked from
  -- `authenticated` and a column list granted back without `family_id`; a bare
  -- `revoke update (family_id)` is a no-op against the table-level grant
  -- pg-bootstrap.sh's default privileges hand out — would sail past it and
  -- turn the move-out refusal into a 42501 swallowed by its own handler: green,
  -- with nothing behind it. Moving the invite back leaves the fixture exactly
  -- as the assertions after it expect to find it.
  begin
    update public.invites set family_id = dest where token = tok;
    get diagnostics n = ROW_COUNT;
    if n <> 1 then
      ctl_err := format('this manager moved an invite into a second family they DO manage on %s rows, not 1', n);
    else
      update public.invites set family_id = fid where token = tok;
      get diagnostics n = ROW_COUNT;
      if n <> 1 then
        ctl_err := format('this manager could not move the invite back out of the control family (%s rows) — the fixture the assertions below expect is no longer in place', n);
      end if;
    end if;
  exception when others then
    ctl_err := format('this manager''s move of an invite between two families they DO manage raised %s: %s — so the move-out refusal below could be a column-level denial on family_id, a missing GRANT or a guard trigger rather than 0298''s WITH CHECK', sqlstate, sqlerrm);
  end;
  if ctl_err is not null then
    raise exception 'INVITE-ESC UNPROVEN (the control this half rests on did not hold): %', ctl_err;
  end if;

  update public.invites set status = 'revoked' where token = tok;
  get diagnostics n = ROW_COUNT;
  if n <> 1 then
    raise exception 'INVITE-ESC FAIL: a manager can no longer revoke an invite in their own family (% rows)', n;
  end if;

  -- 0298's WITH CHECK: not even a manager may push an invite somewhere else.
  -- USING passes (the manager manages fid), so this is the new-row check
  -- speaking, and it speaks as a raised 42501. The control above has just
  -- written this row's family_id in this session, so that 42501 is WITH
  -- CHECK's and not a denial on the column.
  begin
    update public.invites set family_id = other where token = tok;
    get diagnostics n = ROW_COUNT;
    if n <> 0 then
      raise exception 'INVITE-ESC FAIL: a manager moved an invite into a family they do not manage (% rows)', n;
    end if;
  exception when insufficient_privilege then null;
  end;

  raise notice 'INVITE-ESC OK: the same manager CAN move an invite between two families they manage (control), and still cannot move one out into a family they do not (WITH CHECK, as 42501); revoking their own invite still works';
end $$;

-- ── The mechanism, pinned ───────────────────────────────────────────────────
-- Every refusal above is attributed to ONE policy, and the manager's caught
-- 42501 is read as that policy's WITH CHECK. Both readings rest on two facts
-- about the catalog that the header established by reading the migrations
-- once, and that a later migration could change without naming the table (a
-- blanket loop is how the one trigger it has got there). Pin them, so this file
-- notices. A trigger keyed on the ROW or the ACTOR could slip past the controls
-- above — it would fire on the manager's move-out and stay silent on the
-- control's — which is why the inventory is asserted and not just the
-- behaviour. (docs/audit/invite-cannot-rewrite-what-it-grants-check.sql pins
-- the policy's full shape; this block pins only what this file's own
-- attributions lean on.)
do $$
declare
  trg  text[];
  n    int;
  pol  text;
  chk  text;
begin
  select coalesce(array_agg(t.tgname order by t.tgname), array[]::text[]) into trg
    from pg_trigger t
   where t.tgrelid = 'public.invites'::regclass and not t.tgisinternal;
  if trg <> array['trg_set_updated_at'] then
    raise exception 'INVITE-ESC FAIL: public.invites carries triggers % — the header attributes every refusal above to invites_update alone, and a trigger this file did not account for is a second mechanism its controls were not written for', trg;
  end if;

  select count(*), min(p.polname), min(pg_get_expr(p.polwithcheck, p.polrelid))
    into n, pol, chk
    from pg_policy p
   where p.polrelid = 'public.invites'::regclass and p.polcmd in ('w', '*');
  if n <> 1 or pol <> 'invites_update' then
    raise exception 'INVITE-ESC FAIL: % policies govern UPDATE on public.invites (first: %), expected exactly one, invites_update — a second UPDATE policy, permissive or restrictive, is a second mechanism the refusals above could not tell from 0298''s', n, coalesce(pol, '(none)');
  end if;
  if chk is null or chk not like '%can_manage_family(family_id)%' then
    raise exception 'INVITE-ESC FAIL: invites_update''s WITH CHECK is % — the manager''s caught 42501 above is credited to a WITH CHECK asking can_manage_family(family_id), and that is not what is installed', coalesce(chk, '(absent: Postgres reuses USING for the new row, which is the pre-0298 hole)');
  end if;

  raise notice 'INVITE-ESC OK: the mechanism is what the header says — one trigger on invites (trg_set_updated_at, which raises nothing) and one UPDATE policy, invites_update, with a WITH CHECK asking can_manage_family(family_id)';
end $$;
