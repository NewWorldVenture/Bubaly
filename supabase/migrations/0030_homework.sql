-- ============================================================
-- Migration 0030: Homework tracker
-- Backs the Homework Tracker (Top-50 complaint #16 "kids miss homework
-- → AI student assistant"). Per-student assignments with subject, due
-- date, and a simple status workflow.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE homework_status AS ENUM ('assigned', 'in_progress', 'done', 'submitted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.homework_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  subject     text,
  title       text NOT NULL,
  details     text,
  due_at      timestamptz,
  status      homework_status NOT NULL DEFAULT 'assigned',
  completed_at timestamptz,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_homework_family ON public.homework_assignments(family_id);
CREATE INDEX IF NOT EXISTS idx_homework_member ON public.homework_assignments(member_id);
CREATE INDEX IF NOT EXISTS idx_homework_due ON public.homework_assignments(family_id, due_at);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.homework_assignments;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.homework_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.homework_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage homework_assignments" ON public.homework_assignments;
CREATE POLICY "Members can manage homework_assignments" ON public.homework_assignments
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
