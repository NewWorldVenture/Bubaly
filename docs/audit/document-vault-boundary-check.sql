-- Behavioural proof for 0266, run as a real `authenticated` session under RLS.
--
-- Bubaly's Files hub draws a "Secure Vault". Before this migration that was a
-- label the client drew: the row, its `storage_path`, and the button that moves
-- a file back out were all reachable by every family member. This asserts the
-- database now decides.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

do $$
declare
  fam        uuid := 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  parent_uid uuid := 'f0000000-0000-4000-8000-000000000001';
  teen_uid   uuid := 'f0000000-0000-4000-8000-000000000002';
  vault_id   uuid;
  medical_id uuid;
  school_id  uuid;
  n          int;
  refused    boolean;
begin
  insert into public.families (id, name) values (fam, 'Vault') on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'vp@example.test'), (teen_uid, 'vt@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true), (fam, teen_uid, 'Teen', 'teen', true)
  on conflict do nothing;

  -- Three documents: one in the vault, one filed under a sensitive category
  -- but NOT flagged, and one ordinary school form the whole family needs.
  insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
  values (fam, 'Mortgage deed', 'legal', fam || '/deed.pdf', true, parent_uid) returning id into vault_id;
  insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
  values (fam, 'Blood results', 'medical', fam || '/bloods.pdf', false, parent_uid) returning id into medical_id;
  insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
  values (fam, 'Permission slip', 'school', fam || '/slip.pdf', false, parent_uid) returning id into school_id;

  -- ── As the teen ──────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', teen_uid::text, true);
  set local role authenticated;

  -- 1. The vault row is gone, `storage_path` with it — which is all a signed
  --    URL ever needed.
  select count(*) into n from public.documents where id = vault_id;
  if n <> 0 then raise exception 'a teen can still read the vault document'; end if;

  -- 2. Sensitivity is not only the flag. A medical record filed without it is
  --    still not the children's, or re-filing under `other` would be the
  --    bypass.
  select count(*) into n from public.documents where id = medical_id;
  if n <> 0 then raise exception 'a teen can read a medical document that was never flagged'; end if;

  -- 3. The ordinary household paperwork is untouched. A boundary that took the
  --    school form away would be the wrong boundary.
  select count(*) into n from public.documents where id = school_id;
  if n <> 1 then raise exception 'a teen lost sight of the family school form'; end if;

  -- 4. The button the Files hub shows every member — "move to shared" — no
  --    longer works on something they cannot see.
  update public.documents set is_secure = false where id = vault_id;
  if found then raise exception 'a teen moved a document out of the vault'; end if;

  -- 5. Nor can they hide one FROM the adults by moving it in.
  refused := false;
  begin
    update public.documents set is_secure = true where id = school_id;
  exception when insufficient_privilege then refused := true;
  end;
  select is_secure into refused from public.documents where id = school_id;
  if refused then raise exception 'a teen hid a shared document in the vault'; end if;

  -- 6. And cannot file a new one straight into it.
  refused := false;
  begin
    insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
    values (fam, 'Smuggled', 'other', fam || '/smuggled.pdf', true, teen_uid);
  exception when others then refused := true;
  end;
  if not refused then raise exception 'a teen filed a document into the vault'; end if;

  -- 7. Deleting what they cannot see is not a way to see it, but it is a way
  --    to destroy it.
  delete from public.documents where id = vault_id;
  if found then raise exception 'a teen deleted the vault document'; end if;

  -- ── As the parent ────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);

  select count(*) into n from public.documents where family_id = fam;
  if n <> 3 then raise exception 'the parent sees % of their own 3 documents', n; end if;

  update public.documents set is_secure = false where id = vault_id;
  if not found then raise exception 'a parent cannot move their own document out of the vault'; end if;
  update public.documents set is_secure = true where id = vault_id;

  reset role;
  delete from public.documents where family_id = fam;
  delete from public.family_members where family_id = fam;
  delete from public.families where id = fam;
  delete from auth.users where id in (parent_uid, teen_uid);
  raise notice 'document vault boundary check passed';
end $$;
