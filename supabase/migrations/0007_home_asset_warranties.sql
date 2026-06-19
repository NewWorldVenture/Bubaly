-- ============================================================
-- Migration 0007: Warranty storage for home assets
-- Links documents to home_assets and provisions the private
-- "documents" Storage bucket + folder-scoped RLS (family_id is the
-- first path segment), so warranty files are uploaded for real
-- instead of relying on a manually-created bucket.
-- ============================================================

-- ── documents.asset_id: link a document (e.g. a warranty PDF) to a home asset ──
ALTER TABLE documents ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES home_assets(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_documents_asset ON documents(asset_id);

-- ============================================================
-- STORAGE: private "documents" bucket, scoped per family folder
-- Path convention: {family_id}/{category}/{filename}
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('documents', 'documents', false, 26214400) -- 25 MB
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Family members can read their documents" ON storage.objects;
CREATE POLICY "Family members can read their documents" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'documents'
    AND is_family_member(((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS "Family members can upload their documents" ON storage.objects;
CREATE POLICY "Family members can upload their documents" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND is_family_member(((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS "Family members can update their documents" ON storage.objects;
CREATE POLICY "Family members can update their documents" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'documents'
    AND is_family_member(((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS "Family members can delete their documents" ON storage.objects;
CREATE POLICY "Family members can delete their documents" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'documents'
    AND is_family_member(((storage.foldername(name))[1])::uuid)
  );

-- ============================================================
-- Done! Warranty files upload to the real "documents" bucket,
-- tagged to a home asset via documents.asset_id.
-- ============================================================
