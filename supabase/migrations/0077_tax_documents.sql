-- ============================================================
-- Migration 0077: Tax Document Vault — tax_documents
-- Organize critical tax docs by year + category (W-2, 1099, receipts,
-- deductions, statements, returns…). Files live in the existing private
-- "documents" storage bucket (family-folder RLS); this table is the index with
-- amounts for deduction totals. Family-scoped RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tax_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  tax_year     integer NOT NULL,
  category     text NOT NULL DEFAULT 'other'
                 CHECK (category IN ('w2','1099','receipt','deduction','statement','return','property','charity','medical','other')),
  name         text NOT NULL,
  storage_path text,
  amount_cents integer,
  member_id    uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  note         text,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_documents_family ON public.tax_documents (family_id, tax_year DESC);

DROP TRIGGER IF EXISTS trg_tax_documents_updated ON public.tax_documents;
CREATE TRIGGER trg_tax_documents_updated BEFORE UPDATE ON public.tax_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.tax_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage tax_documents" ON public.tax_documents;
CREATE POLICY "Members manage tax_documents" ON public.tax_documents
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
