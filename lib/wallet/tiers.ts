// lib/wallet/tiers.ts — the Family Wallet Free/Basic/Plus feature matrix.
// PURE + tested. Mirrors the published pricing grid: every tier gets the wallet,
// gifts, and chores; allowances are Basic+, the AI coach scales from none →
// limited → unlimited, physical cards from none → optional → included, and the
// Bubaly service fee drops from full → reduced → none.

import type { WalletTier } from '@/lib/wallet/fees';
export type { WalletTier } from '@/lib/wallet/fees';

export type CoachLevel = 'none' | 'limited' | 'unlimited';
export type CardLevel = 'none' | 'optional' | 'included';
export type ServiceFeeLevel = 'full' | 'reduced' | 'none';

export type WalletTierSpec = {
  tier: WalletTier;
  label: string;
  wallet: boolean;
  gifts: boolean;
  chores: boolean;
  allowances: boolean;
  aiCoach: CoachLevel;
  physicalCards: CardLevel;
  serviceFee: ServiceFeeLevel;
};

export const WALLET_TIERS: Record<WalletTier, WalletTierSpec> = {
  free: {
    tier: 'free', label: 'Free',
    wallet: true, gifts: true, chores: true,
    allowances: false, aiCoach: 'none', physicalCards: 'none', serviceFee: 'full',
  },
  basic: {
    tier: 'basic', label: 'Basic',
    wallet: true, gifts: true, chores: true,
    allowances: true, aiCoach: 'limited', physicalCards: 'optional', serviceFee: 'reduced',
  },
  plus: {
    tier: 'plus', label: 'Plus',
    wallet: true, gifts: true, chores: true,
    allowances: true, aiCoach: 'unlimited', physicalCards: 'included', serviceFee: 'none',
  },
};

export const WALLET_TIER_ORDER: WalletTier[] = ['free', 'basic', 'plus'];

/** Boolean wallet features the UI can gate on directly. */
export type WalletFeature = 'wallet' | 'gifts' | 'chores' | 'allowances';

export function walletFeatureEnabled(tier: WalletTier, feature: WalletFeature): boolean {
  return WALLET_TIERS[tier][feature] === true;
}

export function aiCoachLevel(tier: WalletTier): CoachLevel {
  return WALLET_TIERS[tier].aiCoach;
}

export function physicalCardLevel(tier: WalletTier): CardLevel {
  return WALLET_TIERS[tier].physicalCards;
}

/** Daily cap on AI coach calls per tier (limited tier is metered). */
export const AI_COACH_DAILY_LIMIT: Record<WalletTier, number> = {
  free: 0,
  basic: 5,
  plus: Infinity,
};

/** Map the app's billing plan level (0/1/2) to a wallet tier. */
export function walletTierForPlanLevel(level: number): WalletTier {
  return level >= 2 ? 'plus' : level === 1 ? 'basic' : 'free';
}
