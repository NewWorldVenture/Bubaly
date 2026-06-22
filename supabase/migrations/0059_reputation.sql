-- ============================================================
-- Migration 0059: Reputation & Trust — testimonials + case studies
-- Social proof and enterprise sales enablement. Distinct from `reviews` (#41,
-- inbound moderated ratings): these are curated, published marketing assets.
-- Service-role only for writes (RLS ENABLED, NO policies); the public marketing
-- site reads published rows via the service client in a server component.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.testimonials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_name  text NOT NULL,
  author_role  text,
  company      text,
  quote        text NOT NULL,
  rating       integer CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  avatar_url   text,
  is_published boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_testimonials_published ON public.testimonials (is_published, sort_order);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.testimonials;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.testimonials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.case_studies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  slug          text NOT NULL UNIQUE,
  industry      text,
  customer_name text,
  summary       text,
  body          text,
  result_metric text,                      -- e.g. "Saved 6 hrs/week"
  is_published  boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_case_studies_published ON public.case_studies (is_published);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.case_studies;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.case_studies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.testimonials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_studies ENABLE ROW LEVEL SECURITY;
