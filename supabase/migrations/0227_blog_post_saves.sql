-- ============================================================================
-- Migration 0227: Blog saves — signed-in "❤ save this article" bookmarks
-- The public blog heart is now an account feature: clicking it requires being
-- signed in and persists a per-user save (a bookmark), so readers build a
-- library of articles tied to their Bubaly account rather than an anonymous,
-- device-bound like.
--
--   • blog_post_saves — one row per (user, post). RLS lets each user read and
--     manage ONLY their own saves. The public save COUNT shown on the heart is
--     computed by the /api/blog/save route via the service role (aggregate
--     only, no per-user exposure), so nobody can see who saved what.
--
-- The older anonymous blog_post_likes table (0201) is left intact for history
-- but is no longer what the heart writes to.
-- Additive + idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.blog_post_saves (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    uuid NOT NULL REFERENCES public.blog_posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_blog_post_saves_post ON public.blog_post_saves (post_id);
CREATE INDEX IF NOT EXISTS idx_blog_post_saves_user ON public.blog_post_saves (user_id);

ALTER TABLE public.blog_post_saves ENABLE ROW LEVEL SECURITY;

-- Each signed-in user reads + manages ONLY their own saves. No cross-user reads:
-- the aggregate count on the heart is produced server-side by the service role.
DROP POLICY IF EXISTS blog_post_saves_select_own ON public.blog_post_saves;
CREATE POLICY blog_post_saves_select_own ON public.blog_post_saves
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS blog_post_saves_insert_own ON public.blog_post_saves;
CREATE POLICY blog_post_saves_insert_own ON public.blog_post_saves
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS blog_post_saves_delete_own ON public.blog_post_saves;
CREATE POLICY blog_post_saves_delete_own ON public.blog_post_saves
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON public.blog_post_saves TO authenticated;
