-- ============================================================================
-- Migration 0194: public "marketplace-photos" Storage bucket
-- Backs real listing photo UPLOADS (previously photo_url was paste-a-URL only).
-- Public read so listing images render across the marketplace + community feed;
-- writes/updates/deletes are scoped to the uploader's own {user_id}/ folder.
-- Path convention: {user_id}/{timestamp}-{rand}.{ext}  (see components/marketplace/photo-upload.tsx)
-- Additive + idempotent (ON CONFLICT + DROP POLICY IF EXISTS).
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'marketplace-photos', 'marketplace-photos', true, 10485760,  -- 10 MB
  ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 10485760,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif'];

-- Public read (listing photos are non-sensitive and rendered across the app).
DROP POLICY IF EXISTS "Marketplace photos are publicly readable" ON storage.objects;
CREATE POLICY "Marketplace photos are publicly readable" ON storage.objects
  FOR SELECT USING (bucket_id = 'marketplace-photos');

-- Authenticated users may write only inside their own {user_id}/ folder.
DROP POLICY IF EXISTS "Users upload their own marketplace photo" ON storage.objects;
CREATE POLICY "Users upload their own marketplace photo" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'marketplace-photos' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users update their own marketplace photo" ON storage.objects;
CREATE POLICY "Users update their own marketplace photo" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'marketplace-photos' AND auth.uid()::text = (storage.foldername(name))[1])
  WITH CHECK (bucket_id = 'marketplace-photos' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users delete their own marketplace photo" ON storage.objects;
CREATE POLICY "Users delete their own marketplace photo" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'marketplace-photos' AND auth.uid()::text = (storage.foldername(name))[1]);
