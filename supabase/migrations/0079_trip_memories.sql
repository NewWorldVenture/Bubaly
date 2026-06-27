-- ============================================================
-- Migration 0079: Trip Memories — trip_memories
-- Preserve trip experiences: a dated journal entry per memory with an optional
-- photo (stored in the private "documents" bucket), location and member. Can
-- attach to a vacation (vacation_id) or stand alone. Family-scoped RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.trip_memories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id uuid REFERENCES public.vacations(id) ON DELETE SET NULL,
  title       text NOT NULL,
  memory_date date NOT NULL DEFAULT current_date,
  note        text,
  location    text,
  photo_path  text,
  member_id   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_memories_family ON public.trip_memories (family_id, memory_date DESC);
CREATE INDEX IF NOT EXISTS idx_trip_memories_vacation ON public.trip_memories (vacation_id);

DROP TRIGGER IF EXISTS trg_trip_memories_updated ON public.trip_memories;
CREATE TRIGGER trg_trip_memories_updated BEFORE UPDATE ON public.trip_memories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.trip_memories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage trip_memories" ON public.trip_memories;
CREATE POLICY "Members manage trip_memories" ON public.trip_memories
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
