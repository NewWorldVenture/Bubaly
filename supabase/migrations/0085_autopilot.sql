-- ============================================================================
-- Migration 0085: Family Autopilot — the confidence-scored suggestion engine
-- ----------------------------------------------------------------------------
-- The keystone of "Bubaly Gen 2": a prediction layer that scans the family's
-- real data (groceries, documents, appointments, chores, birthdays, reminders)
-- and emits confidence-scored suggestions. Each suggestion carries a confidence
-- (0-100) that drives the autopilot tier:
--   >= 90  → auto-executed (status 'auto_executed')
--   70-89  → needs approval (status 'open', awaiting the family)
--   < 70   → ask / inform   (status 'open', lower urgency)
--
-- One family-scoped table with a stable dedupe_key so re-scans update an
-- existing suggestion instead of piling up duplicates.
-- ============================================================================

DO $$ BEGIN CREATE TYPE autopilot_status AS ENUM ('open','approved','executed','auto_executed','dismissed','snoozed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.autopilot_suggestions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid REFERENCES public.family_members(id) ON DELETE SET NULL, -- who it concerns
  kind          text NOT NULL,                 -- groceries | document | appointment | chore | birthday | reminder | wellbeing | finance
  title         text NOT NULL,
  detail        text,
  confidence    integer NOT NULL DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
  urgency       integer NOT NULL DEFAULT 1 CHECK (urgency BETWEEN 1 AND 3), -- 1 low, 2 med, 3 high
  status        autopilot_status NOT NULL DEFAULT 'open',
  action_type   text,                          -- e.g. add_grocery | create_reminder | create_event | none
  action_label  text,                          -- button label, e.g. "Reorder milk"
  payload       jsonb NOT NULL DEFAULT '{}',    -- structured args for the action
  source_kind   text,                          -- table the signal came from
  source_id     uuid,                          -- row that triggered it (best-effort)
  dedupe_key    text NOT NULL,                 -- stable id so re-scans upsert
  expires_at    timestamptz,                   -- auto-irrelevant after this
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_autopilot_family_status ON public.autopilot_suggestions (family_id, status, urgency DESC, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_autopilot_family_created ON public.autopilot_suggestions (family_id, created_at DESC);

-- ---- RLS + updated_at trigger (family-scoped, shared pattern) ----
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['autopilot_suggestions'];
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
-- Done! The Family Autopilot suggestion store.
-- ============================================================================
