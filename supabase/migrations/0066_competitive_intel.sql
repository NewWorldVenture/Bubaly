-- ============================================================
-- Migration 0066: Competitive Intelligence
-- Competitor Monitoring + Keyword Intelligence + Backlink Monitoring (the
-- Medium-priority intel pillar). Service-role only (RLS ENABLED, NO policies),
-- per the marketing-table convention. Authored in the admin console.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.competitors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  domain      text,
  ranking     integer,                 -- our perceived market position (1 = top)
  notes       text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_competitors_ranking ON public.competitors (ranking);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.competitors;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.competitors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.keyword_intel (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword       text NOT NULL,
  search_volume integer NOT NULL DEFAULT 0,   -- monthly searches
  difficulty    integer,                       -- 0–100 SEO difficulty
  our_rank      integer,                       -- our SERP position (null = unranked)
  competitor_id uuid REFERENCES public.competitors(id) ON DELETE SET NULL,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_keyword_intel_volume ON public.keyword_intel (search_volume DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.keyword_intel;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.keyword_intel
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.backlinks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_domain text NOT NULL,                 -- the site linking to us
  target_url    text,                          -- our page being linked
  authority     integer,                       -- 0–100 domain authority
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','lost','toxic')),
  discovered_at date,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_backlinks_status ON public.backlinks (status);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.backlinks;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.backlinks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.competitors   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_intel ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backlinks     ENABLE ROW LEVEL SECURITY;
