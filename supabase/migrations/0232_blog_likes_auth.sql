-- FamilyOS :: 0232 Blog likes — require sign-in to save a ♥
-- ----------------------------------------------------------------------------
-- The blog heart moves from an anonymous, visitor-keyed like to an
-- authenticated, per-account like: you must be signed in to save one, and your
-- likes are tied to your account (so they follow you across devices). We add a
-- nullable user_id (legacy anonymous rows keep NULL and still count toward the
-- public total) and a partial unique index enforcing one like per (post, user).
-- The /api/blog/like route rejects unauthenticated POSTs; the HeartButton sends
-- signed-out visitors to sign in. Additive + idempotent.

ALTER TABLE public.blog_post_likes
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- One like per (post, signed-in user). Partial so legacy anonymous rows
-- (user_id IS NULL) are unaffected and the existing (post_id, visitor_id)
-- uniqueness continues to guard them.
CREATE UNIQUE INDEX IF NOT EXISTS uq_blog_post_likes_user
  ON public.blog_post_likes (post_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_blog_post_likes_user
  ON public.blog_post_likes (user_id)
  WHERE user_id IS NOT NULL;

-- Still service-role only (no client policies): the /api/blog/like route is the
-- single validated read/write path and now checks the caller's session.
