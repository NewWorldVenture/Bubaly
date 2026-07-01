-- FamilyOS :: 0109 documents.is_favorite + Files indexes + RLS safeguard
-- ----------------------------------------------------------------------------
-- The redesigned Files page (/dashboard/documents) adds a per-file favorite
-- ("star") toggle and richer sorting/filtering. This migration:
--   1. Adds documents.is_favorite (additive, defaults false) so starring works.
--   2. Adds indexes for the page's common query patterns (family + recency,
--      family + favorite).
--   3. Re-asserts the canonical family-scoped RLS on public.documents for all
--      four verbs, as a guard against the production policy drift that has
--      silently emptied family pages before (see 0105-0108).
--
-- Safe to run anywhere: additive + idempotent.

alter table public.documents add column if not exists is_favorite boolean not null default false;

create index if not exists idx_documents_family_created  on public.documents (family_id, created_at desc);
create index if not exists idx_documents_family_favorite on public.documents (family_id, is_favorite);
create index if not exists idx_documents_family_category on public.documents (family_id, category);

alter table public.documents enable row level security;

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents
  for select using (public.is_family_member(family_id));

drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents
  for insert with check (public.is_family_member(family_id));

drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents
  for update using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));

drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents
  for delete using (public.is_family_member(family_id));
