-- Behavioural proof for 0297, run as real `authenticated` sessions under RLS.
--
-- `invites_update` (0004, re-asserted by 0118) had a USING clause and no WITH
-- CHECK. Postgres reuses USING as the check, so the invitee's branch —
-- `lower(email) = lower(auth.jwt()->>'email')` — passed for any new row whose
-- email was still theirs, leaving `role`, `family_id`, `status` and
-- `expires_at` unconstrained. `accept_invite` is SECURITY DEFINER and inserts
-- `(v_invite.family_id, auth.uid(), v_invite.role)` into family_members past
-- `fm_insert`'s can_manage_family check, so the invite row was
-- attacker-controlled input to a privileged insert.
--
-- Four escalations are asserted closed, and the legitimate journey is asserted
-- INTACT alongside them — a guard that also broke accepting an invite would be
-- a worse bug than the one it fixed.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

do $$
declare
  fam_a       uuid := 'eeee0000-0000-4000-8000-00000000000a';
  fam_b       uuid := 'eeee0000-0000-4000-8000-00000000000b';
  parent_uid  uuid := 'e0000000-0000-4000-8000-000000000001';
  invitee_uid uuid := 'e0000000-0000-4000-8000-000000000002';
  tok         text := 'invite-terms-check-token';
  invite_id   uuid;
  blocked     boolean;
  n           int;
  got_family  uuid;
  got_role    text;
begin
  insert into public.families (id, name) values (fam_a, 'Issuer'), (fam_b, 'Bystander')
    on conflict do nothing;
  insert into auth.users (id, email) values
    (parent_uid, 'ip@example.test'), (invitee_uid, 'guest@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam_a, parent_uid, 'Parent', 'parent', true);
  -- fam_b must have a manager of its own, or can_manage_family(fam_b) is false
  -- for everyone and the cross-family probe would pass for the wrong reason.
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam_b, parent_uid, 'Parent', 'parent', true);

  insert into public.invites (family_id, email, role, token, status, invited_by)
  values (fam_a, 'guest@example.test', 'child', tok, 'pending', parent_uid)
  returning id into invite_id;

  -- ── As the INVITEE ───────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', invitee_uid::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', invitee_uid, 'role', 'authenticated', 'email', 'guest@example.test')::text, true);
  set local role authenticated;

  -- The invitee can still SEE the invite addressed to them (invites_select).
  select count(*) into n from public.invites where token = tok;
  if n <> 1 then
    raise exception 'the invitee can no longer read their own invite (%)', n;
  end if;

  -- 1. ROLE ESCALATION — the headline. Was: UPDATE 1, then accept as parent.
  update public.invites set role = 'parent' where token = tok;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'an invitee rewrote the role on their own invite';
  end if;

  -- 2. EXPIRY EXTENSION.
  update public.invites set expires_at = now() + interval '365 days' where token = tok;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'an invitee extended their own invite';
  end if;

  -- 3. CROSS-FAMILY TAKEOVER — re-point the invite at a household that never
  --    issued it. The most severe of the four: it needs only the target uuid.
  update public.invites set family_id = fam_b, role = 'parent' where token = tok;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'an invitee moved their invite to another family';
  end if;

  -- 4. The legitimate journey still works, at the role the family chose.
  got_family := public.accept_invite(tok);
  if got_family <> fam_a then
    raise exception 'accept_invite returned % instead of the issuing family', got_family;
  end if;
  select role::text into got_role from public.family_members
   where family_id = fam_a and user_id = invitee_uid;
  if got_role <> 'child' then
    raise exception 'the invitee joined as % rather than the invited role', got_role;
  end if;

  -- 5. REUSE AFTER REMOVAL — reopening an accepted invite. The trigger holds
  --    this one even where a policy would not.
  update public.invites set status = 'pending', accepted_by = null where token = tok;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'an invitee reopened an accepted invite';
  end if;

  -- ── As the ISSUING FAMILY'S MANAGER ──────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', parent_uid, 'role', 'authenticated', 'email', 'ip@example.test')::text, true);
  set local role authenticated;

  -- 6. A manager still administers their own invites — revoking a pending one.
  insert into public.invites (family_id, email, role, token, status, invited_by)
  values (fam_a, 'second@example.test', 'adult', tok || '-2', 'pending', parent_uid);
  update public.invites set status = 'revoked' where token = tok || '-2';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a manager can no longer revoke their own pending invite (%)', n;
  end if;

  -- 7. …but not readdress one. `email` is the identity accept_invite checks, so
  --    a changed address is a different grant wearing the same token.
  blocked := false;
  begin
    update public.invites set email = 'someone.else@example.test' where token = tok || '-2';
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a manager readdressed an issued invite';
  end if;

  -- 8. …and not move one to another family, even one they also manage. The
  --    WITH CHECK added in 0297 is what stops this; before it, the missing
  --    check made USING serve for both.
  blocked := false;
  begin
    update public.invites set family_id = fam_b where token = tok || '-2';
    get diagnostics n = row_count;
    if n = 0 then blocked := true; end if;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'an invite was moved to another family';
  end if;

  reset role;
  raise notice 'OK invite terms: role/expiry/family/reuse all refused to the invitee; accept still joins at the invited role; managers keep revoke and lose readdress+move';
end $$;
