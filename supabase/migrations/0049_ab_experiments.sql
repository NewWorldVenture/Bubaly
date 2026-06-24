-- ============================================================
-- Migration 0049: A/B Testing (experiments + events)
-- Marketing pillar. Admins define experiments (variants + a conversion metric);
-- the app assigns visitors to variants deterministically and records exposure /
-- conversion events. Results + statistical significance are computed at read time.
--
-- Business-wide (not family-scoped), like the rest of the marketing suite:
--   ab_experiments — RLS ENABLED, NO policies → service-role/admin console only.
--   ab_events      — RLS ENABLED, NO policies → written via the service-role
--                    tracking endpoint; read/aggregated in the admin console.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ab_experiments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  hypothesis  text,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','paused','completed')),
  -- [{ "key": "control", "label": "Control" }, { "key": "b", "label": "Variant B" }]
  variants    jsonb NOT NULL DEFAULT '[]'::jsonb,
  metric      text NOT NULL DEFAULT 'conversion',
  winner      text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ab_experiments_status ON public.ab_experiments (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_ab_experiments_updated_at ON public.ab_experiments;
CREATE TRIGGER trg_ab_experiments_updated_at
  BEFORE UPDATE ON public.ab_experiments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.ab_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_key  text NOT NULL,
  variant_key     text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('exposure','conversion')),
  visitor_id      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ab_events_experiment ON public.ab_events (experiment_key, kind);
-- One exposure / one conversion per visitor per experiment (dedupes double-fires).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ab_events_visitor
  ON public.ab_events (experiment_key, visitor_id, kind)
  WHERE visitor_id IS NOT NULL;

ALTER TABLE public.ab_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ab_events ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done! Experiments are authored in the admin console; events flow in via the
-- service-role tracking endpoint; results are aggregated for significance.
-- ============================================================
