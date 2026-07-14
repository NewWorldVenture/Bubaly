-- ============================================================================
-- Migration 0203: Editable service descriptions (All Services tooltips)
-- The "All Services" catalog now shows a hover tooltip explaining what each
-- service offers. Copy defaults live in code (lib/services/descriptions.ts) so
-- tooltips always work; this table stores only SUPER-ADMIN OVERRIDES, keyed by
-- the service's nav route (`service_key` = the href). Empty/absent → the code
-- default is shown.
--   • World-readable (tooltips render for every signed-in member; the public
--     read is harmless — these are marketing-style blurbs).
--   • Writes are service-role only: the /admin/services editor persists via a
--     super-admin-guarded server action. No client write policy → RLS denies.
-- Additive + idempotent. No seed (defaults are versioned in code).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.service_descriptions (
  service_key text PRIMARY KEY CHECK (char_length(service_key) BETWEEN 1 AND 200),
  description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 400),
  updated_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_service_descriptions_updated_at ON public.service_descriptions;
CREATE TRIGGER trg_service_descriptions_updated_at
  BEFORE UPDATE ON public.service_descriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.service_descriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service descriptions are readable" ON public.service_descriptions;
CREATE POLICY "Service descriptions are readable" ON public.service_descriptions
  FOR SELECT TO anon, authenticated
  USING (true);

GRANT SELECT ON public.service_descriptions TO anon, authenticated;
-- Writes: service-role only (super-admin server action). No INSERT/UPDATE/DELETE policy.
