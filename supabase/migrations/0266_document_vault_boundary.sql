-- Bubaly :: 0266 The Secure Vault is actually secure
-- ----------------------------------------------------------------------------
-- 0117 added `documents.is_secure` to split the Files hub into Cloud Storage /
-- Secure Vault / Shared Files, and said in its own header:
--
--   "RLS is unchanged — `documents` already carries a family-scoped policy
--    (migration 0004) that governs this column."
--
-- That is the reasoning error this migration repairs. The family-scoped policy
-- governs the ROW; it says nothing about which member of the family may read a
-- secure one. So the vault was a label the client drew, and every one of these
-- was true for a child with a /kid-login session and the anon key:
--
--   * `select * from documents` returned every vault row, including
--     `storage_path`, which is all a signed URL needs.
--   * `update documents set is_secure = false` moved anything out of the vault
--     (`components/modules/files-hub-module.tsx` offers exactly that button to
--     every member).
--   * The storage policies on the `documents` bucket (0007) check only
--     `is_family_member` on the folder uuid, so the bytes came back too.
--
-- `lib/services/documents` DOES filter this correctly — `isSensitiveDocument`
-- plus a manager check — but that guards the AI and service paths. The Files
-- and Documents modules query through the browser anon client and never reach
-- it. Same shape as 0264: the boundary the TypeScript enforced now exists in
-- the database, where it holds for every caller.
--
-- SENSITIVITY IS THE SAME PREDICATE ON BOTH SIDES. `is_sensitive_document`
-- below mirrors `SENSITIVE_CATEGORIES` in lib/services/documents/index.ts, and
-- `tests/document-vault-boundary.test.ts` fails if the two lists drift. Keying
-- only on `is_secure` would have left a hole: a child could re-file a medical
-- record as `other` and the category rule is what stops that.
--
-- Additive to the data; no column or row changes. Policies dropped and
-- recreated by name, so it is idempotent.

-- ── The shared definition of "not for the children" ─────────────────────────
create or replace function public.is_sensitive_document(p_is_secure boolean, p_category text)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(p_is_secure, false)
     or btrim(lower(coalesce(p_category, ''))) in (
       'legal', 'medical', 'health', 'financial', 'finance', 'tax', 'taxes', 'insurance',
       'passport', 'passports', 'id', 'identity', 'visa', 'bank', 'banking', 'will', 'estate'
     );
$$;

comment on function public.is_sensitive_document(boolean, text) is
  'Mirrors SENSITIVE_CATEGORIES in lib/services/documents/index.ts. Changing one without the other fails tests/document-vault-boundary.test.ts.';

-- ── The table ───────────────────────────────────────────────────────────────
alter table public.documents enable row level security;

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents
  for select using (
    public.is_family_member(family_id)
    and (not public.is_sensitive_document(is_secure, category) or public.can_manage_family(family_id))
  );

-- A member may still file an ordinary document; only a manager may file one
-- into the vault or under a sensitive category.
drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents
  for insert with check (
    public.is_family_member(family_id)
    and (not public.is_sensitive_document(is_secure, category) or public.can_manage_family(family_id))
  );

-- BOTH halves matter. `using` stops a non-manager touching a row that is
-- already sensitive (the "move it out of the vault, then read it" path);
-- `with check` stops them writing a row INTO that state, which would otherwise
-- let a child hide a document from the adults.
drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents
  for update
  using (
    public.is_family_member(family_id)
    and (not public.is_sensitive_document(is_secure, category) or public.can_manage_family(family_id))
  )
  with check (
    public.is_family_member(family_id)
    and (not public.is_sensitive_document(is_secure, category) or public.can_manage_family(family_id))
  );

drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents
  for delete using (
    public.is_family_member(family_id)
    and (not public.is_sensitive_document(is_secure, category) or public.can_manage_family(family_id))
  );

-- ── The bytes ───────────────────────────────────────────────────────────────
-- Hiding the row is most of it — a signed URL needs `storage_path`, and that
-- now comes back to managers only. This is the other half, so a path learned
-- before today (or guessed) still does not open the file.
--
-- An object with NO matching row stays readable by the family: the Files hub
-- uploads the file first and inserts the row second, and an upload must not
-- have to race its own policy.
drop policy if exists "Family members can read their documents" on storage.objects;
create policy "Family members can read their documents" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
    and not exists (
      select 1 from public.documents d
      where d.storage_path = storage.objects.name
        and public.is_sensitive_document(d.is_secure, d.category)
        and not public.can_manage_family(d.family_id)
    )
  );

drop policy if exists "Family members can update their documents" on storage.objects;
create policy "Family members can update their documents" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
    and not exists (
      select 1 from public.documents d
      where d.storage_path = storage.objects.name
        and public.is_sensitive_document(d.is_secure, d.category)
        and not public.can_manage_family(d.family_id)
    )
  );

drop policy if exists "Family members can delete their documents" on storage.objects;
create policy "Family members can delete their documents" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
    and not exists (
      select 1 from public.documents d
      where d.storage_path = storage.objects.name
        and public.is_sensitive_document(d.is_secure, d.category)
        and not public.can_manage_family(d.family_id)
    )
  );

-- The correlated lookup above is by object name; index the column it joins to.
create index if not exists idx_documents_storage_path on public.documents(storage_path);
