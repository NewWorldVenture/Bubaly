-- ============================================================
-- Migration 0089: public "avatars" Storage bucket
-- Backs the onboarding + settings avatar picker (preset gradients are inline
-- data URIs and need nothing; uploaded photos go here). Public read so avatar
-- URLs render anywhere; writes are scoped to the uploader's own folder.
-- Path convention: {user_id}/{timestamp}.{ext}  (see lib/storage/avatars.ts)
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars', 'avatars', true, 5242880,  -- 5 MB
  ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif'];

-- Public read (avatars are non-sensitive and rendered across the app).
DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;
CREATE POLICY "Avatars are publicly readable" ON storage.objects
  FOR SELECT USING (bucket_id = 'avatars');

-- Authenticated users may write only inside their own {user_id}/ folder.
DROP POLICY IF EXISTS "Users upload their own avatar" ON storage.objects;
CREATE POLICY "Users upload their own avatar" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users update their own avatar" ON storage.objects;
CREATE POLICY "Users update their own avatar" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1])
  WITH CHECK (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users delete their own avatar" ON storage.objects;
CREATE POLICY "Users delete their own avatar" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
