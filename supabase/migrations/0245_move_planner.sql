-- ============================================================
-- Migration 0245: Move Planner — "Moving is extremely stressful" (TODO-0412)
--   moves       — one row per move: from/to, move date, status, budget, mover.
--   move_tasks  — the timeline: category, lead days before/after move day,
--                 due date, assignee, status. Generated from the T-8w → T+2w
--                 template and edited freely.
--   move_boxes  — labelled boxes: number, from-room, to-room, contents,
--                 fragile, packed / loaded / unpacked.
-- Family-owned data: members read/write their own family's rows (RLS).
-- Additive + idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.moves (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  title             text NOT NULL,
  from_address      text,
  to_address        text,
  move_date         date NOT NULL,
  status            text NOT NULL DEFAULT 'planning'
                    CHECK (status IN ('planning','packing','moving_day','settling','done','cancelled')),
  move_kind         text NOT NULL DEFAULT 'local'
                    CHECK (move_kind IN ('local','long_distance','international','within_building')),
  budget_cents      integer CHECK (budget_cents IS NULL OR budget_cents >= 0),
  spent_cents       integer NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
  mover_name        text,
  mover_phone       text,
  mover_quote_cents integer CHECK (mover_quote_cents IS NULL OR mover_quote_cents >= 0),
  has_kids          boolean NOT NULL DEFAULT true,
  has_pets          boolean NOT NULL DEFAULT false,
  is_renting_out    boolean NOT NULL DEFAULT false,
  notes             text,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_moves_family_date ON public.moves (family_id, move_date DESC);

CREATE TABLE IF NOT EXISTS public.move_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  move_id       uuid NOT NULL REFERENCES public.moves(id) ON DELETE CASCADE,
  title         text NOT NULL,
  category      text NOT NULL DEFAULT 'admin'
                CHECK (category IN ('admin','address','utilities','movers','packing','school','medical','pets','finance','cleaning','settling','other')),
  offset_days   integer NOT NULL DEFAULT 0 CHECK (offset_days BETWEEN -365 AND 365),
  due_date      date,
  assignee_id   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','skipped')),
  completed_at  timestamptz,
  template_key  text,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_move_tasks_move_due ON public.move_tasks (move_id, due_date);
CREATE INDEX IF NOT EXISTS idx_move_tasks_family_status ON public.move_tasks (family_id, status);

CREATE TABLE IF NOT EXISTS public.move_boxes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  move_id       uuid NOT NULL REFERENCES public.moves(id) ON DELETE CASCADE,
  box_number    integer NOT NULL CHECK (box_number > 0),
  label         text NOT NULL,
  from_room     text,
  to_room       text,
  contents      text[] NOT NULL DEFAULT '{}',
  is_fragile    boolean NOT NULL DEFAULT false,
  is_essential  boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'empty' CHECK (status IN ('empty','packed','loaded','delivered','unpacked')),
  packed_by     uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  photo_path    text,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (move_id, box_number)
);
CREATE INDEX IF NOT EXISTS idx_move_boxes_move_status ON public.move_boxes (move_id, status);

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['moves','move_tasks','move_boxes'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    EXECUTE format('ALTER TABLE public.%1$I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_all ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_all ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);
  END LOOP;
END $$;

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['moves','move_tasks','move_boxes'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN RETURN; END IF;
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
