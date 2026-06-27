// Metadata + helpers for the global feature_flags table (seeded in migration 0088).
// Drives the admin Feature Flags console: human labels, grouping, and which flags
// gate Stripe capabilities that need Stripe approval before they should be on.

export type FlagGroup = 'core' | 'wallet' | 'stripe';

export type FlagMeta = {
  label: string;
  group: FlagGroup;
  /** Stripe capability that must be approved before this should be enabled. */
  needsApproval?: boolean;
};

export const FLAG_META: Record<string, FlagMeta> = {
  wallet_virtual_ledger_enabled: { label: 'Virtual ledger', group: 'core' },
  ai_wallet_coach_enabled: { label: 'AI Family Financial Coach', group: 'wallet' },
  babysitter_payments_enabled: { label: 'Babysitter payments', group: 'wallet' },
  grandparent_gifting_enabled: { label: 'Grandparent gifting', group: 'wallet' },
  stripe_payments_enabled: { label: 'Stripe payments (Checkout)', group: 'stripe', needsApproval: true },
  stripe_connect_enabled: { label: 'Stripe Connect onboarding', group: 'stripe', needsApproval: true },
  stripe_treasury_enabled: { label: 'Stripe Treasury accounts', group: 'stripe', needsApproval: true },
  stripe_issuing_enabled: { label: 'Stripe Issuing (cards)', group: 'stripe', needsApproval: true },
  physical_cards_enabled: { label: 'Physical cards', group: 'stripe', needsApproval: true },
  custom_card_designs_enabled: { label: 'Custom card designs', group: 'stripe', needsApproval: true },
};

export const GROUP_LABELS: Record<FlagGroup, string> = {
  core: 'Core',
  wallet: 'Family Wallet',
  stripe: 'Stripe — needs approval',
};

export const GROUP_ORDER: FlagGroup[] = ['core', 'wallet', 'stripe'];

/** A readable label for any flag key, falling back to a titleized key. */
export function flagLabel(key: string): string {
  return FLAG_META[key]?.label ?? key.replace(/_enabled$/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function flagGroup(key: string): FlagGroup {
  return FLAG_META[key]?.group ?? 'core';
}

export function flagNeedsApproval(key: string): boolean {
  return Boolean(FLAG_META[key]?.needsApproval);
}
