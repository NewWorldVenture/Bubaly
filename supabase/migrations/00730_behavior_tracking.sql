-- ============================================================
-- Migration 0073: Behavior Tracking — behavior_logs (parenting insights)
-- A structured log of per-child behavior observations (positive / concern /
-- neutral) across categories (responsibility, kindness, focus, respect, mood…).
-- Powers parenting insights: balance score, trends, streaks, and AI tips.
-- Family-scoped RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE behavior_kind AS ENUM ('positive','concern','neutral');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.behavior_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id    uuid REFERENCES public.family_members(id) ON DELETE CASCADE,  -- the child
  kind         behavior_kind NOT NULL DEFAULT 'positive',
  category     text NOT NULL DEFAULT 'general',  -- responsibility, kindness, focus, respect, mood…
  note         text,
  points       integer NOT NULL DEFAULT 0,        -- optional +/- behavior points
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  logged_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_behavior_logs_family ON public.behavior_logs (family_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_behavior_logs_member ON public.behavior_logs (family_id, member_id, occurred_at DESC);

DROP TRIGGER IF EXISTS trg_behavior_logs_updated_at ON public.behavior_logs;
CREATE TRIGGER trg_behavior_logs_updated_at BEFORE UPDATE ON public.behavior_logs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.behavior_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage behavior_logs" ON public.behavior_logs;
CREATE POLICY "Members manage behavior_logs" ON public.behavior_logs
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
