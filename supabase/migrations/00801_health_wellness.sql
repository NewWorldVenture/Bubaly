-- ============================================================
-- Migration 0080: Health & Wellness — Symptom Journal + Health Goals
-- Two gaps in the Health tier:
--   symptom_logs  — a per-member symptom journal (severity, timeline, resolve).
--   health_goals  — configurable per-member targets (steps/sleep/weight/…),
--                   replacing the hard-coded 10k-step goal in the Health module.
-- Both are family-owned data: members read/write their own family's rows (RLS).
-- ============================================================

-- ---------- Symptom journal ----------
CREATE TABLE IF NOT EXISTS public.symptom_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  symptom     text NOT NULL,
  severity    integer NOT NULL DEFAULT 3 CHECK (severity BETWEEN 1 AND 5),
  body_area   text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved')),
  notes       text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_symptom_logs_family ON public.symptom_logs (family_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_symptom_logs_member ON public.symptom_logs (member_id, status);

-- ---------- Health goals ----------
CREATE TABLE IF NOT EXISTS public.health_goals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  metric_type text NOT NULL,            -- matches health_metrics.type (steps, sleep_hours, …)
  target      numeric NOT NULL CHECK (target > 0),
  period      text NOT NULL DEFAULT 'daily' CHECK (period IN ('daily','weekly')),
  label       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, metric_type, period)
);
CREATE INDEX IF NOT EXISTS idx_health_goals_family ON public.health_goals (family_id);

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['symptom_logs','health_goals'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ---------- RLS (family members manage their own family's rows) ----------
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['symptom_logs','health_goals'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%1$I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_all ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_all ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);
  END LOOP;
END $$;
