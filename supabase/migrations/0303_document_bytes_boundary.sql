-- 0303_document_bytes_boundary.sql
-- The vault's second half was checking a row it could not see.
--
-- 0266 closed the document vault in two places. The ROW half works: a child
-- cannot see a sensitive document, so they cannot learn its `storage_path`.
-- The BYTES half was meant to hold the line anyway — its own comment says "a
-- path learned before today (or guessed) still does not open the file" — and
-- it does not.
--
-- All three storage policies guard the same way:
--
--   not exists (select 1 from public.documents d
--               where d.storage_path = storage.objects.name
--                 and public.is_sensitive_document(d.is_secure, d.category)
--                 and not public.can_manage_family(d.family_id))
--
-- A policy expression is evaluated as the CALLING user, so that read of
-- public.documents is itself subject to `documents_select` — the very policy
-- that hides sensitive rows from a child. The child cannot see the row, the
-- subquery finds nothing, `not exists` is TRUE, and the guard admits exactly
-- the object it exists to refuse. The stricter the row half gets, the wider
-- this opens: they are the same predicate pointed in opposite directions.
--
-- Measured on a replayed database with all migrations applied
-- (docs/audit/document-bytes-boundary-check.sql), acting as a child of the
-- family, with both controls passing — the child cannot see the document row,
-- and CAN see an ordinary object, so the bucket is not simply shut:
--
--   * reading the sensitive object returned 1 row;
--   * deleting it removed 1 row — the family's passport scan, gone, by someone
--     who was never allowed to know it existed.
--
-- The fix is to ask the question with the row visible. A SECURITY DEFINER
-- function reads public.documents as its owner, so the lookup no longer
-- depends on the caller being allowed to see what it is looking up. It still
-- answers about the CALLER: `can_manage_family` resolves auth.uid() inside,
-- which SECURITY DEFINER does not change.
--
-- It returns a boolean and nothing else — no title, no path, no family id — so
-- it cannot become a way to read the vault it protects.

-- `search_path` is pinned directly on the declaration below, like every other
-- definer function here: an unqualified name inside a definer function is
-- otherwise resolved in the CALLER's search_path. It sits immediately after
-- `security definer` so that the pin and the privilege are read together —
-- tests/definer-search-path-pinned.test.ts looks for it in that window, and a
-- comment wedged between the two is exactly what makes it easy to miss.
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
      and public.is_sensitive_document(d.is_secure, d.category)
      and not public.can_manage_family(d.family_id)
  );
$$;

comment on function public.document_object_is_restricted(text) is
  'True when this storage object belongs to a sensitive document the CALLER may not manage. SECURITY DEFINER so the lookup does not depend on the caller being able to see the row it asks about — that visibility is exactly what the vault removes.';

revoke all on function public.document_object_is_restricted(text) from public;
grant execute on function public.document_object_is_restricted(text) to authenticated;

-- ── the three policies, asking the question properly ────────────────────────
-- An object with NO matching row stays readable by the family, unchanged from
-- 0266: the Files hub uploads the file first and inserts the row second, and an
-- upload must not have to race its own policy.

drop policy if exists "Family members can read their documents" on storage.objects;
create policy "Family members can read their documents" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
    and not public.document_object_is_restricted(name)
  );

-- BOTH halves, for the same reason documents_update spells out: `using` stops a
-- non-manager touching an object that is already restricted; `with check` stops
-- them renaming one INTO a path that is. Without it Postgres reuses `using` for
-- the new row, which happens to be right here — but leaving that implicit is
-- how the pair drifts apart later.
drop policy if exists "Family members can update their documents" on storage.objects;
create policy "Family members can update their documents" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
    and not public.document_object_is_restricted(name)
  )
  with check (
    bucket_id = 'documents'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
    and not public.document_object_is_restricted(name)
  );

drop policy if exists "Family members can delete their documents" on storage.objects;
create policy "Family members can delete their documents" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
    and not public.document_object_is_restricted(name)
  );
