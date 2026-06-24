-- ============================================================================
-- Migration 0087: Personal Journal — private reflection + growth
-- ----------------------------------------------------------------------------
-- A per-member journal: dated entries with a mood, optional title/body, the
-- reflection prompt that inspired it, and tags. Entries are personal (the app
-- scopes every read/write to the signed-in member), but the table uses the same
-- family-scoped RLS as the rest of the app for consistency.
-- ============================================================================

DO $$ BEGIN CREATE TYPE journal_mood AS ENUM ('great','good','okay','low','stressed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.journal_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id    uuid REFERENCES public.family_members(id) ON DELETE SET NULL, -- the author
  entry_date   date NOT NULL DEFAULT current_date,
  mood         journal_mood,
  title        text,
  body         text NOT NULL DEFAULT '',
  prompt       text,                              -- the reflection prompt used, if any
  tags         text[] NOT NULL DEFAULT '{}',
  is_private   boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_journal_member ON public.journal_entries (family_id, member_id, entry_date DESC);

-- ---- RLS + updated_at trigger (family-scoped; app scopes to the author) ----
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage journal_entries" ON public.journal_entries;
CREATE POLICY "Members manage journal_entries" ON public.journal_entries
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_journal_entries_updated_at ON public.journal_entries;
CREATE TRIGGER trg_journal_entries_updated_at BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- Done! The Personal Journal store.
-- ============================================================================
