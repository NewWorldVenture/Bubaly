-- 0499 — A stored file answers to its own family's rows.
-- The `documents` bucket's write rule, brought up to the rows that point at
-- its files. Found and reproduced 2026-10-10 on a replay of every runnable
-- migration.
--
-- The bucket's policies (0007's upload, 0303's read, update and delete) ask
-- two things of a caller: are you a member of the family whose folder this is,
-- and is this the file of a SENSITIVE `documents` row you may not manage
-- (`document_object_is_restricted`). Every other row that points into the
-- bucket was left out, and so was the question of whose row it is. Measured,
-- as each role of one family through PostgREST's role, rolled back; storage-api
-- runs upload-with-upsert, update, move and remove as these same statements
-- under the caller's RLS:
--
--   * insurance card images. medical-records-module uploads them to
--     {family}/insurance/… and saves the path on `insurance_policies`
--     (front_image_path, back_image_path), whose writes are managers' only.
--     A child, a teen, a caregiver and a guest each replaced, moved and
--     deleted both images (1 row each): the card a parent shows at the
--     pharmacy.
--   * a household document's bytes. 0464 refuses a guest's write on the
--     `documents` row; the guest replaced, moved and deleted the file behind
--     it (1 row each).
--   * across families. A parent of family A inserted, in A, a sensitive
--     `documents` row whose storage_path names a file of family B (nothing
--     ties the path to the row's family). 0303's lookup counts a row of ANY
--     family and asks can_manage_family of THAT row's family, so B's own parent
--     and B's own child then read 0 of their own file. It needs the exact path
--     (B's id and a millisecond timestamp), so it is narrow, and it is still one
--     family locking another out of its file.
--
-- What this does, functions and policies only (no table, trigger or data):
--
--   1. document_object_is_restricted counts only rows of the object's own
--      family, the first folder of its path. A row planted by another family no
--      longer hides the file. Nothing of the object's own family is loosened:
--      every path the app writes is {family}/…, 0007 has only ever let a member
--      upload under their own family's folder, and a row of that family is
--      counted exactly as before.
--   2. document_object_write_is_refused(name), a SECURITY DEFINER helper bound
--      the same way, is true when an `insurance_policies` row of that family
--      names the object and the caller cannot manage the family, or a
--      `documents` row of that family names it and the caller is the family's
--      guest (0464's rule, at the bytes).
--   3. 0007's upload policy and 0303's update and delete policies gain
--      `and not public.document_object_write_is_refused(name)`, in every half
--      that governs a write: INSERT's check (so nobody without the row's right
--      can put a file where a row expects one), UPDATE's using and check (a
--      replace, an upsert, a move away from or onto that path), DELETE's using.
--      The upload check also gains 0303's own `not document_object_is_restricted
--      (name)`, which 0303 left off INSERT: where a sensitive document's file is
--      missing, a child could upload bytes at its path and the parent's vault
--      would open them (measured: the insert landed). Names, PERMISSIVE and
--      `to authenticated` are unchanged, so the bucket is still governed by
--      exactly four policies (document-bytes-boundary-check inventories them).
--      The read policy is unchanged.
--
-- Not changed, deliberately:
--   * tax_documents and trip_memories bytes keep their rows' rule, any member
--     (PROD-002 / ROLE-SCOPE-001, the owner's decision), and so do files no row
--     names.
--   * O-03's step-up for stored files (decisions D1 and D3) stays the owner's.
--   * every other bucket, the family-media bucket included.
--   * Recorded lead, not fixed here: the run executor's documents.readDocument
--     and the super admin's sign and delete use the service role on a
--     row-supplied storage_path without checking that it lies in the row's
--     family. Binding the path, in the database or in those consumers, is the
--     AI-runs and admin owners' call.
--
-- The refusal of an UPDATE or DELETE is a filter (0 rows, no error), as 0303's
-- is: storage-api answers a refused remove with an empty list, which
-- lib/storage/confirm-removal.ts already reads as "not removed" (SEC-015). An
-- upload is refused with storage-api's row-level security error.
--
-- HELD: proposed as 0499 (the first number above 0498; requested on #771 in
-- comment 6094859264, not yet confirmed) in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-stored-file-answers-to-its-own-familys-rows-check.sql
-- and .github/workflows/stored-file-rows-runtime.yml. Not applied to production
-- by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regprocedure('public.document_object_is_restricted(text)') is null then
    raise exception '0499 needs document_object_is_restricted(text) from 0303';
  end if;
  if to_regprocedure('public.family_role(uuid)') is null
     or to_regprocedure('public.can_manage_family(uuid)') is null
     or to_regprocedure('public.is_sensitive_document(boolean, text)') is null then
    raise exception '0499 needs family_role, can_manage_family and is_sensitive_document';
  end if;
  if to_regclass('public.insurance_policies') is null or to_regclass('storage.objects') is null then
    raise exception '0499 needs public.insurance_policies and storage.objects';
  end if;
end
$$;

-- 1. Only the object's own family's rows restrict it.
create or replace function public.document_object_is_restricted(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.documents d
    where d.storage_path = p_object_name
      and d.family_id::text = lower(split_part(p_object_name, '/', 1))
      and public.is_sensitive_document(d.is_secure, d.category)
      and not public.can_manage_family(d.family_id)
  );
$$;

comment on function public.document_object_is_restricted(text) is
  'True when this storage object belongs to a sensitive document of the object''s own family (the first folder of its path) that the CALLER may not manage. SECURITY DEFINER so the lookup does not depend on the caller being able to see the row it asks about (0303). Rows of another family are not counted (0499).';

-- 2. A write follows the row that points at the file.
create or replace function public.document_object_write_is_refused(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.insurance_policies p
    where p_object_name in (p.front_image_path, p.back_image_path)
      and p.family_id::text = lower(split_part(p_object_name, '/', 1))
      and not public.can_manage_family(p.family_id)
  )
  or exists (
    select 1
    from public.documents d
    where d.storage_path = p_object_name
      and d.family_id::text = lower(split_part(p_object_name, '/', 1))
      and public.family_role(d.family_id) = 'guest'
  );
$$;

comment on function public.document_object_write_is_refused(text) is
  'True when the CALLER may not write the row of the object''s own family that names this storage object: an insurance card image (insurance_policies, managers only) or a documents row for a guest (0464). Used by the documents bucket''s upload, update and delete policies (0499).';

revoke all on function public.document_object_write_is_refused(text) from public;
revoke all on function public.document_object_write_is_refused(text) from anon;
grant execute on function public.document_object_write_is_refused(text) to authenticated;

-- 3. The bucket's three write policies, same names and shape, one clause more.
drop policy if exists "Family members can upload their documents" on storage.objects;
create policy "Family members can upload their documents" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
    and not public.document_object_is_restricted(name)
    and not public.document_object_write_is_refused(name)
  );

drop policy if exists "Family members can update their documents" on storage.objects;
create policy "Family members can update their documents" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
    and not public.document_object_is_restricted(name)
    and not public.document_object_write_is_refused(name)
  )
  with check (
    bucket_id = 'documents'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
    and not public.document_object_is_restricted(name)
    and not public.document_object_write_is_refused(name)
  );

drop policy if exists "Family members can delete their documents" on storage.objects;
create policy "Family members can delete their documents" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
    and not public.document_object_is_restricted(name)
    and not public.document_object_write_is_refused(name)
  );

-- Self-check: the four policies are the bucket's only ones, and each write
-- half carries the new clause.
do $$
declare
  n int;
begin
  select count(*) into n
    from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects'
     and (coalesce(p.qual, '') ~ 'bucket_id = ''documents''::text'
          or coalesce(p.with_check, '') ~ 'bucket_id = ''documents''::text');
  if n <> 4 then
    raise exception '0499: % storage.objects policies name the documents bucket, not 4', n;
  end if;
  select count(*) into n
    from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects'
     and p.permissive = 'PERMISSIVE' and p.roles = '{authenticated}'::name[]
     and ((p.policyname = 'Family members can upload their documents' and p.cmd = 'INSERT'
           and p.qual is null
           and p.with_check ~ 'NOT document_object_is_restricted\(name\)'
           and p.with_check ~ 'NOT document_object_write_is_refused\(name\)')
       or (p.policyname = 'Family members can update their documents' and p.cmd = 'UPDATE'
           and p.qual ~ 'NOT document_object_write_is_refused\(name\)'
           and p.with_check ~ 'NOT document_object_write_is_refused\(name\)')
       or (p.policyname = 'Family members can delete their documents' and p.cmd = 'DELETE'
           and p.qual ~ 'NOT document_object_write_is_refused\(name\)'));
  if n <> 3 then
    raise exception '0499: % of 3 write policies on the documents bucket carry the row rule', n;
  end if;
  if not exists (select 1 from pg_proc f
                  where f.oid = 'public.document_object_write_is_refused(text)'::regprocedure
                    and f.prosecdef
                    and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) then
    raise exception '0499: document_object_write_is_refused is not SECURITY DEFINER with a pinned search_path';
  end if;
end
$$;
