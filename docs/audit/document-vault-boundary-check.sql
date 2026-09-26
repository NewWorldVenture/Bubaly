-- Behavioural proof for 0266, run as a real `authenticated` session under RLS.
--
-- Bubaly's Files hub draws a "Secure Vault". Before this migration that was a
-- label the client drew: the row, its `storage_path`, and the button that moves
-- a file back out were all reachable by every family member. This asserts the
-- database now decides.
grant usage on schema public to authenticated;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

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
  --
  -- This asserts the OUTCOME — did the column actually move? — rather than the
  -- mechanism, and that is deliberate: a check on "was 42501 raised" is
  -- satisfied by any refusal, including one from a missing grant or a broken
  -- fixture, while a check on the stored value can only pass if the row really
  -- did not change. It is the stronger of the two and needs no positive control.
  --
  -- The `begin … exception` block IS load-bearing and must stay: RLS refuses
  -- this update with 42501, and without a handler that error propagates and
  -- kills the probe before the outcome check below can run. Removing it was
  -- tried and does exactly that.
  --
  -- What was dead is the ASSIGNMENT inside it. `refused := true` is clobbered
  -- one line later by `select ... into refused`, so nothing ever read it, and
  -- it made the handler look like the assertion when the assertion is the
  -- column read. The block now swallows the refusal and says so, and the value
  -- tested comes only from the table.
  begin
    update public.documents set is_secure = true where id = school_id;
  exception when insufficient_privilege then
    null;  -- expected; the assertion is the column read below, not this catch
  end;
  select is_secure into refused from public.documents where id = school_id;
  if refused then raise exception 'a teen hid a shared document in the vault'; end if;

  -- 6. And cannot file a new one straight into it.
  --
  -- POSITIVE CONTROL FIRST. Check 6 asserts a refusal, and a refusal is only
  -- evidence about the VAULT if the same session can file an ordinary document.
  -- Every setup insert above ran before the session switched to the teen, so
  -- without this nothing proved the teen still holds INSERT on public.documents
  -- or still satisfies `is_family_member(family_id)` — and `insufficient_
  -- privilege` from a missing grant or a broken family scope would have read
  -- exactly like the vault predicate doing its job. This audit has twice
  -- recorded a refusal credited to the wrong cause; this is the guard against
  -- the third time.
  begin
    insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
    values (fam, 'Ordinary', 'other', fam || '/ordinary.pdf', false, teen_uid);
    get diagnostics n = row_count;
  exception when insufficient_privilege then
    -- Caught so the operator is told WHICH refusal this is. Without it the
    -- raw 'permission denied for table documents' is accurate but reads like
    -- the vault working, which is the confusion this control exists to end.
    raise exception 'CONTROL FAILED: the teen was refused an ORDINARY document (%), so a refusal in check 6 would prove nothing about the vault — the session has no usable INSERT on public.documents at all', sqlerrm;
  end;
  if n <> 1 then
    raise exception 'CONTROL FAILED: the teen filed no ORDINARY document and was not refused either, so check 6 below would prove nothing about the vault';
  end if;

  -- The control must leave the fixture exactly as it found it. The parent's
  -- count below asserts 3 documents, and a control that quietly made it 4 would
  -- trade one vacuous check for one false failure.
  delete from public.documents where storage_path = fam || '/ordinary.pdf';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'CONTROL FAILED: could not remove the ordinary document it just filed, so the fixture is no longer what the checks below assume';
  end if;

  refused := false;
  begin
    insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
    values (fam, 'Smuggled', 'other', fam || '/smuggled.pdf', true, teen_uid);
  -- Catch ONLY the RLS refusal, as check 5 above already does. `when others`
  -- also swallows a typo in this statement: rename a column here and the insert
  -- raises 42703, is caught, and the vault reports itself shut while nothing was
  -- tested. Verified against this file: renaming storage_path leaves the probe
  -- printing "document vault boundary check passed".
  exception when insufficient_privilege then refused := true;
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
