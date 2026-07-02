-- 0117_documents_secure.sql
-- Adds a "Secure Vault" flag to documents so the Files hub can split storage into
-- Cloud Storage (everything) / Secure Vault (is_secure) / Shared Files (the rest).
-- Additive + backward-compatible: nullable-safe boolean default false, existing
-- rows unchanged. RLS is unchanged — `documents` already carries a family-scoped
-- policy (migration 0004) that governs this column.

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS is_secure boolean NOT NULL DEFAULT false;

-- The Files sub-pages filter by (family_id, is_secure); index that access path.
CREATE INDEX IF NOT EXISTS idx_documents_family_secure
  ON public.documents(family_id, is_secure);
