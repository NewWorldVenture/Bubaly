-- 0108_transactions_member.sql
-- Attribute a transaction to a family member so the Finances page can render
-- "Spending by Person". Additive + backward-compatible: the column is nullable
-- (unattributed transactions stay valid) and existing rows are untouched.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL;

-- Index the common "spend per member, this family" query pattern.
CREATE INDEX IF NOT EXISTS idx_transactions_family_member ON public.transactions(family_id, member_id);

-- RLS is unchanged: transactions already carry a family-scoped
-- "Members can manage transactions" FOR ALL policy (migration 0006), which
-- continues to govern this column.
