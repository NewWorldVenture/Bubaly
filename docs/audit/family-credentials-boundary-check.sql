-- Behavioural proof for 0296, run as a real `authenticated` session under RLS.
--
-- public.family_credentials holds the household's Wi-Fi passwords, logins, PINs
-- and card details, with `secret` stored as plaintext. Before this migration its
-- four policies used is_family_member(), which ignores role — so every child,
-- who is a real auth user in this product, could read, change and delete all of
-- them. This asserts the database now decides.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

do $$
declare
  fam        uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  parent_uid uuid := 'c0000000-0000-4000-8000-000000000001';
  adult_uid  uuid := 'c0000000-0000-4000-8000-000000000002';
  child_uid  uuid := 'c0000000-0000-4000-8000-000000000003';
  wifi_id    uuid;
  n          int;
  refused    boolean;
begin
  insert into public.families (id, name) values (fam, 'Vault keys') on conflict do nothing;
  insert into auth.users (id, email) values
    (parent_uid, 'cp@example.test'), (adult_uid, 'ca@example.test'), (child_uid, 'cc@example.test')
  on conflict do nothing;
  -- A child with a real auth user, exactly as child-login-actions.ts creates one.
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, adult_uid,  'Adult',  'adult',  true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;

  -- Re-runnable: a probe that only passes on a virgin database is a probe
  -- someone debugging locally will mistake for a broken fix. Clear this
  -- family's rows first, then assert against the one row we create.
  delete from public.family_credentials where family_id = fam;

  insert into public.family_credentials (family_id, category, label, username, secret, created_by)
  values (fam, 'wifi', 'Home Wi-Fi', 'family', 'correct-horse-battery-staple', parent_uid)
  returning id into wifi_id;

  -- ---- the child sees nothing ----
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);

  -- Prove the impersonation TOOK before trusting a single refusal below.
  -- This probe first set `request.jwt.claims` (the JSON object); the shim's
  -- auth.uid() reads `request.jwt.claim.sub` (the dotted GUC), so auth.uid()
  -- was null and every refusal held because NOBODY WAS ANYBODY — the probe
  -- passed its child assertions against the ORIGINAL, broken policies too.
  -- A boundary probe that cannot tell "denied because child" from "denied
  -- because unauthenticated" proves nothing, so make that distinction fatal.
  if auth.uid() is distinct from child_uid then
    raise exception '0296: impersonation failed — auth.uid() is %, expected the child; the probe is not testing what it claims', auth.uid();
  end if;

  select count(*) into n from public.family_credentials where family_id = fam;
  if n <> 0 then
    raise exception '0296: a child can READ % credential row(s); the vault is open', n;
  end if;

  refused := false;
  begin
    update public.family_credentials set secret = 'changed' where id = wifi_id;
    if not found then refused := true; end if;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0296: a child can WRITE a credential';
  end if;

  refused := false;
  begin
    delete from public.family_credentials where id = wifi_id;
    if not found then refused := true; end if;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0296: a child can DELETE a credential';
  end if;

  -- Catch ONLY the RLS refusal. `when others` would also swallow a typo in
  -- this probe — a wrong column name would raise, be caught, and report the
  -- boundary as held. A probe that passes because it is broken is worse than
  -- no probe, and this file exists to prove a boundary, not to reach its end.
  refused := false;
  begin
    insert into public.family_credentials (family_id, category, label, secret, created_by)
    values (fam, 'pin', 'Child-added', 'x', child_uid);
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0296: a child can INSERT a credential';
  end if;

  -- ---- both adults still have their vault (the fix must not lock them out) ----
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  if auth.uid() is distinct from parent_uid then
    raise exception '0296: impersonation failed — auth.uid() is %, expected the parent', auth.uid();
  end if;
  select count(*) into n from public.family_credentials where id = wifi_id;
  if n <> 1 then
    raise exception '0296: a PARENT sees % rows for the vault entry, expected 1 — the fix locked out an owner', n;
  end if;

  perform set_config('request.jwt.claim.sub', adult_uid::text, true);
  if auth.uid() is distinct from adult_uid then
    raise exception '0296: impersonation failed — auth.uid() is %, expected the adult', auth.uid();
  end if;
  select count(*) into n from public.family_credentials where id = wifi_id;
  if n <> 1 then
    raise exception '0296: an ADULT sees % rows for the vault entry, expected 1 — can_manage_family admits parent AND adult', n;
  end if;

  update public.family_credentials set notes = 'rotated' where id = wifi_id;
  if not found then
    raise exception '0296: an ADULT cannot update a credential';
  end if;

  reset role;
  raise notice '0296 OK: the child is refused read, insert, update and delete; parent and adult keep the vault';
end $$;
