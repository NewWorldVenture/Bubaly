-- ============================================================================
-- Migration 0101: Social Feed — "All your social feeds. One place."
-- ----------------------------------------------------------------------------
-- A calm, ad-free CONSUMPTION feed (distinct from the existing Social Command
-- publishing suite at /dashboard/social). Families connect SOURCES (Instagram,
-- YouTube, TikTok, X, etc.) and their posts land as ITEMS in one organized feed
-- the family can favorite, mark read, and filter.
--
-- Live ingestion from each platform needs per-platform OAuth/API keys (handled in
-- a later integration phase, like Stripe). This schema + UI store and render the
-- items; an ingestion worker / manual add populates them. Family-scoped RLS.
-- ============================================================================

DO $$ BEGIN CREATE TYPE social_item_kind AS ENUM ('post','video','photo','link'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE social_category AS ENUM ('family','friends','groups','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- connected sources ("Your Sources") ----------
CREATE TABLE IF NOT EXISTS public.social_reader_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  platform      text NOT NULL,                       -- instagram | facebook | youtube | tiktok | x | linkedin | reddit | whatsapp | pinterest
  display_name  text NOT NULL,                       -- "Instagram", or a specific account/handle
  handle        text,                                -- optional @handle / channel / community
  account_count integer NOT NULL DEFAULT 1 CHECK (account_count >= 0),
  category      social_category NOT NULL DEFAULT 'other',
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_social_reader_sources_family ON public.social_reader_sources (family_id, is_active, sort_order);

-- ---------- the feed items ----------
CREATE TABLE IF NOT EXISTS public.social_reader_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  source_id     uuid REFERENCES public.social_reader_sources(id) ON DELETE SET NULL,
  platform      text NOT NULL,
  author_name   text NOT NULL,
  author_handle text,
  avatar_url    text,
  content       text,
  media_urls    text[] NOT NULL DEFAULT '{}',
  thumbnail_url text,
  permalink     text,
  kind          social_item_kind NOT NULL DEFAULT 'post',
  duration_label text,                               -- e.g. "12:45" for video, "0:15" for short
  category      social_category NOT NULL DEFAULT 'other',
  verified      boolean NOT NULL DEFAULT false,
  is_favorite   boolean NOT NULL DEFAULT false,
  is_read       boolean NOT NULL DEFAULT false,
  external_id   text,                                -- platform's id, for idempotent ingestion
  posted_at     timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_social_reader_items_family ON public.social_reader_items (family_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_reader_items_source ON public.social_reader_items (source_id);
-- Idempotent ingestion: one row per platform item per family.
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_reader_items_external ON public.social_reader_items (family_id, platform, external_id) WHERE external_id IS NOT NULL;

-- ============================================================================
-- Family-scoped RLS + updated_at triggers.
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['social_reader_sources','social_reader_items'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members manage %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Members manage %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))',
      t
    );
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      t
    );
  END LOOP;
END $$;

-- ============================================================================
-- Done. Social Feed (consumption). Live per-platform ingestion is integration-
-- gated (OAuth/API keys); the store + UI are complete. See AGENT_HANDOFF.md.
-- ============================================================================
