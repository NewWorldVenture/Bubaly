-- ============================================================================
-- Migration 0095: Wallet peer-to-peer transfers + spend requests
-- ----------------------------------------------------------------------------
-- Adds the `transfer` ledger type so money can move between family wallets
-- (parent → child, child → child) as a distinct, reportable event — separate
-- from within-wallet `bucket_transfer`. Spend requests reuse the existing
-- `card_spend` type with the `requires_parent_approval` status and a
-- `parent_approvals` row, so no new table is needed.
--
-- ALTER TYPE ... ADD VALUE is safe here: this migration only adds the value and
-- never uses it in the same transaction.
-- ============================================================================
ALTER TYPE wallet_txn_type ADD VALUE IF NOT EXISTS 'transfer';

-- Speed up the parent-approval inbox lookup by ref (spend requests link a
-- parent_approvals row to its pending wallet_transactions row).
CREATE INDEX IF NOT EXISTS idx_parent_approvals_ref
  ON public.parent_approvals (family_id, ref_type, ref_id);
