-- The OTHER half of the document vault: the bytes.
--
-- 0266 hides a sensitive document's ROW from a non-manager, and
-- document-vault-boundary-check.sql proves that half. It then adds three
-- storage.objects policies so "a path learned before today (or guessed) still
-- does not open the file" — and nothing tested those. This does.
--
-- Each of the three guards the same way:
--
--   not exists (select 1 from public.documents d
--               where d.storage_path = storage.objects.name
--                 and public.is_sensitive_document(d.is_secure, d.category)
--                 and not public.can_manage_family(d.family_id))
--
-- The question this file answers is whether that subquery can see the row it
-- is asking about. A policy expression runs as the CALLING user, so the read
-- of public.documents is itself subject to documents_select — the very policy
-- that hides sensitive rows from a child. If it is hidden, the subquery finds
-- nothing, `not exists` is TRUE, and the guard admits exactly the object it
-- exists to refuse.
--
-- Judged on ROW COUNTS, not on whether an error was raised: an UPDATE or
-- DELETE that matches no visible row changes nothing and raises nothing, so an
-- exception-only assertion would pass while the bytes walked out the door.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000000d0c5';
  manager_uid uuid := '00000000-0000-4000-8000-00000000d0a1';
  child_uid uuid := '00000000-0000-4000-8000-00000000d0a2';
  secure_path text := fam::text || '/passport-scan.pdf';
  plain_path  text := fam::text || '/school-newsletter.pdf';
  visible int;
  affected int;
  failures int := 0;
begin
  -- Repeatable: the harness stub gives storage.objects no unique key, so a
  -- re-run would stack a second copy of each fixture object and the control
  -- below would read 2 where it expects 1 — a failure that says nothing about
  -- the boundary. Clear this probe's own rows first.
  delete from storage.objects where bucket_id = 'documents' and name like fam::text || '/%';
  delete from public.documents where family_id = fam;

  -- ── household ────────────────────────────────────────────────────────────
  insert into auth.users (id, email) values
    (manager_uid, 'vault-manager@example.com'),
    (child_uid,   'vault-child@example.com')
  on conflict (id) do nothing;

  insert into public.families (id, name, created_by) values (fam, 'Vault Bytes', manager_uid)
  on conflict (id) do nothing;

  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, manager_uid, 'Manager', 'parent', true),
    (fam, child_uid,   'Child',   'child',  true)
  on conflict do nothing;

  -- A sensitive document and an ordinary one, each with its object in storage.
  insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
  values (fam, 'Passport scan', 'identity', secure_path, true, manager_uid)
  on conflict do nothing;
  insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
  values (fam, 'School newsletter', 'other', plain_path, false, manager_uid)
  on conflict do nothing;

  insert into storage.buckets (id, name, public) values ('documents', 'documents', false)
  on conflict (id) do nothing;
  insert into storage.objects (bucket_id, name, owner) values
    ('documents', secure_path, manager_uid),
    ('documents', plain_path,  manager_uid)
  on conflict do nothing;

  -- ── as the child ─────────────────────────────────────────────────────────
  -- The harness resolves auth.uid() from `request.jwt.claim.sub` (singular),
  -- the same setting the other probes use. Set it BEFORE dropping to the
  -- authenticated role, or the child is nobody and every assertion below
  -- passes for the wrong reason.
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- Prove the identity took, because a probe that measures a stranger measures
  -- nothing: every read would be empty and every refusal vacuous.
  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: the probe is not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: the probe is acting as a manager, so nothing below is a child boundary';
  end if;

  -- Control: the row half still works, or the rest of this proves nothing.
  select count(*) into visible from public.documents where storage_path = secure_path;
  if visible <> 0 then
    raise warning 'CONTROL FAILED: the child can see the sensitive document ROW (0266 row half is broken)';
    failures := failures + 1;
  end if;

  -- Control: the child CAN reach an ordinary document's bytes, so a refusal
  -- below is the guard working rather than the whole bucket being shut.
  select count(*) into visible from storage.objects
   where bucket_id = 'documents' and name = plain_path;
  if visible <> 1 then
    raise warning 'CONTROL FAILED: the child cannot read an ORDINARY document object (expected 1, got %)', visible;
    failures := failures + 1;
  end if;

  -- 1. READ the sensitive object.
  select count(*) into visible from storage.objects
   where bucket_id = 'documents' and name = secure_path;
  if visible <> 0 then
    raise warning 'BREACH: a child can read the storage object for a sensitive document (rows visible: %)', visible;
    failures := failures + 1;
  end if;

  -- 2. UPDATE it — renaming an object out from under the vault, which also
  --    detaches it from the documents row that classifies it as sensitive.
  --    Tested BEFORE the delete: a delete that succeeds would leave nothing to
  --    rename, and the rename would then report a clean zero for the wrong
  --    reason.
  update storage.objects set name = fam::text || '/harmless.pdf'
   where bucket_id = 'documents' and name = secure_path;
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise warning 'BREACH: a child RENAMED the storage object for a sensitive document (rows: %)', affected;
    failures := failures + 1;
    -- Put it back, so the delete below is measured against the same object.
    reset role;
    update storage.objects set name = secure_path
     where bucket_id = 'documents' and name = fam::text || '/harmless.pdf';
    perform set_config('request.jwt.claim.sub', child_uid::text, true);
    set local role authenticated;
  end if;

  -- 3. DELETE it. Destroying the family's passport scan needs no read at all.
  delete from storage.objects where bucket_id = 'documents' and name = secure_path;
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise warning 'BREACH: a child DELETED the storage object for a sensitive document (rows: %)', affected;
    failures := failures + 1;
  end if;

  reset role;
  if failures > 0 then
    raise exception 'document-bytes-boundary: % assertion(s) failed', failures;
  end if;
  raise notice 'document-bytes-boundary: OK — the bytes of a sensitive document are closed to a child';
end
$probe$;
