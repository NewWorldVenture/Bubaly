-- ============================================================
-- Migration 0028: Reward redemptions (allowance / points ledger)
-- Backs the Rewards & Allowance center (Top-50 complaints #7 "kids don't
-- do chores → gamification" and #21 "parents overloaded"). The existing
-- `rewards` table (migration 0002) modelled a one-shot redeemable; this
-- turns rewards into a reusable catalog and logs each redemption as a
-- request that a parent approves, so points balances have real history.
-- ============================================================

-- Transaction-safety: 0096 later runs `ADD VALUE IF NOT EXISTS 'pending'` /
-- `'cancelled'` and uses 'pending' as a column DEFAULT in the SAME statement
-- batch. Postgres refuses to use an enum value added in the current transaction
-- (SQLSTATE 55P04), so a fresh database applied by the Supabase CLI failed at
-- 0096. Declaring both values here (appended, matching the order production
-- ended up with) makes 0096's ADD VALUE a no-op on a fresh replay. On databases
-- where the type already exists this block is a no-op (duplicate_object).
DO $$ BEGIN
  CREATE TYPE redemption_status AS ENUM ('requested', 'approved', 'fulfilled', 'rejected', 'pending', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.reward_redemptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  reward_id    uuid REFERENCES public.rewards(id) ON DELETE SET NULL,
  member_id    uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  -- Snapshot of the reward's title + cost at redemption time so history
  -- survives the reward being edited or deleted.
  reward_title text NOT NULL,
  cost_points  integer NOT NULL DEFAULT 0,
  status       redemption_status NOT NULL DEFAULT 'requested',
  note         text,
  decided_by   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_redemptions_family ON public.reward_redemptions(family_id);
CREATE INDEX IF NOT EXISTS idx_reward_redemptions_member ON public.reward_redemptions(member_id);
CREATE INDEX IF NOT EXISTS idx_reward_redemptions_status ON public.reward_redemptions(family_id, status);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.reward_redemptions;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.reward_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.reward_redemptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage reward_redemptions" ON public.reward_redemptions;
CREATE POLICY "Members can manage reward_redemptions" ON public.reward_redemptions
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
