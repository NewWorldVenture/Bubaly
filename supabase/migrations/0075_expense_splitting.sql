-- ============================================================
-- Migration 0075: Expense Splitting — expense_splits + expense_split_shares
-- Family accounting: record a shared expense (who paid, total, category), split
-- it across members, and track who owes whom until settled. Powers per-member
-- balances and minimal-transfer settlement suggestions. Family-scoped RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.expense_splits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  description text NOT NULL,
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  category    text,
  paid_by     uuid REFERENCES public.family_members(id) ON DELETE SET NULL,  -- who fronted it
  spent_on    date NOT NULL DEFAULT current_date,
  note        text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_splits_family ON public.expense_splits (family_id, spent_on DESC);

CREATE TABLE IF NOT EXISTS public.expense_split_shares (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  split_id    uuid NOT NULL REFERENCES public.expense_splits(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  share_cents integer NOT NULL CHECK (share_cents >= 0),
  settled     boolean NOT NULL DEFAULT false,
  settled_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_shares_split ON public.expense_split_shares (split_id);
CREATE INDEX IF NOT EXISTS idx_expense_shares_member ON public.expense_split_shares (family_id, member_id, settled);

DO $$ BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS trg_expense_splits_updated ON public.expense_splits';
  EXECUTE 'CREATE TRIGGER trg_expense_splits_updated BEFORE UPDATE ON public.expense_splits FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()';
  EXECUTE 'DROP TRIGGER IF EXISTS trg_expense_shares_updated ON public.expense_split_shares';
  EXECUTE 'CREATE TRIGGER trg_expense_shares_updated BEFORE UPDATE ON public.expense_split_shares FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()';
END $$;

ALTER TABLE public.expense_splits       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_split_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members manage expense_splits" ON public.expense_splits;
CREATE POLICY "Members manage expense_splits" ON public.expense_splits
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

DROP POLICY IF EXISTS "Members manage expense_split_shares" ON public.expense_split_shares;
CREATE POLICY "Members manage expense_split_shares" ON public.expense_split_shares
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
